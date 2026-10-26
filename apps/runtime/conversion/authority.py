from __future__ import annotations

import functools
import datetime as dt


class AuthorityError(RuntimeError):
    pass


def source_ranks(inputs):
    keys = sorted({item["s3_key"] for item in inputs})
    return {key: rank for rank, key in enumerate(keys)}


def _candidate_key(cadence, complete, last_modified, s3_key):
    priority = 0 if (cadence == "daily" and complete) else (1 if complete else 2)
    try:
        instant = dt.datetime.fromisoformat(last_modified.replace("Z", "+00:00"))
        if instant.tzinfo is None:
            raise ValueError("timezone required")
        instant = instant.astimezone(dt.timezone.utc)
    except (ValueError, TypeError, AttributeError) as error:
        raise AuthorityError("INVALID_SOURCE_TIMESTAMP") from error
    return (priority, instant, s3_key)


def _compare(a, b):
    if a[0] != b[0]:
        return -1 if a[0] < b[0] else 1
    if a[1] != b[1]:
        return -1 if a[1] > b[1] else 1
    if a[2] != b[2]:
        return -1 if a[2] < b[2] else 1
    return 0


def resolve(inputs):
    ranks = source_ranks(inputs)
    candidates = {}
    for item in inputs:
        for cov in item["coverage"]:
            slot = (cov["instrument_id"], cov["family"], cov["date"])
            key = _candidate_key(item["cadence"], cov["complete"], item["last_modified"], item["s3_key"])
            candidates.setdefault(slot, []).append((key, item["s3_key"], cov))

    plan = []
    excluded = []
    for (instrument_id, family, date), entries in candidates.items():
        bounds = sorted({int(e[2][k]) for e in entries for k in ("from_ns", "to_ns")})
        for start, end in zip(bounds, bounds[1:]):
            active = [e for e in entries if int(e[2]["from_ns"]) <= start and int(e[2]["to_ns"]) >= end]
            if not active:
                continue
            active.sort(key=functools.cmp_to_key(lambda x, y: _compare(x[0], y[0])))
            if len(active) > 1 and any(e[2].get("coverage_unknown") for e in active):
                raise AuthorityError("UNKNOWN_COVERAGE_OVERLAP")
            winner = active[0]
            plan.append({"instrument_id": instrument_id, "family": family, "date": date,
                         "from_ns": start, "to_ns": end, "s3_key": winner[1], "source_rank": ranks[winner[1]]})
            for _, key, cov in active[1:]:
                excluded.append({"instrument_id": instrument_id, "family": family, "date": date,
                                 "s3_key": key, "reason": "NOT_AUTHORITATIVE"})

    plan.sort(key=lambda p: (p["instrument_id"], p["family"], p["date"]))
    excluded.sort(key=lambda p: (p["instrument_id"], p["family"], p["date"], p["s3_key"]))
    return plan, excluded, ranks
