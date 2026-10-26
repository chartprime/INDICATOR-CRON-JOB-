"""Local full-day encoding diagnostic; no publication or lifecycle acceptance."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, suppress
import datetime as dt
import hashlib
import json
from pathlib import Path
from queue import Empty, Full, Queue
import shutil
import subprocess
import sys
from threading import Event

from inspect_historical_native_dbn import admit_source, native_records, unused_snapshot_seed_clock, validate_source_flags
from fetch_verified_part import DATA_ROOT
from verify_historical_cme_flow import fixed9, levels

CONVERSION = Path(__file__).parents[3] / "conversion"
sys.path.insert(0, str(CONVERSION))
import historical_l2_lifecycles as lifecycle
import historical_l2_seconds as seconds

WORKER = Path(__file__).with_name("derive-historical-cme-core.js")
FAMILY_WORKER = Path(__file__).with_name("write_historical_core_family.py")
MAX_OUTPUT_BYTES = 128 * 1024**3
MIN_FREE_DISK = 40 * 1024**3


def normalized(records, *, instrument, start, end, expected, raw_hash):
    previous_book = None
    count = 0
    epoch = 1
    known = start
    date = dt.datetime.fromtimestamp(start // 1_000_000_000, dt.timezone.utc).date().isoformat()
    for index, record in enumerate(records):
        validate_source_flags(int(record.flags), unused_seed_clock=unused_snapshot_seed_clock(record, index, start))
        at = int(record.ts_event)
        book = tuple((level.bid_px, level.ask_px, level.bid_sz, level.ask_sz) for level in record.levels)
        if not start <= at < end:
            if index != 0 or at >= start:
                raise ValueError("only one leading preceding-day native seed is admitted")
            previous_book = book
            continue
        action = str(record.action)
        if action not in ("A", "C", "M", "T", "R") or action == "T" and book != previous_book:
            raise ValueError("unsupported native action or changed trade echo")
        if action == "R":
            epoch += 1
        known = max(known, at, int(record.ts_recv))
        trade = None
        if action == "T":
            if int(record.size) <= 0 or int(record.price) <= 0 or int(record.price) == 9223372036854775807:
                raise ValueError("invalid native trade")
            trade = {"event_ns": str(at), "side": {"B": "BUY", "A": "SELL"}.get(str(record.side), "UNKNOWN"),
                     "price": fixed9(int(record.price)), "size": str(record.size), "record_id": f"raw:{raw_hash}:{index}"}
        count += 1
        if count > expected:
            raise ValueError("native source exceeds admitted row count")
        yield {"event_ns": str(at), "source_rank": "2", "stable_position": str(index), "ordinal": "0",
               "known_ns": str(known), "instrument_id": instrument, "depth_action": "SNAPSHOT", "depth_model": "TOP_N",
               "depth_limit": 10, "bids": levels(record, "bid"), "asks": levels(record, "ask"),
               "continuity": "RESET" if action == "R" else "OK", "book_epoch": str(epoch),
               "date": date,
               "observation_only": action == "T", "matched_trade": trade}
        previous_book = book
    if count != expected:
        raise ValueError("native source row count differs from the pinned depth day")


def encode_threaded(rows, config, directory, node, *, expected_summary):
    directory.mkdir(exist_ok=False)
    if shutil.disk_usage(directory).free < MIN_FREE_DISK:
        raise ValueError("local encoding requires 40 GiB free disk before launch")
    config_path = directory / "config.json"
    config_path.write_text(json.dumps(config, sort_keys=True), encoding="utf-8")
    abort = Event()
    queues = {name: Queue(maxsize=128) for name in ("events", "states")}
    futures = {}
    total_bytes = 0
    completion = None
    output_counts = {"l2_level_event": 0, "l2_level_state_1s": 0, "l2_book_segment": 0}
    previous_progress = 0

    def receive(queue):
        while not abort.is_set():
            try:
                item = queue.get(timeout=0.1)
            except Empty:
                continue
            if item is None:
                return
            yield item
        raise InterruptedError("core encoding aborted before source completion")

    def enqueue(name, item):
        while not abort.is_set():
            if futures[name].done():
                futures[name].result()
                raise ValueError("core writer completed before source")
            try:
                queues[name].put(item, timeout=0.1)
                return
            except Full:
                continue
        raise InterruptedError("core encoding aborted")

    with (directory / "worker.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([node, str(WORKER), str(config_path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=log, text=True, encoding="utf-8", bufsize=1)

        def feed():
            try:
                for row in rows:
                    if abort.is_set():
                        raise InterruptedError("core input cancelled")
                    line = json.dumps(row, separators=(",", ":"), allow_nan=False)
                    if len(line.encode()) > 16_384:
                        raise ValueError("core input row admission exceeded")
                    process.stdin.write(line + "\n")
                process.stdin.close()
            except BaseException:
                abort.set()
                process.kill()
                raise

        with ThreadPoolExecutor(max_workers=3) as pool:
            futures["events"] = pool.submit(lifecycle.write_parts, receive(queues["events"]), directory / "events", cancelled=abort.is_set)
            futures["states"] = pool.submit(seconds.write_parts, receive(queues["states"]), directory / "states", cancelled=abort.is_set)
            feeder = pool.submit(feed)
            try:
                while line := process.stdout.readline(16_386):
                    if len(line.encode()) > 16_384 or not line.endswith("\n"):
                        raise ValueError("core output row admission exceeded")
                    total_bytes += len(line.encode())
                    if total_bytes > MAX_OUTPUT_BYTES or completion is not None:
                        raise ValueError("core output budget or terminal order failed")
                    item = json.loads(line)
                    family = item["family"]
                    if family == "completion":
                        completion = item["row"]
                        if completion.get("outputRows") != output_counts:
                            raise ValueError("worker output counts differ from delivered families")
                    elif family == "progress":
                        progress = item["row"]
                        if (type(progress.get("rows")) is not int or not previous_progress < progress["rows"] <= config["expectedRows"]
                                or progress.get("outputRows") != output_counts):
                            raise ValueError("invalid worker progress or missing family output")
                        previous_progress = progress["rows"]
                        progress.update(expectedRows=config["expectedRows"], receivedJsonBytes=total_bytes)
                        pending = directory / "progress.pending"
                        pending.write_text(json.dumps(progress, sort_keys=True), encoding="utf-8")
                        pending.replace(directory / "progress.json")
                    elif family == "l2_level_event":
                        enqueue("events", item["row"])
                        output_counts[family] += 1
                    elif family in ("l2_level_state_1s", "l2_book_segment"):
                        enqueue("states", item["row"])
                        output_counts[family] += 1
                    else:
                        raise ValueError("unknown core output family")
                feeder.result()
                if process.wait(timeout=30) != 0 or completion is None or completion.get("derivationId") != config["derivationId"]:
                    raise ValueError("core worker failed or omitted completion")
                if any(completion.get(name) != value for name, value in expected_summary.items()):
                    raise ValueError("core source/book/flow totals differ from independent accepted day")
                for name in queues:
                    enqueue(name, None)
                manifests = {name: future.result() for name, future in futures.items()}
            finally:
                abort.set()
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=30)
                process.stdout.close()
                if not process.stdin.closed:
                    process.stdin.close()
    result = {"scope": "local complete-day encoding diagnostic; lifecycle attribution, restore and publication remain unqualified",
              "identity": config["identity"], "completion": completion, "json_bytes": total_bytes,
              "families": {name: {"manifest_sha256": lifecycle.digest(directory / name / "manifest.json"),
                                  "rows": manifest["rows"], "parts": len(manifest["parts"]),
                                  "bytes": sum(part["bytes"] for part in manifest["parts"])} for name, manifest in manifests.items()}}
    (directory / "result.json").write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
    return result


def encode(rows, config, directory, node, *, expected_summary):
    directory.mkdir(exist_ok=False)
    if shutil.disk_usage(directory).free < MIN_FREE_DISK:
        raise ValueError("local encoding requires 40 GiB free disk before launch")
    config_path = directory / "config.json"
    config_path.write_text(json.dumps(config, sort_keys=True), encoding="utf-8")
    abort = Event()
    total_bytes = 0
    completion = None
    counts = {"l2_level_event": 0, "l2_level_state_1s": 0, "l2_book_segment": 0}
    previous_progress = 0
    writers = {}
    process = None
    closing_writers = Event()
    completed = False
    with ExitStack() as resources:
        try:
            for name, limit in (("events", lifecycle.MAX_ROWS), ("states", seconds.MAX_ROWS)):
                log = resources.enter_context((directory / (name + "-writer.log")).open("wb"))
                writers[name] = subprocess.Popen([sys.executable, str(FAMILY_WORKER), name, str(directory / name), str(limit)],
                                                 stdin=subprocess.PIPE, stdout=log, stderr=log)
            log = resources.enter_context((directory / "worker.log").open("wb"))
            process = subprocess.Popen([node, str(WORKER), str(config_path)], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=log)

            def feed():
                try:
                    for row in rows:
                        if abort.is_set():
                            raise InterruptedError("core input cancelled")
                        line = (json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n").encode()
                        if len(line) > 16_384:
                            raise ValueError("core input row admission exceeded")
                        process.stdin.write(line)
                    process.stdin.close()
                except BaseException:
                    abort.set()
                    process.kill()
                    raise

            def watch_writers():
                while not abort.wait(0.1):
                    failed = any(child.poll() is not None and (not closing_writers.is_set() or child.returncode != 0)
                                 for child in writers.values())
                    if failed:
                        abort.set()
                        for child in [process, *writers.values()]:
                            if child.poll() is None:
                                with suppress(OSError):
                                    child.kill()
                        return

            with ThreadPoolExecutor(max_workers=2) as pool:
                feeder = pool.submit(feed)
                watcher = pool.submit(watch_writers)
                try:
                    while line := process.stdout.readline(16_386):
                        if len(line) > 16_384 or not line.endswith(b"\n"):
                            raise ValueError("core output row admission exceeded")
                        total_bytes += len(line)
                        if total_bytes > MAX_OUTPUT_BYTES or completion is not None:
                            raise ValueError("core output budget or terminal order failed")
                        family = None
                        for name in counts:
                            prefix = ('{"family":"' + name + '","row":').encode()
                            if line.startswith(prefix) and line.endswith(b"}\n"):
                                family = name
                                target = "events" if name == "l2_level_event" else "states"
                                if writers[target].poll() is not None:
                                    raise ValueError("core writer failed before source completion")
                                writers[target].stdin.write(line[len(prefix):-2] + b"\n")
                                counts[name] += 1
                                break
                        if family is not None:
                            continue
                        item = json.loads(line)
                        if item["family"] == "completion":
                            completion = item["row"]
                            if completion.get("outputRows") != counts:
                                raise ValueError("worker output counts differ from delivered families")
                        elif item["family"] == "progress":
                            progress = item["row"]
                            if (type(progress.get("rows")) is not int or not previous_progress < progress["rows"] <= config["expectedRows"]
                                    or progress.get("outputRows") != counts):
                                raise ValueError("invalid worker progress or missing family output")
                            previous_progress = progress["rows"]
                            progress.update(expectedRows=config["expectedRows"], receivedJsonBytes=total_bytes)
                            pending = directory / "progress.pending"
                            pending.write_text(json.dumps(progress, sort_keys=True), encoding="utf-8")
                            pending.replace(directory / "progress.json")
                        else:
                            raise ValueError("unknown core output family or malformed envelope")
                    feeder.result()
                    if process.wait(timeout=30) != 0 or completion is None or completion.get("derivationId") != config["derivationId"]:
                        raise ValueError("core worker failed or omitted completion")
                    if any(completion.get(name) != value for name, value in expected_summary.items()):
                        raise ValueError("core source/book/flow totals differ from independent accepted day")
                    closing_writers.set()
                    for writer in writers.values():
                        writer.stdin.close()
                    if any(writer.wait(timeout=120) != 0 for writer in writers.values()):
                        raise ValueError("core family writer failed")
                finally:
                    abort.set()
                    if process.poll() is None:
                        process.kill()
                    for writer in writers.values():
                        if writer.poll() is None:
                            writer.kill()
                    watcher.result()
            manifests = {name: json.loads((directory / name / "manifest.json").read_text()) for name in writers}
            if manifests["events"]["rows"] != counts["l2_level_event"] or manifests["states"]["rows"] != counts["l2_level_state_1s"] + counts["l2_book_segment"]:
                raise ValueError("sealed family counts differ from producer")
            result = {"scope": "local complete-day encoding diagnostic; lifecycle attribution, restore and publication remain unqualified",
                      "identity": config["identity"], "completion": completion, "json_bytes": total_bytes,
                      "families": {name: {"manifest_sha256": lifecycle.digest(directory / name / "manifest.json"),
                                          "rows": manifest["rows"], "parts": len(manifest["parts"]),
                                          "bytes": sum(part["bytes"] for part in manifest["parts"])} for name, manifest in manifests.items()}}
            (directory / "result.json").write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
            completed = True
            return result
        finally:
            abort.set()
            for child in [process, *writers.values()]:
                if child is not None:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=30)
                    if child.stdout is not None:
                        child.stdout.close()
                    if child.stdin is not None and not child.stdin.closed:
                        with suppress(OSError):
                            child.stdin.close()
            # A family writer can seal its manifest before a sibling's failure is seen. Once every
            # child has stopped, a failed day keeps no family manifest under the name a reader pins.
            if not completed:
                for name in writers:
                    sealed = directory / name / "manifest.json"
                    if sealed.exists():
                        sealed.replace(directory / name / "manifest.abandoned.json")


def derive(raw, depth, flow_report, flow_hash, directory, node):
    if (not flow_report.resolve().is_relative_to(DATA_ROOT.resolve()) or flow_report.stat().st_size > 1024**2
            or lifecycle.digest(flow_report) != flow_hash or not directory.resolve().is_relative_to(DATA_ROOT.resolve())):
        raise ValueError("pinned local proof and separate ignored output required")
    proof = json.loads(flow_report.read_text(encoding="utf-8"))
    plan, _, raw_hash = admit_source(raw, depth, proof["depth"])
    if (proof["rawSha256"] != raw_hash or proof.get("scope") != "native-order book and known-side flow only; lifecycle and full-month coverage remain open"
            or proof.get("order") != "native MBP-10 lineage row; verified T echo then trade"):
        raise ValueError("accepted native-order flow proof required")
    date = plan["partition"]["date"]
    start = int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    dependencies = [Path(__file__), WORKER, FAMILY_WORKER, Path(__file__).with_name("inspect_historical_native_dbn.py"),
                    Path(__file__).with_name("verify_historical_cme_flow.py"), CONVERSION / "historical_l2_lifecycles.py",
                    CONVERSION / "historical_l2_seconds.py", CONVERSION / "historical_l2_events.py"]
    root = Path(__file__).parents[3] / "src/indicators/l2-memory"
    dependencies += [root / (name + ".js") for name in ("memory-engine", "level-ledger", "flow-window", "size-history",
        "input-frames", "historical-topn-frames", "historical-source-runner", "historical-event-tap", "historical-level-events", "historical-second-sampler")]
    node_version = subprocess.run([node, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    identity = {"method": "native-cme-full-day-encoding/1", "depth": plan["partition"], "rawSha256": raw_hash,
                "flowReportSha256": flow_hash, "tickSize": "0.25", "depthLimit": 10, "pruneEveryMs": 1000,
                "knowledge": "max(previous_known_ns,event_ns,receive_ns)", "nodeVersion": node_version,
                "budgets": {"eventRows": lifecycle.MAX_ROWS, "stateRows": seconds.MAX_ROWS,
                            "outputJsonBytes": MAX_OUTPUT_BYTES, "partRows": lifecycle.MAX_PART_ROWS,
                            "partBytes": lifecycle.MAX_PART_BYTES, "partDecodedBytes": lifecycle.MAX_PART_DECODED,
                            "minimumFreeDiskBytes": MIN_FREE_DISK},
                "pythonVersion": sys.version, "duckdbVersion": lifecycle.duckdb.__version__,
                "code": [[path.name, lifecycle.digest(path)] for path in dependencies]}
    derivation = hashlib.sha256(json.dumps(identity, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    config = {"identity": identity, "derivationId": derivation, "instrumentId": plan["partition"]["instrument_id"],
              "fromNs": str(start), "toNs": str(start + 86_400_000_000_000), "tickSize": "0.25",
              "expectedRows": plan["partition"]["record_count"]}
    expected = {name: proof["oracle"][name] for name in ("rows", "trusted", "observed", "outsideTrust", "applied", "segments")}
    stream = native_records(raw, date)
    try:
        return encode(normalized(stream, instrument=config["instrumentId"], start=start, end=int(config["toNs"]),
                                 expected=config["expectedRows"], raw_hash=raw_hash), config, directory, node, expected_summary=expected)
    finally:
        stream.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--depth-plan", type=Path, required=True)
    parser.add_argument("--flow-report", type=Path, required=True)
    parser.add_argument("--flow-report-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    result = derive(args.raw, args.depth_plan, args.flow_report, args.flow_report_sha256, args.output, args.node)
    print(json.dumps({"output": str(args.output), "families": result["families"]}), flush=True)
