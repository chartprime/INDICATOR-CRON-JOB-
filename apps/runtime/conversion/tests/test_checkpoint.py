"""Whole-job checkpoint: creation, atomic persistence, and resume bookkeeping."""
from __future__ import annotations

import json
import os

import pytest

import checkpoint as ckpt

_INPUTS = [
    {"s3_key": "raw/a.dbn", "sha256": "a" * 64, "bytes": 10, "last_modified": "2025-09-01T00:00:00Z"},
    {"s3_key": "raw/b.dbn", "sha256": "b" * 64, "bytes": 20, "last_modified": "2025-09-02T00:00:00Z"},
]
_PLAN = [{"instrument_id": "AAPL", "family": "candle", "date": "2025-09-02", "from_ns": 0, "to_ns": 1,
          "s3_key": "raw/a.dbn", "source_rank": 0}]
_MANIFEST = {
    "parts": [{"name": "part-00000.parquet", "sha256": "p" * 64}],
    "record_count": 10, "rejected_count": 0, "event_ns_min": 1, "event_ns_max": 2,
    "logical_sha256": "l" * 64,
}


def _new():
    return ckpt.new("job123", "20260910T000000Z", 1_700_000_000_000_000_000, _PLAN, _INPUTS)


def test_new_checkpoint_freezes_the_given_facts_and_starts_with_empty_progress():
    c = _new()
    assert c["job_id"] == "job123"
    assert c["dataset_version"] == "20260910T000000Z"
    assert c["authority_plan"] == _PLAN
    assert c["completed_partitions"] == []
    assert [i["s3_key"] for i in c["inputs"]] == ["raw/a.dbn", "raw/b.dbn"]
    assert all(i["split_done"] is False and i["day_units"] == [] for i in c["inputs"])


def test_save_writes_atomically_and_load_round_trips_the_same_content(tmp_path):
    stage = tmp_path / "job123"
    saved = ckpt.save(stage, _new(), "2025-09-01T00:00:00Z")
    assert saved["updated_at"] == "2025-09-01T00:00:00Z"
    assert not any(name.startswith("checkpoint.json.tmp") for name in os.listdir(stage))
    loaded = ckpt.load(stage)
    assert loaded == saved
    with open(stage / "checkpoint.json", encoding="utf-8") as fh:
        assert json.load(fh) == saved


def test_load_returns_none_when_no_checkpoint_exists_yet(tmp_path):
    assert ckpt.load(tmp_path / "missing-job") is None


def test_load_rejects_a_checkpoint_missing_its_job_id(tmp_path):
    stage = tmp_path / "job123"
    os.makedirs(stage)
    with open(stage / "checkpoint.json", "w", encoding="utf-8") as fh:
        json.dump({"dataset_version": "x"}, fh)
    with pytest.raises(ckpt.CheckpointError, match="CORRUPT_CHECKPOINT"):
        ckpt.load(stage)


def test_split_then_mapped_tracks_per_day_progress_and_pending_units():
    c = _new()
    assert ckpt.pending_day_units(c, "raw/a.dbn") is None  # split not run yet
    units = [{"date": "2025-09-01", "first_row": 0, "last_row": 9}, {"date": "2025-09-02", "first_row": 10, "last_row": 19}]
    ckpt.mark_split_done(c, "raw/a.dbn", units)
    assert [u["date"] for u in ckpt.pending_day_units(c, "raw/a.dbn")] == ["2025-09-01", "2025-09-02"]
    ckpt.mark_day_mapped(c, "raw/a.dbn", "2025-09-01")
    assert [u["date"] for u in ckpt.pending_day_units(c, "raw/a.dbn")] == ["2025-09-02"]


def test_mark_day_mapped_on_an_unknown_day_or_input_raises():
    c = _new()
    ckpt.mark_split_done(c, "raw/a.dbn", [{"date": "2025-09-01"}])
    with pytest.raises(ckpt.CheckpointError, match="UNKNOWN_DAY_UNIT"):
        ckpt.mark_day_mapped(c, "raw/a.dbn", "2025-09-09")
    with pytest.raises(ckpt.CheckpointError, match="UNKNOWN_INPUT"):
        ckpt.mark_day_mapped(c, "raw/nope.dbn", "2025-09-01")


def test_partition_completion_is_recorded_and_duplicate_completion_raises():
    c = _new()
    assert ckpt.is_partition_complete(c, "AAPL", "candle", "2025-09-02") is False
    ckpt.mark_partition_complete(c, "AAPL", "candle", "2025-09-02", _MANIFEST, "m" * 64)
    assert ckpt.is_partition_complete(c, "AAPL", "candle", "2025-09-02") is True
    with pytest.raises(ckpt.CheckpointError, match="PARTITION_ALREADY_COMPLETED"):
        ckpt.mark_partition_complete(c, "AAPL", "candle", "2025-09-02", _MANIFEST, "m" * 64)


def test_a_resumed_checkpoint_reuses_the_frozen_fields_verbatim(tmp_path):
    stage = tmp_path / "job123"
    original = ckpt.save(stage, _new(), "2025-09-01T00:00:00Z")
    ckpt.mark_partition_complete(original, "AAPL", "candle", "2025-09-02", _MANIFEST, "m" * 64)
    ckpt.save(stage, original, "2025-09-01T00:05:00Z")

    resumed = ckpt.load(stage)
    assert resumed["job_id"] == original["job_id"]
    assert resumed["dataset_version"] == original["dataset_version"]
    assert resumed["conversion_started_ns"] == original["conversion_started_ns"]
    assert resumed["authority_plan"] == original["authority_plan"]
    assert resumed["completed_partitions"] == [{
        "instrument_id": "AAPL", "family": "candle", "date": "2025-09-02",
        "part_sha256s": ["p" * 64], "manifest_sha256": "m" * 64,
        "evicted": False,
        "catalog_fields": {
            "record_count": 10, "rejected_count": 0, "event_ns_min": 1, "event_ns_max": 2,
            "part_count": 1, "logical_sha256": "l" * 64,
        },
    }]


def test_evicting_a_partition_flags_it_and_is_idempotent_refused():
    c = _new()
    ckpt.mark_partition_complete(c, "AAPL", "candle", "2025-09-02", _MANIFEST, "m" * 64)
    ckpt.mark_partition_evicted(c, "AAPL", "candle", "2025-09-02")
    assert c["completed_partitions"][0]["evicted"] is True
    with pytest.raises(ckpt.CheckpointError, match="PARTITION_ALREADY_EVICTED"):
        ckpt.mark_partition_evicted(c, "AAPL", "candle", "2025-09-02")


def test_evicting_an_unknown_partition_raises():
    c = _new()
    with pytest.raises(ckpt.CheckpointError, match="UNKNOWN_COMPLETED_PARTITION"):
        ckpt.mark_partition_evicted(c, "AAPL", "candle", "2025-09-02")
