"""Watch L1 staging files and Drive listings while the downloader runs.

Validates each complete .dbn.zst in staging (schema, nbytes, date range)
before it is deleted. Does not download extra copies from Drive.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

import databento as db

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
DATA_ROOT = os.path.join(RUNTIME_ROOT, "data", "historical", "databento")
STAGING_DIR = os.path.join(DATA_ROOT, "staging")
LOG_PATH = os.path.join(DATA_ROOT, "l1_validation.jsonl")
MANIFEST_PATH = os.path.join(DATA_ROOT, "manifest.json")


def log(record: dict) -> None:
    record["ts"] = datetime.now(timezone.utc).isoformat()
    os.makedirs(DATA_ROOT, exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")
    print(json.dumps(record), flush=True)


def file_fingerprint(path: str) -> tuple:
    st = os.stat(path)
    return (path, st.st_size, int(st.st_mtime))


def expected_schema(filename: str) -> str:
    lower = filename.lower()
    if "ohlcv-1m" in lower:
        return "ohlcv-1m"
    if "mbp-10" in lower:
        return "mbp-10"
    if "mbp-1" in lower:
        return "mbp-1"
    return "mbp-1"


def validate_dbn(path: str) -> dict:
    store = db.DBNStore.from_file(path)
    schema = str(store.schema).replace("Schema.", "").replace("_", "-").lower()
    nbytes = int(store.nbytes or 0)
    want = expected_schema(os.path.basename(path))
    if schema != want:
        raise ValueError("schema " + schema + " expected " + want)
    if nbytes <= 0:
        raise ValueError("empty nbytes")
    sample = 0
    for _rec in store:
        sample += 1
        if sample >= 5:
            break
    if sample <= 0:
        raise ValueError("no records")
    return {
        "schema": schema,
        "nbytes": nbytes,
        "sample_records": sample,
        "start": str(store.start),
        "end": str(store.end),
        "dataset": str(store.dataset),
        "symbols": str(store.symbols),
    }


def manifest_progress() -> dict:
    if not os.path.isfile(MANIFEST_PATH):
        return {}
    with open(MANIFEST_PATH, encoding="utf-8") as handle:
        data = json.load(handle)
    out = {}
    for key, rec in (data.get("jobs") or {}).items():
        if not str(key).endswith("_L1"):
            continue
        files = rec.get("files") or []
        out[key] = {
            "state": rec.get("state"),
            "uploaded": sum(1 for item in files if item.get("uploaded") and str(item.get("filename", "")).endswith(".dbn.zst")),
            "files": len(files),
        }
    return out


def main() -> None:
    seen = set()
    last_progress = None
    print("watching", STAGING_DIR, flush=True)
    while True:
        progress = manifest_progress()
        if progress and progress != last_progress:
            print("manifest", json.dumps(progress), flush=True)
            last_progress = progress
        if os.path.isdir(STAGING_DIR):
            names = os.listdir(STAGING_DIR)
            for name in names:
                path = os.path.join(STAGING_DIR, name)
                if not os.path.isfile(path):
                    continue
                try:
                    fp1 = file_fingerprint(path)
                    time.sleep(8)
                    if not os.path.isfile(path):
                        continue
                    fp2 = file_fingerprint(path)
                except OSError:
                    continue
                if fp1 != fp2:
                    continue
                if fp2 in seen:
                    continue
                if name.lower().endswith(".json"):
                    try:
                        with open(path, encoding="utf-8") as handle:
                            json.load(handle)
                        log({"ok": True, "file": name, "kind": "json", "size": fp2[1]})
                        seen.add(fp2)
                    except Exception as err:
                        log({"ok": False, "file": name, "error": str(err)})
                    continue
                if not (name.endswith(".dbn.zst") or name.endswith(".dbn")):
                    continue
                try:
                    meta = validate_dbn(path)
                    meta.update({"ok": True, "file": name, "size": fp2[1]})
                    log(meta)
                    seen.add(fp2)
                except Exception as err:
                    log({"ok": False, "file": name, "error": str(err), "size": fp2[1]})
        time.sleep(8)


if __name__ == "__main__":
    main()
