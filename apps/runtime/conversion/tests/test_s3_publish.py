import hashlib
import io
import json
import sqlite3

import pytest

import catalog
import s3_publish as pub


class S3Error(Exception):
    def __init__(self, status):
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}}


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.before_put = None

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise S3Error(404)
        data = self.objects[Key]
        return {"Body": io.BytesIO(data), "ETag": hashlib.sha256(data).hexdigest()}

    def put_object(self, **args):
        key = args["Key"]
        if self.before_put:
            self.before_put(key)
        old = self.objects.get(key)
        if args.get("IfNoneMatch") == "*" and old is not None:
            raise S3Error(412)
        if "IfMatch" in args and (old is None or hashlib.sha256(old).hexdigest() != args["IfMatch"]):
            raise S3Error(412)
        body = args["Body"]
        data = body.read() if hasattr(body, "read") else body
        assert len(data) == args["ContentLength"]
        self.objects[key] = data


@pytest.fixture
def setup(tmp_path, monkeypatch):
    data = tmp_path / "part"
    data.write_bytes(b"verified part")
    monkeypatch.setattr(pub, "bundle", lambda *a: {"data/part": (data, pub._sha256_file(data))})
    client = FakeS3()
    return pub.Store(client, "bucket", "curated/qualification"), {"dataset_version": "one"}, tmp_path


def test_publish_and_old_retry_never_roll_current_back(setup):
    store, pointer, root = setup
    assert pub.publish(store, root, pointer, expected_parent=None)["status"] == "PUBLISHED"
    newer = {"dataset_version": "two"}
    pub.publish(store, root, newer, expected_parent=pointer)
    assert pub.publish(store, root, pointer, expected_parent=None)["status"] == "ALREADY_PUBLISHED"
    assert store.get_json("_catalog/CURRENT.json")[0] == newer


def test_crash_before_pointer_leaves_no_visible_dataset_and_retry_recovers(setup):
    store, pointer, root = setup
    def fail(key):
        if key.endswith("CURRENT.json"):
            raise TimeoutError()
    store.client.before_put = fail
    with pytest.raises(TimeoutError):
        pub.publish(store, root, pointer, expected_parent=None)
    assert store.get_json("_catalog/CURRENT.json")[0] is None
    store.client.before_put = None
    assert pub.publish(store, root, pointer, expected_parent=None)["status"] == "PUBLISHED"


def _write_partition(root, prefix, part_bytes=b"fake parquet bytes"):
    dest = root / prefix
    dest.mkdir(parents=True)
    part_path = dest / "part-00000.parquet"
    part_path.write_bytes(part_bytes)
    manifest = {
        "parts": [{"name": "part-00000.parquet", "bytes": len(part_bytes), "sha256": pub._sha256_file(part_path)}],
        "validation": {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True},
    }
    manifest_path = dest / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return pub._sha256_file(manifest_path)


def _write_versioned_partition(root, prefix):
    dest = root / prefix
    dest.mkdir(parents=True)
    part_path = dest / "part-00000.parquet"
    part_path.write_bytes(b"fake parquet bytes")
    manifest = {
        "schema_version": "market-observation/1", "converter_version": "conversion/0.2",
        "contract_version": "market-observation/1", "roll_table_version": None,
        "instrument_id": "instrument", "family": "quote", "dataset_version": "v1", "date": "2025-09-02",
        "created_at": "2026-09-12T00:00:00+00:00",
        "source_objects": [{"s3_key": "raw/source", "sha256": "a" * 64}],
        "record_count": 1, "rejected_count": 0, "rejected_summary": {},
        "event_ns_min": 100, "event_ns_max": 100, "logical_sha256": "new-logical",
        "logical_sha256_format": "json-insertion-v2", "sort_key": ["event_ns"],
        "parts": [{"name": "part-00000.parquet", "bytes": part_path.stat().st_size,
                   "sha256": pub._sha256_file(part_path), "row_count": 1,
                   "event_ns_min": 100, "event_ns_max": 100}],
        "validation": {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True},
        "stage_timings_s": {"write": 1},
    }
    manifest_path = dest / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return manifest, pub._sha256_file(manifest_path)


def _catalog_snapshot(root, name, rows):
    path = root / "_catalog" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.executescript(catalog._DDL)
        for version in {row[2] for row in rows}:
            connection.execute(
                "INSERT INTO dataset_versions VALUES (?, ?, ?, ?, ?, 'PUBLISHED')",
                (version, "2026-09-16T00:00:00+00:00", "conversion/0.2", "market-observation/1", None),
            )
        for row in rows:
            instrument, family, version, date, manifest, *prefix = row
            connection.execute(
                "INSERT INTO partitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (instrument, family, version, date, "databento",
                 prefix[0] if prefix else f"databento/{instrument}/{family}/{version}/{date}", 1, 1, 0, 1, 1,
                 "l" * 64, manifest, "2026-09-16T00:00:00+00:00", 1),
            )
    return path


def _pointer(path, version):
    return {
        "dataset_version": version,
        "catalog_key": path.name,
        "catalog_sha256": pub._sha256_file(path),
    }


def _remote_parent(store, pointer, path):
    store.client.objects[store.key("_catalog/" + path.name)] = path.read_bytes()
    store.client.objects[store.key("_catalog/CURRENT.json")] = pub._json(pointer)


def _bundle_stub(tmp_path, monkeypatch):
    artifact = tmp_path / "part"
    artifact.write_bytes(b"verified part")
    monkeypatch.setattr(pub, "bundle", lambda *args: {"data/part": (artifact, pub._sha256_file(artifact))})


def _catalog_only_setup(tmp_path):
    catalog_root, data_root = tmp_path / "catalog", tmp_path / "data"
    prefix = "databento/instrument/quote/v1/2025-09-02"
    _manifest, manifest_sha = _write_versioned_partition(data_root, prefix)
    snapshot = _catalog_snapshot(
        catalog_root, "history.sqlite",
        [("instrument", "quote", "v1", "2025-09-02", manifest_sha, prefix)],
    )
    pointer = _pointer(snapshot, "v1")
    client = FakeS3()
    data_store = pub.Store(client, "bucket", "curated/databento")
    for path in (data_root / prefix).iterdir():
        client.objects[data_store.key(prefix + "/" + path.name)] = path.read_bytes()
    control_store = pub.Store(client, "bucket", "curated/databento/_historical")
    return catalog_root, snapshot, pointer, data_store, control_store


def test_bundle_verifies_every_published_partition_through_the_bounded_pool(tmp_path):
    """A cumulative catalog re-verifies every partition it already published on
    every publication: one S3 round trip each. Serially that reached 45 minutes
    per month at 4,494 partitions -- twenty times the cost of the month's own
    conversion -- so the verification runs on the same bounded pool
    `verify_remote_partitions` uses, and still covers every partition."""
    import threading
    catalog_root, data_root = tmp_path / "catalog", tmp_path / "data"
    rows, shas = [], {}
    for index in range(12):
        prefix = f"databento/instrument{index}/quote/v1/2025-09-02"
        _manifest, manifest_sha = _write_versioned_partition(data_root, prefix)
        shas[prefix] = manifest_sha
        rows.append((f"instrument{index}", "quote", "v1", "2025-09-02", manifest_sha, prefix))
    snapshot = _catalog_snapshot(catalog_root, "history.sqlite", rows)
    pointer = _pointer(snapshot, "v1")

    live = 0
    peak = 0
    guard = threading.Lock()

    class Counting(FakeS3):
        def get_object(self, **kw):
            nonlocal live, peak
            with guard:
                live += 1
                peak = max(peak, live)
            try:
                import time
                time.sleep(0.02)
                return super().get_object(**kw)
            finally:
                with guard:
                    live -= 1

    client = Counting()
    store = pub.Store(client, "bucket", "curated/databento")
    for prefix in shas:
        for path in (data_root / prefix).iterdir():
            client.objects[store.key(prefix + "/" + path.name)] = path.read_bytes()

    artifacts = pub.bundle(catalog_root, pointer, store, verification_workers=4)

    verified = [key for key in client.reads if key.endswith("_manifest.json")] if hasattr(client, "reads") else None
    assert peak > 1, f"verification never overlapped (peak {peak})"
    assert peak <= 4
    assert store.read_bytes > 0
    assert set(artifacts) == {"_catalog/" + pointer["catalog_key"]}
    if verified is not None:
        assert len(verified) == len(shas)


def test_bundle_still_refuses_a_published_partition_whose_remote_bytes_changed(tmp_path):
    catalog_root, data_root = tmp_path / "catalog", tmp_path / "data"
    prefix = "databento/instrument/quote/v1/2025-09-02"
    _manifest, manifest_sha = _write_versioned_partition(data_root, prefix)
    snapshot = _catalog_snapshot(catalog_root, "history.sqlite",
                                 [("instrument", "quote", "v1", "2025-09-02", manifest_sha, prefix)])
    pointer = _pointer(snapshot, "v1")
    client = FakeS3()
    store = pub.Store(client, "bucket", "curated/databento")
    for path in (data_root / prefix).iterdir():
        client.objects[store.key(prefix + "/" + path.name)] = path.read_bytes()
    client.objects[store.key(prefix + "/_manifest.json")] = b'{"tampered": true}'

    with pytest.raises(pub.PublicationError):
        pub.bundle(catalog_root, pointer, store)


def _unpublished_parent_setup(tmp_path):
    """A2 run 1 (2026-09-28): the Binance converter namespace's parent catalog was
    published with its partitions still flagged published_to_s3=0 (the flag is
    stored as it stood before that upload), and a converter seeded from it holds
    none of those partitions locally. Every inherited row reached _local() and the
    whole month's publication was refused with INVALID_LOCAL_ARTIFACT."""
    catalog_root, data_root = tmp_path / "catalog", tmp_path / "data"
    prefix = "binance/instrument/candle_1m/v1/2025-09-02"
    _manifest, manifest_sha = _write_versioned_partition(data_root, prefix)
    snapshot = _catalog_snapshot(catalog_root, "history.sqlite",
                                 [("instrument", "candle_1m", "v1", "2025-09-02", manifest_sha, prefix)])
    with sqlite3.connect(snapshot) as connection:
        connection.execute("UPDATE partitions SET published_to_s3=0")
    client = FakeS3()
    store = pub.Store(client, "bucket", "curated/binance")
    for path in (data_root / prefix).iterdir():
        client.objects[store.key(prefix + "/" + path.name)] = path.read_bytes()
    return catalog_root, _pointer(snapshot, "v1"), store, prefix


def test_bundle_verifies_remotely_an_unpublished_flagged_partition_that_is_not_held_locally(tmp_path):
    catalog_root, pointer, store, prefix = _unpublished_parent_setup(tmp_path)

    artifacts = pub.bundle(catalog_root, pointer, store)

    assert set(artifacts) == {"_catalog/" + pointer["catalog_key"]}
    assert store.read_bytes > 0


def test_bundle_refuses_an_unpublished_flagged_partition_held_neither_locally_nor_remotely(tmp_path):
    catalog_root, pointer, store, prefix = _unpublished_parent_setup(tmp_path)
    store.client.objects.pop(store.key(prefix + "/_manifest.json"))

    with pytest.raises(pub.PublicationError, match="REMOTE_MANIFEST_UNAVAILABLE"):
        pub.bundle(catalog_root, pointer, store)


def test_bundle_refuses_an_unpublished_flagged_partition_with_changed_remote_parts(tmp_path):
    catalog_root, pointer, store, prefix = _unpublished_parent_setup(tmp_path)
    store.client.objects[store.key(prefix + "/part-00000.parquet")] = b"different bytes"

    with pytest.raises(pub.PublicationError, match="REMOTE_ARTIFACT_MISMATCH"):
        pub.bundle(catalog_root, pointer, store)


def test_bundle_without_a_store_refuses_an_unpublished_flagged_partition_not_held_locally(tmp_path):
    catalog_root, pointer, _store, _prefix = _unpublished_parent_setup(tmp_path)

    with pytest.raises(pub.PublicationError, match="REMOTE_VERIFICATION_REQUIRED"):
        pub.bundle(catalog_root, pointer)


def test_publish_appends_a_month_to_a_seeded_parent_whose_partitions_are_flagged_unpublished(tmp_path):
    catalog_root, parent_pointer, store, parent_prefix = _unpublished_parent_setup(tmp_path)
    parent_path = catalog_root / "_catalog" / parent_pointer["catalog_key"]
    data_root = tmp_path / "data"
    new_prefix = "binance/instrument/trade/v2/2025-09-02"
    _manifest, new_sha = _write_versioned_partition(data_root, new_prefix)
    for path in (data_root / new_prefix).iterdir():
        store.client.objects[store.key(new_prefix + "/" + path.name)] = path.read_bytes()
    candidate = _catalog_snapshot(catalog_root, "candidate.sqlite", [
        ("instrument", "trade", "v2", "2025-09-02", new_sha, new_prefix),
    ])
    with sqlite3.connect(parent_path) as source, sqlite3.connect(candidate) as target:
        inherited = source.execute("SELECT * FROM partitions").fetchone()
        assert inherited[-1] == 0
        target.execute("INSERT INTO partitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", inherited)
        target.execute("INSERT INTO dataset_versions VALUES ('v1', '2026-09-16T00:00:00+00:00', 'conversion/0.2', "
                       "'market-observation/1', NULL, 'SUPERSEDED')")
    _remote_parent(store, parent_pointer, parent_path)
    pointer = _pointer(candidate, "v2")

    result = pub.publish(store, catalog_root, pointer, expected_parent=parent_pointer)

    assert result["status"] == "PUBLISHED"
    assert store.get_json("_catalog/CURRENT.json")[0] == pointer


def test_bundle_still_refuses_a_symlinked_local_manifest(tmp_path):
    catalog_root, pointer, store, prefix = _unpublished_parent_setup(tmp_path)
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text("{}", encoding="utf-8")
    link = catalog_root / prefix / "_manifest.json"
    link.parent.mkdir(parents=True)
    try:
        link.symlink_to(elsewhere)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this platform")

    with pytest.raises(pub.PublicationError, match="INVALID_LOCAL_ARTIFACT"):
        pub.bundle(catalog_root, pointer, store)


def test_catalog_only_publication_verifies_existing_data_without_recopying_it(tmp_path):
    root, _snapshot, pointer, data_store, control_store = _catalog_only_setup(tmp_path)
    before = dict(data_store.client.objects)

    result = pub.publish_catalog_only(control_store, data_store, root, pointer, expected_parent=None)

    assert result["status"] == "PUBLISHED"
    assert data_store.client.objects.keys() >= before.keys()
    assert {key: data_store.client.objects[key] for key in before} == before
    assert data_store.write_bytes == 0
    assert control_store.get_json("_catalog/CURRENT.json")[0] == pointer
    assert control_store.key("_catalog/" + pointer["catalog_key"]) in control_store.client.objects


def test_catalog_only_verification_never_writes_an_object(tmp_path):
    root, _snapshot, pointer, data_store, control_store = _catalog_only_setup(tmp_path)
    before = dict(data_store.client.objects)

    result = pub.verify_catalog_only(data_store, root, pointer, workers=2)

    assert result["partition_count"] == 1
    assert result["verification_workers"] == 2
    assert result["verified_read_bytes"] > 0
    assert data_store.client.objects == before
    assert not any(key.startswith(control_store.prefix + "/") for key in data_store.client.objects)


def test_catalog_only_verification_refuses_an_unbounded_worker_count(tmp_path):
    root, _snapshot, pointer, data_store, _control_store = _catalog_only_setup(tmp_path)

    with pytest.raises(pub.PublicationError, match="INVALID_VERIFICATION_WORKERS"):
        pub.verify_catalog_only(data_store, root, pointer, workers=17)


def test_catalog_only_publication_refuses_before_control_writes_when_data_cannot_be_verified(tmp_path):
    root, _snapshot, pointer, data_store, control_store = _catalog_only_setup(tmp_path)
    data_store.client.objects.pop(data_store.key("databento/instrument/quote/v1/2025-09-02/_manifest.json"))
    before = dict(data_store.client.objects)

    with pytest.raises(pub.PublicationError, match="REMOTE_MANIFEST"):
        pub.publish_catalog_only(control_store, data_store, root, pointer, expected_parent=None)

    assert data_store.client.objects == before
    assert not any(key.startswith(control_store.prefix + "/") for key in data_store.client.objects)


def test_catalog_only_publication_refuses_a_local_partition_not_marked_remote(tmp_path):
    root, snapshot, _pointer_value, data_store, control_store = _catalog_only_setup(tmp_path)
    with sqlite3.connect(snapshot) as connection:
        connection.execute("UPDATE partitions SET published_to_s3=0")
    pointer = _pointer(snapshot, "v1")

    with pytest.raises(pub.PublicationError, match="CATALOG_CONTAINS_UNPUBLISHED_PARTITION"):
        pub.publish_catalog_only(control_store, data_store, root, pointer, expected_parent=None)

    assert not any(key.startswith(control_store.prefix + "/") for key in control_store.client.objects)


def test_publish_rejects_a_candidate_that_drops_parent_authority(tmp_path, monkeypatch):
    root = tmp_path / "curated"
    parent_path = _catalog_snapshot(root, "parent.sqlite", [("instrument", "candle", "one", "2025-09-01", "a" * 64)])
    candidate_path = _catalog_snapshot(root, "candidate.sqlite", [("instrument", "candle_1m", "two", "2025-09-01", "b" * 64)])
    parent, candidate = _pointer(parent_path, "one"), _pointer(candidate_path, "two")
    store = pub.Store(FakeS3(), "bucket", "curated/qualification")
    _remote_parent(store, parent, parent_path)
    _bundle_stub(tmp_path, monkeypatch)

    with pytest.raises(pub.PublicationError, match="PARENT_PARTITION_DROPPED"):
        pub.publish(store, root, candidate, expected_parent=parent)

    assert store.get_json("_catalog/CURRENT.json")[0] == parent
    assert not any("/intents/" in key for key in store.client.objects)


def test_publish_rejects_a_candidate_that_replaces_parent_authority(tmp_path, monkeypatch):
    root = tmp_path / "curated"
    parent_path = _catalog_snapshot(root, "parent.sqlite", [("instrument", "candle", "one", "2025-09-01", "a" * 64)])
    candidate_path = _catalog_snapshot(root, "candidate.sqlite", [("instrument", "candle", "two", "2025-09-01", "b" * 64)])
    parent, candidate = _pointer(parent_path, "one"), _pointer(candidate_path, "two")
    store = pub.Store(FakeS3(), "bucket", "curated/qualification")
    _remote_parent(store, parent, parent_path)
    _bundle_stub(tmp_path, monkeypatch)

    with pytest.raises(pub.PublicationError, match="PARENT_PARTITION_REPLACED"):
        pub.publish(store, root, candidate, expected_parent=parent)

    assert store.get_json("_catalog/CURRENT.json")[0] == parent


def test_publish_accepts_an_append_only_candidate_with_its_parent_intact(tmp_path, monkeypatch):
    root = tmp_path / "curated"
    parent_row = ("instrument", "candle", "one", "2025-09-01", "a" * 64)
    parent_path = _catalog_snapshot(root, "parent.sqlite", [parent_row])
    candidate_path = _catalog_snapshot(root, "candidate.sqlite", [
        parent_row,
        ("instrument", "candle_1m", "two", "2025-09-01", "b" * 64),
    ])
    parent, candidate = _pointer(parent_path, "one"), _pointer(candidate_path, "two")
    store = pub.Store(FakeS3(), "bucket", "curated/qualification")
    _remote_parent(store, parent, parent_path)
    _bundle_stub(tmp_path, monkeypatch)

    assert pub.publish(store, root, candidate, expected_parent=parent)["status"] == "PUBLISHED"
    assert store.get_json("_catalog/CURRENT.json")[0] == candidate


def test_publish_partition_uploads_manifest_and_parts_without_touching_current(tmp_path):
    root = tmp_path / "curated"
    prefix = "databento/AAPL-abcd1234/candle/v1/2025-09-02"
    manifest_sha = _write_partition(root, prefix)
    store = pub.Store(FakeS3(), "bucket", "curated/qualification")

    pub.publish_partition(store, root, prefix, manifest_sha)

    assert store.get_json(prefix + "/_manifest.json")[0]["validation"]["round_trip_ok"] is True
    assert store.get_json("_catalog/CURRENT.json")[0] is None  # untouched by a per-partition push


def test_publish_partition_adopts_only_a_proven_pre_format_remote_manifest(tmp_path):
    root = tmp_path / "curated"
    prefix = "databento/AAPL-abcd1234/quote/v1/2025-09-02"
    candidate, candidate_sha = _write_versioned_partition(root, prefix)
    client = FakeS3()
    store = pub.Store(client, "bucket", "curated/qualification")
    remote = dict(candidate, converter_version="conversion/0.1", logical_sha256="old-sorted-logical")
    del remote["logical_sha256_format"]
    remote_bytes = json.dumps(remote, separators=(",", ":")).encode()
    client.objects[store.key(prefix + "/_manifest.json")] = remote_bytes
    client.objects[store.key(prefix + "/part-00000.parquet")] = (root / prefix / "part-00000.parquet").read_bytes()

    result = pub.publish_partition(
        store, root, prefix, candidate_sha, legacy_logical_sha256="old-sorted-logical",
    )

    assert result["status"] == "ALREADY_PUBLISHED_LEGACY"
    assert result["manifest_sha256"] == hashlib.sha256(remote_bytes).hexdigest()
    assert client.objects[store.key(prefix + "/_manifest.json")] == remote_bytes


def test_publish_partition_rejects_a_semantically_different_existing_manifest_before_writing(tmp_path):
    root = tmp_path / "curated"
    prefix = "databento/AAPL-abcd1234/quote/v1/2025-09-02"
    candidate, candidate_sha = _write_versioned_partition(root, prefix)
    client = FakeS3()
    store = pub.Store(client, "bucket", "curated/qualification")
    remote = dict(candidate, converter_version="conversion/0.1", logical_sha256="old-sorted-logical",
                  source_objects=[{"s3_key": "raw/different", "sha256": "b" * 64}])
    del remote["logical_sha256_format"]
    client.objects[store.key(prefix + "/_manifest.json")] = json.dumps(remote).encode()
    client.objects[store.key(prefix + "/part-00000.parquet")] = b"old remote part"
    before = dict(client.objects)

    with pytest.raises(pub.PublicationError, match="REMOTE_PARTITION_CONFLICT"):
        pub.publish_partition(store, root, prefix, candidate_sha, legacy_logical_sha256="old-sorted-logical")
    assert client.objects == before


def test_publish_partition_refuses_a_non_utf8_remote_manifest_before_writing(tmp_path):
    root = tmp_path / "curated"
    prefix = "databento/AAPL-abcd1234/quote/v1/2025-09-02"
    _candidate, candidate_sha = _write_versioned_partition(root, prefix)
    client = FakeS3()
    store = pub.Store(client, "bucket", "curated/qualification")
    client.objects[store.key(prefix + "/_manifest.json")] = b"\xff"
    before = dict(client.objects)

    with pytest.raises(pub.PublicationError, match="REMOTE_MANIFEST_INVALID_JSON"):
        pub.publish_partition(store, root, prefix, candidate_sha)
    assert client.objects == before


def test_publish_partition_rejects_a_locally_corrupted_manifest(tmp_path):
    root = tmp_path / "curated"
    prefix = "databento/AAPL-abcd1234/candle/v1/2025-09-02"
    manifest_sha = _write_partition(root, prefix)
    (root / prefix / "_manifest.json").write_text("{}", encoding="utf-8")  # corrupted after hashing
    store = pub.Store(FakeS3(), "bucket", "curated/qualification")

    with pytest.raises(pub.PublicationError, match="MANIFEST_INTEGRITY_FAILURE"):
        pub.publish_partition(store, root, prefix, manifest_sha)


def test_publish_partition_rejects_an_unvalidated_partition(tmp_path):
    root = tmp_path / "curated"
    prefix = "databento/AAPL-abcd1234/candle/v1/2025-09-02"
    dest = root / prefix
    dest.mkdir(parents=True)
    part_path = dest / "part-00000.parquet"
    part_path.write_bytes(b"fake parquet bytes")
    manifest = {
        "parts": [{"name": "part-00000.parquet", "bytes": part_path.stat().st_size, "sha256": pub._sha256_file(part_path)}],
        "validation": {"round_trip_ok": False, "id_unique": True, "sorted": True, "count_reconciled": True},
    }
    manifest_path = dest / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    store = pub.Store(FakeS3(), "bucket", "curated/qualification")

    with pytest.raises(pub.PublicationError, match="UNVALIDATED_PARTITION"):
        pub.publish_partition(store, root, prefix, pub._sha256_file(manifest_path))


def test_crash_after_pointer_before_receipt_recovers(setup):
    store, pointer, root = setup
    def fail(key):
        if "/receipts/" in key:
            raise TimeoutError()
    store.client.before_put = fail
    with pytest.raises(TimeoutError):
        pub.publish(store, root, pointer, expected_parent=None)
    assert store.get_json("_catalog/CURRENT.json")[0] == pointer
    store.client.before_put = None
    pub.publish(store, root, pointer, expected_parent=None)


def test_competing_pointer_cas_rejects_stale_publisher(setup):
    store, pointer, root = setup
    def race(key):
        if key.endswith("CURRENT.json"):
            store.client.objects[key] = b'{"dataset_version":"winner"}'
    store.client.before_put = race
    with pytest.raises(pub.PublicationError, match="PARENT_CHANGED"):
        pub.publish(store, root, pointer, expected_parent=None)
    assert store.get_json("_catalog/CURRENT.json")[0]["dataset_version"] == "winner"


def test_wrong_parent_rejected_before_upload(setup):
    store, pointer, root = setup
    with pytest.raises(pub.PublicationError, match="PARENT_CHANGED"):
        pub.publish(store, root, pointer, expected_parent={"dataset_version": "absent"})
    assert not store.client.objects


def test_immutable_collision_never_overwrites(setup):
    store, pointer, root = setup
    store.client.objects[store.key("data/part")] = b"wrong"
    with pytest.raises(pub.PublicationError, match="ARTIFACT_MISMATCH"):
        pub.publish(store, root, pointer, expected_parent=None)
    assert store.client.objects[store.key("data/part")] == b"wrong"
    assert store.get_json("_catalog/CURRENT.json")[0] is None


@pytest.mark.parametrize("prefix", ["raw/archive", "curated/../raw", "/curated/x", "curated\\x"])
def test_unsafe_namespaces_rejected(prefix):
    with pytest.raises(pub.PublicationError):
        pub.Store(FakeS3(), "bucket", prefix)


def test_forbidden_get_is_not_treated_as_missing():
    class Forbidden(FakeS3):
        def get_object(self, **kw):
            raise S3Error(403)
    with pytest.raises(S3Error):
        pub.Store(Forbidden(), "bucket", "curated/test").get_json("_catalog/CURRENT.json")


def test_missing_snapshot_fails_before_remote_access(tmp_path):
    with pytest.raises(pub.PublicationError, match="LOCAL_ARTIFACT"):
        pub.bundle(tmp_path, {"catalog_key": "missing.sqlite", "catalog_sha256": "x"})


def test_real_bundle_reconciles_and_rejects_corrupted_part(tmp_path):
    from pathlib import Path
    import job
    source = Path(__file__).resolve().parents[2] / "test/contracts/fixtures/market-observation-v1/databento-mbp1.dbn"
    root = tmp_path / "curated"
    result = job.run_job([{"local_path": str(source), "schema": "mbp-1", "s3_key":
                          "raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=ESH1/year=2020/month=12/day=28/x.dbn"}],
                         "s3-test", staging_root=str(tmp_path / "stage"), curated_root=str(root),
                         catalog_root=str(root / "_catalog"))
    pointer = result["catalog_pointer"]
    files = pub.bundle(root, pointer)
    assert any(k.endswith(".parquet") for k in files)
    store = pub.Store(FakeS3(), "bucket", "curated/qualification")
    assert pub.publish(store, root, pointer, expected_parent=None)["status"] == "PUBLISHED"
    part = next(path for key, (path, _) in files.items() if key.endswith(".parquet"))
    part.write_bytes(b"broken")
    with pytest.raises(pub.PublicationError, match="PART_INTEGRITY"):
        pub.bundle(root, pointer)


def _replacement_rig(tmp_path, monkeypatch):
    root = tmp_path / "curated"
    parent_path = _catalog_snapshot(root, "parent.sqlite", [("instrument", "candle", "one", "2025-09-01", "a" * 64)])
    candidate_path = _catalog_snapshot(root, "candidate.sqlite", [("instrument", "candle", "two", "2025-09-01", "b" * 64)])
    parent, candidate = _pointer(parent_path, "one"), _pointer(candidate_path, "two")
    store = pub.Store(FakeS3(), "bucket", "curated/qualification")
    _remote_parent(store, parent, parent_path)
    _bundle_stub(tmp_path, monkeypatch)
    return root, store, parent, candidate


def _supersedes(*authorities):
    return {"reason": "GE-14b regular-session re-derivation", "approved_by": "owner",
            "authorities": [list(authority) for authority in authorities]}


def test_report57_a_declared_supersedence_replaces_exactly_its_partition_and_records_why(tmp_path, monkeypatch):
    root, store, parent, candidate = _replacement_rig(tmp_path, monkeypatch)
    supersedes = _supersedes(("instrument", "candle", "2025-09-01"))

    result = pub.publish(store, root, candidate, expected_parent=parent, supersedes=supersedes)

    assert result["status"] == "PUBLISHED"
    assert store.get_json("_catalog/CURRENT.json")[0] == candidate
    identity = hashlib.sha256(pub._json(candidate)).hexdigest()
    assert store.get_json(f"_catalog/receipts/{identity}.json")[0] == {
        "pointer": candidate, "parent": parent, "supersedes": supersedes}


@pytest.mark.parametrize("supersedes, reason", [
    ({"reason": "", "approved_by": "owner", "authorities": [["instrument", "candle", "2025-09-01"]]}, "SUPERSEDENCE_INVALID"),
    ({"reason": "why", "approved_by": "owner", "authorities": []}, "SUPERSEDENCE_INVALID"),
    (None, "PARENT_PARTITION_REPLACED"),
])
def test_report57_a_replacement_without_a_valid_declaration_is_refused(tmp_path, monkeypatch, supersedes, reason):
    root, store, parent, candidate = _replacement_rig(tmp_path, monkeypatch)

    with pytest.raises(pub.PublicationError, match=reason):
        pub.publish(store, root, candidate, expected_parent=parent, supersedes=supersedes)

    assert store.get_json("_catalog/CURRENT.json")[0] == parent


def test_catalog_only_correction_replaces_a_served_day_only_with_a_declared_supersedence(tmp_path):
    root, parent_snapshot, parent, data_store, control_store = _catalog_only_setup(tmp_path)
    assert pub.publish_catalog_only(control_store, data_store, root, parent, expected_parent=None)["status"] == "PUBLISHED"
    corrected_prefix = "databento/instrument/quote/v2/2025-09-02"
    _manifest, corrected_sha = _write_versioned_partition(tmp_path / "data", corrected_prefix)
    for path in (tmp_path / "data" / corrected_prefix).iterdir():
        data_store.client.objects[data_store.key(corrected_prefix + "/" + path.name)] = path.read_bytes()
    candidate_snapshot = _catalog_snapshot(
        root, "corrected.sqlite", [("instrument", "quote", "v2", "2025-09-02", corrected_sha, corrected_prefix)])
    candidate = _pointer(candidate_snapshot, "v2")

    with pytest.raises(pub.PublicationError, match="PARENT_PARTITION_REPLACED"):
        pub.publish_catalog_only(control_store, data_store, root, candidate, expected_parent=parent)
    assert control_store.get_json("_catalog/CURRENT.json")[0] == parent

    supersedes = _supersedes(("instrument", "quote", "2025-09-02"))
    result = pub.publish_catalog_only(control_store, data_store, root, candidate, expected_parent=parent, supersedes=supersedes)

    assert result["status"] == "PUBLISHED"
    assert control_store.get_json("_catalog/CURRENT.json")[0] == candidate
    identity = hashlib.sha256(pub._json(candidate)).hexdigest()
    receipt = control_store.get_json(f"_catalog/receipts/{identity}.json")[0]
    assert receipt["supersedes"] == supersedes
    assert receipt["data_prefix"] == data_store.prefix
    with pytest.raises(pub.PublicationError, match="SUPERSEDENCE_INVALID"):
        pub.publish_catalog_only(control_store, data_store, root, candidate, expected_parent=parent,
                                 supersedes={"reason": "why", "approved_by": "owner", "authorities": []})


def test_report57_a_declared_authority_that_is_not_actually_replaced_is_refused(tmp_path, monkeypatch):
    root, store, parent, candidate = _replacement_rig(tmp_path, monkeypatch)
    supersedes = _supersedes(("instrument", "candle", "2025-09-01"), ("instrument", "candle", "2025-09-02"))

    with pytest.raises(pub.PublicationError, match="SUPERSEDENCE_UNUSED"):
        pub.publish(store, root, candidate, expected_parent=parent, supersedes=supersedes)

    assert store.get_json("_catalog/CURRENT.json")[0] == parent
