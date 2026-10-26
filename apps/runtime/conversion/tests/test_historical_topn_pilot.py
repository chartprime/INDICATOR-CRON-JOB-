from __future__ import annotations

import hashlib
import importlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

import duckdb
import pytest


SCRIPTS = Path(__file__).parents[2] / "scripts" / "verify" / "databento"
sys.path.insert(0, str(SCRIPTS))
exporter = importlib.import_module("export_topn_part")
fetcher = importlib.import_module("fetch_verified_partition")
verifier = importlib.import_module("verify_historical_topn_partition")


@pytest.fixture
def pilot(tmp_path, monkeypatch):
    monkeypatch.setattr(exporter, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(fetcher, "DATA_ROOT", tmp_path)
    partition = {"family": "depth", "instrument_id": "AAPL", "date": "2026-08-05", "manifest_sha256": "a" * 64,
                 "part_count": 1, "record_count": 2}
    folder = tmp_path / "depth-2026-08-05-aaaaaaaaaaaa"
    folder.mkdir()
    source = folder / "part-00000.parquet"
    connection = duckdb.connect()
    try:
        connection.execute("""
            COPY (SELECT CAST(1785916800000000000 + n AS BIGINT) AS event_ns,
                         2 AS source_rank, 0 AS stable_position, 0 AS ordinal,
                         'AAPL' AS instrument_id, 'SNAPSHOT' AS depth_action,
                         'TOP_N' AS depth_model, 10 AS depth_limit,
                         [{'price': '100.00', 'size': '5'}] AS bids,
                         [{'price': '101.00', 'size': '6'}] AS asks,
                         'OK' AS continuity, 1 AS book_epoch
                  FROM (VALUES (2), (1)) AS rows(n)) TO ? (FORMAT PARQUET)
        """, [str(source)])
    finally:
        connection.close()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    plan = {"partition": partition, "relative_prefix": "curated/databento/databento/test",
            "parts": [{"name": source.name, "bytes": source.stat().st_size, "rows": 2, "sha256": digest}]}
    path = tmp_path / "plan.json"
    path.write_text(json.dumps(plan), encoding="utf-8")
    return source, path, digest


def test_export_keeps_adjacent_nanoseconds_exact_and_sorted(pilot, tmp_path):
    source, _, digest = pilot
    output = tmp_path / "ordered.jsonl"
    assert exporter.export(source, digest, output, "2026-08-05") == 2
    rows = [json.loads(line) for line in output.read_text().splitlines()]
    assert [row["event_ns"] for row in rows] == ["1785916800000000001", "1785916800000000002"]
    assert all(isinstance(row[field], str) for row in rows for field in exporter.FIELDS[:4])


def test_whole_partition_checks_identity_before_replaying(pilot):
    source, plan, _ = pilot
    source.write_bytes(source.read_bytes() + b"tampered")
    with pytest.raises(ValueError, match="byte count differs"):
        verifier.verify(plan, "0.01", "not-a-node-executable")


def test_book_oracle_refuses_a_different_catalog_instrument(pilot):
    _, path, _ = pilot
    plan = json.loads(path.read_text())
    plan["partition"]["instrument_id"] = "TSLA"
    path.write_text(json.dumps(plan))
    with pytest.raises(ValueError, match="instrument identity differs"):
        verifier.verify(path, "0.01", "not-a-node-executable")


def test_stream_worker_exits_on_invalid_input_without_waiting_for_source_eof():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for the JavaScript engine integration")
    worker = SCRIPTS / "verify-historical-topn-part.js"
    with subprocess.Popen([node, str(worker), "-", "1", "10"], stdin=subprocess.PIPE,
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as process:
        try:
            process.stdin.write(b"{}\n")
            process.stdin.flush()
            assert process.wait(timeout=5) != 0
            assert b"instrument_id is required" in process.stderr.read()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def test_whole_partition_streams_exact_order_through_the_real_engine(pilot):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for the JavaScript engine integration")
    _, plan, _ = pilot
    result = verifier.verify(plan, "0.01", node)
    assert result["oracle"]["rows"] == 2
    assert result["oracle"]["trusted"] == 2
    assert result["oracle"]["segments"] == 1


def test_full_book_oracle_keeps_crossed_source_unavailable_and_reseeds(pilot):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for the JavaScript engine integration")
    source, path, _ = pilot
    connection = duckdb.connect()
    try:
        connection.execute("CREATE TEMP TABLE states AS SELECT * REPLACE "
                           "([{'price':'102','size':'5'}] AS bids) FROM read_parquet(?) WHERE event_ns%10=2 "
                           "UNION ALL SELECT * FROM read_parquet(?) WHERE event_ns%10=1 "
                           "UNION ALL SELECT * REPLACE (event_ns+2 AS event_ns) FROM read_parquet(?) "
                           "WHERE event_ns%10=1", [str(source)] * 3)
        connection.execute("COPY states TO ? (FORMAT PARQUET)", [str(source.with_suffix(".new"))])
    finally:
        connection.close()
    source.with_suffix(".new").replace(source)
    plan = json.loads(path.read_text())
    plan["partition"]["record_count"] = 3
    plan["parts"][0].update(rows=3, bytes=source.stat().st_size,
                            sha256=hashlib.sha256(source.read_bytes()).hexdigest())
    path.write_text(json.dumps(plan))
    result = verifier.verify(path, "1", node)
    assert result["sourceBookQuality"] == {"incomplete": 0, "crossed": 1, "gapSuspected": 0}
    assert result["oracle"]["rows"] == 3
    assert result["oracle"]["trusted"] == 2
    assert result["oracle"]["segments"] == 2
    assert result["oracle"]["reasons"]["CROSSED_BOOK"] == 1


def test_plan_refuses_duplicate_parts(pilot):
    _, path, _ = pilot
    plan = json.loads(path.read_text())
    plan["parts"] *= 2
    plan["partition"]["part_count"] = 2
    path.write_text(json.dumps(plan))
    with pytest.raises(ValueError, match="duplicate part names"):
        fetcher.load_plan(path)


def test_plan_refuses_negative_sizes_before_admission(pilot):
    _, path, _ = pilot
    plan = json.loads(path.read_text())
    plan["parts"][0]["bytes"] = -1
    path.write_text(json.dumps(plan))
    with pytest.raises(ValueError, match="invalid part identity or size"):
        fetcher.load_plan(path)


def test_large_partition_requires_explicit_bounded_local_admission(pilot):
    _, path, _ = pilot
    plan = json.loads(path.read_text())
    plan["parts"] = [{"name": f"part-{n:05}.parquet", "bytes": 64 * 1024 * 1024,
                      "rows": 1, "sha256": "b" * 64} for n in range(5)]
    plan["partition"].update(part_count=5, record_count=5)
    path.write_text(json.dumps(plan))
    with pytest.raises(ValueError, match="source byte admission"):
        fetcher.load_plan(path)
    assert len(fetcher.load_plan(path, 512 * 1024 * 1024)["parts"]) == 5
    plan["parts"][0]["bytes"] += 1
    path.write_text(json.dumps(plan))
    with pytest.raises(ValueError, match="invalid part identity or size"):
        fetcher.load_plan(path, fetcher.MAX_SOURCE_BYTES)


@pytest.mark.parametrize("budget", [0, -1, True, fetcher.MAX_SOURCE_BYTES + 1])
def test_local_admission_refuses_invalid_or_unbounded_budget(pilot, budget):
    _, path, _ = pilot
    with pytest.raises(ValueError, match="source budget"):
        fetcher.load_plan(path, budget)


def test_partition_refuses_overlapping_ranges_before_streaming(pilot):
    source, path, _ = pilot
    copy = source.with_name("part-00001.parquet")
    shutil.copyfile(source, copy)
    plan = json.loads(path.read_text())
    plan["parts"].append({**plan["parts"][0], "name": copy.name})
    plan["partition"].update(part_count=2, record_count=4)
    path.write_text(json.dumps(plan))
    with pytest.raises(ValueError, match="parts overlap"):
        verifier.verify(path, "0.01", "not-a-node-executable")
