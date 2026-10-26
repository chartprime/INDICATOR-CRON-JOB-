from __future__ import annotations

import importlib
import hashlib
import json
from pathlib import Path
import shutil
import sys
from types import SimpleNamespace

import duckdb
import pytest


sys.path.insert(0, str(Path(__file__).parents[2] / "scripts" / "verify" / "databento"))
flow = importlib.import_module("verify_historical_cme_flow")
START = 1785888000000000000
DATE = "2026-08-05"


def native_row(action, index, ask_size=5, size=2, side="B"):
    best = SimpleNamespace(bid_px=99_000_000_000, ask_px=101_000_000_000, bid_sz=8, ask_sz=ask_size)
    empty = SimpleNamespace(bid_px=9223372036854775807, ask_px=9223372036854775807, bid_sz=0, ask_sz=0)
    return SimpleNamespace(action=action, side=side, price=101_000_000_000, size=size, publisher_id=1,
                           flags=0 if action == "T" else 128, instrument_id=10,
                           ts_event=START + index, ts_recv=START + index, sequence=index, levels=[best] + [empty] * 9)


def test_native_extraction_keeps_two_prints_in_source_order(tmp_path):
    records = [native_row("A", 0), native_row("T", 1), native_row("T", 1), native_row("C", 2, 1)]
    output = tmp_path / "trades.jsonl"
    result = flow.extract_trades(records, DATE, output, 4)
    rows = [json.loads(line) for line in output.read_text().splitlines()]
    assert [row["native_index"] for row in rows] == ["1", "2"]
    assert rows[0]["price"] == "101.000000000"
    assert result["trades"] == 2 and result["tradeBookChanges"] == 0


@pytest.mark.parametrize("records,message", [
    ([native_row("A", 0), native_row("T", 1, 1)], "changes its preceding book"),
    ([native_row("A", 2), native_row("C", 1)], "time regresses"),
    ([native_row("A", 0), native_row("F", 1)], "unqualified native book action"),
    ([native_row("A", 0), native_row("T", 1, side="X")], "side/size"),
    ([native_row("A", 0)], "count or trades disagree"),
    ([native_row("A", -1), native_row("T", 1)], "outside the day"),
])
def test_native_extraction_refuses_unqualified_inputs(tmp_path, records, message):
    with pytest.raises(ValueError, match=message):
        flow.extract_trades(records, DATE, tmp_path / "trades.jsonl", 2)


def test_native_extraction_enforces_both_spool_budgets(tmp_path, monkeypatch):
    records = [native_row("A", 0), native_row("T", 1)]
    monkeypatch.setattr(flow, "MAX_TRADE_BYTES", 1)
    with pytest.raises(ValueError, match="byte admission"):
        flow.extract_trades(records, DATE, tmp_path / "bytes.jsonl", 2)
    monkeypatch.setattr(flow, "MAX_TRADE_ROWS", 0)
    with pytest.raises(ValueError, match="trade admission"):
        flow.extract_trades(records, DATE, tmp_path / "rows.jsonl", 2)


@pytest.fixture
def source(tmp_path, monkeypatch):
    monkeypatch.setattr(flow, "DATA_ROOT", tmp_path)
    depth_file, trade_file = tmp_path / "depth.parquet", tmp_path / "trade.parquet"
    depth = {"family": "depth", "instrument_id": "ES", "record_count": 4, "date": DATE}
    trade = {"family": "trade", "instrument_id": "ES", "record_count": 2, "date": DATE}
    digest = "a" * 64
    with duckdb.connect() as connection:
        connection.execute("""
            CREATE TEMP TABLE depth_source AS SELECT ?::BIGINT+i AS event_ns, ?::BIGINT+i AS receive_ns, i AS sequence,
                         2 AS source_rank, pos AS stable_position, 0 AS ordinal, pos AS lineage_row,
                         ? AS lineage_sha256, 'ES' AS instrument_id, 'GLBX.MDP3' AS source_dataset,
                         'mbp-10' AS source_schema, 1 AS dbn_publisher_id,
                         CASE WHEN pos IN (1,2) THEN 0 ELSE 128 END AS dbn_source_flags,
                         'SNAPSHOT' AS depth_action, 'TOP_N' AS depth_model, 10 AS depth_limit,
                         [{'price':99::DECIMAL(38,12),'size':8::DECIMAL(38,12)}] AS bids,
                         [{'price':101::DECIMAL(38,12),'size':amount::DECIMAL(38,12)}] AS asks,
                         'OK' AS continuity, 1 AS book_epoch
                  FROM (VALUES (0,0,5),(1,1,5),(1,2,5),(2,3,1)) AS r(i,pos,amount)
        """, [START, START, digest])
        connection.execute("COPY depth_source TO ? (FORMAT PARQUET)", [str(depth_file)])
        connection.execute("""
            CREATE TEMP TABLE trade_source AS SELECT ?::BIGINT+1 AS event_ns, ?::BIGINT+1 AS receive_ns, 1 AS sequence,
                         'ES' AS instrument_id, 'GLBX.MDP3' AS source_dataset, 'mbp-1' AS source_schema,
                         1 AS dbn_publisher_id, 0 AS dbn_source_flags, 'T' AS dbn_source_action,
                         'NEW' AS trade_action, true AS valid_tick, 'BUY' AS side,
                         101::DECIMAL(38,12) AS price, 2::DECIMAL(38,12) AS size,
                         'l1-source' AS lineage_sha256, i AS lineage_row, 'print-'||i AS record_id
                  FROM range(2) AS r(i)
        """, [START, START])
        connection.execute("COPY trade_source TO ? (FORMAT PARQUET)", [str(trade_file)])
    records = [native_row("A", 0), native_row("T", 1), native_row("T", 1), native_row("C", 2, 1)]
    depth_plan = {"partition": depth, "parts": [{"name": depth_file.name, "rows": 4}]}
    depth_path, trade_path = tmp_path / "depth.json", tmp_path / "trade.json"
    monkeypatch.setattr(flow, "admit_source", lambda *_: (depth_plan, [str(depth_file)], digest))
    monkeypatch.setattr(flow, "verified_files", lambda *_: ({"partition": trade}, [str(trade_file)]))
    monkeypatch.setattr(flow, "native_records", lambda *_: (record for record in records))
    return depth_file, trade_file, depth_path, trade_path, records, depth, trade, digest


def rewrite(path, projection):
    with duckdb.connect() as connection:
        connection.execute(f"CREATE TEMP TABLE changed AS SELECT {projection} FROM read_parquet(?)", [str(path)])
        connection.execute("COPY changed TO ? (FORMAT PARQUET)", [str(path.with_suffix(".new"))])
    path.with_suffix(".new").replace(path)


def test_cme_native_order_reconciles_duplicate_prints_through_real_engine(source, tmp_path):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for engine integration")
    _, _, depth_path, trade_path, *_ = source
    result = flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", node)
    assert result["oracle"]["rows"] == 4
    assert result["oracle"]["observed"]["BUY"] == {"count": 2, "volume": 4}
    assert result["oracle"]["applied"] == 2 and result["independentFlowSamples"] == 1
    assert result["oracle"]["samples"][0]["buyVolume"] == 4


@pytest.mark.parametrize("rank", [0, 1, 3, 100])
def test_cme_accepts_one_conversion_assigned_rank_without_changing_native_order(source, tmp_path, rank):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for engine integration")
    depth_file, _, depth_path, trade_path, *_ = source
    rewrite(depth_file, f"* REPLACE ({rank} AS source_rank)")
    result = flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", node)
    assert result["oracle"]["rows"] == 4 and result["oracle"]["applied"] == 2
    assert int(result["oracle"]["samples"][0]["fromKey"][1]) == rank


def test_cme_flow_closes_a_segment_after_a_quiet_period_without_backdating_samples(source, tmp_path):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for engine integration")
    depth_file, _, depth_path, trade_path, records, *_ = source
    records[-1] = native_row("R", 90_000_000_000, 1)
    rewrite(depth_file, f"* REPLACE (CASE WHEN stable_position=3 THEN {START + 90_000_000_000} ELSE event_ns END AS event_ns, "
                        f"CASE WHEN stable_position=3 THEN {START + 90_000_000_000} ELSE receive_ns END AS receive_ns, "
                        "CASE WHEN stable_position=3 THEN 'RESET' ELSE continuity END AS continuity, "
                        "CASE WHEN stable_position=3 THEN 2 ELSE book_epoch END AS book_epoch)")
    result = flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", node)
    samples = result["oracle"]["samples"]
    assert result["oracle"]["segments"] == 2 and result["oracle"]["applied"] == 2
    assert [row["ts"] for row in samples] == sorted(row["ts"] for row in samples)
    assert samples[0]["tradeCount"] == 2 and samples[-1]["segment"] == 2


@pytest.mark.parametrize("target,projection,message", [
    ("trade", "* REPLACE (3::DECIMAL(38,12) AS size)", "trade multisets differ"),
    ("trade", "* REPLACE ('print-0' AS record_id)", "identity, uniqueness or count"),
    ("depth", "* REPLACE (stable_position+1 AS stable_position)", "complete native row order"),
    ("depth", "* REPLACE (-1 AS source_rank)", "complete native row order"),
    ("depth", "* REPLACE (NULL::BIGINT AS source_rank)", "complete native row order"),
    ("depth", "* REPLACE (CASE WHEN stable_position=3 THEN 3 ELSE 2 END AS source_rank)", "complete native row order"),
    ("depth", "* REPLACE ([{'price':101::DECIMAL(38,12),'size':3::DECIMAL(38,12)}] AS asks)", "do not match exactly one"),
])
def test_cme_refuses_bad_independent_or_native_correspondence_before_node(source, tmp_path, target, projection, message):
    depth_file, trade_file, depth_path, trade_path, *_ = source
    rewrite(trade_file if target == "trade" else depth_file, projection)
    with pytest.raises(ValueError, match=message):
        flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", "not-node")


def test_independent_reference_refuses_changed_engine_result(source, tmp_path, monkeypatch):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for engine integration")
    original = flow.reference_samples
    def corrupt(connection, result):
        result["samples"][0]["buyVolume"] = 0
        return original(connection, result)
    monkeypatch.setattr(flow, "reference_samples", corrupt)
    _, _, depth_path, trade_path, *_ = source
    with pytest.raises(ValueError, match="independent rolling flow disagrees"):
        flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", node)


def test_failed_reconciliation_preserves_pinned_worker_and_rechecks_without_replay(source, tmp_path, monkeypatch):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for engine integration")
    _, _, depth_path, trade_path, *_ = source
    report = tmp_path / "worker.json"
    original = flow.reference_samples
    def fail(_connection, _result):
        raise ValueError("late checking failure")
    monkeypatch.setattr(flow, "reference_samples", fail)
    with pytest.raises(ValueError, match="late checking failure"):
        flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", node, report)
    assert json.loads(report.read_text())["status"] == "UNRECONCILED"
    monkeypatch.setattr(flow, "reference_samples", original)
    pin = hashlib.sha256(report.read_bytes()).hexdigest()
    result = flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", "not-node", report, True, pin)
    assert result["independentFlowSamples"] == 1
    with pytest.raises(ValueError, match="does not match pinned"):
        flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.5", "not-node", report, True, pin)
    saved = json.loads(report.read_text())
    saved["oracle"]["samples"][0]["buyVolume"] = 0
    report.write_text(json.dumps(saved))
    with pytest.raises(ValueError, match="pin changed"):
        flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", "not-node", report, True, pin)
    with pytest.raises(ValueError, match="independent rolling flow disagrees"):
        flow.verify(tmp_path / "raw.dbn.zst", depth_path, trade_path, "0.25", "not-node", report, True,
                    hashlib.sha256(report.read_bytes()).hexdigest())
