"""Failure-boundary integration tests for the Phase 2 audit."""
import json
import os
import sqlite3
import pytest
import catalog
import job
import budget
from test_job import MBP1, _MBP1_KEY, _roots, _csv_file


def inputs():
    return [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]


@pytest.mark.parametrize("boundary", ["intent", "CURRENT", "receipt"])
def test_catalog_interrupted_write_recovers(tmp_path, monkeypatch, boundary):
    real = catalog._atomic_write_json
    crashed = []
    def fail(path, value):
        real(path, value)
        hit = (boundary == "intent" and os.path.basename(path).startswith("intent-") and value.get("pointer")) or (boundary == "CURRENT" and os.path.basename(path) == "CURRENT.json") or (boundary == "receipt" and os.path.basename(path).startswith("receipt-"))
        if hit and not crashed:
            crashed.append(True)
            raise RuntimeError("crash")
    monkeypatch.setattr(catalog, "_atomic_write_json", fail)
    with pytest.raises(RuntimeError, match="crash"):
        job.run_job(inputs(), "v1", **_roots(tmp_path))
    monkeypatch.setattr(catalog, "_atomic_write_json", real)
    result = job.run_job(inputs(), "v1", **_roots(tmp_path))
    assert result["catalog_pointer"]["dataset_version"] == "v1"


def test_old_job_receipt_and_cumulative_catalog(tmp_path):
    roots = _roots(tmp_path)
    first = job.run_job(inputs(), "v1", **roots)
    csv = {"local_path": _csv_file(tmp_path), "s3_key": "raw/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/month=09/x.csv", "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL"}
    second = job.run_job([csv], "v2", **roots)
    again = job.run_job(inputs(), "v1", **roots)
    assert again["catalog_pointer"] == first["catalog_pointer"]
    assert catalog.read_current(roots["catalog_root"]) == second["catalog_pointer"]
    with sqlite3.connect(os.path.join(roots["catalog_root"], second["catalog_pointer"]["catalog_key"])) as con:
        assert con.execute("SELECT count(*) FROM partitions").fetchone()[0] == 3


@pytest.mark.parametrize("kind", ["split", "part"])
def test_resume_detects_artifact_damage(tmp_path, kind):
    roots = _roots(tmp_path)
    job.run_job(inputs(), "v1", **roots)
    if kind == "split":
        target = next((tmp_path / "staging").glob("*/raw/*/*.ndjson"))
    else:
        target = next((tmp_path / "curated").rglob("*.parquet"))
    target.write_bytes(b"damaged")
    with pytest.raises(job.JobError, match="INTEGRITY_FAILURE"):
        job.run_job(inputs(), "v1", **roots)


def test_tiny_budget_prevents_publication(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "1")
    with pytest.raises(RuntimeError, match="SCRATCH_BUDGET_EXCEEDED"):
        job.run_job(inputs(), "v1", **_roots(tmp_path))
    assert not (tmp_path / "curated" / "_catalog" / "CURRENT.json").exists()


def test_small_part_limit_splits_time_disjoint_parts(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_PART_ROWS", "1")
    result = job.run_job(inputs(), "v1", **_roots(tmp_path))
    path = tmp_path / "curated" / result["partitions"][0] / "_manifest.json"
    manifest = json.loads(path.read_text())
    assert len(manifest["parts"]) == 2
    assert sum(p["row_count"] for p in manifest["parts"]) == 2
    assert manifest["parts"][0]["event_ns_max"] < manifest["parts"][1]["event_ns_min"]


def test_mixed_mbp_tbbo_authority(tmp_path):
    from test_job import TBBO, _TBBO_KEY
    result = job.run_job(inputs() + [{"local_path": TBBO, "s3_key": _TBBO_KEY, "schema": "tbbo"}], "v1", **_roots(tmp_path))
    assert {p.split('/')[2] for p in result['partitions']} == {'trade', 'quote'}


def test_unknown_csv_overlap_refused(tmp_path):
    path = _csv_file(tmp_path)
    common = {"local_path": path, "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL"}
    with pytest.raises(Exception, match="UNKNOWN_COVERAGE_OVERLAP"):
        job.run_job([{**common, "s3_key": "raw/month=09/a.csv"}, {**common, "s3_key": "raw/month=09/day=02/b.csv"}], "v1", **_roots(tmp_path))


def test_authority_retains_disjoint_partial_intervals():
    import authority
    def source(key, start, end):
        return {"s3_key": key, "cadence": "daily", "last_modified": "2025-09-01T00:00:00Z", "coverage": [{"instrument_id": "x", "family": "trade", "date": "2025-09-01", "from_ns": start, "to_ns": end, "complete": False}]}
    plan, _, _ = authority.resolve([source("a", 0, 10), source("b", 10, 20)])
    assert [(p['from_ns'], p['to_ns']) for p in plan] == [(0, 10), (10, 20)]


def test_unsplittable_timestamp_fails_before_publication(tmp_path, monkeypatch):
    from test_writer import _records
    import writer
    records, _ = _records('databento-mbp1.dbn', 'mbp-1')
    monkeypatch.setenv('TT_CONVERT_PART_ROWS', '1')
    pw = writer.PartitionWriter(tmp_path, records[0]['instrument']['id'], 'quote', 'v1', '2020-12-28')
    pw.add(records[0])
    copy = json.loads(json.dumps(records[0]))
    copy['id'] = 'distinct'
    pw.add(copy)
    with pytest.raises(writer.WriterError, match='PARTITION_UNSPLITTABLE'):
        pw.finalize([])
