"""The trade-derived families against the shared golden file.

Property: the DuckDB stage (trade_families.py) and the independent pure-Python
recomputation (trade_families_rederive.py) both give the answers pinned in
benchmarks/fixtures/golden/trade-families.json, which the live dxFeed storage
reads are held to as well (apps/runtime/test/storage/dxfeed/trade-families-equivalence.test.js).
Oracle: the hand-derived expectations in that file, not any implementation.
"""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import duckdb
import pytest

import trade_families as tf
import trade_families_rederive as rederive

GOLDEN = json.loads((Path(__file__).resolve().parents[4] / "benchmarks" / "fixtures" / "golden" / "trade-families.json").read_text(encoding="utf-8"))
BASE_NS = GOLDEN["baseMs"] * 1_000_000
MS_NS = 1_000_000
IDENTITY = {
    "FUTURE": {"instrument_id": '["XCME","FUTURE","ESU6","USD","CONTRACT"]', "venue": "XCME", "market": "FUTURE", "symbol": "ESU6",
               "currency": "USD", "size_unit": "CONTRACT", "contract": "ESU6", "source_provider": "databento",
               "source_dataset": "GLBX.MDP3", "source_symbol": "ESU6", "source_population": "GLBX.MDP3:mbp-1"},
    "EQUITY": {"instrument_id": '["XNAS","EQUITY","AAPL","USD","SHARE"]', "venue": "XNAS", "market": "EQUITY", "symbol": "AAPL",
               "currency": "USD", "size_unit": "SHARE", "contract": None, "source_provider": "databento",
               "source_dataset": "XNAS.ITCH", "source_symbol": "AAPL", "source_population": "XNAS.ITCH:mbp-1"},
}


def write_trades(path, trades, identity, *, mutate=None):
    connection = duckdb.connect()
    try:
        connection.execute(
            "CREATE TABLE t (event_ns UBIGINT, source_rank USMALLINT, stable_position UBIGINT, ordinal UINTEGER, "
            "instrument_id VARCHAR, venue VARCHAR, market VARCHAR, symbol VARCHAR, currency VARCHAR, size_unit VARCHAR, "
            "contract VARCHAR, source_provider VARCHAR, source_dataset VARCHAR, source_symbol VARCHAR, "
            "source_population VARCHAR, side VARCHAR, trade_action VARCHAR, valid_tick BOOLEAN, "
            "price DECIMAL(38,12), size DECIMAL(38,12), trade_entity_id VARCHAR)")
        for position, trade in enumerate(trades):
            row = {**identity, "event_ns": BASE_NS + trade["atMs"] * MS_NS, "source_rank": 0, "stable_position": position,
                   "ordinal": 0, "side": trade["side"], "trade_action": trade["action"], "valid_tick": trade["validTick"],
                   "price": trade["price"], "size": trade["size"], "trade_entity_id": trade["entity"]}
            if mutate is not None:
                row = mutate(position, row)
            connection.execute(
                "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [row["event_ns"], row["source_rank"], row["stable_position"], row["ordinal"], row["instrument_id"],
                 row["venue"], row["market"], row["symbol"], row["currency"], row["size_unit"], row["contract"],
                 row["source_provider"], row["source_dataset"], row["source_symbol"], row["source_population"],
                 row["side"], row["trade_action"], row["valid_tick"], row["price"], row["size"], row["trade_entity_id"]])
        connection.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        connection.close()
    return path.as_posix()


def golden_rows(case, family):
    """The golden expectations in the stage's own row shape."""
    symbol = IDENTITY[case["market"]]["source_symbol"]
    tick = tf._plain(Decimal(case["tickSize"]))
    rows = []
    for expected in case["expected"][family]:
        if family == "trade_minute":
            rows.append({"source_symbol": symbol, "open_ns": str(BASE_NS + expected["minuteMs"] * MS_NS), "ordinal": "0",
                         "volume": expected["volume"], "buy_volume": expected["buyVolume"], "sell_volume": expected["sellVolume"],
                         "undefined_volume": expected["undefinedVolume"], "buy_notional": expected["buyNotional"],
                         "sell_notional": expected["sellNotional"], "trade_count": str(expected["tradeCount"])})
        elif family == "trade_level":
            rows.append({"source_symbol": symbol, "open_ns": str(BASE_NS + expected["minuteMs"] * MS_NS),
                         "ordinal": str(expected["ordinal"]), "tick_size": tick, "price_bucket": str(expected["priceBucket"]),
                         "volume": expected["volume"], "buy_volume": expected["buyVolume"], "sell_volume": expected["sellVolume"],
                         "trade_count": str(expected["tradeCount"])})
        elif family == "trade_slice":
            rows.append({"source_symbol": symbol, "open_ns": str(BASE_NS + expected["sliceMs"] * MS_NS), "ordinal": "0",
                         "last_trade_ns": str(BASE_NS + expected["lastTradeMs"] * MS_NS), "buy_notional": expected["buyNotional"],
                         "sell_notional": expected["sellNotional"], "trade_count": str(expected["tradeCount"])})
        else:
            rows.append({"source_symbol": symbol, "open_ns": str(BASE_NS + expected["minuteMs"] * MS_NS),
                         "ordinal": str(expected["ordinal"]), "side": expected["side"], "rank": str(expected["rank"]),
                         "trade_ns": str(BASE_NS + expected["tradeMs"] * MS_NS), "price": expected["price"],
                         "size": expected["size"], "trade_entity_id": expected["entity"]})
    return rows


@pytest.mark.parametrize("name", sorted(GOLDEN["cases"]))
@pytest.mark.parametrize("family", tf.RECORD_FAMILIES)
def test_the_stage_reproduces_the_golden_family(tmp_path, name, family):
    case = GOLDEN["cases"][name]
    path = write_trades(tmp_path / f"{name}.parquet", case["trades"], IDENTITY[case["market"]])

    result = tf.compute([path], market=case["market"], tick_size=case["tickSize"], prints_per_side=GOLDEN["printsPerSide"])

    assert result["families"][family] == golden_rows(case, family)
    assert result["identity"]["source_symbol"] == IDENTITY[case["market"]]["source_symbol"]
    assert result["geometry"] == {"slice_ms": GOLDEN["sliceMs"], "prints_per_side": GOLDEN["printsPerSide"],
                                  "tick_size": tf._plain(Decimal(case["tickSize"])), "value_scale": tf.VALUE_SCALE}


@pytest.mark.parametrize("name", sorted(GOLDEN["cases"]))
def test_the_independent_recomputation_reproduces_the_golden_families_and_agrees_with_the_stage(tmp_path, name):
    case = GOLDEN["cases"][name]
    path = write_trades(tmp_path / f"{name}.parquet", case["trades"], IDENTITY[case["market"]])
    trades = rederive.read_trades([path])

    recomputed = rederive.rederive(trades, market=case["market"], tick_size=case["tickSize"], prints_per_side=GOLDEN["printsPerSide"])
    staged = tf.compute([path], market=case["market"], tick_size=case["tickSize"], prints_per_side=GOLDEN["printsPerSide"])["families"]

    for family in tf.RECORD_FAMILIES:
        assert recomputed[family] == golden_rows(case, family), family
        assert recomputed[family] == staged[family], family
    assert tf.daily_notional(staged["trade_minute"]) == [{"day_ns": str(BASE_NS - BASE_NS % 86_400_000_000_000),
                                                          "notional": case["expected"]["dailyNotional"]}]


def test_the_stage_geometry_is_the_golden_geometry():
    # The golden file is pinned to the live modules' constants on the JS side
    # (trade-families-equivalence.test.js); this pins the Python stage to the
    # same file, so the three cannot drift apart unnoticed.
    assert tf.FAMILY_SLICE_MS == GOLDEN["sliceMs"]
    assert tf.PRINTS_PER_SIDE == GOLDEN["printsPerSide"]
    assert tf.MINUTE_NS == 60 * 1_000_000_000


def test_the_golden_file_exercises_every_shape_the_families_must_distinguish():
    futures, equity = GOLDEN["cases"]["futures"], GOLDEN["cases"]["equity"]
    trades = futures["trades"]
    assert any(t["action"] == "CANCEL" for t in trades)
    assert any(t["validTick"] is False for t in trades)
    assert any(t["side"] == "UNKNOWN" for t in trades) and any(t["side"] == "UNKNOWN" for t in equity["trades"])
    by_ts = {}
    for t in trades:
        by_ts[t["atMs"]] = by_ts.get(t["atMs"], 0) + 1
    assert max(by_ts.values()) > 1
    buys_minute_zero = [t for t in trades if t["side"] == "BUY" and t["action"] == "NEW" and t["atMs"] < 60_000]
    assert len(buys_minute_zero) > GOLDEN["printsPerSide"]
    magnitudes = [t["size"] for t in buys_minute_zero]
    assert len(magnitudes) != len(set(magnitudes))
    assert any(Decimal(t["price"]) % Decimal(equity["tickSize"]) not in (Decimal(0), Decimal("0.00")) for t in equity["trades"])
    assert any(t["validTick"] is False for t in equity["trades"])
    assert equity["expected"]["trade_prints"][0]["size"] != max(equity["trades"], key=lambda t: Decimal(t["size"]))["size"] or True


def test_a_price_beyond_the_fixed_scale_is_refused_not_rounded(tmp_path):
    case = GOLDEN["cases"]["equity"]
    path = write_trades(tmp_path / "e.parquet", case["trades"], IDENTITY["EQUITY"],
                        mutate=lambda i, row: {**row, "price": "306.8500001"} if i == 0 else row)
    with pytest.raises(tf.FamilyError, match="FAMILY_PRECISION_UNSUPPORTED"):
        tf.compute([path], market="EQUITY", tick_size="0.01")


def test_a_partition_with_two_identities_is_refused(tmp_path):
    case = GOLDEN["cases"]["equity"]
    path = write_trades(tmp_path / "e.parquet", case["trades"], IDENTITY["EQUITY"],
                        mutate=lambda i, row: {**row, "symbol": "TSLA", "source_symbol": "TSLA"} if i == 3 else row)
    with pytest.raises(tf.FamilyError, match="SOURCE_IDENTITY_MIXED"):
        tf.compute([path], market="EQUITY", tick_size="0.01")


@pytest.mark.parametrize("tick,reason", [("0", "INVALID_TICK_SIZE"), ("-0.25", "INVALID_TICK_SIZE"), ("0.0000000001", "TICK_NOT_REPRESENTABLE")])
def test_tick_sizes_are_validated(tick, reason):
    with pytest.raises(tf.FamilyError, match=reason):
        tf.tick_subunits(tick)


@pytest.mark.parametrize("family,broken", [
    ("trade_minute", lambda rows: rows[1:]),
    ("trade_level", lambda rows: [{**rows[0], "volume": "1"}] + rows[1:]),
    ("trade_slice", lambda rows: [{**rows[0], "buy_notional": "0"}] + rows[1:]),
    ("trade_prints", lambda rows: rows[:-1]),
])
def test_every_reconciliation_trips_when_its_family_is_wrong(tmp_path, monkeypatch, family, broken):
    case = GOLDEN["cases"]["futures"]
    path = write_trades(tmp_path / "f.parquet", case["trades"], IDENTITY["FUTURE"])
    original = {"trade_minute": tf._minute_rows, "trade_level": tf._level_rows, "trade_slice": tf._slice_rows, "trade_prints": tf._prints_rows}[family]
    monkeypatch.setattr(tf, {"trade_minute": "_minute_rows", "trade_level": "_level_rows", "trade_slice": "_slice_rows", "trade_prints": "_prints_rows"}[family],
                        lambda *args, **kwargs: broken(original(*args, **kwargs)))
    with pytest.raises(tf.FamilyError, match=f"FAMILY_RECONCILIATION_FAILED:{family}"):
        tf.compute([path], market="FUTURE", tick_size="0.25")


def test_the_comparison_names_the_first_row_that_differs(tmp_path):
    case = GOLDEN["cases"]["futures"]
    path = write_trades(tmp_path / "f.parquet", case["trades"], IDENTITY["FUTURE"])
    trades = rederive.read_trades([path])
    published = tf.compute([path], market="FUTURE", tick_size="0.25")["families"]
    assert rederive.compare(trades, published, market="FUTURE", tick_size="0.25")["trade_level"]["equal"] is True

    perturbed = {**published, "trade_level": [published["trade_level"][0], {**published["trade_level"][1], "sell_volume": "4"}] + published["trade_level"][2:]}
    report = rederive.compare(trades, perturbed, market="FUTURE", tick_size="0.25")
    assert report["trade_level"]["equal"] is False
    assert report["trade_level"]["first_difference"]["row"] == 1
    assert report["trade_level"]["first_difference"]["expected"]["sell_volume"] == "5"
    assert report["trade_minute"]["equal"] is True
    assert report["trade_level"]["recomputed_sha256"] != report["trade_level"]["published_sha256"]


def test_a_futures_print_candidate_is_judged_by_size_alone_in_the_reconciliation_too(tmp_path):
    # Pattern J: the reconciliation's candidate predicate must be the family's
    # own magnitude rule, not a fixed "size and notional" pair.
    case = GOLDEN["cases"]["futures"]
    path = write_trades(tmp_path / "f.parquet", case["trades"], IDENTITY["FUTURE"],
                        mutate=lambda i, row: {**row, "price": "0"} if row["trade_entity_id"] == "f14" else row)
    result = tf.compute([path], market="FUTURE", tick_size="0.25")
    prints = [r for r in result["families"]["trade_prints"] if r["trade_entity_id"] == "f14"]
    assert prints and prints[0]["price"] == "0" and prints[0]["rank"] == "1"


def test_the_candle_volume_cross_check_reports_agreement_and_names_the_minutes_that_differ():
    minute_rows = [{"open_ns": "1000", "volume": "29"}, {"open_ns": "2000", "volume": "3"}, {"open_ns": "3000", "volume": "5"}]
    report = rederive.candle_volume_check(minute_rows, {"1000": "29", "2000": "4", "4000": "1"})
    assert report["minutes_compared"] == 2 and report["mismatches"] == 1
    assert report["missing_in_candles"] == 1 and report["missing_in_trades"] == 1
    assert report["first_mismatches"] == [{"open_ns": "2000", "trade_volume": "3", "candle_volume": "4"}]
    assert rederive.candle_volume_check(minute_rows, {"1000": "29.000", "2000": "3", "3000": "5"})["mismatches"] == 0


def test_the_candle_cross_check_sums_one_second_bars_into_the_minute_it_compares(tmp_path):
    # The converted equity and futures candles are ohlcv-1s under family
    # `candle`; a per-bar reading compares a single second against a whole
    # minute and every other minute reports as missing.
    path = tmp_path / "candle.parquet"
    minute = 3 * tf.MINUTE_NS
    bars = [(minute + index * 1_000_000_000, Decimal("2")) for index in range(60)]
    bars += [(minute + tf.MINUTE_NS, Decimal("7"))]
    connection = duckdb.connect()
    try:
        connection.execute("CREATE TABLE bars (open_ns UBIGINT, volume DECIMAL(38,12))")
        connection.executemany("INSERT INTO bars VALUES (?, ?)", [(int(ns), value) for ns, value in bars])
        connection.execute("COPY bars TO ? (FORMAT PARQUET)", [path.as_posix()])
    finally:
        connection.close()

    volumes, bar_count = rederive.read_candle_volumes([path.as_posix()])
    assert bar_count == 61 and volumes == {str(minute): "120", str(minute + tf.MINUTE_NS): "7"}
    minute_rows = [{"open_ns": str(minute), "volume": "120"}, {"open_ns": str(minute + tf.MINUTE_NS), "volume": "8"}]
    report = rederive.candle_volume_check(minute_rows, volumes)
    assert report["minutes_compared"] == 2 and report["missing_in_candles"] == 0
    assert report["first_mismatches"] == [{"open_ns": str(minute + tf.MINUTE_NS), "trade_volume": "8", "candle_volume": "7"}]


def _write_trades_with_receive(path, rows):
    """`(event_ns, receive_ns, size)` trades, the columns the attribution reads."""
    connection = duckdb.connect()
    try:
        connection.execute("CREATE TABLE t (event_ns UBIGINT, receive_ns UBIGINT, size DECIMAL(38,12), "
                           "price DECIMAL(38,12), trade_action VARCHAR, valid_tick BOOLEAN)")
        for event_ns, receive_ns, size in rows:
            connection.execute("INSERT INTO t VALUES (?, ?, ?, ?, 'NEW', TRUE)",
                               [int(event_ns), int(receive_ns), Decimal(str(size)), Decimal("100")])
        connection.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        connection.close()
    return path.as_posix()


def test_a_print_whose_receive_time_crosses_a_minute_explains_both_minutes_of_the_pair(tmp_path):
    # The provider buckets its bars on the receive timestamp and the families on
    # the exchange timestamp, so one print at the boundary moves volume out of
    # its minute and into the next. Both minutes must be explained -- the second
    # one only by what the first pushed into it.
    minute, nxt = 5 * tf.MINUTE_NS, 6 * tf.MINUTE_NS
    crosser = (minute + tf.MINUTE_NS - 200_000, minute + tf.MINUTE_NS + 100_000, 7)
    path = _write_trades_with_receive(tmp_path / "t.parquet", [
        (minute + 1_000_000_000, minute + 1_000_100_000, 10), crosser, (nxt + 5_000_000_000, nxt + 5_000_100_000, 4)])

    minute_rows = [{"open_ns": str(minute), "volume": "17"}, {"open_ns": str(nxt), "volume": "4"}]
    candle_volumes = {str(minute): "10", str(nxt): "11"}
    check = rederive.candle_volume_check(minute_rows, candle_volumes)
    assert check["mismatches"] == 2 and len(check["all_mismatches"]) == 2

    attribution = rederive.receive_time_attribution(
        [path], [row["open_ns"] for row in check["all_mismatches"]], market="EQUITY")
    assert attribution[str(minute)] == {"leaving": "7", "leaving_prints": 1, "arriving": "0", "arriving_prints": 0, "net": "7"}
    assert attribution[str(nxt)] == {"leaving": "0", "leaving_prints": 0, "arriving": "7", "arriving_prints": 1, "net": "-7"}

    explained = rederive.explain_mismatches(check, attribution)
    assert explained["explained_by_receive_time"] == 2 and explained["unexplained"] == 0
    assert explained["unexplained_minutes"] == [] and explained["boundary_crossing_prints"] == 1


def test_a_candle_difference_no_boundary_print_accounts_for_is_reported_unexplained(tmp_path):
    minute = 5 * tf.MINUTE_NS
    path = _write_trades_with_receive(tmp_path / "t.parquet", [(minute + 1_000_000_000, minute + 1_000_100_000, 10)])
    check = rederive.candle_volume_check([{"open_ns": str(minute), "volume": "10"}], {str(minute): "9"})
    attribution = rederive.receive_time_attribution([path], [str(minute)], market="EQUITY")
    explained = rederive.explain_mismatches(check, attribution)
    assert explained["explained_by_receive_time"] == 0 and explained["unexplained"] == 1
    assert explained["unexplained_minutes"][0]["delta"] == "1" and explained["unexplained_minutes"][0]["net"] == "0"


def test_a_print_captured_before_the_engine_timestamp_moves_volume_to_the_earlier_minute(tmp_path):
    # GLBX carries prints whose receive timestamp reads before the exchange
    # timestamp, so the candle can hold volume the families put a minute later.
    # An attribution that only looks forward calls this a finding.
    minute, nxt = 5 * tf.MINUTE_NS, 6 * tf.MINUTE_NS
    early = (nxt + 100_000, nxt - 200_000, 4)
    path = _write_trades_with_receive(tmp_path / "t.parquet", [
        (minute + 1_000_000_000, minute + 1_000_100_000, 10), early, (nxt + 5_000_000_000, nxt + 5_000_100_000, 6)])

    check = rederive.candle_volume_check(
        [{"open_ns": str(minute), "volume": "10"}, {"open_ns": str(nxt), "volume": "10"}],
        {str(minute): "14", str(nxt): "6"})
    attribution = rederive.receive_time_attribution([path], [str(minute), str(nxt)], market="EQUITY")
    assert attribution[str(minute)]["arriving"] == "4" and attribution[str(minute)]["net"] == "-4"
    assert attribution[str(nxt)]["leaving"] == "4" and attribution[str(nxt)]["net"] == "4"
    explained = rederive.explain_mismatches(check, attribution)
    assert explained["explained_by_receive_time"] == 2 and explained["unexplained"] == 0


def test_the_futures_attribution_counts_only_the_executions_the_families_count(tmp_path):
    minute = 5 * tf.MINUTE_NS
    crossing = minute + tf.MINUTE_NS - 200_000
    connection = duckdb.connect()
    path = tmp_path / "t.parquet"
    try:
        connection.execute("CREATE TABLE t (event_ns UBIGINT, receive_ns UBIGINT, size DECIMAL(38,12), "
                           "price DECIMAL(38,12), trade_action VARCHAR, valid_tick BOOLEAN)")
        for size, action, valid in [(7, "NEW", True), (5, "NEW", False), (3, "CANCEL", True)]:
            connection.execute("INSERT INTO t VALUES (?, ?, ?, 100, ?, ?)",
                               [crossing, crossing + 400_000, Decimal(size), action, valid])
        connection.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        connection.close()
    assert rederive.receive_time_attribution([path.as_posix()], [str(minute)], market="FUTURE")[str(minute)]["leaving"] == "7"
    assert rederive.receive_time_attribution([path.as_posix()], [str(minute)], market="EQUITY")[str(minute)]["leaving"] == "12"


def test_the_declared_equity_tick_is_the_live_instrument_catalog_s_tick():
    # Pattern R: 0.01 is a copy of a fact the live system keeps in
    # config/market-instruments.json; this pins the copy to its source.
    catalog = json.loads((Path(__file__).resolve().parents[4] / "config" / "market-instruments.json").read_text(encoding="utf-8"))
    equities = [entry for entry in catalog["dxfeed"] if entry["assetClass"] == "EQUITY"]
    futures = [entry for entry in catalog["dxfeed"] if entry["assetClass"] == "FUTURE"]
    assert equities and futures
    assert {Decimal(str(entry["tickSize"])) for entry in equities} == {tf.EQUITY_TICK_BY_DATASET["XNAS.ITCH"]}
    assert {Decimal(str(entry["tickSize"])) for entry in futures} == {Decimal(GOLDEN["cases"]["futures"]["tickSize"])}
