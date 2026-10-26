"""Resolve a published curated partition through a catalog snapshot and fetch its parts, verified.

The catalog names a partition by `(instrument, family, date)` and records the
manifest's hash; the manifest names the parts and their hashes. Every byte
that leaves S3 through here is checked against those hashes before a caller
sees it, so a computation over the parts is a computation over exactly what
was published.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from pathlib import Path

MAX_MANIFEST_BYTES = 4 * 1024 * 1024
PART_NAME_PATTERN = "part-"


class CuratedPartitionError(RuntimeError):
    pass


def _connect(snapshot_path):
    return sqlite3.connect(Path(snapshot_path).resolve().as_uri() + "?mode=ro", uri=True)


def _rows(snapshot_path, query, parameters):
    connection = _connect(snapshot_path)
    try:
        return connection.execute(query, parameters).fetchall()
    finally:
        connection.close()


def _partition_rows(snapshot_path, query, parameters):
    """Rows with a provider column; a snapshot built before the column existed reads as NULL."""
    connection = _connect(snapshot_path)
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(partitions)")}
        provider = "provider" if "provider" in columns else "NULL"
        return connection.execute(query.replace("{provider}", provider), parameters).fetchall()
    finally:
        connection.close()


def resolve(snapshot_path, instrument_id, family, date, dataset_version=None):
    """The one catalogued partition for an authority, refused when there are none or two."""
    query = ("SELECT s3_prefix, manifest_sha256, record_count, dataset_version, part_count, {provider}, "
             "published_to_s3 FROM partitions WHERE instrument_id=? AND family=? AND date=?")
    parameters = [instrument_id, family, date]
    if dataset_version is not None:
        query += " AND dataset_version=?"
        parameters.append(dataset_version)
    rows = _partition_rows(snapshot_path, query + " ORDER BY dataset_version", parameters)
    if not rows:
        raise CuratedPartitionError(f"PARTITION_NOT_CATALOGUED:{family}:{date}")
    if len(rows) > 1:
        raise CuratedPartitionError(f"PARTITION_AUTHORITY_AMBIGUOUS:{family}:{date}")
    prefix, manifest_sha256, record_count, version, part_count, provider, published = rows[0]
    return {"instrument_id": instrument_id, "family": family, "date": date, "s3_prefix": prefix,
            "manifest_sha256": manifest_sha256, "record_count": record_count, "dataset_version": version,
            "part_count": part_count, "provider": provider or "databento", "published_to_s3": bool(published)}


def resolve_many(snapshot_path, instrument_id, family, dates):
    return [resolve(snapshot_path, instrument_id, family, date) for date in dates]


def catalogued_dates(snapshot_path, instrument_id, family, month=None):
    """Every date the catalog holds for an authority, with its record count, oldest first."""
    query = "SELECT date, record_count FROM partitions WHERE instrument_id=? AND family=?"
    parameters = [instrument_id, family]
    if month is not None:
        query += " AND date LIKE ?"
        parameters.append(f"{month}-%")
    return [{"date": date, "record_count": count}
            for date, count in _rows(snapshot_path, query + " ORDER BY date", parameters)]


def read_manifest(store, partition):
    """The partition's manifest, only if it hashes to what the catalog recorded."""
    obj = store.client.get_object(Bucket=store.bucket, Key=store.key(partition["s3_prefix"] + "/_manifest.json"))
    with obj["Body"] as body:
        data = body.read(MAX_MANIFEST_BYTES + 1)
    if len(data) > MAX_MANIFEST_BYTES or hashlib.sha256(data).hexdigest() != partition["manifest_sha256"]:
        raise CuratedPartitionError("REMOTE_MANIFEST_INTEGRITY_FAILURE")
    manifest = json.loads(data)
    parts = manifest.get("parts")
    if not isinstance(parts, list) or not parts:
        raise CuratedPartitionError("MANIFEST_HAS_NO_PARTS")
    if sum(part["row_count"] for part in parts) != manifest["record_count"]:
        raise CuratedPartitionError("UNVALIDATED_PARTITION")
    if partition.get("record_count") is not None and manifest["record_count"] != partition["record_count"]:
        raise CuratedPartitionError("MANIFEST_DISAGREES_WITH_CATALOG")
    return manifest


def download_part(store, relative, sha256, size, destination):
    obj = store.client.get_object(Bucket=store.bucket, Key=store.key(relative))
    digest, count = hashlib.sha256(), 0
    with obj["Body"] as body, open(destination, "wb") as handle:
        while chunk := body.read(1024 * 1024):
            digest.update(chunk)
            count += len(chunk)
            if count > size:
                raise CuratedPartitionError("REMOTE_ARTIFACT_MISMATCH")
            handle.write(chunk)
    if count != size or digest.hexdigest() != sha256:
        raise CuratedPartitionError("REMOTE_ARTIFACT_MISMATCH")
    return count


def fetch_verified(store, partition, scratch_dir, manifest=None):
    """Download every part of a partition into `scratch_dir`, hash-verified, and return their paths.

    A part that fails verification is removed before the error surfaces, so a
    caller never finds a half-written file next to good ones."""
    manifest = manifest or read_manifest(store, partition)
    target = Path(scratch_dir) / f"{partition['family']}-{partition['date']}-{partition['manifest_sha256'][:12]}"
    target.mkdir(parents=True, exist_ok=True)
    paths = []
    for part in manifest["parts"]:
        name = part["name"]
        if not isinstance(name, str) or not name.startswith(PART_NAME_PATTERN) or "/" in name or "\\" in name:
            raise CuratedPartitionError("UNSAFE_PART_NAME")
        destination = target / name
        try:
            download_part(store, partition["s3_prefix"] + "/" + name, part["sha256"], part["bytes"], destination)
        except BaseException:
            for path in [*paths, os.fspath(destination)]:
                Path(path).unlink(missing_ok=True)
            raise
        paths.append(os.fspath(destination))
    return paths


def discard(paths):
    for path in paths:
        Path(path).unlink(missing_ok=True)
    for parent in {Path(path).parent for path in paths}:
        try:
            parent.rmdir()
        except OSError:
            pass
