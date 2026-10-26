from __future__ import annotations

import hashlib
import json
import os
import time


SCHEMA_VERSION = "conversion-rejections/1"
MAX_SAMPLES = 32
MAX_VALUE_BYTES = 64 * 1024


def new(*, source_objects):
    return {
        "schema_version": SCHEMA_VERSION,
        "source_objects": source_objects,
        "rejected": 0,
        "reasons": {},
        "sample_limit": MAX_SAMPLES,
        "samples": [],
    }


def _reason(value):
    return value if isinstance(value, str) and value else "UNSPECIFIED_REJECTION"


def _bounded(value):
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        return {"serialization_error": type(value).__name__, "repr": repr(value)[:1024]}
    if len(encoded) <= MAX_VALUE_BYTES:
        return json.loads(encoded)
    return {
        "truncated": True,
        "bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }


def record(evidence, reason, *, source, row=None, canonical_record=None, quarantine=None):
    reason = _reason(reason)
    evidence["rejected"] += 1
    evidence["reasons"][reason] = evidence["reasons"].get(reason, 0) + 1
    if len(evidence["samples"]) >= evidence["sample_limit"]:
        return
    sample = {"reason": reason, "source": _bounded(source)}
    if row is not None:
        sample["row"] = _bounded(row)
    if canonical_record is not None:
        sample["canonical_record"] = _bounded(canonical_record)
    if quarantine is not None:
        sample["quarantine"] = _bounded(quarantine)
    evidence["samples"].append(sample)


def _fsync_dir(path):
    if os.name != "posix":
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _rename_durable(source, destination):
    os.replace(source, destination)
    source_dir = os.path.dirname(source) or "."
    destination_dir = os.path.dirname(destination) or "."
    _fsync_dir(destination_dir)
    if os.path.abspath(source_dir) != os.path.abspath(destination_dir):
        _fsync_dir(source_dir)


def begin_attempt(job_stage):
    directory = os.fspath(job_stage)
    path = os.path.join(directory, "rejections.json")
    if not os.path.lexists(path):
        return None
    archive_dir = os.path.join(directory, "rejections")
    os.makedirs(archive_dir, exist_ok=True)
    archived = os.path.join(archive_dir, f"rejections-{time.time_ns()}-{os.getpid()}.json")
    _rename_durable(path, archived)
    return archived


def archive_for_date(job_stage, date):
    directory = os.fspath(job_stage)
    path = os.path.join(directory, "rejections.json")
    if not os.path.lexists(path):
        return None
    archive_dir = os.path.join(directory, "rejections")
    os.makedirs(archive_dir, exist_ok=True)
    archived = os.path.join(archive_dir, f"rejections-{date}.json")
    if os.path.lexists(archived):
        archived = os.path.join(archive_dir, f"rejections-{date}-{time.time_ns()}.json")
    _rename_durable(path, archived)
    return archived


def write(job_stage, evidence):
    directory = os.fspath(job_stage)
    path = os.path.join(directory, "rejections.json")
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, indent=2, sort_keys=True, allow_nan=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    _fsync_dir(directory)
    return path
