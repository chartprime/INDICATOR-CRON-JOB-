from __future__ import annotations

import datetime as dt
import io
import json
import os
import shutil
import sqlite3

import pytest

import backfill_driver as driver
import catalog
import job
import s3_publish
import rejection_evidence as rejections

_REAL_PROCESS_GROUP = job._process_group
from test_job import MBP1


@pytest.mark.parametrize("floor", [0, -1, True, float("nan")])
def test_invalid_storage_limits_fail_closed(tmp_path, floor):
    with pytest.raises(driver.BackfillError, match="INVALID_FREE_SPACE"):
        driver.check_storage(tmp_path, floor)


def test_cleanup_rejects_traversal_before_removing_anything(tmp_path):
    root = tmp_path / "stage"
    safe = root / "SLUG/candle/v1/2025-09-02"
    safe.mkdir(parents=True)
    with pytest.raises(driver.BackfillError, match="UNSAFE_CLEANUP"):
        driver.clean_partition_staging_for_date(str(root), [
            "databento/SLUG/candle/v1/2025-09-02", "databento/../outside/v1/2025-09-02"], "2025-09-02")
    assert safe.is_dir()


def test_completed_job_split_cleanup_preserves_job_evidence(tmp_path):
    stage = tmp_path / "stage"
    raw = stage / "raw" / "source" / "date=2025-09-04"
    raw.mkdir(parents=True)
    (raw / "rows.ndjson").write_text("evidence-free scratch", encoding="utf-8")
    checkpoint = stage / "checkpoint.json"
    checkpoint.write_text('{"durable": true}', encoding="utf-8")

    assert driver.clean_completed_job_split_staging(stage, stage) is True
    assert not (stage / "raw").exists()
    assert checkpoint.read_text(encoding="utf-8") == '{"durable": true}'
    assert driver.clean_completed_job_split_staging(stage, stage) is False


def test_completed_job_split_cleanup_rejects_replaced_stage_symlink(tmp_path):
    outside = tmp_path / "outside"
    (outside / "raw").mkdir(parents=True)
    (outside / "raw" / "must-survive").write_text("sentinel", encoding="utf-8")
    replaced = tmp_path / "replaced-stage"
    try:
        replaced.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation is unavailable in this test environment")

    with pytest.raises(driver.BackfillError, match="UNSAFE_COMPLETED_SCRATCH"):
        driver.clean_completed_job_split_staging(replaced, tmp_path)
    assert (outside / "raw" / "must-survive").read_text(encoding="utf-8") == "sentinel"


def test_completed_job_split_cleanup_rejects_symlinked_ancestor_under_staging(tmp_path):
    staging = tmp_path / "staging"
    outside = tmp_path / "outside"
    (outside / "job" / "raw").mkdir(parents=True)
    sentinel = outside / "job" / "raw" / "must-survive"
    sentinel.write_text("sentinel", encoding="utf-8")
    staging.mkdir()
    linked = staging / "linked"
    try:
        linked.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation is unavailable in this test environment")

    with pytest.raises(driver.BackfillError, match="UNSAFE_COMPLETED_SCRATCH"):
        driver.clean_completed_job_split_staging(linked / "job", staging)
    assert sentinel.read_text(encoding="utf-8") == "sentinel"


def test_cleanup_holds_conversion_lock(tmp_path, monkeypatch):
    from local_lock import LocalLock, conversion_guard_path
    roots = _roots(tmp_path)
    real = driver.clean_partition_staging_for_date
    observed = []
    def guarded(*args):
        with pytest.raises(OSError):
            with LocalLock(conversion_guard_path(roots["curated_root"], "v1")):
                pass
        observed.append(True)
        return real(*args)
    monkeypatch.setattr(driver, "clean_partition_staging_for_date", guarded)
    driver.run_one_day(_inputs(tmp_path), "v1", "2025-09-02", **roots)
    assert observed == [True]


def test_missing_date_is_not_success(tmp_path):
    with pytest.raises(job.JobError, match="TARGET_DATE_NOT_IN_PLAN"):
        driver.run_one_day(_inputs(tmp_path), "v1", "2025-09-04", **_roots(tmp_path))


def test_reversed_dates_refused_before_any_conversion(tmp_path, monkeypatch):
    def unexpected(*args, **kwargs):
        raise AssertionError("must not start")
    monkeypatch.setattr(driver, "run_one_day", unexpected)
    with pytest.raises(driver.BackfillError, match="UNIQUE_AND_ORDERED"):
        driver.run_range([], "v1", ["2025-09-03", "2025-09-02"], **_roots(tmp_path))


def test_completed_day_can_resume_after_staging_cleanup(tmp_path):
    roots, inputs = _roots(tmp_path), _inputs(tmp_path)
    first = driver.run_one_day(inputs, "v1", "2025-09-02", **roots)
    again = driver.run_one_day(inputs, "v1", "2025-09-02", **roots)
    assert again["partitions"] == first["partitions"]
    assert again["cleaned_staging_dirs"] == []
    final = driver.run_one_day(inputs, "v1", "2025-09-03", **roots)
    assert final["fully_published"]


_CSV_HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"
_CSV_ROWS = [
    "1756800000000000000,32,2,38,231460000000,231460000000,231460000000,231460000000,21",
    "1756886400000000000,32,2,38,232000000000,232500000000,231900000000,232400000000,1000",
]


def _csv_file(tmp_path):
    path = tmp_path / "aapl.ohlcv-1s.csv"
    path.write_text("\n".join([_CSV_HEADER, *_CSV_ROWS]) + "\n")
    return str(path)


def _roots(tmp_path):
    return {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }


def _inputs(tmp_path):
    return [{
        "local_path": _csv_file(tmp_path),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]


def test_check_storage_refuses_below_the_floor_and_passes_above_it(tmp_path, monkeypatch):
    import shutil as _shutil

    class _Usage:
        def __init__(self, free):
            self.free = free

    monkeypatch.setattr(driver.shutil, "disk_usage", lambda path: _Usage(10))
    with pytest.raises(driver.BackfillError, match="INSUFFICIENT_FREE_DISK"):
        driver.check_storage(str(tmp_path), min_free_bytes=100)

    monkeypatch.setattr(driver.shutil, "disk_usage", lambda path: _Usage(1000))
    driver.check_storage(str(tmp_path), min_free_bytes=100)


def test_job_stage_for_matches_the_real_job_stage_job_run_job_uses(tmp_path):
    roots = _roots(tmp_path)
    inputs = _inputs(tmp_path)
    result = job.run_job(inputs, "v1", **roots)
    expected_job_id = result["job_id"]

    computed = driver.job_stage_for(inputs, "v1", roots["staging_root"])

    assert computed == os.path.join(roots["staging_root"], expected_job_id)
    assert os.path.isdir(computed)


def test_s3_backfill_refuses_a_preexisting_inventory_without_frozen_object_identity(tmp_path):
    roots = _roots(tmp_path)
    stage = os.path.join(roots["staging_root"], "_plans")
    os.makedirs(stage)
    binding = {
        "bucket": "bucket", "prefix": "curated/test", "dataset": "XNAS.ITCH",
        "schema": "ohlcv-1s", "symbol": "AAPL",
    }
    with open(os.path.join(stage, "v1-raw.json"), "w", encoding="utf-8") as fh:
        json.dump({"binding": binding, "objects": [{
            "s3_key": _S3_RAW_KEY, "bytes": 1, "last_modified": "2025-09-01T00:00:00+00:00",
            "covered_end": "2025-09-30",
        }]}, fh)

    with pytest.raises(driver.BackfillError, match="FROZEN_INVENTORY_MISSING_OBJECT_IDENTITY"):
        driver.run_s3_backfill(
            "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
            bucket="bucket", curated_prefix="curated/test", min_free_bytes=1, client=FakeBucket(), **roots,
        )


def test_clean_partition_staging_for_date_only_removes_the_matching_date(tmp_path):
    job_stage = str(tmp_path / "stage" / "somejobid")
    day1 = os.path.join(job_stage, "SLUG", "candle", "v1", "2025-09-02")
    day2 = os.path.join(job_stage, "SLUG", "candle", "v1", "2025-09-03")
    os.makedirs(day1)
    os.makedirs(day2)

    cleaned = driver.clean_partition_staging_for_date(
        job_stage,
        ["databento/SLUG/candle/v1/2025-09-02", "databento/SLUG/candle/v1/2025-09-03"],
        "2025-09-02",
    )

    assert cleaned == [day1]
    assert not os.path.exists(day1)
    assert os.path.isdir(day2)


def test_run_one_day_processes_only_that_date_and_cleans_only_its_own_staging(tmp_path):
    roots = _roots(tmp_path)
    inputs = _inputs(tmp_path)

    first = driver.run_one_day(inputs, "v1", "2025-09-02", **roots)
    assert [p.split("/")[-1] for p in first["partitions"]] == ["2025-09-02"]
    assert first["fully_published"] is False
    assert len(first["cleaned_staging_dirs"]) == 1

    job_stage = driver.job_stage_for(inputs, "v1", roots["staging_root"])
    day1_dir = os.path.join(job_stage, os.path.basename(first["cleaned_staging_dirs"][0]))
    assert not os.path.exists(first["cleaned_staging_dirs"][0])

    day2_split = job._split.split_dir(job_stage, inputs[0]["s3_key"])
    assert os.path.isdir(day2_split)


def test_run_one_day_refuses_when_disk_is_too_thin(tmp_path, monkeypatch):
    roots = _roots(tmp_path)
    inputs = _inputs(tmp_path)

    class _Usage:
        free = 10

    monkeypatch.setattr(driver.shutil, "disk_usage", lambda path: _Usage())
    with pytest.raises(driver.BackfillError, match="INSUFFICIENT_FREE_DISK"):
        driver.run_one_day(inputs, "v1", "2025-09-02", min_free_bytes=100, **roots)


def test_run_range_processes_every_date_in_order_and_finishes_fully_published(tmp_path):
    roots = _roots(tmp_path)
    inputs = _inputs(tmp_path)

    results = driver.run_range(inputs, "v1", ["2025-09-02", "2025-09-03"], **roots)

    assert [r["fully_published"] for r in results] == [False, True]
    assert results[-1]["catalog_pointer"] is not None
    assert catalog.read_current(roots["catalog_root"]) == results[-1]["catalog_pointer"]


class _S3Error(Exception):
    def __init__(self, status):
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}}


class FakeBucket:
    """One fake client standing in for the whole bucket: raw/ discovery +
    download (list_objects_v2/head_object/get_object) and curated/ conditional
    writes (put_object) -- exactly what run_s3_backfill needs from one client,
    covering both raw_source.py and s3_publish.Store."""

    def __init__(self):
        self.objects = {}
        self.last_modified = {}
        self.before_put = None

    def put_raw(self, key, data, last_modified=dt.datetime(2025, 9, 1, tzinfo=dt.timezone.utc)):
        self.objects[key] = data
        self.last_modified[key] = last_modified

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        client = self

        class _Paginator:
            def paginate(self, Bucket, Prefix):
                matching = sorted(k for k in client.objects if k.startswith(Prefix))
                yield {"Contents": [
                    {"Key": k, "Size": len(client.objects[k]), "LastModified": client.last_modified[k],
                     "ETag": _etag(client.objects[k])}
                    for k in matching
                ]}
        return _Paginator()

    def head_object(self, Bucket, Key, ChecksumMode=None):
        return {"ContentLength": len(self.objects[Key]), "ETag": _etag(self.objects[Key])}

    def get_object(self, Bucket, Key, IfMatch=None):
        if Key not in self.objects:
            raise _S3Error(404)
        data = self.objects[Key]
        if IfMatch is not None and IfMatch != _etag(data):
            raise _S3Error(412)
        return {"Body": io.BytesIO(data), "ETag": _etag(data)}

    def put_object(self, **args):
        key = args["Key"]
        if self.before_put:
            self.before_put(key)
        old = self.objects.get(key)
        if args.get("IfNoneMatch") == "*" and old is not None:
            raise _S3Error(412)
        if "IfMatch" in args and (old is None or _etag(old) != args["IfMatch"]):
            raise _S3Error(412)
        body = args["Body"]
        data = body.read() if hasattr(body, "read") else body
        self.objects[key] = data
        self.last_modified[key] = dt.datetime.now(dt.timezone.utc)


def _etag(data):
    import hashlib
    return hashlib.sha256(data).hexdigest()


_S3_CSV_HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"
_S3_CSV_ROWS = [
    "1756800000000000000,32,2,38,231460000000,231460000000,231460000000,231460000000,21",
    "1756886400000000000,32,2,38,232000000000,232500000000,231900000000,232400000000,1000",
]
_S3_RAW_KEY = "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv"


_S3_CSV_ROW_PRIOR_MONTH = "1756684799984035837,32,2,38,231000000000,231000000000,231000000000,231000000000,1"


def test_a_month_is_complete_when_every_date_it_was_scoped_to_convert_is_published(tmp_path):
    # The live L1 failure, reproduced. A GLBX monthly file declares a span that
    # opens milliseconds before midnight, so the authority plan names the prior
    # month's last day. backfill_sequence iterates the calendar month and never
    # visits it, and grading the whole plan then reported a month that converted
    # every one of its own dates as INCOMPLETE_PUBLICATION -- which killed the
    # symbol outright, all twelve months of it.
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, _S3_CSV_ROW_PRIOR_MONTH, *_S3_CSV_ROWS]) + "\n").encode())
    roots = _roots(tmp_path)

    outcome = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1-aapl-2025-09",
        bucket="bucket", curated_prefix="curated/test", client=client, **roots,
    )

    import glob as _glob
    checkpoints = _glob.glob(os.path.join(roots["staging_root"], "*", "checkpoint.json"))
    assert len(checkpoints) == 1
    with open(checkpoints[0], encoding="utf-8") as handle:
        planned = {e["date"] for e in json.load(handle)["authority_plan"]}
    assert "2025-08-31" in planned, "the plan must still record what the source really spans"

    assert outcome["fully_published"] is True, "every date the month was scoped to convert is published"
    current, _ = s3_publish.Store(client, "bucket", "curated/test").get_json("_catalog/CURRENT.json")
    assert current is not None, "a complete month publishes its catalog"


def test_evict_one_raises_rather_than_silently_marking_a_missing_file_evicted(tmp_path):
    # The real gap this closes: if local files are somehow already gone
    # before eviction was ever confirmed, marking the checkpoint "evicted"
    # anyway would be silent data loss -- we'd be claiming it's safely in
    # S3 when it was never actually verified there. This must fail loudly.
    roots = _roots(tmp_path)
    inputs = _inputs(tmp_path)
    result = job.run_job(inputs, "v1", target_date="2025-09-02", **roots)
    job_stage = driver.job_stage_for(inputs, "v1", roots["staging_root"])
    checkpoint = job._ckpt.load(job_stage)
    entry = checkpoint["completed_partitions"][0]
    shutil.rmtree(os.path.join(roots["curated_root"], result["partitions"][0]))

    store = s3_publish.Store(FakeBucket(), "bucket", "curated/test")
    with pytest.raises(driver.BackfillError, match="EVICTION_TARGET_MISSING_BEFORE_UPLOAD_CONFIRMED"):
        driver._evict_one(store, checkpoint, job_stage, roots["curated_root"], "v1", entry)


def test_legacy_remote_partition_rewrites_the_evicted_checkpoint_to_remote_identity(tmp_path, monkeypatch):
    curated_root = str(tmp_path / "curated")
    job_stage = str(tmp_path / "staging" / "job")
    instrument_id, family, date = "instrument", "quote", "2025-09-02"
    manifest = {
        "instrument_id": instrument_id, "family": family, "dataset_version": "v1", "date": date,
        "record_count": 1, "rejected_count": 0, "event_ns_min": 100, "event_ns_max": 100,
        "logical_sha256": "new-logical", "parts": [{"sha256": "new-part"}],
    }
    checkpoint = job._ckpt.new("job", "v1", 0, [], [])
    job._ckpt.mark_partition_complete(checkpoint, instrument_id, family, date, manifest, "new-manifest")
    entry = checkpoint["completed_partitions"][0]
    local_dir = job._completed_partition_dest(curated_root, "v1", instrument_id, family, date)
    os.makedirs(local_dir)
    staged_rows = os.path.join(job_stage, job._writer.instrument_slug(instrument_id), family, "v1", date, "rows.ndjson")
    os.makedirs(os.path.dirname(staged_rows), exist_ok=True)
    with open(staged_rows, "w", encoding="utf-8") as fh:
        fh.write('{"row":"for legacy digest"}\n')
    remote_manifest = {**manifest, "logical_sha256": "old-sorted-logical", "parts": [{"sha256": "old-part"}]}
    published = {}

    def fake_publish(*args, **kwargs):
        published.update(kwargs)
        return {"status": "ALREADY_PUBLISHED_LEGACY", "manifest": remote_manifest,
                "manifest_sha256": "old-manifest"}

    monkeypatch.setattr(driver.s3_publish, "publish_partition", fake_publish)
    store = s3_publish.Store(FakeBucket(), "bucket", "curated/test")
    driver._evict_one(store, checkpoint, job_stage, curated_root, "v1", entry)

    assert published["legacy_logical_sha256"] == job._writer.legacy_sorted_logical_sha256(staged_rows)
    assert entry["evicted"] is True
    assert entry["manifest_sha256"] == "old-manifest"
    assert entry["part_sha256s"] == ["old-part"]
    assert entry["catalog_fields"]["logical_sha256"] == "old-sorted-logical"
    reconstructed, _prefix = job._manifest_and_prefix_for(curated_root, "v1", entry)
    assert reconstructed["logical_sha256"] == "old-sorted-logical"
    assert not os.path.exists(local_dir)


def test_catch_up_evictions_finishes_an_interrupted_eviction(tmp_path):
    # Simulates a crash after a partition completed but before the push+evict
    # hook ever ran (or got interrupted mid-way) -- local files are still
    # intact. A fresh call must finish the job, not leave it stuck forever
    # (on_partition_complete only ever fires once, for newly-completed
    # partitions -- it is never retried on its own).
    roots = _roots(tmp_path)
    inputs = _inputs(tmp_path)
    result = job.run_job(inputs, "v1", target_date="2025-09-02", **roots)
    job_stage = driver.job_stage_for(inputs, "v1", roots["staging_root"])
    prefix = result["partitions"][0]

    client = FakeBucket()
    store = s3_publish.Store(client, "bucket", "curated/test")
    caught_up = driver.catch_up_evictions(store, job_stage, roots["curated_root"], "v1")

    assert len(caught_up) == 1
    assert not os.path.exists(os.path.join(roots["curated_root"], prefix))
    assert client.objects[f"curated/test/{prefix}/_manifest.json"]
    reloaded = job._ckpt.load(job_stage)
    assert reloaded["completed_partitions"][0]["evicted"] is True


def test_catch_up_keeps_a_minute_partition_needed_by_unfinished_rollups(tmp_path, monkeypatch):
    minute = tmp_path / "aapl.ohlcv-1m.csv"
    minute.write_text("\n".join([_CSV_HEADER, *[
        "1756819800000000000,32,2,38,231460000000,231800000000,231400000000,231700000000,21",
        "1756819860000000000,32,2,38,231700000000,232900000000,231100000000,232000000000,472",
    ]]) + "\n")
    roots = _roots(tmp_path)
    inputs = [{
        "local_path": str(minute),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1m/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1m", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]
    real = job._derive_candle_rollups
    monkeypatch.setattr(job, "_derive_candle_rollups", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("stop")))
    with pytest.raises(RuntimeError, match="stop"):
        job.run_job(inputs, "v1", **roots)
    monkeypatch.setattr(job, "_derive_candle_rollups", real)

    stage = driver.job_stage_for(inputs, "v1", roots["staging_root"])
    client = FakeBucket()
    store = s3_publish.Store(client, "bucket", "curated/test")
    assert driver.catch_up_evictions(store, stage, roots["curated_root"], "v1") == []
    assert not client.objects

    result = job.run_job(inputs, "v1", on_partition_complete=driver._make_publish_and_evict(store), **roots)
    assert {prefix.split("/")[2] for prefix in result["partitions"]} == {
        "candle_1m", "candle_1h", "candle_1d"}
    assert len([key for key in client.objects if key.endswith("/_manifest.json")]) == 3


def test_catch_up_evictions_sweeps_a_dangling_directory_already_marked_evicted(tmp_path):
    # Simulates a crash between "persist evicted=True" (durable, safe) and
    # "delete the local directory" (not yet run) -- the checkpoint already
    # safely reflects success; catch-up should just finish the cleanup
    # without re-uploading anything.
    roots = _roots(tmp_path)
    inputs = _inputs(tmp_path)
    result = job.run_job(inputs, "v1", target_date="2025-09-02", **roots)
    job_stage = driver.job_stage_for(inputs, "v1", roots["staging_root"])
    prefix = result["partitions"][0]
    checkpoint = job._ckpt.load(job_stage)
    client = FakeBucket()
    store = s3_publish.Store(client, "bucket", "curated/test")
    s3_publish.publish_partition(store, roots["curated_root"], prefix, checkpoint["completed_partitions"][0]["manifest_sha256"])
    checkpoint["completed_partitions"][0]["remote_namespace"] = {"bucket": "bucket", "prefix": "curated/test"}
    job._ckpt.mark_partition_evicted(checkpoint, *[checkpoint["completed_partitions"][0][k] for k in ("instrument_id", "family", "date")])
    job._ckpt.save(job_stage, checkpoint, "2025-09-01T00:00:00Z")

    def fail(*a, **k):
        raise AssertionError("must not re-upload an already-evicted partition")
    client.put_object = fail
    store = s3_publish.Store(client, "bucket", "curated/test")

    caught_up = driver.catch_up_evictions(store, job_stage, roots["curated_root"], "v1")

    assert caught_up == []
    assert not os.path.exists(os.path.join(roots["curated_root"], prefix))


def test_run_s3_backfill_pushes_and_evicts_each_day_then_publishes_once(tmp_path):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    roots = _roots(tmp_path)

    outcome = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client, **roots,
    )

    assert [r["fully_published"] for r in outcome["results"]] == [False, True]
    assert outcome["fully_published"] is True
    assert outcome["cleaned_split_staging"] is True
    assert outcome["skipped_dates"] == []
    final = outcome["results"][-1]

    # Each day's curated partition is gone locally the moment it's pushed --
    # never both sitting on disk at once.
    for prefix in final["partitions"]:
        assert not os.path.exists(os.path.join(roots["curated_root"], prefix))
        assert client.objects[f"curated/test/{prefix}/_manifest.json"]

    # The catalog snapshot + CURRENT.json landed in S3 exactly once, at the end.
    current, _ = s3_publish.Store(client, "bucket", "curated/test").get_json("_catalog/CURRENT.json")
    assert current == final["catalog_pointer"]

    # The raw input is only freed once the whole requested range is done.
    raw_cache = os.path.join(roots["staging_root"], "_raw_cache")
    assert os.listdir(raw_cache) == [".cache.guard"]
    assert not os.path.exists(os.path.join(roots["staging_root"], final["job_id"], "raw"))


def test_eviction_retry_checks_destination_and_remote_bytes(tmp_path):
    roots, inputs = _roots(tmp_path), _inputs(tmp_path)
    result = job.run_job(inputs, "v1", target_date="2025-09-02", **roots)
    stage = driver.job_stage_for(inputs, "v1", roots["staging_root"])
    client = FakeBucket()
    store = s3_publish.Store(client, "bucket", "curated/test")
    driver.catch_up_evictions(store, stage, roots["curated_root"], "v1")
    with pytest.raises(driver.BackfillError, match="EVICTED_NAMESPACE_MISMATCH"):
        driver.catch_up_evictions(s3_publish.Store(client, "bucket", "curated/other"), stage, roots["curated_root"], "v1")
    part = next(k for k in client.objects if k.endswith(".parquet"))
    client.objects[part] = b"corrupt"
    with pytest.raises(s3_publish.PublicationError, match="REMOTE_ARTIFACT_MISMATCH"):
        driver.catch_up_evictions(store, stage, roots["curated_root"], "v1")


def test_two_dataset_versions_publish_remotely_through_the_same_hook_and_chain_correctly(tmp_path):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    client.put_raw(_S3_RAW_KEY.replace("AAPL", "TSLA"), ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    roots_a = _roots(tmp_path / "a")
    roots_b = {**roots_a, "staging_root": str(tmp_path / "b" / "staging")}

    outcome_a = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client, **roots_a,
    )
    outcome_b = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "TSLA", ["2025-09-02", "2025-09-03"], "v2",
        bucket="bucket", curated_prefix="curated/test", client=client, **roots_b,
    )

    assert outcome_a["fully_published"] is True
    assert outcome_b["fully_published"] is True
    store = s3_publish.Store(client, "bucket", "curated/test")
    current, _ = store.get_json("_catalog/CURRENT.json")
    assert current["dataset_version"] == "v2"

    con = sqlite3.connect(":memory:")
    con.execute("ATTACH DATABASE ? AS snap", [os.path.join(roots_a["catalog_root"], current["catalog_key"])])
    try:
        versions = {r[0] for r in con.execute("SELECT dataset_version FROM snap.dataset_versions")}
    finally:
        con.close()
    assert versions == {"v1", "v2"}  # v2's remote snapshot still carries v1's history


def _authorities_in(catalog_root, pointer):
    path = os.path.join(catalog_root, pointer["catalog_key"])
    return s3_publish._catalog_authorities(path, pointer["catalog_sha256"])


def _allowlist_file(tmp_path, authorities):
    path = tmp_path / "allowlist.json"
    path.write_text(json.dumps({"reason": "re-derive after the coverage fix", "approved_by": "owner",
                                "authorities": [list(a) for a in authorities]}), encoding="utf-8")
    return str(path)


def test_a_corrected_rederivation_replaces_only_the_approved_days_and_records_the_supersedence(tmp_path):
    # Report 58 L2 correction: the ES/NQ August depth days must be re-derived
    # under a new version and replace the published stubs, while every other
    # published partition stays byte-identical.
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    client.put_raw(_S3_RAW_KEY.replace("AAPL", "TSLA"), ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    roots = _roots(tmp_path / "a")
    stages = iter(range(100))

    def stage():
        # Short staging paths keep the split files under Windows' 260-character limit under xdist.
        return str(tmp_path / "s" / str(next(stages)))

    for symbol, version in (("AAPL", "v1-aapl"), ("TSLA", "v1-tsla")):
        driver.run_s3_backfill("XNAS.ITCH", "ohlcv-1s", symbol, ["2025-09-02", "2025-09-03"], version,
                               bucket="bucket", curated_prefix="curated/test", client=client,
                               **{**roots, "staging_root": stage()})
    store = s3_publish.Store(client, "bucket", "curated/test")
    before_pointer, _ = store.get_json("_catalog/CURRENT.json")
    before = _authorities_in(roots["catalog_root"], before_pointer)
    aapl = sorted(a for a in before if '"AAPL"' in a[0])
    assert [a[2] for a in aapl] == ["2025-09-02", "2025-09-03"]

    def correct(version, allowlist):
        return driver.run_s3_backfill(
            "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], version,
            bucket="bucket", curated_prefix="curated/test", client=client,
            supersede_allowlist=allowlist, **{**roots, "staging_root": stage()})

    with pytest.raises(s3_publish.PublicationError, match="PARENT_PARTITION_REPLACED"):
        correct("v2-aapl-unapproved", None)
    with pytest.raises(driver.BackfillError, match="SUPERSEDENCE_NOT_APPROVED"):
        correct("v2-aapl-partial", driver.load_supersede_allowlist(_allowlist_file(tmp_path, aapl[1:])))
    assert store.get_json("_catalog/CURRENT.json")[0] == before_pointer

    outcome = correct("v2-aapl", driver.load_supersede_allowlist(_allowlist_file(tmp_path, aapl)))
    assert outcome["fully_published"] is True
    after_pointer, _ = store.get_json("_catalog/CURRENT.json")
    after = _authorities_in(roots["catalog_root"], after_pointer)
    assert {a: v[0] for a, v in after.items() if a in aapl} == {a: "v2-aapl" for a in aapl}
    assert {a: v for a, v in after.items() if a not in aapl} == {a: v for a, v in before.items() if a not in aapl}

    receipts = [json.loads(v) for k, v in client.objects.items() if k.startswith("curated/test/_catalog/receipts/")]
    superseded = sorted(tuple(a) for r in receipts for a in r.get("supersedes", {}).get("authorities", []))
    assert superseded == aapl
    assert all(r["supersedes"]["approved_by"] == "owner" for r in receipts if "supersedes" in r)


def test_a_malformed_allowlist_is_refused_before_any_work(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"reason": "x", "approved_by": "owner", "authorities": [["only", "two"]]}), encoding="utf-8")
    with pytest.raises(driver.BackfillError, match="SUPERSEDE_ALLOWLIST_INVALID"):
        driver.load_supersede_allowlist(str(bad))
    with pytest.raises(driver.BackfillError, match="SUPERSEDE_ALLOWLIST_UNREADABLE"):
        driver.load_supersede_allowlist(str(tmp_path / "missing.json"))


def test_recover_from_stale_intent_cleans_up_and_retries_on_parent_changed(tmp_path):
    catalog_root = tmp_path / "catalog"
    catalog_root.mkdir()
    intent_path = catalog_root / "intent-v1.json"
    snapshot_path = catalog_root / "catalog-v1.sqlite"
    preparing_path = catalog_root / "catalog-v1.sqlite.preparing"
    parent = {"dataset_version": "v0"}
    intent_path.write_text(json.dumps({"parent": parent}))
    (catalog_root / "CURRENT.json").write_text(json.dumps({"dataset_version": "v2"}))
    snapshot_path.write_bytes(b"stale")
    preparing_path.write_bytes(b"stale-preparing")

    calls = {"n": 0}
    def fn():
        calls["n"] += 1
        if calls["n"] == 1:
            raise s3_publish.PublicationError("PUBLICATION_PARENT_CHANGED")
        return "recovered"

    result = driver.recover_from_stale_intent(fn, catalog_root=str(catalog_root), dataset_version="v1")

    assert result == "recovered"
    assert calls["n"] == 2
    assert not intent_path.exists()
    assert not snapshot_path.exists()
    assert not preparing_path.exists()


def test_recover_from_stale_intent_does_not_swallow_other_publication_errors(tmp_path):
    catalog_root = tmp_path / "catalog"
    catalog_root.mkdir()

    def fn():
        raise s3_publish.PublicationError("CATALOG_INTEGRITY_FAILURE")

    with pytest.raises(s3_publish.PublicationError, match="CATALOG_INTEGRITY_FAILURE"):
        driver.recover_from_stale_intent(fn, catalog_root=str(catalog_root), dataset_version="v1")


def test_recover_from_stale_intent_gives_up_after_repeated_parent_changes(tmp_path):
    catalog_root = tmp_path / "catalog"
    catalog_root.mkdir()
    parent = {"dataset_version": "v0"}
    intent_path = catalog_root / "intent-v1.json"
    (catalog_root / "CURRENT.json").write_text(json.dumps({"dataset_version": "v2"}))

    calls = {"n": 0}
    def fn():
        calls["n"] += 1
        intent_path.write_text(json.dumps({"parent": parent}))
        raise s3_publish.PublicationError("PUBLICATION_PARENT_CHANGED")

    with pytest.raises(s3_publish.PublicationError, match="PUBLICATION_PARENT_CHANGED"):
        driver.recover_from_stale_intent(fn, catalog_root=str(catalog_root), dataset_version="v1")
    assert calls["n"] == driver._MAX_STALE_INTENT_RETRIES


def test_recover_from_stale_intent_does_not_delete_another_jobs_intent(tmp_path):
    catalog_root = tmp_path / "catalog"
    catalog_root.mkdir()
    intent_path = catalog_root / "intent-v1.json"
    intent_path.write_text(json.dumps({"job_id": "other-job", "parent": None}))

    def fn():
        raise s3_publish.PublicationError("PUBLICATION_PARENT_CHANGED")

    with pytest.raises(driver.BackfillError, match="STALE_INTENT_OWNED_BY_OTHER_JOB"):
        driver.recover_from_stale_intent(
            fn, catalog_root=str(catalog_root), dataset_version="v1", expected_job_id="this-job",
        )
    assert json.loads(intent_path.read_text()) == {"job_id": "other-job", "parent": None}


def test_remote_conflict_preserves_intent_snapshot_and_raw_for_reconciliation(tmp_path, monkeypatch):
    roots, client = _roots(tmp_path), FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    real_publish = s3_publish.publish
    def raced(store, root, pointer, *, expected_parent):
        assert expected_parent is None
        client.objects[store.key("_catalog/CURRENT.json")] = b'{"concurrent":"publisher"}'
        return real_publish(store, root, pointer, expected_parent=expected_parent)
    monkeypatch.setattr(s3_publish, "publish", raced)
    with pytest.raises(driver.BackfillError, match="REMOTE_PARENT_RECONCILIATION_REQUIRED"):
        driver.run_s3_backfill("XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1",
            bucket="bucket", curated_prefix="curated/test", client=client, **roots)
    assert client.objects["curated/test/_catalog/CURRENT.json"] == b'{"concurrent":"publisher"}'
    assert os.path.exists(os.path.join(roots["catalog_root"], "intent-v1.json"))
    assert os.path.exists(os.path.join(roots["catalog_root"], "catalog-v1.sqlite"))
    assert any(n.endswith(".csv") for n in os.listdir(os.path.join(roots["staging_root"], "_raw_cache")))


def test_remote_cas_race_after_immutable_catalog_upload_preserves_reconciliation_state(tmp_path):
    roots, client = _roots(tmp_path), FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    current_key = "curated/test/_catalog/CURRENT.json"
    raced = False

    def race(key):
        nonlocal raced
        if key == current_key and not raced:
            raced = True
            client.objects[current_key] = b'{"concurrent":"publisher"}'

    client.before_put = race
    with pytest.raises(driver.BackfillError, match="REMOTE_PARENT_RECONCILIATION_REQUIRED"):
        driver.run_s3_backfill("XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1",
            bucket="bucket", curated_prefix="curated/test", client=client, **roots)

    assert raced
    assert client.objects[current_key] == b'{"concurrent":"publisher"}'
    assert "curated/test/_catalog/catalog-v1.sqlite" in client.objects
    assert os.path.exists(os.path.join(roots["catalog_root"], "intent-v1.json"))
    assert os.path.exists(os.path.join(roots["catalog_root"], "catalog-v1.sqlite"))


def test_run_s3_backfill_does_not_raise_on_a_genuine_partial_range(tmp_path):
    # The real bug this guards: the underlying raw file's authority plan can
    # span many more dates than the caller happens to request right now (a
    # monthly file backing a single-day request). That must be normal,
    # successful partial progress -- not a fatal error -- since each
    # requested day is still genuinely pushed to S3 as it completes.
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    roots = _roots(tmp_path)

    outcome = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client, **roots,
    )

    assert outcome["fully_published"] is False
    assert outcome["results"][0]["fully_published"] is False
    prefix = outcome["results"][0]["partitions"][0]
    assert not os.path.exists(os.path.join(roots["curated_root"], prefix))
    assert client.objects[f"curated/test/{prefix}/_manifest.json"]
    # The catalog is not published and the raw input is not freed yet --
    # 2025-09-03 (the file's other real date) still needs it.
    current, _ = s3_publish.Store(client, "bucket", "curated/test").get_json("_catalog/CURRENT.json")
    assert current is None
    raw_cache = os.path.join(roots["staging_root"], "_raw_cache")
    assert os.listdir(raw_cache) != []


def test_run_s3_backfill_skips_a_requested_date_with_no_real_coverage(tmp_path):
    # A weekend/holiday inside --start-date/--end-date has no authoritative
    # coverage at all -- that must be a graceful skip, not a crash, and the
    # remaining real dates still complete and publish normally. The CSV
    # fixture only has rows for 09-02/09-03; 09-04 is a genuine gap (same
    # date test_missing_date_is_not_success uses to prove TARGET_DATE_NOT_IN_PLAN).
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    roots = _roots(tmp_path)

    outcome = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03", "2025-09-04"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client, **roots,
    )

    assert outcome["skipped_dates"] == ["2025-09-04"]
    assert outcome["fully_published"] is True
    assert len(outcome["results"]) == 2


def test_run_s3_backfill_accounts_for_the_raw_download_size_in_its_storage_check(tmp_path, monkeypatch):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    roots = _roots(tmp_path)

    class _Usage:
        free = 10  # far below even the smallest real floor once the raw object's bytes are added

    monkeypatch.setattr(driver.shutil, "disk_usage", lambda path: _Usage())
    with pytest.raises(driver.BackfillError, match="INSUFFICIENT_FREE_DISK"):
        driver.run_s3_backfill(
            "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
            bucket="bucket", curated_prefix="curated/test", client=client, min_free_bytes=1, **roots,
        )


_S3_DEFINITION_KEY = "raw/databento/dataset=XNAS.ITCH/schema=definition/symbol=NQ/year=2025/month=08/x.definition.csv"


def test_run_s3_backfill_reserves_space_before_definition_download(tmp_path, monkeypatch):
    client = FakeBucket()
    raw = ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode()
    definition = b"definition,csv,bytes"
    client.put_raw(_S3_RAW_KEY, raw)
    client.put_raw(_S3_DEFINITION_KEY, definition)
    free_values = iter([len(raw) + 1, len(definition)])

    class _Usage:
        def __init__(self, free):
            self.free = free

    monkeypatch.setattr(driver.shutil, "disk_usage", lambda path: _Usage(next(free_values)))

    with pytest.raises(driver.BackfillError, match="INSUFFICIENT_FREE_DISK"):
        driver.run_s3_backfill(
            "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
            bucket="bucket", curated_prefix="curated/test", client=client,
            definition_symbol="NQ", min_free_bytes=1, **_roots(tmp_path),
        )


def test_run_s3_backfill_discovers_and_forwards_definition_sources(tmp_path, monkeypatch):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    client.put_raw(_S3_DEFINITION_KEY, b"definition,csv,bytes")
    captured = {}
    admissions = []

    def fake_run_one_day(inputs, dataset_version, date, **kwargs):
        captured["definition_sources"] = kwargs.get("definition_sources")
        return {"fully_published": False, "catalog_pointer": None, "job_id": "x"}

    monkeypatch.setattr(driver, "run_one_day", fake_run_one_day)
    monkeypatch.setattr(s3_publish, "publish", lambda *a, **k: None)
    monkeypatch.setattr(s3_publish.Store, "get_json", lambda self, rel: (None, None))

    driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client,
        definition_symbol="NQ", on_month_admission=lambda objects: admissions.append(objects), **_roots(tmp_path),
    )

    assert len(captured["definition_sources"]) == 1
    assert captured["definition_sources"][0]["s3_key"] == _S3_DEFINITION_KEY
    assert os.path.isfile(captured["definition_sources"][0]["local_path"])
    assert [[obj["s3_key"] for obj in objects] for objects in admissions] == [[_S3_RAW_KEY], [_S3_DEFINITION_KEY]]


def test_run_s3_backfill_evicts_definition_cache_only_after_full_publication(tmp_path, monkeypatch):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    client.put_raw(_S3_DEFINITION_KEY, b"definition,csv,bytes")
    captured = {}

    def fake_run_one_day(inputs, dataset_version, date, **kwargs):
        captured["definition_sources"] = kwargs["definition_sources"]
        return {"fully_published": True, "catalog_pointer": {"dataset_version": dataset_version}, "job_id": "x"}

    monkeypatch.setattr(driver, "run_one_day", fake_run_one_day)

    outcome = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client,
        definition_symbol="NQ", **_roots(tmp_path),
    )

    assert outcome["fully_published"] is True
    definition_path = captured["definition_sources"][0]["local_path"]
    assert not os.path.exists(definition_path)
    assert not os.path.exists(definition_path + ".identity.json")


_S3_LATER_DEFINITION_KEY = "raw/databento/dataset=XNAS.ITCH/schema=definition/symbol=NQ/year=2025/month=09/day=25/x.definition.csv"


def test_run_s3_backfill_discovers_definitions_past_the_requested_conversion_dates(tmp_path, monkeypatch):
    # The real bug this guards: a continuous alias's roll table can need
    # definition coverage for a contract that only starts appearing later in
    # the same raw file's date coverage than the specific day being
    # converted right now (e.g. converting day 1 of a month still needs a
    # definition dated day 25, for a later part of that same file). Discovery
    # must reach the raw file's own full covered range, not stop at the
    # requested dates.
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    client.put_raw(_S3_LATER_DEFINITION_KEY, b"definition,csv,bytes")
    captured = {}

    def fake_run_one_day(inputs, dataset_version, date, **kwargs):
        captured["definition_sources"] = kwargs.get("definition_sources")
        return {"fully_published": False, "catalog_pointer": None, "job_id": "x"}

    monkeypatch.setattr(driver, "run_one_day", fake_run_one_day)
    monkeypatch.setattr(s3_publish, "publish", lambda *a, **k: None)
    monkeypatch.setattr(s3_publish.Store, "get_json", lambda self, rel: (None, None))

    driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client,
        definition_symbol="NQ", **_roots(tmp_path),
    )

    assert captured["definition_sources"][0]["s3_key"] == _S3_LATER_DEFINITION_KEY


def test_continuous_interval_end_reads_the_real_files_own_roll_boundary(monkeypatch):
    # This is the fix for a second, sneakier bug: bounding definition
    # discovery by "today" made the discovered file set (and therefore
    # job_id, which hashes definition_sources) drift every time the driver
    # is re-run on a later calendar day -- silently discarding a real,
    # expensive, already-paid split every time someone resumes a backfill.
    # The interval end must come from the raw file's own declared roll
    # boundary instead, which never changes for the same file.
    real_read_metadata = job._dbn.read_metadata

    def faked(path, expected_schema=None):
        meta = real_read_metadata(path, expected_schema=expected_schema)
        if path == MBP1:
            meta.stype_in = "continuous"
            meta.symbols = ["NQ.n.0"]
            meta.mappings = {"NQ.n.0": [
                {"start_date": "2026-06-01", "end_date": "2026-06-17", "symbol": "42004058"},
                {"start_date": "2026-06-17", "end_date": "2026-07-01", "symbol": "42004177"},
            ]}
        return meta

    monkeypatch.setattr(job._dbn, "read_metadata", faked)

    inputs = [{"local_path": MBP1, "schema": "mbp-1"}]
    assert driver._continuous_interval_end(inputs) == "2026-07-01"


def test_continuous_interval_end_is_none_for_a_plain_csv_input(tmp_path):
    csv_path = tmp_path / "x.csv"
    csv_path.write_text("a,b\n1,2\n")
    inputs = [{"local_path": str(csv_path), "schema": "ohlcv-1s"}]
    assert driver._continuous_interval_end(inputs) is None


def test_run_s3_backfill_refuses_when_no_definition_objects_are_found(tmp_path):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    with pytest.raises(driver.BackfillError, match="NO_DEFINITION_OBJECTS_FOUND"):
        driver.run_s3_backfill(
            "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
            bucket="bucket", curated_prefix="curated/test", client=client,
            definition_symbol="NQ", **_roots(tmp_path),
        )


def test_run_s3_backfill_refuses_when_no_raw_objects_cover_the_range(tmp_path):
    client = FakeBucket()
    with pytest.raises(driver.BackfillError, match="NO_RAW_OBJECTS_FOUND"):
        driver.run_s3_backfill(
            "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02"], "v1",
            bucket="bucket", curated_prefix="curated/test", client=client, **_roots(tmp_path),
        )


def test_run_range_stops_on_the_first_failure_and_does_not_attempt_later_dates(tmp_path, monkeypatch):
    roots = _roots(tmp_path)
    inputs = _inputs(tmp_path)
    calls = []

    def fake_run_one_day(inputs_, dataset_version, date, **kwargs):
        calls.append(date)
        if date == "2025-09-03":
            raise RuntimeError("INJECTED_FAILURE")
        return {"fully_published": False}

    monkeypatch.setattr(driver, "run_one_day", fake_run_one_day)
    with pytest.raises(RuntimeError, match="INJECTED_FAILURE"):
        driver.run_range(inputs, "v1", ["2025-09-02", "2025-09-03", "2025-09-04"], **roots)

    assert calls == ["2025-09-02", "2025-09-03"]


def _quarantine_on(monkeypatch, bad_dates, seen=None):
    """Fail inside the real job, after its checkpoint is built and saved, exactly
    where a rejected row raises -- faking higher up skips the durable state the
    driver now depends on."""
    real = job._process_group

    def fake(bridge, checkpoint, job_stage, dataset_version, curated_root, key, date, *args, **kwargs):
        if date in bad_dates:
            if seen is not None:
                seen.append(date)
            evidence = rejections.new(source_objects=[{"s3_key": "some/key"}])
            rejections.record(evidence, "UNSUPPORTED_MBP_ACTION", source={"s3_key": "some/key", "date": date},
                              row={"action": "F"})
            rejections.write(job_stage, evidence)
            raise job.JobError(f"QUARANTINE_BLOCKS_PUBLICATION:some/key:{date}:1")
        return real(bridge, checkpoint, job_stage, dataset_version, curated_root, key, date, *args, **kwargs)

    monkeypatch.setattr(job, "_process_group", fake)


def test_run_s3_backfill_quarantines_a_bad_day_and_finishes_the_rest_of_the_month(tmp_path, monkeypatch):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    roots = _roots(tmp_path)
    _quarantine_on(monkeypatch, {"2025-09-02"})

    outcome = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client,
        allow_quarantine_skip=True, **roots,
    )

    assert [q["date"] for q in outcome["quarantined_dates"]] == ["2025-09-02"]
    assert "QUARANTINE_BLOCKS_PUBLICATION" in outcome["quarantined_dates"][0]["error"]
    assert len(outcome["results"]) == 1
    assert outcome["fully_published"] is False
    raw_cache = os.path.join(roots["staging_root"], "_raw_cache")
    assert os.listdir(raw_cache) != []


def test_run_s3_backfill_still_aborts_on_a_quarantined_day_when_skipping_is_not_allowed(tmp_path, monkeypatch):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    _quarantine_on(monkeypatch, {"2025-09-02"})

    with pytest.raises(job.JobError, match="QUARANTINE_BLOCKS_PUBLICATION"):
        driver.run_s3_backfill(
            "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1",
            bucket="bucket", curated_prefix="curated/test", client=client, **_roots(tmp_path),
        )


def test_each_quarantined_day_keeps_its_own_evidence_file(tmp_path, monkeypatch):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    roots = _roots(tmp_path)
    _quarantine_on(monkeypatch, {"2025-09-02", "2025-09-03"})

    outcome = driver.run_s3_backfill(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1",
        bucket="bucket", curated_prefix="curated/test", client=client,
        allow_quarantine_skip=True, max_quarantined_days=5, **roots,
    )

    # A later day's run archives the previous rejections.json, so recording a
    # bare path would leave every earlier day pointing at a moved file.
    entries = outcome["quarantined_dates"]
    paths = [q["evidence"] for q in entries]
    assert len(paths) == 2 and len(set(paths)) == 2
    for date, entry in zip(["2025-09-02", "2025-09-03"], entries):
        path = entry["evidence"]
        assert path is not None and date in os.path.basename(path)
        assert os.path.isfile(path)
        assert entry["evidence_sha256"] == job._convert._sha256_file(path)
        evidence = json.loads(open(path, encoding="utf-8").read())
        assert evidence["rejected"] == 1
        assert evidence["reasons"] == {"UNSUPPORTED_MBP_ACTION": 1}
        assert evidence["source_objects"] == [{"s3_key": "some/key"}]
        assert [s["source"]["date"] for s in evidence["samples"]] == [date]
        assert evidence["samples"][0]["row"] == {"action": "F"}


def test_run_s3_backfill_stops_once_the_quarantined_day_budget_is_spent(tmp_path, monkeypatch):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    _quarantine_on(monkeypatch, {"2025-09-02", "2025-09-03"})

    with pytest.raises(driver.BackfillError, match="QUARANTINED_DAY_BUDGET_EXCEEDED"):
        driver.run_s3_backfill(
            "XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1",
            bucket="bucket", curated_prefix="curated/test", client=client,
            allow_quarantine_skip=True, max_quarantined_days=1, **_roots(tmp_path),
        )


def _aapl_bucket():
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    return client


def test_a_durably_quarantined_date_is_never_reconverted_on_a_later_run(tmp_path, monkeypatch):
    # The audit's executable finding: with the quarantine set held only in
    # process memory, every restart replayed and re-rejected the same date and
    # the budget reset, so a month past its budget looped forever.
    roots = _roots(tmp_path)
    attempts = []
    _quarantine_on(monkeypatch, {"2025-09-02"}, attempts)
    args = ("XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1")
    kwargs = dict(bucket="bucket", curated_prefix="curated/test", allow_quarantine_skip=True, **roots)

    client = _aapl_bucket()
    first = driver.run_s3_backfill(*args, client=client, **kwargs)
    second = driver.run_s3_backfill(*args, client=client, **kwargs)

    assert attempts == ["2025-09-02"], "the bad date must be converted once, ever"
    assert [q["date"] for q in first["quarantined_dates"]] == ["2025-09-02"]
    assert [q["date"] for q in second["quarantined_dates"]] == ["2025-09-02"]
    assert second["fully_published"] is False
    assert second["quarantined_dates"][0]["evidence_sha256"]


def test_the_quarantine_budget_survives_a_restart_instead_of_resetting(tmp_path, monkeypatch):
    roots = _roots(tmp_path)
    _quarantine_on(monkeypatch, {"2025-09-02", "2025-09-03"})
    args = ("XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1")
    kwargs = dict(bucket="bucket", curated_prefix="curated/test", allow_quarantine_skip=True,
                  max_quarantined_days=1, **roots)

    with pytest.raises(driver.BackfillError, match="QUARANTINED_DAY_BUDGET_EXCEEDED"):
        driver.run_s3_backfill(*args, client=_aapl_bucket(), **kwargs)
    with pytest.raises(driver.BackfillError, match="QUARANTINED_DAY_BUDGET_EXCEEDED"):
        driver.run_s3_backfill(*args, client=_aapl_bucket(), **kwargs)


def test_retry_quarantined_clears_the_durable_set_so_a_fixed_day_is_reconverted(tmp_path, monkeypatch):
    roots = _roots(tmp_path)
    attempts = []
    _quarantine_on(monkeypatch, {"2025-09-02"}, attempts)
    args = ("XNAS.ITCH", "ohlcv-1s", "AAPL", ["2025-09-02", "2025-09-03"], "v1")
    kwargs = dict(bucket="bucket", curated_prefix="curated/test", allow_quarantine_skip=True, **roots)
    client = _aapl_bucket()
    driver.run_s3_backfill(*args, client=client, **kwargs)

    monkeypatch.setattr(job, "_process_group", _REAL_PROCESS_GROUP)
    outcome = driver.run_s3_backfill(*args, client=client, retry_quarantined=True, **kwargs)

    assert outcome["quarantined_dates"] == []
    assert outcome["fully_published"] is True
