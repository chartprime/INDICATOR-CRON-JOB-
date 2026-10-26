from __future__ import annotations

from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import historical_l2_lifecycles as lifecycles
import historical_l2_seconds as seconds


RUNTIME = Path(__file__).parents[2]


def node():
    executable = shutil.which("node")
    if executable is None:
        pytest.skip("Node required for cross-language lifecycle proof")
    return executable


def native(instrument):
    run = subprocess.run([node(), "scripts/verify/databento/verify-historical-lifecycle-pilot.js", instrument],
                         cwd=RUNTIME, check=True, capture_output=True, text=True)
    rows = [json.loads(line) for line in run.stdout.splitlines()]
    return json.loads(run.stderr), [item["row"] for item in rows if item["family"] == "l2_level_event"], [item["row"] for item in rows if item["family"] != "l2_level_event"]


def delayed(*, instrument="ES", derivation="a" * 64, start_ns=0):
    source = """
const { createMemoryEngine } = require('./src/indicators/l2-memory/memory-engine');
const { createHistoricalTopNFrames } = require('./src/indicators/l2-memory/historical-topn-frames');
const { createHistoricalLevelEvents } = require('./src/indicators/l2-memory/historical-level-events');
const engine=createMemoryEngine({tickSize:1,snapshotDepth:2});
const source=createHistoricalTopNFrames({depthLimit:2});
const observer=createHistoricalLevelEvents({derivationId:'a'.repeat(64),instrumentId:'ES',seedKey:['1000000000','2','0','0'],tickSize:'1',depthLimit:2});
const bids=[{price:'99',size:'10'},{price:'98',size:'8'}];
const rows=[];
function apply(ms,pos,asks) {
 const key=[String(ms*1e6),'2',String(pos),'0'];
 const transition=source.push({event_ns:key[0],source_rank:'2',stable_position:key[2],ordinal:'0',instrument_id:'ES',depth_action:'SNAPSHOT',depth_model:'TOP_N',depth_limit:2,continuity:'OK',book_epoch:'1',date:'2026-08-05',bids,asks});
 const frame=transition.frames.find(f=>f.kind==='book');
 engine.apply(frame);
 rows.push(...observer.capture(engine,{sourceKey:key,knownNs:key[0],bookFrame:frame}));
}
apply(1000,0,[{price:'101',size:'5'},{price:'102',size:'7'}]);
apply(1200,1,[{price:'102',size:'7'},{price:'103',size:'6'}]);
engine.prune(2800);
rows.push(...observer.capture(engine,{sourceKey:['1200000000','2','1','0'],knownNs:'2800000000',pruned:true}));
apply(2900,2,[{price:'101',size:'5'},{price:'102',size:'7'}]);
rows.push(...observer.close(engine,{sourceKey:['2900000000','2','2','0'],knownNs:'2900000000',cause:'EOF'}));
process.stdout.write(JSON.stringify(rows));
"""
    source = source.replace("instrumentId:'ES'", "instrumentId:" + json.dumps(instrument))
    source = source.replace("instrument_id:'ES'", "instrument_id:" + json.dumps(instrument))
    source = source.replace("derivationId:'a'.repeat(64)", "derivationId:" + json.dumps(derivation))
    source = source.replace("const key=[String(ms*1e6)", f"ms += {start_ns // 1_000_000}; const key=[String(ms*1e6)")
    source = source.replace("engine.prune(2800)", f"engine.prune({start_ns // 1_000_000 + 2800})")
    for value in (1_000_000_000, 1_200_000_000, 2_800_000_000, 2_900_000_000):
        source = source.replace("'" + str(value) + "'", "'" + str(start_ns + value) + "'")
    return json.loads(subprocess.run([node(), "-e", source], cwd=RUNTIME, check=True, capture_output=True, text=True).stdout)


def read(directory, pin, at=3_000_000_000, key=None):
    return lifecycles.read_events(directory, pin, from_ns="0", as_of_ns=str(at), as_of_key=key or [str(at), "2", "99", "0"])


def test_multipart_delayed_verdict_and_refill_genealogy(tmp_path):
    rows = delayed()
    directory = tmp_path / "events"
    manifest = lifecycles.write_parts(rows, directory, part_rows=7)
    pin = lifecycles.digest(directory / "manifest.json")
    assert len(manifest["parts"]) > 3
    assert read(directory, pin) == rows
    assert not any(row["event_type"] == "engine_verdict" for row in read(directory, pin, 2_799_999_999))
    now = read(directory, pin, 2_800_000_000)
    verdict = next(row for row in now if row["event_type"] == "engine_verdict")
    start = next(row for row in rows if row["event_type"] == "lifecycle_start" and row["price_key"] == 101)
    assert verdict["lifecycle_id"] == start["lifecycle_id"]
    assert verdict["payload"]["endedBy"] == "pulled"
    refill = [row for row in rows if row["event_type"] == "lifecycle_start" and row["price_key"] == 101][-1]
    assert refill["lifecycle_id"] != start["lifecycle_id"] and refill["observation_id"] == start["observation_id"]
    assert refill["payload"]["previous_lifecycle_id"] == start["lifecycle_id"]
    before_refill = read(directory, pin, 2_900_000_000, ["2900000000", "2", "1", "0"])
    assert not any(row["lifecycle_id"] == refill["lifecycle_id"] for row in before_refill)


@pytest.mark.parametrize("instrument", ["ES", "NQ"])
def test_integrated_native_events_and_seconds_agree_with_independent_source(tmp_path, instrument):
    metadata, events, states = native(instrument)
    events_path, states_path = tmp_path / "events", tmp_path / "states"
    lifecycles.write_parts(events, events_path, part_rows=17)
    seconds.write_parts(states, states_path, part_rows=17)
    received = lifecycles.read_events(events_path, lifecycles.digest(events_path / "manifest.json"),
                                     from_ns=metadata["fromNs"], as_of_ns=metadata["toNs"], as_of_key=[metadata["toNs"], "2", "99999999", "0"])
    assert received == events
    assert seconds.read_seconds(states_path, seconds.digest(states_path / "manifest.json"),
                                from_ns=metadata["fromNs"], as_of_ns=metadata["toNs"], as_of_key=[metadata["toNs"], "2", "99999999", "0"]) == states
    fixture = next(case for case in json.loads((RUNTIME / "test/fixtures/golden/historical-cme-source-witnesses.json").read_text())["cases"] if case["instrument"] == instrument)
    trade_volume = sum(record["size"] for record in fixture["rows"] if record["action"] == "T")
    assert sum(row["payload"]["size"] for row in events if row["event_type"] == "engine_trade") == trade_volume
    assert sum(row["payload"]["flow"]["BUY"] for row in states if row["payload"].get("row_kind") == "coverage") == trade_volume
    final = {"bid": {}, "ask": {}}
    for row in events:
        if row["event_type"] == "level_size":
            final[row["side"]][row["price_key"]] = row["payload"]["size"]
        elif row["event_type"] == "observation_end" and row["payload"]["cause"] == "DEPTH_EXIT":
            final[row["side"]].pop(row["price_key"], None)
    for side in ("bid", "ask"):
        expected = {int(Decimal(level[side + "_px"]) / Decimal(1_000_000_000) / Decimal("0.25")): level[side + "_sz"] for level in fixture["rows"][-1]["levels"]}
        assert {key: value for key, value in final[side].items() if value} == expected
    segment = next(row["segment_id"] for row in events)
    assert {row["payload"]["segment_id"] for row in states if row["payload"].get("trusted")} == {segment}
    assert events[-1]["event_type"] == "segment_close"
    assert all(row["lifecycle_id"] is None and row["record_evidence_gap"] for row in events if row["event_type"] == "engine_trade" and row["evidence_quality"] == "resting_unknown")
    before = {"bid": {}, "ask": {}}
    expected_changes = []
    for index, record in enumerate(fixture["rows"]):
        for side in ("bid", "ask"):
            current = {int(Decimal(level[side + "_px"]) / Decimal(1_000_000_000) / Decimal("0.25")): level[side + "_sz"] for level in record["levels"]}
            old = before[side]
            new_edge = min(current) if side == "bid" else max(current)
            old_edge = (min(old) if side == "bid" else max(old)) if old else None
            for at in old.keys() | current.keys():
                previous_size, size = old.get(at), current.get(at)
                if previous_size == size:
                    continue
                worsens_new = at < new_edge if side == "bid" else at > new_edge
                if size is None and len(current) == 10 and worsens_new:
                    continue
                worsens_old = old_edge is not None and (at < old_edge if side == "bid" else at > old_edge)
                unknown_before = index == 0 or previous_size is None and len(old) == 10 and worsens_old
                expected_changes.append((int(record["native_index"]), side, at, None if unknown_before else previous_size or 0, size or 0))
            before[side] = current
    actual_changes = [(int(row["known_key"][2]), row["side"], row["price_key"], row["payload"]["previous_size"], row["payload"]["size"])
                      for row in events if row["event_type"] == "level_size"]
    assert sorted(actual_changes) == sorted(expected_changes)


@pytest.mark.parametrize("change", [
    lambda rows: rows.pop(),
    lambda rows: rows[2].update(event_seq=99),
    lambda rows: rows[2].update(observation_id="f" * 64),
    lambda rows: next(row for row in rows if row["event_type"] == "engine_verdict").update(lifecycle_id="f" * 64),
    lambda rows: next(row for row in rows if row["event_type"] == "engine_verdict").update(known_ns="1200000000"),
    lambda rows: next(row["payload"] for row in rows if row["event_type"] == "level_size" and row["source_ns"] == "1200000000").update(previous_size=99),
    lambda rows: next(row["payload"] for row in rows if row["event_type"] == "lifecycle_start").update(first_key=["0", "2", "0", "0"]),
    lambda rows: rows[-1].update(known_key=["1000000000", "2", "0", "0"], source_ns="1000000000"),
    lambda rows: rows[-1]["payload"].update(unresolved_endings=99),
    lambda rows: rows[0]["payload"].update(tick_size="0"),
    lambda rows: next(row["payload"] for row in rows if row["event_type"] == "level_size").update(source_price="999"),
    lambda rows: next(row["payload"] for row in rows if row["event_type"] == "quote").update(bid=999),
])
def test_bad_genealogy_missing_output_or_future_evidence_cannot_seal(tmp_path, change):
    rows = delayed()
    change(rows)
    with pytest.raises(ValueError):
        lifecycles.write_parts(rows, tmp_path / "bad", part_rows=17)
    assert not (tmp_path / "bad" / "manifest.json").exists()


def test_cancel_corruption_and_budget_refusals_return_no_partial_results(tmp_path, monkeypatch):
    directory = tmp_path / "events"
    lifecycles.write_parts(delayed(), directory, part_rows=17)
    pin = lifecycles.digest(directory / "manifest.json")
    with pytest.raises(ValueError, match="pin changed"):
        read(directory, "0" * 64)
    with pytest.raises(InterruptedError):
        lifecycles.read_events(directory, pin, from_ns="0", as_of_ns="3000000000", as_of_key=["3000000000", "2", "99", "0"], cancelled=lambda: True)
    monkeypatch.setattr(lifecycles, "MAX_READ_ROWS", 1)
    with pytest.raises(ValueError, match="output admission"):
        read(directory, pin)
    monkeypatch.setattr(lifecycles, "MAX_READ_ROWS", 20_000)
    monkeypatch.setattr(lifecycles, "MAX_SCAN_BYTES", 1)
    with pytest.raises(ValueError, match="scan byte admission"):
        read(directory, pin)
    monkeypatch.setattr(lifecycles, "MAX_SCAN_BYTES", 64 * 1024 * 1024)
    with (directory / "part-0000.parquet").open("ab") as sink:
        sink.write(b"bad")
    with pytest.raises(ValueError, match="integrity"):
        read(directory, pin)


def test_partial_writer_failure_keeps_manifest_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(lifecycles, "MAX_ROWS", 17)
    with pytest.raises(ValueError, match="row or decoded"):
        lifecycles.write_parts(delayed(), tmp_path / "oversize", part_rows=17)
    with pytest.raises(InterruptedError):
        lifecycles.write_parts(delayed(), tmp_path / "cancelled", cancelled=lambda: True)
    assert not (tmp_path / "oversize" / "manifest.json").exists()
    assert not (tmp_path / "cancelled" / "manifest.json").exists()


def test_changing_part_boundaries_preserves_logical_events(tmp_path):
    rows = delayed()
    for index, count in enumerate((17, 23)):
        directory = tmp_path / str(index)
        lifecycles.write_parts(deepcopy(rows), directory, part_rows=count)
        assert read(directory, lifecycles.digest(directory / "manifest.json")) == rows


def test_response_budget_includes_json_array_framing(tmp_path, monkeypatch):
    directory = tmp_path / "events"
    lifecycles.write_parts(delayed(), directory, part_rows=17)
    pin = lifecycles.digest(directory / "manifest.json")
    expected = read(directory, pin)
    size = len(json.dumps(expected, separators=(",", ":")).encode())
    monkeypatch.setattr(lifecycles, "MAX_READ_BYTES", size)
    assert read(directory, pin) == expected
    monkeypatch.setattr(lifecycles, "MAX_READ_BYTES", size - 1)
    with pytest.raises(ValueError, match="output admission"):
        read(directory, pin)
    empty = dict(from_ns="999000000000", as_of_ns="999000000000", as_of_key=["999000000000", "0", "0", "0"])
    monkeypatch.setattr(lifecycles, "MAX_READ_BYTES", 2)
    assert lifecycles.read_events(directory, pin, **empty) == []
    monkeypatch.setattr(lifecycles, "MAX_READ_BYTES", 1)
    with pytest.raises(ValueError, match="output admission"):
        lifecycles.read_events(directory, pin, **empty)
