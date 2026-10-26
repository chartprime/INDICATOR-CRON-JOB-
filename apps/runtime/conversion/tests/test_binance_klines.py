"""The Binance kline input path, against real archive bytes.

The fixtures are the first rows of the genuine September 2025 BTCUSDT monthly
klines from data.binance.vision, both checksum-verified against their published
.CHECKSUM on retrieval. They are kept because the two sources disagree in ways
no documentation states plainly:

  spot     no header row, timestamps in microseconds
  USDs-M   a header row,  timestamps in milliseconds

A decoder that assumed either shape corrupts the other silently -- skipping a
line on spot drops a real bar, and not skipping on futures parses the word
"open_time" as a price.
"""
from __future__ import annotations

import io
import os
import hashlib
import sqlite3
import zipfile
import datetime as dt
from decimal import Decimal
from pathlib import Path

import pytest

import convert
import binance_candle_backfill
import csv_decode
import identity
from bridge import ContractBridge

HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.normpath(os.path.join(HERE, "..", "..", "test", "contracts", "fixtures", "market-observation-v1"))
SPOT = os.path.join(FX, "binance-spot-klines-1m.zip")
UM = os.path.join(FX, "binance-um-klines-1m.zip")

MINUTE_NS = 60_000_000_000
HOUR_NS = 3_600_000_000_000
DAY_NS = 86_400_000_000_000


def _rows(path):
    return list(csv_decode.kline_rows(path))


def _zip_of(text, name="x.csv", extra=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(name, text)
        if extra is not None:
            archive.writestr("second.csv", extra)
    return buffer


def _written(tmp_path, text, name="x.csv", extra=None):
    path = tmp_path / "k.zip"
    path.write_bytes(_zip_of(text, name, extra).getvalue())
    return str(path)


def _kline(open_time, interval, *, close_time=None):
    close_time = open_time + interval - 1 if close_time is None else close_time
    return f"{open_time},1,1,1,1,1,{close_time},1,1,1,1,0"


def _month_window(year, month):
    start = dt.datetime(year, month, 1, tzinfo=dt.timezone.utc)
    end = dt.datetime(year + (month == 12), month % 12 + 1, 1, tzinfo=dt.timezone.utc)
    return int(start.timestamp() * 1_000_000_000), int(end.timestamp() * 1_000_000_000)


def _complete_daily_month(tmp_path, year, month):
    start, end = _month_window(year, month)
    unit = DAY_NS // 1_000_000
    body = "\n".join(_kline((start + offset * DAY_NS) // 1_000_000, unit)
                     for offset in range((end - start) // DAY_NS)) + "\n"
    path = tmp_path / f"{year}-{month:02d}.zip"
    path.write_bytes(_zip_of(body).getvalue())
    return path


def _sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_spot_has_no_header_and_futures_does(tmp_path):
    """Both are read correctly without being told which is which."""
    spot, um = _rows(SPOT), _rows(UM)
    assert len(spot) == 6, "spot's first line is a bar, not a header"
    assert len(um) == 5, "futures' first line is a header and is not a bar"
    for index, row in spot + um:
        assert row["open_time"].isdigit()
        assert row["open_time"] != "open_time"


def test_the_timestamp_unit_is_proven_by_the_bar_span_not_guessed():
    """Close times are inclusive, so a one-minute bar spans 59,999,999 in
    microseconds and 59,999 in milliseconds. That is an assertion; reading the
    magnitude of the number would be a guess."""
    assert csv_decode.kline_timestamp_unit(_rows(SPOT)[0][1], MINUTE_NS) == "us"
    assert csv_decode.kline_timestamp_unit(_rows(UM)[0][1], MINUTE_NS) == "ms"


def test_a_span_that_matches_no_known_unit_is_refused():
    row = dict(_rows(UM)[0][1])
    with pytest.raises(csv_decode.CsvError, match="KLINE_INTERVAL_UNRECOGNISED"):
        csv_decode.kline_timestamp_unit(row, HOUR_NS)


def test_a_complete_month_is_proven_before_any_row_is_admitted(tmp_path):
    start, end = _month_window(2025, 9)
    unit = DAY_NS // 1_000_000
    body = "\n".join(_kline((start + offset * DAY_NS) // 1_000_000, unit)
                     for offset in range((end - start) // DAY_NS)) + "\n"
    rows = list(csv_decode.validated_kline_month_rows(
        _written(tmp_path, body), interval_ns=DAY_NS, start_ns=start, end_ns=end,
    ))
    assert len(rows) == 30


def test_a_gap_or_duplicate_in_a_month_is_refused_before_conversion(tmp_path):
    start, end = _month_window(2025, 9)
    unit = DAY_NS // 1_000_000
    body = "\n".join([
        _kline(start // 1_000_000, unit),
        _kline((start + 2 * DAY_NS) // 1_000_000, unit),
    ]) + "\n"
    with pytest.raises(csv_decode.CsvError, match="KLINE_MONTH_NONCONTIGUOUS"):
        list(csv_decode.validated_kline_month_rows(
            _written(tmp_path, body), interval_ns=DAY_NS, start_ns=start, end_ns=end,
        ))


def test_an_off_grid_kline_is_refused_before_conversion(tmp_path):
    start, end = _month_window(2025, 9)
    unit = DAY_NS // 1_000_000
    body = _kline(start // 1_000_000 + 1, unit) + "\n"
    with pytest.raises(csv_decode.CsvError, match="KLINE_OPEN_NOT_UTC_GRID_ALIGNED"):
        list(csv_decode.validated_kline_month_rows(
            _written(tmp_path, body), interval_ns=DAY_NS, start_ns=start, end_ns=end,
        ))


def test_a_header_that_is_not_the_expected_one_is_refused(tmp_path):
    bad = "open_time,open,high,low,close\n1,2,3,4,5\n"
    with pytest.raises(csv_decode.CsvError, match="KLINE_CSV_HEADER_MISMATCH"):
        _rows(_written(tmp_path, bad))


@pytest.mark.parametrize("body,expected", [
    ("1,2,3,4,5\n", "RAGGED_KLINE_ROW"),
    ("1,2,3,4,5,6,7,8,9,10,11,12\n1,2,3\n", "RAGGED_KLINE_ROW"),
    ("1,2,,4,5,6,7,8,9,10,11,12\n", "EMPTY_KLINE_FIELD"),
    ("", "EMPTY_KLINE_CSV"),
])
def test_a_malformed_member_is_refused(tmp_path, body, expected):
    with pytest.raises(csv_decode.CsvError, match=expected):
        _rows(_written(tmp_path, body))


def test_an_archive_that_is_not_one_file_is_refused(tmp_path):
    """Every real monthly object holds exactly one CSV. More than one means the
    object is not what we think it is, and picking one would be a guess."""
    good = "1,2,3,4,5,6,7,8,9,10,11,12\n"
    with pytest.raises(csv_decode.CsvError, match="KLINE_ZIP_MEMBER_COUNT"):
        _rows(_written(tmp_path, good, extra=good))


def test_spot_and_perpetual_are_permanently_different_instruments():
    """The locked non-negotiable, asserted rather than assumed."""
    spot = identity.build_binance_mappings("BINANCE.SPOT", "BTCUSDT", "s3-key:x")[0]
    perp = identity.build_binance_mappings("BINANCE.UM", "BTCUSDT", "s3-key:x")[0]
    assert identity.instrument_id(spot["instrument"]) != identity.instrument_id(perp["instrument"])
    assert spot["instrument"]["market"] == "SPOT"
    assert perp["instrument"]["market"] == "PERPETUAL"
    assert spot["instrument"]["contract"] is None and perp["instrument"]["contract"] is None


def test_a_product_that_does_not_settle_in_the_dataset_currency_is_refused():
    """Currency is a dataset property here. A BTC-quoted pair labelled USDT
    would be wrong permanently, because instrument_id includes the currency."""
    with pytest.raises(identity.IdentityError, match="BINANCE_SYMBOL_CURRENCY_MISMATCH"):
        identity.build_binance_mappings("BINANCE.SPOT", "ETHBTC", "s3-key:x")
    with pytest.raises(identity.IdentityError, match="NOT_A_BINANCE_DATASET"):
        identity.build_binance_mappings("XNAS.ITCH", "AAPL", "s3-key:x")


def _map(path, dataset, schema="klines-1m", limit=3):
    rows = [{"row": r, "position": i} for i, r in csv_decode.kline_rows(path)][:limit]
    context = {
        "mappings": identity.build_binance_mappings(dataset, "BTCUSDT", "s3-key:probe"),
        "dataset": dataset, "sourceSymbol": "BTCUSDT", "population": f"{dataset}:{schema}",
        "datasetVersion": "w606-binance-v1", "streamId": f"binance:{dataset}:{schema}",
        "schema": schema, "ingestNs": "1789000000000000000",
        "lineage": {"object": "https://data.binance.vision/x.zip", "sha256": "0" * 64},
    }
    with ContractBridge(convert._WORKER) as bridge:
        return bridge.map_batch("b", "BINANCE", "candle", rows, context)


def _amount(value):
    return Decimal(value["coefficient"]) / (Decimal(10) ** value["scale"])


@pytest.mark.parametrize("path,dataset,market", [
    (SPOT, "BINANCE.SPOT", "SPOT"),
    (UM, "BINANCE.UM", "PERPETUAL"),
])
def test_both_sources_normalise_to_the_same_bar_shape(path, dataset, market):
    """Different clocks in, one canonical nanosecond bar out."""
    results = _map(path, dataset)
    failed = [r.get("quarantine") for r in results if not r["ok"]]
    assert not failed, failed
    record = [x for r in results for x in r["records"]][0]
    assert record["instrument"]["market"] == market
    bar = record["data"]
    assert int(bar["closeNs"]) - int(bar["openNs"]) == MINUTE_NS
    assert bar["closed"] is True
    assert bar["method"] == "binance-klines-1m/1"
    assert _amount(bar["takerSellBaseVolume"]) == _amount(bar["volume"]) - _amount(bar["buyVolume"])
    assert _amount(bar["takerSellQuoteVolume"]) == (
        _amount(bar["quoteVolume"]) - _amount(bar["takerBuyQuoteVolume"]))
    assert int(bar["tradeCount"]) > 0


def test_the_partition_family_follows_the_kline_interval():
    assert convert._partition_family_for("candle", "klines-1m") == "candle_1m"
    assert convert._partition_family_for("candle", "klines-1h") == "candle_1h"
    assert convert._partition_family_for("candle", "klines-1d") == "candle_1d"


@pytest.mark.parametrize("field,reason", [
    ("quote_volume", "NEGATIVE_QUOTE_VOLUME"),
    ("taker_buy_quote_volume", "NEGATIVE_TAKER_BUY_QUOTE_VOLUME"),
    ("count", "NEGATIVE_TRADE_COUNT"),
])
def test_negative_quote_metrics_are_quarantined(field, reason):
    row = dict(_rows(UM)[0][1])
    row[field] = "-1"
    context = {
        "mappings": identity.build_binance_mappings("BINANCE.UM", "BTCUSDT", "s3-key:probe"),
        "dataset": "BINANCE.UM", "sourceSymbol": "BTCUSDT", "population": "BINANCE.UM:klines-1m",
        "datasetVersion": "v1", "streamId": "binance:BINANCE.UM:klines-1m", "schema": "klines-1m",
        "ingestNs": "1789000000000000000", "lineage": {"object": "s3://raw/binance/x.zip", "sha256": "0" * 64},
    }
    with ContractBridge(convert._WORKER) as bridge:
        result = bridge.map_batch("negative", "BINANCE", "candle", [{"row": row, "position": 0}], context)[0]
    assert result["ok"] is False
    assert result["quarantine"]["reason"] == reason


def test_a_trade_count_that_cannot_fit_the_archive_column_is_quarantined():
    row = dict(_rows(UM)[0][1])
    row["count"] = str(2 ** 63)
    context = {
        "mappings": identity.build_binance_mappings("BINANCE.UM", "BTCUSDT", "s3-key:probe"),
        "dataset": "BINANCE.UM", "sourceSymbol": "BTCUSDT", "population": "BINANCE.UM:klines-1m",
        "datasetVersion": "v1", "streamId": "binance:BINANCE.UM:klines-1m", "schema": "klines-1m",
        "ingestNs": "1789000000000000000", "lineage": {"object": "s3://raw/binance/x.zip", "sha256": "0" * 64},
    }
    with ContractBridge(convert._WORKER) as bridge:
        result = bridge.map_batch("large-count", "BINANCE", "candle", [{"row": row, "position": 0}], context)[0]
    assert result["ok"] is False
    assert result["quarantine"]["reason"] == "TRADE_COUNT_OUT_OF_RANGE"


def test_an_off_grid_kline_is_also_quarantined_at_the_contract_boundary():
    row = dict(_rows(UM)[0][1])
    row["open_time"] = str(int(row["open_time"]) + 1)
    row["close_time"] = str(int(row["close_time"]) + 1)
    context = {
        "mappings": identity.build_binance_mappings("BINANCE.UM", "BTCUSDT", "s3-key:probe"),
        "dataset": "BINANCE.UM", "sourceSymbol": "BTCUSDT", "population": "BINANCE.UM:klines-1m",
        "datasetVersion": "v1", "streamId": "binance:BINANCE.UM:klines-1m", "schema": "klines-1m",
        "ingestNs": "1789000000000000000", "lineage": {"object": "s3://raw/binance/x.zip", "sha256": "0" * 64},
    }
    with ContractBridge(convert._WORKER) as bridge:
        result = bridge.map_batch("off-grid", "BINANCE", "candle", [{"row": row, "position": 0}], context)[0]
    assert result["ok"] is False
    assert result["quarantine"]["reason"] == "BINANCE_KLINE_NOT_UTC_GRID_ALIGNED"


def test_a_kline_schema_is_not_admitted_to_the_databento_converter():
    """_OHLCV_SCHEMAS gates the Databento DBN and CSV paths. A Binance schema
    reaching them would be decoded with the wrong column set."""
    assert "klines-1m" not in convert._OHLCV_SCHEMAS
    assert "klines-1h" not in convert._OHLCV_SCHEMAS


def test_a_partial_month_never_reaches_a_binance_partition_through_the_real_converter(tmp_path):
    roots = {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }
    with pytest.raises(csv_decode.CsvError, match="KLINE_MONTH_INCOMPLETE"):
        convert.convert_file(
            SPOT, "klines-1m", "v1", dataset="BINANCE.SPOT", symbol="BTCUSDT",
            s3_key="raw/binance/spot/BTCUSDT/1m/2025-09.zip",
            expected_sha256=_sha256_file(Path(SPOT)), **roots)
    assert not (tmp_path / "curated" / "binance").exists()


@pytest.mark.parametrize("s3_key,expected", [
    ("raw/databento/BTCUSDT.zip", "BINANCE_KLINE_SOURCE_KEY_INVALID"),
    ("raw/binance/BTCUSDT.csv", "KLINE_SOURCE_MUST_BE_ZIP"),
])
def test_a_kline_cannot_be_mislabeled_as_a_databento_source(tmp_path, s3_key, expected):
    roots = {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }
    source = SPOT if s3_key.endswith(".zip") else os.path.join(tmp_path, "BTCUSDT.csv")
    if source.endswith(".csv"):
        with open(source, "wb") as handle:
            handle.write(b"not-a-zip")
    with pytest.raises(convert.ConversionError, match=expected):
        convert.convert_file(source, "klines-1m", "v1", dataset="BINANCE.SPOT", symbol="BTCUSDT",
                             s3_key=s3_key, expected_sha256=_sha256_file(Path(source)),
                             **roots)


def test_a_direct_binance_conversion_cannot_bypass_the_source_checksum(tmp_path):
    roots = {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }
    with pytest.raises(convert.ConversionError, match="BINANCE_SOURCE_SHA256_REQUIRED"):
        convert.convert_file(SPOT, "klines-1m", "v1", dataset="BINANCE.SPOT", symbol="BTCUSDT",
                             s3_key="raw/binance/spot/BTCUSDT/1m/2025-09.zip", **roots)


@pytest.mark.parametrize("dataset,symbol,schema,s3_key,expected", [
    ("BINANCE.UM", "BTCUSDT", "klines-1m", "raw/binance/spot/BTCUSDT/1m/2025-09.zip",
     "BINANCE_KLINE_DATASET_KEY_MISMATCH"),
    ("BINANCE.SPOT", "ETHUSDT", "klines-1m", "raw/binance/spot/BTCUSDT/1m/2025-09.zip",
     "BINANCE_KLINE_SYMBOL_KEY_MISMATCH"),
    ("BINANCE.SPOT", "BTCUSDT", "klines-1h", "raw/binance/spot/BTCUSDT/1m/2025-09.zip",
     "BINANCE_KLINE_INTERVAL_KEY_MISMATCH"),
])
def test_the_binance_object_key_is_bound_to_the_claimed_identity(dataset, symbol, schema, s3_key, expected):
    with pytest.raises(convert.ConversionError, match=expected):
        convert._binance_kline_month(s3_key, dataset, symbol, schema)


def test_a_checksum_addressed_raw_candidate_keeps_the_calendar_identity():
    source = "a" * 64
    interval, start, end = convert._binance_kline_month(
        f"raw/binance/spot/BTCUSDT/1m/2025-09/{source}.zip",
        "BINANCE.SPOT", "BTCUSDT", "klines-1m",
    )
    assert interval == MINUTE_NS
    assert (start, end) == _month_window(2025, 9)
    assert convert._binance_candidate_sha256(
        f"raw/binance/spot/BTCUSDT/1m/2025-09/{source}.zip") == source


def test_a_checksum_addressed_raw_candidate_must_name_the_verified_bytes():
    with pytest.raises(convert.ConversionError, match="BINANCE_SOURCE_KEY_SHA256_MISMATCH"):
        convert._source_spec({
            "source_path": SPOT,
            "schema": "klines-1m",
            "dataset": "BINANCE.SPOT",
            "symbol": "BTCUSDT",
            "s3_key": f"raw/binance/spot/BTCUSDT/1m/2025-09/{'0' * 64}.zip",
            "expected_sha256": _sha256_file(Path(SPOT)),
        })


def test_a_source_receipt_is_preserved_in_conversion_lineage():
    sha = _sha256_file(Path(SPOT))
    key = f"raw/binance/spot/BTCUSDT/1m/2025-09/{sha}.zip"
    source = convert._source_spec({
        "source_path": SPOT,
        "schema": "klines-1m",
        "dataset": "BINANCE.SPOT",
        "symbol": "BTCUSDT",
        "s3_key": key,
        "expected_sha256": sha,
        "source_delivered_at": "2026-09-15T00:00:00+00:00",
        "source_receipt_key": key + ".receipt.json",
    })
    assert source["source_object"]["source_delivered_at"] == "2026-09-15T00:00:00+00:00"
    assert source["source_object"]["source_receipt_key"] == key + ".receipt.json"


def test_a_source_delivery_time_must_be_an_aware_timestamp():
    sha = _sha256_file(Path(SPOT))
    with pytest.raises(convert.ConversionError, match="INVALID_SOURCE_DELIVERED_AT"):
        convert._source_spec({
            "source_path": SPOT,
            "schema": "klines-1m",
            "dataset": "BINANCE.SPOT",
            "symbol": "BTCUSDT",
            "s3_key": f"raw/binance/spot/BTCUSDT/1m/2025-09/{sha}.zip",
            "expected_sha256": sha,
            "source_delivered_at": "2026-09-15T00:00:00",
        })


def test_verified_months_share_one_catalog_but_keep_exact_source_lineage(tmp_path):
    september = _complete_daily_month(tmp_path, 2025, 9)
    october = _complete_daily_month(tmp_path, 2025, 10)
    sources = [
        {
            "source_path": str(path), "schema": "klines-1d", "dataset": "BINANCE.SPOT", "symbol": "BTCUSDT",
            "s3_key": f"raw/binance/spot/BTCUSDT/1d/2025-{month:02d}.zip",
            "expected_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path, month in ((september, 9), (october, 10))
    ]
    roots = {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }
    summary = binance_candle_backfill.convert_months(sources, "v1", **roots)

    assert summary["accepted"] == 61
    assert len(summary["partitions"]) == 61
    with sqlite3.connect(tmp_path / "curated" / "_catalog" / summary["catalog_pointer"]["catalog_key"]) as con:
        assert con.execute("SELECT count(*), min(provider), max(provider) FROM partitions").fetchone() == (
            61, "binance", "binance"
        )
    september_manifest = next((tmp_path / "curated").glob("binance/*/candle_1d/v1/2025-09-01/_manifest.json"))
    source_objects = __import__("json").loads(september_manifest.read_text(encoding="utf-8"))["source_objects"]
    assert source_objects == [{
        "s3_key": "raw/binance/spot/BTCUSDT/1d/2025-09.zip",
        "sha256": hashlib.sha256(september.read_bytes()).hexdigest(),
        "bytes": september.stat().st_size,
        "local_file_mtime": source_objects[0]["local_file_mtime"],
        "source_delivered_at": None,
    }]


def test_a_binance_batch_refuses_a_changed_or_duplicate_source_before_conversion(tmp_path):
    source = _complete_daily_month(tmp_path, 2025, 9)
    common = {
        "source_path": str(source), "schema": "klines-1d", "dataset": "BINANCE.SPOT", "symbol": "BTCUSDT",
        "s3_key": "raw/binance/spot/BTCUSDT/1d/2025-09.zip",
        "expected_sha256": "0" * 64,
    }
    with pytest.raises(binance_candle_backfill.BinanceBackfillError, match="BINANCE_SOURCE_SHA256_MISMATCH"):
        binance_candle_backfill._checked_sources([common])
    common["expected_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
    with pytest.raises(binance_candle_backfill.BinanceBackfillError, match="DUPLICATE_BINANCE_SOURCE_MONTH"):
        binance_candle_backfill._checked_sources([common, dict(common, s3_key="raw/binance/spot/BTCUSDT/1d/2025-09.zip")])


def test_a_month_that_mixes_microsecond_and_millisecond_rows_is_refused(tmp_path):
    start, end = _month_window(2025, 9)
    rows = [
        _kline(start // 1_000, DAY_NS // 1_000),
        _kline((start + DAY_NS) // 1_000_000, DAY_NS // 1_000_000),
    ]
    with pytest.raises(csv_decode.CsvError, match="MIXED_KLINE_TIMESTAMP_UNITS"):
        list(csv_decode.validated_kline_month_rows(
            _written(tmp_path, "\n".join(rows) + "\n"), interval_ns=DAY_NS, start_ns=start, end_ns=end,
        ))
