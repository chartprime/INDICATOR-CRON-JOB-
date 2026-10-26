"""Derive the four trade families from published `trade` partitions, one symbol-month per job.

A month is a dataset version of its own, exactly as the raw backfill's months
are, so it has its own checkpoint, its own catalog publication and its own
completion receipt. Inside the job every source day is fetched hash-verified
from S3, aggregated by `trade_families`, mapped through the contract bridge,
written by the same partition writer as every other family, committed and
evicted to S3 one partition at a time, and recorded in the checkpoint before
the next begins. A restart resumes from the checkpoint; a re-run of a
finished month is answered from its receipt.

No day is ever quarantined here. A raw day can be bad data; an aggregate of
published data that the contract refuses is a defect in this stage, and the
job stops on it.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import shutil
import sys
import time
from decimal import Decimal
from pathlib import Path

import backfill_driver as _driver
import catalog as _catalog
import checkpoint as _ckpt
import convert as _convert
import curated_partition
import identity as _identity
import job as _job
import s3_publish
import throttle as _throttle
import trade_families
import writer as _writer
from bridge import ContractBridge
from local_lock import LocalLock, conversion_guard_path

PHASE = "l1agg"
BASE_VERSION = "w606-l1agg-v1"
MAPPING_VERSION = "derived-from-trade/1"
DAY_NS = 86_400_000_000_000
SOURCE_BYTES_PER_ROW_ESTIMATE = 60
JOB_STAGE_NAME_LENGTH = 16
PARTITION_FAMILIES = dict(_writer.DERIVED_PARTITION_FAMILIES)


class DeriveError(RuntimeError):
    pass


def _now_iso():
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _log(**event):
    print(json.dumps(event), file=sys.stderr, flush=True)


def snapshot_path(catalog_root):
    """The converter catalog's current snapshot, verified against its pointer."""
    current = _catalog.read_current(catalog_root)
    if not current:
        raise DeriveError("NO_CURRENT_CATALOG")
    path = os.path.join(os.fspath(catalog_root), current["catalog_key"])
    if not os.path.isfile(path) or _catalog._sha256_file(path) != current["catalog_sha256"]:
        raise DeriveError("CATALOG_INTEGRITY_FAILURE")
    return path


def version_stem(base_version, dataset, symbol):
    return f"{base_version}-{dataset.lower().replace('.', '-')}-{symbol.lower()}"


def _contracts_for(snapshot, dataset, symbol):
    import sqlite3
    connection = sqlite3.connect(Path(snapshot).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT DISTINCT contract_code, tick_size FROM roll_intervals WHERE alias=? ORDER BY contract_code",
            [f"{symbol}.n.0"]).fetchall()
    finally:
        connection.close()
    contracts = {}
    for contract, tick in rows:
        if contract in contracts and contracts[contract] != Decimal(tick):
            raise DeriveError(f"ROLL_TICK_SIZE_AMBIGUOUS:{contract}")
        contracts[contract] = Decimal(tick)
    if not contracts:
        raise DeriveError(f"ROLL_TABLE_MISSING:{dataset}:{symbol}")
    return contracts


def plan_symbol(snapshot, dataset, symbol):
    """Every published `trade` partition that belongs to the symbol, grouped by month.

    Equities are one instrument; futures are every contract the roll table
    names for the alias, each with the tick size the roll table records.
    Anything the catalog cannot vouch for -- unpublished, or one date under
    two versions -- is refused rather than picked."""
    base = _identity.instrument_for(dataset, symbol)
    if base["market"] == "FUTURE":
        instruments = [(_identity.instrument_id(_identity.instrument_for(dataset, contract)), tick)
                       for contract, tick in _contracts_for(snapshot, dataset, symbol).items()]
    else:
        tick = trade_families.declared_tick(dataset, symbol)
        if tick is None:
            raise DeriveError(f"TICK_UNDECLARED:{dataset}:{symbol}")
        instruments = [(_identity.instrument_id(base), tick)]
    months = {}
    for instrument_id, tick in instruments:
        seen = set()
        for entry in curated_partition.catalogued_dates(snapshot, instrument_id, "trade"):
            date = entry["date"]
            if date in seen:
                raise DeriveError(f"SOURCE_AUTHORITY_AMBIGUOUS:{instrument_id}:{date}")
            seen.add(date)
            try:
                partition = curated_partition.resolve(snapshot, instrument_id, "trade", date)
            except curated_partition.CuratedPartitionError as error:
                raise DeriveError(f"SOURCE_{error}") from error
            if not partition["published_to_s3"]:
                raise DeriveError(f"SOURCE_PARTITION_NOT_PUBLISHED:{instrument_id}:{date}")
            months.setdefault(date[:7], []).append({**partition, "market": base["market"], "tick_size": str(tick)})
    if not months:
        raise DeriveError(f"NO_SOURCE_PARTITIONS:{dataset}:{symbol}")
    for entries in months.values():
        entries.sort(key=lambda e: (e["date"], e["instrument_id"]))
    return {"dataset": dataset, "symbol": symbol, "market": base["market"], "months": months}


def job_id_for(version, entries):
    material = json.dumps({
        "version": version, "method": trade_families.METHOD_VERSION,
        "sources": sorted((e["instrument_id"], e["date"], e["manifest_sha256"]) for e in entries),
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _authority_plan(entries, store):
    plan = []
    for entry in entries:
        day = _dt.datetime.fromisoformat(entry["date"]).replace(tzinfo=_dt.timezone.utc)
        from_ns = int(day.timestamp()) * 1_000_000_000
        for family in PARTITION_FAMILIES:
            plan.append({
                "instrument_id": entry["instrument_id"], "family": family, "date": entry["date"],
                "s3_key": store.key(entry["s3_prefix"] + "/_manifest.json"), "sha256": entry["manifest_sha256"],
                "source_rank": 0, "from_ns": str(from_ns), "to_ns": str(from_ns + DAY_NS),
            })
    return plan


def _inputs(entries, store):
    return [{
        "s3_key": store.key(entry["s3_prefix"] + "/_manifest.json"), "sha256": entry["manifest_sha256"],
        "instrument_id": entry["instrument_id"], "date": entry["date"], "s3_prefix": entry["s3_prefix"],
        "source_dataset_version": entry["dataset_version"], "record_count": entry["record_count"],
        "market": entry["market"], "tick_size": entry["tick_size"], "provider": entry["provider"],
    } for entry in entries]


def _verify_completed(checkpoint, curated_root, version):
    for entry in checkpoint["completed_partitions"]:
        if entry.get("evicted"):
            continue
        dest = _job._completed_partition_dest(curated_root, version, entry["instrument_id"], entry["family"],
                                             entry["date"], entry.get("provider", "databento"))
        manifest_path = os.path.join(dest, "_manifest.json")
        if _convert._sha256_file(manifest_path) != entry["manifest_sha256"]:
            raise DeriveError("MANIFEST_INTEGRITY_FAILURE")
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
        for part in manifest["parts"]:
            if _convert._sha256_file(os.path.join(dest, part["name"])) != part["sha256"]:
                raise DeriveError("PART_INTEGRITY_FAILURE")


def _mapping(identity, source, day_from_ns):
    instrument = {"venue": identity["venue"], "market": identity["market"], "symbol": identity["symbol"],
                  "currency": identity["currency"], "sizeUnit": identity["size_unit"], "contract": identity["contract"]}
    if _identity.instrument_id(instrument) != source["instrument_id"] or identity["instrument_id"] != source["instrument_id"]:
        raise DeriveError(f"SOURCE_IDENTITY_MISMATCH:{source['instrument_id']}:{identity['instrument_id']}")
    return {
        "provider": identity["source_provider"].upper(), "dataset": identity["source_dataset"],
        "sourceSymbol": identity["source_symbol"], "fromNs": str(day_from_ns), "toNs": str(day_from_ns + DAY_NS),
        "instrument": instrument, "mappingVersion": MAPPING_VERSION, "reference": f"curated:{source['sha256']}",
    }


def _derive_source(bridge, checkpoint, job_stage, version, curated_root, source_store, source, pending_families,
                   writer_for, on_partition_complete):
    scratch = os.path.join(job_stage, "_source")
    os.makedirs(scratch, exist_ok=True)
    partition = {"instrument_id": source["instrument_id"], "family": "trade", "date": source["date"],
                 "s3_prefix": source["s3_prefix"], "manifest_sha256": source["sha256"],
                 "record_count": source["record_count"]}
    manifest = curated_partition.read_manifest(source_store, partition)
    paths = curated_partition.fetch_verified(source_store, partition, scratch, manifest=manifest)
    try:
        computed = trade_families.compute(paths, market=source["market"], tick_size=source["tick_size"])
    finally:
        curated_partition.discard(paths)
    identity = computed["identity"]
    day_from_ns = int(next(e for e in checkpoint["authority_plan"]
                           if e["instrument_id"] == source["instrument_id"] and e["date"] == source["date"])["from_ns"])
    mapping = _mapping(identity, source, day_from_ns)
    lineage = {"object": f"s3://{source_store.bucket}/{source['s3_key']}", "sha256": source["sha256"]}
    source_objects = [{"s3_key": source["s3_key"], "sha256": source["sha256"]}]
    for partition_family in pending_families:
        record_family = PARTITION_FAMILIES[partition_family]
        rows = computed["families"][record_family]
        if not rows:
            checkpoint.setdefault("empty_partitions", []).append(
                {"instrument_id": source["instrument_id"], "family": partition_family, "date": source["date"]})
            checkpoint = _ckpt.save(job_stage, checkpoint, _now_iso())
            _log(event="family_empty", version=version, date=source["date"], family=partition_family)
            continue
        context = {
            "mappings": [mapping], "dataset": identity["source_dataset"], "sourceSymbol": identity["source_symbol"],
            "population": identity["source_population"], "datasetVersion": version,
            "streamId": f"derived:trade:{record_family}", "schema": f"{record_family}/1",
            "ingestNs": str(checkpoint["conversion_started_ns"]), "lineage": lineage,
        }
        pw = writer_for(source["instrument_id"], partition_family, source["date"])
        for batch in _convert._batches(enumerate(rows), _convert._batch_rows()):
            batch_id = f"{checkpoint['job_id']}:{source['date']}:{identity['source_symbol']}:{record_family}:{batch[0]['position']}"
            results = bridge.map_batch(batch_id, mapping["provider"], record_family, batch, context)
            for result in results:
                if not result.get("ok"):
                    reason = (result.get("quarantine") or {}).get("reason", "UNKNOWN")
                    raise DeriveError(f"DERIVED_MAPPING_REJECTED:{source['instrument_id']}:{partition_family}:{source['date']}:{reason}")
                for record in result["records"]:
                    if (record["instrument"]["id"], _convert._partition_family_for(record["family"], context["schema"])) \
                            != (source["instrument_id"], partition_family):
                        raise DeriveError(f"DERIVED_UNPLANNED_OUTPUT_RECORD:{partition_family}:{source['date']}")
                    if not (day_from_ns <= int(record["time"]["eventNs"]) < day_from_ns + DAY_NS):
                        raise DeriveError(f"DERIVED_RECORD_OUTSIDE_DATE:{partition_family}:{source['date']}")
                    outcome = pw.add(record, source_rank=0)
                    if not outcome["accepted"]:
                        raise DeriveError(f"DERIVED_WRITER_REJECTED:{partition_family}:{source['date']}:{outcome['reason']}")
        derivation = {
            "stage_method_version": trade_families.METHOD_VERSION, "family_method": trade_families.FAMILY_METHOD[record_family],
            "geometry": computed["geometry"],
            "filters": {"trade_action": "NEW", "valid_tick": "required" if source["market"] == "FUTURE" else "ignored",
                        "sides": "all" if record_family in ("trade_minute", "trade_level") else "BUY,SELL"},
            "source_partition": {"instrument_id": source["instrument_id"], "family": "trade",
                                 "dataset_version": source["source_dataset_version"], "date": source["date"],
                                 "manifest_sha256": source["sha256"], "record_count": manifest["record_count"]},
            "reconciliation": computed["reconciliation"],
        }
        checkpoint = _job._finish({(source["instrument_id"], partition_family): pw}, checkpoint, job_stage, version,
                                  curated_root, source["date"], source_objects,
                                  derivations={(source["instrument_id"], partition_family): derivation},
                                  provider=source["provider"])
        on_partition_complete(checkpoint, source["instrument_id"], partition_family, source["date"])
    return checkpoint


def _is_done(checkpoint, instrument_id, family, date):
    return _ckpt.is_partition_complete(checkpoint, instrument_id, family, date) or any(
        (e["instrument_id"], e["family"], e["date"]) == (instrument_id, family, date)
        for e in checkpoint.get("empty_partitions", []))


def _publish_catalog(checkpoint, job_stage, version, curated_root, catalog_root, remote_hook):
    if checkpoint.get("published"):
        return _catalog.job_receipt(catalog_root, version, checkpoint["job_id"]), checkpoint
    local_db = os.path.join(job_stage, "catalog.local.sqlite")
    builder = _catalog.CatalogBuilder(local_db)
    builder.record_dataset_version(version)
    for entry in checkpoint["completed_partitions"]:
        manifest, prefix = _job._manifest_and_prefix_for(curated_root, version, entry)
        builder.record_partition(manifest, prefix, entry["manifest_sha256"], published_to_s3=entry.get("evicted", False),
                                 provider=entry.get("provider", "databento"))
    builder.mark_published(version)
    builder.close()
    pointer = _catalog.publish_job(catalog_root, local_db, version, checkpoint["job_id"], holder="derive-families",
                                   on_ready_to_publish=remote_hook)
    checkpoint["published"] = True
    return pointer, _ckpt.save(job_stage, checkpoint, _now_iso())


def run_month(entries, version, *, store, staging_root, curated_root, catalog_root, node_bin="node", worker_path=None,
              min_free_bytes=_driver.DEFAULT_MIN_FREE_BYTES, on_month_admission=None, source_store=None):
    """One symbol-month: every family for every source day, then the month's catalog, published.

    `source_store` is where the trade partitions are read from. It defaults to
    the store the families are published to, which is the production shape; a
    qualification run publishes into its own namespace while reading the real
    sources, and names the two separately.
    """
    _writer.validate_version(version)
    source_store = store if source_store is None else source_store
    if not entries:
        raise DeriveError("NO_SOURCE_PARTITIONS")
    if len({e["provider"] for e in entries}) != 1:
        raise DeriveError("SOURCE_PROVIDERS_MIXED")
    stage = os.path.realpath(os.fspath(staging_root))
    root = os.path.realpath(os.fspath(curated_root))
    if stage == root or os.path.commonpath([stage, root]) in (stage, root):
        raise DeriveError("STAGING_CURATED_MUST_BE_DISJOINT")
    estimate = [{"bytes": int(e["record_count"]) * SOURCE_BYTES_PER_ROW_ESTIMATE, "s3_key": e["s3_prefix"]} for e in entries]
    if on_month_admission is not None:
        on_month_admission(estimate)
    _driver.check_storage(stage, min_free_bytes + max((o["bytes"] for o in estimate), default=0))
    with LocalLock(stage + ".backfill.guard"):
        return _driver.recover_from_stale_intent(
            lambda: _run_month(entries, version, store=store, source_store=source_store, stage=stage, curated_root=root,
                               catalog_root=catalog_root, node_bin=node_bin, worker_path=worker_path),
            catalog_root=catalog_root, dataset_version=version)


def _run_month(entries, version, *, store, source_store, stage, curated_root, catalog_root, node_bin, worker_path):
    job_id = job_id_for(version, entries)
    job_stage = os.path.join(stage, job_id[:JOB_STAGE_NAME_LENGTH])
    os.makedirs(job_stage, exist_ok=True)
    with LocalLock(conversion_guard_path(curated_root, version)), LocalLock(stage + ".stage.guard"):
        checkpoint = _ckpt.load(job_stage)
        if checkpoint is None:
            checkpoint = _ckpt.new(job_id, version, time.time_ns(), _authority_plan(entries, source_store),
                                   _inputs(entries, source_store))
            checkpoint = _ckpt.save(job_stage, checkpoint, _now_iso())
        elif checkpoint["job_id"] != job_id or checkpoint.get("dataset_version") != version:
            raise DeriveError("CHECKPOINT_IDENTITY_MISMATCH")
        _verify_completed(checkpoint, curated_root, version)
        _driver._catch_up_evictions(store, job_stage, curated_root, version)
        checkpoint = _ckpt.load(job_stage)

        writers = {}

        def writer_for(instrument_id, family, date):
            key = (instrument_id, family, date)
            if key not in writers:
                writers[key] = _writer.PartitionWriter(job_stage, instrument_id, family, version, date)
            return writers[key]

        def on_partition_complete(current, instrument_id, family, date):
            entry = next(e for e in current["completed_partitions"]
                         if (e["instrument_id"], e["family"], e["date"]) == (instrument_id, family, date))
            _driver._evict_one(store, current, job_stage, curated_root, version, entry)
            _log(event="partition_published", version=version, date=date, family=family, instrument_id=instrument_id)

        health_file = os.environ.get("TT_COLLECTOR_HEALTH_FILE")
        with ContractBridge(worker_path or _convert._WORKER, node_bin=node_bin) as bridge:
            try:
                for source in checkpoint["inputs"]:
                    pending = [family for family in PARTITION_FAMILIES
                               if not _is_done(checkpoint, source["instrument_id"], family, source["date"])]
                    if not pending:
                        continue
                    _throttle.wait_if_needed(health_file)
                    _log(event="day_start", version=version, date=source["date"], instrument_id=source["instrument_id"])
                    checkpoint = _derive_source(bridge, checkpoint, job_stage, version, curated_root, source_store, source,
                                                pending, writer_for, on_partition_complete)
                    checkpoint = _ckpt.load(job_stage)
                    _log(event="day_complete", version=version, date=source["date"], instrument_id=source["instrument_id"])
            finally:
                for pw in writers.values():
                    pw.close_input()

        complete = all(_is_done(checkpoint, p["instrument_id"], p["family"], p["date"])
                       for p in _ckpt.planned_in_scope(checkpoint))
        pointer = None
        if complete:
            pointer, checkpoint = _publish_catalog(checkpoint, job_stage, version, curated_root, catalog_root,
                                                   _driver._make_remote_publish_hook(store, curated_root))
        result = {
            "job_id": job_id, "dataset_version": version, "conversion_started_ns": checkpoint["conversion_started_ns"],
            "partitions": sorted(
                f"{e.get('provider', 'databento')}/{_writer.instrument_slug(e['instrument_id'])}/{e['family']}/{version}/{e['date']}"
                for e in checkpoint["completed_partitions"]),
            "empty_partitions": list(checkpoint.get("empty_partitions", [])),
            "catalog_pointer": pointer, "fully_published": complete,
        }
    shutil.rmtree(os.path.join(job_stage, "_source"), ignore_errors=True)
    return {"results": [result], "skipped_dates": [], "quarantined_dates": [], "fully_published": complete,
            "cleaned_split_staging": False}


def run_symbol(dataset, symbol, base_version, *, client, bucket, curated_prefix, staging_root, curated_root, catalog_root,
               node_bin="node", worker_path=None, min_free_bytes=_driver.DEFAULT_MIN_FREE_BYTES, months=None,
               on_month_admission=None, source_prefix=None, source_catalog_root=None):
    """Every month of one symbol, oldest first; a finished month is skipped by its receipt.

    In production the families are published beside their sources, so the
    sources are planned from `catalog_root` and read under `curated_prefix`. A
    qualification run names `source_prefix` and `source_catalog_root` so it
    reads the real sources while publishing into its own namespace and catalog.
    """
    snapshot = snapshot_path(catalog_root if source_catalog_root is None else source_catalog_root)
    plan = plan_symbol(snapshot, dataset, symbol)
    store = s3_publish.Store(client, bucket, curated_prefix)
    source_store = store if source_prefix is None else s3_publish.Store(client, bucket, source_prefix)
    stem = version_stem(base_version, dataset, symbol)
    selected = sorted(plan["months"]) if months is None else [m for m in sorted(plan["months"]) if m in months]
    if not selected:
        raise DeriveError(f"NO_MONTHS_SELECTED:{dataset}:{symbol}:{sorted(months or [])}")
    outcomes = []
    for month in selected:
        entries = plan["months"][month]
        version = f"{stem}-{month}"
        _log(event="month_start", version=version, sources=len(entries))
        outcome = run_month(entries, version, store=store, source_store=source_store,
                            staging_root=str(Path(staging_root, version)), curated_root=curated_root,
                            catalog_root=catalog_root, node_bin=node_bin, worker_path=worker_path,
                            min_free_bytes=min_free_bytes, on_month_admission=on_month_admission)
        outcomes.append({"month": month, "version": version, **outcome})
        if not outcome["fully_published"]:
            raise DeriveError(f"INCOMPLETE_PUBLICATION:{version}")
        _log(event="month_complete", version=version)
    return {"dataset": dataset, "symbol": symbol, "market": plan["market"], "months": outcomes}
