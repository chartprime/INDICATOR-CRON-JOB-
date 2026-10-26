"""Conditional publication of a validated local catalog into an S3 namespace.

Immutable objects precede CURRENT. A stale parent never gets silently rebased.
The caller must supply the parent used to build this cumulative snapshot.
No deletion, raw writes, multipart uploads or bucket policy changes are made.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor

from catalog import _sha256_file


class PublicationError(RuntimeError):
    pass


_MAX_MANIFEST_BYTES = 16 * 1024 * 1024
_MAX_CATALOG_BYTES = 64 * 1024 * 1024
_MAX_VERIFICATION_WORKERS = 16
_DEFAULT_VERIFICATION_WORKERS = 8
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _relative(value):
    p = PurePosixPath(value)
    if not value or p.is_absolute() or ".." in p.parts or "\\" in value or str(p) != value:
        raise PublicationError("UNSAFE_OBJECT_PATH")
    return value


def _local(root, relative):
    path = root / _relative(relative)
    if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink() or not path.is_file():
        raise PublicationError("INVALID_LOCAL_ARTIFACT")
    return path


def _status(error):
    return getattr(error, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")


class Store:
    """Objects under one curated namespace.

    The rail is that nothing here can address `raw/` or the bucket root. A
    publisher is additionally confined to its own provider subtree by the prefix
    it is configured with, which is why that stays a deployment choice rather
    than something this class decides.

    The bare `curated` root is admitted for readers, which must span providers:
    a partition's provider is part of its key, so a reader rooted at
    `curated/databento` cannot reach `curated/binance` at all."""

    def __init__(self, client, bucket, prefix):
        self.client, self.bucket = client, bucket
        self.prefix = _relative(prefix.rstrip("/"))
        if self.prefix != "curated" and not self.prefix.startswith("curated/"):
            raise PublicationError("CURATED_NAMESPACE_REQUIRED")
        self.read_bytes = self.write_bytes = 0

    def key(self, relative):
        return self.prefix + "/" + _relative(relative)

    def get_json(self, relative):
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=self.key(relative))
        except Exception as error:
            if _status(error) == 404:
                return None, None
            raise
        with obj["Body"] as body:
            data = body.read(65537)
        self.read_bytes += len(data)
        if len(data) > 65536:
            raise PublicationError("OVERSIZED_CONTROL_OBJECT")
        return json.loads(data), obj["ETag"]

    def verify(self, relative, sha, size):
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=self.key(relative))
        except Exception as error:
            if _status(error) == 404:
                raise PublicationError("REMOTE_ARTIFACT_UNAVAILABLE") from error
            raise
        h, count = hashlib.sha256(), 0
        with obj["Body"] as body:
            while chunk := body.read(1024 * 1024):
                h.update(chunk)
                count += len(chunk)
                self.read_bytes += len(chunk)
                if count > size:
                    raise PublicationError("REMOTE_ARTIFACT_MISMATCH")
        if count != size or h.hexdigest() != sha:
            raise PublicationError("REMOTE_ARTIFACT_MISMATCH")

    def verify_stored(self, relative, sha, size):
        if hasattr(self.client, "head_object"):
            obj = self.client.head_object(Bucket=self.bucket, Key=self.key(relative), ChecksumMode="ENABLED")
            checksum = obj.get("ChecksumSHA256")
            if checksum:
                if obj["ContentLength"] != size or checksum != base64.b64encode(bytes.fromhex(sha)).decode():
                    raise PublicationError("REMOTE_ARTIFACT_MISMATCH")
                return
        self.verify(relative, sha, size)

    def immutable(self, relative, body, sha, size):
        if size > 5_000_000_000:
            raise PublicationError("SINGLE_PUT_LIMIT_EXCEEDED")
        try:
            self.client.put_object(Bucket=self.bucket, Key=self.key(relative), Body=body,
                                   ContentLength=size, IfNoneMatch="*",
                                   ChecksumSHA256=base64.b64encode(bytes.fromhex(sha)).decode())
            self.write_bytes += size
        except Exception as error:
            if _status(error) != 412:
                raise  # ambiguous network errors are recovered by rerunning
        self.verify(relative, sha, size)

    def immutable_json(self, relative, value):
        data = _json(value)
        self.immutable(relative, data, hashlib.sha256(data).hexdigest(), len(data))


def bundle(curated_root, pointer, store=None, *, verification_workers=_DEFAULT_VERIFICATION_WORKERS):
    """Enumerate only catalog-referenced artifacts, verifying every local hash.

    A cumulative catalog carries every partition ever published under it, and
    each one is re-verified against the remote object on every publication.
    That is one S3 round trip per partition, so it is done through the same
    bounded pool `verify_remote_partitions` uses rather than one at a time:
    serially it grew to 45 minutes per month at 4,494 partitions, which is
    twenty times the cost of converting the month it publishes.
    """
    root = Path(curated_root)
    snap_rel = "_catalog/" + _relative(pointer["catalog_key"])
    snap = _local(root, snap_rel)
    if _sha256_file(snap) != pointer["catalog_sha256"]:
        raise PublicationError("CATALOG_INTEGRITY_FAILURE")
    artifacts = {}
    already_published = []
    con = sqlite3.connect(snap.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise PublicationError("CATALOG_INTEGRITY_FAILURE")
        if con.execute("SELECT status FROM dataset_versions WHERE dataset_version=?",
                       [pointer["dataset_version"]]).fetchone() != ("PUBLISHED",):
            raise PublicationError("CATALOG_VERSION_MISMATCH")
        for prefix, manifest_sha, count, part_count, published_to_s3 in con.execute(
            "SELECT s3_prefix, manifest_sha256, record_count, part_count, published_to_s3 FROM partitions"
        ):
            manifest_rel = _relative(prefix) + "/_manifest.json"
            local_manifest = root / manifest_rel
            if published_to_s3 or not (local_manifest.exists() or local_manifest.is_symlink()):
                if store is None:
                    raise PublicationError("REMOTE_VERIFICATION_REQUIRED")
                already_published.append((prefix, manifest_sha))
                continue
            manifest_file = _local(root, manifest_rel)
            if _sha256_file(manifest_file) != manifest_sha:
                raise PublicationError("MANIFEST_INTEGRITY_FAILURE")
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            if (manifest["record_count"] != count or len(manifest["parts"]) != part_count
                    or sum(p["row_count"] for p in manifest["parts"]) != count
                    or not all(manifest.get("validation", {}).get(k) is True for k in
                               ("round_trip_ok", "id_unique", "sorted", "count_reconciled"))):
                raise PublicationError("UNVALIDATED_PARTITION")
            for part in manifest["parts"]:
                name = _relative(part["name"])
                if "/" in name:
                    raise PublicationError("UNSAFE_PART_NAME")
                rel = prefix + "/" + name
                path = _local(root, rel)
                if path.stat().st_size != part["bytes"] or _sha256_file(path) != part["sha256"]:
                    raise PublicationError("PART_INTEGRITY_FAILURE")
                if rel in artifacts:
                    raise PublicationError("DUPLICATE_ARTIFACT")
                artifacts[rel] = (path, part["sha256"])
            artifacts[manifest_rel] = (manifest_file, manifest_sha)
    finally:
        con.close()
    if already_published:
        verify_remote_partitions(store, already_published, workers=verification_workers)
    artifacts[snap_rel] = (snap, pointer["catalog_sha256"])
    return artifacts


def _remote_partition_manifest(store, prefix):
    relative = _relative(prefix) + "/_manifest.json"
    try:
        obj = store.client.get_object(Bucket=store.bucket, Key=store.key(relative))
    except Exception as error:
        if _status(error) == 404:
            return None
        raise
    with obj["Body"] as body:
        data = body.read(_MAX_MANIFEST_BYTES + 1)
    store.read_bytes += len(data)
    if len(data) > _MAX_MANIFEST_BYTES:
        raise PublicationError("OVERSIZED_REMOTE_MANIFEST")
    try:
        manifest = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise PublicationError("REMOTE_MANIFEST_INVALID_JSON") from error
    if not isinstance(manifest, dict):
        raise PublicationError("REMOTE_MANIFEST_INVALID_JSON")
    return manifest, hashlib.sha256(data).hexdigest()


def _partition_semantics(manifest):
    fields = (
        "schema_version", "contract_version", "roll_table_version", "instrument_id", "family",
        "dataset_version", "date", "source_objects", "record_count", "rejected_count",
        "rejected_summary", "event_ns_min", "event_ns_max", "sort_key", "validation",
    )
    return (
        tuple((field, manifest[field]) for field in fields),
        tuple((part["name"], part["row_count"], part["event_ns_min"], part["event_ns_max"])
              for part in manifest["parts"]),
    )


def _legacy_manifest_matches(candidate, remote, legacy_logical_sha256):
    if not isinstance(legacy_logical_sha256, str) or not legacy_logical_sha256:
        return False
    if remote.get("logical_sha256_format") is not None:
        return False
    if remote.get("converter_version") != "conversion/0.1":
        return False
    if candidate.get("logical_sha256_format") != "json-insertion-v2":
        return False
    if candidate.get("converter_version") != "conversion/0.2":
        return False
    if remote.get("logical_sha256") not in {candidate.get("logical_sha256"), legacy_logical_sha256}:
        return False
    try:
        return _partition_semantics(candidate) == _partition_semantics(remote)
    except (KeyError, TypeError):
        return False


def publish_partition(store, curated_root, prefix, manifest_sha256, *, legacy_logical_sha256=None):
    root = Path(curated_root)
    manifest_rel = _relative(prefix) + "/_manifest.json"
    manifest_file = _local(root, manifest_rel)
    if _sha256_file(manifest_file) != manifest_sha256:
        raise PublicationError("MANIFEST_INTEGRITY_FAILURE")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if not all(manifest.get("validation", {}).get(k) is True for k in
               ("round_trip_ok", "id_unique", "sorted", "count_reconciled")):
        raise PublicationError("UNVALIDATED_PARTITION")
    remote = _remote_partition_manifest(store, prefix)
    if remote is not None:
        remote_manifest, remote_sha256 = remote
        if remote_sha256 == manifest_sha256:
            verify_remote_partition(store, prefix, remote_sha256)
            return {"status": "ALREADY_PUBLISHED", "manifest": remote_manifest,
                    "manifest_sha256": remote_sha256}
        if _legacy_manifest_matches(manifest, remote_manifest, legacy_logical_sha256):
            verify_remote_partition(store, prefix, remote_sha256)
            return {"status": "ALREADY_PUBLISHED_LEGACY", "manifest": remote_manifest,
                    "manifest_sha256": remote_sha256}
        raise PublicationError("REMOTE_PARTITION_CONFLICT")
    for part in manifest["parts"]:
        name = _relative(part["name"])
        if "/" in name:
            raise PublicationError("UNSAFE_PART_NAME")
        rel = prefix + "/" + name
        path = _local(root, rel)
        if path.stat().st_size != part["bytes"] or _sha256_file(path) != part["sha256"]:
            raise PublicationError("PART_INTEGRITY_FAILURE")
        with path.open("rb") as body:
            store.immutable(rel, body, part["sha256"], path.stat().st_size)
    store.immutable(manifest_rel, manifest_file.read_bytes(), manifest_sha256, manifest_file.stat().st_size)
    return {"status": "PUBLISHED", "manifest": manifest, "manifest_sha256": manifest_sha256}


def verify_remote_partition(store, prefix, manifest_sha256):
    try:
        obj = store.client.get_object(
            Bucket=store.bucket, Key=store.key(_relative(prefix) + "/_manifest.json"))
    except Exception as error:
        if _status(error) == 404:
            raise PublicationError("REMOTE_MANIFEST_UNAVAILABLE") from error
        raise
    with obj["Body"] as body:
        data = body.read(_MAX_MANIFEST_BYTES + 1)
    store.read_bytes += len(data)
    if len(data) > _MAX_MANIFEST_BYTES or hashlib.sha256(data).hexdigest() != manifest_sha256:
        raise PublicationError("REMOTE_MANIFEST_INTEGRITY_FAILURE")
    manifest = json.loads(data)
    if (sum(p["row_count"] for p in manifest["parts"]) != manifest["record_count"]
            or not all(manifest.get("validation", {}).get(k) is True for k in
                       ("round_trip_ok", "id_unique", "sorted", "count_reconciled"))):
        raise PublicationError("UNVALIDATED_PARTITION")
    for part in manifest["parts"]:
        name = _relative(part["name"])
        if "/" in name:
            raise PublicationError("UNSAFE_PART_NAME")
        store.verify_stored(prefix + "/" + name, part["sha256"], part["bytes"])


def _catalog_pointer(pointer):
    if not isinstance(pointer, dict):
        raise PublicationError("PARENT_CATALOG_POINTER_INVALID")
    key, digest = pointer.get("catalog_key"), pointer.get("catalog_sha256")
    if (not isinstance(key, str) or not isinstance(digest, str)
            or _SHA256.fullmatch(digest) is None):
        raise PublicationError("PARENT_CATALOG_POINTER_INVALID")
    return _relative(key), digest


def _has_catalog_pointer(pointer):
    return isinstance(pointer, dict) and {"catalog_key", "catalog_sha256"} <= set(pointer)


def _catalog_authorities(path, expected_sha256):
    if _sha256_file(path) != expected_sha256:
        raise PublicationError("CATALOG_INTEGRITY_FAILURE")
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise PublicationError("CATALOG_INTEGRITY_FAILURE")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(partitions)")}
        required = {
            "instrument_id", "family", "dataset_version", "date", "s3_prefix", "part_count",
            "record_count", "rejected_count", "event_ns_min", "event_ns_max", "logical_sha256",
            "manifest_sha256", "created_at", "published_to_s3",
        }
        if not required <= columns:
            raise PublicationError("CATALOG_SCHEMA_UNSUPPORTED")
        provider = "provider" if "provider" in columns else "'databento' AS provider"
        authorities = {}
        for row in connection.execute(
                "SELECT instrument_id, family, dataset_version, date, " + provider + ", s3_prefix, "
                "part_count, record_count, rejected_count, event_ns_min, event_ns_max, logical_sha256, "
                "manifest_sha256, created_at, published_to_s3 FROM partitions"):
            authority = (row[0], row[1], row[3])
            value = tuple(row[2:])
            if authority in authorities:
                raise PublicationError("CATALOG_AUTHORITY_AMBIGUOUS")
            authorities[authority] = value
        return authorities
    except sqlite3.DatabaseError as error:
        raise PublicationError("CATALOG_INTEGRITY_FAILURE") from error
    finally:
        connection.close()


def _remote_catalog(store, pointer, directory):
    key, expected_sha256 = _catalog_pointer(pointer)
    path = Path(directory) / key
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        response = store.client.get_object(Bucket=store.bucket, Key=store.key("_catalog/" + key))
    except Exception as error:
        raise PublicationError("PARENT_CATALOG_UNAVAILABLE") from error
    digest, size = hashlib.sha256(), 0
    try:
        with path.open("xb") as handle, response["Body"] as body:
            while chunk := body.read(1024 * 1024):
                size += len(chunk)
                if size > _MAX_CATALOG_BYTES:
                    raise PublicationError("PARENT_CATALOG_OVERSIZED")
                digest.update(chunk)
                handle.write(chunk)
        store.read_bytes += size
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    if digest.hexdigest() != expected_sha256:
        path.unlink(missing_ok=True)
        raise PublicationError("PARENT_CATALOG_INTEGRITY_FAILURE")
    return path, expected_sha256


def _superseded_authorities(record):
    if record is None:
        return frozenset()
    if (not isinstance(record, dict) or set(record) != {"reason", "approved_by", "authorities"}
            or not all(isinstance(record[name], str) and record[name].strip() for name in ("reason", "approved_by"))
            or not isinstance(record["authorities"], list) or not record["authorities"]):
        raise PublicationError("SUPERSEDENCE_INVALID")
    authorities = set()
    for authority in record["authorities"]:
        if (not isinstance(authority, list) or len(authority) != 3
                or not all(isinstance(part, str) and part for part in authority)):
            raise PublicationError("SUPERSEDENCE_INVALID")
        authorities.add(tuple(authority))
    if len(authorities) != len(record["authorities"]):
        raise PublicationError("SUPERSEDENCE_INVALID")
    return frozenset(authorities)


def _assert_parent_contained(store, curated_root, pointer, parent, superseded=frozenset()):
    """Require an append-only authority transition except for the declared supersedence."""
    if parent is None or not (_has_catalog_pointer(parent) and _has_catalog_pointer(pointer)):
        if superseded:
            raise PublicationError("SUPERSEDENCE_UNUSED")
        return
    parent_key, parent_sha256 = _catalog_pointer(parent)
    candidate_key, candidate_sha256 = _catalog_pointer(pointer)
    candidate = _local(Path(curated_root), "_catalog/" + candidate_key)
    candidate_authorities = _catalog_authorities(candidate, candidate_sha256)
    with tempfile.TemporaryDirectory() as directory:
        remote, _ = _remote_catalog(store, parent, directory)
        parent_authorities = _catalog_authorities(remote, parent_sha256)
    replaced = set()
    for authority, value in parent_authorities.items():
        candidate_value = candidate_authorities.get(authority)
        if candidate_value is None:
            raise PublicationError("PARENT_PARTITION_DROPPED")
        if candidate_value != value:
            if authority not in superseded:
                raise PublicationError("PARENT_PARTITION_REPLACED")
            replaced.add(authority)
    if replaced != superseded:
        raise PublicationError("SUPERSEDENCE_UNUSED")


def _publish_catalog(store, curated_root, pointer, *, expected_parent, artifacts, intent, supersedes=None):
    """Publish verified immutable artifacts before one conditional catalog transition."""
    identity = hashlib.sha256(_json(pointer)).hexdigest()
    intent_key, receipt_key = f"_catalog/intents/{identity}.json", f"_catalog/receipts/{identity}.json"
    receipt, _ = store.get_json(receipt_key)
    if receipt is not None:
        if receipt != intent:
            raise PublicationError("RECEIPT_MISMATCH")
        return {"status": "ALREADY_PUBLISHED", "pointer": pointer}
    current, etag = store.get_json("_catalog/CURRENT.json")
    if current != pointer and current != expected_parent:
        raise PublicationError("PUBLICATION_PARENT_CHANGED")
    _assert_parent_contained(store, curated_root, pointer, expected_parent,
                             _superseded_authorities(supersedes))
    store.immutable_json(intent_key, intent)
    for relative, (path, sha) in artifacts.items():
        with path.open("rb") as body:
            store.immutable(relative, body, sha, path.stat().st_size)
    if current != pointer:
        data = _json(pointer)
        condition = {"IfNoneMatch": "*"} if expected_parent is None else {"IfMatch": etag}
        try:
            store.client.put_object(Bucket=store.bucket, Key=store.key("_catalog/CURRENT.json"),
                                    Body=data, ContentLength=len(data), **condition)
            store.write_bytes += len(data)
        except Exception as error:
            if _status(error) in (409, 412, 404):
                raise PublicationError("PUBLICATION_PARENT_CHANGED") from error
            raise
    store.immutable_json(receipt_key, intent)
    return {"status": "PUBLISHED", "pointer": pointer,
            "verified_read_bytes": store.read_bytes, "uploaded_bytes": store.write_bytes}


def publish(store, curated_root, pointer, *, expected_parent, supersedes=None):
    """Publish converted artifacts and their cumulative catalog in one namespace."""
    _superseded_authorities(supersedes)
    intent = {"pointer": pointer, "parent": expected_parent}
    if supersedes is not None:
        intent["supersedes"] = supersedes
    return _publish_catalog(
        store, curated_root, pointer, expected_parent=expected_parent,
        artifacts=bundle(curated_root, pointer, store),
        intent=intent, supersedes=supersedes,
    )


def _catalog_only_snapshot(catalog_root, pointer):
    catalog_key, _ = _catalog_pointer(pointer)
    candidate = _local(Path(catalog_root), "_catalog/" + catalog_key)
    authorities = _catalog_authorities(candidate, pointer["catalog_sha256"])
    if any(value[-1] != 1 for value in authorities.values()):
        raise PublicationError("CATALOG_CONTAINS_UNPUBLISHED_PARTITION")
    try:
        connection = sqlite3.connect(candidate.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            if connection.execute(
                    "SELECT status FROM dataset_versions WHERE dataset_version=?",
                    [pointer["dataset_version"]]).fetchone() != ("PUBLISHED",):
                raise PublicationError("CATALOG_VERSION_MISMATCH")
            entries = connection.execute(
                "SELECT s3_prefix, manifest_sha256 FROM partitions ORDER BY s3_prefix"
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.DatabaseError as error:
        raise PublicationError("CATALOG_INTEGRITY_FAILURE") from error
    prefixes = {}
    for prefix, manifest_sha256 in entries:
        previous = prefixes.setdefault(prefix, manifest_sha256)
        if previous != manifest_sha256:
            raise PublicationError("CATALOG_ARTIFACT_AMBIGUOUS")
    return candidate, catalog_key, tuple(prefixes.items()), len(authorities)


def verify_remote_partitions(data_store, entries, *, workers=8):
    """Verify catalogued remote partitions through a bounded thread-safe S3 client."""
    if not isinstance(workers, int) or isinstance(workers, bool) or not 1 <= workers <= _MAX_VERIFICATION_WORKERS:
        raise PublicationError("INVALID_VERIFICATION_WORKERS")

    def verify(entry):
        store = Store(data_store.client, data_store.bucket, data_store.prefix)
        verify_remote_partition(store, entry[0], entry[1])
        return store.read_bytes

    if workers == 1:
        read_bytes = sum(verify(entry) for entry in entries)
    else:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            read_bytes = sum(executor.map(verify, entries))
    data_store.read_bytes += read_bytes
    return {"partition_count": len(entries), "verified_read_bytes": read_bytes,
            "verification_workers": workers}


def verify_catalog_only(data_store, catalog_root, pointer, *, workers=8):
    """Verify every remotely published catalog partition without writing an object."""
    _candidate, _catalog_key, entries, authority_count = _catalog_only_snapshot(catalog_root, pointer)
    verification = verify_remote_partitions(data_store, entries, workers=workers)
    return {"catalog_key": pointer["catalog_key"], "catalog_sha256": pointer["catalog_sha256"],
            "partition_count": authority_count, **verification}


def publish_catalog_only(catalog_store, data_store, catalog_root, pointer, *, expected_parent, workers=8, supersedes=None):
    """Publish a verified catalog control plane without copying immutable data artifacts.

    ``data_store`` is read-only from this function's perspective: it verifies
    every catalog-referenced remote partition before the historical control
    namespace receives an intent, snapshot, receipt, or ``CURRENT`` update.
    """
    _superseded_authorities(supersedes)
    candidate, catalog_key, entries, _authority_count = _catalog_only_snapshot(catalog_root, pointer)
    verify_remote_partitions(data_store, entries, workers=workers)
    artifacts = {"_catalog/" + catalog_key: (candidate, pointer["catalog_sha256"])}
    intent = {"pointer": pointer, "parent": expected_parent, "data_prefix": data_store.prefix}
    if supersedes is not None:
        intent["supersedes"] = supersedes
    return _publish_catalog(
        catalog_store, catalog_root, pointer, expected_parent=expected_parent,
        artifacts=artifacts, intent=intent, supersedes=supersedes,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--curated-root", required=True)
    parser.add_argument("--intent", required=True, help="Local catalog intent (pointer + parent)")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", help="Converted-data namespace for a normal publication")
    parser.add_argument("--catalog-control-prefix",
                        help="Dedicated curated/... historical catalog-control namespace")
    parser.add_argument("--data-prefix",
                        help="Existing curated/... provider-data namespace verified by catalog-only publication")
    parser.add_argument("--verification-workers", type=int, default=8)
    args = parser.parse_args()
    import boto3
    from botocore.config import Config
    intent = json.loads(Path(args.intent).read_text(encoding="utf-8"))
    client = boto3.client("s3", region_name=os.environ["RCLONE_CONFIG_TTCONVERT_REGION"],
                          aws_access_key_id=os.environ["RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID"],
                          aws_secret_access_key=os.environ["RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY"],
                          config=Config(connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}))
    if args.catalog_control_prefix is not None or args.data_prefix is not None:
        if args.prefix is not None or not args.catalog_control_prefix or not args.data_prefix:
            parser.error("catalog-only publication requires --catalog-control-prefix and --data-prefix only")
        result = publish_catalog_only(
            Store(client, args.bucket, args.catalog_control_prefix),
            Store(client, args.bucket, args.data_prefix), args.curated_root,
            intent["pointer"], expected_parent=intent["parent"], workers=args.verification_workers,
            supersedes=intent.get("supersedes"),
        )
    else:
        if not args.prefix:
            parser.error("--prefix is required for a normal publication")
        result = publish(Store(client, args.bucket, args.prefix), args.curated_root,
                         intent["pointer"], expected_parent=intent["parent"],
                         supersedes=intent.get("supersedes"))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
