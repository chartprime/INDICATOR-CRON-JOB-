from __future__ import annotations

import threading

import pytest

import archive_telemetry as at


def test_every_declared_stage_starts_empty_with_one_slot_more_than_the_bucket_edges():
    snapshot = at.StageTelemetry().snapshot()

    assert set(snapshot["stages"]) == set(at.STAGES)
    assert snapshot["latencyBucketsMs"] == list(at.LATENCY_BUCKETS_MS)
    for entry in snapshot["stages"].values():
        assert entry["count"] == 0 and entry["totalMs"] == 0.0 and entry["maxMs"] == 0.0
        assert entry["buckets"] == [0] * (len(at.LATENCY_BUCKETS_MS) + 1)


def test_observations_land_in_the_bucket_whose_upper_edge_they_do_not_exceed():
    telemetry = at.StageTelemetry(stages=("a",), buckets=(10, 100))

    for value in (0.0, 10.0, 10.001, 100.0, 100.001, 5_000.0):
        telemetry.observe("a", value)

    entry = telemetry.snapshot()["stages"]["a"]
    assert entry["buckets"] == [2, 2, 2]
    assert entry["count"] == 6
    assert entry["maxMs"] == 5_000.0
    assert entry["totalMs"] == pytest.approx(0.0 + 10.0 + 10.001 + 100.0 + 100.001 + 5_000.0)


def test_an_unknown_stage_is_refused_instead_of_silently_growing_a_series():
    telemetry = at.StageTelemetry(stages=("a",))

    with pytest.raises(ValueError, match="UNKNOWN_TELEMETRY_STAGE:typo"):
        telemetry.observe("typo", 1.0)
    assert set(telemetry.snapshot()["stages"]) == {"a"}


def test_negative_and_nan_durations_are_dropped_not_recorded():
    telemetry = at.StageTelemetry(stages=("a",))

    telemetry.observe("a", -1.0)
    telemetry.observe("a", float("nan"))

    assert telemetry.snapshot()["stages"]["a"]["count"] == 0


def test_snapshot_is_a_copy_and_memory_stays_constant_under_many_observations():
    telemetry = at.StageTelemetry(stages=("a",), buckets=(1,))
    before = telemetry.snapshot()

    for index in range(5_000):
        telemetry.observe("a", index % 3)
    after = telemetry.snapshot()
    after["stages"]["a"]["buckets"][0] = 999

    assert before["stages"]["a"]["count"] == 0
    assert len(after["stages"]["a"]["buckets"]) == 2
    assert telemetry.snapshot()["stages"]["a"]["buckets"][0] != 999
    assert telemetry.snapshot()["stages"]["a"]["count"] == 5_000


def test_concurrent_observers_lose_no_counts():
    telemetry = at.StageTelemetry(stages=("a",))
    workers, per_worker = 8, 2_000

    def hammer():
        for _ in range(per_worker):
            telemetry.observe("a", 1.0)

    threads = [threading.Thread(target=hammer) for _ in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    entry = telemetry.snapshot()["stages"]["a"]
    assert entry["count"] == workers * per_worker
    assert sum(entry["buckets"]) == workers * per_worker


def test_reset_clears_every_stage():
    telemetry = at.StageTelemetry(stages=("a", "b"))
    telemetry.observe("a", 3.0)
    telemetry.observe("b", 4.0)

    telemetry.reset()

    assert all(entry["count"] == 0 for entry in telemetry.snapshot()["stages"].values())
