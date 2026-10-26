"""DBN decode against the repo's pinned public fixtures."""
from __future__ import annotations

import os
import types

import pytest

import dbn

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.normpath(os.path.join(HERE, "..", "..", "test", "contracts", "fixtures", "market-observation-v1"))
MBP1 = os.path.join(FIXTURES, "databento-mbp1.dbn")
TBBO = os.path.join(FIXTURES, "databento-tbbo.dbn")


def _rows(path, **kw):
    meta = []
    out = list(dbn.decode(path, on_metadata=meta.append, **kw))
    return meta[0], out


def test_decodes_pinned_mbp1_fixture_to_string_fields_and_metadata():
    meta, rows = _rows(MBP1)
    assert meta.schema == "mbp-1"
    assert meta.version == 2
    assert meta.stype_in == "raw_symbol"
    assert meta.stype_out == "instrument_id"
    assert meta.mappings == {"ESH1": [{"start_date": "2020-12-28", "end_date": "2020-12-29", "symbol": "5482"}]}
    assert meta.start_ns == 1609160400000000000 and meta.end_ns == 1609200000000000000
    assert meta.partial == [] and meta.not_found == []

    assert [i for i, _ in rows] == [0, 1]
    r0 = rows[0][1]
    assert r0["action"] == "A" and r0["side"] == "A"
    assert r0["flags"] == "128"
    assert r0["instrument_id"] == "5482"
    assert r0["price"] == "3720500000000"
    assert r0["bid_px_00"] == "3720250000000" and r0["ask_px_00"] == "3720500000000"
    assert all(isinstance(v, str) for v in r0.values())


def test_tbbo_fixture_decodes_as_trades():
    _, rows = _rows(TBBO)
    assert [rows[0][1]["action"], rows[1][1]["action"]] == ["T", "T"]


def test_read_metadata_returns_the_header_without_consuming_all_rows():
    meta = dbn.read_metadata(MBP1)
    assert meta.schema == "mbp-1" and meta.symbols == ["ESH1"]


def test_expected_schema_mismatch_is_rejected():
    with pytest.raises(dbn.DbnError, match="SCHEMA_MISMATCH"):
        list(dbn.decode(MBP1, expected_schema="mbp-10"))


def test_truncated_dbn_raises_after_the_last_complete_record(tmp_path):
    body = open(MBP1, "rb").read()
    cut = tmp_path / "cut.dbn"
    cut.write_bytes(body[:-20])
    with pytest.raises(dbn.DbnError, match="TRUNCATED_DBN"):
        list(dbn.decode(str(cut)))


def test_ohlcv_row_extraction_is_stringified():
    rec = types.SimpleNamespace(instrument_id=5482, ts_event=1609160400000000000, open=100, high=110, low=90, close=105, volume=42)
    assert dbn._ohlcv_row(rec) == {
        "instrument_id": "5482", "ts_event": "1609160400000000000",
        "open": "100", "high": "110", "low": "90", "close": "105", "volume": "42",
    }


def test_definition_row_extraction_is_stringified_and_normalizes_undef_sentinels():
    rec = types.SimpleNamespace(
        instrument_id=1234, ts_recv=1609160400000000000, raw_symbol="ESZ5",
        min_price_increment=250000000, unit_of_measure_qty=50000000000, expiration=1734652800000000000,
    )
    assert dbn._definition_row(rec) == {
        "instrument_id": "1234", "ts_recv": "1609160400000000000", "raw_symbol": "ESZ5",
        "min_price_increment": "250000000", "unit_of_measure_qty": "50000000000", "expiration": "1734652800000000000",
    }
    undef = types.SimpleNamespace(
        instrument_id=1234, ts_recv=1609160400000000000, raw_symbol="ESZ5",
        min_price_increment=250000000, unit_of_measure_qty=9223372036854775807, expiration=18446744073709551615,
    )
    row = dbn._definition_row(undef)
    assert row["expiration"] is None and row["unit_of_measure_qty"] is None
