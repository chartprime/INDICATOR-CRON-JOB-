"""Encode a pinned equity day using its independently qualified first-depth trade order."""

from __future__ import annotations

import argparse
import datetime as dt
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import derive_historical_cme_core as core
from inspect_historical_trade_join import inspect
from verify_historical_equity_flow import validate_join
from verify_historical_topn_partition import json_depth_fields, ordered_depth_parts, verified_files


def joined_rows(connection, parts, date, start, expected, *, trade_observation=True):
    known = start
    count = 0
    previous_book = None
    for _first, _last, path in parts:
        cursor = connection.execute(
            f"SELECT to_json(struct_pack({json_depth_fields('d.')}, receive_ns := d.receive_ns::VARCHAR, "
            "sequence := d.sequence, native_flags := d.dbn_source_flags, lineage_row := d.lineage_row::VARCHAR, date := ?, "
            "matched_trade := CASE WHEN d.matched_id IS NULL THEN NULL ELSE struct_pack("
            "record_id := d.matched_id, event_ns := d.event_ns::VARCHAR, side := d.matched_side, "
            "price := d.matched_price::VARCHAR, size := d.matched_size::VARCHAR) END)) "
            "FROM (SELECT d.*, a.record_id AS matched_id, a.side AS matched_side, "
            "a.price AS matched_price, a.size AS matched_size "
            "FROM read_parquet(?) d LEFT JOIN anchors a "
            "USING(event_ns, source_rank, stable_position, ordinal) "
            "ORDER BY d.event_ns, d.source_rank, d.stable_position, d.ordinal) d", [date, path])
        while batch := cursor.fetchmany(1000):
            for encoded, in batch:
                row = json.loads(encoded)
                core.validate_source_flags(row["native_flags"])
                at = int(row["event_ns"])
                if not start <= at < start + 86_400_000_000_000:
                    raise ValueError("equity source outside the pinned UTC day")
                known = max(known, at, int(row["receive_ns"]))
                book = (row["bids"], row["asks"])
                row.update(known_ns=str(known), observation_only=bool(
                    trade_observation and row["matched_trade"] is not None and book == previous_book))
                previous_book = book
                if row["matched_trade"] is not None:
                    quantity = Decimal(row["matched_trade"]["size"])
                    if not quantity.is_finite() or quantity <= 0 or quantity != int(quantity) or quantity > 9007199254740991:
                        raise ValueError("equity trade requires exact integer shares")
                    row["matched_trade"]["size"] = str(int(quantity))
                count += 1
                if count > expected:
                    raise ValueError("equity source exceeds the pinned row count")
                yield row
    if count != expected:
        raise ValueError("equity source row count differs from its manifest")


def pinned_source_rank(connection, files):
    values = connection.execute("SELECT source_rank, ordinal FROM read_parquet(?) GROUP BY ALL", [files]).fetchall()
    if (len(values) != 1 or type(values[0][0]) is not int or not 0 <= values[0][0] <= 65535
            or values[0][1] != 0):
        raise ValueError("equity native source requires one exact retained rank and zero ordinal")
    return str(values[0][0])


def derive(depth, trade, quote, flow_report, flow_hash, directory, node, *, native_report, native_hash):
    if (not flow_report.resolve().is_relative_to(core.DATA_ROOT.resolve()) or flow_report.stat().st_size > 1024**2
            or core.lifecycle.digest(flow_report) != flow_hash or not directory.resolve().is_relative_to(core.DATA_ROOT.resolve())):
        raise ValueError("pinned local proof and separate ignored output required")
    accepted = json.loads(flow_report.read_text(encoding="utf-8"))
    if (accepted.get("candidateOrder") != "quote-confirmed-first-depth-then-trade/1"
            or accepted.get("scope", "book-and-known-side-flow-only") != "book-and-known-side-flow-only"
            or type(accepted.get("independentFlowSamples")) is not int or accepted["independentFlowSamples"] < 1):
        raise ValueError("accepted independently reconciled equity flow proof required")
    proof = inspect(depth, trade, quote)
    validate_join(proof)
    if any(proof[name] != accepted[name] for name in ("depth", "trade", "quote")):
        raise ValueError("equity source lineage differs from accepted flow proof")
    from verify_historical_equity_native import validate_receipt
    validate_receipt(native_report, native_hash, proof, flow_hash)
    plan, depth_files = verified_files(depth)
    trade_plan, trade_files = verified_files(trade)
    date = plan["partition"]["date"]
    start = int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    dependencies = [Path(__file__), Path(core.__file__), core.WORKER, core.FAMILY_WORKER,
                    Path(__file__).with_name("inspect_historical_trade_join.py"),
                    Path(__file__).with_name("verify_historical_equity_flow.py"),
                    Path(__file__).with_name("verify_historical_topn_partition.py")]
    dependencies += [core.CONVERSION / (name + ".py") for name in
                     ("historical_l2_lifecycles", "historical_l2_seconds", "historical_l2_events")]
    dependencies.append(Path(__file__).with_name("verify_historical_equity_native.py"))
    dependencies.append(Path(__file__).with_name("inspect_historical_native_dbn.py"))
    root = Path(__file__).parents[3] / "src/indicators/l2-memory"
    dependencies += [root / (name + ".js") for name in ("memory-engine", "level-ledger", "flow-window", "size-history",
        "input-frames", "historical-topn-frames", "historical-source-runner", "historical-event-tap", "historical-level-events", "historical-second-sampler")]
    identity = {"method": "equity-first-depth-full-day-encoding/2", "depth": proof["depth"], "trade": proof["trade"],
                "quote": proof["quote"], "sourcePlans": [[path.name, core.lifecycle.digest(path)] for path in (depth, trade, quote)],
                "flowReportSha256": flow_hash, "nativeOrderReportSha256": native_hash,
                "tickSize": "0.01", "depthLimit": 10, "pruneEveryMs": 1000,
                "knowledge": "max(previous_known_ns,event_ns,receive_ns)",
                "nodeVersion": subprocess.run([node, "--version"], check=True, capture_output=True, text=True).stdout.strip(),
                "pythonVersion": sys.version, "duckdbVersion": core.lifecycle.duckdb.__version__,
                "budgets": {"eventRows": core.lifecycle.MAX_ROWS, "stateRows": core.seconds.MAX_ROWS,
                            "outputJsonBytes": core.MAX_OUTPUT_BYTES, "partRows": core.lifecycle.MAX_PART_ROWS,
                            "partBytes": core.lifecycle.MAX_PART_BYTES, "partDecodedBytes": core.lifecycle.MAX_PART_DECODED,
                            "minimumFreeDiskBytes": core.MIN_FREE_DISK},
                "code": [[path.name, core.lifecycle.digest(path)] for path in dependencies]}
    config = {"identity": identity, "derivationId": hashlib.sha256(json.dumps(identity, separators=(",", ":"), sort_keys=True).encode()).hexdigest(),
              "instrumentId": plan["partition"]["instrument_id"], "fromNs": str(start), "toNs": str(start + 86_400_000_000_000),
              "tickSize": "0.01", "tradePolicy": "equity-trade-observation", "expectedRows": plan["partition"]["record_count"]}
    expected = {name: accepted["oracle"][name] for name in ("rows", "trusted", "observed", "outsideTrust", "applied", "segments")}
    with tempfile.TemporaryDirectory(dir=depth.parent, prefix="equity-core-") as scratch:
        connection = core.lifecycle.duckdb.connect(config={"threads": "1", "memory_limit": "512MB",
            "temp_directory": scratch, "max_temp_directory_size": "4GB", "preserve_insertion_order": "false"})
        try:
            parts = ordered_depth_parts(connection, plan, depth_files)
            source_rank = pinned_source_rank(connection, depth_files)
            identity["sourceRank"] = source_rank
            config["sourceRank"] = source_rank
            config["derivationId"] = hashlib.sha256(json.dumps(identity, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
            connection.execute("CREATE TEMP TABLE trades AS SELECT record_id, event_ns, receive_ns, sequence, "
                               "source_dataset, dbn_publisher_id, side, price, size FROM read_parquet(?)", [trade_files])
            invalid = connection.execute("SELECT count(*) FROM trades WHERE price IS NULL OR price<=0 "
                                         "OR size IS NULL OR size<=0 OR size<>trunc(size) OR size>9007199254740991").fetchone()[0]
            if invalid:
                raise ValueError("equity source requires positive exact integer shares and prices")
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
                raise ValueError("anchored equity trades disagree with the manifest")
            if connection.execute("SELECT count(*) FROM (SELECT event_ns, source_rank, stable_position, ordinal "
                                  "FROM anchors GROUP BY ALL HAVING count(*)>1)").fetchone()[0]:
                raise ValueError("multiple trades share a depth anchor")
            return core.encode(joined_rows(connection, parts, date, start, config["expectedRows"]), config,
                               directory, node, expected_summary=expected)
        finally:
            connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("depth-plan", "trade-plan", "quote-plan", "flow-report", "native-order-report", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--flow-report-sha256", required=True)
    parser.add_argument("--native-order-report-sha256", required=True)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    result = derive(args.depth_plan, args.trade_plan, args.quote_plan, args.flow_report, args.flow_report_sha256, args.output, args.node,
                    native_report=args.native_order_report, native_hash=args.native_order_report_sha256)
    print(json.dumps({"output": str(args.output), "families": result["families"]}), flush=True)
