"""Build a local cumulative catalog from two immutable catalog snapshots."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid

import catalog
from s3_publish import PublicationError, _superseded_authorities
from writer import WriterError, validate_version


class CatalogReconciliationError(RuntimeError):
    pass


_DATASET_COLUMNS = (
    "dataset_version", "created_at", "converter_version", "contract_version",
    "roll_table_version", "status",
)
_PARTITION_COLUMNS = (
    "instrument_id", "family", "dataset_version", "date", "provider", "s3_prefix",
    "part_count", "record_count", "rejected_count", "event_ns_min", "event_ns_max",
    "logical_sha256", "manifest_sha256", "created_at", "published_to_s3",
)
_ROLL_COLUMNS = (
    "alias", "from_ns", "to_ns", "instrument_id", "contract_code", "tick_size",
    "multiplier", "roll_table_version",
)
_CONTINUITY_COLUMNS = (
    "instrument_id", "family", "dataset_version", "book_epoch", "from_ns", "to_ns",
    "state", "observed_resets", "suspected_gaps",
)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _snapshot(path, expected_sha256):
    path = Path(path)
    if (not isinstance(expected_sha256, str) or _SHA256.fullmatch(expected_sha256) is None):
        raise CatalogReconciliationError("CATALOG_SNAPSHOT_HASH_INVALID")
    if path.is_symlink() or not path.is_file():
        raise CatalogReconciliationError("CATALOG_SNAPSHOT_UNAVAILABLE")
    if catalog._sha256_file(path) != expected_sha256:
        raise CatalogReconciliationError("CATALOG_SNAPSHOT_HASH_MISMATCH")
    try:
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            connection.row_factory = sqlite3.Row
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise CatalogReconciliationError("CATALOG_SNAPSHOT_CORRUPT")
            tables = {row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )}
            if not {"dataset_versions", "partitions", "roll_intervals", "continuity"} <= tables:
                raise CatalogReconciliationError("CATALOG_SCHEMA_UNSUPPORTED")
            partition_columns = {row[1] for row in connection.execute("PRAGMA table_info(partitions)")}
            required = set(_PARTITION_COLUMNS) - {"provider"}
            if not required <= partition_columns:
                raise CatalogReconciliationError("CATALOG_SCHEMA_UNSUPPORTED")
            provider = "provider" if "provider" in partition_columns else "'databento' AS provider"
            snapshot = {
                "datasets": [dict(row) for row in connection.execute(
                    "SELECT " + ", ".join(_DATASET_COLUMNS) + " FROM dataset_versions"
                )],
                "partitions": [dict(row) for row in connection.execute(
                    "SELECT instrument_id, family, dataset_version, date, " + provider + ", s3_prefix, "
                    "part_count, record_count, rejected_count, event_ns_min, event_ns_max, logical_sha256, "
                    "manifest_sha256, created_at, published_to_s3 FROM partitions"
                )],
                "rolls": [dict(row) for row in connection.execute(
                    "SELECT " + ", ".join(_ROLL_COLUMNS) + " FROM roll_intervals"
                )],
                "continuity": [dict(row) for row in connection.execute(
                    "SELECT " + ", ".join(_CONTINUITY_COLUMNS) + " FROM continuity"
                )],
            }
        finally:
            connection.close()
    except sqlite3.DatabaseError as error:
        raise CatalogReconciliationError("CATALOG_SNAPSHOT_CORRUPT") from error
    if catalog._sha256_file(path) != expected_sha256:
        raise CatalogReconciliationError("CATALOG_SNAPSHOT_HASH_MISMATCH")
    return snapshot


def _values(row, columns):
    return tuple(row[column] for column in columns)


def _insert_unique(connection, table, columns, rows, key_columns, conflict):
    known = {}
    statement = (
        "INSERT INTO " + table + " (" + ", ".join(columns) + ") VALUES ("
        + ", ".join("?" for _ in columns) + ")"
    )
    for row in rows:
        values = _values(row, columns)
        key = tuple(row[column] for column in key_columns)
        previous = known.get(key)
        if previous is not None:
            if previous != values:
                raise CatalogReconciliationError(conflict)
            continue
        known[key] = values
        connection.execute(statement, values)
    return known


def _insert_datasets(connection, rows):
    known = {}
    for row in rows:
        version = row["dataset_version"]
        values = _values(row, _DATASET_COLUMNS)
        previous = known.get(version)
        if previous is None:
            known[version] = values
            connection.execute(
                "INSERT INTO dataset_versions (" + ", ".join(_DATASET_COLUMNS)
                + ") VALUES (" + ", ".join("?" for _ in _DATASET_COLUMNS) + ")",
                values,
            )
            continue
        if previous == values:
            continue
        if (previous[:-1] != values[:-1]
                or {previous[-1], values[-1]} != {"PUBLISHED", "SUPERSEDED"}):
            raise CatalogReconciliationError("CONFLICTING_DATASET_VERSION")
        known[version] = previous[:-1] + ("SUPERSEDED",)
        connection.execute(
            "UPDATE dataset_versions SET status='SUPERSEDED' WHERE dataset_version=?",
            [version],
        )
    return known


def _insert_partitions(connection, parent, additions, supersede=frozenset()):
    identities, authorities, owners = {}, {}, {}
    replaced = set()
    statement = (
        "INSERT INTO partitions (" + ", ".join(_PARTITION_COLUMNS) + ") VALUES ("
        + ", ".join("?" for _ in _PARTITION_COLUMNS) + ")"
    )
    for origin, source in (("parent", parent), ("addition", additions)):
        for row in source:
            values = _values(row, _PARTITION_COLUMNS)
            identity = (row["instrument_id"], row["family"], row["dataset_version"], row["date"])
            authority = (row["instrument_id"], row["family"], row["date"])
            previous = identities.get(identity)
            if previous is not None:
                if previous != values:
                    if (previous[:-1] != values[:-1]
                            or {previous[-1], values[-1]} != {0, 1}):
                        raise CatalogReconciliationError("CONFLICTING_PARTITION_IDENTITY")
                    identities[identity] = previous[:-1] + (1,)
                    connection.execute(
                        "UPDATE partitions SET published_to_s3=1 WHERE instrument_id=? "
                        "AND family=? AND dataset_version=? AND date=?",
                        list(identity),
                    )
                continue
            if authority in authorities:
                owner = owners[authority]
                if origin != "addition" or owner[0] != "parent" or authority not in supersede:
                    raise CatalogReconciliationError("CONFLICTING_PARTITION_AUTHORITY")
                connection.execute(
                    "DELETE FROM partitions WHERE instrument_id = ? AND family = ? AND date = ?",
                    list(authority),
                )
                del identities[owner[1]]
                replaced.add(authority)
            identities[identity] = values
            authorities[authority] = values
            owners[authority] = (origin, identity)
            connection.execute(statement, values)
    return identities, authorities, replaced


def _sync_directory(path):
    if os.name != "posix":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def reconcile(parent_snapshot, addition_snapshot, output_path, dataset_version, *, parent_sha256, addition_sha256,
              supersede_allowlist=None):
    """Create one local snapshot that retains both source authorities exactly."""
    try:
        validate_version(dataset_version)
    except WriterError as error:
        raise CatalogReconciliationError("INVALID_RECONCILIATION_VERSION") from error
    try:
        supersede = _superseded_authorities(supersede_allowlist)
    except PublicationError as error:
        raise CatalogReconciliationError("SUPERSEDE_ALLOWLIST_INVALID") from error
    parent = _snapshot(parent_snapshot, parent_sha256)
    additions = _snapshot(addition_snapshot, addition_sha256)
    if any(row["dataset_version"] == dataset_version for row in parent["datasets"] + additions["datasets"]):
        raise CatalogReconciliationError("RECONCILIATION_VERSION_ALREADY_EXISTS")
    output = Path(output_path)
    if output.exists() or output.is_symlink():
        raise CatalogReconciliationError("RECONCILIATION_OUTPUT_EXISTS")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp." + uuid.uuid4().hex)
    connection = None
    try:
        connection = sqlite3.connect(temporary)
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.executescript(catalog._DDL)
        datasets = _insert_datasets(connection, parent["datasets"] + additions["datasets"])
        partitions, authorities, replaced = _insert_partitions(
            connection, parent["partitions"], additions["partitions"], supersede
        )
        _insert_unique(
            connection, "roll_intervals", _ROLL_COLUMNS,
            parent["rolls"] + additions["rolls"],
            ("alias", "from_ns", "roll_table_version"), "CONFLICTING_ROLL_INTERVAL",
        )
        _insert_unique(
            connection, "continuity", _CONTINUITY_COLUMNS,
            parent["continuity"] + additions["continuity"],
            ("instrument_id", "family", "dataset_version", "book_epoch"),
            "CONFLICTING_CONTINUITY_EPOCH",
        )
        connection.execute(
            "INSERT INTO dataset_versions (dataset_version, created_at, converter_version, "
            "contract_version, roll_table_version, status) VALUES (?, ?, ?, ?, ?, 'PUBLISHED')",
            [dataset_version, catalog._now_iso(), catalog.CONVERTER_VERSION, catalog.CONTRACT_VERSION, None],
        )
        connection.commit()
        connection.execute("VACUUM")
        connection.close()
        connection = None
        os.replace(temporary, output)
        _sync_directory(output.parent)
    except BaseException:
        if connection is not None:
            connection.close()
        temporary.unlink(missing_ok=True)
        raise
    return {
        "catalog_key": output.name,
        "catalog_sha256": catalog._sha256_file(output),
        "parent_catalog_sha256": parent_sha256,
        "addition_catalog_sha256": addition_sha256,
        "parent_partitions": len(parent["partitions"]),
        "addition_partitions": len(additions["partitions"]),
        "candidate_partitions": len(partitions),
        "candidate_authorities": len(authorities),
        "dataset_versions": len(datasets) + 1,
        "supersedes": None if not replaced else {
            "reason": supersede_allowlist["reason"],
            "approved_by": supersede_allowlist["approved_by"],
            "authorities": [list(authority) for authority in sorted(replaced)],
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent-snapshot", required=True)
    parser.add_argument("--addition-snapshot", required=True)
    parser.add_argument("--parent-sha256", required=True)
    parser.add_argument("--addition-sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--supersede-allowlist", default=None,
                        help="JSON {reason, approved_by, authorities}: parent authorities an addition may replace")
    args = parser.parse_args(argv)
    allowlist = None
    if args.supersede_allowlist is not None:
        try:
            allowlist = json.loads(Path(args.supersede_allowlist).read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise CatalogReconciliationError("SUPERSEDE_ALLOWLIST_UNREADABLE") from error
    print(json.dumps(reconcile(
        args.parent_snapshot, args.addition_snapshot, args.output, args.dataset_version,
        parent_sha256=args.parent_sha256, addition_sha256=args.addition_sha256,
        supersede_allowlist=allowlist,
    ), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
