from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import shutil
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import derive_historical_cme_core as core


def node():
    executable = shutil.which("node")
    if executable is None:
        pytest.skip("Node required for complete producer integration")
    return executable


def config(count=5):
    return {"derivationId": "a" * 64, "instrumentId": "ES", "fromNs": "1000000000", "toNs": "6000000000",
            "tickSize": "0.25", "expectedRows": count, "identity": {"method": "test"}}


def rows():
    result = []
    for index in range(5):
        item = {"event_ns": str((index + 1) * 1_000_000_000), "source_rank": "2", "stable_position": str(index),
                "ordinal": "0", "known_ns": str((index + 1) * 1_000_000_000 + 100), "instrument_id": "ES",
                "depth_action": "SNAPSHOT", "depth_model": "TOP_N", "depth_limit": 10, "continuity": "OK",
                "book_epoch": "1", "date": "2026-08-05", "observation_only": index in (2, 4), "matched_trade": None,
                "bids": [{"price": "99", "size": "10"}, {"price": "98.75", "size": "8"}],
                "asks": [{"price": "101", "size": "5"}, {"price": "101.25", "size": "7"}]}
        if index in (1, 2):
            item["asks"][0]["price"] = "99"
        if item["observation_only"]:
            item["matched_trade"] = {"event_ns": item["event_ns"], "side": "UNKNOWN" if index == 2 else "BUY",
                                      "price": "101", "size": "2", "record_id": str(index)}
        result.append(item)
    return result


def expected():
    return {"rows": 5, "trusted": 3, "segments": 2, "applied": 1,
            "observed": {"BUY": {"count": 1, "volume": 2}, "SELL": {"count": 0, "volume": 0}, "UNKNOWN": {"count": 1, "volume": 2}},
            "outsideTrust": {"BUY": {"count": 0, "volume": 0}, "SELL": {"count": 0, "volume": 0}, "UNKNOWN": {"count": 1, "volume": 2}}}


def test_combined_producer_crossed_book_restart_unknown_flow_and_terminal_pins(tmp_path):
    result = core.encode(iter(rows()), config(), tmp_path / "core", node(), expected_summary=expected())
    assert result["completion"]["trusted"] == 3
    assert result["families"]["events"]["rows"] > 0 and result["families"]["states"]["rows"] > 0
    directory = tmp_path / "core" / "events"
    events = core.lifecycle.read_events(directory, result["families"]["events"]["manifest_sha256"],
        from_ns="1000000000", as_of_ns="6000000000", as_of_key=["6000000000", "2", "99", "0"])
    opens = [row for row in events if row["event_type"] == "segment_open"]
    closes = [row for row in events if row["event_type"] == "segment_close"]
    assert len(opens) == len(closes) == 2 and opens[0]["segment_id"] != opens[1]["segment_id"]
    assert [row["payload"]["cause"] for row in closes] == ["CROSSED_BOOK", "EOF"]
    assert len([row for row in events if row["event_type"] == "engine_trade"]) == 1
    assert not any(row["event_type"] == "engine_verdict" for row in events)


def test_process_writers_preserve_every_logical_row_and_physical_family_pin(tmp_path):
    threaded = core.encode_threaded(iter(rows()), config(), tmp_path / "threads", node(), expected_summary=expected())
    processes = core.encode(iter(rows()), config(), tmp_path / "processes", node(), expected_summary=expected())
    assert threaded["families"] == processes["families"]
    assert threaded["completion"]["observed"] == processes["completion"]["observed"]


def test_terminal_family_failure_cannot_mark_combined_output_complete(tmp_path, monkeypatch):
    fake = tmp_path / "terminal_failure.py"
    fake.write_text("import sys,runpy\nif sys.argv[1]=='events':\n for line in sys.stdin.buffer: pass\n sys.exit(1)\n"
                    "else:\n sys.argv[0]=" + repr(str(core.FAMILY_WORKER)) + "\n runpy.run_path(sys.argv[0],run_name='__main__')\n")
    monkeypatch.setattr(core, "FAMILY_WORKER", fake)
    with pytest.raises((ValueError, BrokenPipeError)):
        core.encode(iter(rows()), config(), tmp_path / "terminal", node(), expected_summary=expected())
    assert not (tmp_path / "terminal" / "result.json").exists()


@pytest.mark.parametrize("fault", ["missing_source", "writer_failure", "wrong_summary", "bad_trade_echo", "output_budget"])
def test_failure_cannot_complete_combined_output_or_hang(tmp_path, monkeypatch, fault):
    source, summary = rows(), expected()
    if fault == "missing_source":
        source.pop()
    elif fault == "wrong_summary":
        summary["applied"] = 99
    elif fault == "writer_failure":
        monkeypatch.setattr(core.lifecycle, "MAX_ROWS", 1)
    elif fault == "output_budget":
        monkeypatch.setattr(core, "MAX_OUTPUT_BYTES", 1)
    else:
        source[-1]["observation_only"] = False
    with pytest.raises((ValueError, BrokenPipeError)):
        core.encode(iter(source), config(), tmp_path / fault, node(), expected_summary=summary)
    assert not (tmp_path / fault / "result.json").exists()
    assert not (tmp_path / fault / "events" / "manifest.json").exists()
    assert not (tmp_path / fault / "states" / "manifest.json").exists()


def test_disk_admission_refuses_before_worker_launch(tmp_path, monkeypatch):
    monkeypatch.setattr(core.shutil, "disk_usage", lambda _path: SimpleNamespace(free=core.MIN_FREE_DISK - 1))
    with pytest.raises(ValueError, match="free disk"):
        core.encode(iter(rows()), config(), tmp_path / "disk", node(), expected_summary=expected())
    assert not (tmp_path / "disk" / "worker.log").exists()


@pytest.mark.parametrize("rank", ["2", "3"])
def test_equity_updates_are_not_trade_echoes_and_unknown_half_cent_volume_is_preserved(tmp_path, rank):
    source = rows()
    setup = config()
    setup.update(tickSize="0.01", tradePolicy="equity-trade-observation", sourceRank=rank)
    for row in source:
        row["observation_only"] = False
        row["source_rank"] = rank
    source[2]["observation_only"] = True
    source[2]["matched_trade"]["price"] = "101.005000000000"
    source[4]["asks"][0]["size"] = "3"
    result = core.encode(iter(source), setup, tmp_path / "equity", node(), expected_summary=expected())
    folder = tmp_path / "equity" / "events"
    events = core.lifecycle.read_events(folder, result["families"]["events"]["manifest_sha256"],
        from_ns="1000000000", as_of_ns="6000000000", as_of_key=["6000000000", rank, "99", "0"])
    assert all(row["known_key"][1] == rank for row in events)
    assert any(row["event_type"] == "level_size" and row["payload"]["previous_size"] == 5
               and row["payload"]["size"] == 3 for row in events)
    assert result["completion"]["outsideTrust"]["UNKNOWN"]["volume"] == 2


def records():
    slots = [SimpleNamespace(bid_px=99_000_000_000, ask_px=101_000_000_000, bid_sz=10, ask_sz=5)]
    return [SimpleNamespace(ts_event=1_000_000_000, ts_recv=1_000_000_100, action="M", flags=0, levels=deepcopy(slots), size=1, price=99_000_000_000, side="B"),
            SimpleNamespace(ts_event=1_000_000_000, ts_recv=1_000_000_090, action="T", flags=0, levels=deepcopy(slots), size=2, price=101_000_000_000, side="B")]


def test_equity_repeated_trade_books_do_not_manufacture_hidden_fills(tmp_path):
    initial = rows()[0]
    source = []
    for i in range(4):
        row = deepcopy(initial)
        row.update(event_ns=str((i+1)*1000000000), known_ns=str((i+1)*1000000000+100), stable_position=str(i))
        if i in (1,2):
            row["observation_only"] = True
            row["matched_trade"] = {"event_ns": row["event_ns"], "side": "BUY", "price": "101", "size": str(i+1), "record_id": str(i)}
        elif i==3:
            row["asks"].pop(0)
        source.append(row)
    setup = config(4)
    setup.update(tickSize="0.01",tradePolicy="equity-trade-observation",sourceRank="2")
    expected_summary = {"rows":4,"trusted":4,"segments":1,"applied":2,
        "observed":{"BUY":{"count":2,"volume":5},"SELL":{"count":0,"volume":0},"UNKNOWN":{"count":0,"volume":0}},
        "outsideTrust":{"BUY":{"count":0,"volume":0},"SELL":{"count":0,"volume":0},"UNKNOWN":{"count":0,"volume":0}}}
    result = core.encode(iter(source), setup, tmp_path/"equity-fill", node(), expected_summary=expected_summary)
    events = core.lifecycle.read_events(tmp_path/"equity-fill/events", result["families"]["events"]["manifest_sha256"],
        from_ns="1000000000",as_of_ns="6000000000",as_of_key=["6000000000","2","99","0"])
    final = [r["payload"]["state"] for r in events if r["event_type"]=="engine_level_state" and r["side"]=="ask" and r["price_key"]==10100][-1]
    assert final["tradedVisible"]==5 and final["hiddenTraded"]==0 and final["cancelled"]==0
    assert any(r["event_type"]=="engine_verdict" and r["payload"]["endedBy"]=="filled" and r["payload"]["explained"]==5 for r in events)


def test_native_order_and_receive_high_water_retained_with_exact_decimals():
    output = list(core.normalized(records(), instrument="ES", start=1_000_000_000, end=2_000_000_000,
                                  expected=2, raw_hash="b" * 64))
    assert [row["stable_position"] for row in output] == ["0", "1"]
    assert output[1]["known_ns"] == "1000000100"
    assert output[1]["matched_trade"]["price"] == "101.000000000"
    assert output[1]["observation_only"]


def test_synthetic_preceding_snapshot_clock_is_not_emitted_or_carried_as_wall_history():
    source = records()
    seed = deepcopy(source[0])
    seed.ts_event = 999_999_999
    seed.ts_recv = 1_000_000_000
    seed.action = "A"
    seed.flags = 128 | 32 | 8
    output = list(core.normalized([seed, *source], instrument="ES", start=1_000_000_000, end=2_000_000_000,
                                  expected=2, raw_hash="b" * 64))
    assert len(output) == 2
    assert output[0]["stable_position"] == "1"
    assert output[0]["known_ns"] == "1000000100"


@pytest.mark.parametrize("fault", ["changed_echo", "extra_row", "short_source", "unknown_action", "trailing_outside",
                                  "bad_first_book", "bad_later_book", "bad_receive_clock"])
def test_native_source_refuses_incomplete_or_unsupported_input(fault):
    source = records()
    expected_count = 2
    if fault == "changed_echo":
        source[1].levels[0].bid_sz = 12
    elif fault == "extra_row":
        expected_count = 1
    elif fault == "short_source":
        expected_count = 3
    elif fault == "unknown_action":
        source[1].action = "F"
    elif fault in ("bad_first_book", "bad_later_book", "bad_receive_clock"):
        source[1 if fault == "bad_later_book" else 0].flags = 8 if fault == "bad_receive_clock" else 4
    else:
        source[1].ts_event = 3_000_000_000
    with pytest.raises(ValueError):
        list(core.normalized(source, instrument="ES", start=1_000_000_000, end=2_000_000_000,
                             expected=expected_count, raw_hash="b" * 64))
