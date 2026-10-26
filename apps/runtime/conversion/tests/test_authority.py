"""Cross-file source authority resolution (design lock 19 section 0.10)."""
from __future__ import annotations

import pytest

import authority


def test_newer_partial_cannot_displace_complete_monthly():
    partial = _input("daily", "daily", "2026-01-01T00:00:00Z", [_cov("2025-09-02", complete=False)])
    full = _input("monthly", "monthly", "2025-09-01T00:00:00Z", [_cov("2025-09-02")])
    assert authority.resolve([partial, full])[0][0]["s3_key"] == "monthly"


def test_recency_compares_instants_not_timezone_strings():
    older = _input("a", "monthly", "2025-09-10T12:00:00+02:00", [_cov("2025-09-02")])
    newer = _input("b", "monthly", "2025-09-10T11:00:00Z", [_cov("2025-09-02")])
    assert authority.resolve([older, newer])[0][0]["s3_key"] == "b"


def _input(s3_key, cadence, last_modified, coverage):
    return {"s3_key": s3_key, "cadence": cadence, "last_modified": last_modified, "coverage": coverage}


def _cov(date, complete=True, instrument_id="AAPL", family="candle", from_ns=None, to_ns=None):
    return {
        "instrument_id": instrument_id, "family": family, "date": date,
        "from_ns": from_ns or 0, "to_ns": to_ns or 1, "complete": complete,
    }


def test_complete_daily_beats_monthly_even_when_monthly_is_more_recently_delivered():
    daily = _input("raw/daily/2025-09-02.dbn", "daily", "2025-09-01T00:00:00Z", [_cov("2025-09-02")])
    monthly = _input("raw/monthly/2025-09.dbn", "monthly", "2025-09-30T00:00:00Z", [_cov("2025-09-02")])
    plan, excluded, ranks = authority.resolve([daily, monthly])
    assert plan == [{
        "instrument_id": "AAPL", "family": "candle", "date": "2025-09-02",
        "from_ns": 0, "to_ns": 1, "s3_key": "raw/daily/2025-09-02.dbn", "source_rank": ranks["raw/daily/2025-09-02.dbn"],
    }]
    assert excluded == [{
        "instrument_id": "AAPL", "family": "candle", "date": "2025-09-02",
        "s3_key": "raw/monthly/2025-09.dbn", "reason": "NOT_AUTHORITATIVE",
    }]


def test_incomplete_daily_does_not_automatically_beat_monthly_recency_decides():
    partial_daily = _input("raw/daily/2025-09-02.dbn", "daily", "2025-09-01T00:00:00Z", [_cov("2025-09-02", complete=False)])
    monthly = _input("raw/monthly/2025-09.dbn", "monthly", "2025-09-30T00:00:00Z", [_cov("2025-09-02")])
    plan, excluded, _ranks = authority.resolve([partial_daily, monthly])
    assert plan[0]["s3_key"] == "raw/monthly/2025-09.dbn"
    assert excluded[0]["s3_key"] == "raw/daily/2025-09-02.dbn"


def test_recency_breaks_ties_between_two_monthly_sources_for_the_same_date():
    older = _input("raw/monthly/v1.dbn", "monthly", "2025-09-10T00:00:00Z", [_cov("2025-09-02")])
    newer = _input("raw/monthly/v2.dbn", "monthly", "2025-09-20T00:00:00Z", [_cov("2025-09-02")])
    plan, excluded, _ranks = authority.resolve([older, newer])
    assert plan[0]["s3_key"] == "raw/monthly/v2.dbn"
    assert excluded[0]["s3_key"] == "raw/monthly/v1.dbn"


def test_s3_key_is_the_final_tiebreak_when_cadence_and_recency_are_equal():
    a = _input("raw/monthly/a.dbn", "monthly", "2025-09-10T00:00:00Z", [_cov("2025-09-02")])
    b = _input("raw/monthly/b.dbn", "monthly", "2025-09-10T00:00:00Z", [_cov("2025-09-02")])
    plan, excluded, _ranks = authority.resolve([b, a])
    assert plan[0]["s3_key"] == "raw/monthly/a.dbn"
    assert excluded[0]["s3_key"] == "raw/monthly/b.dbn"


def test_source_rank_is_stable_and_lexically_ordered_across_all_inputs():
    z = _input("raw/z.dbn", "monthly", "2025-09-10T00:00:00Z", [_cov("2025-09-02")])
    a = _input("raw/a.dbn", "monthly", "2025-09-05T00:00:00Z", [_cov("2025-09-03")])
    _plan, _excluded, ranks = authority.resolve([z, a])
    assert ranks == {"raw/a.dbn": 0, "raw/z.dbn": 1}


def test_non_overlapping_dates_each_get_their_own_authoritative_source_with_nothing_excluded():
    monthly = _input("raw/monthly/2025-09.dbn", "monthly", "2025-09-30T00:00:00Z",
                      [_cov("2025-09-01"), _cov("2025-09-02")])
    plan, excluded, _ranks = authority.resolve([monthly])
    assert [p["date"] for p in plan] == ["2025-09-01", "2025-09-02"]
    assert excluded == []


def test_different_instruments_and_families_do_not_compete_for_the_same_slot():
    aapl = _input("raw/aapl.dbn", "daily", "2025-09-01T00:00:00Z", [_cov("2025-09-02", instrument_id="AAPL")])
    tsla = _input("raw/tsla.dbn", "daily", "2025-09-01T00:00:00Z", [_cov("2025-09-02", instrument_id="TSLA")])
    plan, excluded, _ranks = authority.resolve([aapl, tsla])
    assert {p["instrument_id"] for p in plan} == {"AAPL", "TSLA"}
    assert excluded == []


def test_different_instruments_with_overlapping_time_windows_on_the_same_date_both_get_planned():
    old_contract = _input("raw/esu5.dbn", "monthly", "2025-09-01T00:00:00Z",
                           [_cov("2025-09-17", instrument_id="ESU5", from_ns=0, to_ns=2)])
    new_contract = _input("raw/esz5.dbn", "monthly", "2025-09-01T00:00:00Z",
                           [_cov("2025-09-17", instrument_id="ESZ5", from_ns=0, to_ns=100)])
    plan, excluded, _ranks = authority.resolve([old_contract, new_contract])
    assert {(p["instrument_id"], p["date"]) for p in plan} == {("ESU5", "2025-09-17"), ("ESZ5", "2025-09-17")}
    assert excluded == []
