"""Create a new local catalog snapshot after verifying its remote artifacts."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import uuid

import catalog
import s3_publish


class CatalogAttestationError(RuntimeError):
    pass


def _source(root, pointer):
    try:
        catalog_key, catalog_sha256 = s3_publish._catalog_pointer(pointer)
        path = s3_publish._local(Path(root), "_catalog/" + catalog_key)
        authorities = s3_publish._catalog_authorities(path, catalog_sha256)
    except s3_publish.PublicationError as error:
        raise CatalogAttestationError(str(error)) from error
    return path, catalog_key, catalog_sha256, authorities


def _partitions(path, dataset_version):
    try:
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            status = connection.execute(
                "SELECT status FROM dataset_versions WHERE dataset_version=?", [dataset_version]
            ).fetchone()
            if status != ("PUBLISHED",):
                raise CatalogAttestationError("CATALOG_VERSION_MISMATCH")
            rows = connection.execute(
                "SELECT s3_prefix, manifest_sha256 FROM partitions ORDER BY s3_prefix"
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.DatabaseError as error:
        raise CatalogAttestationError("CATALOG_INTEGRITY_FAILURE") from error
    known = {}
    for prefix, manifest_sha256 in rows:
        prior = known.setdefault(prefix, manifest_sha256)
        if prior != manifest_sha256:
            raise CatalogAttestationError("CATALOG_ARTIFACT_AMBIGUOUS")
    return tuple(known.items())


def _sync_directory(path):
    if os.name != "posix":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def attest(data_store, catalog_root, pointer, output_path, *, workers=8):
    """Verify all remote partitions, then atomically write an attested catalog copy."""
    if not isinstance(pointer, dict) or not isinstance(pointer.get("dataset_version"), str):
        raise CatalogAttestationError("CATALOG_POINTER_INVALID")
    source, _catalog_key, source_sha256, authorities = _source(catalog_root, pointer)
    partitions = _partitions(source, pointer["dataset_version"])
    output = Path(output_path)
    if output.exists() or output.is_symlink():
        raise CatalogAttestationError("ATTESTED_CATALOG_OUTPUT_EXISTS")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp." + uuid.uuid4().hex)
    try:
        s3_publish.verify_remote_partitions(data_store, partitions, workers=workers)
        if catalog._sha256_file(source) != source_sha256:
            raise CatalogAttestationError("CATALOG_SNAPSHOT_HASH_MISMATCH")
        destination = sqlite3.connect(temporary)
        try:
            original = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)
            try:
                original.backup(destination)
            finally:
                original.close()
            destination.execute("PRAGMA journal_mode=DELETE")
            destination.execute("UPDATE partitions SET published_to_s3=1")
            destination.commit()
            if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise CatalogAttestationError("ATTESTED_CATALOG_CORRUPT")
        finally:
            destination.close()
        if os.name == "posix":
            with temporary.open("rb") as handle:
                os.fsync(handle.fileno())
        os.replace(temporary, output)
        _sync_directory(output.parent)
    except (s3_publish.PublicationError, CatalogAttestationError):
        temporary.unlink(missing_ok=True)
        raise
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    result = dict(pointer)
    result["catalog_key"] = output.name
    result["catalog_sha256"] = catalog._sha256_file(output)
    result["source_catalog_sha256"] = source_sha256
    result["partition_count"] = len(authorities)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-root", required=True)
    parser.add_argument("--pointer", required=True, help="Local source catalog pointer JSON")
    parser.add_argument("--output", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--data-prefix", required=True)
    parser.add_argument("--verification-workers", type=int, default=8)
    args = parser.parse_args(argv)
    from archive_http import _build_query_s3_client

    pointer = json.loads(Path(args.pointer).read_text(encoding="utf-8"))
    store = s3_publish.Store(_build_query_s3_client(), args.bucket, args.data_prefix)
    print(json.dumps(attest(
        store, args.catalog_root, pointer, args.output, workers=args.verification_workers), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
