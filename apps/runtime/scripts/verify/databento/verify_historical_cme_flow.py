"""Reconcile native CME trade order, then qualify the real engine against retained L1 flow."""

from __future__ import annotations

import argparse
from collections import Counter
import datetime as dt
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import duckdb

from fetch_verified_part import DATA_ROOT
from fetch_verified_partition import MAX_SOURCE_BYTES
from inspect_historical_native_dbn import admit_source, native_records
from verify_historical_equity_flow import reference_samples
from verify_historical_topn_partition import json_depth_fields, ordered_depth_parts, verified_files


MAX_TRADE_BYTES = 1024 * 1024 * 1024
MAX_TRADE_ROWS = 2_000_000
SIGNATURE = "event_ns, receive_ns, sequence, dbn_publisher_id, dbn_source_flags, side, price, size"


def fixed9(value: int) -> str:
    if not 0 < value < 9223372036854775807:
        raise ValueError("native price must be positive and defined")
    whole, fraction = divmod(value, 1_000_000_000)
    return f"{whole}.{fraction:09d}"


def levels(record, side: str) -> list[dict]:
    result = []
    for level in record.levels:
        price, size = getattr(level, side + "_px"), getattr(level, side + "_sz")
        if price == 9223372036854775807 or size == 0:
            continue
        result.append({"price": fixed9(price), "size": str(size)})
    return result


def extract_trades(records, date: str, output: Path, expected_rows: int) -> dict:
    start = int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    end = start + 86_400_000_000_000
    previous_book = None
    previous_time = None
    actions = Counter()
    total, trades, written, outside = 0, 0, 0, 0
    with output.open("xb") as sink:
        for index, record in enumerate(records):
            total += 1
            if total % 1_000_000 == 0:
                print(json.dumps({"nativeRows": total, "expected": expected_rows}), file=sys.stderr, flush=True)
            if total > expected_rows + 1 or len(record.levels) != 10:
                raise ValueError("native record count or depth exceeds pinned source")
            at = (record.ts_event, record.ts_recv)
            if previous_time is not None and (at[0] < previous_time[0] or at[1] < previous_time[1]):
                raise ValueError("native source time regresses")
            previous_time = at
            book = tuple((level.bid_px, level.ask_px, level.bid_sz, level.ask_sz) for level in record.levels)
            action = str(record.action)
            if action not in ("A", "C", "M", "T", "R"):
                raise ValueError("unqualified native book action")
            if action == "T" and previous_book != book:
                raise ValueError("native trade changes its preceding book; echo rule is unqualified")
            previous_book = book
            if not start <= record.ts_event < end:
                if index != 0 or record.ts_event >= start or record.ts_recv < start or action == "T":
                    raise ValueError("only a leading preceding-day book seed is admitted outside the day")
                outside += 1
                continue
            actions[action] += 1
            if action != "T":
                continue
            trades += 1
            if trades > MAX_TRADE_ROWS or str(record.side) not in ("B", "A", "N") or record.size <= 0:
                raise ValueError("native trade admission or side/size is invalid")
            row = {"native_index": str(index), "event_ns": str(record.ts_event),
                   "receive_ns": str(record.ts_recv), "sequence": record.sequence,
                   "dbn_publisher_id": record.publisher_id, "dbn_source_flags": record.flags,
                   "side": {"B": "BUY", "A": "SELL", "N": "UNKNOWN"}[str(record.side)],
                   "price": fixed9(record.price), "size": str(record.size),
                   "bids": levels(record, "bid"), "asks": levels(record, "ask")}
            encoded = (json.dumps(row, separators=(",", ":")) + "\n").encode()
            written += len(encoded)
            if written > MAX_TRADE_BYTES:
                raise ValueError("native trade spool exceeds byte admission")
            sink.write(encoded)
    if total - outside != expected_rows or not trades:
        raise ValueError("native in-day count or trades disagree with pinned day")
    return {"decodedRows": total, "outsideDaySeeds": outside, "trades": trades,
            "tradeBookChanges": 0, "spoolBytes": written, "actions": dict(actions)}


def reconcile(connection, depth_files: list[str], trade_files: list[str], native_path: Path,
              depth: dict, trade: dict, digest: str) -> list[tuple]:
    connection.execute("CREATE TEMP TABLE native AS SELECT native_index::BIGINT AS native_index, "
                       "event_ns::BIGINT AS event_ns, receive_ns::BIGINT AS receive_ns, sequence, "
                       "dbn_publisher_id, dbn_source_flags, side, price::DECIMAL(38,12) AS price, "
                       "size::DECIMAL(38,12) AS size, "
                       "list_transform(bids, l -> struct_pack(price:=l.price::DECIMAL(38,12), size:=l.size::DECIMAL(38,12))) AS bids, "
                       "list_transform(asks, l -> struct_pack(price:=l.price::DECIMAL(38,12), size:=l.size::DECIMAL(38,12))) AS asks "
                       "FROM read_json(?, format='newline_delimited', columns={native_index:'VARCHAR', event_ns:'VARCHAR', "
                       "receive_ns:'VARCHAR', sequence:'BIGINT', dbn_publisher_id:'BIGINT', dbn_source_flags:'INTEGER', "
                       "side:'VARCHAR', price:'VARCHAR', size:'VARCHAR', "
                       "bids:'STRUCT(price VARCHAR, size VARCHAR)[]', asks:'STRUCT(price VARCHAR, size VARCHAR)[]'})",
                       [str(native_path)])
    connection.execute("CREATE TEMP TABLE trades AS SELECT * FROM read_parquet(?)", [trade_files])
    invalid = connection.execute("SELECT count(*) FROM trades WHERE instrument_id IS DISTINCT FROM ? "
                                 "OR source_dataset IS DISTINCT FROM 'GLBX.MDP3' OR source_schema IS DISTINCT FROM 'mbp-1' "
                                 "OR dbn_publisher_id IS DISTINCT FROM 1 OR dbn_source_action IS DISTINCT FROM 'T' "
                                 "OR trade_action IS DISTINCT FROM 'NEW' OR valid_tick IS DISTINCT FROM true "
                                 "OR side IS NULL OR side NOT IN ('BUY','SELL','UNKNOWN') "
                                 "OR price IS NULL OR price<=0 OR size IS NULL OR size<=0 OR size<>trunc(size) "
                                 "OR event_ns IS NULL OR receive_ns IS NULL OR sequence IS NULL "
                                 "OR dbn_source_flags IS NULL OR record_id IS NULL OR record_id=''",
                                 [trade["instrument_id"]]).fetchone()[0]
    rows, unique, lineages = connection.execute(
        "SELECT count(*), count(DISTINCT record_id), count(DISTINCT lineage_sha256) FROM trades").fetchone()
    if invalid or rows != trade["record_count"] or unique != rows or lineages != 1:
        raise ValueError("L1 trade source identity, uniqueness or count is unqualified")
    differences = connection.execute(
        f"SELECT count(*) FROM ((SELECT {SIGNATURE}, count(*) AS n FROM native GROUP BY ALL "
        f"EXCEPT SELECT {SIGNATURE}, count(*) AS n FROM trades GROUP BY ALL) UNION ALL "
        f"(SELECT {SIGNATURE}, count(*) AS n FROM trades GROUP BY ALL "
        f"EXCEPT SELECT {SIGNATURE}, count(*) AS n FROM native GROUP BY ALL))").fetchone()[0]
    if differences:
        raise ValueError("native and L1 trade multisets differ")
    invalid_depth = connection.execute(
        "SELECT count(*) FROM read_parquet(?) WHERE source_dataset IS DISTINCT FROM 'GLBX.MDP3' "
        "OR source_schema IS DISTINCT FROM 'mbp-10' OR dbn_publisher_id IS DISTINCT FROM 1 "
        "OR lineage_sha256 IS DISTINCT FROM ? OR stable_position IS DISTINCT FROM lineage_row "
        "OR source_rank IS NULL OR source_rank<0 OR ordinal IS DISTINCT FROM 0", [depth_files, digest]).fetchone()[0]
    shape = connection.execute("SELECT count(*), count(DISTINCT lineage_row), min(lineage_row), max(lineage_row), "
                               "count(DISTINCT source_rank) "
                               "FROM read_parquet(?)", [depth_files]).fetchone()
    if (invalid_depth or shape[0] != depth["record_count"] or shape[1] != shape[0]
            or shape[2] not in (0, 1) or shape[3] != shape[2] + shape[0] - 1 or shape[4] != 1):
        raise ValueError("canonical depth does not retain a complete native row order")
    connection.execute("""
        CREATE TEMP TABLE anchors AS WITH source_trades AS (
            SELECT *, row_number() OVER (PARTITION BY event_ns, receive_ns, sequence, dbn_publisher_id,
                                         dbn_source_flags, side, price, size ORDER BY lineage_row) AS occurrence
            FROM trades
        ), native_trades AS (
            SELECT *, row_number() OVER (PARTITION BY event_ns, receive_ns, sequence, dbn_publisher_id,
                                         dbn_source_flags, side, price, size ORDER BY native_index) AS occurrence
            FROM native
        ) SELECT d.event_ns, d.source_rank, d.stable_position, d.ordinal, n.side, t.price, t.size,
                 'raw:' || ? || ':' || n.native_index AS record_id
          FROM native_trades n JOIN source_trades t
            USING(event_ns, receive_ns, sequence, dbn_publisher_id, dbn_source_flags, side, price, size, occurrence)
          JOIN read_parquet(?) d ON d.lineage_row=n.native_index
           AND d.event_ns=n.event_ns AND d.receive_ns=n.receive_ns AND d.sequence=n.sequence
           AND d.dbn_source_flags=n.dbn_source_flags AND d.bids=n.bids AND d.asks=n.asks
    """, [digest, depth_files])
    count, unique = connection.execute("SELECT count(*), count(DISTINCT stable_position) FROM anchors").fetchone()
    if count != rows or unique != rows:
        raise ValueError("native trade books do not match exactly one retained depth row each")
    totals = connection.execute("SELECT side, count(*), sum(size)::VARCHAR FROM trades GROUP BY side").fetchall()
    if any(Decimal(volume) > 9007199254740991 for _side, _count, volume in totals):
        raise ValueError("day trade volume exceeds exact engine range")
    connection.execute("DROP TABLE native")
    connection.execute("DROP TABLE trades")
    return totals


def worker_identity(depth_plan: dict, trade_plan: dict, digest: str, tick_size: str) -> dict:
    script = Path(__file__).with_name("verify-historical-equity-flow.js")
    root = Path(__file__).parents[3] / "src" / "indicators" / "l2-memory"
    code = hashlib.sha256()
    dependencies = ("memory-engine", "level-ledger", "size-history", "flow-window", "input-frames",
                    "historical-topn-frames", "historical-source-runner")
    for path in [script, Path(__file__), *[root / (name + ".js") for name in dependencies]]:
        code.update(path.name.encode() + b"\0" + path.read_bytes() + b"\0")
    return {"depthPlan": depth_plan, "tradePlan": trade_plan, "rawSha256": digest,
            "tickSize": tick_size, "producerCodeSha256": code.hexdigest(), "mode": "native-trade-echo"}


def verify(raw_path: Path, depth_path: Path, trade_path: Path, tick_size: str, node: str,
           worker_report: Path | None = None, reuse_worker: bool = False, worker_sha256: str | None = None) -> dict:
    started = time.monotonic()
    if worker_report is not None and (
            worker_report.parent.resolve() != DATA_ROOT.resolve() or worker_report.suffix != ".json"
            or worker_report.resolve() in {p.resolve() for p in (raw_path, depth_path, trade_path)}):
        raise ValueError("worker report must be a separate JSON file under ignored pilot data")
    if reuse_worker and (worker_report is None or worker_sha256 is None):
        raise ValueError("rechecking requires a pinned worker report and its recorded SHA-256")
    depth_plan, depth_files, digest = admit_source(raw_path, depth_path)
    trade_plan, trade_files = verified_files(trade_path, MAX_SOURCE_BYTES)
    depth, trade = depth_plan["partition"], trade_plan["partition"]
    identity = worker_identity(depth_plan, trade_plan, digest, tick_size)
    if (trade["family"] != "trade" or trade["instrument_id"] != depth["instrument_id"]
            or trade["date"] != depth["date"]):
        raise ValueError("matching instrument/day L1 trade authority is required")
    if shutil.disk_usage(DATA_ROOT).free < MAX_TRADE_BYTES + 4 * 1024 ** 3:
        raise ValueError("insufficient pilot disk for native trades plus bounded spill")
    with tempfile.TemporaryDirectory(dir=DATA_ROOT, prefix="cme-flow-") as scratch:
        connection = duckdb.connect(config={"threads": "1", "memory_limit": "256MB", "temp_directory": scratch,
                                            "max_temp_directory_size": "4GB", "preserve_insertion_order": "false"})
        try:
            parts = ordered_depth_parts(connection, depth_plan, depth_files)
            spool = Path(scratch) / "native-trades.jsonl"
            records = native_records(raw_path, depth["date"])
            try:
                native = extract_trades(records, depth["date"], spool, depth["record_count"])
            finally:
                records.close()
            totals = reconcile(connection, depth_files, trade_files, spool, depth, trade, digest)
            print(json.dumps({"phase": "native_order_and_l1_multiset_verified", "trades": native["trades"]}),
                  file=sys.stderr, flush=True)
            if reuse_worker:
                if worker_report.stat().st_size > 4 * 1024 * 1024:
                    raise ValueError("worker report exceeds admission")
                encoded_worker = worker_report.read_bytes()
                if hashlib.sha256(encoded_worker).hexdigest() != worker_sha256:
                    raise ValueError("worker report SHA-256 pin changed")
                saved = json.loads(encoded_worker)
                if saved.get("status") != "UNRECONCILED" or saved.get("identity") != identity:
                    raise ValueError("saved worker does not match pinned source, geometry and producer code")
                result = saved["oracle"]
                count = result["rows"]
            else:
                result, count = replay(connection, parts, depth, tick_size, node)
                if worker_report is not None:
                    pending = worker_report.with_suffix(".pending")
                    pending.write_text(json.dumps({"status": "UNRECONCILED", "identity": identity,
                                                   "oracle": result}), encoding="utf-8")
                    pending.replace(worker_report)
                    print(json.dumps({"phase": "unreconciled_worker_saved", "name": worker_report.name,
                                      "sha256": hashlib.sha256(worker_report.read_bytes()).hexdigest()}),
                          file=sys.stderr, flush=True)
            print(json.dumps({"phase": "node_complete", "depthRows": count, "samples": len(result["samples"])}),
                  file=sys.stderr, flush=True)
            if count != depth["record_count"] or result["rows"] != count:
                raise ValueError("replayed depth count differs from catalog")
            for side, rows, volume in totals:
                if result["observed"][side] != {"count": rows, "volume": int(Decimal(volume))}:
                    raise ValueError("observed trade totals disagree with L1 archive")
            checked = reference_samples(connection, result)
            return {"depth": depth, "trade": trade, "rawSha256": digest, "native": native,
                    "producerIdentity": identity,
                    "referenceCodeSha256": hashlib.sha256(Path(__file__).with_name(
                        "verify_historical_equity_flow.py").read_bytes()).hexdigest(),
                    "scope": "native-order book and known-side flow only; lifecycle and full-month coverage remain open",
                    "order": "native MBP-10 lineage row; verified T echo then trade", "independentFlowSamples": checked,
                    "totalElapsedSeconds": round(time.monotonic() - started, 2), "oracle": result}
        finally:
            connection.close()


def replay(connection, parts, depth: dict, tick_size: str, node: str) -> tuple[dict, int]:
    script = Path(__file__).with_name("verify-historical-equity-flow.js")
    count = 0
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        with subprocess.Popen([node, str(script), "-", tick_size, "native-trade-echo"], stdin=subprocess.PIPE,
                              stdout=output, stderr=errors) as process:
            try:
                for first, last, path in parts:
                    cursor = connection.execute(
                        f"SELECT to_json(struct_pack({json_depth_fields('d.')}, date:=?, "
                        "observation_only:=a.record_id IS NOT NULL, "
                        "matched_trade:=CASE WHEN a.record_id IS NULL THEN NULL ELSE struct_pack("
                        "record_id:=a.record_id, event_ns:=a.event_ns::VARCHAR, side:=a.side, "
                        "price:=a.price::VARCHAR, size:=a.size::VARCHAR) END)) "
                        "FROM read_parquet(?) d LEFT JOIN "
                        "(SELECT * FROM anchors WHERE stable_position BETWEEN ? AND ?) a "
                        "USING(event_ns, source_rank, stable_position, ordinal) "
                        "ORDER BY d.event_ns, d.source_rank, d.stable_position, d.ordinal",
                        [depth["date"], path, first[2], last[2]])
                    while batch := cursor.fetchmany(1000):
                        process.stdin.write("".join(row[0] + "\n" for row in batch).encode())
                        count += len(batch)
                        if count % 100_000 < len(batch):
                            print(json.dumps({"replayed": count, "expected": depth["record_count"]}),
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
    return result, count

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-path", type=Path, required=True)
    parser.add_argument("--depth-plan", type=Path, required=True)
    parser.add_argument("--trade-plan", type=Path, required=True)
    parser.add_argument("--tick-size", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--worker-report", type=Path)
    parser.add_argument("--recheck-worker", action="store_true")
    parser.add_argument("--worker-sha256")
    args = parser.parse_args()
    if (args.output.parent.resolve() != DATA_ROOT.resolve() or args.output.suffix != ".json"
            or args.output.resolve() in {p.resolve() for p in
                                        (args.raw_path, args.depth_plan, args.trade_plan, args.worker_report) if p is not None}):
        parser.error("output must be a separate JSON file under ignored pilot data")
    worker_report = args.worker_report or args.output.with_suffix(".worker.json")
    result = verify(args.raw_path, args.depth_plan, args.trade_plan, args.tick_size, args.node,
                    worker_report, args.recheck_worker, args.worker_sha256)
    args.output.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
    print(json.dumps({"verifiedReport": args.output.name, "samples": result["independentFlowSamples"]}), flush=True)
