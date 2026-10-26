"""The four trade-derived families, computed from published `trade` partitions.

Each family is the shape one live storage read already produces from the
capture database -- `readMinuteRollup`, `readSlicedNotional`,
`readLargeTrades`, `readDailyNotional` -- so a study fed from the archive is
fed the same numbers it gets live. The filters are those reads' filters, not
a new definition: NEW executions, a valid tick for futures, every side in the
minute and level aggregates, BUY and SELL only in slices and prints.

Arithmetic is exact. Prices and sizes are cast to a fixed scale that the
stored values must round-trip through, so a notional is a decimal product and
a price bucket is an integer floor division on fixed-point subunits; nothing
here passes through a double.
"""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import duckdb

FAMILY_SLICE_MS = 2_000
PRINTS_PER_SIDE = 4
MINUTE_NS = 60_000_000_000
SLICE_NS = FAMILY_SLICE_MS * 1_000_000
PRICE_SUBUNITS = 10 ** 9
VALUE_SCALE = 6
NOTIONAL_OPERAND_WIDTH = 19

METHOD_VERSION = "trade-derive/1"
FAMILY_METHOD = {
    "trade_minute": "trade_minute/1",
    "trade_level": "trade_level/1",
    "trade_slice": "trade_slice/1",
    "trade_prints": "trade_prints/1",
}
RECORD_FAMILIES = tuple(FAMILY_METHOD)

EQUITY_TICK_BY_DATASET = {"XNAS.ITCH": Decimal("0.01")}
_CRYPTO_CONFIG = json.loads((Path(__file__).resolve().parents[3] / "config" / "archive-crypto-ticks.json").read_text(encoding="utf-8"))
CRYPTO_TRADE_WINDOW = (_CRYPTO_CONFIG["tradeWindow"]["from"], _CRYPTO_CONFIG["tradeWindow"]["toExclusive"])
CRYPTO_TICK_BY_INSTRUMENT = {
    (row["dataset"], row["symbol"]): Decimal(row["tickSize"])
    for row in _CRYPTO_CONFIG["instruments"]
}


def declared_tick(dataset, symbol):
    if dataset in EQUITY_TICK_BY_DATASET:
        return EQUITY_TICK_BY_DATASET[dataset]
    return CRYPTO_TICK_BY_INSTRUMENT.get((dataset, symbol))

IDENTITY_COLUMNS = (
    "instrument_id", "venue", "market", "symbol", "currency", "size_unit", "contract",
    "source_provider", "source_dataset", "source_symbol", "source_population",
)


class FamilyError(RuntimeError):
    pass


def _plain(value):
    if isinstance(value, Decimal):
        text = format(value.normalize(), "f")
        return "0" if text in ("-0", "0.0") else text
    return str(value)


def tick_subunits(tick_size):
    tick = Decimal(str(tick_size))
    if tick <= 0:
        raise FamilyError(f"INVALID_TICK_SIZE:{tick_size}")
    scaled = tick * PRICE_SUBUNITS
    if scaled != scaled.to_integral_value():
        raise FamilyError(f"TICK_NOT_REPRESENTABLE_AS_FIXED9:{tick_size}")
    return int(scaled)


def _connect():
    return duckdb.connect(config={"threads": "1"})


def partition_identity(paths, connection=None):
    """The one instrument a trade partition describes, refused when it is not one."""
    own = connection is None
    connection = connection or _connect()
    try:
        columns = ", ".join(IDENTITY_COLUMNS)
        rows = connection.read_parquet(list(paths)).project(columns).distinct().fetchall()
    finally:
        if own:
            connection.close()
    if len(rows) != 1:
        raise FamilyError(f"SOURCE_IDENTITY_MIXED:{len(rows)}")
    return dict(zip(IDENTITY_COLUMNS, rows[0]))


def _trades_view(connection, paths, market):
    validity = "AND (valid_tick IS NULL OR valid_tick) " if market == "FUTURE" else ""
    connection.read_parquet(list(paths)).create_view("parts_raw", replace=True)
    connection.execute(
        "CREATE OR REPLACE VIEW trades_raw AS SELECT * FROM parts_raw "
        f"WHERE trade_action = 'NEW' AND price IS NOT NULL AND size IS NOT NULL {validity}")
    imprecise = connection.execute(
        f"SELECT count(*) FROM trades_raw WHERE CAST(price AS DECIMAL(18,{VALUE_SCALE})) <> price "
        f"OR CAST(size AS DECIMAL(18,{VALUE_SCALE})) <> size "
        f"OR price * {PRICE_SUBUNITS} <> CAST(price * {PRICE_SUBUNITS} AS HUGEINT)").fetchone()[0]
    if imprecise:
        raise FamilyError(f"FAMILY_PRECISION_UNSUPPORTED:{imprecise}")
    connection.execute(
        "CREATE OR REPLACE VIEW trades AS SELECT event_ns, source_rank, stable_position, ordinal, source_symbol, side, "
        "trade_entity_id, price, size, "
        f"CAST(price AS DECIMAL(18,{VALUE_SCALE})) AS price_v, CAST(size AS DECIMAL(18,{VALUE_SCALE})) AS size_v, "
        f"CAST(price AS DECIMAL({NOTIONAL_OPERAND_WIDTH},{VALUE_SCALE})) "
        f"* CAST(size AS DECIMAL({NOTIONAL_OPERAND_WIDTH},{VALUE_SCALE})) AS notional, "
        f"CAST(price * {PRICE_SUBUNITS} AS HUGEINT) AS price_sub, "
        f"event_ns - event_ns % {MINUTE_NS} AS minute_ns, event_ns - event_ns % {SLICE_NS} AS slice_ns "
        "FROM trades_raw")


def _minute_rows(connection, source_symbol):
    rows = connection.execute(
        "SELECT minute_ns, SUM(size_v), "
        "SUM(CASE WHEN side = 'BUY' THEN size_v ELSE 0 END), "
        "SUM(CASE WHEN side = 'SELL' THEN size_v ELSE 0 END), "
        "SUM(CASE WHEN side = 'BUY' OR side = 'SELL' THEN 0 ELSE size_v END), "
        "SUM(CASE WHEN side = 'BUY' THEN notional ELSE 0 END), "
        "SUM(CASE WHEN side = 'SELL' THEN notional ELSE 0 END), count(*) "
        "FROM trades GROUP BY minute_ns ORDER BY minute_ns").fetchall()
    return [{
        "source_symbol": source_symbol, "open_ns": str(minute), "ordinal": "0",
        "volume": _plain(volume), "buy_volume": _plain(buy), "sell_volume": _plain(sell),
        "undefined_volume": _plain(undefined), "buy_notional": _plain(buy_notional),
        "sell_notional": _plain(sell_notional), "trade_count": str(count),
    } for minute, volume, buy, sell, undefined, buy_notional, sell_notional, count in rows]


def _level_rows(connection, source_symbol, tick_size):
    tick = tick_subunits(tick_size)
    bucket = f"(price_sub - ((price_sub % {tick} + {tick}) % {tick})) // {tick}"
    rows = connection.execute(
        "SELECT minute_ns, bucket, row_number() OVER (PARTITION BY minute_ns ORDER BY bucket) - 1, "
        "volume, buy, sell, count FROM ("
        f"  SELECT minute_ns, {bucket} AS bucket, SUM(size_v) AS volume, "
        "    SUM(CASE WHEN side = 'BUY' THEN size_v ELSE 0 END) AS buy, "
        "    SUM(CASE WHEN side = 'SELL' THEN size_v ELSE 0 END) AS sell, count(*) AS count "
        "  FROM trades GROUP BY minute_ns, bucket"
        ") ORDER BY minute_ns, bucket").fetchall()
    tick_text = _plain(Decimal(str(tick_size)))
    return [{
        "source_symbol": source_symbol, "open_ns": str(minute), "ordinal": str(ordinal), "tick_size": tick_text,
        "price_bucket": str(bucket_value), "volume": _plain(volume), "buy_volume": _plain(buy),
        "sell_volume": _plain(sell), "trade_count": str(count),
    } for minute, bucket_value, ordinal, volume, buy, sell, count in rows]


def _slice_rows(connection, source_symbol):
    rows = connection.execute(
        "SELECT slice_ns, MAX(event_ns), "
        "SUM(CASE WHEN side = 'BUY' THEN notional ELSE 0 END), "
        "SUM(CASE WHEN side = 'SELL' THEN notional ELSE 0 END), count(*) "
        "FROM trades WHERE side IN ('BUY', 'SELL') GROUP BY slice_ns ORDER BY slice_ns").fetchall()
    return [{
        "source_symbol": source_symbol, "open_ns": str(slice_open), "ordinal": "0",
        "last_trade_ns": str(last), "buy_notional": _plain(buy), "sell_notional": _plain(sell),
        "trade_count": str(count),
    } for slice_open, last, buy, sell, count in rows]


def _prints_rows(connection, source_symbol, market, prints_per_side):
    magnitude = "size_v" if market == "FUTURE" else "notional"
    rows = connection.execute(
        "SELECT minute_ns, side, rank, event_ns, price, size, trade_entity_id FROM ("
        f"  SELECT minute_ns, side, event_ns, price, size, trade_entity_id, "
        f"    row_number() OVER (PARTITION BY minute_ns, side ORDER BY {magnitude} DESC, event_ns DESC, "
        "      source_rank DESC, stable_position DESC, ordinal DESC) AS rank "
        f"  FROM trades WHERE side IN ('BUY', 'SELL') AND {magnitude} > 0"
        f") WHERE rank <= {int(prints_per_side)} "
        "ORDER BY minute_ns, CASE WHEN side = 'BUY' THEN 0 ELSE 1 END, rank").fetchall()
    return [{
        "source_symbol": source_symbol, "open_ns": str(minute),
        "ordinal": str((prints_per_side if side == "SELL" else 0) + rank - 1),
        "side": side, "rank": str(rank), "trade_ns": str(event_ns), "price": _plain(price),
        "size": _plain(size), "trade_entity_id": entity,
    } for minute, side, rank, event_ns, price, size, entity in rows]


def _reconcile(connection, families, market, prints_per_side):
    total_size, total_count = connection.execute("SELECT COALESCE(SUM(size_v), 0), count(*) FROM trades").fetchone()
    minute_volume = sum(Decimal(r["volume"]) for r in families["trade_minute"])
    minute_count = sum(int(r["trade_count"]) for r in families["trade_minute"])
    if minute_volume != Decimal(total_size) or minute_count != total_count:
        raise FamilyError("FAMILY_RECONCILIATION_FAILED:trade_minute")
    per_minute = {}
    for row in families["trade_level"]:
        volume, count = per_minute.get(row["open_ns"], (Decimal(0), 0))
        per_minute[row["open_ns"]] = (volume + Decimal(row["volume"]), count + int(row["trade_count"]))
    for row in families["trade_minute"]:
        if per_minute.get(row["open_ns"]) != (Decimal(row["volume"]), int(row["trade_count"])):
            raise FamilyError("FAMILY_RECONCILIATION_FAILED:trade_level")
    sided = connection.execute(
        "SELECT COALESCE(SUM(CASE WHEN side = 'BUY' THEN notional ELSE 0 END), 0), "
        "COALESCE(SUM(CASE WHEN side = 'SELL' THEN notional ELSE 0 END), 0), count(*) "
        "FROM trades WHERE side IN ('BUY', 'SELL')").fetchone()
    if (sum(Decimal(r["buy_notional"]) for r in families["trade_slice"]) != Decimal(sided[0])
            or sum(Decimal(r["sell_notional"]) for r in families["trade_slice"]) != Decimal(sided[1])
            or sum(int(r["trade_count"]) for r in families["trade_slice"]) != sided[2]):
        raise FamilyError("FAMILY_RECONCILIATION_FAILED:trade_slice")
    magnitude = "size_v" if market == "FUTURE" else "notional"
    expected = dict(connection.execute(
        "SELECT minute_ns || ':' || side, LEAST(count(*), ?) FROM trades "
        f"WHERE side IN ('BUY', 'SELL') AND {magnitude} > 0 GROUP BY minute_ns, side",
        [prints_per_side]).fetchall())
    observed = {}
    for row in families["trade_prints"]:
        key = f"{row['open_ns']}:{row['side']}"
        observed[key] = observed.get(key, 0) + 1
    if observed != expected:
        raise FamilyError("FAMILY_RECONCILIATION_FAILED:trade_prints")
    return {"trades": total_count, "volume": _plain(Decimal(total_size)),
            "sided_trades": sided[2], "buy_notional": _plain(Decimal(sided[0])), "sell_notional": _plain(Decimal(sided[1]))}


def compute(paths, *, market, tick_size, prints_per_side=PRINTS_PER_SIDE, connection=None):
    """Every family's rows for one partition's parts, in the adapter's source shape.

    The rows carry decimal text and nanosecond strings; the contract turns them
    into exact records and validates them. The returned `reconciliation` block
    is the stage's own bookkeeping, not evidence -- the golden fixture and the
    independent re-derivation are."""
    if market not in ("FUTURE", "EQUITY", "SPOT", "PERPETUAL"):
        raise FamilyError(f"UNSUPPORTED_MARKET:{market}")
    if not isinstance(prints_per_side, int) or isinstance(prints_per_side, bool) or not 1 <= prints_per_side <= 64:
        raise FamilyError(f"INVALID_PRINTS_PER_SIDE:{prints_per_side}")
    own = connection is None
    connection = connection or _connect()
    try:
        identity = partition_identity(paths, connection)
        _trades_view(connection, paths, market)
        source_symbol = identity["source_symbol"]
        families = {
            "trade_minute": _minute_rows(connection, source_symbol),
            "trade_level": _level_rows(connection, source_symbol, tick_size),
            "trade_slice": _slice_rows(connection, source_symbol),
            "trade_prints": _prints_rows(connection, source_symbol, market, prints_per_side),
        }
        reconciliation = _reconcile(connection, families, market, prints_per_side)
    finally:
        if own:
            connection.close()
    return {"identity": identity, "families": families, "reconciliation": reconciliation,
            "geometry": {"slice_ms": FAMILY_SLICE_MS, "prints_per_side": prints_per_side,
                         "tick_size": _plain(Decimal(str(tick_size))), "value_scale": VALUE_SCALE}}


def daily_notional(minute_rows):
    """The live `readDailyNotional` shape from minute rows: BUY plus SELL notional per UTC day."""
    days = {}
    for row in minute_rows:
        day = int(row["open_ns"]) // 86_400_000_000_000
        days[day] = days.get(day, Decimal(0)) + Decimal(row["buy_notional"]) + Decimal(row["sell_notional"])
    return [{"day_ns": str(day * 86_400_000_000_000), "notional": _plain(total)} for day, total in sorted(days.items())]
