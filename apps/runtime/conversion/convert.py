from __future__ import annotations

import datetime as _dt
import calendar as _calendar
import hashlib
import json
import os
import re
import shutil
import time
import types

import budget
import catalog as _catalog
import rejection_evidence as _rejections
import csv_decode as _csv
import dbn as _dbn
import identity as _identity
import writer as _writer
from bridge import ContractBridge

BATCH_ROWS = 2048
_MBP_SCHEMAS = {"mbp-1", "tbbo"}
_DEPTH_SCHEMAS = {"mbp-10"}
_OHLCV_SCHEMAS = {"ohlcv-1s", "ohlcv-1m", "ohlcv-1h", "ohlcv-1d"}
_KLINE_SCHEMAS = {"klines-1m", "klines-1h", "klines-1d"}
_WORKER = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "scripts", "convert", "contract-worker.js"))

_KLINE_INTERVAL_NS = {
    "klines-1m": 60_000_000_000,
    "klines-1h": 3_600_000_000_000,
    "klines-1d": 86_400_000_000_000,
}
_BINANCE_KEY = re.compile(
    r"raw/binance/(?P<product>spot|um)/(?P<symbol>[A-Z0-9]+)/(?P<interval>1m|1h|1d)/"
    r"(?P<year>[0-9]{4})-(?P<month>0[1-9]|1[0-2])"
    r"(?:/(?P<candidate_sha256>[0-9a-f]{64}))?\.zip\Z"
)
_BINANCE_DATASET = {"spot": "BINANCE.SPOT", "um": "BINANCE.UM"}


class ConversionError(RuntimeError):
    pass


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _utc_date(event_ns):
    seconds = int(event_ns) // 1_000_000_000
    return _dt.datetime.fromtimestamp(seconds, tz=_dt.timezone.utc).strftime("%Y-%m-%d")


def _binance_kline_month(s3_key, dataset, symbol, schema):
    match = _BINANCE_KEY.fullmatch(s3_key or "")
    if match is None:
        raise ConversionError("BINANCE_KLINE_SOURCE_KEY_INVALID")
    parts = match.groupdict()
    if _BINANCE_DATASET[parts["product"]] != dataset:
        raise ConversionError("BINANCE_KLINE_DATASET_KEY_MISMATCH")
    if parts["symbol"] != symbol:
        raise ConversionError("BINANCE_KLINE_SYMBOL_KEY_MISMATCH")
    if "klines-" + parts["interval"] != schema:
        raise ConversionError("BINANCE_KLINE_INTERVAL_KEY_MISMATCH")
    start = _dt.datetime(int(parts["year"]), int(parts["month"]), 1, tzinfo=_dt.timezone.utc)
    end = _dt.datetime(start.year + (start.month == 12), start.month % 12 + 1, 1,
                       tzinfo=_dt.timezone.utc)
    return (_KLINE_INTERVAL_NS[schema], _calendar.timegm(start.utctimetuple()) * 1_000_000_000,
            _calendar.timegm(end.utctimetuple()) * 1_000_000_000)


def _binance_candidate_sha256(s3_key):
    match = _BINANCE_KEY.fullmatch(s3_key or "")
    return None if match is None else match.group("candidate_sha256")


_DERIVED_PARTITION_FAMILY = {record: partition for partition, record in _writer.DERIVED_PARTITION_FAMILIES.items()}

_OHLCV_PARTITION_FAMILY = {
    "ohlcv-1s": "candle", "ohlcv-1m": "candle_1m", "ohlcv-1h": "candle_1h",
    "ohlcv-1d": "candle_1d", "klines-1m": "candle_1m", "klines-1h": "candle_1h",
    "klines-1d": "candle_1d",
}


def _partition_family_for(record_family, schema):
    """Which partition a record belongs in, which is not the same as what kind of
    record it is. Bars at every resolution are `candle` records under
    market-observation/1 and must stay that way -- the live contract is shared
    with the collector. The archive still has to address them separately, so the
    resolution lives in the partition family instead. An ohlcv schema with no
    mapping here is refused rather than defaulted: silently filing one-hour bars
    under the one-second family is the failure this exists to prevent."""
    if record_family in _DERIVED_PARTITION_FAMILY:
        return _DERIVED_PARTITION_FAMILY[record_family]
    if record_family != "candle":
        return record_family
    partition_family = _OHLCV_PARTITION_FAMILY.get(schema)
    if partition_family is None:
        raise ConversionError(f"UNMAPPED_CANDLE_SCHEMA:{schema}")
    return partition_family


def _map_family_for(schema):
    if schema in _MBP_SCHEMAS:
        return "mbp"
    if schema in _DEPTH_SCHEMAS:
        return "depth"
    if schema in _OHLCV_SCHEMAS:
        return "candle"
    raise ConversionError(f"UNSUPPORTED_SCHEMA:{schema}")


def _job_id(inputs, dataset_version, roll_table_version, scope=None):
    material = {
        "inputs": sorted((i["s3_key"], i["sha256"]) for i in inputs),
        "converter": _writer.CONVERTER_VERSION,
        "contract": _catalog.CONTRACT_VERSION,
        "roll_table": roll_table_version,
        "dataset_version": dataset_version,
        "scope": scope,
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def _batch_rows():
    return budget.positive_env("TT_CONVERT_BATCH_ROWS", BATCH_ROWS)


def _batches(row_iter, size):
    batch = []
    for index, row in row_iter:
        batch.append({"row": row, "position": index})
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _group_by_instrument(batch):
    groups = {}
    for entry in batch:
        groups.setdefault(entry["row"]["instrument_id"], []).append(entry)
    return groups


def _publish_partition(pw, curated_root, provider="databento"):
    if provider not in {"databento", "binance"}:
        raise ConversionError(f"UNSUPPORTED_CURATED_PROVIDER:{provider}")
    dest = os.path.join(curated_root, provider, _writer.instrument_slug(pw.instrument_id),
                        pw.family, pw.dataset_version, pw.date)
    if os.path.exists(dest):
        raise ConversionError(f"PARTITION_ALREADY_PUBLISHED:{dest}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    staging = f"{dest}.publishing"
    if os.path.exists(staging):
        shutil.rmtree(staging)
    manifest_path = os.path.join(pw.dir, "_manifest.json")
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    paths = _writer.manifest_part_paths(pw.dir, manifest)
    os.makedirs(staging)
    for source in [*paths, manifest_path]:
        target = os.path.join(staging, os.path.basename(source))
        shutil.copyfile(source, target)
        with open(target, "r+b") as fh:
            os.fsync(fh.fileno())
    if os.name == "posix":
        fd = os.open(staging, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    os.replace(staging, dest)
    if os.name == "posix":
        fd = os.open(os.path.dirname(dest), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return os.path.relpath(dest, curated_root).replace(os.sep, "/")


def _is_csv(source_path):
    return source_path.endswith(".csv") or source_path.endswith(".csv.gz")


def _prepare(source_path, schema, symbol, dataset, raw_sha, s3_key):
    if schema in _KLINE_SCHEMAS:
        if not source_path.endswith(".zip"):
            raise ConversionError(f"KLINE_SOURCE_MUST_BE_ZIP:{schema}")
        if not dataset:
            raise ConversionError("KLINE_SOURCE_REQUIRES_DATASET")
        if not symbol:
            raise ConversionError("KLINE_SOURCE_REQUIRES_SYMBOL")
        interval_ns, start_ns, end_ns = _binance_kline_month(s3_key, dataset, symbol, schema)
        mappings = _identity.build_binance_mappings(dataset, symbol, reference=f"s3-key:{s3_key}")

        def rows():
            for position, row in _csv.validated_kline_month_rows(
                    source_path, interval_ns=interval_ns, start_ns=start_ns, end_ns=end_ns):
                yield position, {**row, "instrument_id": symbol}

        return (rows, types.SimpleNamespace(dataset=dataset, schema=schema), mappings, "candle", "BINANCE")
    if _is_csv(source_path):
        if schema not in _OHLCV_SCHEMAS:
            raise ConversionError(f"CSV_ONLY_SUPPORTED_FOR_OHLCV:{schema}")
        if not symbol:
            raise ConversionError("CSV_SOURCE_REQUIRES_SYMBOL")
        if not dataset:
            raise ConversionError("CSV_SOURCE_REQUIRES_DATASET")
        for name, value in (("dataset", dataset), ("symbol", symbol), ("schema", schema)):
            declared = [p.split("=", 1)[1] for p in s3_key.split("/") if p.startswith(name + "=")]
            if declared and any(v != value for v in declared):
                raise ConversionError(f"CSV_SOURCE_IDENTITY_MISMATCH:{name}")
        instrument_ids = _csv.distinct_instrument_ids(source_path)
        mappings = _identity.build_csv_mappings(dataset, symbol, instrument_ids, reference=f"s3-key:{s3_key}")
        return (lambda: _csv.decode_ohlcv(source_path)), types.SimpleNamespace(dataset=dataset, schema=schema), mappings, "candle", "DATABENTO"

    meta = _dbn.read_metadata(source_path, expected_schema=schema)
    mappings = _identity.build_mappings(meta, raw_sha)
    map_family = _map_family_for(meta.schema)
    if map_family == "depth":
        raise ConversionError("DEPTH_CONVERSION_IS_PHASE_3")
    return (lambda: _dbn.decode(source_path, expected_schema=schema)), meta, mappings, map_family, "DATABENTO"


def _source_spec(value):
    if not isinstance(value, dict):
        raise ConversionError("INVALID_SOURCE_SPEC")
    try:
        source_path = os.fspath(value["source_path"])
        schema = value["schema"]
    except (KeyError, TypeError):
        raise ConversionError("INVALID_SOURCE_SPEC") from None
    if not isinstance(schema, str) or not schema:
        raise ConversionError("INVALID_SOURCE_SCHEMA")
    dataset, symbol = value.get("dataset"), value.get("symbol")
    s3_key = value.get("s3_key") or f"raw/databento/{os.path.basename(source_path)}"
    if not isinstance(s3_key, str) or not s3_key:
        raise ConversionError("INVALID_SOURCE_KEY")
    raw_sha = _sha256_file(source_path)
    if schema in _KLINE_SCHEMAS:
        expected = value.get("expected_sha256")
        if not isinstance(expected, str) or re.fullmatch(r"[0-9a-f]{64}", expected) is None:
            raise ConversionError("BINANCE_SOURCE_SHA256_REQUIRED")
        if raw_sha != expected:
            raise ConversionError("BINANCE_SOURCE_SHA256_MISMATCH")
        candidate = _binance_candidate_sha256(s3_key)
        if candidate is not None and candidate != expected:
            raise ConversionError("BINANCE_SOURCE_KEY_SHA256_MISMATCH")
    source_object = {
        "s3_key": s3_key, "sha256": raw_sha, "bytes": os.path.getsize(source_path),
        "local_file_mtime": _dt.datetime.fromtimestamp(
            os.path.getmtime(source_path), tz=_dt.timezone.utc).isoformat(),
        "source_delivered_at": value.get("source_delivered_at"),
    }
    delivered_at = source_object["source_delivered_at"]
    if delivered_at is not None:
        if not isinstance(delivered_at, str):
            raise ConversionError("INVALID_SOURCE_DELIVERED_AT")
        try:
            parsed_delivered_at = _dt.datetime.fromisoformat(delivered_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ConversionError("INVALID_SOURCE_DELIVERED_AT") from error
        if parsed_delivered_at.tzinfo is None:
            raise ConversionError("INVALID_SOURCE_DELIVERED_AT")
    source_receipt_key = value.get("source_receipt_key")
    if source_receipt_key is not None:
        if (not isinstance(source_receipt_key, str)
                or source_receipt_key != s3_key + ".receipt.json"):
            raise ConversionError("BINANCE_SOURCE_RECEIPT_KEY_MISMATCH")
        source_object["source_receipt_key"] = source_receipt_key
    return {
        "source_path": source_path, "schema": schema, "dataset": dataset, "symbol": symbol,
        "s3_key": s3_key, "sha256": raw_sha, "source_object": source_object,
    }


def _convert_sources(sources, dataset_version, *, staging_root, curated_root, catalog_root,
                     node_bin="node", worker_path=None, holder="conversion"):
    _writer.validate_version(dataset_version)
    worker_path = worker_path or _WORKER
    if not isinstance(sources, (list, tuple)) or not sources:
        raise ConversionError("SOURCES_REQUIRED")
    sources = [_source_spec(value) for value in sources]
    if len({source["s3_key"] for source in sources}) != len(sources):
        raise ConversionError("DUPLICATE_SOURCE_KEY")
    inputs = [source["source_object"] for source in sources]
    job_id = _job_id(inputs, dataset_version, None, {
        "sources": sorted((source["s3_key"], source["schema"], source["dataset"] or "", source["symbol"] or "")
                          for source in sources),
    })
    started_ns = time.time_ns()
    prepared = [
        (source, *_prepare(source["source_path"], source["schema"], source["symbol"], source["dataset"],
                           source["sha256"], source["s3_key"]))
        for source in sources
    ]

    job_stage = os.path.join(staging_root, job_id)
    os.makedirs(job_stage, exist_ok=True)
    _rejections.begin_attempt(job_stage)

    writers = {}
    writer_providers = {}
    writer_sources = {}
    accepted = 0
    evidence = _rejections.new(source_objects=[{"s3_key": source["s3_key"], "sha256": source["sha256"]}
                                                for source in sources])

    def _reject(reason, **kwargs):
        _rejections.record(evidence, reason, **kwargs)

    def writer_for(instrument_id, family, date):
        key = (instrument_id, family, date)
        if key not in writers:
            writers[key] = _writer.PartitionWriter(job_stage, instrument_id, family, dataset_version, date)
        return writers[key]

    try:
        with ContractBridge(worker_path, node_bin=node_bin) as bridge:
            for source, row_iter, meta, mappings, map_family, provider in prepared:
                source_writers = set()
                try:
                    for batch in _batches(row_iter(), _batch_rows()):
                        for source_symbol, group in _group_by_instrument(batch).items():
                            context = {
                                "mappings": mappings, "dataset": meta.dataset, "sourceSymbol": source_symbol,
                                "population": f"{meta.dataset}:{meta.schema}", "datasetVersion": dataset_version,
                                "streamId": f"{provider.lower()}:{meta.dataset}:{meta.schema}", "schema": meta.schema,
                                "ingestNs": str(started_ns),
                                "lineage": {"object": f"s3://{source['s3_key']}", "sha256": source["sha256"]},
                            }
                            batch_id = f"{job_id}:{source_symbol}:{group[0]['position']}"
                            for entry, res in zip(group, bridge.map_batch(batch_id, provider, map_family, group, context)):
                                if not res["ok"]:
                                    quarantine = res.get("quarantine")
                                    reason = quarantine.get("reason") if isinstance(quarantine, dict) else None
                                    _reject(reason,
                                            source={"s3_key": source["s3_key"], "sha256": source["sha256"],
                                                    "source_symbol": source_symbol, "position": entry["position"],
                                                    "batch_id": batch_id}, row=entry["row"], quarantine=quarantine)
                                    continue
                                for record in res["records"]:
                                    date = _utc_date(record["time"]["eventNs"])
                                    partition_family = _partition_family_for(record["family"], meta.schema)
                                    key = (record["instrument"]["id"], partition_family, date)
                                    previous_provider = writer_providers.setdefault(key, provider.lower())
                                    if previous_provider != provider.lower():
                                        raise ConversionError(f"MIXED_PROVIDER_PARTITION:{key}")
                                    writer_sources.setdefault(key, {})[source["s3_key"]] = source["source_object"]
                                    pw = writer_for(*key)
                                    source_writers.add(pw)
                                    outcome = pw.add(record, source_rank=0)
                                    if outcome["accepted"]:
                                        accepted += 1
                                    else:
                                        _reject(outcome["reason"],
                                                source={"s3_key": source["s3_key"], "sha256": source["sha256"],
                                                        "source_symbol": source_symbol, "position": entry["position"],
                                                        "batch_id": batch_id}, row=entry["row"], canonical_record=record)
                finally:
                    for pw in source_writers:
                        pw.close_input()

    finally:
        for pw in writers.values():
            pw.close_input()

    for source in sources:
        if _sha256_file(source["source_path"]) != source["sha256"]:
            raise ConversionError("SOURCE_CHANGED_DURING_CONVERSION")
    if evidence["rejected"]:
        for pw in writers.values():
            pw.close_input()
        _rejections.write(job_stage, evidence)
        raise ConversionError(f"QUARANTINE_BLOCKS_PUBLICATION:{evidence['rejected']}")
    if not writers:
        raise ConversionError("NO_RECORDS_PRODUCED")

    local_db = os.path.join(job_stage, "catalog.local.sqlite")
    builder = _catalog.CatalogBuilder(local_db)
    builder.record_dataset_version(dataset_version)
    partition_prefixes = []
    for key, pw in writers.items():
        manifest = pw.finalize(writer_sources[key].values())
        provider = writer_providers[key]
        prefix = _publish_partition(pw, curated_root, provider)
        builder.record_partition(manifest, prefix, _sha256_file(os.path.join(pw.dir, "_manifest.json")),
                                 provider=provider)
        partition_prefixes.append(prefix)
    builder.mark_published(dataset_version)
    builder.close()

    pointer = _catalog.publish(catalog_root, local_db, dataset_version, holder=holder)

    summary = {
        "job_id": job_id,
        "dataset_version": dataset_version,
        "raw_sha256": sources[0]["sha256"],
        "source_sha256s": {source["s3_key"]: source["sha256"] for source in sources},
        "conversion_started_ns": started_ns,
        "schema": sources[0]["schema"],
        "schemas": sorted({source["schema"] for source in sources}),
        "accepted": accepted,
        "rejected": evidence["rejected"],
        "rejected_summary": evidence["reasons"],
        "partitions": sorted(partition_prefixes),
        "catalog_pointer": pointer,
    }
    with open(os.path.join(job_stage, "job.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2, sort_keys=True)
    return summary


def _convert_file(source_path, schema, dataset_version, *, staging_root, curated_root, catalog_root,
                  dataset=None, symbol=None, s3_key=None, expected_sha256=None, node_bin="node", worker_path=None,
                  holder="conversion"):
    return _convert_sources([{
        "source_path": source_path, "schema": schema, "dataset": dataset, "symbol": symbol, "s3_key": s3_key,
        "expected_sha256": expected_sha256,
    }], dataset_version, staging_root=staging_root, curated_root=curated_root, catalog_root=catalog_root,
       node_bin=node_bin, worker_path=worker_path, holder=holder)


def convert_file(source_path, schema, dataset_version, **kwargs):
    from local_lock import LocalLock, conversion_guard_path
    _writer.validate_version(dataset_version)
    root = os.path.realpath(os.fspath(kwargs["curated_root"]))
    with LocalLock(conversion_guard_path(root, dataset_version)):
        return _convert_file(source_path, schema, dataset_version, **kwargs)


def convert_files(sources, dataset_version, **kwargs):
    from local_lock import LocalLock, conversion_guard_path
    _writer.validate_version(dataset_version)
    root = os.path.realpath(os.fspath(kwargs["curated_root"]))
    with LocalLock(conversion_guard_path(root, dataset_version)):
        return _convert_sources(sources, dataset_version, **kwargs)
