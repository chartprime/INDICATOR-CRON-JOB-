"""Run a frozen August plan with bounded workers and revalidated day-level resumption."""

from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import datetime as dt
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time

from fetch_verified_part import DATA_ROOT
from local_lock import LocalLock
from plan_historical_core_month import digest, plan
from validate_historical_core_day import read_json, validate


SCRIPTS = Path(__file__).resolve().parent
RUNTIME = SCRIPTS.parents[2]
MAX_WORKERS = 2


def atomic_json(path, value):
    temporary = path.with_suffix(".pending")
    if temporary.is_symlink() or path.is_symlink():
        raise ValueError("run journal must not be a symlink")
    with temporary.open("w", encoding="utf-8") as sink:
        json.dump(value, sink, sort_keys=True, allow_nan=False)
        sink.flush()
        os.fsync(sink.fileno())
    temporary.replace(path)
    if os.name == "posix":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def code_identity(node):
    files = [*SCRIPTS.glob("*.py"), *SCRIPTS.glob("*.js"),
             *(RUNTIME / "conversion").glob("*.py"), *(RUNTIME / "src/indicators/l2-memory").glob("*.js")]
    version = subprocess.run([node, "--version"], check=True, capture_output=True, text=True, timeout=15).stdout.strip()
    if version != "v24.21.0":
        raise ValueError("pinned Node 24.21.0 required")
    return {"node": version, "python": sys.version,
            "files": {str(path.relative_to(RUNTIME)).replace("\\", "/"): digest(path) for path in sorted(files)}}


def stop_child(child):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        child.wait()
        return
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def drive(catalog, pin, session, node, stem, stopped):
    if os.name != "posix":
        raise ValueError("monthly execution requires the Linux converter host")
    arguments = [sys.executable, str(SCRIPTS / "rehearse_historical_core_day.py"),
                 "--catalog", str(catalog), "--catalog-sha256", pin, "--instrument", session["instrument"],
                 "--day", session["date"], "--node", node, "--stem", stem]
    log = DATA_ROOT / (stem + "-runner.log")
    with log.open("xb") as sink, subprocess.Popen(arguments, stdout=sink, stderr=sink, start_new_session=True) as child:
        started = time.monotonic()
        try:
            while child.poll() is None:
                if stopped.wait(0.25):
                    raise InterruptedError("monthly runner stopped")
                if time.monotonic() - started > 6 * 3600:
                    raise TimeoutError("complete day exceeded six-hour work budget")
            if child.returncode:
                raise RuntimeError("day worker failed; inspect its isolated log and receipts")
        finally:
            stop_child(child)


def run(catalog, pin, node, *, workers=2, retry_failed=False, adopt=(), stopped=None, driver=drive):
    if type(workers) is not int or not 1 <= workers <= MAX_WORKERS:
        raise ValueError("monthly worker admission failed")
    inventory = plan(catalog, "2026-08", pin)
    identity = code_identity(node)
    root = DATA_ROOT / ("month-2026-08-" + inventory["plan_id"][:12])
    if root.is_symlink():
        raise ValueError("run directory must not be a symlink")
    root.mkdir(parents=True, exist_ok=True)
    stop = threading.Event() if stopped is None else stopped
    with LocalLock(root / "run.guard"):
        journal = root / "run.json"
        if journal.exists():
            state = read_json(journal, 8 * 1024**2)
            if (state.get("plan") != inventory or state.get("identity") != identity
                    or state.get("schema") != "historical-l2-month-run/1"):
                raise ValueError("resumption source plan or code/runtime differs")
        else:
            state = {"schema": "historical-l2-month-run/1", "plan": inventory, "identity": identity,
                     "publication": "NOT_PUBLISHED", "sessions": {}}
            for session in inventory["sessions"]:
                key = session["instrument"] + "/" + session["date"]
                pending = session["reason"] == "AWAITING_FULL_DAY_QUALIFICATION"
                state["sessions"][key] = {"state": "PENDING" if pending else "UNAVAILABLE",
                                          "reason": session["reason"], "attempts": []}
        by_key = {row["instrument"] + "/" + row["date"]: row for row in inventory["sessions"]}
        if set(state["sessions"]) != set(by_key):
            raise ValueError("resumption session inventory differs")

        def persist():
            state["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
            atomic_json(journal, state)

        for stem in adopt:
            matching = [row for row in inventory["sessions"]
                        if re.fullmatch(re.escape(f"stage3-{row['instrument'].lower()}-{row['date']}")
                                        + r"(?:-a[0-9]{4})?", stem)]
            if len(matching) != 1 or matching[0]["reason"] != "AWAITING_FULL_DAY_QUALIFICATION":
                raise ValueError("adopted day is outside the admitted inventory")
            session = matching[0]
            proof = validate(DATA_ROOT, stem, session, inventory["plan_id"], pin)
            entry = state["sessions"][session["instrument"] + "/" + session["date"]]
            if entry["state"] not in ("PENDING", "AVAILABLE") or entry.get("proof", proof) != proof:
                raise ValueError("adopted day conflicts with existing run")
            entry.update(state="AVAILABLE", proof=proof)
        pending = []
        for key, entry in state["sessions"].items():
            session = by_key[key]
            if entry["state"] == "AVAILABLE":
                proof = validate(DATA_ROOT, entry["proof"]["stem"], session, inventory["plan_id"], pin)
                if proof != entry["proof"]:
                    raise ValueError("completed day changed during resumption")
            elif entry["state"] == "UNAVAILABLE":
                if entry["reason"] != session["reason"] or session["reason"] == "AWAITING_FULL_DAY_QUALIFICATION":
                    raise ValueError("unavailable day disposition differs from source plan")
            elif entry["state"] in ("PENDING", "RUNNING", "FAILED", "INTERRUPTED"):
                if session["reason"] != "AWAITING_FULL_DAY_QUALIFICATION":
                    raise ValueError("unadmitted day cannot start a worker")
                if entry["state"] == "RUNNING":
                    status_path = DATA_ROOT / (entry["stem"] + "-status.json")
                    if status_path.exists() and read_json(status_path).get("state") == "LOCAL_VERIFIED":
                        proof = validate(DATA_ROOT, entry["stem"], session, inventory["plan_id"], pin)
                        entry.update(state="AVAILABLE", proof=proof)
                        continue
                    entry.update(state="INTERRUPTED", reason="previous runner did not record completion")
                if entry["state"] == "PENDING" or retry_failed:
                    pending.append((key, session))
            else:
                raise ValueError("unknown resumption state")
        state["state"] = "RUNNING"
        persist()
        futures = {}
        with ThreadPoolExecutor(max_workers=workers) as executor:
            try:
                while pending or futures:
                    while pending and len(futures) < workers and not stop.is_set():
                        if code_identity(node) != identity:
                            raise ValueError("frozen worker code/runtime changed before launch")
                        key, session = pending.pop(0)
                        entry = state["sessions"][key]
                        attempt = len(entry["attempts"]) + 1
                        if attempt > 9999:
                            raise ValueError("attempt count admission failed")
                        stem = f"stage3-{session['instrument'].lower()}-{session['date']}-a{attempt:04d}"
                        entry["attempts"].append(stem)
                        entry.update(state="RUNNING", reason="full-day qualification", stem=stem)
                        persist()
                        futures[executor.submit(driver, catalog, pin, session, node, stem, stop)] = (key, session, stem)
                    if not futures:
                        break
                    completed, _ = wait(futures, timeout=1, return_when=FIRST_COMPLETED)
                    for future in completed:
                        key, session, stem = futures.pop(future)
                        entry = state["sessions"][key]
                        try:
                            future.result()
                            proof = validate(DATA_ROOT, stem, session, inventory["plan_id"], pin)
                            entry.update(state="AVAILABLE", proof=proof)
                        except Exception as error:
                            entry.update(state="INTERRUPTED" if isinstance(error, InterruptedError) else "FAILED",
                                         reason=type(error).__name__)
                        persist()
            except BaseException:
                stop.set()
                for future in futures:
                    future.cancel()
                state["state"] = "INTERRUPTED"
                persist()
                raise
        if code_identity(node) != identity or digest(catalog) != pin:
            state["state"] = "INVALIDATED"
            persist()
            raise ValueError("code/runtime or source catalog changed during monthly run")
        outcomes = [entry["state"] for entry in state["sessions"].values()]
        state["state"] = "LOCAL_VERIFIED" if all(value in ("AVAILABLE", "UNAVAILABLE") for value in outcomes) else "INCOMPLETE"
        state["summary"] = {value: outcomes.count(value) for value in sorted(set(outcomes))}
        persist()
        return state


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--catalog-sha256", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--retry-failed", action="store_true", help="New attempts; previous files remain untouched")
    parser.add_argument("--adopt-day", action="append", default=[])
    args = parser.parse_args()
    stopped = threading.Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: stopped.set())
    result = run(args.catalog, args.catalog_sha256, args.node, workers=args.workers,
                 retry_failed=args.retry_failed, adopt=args.adopt_day, stopped=stopped)
    print(json.dumps({"state": result["state"], "summary": result["summary"], "publication": result["publication"]}))
    raise SystemExit(0 if result["state"] == "LOCAL_VERIFIED" else 1)
