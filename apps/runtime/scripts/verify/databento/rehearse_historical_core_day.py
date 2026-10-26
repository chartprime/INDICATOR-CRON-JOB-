"""Run one isolated, full-day host qualification without publishing or changing services."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

import duckdb

from fetch_verified_part import DATA_ROOT, MAX_DBN_BYTES
from fetch_verified_partition import destination, MAX_SOURCE_BYTES, load_plan
from inspect_historical_l2_partition import inspect
from plan_historical_core_month import digest, plan
from local_lock import LocalLock


SCRIPTS = Path(__file__).resolve().parent
REMOTE = "ttconvert:chartprime-historical-data/"


def copy_verified(remote_key, output, size, sha256):
    if (not remote_key.startswith(("curated/databento/databento/", "raw/databento/"))
            or not re.fullmatch(r"[A-Za-z0-9/_=.-]+", remote_key)
            or any(piece in ("", ".", "..") for piece in remote_key.split("/"))
            or not output.resolve().is_relative_to(DATA_ROOT.resolve())
            or type(size) is not int or not 0 < size <= MAX_SOURCE_BYTES
            or not re.fullmatch(r"[0-9a-f]{64}", sha256)):
        raise ValueError("source transfer admission failed")
    if output.exists():
        if output.is_symlink() or output.stat().st_size != size or digest(output) != sha256:
            raise ValueError("existing source identity differs")
        return
    if shutil.disk_usage(DATA_ROOT).free < size + 40 * 1024**3:
        raise ValueError("source transfer disk reserve failed")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".pending", delete=False) as sink:
            temporary = Path(sink.name)
            with subprocess.Popen(["rclone", "cat", REMOTE + remote_key, "--contimeout", "15s", "--timeout", "60s",
                                   "--retries", "3", "--low-level-retries", "3"],
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
                count, checksum = 0, hashlib.sha256()
                try:
                    while chunk := child.stdout.read(1024**2):
                        count += len(chunk)
                        if count > size:
                            raise ValueError("source exceeds pinned size")
                        checksum.update(chunk)
                        sink.write(chunk)
                    if child.wait() != 0 or count != size or checksum.hexdigest() != sha256:
                        raise ValueError("source transfer/hash failed")
                except BaseException:
                    child.kill()
                    child.wait()
                    raise
        temporary.replace(output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def save(path, value):
    with path.open("x", encoding="utf-8") as sink:
        sink.write(json.dumps(value, sort_keys=True))


def run(catalog, catalog_pin, symbol, day, node, *, stem=None):
    if symbol not in ("ESU6", "NQU6", "AAPL", "TSLA") or not re.fullmatch(r"2026-08-[0-9]{2}", day):
        raise ValueError("day lock identity admission failed")
    if day < "2026-08-01" or day > "2026-08-31" or dt.date.fromisoformat(day).isoformat() != day:
        raise ValueError("rehearsal is confined to August 2026")
    inventory = plan(catalog, "2026-08", catalog_pin)
    selected = [session for session in inventory["sessions"] if session["instrument"] == symbol and session["date"] == day]
    if len(selected) != 1 or selected[0]["reason"] != "AWAITING_FULL_DAY_QUALIFICATION":
        raise ValueError("session has no admitted source set")
    session = selected[0]
    with LocalLock(DATA_ROOT / "_locks" / f"day-{symbol}-{day}.guard"):
        return _run_session(catalog, catalog_pin, symbol, day, node, inventory, session, stem=stem)


def _run_session(catalog, catalog_pin, symbol, day, node, inventory, session, *, stem=None):
    base_stem = f"stage3-{symbol.lower()}-{day}"
    stem = base_stem if stem is None else stem
    if not re.fullmatch(re.escape(base_stem) + r"(?:-a[0-9]{4})?", stem):
        raise ValueError("rehearsal attempt identity admission failed")
    status_path = DATA_ROOT / (stem + "-status.json")
    if status_path.exists():
        raise FileExistsError("rehearsal identity already exists; inspect its receipts before another attempt")
    started = time.monotonic()
    status = {"scope": "isolated full-day host rehearsal; NOT_PUBLISHED", "plan_id": inventory["plan_id"],
              "instrument": symbol, "date": day, "stages": [], "state": "PREPARING"}

    def progress():
        pending = status_path.with_suffix(".pending")
        pending.write_text(json.dumps(status, sort_keys=True), encoding="utf-8")
        pending.replace(status_path)

    def stage(name, script, arguments, receipt):
        status.update(state="RUNNING", active_stage=name)
        progress()
        at = time.monotonic()
        with (DATA_ROOT / (stem + "-" + name + ".log")).open("xb") as log:
            subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, arguments)],
                           stdout=log, stderr=log, check=True)
        entry = {"name": name, "seconds": round(time.monotonic() - at, 3),
                 "receipt": receipt.name, "sha256": digest(receipt)}
        status["stages"].append(entry)
        progress()
        return entry["sha256"]

    progress()
    try:
        paths = {}
        source_bytes = 0
        for family, authority in session["sources"].items():
            source = inspect(catalog, symbol, family, day, authority["dataset_version"])
            if source["partition"] != authority:
                raise ValueError("inspected source differs from frozen inventory")
            path = DATA_ROOT / (stem + "-" + family + ".json")
            save(path, source)
            load_plan(path, MAX_SOURCE_BYTES)
            paths[family] = path
            for part in source["parts"]:
                copy_verified(source["relative_prefix"] + "/" + part["name"], destination(source, part["name"]),
                              part["bytes"], part["sha256"])
                source_bytes += part["bytes"]
        depth = json.loads(paths["depth"].read_text())
        depth_files = [str(destination(depth, part["name"])) for part in depth["parts"]]
        with duckdb.connect(config={"threads": "1", "memory_limit": "256MB"}) as connection:
            lineages = connection.execute("SELECT DISTINCT lineage_sha256 FROM read_parquet(?) LIMIT 2", [depth_files]).fetchall()
        if len(lineages) != 1:
            raise ValueError("one native lineage required")
        dataset = "GLBX.MDP3" if session["profile"][1] == "FUTURE" else "XNAS.ITCH"
        raw_symbol = symbol[:2] if dataset == "GLBX.MDP3" else symbol
        prefix = f"raw/databento/dataset={dataset}/schema=mbp-10/symbol={raw_symbol}/year=2026/month=08/day={day[-2:]}/"
        result = subprocess.run(["rclone", "lsjson", REMOTE + prefix, "--files-only"], capture_output=True,
                                check=True, timeout=120)
        if len(result.stdout) > 65536:
            raise ValueError("raw listing exceeds admission")
        objects = json.loads(result.stdout)
        if (len(objects) != 1 or objects[0].get("IsDir") is not False
                or objects[0]["Path"] != objects[0]["Name"] or "/" in objects[0]["Name"]
                or "\\" in objects[0]["Name"] or not objects[0]["Name"].endswith(".dbn.zst")
                or type(objects[0]["Size"]) is not int or not 0 < objects[0]["Size"] <= MAX_DBN_BYTES):
            raise ValueError("one bounded native DBN object required")
        raw = DATA_ROOT / (stem + ".dbn.zst")
        copy_verified(prefix + objects[0]["Name"], raw, objects[0]["Size"], lineages[0][0])
        status.update(source_bytes=source_bytes + raw.stat().st_size, preparation_seconds=round(time.monotonic() - started, 3))
        flow = DATA_ROOT / (stem + "-flow.json")
        output = DATA_ROOT / (stem + "-core")
        common = ["--depth-plan", paths["depth"], "--trade-plan", paths["trade"]]
        tick = "0.25" if dataset == "GLBX.MDP3" else "0.01"
        native = None
        if dataset == "GLBX.MDP3":
            flow_pin = stage("flow", "verify_historical_cme_flow.py",
                             [*common, "--raw-path", raw, "--tick-size", tick, "--node", node, "--output", flow], flow)
            stage("derive", "derive_historical_cme_core.py",
                  ["--raw", raw, "--depth-plan", paths["depth"], "--flow-report", flow,
                   "--flow-report-sha256", flow_pin, "--output", output, "--node", node], output / "result.json")
            check_args = ["--raw", raw, "--depth-plan", paths["depth"]]
        else:
            common += ["--quote-plan", paths["quote"]]
            flow_pin = stage("flow", "verify_historical_equity_flow.py",
                             [*common, "--tick-size", tick, "--node", node, "--output", flow], flow)
            native = DATA_ROOT / (stem + "-native.json")
            native_pin = stage("native", "verify_historical_equity_native.py",
                               [*common, "--raw", raw, "--flow-report", flow, "--output", native], native)
            stage("derive", "derive_historical_equity_core.py",
                  [*common, "--flow-report", flow, "--flow-report-sha256", flow_pin,
                   "--native-order-report", native, "--native-order-report-sha256", native_pin,
                   "--output", output, "--node", node], output / "result.json")
            check_args = [*common, "--flow-report", flow, "--native-order-report", native]
        source_pin = stage("source-check", "check_historical_core_day.py", ["--output", output, *check_args],
                           output / "independent-check.json")
        state_pin = stage("state-check", "check_historical_state_cuts.py",
                          ["--output", output, "--source-check-sha256", source_pin], output / "state-check.json")
        candidate_args = ["--output", output, "--check-sha256", source_pin, "--state-check-sha256", state_pin,
                          "--flow-report", flow, "--catalog-sha256", catalog_pin]
        if native is not None:
            candidate_args += ["--native-order-report", native]
        stage("candidate", "prepare_historical_core_candidate.py", candidate_args, output / "candidate.json")
        stage("reads", "bench_historical_core_reads.py", ["--output", output, "--report-name", "read-benchmark-strict.json"],
              output / "read-benchmark-strict.json")
        if digest(catalog) != catalog_pin:
            raise ValueError("catalog changed during rehearsal")
        status.update(state="LOCAL_VERIFIED", total_seconds=round(time.monotonic() - started, 3))
        status.pop("active_stage", None)
        progress()
    except BaseException as error:
        status.update(state="FAILED", error_type=type(error).__name__, total_seconds=round(time.monotonic() - started, 3))
        progress()
        raise
    return status


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--catalog-sha256", required=True)
    parser.add_argument("--instrument", choices=("ESU6", "NQU6", "AAPL", "TSLA"), required=True)
    parser.add_argument("--day", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--stem", help="Isolated attempt name; existing attempts are never overwritten")
    args = parser.parse_args()
    print(json.dumps(run(args.catalog, args.catalog_sha256, args.instrument, args.day, args.node, stem=args.stem), sort_keys=True))
