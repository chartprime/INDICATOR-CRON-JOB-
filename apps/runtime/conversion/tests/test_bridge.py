"""Bridge <-> Node contract-worker integration. Needs `node` on PATH."""
from __future__ import annotations

import json
import os
import textwrap

import pytest

import convert
from bridge import MAX_FRAME_BYTES, BridgeError, ContractBridge

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.normpath(os.path.join(HERE, "..", "..", "scripts", "convert", "contract-worker.js"))

T = "1788807187569123456"
AAPL = {"venue": "XNAS", "market": "EQUITY", "symbol": "AAPL", "currency": "USD", "sizeUnit": "SHARE", "contract": None}
TSLA = {**AAPL, "symbol": "TSLA"}


def _context(instrument=AAPL, source_symbol="38", schema="mbp-1"):
    return {
        "mappings": [{
            "provider": "DATABENTO", "dataset": "XNAS.ITCH", "sourceSymbol": source_symbol,
            "fromNs": "0", "toNs": "18446744073709551614", "instrument": instrument,
            "mappingVersion": "fixture/1", "reference": "fixture://identity",
        }],
        "dataset": "XNAS.ITCH", "sourceSymbol": source_symbol, "population": f"XNAS.ITCH:{schema}",
        "datasetVersion": "v1", "streamId": "stream/1", "schema": schema, "ingestNs": T,
        "lineage": {"object": "s3://raw/x.dbn.zst", "sha256": "a" * 64},
    }


MBP_ROW = {
    "instrument_id": "38", "publisher_id": "1", "ts_event": T, "ts_recv": "1788807187569123500",
    "sequence": "42", "action": "T", "side": "B", "price": "195123456789", "size": "10", "flags": "0",
    "bid_px_00": "195120000000", "bid_sz_00": "5", "ask_px_00": "195130000000", "ask_sz_00": "7",
}


def test_round_trips_a_batch_and_reuses_one_worker():
    with ContractBridge(WORKER) as bridge:
        first = bridge.map_batch("b1", "DATABENTO", "mbp", [{"row": MBP_ROW, "position": 0}], _context())
        assert first[0]["ok"] is True
        assert [r["family"] for r in first[0]["records"]] == ["trade", "quote"]

        second = bridge.map_batch("b2", "DATABENTO", "mbp",
                                  [{"row": MBP_ROW, "position": 0}, {"row": MBP_ROW, "position": 5}], _context())
        assert len(second) == 2
        assert second[1]["records"][0]["lineage"]["row"] == "5"

        tsla = bridge.map_batch("b3", "DATABENTO", "mbp", [{"row": {**MBP_ROW}, "position": 0}], _context(TSLA))
        assert tsla[0]["records"][0]["instrument"]["symbol"] == "TSLA"
    assert bridge.returncode == 0


def test_bad_row_is_quarantined_not_dropped():
    with ContractBridge(WORKER) as bridge:
        out = bridge.map_batch("b1", "DATABENTO", "mbp", [
            {"row": MBP_ROW, "position": 0},
            {"row": {**MBP_ROW, "action": "Z"}, "position": 1},
        ], _context())
    assert out[0]["ok"] is True
    assert out[1]["ok"] is False
    assert out[1]["quarantine"]["reason"] == "UNSUPPORTED_MBP_ACTION"


def test_job_level_worker_failure_raises():
    with ContractBridge(WORKER) as bridge:
        bad = _context()
        bad["mappings"] = "not-a-list"
        with pytest.raises(BridgeError, match="worker fatal"):
            bridge.map_batch("b1", "DATABENTO", "mbp", [{"row": MBP_ROW, "position": 0}], bad)


def test_request_frame_over_the_cap_is_refused_before_send(monkeypatch):
    monkeypatch.setattr("bridge.MAX_FRAME_BYTES", 64)
    with ContractBridge(WORKER) as bridge:
        with pytest.raises(BridgeError, match="reduce the batch size"):
            bridge.map_batch("b1", "DATABENTO", "mbp", [{"row": MBP_ROW, "position": 0}], _context())


def test_missed_deadline_kills_the_worker(tmp_path, monkeypatch):
    hang = tmp_path / "hang.js"
    hang.write_text(textwrap.dedent("""
        process.stdin.resume();
        setInterval(() => {}, 1000);
    """))
    monkeypatch.setattr("bridge.RESPONSE_DEADLINE_S", 1.0)
    bridge = ContractBridge(str(hang))
    bridge.start()
    try:
        with pytest.raises(BridgeError, match="did not respond within"):
            bridge.map_batch("b1", "DATABENTO", "mbp", [{"row": MBP_ROW, "position": 0}], _context())
    finally:
        bridge.close()
    assert bridge.returncode is not None


def test_close_stops_the_worker():
    bridge = ContractBridge(WORKER)
    bridge.start()
    bridge.close()
    assert bridge.returncode is not None
    assert MAX_FRAME_BYTES == 16 * 1024 * 1024


def test_deadline_also_bounds_blocked_stdin(tmp_path, monkeypatch):
    hang = tmp_path / "no-read.js"
    hang.write_text("setInterval(() => {}, 1000);")
    monkeypatch.setattr("bridge.RESPONSE_DEADLINE_S", 0.5)
    with ContractBridge(str(hang)) as bridge:
        with pytest.raises(BridgeError, match="blocked stdin"):
            bridge.map_batch("b", "DATABENTO", "mbp", [{"row": {"large": "x" * 1000000}}], {})
        assert bridge.returncode is not None


def test_early_worker_exit_is_reported_without_waiting_for_deadline(tmp_path):
    worker = tmp_path / "exit.js"
    worker.write_text("process.exit(0);")
    with ContractBridge(str(worker)) as bridge:
        with pytest.raises(BridgeError, match="closed stdout|stdin unavailable"):
            bridge.map_batch("b", "DATABENTO", "mbp", [], {})


def _mbp10_row():
    row = {
        "instrument_id": "38", "publisher_id": "1", "ts_event": T, "ts_recv": "1788807187569123500",
        "sequence": "42", "action": "T", "side": "B", "price": "195123456789", "size": "10", "flags": "0",
    }
    for i in range(10):
        suffix = f"{i:02d}"
        row[f"bid_px_{suffix}"] = "195120000000"
        row[f"bid_sz_{suffix}"] = "5"
        row[f"ask_px_{suffix}"] = "195130000000"
        row[f"ask_sz_{suffix}"] = "7"
    return row


def test_a_full_width_batch_at_the_real_batch_rows_size_round_trips(monkeypatch):
    monkeypatch.delenv("TT_CONVERT_BATCH_ROWS", raising=False)
    size = convert._batch_rows()
    rows = [{"row": _mbp10_row(), "position": i} for i in range(size)]
    context = _context(schema="mbp-10")
    payload = json.dumps(
        {"batchId": "b1", "provider": "DATABENTO", "family": "depth", "rows": rows, "context": context},
        separators=(",", ":"),
    ).encode("utf-8")
    assert len(payload) < MAX_FRAME_BYTES, (
        f"a full-width mbp-10 batch at BATCH_ROWS={size} is {len(payload)} bytes -- exceeds the wire frame limit"
    )
    with ContractBridge(WORKER) as bridge:
        results = bridge.map_batch("b1", "DATABENTO", "depth", rows, context)
    assert len(results) == size
    assert all(r["ok"] for r in results)
