"""Cooperative pause against the live collector (design lock 19 section 0.8,
Phase 4). The collector writes its own health to a shared runtime file
(`/run/terminal-l1-l2/collector-health.json` in production) every ~1s; this
converter reads it between batches and backs off while the collector looks
under real pressure -- or if the file is missing/stale, since that means
the collector might be down or stuck, and backing off is the safe default.

This is the *cooperative* layer on top of the OS-level throttle (`nice`/
`ionice`, already shipped in Phase 1) -- it costs the collector nothing to
read (world-readable file, no IPC, no access to its private capture dir)
and never blocks it even if the converter reads it at the exact wrong
moment (each write is atomic, tmp-then-rename).
"""
from __future__ import annotations

import datetime as _dt
import json
import math
import os
import time

MAX_PENDING_WRITE_ITEMS = int(os.environ.get("TT_THROTTLE_MAX_PENDING_WRITE_ITEMS", "20000"))
MAX_WRITE_LAG_MS = int(os.environ.get("TT_THROTTLE_MAX_WRITE_LAG_MS", "20000"))
MAX_STALENESS_S = float(os.environ.get("TT_THROTTLE_MAX_STALENESS_S", "15"))
PAUSE_INTERVAL_S = float(os.environ.get("TT_THROTTLE_PAUSE_INTERVAL_S", "5"))


class ThrottleError(RuntimeError):
    pass


def read_health(path):
    """The collector's last-written health snapshot, or None if the file is
    missing or unreadable -- both are treated identically by `should_pause`
    (collector might not be running at all; back off, don't assume clean)."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _age_seconds(health, now):
    try:
        updated_at = _dt.datetime.fromisoformat(health["updatedAt"].replace("Z", "+00:00"))
    except (KeyError, ValueError, TypeError, AttributeError):
        return None
    if updated_at.tzinfo is None:
        return None
    return (now - updated_at).total_seconds()


def should_pause(health, now=None,
                  max_pending_write_items=MAX_PENDING_WRITE_ITEMS,
                  max_write_lag_ms=MAX_WRITE_LAG_MS, max_staleness_s=MAX_STALENESS_S):
    """True if the collector looks like it's under real pressure, or if we
    can't tell (missing file, unparsable timestamp, stale heartbeat) --
    every unknown case defaults to "pause", never to "proceed assuming
    it's fine".
    """
    if not isinstance(health, dict):
        return True
    now = now or _dt.datetime.now(_dt.timezone.utc)
    age_s = _age_seconds(health, now)
    if age_s is None or age_s < 0 or age_s > max_staleness_s:
        return True
    pending = health.get("pendingWriteItems")
    lag = health.get("writeLagMs")
    if any(isinstance(v, bool) or not isinstance(v, (int, float))
           or not math.isfinite(v) or v < 0 for v in (pending, lag)):
        return True
    return pending > max_pending_write_items or lag > max_write_lag_ms


def wait_if_needed(path, *, sleep=time.sleep, clock=None, max_wait_s=None, **thresholds):
    """Block between batches while `should_pause` -- design lock 19 0.8:
    "the converter sleeps 5 s and re-checks". A no-op when `path` is falsy:
    no configured health-file location means there is no collector to
    coordinate with (local dev, CI, a host not also running one) -- that is
    a normal, safe state, not something to treat as "missing, therefore
    pause forever". Once a real path *is* configured, a missing file at
    that path means something (the collector that's supposed to be there
    isn't) and `should_pause` correctly treats that as a reason to wait.

    `max_wait_s` is a test/safety escape hatch (never used in production,
    where waiting for the collector to recover is exactly the point) so a
    permanently-missing health file can't hang a caller forever by accident.
    """
    if not path:
        return
    clock = clock or (lambda: _dt.datetime.now(_dt.timezone.utc))
    waited = 0.0
    while should_pause(read_health(path), clock(), **thresholds):
        if max_wait_s is not None and waited >= max_wait_s:
            raise ThrottleError(f"THROTTLE_MAX_WAIT_EXCEEDED:{path}")
        sleep(PAUSE_INTERVAL_S)
        waited += PAUSE_INTERVAL_S
