from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest

import candle_rollup as rollup

MINUTE = rollup.MINUTE_NS
HOUR = rollup.HOUR_NS
EQUITY = '["XNAS","EQUITY","AAPL","USD","SHARE"]'
FUTURE = '["XCME","FUTURE","ESZ6","USD","CONTRACT"]'


def _ns(iso):
    return int(dt.datetime.fromisoformat(iso).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000


def _minute(open_ns, volume="1"):
    return {"open_ns": open_ns, "close_ns": open_ns + MINUTE, "open": Decimal("100"), "high": Decimal("101"),
            "low": Decimal("99"), "close": Decimal("100"), "volume": Decimal(volume), "source_symbol": "38"}


def _span(start_iso, end_iso):
    start, end = _ns(start_iso), _ns(end_iso)
    return [_minute(ts) for ts in range(start, end, MINUTE)]


def test_equity_hours_open_at_0930_and_leave_extended_hours_out():
    day = _span("2026-09-23T08:00:00", "2026-09-24T00:00:00")
    hours = rollup.rollups_for(EQUITY)["candle_1h"](day)
    assert [int(row["ts_event"]) for row in hours] == [_ns("2026-09-23T13:30:00") + i * HOUR for i in range(7)]
    assert [row["volume"] for row in hours] == ["60"] * 6 + ["30"]
    assert rollup.total_volume(hours) == 390


def test_equity_day_is_the_regular_session_on_its_utc_date():
    day = _span("2026-09-23T08:00:00", "2026-09-24T00:00:00")
    days = rollup.rollups_for(EQUITY)["candle_1d"](day)
    assert [(int(row["ts_event"]), row["volume"]) for row in days] == [(_ns("2026-09-23T00:00:00"), "390")]


def test_winter_time_and_an_early_close_move_the_session():
    day = _span("2025-12-24T09:00:00", "2025-12-24T23:00:00")
    hours = rollup.equity_hour_rows(day)
    assert [int(row["ts_event"]) for row in hours] == [_ns("2025-12-24T14:30:00") + i * HOUR for i in range(4)]
    assert rollup.total_volume(hours) == 210


def test_a_holiday_or_an_uncovered_date_never_passes_as_a_session():
    assert rollup.equity_hour_rows(_span("2025-12-25T14:30:00", "2025-12-25T15:30:00")) == []
    with pytest.raises(rollup.RollupError, match="EQUITY_CALENDAR_DOES_NOT_COVER"):
        rollup.equity_hour_rows(_span("2025-08-29T14:30:00", "2025-08-29T14:31:00"))


def test_futures_keep_utc_hours_and_every_minute():
    day = _span("2026-09-23T13:00:00", "2026-09-23T15:00:00")
    hours = rollup.rollups_for(FUTURE)["candle_1h"](day)
    assert [int(row["ts_event"]) for row in hours] == [_ns("2026-09-23T13:00:00"), _ns("2026-09-23T14:00:00")]


def test_the_clocks_change_on_the_second_sunday_of_march_not_the_first():
    calendar = rollup.load_equity_calendar()
    # 2026-03-01 is the first Sunday and 2026-03-08 the second: the week between is still winter time.
    assert rollup.regular_session_ns("2026-03-04", calendar)[0] == _ns("2026-03-04T14:30:00")
    assert rollup.regular_session_ns("2026-03-09", calendar)[0] == _ns("2026-03-09T13:30:00")
