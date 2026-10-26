"""Coarser bars derived from published one-minute partitions.

The archive has no hourly source: Databento supplies ohlcv-1s and ohlcv-1m and
nothing coarser, so the hourly rung is arithmetic on bars we already hold. It
exists because transport, not resampling, is what makes a year-long view
expensive -- a year of daily candles drawn from minute bars is 525,600 rows
against 8,760 at one hour.

Derived bars go through the same mapping every other bar goes through rather
than being assembled by hand, so they get the same identity, the same decimal
handling and the same validation. That costs one conversion back to the fixed
point representation the mapping expects, which is checked for exactness rather
than rounded: a price that cannot round-trip is a defect, not a rounding
opportunity.
"""
from __future__ import annotations

import datetime as _dt
import json as _json
import pathlib as _pathlib
from decimal import Decimal

HOUR_NS = 3_600_000_000_000
MINUTE_NS = 60_000_000_000
DAY_NS = 86_400_000_000_000

_FIXED9 = Decimal(10) ** 9
_CALENDAR_PATH = _pathlib.Path(__file__).resolve().parents[3] / "config" / "market-calendar.json"
_EPOCH = _dt.date(1970, 1, 1)


class RollupError(RuntimeError):
    pass


def _fixed9_text(value):
    scaled = Decimal(value) * _FIXED9
    if scaled != scaled.to_integral_value():
        raise RollupError(f"PRICE_NOT_REPRESENTABLE_AS_FIXED9:{value}")
    return str(int(scaled))


def _integer_volume(value):
    quantity = Decimal(value)
    if quantity != quantity.to_integral_value():
        raise RollupError(f"VOLUME_NOT_REPRESENTABLE_AS_INTEGER:{value}")
    return int(quantity)


def _assert_minute_bar(row):
    open_ns, close_ns = int(row["open_ns"]), int(row["close_ns"])
    if close_ns - open_ns != MINUTE_NS:
        raise RollupError(f"SOURCE_IS_NOT_A_MINUTE_BAR:{close_ns - open_ns}")
    if open_ns % MINUTE_NS != 0:
        raise RollupError(f"SOURCE_BAR_NOT_MINUTE_ALIGNED:{open_ns}")
    return open_ns


def load_equity_calendar(path=_CALENDAR_PATH):
    with open(path, encoding="utf-8") as fh:
        calendar = _json.load(fh)
    if calendar.get("version") != 1 or calendar.get("timeZone") != "America/New_York":
        raise RollupError("EQUITY_CALENDAR_UNSUPPORTED")
    equity = calendar["equity"]
    minute = lambda text: int(text[:2]) * 60 + int(text[3:5])
    return {
        "from": equity["coverage"]["from"], "to": equity["coverage"]["to"],
        "open": minute(equity["regularOpen"]), "close": minute(equity["regularClose"]),
        "early_close": minute(equity["earlyClose"]),
        "holidays": frozenset(equity["holidays"]), "early_closes": frozenset(equity["earlyCloses"]),
    }


def _nth_sunday_utc_ns(year, month, nth, hour_utc):
    first = _dt.date(year, month, 1)
    day = first + _dt.timedelta(days=(6 - first.weekday()) % 7 + 7 * (nth - 1))
    return ((day - _EPOCH).days * 24 + hour_utc) * HOUR_NS


def _eastern_offset_ns(day):
    midday = ((day - _EPOCH).days * 24 + 17) * HOUR_NS
    dst = _nth_sunday_utc_ns(day.year, 3, 2, 7) <= midday < _nth_sunday_utc_ns(day.year, 11, 1, 6)
    return (4 if dst else 5) * HOUR_NS


def regular_session_ns(date_iso, calendar):
    if not calendar["from"] <= date_iso <= calendar["to"]:
        raise RollupError(f"EQUITY_CALENDAR_DOES_NOT_COVER:{date_iso}")
    day = _dt.date.fromisoformat(date_iso)
    if day.weekday() >= 5 or date_iso in calendar["holidays"]:
        return None
    local_midnight = (day - _EPOCH).days * DAY_NS + _eastern_offset_ns(day)
    close = calendar["early_close"] if date_iso in calendar["early_closes"] else calendar["close"]
    return local_midnight + calendar["open"] * MINUTE_NS, local_midnight + close * MINUTE_NS


def _regular_session_minutes(minute_rows, calendar):
    sessions = {}
    kept = []
    for row in minute_rows:
        open_ns = _assert_minute_bar(row)
        date_iso = (_EPOCH + _dt.timedelta(days=open_ns // DAY_NS)).isoformat()
        if date_iso not in sessions:
            sessions[date_iso] = regular_session_ns(date_iso, calendar)
        session = sessions[date_iso]
        if session is not None and session[0] <= open_ns < session[1]:
            kept.append((row, session[0]))
    return kept


def _utc_bucket(interval_ns):
    return lambda open_ns: open_ns - (open_ns % interval_ns)


def _rollup_rows(minute_rows, interval_ns, label, bucket_of=None):
    """Aggregate minute bars into synthetic source rows for one fixed interval.

    A sparse hour is not a gap. The archive only holds a bar where the market
    traded, so an hour carrying three minutes is an ordinary hour and must
    produce an ordinary bar -- dropping it would put a hole in the hourly rung
    wherever the market was quiet, which is exactly where it looks most like
    real data.
    """
    bucket_of = bucket_of or _utc_bucket(interval_ns)
    buckets = {}
    for row in minute_rows:
        open_ns = _assert_minute_bar(row)
        bucket = bucket_of(open_ns)
        buckets.setdefault(bucket, []).append((open_ns, row))

    rows = []
    for bucket in sorted(buckets):
        members = sorted(buckets[bucket], key=lambda pair: pair[0])
        if members[-1][0] + MINUTE_NS > bucket + interval_ns:
            raise RollupError(f"MINUTE_BAR_OUTSIDE_ITS_{label.upper()}:{bucket}")
        if bucket // DAY_NS != (bucket + interval_ns - 1) // DAY_NS:
            raise RollupError(f"{label.upper()}_CROSSES_UTC_DATE:{bucket}")
        symbols = {row["source_symbol"] for _open_ns, row in members}
        if len(symbols) != 1:
            raise RollupError(f"{label.upper()}_SPANS_MULTIPLE_SOURCE_SYMBOLS:{sorted(symbols)}")
        prices = [(Decimal(row["high"]), Decimal(row["low"])) for _open_ns, row in members]
        rows.append({
            "ts_event": str(bucket),
            "instrument_id": members[0][1]["source_symbol"],
            "open": _fixed9_text(members[0][1]["open"]),
            "high": _fixed9_text(max(high for high, _low in prices)),
            "low": _fixed9_text(min(low for _high, low in prices)),
            "close": _fixed9_text(members[-1][1]["close"]),
            "volume": str(sum(_integer_volume(row["volume"]) for _open_ns, row in members)),
        })
    return rows


def hour_rows(minute_rows):
    """Aggregate minute bars into hourly synthetic source rows."""
    return _rollup_rows(minute_rows, HOUR_NS, "hour")


def day_rows(minute_rows):
    """Aggregate minute bars into UTC-day synthetic source rows."""
    return _rollup_rows(minute_rows, DAY_NS, "day")


def equity_hour_rows(minute_rows, calendar=None):
    kept = _regular_session_minutes(minute_rows, calendar or load_equity_calendar())
    session_open = {int(row["open_ns"]): opened for row, opened in kept}
    return _rollup_rows([row for row, _opened in kept], HOUR_NS, "hour",
                        lambda open_ns: open_ns - (open_ns - session_open[open_ns]) % HOUR_NS)


def equity_day_rows(minute_rows, calendar=None):
    kept = _regular_session_minutes(minute_rows, calendar or load_equity_calendar())
    return _rollup_rows([row for row, _opened in kept], DAY_NS, "day")


def rollups_for(instrument_id):
    if _json.loads(instrument_id)[1] == "EQUITY":
        return {"candle_1h": equity_hour_rows, "candle_1d": equity_day_rows}
    return {"candle_1h": hour_rows, "candle_1d": day_rows}


def total_volume(rows):
    return sum(int(Decimal(row["volume"])) for row in rows)


def read_minute_rows(parquet_paths):
    """Published one-minute bars, in the shape :func:`hour_rows` consumes."""
    import duckdb

    if not parquet_paths:
        return []
    con = duckdb.connect()
    try:
        selected = con.execute(
            "SELECT open_ns, close_ns, open, high, low, close, volume, source_symbol "
            "FROM read_parquet(?) ORDER BY open_ns", [list(parquet_paths)]
        ).fetchall()
    finally:
        con.close()
    columns = ("open_ns", "close_ns", "open", "high", "low", "close", "volume", "source_symbol")
    return [dict(zip(columns, row)) for row in selected]
