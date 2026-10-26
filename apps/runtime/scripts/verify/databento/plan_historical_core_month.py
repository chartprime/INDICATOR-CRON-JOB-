"""Freeze a read-only, hash-pinned source inventory; no day is qualified by presence."""

from __future__ import annotations

import argparse
import calendar
from collections import Counter
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from historical_l2_coverage import source_disposition


PROFILES = (
    ("XCME", "FUTURE", "ESU6", "USD", "CONTRACT"),
    ("XCME", "FUTURE", "NQU6", "USD", "CONTRACT"),
    ("XNAS", "EQUITY", "AAPL", "USD", "SHARE"),
    ("XNAS", "EQUITY", "TSLA", "USD", "SHARE"),
)


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def plan(catalog, month, catalog_sha256):
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}", month):
        raise ValueError("canonical ISO month required")
    first = dt.date.fromisoformat(month + "-01")
    last = first.replace(day=calendar.monthrange(first.year, first.month)[1])
    end = (last + dt.timedelta(days=1)).isoformat()
    if (catalog.is_symlink() or not catalog.is_file() or catalog.stat().st_size > 64 * 1024**2
            or not re.fullmatch(r"[0-9a-f]{64}", catalog_sha256) or digest(catalog) != catalog_sha256):
        raise ValueError("immutable catalog pin failed")
    sources = {}
    with sqlite3.connect(catalog.resolve().as_uri() + "?mode=ro&immutable=1", uri=True) as connection:
        if connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ValueError("catalog integrity failed")
        rows = connection.execute(
            "SELECT instrument_id,family,date,s3_prefix,manifest_sha256,record_count,dataset_version,"
            "part_count,provider,published_to_s3 FROM partitions WHERE date>=? AND date<? "
            "AND family IN ('depth','trade','quote') ORDER BY instrument_id,date,family,dataset_version",
            [first.isoformat(), end],
        ).fetchall()
    for row in rows:
        instrument, family, day, prefix, sha, count, version, parts, provider, published = row
        profile = tuple(json.loads(instrument))
        if profile not in PROFILES:
            continue
        if (dt.date.fromisoformat(day).isoformat() != day or provider != "databento"
                or not re.fullmatch(r"databento/[A-Za-z0-9/_=.-]+", prefix)
                or any(piece in ("", ".", "..") for piece in prefix.split("/"))
                or not re.fullmatch(r"[0-9a-f]{64}", sha) or type(count) is not int or count < 0
                or type(parts) is not int or parts < 0 or bool(count) != bool(parts)
                or published not in (0, 1) or not isinstance(version, str) or not version):
            raise ValueError("invalid source partition metadata")
        key = (profile, day, family)
        if key in sources:
            raise ValueError("ambiguous source partition authority")
        sources[key] = dict(zip(
            ("instrument_id", "family", "date", "s3_prefix", "manifest_sha256", "record_count",
             "dataset_version", "part_count", "provider", "published_to_s3"), row))
    sessions = []
    for profile in PROFILES:
        families = ("depth", "trade") if profile[1] == "FUTURE" else ("depth", "trade", "quote")
        for number in range(1, last.day + 1):
            day = first.replace(day=number).isoformat()
            selected = {family: sources[(profile, day, family)] for family in families
                        if (profile, day, family) in sources}
            reason = "SOURCE_ABSENT"
            if len(selected) == len(families):
                reason = "SOURCE_NOT_PUBLISHED"
                if all(partition["published_to_s3"] for partition in selected.values()):
                    reason = source_disposition(selected["depth"], selected["trade"], catalog_sha256)["reason"]
                    if reason == "AWAITING_FULL_DAY_QUALIFICATION" and any(
                            partition["record_count"] == 0 for partition in selected.values()):
                        reason = "EMPTY_REQUIRED_SOURCE"
            sessions.append({"instrument": profile[2], "profile": list(profile), "date": day,
                             "available": False, "reason": reason, "sources": selected})
    if digest(catalog) != catalog_sha256:
        raise ValueError("source catalog changed during inventory")
    value = {"schema": "historical-l2-month-plan/1", "month": month,
             "source_catalog_sha256": catalog_sha256, "sessions": sessions,
             "summary": dict(sorted(Counter(session["reason"] for session in sessions).items())),
             "publication": "NOT_PUBLISHED; each pending day requires full-source and every-state receipts"}
    value["plan_id"] = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--catalog-sha256", required=True)
    parser.add_argument("--month", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    value = plan(args.catalog, args.month, args.catalog_sha256)
    with args.output.open("x", encoding="utf-8") as sink:
        sink.write(json.dumps(value, sort_keys=True))
    print(json.dumps({"plan_id": value["plan_id"], "sessions": len(value["sessions"]), "summary": value["summary"]}))
