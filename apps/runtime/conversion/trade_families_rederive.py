"""An independent recomputation of the trade-derived families, for evidence.

`trade_families.py` computes the families in DuckDB SQL. This module computes
them again in plain Python over the same trade rows -- dictionaries, loops and
`decimal.Decimal`, no SQL -- so a published family partition can be checked
against a second implementation the way the candle rungs were. Agreement
between the two is the evidence; either alone is just an implementation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from decimal import Decimal
from pathlib import Path

import duckdb

import trade_families as _families

TRADE_COLUMNS = ("event_ns", "source_rank", "stable_position", "ordinal", "source_symbol", "side", "trade_action",
                 "valid_tick", "price", "size", "trade_entity_id")


class RederiveError(RuntimeError):
    pass


def read_trades(paths):
    """The trade rows the families are defined over, in canonical order."""
    connection = duckdb.connect(config={"threads": "1"})
    try:
        rows = connection.execute(
            f"SELECT {', '.join(TRADE_COLUMNS)} FROM read_parquet(?) "
            "ORDER BY event_ns, source_rank, stable_position, ordinal", [list(paths)]).fetchall()
    finally:
        connection.close()
    return [dict(zip(TRADE_COLUMNS, row)) for row in rows]


def _executions(trades, market):
    kept = []
    for trade in trades:
        if trade["trade_action"] != "NEW" or trade["price"] is None or trade["size"] is None:
            continue
        if market == "FUTURE" and trade["valid_tick"] is False:
            continue
        kept.append(trade)
    return kept


def _bucket(price, tick_sub):
    scaled = Decimal(price) * _families.PRICE_SUBUNITS
    if scaled != scaled.to_integral_value():
        raise RederiveError(f"PRICE_NOT_FIXED9:{price}")
    return int(scaled) // tick_sub


def rederive(trades, *, market, tick_size, prints_per_side=_families.PRINTS_PER_SIDE):
    """All four families from trade rows, as canonical text rows keyed like the stage's."""
    executions = _executions(trades, market)
    source_symbol = {t["source_symbol"] for t in executions}
    if len(source_symbol) > 1:
        raise RederiveError("SOURCE_IDENTITY_MIXED")
    symbol = source_symbol.pop() if source_symbol else None
    tick_sub = _families.tick_subunits(tick_size)
    minute_ns, slice_ns = _families.MINUTE_NS, _families.SLICE_NS

    minutes, levels, slices, sided_by_minute = {}, {}, {}, {}
    for trade in executions:
        price, size = Decimal(trade["price"]), Decimal(trade["size"])
        notional = price * size
        side = trade["side"]
        minute = int(trade["event_ns"]) - int(trade["event_ns"]) % minute_ns
        m = minutes.setdefault(minute, {"volume": Decimal(0), "buy": Decimal(0), "sell": Decimal(0), "undefined": Decimal(0),
                                        "buy_notional": Decimal(0), "sell_notional": Decimal(0), "count": 0})
        m["volume"] += size
        m["count"] += 1
        if side == "BUY":
            m["buy"] += size
            m["buy_notional"] += notional
        elif side == "SELL":
            m["sell"] += size
            m["sell_notional"] += notional
        else:
            m["undefined"] += size
        level = levels.setdefault((minute, _bucket(trade["price"], tick_sub)),
                                  {"volume": Decimal(0), "buy": Decimal(0), "sell": Decimal(0), "count": 0})
        level["volume"] += size
        level["count"] += 1
        if side == "BUY":
            level["buy"] += size
        elif side == "SELL":
            level["sell"] += size
        if side in ("BUY", "SELL"):
            slice_open = int(trade["event_ns"]) - int(trade["event_ns"]) % slice_ns
            s = slices.setdefault(slice_open, {"buy": Decimal(0), "sell": Decimal(0), "last": 0, "count": 0})
            s["buy" if side == "BUY" else "sell"] += notional
            s["last"] = max(s["last"], int(trade["event_ns"]))
            s["count"] += 1
            magnitude = size if market == "FUTURE" else notional
            if magnitude > 0:
                sided_by_minute.setdefault((minute, side), []).append((magnitude, trade))

    plain = _families._plain
    minute_rows = [{
        "source_symbol": symbol, "open_ns": str(minute), "ordinal": "0", "volume": plain(m["volume"]),
        "buy_volume": plain(m["buy"]), "sell_volume": plain(m["sell"]), "undefined_volume": plain(m["undefined"]),
        "buy_notional": plain(m["buy_notional"]), "sell_notional": plain(m["sell_notional"]), "trade_count": str(m["count"]),
    } for minute, m in sorted(minutes.items())]
    level_rows, ordinal_by_minute = [], {}
    tick_text = plain(Decimal(str(tick_size)))
    for (minute, bucket), level in sorted(levels.items()):
        ordinal = ordinal_by_minute.get(minute, 0)
        ordinal_by_minute[minute] = ordinal + 1
        level_rows.append({
            "source_symbol": symbol, "open_ns": str(minute), "ordinal": str(ordinal), "tick_size": tick_text,
            "price_bucket": str(bucket), "volume": plain(level["volume"]), "buy_volume": plain(level["buy"]),
            "sell_volume": plain(level["sell"]), "trade_count": str(level["count"]),
        })
    slice_rows = [{
        "source_symbol": symbol, "open_ns": str(slice_open), "ordinal": "0", "last_trade_ns": str(s["last"]),
        "buy_notional": plain(s["buy"]), "sell_notional": plain(s["sell"]), "trade_count": str(s["count"]),
    } for slice_open, s in sorted(slices.items())]
    print_rows = []
    for (minute, side), candidates in sorted(sided_by_minute.items(), key=lambda item: (item[0][0], item[0][1] == "SELL")):
        ranked = sorted(candidates, key=lambda entry: (
            entry[0], int(entry[1]["event_ns"]), int(entry[1]["source_rank"]), int(entry[1]["stable_position"]),
            int(entry[1]["ordinal"])), reverse=True)
        for rank, (_magnitude, trade) in enumerate(ranked[:prints_per_side], start=1):
            print_rows.append({
                "source_symbol": symbol, "open_ns": str(minute),
                "ordinal": str((prints_per_side if side == "SELL" else 0) + rank - 1), "side": side, "rank": str(rank),
                "trade_ns": str(trade["event_ns"]), "price": plain(Decimal(trade["price"])),
                "size": plain(Decimal(trade["size"])), "trade_entity_id": trade["trade_entity_id"],
            })
    return {"trade_minute": minute_rows, "trade_level": level_rows, "trade_slice": slice_rows, "trade_prints": print_rows}


def family_digest(rows):
    digest = hashlib.sha256()
    for row in rows:
        digest.update(json.dumps(row, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return digest.hexdigest()


def first_difference(expected, observed):
    for index, (left, right) in enumerate(zip(expected, observed)):
        if left != right:
            return {"row": index, "expected": left, "observed": right}
    if len(expected) != len(observed):
        return {"row": min(len(expected), len(observed)), "expected_rows": len(expected), "observed_rows": len(observed)}
    return None


PUBLISHED_COLUMNS = {
    "trade_minute": ("open_ns", "volume", "buy_volume", "sell_volume", "undefined_volume", "buy_notional", "sell_notional", "trade_count"),
    "trade_level": ("open_ns", "ordinal", "tick_size", "price_bucket", "volume", "buy_volume", "sell_volume", "trade_count"),
    "trade_slice": ("open_ns", "last_trade_ns", "buy_notional", "sell_notional", "trade_count"),
    "trade_prints": ("open_ns", "ordinal", "side", "rank", "trade_ns", "price", "size", "trade_entity_id"),
}


def read_published(paths, record_family):
    """A published family partition's rows in the stage's text shape, for comparison."""
    columns = PUBLISHED_COLUMNS[record_family]
    connection = duckdb.connect(config={"threads": "1"})
    try:
        rows = connection.execute(
            f"SELECT source_symbol, {', '.join(columns)} FROM read_parquet(?) ORDER BY event_ns, ordinal",
            [list(paths)]).fetchall()
    finally:
        connection.close()
    plain = _families._plain
    out = []
    for row in rows:
        values = dict(zip(("source_symbol",) + columns, row))
        text = {"source_symbol": values["source_symbol"], "open_ns": str(values["open_ns"]),
                "ordinal": str(values.get("ordinal", 0))}
        for column in columns:
            if column in ("open_ns", "ordinal"):
                continue
            value = values[column]
            text[column] = plain(value) if isinstance(value, Decimal) else str(value)
        out.append(text)
    return out


def read_candle_volumes(paths, bucket_ns=_families.MINUTE_NS):
    """Traded volume per minute of a published candle partition, whatever rung it
    holds: the converted equity and futures candles are one-second bars, so the
    bars are summed into the minute the trade families use."""
    connection = duckdb.connect(config={"threads": "1"})
    try:
        rows = connection.execute(
            f"SELECT open_ns - open_ns % {int(bucket_ns)} AS bucket_ns, SUM(volume), count(*) "
            "FROM read_parquet(?) GROUP BY bucket_ns ORDER BY bucket_ns", [list(paths)]).fetchall()
    finally:
        connection.close()
    return {str(bucket): _families._plain(volume) for bucket, volume, _ in rows}, sum(count for _, _, count in rows)


def receive_time_attribution(paths, minute_ns_values, *, market):
    """What a minute's candle disagreement must equal if the provider buckets a
    bar on the receive timestamp while the families bucket on the exchange
    timestamp: the size whose event is in the minute but whose receive is not,
    less the size whose receive is in the minute but whose event is not. A
    receive timestamp is not always the later of the two -- GLBX carries prints
    whose capture clock reads before the matching-engine clock -- so neither
    direction is assumed."""
    validity = "AND (valid_tick IS NULL OR valid_tick) " if market == "FUTURE" else ""
    connection = duckdb.connect(config={"threads": "1"})
    try:
        connection.read_parquet(list(paths)).create_view("attribution_raw", replace=True)
        connection.execute(
            "CREATE OR REPLACE VIEW attribution AS SELECT event_ns, receive_ns, size FROM attribution_raw "
            f"WHERE trade_action = 'NEW' AND price IS NOT NULL AND size IS NOT NULL {validity}")
        attribution = {}
        for minute_ns in minute_ns_values:
            minute = int(minute_ns)
            close = minute + _families.MINUTE_NS
            leaving, leaving_prints = connection.execute(
                "SELECT COALESCE(SUM(size), 0), count(*) FROM attribution "
                "WHERE event_ns >= ? AND event_ns < ? AND (receive_ns < ? OR receive_ns >= ?)",
                [minute, close, minute, close]).fetchone()
            arriving, arriving_prints = connection.execute(
                "SELECT COALESCE(SUM(size), 0), count(*) FROM attribution "
                "WHERE receive_ns >= ? AND receive_ns < ? AND (event_ns < ? OR event_ns >= ?)",
                [minute, close, minute, close]).fetchone()
            attribution[str(minute)] = {
                "leaving": _families._plain(leaving), "leaving_prints": leaving_prints,
                "arriving": _families._plain(arriving), "arriving_prints": arriving_prints,
                "net": _families._plain(leaving - arriving),
            }
        return attribution
    finally:
        connection.close()


def explain_mismatches(check, attribution):
    """A mismatched minute is explained when the boundary-crossing prints account
    for it exactly. Anything left over is a finding, and is reported in full."""
    explained, unexplained = [], []
    for mismatch in check["all_mismatches"]:
        entry = attribution.get(mismatch["open_ns"], {})
        delta = Decimal(mismatch["trade_volume"]) - Decimal(mismatch["candle_volume"])
        target = {**mismatch, **entry, "delta": _families._plain(delta)}
        (explained if entry and Decimal(entry["net"]) == delta else unexplained).append(target)
    return {"explained_by_receive_time": len(explained), "unexplained": len(unexplained),
            "unexplained_minutes": unexplained, "explained_sample": explained[:3],
            "boundary_crossing_prints": sum(entry["leaving_prints"] for entry in attribution.values())}


def candle_volume_check(minute_rows, candle_volumes):
    """Databento builds its one-minute OHLCV from the same executions the trade
    family aggregates, so every minute's traded volume should agree with the
    candle's. A disagreement is a finding about the L1 conversion or the
    provider's population, reported with the minutes involved -- never hidden."""
    minutes = {row["open_ns"]: row["volume"] for row in minute_rows}
    compared = [key for key in minutes if key in candle_volumes]
    mismatches = [{"open_ns": key, "trade_volume": minutes[key], "candle_volume": candle_volumes[key]}
                  for key in compared if Decimal(minutes[key]) != Decimal(candle_volumes[key])]
    return {
        "minutes_compared": len(compared), "mismatches": len(mismatches),
        "missing_in_candles": len([key for key in minutes if key not in candle_volumes]),
        "missing_in_trades": len([key for key in candle_volumes if key not in minutes]),
        "first_mismatches": mismatches[:5], "all_mismatches": mismatches,
    }


def compare(trades, published, *, market, tick_size, prints_per_side=_families.PRINTS_PER_SIDE):
    """Digests of the recomputation against the published rows, family by family."""
    recomputed = rederive(trades, market=market, tick_size=tick_size, prints_per_side=prints_per_side)
    report = {}
    for family, rows in recomputed.items():
        observed = published.get(family, [])
        report[family] = {
            "rows": len(rows), "recomputed_sha256": family_digest(rows), "published_sha256": family_digest(observed),
            "equal": rows == observed, "first_difference": first_difference(rows, observed),
        }
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, help="Synced or converter catalog snapshot (SQLite)")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--data-prefix", required=True)
    parser.add_argument("--scratch", required=True)
    parser.add_argument("--instrument", required=True, help="instrument_id:market:tick_size")
    parser.add_argument("--date", action="append", required=True)
    parser.add_argument("--families-version", required=True, help="dataset_version the family partitions were published under")
    parser.add_argument("--families-snapshot", default=None,
                        help="catalog snapshot the family partitions are resolved from when it is not --snapshot")
    parser.add_argument("--families-prefix", default=None,
                        help="namespace the family partitions are read from when it is not --data-prefix")
    parser.add_argument("--candle-family", default="candle",
                        help="partition family the population cross-check reads; the converted candles are family candle")
    parser.add_argument("--credentials", choices=["query", "convert"], default="query",
                        help="which S3 identity reads the bucket: the read-only query identity or the converter's")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    import curated_partition
    import s3_publish

    if args.credentials == "query":
        from archive_http import _build_query_s3_client as build_client
    else:
        from backfill_driver import _build_s3_client as build_client
    instrument_id, market, tick_size = args.instrument.rsplit(":", 2)
    client = build_client()
    store = s3_publish.Store(client, args.bucket, args.data_prefix)
    families_store = store if args.families_prefix is None else s3_publish.Store(client, args.bucket, args.families_prefix)
    families_snapshot = args.snapshot if args.families_snapshot is None else args.families_snapshot
    days = []
    for date in args.date:
        with tempfile.TemporaryDirectory(dir=args.scratch) as scratch:
            source = curated_partition.resolve(args.snapshot, instrument_id, "trade", date)
            trade_paths = curated_partition.fetch_verified(store, source, scratch)
            published = {}
            for record_family, partition_family in (("trade_minute", "trade_minute_1m"), ("trade_level", "trade_level_1m"),
                                                    ("trade_slice", "trade_slice_2s"), ("trade_prints", "trade_prints_1m")):
                partition = curated_partition.resolve(families_snapshot, instrument_id, partition_family, date,
                                                      dataset_version=args.families_version)
                published[record_family] = read_published(curated_partition.fetch_verified(families_store, partition, scratch),
                                                          record_family)
            report = compare(read_trades(trade_paths), published, market=market, tick_size=tick_size)
            candle_check = None
            try:
                candle = curated_partition.resolve(args.snapshot, instrument_id, args.candle_family, date)
            except curated_partition.CuratedPartitionError as error:
                candle_check = {"skipped": str(error), "family": args.candle_family}
            if candle_check is None:
                volumes, bars = read_candle_volumes(curated_partition.fetch_verified(store, candle, scratch))
                check = candle_volume_check(published["trade_minute"], volumes)
                attribution = receive_time_attribution(
                    trade_paths, [row["open_ns"] for row in check["all_mismatches"]], market=market)
                candle_check = {**{k: v for k, v in check.items() if k != "all_mismatches"},
                                **explain_mismatches(check, attribution),
                                "family": candle["family"], "dataset_version": candle["dataset_version"],
                                "candle_bars": bars, "candle_minutes": len(volumes)}
        days.append({"instrument_id": instrument_id, "date": date, "source_manifest_sha256": source["manifest_sha256"],
                     "families": report, "equal": all(f["equal"] for f in report.values()),
                     "candle_volume_check": candle_check})
        print(json.dumps({"rederived": instrument_id, "date": date, "equal": days[-1]["equal"]}), flush=True)
    result = {"version": 1, "families_version": args.families_version, "days": days,
              "equal": all(day["equal"] for day in days)}
    Path(args.output).write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    return 0 if result["equal"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
