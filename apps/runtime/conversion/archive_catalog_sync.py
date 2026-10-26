"""Synchronise one immutable remote catalog snapshot into a local reader root."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re

import catalog
import s3_publish


MAX_CATALOG_BYTES = 64 * 1024 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class CatalogSyncError(RuntimeError):
    pass


def _atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp.{os.getpid()}")
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name == "posix":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _pointer(pointer):
    if not isinstance(pointer, dict):
        raise CatalogSyncError("REMOTE_POINTER_INVALID")
    key, sha = pointer.get("catalog_key"), pointer.get("catalog_sha256")
    if (not isinstance(key, str) or not isinstance(sha, str)
            or _SHA256.fullmatch(sha) is None):
        raise CatalogSyncError("REMOTE_POINTER_INVALID")
    try:
        s3_publish._relative(key)
    except s3_publish.PublicationError as error:
        raise CatalogSyncError("REMOTE_POINTER_INVALID") from error
    return key, sha


def _read_catalog(store, key, expected_sha256):
    try:
        response = store.client.get_object(
            Bucket=store.bucket, Key=store.key("_catalog/" + key))
    except Exception as error:
        raise CatalogSyncError("REMOTE_CATALOG_UNAVAILABLE") from error
    digest, data = hashlib.sha256(), bytearray()
    with response["Body"] as body:
        while chunk := body.read(1024 * 1024):
            data.extend(chunk)
            if len(data) > MAX_CATALOG_BYTES:
                raise CatalogSyncError("REMOTE_CATALOG_OVERSIZED")
            digest.update(chunk)
    if digest.hexdigest() != expected_sha256:
        raise CatalogSyncError("REMOTE_CATALOG_HASH_MISMATCH")
    return bytes(data)


def sync(store, catalog_root):
    """Atomically point a local reader root at the hash-verified remote snapshot."""
    try:
        pointer, _etag = store.get_json("_catalog/CURRENT.json")
    except Exception as error:
        raise CatalogSyncError("REMOTE_POINTER_UNAVAILABLE") from error
    key, sha = _pointer(pointer)
    data = _read_catalog(store, key, sha)
    root = Path(catalog_root)
    _atomic_bytes(root / key, data)
    catalog._atomic_write_json(root / "CURRENT.json", pointer)
    return {"catalog_key": key, "catalog_sha256": sha, "catalog_bytes": len(data)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--catalog-prefix", required=True)
    parser.add_argument("--catalog-root", required=True)
    args = parser.parse_args(argv)
    from archive_http import _build_query_s3_client

    store = s3_publish.Store(_build_query_s3_client(), args.bucket, args.catalog_prefix)
    print(json.dumps(sync(store, args.catalog_root), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
