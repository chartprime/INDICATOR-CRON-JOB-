"""Writer correctness + a real regression guard at a scale where the old
`finalize()` patterns (an un-materialized `_staged` view re-scanned by every
split query, a full bidirectional EXCEPT ALL over every column, a
budget.check() on every ~64KB of NDJSON) would show up as clearly higher
latency. Every existing writer test uses 2-row fixtures -- nowhere near
where any of that mattered, which is exactly how it reached a real host
before anyone noticed.

Not a claim this reproduces the full host failure (that needed an
accumulating multi-partition job tree, not one writer's own directory) --
but it is a real, checked-in scale higher than anything before it, and a
tripwire if the fixed patterns ever come back.
"""
from __future__ import annotations

import time

import writer

ROW_COUNT = 300_000  # comfortably above ROW_GROUP_SIZE, forces multiple output parts
WALL_TIME_BUDGET_S = 60  # generous; this is a regression tripwire, not a tight perf bound


def _price(value):
    return {"coefficient": str(int(round(value * 100))), "scale": 2}


def _synthetic_depth_record(i, event_ns):
    levels = [{"price": _price(100 + i % 50 + lvl), "size": _price(1 + lvl)} for lvl in range(5)]
    return {
        "id": f"rec-{i:09d}",
        "family": "depth",
        "instrument": {
            "id": "XCME:FUTURE:TSLA:USD:CONTRACT", "venue": "XCME", "market": "FUTURE",
            "symbol": "TSLA", "currency": "USD", "sizeUnit": "CONTRACT", "contract": "TSLAZ6",
        },
        "source": {
            "provider": "DATABENTO", "dataset": "GLBX.MDP3", "schema": "mbp-10",
            "population": "GLBX.MDP3:mbp-10", "datasetVersion": "20260910T000000Z",
            "methodVersion": "conversion/0.1", "sourceSymbol": "TSLAZ6",
            "mappingVersion": "1", "mappingReference": "synthetic", "streamId": "databento:GLBX.MDP3:mbp-10",
        },
        "time": {
            "eventNs": str(event_ns), "receiveNs": str(event_ns), "ingestNs": "1789000000000000000",
            "precision": "ns", "origin": "PROVIDER",
        },
        "order": {"position": i, "ordinal": 0, "sequence": str(i)},
        "lineage": {"object": "file://synthetic.dbn", "sha256": "0" * 64, "row": i},
        "quality": {"state": "OK", "flags": []},
        "data": {
            "action": "SNAPSHOT", "model": "TOP_N", "depthLimit": 5,
            "bids": levels, "asks": levels,
            "firstSequence": i, "lastSequence": i, "previousSequence": i - 1 if i else None,
            "batchId": "b0", "batchEnd": True, "reset": True,
        },
    }


def test_a_full_size_depth_partition_finalizes_correctly_and_within_a_sane_time_budget(tmp_path):
    pw = writer.PartitionWriter(str(tmp_path), "XCME:FUTURE:TSLA:USD:CONTRACT-scale", "depth", "v1", "2026-08-14")
    base_ns = 1_723_593_600_000_000_000  # 2024-08-14T00:00:00Z, arbitrary real-shaped ns
    started = time.monotonic()
    for i in range(ROW_COUNT):
        # Mostly-increasing event_ns with some same-ns clustering (realistic
        # for a busy book, and the exact shape that stresses `divide()`'s
        # low==high PARTITION_UNSPLITTABLE guard if it were ever wrong).
        event_ns = base_ns + (i // 4) * 1000
        outcome = pw.add(_synthetic_depth_record(i, event_ns), continuity={"continuity": "OK", "book_epoch": 0})
        assert outcome["accepted"] is True
    manifest = pw.finalize([{"s3_key": "raw/synthetic.dbn", "sha256": "0" * 64, "bytes": 1}])
    elapsed = time.monotonic() - started

    assert manifest["record_count"] == ROW_COUNT
    assert manifest["rejected_count"] == 0
    assert manifest["validation"] == {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True}
    assert len(manifest["parts"]) > 1  # actually exercised the multi-part split path
    assert sum(p["row_count"] for p in manifest["parts"]) == ROW_COUNT

    timings = manifest["stage_timings_s"]
    assert set(timings) == {
        "materialize_staged", "split_plan", "sort_and_write_parts",
        "validate_count_and_uniqueness", "validate_sorted", "validate_content_round_trip",
    }
    # Absolute bounds, not "less than total" -- measured ~0.02s and ~0.6s at
    # this row count. Generous headroom (5s), but tight enough that a
    # regression back to the un-materialized `_staged` re-scan (split_plan)
    # or the full EXCEPT ALL diff (validate_content_round_trip) -- each of
    # which would push these into tens of seconds at this row count -- fails
    # this test loudly instead of just being a bit slower.
    assert timings["split_plan"] < 5, f"split_plan took {timings['split_plan']}s -- looks like _staged isn't materialized"
    assert timings["validate_content_round_trip"] < 5, (
        f"validate_content_round_trip took {timings['validate_content_round_trip']}s -- bounded exact comparison exceeded its budget"
    )

    assert elapsed < WALL_TIME_BUDGET_S, (
        f"finalize() took {elapsed:.1f}s for {ROW_COUNT} rows -- "
        f"budget is {WALL_TIME_BUDGET_S}s; investigate before assuming this is fine"
    )
