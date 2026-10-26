"""Read a pinned catalog partition and verify its remote manifest, without fetching parts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess


MAX_MANIFEST_BYTES = 4 * 1024 * 1024


def inspect(catalog: Path, instrument: str, family: str, day: str, version: str) -> dict[str, object]:
    if family not in ("depth", "trade", "quote") or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError("only dated depth/trade/quote partitions are supported")
    connection = sqlite3.connect(catalog.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT instrument_id, s3_prefix, manifest_sha256, record_count, dataset_version, part_count, "
            "provider, published_to_s3 FROM partitions WHERE family=? AND date=? "
            "AND dataset_version=?",
            (family, day, version),
        ).fetchall()
    finally:
        connection.close()
    rows = [row for row in rows if row[0] == instrument or json.loads(row[0])[2] == instrument]
    if len(rows) != 1:
        raise ValueError("partition authority is absent or ambiguous")
    instrument, prefix, manifest_sha, record_count, version, part_count, provider, published = rows[0]
    partition = {"instrument_id": instrument, "family": family, "date": day,
                 "s3_prefix": prefix, "manifest_sha256": manifest_sha, "record_count": record_count,
                 "dataset_version": version, "part_count": part_count, "provider": provider,
                 "published_to_s3": bool(published)}
    if not partition["published_to_s3"]:
        raise ValueError("partition is not published")
    if provider != "databento" or not prefix.startswith("databento/") or not re.fullmatch(r"[A-Za-z0-9/_=.-]+", prefix):
        raise ValueError("unexpected Databento storage prefix")
    relative = "databento/" + prefix
    remote = f"ttconvert:chartprime-historical-data/curated/{relative}/_manifest.json"
    result = subprocess.run(["rclone", "cat", remote, "--head", str(MAX_MANIFEST_BYTES + 1)],
                            capture_output=True, check=True, timeout=30)
    data = result.stdout
    if len(data) > MAX_MANIFEST_BYTES:
        raise ValueError("manifest exceeds size limit")
    if hashlib.sha256(data).hexdigest() != partition["manifest_sha256"]:
        raise ValueError("manifest differs from pinned catalog")
    manifest = json.loads(data)
    parts = manifest.get("parts")
    if not isinstance(parts, list) or not parts:
        raise ValueError("manifest has no parts")
    if sum(part["row_count"] for part in parts) != partition["record_count"]:
        raise ValueError("part rows differ from pinned catalog")
    return {"partition": partition, "relative_prefix": f"curated/{relative}",
            "parts": [{"name": part["name"], "bytes": part["bytes"],
                       "rows": part["row_count"], "sha256": part["sha256"]} for part in parts]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--family", required=True)
    parser.add_argument("--day", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    print(json.dumps(inspect(args.catalog, args.instrument, args.family, args.day, args.version), sort_keys=True))
