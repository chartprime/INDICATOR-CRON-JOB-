"""Qualify a candidate equity depth/trade order against independent archive flow sums."""

from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import deque
from decimal import Decimal
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import duckdb

from inspect_historical_trade_join import inspect
from verify_historical_topn_partition import json_depth_fields, ordered_depth_parts, verified_files


def validate_join(proof: dict) -> None:
    if (proof["tradeDuplicateIds"] != [{"duplicate_record_ids": 0}]
            or proof["depthSourceOrdering"] != [{"event_time_regressions": 0, "receive_time_regressions": 0}]):
        raise ValueError("candidate order requires unique trades and monotone retained source time")
    if not proof["depthIdentity"] or any(
            row["source_dataset"] != "XNAS.ITCH" or row["source_schema"] != "mbp-10"
            or row["dbn_publisher_id"] != 2 or row["missing_order"] for row in proof["depthIdentity"]):
        raise ValueError("this candidate pilot supports XNAS.ITCH MBP-10 only")
    if not proof["tradeIdentity"] or any(
            row["source_dataset"] != "XNAS.ITCH" or row["source_schema"] != "mbp-1"
            or row["dbn_publisher_id"] != 2 or row["trade_action"] != "NEW"
            or row["dbn_source_action"] != "T" or row["valid_tick"] is not True
            or row["side"] not in ("BUY", "SELL", "UNKNOWN") for row in proof["tradeIdentity"]):
        raise ValueError("candidate pilot requires unmodified valid equity trades")
    matching = proof["tradeTimeQuoteMatching"]
    if not matching or sum(row["trades"] for row in matching) != proof["trade"]["record_count"] or any(
            row["quotes"] != 1 or row["first_matches"] != 1 or row["bbo_matches"] != 1
            or row["depth_rows"] not in (1, 2) for row in matching):
        raise ValueError("every trade needs one quote-confirmed first depth candidate")


def reference_samples(connection, result: dict) -> int:
    samples = result["samples"]
    if not samples or len(samples) > 10_000:
        raise ValueError("flow pilot has no trusted samples or exceeds sample admission")
    segments = {}
    previous = None
    for sample in samples:
        first, last = tuple(map(int, sample["fromKey"])), tuple(map(int, sample["throughKey"]))
        if (len(first) != 4 or len(last) != 4 or first > last or last[0] // 1_000_000 > sample["ts"]
                or previous is not None and (last < previous[0] or sample["ts"] < previous[1])):
            raise ValueError("flow samples regress or have invalid cursor bounds")
        if sample["segment"] in segments and segments[sample["segment"]][0] != first:
            raise ValueError("flow sample segment changes its seed")
        segments[sample["segment"]] = (first, last)
        previous = (last, sample["ts"])
    ranges = sorted(segments.values())
    if any(left[1] >= right[0] for left, right in zip(ranges, ranges[1:])):
        raise ValueError("trusted source ranges overlap")
    starts = [first for first, _last in ranges]
    expected_outside = {side: {"count": 0, "volume": 0} for side in ("BUY", "SELL", "UNKNOWN")}
    cursor = connection.execute("SELECT event_ns, source_rank, stable_position, ordinal, side, size "
                                "FROM anchors ORDER BY event_ns, source_rank, stable_position, ordinal")

    def source_rows():
        while batch := cursor.fetchmany(1000):
            for event, rank, position, ordinal, side, size in batch:
                key = (event, rank, position, ordinal)
                interval = bisect_right(starts, key) - 1
                if interval < 0 or key > ranges[interval][1]:
                    expected_outside[side]["count"] += 1
                    expected_outside[side]["volume"] += int(size)
                yield key, side, size

    rows = iter(source_rows())
    anchor = next(rows, None)
    window = deque()
    totals = {"BUY": Decimal(0), "SELL": Decimal(0)}
    active_first = None
    for index, sample in enumerate(samples):
        first, last = tuple(map(int, sample["fromKey"])), tuple(map(int, sample["throughKey"]))
        if first != active_first:
            window.clear()
            totals = {"BUY": Decimal(0), "SELL": Decimal(0)}
            active_first = first
        while anchor is not None and anchor[0] <= last:
            key, side, size = anchor
            if key >= first and side in totals and key[0] // 1_000_000 > sample["ts"] - 60_000:
                if len(window) >= 1_000_000:
                    raise ValueError("independent flow window exceeds row admission")
                window.append((key[0] // 1_000_000, side, size))
                totals[side] += size
            anchor = next(rows, None)
        while window and window[0][0] <= sample["ts"] - 60_000:
            _at, side, size = window.popleft()
            totals[side] -= size
        if (totals["BUY"] != Decimal(str(sample["buyVolume"]))
                or totals["SELL"] != Decimal(str(sample["sellVolume"])) or len(window) != sample["tradeCount"]):
            raise ValueError(f"independent rolling flow disagrees at sample {index}")
    for _row in rows:
        pass
    if result["outsideTrust"] != expected_outside:
        raise ValueError("outside-trust trade totals disagree with source segment ranges")
    known = sum(result["observed"][side]["count"] - expected_outside[side]["count"] for side in ("BUY", "SELL"))
    if result["applied"] != known:
        raise ValueError("engine accepted trade count disagrees with trusted source ranges")
    return len(samples)


def verify(depth_path: Path, trade_path: Path, quote_path: Path, tick_size: str, node: str,
           worker_report: Path | None = None) -> dict:
    if worker_report is not None and (
            worker_report.parent.resolve() != depth_path.parent.resolve() or worker_report.suffix != ".json"
            or worker_report.resolve() in {path.resolve() for path in (depth_path, trade_path, quote_path)}):
        raise ValueError("worker report must be a separate JSON file in the local pilot plan directory")
    started = time.monotonic()
    proof = inspect(depth_path, trade_path, quote_path)
    validate_join(proof)
    depth_plan, depth_files = verified_files(depth_path)
    trade_plan, trade_files = verified_files(trade_path)
    with tempfile.TemporaryDirectory(dir=depth_path.parent, prefix="equity-flow-") as scratch:
        connection = duckdb.connect(config={"threads": "1", "memory_limit": "512MB", "temp_directory": scratch,
                                           "max_temp_directory_size": "4GB", "preserve_insertion_order": "false"})
        try:
            parts = ordered_depth_parts(connection, depth_plan, depth_files)
            connection.execute("CREATE TEMP TABLE trades AS SELECT record_id, event_ns, receive_ns, sequence, "
                               "source_dataset, dbn_publisher_id, side, price, size FROM read_parquet(?)", [trade_files])
            invalid = connection.execute("SELECT count(*) FROM trades WHERE price IS NULL OR price<=0 "
                                         "OR size IS NULL OR size<=0 OR size<>trunc(size) OR size>9007199254740991").fetchone()[0]
            if invalid:
                raise ValueError("equity pilot requires positive exact integer shares and prices")
            connection.execute("""
                CREATE TEMP TABLE anchors AS WITH first_depth AS (
                    SELECT event_ns, source_rank, stable_position, ordinal, receive_ns, sequence,
                           source_dataset, dbn_publisher_id FROM read_parquet(?)
                    QUALIFY row_number() OVER (
                        PARTITION BY source_dataset, dbn_publisher_id, sequence, event_ns, receive_ns
                        ORDER BY source_rank, stable_position, ordinal)=1
                ) SELECT d.event_ns, d.source_rank, d.stable_position, d.ordinal,
                         t.record_id, t.side, t.price, t.size
                    FROM first_depth d JOIN trades t
                      ON t.event_ns=d.event_ns AND t.receive_ns=d.receive_ns AND t.sequence=d.sequence
                     AND t.source_dataset=d.source_dataset AND t.dbn_publisher_id=d.dbn_publisher_id
            """, [depth_files])
            if connection.execute("SELECT count(*) FROM anchors").fetchone()[0] != trade_plan["partition"]["record_count"]:
                raise ValueError("anchored trades disagree with the catalog")
            duplicate_anchors = connection.execute("SELECT count(*) FROM (SELECT event_ns, source_rank, "
                                                    "stable_position, ordinal FROM anchors GROUP BY ALL HAVING count(*)>1)").fetchone()[0]
            if duplicate_anchors:
                raise ValueError("multiple trades share a depth anchor; candidate order is ambiguous")
            totals = connection.execute("SELECT side, count(*), sum(size)::VARCHAR FROM trades GROUP BY side").fetchall()
            if any(Decimal(volume) > 9007199254740991 for _side, _count, volume in totals):
                raise ValueError("day volume exceeds exact engine integer range")
            script = Path(__file__).with_name("verify-historical-equity-flow.js")
            count = 0
            print(json.dumps({"phase": "candidate_join_verified", "trades": trade_plan["partition"]["record_count"]}),
                  file=sys.stderr, flush=True)
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                with subprocess.Popen([node, str(script), "-", tick_size], stdin=subprocess.PIPE,
                                      stdout=output, stderr=errors) as process:
                    try:
                        for _first, _last, path in parts:
                            cursor = connection.execute(
                                f"SELECT to_json(struct_pack({json_depth_fields('d.')}, date := ?, "
                                "matched_trade := CASE WHEN a.record_id IS NULL THEN NULL ELSE struct_pack("
                                "record_id := a.record_id, event_ns := a.event_ns::VARCHAR, side := a.side, "
                                "price := a.price::VARCHAR, size := a.size::VARCHAR) END)) "
                                "FROM read_parquet(?) d LEFT JOIN anchors a "
                                "USING(event_ns, source_rank, stable_position, ordinal) "
                                "ORDER BY d.event_ns, d.source_rank, d.stable_position, d.ordinal",
                                [depth_plan["partition"]["date"], path])
                            while rows := cursor.fetchmany(1000):
                                process.stdin.write("".join(row[0] + "\n" for row in rows).encode())
                                count += len(rows)
                                if count % 100_000 < len(rows):
                                    print(json.dumps({"replayed": count, "expected": depth_plan["partition"]["record_count"]}),
                                          file=sys.stderr, flush=True)
                        process.stdin.close()
                        status = process.wait()
                    except BaseException:
                        process.kill()
                        process.wait()
                        errors.seek(0)
                        message = errors.read(4096).decode(errors="replace")
                        if message:
                            raise RuntimeError(message) from None
                        raise
                if status:
                    errors.seek(0)
                    raise RuntimeError(errors.read(4096).decode(errors="replace"))
                output.seek(0)
                encoded = output.read(4 * 1024 * 1024 + 1)
                if len(encoded) > 4 * 1024 * 1024:
                    raise ValueError("flow report exceeds admission")
                result = json.loads(encoded)
            if worker_report is not None:
                worker_report.write_text(json.dumps({"status": "UNRECONCILED", "depth": depth_plan["partition"],
                                                      "trade": trade_plan["partition"], "quote": proof["quote"],
                                                      "oracle": result}), encoding="utf-8")
            print(json.dumps({"phase": "node_complete", "depthRows": count, "samples": len(result["samples"])}),
                  file=sys.stderr, flush=True)
            if count != depth_plan["partition"]["record_count"] or result["rows"] != count:
                raise ValueError("replayed depth count differs from catalog")
            for side, rows, volume in totals:
                if result["observed"][side] != {"count": rows, "volume": int(Decimal(volume))}:
                    raise ValueError("observed trade totals disagree with archive")
            if sum(result["observed"][side]["count"] for side in ("BUY", "SELL")) < result["applied"]:
                raise ValueError("engine accepted more trades than the archive")
            checked = reference_samples(connection, result)
            print(json.dumps({"phase": "independent_flow_verified", "samples": checked}), file=sys.stderr, flush=True)
            return {"depth": depth_plan["partition"], "trade": trade_plan["partition"], "quote": proof["quote"],
                    "scope": "book-and-known-side-flow-only",
                    "candidateOrder": "quote-confirmed-first-depth-then-trade/1", "independentFlowSamples": checked,
                    "totalElapsedSeconds": round(time.monotonic() - started, 2), "oracle": result}
        finally:
            connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--depth-plan", type=Path, required=True)
    parser.add_argument("--trade-plan", type=Path, required=True)
    parser.add_argument("--quote-plan", type=Path, required=True)
    parser.add_argument("--tick-size", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--worker-report", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output is not None and (
            args.output.parent.resolve() != args.depth_plan.parent.resolve() or args.output.suffix != ".json"
            or args.output.resolve() in {path.resolve() for path in
                                        (args.depth_plan, args.trade_plan, args.quote_plan, args.worker_report) if path is not None}):
        parser.error("output must be a separate JSON file in the local pilot plan directory")
    result = verify(args.depth_plan, args.trade_plan, args.quote_plan, args.tick_size, args.node, args.worker_report)
    if args.output is None:
        print(json.dumps(result, sort_keys=True))
    else:
        args.output.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
        print(json.dumps({"verifiedReport": args.output.name, "samples": result["independentFlowSamples"]}), flush=True)
