"""Pin published August sessions to retained qualification directories; no writes to S3."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "conversion"))
from archive_http import _build_query_s3_client
import historical_l2_catalog as catalog
from s3_publish import Store


def hashed(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("regular retained file required")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build_plan(store, qualified_root):
    root = Path(qualified_root).resolve(strict=True)
    pointer, release = catalog.current(store)
    local = {}
    for candidate in sorted((root / "data").glob("*-core/candidate.json")):
        if candidate.parent.is_symlink() or not candidate.resolve().is_relative_to(root):
            raise ValueError("retained candidate escapes qualification root")
        digest = hashed(candidate)
        local.setdefault(digest, candidate.parent)
    jobs = []
    for session in release["sessions"]:
        if session["state"] != "AVAILABLE":
            continue
        candidate = local.get(session["descriptor_sha256"])
        if candidate is None:
            raise ValueError("published session lacks retained candidate: " + session["date"])
        descriptor, manifest, _prefix = catalog.family(store, pointer, release,
            session["instrument_id"], session["date"], "events")
        if not 0 < manifest["rows"] <= 100_000_000:
            raise ValueError("published day exceeds wall stream admission")
        jobs.append({"instrument_id": session["instrument_id"], "date": session["date"],
            "candidate_root": str(candidate), "descriptor_sha256": session["descriptor_sha256"],
            "event_rows": manifest["rows"], "source_rows": descriptor["flow_counts"]["rows"],
            "event_bytes": sum(part["bytes"] for part in manifest["parts"]),
            "minimum_size": 40 if json.loads(session["instrument_id"])[1] == "FUTURE" else 800})
    return {"schema": "historical-l2-index-plan/1", "pointer": pointer,
        "qualified_root": str(root), "jobs": sorted(jobs, key=lambda job: (job["date"], job["instrument_id"])),
        "unavailable": [{key: row[key] for key in ("instrument_id", "date", "reason")}
                        for row in release["sessions"] if row["state"] == "UNAVAILABLE"]}


def load_job(plan_path, plan_sha256, instrument, day):
    if hashed(plan_path) != catalog.sha(plan_sha256):
        raise ValueError("frozen index plan hash differs")
    if Path(plan_path).stat().st_size > 1024 * 1024:
        raise ValueError("index plan exceeds admission")
    plan = json.loads(Path(plan_path).read_bytes())
    if plan.get("schema") != "historical-l2-index-plan/1" or not 1 <= len(plan["jobs"]) <= 124:
        raise ValueError("index plan scope differs")
    matches = [job for job in plan["jobs"] if (job["instrument_id"], job["date"]) == (instrument, day)]
    if len(matches) != 1:
        raise ValueError("exact unique index job required")
    job = matches[0]
    root = Path(job["candidate_root"])
    qualified = Path(plan["qualified_root"]).resolve(strict=True)
    if root.is_symlink() or not root.resolve(strict=True).is_relative_to(qualified / "data"):
        raise ValueError("candidate escapes pinned qualification root")
    if hashed(root / "candidate.json") != job["descriptor_sha256"]:
        raise ValueError("retained candidate differs from published plan")
    descriptor = json.loads((root / "candidate.json").read_bytes())
    if (descriptor["instrument_id"], descriptor["date"]) != (instrument, day):
        raise ValueError("planned candidate identity differs")
    return plan, job, descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qualified-root", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    plan = build_plan(Store(_build_query_s3_client(), args.bucket, catalog.PREFIX), args.qualified_root)
    body = json.dumps(plan, separators=(",", ":"), allow_nan=False).encode()
    with args.out.open("xb") as stream:
        os.chmod(args.out, 0o600)
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({"status": "PINNED", "release_id": plan["pointer"]["release_id"],
        "jobs": len(plan["jobs"]), "unavailable": len(plan["unavailable"]),
        "event_rows": sum(job["event_rows"] for job in plan["jobs"]),
        "event_bytes": sum(job["event_bytes"] for job in plan["jobs"]), "sha256": hashlib.sha256(body).hexdigest()}))


if __name__ == "__main__":
    main()
