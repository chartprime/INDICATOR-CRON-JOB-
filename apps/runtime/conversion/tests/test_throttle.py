"""Cooperative pause against the live collector's health file (design lock
19 section 0.8, Phase 4)."""
from __future__ import annotations

import datetime as dt
import json

import pytest

import throttle as th

_NOW = dt.datetime(2026, 9, 10, 12, 0, 0, tzinfo=dt.timezone.utc)


@pytest.mark.parametrize('value', [[], 'healthy', 42, True])
def test_wrong_payload_type_pauses(value):
    assert th.should_pause(value, _NOW)


@pytest.mark.parametrize('value', [-1, float('nan'), float('inf'), True])
def test_invalid_metric_pauses(value):
    assert th.should_pause(dict(updatedAt=_NOW.isoformat(), pendingWriteItems=value, writeLagMs=0), _NOW)


def test_future_health_pauses():
    assert th.should_pause(dict(updatedAt=(_NOW + dt.timedelta(seconds=1)).isoformat(),
                                pendingWriteItems=0, writeLagMs=0), _NOW)


def _write(tmp_path, **fields):
    path = tmp_path / "collector-health.json"
    path.write_text(json.dumps({"pendingWriteItems": 0, "writeLagMs": 0,
                                 "sessionQuality": "HEALTHY", "updatedAt": _NOW.isoformat(), **fields}))
    return str(path)


def test_a_missing_health_file_means_pause_not_proceed():
    assert th.read_health("/nonexistent/collector-health.json") is None
    assert th.should_pause(None, _NOW) is True


def test_a_fresh_healthy_file_does_not_pause(tmp_path):
    path = _write(tmp_path)
    assert th.should_pause(th.read_health(path), _NOW) is False


def test_a_stale_file_pauses_even_if_the_numbers_look_fine(tmp_path):
    old = _NOW - dt.timedelta(seconds=th.MAX_STALENESS_S + 1)
    path = _write(tmp_path, updatedAt=old.isoformat())
    assert th.should_pause(th.read_health(path), _NOW) is True


def test_high_pending_write_items_pauses(tmp_path):
    path = _write(tmp_path, pendingWriteItems=th.MAX_PENDING_WRITE_ITEMS + 1)
    assert th.should_pause(th.read_health(path), _NOW) is True


def test_high_write_lag_pauses(tmp_path):
    path = _write(tmp_path, writeLagMs=th.MAX_WRITE_LAG_MS + 1)
    assert th.should_pause(th.read_health(path), _NOW) is True


def test_values_exactly_at_the_threshold_do_not_pause(tmp_path):
    path = _write(tmp_path, pendingWriteItems=th.MAX_PENDING_WRITE_ITEMS, writeLagMs=th.MAX_WRITE_LAG_MS)
    assert th.should_pause(th.read_health(path), _NOW) is False


def test_malformed_json_is_treated_the_same_as_a_missing_file(tmp_path):
    path = tmp_path / "collector-health.json"
    path.write_text("{not valid json")
    assert th.read_health(str(path)) is None


def test_a_missing_timestamp_or_missing_numeric_fields_defaults_to_pause_not_a_crash(tmp_path):
    path = tmp_path / "collector-health.json"
    path.write_text(json.dumps({"pendingWriteItems": 0, "writeLagMs": 0, "sessionQuality": "HEALTHY"}))
    assert th.should_pause(th.read_health(str(path)), _NOW) is True

    path.write_text(json.dumps({"sessionQuality": "HEALTHY", "updatedAt": _NOW.isoformat()}))
    assert th.should_pause(th.read_health(str(path)), _NOW) is True


def test_wait_if_needed_sleeps_and_rechecks_until_the_collector_recovers(tmp_path):
    path = _write(tmp_path, pendingWriteItems=th.MAX_PENDING_WRITE_ITEMS + 1)
    sleeps = []

    def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            # Simulate the collector recovering after two bad ticks.
            _write(tmp_path, pendingWriteItems=0)

    th.wait_if_needed(path, sleep=fake_sleep, clock=lambda: _NOW)
    assert sleeps == [th.PAUSE_INTERVAL_S, th.PAUSE_INTERVAL_S]


@pytest.mark.parametrize("path", [None, ""])
def test_wait_if_needed_is_a_no_op_with_no_configured_health_file_path(path):
    # No configured path means no collector to coordinate with (local dev,
    # CI, a host not also running one) -- must never hang waiting for a
    # file that was never going to exist.
    calls = []
    th.wait_if_needed(path, sleep=lambda s: calls.append(s), clock=lambda: _NOW)
    assert calls == []


def test_wait_if_needed_returns_immediately_when_there_is_nothing_to_wait_for(tmp_path):
    path = _write(tmp_path)
    calls = []
    th.wait_if_needed(path, sleep=lambda s: calls.append(s), clock=lambda: _NOW)
    assert calls == []


def test_wait_if_needed_raises_rather_than_hang_forever_when_max_wait_is_set(tmp_path):
    path = "/nonexistent/collector-health.json"
    with pytest.raises(th.ThrottleError, match="THROTTLE_MAX_WAIT_EXCEEDED"):
        th.wait_if_needed(path, sleep=lambda s: None, clock=lambda: _NOW, max_wait_s=th.PAUSE_INTERVAL_S)
