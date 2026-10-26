"""Multi-file, resumable conversion job (design lock 19 sections 0.10/0.11):
the core Phase 2 acceptance proof -- interrupt mid-job, resume with the same
inputs, get no missing and no duplicated output, and never re-decode a
source file that has already been split.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3

import duckdb
import pytest

import catalog
import job


def test_resume_after_partition_rename_before_checkpoint(tmp_path, monkeypatch):
    real = job._convert._publish_partition
    def publish_then_crash(*args):
        real(*args)
        raise RuntimeError("after rename")
    monkeypatch.setattr(job._convert, "_publish_partition", publish_then_crash)
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    with pytest.raises(RuntimeError, match="after rename"):
        job.run_job(inputs, "v1", **_roots(tmp_path))
    monkeypatch.setattr(job._convert, "_publish_partition", real)
    result = job.run_job(inputs, "v1", **_roots(tmp_path))
    assert len(result["partitions"]) == 1


def test_resume_accepts_a_pre_throughput_upgrade_partition_after_rename_before_checkpoint(tmp_path, monkeypatch):
    """A deploy must not turn an already-durable old partition into a conflict."""
    real = job._convert._publish_partition

    def old_logical_sha256(path):
        digest = hashlib.sha256()
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                digest.update(json.dumps(json.loads(line), sort_keys=True, separators=(",", ":")).encode("utf-8"))
        return digest.hexdigest()

    def publish_as_old_release_then_crash(pw, curated_root, provider="databento"):
        real(pw, curated_root)
        dest = os.path.join(
            curated_root, "databento", job._writer.instrument_slug(pw.instrument_id),
            pw.family, pw.dataset_version, pw.date,
        )
        manifest_path = os.path.join(dest, "_manifest.json")
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
        manifest["logical_sha256"] = old_logical_sha256(pw._ndjson)
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh)
        raise RuntimeError("after old-release rename")

    monkeypatch.setattr(job._convert, "_publish_partition", publish_as_old_release_then_crash)
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    roots = _roots(tmp_path)
    with pytest.raises(RuntimeError, match="after old-release rename"):
        job.run_job(inputs, "legacy-resume", **roots)

    monkeypatch.setattr(job._convert, "_publish_partition", real)
    result = job.run_job(inputs, "legacy-resume", **roots)
    assert len(result["partitions"]) == 1


def test_resume_rejects_a_different_logical_partition_after_rename_before_checkpoint(tmp_path, monkeypatch):
    """The legacy recovery fallback must not weaken conflict detection."""
    real = job._convert._publish_partition

    def publish_conflicting_partition_then_crash(pw, curated_root, provider="databento"):
        real(pw, curated_root)
        dest = os.path.join(
            curated_root, "databento", job._writer.instrument_slug(pw.instrument_id),
            pw.family, pw.dataset_version, pw.date,
        )
        manifest_path = os.path.join(dest, "_manifest.json")
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
        manifest["logical_sha256"] = "0" * 64
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh)
        raise RuntimeError("after conflicting rename")

    monkeypatch.setattr(job._convert, "_publish_partition", publish_conflicting_partition_then_crash)
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    roots = _roots(tmp_path)
    with pytest.raises(RuntimeError, match="after conflicting rename"):
        job.run_job(inputs, "conflict-resume", **roots)

    monkeypatch.setattr(job._convert, "_publish_partition", real)
    with pytest.raises(job.JobError, match="PUBLISHED_PARTITION_CONFLICT"):
        job.run_job(inputs, "conflict-resume", **roots)


def test_duplicate_source_keys_refused(tmp_path):
    item = {"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}
    with pytest.raises(job.JobError, match="DUPLICATE_SOURCE_KEY"):
        job.run_job([item, item], "v1", **_roots(tmp_path))

HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.normpath(os.path.join(HERE, "..", "..", "test", "contracts", "fixtures", "market-observation-v1"))
MBP1 = os.path.join(FX, "databento-mbp1.dbn")
TBBO = os.path.join(FX, "databento-tbbo.dbn")

_TBBO_KEY = "raw/databento/dataset=GLBX.MDP3/schema=tbbo/symbol=ESH1/year=2020/month=12/day=28/x.dbn"
_MBP1_KEY = "raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=ESH1/year=2020/month=12/day=28/x.dbn"

_CSV_HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"
_CSV_ROWS = [
    "1756819800000000000,32,2,38,231460000000,231460000000,231460000000,231460000000,21",
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


def test_a_fresh_single_input_job_produces_the_same_partitions_convert_file_would(tmp_path):
    roots = _roots(tmp_path)
    summary = job.run_job([{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}], "v1", **roots)
    assert len(summary["partitions"]) == 1
    prefix = summary["partitions"][0]
    con = duckdb.connect()
    try:
        n = con.execute(
            "SELECT count(*) FROM read_parquet(?)", [os.path.join(roots["curated_root"], prefix, "part-00000.parquet")]
        ).fetchone()[0]
    finally:
        con.close()
    assert n == 2
    pointer = catalog.read_current(roots["catalog_root"])
    assert pointer is not None


def test_l1_bridge_rejection_retains_reason_source_position_and_row(tmp_path, monkeypatch):
    original = job.ContractBridge.map_batch

    def reject_one(self, *args, **kwargs):
        results = original(self, *args, **kwargs)
        results[0] = {"ok": False, "quarantine": {"reason": "TEST_L1_BRIDGE_REJECTION"}}
        return results

    monkeypatch.setattr(job.ContractBridge, "map_batch", reject_one)
    roots = _roots(tmp_path)
    with pytest.raises(job.JobError, match="QUARANTINE_BLOCKS_PUBLICATION"):
        job.run_job([{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}], "v1", **roots)

    [evidence_path] = list((tmp_path / "staging").glob("*/rejections.json"))
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["reasons"] == {"TEST_L1_BRIDGE_REJECTION": 1}
    sample = evidence["samples"][0]
    assert sample["source"]["s3_key"] == _MBP1_KEY
    assert isinstance(sample["source"]["position"], int)
    assert sample["row"]
    assert sample["quarantine"] == {"reason": "TEST_L1_BRIDGE_REJECTION"}


def test_on_catalog_publish_reaches_catalog_publish_job_with_the_real_pointer(tmp_path):
    seen = []
    roots = _roots(tmp_path)
    summary = job.run_job(
        [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}], "v1",
        on_catalog_publish=lambda payload, parent: seen.append((payload, parent)), **roots,
    )
    assert seen == [(summary["catalog_pointer"], None)]


def test_a_failing_on_catalog_publish_hook_fails_the_whole_job_without_publishing(tmp_path):
    roots = _roots(tmp_path)
    with pytest.raises(RuntimeError, match="simulated remote failure"):
        job.run_job(
            [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}], "v1",
            on_catalog_publish=lambda payload, parent: (_ for _ in ()).throw(RuntimeError("simulated remote failure")),
            **roots,
        )
    assert catalog.read_current(roots["catalog_root"]) is None

    result = job.run_job([{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}], "v1", **roots)
    assert len(result["partitions"]) == 1
    assert catalog.read_current(roots["catalog_root"]) is not None


def test_interrupting_after_one_partition_resumes_to_completion_without_redecoding(tmp_path, monkeypatch):
    real_decode = job._dbn.decode
    decode_calls = {"n": 0}

    def counting_decode(*args, **kwargs):
        decode_calls["n"] += 1
        return real_decode(*args, **kwargs)

    monkeypatch.setattr(job._dbn, "decode", counting_decode)

    real_publish = job._convert._publish_partition
    publish_calls = {"n": 0}

    def flaky_publish(pw, curated_root, provider="databento"):
        publish_calls["n"] += 1
        if publish_calls["n"] == 2:
            raise RuntimeError("simulated crash before the second partition publishes")
        return real_publish(pw, curated_root)

    monkeypatch.setattr(job._convert, "_publish_partition", flaky_publish)

    roots = _roots(tmp_path)
    inputs = [{"local_path": TBBO, "s3_key": _TBBO_KEY, "schema": "tbbo"}]

    with pytest.raises(RuntimeError, match="simulated crash"):
        job.run_job(inputs, "v1", **roots)
    # Three calls, all only during the initial checkpoint build: one for
    # _build_roll_tables' continuous-request probe, one for
    # dbn.read_metadata's own header-only probe, one for the real split pass.
    after_first_run = decode_calls["n"]
    assert after_first_run == 3

    # "Restart": a fresh call with the same inputs, no more injected failure.
    monkeypatch.setattr(job._convert, "_publish_partition", real_publish)
    summary = job.run_job(inputs, "v1", **roots)

    assert decode_calls["n"] == after_first_run  # unchanged -- resume never touched the source file again
    families = sorted(p.split("/")[2] for p in summary["partitions"])
    assert families == ["quote", "trade"]

    pointer = catalog.read_current(roots["catalog_root"])
    snap = sqlite3.connect(os.path.join(roots["catalog_root"], pointer["catalog_key"]))
    try:
        rows = snap.execute("SELECT family FROM partitions ORDER BY family").fetchall()
    finally:
        snap.close()
    assert [r[0] for r in rows] == ["quote", "trade"]  # no duplicates from the interrupted first attempt

    for prefix in summary["partitions"]:
        con = duckdb.connect()
        try:
            n = con.execute(
                "SELECT count(*) FROM read_parquet(?)", [os.path.join(roots["curated_root"], prefix, "part-00000.parquet")]
            ).fetchone()[0]
        finally:
            con.close()
        assert n == 2


def test_a_day_producing_both_trade_and_quote_dispatches_the_source_only_once(tmp_path, monkeypatch):
    real_read_day = job._split.read_day
    real_map_batch = job.ContractBridge.map_batch
    read_day_calls = {"n": 0}
    dispatched_families = []

    def counting_read_day(path):
        read_day_calls["n"] += 1
        return real_read_day(path)

    def counting_map_batch(self, batch_id, provider, family, rows, context):
        dispatched_families.append(family)
        return real_map_batch(self, batch_id, provider, family, rows, context)

    monkeypatch.setattr(job._split, "read_day", counting_read_day)
    monkeypatch.setattr(job.ContractBridge, "map_batch", counting_map_batch)

    roots = _roots(tmp_path)
    inputs = [{"local_path": TBBO, "s3_key": _TBBO_KEY, "schema": "tbbo"}]
    summary = job.run_job(inputs, "v1", **roots)

    families = sorted(p.split("/")[2] for p in summary["partitions"])
    assert families == ["quote", "trade"]
    # One read during _build_checkpoint's has-trade probe (_canonical_families),
    # one real dispatch pass shared by both families -- not one dispatch pass
    # per family, which would silently double the bridge/writer cost of every
    # trade-bearing day.
    assert read_day_calls["n"] == 2
    assert dispatched_families == ["mbp"]

    for prefix in summary["partitions"]:
        con = duckdb.connect()
        try:
            n = con.execute(
                "SELECT count(*) FROM read_parquet(?)", [os.path.join(roots["curated_root"], prefix, "part-00000.parquet")]
            ).fetchone()[0]
        finally:
            con.close()
        assert n == 2


def test_full_job_finalizes_each_date_when_its_shared_source_group_is_done(tmp_path, monkeypatch):
    """Shared dispatch must retain run_job's incremental staging bound."""
    events = []
    real_read_day = job._split.read_day
    real_publish = job._convert._publish_partition

    def tracking_read_day(path):
        events.append("read")
        return real_read_day(path)

    def tracking_publish(*args, **kwargs):
        events.append("publish")
        return real_publish(*args, **kwargs)

    monkeypatch.setattr(job._split, "read_day", tracking_read_day)
    monkeypatch.setattr(job._convert, "_publish_partition", tracking_publish)
    inputs = [{
        "local_path": _csv_file(tmp_path),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]

    summary = job.run_job(inputs, "v1", **_roots(tmp_path))

    # Checkpoint construction makes two legitimate read_day calls to classify
    # these two CSV day units. Once processing begins, however, the first
    # date must publish before the second date is read; otherwise a full job
    # retains every date's NDJSON until the end.
    first_publish = events.index("publish")
    assert events[first_publish + 1:] == ["read", "publish"]
    assert sorted(partition.split("/")[-1] for partition in summary["partitions"]) == ["2025-09-02", "2025-09-03"]


def test_run_job_is_serialized_by_the_same_per_version_lock_convert_file_uses(tmp_path):
    # Without this, two concurrent runs against the same curated root for the
    # *same* dataset_version could interleave checkpoint writes (lost
    # updates) or both try to publish the same partition. Hold the exact
    # per-version lock convert.convert_file uses and confirm run_job refuses
    # to proceed rather than racing past it. Different dataset_versions are
    # deliberately *not* serialized by this lock any more -- see
    # test_run_job_for_a_different_dataset_version_is_not_blocked_by_it.
    from local_lock import LocalLock, conversion_guard_path

    roots = _roots(tmp_path)
    os.makedirs(roots["curated_root"], exist_ok=True)
    guard = conversion_guard_path(roots["curated_root"], "v1")
    lock = LocalLock(guard)
    lock.acquire()
    try:
        with pytest.raises(OSError):
            job.run_job([{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}], "v1", **roots)
    finally:
        lock.release()

    # With the lock released, the same call now succeeds normally.
    summary = job.run_job([{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}], "v1", **roots)
    assert len(summary["partitions"]) == 1


def test_run_job_for_a_different_dataset_version_is_not_blocked_by_it(tmp_path):
    # The whole point of narrowing the lock: two different dataset_versions
    # against the same curated_root must be able to proceed independently,
    # since they never touch the same output paths.
    from local_lock import LocalLock, conversion_guard_path

    roots = _roots(tmp_path)
    os.makedirs(roots["curated_root"], exist_ok=True)
    guard = conversion_guard_path(roots["curated_root"], "v1")
    lock = LocalLock(guard)
    lock.acquire()
    try:
        summary = job.run_job([{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}], "v2", **roots)
        assert len(summary["partitions"]) == 1
    finally:
        lock.release()


def test_conversion_guard_path_rejects_an_unsafe_dataset_version(tmp_path):
    from local_lock import conversion_guard_path

    with pytest.raises(job._writer.WriterError, match="INVALID_DATASET_VERSION"):
        conversion_guard_path(tmp_path / "curated", "../escape")


def test_writer_handles_are_closed_even_when_an_unplanned_output_record_is_raised(tmp_path, monkeypatch):
    # A rejection isn't the only way this can fail mid-group; any exception
    # (bridge misbehavior, a genuine planning gap) must still close every
    # writer file handle opened so far, not just the ones on the rejection
    # path. Track instances directly rather than relying on filesystem
    # deletion semantics or GC timing to observe whether a handle is closed.
    real_map_batch = job.ContractBridge.map_batch

    def lying_map_batch(self, *args, **kwargs):
        results = real_map_batch(self, *args, **kwargs)
        for res in results:
            if res.get("ok"):
                for record in res["records"]:
                    record["family"] = "bogus_family"  # not a family the plan declared
        return results

    monkeypatch.setattr(job.ContractBridge, "map_batch", lying_map_batch)

    created = []
    real_init = job._writer.PartitionWriter.__init__

    def tracking_init(self, *args, **kwargs):
        real_init(self, *args, **kwargs)
        created.append(self)

    monkeypatch.setattr(job._writer.PartitionWriter, "__init__", tracking_init)

    roots = _roots(tmp_path)
    inputs = [{"local_path": TBBO, "s3_key": _TBBO_KEY, "schema": "tbbo"}]
    with pytest.raises(job.JobError, match="UNPLANNED_OUTPUT_RECORD"):
        job.run_job(inputs, "v1", **roots)

    assert created  # the group's writers really were opened before the raise
    assert all(pw._fh.closed for pw in created)


def test_resuming_with_a_changed_input_file_is_refused(tmp_path):
    roots = _roots(tmp_path)
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    job.run_job(inputs, "v1", **roots)
    # A same-job_id resume with a different source file (different sha256)
    # would only occur if inputs are wrongly recomputed instead of frozen;
    # simulate the check directly against a tampered checkpoint entry.
    import checkpoint as ckpt
    descs = [job._describe_input(**i) for i in inputs]
    job_id = job.job_id_for(descs, "v1")
    job_stage = os.path.join(roots["staging_root"], job_id)
    checkpoint = ckpt.load(job_stage)
    checkpoint["inputs"][0]["sha256"] = "0" * 64
    ckpt.save(job_stage, checkpoint, "2025-01-01T00:00:00Z")
    with pytest.raises(job.JobError, match="JOB_INPUTS_CHANGED"):
        job.run_job(inputs, "v1", **roots)


def test_a_genuinely_overlapping_daily_file_wins_over_a_stale_monthly_file_end_to_end(tmp_path):
    # The one integration proof that had been missing: authority.py's
    # cadence-precedence logic proven in isolation, and job.py proven on
    # single non-overlapping inputs, but never together on two real files
    # whose coverage genuinely overlaps. This is job.py's actual reason to
    # exist over convert.py's single-file path.
    header = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"
    sep01, sep02, sep03 = 1756713600000000000, 1756800000000000000, 1756886400000000000

    monthly_path = tmp_path / "aapl-month.ohlcv-1s.csv"
    monthly_path.write_text("\n".join([header, *[
        f"{sep01},32,2,38,231000000000,231000000000,231000000000,231000000000,10",
        f"{sep02},32,2,38,111000000000,111000000000,111000000000,111000000000,10",  # stale close
        f"{sep03},32,2,38,233000000000,233000000000,233000000000,233000000000,10",
    ]]) + "\n")

    daily_path = tmp_path / "aapl-day02.ohlcv-1s.csv"
    daily_path.write_text("\n".join([header,
        f"{sep02},32,2,38,999000000000,999000000000,999000000000,999000000000,10",  # corrected close
    ]) + "\n")

    roots = _roots(tmp_path)
    inputs = [
        {
            "local_path": str(monthly_path),
            "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv",
            "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
            "coverage_verified": True, "last_modified": "2025-09-30T00:00:00Z",  # deliberately the *more recent* delivery, to prove cadence still wins
        },
        {
            "local_path": str(daily_path),
            "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/day=02/x.csv",
            "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
            "coverage_verified": True, "last_modified": "2025-09-02T12:00:00Z",
        },
    ]
    summary = job.run_job(inputs, "v1", **roots)

    dates = sorted(p.split("/")[-1] for p in summary["partitions"])
    assert dates == ["2025-09-01", "2025-09-02", "2025-09-03"]  # one partition per date, no duplicates
    assert len(summary["overlap_excluded"]) == 1
    assert summary["overlap_excluded"][0]["s3_key"] == inputs[0]["s3_key"]  # the monthly file lost the Sep-02 slot
    assert summary["overlap_excluded"][0]["date"] == "2025-09-02"

    sep02_prefix = next(p for p in summary["partitions"] if p.endswith("/2025-09-02"))
    con = duckdb.connect()
    try:
        close = con.execute(
            "SELECT close FROM read_parquet(?)",
            [os.path.join(roots["curated_root"], sep02_prefix, "part-00000.parquet")],
        ).fetchone()[0]
    finally:
        con.close()
    from decimal import Decimal
    assert close == Decimal("999")  # the daily (corrected) file's value, not the stale monthly one

    # Sep-01 and Sep-03 only exist in the monthly file and must still convert.
    for date, expected in (("2025-09-01", Decimal("231")), ("2025-09-03", Decimal("233"))):
        prefix = next(p for p in summary["partitions"] if p.endswith(f"/{date}"))
        con = duckdb.connect()
        try:
            close = con.execute(
                "SELECT close FROM read_parquet(?)",
                [os.path.join(roots["curated_root"], prefix, "part-00000.parquet")],
            ).fetchone()[0]
        finally:
            con.close()
        assert close == expected


def test_a_job_with_no_inputs_is_refused_cleanly_not_silently_degenerate(tmp_path):
    with pytest.raises(job.JobError, match="NO_AUTHORITATIVE_COVERAGE"):
        job.run_job([], "v1", **_roots(tmp_path))


def test_a_csv_input_produces_one_candle_partition_per_utc_date_present(tmp_path):
    roots = _roots(tmp_path)
    inputs = [{
        "local_path": _csv_file(tmp_path),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]
    summary = job.run_job(inputs, "v1", **roots)
    dates = sorted(p.split("/")[-1] for p in summary["partitions"])
    assert dates == ["2025-09-02", "2025-09-03"]
    families = {p.split("/")[2] for p in summary["partitions"]}
    assert families == {"candle"}


def _minute_csv_file(tmp_path):
    path = tmp_path / "aapl.ohlcv-1m.csv"
    path.write_text("\n".join([_CSV_HEADER, *[
        "1756819800000000000,32,2,38,231460000000,231800000000,231400000000,231700000000,21",
        "1756819860000000000,32,2,38,231700000000,232900000000,231100000000,232000000000,472",
    ]]) + "\n")
    return str(path)


def _minute_job_input(tmp_path):
    return [{
        "local_path": _minute_csv_file(tmp_path),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1m/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1m", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]


def test_ohlcv_1m_job_materializes_hourly_and_daily_rungs_before_the_minute_callback(tmp_path):
    roots = _roots(tmp_path)
    callbacks = []

    def observe(checkpoint, job_stage, curated_root, dataset_version, instrument_id, family, date):
        callbacks.append(family)
        if family == "candle_1m":
            for derived in ("candle_1h", "candle_1d"):
                assert os.path.exists(job._completed_partition_dest(
                    curated_root, dataset_version, instrument_id, derived, date))

    summary = job.run_job(_minute_job_input(tmp_path), "v1", on_partition_complete=observe, **roots)

    assert {prefix.split("/")[2] for prefix in summary["partitions"]} == {
        "candle_1m", "candle_1h", "candle_1d"}
    assert callbacks == ["candle_1h", "candle_1d", "candle_1m"]
    assert catalog.read_current(roots["catalog_root"]) is not None

    expected = {"candle_1m": 2, "candle_1h": 1, "candle_1d": 1}
    for prefix in summary["partitions"]:
        family = prefix.split("/")[2]
        con = duckdb.connect()
        try:
            count = con.execute(
                "SELECT count(*) FROM read_parquet(?)",
                [os.path.join(roots["curated_root"], prefix, "part-00000.parquet")],
            ).fetchone()[0]
        finally:
            con.close()
        assert count == expected[family]


def test_ohlcv_1m_rollups_resume_from_a_durable_minute_partition_after_a_crash(tmp_path, monkeypatch):
    roots = _roots(tmp_path)
    real = job._derive_candle_rollups

    def crash_after_minute(*args, **kwargs):
        raise RuntimeError("before derived rungs")

    monkeypatch.setattr(job, "_derive_candle_rollups", crash_after_minute)
    with pytest.raises(RuntimeError, match="before derived rungs"):
        job.run_job(_minute_job_input(tmp_path), "v1", **roots)
    monkeypatch.setattr(job, "_derive_candle_rollups", real)

    callbacks = []
    summary = job.run_job(
        _minute_job_input(tmp_path), "v1",
        on_partition_complete=lambda *_args: callbacks.append(_args[-2]), **roots)
    assert {prefix.split("/")[2] for prefix in summary["partitions"]} == {
        "candle_1m", "candle_1h", "candle_1d"}
    assert callbacks == ["candle_1h", "candle_1d", "candle_1m"]


def test_target_date_processes_only_that_date_and_defers_catalog_publication(tmp_path):
    roots = _roots(tmp_path)
    inputs = [{
        "local_path": _csv_file(tmp_path),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]
    first = job.run_job(inputs, "v1", target_date="2025-09-02", **roots)
    assert [p.split("/")[-1] for p in first["partitions"]] == ["2025-09-02"]
    assert first["fully_published"] is False
    assert first["catalog_pointer"] is None
    assert catalog.read_current(roots["catalog_root"]) is None

    second = job.run_job(inputs, "v1", target_date="2025-09-03", **roots)
    dates = sorted(p.split("/")[-1] for p in second["partitions"])
    assert dates == ["2025-09-02", "2025-09-03"]
    assert second["fully_published"] is True
    assert second["catalog_pointer"] is not None
    assert catalog.read_current(roots["catalog_root"]) == second["catalog_pointer"]


def test_an_evicted_partitions_local_files_are_never_touched_again(tmp_path):
    import shutil
    import checkpoint as ckpt

    roots = _roots(tmp_path)
    inputs = [{
        "local_path": _csv_file(tmp_path),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]
    first = job.run_job(inputs, "v1", target_date="2025-09-02", **roots)
    day1_prefix = first["partitions"][0]

    job_stage = os.path.join(roots["staging_root"], first["job_id"])
    checkpoint = ckpt.load(job_stage)
    completed = checkpoint["completed_partitions"][0]
    ckpt.mark_partition_evicted(checkpoint, completed["instrument_id"], completed["family"], completed["date"])
    ckpt.save(job_stage, checkpoint, "2025-09-02T00:00:00Z")
    shutil.rmtree(os.path.join(roots["curated_root"], day1_prefix))

    # A later call must not need day 1's evicted local files back for anything --
    # not the startup integrity re-check, not the final catalog build.
    second = job.run_job(inputs, "v1", target_date="2025-09-03", **roots)
    assert second["fully_published"] is True
    assert sorted(p.split("/")[-1] for p in second["partitions"]) == ["2025-09-02", "2025-09-03"]

    con = sqlite3.connect(os.path.join(roots["catalog_root"], second["catalog_pointer"]["catalog_key"]))
    try:
        rows = con.execute("SELECT date, record_count FROM partitions ORDER BY date").fetchall()
    finally:
        con.close()
    assert rows == [("2025-09-02", 1), ("2025-09-03", 1)]


def test_on_partition_complete_can_evict_locally_before_this_same_calls_catalog_build(tmp_path):
    # The regression this guards: an eviction hook that fires for the very
    # LAST partition of a job must still run (and be reflected in the
    # checkpoint) *before* run_job's own end-of-job catalog build reads
    # completed_partitions -- otherwise that last partition's local files get
    # deleted out from under a catalog build that still expects them there.
    import shutil
    import checkpoint as ckpt

    roots = _roots(tmp_path)
    inputs = [{
        "local_path": _csv_file(tmp_path),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]
    evicted = []

    def evict_immediately(checkpoint, job_stage, curated_root, dataset_version, instrument_id, family, date):
        ckpt.mark_partition_evicted(checkpoint, instrument_id, family, date)
        dest = job._completed_partition_dest(curated_root, dataset_version, instrument_id, family, date)
        shutil.rmtree(dest)
        evicted.append(date)

    summary = job.run_job(inputs, "v1", on_partition_complete=evict_immediately, **roots)

    assert evicted == ["2025-09-02", "2025-09-03"]
    assert summary["fully_published"] is True
    for prefix in summary["partitions"]:
        assert not os.path.exists(os.path.join(roots["curated_root"], prefix))

    con = sqlite3.connect(os.path.join(roots["catalog_root"], summary["catalog_pointer"]["catalog_key"]))
    try:
        rows = con.execute("SELECT date, published_to_s3 FROM partitions ORDER BY date").fetchall()
    finally:
        con.close()
    assert rows == [("2025-09-02", 1), ("2025-09-03", 1)]


def test_read_published_manifest_needs_only_curated_root_no_staging_at_all(tmp_path):
    curated_root = str(tmp_path / "curated")
    entry = {"instrument_id": '["XCME","FUTURE","ESH1","USD","CONTRACT"]', "family": "quote", "date": "2020-12-28"}
    dest = job._completed_partition_dest(curated_root, "v1", entry["instrument_id"], entry["family"], entry["date"])
    os.makedirs(dest)
    with open(os.path.join(dest, "_manifest.json"), "w", encoding="utf-8") as fh:
        fh.write('{"record_count": 2}')

    manifest, prefix = job._read_published_manifest(curated_root, "v1", entry)

    assert manifest == {"record_count": 2}
    assert prefix == os.path.relpath(dest, curated_root).replace(os.sep, "/")
    assert not os.path.exists(str(tmp_path / "staging"))




def test_a_csv_input_whose_declared_symbol_contradicts_its_s3_key_is_refused(tmp_path):
    inputs = [{
        "local_path": _csv_file(tmp_path),
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=TSLA/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]
    with pytest.raises(job.JobError, match="CSV_SOURCE_IDENTITY_MISMATCH:symbol"):
        job.run_job(inputs, "v1", **_roots(tmp_path))


def test_rerunning_an_already_complete_job_id_is_a_clean_noop_not_a_republish(tmp_path):
    roots = _roots(tmp_path)
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    first = job.run_job(inputs, "v1", **roots)
    second = job.run_job(inputs, "v1", **roots)
    assert first["partitions"] == second["partitions"]
    assert first["catalog_pointer"] == second["catalog_pointer"]


def test_the_cooperative_throttle_is_not_consulted_when_unconfigured(tmp_path, monkeypatch):
    monkeypatch.delenv("TT_COLLECTOR_HEALTH_FILE", raising=False)
    calls = []
    monkeypatch.setattr(job._throttle, "wait_if_needed", lambda path, **kw: calls.append(path))
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    job.run_job(inputs, "v1", **_roots(tmp_path))
    assert calls == [None]  # called (once per batch here, one batch) but with nothing configured


def test_the_cooperative_throttle_is_consulted_with_the_configured_path_once_per_batch(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_COLLECTOR_HEALTH_FILE", "/run/terminal-l1-l2/collector-health.json")
    calls = []
    monkeypatch.setattr(job._throttle, "wait_if_needed", lambda path, **kw: calls.append(path))
    inputs = [{"local_path": TBBO, "s3_key": _TBBO_KEY, "schema": "tbbo"}]
    job.run_job(inputs, "v1", **_roots(tmp_path))
    assert calls and all(p == "/run/terminal-l1-l2/collector-health.json" for p in calls)


def test_continuous_input_with_multiple_aliases_is_rejected_before_roll_table_resolution(tmp_path, monkeypatch):
    import types

    meta = types.SimpleNamespace(
        schema="mbp-1", stype_in="continuous", symbols=["ES.n.0", "NQ.n.0"],
        dataset="GLBX.MDP3", mappings={},
    )
    monkeypatch.setattr(job._dbn, "read_metadata", lambda *args, **kwargs: meta)
    desc = {
        "local_path": str(tmp_path / "source.dbn"), "schema": "mbp-1", "dataset": None,
        "symbol": None, "s3_key": "raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=ES/x.dbn",
        "sha256": "a" * 64,
    }

    with pytest.raises(job.JobError, match="CONTINUOUS_INPUT_MULTIPLE_SYMBOLS"):
        job._resolve_input(desc)
