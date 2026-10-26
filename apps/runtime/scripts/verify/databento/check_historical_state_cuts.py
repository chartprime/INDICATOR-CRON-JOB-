"""Verify every stored second book and known-side price flow against source-qualified events."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import tempfile

import check_historical_core_day as checker

SCOPE = "every stored second book, knowledge bound and known-side price flow against source-qualified events; unknown flow remains independently reconciled by day"


def reconcile(events, states):
    events = iter(events)
    current = next(events, None)
    book = {"bid": {}, "ask": {}}
    prints = {"BUY": Counter(), "SELL": Counter()}
    segment = None
    counts = Counter(coverage_intervals=0, level_rows=0, known_prints=0)
    expected = None
    seen = set()
    prior = None
    known = 0
    coverage_key = coverage_known = None

    def close():
        if expected is not None and seen != set(expected):
            raise ValueError("state book or price-flow rows missing")

    for row in states:
        payload = row["payload"]
        if row["family"] != "l2_level_state_1s":
            continue
        if payload["row_kind"] == "coverage":
            close()
            cursor = tuple(map(int, row["known_key"])) if row["known_key"] is not None else None
            if prior is not None and (cursor is None or cursor < prior):
                raise ValueError("state source cursor regressed")
            prior = cursor
            while current is not None and cursor is not None and tuple(map(int, current["known_key"])) <= cursor:
                kind, value = current["event_type"], current["payload"]
                known = max(known, int(current["known_ns"]))
                point = current["price_key"]
                if kind == "segment_open":
                    book = {"bid": {}, "ask": {}}
                    segment = current["segment_id"]
                elif kind == "segment_close" and value["cause"] != "EOF":
                    book = {"bid": {}, "ask": {}}
                    segment = None
                elif kind == "level_size":
                    book[current["side"]][point] = value["size"]
                elif kind == "observation_end" and value["cause"] != "EOF":
                    book[current["side"]].pop(point, None)
                elif kind == "engine_trade":
                    side = "BUY" if current["side"] == "ask" else "SELL"
                    prints[side][point] += value["size"]
                    counts["known_prints"] += 1
                if sum(map(len, book.values())) > 8192 or sum(map(len, prints.values())) > 4096:
                    raise ValueError("state reference admission exceeded")
                current = next(events, None)
            if int(row["known_ns"]) < max(known, int(payload["close_ns"])):
                raise ValueError("state exposes evidence before its knowledge bound")
            coverage_key, coverage_known = row["known_key"], int(row["known_ns"])
            expected = {}
            seen = set()
            if payload["trusted"]:
                if payload["segment_id"] != segment:
                    raise ValueError("state segment differs from qualified events")
                visible = {side: {price: size for price, size in values.items() if size} for side, values in book.items()}
                ranges = {side: [min(values), max(values)] if values else None for side, values in visible.items()}
                if any(not 1 <= len(visible[side]) <= payload["depth_limit"] or ranges[side] != payload[side + "_range"]
                       for side in ("bid", "ask")):
                    raise ValueError("state observed range differs from qualified events")
                for price in visible["bid"].keys() | visible["ask"].keys() | prints["BUY"].keys() | prints["SELL"].keys():
                    sizes = [visible[side].get(price, 0) if ranges[side][0] <= price <= ranges[side][1] else None
                             for side in ("bid", "ask")]
                    expected[price] = (*sizes, prints["BUY"][price], prints["SELL"][price])
            elif any(prints[side] for side in prints):
                raise ValueError("known-side prints crossed a state trust boundary")
            if any(payload["flow"][side] != sum(prints[side].values()) for side in prints):
                raise ValueError("second directional flow differs from qualified events")
            prints = {"BUY": Counter(), "SELL": Counter()}
            counts["coverage_intervals"] += 1
        else:
            point = payload["price_key"]
            actual = tuple(payload[field] for field in ("bid_size", "ask_size", "buy_volume", "sell_volume"))
            if (expected is None or point in seen or expected.get(point) != actual
                    or row["known_key"] != coverage_key or int(row["known_ns"]) != coverage_known):
                raise ValueError("state book or price flow differs from qualified events")
            seen.add(point)
            counts["level_rows"] += 1
    close()
    if current is not None:
        if current["event_type"] == "engine_trade" or any(event["event_type"] == "engine_trade" for event in events):
            raise ValueError("qualified print beyond final state cursor")
    return dict(counts)


def stored(connection, directory, manifest, family):
    for part in manifest["parts"]:
        query = "SELECT * FROM read_parquet(?) ORDER BY append_position"
        if family == "events":
            query = ("SELECT segment_id,event_type,side,price_key,known_ns,known_event,known_rank,known_position,known_ordinal,payload "
                     "FROM read_parquet(?) WHERE event_type IN ('segment_open','segment_close','level_size','observation_end','engine_trade') ORDER BY append_position")
        cursor = connection.execute(query, [str(directory / part["name"])])
        columns = [value[0] for value in cursor.description]
        while batch := cursor.fetchmany(1000):
            for values in batch:
                row = dict(zip(columns, values))
                keys = [row.pop(field) for field in ("known_event", "known_rank", "known_position", "known_ordinal")]
                row["known_key"] = None if all(value is None for value in keys) else keys
                row["payload"] = json.loads(row["payload"])
                yield row


def check(directory, source_check_sha256):
    method_pin = checker.core.lifecycle.digest(Path(__file__))
    config, result, manifests = checker.load_output(directory)
    path = directory / "independent-check.json"
    if path.is_symlink() or path.stat().st_size > 1024**2 or checker.core.lifecycle.digest(path) != source_check_sha256:
        raise ValueError("state source-check pin failed")
    receipt = json.loads(path.read_text())
    if (receipt.get("scope") != "complete source walk; top-ten inferred lifecycle accounting, not order-level cancellation truth"
            or receipt.get("result_sha256") != checker.core.lifecycle.digest(directory / "result.json")
            or receipt.get("counts", {}).get("source_rows") != config["expectedRows"]
            or receipt.get("derivation_id") != config["derivationId"] or receipt.get("families") != result["families"]):
        raise ValueError("state source-check differs from complete output")
    with tempfile.TemporaryDirectory(dir=directory, prefix="state-check-") as scratch:
        options = {"threads": "1", "memory_limit": "128MB", "temp_directory": scratch, "max_temp_directory_size": "256MB"}
        with checker.core.lifecycle.duckdb.connect(config=options) as event_connection, checker.core.lifecycle.duckdb.connect(config=options) as state_connection:
            counts = reconcile(stored(event_connection, directory / "events", manifests["events"], "events"),
                               stored(state_connection, directory / "states", manifests["states"], "states"))
    if counts["known_prints"] != receipt["counts"]["engine_trade"]:
        raise ValueError("state accepted print count differs from source")
    if checker.core.lifecycle.digest(Path(__file__)) != method_pin:
        raise ValueError("state checker changed during verification")
    report = {"scope": SCOPE,
              "result_sha256": receipt["result_sha256"], "source_check_sha256": source_check_sha256,
              "derivation_id": config["derivationId"], "method_sha256": method_pin, "counts": counts}
    with (directory / "state-check.json").open("x", encoding="utf-8") as sink:
        sink.write(json.dumps(report, sort_keys=True))
    return report


def validate_receipt(directory, pin, source_pin, source_receipt, config, result):
    path = directory / "state-check.json"
    if path.is_symlink() or path.stat().st_size > 1024**2 or checker.core.lifecycle.digest(path) != pin:
        raise ValueError("state receipt pin failed")
    value = json.loads(path.read_text())
    counts = value.get("counts", {})
    if (value.get("scope") != SCOPE or value.get("result_sha256") != source_receipt["result_sha256"]
            or value.get("source_check_sha256") != source_pin or value.get("derivation_id") != config["derivationId"]
            or set(counts) != {"known_prints", "coverage_intervals", "level_rows"}
            or any(type(number) is not int or number < 0 for number in counts.values())
            or counts.get("known_prints", 0) != source_receipt["counts"]["engine_trade"]
            or counts.get("coverage_intervals", 0) + counts.get("level_rows", 0) != result["completion"]["outputRows"]["l2_level_state_1s"]):
        raise ValueError("state receipt differs from complete output")
    return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-check-sha256", required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.output, args.source_check_sha256), sort_keys=True))
