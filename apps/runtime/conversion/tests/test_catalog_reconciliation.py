from contextlib import closing
import sqlite3

import pytest

import catalog
import catalog_reconciliation as reconcile


def _manifest(version, family="candle", date="2025-09-01", instrument='["GLBX","FUTURE","ESH6"]'):
    return {
        "instrument_id": instrument,
        "family": family,
        "dataset_version": version,
        "date": date,
        "record_count": 1,
        "rejected_count": 0,
        "event_ns_min": 1,
        "event_ns_max": 1,
        "logical_sha256": "l" * 64,
        "parts": [{"name": "part-00000.parquet"}],
    }


def _snapshot(tmp_path, name, records):
    path = tmp_path / name
    builder = catalog.CatalogBuilder(path)
    versions = {record[0] for record in records}
    for version in versions:
        builder.record_dataset_version(version)
    for version, family, date, manifest_sha in records:
        builder.record_partition(
            _manifest(version, family, date),
            f"databento/instrument/{family}/{version}/{date}", manifest_sha,
            published_to_s3=True,
        )
    for version in versions:
        builder.mark_published(version)
    builder.close()
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute(
            "UPDATE dataset_versions SET created_at='2026-09-16T00:00:00+00:00', status='PUBLISHED'"
        )
        connection.execute("UPDATE partitions SET created_at='2026-09-16T00:00:00+00:00'")
    return path


def _partitions(path):
    with closing(sqlite3.connect(path)) as connection, connection:
        return connection.execute(
            "SELECT family, dataset_version, date, manifest_sha256 FROM partitions ORDER BY family"
        ).fetchall()


def _reconcile(parent, additions, output):
    return reconcile.reconcile(
        parent, additions, output, "w614_catalog_reconcile_v1",
        parent_sha256=catalog._sha256_file(parent),
        addition_sha256=catalog._sha256_file(additions),
    )


def test_reconcile_retains_parent_and_adds_each_new_rung(tmp_path):
    parent = _snapshot(tmp_path, "parent.sqlite", [("l1", "candle", "2025-09-01", "a" * 64)])
    additions = _snapshot(tmp_path, "ladder.sqlite", [
        ("ladder", "candle_1m", "2025-09-01", "b" * 64),
        ("ladder", "candle_1h", "2025-09-01", "c" * 64),
        ("ladder", "candle_1d", "2025-09-01", "d" * 64),
    ])

    result = _reconcile(parent, additions, tmp_path / "candidate.sqlite")

    assert result["parent_partitions"] == 1
    assert result["addition_partitions"] == 3
    assert result["candidate_partitions"] == 4
    assert _partitions(tmp_path / "candidate.sqlite") == [
        ("candle", "l1", "2025-09-01", "a" * 64),
        ("candle_1d", "ladder", "2025-09-01", "d" * 64),
        ("candle_1h", "ladder", "2025-09-01", "c" * 64),
        ("candle_1m", "ladder", "2025-09-01", "b" * 64),
    ]


def test_reconcile_accepts_only_publication_bookkeeping_drift_for_shared_history(tmp_path):
    record = [("candles", "candle_1m", "2025-09-01", "a" * 64)]
    parent = _snapshot(tmp_path, "parent.sqlite", record)
    additions = _snapshot(tmp_path, "addition.sqlite", record)
    with closing(sqlite3.connect(additions)) as connection, connection:
        connection.execute("UPDATE dataset_versions SET status='SUPERSEDED'")
        connection.execute("UPDATE partitions SET published_to_s3=0")

    result = _reconcile(parent, additions, tmp_path / "candidate.sqlite")

    assert result["candidate_partitions"] == 1
    with closing(sqlite3.connect(tmp_path / "candidate.sqlite")) as connection, connection:
        assert connection.execute(
            "SELECT status FROM dataset_versions WHERE dataset_version='candles'"
        ).fetchone() == ("SUPERSEDED",)
        assert connection.execute(
            "SELECT published_to_s3 FROM partitions WHERE dataset_version='candles'"
        ).fetchone() == (1,)


def test_reconcile_rejects_changed_dataset_metadata_even_when_status_advanced(tmp_path):
    record = [("candles", "candle_1m", "2025-09-01", "a" * 64)]
    parent = _snapshot(tmp_path, "parent.sqlite", record)
    additions = _snapshot(tmp_path, "addition.sqlite", record)
    with closing(sqlite3.connect(additions)) as connection, connection:
        connection.execute(
            "UPDATE dataset_versions SET status='SUPERSEDED', converter_version='conversion/other'"
        )

    with pytest.raises(reconcile.CatalogReconciliationError, match="CONFLICTING_DATASET_VERSION"):
        _reconcile(parent, additions, tmp_path / "candidate.sqlite")
    assert not (tmp_path / "candidate.sqlite").exists()


def test_reconcile_refuses_two_authorities_for_one_instrument_family_date(tmp_path):
    parent = _snapshot(tmp_path, "parent.sqlite", [("one", "candle", "2025-09-01", "a" * 64)])
    additions = _snapshot(tmp_path, "addition.sqlite", [("two", "candle", "2025-09-01", "b" * 64)])

    with pytest.raises(reconcile.CatalogReconciliationError, match="CONFLICTING_PARTITION_AUTHORITY"):
        _reconcile(parent, additions, tmp_path / "candidate.sqlite")

    assert not (tmp_path / "candidate.sqlite").exists()


def _allowlist(*dates):
    return {"reason": "FA-18 corrected depth", "approved_by": "owner",
            "authorities": [['["GLBX","FUTURE","ESH6"]', "candle", date] for date in dates]}


def test_reconcile_replaces_an_approved_served_day_with_the_corrected_addition_and_reports_exactly_it(tmp_path):
    parent = _snapshot(tmp_path, "parent.sqlite", [
        ("old", "candle", "2025-09-01", "a" * 64),
        ("old", "candle", "2025-09-02", "b" * 64),
    ])
    additions = _snapshot(tmp_path, "addition.sqlite", [
        ("new", "candle", "2025-09-01", "c" * 64),
        ("old", "candle", "2025-09-02", "b" * 64),
    ])

    result = reconcile.reconcile(
        parent, additions, tmp_path / "candidate.sqlite", "w614_catalog_reconcile_v1",
        parent_sha256=catalog._sha256_file(parent), addition_sha256=catalog._sha256_file(additions),
        supersede_allowlist=_allowlist("2025-09-01", "2025-09-02", "2025-09-03"),
    )

    assert sorted(_partitions(tmp_path / "candidate.sqlite"), key=lambda row: row[2]) == [
        ("candle", "new", "2025-09-01", "c" * 64),
        ("candle", "old", "2025-09-02", "b" * 64),
    ]
    assert result["candidate_partitions"] == 2
    assert result["supersedes"] == {"reason": "FA-18 corrected depth", "approved_by": "owner",
                                    "authorities": [['["GLBX","FUTURE","ESH6"]', "candle", "2025-09-01"]]}


def test_reconcile_still_refuses_a_conflict_the_allowlist_does_not_approve(tmp_path):
    parent = _snapshot(tmp_path, "parent.sqlite", [("old", "candle", "2025-09-01", "a" * 64)])
    additions = _snapshot(tmp_path, "addition.sqlite", [("new", "candle", "2025-09-01", "c" * 64)])

    with pytest.raises(reconcile.CatalogReconciliationError, match="CONFLICTING_PARTITION_AUTHORITY"):
        reconcile.reconcile(
            parent, additions, tmp_path / "candidate.sqlite", "w614_catalog_reconcile_v1",
            parent_sha256=catalog._sha256_file(parent), addition_sha256=catalog._sha256_file(additions),
            supersede_allowlist=_allowlist("2025-09-02"),
        )
    assert not (tmp_path / "candidate.sqlite").exists()

    with pytest.raises(reconcile.CatalogReconciliationError, match="SUPERSEDE_ALLOWLIST_INVALID"):
        reconcile.reconcile(
            parent, additions, tmp_path / "candidate.sqlite", "w614_catalog_reconcile_v1",
            parent_sha256=catalog._sha256_file(parent), addition_sha256=catalog._sha256_file(additions),
            supersede_allowlist={"reason": "why", "approved_by": "owner", "authorities": []},
        )


def test_reconcile_without_an_allowlist_reports_no_supersedence(tmp_path):
    parent = _snapshot(tmp_path, "parent.sqlite", [("l1", "candle", "2025-09-01", "a" * 64)])
    additions = _snapshot(tmp_path, "addition.sqlite", [("ladder", "candle_1m", "2025-09-01", "b" * 64)])
    assert _reconcile(parent, additions, tmp_path / "candidate.sqlite")["supersedes"] is None


def test_reconcile_refuses_changed_duplicate_primary_identity(tmp_path):
    parent = _snapshot(tmp_path, "parent.sqlite", [("one", "candle", "2025-09-01", "a" * 64)])
    additions = _snapshot(tmp_path, "addition.sqlite", [("one", "candle", "2025-09-01", "b" * 64)])

    with pytest.raises(reconcile.CatalogReconciliationError, match="CONFLICTING_PARTITION_IDENTITY"):
        _reconcile(parent, additions, tmp_path / "candidate.sqlite")


def test_reconcile_rejects_a_corrupt_input_snapshot(tmp_path):
    parent = _snapshot(tmp_path, "parent.sqlite", [("one", "candle", "2025-09-01", "a" * 64)])
    additions = _snapshot(tmp_path, "addition.sqlite", [("two", "candle_1m", "2025-09-01", "b" * 64)])
    additions.write_bytes(b"not sqlite")

    with pytest.raises(reconcile.CatalogReconciliationError, match="CATALOG_SNAPSHOT_CORRUPT"):
        _reconcile(parent, additions, tmp_path / "candidate.sqlite")


def test_reconcile_refuses_a_snapshot_when_its_expected_hash_does_not_match(tmp_path):
    parent = _snapshot(tmp_path, "parent.sqlite", [("one", "candle", "2025-09-01", "a" * 64)])
    additions = _snapshot(tmp_path, "addition.sqlite", [("two", "candle_1m", "2025-09-01", "b" * 64)])

    with pytest.raises(reconcile.CatalogReconciliationError, match="CATALOG_SNAPSHOT_HASH_MISMATCH"):
        reconcile.reconcile(
            parent, additions, tmp_path / "candidate.sqlite", "w614_catalog_reconcile_v1",
            parent_sha256="0" * 64, addition_sha256=catalog._sha256_file(additions),
        )
