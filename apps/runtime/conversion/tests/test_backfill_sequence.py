from __future__ import annotations

import pytest
import json
import hashlib
import multiprocessing
import os
import sqlite3
import tempfile
import threading
import time
from contextlib import closing
from functools import partial
from pathlib import Path

import backfill_driver
import backfill_sequence as seq


def test_registered_phase_versions_preserve_completed_stages_and_bump_l1():
    assert seq.dataset_version_for_phase("ohlcv") == "w606-ohlcv-v1"
    assert seq.dataset_version_for_phase("ohlcv1m") == "w606-ohlcv-1m-v1"
    assert seq.dataset_version_for_phase("l1") == "w606-l1-v2"
    assert seq.dataset_version_for_phase("l2") == "w606-l2-v1"
    with pytest.raises(seq.SequenceError, match="UNKNOWN_PHASE"):
        seq.dataset_version_for_phase("unknown")
from test_backfill_driver import FakeBucket, _S3_CSV_HEADER, _S3_CSV_ROWS, _roots
from shared_fake_s3 import SharedFakeClient as _SharedFakeClient


@pytest.fixture(autouse=True)
def _tiny_global_reserve(monkeypatch):
    """The production floor is sized for the host's 1.9 TB volume; pin it low so
    these tests assert sequencing rather than the developer's free disk."""
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", "1")

def _fake_published(version, kwargs):
    root = Path(kwargs["catalog_root"])
    root.mkdir(parents=True, exist_ok=True)
    pointer = {"catalog_key": f"catalog-{version}.sqlite"}
    (root / pointer["catalog_key"]).write_bytes(b"unit-test-stub")
    (root / f"intent-{version}.json").write_text(json.dumps({"pointer": pointer, "parent": None}))
    return {"results": [], "skipped_dates": [], "fully_published": True}


def _put_ohlcv(client, dataset, symbol, schema="ohlcv-1s"):
    key = f"raw/databento/dataset={dataset}/schema={schema}/symbol={symbol}/year=2025/month=09/x.csv"
    client.put_raw(key, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())


def test_run_phase_refuses_an_unknown_phase(tmp_path):
    with pytest.raises(seq.SequenceError, match="UNKNOWN_PHASE"):
        seq.run_phase("bogus", "v1", bucket="bucket", curated_prefix="curated/test", client=FakeBucket(), **_roots(tmp_path))


def test_run_phase_processes_every_symbol_in_the_phase(tmp_path, monkeypatch):
    client = FakeBucket()
    for dataset, schema, symbol, _definition_symbol in seq.PHASE_SYMBOLS["ohlcv"]:
        _put_ohlcv(client, dataset, symbol)

    calls = []

    def fake_run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs):
        calls.append((dataset, schema, symbol, dataset_version))
        return _fake_published(dataset_version, kwargs)

    monkeypatch.setattr(backfill_driver, "run_s3_backfill", fake_run_s3_backfill)

    outcomes = seq.run_phase("ohlcv", "v1", bucket="bucket", curated_prefix="curated/test", client=client, **_roots(tmp_path))

    assert len(outcomes) == 4
    assert all(o["status"] == "ok" for o in outcomes)
    assert len(calls) == 4
    assert len({c[3] for c in calls}) == 4


def test_ohlcv1m_phase_processes_its_own_sources_and_version(tmp_path, monkeypatch):
    client = FakeBucket()
    for dataset, schema, symbol, _definition_symbol in seq.PHASE_SYMBOLS["ohlcv1m"]:
        _put_ohlcv(client, dataset, symbol, schema)

    calls = []

    def fake_run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs):
        calls.append((dataset, schema, symbol, dataset_version, kwargs["allow_quarantine_skip"]))
        return _fake_published(dataset_version, kwargs)

    monkeypatch.setattr(backfill_driver, "run_s3_backfill", fake_run_s3_backfill)
    outcomes = seq.run_phase("ohlcv1m", "w606-ohlcv-1m-v1", bucket="bucket", curated_prefix="curated/test",
                             client=client, **_roots(tmp_path))

    assert [call[1] for call in calls] == ["ohlcv-1m"] * 4
    assert all(call[3] != "w606-ohlcv-1m-v1" and call[4] is True for call in calls)
    assert all(outcome["status"] == "ok" for outcome in outcomes)


def test_incomplete_output_is_not_success(tmp_path, monkeypatch):
    client = FakeBucket()
    for dataset, _, symbol, _ in seq.PHASE_SYMBOLS["ohlcv"]:
        _put_ohlcv(client, dataset, symbol)
    monkeypatch.setattr(backfill_driver, "run_s3_backfill", lambda *a, **kw: {"fully_published": False})
    outcomes = seq.run_phase("ohlcv", "v1", bucket="bucket", curated_prefix="curated/test", client=client, **_roots(tmp_path))
    assert all(o["status"] == "failed" and "INCOMPLETE_PUBLICATION" in o["error"] for o in outcomes)


def test_run_phase_continues_past_one_symbols_failure(tmp_path, monkeypatch):
    client = FakeBucket()
    # AAPL and TSLA have real data; ES and NQ don't -- their discovery fails.
    _put_ohlcv(client, "XNAS.ITCH", "AAPL")
    _put_ohlcv(client, "XNAS.ITCH", "TSLA")

    calls = []

    def fake_run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs):
        calls.append(symbol)
        return _fake_published(dataset_version, kwargs)



    monkeypatch.setattr(backfill_driver, "run_s3_backfill", fake_run_s3_backfill)

    outcomes = seq.run_phase("ohlcv", "v1", bucket="bucket", curated_prefix="curated/test", client=client, **_roots(tmp_path))

    assert len(outcomes) == 4
    by_symbol = {o["symbol"]: o for o in outcomes}
    assert by_symbol["ES"]["status"] == "failed"
    assert "RawSourceError" in by_symbol["ES"]["error"]
    assert by_symbol["NQ"]["status"] == "failed"
    assert by_symbol["AAPL"]["status"] == "ok"
    assert by_symbol["TSLA"]["status"] == "ok"
    assert calls == ["AAPL", "TSLA"]


@pytest.fixture
def short_root():
    with tempfile.TemporaryDirectory(prefix="bf-") as directory:
        yield Path(directory)


def test_real_resume(short_root, monkeypatch):
    client = FakeBucket()
    monkeypatch.setitem(seq.PHASE_SYMBOLS, "ohlcv", [("XNAS.ITCH", "ohlcv-1s", "AAPL", None), ("XNAS.ITCH", "ohlcv-1s", "TSLA", None)])
    for symbol in ("AAPL", "TSLA"):
        _put_ohlcv(client, "XNAS.ITCH", symbol)
    roots = _roots(short_root)
    first = seq.run_phase("ohlcv", "real-v1", bucket="bucket", curated_prefix="curated/test", client=client, **roots)
    assert all(o["status"] == "ok" for o in first), first
    current, _ = seq.s3_publish.Store(client, "bucket", "curated/test").get_json("_catalog/CURRENT.json")
    import sqlite3
    with closing(sqlite3.connect(Path(roots["catalog_root"], current["catalog_key"]))) as con:
        rows = con.execute("SELECT instrument_id,date FROM partitions").fetchall()
    assert len(rows) == 4
    assert len({r[0] for r in rows}) == 2
    assert not list(Path(roots["staging_root"]).rglob("*.ndjson"))
    monkeypatch.setattr(client, "head_object", lambda **kw: pytest.fail("completed month downloaded raw again"))
    second = seq.run_phase("ohlcv", "real-v1", bucket="bucket", curated_prefix="curated/test", client=client, **roots)
    assert all(o["status"] == "ok" for o in second), second


def _build_shared_client(objects, last_modified, guard):
    return _SharedFakeClient(objects, last_modified, guard)


def _exit_without_a_result(exit_code):
    os._exit(exit_code)


def _hold_capacity_reservation(staging_root, admitted, release, result):
    """Top-level so Windows spawn and Linux fork both exercise the real
    filesystem lock and durable ledger instead of a thread-local imitation."""
    os.environ["TT_CONVERT_GLOBAL_RESERVE_BYTES"] = "1"
    os.environ["TT_CONVERT_SCRATCH_BYTES"] = "1"
    reservation = seq._CapacityReservation(staging_root)
    try:
        reservation.admit([{"bytes": 1}])
        result.put(("admitted", reservation.key))
        admitted.set()
        if not release.wait(15):
            raise RuntimeError("TEST_RESERVATION_RELEASE_TIMEOUT")
    except BaseException as error:
        result.put(("error", f"{type(error).__name__}: {error}"))
        raise
    finally:
        reservation.release()


def test_capacity_reservations_keep_both_real_worker_claims_across_a_process_boundary(tmp_path):
    context = multiprocessing.get_context("spawn")
    admitted = [context.Event(), context.Event()]
    release = context.Event()
    result = context.Queue()
    workers = [
        context.Process(target=_hold_capacity_reservation,
                        args=(str(tmp_path), admitted[index], release, result))
        for index in range(2)
    ]
    try:
        for worker in workers:
            worker.start()
        assert all(event.wait(15) for event in admitted), "each worker must publish its claim"
        outcomes = [result.get(timeout=5) for _ in workers]
        assert all(status == "admitted" for status, _key in outcomes), outcomes
        ledger = json.loads((tmp_path / "_capacity-reservations.json").read_text(encoding="utf-8"))
        assert set(ledger) == {"reservations"}
        assert len(ledger["reservations"]) == 2
        assert all(entry["bytes"] == 2 for entry in ledger["reservations"].values())
    finally:
        release.set()
        for worker in workers:
            worker.join(timeout=15)
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
    assert all(worker.exitcode == 0 for worker in workers)
    assert json.loads((tmp_path / "_capacity-reservations.json").read_text(encoding="utf-8")) == {
        "reservations": {}
    }


def test_pool_size_greater_than_one_runs_symbols_as_real_separate_processes(short_root, monkeypatch):
    monkeypatch.setitem(seq.PHASE_SYMBOLS, "ohlcv", [
        ("XNAS.ITCH", "ohlcv-1s", "AAPL", None), ("XNAS.ITCH", "ohlcv-1s", "TSLA", None),
        ("XNAS.ITCH", "ohlcv-1s", "MSFT", None), ("XNAS.ITCH", "ohlcv-1s", "NVDA", None),
    ])
    import datetime as dt
    manager = multiprocessing.Manager()
    objects, last_modified, guard = manager.dict(), manager.dict(), manager.Lock()
    for symbol in ("AAPL", "TSLA", "MSFT", "NVDA"):
        key = f"raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol={symbol}/year=2025/month=09/x.csv"
        objects[key] = ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode()
        last_modified[key] = dt.datetime(2025, 9, 1, tzinfo=dt.timezone.utc)
    seed_client = _SharedFakeClient(objects, last_modified, guard)

    roots = _roots(short_root)
    outcomes = seq.run_phase(
        "ohlcv", "pool-v1", bucket="bucket", curated_prefix="curated/test", client=None, pool_size=4,
        client_factory=partial(_build_shared_client, objects, last_modified, guard), **roots,
    )

    assert [o["symbol"] for o in outcomes] == ["AAPL", "TSLA", "MSFT", "NVDA"]  # original PHASE_SYMBOLS order preserved
    assert all(o["status"] == "ok" for o in outcomes), outcomes

    current, _ = seq.s3_publish.Store(seed_client, "bucket", "curated/test").get_json("_catalog/CURRENT.json")
    with closing(sqlite3.connect(Path(roots["catalog_root"], current["catalog_key"]))) as con:
        rows = con.execute("SELECT instrument_id, date FROM partitions").fetchall()
    assert len(rows) == 8  # every symbol's both fixture days, none lost across the process boundary
    assert len({r[0] for r in rows}) == 4


def test_pool_reports_a_spawned_worker_that_exits_without_a_result(short_root, monkeypatch):
    monkeypatch.setitem(seq.PHASE_SYMBOLS, "ohlcv", [("XNAS.ITCH", "ohlcv-1s", "AAPL", None)])

    outcomes = seq.run_phase(
        "ohlcv", "pool-exit-v1", bucket="bucket", curated_prefix="curated/test", client=None, pool_size=2,
        client_factory=partial(_exit_without_a_result, 7), **_roots(short_root),
    )

    assert outcomes == [{
        "dataset": "XNAS.ITCH", "schema": "ohlcv-1s", "symbol": "AAPL", "status": "failed",
        "error": "WORKER_EXITED_WITHOUT_RESULT:7",
    }]


def test_pool_size_requires_building_its_own_client_per_worker(tmp_path):
    with pytest.raises(seq.SequenceError, match="POOLED_EXECUTION_BUILDS_ITS_OWN_CLIENT_PER_WORKER"):
        seq.run_phase("ohlcv", "v1", bucket="bucket", curated_prefix="curated/test",
                      client=FakeBucket(), pool_size=2, **_roots(tmp_path))


def test_invalid_pool_size_is_rejected(tmp_path):
    with pytest.raises(seq.SequenceError, match="INVALID_POOL_SIZE"):
        seq.run_phase("ohlcv", "v1", bucket="bucket", curated_prefix="curated/test",
                      client=FakeBucket(), pool_size=0, **_roots(tmp_path))


def _put_ohlcv_month(client, dataset, symbol, month):
    key = f"raw/databento/dataset={dataset}/schema=ohlcv-1s/symbol={symbol}/year=2025/month={month}/x.csv"
    client.put_raw(key, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())


def _partial(version, quarantined="2025-09-02"):
    return {"results": [], "skipped_dates": [], "fully_published": False,
            "quarantined_dates": [{"date": quarantined, "error": "JobError: QUARANTINE_BLOCKS_PUBLICATION:k:d:2",
                                   "evidence": f"/stage/{version}/rejections.json"}]}


def test_a_partial_month_does_not_stop_the_symbols_remaining_months(tmp_path, monkeypatch):
    client = FakeBucket()
    _put_ohlcv_month(client, "XNAS.ITCH", "AAPL", "09")
    _put_ohlcv_month(client, "XNAS.ITCH", "AAPL", "10")
    roots = _roots(tmp_path)
    seen = []

    def fake_run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs):
        seen.append(dataset_version)
        if dataset_version.endswith("2025-09"):
            return _partial(dataset_version)
        return _fake_published(dataset_version, kwargs)

    monkeypatch.setattr(backfill_driver, "run_s3_backfill", fake_run_s3_backfill)

    outcome = seq._run_one_symbol(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", None, "v1", client=client, bucket="bucket",
        curated_prefix="curated/test", min_free_bytes=0, job_kwargs={}, **roots,
    )

    assert len(seen) == 2, "the bad first month must not stop the second"
    assert outcome["status"] == "partial"
    assert [p["version"] for p in outcome["partial_months"]] == ["v1-xnas-itch-ohlcv-1s-aapl-2025-09"]
    marker = Path(roots["staging_root"], "_sequence")
    assert not (marker / "v1-xnas-itch-ohlcv-1s-aapl-2025-09-complete.json").exists()
    assert (marker / "v1-xnas-itch-ohlcv-1s-aapl-2025-10-complete.json").exists()


def test_an_incomplete_month_with_no_quarantined_days_still_fails_the_symbol(tmp_path, monkeypatch):
    client = FakeBucket()
    _put_ohlcv_month(client, "XNAS.ITCH", "AAPL", "09")

    monkeypatch.setattr(backfill_driver, "run_s3_backfill",
                        lambda *a, **k: {"results": [], "skipped_dates": [], "fully_published": False})

    outcome = seq._run_one_symbol(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", None, "v1", client=client, bucket="bucket",
        curated_prefix="curated/test", min_free_bytes=0, job_kwargs={}, **_roots(tmp_path),
    )

    assert outcome["status"] == "failed"
    assert "INCOMPLETE_PUBLICATION" in outcome["error"]


@pytest.mark.parametrize("phase,expected", [("ohlcv", True), ("ohlcv1m", True), ("l1", True), ("l2", False)])
def test_only_phases_without_depth_continuity_may_skip_a_quarantined_day(tmp_path, monkeypatch, phase, expected):
    client = FakeBucket()
    for dataset, schema, symbol, _d in seq.PHASE_SYMBOLS[phase]:
        client.put_raw(
            f"raw/databento/dataset={dataset}/schema={schema}/symbol={symbol}/year=2025/month=09/x.csv",
            ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode(),
        )
    seen = []

    def fake_run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs):
        seen.append(kwargs.get("allow_quarantine_skip"))
        return _fake_published(dataset_version, kwargs)

    monkeypatch.setattr(backfill_driver, "run_s3_backfill", fake_run_s3_backfill)
    seq.run_phase(phase, "v1", bucket="bucket", curated_prefix="curated/test", client=client, **_roots(tmp_path))

    assert seen and all(flag is expected for flag in seen)


def test_the_run_halts_before_global_free_space_is_endangered(tmp_path, monkeypatch):
    # Each symbol-month keeps its own stage, so the per-stage scratch budget
    # cannot bound the aggregate. A retained partial month holds ~19x its
    # compressed size, so the sequence checks global headroom per month.
    client = FakeBucket()
    _put_ohlcv_month(client, "XNAS.ITCH", "AAPL", "09")
    _put_ohlcv_month(client, "XNAS.ITCH", "AAPL", "10")
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", str(8 * 1024**4))

    class _Usage:
        free = 4 * 1024**4

    monkeypatch.setattr(seq.shutil, "disk_usage", lambda path: _Usage())
    started = []

    def fake_run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs):
        kwargs["on_month_admission"]([{"bytes": 0}])
        started.append(dataset_version)
        return _fake_published(dataset_version, kwargs)

    monkeypatch.setattr(backfill_driver, "run_s3_backfill", fake_run_s3_backfill)

    outcome = seq._run_one_symbol(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", None, "v1", client=client, bucket="bucket",
        curated_prefix="curated/test", min_free_bytes=1, job_kwargs={}, **_roots(tmp_path),
    )

    assert started == [], "no month may begin once headroom is below the reserve"
    assert outcome["status"] == "failed"
    assert "GLOBAL_SCRATCH_RESERVE_EXCEEDED" in outcome["error"]
    assert outcome["retryable"] is False


def test_month_admission_preserves_global_reserve_after_scratch_and_download(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", "100")
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "200")

    class _Usage:
        free = 349

    monkeypatch.setattr(seq.shutil, "disk_usage", lambda path: _Usage())
    with pytest.raises(seq.SequenceError, match=r"GLOBAL_SCRATCH_RESERVE_EXCEEDED:349<350"):
        seq._month_capacity_admission(tmp_path, [{"bytes": 50}])


def test_month_admission_refuses_an_unusable_frozen_size_before_download(tmp_path):
    with pytest.raises(seq.SequenceError, match="INVALID_SOURCE_SIZE_FOR_CAPACITY_ADMISSION"):
        seq._month_capacity_admission(tmp_path, [{"bytes": True}])


def test_concurrent_month_reservations_cannot_overcommit_the_same_free_space(tmp_path, monkeypatch):
    # Two workers can otherwise both see the same free-space value before
    # either expands a split.  The second claim must include the first one's
    # whole scratch ceiling even though disk_usage itself has not moved yet.
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", "100")
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "200")

    class _Usage:
        free = 699

    monkeypatch.setattr(seq.shutil, "disk_usage", lambda path: _Usage())
    first = seq._CapacityReservation(tmp_path)
    second = seq._CapacityReservation(tmp_path)
    first.admit([{"bytes": 100}])
    try:
        with pytest.raises(seq.SequenceError, match=r"GLOBAL_SCRATCH_RESERVE_EXCEEDED:699<700"):
            second.admit([{"bytes": 100}])
    finally:
        first.release()

    second.admit([{"bytes": 100}])
    second.release()
    state = json.loads((tmp_path / "_capacity-reservations.json").read_text(encoding="utf-8"))
    assert state == {"reservations": {}}


def test_capacity_reservation_accumulates_raw_and_definition_downloads(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", "100")
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "200")

    class _Usage:
        free = 1000

    monkeypatch.setattr(seq.shutil, "disk_usage", lambda path: _Usage())
    reservation = seq._CapacityReservation(tmp_path)
    try:
        reservation.admit([{"bytes": 100}])
        reservation.admit([{"bytes": 50}])
        state = json.loads((tmp_path / "_capacity-reservations.json").read_text(encoding="utf-8"))
        assert state["reservations"][reservation.key]["bytes"] == 350
    finally:
        reservation.release()


def test_capacity_reservation_rejects_malformed_owner_metadata(tmp_path):
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "_capacity-reservations.json").write_text(
        json.dumps({"reservations": {"broken": {"bytes": 1}}}), encoding="utf-8"
    )

    with pytest.raises(seq.SequenceError, match="CAPACITY_RESERVATION_STATE_INVALID"):
        seq._CapacityReservation(staging)._read()


def test_completed_month_cleanup_rejects_a_symlinked_stage(tmp_path):
    staging = tmp_path / "staging"
    outside = tmp_path / "outside"
    job_id = "a" * 64
    sentinel = outside / job_id / "raw" / "must-survive"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_text("sentinel", encoding="utf-8")
    staging.mkdir()
    try:
        (staging / "v1").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation is unavailable in this test environment")

    with pytest.raises(seq.SequenceError, match="UNSAFE_COMPLETED_SCRATCH"):
        seq._clean_completed_month(staging, "v1", {"results": [{"job_id": job_id}]})
    assert sentinel.read_text(encoding="utf-8") == "sentinel"


def test_completed_derived_month_releases_rows_but_retains_evidence(tmp_path):
    staging = tmp_path / "staging"
    job_id = "a" * 64
    job = staging / "v1" / job_id[:16]
    day = job / "instrument" / "trade_level_1m" / "v1" / "2025-09-06"
    day.mkdir(parents=True)
    (day / "rows.ndjson").write_text("large staging rows", encoding="utf-8")
    (day / "part-00000.parquet").write_bytes(b"published part evidence")
    (job / "checkpoint.json").write_text("checkpoint", encoding="utf-8")
    outcome = {"results": [{"job_id": job_id}]}

    seq._clean_completed_month(staging, "v1", outcome, derived=True)
    seq._clean_completed_month(staging, "v1", outcome, derived=True)

    assert not (day / "rows.ndjson").exists()
    assert (day / "part-00000.parquet").read_bytes() == b"published part evidence"
    assert (job / "checkpoint.json").read_text(encoding="utf-8") == "checkpoint"


def test_completed_nonderived_month_keeps_rows(tmp_path):
    staging = tmp_path / "staging"
    job_id = "a" * 64
    day = staging / "v1" / job_id / "instrument" / "trade_level_1m" / "v1" / "2025-09-06"
    day.mkdir(parents=True)
    (day / "rows.ndjson").write_text("rows", encoding="utf-8")

    seq._clean_completed_month(staging, "v1", {"results": [{"job_id": job_id}]})

    assert (day / "rows.ndjson").read_text(encoding="utf-8") == "rows"


def test_completed_derived_month_rejects_symlink_without_deleting_rows(tmp_path):
    staging = tmp_path / "staging"
    job_id = "a" * 64
    job = staging / "v1" / job_id[:16]
    day = job / "instrument" / "trade_level_1m" / "v1" / "2025-09-06"
    day.mkdir(parents=True)
    rows = day / "rows.ndjson"
    rows.write_text("rows", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (job / "linked").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation is unavailable in this test environment")

    with pytest.raises(seq.SequenceError, match="UNSAFE_COMPLETED_SCRATCH"):
        seq._clean_completed_month(staging, "v1", {"results": [{"job_id": job_id}]}, derived=True)
    assert rows.read_text(encoding="utf-8") == "rows"


def test_capacity_reservation_waits_for_a_briefly_held_ledger_lock(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", "1")
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "1")

    class _Usage:
        free = 10_000

    monkeypatch.setattr(seq.shutil, "disk_usage", lambda path: _Usage())
    reservation = seq._CapacityReservation(tmp_path)
    attempted = threading.Event()
    errors = []

    def admit():
        attempted.set()
        try:
            reservation.admit([{"bytes": 1}])
        except BaseException as error:
            errors.append(error)

    from local_lock import LocalLock
    with LocalLock(str(tmp_path / ".capacity-reservations.guard")):
        worker = threading.Thread(target=admit)
        worker.start()
        assert attempted.wait(timeout=1)
        time.sleep(0.1)
        assert worker.is_alive()
    worker.join(timeout=2)
    try:
        assert not worker.is_alive()
        assert errors == []
    finally:
        reservation.release()


def test_a_partial_month_writes_a_durable_operator_receipt(tmp_path, monkeypatch):
    client = FakeBucket()
    _put_ohlcv_month(client, "XNAS.ITCH", "AAPL", "09")
    roots = _roots(tmp_path)
    monkeypatch.setattr(backfill_driver, "run_s3_backfill",
                        lambda *a, **k: _partial(a[4]))

    outcome = seq._run_one_symbol(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", None, "v1", client=client, bucket="bucket",
        curated_prefix="curated/test", min_free_bytes=0, job_kwargs={}, **roots,
    )

    receipt_path = Path(roots["staging_root"], "_sequence", "v1-xnas-itch-ohlcv-1s-aapl-2025-09-partial.json")
    assert receipt_path.exists(), "a partial month must survive the process that produced it"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["status"] == "partial"
    assert receipt["symbol"] == "AAPL"
    assert [q["date"] for q in receipt["quarantined_dates"]] == ["2025-09-02"]
    assert receipt["operator_action_required"]
    assert receipt["recorded_at"]
    assert outcome["status"] == "partial"


def test_completed_retry_retains_and_binds_the_prior_partial_receipt(tmp_path, monkeypatch):
    client = FakeBucket()
    _put_ohlcv_month(client, "XNAS.ITCH", "AAPL", "09")
    roots = _roots(tmp_path)
    attempts = 0

    def fake_run_s3_backfill(dataset, schema, symbol, dates, dataset_version, **kwargs):
        nonlocal attempts
        attempts += 1
        return _partial(dataset_version) if attempts == 1 else _fake_published(dataset_version, kwargs)

    monkeypatch.setattr(backfill_driver, "run_s3_backfill", fake_run_s3_backfill)
    first = seq._run_one_symbol(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", None, "v1", client=client, bucket="bucket",
        curated_prefix="curated/test", min_free_bytes=0, job_kwargs={}, **roots,
    )
    second = seq._run_one_symbol(
        "XNAS.ITCH", "ohlcv-1s", "AAPL", None, "v1", client=client, bucket="bucket",
        curated_prefix="curated/test", min_free_bytes=0, job_kwargs={}, **roots,
    )

    assert first["status"] == "partial" and second["status"] == "ok"
    marker = Path(roots["staging_root"], "_sequence")
    partial = marker / "v1-xnas-itch-ohlcv-1s-aapl-2025-09-partial.json"
    completed = json.loads((marker / "v1-xnas-itch-ohlcv-1s-aapl-2025-09-complete.json").read_text(encoding="utf-8"))
    assert partial.exists()
    assert completed["resolved_partial_receipt"]["path"] == partial.name
    assert completed["resolved_partial_receipt"]["sha256"] == hashlib.sha256(partial.read_bytes()).hexdigest()


def test_only_a_transient_transport_fault_is_marked_retryable():
    class _Timeout(Exception):
        pass
    _Timeout.__name__ = "ReadTimeoutError"

    class _Throttled(Exception):
        response = {"ResponseMetadata": {"HTTPStatusCode": 503}, "Error": {"Code": "SlowDown"}}

    assert seq.is_retryable(_Timeout()) is True
    assert seq.is_retryable(_Throttled()) is True
    assert seq.is_retryable(seq.SequenceError("INCOMPLETE_PUBLICATION")) is False
    assert seq.is_retryable(ValueError("anything unclassified")) is False


def test_select_symbols_defaults_to_the_whole_phase():
    assert seq.select_symbols("l1") == list(seq.PHASE_SYMBOLS["l1"])


def test_select_symbols_honours_the_requested_order():
    # The pool starts symbols in list order, so ordering is the whole point:
    # pairing heavy ES with a light equity and leaving NQ for last is a
    # scheduling decision that previously required editing this module.
    chosen = seq.select_symbols("l1", ["ES", "AAPL", "TSLA", "NQ"])
    assert [entry[2] for entry in chosen] == ["ES", "AAPL", "TSLA", "NQ"]
    assert chosen != list(seq.PHASE_SYMBOLS["l1"])


def test_select_symbols_narrows_to_a_subset():
    chosen = seq.select_symbols("l1", ["AAPL"])
    assert [entry[2] for entry in chosen] == ["AAPL"]
    assert chosen[0] in seq.PHASE_SYMBOLS["l1"]


def test_select_symbols_preserves_the_dataset_and_definition_of_each_entry():
    (dataset, schema, symbol, definition) = seq.select_symbols("l1", ["ES"])[0]
    assert (dataset, schema, symbol, definition) == ("GLBX.MDP3", "mbp-1", "ES", "ES")
    (dataset, schema, symbol, definition) = seq.select_symbols("l1", ["AAPL"])[0]
    assert (dataset, schema, symbol, definition) == ("XNAS.ITCH", "mbp-1", "AAPL", None)


def test_an_unknown_symbol_is_refused_and_names_the_valid_set():
    with pytest.raises(seq.SequenceError) as raised:
        seq.select_symbols("l1", ["ES", "BTCUSDT"])
    assert "UNKNOWN_SYMBOL_FOR_PHASE:l1:BTCUSDT" in str(raised.value)
    assert "AAPL,ES,NQ,TSLA" in str(raised.value)


def test_a_repeated_symbol_is_refused_rather_than_converted_twice():
    with pytest.raises(seq.SequenceError, match="DUPLICATE_SYMBOL:ES"):
        seq.select_symbols("l1", ["ES", "ES"])


def test_an_empty_selection_is_refused_rather_than_silently_doing_nothing():
    with pytest.raises(seq.SequenceError, match="NO_SYMBOLS_SELECTED"):
        seq.select_symbols("l1", [])
