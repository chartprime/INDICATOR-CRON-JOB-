"""Identity mapping build from DBN metadata."""
from __future__ import annotations

import os
import types

import pytest

import dbn
import identity

HERE = os.path.dirname(os.path.abspath(__file__))
MBP1 = os.path.normpath(os.path.join(HERE, "..", "..", "test", "contracts", "fixtures", "market-observation-v1", "databento-mbp1.dbn"))

SHA = "a" * 64


def _meta(**over):
    base = {"stype_in": "raw_symbol", "stype_out": "instrument_id", "dataset": "XNAS.ITCH",
            "mappings": {"AAPL": [{"start_date": "2025-09-06", "end_date": "2025-09-07", "symbol": "38"}]}}
    base.update(over)
    return types.SimpleNamespace(**base)


def test_day_ns_is_utc_midnight_since_epoch():
    assert identity.day_ns("1970-01-02") == str(86_400 * 1_000_000_000)
    assert int(identity.day_ns("2025-09-07")) > int(identity.day_ns("2025-09-06"))


def test_builds_a_futures_mapping_from_the_pinned_fixture_metadata():
    meta = dbn.read_metadata(MBP1)
    rows = identity.build_mappings(meta, SHA)
    assert len(rows) == 1
    row = rows[0]
    assert row["sourceSymbol"] == "5482"
    assert row["fromNs"] == identity.day_ns("2020-12-28")
    assert row["toNs"] == identity.day_ns("2020-12-29")
    assert row["instrument"] == {
        "venue": "XCME", "market": "FUTURE", "symbol": "ESH1", "contract": "ESH1",
        "currency": "USD", "sizeUnit": "CONTRACT",
    }
    assert row["reference"] == f"sha256:{SHA}:metadata"


def test_equity_mapping_has_no_contract():
    row = identity.build_mappings(_meta(), SHA)[0]
    assert row["instrument"]["market"] == "EQUITY"
    assert row["instrument"]["contract"] is None
    assert row["instrument"]["sizeUnit"] == "SHARE"


def test_continuous_input_requires_the_roll_table():
    with pytest.raises(identity.IdentityError, match="CONTINUOUS_REQUIRES_ROLL_TABLE"):
        identity.build_mappings(_meta(stype_in="continuous"), SHA)


def test_a_continuous_alias_in_the_mapping_table_is_refused():
    meta = _meta(dataset="GLBX.MDP3", mappings={"ES.n.0": [{"start_date": "2025-09-06", "end_date": "2025-12-19", "symbol": "1"}]})
    with pytest.raises(identity.IdentityError, match="CONTINUOUS_ALIAS_IN_MAPPINGS"):
        identity.build_mappings(meta, SHA)


@pytest.mark.parametrize("exchange,dataset", [("binance", "BINANCE.SPOT"), ("binance-futures", "BINANCE.UM")])
def test_a_tardis_trade_lands_on_the_same_instrument_as_the_served_binance_candles(exchange, dataset):
    tardis = identity.build_tardis_mappings(exchange, "BTCUSDT", "s3-key:x")[0]
    candles = identity.build_binance_mappings(dataset, "BTCUSDT", "s3-key:y")[0]
    assert identity.instrument_id(tardis["instrument"]) == identity.instrument_id(candles["instrument"])
    assert (tardis["provider"], tardis["dataset"], tardis["sourceSymbol"]) == ("TARDIS", exchange, "BTCUSDT")


def test_a_tardis_exchange_or_symbol_outside_the_binance_scope_is_refused():
    with pytest.raises(identity.IdentityError, match="UNSUPPORTED_TARDIS_EXCHANGE"):
        identity.build_tardis_mappings("bybit", "BTCUSDT", "r")
    with pytest.raises(identity.IdentityError, match="TARDIS_SYMBOL_CURRENCY_MISMATCH"):
        identity.build_tardis_mappings("binance-futures", "BTCUSD_PERP", "r")


def test_unknown_dataset_and_empty_interval_are_rejected():
    with pytest.raises(identity.IdentityError, match="UNSUPPORTED_DATASET"):
        identity.build_mappings(_meta(dataset="XBOG.SOMETHING"), SHA)
    with pytest.raises(identity.IdentityError, match="EMPTY_MAPPING_INTERVAL"):
        identity.build_mappings(_meta(mappings={"AAPL": [{"start_date": "2025-09-06", "end_date": "2025-09-06", "symbol": "38"}]}), SHA)
