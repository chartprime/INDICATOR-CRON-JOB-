"""Publish revalidated immutable L2 artifacts before a conditional, separate L2 catalog."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from itertools import islice
import os
from pathlib import Path

from plan_historical_core_month import digest
from run_historical_core_month import code_identity
from s3_publish import PublicationError, Store, _relative, _status
from validate_historical_core_day import read_json, validate


PREFIX = "curated/l2-core"
CURRENT = "_catalog/CURRENT.json"


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def prepare(root, journal, node, *, partial=False):
    journal_pin = digest(journal)
    run = read_json(journal, 8 * 1024**2)
    inventory = run["plan"]
    frozen = {key: value for key, value in inventory.items() if key != "plan_id"}
    if (run.get("schema") != "historical-l2-month-run/1" or run.get("identity") != code_identity(node)
            or inventory.get("month") != "2026-08" or hashlib.sha256(encoded(frozen)).hexdigest() != inventory.get("plan_id")):
        raise ValueError("release source plan or code/runtime differs")
    statuses = run["sessions"]
    planned = {row["instrument"] + "/" + row["date"]: row for row in inventory["sessions"]}
    if set(statuses) != set(planned):
        raise ValueError("release session inventory differs")
    sessions, artifacts = [], {}
    for key, source in planned.items():
        entry = statuses[key]
        row = {"instrument_id": json.dumps(source["profile"], separators=(",", ":")), "date": source["date"],
               "state": "UNAVAILABLE", "reason": source["reason"]}
        if entry["state"] == "AVAILABLE":
            proof = validate(root, entry["proof"]["stem"], source, inventory["plan_id"], inventory["source_catalog_sha256"])
            if proof != entry["proof"]:
                raise ValueError("release completed day changed")
            directory = root / (proof["stem"] + "-core")
            candidate_path = directory / "candidate.json"
            candidate = read_json(candidate_path, 4 * 1024**2)
            prefix = candidate["prefix"]
            if not prefix.startswith(PREFIX + "/databento/"):
                raise ValueError("release namespace differs")
            for item in candidate["objects"]:
                relative = item["key"].removeprefix(PREFIX + "/")
                tail = item["key"].removeprefix(prefix + "/")
                path = directory / tail
                if (not item["key"].startswith(prefix + "/") or not path.resolve().is_relative_to(directory.resolve())
                        or path.is_symlink() or not path.is_file() or path.stat().st_size != item["bytes"]
                        or digest(path) != item["sha256"] or relative in artifacts):
                    raise ValueError("release artifact identity or admission failed")
                artifacts[relative] = (path, item["sha256"], item["bytes"])
            descriptor_key = prefix.removeprefix(PREFIX + "/") + "/candidate.json"
            artifacts[descriptor_key] = (candidate_path, proof["candidate_sha256"], candidate_path.stat().st_size)
            row.update(state="AVAILABLE", reason="FULL_DAY_VERIFIED", derivation_id=proof["derivation_id"],
                       descriptor_key=descriptor_key, descriptor_sha256=proof["candidate_sha256"],
                       descriptor_bytes=candidate_path.stat().st_size)
        elif entry["state"] == "UNAVAILABLE":
            if entry["reason"] != source["reason"] or source["reason"] == "AWAITING_FULL_DAY_QUALIFICATION":
                raise ValueError("release unavailable disposition differs")
        elif partial and entry["state"] in ("PENDING", "RUNNING", "FAILED", "INTERRUPTED"):
            row["reason"] = "NOT_YET_QUALIFIED" if entry["state"] in ("PENDING", "RUNNING") else "QUALIFICATION_FAILED"
        else:
            raise ValueError("full-month release has an unfinished or failed day")
        sessions.append(row)
    if not any(row["state"] == "AVAILABLE" for row in sessions):
        raise ValueError("release contains no qualified days")
    payload = {"schema": "historical-l2-release/1", "month": inventory["month"], "plan_id": inventory["plan_id"],
               "source_catalog_sha256": inventory["source_catalog_sha256"], "sessions": sessions,
               "scope": "QUALIFIED_SUBSET" if partial else "COMPLETE_MONTH_DISPOSITIONS",
               "depth_limit": 10, "inference": "top-ten depth inference; not order-level cancellation truth"}
    data = encoded(payload)
    if len(data) > 65536:
        raise ValueError("release catalog exceeds control-object admission")
    release_id = hashlib.sha256(data).hexdigest()
    pointer = {"schema": "historical-l2-pointer/1", "release_id": release_id,
               "catalog_key": "_catalog/releases/" + release_id + ".json",
               "catalog_sha256": release_id, "catalog_bytes": len(data)}
    if digest(journal) != journal_pin:
        raise ValueError("run journal changed while preparing release; retry on a stable snapshot")
    return pointer, payload, artifacts


def verify_graph(payload, artifacts):
    if payload.get("schema") != "historical-l2-release/1" or not isinstance(payload.get("sessions"), list):
        raise ValueError("release schema admission failed")
    required, identities = set(), set()
    for row in payload["sessions"]:
        identity = (row["instrument_id"], row["date"])
        if identity in identities:
            raise ValueError("duplicate release session")
        identities.add(identity)
        if row["state"] == "UNAVAILABLE":
            if not row.get("reason"):
                raise ValueError("unavailable release needs an explicit reason")
            continue
        if row["state"] != "AVAILABLE":
            raise ValueError("release state admission failed")
        key = _relative(row["descriptor_key"])
        if not key.startswith("databento/") or key not in artifacts:
            raise ValueError("release descriptor missing")
        path, sha, size = artifacts[key]
        if (sha != row["descriptor_sha256"] or size != row["descriptor_bytes"]
                or path.stat().st_size != size or digest(path) != sha):
            raise ValueError("release descriptor pin differs")
        candidate = read_json(path, 4 * 1024**2)
        prefix = PREFIX + "/" + key.removesuffix("/candidate.json")
        if (candidate.get("schema") != "historical-l2-candidate/1" or candidate.get("status") != "LOCAL_VERIFIED; NOT_PUBLISHED"
                or candidate.get("prefix") != prefix or candidate.get("instrument_id") != row["instrument_id"]
                or candidate.get("date") != row["date"] or candidate.get("derivation_id") != row["derivation_id"]):
            raise ValueError("release descriptor identity differs")
        required.add(key)
        for item in candidate["objects"]:
            relative = _relative(item["key"].removeprefix(PREFIX + "/"))
            if not item["key"].startswith(prefix + "/") or relative not in artifacts or relative in required:
                raise ValueError("release artifact missing or duplicate")
            _path, actual_sha, actual_size = artifacts[relative]
            if (actual_sha, actual_size) != (item["sha256"], item["bytes"]):
                raise ValueError("release artifact pin differs")
            required.add(relative)
    if required != set(artifacts) or not required:
        raise ValueError("release artifact graph differs")


def publish(store, pointer, payload, artifacts, *, expected_parent, workers=4):
    if store.prefix != PREFIX or type(workers) is not int or not 1 <= workers <= 8:
        raise ValueError("publication namespace or worker admission failed")
    data = encoded(payload)
    identity = hashlib.sha256(data).hexdigest()
    expected = {"schema": "historical-l2-pointer/1", "release_id": identity,
                "catalog_key": "_catalog/releases/" + identity + ".json",
                "catalog_sha256": identity, "catalog_bytes": len(data)}
    if pointer != expected or len(data) > 65536:
        raise ValueError("publication catalog identity differs")
    verify_graph(payload, artifacts)
    current, etag = store.get_json(CURRENT)
    if current not in (pointer, expected_parent):
        raise PublicationError("PUBLICATION_PARENT_CHANGED")
    if expected_parent is not None:
        parent_key = expected_parent.get("catalog_key", "")
        if not parent_key.startswith("_catalog/releases/"):
            raise ValueError("parent catalog admission failed")
        parent, _ = store.get_json(parent_key)
        if parent is None or hashlib.sha256(encoded(parent)).hexdigest() != expected_parent.get("catalog_sha256"):
            raise PublicationError("PARENT_CATALOG_CORRUPT")
        new = {(row["instrument_id"], row["date"]): row for row in payload["sessions"]}
        for row in parent["sessions"]:
            if row["state"] == "AVAILABLE" and new.get((row["instrument_id"], row["date"])) != row:
                raise PublicationError("PARENT_QUALIFIED_DAY_DROPPED_OR_REPLACED")

    def upload(item):
        relative, (path, sha, size) = item
        if (path.is_symlink() or path.stat().st_size != size or digest(path) != sha
                or not relative.startswith("databento/") or "/../" in relative):
            raise ValueError("publication artifact changed or namespace differs")
        worker = Store(store.client, store.bucket, store.prefix)
        with path.open("rb") as body:
            worker.immutable(relative, body, sha, size)
        if digest(path) != sha:
            raise ValueError("publication artifact changed during upload")
        return worker.read_bytes, worker.write_bytes

    with ThreadPoolExecutor(max_workers=workers) as executor:
        items = iter(artifacts.items())
        while batch := list(islice(items, workers)):
            for read_bytes, write_bytes in executor.map(upload, batch):
                store.read_bytes += read_bytes
                store.write_bytes += write_bytes
    store.immutable_json(pointer["catalog_key"], payload)
    if current != pointer:
        body = encoded(pointer)
        condition = {"IfNoneMatch": "*"} if expected_parent is None else {"IfMatch": etag}
        try:
            store.client.put_object(Bucket=store.bucket, Key=store.key(CURRENT), Body=body,
                                    ContentLength=len(body), **condition)
        except Exception as error:
            if _status(error) in (404, 409, 412):
                raise PublicationError("PUBLICATION_PARENT_CHANGED") from error
            raise
        store.write_bytes += len(body)
    actual, _ = store.get_json(CURRENT)
    if actual != pointer:
        raise PublicationError("PUBLICATION_POINTER_NOT_VISIBLE")
    receipt = {"schema": "historical-l2-publication/1", "pointer": pointer}
    store.immutable_json("_catalog/receipts/" + identity + ".json", receipt)
    return {"status": "PUBLISHED", "pointer": pointer, "verified_read_bytes": store.read_bytes,
            "uploaded_bytes": store.write_bytes, "rollback_pointer": expected_parent}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--expected-parent", type=Path, help="Pinned prior L2 pointer JSON; omitted only for first publication")
    parser.add_argument("--partial", action="store_true", help="Publish qualified dates; remaining dates stay unavailable")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    import boto3
    from botocore.config import Config
    client = boto3.client("s3", region_name=os.environ["RCLONE_CONFIG_TTCONVERT_REGION"],
                          endpoint_url=os.environ.get("RCLONE_CONFIG_TTCONVERT_ENDPOINT") or None,
                          aws_access_key_id=os.environ["RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID"],
                          aws_secret_access_key=os.environ["RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY"],
                          config=Config(connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}))
    pointer, payload, artifacts = prepare(args.data_root, args.journal, args.node, partial=args.partial)
    result = publish(Store(client, args.bucket, PREFIX), pointer, payload, artifacts,
                     expected_parent=read_json(args.expected_parent) if args.expected_parent else None, workers=args.workers)
    print(json.dumps(result, sort_keys=True))
