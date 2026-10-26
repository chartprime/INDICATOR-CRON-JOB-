"""Reconcile every equity book/trade anchor to retained native MBP-10 order."""

from __future__ import annotations

import argparse
from collections import Counter
import datetime as dt
from decimal import Decimal
from itertools import zip_longest
import json
from pathlib import Path
import re

import check_historical_core_day as checker
from inspect_historical_native_dbn import admit_source, native_records
from verify_historical_cme_flow import levels

SCOPE = "complete native equity book/trade ordering; unchanged T observes, changed T applies retained book"


def same_book(left, right):
    return [(Decimal(x["price"]), Decimal(x["size"])) for x in left] == [
        (Decimal(x["price"]), Decimal(x["size"])) for x in right]


def reconcile(records, rows, expected):
    counts = Counter()
    previous = None
    for index, (native, row) in enumerate(zip_longest(records, rows)):
        if native is None or row is None:
            raise ValueError("equity native and canonical row counts differ")
        action = str(native.action)
        if action not in ("A", "C", "M", "R", "T"):
            raise ValueError("unsupported equity native action")
        if (str(native.ts_event) != row["event_ns"] or str(native.ts_recv) != row["receive_ns"]
                or native.sequence != row["sequence"] or native.flags != row["native_flags"]
                or str(index) != row["stable_position"] or str(index) != row["lineage_row"]
                or not same_book(levels(native, "bid"), row["bids"])
                or not same_book(levels(native, "ask"), row["asks"])):
            raise ValueError("equity native book/order differs from canonical source")
        trade = row["matched_trade"]
        if (action == "T") != (trade is not None):
            raise ValueError("equity native trade missing or assigned to another row")
        book = (row["bids"], row["asks"])
        observation = action == "T" and book == previous
        if row["observation_only"] != observation:
            raise ValueError("equity native observation policy differs")
        if trade is not None:
            if (trade["side"] != {"B": "BUY", "A": "SELL", "N": "UNKNOWN"}.get(str(native.side))
                    or Decimal(trade["price"]) != Decimal(native.price) / 1_000_000_000
                    or int(trade["size"]) != native.size):
                raise ValueError("equity native print differs from independent L1 anchor")
            counts["trade_observations" if observation else "trade_changed_books"] += 1
        counts[action] += 1
        counts["rows"] += 1
        previous = book
    if counts["rows"] != expected:
        raise ValueError("equity native row count differs from pinned manifest")
    return dict(counts)


def validate_receipt(path, pin, proof, flow_pin):
    if (not path.resolve().is_relative_to(checker.core.DATA_ROOT.resolve()) or path.is_symlink()
            or path.stat().st_size > 1024**2 or checker.core.lifecycle.digest(path) != pin):
        raise ValueError("equity native receipt pin failed")
    value = json.loads(path.read_text(encoding="utf-8"))
    if (value.get("scope") != SCOPE or value.get("flow_report_sha256") != flow_pin
            or any(value.get(name) != proof[name] for name in ("depth", "trade", "quote"))
            or value.get("counts", {}).get("rows") != proof["depth"]["record_count"]
            or value.get("counts", {}).get("T") != proof["trade"]["record_count"]):
        raise ValueError("equity native receipt differs from accepted sources")
    counts = value["counts"]
    if (any(type(n) is not int or n < 0 for n in counts.values())
            or counts.get("trade_observations", 0) + counts.get("trade_changed_books", 0) != counts["T"]
            or sum(counts.get(action,0) for action in ("A","C","M","R","T")) != counts["rows"]
            or not re.fullmatch(r"[0-9a-f]{64}", value.get("raw_sha256", ""))
            or not re.fullmatch(r"[0-9a-f]{64}", value.get("method_sha256", ""))
            or type(value.get("raw_bytes")) is not int or not 0 < value["raw_bytes"] <= 1024**3):
        raise ValueError("equity native receipt accounting admission failed")
    return value


def verify(raw, depth, trade, quote, flow_report):
    plan, _files, raw_pin = admit_source(raw, depth)
    proof = json.loads(flow_report.read_text(encoding="utf-8"))
    day = plan["partition"]["date"]
    start = int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    flow_pin = checker.core.lifecycle.digest(flow_report)
    config = {"identity": {"method": "equity-first-depth-full-day-encoding/2", "flowReportSha256": flow_pin,
                          **{name: proof[name] for name in ("depth", "trade", "quote")}},
              "fromNs": str(start), "expectedRows": plan["partition"]["record_count"]}
    if config["identity"]["depth"] != plan["partition"]:
        raise ValueError("native and flow source partitions differ")
    records = native_records(raw, day, dataset="XNAS.ITCH")
    rows = checker.equity_source(config, depth, trade, quote, flow_report)
    try:
        counts = reconcile(records, rows, config["expectedRows"])
    finally:
        records.close()
        rows.close()
    return {"scope": SCOPE, "raw_sha256": raw_pin, "raw_bytes": raw.stat().st_size,
            "flow_report_sha256": flow_pin, "method_sha256": checker.core.lifecycle.digest(Path(__file__)),
            **{name: proof[name] for name in ("depth", "trade", "quote")}, "counts": counts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("raw", "depth-plan", "trade-plan", "quote-plan", "flow-report", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    if not args.output.resolve().is_relative_to(checker.core.DATA_ROOT.resolve()) or args.output.suffix != ".json":
        parser.error("separate ignored local JSON output required")
    report = verify(args.raw, args.depth_plan, args.trade_plan, args.quote_plan, args.flow_report)
    with args.output.open("x", encoding="utf-8") as sink:
        sink.write(json.dumps(report, sort_keys=True))
    print(json.dumps({"report": str(args.output), "counts": report["counts"], "sha256": checker.core.lifecycle.digest(args.output)}))
