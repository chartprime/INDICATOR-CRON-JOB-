"""Seed catalog build + fencing-token immutable-snapshot publish."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

import pytest

import catalog


def _manifest(instrument_id="[\"XNAS\",\"EQUITY\",\"AAPL\",\"USD\",\"SHARE\",null]", family="quote",
              dataset_version="20260910T000000Z", date="2025-09-06", records=2):
    return {
        "instrument_id": instrument_id, "family": family, "dataset_version": dataset_version, "date": date,
        "record_count": records, "rejected_count": 0, "event_ns_min": 1, "event_ns_max": 9,
        "logical_sha256": "l" * 64, "parts": [{"name": "part-00000.parquet"}],
    }


def _build(tmp_path, dataset_version="20260910T000000Z"):
    db = tmp_path / f"catalog-{dataset_version}.local.sqlite"
    builder = catalog.CatalogBuilder(str(db))
    builder.record_dataset_version(dataset_version)
    builder.record_partition(_manifest(dataset_version=dataset_version), "curated/databento/x/quote/...", "m" * 64)
    builder.mark_published(dataset_version)
    builder.close()
    return str(db)


def test_builder_creates_the_seed_tables_and_records_a_partition(tmp_path):
    db = _build(tmp_path)
    con = sqlite3.connect(db)
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"dataset_versions", "partitions", "roll_intervals", "continuity"} <= tables
        assert con.execute("SELECT status FROM dataset_versions").fetchone()[0] == "PUBLISHED"
        assert con.execute("SELECT record_count, manifest_sha256, provider FROM partitions").fetchone() == (
            2, "m" * 64, "databento"
        )
    finally:
        con.close()


def test_builder_records_an_explicit_provider_for_new_partitions(tmp_path):
    db = tmp_path / "catalog.sqlite"
    builder = catalog.CatalogBuilder(str(db))
    builder.record_dataset_version("v1")
    builder.record_partition(_manifest(dataset_version="v1"), "binance/x/candle_1m/v1/2025-09-06",
                             "m" * 64, provider="binance")
    builder.mark_published("v1")
    builder.close()
    with sqlite3.connect(db) as con:
        assert con.execute("SELECT provider FROM partitions").fetchone() == ("binance",)


def test_publish_job_imports_a_providerless_parent_as_legacy_databento(tmp_path):
    root = tmp_path / "_catalog"
    root.mkdir()
    parent = root / "catalog-old.sqlite"
    with sqlite3.connect(parent) as con:
        con.executescript(catalog._DDL.replace("  provider TEXT NOT NULL DEFAULT 'databento',\n", ""))
        con.execute("INSERT INTO dataset_versions VALUES (?, ?, ?, ?, ?, ?)",
                    ("old", "now", "conversion/0.1", "market-observation/1", None, "PUBLISHED"))
        con.execute(
            "INSERT INTO partitions (instrument_id, family, dataset_version, date, s3_prefix, part_count, "
            "record_count, rejected_count, event_ns_min, event_ns_max, logical_sha256, manifest_sha256, "
            "created_at, published_to_s3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("iid", "trade", "old", "2025-09-01", "databento/iid/trade/old/2025-09-01", 1, 1, 0,
             1, 1, "l" * 64, "m" * 64, "now", 1),
        )
    pointer = {
        "catalog_key": parent.name, "catalog_sha256": catalog._sha256_file(parent),
        "dataset_version": "old", "publisher_fence": 1,
    }
    (root / "CURRENT.json").write_text(json.dumps(pointer), encoding="utf-8")

    catalog.publish_job(str(root), _build(tmp_path, "new"), "new", "job-new")
    with sqlite3.connect(root / "catalog-new.sqlite") as con:
        assert con.execute("SELECT provider FROM partitions WHERE dataset_version='old'").fetchone() == (
            "databento",
        )


def test_publish_writes_an_immutable_snapshot_and_a_fenced_pointer(tmp_path):
    root = tmp_path / "_catalog"
    db = _build(tmp_path, "v1")
    pointer = catalog.publish(str(root), db, "v1")

    assert pointer["catalog_key"] == "catalog-v1.sqlite"
    assert pointer["publisher_fence"] == 1
    snap = root / "catalog-v1.sqlite"
    assert snap.is_file()
    assert catalog._sha256_file(str(snap)) == pointer["catalog_sha256"]
    # the snapshot is a real, queryable catalog
    con = sqlite3.connect(str(snap))
    try:
        assert con.execute("SELECT count(*) FROM partitions").fetchone()[0] == 1
    finally:
        con.close()
    assert json.loads((root / "CURRENT.json").read_text())["publisher_fence"] == 1
    assert not (root / ".publish-lock.json").exists()


def test_second_publish_supersedes_and_increments_the_fence(tmp_path):
    root = tmp_path / "_catalog"
    catalog.publish(str(root), _build(tmp_path, "v1"), "v1")
    pointer2 = catalog.publish(str(root), _build(tmp_path, "v2"), "v2")
    assert pointer2["publisher_fence"] == 2
    assert catalog.read_current(str(root))["dataset_version"] == "v2"


def test_publish_job_calls_the_hook_with_the_payload_and_parent_before_committing_local_current(tmp_path):
    root = tmp_path / "_catalog"
    db = _build(tmp_path, "v1")
    seen = []

    def hook(payload, parent):
        seen.append((payload, parent))
        assert not (root / "CURRENT.json").exists()
        assert not (root / "receipt-v1.json").exists()
        assert (root / payload["catalog_key"]).is_file()

    pointer = catalog.publish_job(str(root), db, "v1", "job-1", on_ready_to_publish=hook)

    assert len(seen) == 1
    assert seen[0] == (pointer, None)
    assert (root / "CURRENT.json").exists()
    assert (root / "receipt-v1.json").exists()


def test_publish_job_second_call_after_receipt_exists_does_not_recall_the_hook(tmp_path):
    root = tmp_path / "_catalog"
    db = _build(tmp_path, "v1")
    calls = {"n": 0}

    def hook(payload, parent):
        calls["n"] += 1

    catalog.publish_job(str(root), db, "v1", "job-1", on_ready_to_publish=hook)
    catalog.publish_job(str(root), db, "v1", "job-1", on_ready_to_publish=hook)
    assert calls["n"] == 1


def test_publish_job_aborts_before_local_commit_if_the_hook_raises(tmp_path):
    root = tmp_path / "_catalog"
    db = _build(tmp_path, "v1")

    def failing_hook(payload, parent):
        raise RuntimeError("simulated remote publish failure")

    with pytest.raises(RuntimeError, match="simulated remote publish failure"):
        catalog.publish_job(str(root), db, "v1", "job-1", on_ready_to_publish=failing_hook)

    assert not (root / "CURRENT.json").exists()
    assert not (root / "receipt-v1.json").exists()
    assert (root / "intent-v1.json").exists()  # durable enough to retry without redoing the snapshot build


def test_publish_job_retried_after_a_failed_hook_succeeds_without_rebuilding_the_snapshot(tmp_path):
    root = tmp_path / "_catalog"
    db = _build(tmp_path, "v1")
    attempts = {"n": 0}

    def flaky_hook(payload, parent):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("first attempt fails")

    with pytest.raises(RuntimeError, match="first attempt fails"):
        catalog.publish_job(str(root), db, "v1", "job-1", on_ready_to_publish=flaky_hook)
    pointer = catalog.publish_job(str(root), db, "v1", "job-1", on_ready_to_publish=flaky_hook)

    assert attempts["n"] == 2
    assert catalog.read_current(str(root)) == pointer


def test_publish_job_second_dataset_version_sees_the_first_as_its_parent_in_the_hook(tmp_path):
    root = tmp_path / "_catalog"
    seen_parents = []

    def hook(payload, parent):
        seen_parents.append(parent)

    pointer1 = catalog.publish_job(str(root), _build(tmp_path, "v1"), "v1", "job-1", on_ready_to_publish=hook)
    catalog.publish_job(str(root), _build(tmp_path, "v2"), "v2", "job-2", on_ready_to_publish=hook)

    assert seen_parents == [None, pointer1]


def test_a_live_lock_blocks_a_second_publisher(tmp_path):
    root = tmp_path / "_catalog"
    held = catalog.PublisherLock(str(root), holder="worker-A", lease_s=60)
    held.acquire()
    try:
        with pytest.raises(catalog.CatalogError, match="PUBLISH_LOCK_HELD_BY"):
            catalog.publish(str(root), _build(tmp_path, "v1"), "v1", holder="worker-B", lease_s=0.1)
    finally:
        held.release()


def test_a_live_lock_is_waited_out_not_failed_immediately(tmp_path):
    root = tmp_path / "_catalog"
    held = catalog.PublisherLock(str(root), holder="worker-A", lease_s=60)
    held.acquire()

    def release_shortly():
        time.sleep(0.2)
        held.release()
    threading.Thread(target=release_shortly).start()

    pointer = catalog.publish(str(root), _build(tmp_path, "v1"), "v1", holder="worker-B")
    assert pointer["dataset_version"] == "v1"


def test_a_stale_lock_is_taken_over_and_the_fence_still_advances(tmp_path):
    root = tmp_path / "_catalog"
    os.makedirs(root)
    (root / "CURRENT.json").write_text(json.dumps({"publisher_fence": 4, "dataset_version": "old"}))
    (root / ".publish-lock.json").write_text(json.dumps(
        {"holder": "ghost", "host": "elsewhere", "pid": 1, "fence": 4, "lease_until": time.time() - 10}
    ))
    pointer = catalog.publish(str(root), _build(tmp_path, "v5"), "v5", holder="worker-C")
    assert pointer["publisher_fence"] == 5
    assert catalog.read_current(str(root))["dataset_version"] == "v5"


def test_republishing_the_same_dataset_version_is_refused(tmp_path):
    root = tmp_path / "_catalog"
    catalog.publish(str(root), _build(tmp_path, "v1"), "v1")
    with pytest.raises(catalog.CatalogError, match="SNAPSHOT_ALREADY_PUBLISHED"):
        catalog.publish(str(root), _build(tmp_path, "v1b"), "v1")


def test_same_holder_cannot_steal_live_lock_even_after_lease_expiry(tmp_path):
    root = tmp_path / "catalog"
    with catalog.PublisherLock(root, "conversion", lease_s=0.01):
        time.sleep(0.02)
        with pytest.raises(catalog.CatalogError, match="PUBLISH_LOCK_HELD_BY"):
            with catalog.PublisherLock(root, "conversion", lease_s=0.1):
                pytest.fail("second writer entered")


def test_path_traversal_version_is_rejected(tmp_path):
    with pytest.raises(Exception, match="INVALID_DATASET_VERSION"):
        catalog.publish(tmp_path / "catalog", _build(tmp_path, "safe"), "../escape")
