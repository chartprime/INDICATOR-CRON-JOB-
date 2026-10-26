#!/usr/bin/env python3
"""Databento historical collector: quote, batch-submit, stage, rclone to Drive.

Never opens data/live SQLite. Cost-guard: submit aborts if get_cost is not 0.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
TERMINAL_ROOT = os.path.abspath(os.path.join(RUNTIME_ROOT, "..", ".."))
ENV_PATH = os.path.join(TERMINAL_ROOT, ".env")
DATA_ROOT = os.path.join(RUNTIME_ROOT, "data", "historical", "databento")
STAGING_DIR = os.path.join(DATA_ROOT, "staging")
MANIFEST_PATH = os.path.join(DATA_ROOT, "manifest.json")
LOCK_PATH = os.path.join(DATA_ROOT, "collector.lock")
VALIDATION_LOG = os.path.join(DATA_ROOT, "l1_validation.jsonl")
HIST_BASE = "https://hist.databento.com/v0"
MIN_FREE_RESERVE_BYTES = 20 * 1024 * 1024 * 1024
DEFAULT_REMOTE = "gdrive:arkeos-databento-historical"
CTX = ssl.create_default_context()

SYMBOLS = (
    {
        "name": "ES",
        "dataset": "GLBX.MDP3",
        "symbols": "ES.n.0",
        "stype_in": "continuous",
        "asset_class": "FUTURE",
    },
    {
        "name": "NQ",
        "dataset": "GLBX.MDP3",
        "symbols": "NQ.n.0",
        "stype_in": "continuous",
        "asset_class": "FUTURE",
    },
    {
        "name": "AAPL",
        "dataset": "XNAS.ITCH",
        "symbols": "AAPL",
        "stype_in": "raw_symbol",
        "asset_class": "EQUITY",
    },
    {
        "name": "TSLA",
        "dataset": "XNAS.ITCH",
        "symbols": "TSLA",
        "stype_in": "raw_symbol",
        "asset_class": "EQUITY",
    },
)

SCHEMA_SPECS = (
    {"folder": "ohlcv-1m", "schema": "ohlcv-1m", "window_days": 365, "split_duration": "month"},
    {"folder": "L1", "schema": "mbp-1", "window_days": 365, "split_duration": "month"},
    {"folder": "L2", "schema": "mbp-10", "window_days": 30, "split_duration": "day"},
)


def load_key(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if name.strip().lower() in ("databento_key", "databento_api_key"):
                key = value.strip().strip('"').strip("'")
                if key:
                    return key
    raise SystemExit("databento_key not found in .env")


def auth_header(key: str) -> str:
    token = base64.b64encode((key + ":").encode("ascii")).decode("ascii")
    return "Basic " + token


def http_json(key: str, method: str, params: dict | None = None, http: str = "GET"):
    url = HIST_BASE + "/" + method
    data = None
    headers = {"Authorization": auth_header(key), "Accept": "application/json"}
    if params:
        encoded = urllib.parse.urlencode(params)
        if http == "GET":
            url = url + "?" + encoded
        else:
            data = encoded.encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers, method=http)
    try:
        with urllib.request.urlopen(req, timeout=180, context=CTX) as resp:
            body = resp.read().decode("utf-8")
            parsed = json.loads(body) if body else None
            return resp.status, parsed
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"raw": raw[:2000]}
        return err.code, parsed


def utc_today():
    return datetime.now(timezone.utc).date()


def window_for(days: int) -> tuple[str, str]:
    end = utc_today()
    start = end - timedelta(days=days)
    return start.isoformat(), end.isoformat()


def parse_databento_ts(raw: str) -> datetime:
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty timestamp")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if "T" not in text:
        return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)
    if "." in text:
        head, rest = text.split(".", 1)
        digits = []
        tz_part = ""
        for ch in rest:
            if ch.isdigit() and not tz_part:
                digits.append(ch)
            else:
                tz_part += ch
        frac = "".join(digits[:6]).ljust(6, "0")
        text = head + "." + frac + tz_part
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def clamp_jobs_to_available(key: str, jobs: list[dict]) -> None:
    """Keep end at or before each dataset/schema available_end (avoids CME L2 422)."""
    ranges: dict[str, dict] = {}
    for job in jobs:
        dataset = job["dataset"]
        if dataset not in ranges:
            status, body = http_json(key, "metadata.get_dataset_range", {"dataset": dataset})
            schema_map = {}
            if status == 200 and isinstance(body, dict):
                schema_map = body.get("schema") or {}
            else:
                print("WARN: dataset range unavailable", dataset, status)
            ranges[dataset] = schema_map
        schema_range = ranges[dataset].get(job["schema"]) or {}
        available_end = schema_range.get("end") if isinstance(schema_range, dict) else None
        if not available_end:
            continue
        try:
            job_end = parse_databento_ts(job["end"])
            avail_end = parse_databento_ts(str(available_end))
        except ValueError:
            continue
        if job_end > avail_end:
            job["end"] = str(available_end)
            print("clamp", job["key"], "end to", available_end)



def job_defs(schema_filter: set[str] | None):
    jobs = []
    for spec in SCHEMA_SPECS:
        if schema_filter and spec["schema"] not in schema_filter:
            continue
        start, end = window_for(spec["window_days"])
        for inst in SYMBOLS:
            job_id = inst["name"] + "_" + spec["folder"]
            jobs.append({
                "key": job_id,
                "folder": spec["folder"],
                "schema": spec["schema"],
                "split_duration": spec["split_duration"],
                "start": start,
                "end": end,
                **inst,
            })
    return jobs


def load_manifest() -> dict:
    if not os.path.isfile(MANIFEST_PATH):
        return {
            "remote": DEFAULT_REMOTE,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "jobs": {},
        }
    with open(MANIFEST_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def save_manifest(manifest: dict) -> None:
    os.makedirs(DATA_ROOT, exist_ok=True)
    tmp = MANIFEST_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, MANIFEST_PATH)


def pid_alive(pid: int) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def acquire_lock(schemas: str) -> None:
    os.makedirs(DATA_ROOT, exist_ok=True)
    if os.path.isfile(LOCK_PATH):
        old_pid = 0
        try:
            with open(LOCK_PATH, encoding="utf-8") as handle:
                old = json.load(handle)
            old_pid = int(old.get("pid") or 0)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            old_pid = 0
        if pid_alive(old_pid) and old_pid != os.getpid():
            raise SystemExit("collector already running pid " + str(old_pid))
        print("clearing stale collector.lock pid", old_pid)
    payload = {
        "pid": os.getpid(),
        "schema": schemas,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(LOCK_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
    print("lock acquired pid", os.getpid())


def release_lock() -> None:
    try:
        if os.path.isfile(LOCK_PATH):
            with open(LOCK_PATH, encoding="utf-8") as handle:
                old = json.load(handle)
            if int(old.get("pid") or 0) not in (0, os.getpid()):
                return
        if os.path.isfile(LOCK_PATH):
            os.remove(LOCK_PATH)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass


def live_job_cost(live: dict) -> float | None:
    raw = live.get("cost", live.get("cost_usd"))
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        raise SystemExit("unreadable live job cost " + str(raw))


def abort_if_billed(key: str, jobs: list[dict], manifest: dict) -> int:
    """Re-quote the windows we will actually download. Abort unless every cost is $0."""
    planned = []
    for job in jobs:
        item = dict(job)
        existing = (manifest.get("jobs") or {}).get(job["key"]) or {}
        if existing.get("start") and existing.get("end"):
            item["start"] = existing["start"]
            item["end"] = existing["end"]
        planned.append(item)
    rows = quote_jobs(key, planned)
    if any(not row["included"] for row in rows):
        print("ABORT: quote is not $0")
        return 2
    print("all quoted windows are included at $0")
    return 0


def quote_jobs(key: str, jobs: list[dict]) -> list[dict]:
    rows = []
    print("schema            symbol  start       end         cost_usd   billable_GB")
    for job in jobs:
        params = {
            "dataset": job["dataset"],
            "schema": job["schema"],
            "symbols": job["symbols"],
            "stype_in": job["stype_in"],
            "start": job["start"],
            "end": job["end"],
        }
        st_cost, cost = http_json(key, "metadata.get_cost", params)
        st_size, size = http_json(key, "metadata.get_billable_size", params)
        ok_cost = st_cost == 200 and isinstance(cost, (int, float))
        ok_size = st_size == 200 and isinstance(size, (int, float))
        included = ok_cost and cost == 0
        gb = (size / 1e9) if ok_size else None
        print(
            job["schema"].ljust(16),
            job["name"].ljust(6),
            job["start"],
            job["end"],
            ("%.4f" % cost) if ok_cost else ("ERR " + str(st_cost)),
            ("%.3f" % gb) if gb is not None else ("ERR " + str(st_size)),
        )
        rows.append({
            "job": job,
            "cost_ok": ok_cost,
            "cost": cost if ok_cost else None,
            "size": size if ok_size else None,
            "included": included,
        })
        time.sleep(0.08)
    return rows


def cmd_quote(key: str, jobs: list[dict]) -> int:
    rows = quote_jobs(key, jobs)
    bad = [r for r in rows if not r["included"]]
    if bad:
        print("ABORT: one or more windows are not included at $0")
        return 2
    print("all quoted windows are included at $0")
    return 0


def cmd_submit(key: str, jobs: list[dict], manifest: dict) -> int:
    rows = quote_jobs(key, jobs)
    if any(not r["included"] for r in rows):
        print("ABORT: refusing to submit, a window is not $0")
        return 2
    for row in rows:
        job = row["job"]
        existing = (manifest.get("jobs") or {}).get(job["key"]) or {}
        if existing.get("databento_job_id") and existing.get("state") not in ("error", "expired"):
            print("skip submit", job["key"], "already", existing.get("databento_job_id"), existing.get("state"))
            continue
        payload = {
            "dataset": job["dataset"],
            "schema": job["schema"],
            "symbols": job["symbols"],
            "stype_in": job["stype_in"],
            "start": job["start"],
            "end": job["end"],
            "encoding": "dbn",
            "compression": "zstd",
            "packaging": "none",
            "split_duration": job["split_duration"],
            "delivery": "download",
        }
        status, body = http_json(key, "batch.submit_job", payload, http="POST")
        if status != 200 or not isinstance(body, dict) or not body.get("id"):
            print("submit failed", job["key"], status, body)
            return 1
        rec = {
            "key": job["key"],
            "folder": job["folder"],
            "name": job["name"],
            "dataset": job["dataset"],
            "schema": job["schema"],
            "symbols": job["symbols"],
            "stype_in": job["stype_in"],
            "start": job["start"],
            "end": job["end"],
            "cost_usd": row["cost"],
            "billable_bytes": row["size"],
            "databento_job_id": body["id"],
            "state": body.get("state") or "queued",
            "submitted_at": datetime.now(timezone.utc).isoformat(),
            "files": existing.get("files") or [],
        }
        manifest.setdefault("jobs", {})[job["key"]] = rec
        save_manifest(manifest)
        print("submitted", job["key"], body["id"], rec["state"])
        time.sleep(0.15)
    return 0


def find_rclone() -> str:
    found = shutil.which("rclone")
    if found:
        return found
    winget_root = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages")
    if os.path.isdir(winget_root):
        for dirpath, _dirnames, filenames in os.walk(winget_root):
            if "rclone.exe" in filenames:
                return os.path.join(dirpath, "rclone.exe")
    raise SystemExit("rclone.exe not found on PATH")


def rclone_has_remote(rclone_bin: str, remote_name: str) -> bool:
    proc = subprocess.run([rclone_bin, "listremotes"], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print("rclone listremotes failed:", proc.stderr.strip())
        return False
    names = {line.strip().rstrip(":") for line in proc.stdout.splitlines() if line.strip()}
    return remote_name in names


def ensure_disk(needed: int) -> None:
    free = shutil.disk_usage(os.path.splitdrive(STAGING_DIR)[0] + os.sep).free
    if free < needed + MIN_FREE_RESERVE_BYTES:
        raise SystemExit(
            "not enough free disk: need "
            + str(needed + MIN_FREE_RESERVE_BYTES)
            + " have "
            + str(free)
        )


def append_validation(record: dict) -> None:
    record["ts"] = datetime.now(timezone.utc).isoformat()
    os.makedirs(DATA_ROOT, exist_ok=True)
    with open(VALIDATION_LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def validate_staged_file(path: str, expected_schema: str) -> dict:
    """Cheap cleanliness check: JSON parses; DBN metadata + a few records look right."""
    name = os.path.basename(path).lower()
    if name.endswith(".json"):
        with open(path, encoding="utf-8") as handle:
            json.load(handle)
        result = {"ok": True, "kind": "json", "file": os.path.basename(path)}
        append_validation(result)
        return result
    if not (name.endswith(".dbn.zst") or name.endswith(".dbn")):
        return {"ok": True, "kind": "other", "file": os.path.basename(path)}
    import databento as db

    store = db.DBNStore.from_file(path)
    schema = str(store.schema).replace("Schema.", "").replace("_", "-").lower()
    expected = expected_schema.replace("_", "-").lower()
    nbytes = int(store.nbytes or 0)
    if schema != expected:
        raise SystemExit("schema mismatch " + path + " got " + schema + " expected " + expected)
    if nbytes <= 0:
        raise SystemExit("empty DBN " + path)
    sample = 0
    for _rec in store:
        sample += 1
        if sample >= 5:
            break
    if sample <= 0:
        raise SystemExit("DBN has metadata but no records " + path)
    result = {
        "ok": True,
        "kind": "dbn",
        "file": os.path.basename(path),
        "schema": schema,
        "nbytes": nbytes,
        "sample_records": sample,
        "start": str(store.start),
        "end": str(store.end),
        "dataset": str(store.dataset),
    }
    print("validated", os.path.basename(path), "schema", schema, "nbytes", nbytes, "sample", sample)
    append_validation(result)
    return result


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(8 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def download_url(key: str, url: str, dest: str, expected: int | None) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    attempts = 3
    last_err: Exception | None = None
    for attempt in range(1, attempts + 1):
        copied = 0
        try:
            req = urllib.request.Request(url, headers={"Authorization": auth_header(key)})
            with urllib.request.urlopen(req, timeout=7200, context=CTX) as resp, open(dest, "wb") as out:
                last_report = 0
                while True:
                    chunk = resp.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    copied += len(chunk)
                    if copied - last_report >= 256 * 1024 * 1024:
                        print("  downloaded", copied, "bytes")
                        last_report = copied
            print("  finished", copied, "bytes")
            if expected is not None and copied != expected:
                raise ValueError("size mismatch got " + str(copied) + " expected " + str(expected))
            return
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
            last_err = err
            print("  download attempt", attempt, "failed", err)
            try:
                if os.path.isfile(dest):
                    os.remove(dest)
            except OSError:
                pass
            if attempt < attempts:
                time.sleep(5 * attempt)
    raise SystemExit("download failed for " + dest + " " + str(last_err))


def rclone_copyto(rclone_bin: str, local_path: str, remote_dest: str) -> None:
    proc = subprocess.run(
        [rclone_bin, "copyto", "--checksum", local_path, remote_dest],
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit("rclone copyto failed for " + local_path + " -> " + remote_dest)


def rclone_remote_size(rclone_bin: str, remote_dest: str) -> int:
    proc = subprocess.run(
        [rclone_bin, "lsjson", remote_dest],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        data = json.loads(proc.stdout)
        if isinstance(data, dict) and "Size" in data:
            return int(data["Size"])
        if isinstance(data, list) and data and "Size" in data[0]:
            return int(data[0]["Size"])
    parent, name = remote_dest.rsplit("/", 1)
    proc = subprocess.run(
        [rclone_bin, "lsjson", "--files-only", parent],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()[:400]
        raise SystemExit("rclone lsjson failed for " + remote_dest + " " + err)
    items = json.loads(proc.stdout)
    for item in items:
        if item.get("Name") == name or item.get("Path") == name:
            return int(item["Size"])
    raise SystemExit("remote file not found after upload: " + remote_dest)


def confirm_remote_size(rclone_bin: str, local_path: str, remote_dest: str) -> int:
    local_size = os.path.getsize(local_path)
    remote_size = rclone_remote_size(rclone_bin, remote_dest)
    if remote_size != local_size:
        raise SystemExit(
            "remote size mismatch "
            + remote_dest
            + " remote="
            + str(remote_size)
            + " local="
            + str(local_size)
        )
    print("remote size ok", remote_size)
    return remote_size


def cmd_download(key: str, jobs: list[dict], manifest: dict, remote: str, keep_ohlcv_local: bool) -> int:
    quote_rc = abort_if_billed(key, jobs, manifest)
    if quote_rc != 0:
        return quote_rc

    rclone_bin = None
    rclone_ready = False
    try:
        rclone_bin = find_rclone()
        remote_name = remote.split(":", 1)[0]
        rclone_ready = rclone_has_remote(rclone_bin, remote_name)
    except SystemExit as err:
        print(str(err))
    if not rclone_ready:
        print("rclone remote is not ready; Databento files will still land locally.")
        print("One-time Drive setup, then re-run download to upload:")
        print("  rclone config create gdrive drive scope drive")

    os.makedirs(STAGING_DIR, exist_ok=True)
    wanted = {job["key"] for job in jobs}
    download_order = {"AAPL_L1": 0, "TSLA_L1": 1, "ES_L1": 2, "NQ_L1": 3}
    pending = True
    while pending:
        pending = False
        status, listed = http_json(key, "batch.list_jobs", {"states": "queued,processing,done"})
        if status != 200 or not isinstance(listed, list):
            print("list_jobs failed", status, listed)
            return 1
        by_id = {item.get("id"): item for item in listed if isinstance(item, dict)}
        ordered = sorted(wanted, key=lambda name: download_order.get(name, 50))
        for key_name in ordered:
            rec = (manifest.get("jobs") or {}).get(key_name)
            if not rec or not rec.get("databento_job_id"):
                print("no submitted job in manifest for", key_name, "-- run submit first")
                return 1
            live = by_id.get(rec["databento_job_id"])
            if live:
                rec["state"] = live.get("state") or rec.get("state")
                rec["billed_size"] = live.get("billed_size")
                rec["actual_size"] = live.get("actual_size")
                billed = live_job_cost(live)
                if billed is not None and billed > 0:
                    print("ABORT: live job has cost", billed, key_name, rec["databento_job_id"])
                    return 2
            state = rec.get("state")
            if state in ("queued", "processing"):
                pending = True
                print("waiting", key_name, rec["databento_job_id"], state)
                continue
            if state != "done":
                print("job not done", key_name, state)
                return 1
            st_files, files = http_json(key, "batch.list_files", {"job_id": rec["databento_job_id"]})
            if st_files != 200 or not isinstance(files, list):
                print("list_files failed", key_name, st_files, files)
                return 1
            landed = rec.setdefault("files", [])
            landed_names = {item.get("filename") for item in landed}
            for info in files:
                filename = info.get("filename")
                if not filename or filename == "metadata.json":
                    continue
                existing_file = next((item for item in landed if item.get("filename") == filename), None)
                if existing_file and existing_file.get("uploaded"):
                    continue
                if existing_file and existing_file.get("local") and os.path.isfile(existing_file["local"]) and not rclone_ready:
                    continue
                keep_local = keep_ohlcv_local and rec["folder"] == "ohlcv-1m"
                if rec["folder"] != "ohlcv-1m" and not rclone_ready:
                    print("L1/L2 requires rclone; refusing to land", filename, "on the laptop")
                    return 3
                url = ((info.get("urls") or {}).get("https"))
                if not url:
                    print("no https url for", filename)
                    return 1
                size = info.get("size")
                ensure_disk(int(size or 0))
                staging_path = os.path.join(STAGING_DIR, filename)
                print("download", filename, "bytes", size)
                download_url(key, url, staging_path, int(size) if isinstance(size, int) else None)
                digest = sha256_file(staging_path)
                expected_hash = (info.get("hash") or "").replace("sha256:", "")
                if expected_hash and digest != expected_hash:
                    print("hash mismatch", filename)
                    append_validation({"ok": False, "file": filename, "error": "sha256 mismatch"})
                    return 1
                try:
                    validate_staged_file(staging_path, rec["schema"])
                except Exception as err:
                    print("validation failed", filename, err)
                    append_validation({"ok": False, "file": filename, "error": str(err)})
                    return 1
                remote_path = remote.rstrip("/") + "/" + rec["folder"] + "/" + rec["name"] + "/" + filename
                local_path = None
                if keep_local:
                    local_dir = os.path.join(DATA_ROOT, rec["folder"], rec["name"])
                    os.makedirs(local_dir, exist_ok=True)
                    local_path = os.path.join(local_dir, filename)
                    shutil.copy2(staging_path, local_path)
                uploaded = False
                if rclone_ready and rclone_bin:
                    print("rclone", remote_path)
                    rclone_copyto(rclone_bin, staging_path, remote_path)
                    confirm_remote_size(rclone_bin, staging_path, remote_path)
                    uploaded = True
                if rec["folder"] != "ohlcv-1m" and os.path.isfile(staging_path):
                    os.remove(staging_path)
                elif keep_local and os.path.isfile(staging_path):
                    os.remove(staging_path)
                file_rec = {
                    "filename": filename,
                    "size": size,
                    "sha256": digest,
                    "remote": remote_path if uploaded else None,
                    "local": local_path if local_path and os.path.isfile(local_path) else None,
                    "uploaded": uploaded,
                    "validated": True,
                    "uploaded_at": datetime.now(timezone.utc).isoformat() if uploaded else None,
                }
                if existing_file:
                    existing_file.update(file_rec)
                else:
                    landed.append(file_rec)
                rec["files"] = landed
                save_manifest(manifest)
            rec["downloaded_at"] = datetime.now(timezone.utc).isoformat()
            save_manifest(manifest)
            print("complete", key_name)
        save_manifest(manifest)
        if pending:
            print("jobs still processing, sleep 20s")
            time.sleep(20)
    if not rclone_ready:
        print("Databento download complete locally. Drive upload still needs rclone config.")
        return 3
    print("all requested jobs downloaded and uploaded")
    return 0


def parse_args():
    parser = argparse.ArgumentParser(description="Databento historical collector")
    parser.add_argument("mode", choices=("quote", "submit", "download"))
    parser.add_argument(
        "--schemas",
        default="ohlcv-1m",
        help="comma-separated: ohlcv-1m,mbp-1,mbp-10 (default ohlcv-1m for the first pipeline proof)",
    )
    parser.add_argument("--remote", default=os.environ.get("TT_DATABENTO_REMOTE", DEFAULT_REMOTE))
    parser.add_argument("--keep-ohlcv-local", action="store_true", default=True)
    parser.add_argument("--no-keep-ohlcv-local", action="store_false", dest="keep_ohlcv_local")
    return parser.parse_args()


def main() -> int:
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass
    args = parse_args()
    schema_names = {item.strip() for item in args.schemas.split(",") if item.strip()}
    allowed = {spec["schema"] for spec in SCHEMA_SPECS}
    unknown = schema_names - allowed
    if unknown:
        raise SystemExit("unknown schema " + ",".join(sorted(unknown)))
    jobs = job_defs(schema_names)
    key = load_key(ENV_PATH)
    clamp_jobs_to_available(key, jobs)
    os.makedirs(DATA_ROOT, exist_ok=True)
    manifest = load_manifest()
    manifest["remote"] = args.remote
    if args.mode == "quote":
        return cmd_quote(key, jobs)
    if args.mode in ("submit", "download"):
        acquire_lock(args.schemas)
        try:
            if args.mode == "submit":
                return cmd_submit(key, jobs, manifest)
            return cmd_download(key, jobs, manifest, args.remote, args.keep_ohlcv_local)
        finally:
            release_lock()
    raise SystemExit("unknown mode")


if __name__ == "__main__":
    sys.exit(main())
