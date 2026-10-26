"""Hourly bars derived from one-minute bars.

The hourly rung is arithmetic, not a source, so nothing upstream can catch a
mistake here. These tests pin the properties that would otherwise fail silently:
volume must survive aggregation, a quiet hour must still produce a bar, and a
bar must never be assembled out of minutes that do not belong to it.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

import candle_rollup as rollup

HOUR = rollup.HOUR_NS
MINUTE = rollup.MINUTE_NS


def _minute(open_ns, open_, high, low, close, volume, symbol="38"):
    return {
        "open_ns": open_ns, "close_ns": open_ns + MINUTE,
        "open": Decimal(open_), "high": Decimal(high), "low": Decimal(low),
        "close": Decimal(close), "volume": Decimal(volume), "source_symbol": symbol,
    }


def _full_hour(base, count=60, volume="10"):
    return [_minute(base + i * MINUTE, "100", "101", "99", "100", volume) for i in range(count)]


def test_an_hour_takes_its_edges_from_the_minutes_not_the_extremes():
    minutes = [
        _minute(0, "100", "105", "95", "101", "7"),
        _minute(MINUTE, "101", "110", "90", "102", "3"),
        _minute(2 * MINUTE, "102", "103", "99", "104", "5"),
    ]
    rows = rollup.hour_rows(minutes)
    assert len(rows) == 1
    row = rows[0]
    assert row["ts_event"] == "0"
    assert row["open"] == rollup._fixed9_text(Decimal("100"))
    assert row["close"] == rollup._fixed9_text(Decimal("104"))
    assert row["high"] == rollup._fixed9_text(Decimal("110"))
    assert row["low"] == rollup._fixed9_text(Decimal("90"))
    assert row["volume"] == "15"


def test_minutes_arriving_out_of_order_still_give_the_hour_its_first_open_and_last_close():
    minutes = [
        _minute(2 * MINUTE, "102", "103", "99", "104", "5"),
        _minute(0, "100", "105", "95", "101", "7"),
        _minute(MINUTE, "101", "110", "90", "102", "3"),
    ]
    row = rollup.hour_rows(minutes)[0]
    assert row["open"] == rollup._fixed9_text(Decimal("100"))
    assert row["close"] == rollup._fixed9_text(Decimal("104"))


def test_volume_survives_aggregation():
    minutes = _full_hour(0) + _full_hour(HOUR, count=17)
    rows = rollup.hour_rows(minutes)
    assert len(rows) == 2
    assert rollup.total_volume(rows) == sum(int(m["volume"]) for m in minutes)


def test_a_quiet_hour_still_produces_a_bar():
    """The archive only holds a bar where the market traded. Three minutes in an
    hour is an ordinary hour, and dropping it would put a hole in the hourly
    rung exactly where the market was quiet."""
    minutes = [
        _minute(HOUR, "100", "100", "100", "100", "1"),
        _minute(HOUR + 31 * MINUTE, "101", "101", "101", "101", "1"),
        _minute(HOUR + 59 * MINUTE, "102", "102", "102", "102", "1"),
    ]
    rows = rollup.hour_rows(minutes)
    assert len(rows) == 1
    assert rows[0]["ts_event"] == str(HOUR)
    assert rows[0]["volume"] == "3"


def test_a_quiet_utc_day_still_produces_a_daily_bar():
    minutes = [
        _minute(0, "100", "101", "99", "100", "1"),
        _minute(rollup.DAY_NS - MINUTE, "100", "110", "90", "105", "2"),
    ]
    rows = rollup.day_rows(minutes)
    assert rows == [{
        "ts_event": "0", "instrument_id": "38", "open": rollup._fixed9_text(Decimal("100")),
        "high": rollup._fixed9_text(Decimal("110")), "low": rollup._fixed9_text(Decimal("90")),
        "close": rollup._fixed9_text(Decimal("105")), "volume": "3",
    }]


def test_hours_are_ordered_and_never_merged_across_buckets():
    minutes = _full_hour(2 * HOUR) + _full_hour(0) + _full_hour(HOUR)
    rows = rollup.hour_rows(minutes)
    assert [row["ts_event"] for row in rows] == ["0", str(HOUR), str(2 * HOUR)]


def test_an_hour_never_straddles_a_utc_date():
    """Partitions are keyed by UTC date. An hour that crossed midnight would
    belong to two partitions at once, and whichever one took it would be wrong."""
    for bucket in (0, 23 * HOUR, rollup.DAY_NS - HOUR):
        rows = rollup.hour_rows(_full_hour(bucket, count=1))
        assert len(rows) == 1
    assert rollup.DAY_NS % HOUR == 0


def test_a_source_that_is_not_a_minute_bar_is_refused():
    """The guard that stops the hourly rung being built out of second bars."""
    second_bar = dict(_minute(0, "100", "100", "100", "100", "1"), close_ns=1_000_000_000)
    with pytest.raises(rollup.RollupError, match="SOURCE_IS_NOT_A_MINUTE_BAR"):
        rollup.hour_rows([second_bar])

    misaligned = _minute(30 * 1_000_000_000, "100", "100", "100", "100", "1")
    with pytest.raises(rollup.RollupError, match="SOURCE_BAR_NOT_MINUTE_ALIGNED"):
        rollup.hour_rows([misaligned])


def test_two_instruments_are_never_folded_into_one_bar():
    minutes = [
        _minute(0, "100", "100", "100", "100", "1", symbol="38"),
        _minute(MINUTE, "200", "200", "200", "200", "1", symbol="39"),
    ]
    with pytest.raises(rollup.RollupError, match="HOUR_SPANS_MULTIPLE_SOURCE_SYMBOLS"):
        rollup.hour_rows(minutes)


def test_two_instruments_are_never_folded_into_one_daily_bar():
    minutes = [
        _minute(0, "100", "100", "100", "100", "1", symbol="38"),
        _minute(rollup.DAY_NS - MINUTE, "200", "200", "200", "200", "1", symbol="39"),
    ]
    with pytest.raises(rollup.RollupError, match="DAY_SPANS_MULTIPLE_SOURCE_SYMBOLS"):
        rollup.day_rows(minutes)


def test_a_price_that_cannot_round_trip_is_refused_rather_than_rounded():
    """Prices go back to fixed point for the mapping. Rounding here would put a
    wrong price in the archive that nothing downstream could detect."""
    assert rollup._fixed9_text(Decimal("231.46")) == "231460000000"
    with pytest.raises(rollup.RollupError, match="PRICE_NOT_REPRESENTABLE_AS_FIXED9"):
        rollup._fixed9_text(Decimal("0.0000000001"))


def test_a_fractional_volume_is_refused_rather_than_truncated():
    minute = _minute(0, "100", "100", "100", "100", "1.5")
    with pytest.raises(rollup.RollupError, match="VOLUME_NOT_REPRESENTABLE_AS_INTEGER"):
        rollup.hour_rows([minute])


_HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"
_MINUTES = [
    "1756800000000000000,32,2,38,231460000000,231800000000,231400000000,231700000000,21",
    "1756800060000000000,32,2,38,231700000000,232900000000,231100000000,232000000000,472",
]


def test_the_whole_hourly_rung_end_to_end(tmp_path):
    """One minute partition, published for real, rolled up through the same
    mapping every other bar uses, into a real hourly partition. This is the only
    test that proves the derived bar survives identity, validation and the
    writer's interval guard rather than just the arithmetic."""
    import convert
    import writer
    from bridge import ContractBridge

    source = tmp_path / "aapl.ohlcv-1m.csv"
    source.write_text("\n".join([_HEADER, *_MINUTES]) + "\n", encoding="utf-8")
    roots = {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }
    summary = convert.convert_file(
        str(source), "ohlcv-1m", "20260910T000000Z", dataset="XNAS.ITCH", symbol="AAPL",
        s3_key="raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1m/symbol=AAPL/y/aapl.csv", **roots)
    partition = summary["partitions"][0]
    assert "/candle_1m/" in partition

    import os
    minute_rows = rollup.read_minute_rows(
        [os.path.join(roots["curated_root"], partition, "part-00000.parquet")])
    assert len(minute_rows) == 2

    rows = rollup.hour_rows(minute_rows)
    assert len(rows) == 1
    assert rollup.total_volume(rows) == 493

    mappings = __import__("identity").build_csv_mappings(
        "XNAS.ITCH", "AAPL", {"38"}, reference=f"s3-key:{partition}")
    context = {
        "mappings": mappings, "dataset": "XNAS.ITCH", "sourceSymbol": "38",
        "population": "XNAS.ITCH:ohlcv-1h", "datasetVersion": "20260910T000000Z",
        "streamId": f"rollup:candle_1m:candle_1h", "schema": "ohlcv-1h",
        "ingestNs": "1789000000000000000",
        "lineage": {"object": f"curated://{partition}", "sha256": "0" * 64},
    }
    with ContractBridge(convert._WORKER) as bridge:
        results = bridge.map_batch(
            "rollup", "DATABENTO", "candle",
            [{"row": r, "position": i} for i, r in enumerate(rows)], context)
    records = [rec for r in results if r["ok"] for rec in r["records"]]
    assert len(records) == 1, [r.get("quarantine") for r in results if not r["ok"]]

    def amount(value):
        return Decimal(value["coefficient"]) / (Decimal(10) ** value["scale"])

    bar = records[0]["data"]
    assert int(bar["closeNs"]) - int(bar["openNs"]) == HOUR
    assert int(bar["openNs"]) == 1756800000000000000
    assert amount(bar["open"]) == Decimal("231.46")
    assert amount(bar["close"]) == Decimal("232.00")
    assert amount(bar["high"]) == Decimal("232.90")
    assert amount(bar["low"]) == Decimal("231.10")
    assert amount(bar["volume"]) == 493
    assert bar["closed"] is True

    pw = writer.PartitionWriter(str(tmp_path / "hourly"), records[0]["instrument"]["id"],
                                "candle_1h", "v1", "2025-09-02")
    assert pw.add(records[0])["accepted"] is True


def test_the_daily_rung_reaches_the_same_mapping_and_interval_guard(tmp_path):
    import convert
    import identity
    import writer
    from bridge import ContractBridge

    rows = rollup.day_rows([
        _minute(0, "100", "101", "99", "100", "1"),
        _minute(rollup.DAY_NS - MINUTE, "100", "110", "90", "105", "2"),
    ])
    context = {
        "mappings": identity.build_csv_mappings("XNAS.ITCH", "AAPL", {"38"}, reference="rollup"),
        "dataset": "XNAS.ITCH", "sourceSymbol": "38", "population": "XNAS.ITCH:ohlcv-1d",
        "datasetVersion": "v1", "streamId": "rollup:candle_1m:candle_1d", "schema": "ohlcv-1d",
        "ingestNs": "1789000000000000000", "lineage": {"object": "curated://minute", "sha256": "0" * 64},
    }
    with ContractBridge(convert._WORKER) as bridge:
        results = bridge.map_batch("daily", "DATABENTO", "candle",
                                   [{"row": row, "position": index} for index, row in enumerate(rows)], context)
    records = [record for result in results if result["ok"] for record in result["records"]]
    assert len(records) == 1
    assert int(records[0]["data"]["closeNs"]) - int(records[0]["data"]["openNs"]) == rollup.DAY_NS
    pw = writer.PartitionWriter(str(tmp_path / "daily"), records[0]["instrument"]["id"], "candle_1d", "v1", "1970-01-01")
    assert pw.add(records[0])["accepted"] is True
