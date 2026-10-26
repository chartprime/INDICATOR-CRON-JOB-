from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import historical_l2_events as events


def event(seq, kind, known, position, observed=None):
    segment = "b" * 64
    payload = {"seq": seq, "type": kind, "ts": (observed if observed is not None else known) // 1_000_000,
               "side": "ask", "key": 101}
    if kind == "verdict":
        payload["endedBy"] = "pulled"
    identity = hashlib.sha256(json.dumps([events.SCHEMA, segment, seq], separators=(",", ":")).encode()).hexdigest()
    return {"schema": events.SCHEMA, "derivation_id": "a" * 64, "instrument_id": "ES", "segment_id": segment,
            "event_id": identity, "event_seq": seq, "event_type": kind, "observed_engine_ms": payload["ts"],
            "known_ns": str(known), "known_key": [str(known), "2", str(position), "0"],
            "side": "ask", "price_key": 101, "evidence_quality": "observed_depth_inference", "payload": json.dumps(payload)}


def read(directory, pin, upper, position="99"):
    return events.read_events(directory, pin, from_ns="0", as_of_ns=str(upper),
                              as_of_key=[str(upper), "2", position, "0"])


def test_parquet_roundtrip_filters_knowledge_time_and_exact_ties(tmp_path):
    rows = [event(0, "emptied", 1_200_000_000, 1), event(1, "trade", 1_200_000_000, 2),
            event(2, "verdict", 2_800_000_000, 3, observed=1_200_000_000)]
    directory = tmp_path / "events"
    manifest = events.write_part(rows, directory)
    pin = events.digest(directory / "manifest.json")
    assert manifest["part"]["rows"] == 3
    assert read(directory, pin, 1_200_000_000, "1") == rows[:1]
    assert read(directory, pin, 2_000_000_000) == rows[:2]
    assert read(directory, pin, 2_800_000_000) == rows
    again = tmp_path / "again"
    events.write_part(deepcopy(rows), again)
    assert read(again, events.digest(again / "manifest.json"), 2_800_000_000) == rows


@pytest.mark.parametrize("change", [
    lambda r: r.update(event_seq=2),
    lambda r: r.update(known_ns="1"),
    lambda r: r.update(event_id="c" * 64),
    lambda r: r.update(payload='{"seq":0,"type":"trade","ts":NaN}'),
    lambda r: r.update(known_key=[1.2, "2", "1", "0"]),
])
def test_invalid_events_never_receive_manifest(tmp_path, change):
    row = event(0, "emptied", 1_200_000_000, 1)
    change(row)
    with pytest.raises(ValueError):
        events.write_part([row], tmp_path / "bad")
    assert not (tmp_path / "bad" / "manifest.json").exists()


def test_tampered_parts_pins_cancellation_and_budgets(tmp_path, monkeypatch):
    directory = tmp_path / "events"
    events.write_part([event(0, "emptied", 1_200_000_000, 1)], directory)
    pin = events.digest(directory / "manifest.json")
    with pytest.raises(ValueError, match="pin changed"):
        read(directory, "0" * 64, 2_000_000_000)
    with pytest.raises(InterruptedError):
        events.read_events(directory, pin, from_ns="0", as_of_ns="2000000000",
                           as_of_key=["2000000000", "2", "1", "0"], cancelled=lambda: True)
    monkeypatch.setattr(events, "MAX_READ_ROWS", 0)
    with pytest.raises(ValueError, match="output admission"):
        read(directory, pin, 2_000_000_000)
    monkeypatch.setattr(events, "MAX_READ_ROWS", 20_000)
    with (directory / "part.parquet").open("ab") as sink:
        sink.write(b"changed")
    with pytest.raises(ValueError, match="integrity"):
        read(directory, pin, 2_000_000_000)


def test_row_overflow_keeps_partition_unpublished(tmp_path, monkeypatch):
    monkeypatch.setattr(events, "MAX_ROWS", 1)
    with pytest.raises(ValueError, match="row, decoded byte"):
        events.write_part([event(0, "emptied", 1000000000, 0), event(1, "verdict", 2000000000, 1)], tmp_path / "oversize")
    assert not (tmp_path / "oversize" / "manifest.json").exists()


def test_response_budget_includes_array_framing_and_empty_response(tmp_path, monkeypatch):
    directory = tmp_path / "framing"
    rows = [event(0, "emptied", 1000000000, 0), event(1, "verdict", 2000000000, 1)]
    events.write_part(rows, directory)
    pin = events.digest(directory / "manifest.json")
    size = len(json.dumps(rows, separators=(",", ":")).encode())
    monkeypatch.setattr(events, "MAX_READ_BYTES", size)
    assert read(directory, pin, 2000000000) == rows
    monkeypatch.setattr(events, "MAX_READ_BYTES", size - 1)
    with pytest.raises(ValueError, match="output admission"):
        read(directory, pin, 2000000000)
    monkeypatch.setattr(events, "MAX_READ_BYTES", 2)
    assert read(directory, pin, 0) == []
    monkeypatch.setattr(events, "MAX_READ_BYTES", 1)
    with pytest.raises(ValueError, match="output admission"):
        read(directory, pin, 0)


@pytest.mark.parametrize("fault", ["late_cancel", "manifest_change", "part_change"])
def test_read_rechecks_cancellation_and_integrity_before_return(tmp_path, monkeypatch, fault):
    directory = tmp_path / "changing"
    events.write_part([event(0, "emptied", 1000000000, 0)], directory)
    pin = events.digest(directory / "manifest.json")
    late = {"cancelled": False}
    original = events.validate
    def validate(row):
        original(row)
        if fault == "late_cancel":
            late["cancelled"] = True
        else:
            file = directory / ("manifest.json" if fault == "manifest_change" else "part.parquet")
            with file.open("ab") as sink:
                sink.write(b" ")
    monkeypatch.setattr(events, "validate", validate)
    error = InterruptedError if fault == "late_cancel" else ValueError
    with pytest.raises(error):
        events.read_events(directory, pin, from_ns="0", as_of_ns="2000000000",
                           as_of_key=["2000000000", "2", "99", "0"], cancelled=lambda: late["cancelled"])


def test_segment_switch_at_one_trigger_preserves_append_order(tmp_path):
    rows = [event(0, "emptied", 1000000000, 1), event(1, "verdict", 2000000000, 2),
            event(0, "appeared", 2000000000, 2)]
    rows[-1]["segment_id"] = "c" * 64
    rows[-1]["event_id"] = hashlib.sha256(json.dumps([events.SCHEMA, "c" * 64, 0], separators=(",", ":")).encode()).hexdigest()
    directory = tmp_path / "segments"
    events.write_part(rows, directory)
    assert read(directory, events.digest(directory / "manifest.json"), 2000000000) == rows


def test_real_engine_to_parquet_does_not_reveal_later_prune_verdict(tmp_path):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for engine/Parquet integration")
    runtime = Path(__file__).parents[2]
    script = """
      const {createMemoryEngine} = require('./src/indicators/l2-memory/memory-engine');
      const {createHistoricalEventTap} = require('./src/indicators/l2-memory/historical-event-tap');
      const engine = createMemoryEngine({tickSize:1});
      const tap = createHistoricalEventTap({derivationId:'a'.repeat(64),instrumentId:'ES',seedKey:['1000000000','2','0','0']});
      const coverage = {bid:[100,100],ask:[101,102]};
      const book = {bids:[[100,10]],asks:[[101,10],[102,10]]};
      const rows = [];
      function drain(ns,key) {rows.push(...tap.drain(engine,{knownNs:ns,knownKey:key,coverage}));}
      engine.apply({kind:'book',ts:1000,status:'READY',book});
      drain('1000000000',['1000000000','2','0','0']);
      engine.apply({kind:'book',ts:1200,status:'READY',book:{bids:book.bids,asks:[[102,10]]},delta:{bids:[],asks:[[101,0]]}});
      drain('1200000000',['1200000000','2','1','0']);
      engine.prune(2800);
      drain('2800000000',['1200000000','2','1','0']);
      console.log(JSON.stringify(rows));
    """
    rows = json.loads(subprocess.check_output([node, "-e", script], cwd=runtime, timeout=15))
    directory = tmp_path / "real-engine"
    events.write_part(rows, directory)
    pin = events.digest(directory / "manifest.json")
    early = read(directory, pin, 2_000_000_000)
    assert any(row["event_type"] == "emptied" for row in early)
    assert not any(row["event_type"] == "verdict" for row in early)
    later = read(directory, pin, 2_800_000_000)
    assert json.loads(later[-1]["payload"])["endedBy"] == "pulled"
    assert later[-1]["known_key"] == ["1200000000", "2", "1", "0"]


@pytest.mark.parametrize("instrument", ["ES", "NQ"])
def test_pinned_native_examples_roundtrip_through_actual_event_producer(tmp_path, instrument):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for native event integration")
    runtime = Path(__file__).parents[2]
    encoded = subprocess.check_output([node, "scripts/verify/databento/verify-historical-event-pilot.js", instrument],
                                      cwd=runtime, stderr=subprocess.DEVNULL, timeout=15)
    rows = [json.loads(line) for line in encoded.splitlines()]
    directory = tmp_path / instrument
    events.write_part(rows, directory)
    first = int(rows[0]["known_ns"])
    last = rows[-1]
    selected = events.read_events(directory, events.digest(directory / "manifest.json"), from_ns=str(first),
                                 as_of_ns=last["known_ns"], as_of_key=last["known_key"])
    assert selected == rows
    assert any(row["event_type"] == "trade" for row in selected)
    if instrument == "NQ":
        assert any(row["event_type"] == "trade" and row["evidence_quality"] == "resting_unknown" for row in selected)
