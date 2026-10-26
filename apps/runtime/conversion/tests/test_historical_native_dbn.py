from __future__ import annotations

import importlib
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
import duckdb


sys.path.insert(0, str(Path(__file__).parents[2] / "scripts" / "verify" / "databento"))
native = importlib.import_module("inspect_historical_native_dbn")


def row(action, at=1, size=5, instrument=10):
    level = SimpleNamespace(bid_px=100, ask_px=101, bid_sz=5, ask_sz=size)
    return SimpleNamespace(instrument_id=instrument, ts_event=at, ts_recv=2, sequence=3,
                           action=action, side="B", price=101, size=2, flags=0, levels=[level] * 10)


def test_native_witness_preserves_individual_trade_order_without_assuming_book_updates():
    result = native.summarize([row("A", 0), row("T"), row("T"), row("C", 2, 1)], 10, {(1, 2, 3)}, 0, 10)
    assert result["trade_book_change_count"] == 0
    assert result["actions_in_day"] == {"A": 1, "T": 2, "C": 1}
    assert [r["native_index"] for r in result["windows"][0]["rows"]] == ["0", "1", "2", "3"]
    assert result["windows"][0]["matched"] == 2


def test_native_diagnostic_exposes_trade_book_change_instead_of_approving_the_echo_rule():
    result = native.summarize([row("A", 0), row("T", size=2)], 10, {(1, 2, 3)}, 0, 10)
    assert result["trade_book_change_count"] == 1


@pytest.mark.parametrize("dataset,publisher",[("GLBX.MDP3",1),("XNAS.ITCH",2)])
@pytest.mark.parametrize("unsafe_flags,position,action", [(4, 0, "A"), (4, 1, "A"), (4, 0, "R"),
                                                        (8, 0, "A"), (8, 1, "A"), (12, 0, "R")])
def test_native_profiles_pin_dataset_publisher_and_source_quality(tmp_path,monkeypatch,dataset,publisher,
                                                               unsafe_flags,position,action):
    class Metadata:
        pass
    class Record:
        pass
    meta=Metadata()
    meta.dataset=dataset
    meta.schema=SimpleNamespace(value="mbp-10")
    meta.start=1785888000000000000
    meta.end=1785974400000000000
    meta.mappings={"A":[{"symbol":"10","start_date":"2026-08-05","end_date":"2026-08-06"}]}
    meta.partial=meta.not_found=[]
    record=Record()
    record.publisher_id=publisher
    record.instrument_id=10
    record.levels=[None]*10
    record.flags=128 | 16
    record.action=action
    record.ts_event=1785888000000000000
    record.ts_recv=1785888000000000000
    prefix=Record()
    prefix.publisher_id=publisher
    prefix.instrument_id=10
    prefix.levels=[None]*10
    prefix.flags=128 | 16
    prefix.ts_event=1785888000000000000
    prefix.ts_recv=1785888000000000000
    class Decoder:
        def write_and_decode(self,_chunk): return [meta,*([prefix] if position else []),record]
        def buffer(self): return b""
    monkeypatch.setattr(native.dbn,"Metadata",Metadata)
    monkeypatch.setattr(native.dbn,"MBP10Msg",Record)
    monkeypatch.setattr(native.dbn,"DBNDecoder",lambda **_kwargs:Decoder())
    raw=tmp_path/"native.dbn.zst"
    raw.write_bytes(b"stub")
    assert list(native.native_records(raw,"2026-08-05",dataset=dataset))==([prefix] if position else [])+[record]
    record.flags |= unsafe_flags
    with pytest.raises(ValueError,match="source quality flags"):
        list(native.native_records(raw,"2026-08-05",dataset=dataset))
    record.flags=128 | 16
    record.publisher_id=3
    with pytest.raises(ValueError,match="unexpected native record"):
        list(native.native_records(raw,"2026-08-05",dataset=dataset))
    with pytest.raises(ValueError,match="unsupported native dataset"):
        list(native.native_records(raw,"2026-08-05",dataset="UNKNOWN"))


def test_previous_day_seed_is_counted_separately_from_the_pinned_day():
    result = native.summarize([row("A", 0), row("T")], 10, {(1, 2, 3)}, 1, 10)
    assert result["decoded_rows"] == 2 and result["outside_day"] == 1
    assert result["actions_in_day"] == {"T": 1}


@pytest.mark.parametrize("fault", [None, "book_flag", "not_snapshot", "not_first", "in_day", "receive_not_boundary", "trade"])
def test_only_unused_preceding_snapshot_seed_may_have_a_synthetic_receive_clock(fault):
    record = row("A", at=99)
    record.ts_recv = 100
    record.flags = 128 | 32 | 8
    index = 0
    if fault == "book_flag": record.flags |= 4
    elif fault == "not_snapshot": record.flags &= ~32
    elif fault == "not_first": index = 1
    elif fault == "in_day": record.ts_event = 100
    elif fault == "receive_not_boundary": record.ts_recv = 101
    elif fault == "trade": record.action = "T"
    allowed = native.unused_snapshot_seed_clock(record, index, 100)
    if fault is None:
        native.validate_source_flags(record.flags, unused_seed_clock=allowed)
    else:
        with pytest.raises(ValueError, match="source quality flags"):
            native.validate_source_flags(record.flags, unused_seed_clock=allowed)


def test_native_diagnostic_refuses_foreign_instrument_and_wrong_depth():
    with pytest.raises(ValueError, match="unexpected native instrument"):
        native.summarize([row("T", instrument=11)], 10, {(1, 2, 3)}, 0, 10)
    short = row("T")
    short.levels = short.levels[:1]
    with pytest.raises(ValueError, match="ten level slots"):
        native.summarize([short], 10, {(1, 2, 3)}, 0, 10)


def test_native_diagnostic_refuses_empty_absent_and_oversized_witnesses():
    for records in ([], [row("T", 2)]):
        with pytest.raises(ValueError, match="empty source or absent"):
            native.summarize(records, 10, {(1, 2, 3)}, 0, 10)
    with pytest.raises(ValueError, match="exceeds 128 rows"):
        native.summarize([row("T")] * 129, 10, {(1, 2, 3)}, 0, 10)


@pytest.fixture
def pinned_source(tmp_path, monkeypatch):
    monkeypatch.setattr(native, "DATA_ROOT", tmp_path)
    raw = tmp_path / "native.dbn.zst"
    raw.write_bytes(b"not a DBN")
    part = tmp_path / "part.parquet"
    with duckdb.connect() as connection:
        connection.execute("CREATE TABLE source AS SELECT ? AS lineage_sha256, 'ES' AS instrument_id, 144 AS dbn_source_flags",
                           [hashlib.sha256(b"expected source").hexdigest()])
        connection.execute("COPY source TO ? (FORMAT PARQUET)", [str(part)])
    plan = {"partition": {"family": "depth", "instrument_id": "ES", "record_count": 1, "date": "2026-08-05"}}
    depth = tmp_path / "plan.json"
    depth.write_text("{}", encoding="utf-8")
    witness = tmp_path / "witness.json"
    witness.write_text(json.dumps({"depth": plan["partition"]}), encoding="utf-8")
    monkeypatch.setattr(native, "verified_files", lambda *_args: (plan, [str(part)]))
    return raw, depth, witness, part, plan


def test_native_inspection_refuses_a_raw_hash_not_present_in_verified_lineage(pinned_source):
    raw, depth, witness, _, _ = pinned_source
    with pytest.raises(ValueError, match="hash differs from verified canonical lineage"):
        native.inspect(raw, depth, witness)


def test_native_inspection_refuses_a_witness_from_another_partition(pinned_source):
    raw, depth, witness, _, _ = pinned_source
    witness.write_text(json.dumps({"depth": {"family": "depth", "instrument_id": "NQ"}}), encoding="utf-8")
    with pytest.raises(ValueError, match="match the pinned depth partition"):
        native.inspect(raw, depth, witness)


def test_native_inspection_refuses_canonical_count_disagreement(pinned_source):
    raw, depth, witness, _, plan = pinned_source
    plan["partition"]["record_count"] = 2
    witness.write_text(json.dumps({"depth": plan["partition"]}), encoding="utf-8")
    with pytest.raises(ValueError, match="one reconciled raw lineage and instrument"):
        native.inspect(raw, depth, witness)


@pytest.mark.parametrize("flags", [None, -1, 256, 4, 8, 12])
def test_native_admission_refuses_unqualified_canonical_flags(pinned_source, flags):
    raw, depth, _, part, _ = pinned_source
    with duckdb.connect() as connection:
        connection.execute("CREATE TABLE source AS SELECT ? AS lineage_sha256, 'ES' AS instrument_id, "
                           "?::INTEGER AS dbn_source_flags", [hashlib.sha256(raw.read_bytes()).hexdigest(), flags])
        connection.execute("COPY source TO ? (FORMAT PARQUET)", [str(part)])
    with pytest.raises(ValueError, match="source quality flags"):
        native.admit_source(raw, depth)
