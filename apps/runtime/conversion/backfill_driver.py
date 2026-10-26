from __future__ import annotations

import os
import shutil
import datetime
import json
import sys
from pathlib import Path

import checkpoint as _ckpt
import catalog as _catalog
import dbn as _dbn
import job as _job
import raw_source
import rejection_evidence as _rejections
import s3_publish
import writer as _writer
from local_lock import LocalLock, conversion_guard_path

DEFAULT_MIN_FREE_BYTES = 50 * 1024**3
MAX_QUARANTINED_DAYS_PER_MONTH = 3


class BackfillError(RuntimeError):
    pass


def _nearest_existing_ancestor(path):
    current = os.path.abspath(path)
    while not os.path.exists(current):
        parent = os.path.dirname(current)
        if parent == current:
            raise BackfillError(f"NO_EXISTING_ANCESTOR:{path}")
        current = parent
    return current


def check_storage(path, min_free_bytes=DEFAULT_MIN_FREE_BYTES):
    if isinstance(min_free_bytes, bool) or not isinstance(min_free_bytes, int) or min_free_bytes <= 0:
        raise BackfillError("INVALID_FREE_SPACE_FLOOR")
    free = shutil.disk_usage(_nearest_existing_ancestor(path)).free
    if free < min_free_bytes:
        raise BackfillError(f"INSUFFICIENT_FREE_DISK:{free}<{min_free_bytes}")


def job_stage_for(inputs, dataset_version, staging_root, definition_sources=None, families=None):
    descs = [_job._describe_input(**i) for i in inputs]
    resolved_definition_sources = [
        dict(s, sha256=_job._convert._sha256_file(s["local_path"])) for s in (definition_sources or [])
    ]
    job_id = _job.job_id_for(descs, dataset_version, resolved_definition_sources, families)
    return os.path.join(os.fspath(staging_root), job_id)


def clean_partition_staging_for_date(job_stage, partitions, date):
    root = Path(job_stage).resolve()
    targets = []
    for partition in partitions:
        parts = partition.split("/")
        if (len(parts) != 5 or parts[0] not in ("databento", "binance")
                or any(p in ("", ".", "..") or "\\" in p or ":" in p for p in parts)):
            raise BackfillError("UNSAFE_CLEANUP_PATH")
        if parts[-1] != date:
            continue
        candidate = root.joinpath(*parts[1:])
        if not candidate.resolve().is_relative_to(root) or any(p.is_symlink() for p in [candidate, *candidate.parents] if p != root and root in p.parents):
            raise BackfillError("UNSAFE_CLEANUP_PATH")
        targets.append(candidate)
    cleaned = []
    for candidate in targets:
        staging_dir = str(candidate)
        if os.path.isdir(staging_dir):
            shutil.rmtree(staging_dir)
            cleaned.append(staging_dir)
    return cleaned


def clean_completed_job_split_staging(job_stage, staging_root):
    """Release a fully published job's day-split source files, retaining its
    checkpoint, frozen inventory and publication evidence for later audit."""
    supplied_stage = Path(job_stage).absolute()
    supplied_root = Path(staging_root).absolute()
    # `resolve()` is useful for the containment check below, but doing it
    # before rejecting a replaced job directory would make a symlink outside
    # the configured staging tree look legitimate.
    if supplied_stage.is_symlink() or supplied_root.is_symlink():
        raise BackfillError("UNSAFE_COMPLETED_SCRATCH")
    try:
        relative_stage = supplied_stage.relative_to(supplied_root)
    except ValueError as error:
        raise BackfillError("UNSAFE_COMPLETED_SCRATCH") from error
    stage = supplied_stage.resolve()
    root = supplied_root.resolve()
    if not stage.is_relative_to(root):
        raise BackfillError("UNSAFE_COMPLETED_SCRATCH")
    # Reject an intermediate symlink even when it happens to point somewhere
    # below the root: cleanup must only traverse the configured staging tree.
    candidate = supplied_root
    for component in relative_stage.parts:
        candidate = candidate / component
        if candidate.is_symlink():
            raise BackfillError("UNSAFE_COMPLETED_SCRATCH")
    target = stage / "raw"
    if not target.exists():
        return False
    if target.is_symlink() or not target.resolve().is_relative_to(stage):
        raise BackfillError("UNSAFE_COMPLETED_SCRATCH")
    for parent in target.parents:
        if parent == stage:
            break
        if parent.is_symlink():
            raise BackfillError("UNSAFE_COMPLETED_SCRATCH")
    shutil.rmtree(target)
    return True


def run_one_day(inputs, dataset_version, date, *, staging_root, curated_root, catalog_root,
                min_free_bytes=DEFAULT_MIN_FREE_BYTES, **job_kwargs):
    check_storage(staging_root, min_free_bytes)
    result = _job.run_job(
        inputs, dataset_version, target_date=date,
        staging_root=staging_root, curated_root=curated_root, catalog_root=catalog_root,
        cleanup_date_staging=True, **job_kwargs,
    )
    return result


def _validate_dates(dates):
    if any(not isinstance(d, str) or datetime.date.fromisoformat(d).isoformat() != d for d in dates):
        raise BackfillError("INVALID_TARGET_DATE")
    if dates != sorted(set(dates)):
        raise BackfillError("DATES_MUST_BE_UNIQUE_AND_ORDERED")


def run_range(inputs, dataset_version, dates, *, staging_root, curated_root, catalog_root,
              min_free_bytes=DEFAULT_MIN_FREE_BYTES, **job_kwargs):
    dates = list(dates)
    _validate_dates(dates)
    results = []
    for date in dates:
        result = run_one_day(
            inputs, dataset_version, date,
            staging_root=staging_root, curated_root=curated_root, catalog_root=catalog_root,
            min_free_bytes=min_free_bytes, **job_kwargs,
        )
        results.append(result)
    return results


def _next_day(date_str):
    return (datetime.date.fromisoformat(date_str) + datetime.timedelta(days=1)).isoformat()


def inclusive_date_range(start_date, end_date):
    start = datetime.date.fromisoformat(start_date)
    end = datetime.date.fromisoformat(end_date)
    if end < start:
        raise BackfillError("END_DATE_BEFORE_START_DATE")
    dates = []
    current = start
    while current <= end:
        dates.append(current.isoformat())
        current += datetime.timedelta(days=1)
    return dates


def _evict_one(store, checkpoint, job_stage, curated_root, dataset_version, entry):
    instrument_id, family, date = entry["instrument_id"], entry["family"], entry["date"]
    prefix = f"{entry.get('provider', 'databento')}/{_writer.instrument_slug(instrument_id)}/{family}/{dataset_version}/{date}"
    local_dir = os.path.join(curated_root, *prefix.split("/"))
    if not os.path.isdir(local_dir):
        raise BackfillError(f"EVICTION_TARGET_MISSING_BEFORE_UPLOAD_CONFIRMED:{instrument_id}:{family}:{date}")
    staged_rows = os.path.join(job_stage, _writer.instrument_slug(instrument_id), family, dataset_version, date, "rows.ndjson")
    legacy_logical_sha256 = _writer.legacy_sorted_logical_sha256(staged_rows) if os.path.isfile(staged_rows) else None
    published = s3_publish.publish_partition(
        store, curated_root, prefix, entry["manifest_sha256"], legacy_logical_sha256=legacy_logical_sha256,
    )
    if published["manifest_sha256"] != entry["manifest_sha256"]:
        _ckpt.reconcile_partition_manifest(
            checkpoint, instrument_id, family, date, published["manifest"], published["manifest_sha256"],
        )
    entry["remote_namespace"] = {"bucket": store.bucket, "prefix": store.prefix}
    _ckpt.mark_partition_evicted(checkpoint, instrument_id, family, date)
    _ckpt.save(job_stage, checkpoint, _now_iso())
    shutil.rmtree(local_dir)


def _resume_quarantined(job_stage, retry_quarantined):
    checkpoint = _ckpt.load(job_stage) if os.path.isdir(job_stage) else None
    if checkpoint is None:
        return []
    if not retry_quarantined:
        return _ckpt.quarantined_dates(checkpoint)
    if _ckpt.clear_quarantined_dates(checkpoint):
        _ckpt.save(job_stage, checkpoint, _now_iso())
    return []


def _record_quarantined(job_stage, date, error):
    evidence = _rejections.archive_for_date(job_stage, date)
    if evidence is None:
        raise BackfillError(f"QUARANTINE_EVIDENCE_MISSING:{date}")
    checkpoint = _ckpt.load(job_stage)
    if checkpoint is None:
        raise BackfillError(f"QUARANTINE_CHECKPOINT_MISSING:{date}")
    entry = _ckpt.mark_date_quarantined(
        checkpoint, date, error=error, evidence=evidence,
        evidence_sha256=_convert_sha256(evidence), attempted_at=_now_iso(),
    )
    _ckpt.save(job_stage, checkpoint, _now_iso())
    return dict(entry)


def _convert_sha256(path):
    return _job._convert._sha256_file(path)


def _make_publish_and_evict(store):
    def _hook(checkpoint, job_stage, curated_root, dataset_version, instrument_id, family, date):
        entry = next(
            e for e in checkpoint["completed_partitions"]
            if (e["instrument_id"], e["family"], e["date"]) == (instrument_id, family, date)
        )
        _evict_one(store, checkpoint, job_stage, curated_root, dataset_version, entry)
    return _hook


def load_supersede_allowlist(path):
    try:
        record = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise BackfillError("SUPERSEDE_ALLOWLIST_UNREADABLE") from error
    try:
        authorities = s3_publish._superseded_authorities(record)
    except s3_publish.PublicationError as error:
        raise BackfillError("SUPERSEDE_ALLOWLIST_INVALID") from error
    return {"reason": record["reason"], "approved_by": record["approved_by"], "authorities": authorities}


def supersedes_for(curated_root, payload, parent, allowlist):
    if allowlist is None or not s3_publish._has_catalog_pointer(parent):
        return None
    root = Path(curated_root)
    candidate_key, candidate_sha256 = s3_publish._catalog_pointer(payload)
    parent_key, parent_sha256 = s3_publish._catalog_pointer(parent)
    after = s3_publish._catalog_authorities(s3_publish._local(root, "_catalog/" + candidate_key), candidate_sha256)
    before = s3_publish._catalog_authorities(s3_publish._local(root, "_catalog/" + parent_key), parent_sha256)
    changed = sorted(authority for authority, value in before.items()
                     if authority in after and after[authority] != value)
    if not changed:
        return None
    unapproved = [authority for authority in changed if authority not in allowlist["authorities"]]
    if unapproved:
        raise BackfillError(f"SUPERSEDENCE_NOT_APPROVED:{len(unapproved)}:{'|'.join(unapproved[0])}")
    return {"reason": allowlist["reason"], "approved_by": allowlist["approved_by"],
            "authorities": [list(authority) for authority in changed]}


def _make_remote_publish_hook(store, curated_root, supersede_allowlist=None):
    def _hook(payload, parent):
        supersedes = supersedes_for(curated_root, payload, parent, supersede_allowlist)
        if supersedes is None:
            s3_publish.publish(store, curated_root, payload, expected_parent=parent)
        else:
            s3_publish.publish(store, curated_root, payload, expected_parent=parent, supersedes=supersedes)
        current, _ = store.get_json("_catalog/CURRENT.json")
        if current != payload:
            raise s3_publish.PublicationError("PUBLICATION_PARENT_CHANGED")
    return _hook


_MAX_STALE_INTENT_RETRIES = 3


def recover_from_stale_intent(fn, *, catalog_root, dataset_version, expected_job_id=None):
    for attempt in range(_MAX_STALE_INTENT_RETRIES):
        try:
            return fn()
        except s3_publish.PublicationError as error:
            if "PUBLICATION_PARENT_CHANGED" not in str(error) or attempt == _MAX_STALE_INTENT_RETRIES - 1:
                raise
            with _catalog.PublisherLock(catalog_root, holder="stale-intent-recovery"):
                receipt_path = os.path.join(catalog_root, f"receipt-{dataset_version}.json")
                if os.path.exists(receipt_path):
                    receipt = _catalog._read_json(receipt_path)
                    if expected_job_id is not None and receipt.get("job_id") != expected_job_id:
                        raise BackfillError("STALE_INTENT_OWNED_BY_OTHER_JOB")
                    continue
                intent_path = os.path.join(catalog_root, f"intent-{dataset_version}.json")
                intent = _catalog._read_json(intent_path)
                if not isinstance(intent, dict) or "parent" not in intent:
                    raise BackfillError("STALE_INTENT_INVALID")
                if expected_job_id is not None and intent.get("job_id") != expected_job_id:
                    raise BackfillError("STALE_INTENT_OWNED_BY_OTHER_JOB")
                if _catalog.read_current(catalog_root) == intent["parent"]:
                    raise BackfillError("REMOTE_PARENT_RECONCILIATION_REQUIRED")
                if os.path.exists(intent_path):
                    os.remove(intent_path)
                for suffix in (".sqlite", ".sqlite.preparing"):
                    stale_snapshot = os.path.join(catalog_root, f"catalog-{dataset_version}{suffix}")
                    if os.path.exists(stale_snapshot):
                        os.remove(stale_snapshot)


def _run_one_day_recovering_stale_intent(inputs, dataset_version, date, *, catalog_root, expected_job_id, **kwargs):
    return recover_from_stale_intent(
        lambda: run_one_day(inputs, dataset_version, date, catalog_root=catalog_root, **kwargs),
        catalog_root=catalog_root, dataset_version=dataset_version, expected_job_id=expected_job_id,
    )


def catch_up_evictions(store, job_stage, curated_root, dataset_version):
    with LocalLock(conversion_guard_path(curated_root, dataset_version)), LocalLock(os.path.realpath(os.path.dirname(job_stage)) + ".stage.guard"):
        return _catch_up_evictions(store, job_stage, curated_root, dataset_version)


def _catch_up_evictions(store, job_stage, curated_root, dataset_version):
    checkpoint = _ckpt.load(job_stage)
    if checkpoint is None:
        return []
    caught_up = []
    for entry in checkpoint["completed_partitions"]:
        instrument_id, family, date = entry["instrument_id"], entry["family"], entry["date"]
        if family == "candle_1m" and any(
            plan["instrument_id"] == instrument_id and plan["date"] == date
            and plan["family"] in {"candle_1h", "candle_1d"}
            and not _ckpt.is_partition_complete(checkpoint, instrument_id, plan["family"], date)
            for plan in checkpoint["authority_plan"]
        ):
            continue
        prefix = f"{entry.get('provider', 'databento')}/{_writer.instrument_slug(instrument_id)}/{family}/{dataset_version}/{date}"
        local_dir = os.path.join(curated_root, *prefix.split("/"))
        if entry.get("evicted"):
            if entry.get("remote_namespace") != {"bucket": store.bucket, "prefix": store.prefix}:
                raise BackfillError("EVICTED_NAMESPACE_MISMATCH")
            s3_publish.verify_remote_partition(store, prefix, entry["manifest_sha256"])
            if os.path.isdir(local_dir):
                shutil.rmtree(local_dir)
            continue
        _evict_one(store, checkpoint, job_stage, curated_root, dataset_version, entry)
        caught_up.append((instrument_id, family, date))
    return caught_up


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _build_s3_client():
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3", region_name=os.environ["RCLONE_CONFIG_TTCONVERT_REGION"],
        aws_access_key_id=os.environ["RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY"],
        config=Config(connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}),
    )


_DEFINITION_HISTORY_START = "2000-01-01"


def _continuous_interval_end(inputs):
    latest = None
    for entry in inputs:
        if _job._convert._is_csv(entry["local_path"]):
            continue
        meta = _dbn.read_metadata(entry["local_path"], expected_schema=entry["schema"])
        if meta.stype_in != "continuous" or not meta.symbols:
            continue
        for interval in meta.mappings.get(_job._continuous_alias(meta), []):
            if latest is None or interval["end_date"] > latest:
                latest = interval["end_date"]
    return latest


def run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs):
    _writer.validate_version(dataset_version)
    stage = os.path.realpath(os.fspath(kwargs["staging_root"]))
    with LocalLock(stage + ".backfill.guard"):
        return _run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs)


def _inventory(path, binding, discover):
    if path.exists():
        saved = json.loads(path.read_text(encoding="utf-8"))
        if saved["binding"] != binding:
            raise BackfillError("INVENTORY_BINDING_MISMATCH")
        return saved["objects"]
    objects = discover()
    path.parent.mkdir(parents=True, exist_ok=True)
    _ckpt._atomic_write_json(str(path), {"binding": binding, "objects": objects})
    return objects


def _tardis_day_files(objects, first_date, last_date):
    expected = inclusive_date_range(first_date, last_date)
    by_date = {}
    for obj in objects:
        by_date.setdefault(obj["covered_end"], []).append(obj)
    duplicated = sorted(date for date, found in by_date.items() if len(found) != 1)
    if duplicated:
        raise BackfillError(f"TARDIS_DAY_FILE_AMBIGUOUS:{','.join(duplicated)}")
    missing = [date for date in expected if date not in by_date]
    if missing:
        raise BackfillError(f"TARDIS_DAY_FILE_MISSING:{','.join(missing)}")
    return [by_date[date][0] for date in expected]


def _require_frozen_object_identities(objects):
    for obj in objects:
        if not isinstance(obj.get("s3_key"), str) or not obj.get("etag"):
            raise BackfillError("FROZEN_INVENTORY_MISSING_OBJECT_IDENTITY")


def _run_s3_backfill(dataset, schema, symbol, dates, dataset_version, *, bucket, curated_prefix,
                    staging_root, curated_root, catalog_root, min_free_bytes=DEFAULT_MIN_FREE_BYTES,
                    definition_symbol=None, client=None, allow_quarantine_skip=False,
                    max_quarantined_days=MAX_QUARANTINED_DAYS_PER_MONTH,
                    retry_quarantined=False, on_month_admission=None, supersede_allowlist=None, **job_kwargs):
    dates = list(dates)
    if not dates:
        raise BackfillError("NO_DATES_REQUESTED")
    job_kwargs["families"] = _job.validate_families(job_kwargs.get("families"))
    _validate_dates(dates)
    client = client or _build_s3_client()

    binding = {"bucket": bucket, "prefix": curated_prefix, "dataset": dataset, "schema": schema, "symbol": symbol}
    tardis = raw_source.is_tardis(dataset)
    list_end = _next_day(_next_day(dates[-1])) if tardis else _next_day(dates[-1])
    raw_objects = _inventory(Path(staging_root, "_plans", dataset_version + "-raw.json"), binding,
        lambda: raw_source.list_raw_objects(client, bucket, dataset, schema, symbol, dates[0], list_end))
    if not raw_objects:
        raise BackfillError(f"NO_RAW_OBJECTS_FOUND:{dataset}:{schema}:{symbol}:{dates[0]}..{dates[-1]}")
    _require_frozen_object_identities(raw_objects)
    if tardis:
        raw_objects = _tardis_day_files(raw_objects, dates[0], _next_day(dates[-1]))
    if on_month_admission is not None:
        on_month_admission(raw_objects)
    check_storage(staging_root, min_free_bytes + sum(o["bytes"] for o in raw_objects))

    raw_cache = os.path.join(staging_root, "_raw_cache")
    inputs = []
    downloaded = []
    for obj in raw_objects:
        print(json.dumps({"event": "download", "key": obj["s3_key"], "bytes": obj["bytes"]}), file=sys.stderr, flush=True)
        local_path = raw_source.ensure_local(client, bucket, obj["s3_key"], raw_cache, expected_etag=obj.get("etag"))
        downloaded.append(local_path)
        inputs.append({
            "local_path": local_path, "s3_key": obj["s3_key"], "schema": schema,
            "dataset": dataset, "symbol": symbol, "last_modified": obj["last_modified"],
        })
    if tardis:
        inputs = [{
            "stream": [{"local_path": item["local_path"], "s3_key": item["s3_key"]} for item in inputs],
            "s3_key": raw_source.raw_prefix(dataset, schema, symbol) + f"stream={dates[0]}..{dates[-1]}",
            "schema": schema, "dataset": dataset, "symbol": symbol, "window": [dates[0], dates[-1]],
            "last_modified": max(item["last_modified"] for item in inputs),
        }]

    if definition_symbol is not None:
        definition_end = _continuous_interval_end(inputs) or _next_day(max(o["covered_end"] for o in raw_objects))
        definition_objects = _inventory(Path(staging_root, "_plans", dataset_version + "-definitions.json"),
            {**binding, "definition_symbol": definition_symbol}, lambda: raw_source.list_raw_objects(
                client, bucket, dataset, "definition", definition_symbol, _DEFINITION_HISTORY_START, definition_end))
        if not definition_objects:
            raise BackfillError(f"NO_DEFINITION_OBJECTS_FOUND:{dataset}:{definition_symbol}")
        _require_frozen_object_identities(definition_objects)
        if on_month_admission is not None:
            on_month_admission(definition_objects)
        check_storage(staging_root, min_free_bytes + sum(o["bytes"] for o in definition_objects))
        definition_cache = os.path.join(staging_root, "_definition_cache")
        job_kwargs["definition_sources"] = [
            {"local_path": raw_source.ensure_local(client, bucket, obj["s3_key"], definition_cache, expected_etag=obj.get("etag")), "s3_key": obj["s3_key"]}
            for obj in definition_objects
        ]

    store = s3_publish.Store(client, bucket, curated_prefix)
    job_stage = job_stage_for(inputs, dataset_version, staging_root, definition_sources=job_kwargs.get("definition_sources"),
                              families=job_kwargs.get("families"))
    catch_up_evictions(store, job_stage, curated_root, dataset_version)

    results = []
    skipped_dates = []
    quarantined_dates = _resume_quarantined(job_stage, retry_quarantined)
    if len(quarantined_dates) > max_quarantined_days:
        raise BackfillError(
            f"QUARANTINED_DAY_BUDGET_EXCEEDED:{dataset_version}:{len(quarantined_dates)}>{max_quarantined_days}"
        )
    final = None
    for date in dates:
        if any(q["date"] == date for q in quarantined_dates):
            print(json.dumps({"event": "day_quarantined_already", "version": dataset_version, "date": date}),
                  file=sys.stderr, flush=True)
            continue
        print(json.dumps({"event": "day_start", "version": dataset_version, "date": date}), file=sys.stderr, flush=True)
        try:
            result = _run_one_day_recovering_stale_intent(
                inputs, dataset_version, date,
                staging_root=staging_root, curated_root=curated_root, catalog_root=catalog_root,
                min_free_bytes=min_free_bytes, on_partition_complete=_make_publish_and_evict(store),
                on_catalog_publish=_make_remote_publish_hook(store, curated_root, supersede_allowlist),
                expected_job_id=os.path.basename(job_stage), **job_kwargs,
            )
        except _job.JobError as error:
            if "TARGET_DATE_NOT_IN_PLAN" in str(error):
                skipped_dates.append(date)
                print(json.dumps({"event": "no_source_rows", "version": dataset_version, "date": date}), file=sys.stderr, flush=True)
                continue
            if not (allow_quarantine_skip and "QUARANTINE_BLOCKS_PUBLICATION" in str(error)):
                raise
            quarantined_dates.append(
                _record_quarantined(job_stage, date, f"{type(error).__name__}: {error}")
            )
            print(json.dumps({"event": "day_quarantined", "version": dataset_version, "date": date,
                              "quarantined_days": len(quarantined_dates),
                              "error": f"{type(error).__name__}: {error}"}), file=sys.stderr, flush=True)
            if len(quarantined_dates) > max_quarantined_days:
                raise BackfillError(
                    f"QUARANTINED_DAY_BUDGET_EXCEEDED:{dataset_version}:{len(quarantined_dates)}>{max_quarantined_days}"
                ) from error
            continue
        results.append(result)
        final = result
        print(json.dumps({"event": "day_complete", "version": dataset_version, "date": date}), file=sys.stderr, flush=True)

    fully_published = bool(final and final["fully_published"]) and not quarantined_dates
    cleaned_split_staging = False
    if fully_published:
        for local_path in [*downloaded, *(s["local_path"] for s in job_kwargs.get("definition_sources", []))]:
            os.remove(local_path)
            os.remove(local_path + ".identity.json")
        cleaned_split_staging = clean_completed_job_split_staging(job_stage, staging_root)

    return {"results": results, "skipped_dates": skipped_dates, "quarantined_dates": quarantined_dates,
            "fully_published": fully_published, "cleaned_split_staging": cleaned_split_staging}
