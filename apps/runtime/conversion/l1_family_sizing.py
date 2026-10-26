"""Measure, from curated trade partitions, what report 54's four trade-derived families would cost."""
from __future__ import annotations

import argparse
import json
import sqlite3
import time
import zlib
from pathlib import Path

import duckdb

import catalog
import curated_partition
import s3_publish
from trade_families import FAMILY_SLICE_MS, MINUTE_NS, PRINTS_PER_SIDE, SLICE_NS

PRINTS_PER_SIDE_PER_MINUTE = PRINTS_PER_SIDE
AGGRESSOR_SIDES = ("BUY", "SELL")
FAMILIES = ("trade_minute_1m", "trade_level_1m", "trade_slice_2s", "trade_prints_1m")

SizingError = curated_partition.CuratedPartitionError


def partition_for(snapshot_path, instrument_id, date):
    return curated_partition.resolve(snapshot_path, instrument_id, "trade", date)


def busiest_days(snapshot_path, instrument_id, month):
    connection = sqlite3.connect(Path(snapshot_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        return [
            {"date": date, "record_count": count}
            for date, count in connection.execute(
                "SELECT date, record_count FROM partitions WHERE instrument_id=? AND family='trade' "
                "AND date LIKE ? ORDER BY record_count DESC, date",
                [instrument_id, f"{month}-%"],
            ).fetchall()
        ]
    finally:
        connection.close()


def _encoded(rows):
    encoded = json.dumps(rows, separators=(",", ":")).encode()
    return {"rows": len(rows), "json_bytes": len(encoded), "gzip_bytes": len(zlib.compress(encoded, 6))}


def measure_parts(paths, *, tick_size, coarse_ticks=None, connection=None):
    if not (tick_size > 0):
        raise SizingError("TICK_SIZE_INVALID")
    own = connection is None
    connection = connection or duckdb.connect(config={"threads": "2"})
    try:
        connection.read_parquet(list(paths)).create_view("parts_raw", replace=True)
        connection.execute("DROP VIEW IF EXISTS trades_raw")
        connection.execute(
            "CREATE VIEW trades_raw AS SELECT event_ns, CAST(price AS DOUBLE) AS price, "
            "CAST(size AS DOUBLE) AS size, side, trade_action FROM parts_raw"
        )
        totals = connection.execute(
            "SELECT count(*), sum(CASE WHEN trade_action='NEW' THEN 1 ELSE 0 END), "
            "min(event_ns), max(event_ns) FROM trades_raw"
        ).fetchone()
        actions = dict(connection.execute(
            "SELECT trade_action, count(*) FROM trades_raw GROUP BY 1 ORDER BY 1").fetchall())
        sides = dict(connection.execute(
            "SELECT coalesce(side, 'NULL'), count(*) FROM trades_raw WHERE trade_action='NEW' GROUP BY 1 ORDER BY 1"
        ).fetchall())
        connection.execute("DROP VIEW IF EXISTS trades")
        connection.execute(
            "CREATE VIEW trades AS SELECT event_ns, price, size, side, "
            f"CAST(event_ns / {MINUTE_NS} AS BIGINT) AS minute_bucket, "
            f"CAST(event_ns / {SLICE_NS} AS BIGINT) AS slice_bucket "
            "FROM trades_raw WHERE trade_action='NEW' AND size > 0 AND price > 0"
        )
        minute_rows = connection.execute(
            "SELECT minute_bucket, "
            "sum(CASE WHEN side='BUY' THEN size ELSE 0 END), sum(CASE WHEN side='SELL' THEN size ELSE 0 END), "
            "sum(CASE WHEN side='BUY' THEN size*price ELSE 0 END), sum(CASE WHEN side='SELL' THEN size*price ELSE 0 END), "
            "sum(CASE WHEN side NOT IN ('BUY','SELL') OR side IS NULL THEN size ELSE 0 END), count(*) "
            "FROM trades GROUP BY 1 ORDER BY 1"
        ).fetchall()
        max_per_minute = max((row[6] for row in minute_rows), default=0)
        level_rows = connection.execute(
            "SELECT minute_bucket, CAST(floor(price / ? + 1e-9) AS BIGINT) AS price_bucket, "
            "sum(CASE WHEN side='BUY' THEN size ELSE 0 END), sum(CASE WHEN side='SELL' THEN size ELSE 0 END), count(*) "
            "FROM trades GROUP BY 1, 2 ORDER BY 1, 2",
            [tick_size],
        ).fetchall()
        coarse = None
        if coarse_ticks:
            coarse = _encoded(connection.execute(
                "SELECT minute_bucket, CAST(floor(price / ? + 1e-9) AS BIGINT), "
                "sum(CASE WHEN side='BUY' THEN size ELSE 0 END), sum(CASE WHEN side='SELL' THEN size ELSE 0 END), count(*) "
                "FROM trades GROUP BY 1, 2 ORDER BY 1, 2",
                [tick_size * coarse_ticks],
            ).fetchall())
        slice_rows = connection.execute(
            "SELECT max(event_ns), "
            "sum(CASE WHEN side='BUY' THEN size*price ELSE 0 END), sum(CASE WHEN side='SELL' THEN size*price ELSE 0 END) "
            "FROM trades WHERE side IN ('BUY','SELL') GROUP BY slice_bucket ORDER BY slice_bucket"
        ).fetchall()
        print_rows = connection.execute(
            "SELECT minute_bucket, side, rank, event_ns, price, size FROM ("
            "  SELECT minute_bucket, side, event_ns, price, size, "
            "  row_number() OVER (PARTITION BY minute_bucket, side ORDER BY size DESC, event_ns) AS rank "
            "  FROM trades WHERE side IN ('BUY','SELL')"
            ") WHERE rank <= ? ORDER BY minute_bucket, side, rank",
            [PRINTS_PER_SIDE_PER_MINUTE],
        ).fetchall()
    finally:
        if own:
            connection.close()
    families = {
        "trade_minute_1m": _encoded(minute_rows),
        "trade_level_1m": _encoded(level_rows),
        "trade_slice_2s": _encoded(slice_rows),
        "trade_prints_1m": _encoded(print_rows),
    }
    if coarse is not None:
        families["trade_level_1m_coarse"] = {**coarse, "ticks": coarse_ticks}
    return {
        "rows_total": totals[0], "trades_new": totals[1], "event_ns_min": totals[2], "event_ns_max": totals[3],
        "actions": actions, "sides": sides, "max_trades_per_minute": max_per_minute,
        "minutes_with_trades": len(minute_rows), "families": families,
    }


def measure_partition(store, snapshot_path, instrument_id, date, scratch_dir, *, tick_size, coarse_ticks=None):
    partition = partition_for(snapshot_path, instrument_id, date)
    manifest = curated_partition.read_manifest(store, partition)
    started = time.monotonic()
    paths = curated_partition.fetch_verified(store, partition, scratch_dir, manifest=manifest)
    try:
        fetched_s = time.monotonic() - started
        measured = measure_parts(paths, tick_size=tick_size, coarse_ticks=coarse_ticks)
    finally:
        curated_partition.discard(paths)
    if measured["rows_total"] != manifest["record_count"]:
        raise SizingError("ROW_COUNT_MISMATCH")
    return {
        "instrument_id": instrument_id, "date": date, "dataset_version": partition["dataset_version"],
        "record_count": partition["record_count"], "parts": len(manifest["parts"]),
        "curated_bytes": sum(part["bytes"] for part in manifest["parts"]),
        "fetch_seconds": round(fetched_s, 3), "measure_seconds": round(time.monotonic() - started - fetched_s, 3),
        **measured,
    }


def summarise(days):
    by_instrument = {}
    for day in days:
        entry = by_instrument.setdefault(day["instrument_id"], {"days": 0, "trades_new": 0, "families": {}})
        entry["days"] += 1
        entry["trades_new"] += day["trades_new"]
        for family, figures in day["families"].items():
            family_total = entry["families"].setdefault(family, {"rows": 0, "json_bytes": 0, "gzip_bytes": 0, "max_day_rows": 0})
            family_total["rows"] += figures["rows"]
            family_total["json_bytes"] += figures["json_bytes"]
            family_total["gzip_bytes"] += figures["gzip_bytes"]
            family_total["max_day_rows"] = max(family_total["max_day_rows"], figures["rows"])
    return by_instrument


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, help="Synced catalog snapshot (SQLite)")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--data-prefix", required=True)
    parser.add_argument("--scratch", required=True)
    parser.add_argument("--instrument", action="append", required=True,
                        help="instrument_id:tick_size[:coarse_ticks], repeatable")
    parser.add_argument("--date", action="append", default=[], help="YYYY-MM-DD, repeatable")
    parser.add_argument("--busiest-in", help="YYYY-MM: also measure each instrument's busiest day of that month")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    from archive_http import _build_query_s3_client

    store = s3_publish.Store(_build_query_s3_client(), args.bucket, args.data_prefix)
    days = []
    for spec in args.instrument:
        fields = spec.split(":")
        if len(fields) not in (2, 3):
            parser.error("--instrument expects instrument_id:tick_size[:coarse_ticks]")
        instrument_id, tick_size = fields[0], float(fields[1])
        coarse_ticks = int(fields[2]) if len(fields) == 3 else None
        dates = list(args.date)
        if args.busiest_in:
            ranked = busiest_days(args.snapshot, instrument_id, args.busiest_in)
            if ranked and ranked[0]["date"] not in dates:
                dates.append(ranked[0]["date"])
        for date in dates:
            days.append(measure_partition(store, args.snapshot, instrument_id, date, args.scratch,
                                          tick_size=tick_size, coarse_ticks=coarse_ticks))
            print(json.dumps({"measured": instrument_id, "date": date, "trades_new": days[-1]["trades_new"]}), flush=True)
    report = {
        "version": 1,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "snapshot_sha256": catalog._sha256_file(args.snapshot),
        "geometry": {"slice_ms": FAMILY_SLICE_MS, "prints_per_side_per_minute": PRINTS_PER_SIDE_PER_MINUTE},
        "days": days,
        "summary": summarise(days),
    }
    Path(args.output).write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(report["summary"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
