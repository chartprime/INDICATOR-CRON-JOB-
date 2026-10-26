"""The candle resolution ladder.

A bar is a `candle` record at every resolution, because market-observation/1 is
shared with the live collector and must not move. The archive still has to
address resolutions separately, so the resolution rides on the partition family
instead. These tests pin both halves of that split and the guard between them.
"""
from __future__ import annotations

import os
from decimal import Decimal

import duckdb
import pytest

import archive_query as aq
import convert
import csv_decode
import identity
import writer
from bridge import ContractBridge

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.normpath(os.path.join(HERE, "..", "..", "scripts", "convert", "contract-worker.js"))

_HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"
_ROWS = [
    "1756800000000000000,32,2,38,231460000000,231460000000,231460000000,231460000000,21",
    "1756800060000000000,32,2,38,231000000000,231010000000,230890000000,230890000000,472",
]

_DAY_NS = 86_400_000_000_000
_YEAR_NS = 365 * _DAY_NS


def _csv(tmp_path, schema):
    path = tmp_path / f"aapl.{schema}.csv"
    path.write_text("\n".join([_HEADER, *_ROWS]) + "\n", encoding="utf-8")
    return str(path)


def _convert(tmp_path, schema):
    roots = {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }
    summary = convert.convert_file(
        _csv(tmp_path, schema), schema, "20260910T000000Z",
        dataset="XNAS.ITCH", symbol="AAPL",
        s3_key=f"raw/databento/dataset=XNAS.ITCH/schema={schema}/symbol=AAPL/y/aapl.csv",
        **roots,
    )
    return summary, roots


def _bar_span_ns(curated_root, partition):
    part = os.path.join(curated_root, partition, "part-00000.parquet")
    con = duckdb.connect()
    try:
        return con.execute(
            "SELECT close_ns - open_ns FROM read_parquet(?) ORDER BY event_ns LIMIT 1", [part]
        ).fetchone()[0]
    finally:
        con.close()


def test_every_rung_is_addressable_and_bounded():
    for family in ("candle", "candle_1m", "candle_1h", "candle_1d"):
        assert family in aq.FAMILIES
        assert family in aq.WINDOW_LIMIT_NS
        assert family in aq.BYTES_PER_ROW


def test_a_coarser_rung_is_what_makes_a_year_answerable():
    """The whole reason the ladder exists. One second refuses a year outright;
    one hour admits it, and the row count is what keeps it to a single page."""
    args = ("AAPL.XNAS", None, "0", str(_YEAR_NS), None)
    with pytest.raises(aq.ArchiveQueryError) as refused:
        aq._validate_request_shape("AAPL.XNAS", "candle", "0", str(_YEAR_NS), None)
    assert refused.value.code == aq.WINDOW_TOO_LARGE

    start, end, _budget = aq._validate_request_shape(
        "AAPL.XNAS", "candle_1h", "0", str(_YEAR_NS), None)
    assert end - start == _YEAR_NS
    assert aq.estimated_bytes("candle_1h", 365 * 24) < aq.MAX_SCAN_BYTES


def test_the_daily_rung_keeps_a_long_range_addressable():
    start, end, _budget = aq._validate_request_shape(
        "AAPL.XNAS", "candle_1d", "0", str(25 * _YEAR_NS), None)
    assert end - start == 25 * _YEAR_NS
    assert aq.estimated_bytes("candle_1d", 25 * 365) < aq.MAX_SCAN_BYTES


def test_one_second_bars_keep_the_family_the_archive_already_published(tmp_path):
    """1,144 published dates carry family='candle'. If this moves, every one of
    them becomes unreachable without a catalogue migration."""
    summary, roots = _convert(tmp_path, "ohlcv-1s")
    assert all("/candle/" in partition for partition in summary["partitions"])
    assert _bar_span_ns(roots["curated_root"], summary["partitions"][0]) == 1_000_000_000


def test_one_minute_bars_land_in_their_own_partition_family(tmp_path):
    summary, roots = _convert(tmp_path, "ohlcv-1m")
    assert all("/candle_1m/" in partition for partition in summary["partitions"])
    assert _bar_span_ns(roots["curated_root"], summary["partitions"][0]) == 60_000_000_000


def test_the_record_family_stays_candle_at_every_resolution(tmp_path):
    """market-observation/1 is the live contract. The ladder must not reach it."""
    _summary, roots = _convert(tmp_path, "ohlcv-1m")
    partition = _summary["partitions"][0]
    part = os.path.join(roots["curated_root"], partition, "part-00000.parquet")
    con = duckdb.connect()
    try:
        schema = con.execute(
            "SELECT source_schema FROM read_parquet(?) LIMIT 1", [part]).fetchone()[0]
    finally:
        con.close()
    assert schema == "ohlcv-1m"
    assert writer._PARTITION_RECORD_FAMILY["candle_1m"] == "candle"


def _candle_records(tmp_path, schema):
    path = _csv(tmp_path, schema)
    mappings = identity.build_csv_mappings(
        "XNAS.ITCH", "AAPL", csv_decode.distinct_instrument_ids(path), reference="s3-key:raw/x.csv")
    rows = [{"row": r, "position": i} for i, r in csv_decode.decode_ohlcv(path)]
    ctx = {
        "mappings": mappings, "dataset": "XNAS.ITCH", "sourceSymbol": rows[0]["row"]["instrument_id"],
        "population": f"XNAS.ITCH:{schema}", "datasetVersion": "20260910T000000Z",
        "streamId": f"databento:XNAS.ITCH:{schema}", "schema": schema,
        "ingestNs": "1789000000000000000", "lineage": {"object": "file://x.csv", "sha256": "0" * 64},
    }
    with ContractBridge(WORKER) as bridge:
        results = bridge.map_batch("b1", "DATABENTO", "candle", rows, ctx)
    return [rec for r in results if r["ok"] for rec in r["records"]]


def test_a_bar_whose_span_contradicts_its_partition_is_refused(tmp_path):
    """The failure this guard exists for. A real one-second bar offered to the
    one-minute rung is a complete, valid record -- without the guard the writer
    accepts it and every higher timeframe resampled from that partition is
    silently wrong. Nothing else in the pipeline compares the two."""
    one_second = _candle_records(tmp_path, "ohlcv-1s")
    assert one_second, "expected the bridge to map the fixture rows"
    span = int(one_second[0]["data"]["closeNs"]) - int(one_second[0]["data"]["openNs"])
    assert span == 1_000_000_000

    pw = writer.PartitionWriter(str(tmp_path / "stage"), one_second[0]["instrument"]["id"],
                                "candle_1m", "v1", "2025-09-02")
    with pytest.raises(writer.WriterError, match="BAR_INTERVAL_MISMATCH:candle_1m:1000000000"):
        pw.add(one_second[0])

    legacy = writer.PartitionWriter(str(tmp_path / "stage2"), one_second[0]["instrument"]["id"],
                                    "candle", "v1", "2025-09-02")
    assert legacy.add(one_second[0])["accepted"] is True


def test_an_unmapped_ohlcv_schema_is_refused_rather_than_defaulted():
    """Adding a resolution to _OHLCV_SCHEMAS without giving it a partition family
    must fail loudly, not quietly file those bars under the one-second family.
    A new source resolution has to make an explicit family choice."""
    with pytest.raises(convert.ConversionError, match="UNMAPPED_CANDLE_SCHEMA:ohlcv-5m"):
        convert._partition_family_for("candle", "ohlcv-5m")
    assert convert._partition_family_for("quote", "mbp-1") == "quote"


def test_every_mapped_resolution_has_a_writer_and_a_window_cap():
    """The three places a resolution has to be known agree. A rung added to one
    and forgotten in another fails at conversion time or serves an unbounded
    window, and neither surfaces until real data exists."""
    for schema, family in convert._OHLCV_PARTITION_FAMILY.items():
        if schema.startswith("ohlcv-"):
            assert schema in convert._OHLCV_SCHEMAS, schema
        assert writer._PARTITION_RECORD_FAMILY[family] == "candle"
        assert family in writer._PARTITION_BAR_INTERVAL_NS
        assert family in aq.FAMILIES and family in aq.WINDOW_LIMIT_NS
