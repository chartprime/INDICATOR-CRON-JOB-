"""CSV OHLCV decode + path-symbology identity + end-to-end candle conversion."""
from __future__ import annotations

import json
import os
import sqlite3

import duckdb
import pytest

import catalog
import convert
import csv_decode
import identity

_HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"
_ROWS = [
    "1756800000000000000,32,2,38,231460000000,231460000000,231460000000,231460000000,21",
    "1756800020000000000,32,2,38,231000000000,231010000000,230890000000,230890000000,472",
    "1756886400000000000,32,2,38,232000000000,232500000000,231900000000,232400000000,1000",
]


def _csv(tmp_path, rows=_ROWS, header=_HEADER):
    path = tmp_path / "aapl.ohlcv-1s.csv"
    path.write_text("\n".join([header, *rows]) + "\n")
    return str(path)


def test_decode_ohlcv_yields_string_rows_and_validates_the_header(tmp_path):
    rows = list(csv_decode.decode_ohlcv(_csv(tmp_path)))
    assert [i for i, _ in rows] == [0, 1, 2]
    assert rows[0][1] == {
        "ts_event": "1756800000000000000", "rtype": "32", "publisher_id": "2", "instrument_id": "38",
        "open": "231460000000", "high": "231460000000", "low": "231460000000", "close": "231460000000", "volume": "21",
    }
    assert csv_decode.distinct_instrument_ids(_csv(tmp_path)) == {"38"}


def test_decode_ohlcv_rejects_a_bad_header_and_ragged_rows(tmp_path):
    with pytest.raises(csv_decode.CsvError, match="HEADER_MISMATCH"):
        list(csv_decode.decode_ohlcv(_csv(tmp_path, header="ts_event,open,close")))
    with pytest.raises(csv_decode.CsvError, match="RAGGED_CSV_ROW"):
        list(csv_decode.decode_ohlcv(_csv(tmp_path, rows=["1,2,3"])))


def test_decode_ohlcv_refuses_a_row_with_an_empty_field(tmp_path):
    with pytest.raises(csv_decode.CsvError, match="EMPTY_CSV_FIELD"):
        list(csv_decode.decode_ohlcv(_csv(tmp_path, rows=["1756800000000000000,32,2,38,,231460000000,231460000000,231460000000,21"])))


def test_path_symbology_builds_a_wide_equity_mapping_and_rejects_futures():
    rows = identity.build_csv_mappings("XNAS.ITCH", "AAPL", {"38"}, "s3-key:raw/databento/.../aapl.csv")
    assert rows == [{
        "provider": "DATABENTO", "dataset": "XNAS.ITCH", "sourceSymbol": "38",
        "fromNs": "0", "toNs": "18446744073709551614",
        "instrument": {"venue": "XNAS", "market": "EQUITY", "symbol": "AAPL", "currency": "USD", "sizeUnit": "SHARE", "contract": None},
        "mappingVersion": "path-symbology/1", "reference": "s3-key:raw/databento/.../aapl.csv",
    }]
    with pytest.raises(identity.IdentityError, match="CSV_FUTURES_IDENTITY_REQUIRES_ROLL_TABLE"):
        identity.build_csv_mappings("GLBX.MDP3", "ESZ5", {"1"}, "s3-key:x")


def test_csv_partition_identity_cannot_be_overridden(tmp_path):
    with pytest.raises(convert.ConversionError, match="CSV_SOURCE_IDENTITY_MISMATCH:symbol"):
        convert.convert_file(_csv(tmp_path), "ohlcv-1s", "v1", dataset="XNAS.ITCH", symbol="TSLA",
                             s3_key="raw/databento/symbol=AAPL/x.csv",
                             staging_root=tmp_path / "stage", curated_root=tmp_path / "curated",
                             catalog_root=tmp_path / "catalog")


def test_full_candle_spine_from_a_csv(tmp_path):
    roots = {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }
    summary = convert.convert_file(
        _csv(tmp_path), "ohlcv-1s", "20260910T000000Z",
        dataset="XNAS.ITCH", symbol="AAPL", s3_key="raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/y/aapl.csv",
        **roots,
    )
    assert summary["accepted"] == 3
    assert summary["rejected"] == 0
    # rows span two UTC dates -> two date partitions
    dates = sorted(p.split("/")[-1] for p in summary["partitions"])
    assert dates == ["2025-09-02", "2025-09-03"]

    part = os.path.join(roots["curated_root"], summary["partitions"][0], "part-00000.parquet")
    con = duckdb.connect()
    try:
        row = con.execute(
            "SELECT open, high, low, close, volume, close_ns - open_ns, method, closed FROM read_parquet(?) ORDER BY event_ns LIMIT 1",
            [part],
        ).fetchone()
    finally:
        con.close()
    from decimal import Decimal
    assert row[0] == Decimal("231.46") and row[3] == Decimal("231.46")
    assert row[4] == Decimal("21")
    assert row[5] == 1_000_000_000
    assert row[6] == "databento-ohlcv-1s/1"
    assert row[7] is True

    pointer = catalog.read_current(roots["catalog_root"])
    snap = sqlite3.connect(os.path.join(roots["catalog_root"], pointer["catalog_key"]))
    try:
        assert snap.execute("SELECT count(*) FROM partitions WHERE family='candle'").fetchone()[0] == 2
    finally:
        snap.close()
