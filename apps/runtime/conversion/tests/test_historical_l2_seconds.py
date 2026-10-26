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
import historical_l2_seconds as seconds


RUNTIME = Path(__file__).parents[2]


def sampled():
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for cross-language sampler/storage proof")
    source = """
const {createHistoricalSecondSampler} = require('./src/indicators/l2-memory/historical-second-sampler');
const sampler = createHistoricalSecondSampler({derivationId:'a'.repeat(64),instrumentId:'ES',tickSize:'1',fromNs:'0',toNs:'4000000000'});
const book = {bids:[{price:'99',size:'10'}],asks:[{price:'101',size:'5'}]};
const rows=[];
function observe(ns,pos,changes={}) { rows.push(...sampler.observe({sourceKey:[String(ns),'2',String(pos),'0'],knownNs:String(ns),segmentId:'b'.repeat(64),...book,...changes})); }
observe(0,0);
observe(500000000,1,{trade:{event_ns:'500000000',side:'BUY',price:'105',size:'3'}});
observe(1000000000,2,{trade:{event_ns:'1000000000',side:'UNKNOWN',price:'101',size:'4'}});
observe(1500000000,3,{segmentId:null,unavailableReason:'CROSSED_BOOK',trade:{event_ns:'1500000000',side:'SELL',price:'99',size:'2'}});
observe(2000000000,4,{segmentId:'c'.repeat(64),knownNs:'2500000000'});
rows.push(...sampler.finish());
process.stdout.write(JSON.stringify(rows));
"""
    return json.loads(subprocess.run([node, "-e", source], cwd=RUNTIME, check=True, capture_output=True, text=True).stdout)


def read(directory, pin, at=4_000_000_000, position="99"):
    return seconds.read_seconds(directory, pin, from_ns="0", as_of_ns=str(at),
                                as_of_key=[str(at), "2", position, "0"])


def test_multipart_roundtrip_boundary_flow_coverage_and_knowledge(tmp_path):
    rows = sampled()
    directory = tmp_path / "seconds"
    manifest = seconds.write_parts(rows, directory, part_rows=2)
    pin = seconds.digest(directory / "manifest.json")
    assert len(manifest["parts"]) > 5
    assert read(directory, pin) == rows
    earlier = read(directory, pin, 1_000_000_000)
    coverage = [row["payload"] for row in earlier if row["payload"].get("row_kind") == "coverage"]
    assert coverage[-1]["flow"] == {"BUY": 3, "SELL": 0, "UNKNOWN": 0, "count": 1}
    beyond = next(row["payload"] for row in earlier if row["payload"].get("price_key") == 105)
    assert beyond["bid_size"] is None and beyond["ask_size"] is None
    assert not any(row["payload"].get("reason") == "FINAL_SOURCE_PREFIX" for row in read(directory, pin, 2_400_000_000))
    again = tmp_path / "again"
    seconds.write_parts(rows, again, part_rows=3)
    assert read(again, seconds.digest(again / "manifest.json")) == rows


@pytest.mark.parametrize("change", [
    lambda rows: rows.pop(),
    lambda rows: rows[2].update(append_position=8),
    lambda rows: rows[2].update(record_id="f" * 64),
    lambda rows: next(row["payload"] for row in rows if row["payload"].get("price_key") == 105).update(bid_size=0),
    lambda rows: next(row["payload"] for row in rows if row["payload"].get("row_kind") == "coverage" and row["payload"]["trusted"]).update(flow={"BUY": 100, "SELL": 0, "UNKNOWN": 0, "count": 1}),
    lambda rows: next(row["payload"] for row in rows if row["payload"].get("row_kind") == "coverage" and not row["payload"]["complete"]).update(complete=True),
    lambda rows: rows.append(deepcopy(rows[-1])),
    lambda rows: rows[-1].update(known_key=["1000000000", "2", "1", "0"]),
    lambda rows: rows[-1].update(known_key=["4000000000", "2", "99", "0"]),
    lambda rows: next(row["payload"] for row in rows if row["payload"].get("row_kind") == "coverage" and not row["payload"]["complete"]).update(tick_size="0.5"),
])
def test_incomplete_malformed_or_lookahead_stream_never_seals(tmp_path, change):
    rows = sampled()
    change(rows)
    with pytest.raises(ValueError):
        seconds.write_parts(rows, tmp_path / "bad", part_rows=2)
    assert not (tmp_path / "bad" / "manifest.json").exists()


def test_integrity_cancellation_and_resource_budgets(tmp_path, monkeypatch):
    directory = tmp_path / "seconds"
    seconds.write_parts(sampled(), directory, part_rows=2)
    pin = seconds.digest(directory / "manifest.json")
    with pytest.raises(ValueError, match="pin changed"):
        read(directory, "0" * 64)
    with pytest.raises(InterruptedError):
        seconds.read_seconds(directory, pin, from_ns="0", as_of_ns="4000000000", as_of_key=["4000000000", "2", "99", "0"], cancelled=lambda: True)
    monkeypatch.setattr(seconds, "MAX_READ_ROWS", 2)
    with pytest.raises(ValueError, match="output admission"):
        read(directory, pin)
    monkeypatch.setattr(seconds, "MAX_READ_ROWS", 20_000)
    monkeypatch.setattr(seconds, "MAX_SCAN_BYTES", 1)
    with pytest.raises(ValueError, match="scan byte admission"):
        read(directory, pin)
    monkeypatch.setattr(seconds, "MAX_SCAN_BYTES", 64 * 1024 * 1024)
    with (directory / "part-0000.parquet").open("ab") as sink:
        sink.write(b"bad")
    with pytest.raises(ValueError, match="integrity"):
        read(directory, pin)


def test_write_limits_and_cancel_leave_no_manifest(tmp_path, monkeypatch):
    monkeypatch.setattr(seconds, "MAX_ROWS", 2)
    with pytest.raises(ValueError, match="row admission"):
        seconds.write_parts(sampled(), tmp_path / "oversize", part_rows=2)
    with pytest.raises(InterruptedError):
        seconds.write_parts(sampled(), tmp_path / "cancelled", cancelled=lambda: True)
    assert not (tmp_path / "oversize" / "manifest.json").exists()
    assert not (tmp_path / "cancelled" / "manifest.json").exists()


def test_missing_book_rows_cannot_seal_even_with_valid_ids(tmp_path):
    rows = sampled()
    removed = next(index for index, row in enumerate(rows) if row["payload"].get("price_key") == 99)
    del rows[removed]
    for index, row in enumerate(rows):
        row["append_position"] = index
        row["record_id"] = seconds.hashed([seconds.SCHEMA, row["derivation_id"], row["instrument_id"], index])
    with pytest.raises(ValueError, match="book rows missing"):
        seconds.write_parts(rows, tmp_path / "missing", part_rows=2)
    assert not (tmp_path / "missing" / "manifest.json").exists()


def test_response_budget_includes_json_array_framing(tmp_path, monkeypatch):
    directory = tmp_path / "seconds"
    seconds.write_parts(sampled(), directory, part_rows=2)
    pin = seconds.digest(directory / "manifest.json")
    expected = read(directory, pin)
    size = len(json.dumps(expected, separators=(",", ":")).encode())
    monkeypatch.setattr(seconds, "MAX_READ_BYTES", size)
    assert read(directory, pin) == expected
    monkeypatch.setattr(seconds, "MAX_READ_BYTES", size - 1)
    with pytest.raises(ValueError, match="output admission"):
        read(directory, pin)
    empty = dict(from_ns="999000000000", as_of_ns="999000000000", as_of_key=["999000000000", "0", "0", "0"])
    monkeypatch.setattr(seconds, "MAX_READ_BYTES", 2)
    assert seconds.read_seconds(directory, pin, **empty) == []
    monkeypatch.setattr(seconds, "MAX_READ_BYTES", 1)
    with pytest.raises(ValueError, match="output admission"):
        seconds.read_seconds(directory, pin, **empty)


def test_exact_source_cursor_excludes_later_boundary_at_same_nanosecond(tmp_path):
    rows = sampled()
    directory = tmp_path / "seconds"
    seconds.write_parts(rows, directory, part_rows=2)
    pin = seconds.digest(directory / "manifest.json")
    visible = seconds.read_seconds(directory, pin, from_ns="0", as_of_ns="2500000000",
                                   as_of_key=["2000000000", "2", "3", "0"])
    assert not any(row["payload"].get("segment_id") == "c" * 64 for row in visible)
    later = seconds.read_seconds(directory, pin, from_ns="0", as_of_ns="2500000000",
                                 as_of_key=["2000000000", "2", "4", "0"])
    assert any(row["payload"].get("segment_id") == "c" * 64 for row in later)


@pytest.mark.parametrize("instrument", ["ES", "NQ"])
def test_native_witness_roundtrip_matches_independent_books_and_trade_sums(tmp_path, instrument):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node required for native source pilot")
    process = subprocess.run([node, "scripts/verify/databento/verify-historical-second-pilot.js", instrument],
                             cwd=RUNTIME, check=True, capture_output=True, text=True)
    rows = [json.loads(line) for line in process.stdout.splitlines()]
    fixture = next(case for case in json.loads((RUNTIME / "test/fixtures/golden/historical-cme-source-witnesses.json").read_text())["cases"] if case["instrument"] == instrument)
    expected = {side: sum(record["size"] for record in fixture["rows"] if record["action"] == "T" and record["side"] == native_side)
                for side, native_side in (("BUY", "B"), ("SELL", "A"))}
    directory = tmp_path / instrument
    seconds.write_parts(rows, directory, part_rows=7)
    metadata = json.loads(process.stderr)
    received = seconds.read_seconds(directory, seconds.digest(directory / "manifest.json"), from_ns=metadata["fromNs"],
                                    as_of_ns=metadata["toNs"], as_of_key=[metadata["toNs"], "2", "99999999", "0"])
    assert received == rows
    coverage = [row["payload"] for row in received if row["payload"].get("row_kind") == "coverage"]
    assert {side: sum(row["flow"][side] for row in coverage) for side in expected} == expected
    assert all(not row["complete"] for row in coverage if row["trusted"])
    assert coverage[0]["trusted"] is False and coverage[-1]["reason"] == "TAIL_NOT_VERIFIED"
    final = fixture["rows"][-1]
    last_book = [row["payload"] for row in rows if row["payload"].get("row_kind") == "level"]
    for side in ("bid", "ask"):
        expected_book = {int(Decimal(level[side + "_px"]) / Decimal(1_000_000_000) / Decimal("0.25")): level[side + "_sz"] for level in final["levels"]}
        actual = {row["price_key"]: row[side + "_size"] for row in last_book if row[side + "_size"]}
        assert actual == expected_book
