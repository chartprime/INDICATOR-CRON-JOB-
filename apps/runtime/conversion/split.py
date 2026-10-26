from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import budget


class SplitError(RuntimeError):
    pass


def _slug(s3_key):
    readable = re.sub(r"[^A-Za-z0-9]+", "_", s3_key).strip("_")[-80:]
    digest = hashlib.sha256(s3_key.encode("utf-8")).hexdigest()[:8]
    return f"{readable}-{digest}"


def _utc_date(ts_event_ns):
    seconds = int(ts_event_ns) // 1_000_000_000
    return _dt.datetime.fromtimestamp(seconds, tz=_dt.timezone.utc).strftime("%Y-%m-%d")


def split_dir(job_stage, s3_key):
    return os.path.join(os.fspath(job_stage), "raw", _slug(s3_key))


def split_by_day(row_iter, job_stage, s3_key, ts_field="ts_event"):
    out_dir = split_dir(job_stage, s3_key)
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)

    open_files = {}
    pending_budget = 0

    def _entry(date):
        if date not in open_files:
            final_path = os.path.join(out_dir, f"date={date}.ndjson")
            tmp_path = f"{final_path}.partial"
            open_files[date] = {
                "final": final_path, "tmp": tmp_path, "fh": open(tmp_path, "w", encoding="utf-8"),
                "first": None, "last": None, "count": 0,
            }
        return open_files[date]

    try:
        for index, row in row_iter:
            if ts_field not in row:
                raise SplitError(f"MISSING_TS_FIELD:{ts_field}")
            try:
                date = _utc_date(row[ts_field])
            except (ValueError, OverflowError, TypeError, OSError) as error:
                raise SplitError("INVALID_TIMESTAMP") from error
            entry = _entry(date)
            line = json.dumps({"index": index, "row": row}, separators=(",", ":")) + "\n"
            needed = len(line.encode("utf-8"))
            if pending_budget < needed:
                for handle in open_files.values():
                    if not handle["fh"].closed:
                        handle["fh"].flush()
                pending_budget = max(needed, 65536)
                budget.check(job_stage, pending_budget)
            pending_budget -= needed
            if entry["fh"].closed:
                entry["fh"] = open(entry["tmp"], "a", encoding="utf-8")
            entry["fh"].write(line)
            if sum(not e["fh"].closed for e in open_files.values()) >= 16:
                for e in open_files.values():
                    if e is not entry and not e["fh"].closed:
                        e["fh"].close()
                        break
            entry["first"] = index if entry["first"] is None else min(entry["first"], index)
            entry["last"] = index if entry["last"] is None else max(entry["last"], index)
            entry["count"] += 1
    finally:
        for entry in open_files.values():
            if not entry["fh"].closed:
                entry["fh"].close()

    if not open_files:
        raise SplitError("NO_ROWS_TO_SPLIT")

    day_units = []
    for date in sorted(open_files):
        entry = open_files[date]
        with open(entry["tmp"], "a", encoding="utf-8") as fh:
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(entry["tmp"], entry["final"])
        day_units.append({
            "date": date, "path": entry["final"],
            "sha256": _sha(entry["final"]),
            "first_row": entry["first"], "last_row": entry["last"], "row_count": entry["count"],
        })
    return day_units


def read_day(path):
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            entry = json.loads(line)
            yield entry["index"], entry["row"]


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()
