"""Binance flow metrics on the archive candle row.

Binance's kline archives carry what Databento's OHLCV does not: how much of a
bar's volume was taken by aggressive buyers, how much money changed hands, and
how many trades composed it. Keeping it costs nothing at conversion and cannot
be recovered later without re-fetching a year of source data.

Two rules carry the weight. Null is not zero -- a Databento bar reporting `0`
aggressive buying would be asserting something false about the market. And
taker-sell is subtraction, so a source claiming taker-buy above total volume is
a corrupt row, not a row to clamp.
"""
from __future__ import annotations

import json
import pathlib
from decimal import Decimal

import pytest

import archive_query as aq
import writer

SCHEMA = (
    pathlib.Path(__file__).resolve().parents[4]
    / "docs/contracts/archive-query/v1/archive-query-v1.schema.json"
)


def _candle_row_schema():
    defs = json.loads(SCHEMA.read_text(encoding="utf-8"))["$defs"]
    return defs["candleRow"]["allOf"][1]


def _dec(text):
    return {"coefficient": str(text), "scale": 0}


def _candle_data(**overrides):
    base = {
        "openNs": "0", "closeNs": "60000000000",
        "open": _dec(100), "high": _dec(110), "low": _dec(90), "close": _dec(105),
        "volume": _dec(10), "buyVolume": None, "closed": True, "method": "x/1",
    }
    base.update(overrides)
    return base


def test_the_new_fields_are_declared_required_and_nullable():
    """The house pattern. Required so a consumer never has to distinguish absent
    from unknown; nullable so a source without the data says so."""
    schema = _candle_row_schema()
    for field in aq.CANDLE_SOURCE_METRIC_FIELDS:
        assert field in schema["required"], field
        spec = schema["properties"][field]
        ref = spec.get("$ref", "")
        assert ref.startswith("#/$defs/nullable"), (field, ref)


def test_the_python_field_list_matches_the_contract():
    """Bound to the schema rather than trusted, like every other operator-visible
    bound in this module."""
    schema = _candle_row_schema()
    declared = set(schema["required"]) - {
        "open_ns", "close_ns", "open", "high", "low", "close",
        "volume", "buy_volume", "closed", "method",
    }
    assert declared == set(aq.CANDLE_SOURCE_METRIC_FIELDS)


def test_every_candle_family_is_treated_as_a_candle():
    """A rung added to FAMILIES but forgotten here would serve rows missing the
    declared fields, which is precisely the gap this normalisation closes."""
    assert {f for f in aq.FAMILIES if f.startswith("candle")} == aq.CANDLE_FAMILIES
    assert aq.CANDLE_FAMILIES <= set(aq.WINDOW_LIMIT_NS)


def test_the_root_response_schema_selects_the_candle_row_for_every_candle_family():
    defs = json.loads(SCHEMA.read_text(encoding="utf-8"))["$defs"]
    candle_branch = defs["response"]["allOf"][2]
    assert set(candle_branch["if"]["properties"]["family"]["enum"]) == aq.CANDLE_FAMILIES
    assert candle_branch["then"]["properties"]["rows"]["items"]["$ref"] == "#/$defs/candleRow"


def test_a_partition_written_before_the_fields_existed_still_reports_them():
    """Rows are built from the columns their own file carries, so a partition
    published earlier simply lacks these keys. Absent and null are not the same
    thing to a consumer doing arithmetic."""
    old_row = {"event_ns": "1", "open": "100", "close": "105", "volume": "10"}
    filled = aq.with_declared_candle_fields("candle", [old_row])[0]
    for field in aq.CANDLE_SOURCE_METRIC_FIELDS:
        assert field in filled
        assert filled[field] is None
    assert filled["open"] == "100"


def test_a_row_that_already_carries_the_fields_is_untouched():
    row = {"event_ns": "1", "trade_count": "42", "quote_volume": "5",
           "taker_buy_quote_volume": "2", "taker_sell_base_volume": "1",
           "taker_sell_quote_volume": "3"}
    assert aq.with_declared_candle_fields("candle_1m", [row])[0] is row


def test_a_non_candle_family_is_left_alone():
    rows = [{"event_ns": "1", "price": "100"}]
    assert aq.with_declared_candle_fields("trade", rows) is rows


def test_a_databento_bar_reports_unavailable_rather_than_zero():
    """Databento OHLCV carries none of these. Writing 0 would claim no aggressive
    buying occurred, which is a statement about the market, not about coverage."""
    flat = writer._candle(_candle_data())
    for column in ("quote_volume", "taker_buy_quote_volume", "taker_sell_base_volume",
                   "taker_sell_quote_volume", "trade_count"):
        assert flat[column] is None, column


def test_a_binance_bar_carries_the_metrics_through_to_the_column():
    flat = writer._candle(_candle_data(
        buyVolume=_dec(6), quoteVolume=_dec(1050), takerBuyQuoteVolume=_dec(630),
        takerSellBaseVolume=_dec(4), takerSellQuoteVolume=_dec(420), tradeCount=37))
    assert Decimal(flat["buy_volume"]) == Decimal("6")
    assert Decimal(flat["quote_volume"]) == Decimal("1050")
    assert Decimal(flat["taker_buy_quote_volume"]) == Decimal("630")
    assert Decimal(flat["taker_sell_base_volume"]) == Decimal("4")
    assert Decimal(flat["taker_sell_quote_volume"]) == Decimal("420")
    assert flat["trade_count"] == 37


def test_the_writer_declares_a_column_for_every_contract_field():
    """A field declared in the contract but absent from the writer would be null
    on every row forever, with nothing reporting why."""
    for field in aq.CANDLE_SOURCE_METRIC_FIELDS:
        assert field in writer._FAMILY_COLUMNS["candle"], field


def test_trade_count_crosses_the_boundary_the_way_its_column_type_says():
    """BIGINT is stringified on the wire; the contract must agree or a consumer
    parses the wrong type."""
    import archive_reader
    assert writer._FAMILY_COLUMNS["candle"]["trade_count"] == "BIGINT"
    assert archive_reader._serialise(37, "BIGINT") == "37"
    spec = _candle_row_schema()["properties"]["trade_count"]
    assert spec["$ref"] == "#/$defs/nullableInteger64"
