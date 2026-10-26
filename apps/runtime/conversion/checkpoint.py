from __future__ import annotations

import json
import os


class CheckpointError(RuntimeError):
    pass


def _path(job_stage):
    return os.path.join(os.fspath(job_stage), "checkpoint.json")


def _atomic_write_json(path, payload):
    directory = os.path.dirname(path) or "."
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    if os.name == "posix":
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def scoped_month(dataset_version):
    """The month a job was scoped to convert, taken from the version its sequence
    built. The authority plan is derived from each source file's own declared
    span, so it can name a date the job will never visit: a GLBX monthly file
    opens with a book snapshot stamped milliseconds before midnight, putting the
    previous month's last day in a plan the driver then iterates a calendar
    month over. That date is an artefact of the source, not work the job owes.
    A version without a trailing year-month yields no scope and nothing is
    filtered, because a scope wrongly inferred would hide real unfinished work."""
    tail = (dataset_version or "").rsplit("-", 2)[-2:]
    if len(tail) != 2 or not all(part.isdigit() for part in tail):
        return None
    year, month = tail
    if len(year) != 4 or len(month) != 2 or not "01" <= month <= "12":
        return None
    return f"{year}-{month}"


def planned_in_scope(checkpoint):
    """Authority-plan entries the job was actually scoped to produce. Grading
    completion against the whole plan fails a month that converted every day of
    it, and a month that cannot report completion takes its whole symbol down."""
    scope = scoped_month(checkpoint.get("dataset_version"))
    plan = checkpoint.get("authority_plan", [])
    if scope is None:
        return list(plan)
    return [entry for entry in plan if entry["date"][:7] == scope]


def new(job_id, dataset_version, conversion_started_ns, authority_plan, inputs):
    return {
        "job_id": job_id,
        "dataset_version": dataset_version,
        "conversion_started_ns": conversion_started_ns,
        "authority_plan": authority_plan,
        "inputs": [dict(i, split_done=False, day_units=[]) for i in inputs],
        "completed_partitions": [],
        "updated_at": None,
    }


def load(job_stage):
    path = _path(job_stage)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        checkpoint = json.load(fh)
    if not checkpoint.get("job_id"):
        raise CheckpointError("CORRUPT_CHECKPOINT")
    return checkpoint


def save(job_stage, checkpoint, now_iso):
    checkpoint = dict(checkpoint, updated_at=now_iso)
    os.makedirs(os.fspath(job_stage), exist_ok=True)
    _atomic_write_json(_path(job_stage), checkpoint)
    return checkpoint


def _input_entry(checkpoint, s3_key):
    for entry in checkpoint["inputs"]:
        if entry["s3_key"] == s3_key:
            return entry
    raise CheckpointError(f"UNKNOWN_INPUT:{s3_key}")


def mark_split_done(checkpoint, s3_key, day_units):
    entry = _input_entry(checkpoint, s3_key)
    entry["split_done"] = True
    entry["day_units"] = [dict(unit, mapped=False) for unit in day_units]
    return checkpoint


def mark_day_mapped(checkpoint, s3_key, date):
    entry = _input_entry(checkpoint, s3_key)
    for unit in entry["day_units"]:
        if unit["date"] == date:
            unit["mapped"] = True
            return checkpoint
    raise CheckpointError(f"UNKNOWN_DAY_UNIT:{s3_key}:{date}")


def pending_day_units(checkpoint, s3_key):
    entry = _input_entry(checkpoint, s3_key)
    if not entry["split_done"]:
        return None
    return [unit for unit in entry["day_units"] if not unit["mapped"]]


def mark_partition_complete(checkpoint, instrument_id, family, date, manifest, manifest_sha256):
    if is_partition_complete(checkpoint, instrument_id, family, date):
        raise CheckpointError(f"PARTITION_ALREADY_COMPLETED:{instrument_id}:{family}:{date}")
    checkpoint["completed_partitions"].append({
        "instrument_id": instrument_id, "family": family, "date": date,
        "part_sha256s": [part["sha256"] for part in manifest["parts"]],
        "manifest_sha256": manifest_sha256,
        "evicted": False,
        "catalog_fields": {
            "record_count": manifest["record_count"],
            "rejected_count": manifest["rejected_count"],
            "event_ns_min": manifest["event_ns_min"],
            "event_ns_max": manifest["event_ns_max"],
            "part_count": len(manifest["parts"]),
            "logical_sha256": manifest["logical_sha256"],
        },
    })
    return checkpoint


def mark_partition_evicted(checkpoint, instrument_id, family, date):
    for entry in checkpoint["completed_partitions"]:
        if (entry["instrument_id"], entry["family"], entry["date"]) == (instrument_id, family, date):
            if entry["evicted"]:
                raise CheckpointError(f"PARTITION_ALREADY_EVICTED:{instrument_id}:{family}:{date}")
            entry["evicted"] = True
            return checkpoint
    raise CheckpointError(f"UNKNOWN_COMPLETED_PARTITION:{instrument_id}:{family}:{date}")


def reconcile_partition_manifest(checkpoint, instrument_id, family, date, manifest, manifest_sha256):
    for entry in checkpoint["completed_partitions"]:
        if (entry["instrument_id"], entry["family"], entry["date"]) != (instrument_id, family, date):
            continue
        if entry["evicted"]:
            raise CheckpointError(f"PARTITION_ALREADY_EVICTED:{instrument_id}:{family}:{date}")
        if (manifest.get("instrument_id"), manifest.get("family"), manifest.get("date")) != (instrument_id, family, date):
            raise CheckpointError("REMOTE_MANIFEST_IDENTITY_MISMATCH")
        entry["part_sha256s"] = [part["sha256"] for part in manifest["parts"]]
        entry["manifest_sha256"] = manifest_sha256
        entry["catalog_fields"] = {
            "record_count": manifest["record_count"],
            "rejected_count": manifest["rejected_count"],
            "event_ns_min": manifest["event_ns_min"],
            "event_ns_max": manifest["event_ns_max"],
            "part_count": len(manifest["parts"]),
            "logical_sha256": manifest["logical_sha256"],
        }
        return entry
    raise CheckpointError(f"UNKNOWN_COMPLETED_PARTITION:{instrument_id}:{family}:{date}")


def quarantined_dates(checkpoint):
    return list(checkpoint.get("quarantined_dates", []))


def is_date_quarantined(checkpoint, date):
    return any(entry["date"] == date for entry in checkpoint.get("quarantined_dates", []))


def mark_date_quarantined(checkpoint, date, *, error, evidence, evidence_sha256, attempted_at):
    entries = checkpoint.setdefault("quarantined_dates", [])
    for entry in entries:
        if entry["date"] == date:
            entry.update(error=error, evidence=evidence, evidence_sha256=evidence_sha256,
                         attempted_at=attempted_at, attempts=entry.get("attempts", 1) + 1)
            return entry
    entry = {"date": date, "error": error, "evidence": evidence,
             "evidence_sha256": evidence_sha256, "attempted_at": attempted_at, "attempts": 1}
    entries.append(entry)
    entries.sort(key=lambda e: e["date"])
    return entry


def clear_quarantined_dates(checkpoint):
    return checkpoint.pop("quarantined_dates", [])


def is_partition_complete(checkpoint, instrument_id, family, date):
    return any(
        (entry["instrument_id"], entry["family"], entry["date"]) == (instrument_id, family, date)
        for entry in checkpoint["completed_partitions"]
    )
