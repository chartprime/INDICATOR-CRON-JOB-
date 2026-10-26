import hashlib
import io
import json
import sqlite3

import pytest

import catalog
import catalog_attestation as attestation
import s3_publish


class S3Error(Exception):
    def __init__(self, status):
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}}


class FakeS3:
    def __init__(self):
        self.objects = {}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise S3Error(404)
        data = self.objects[Key]
        return {"Body": io.BytesIO(data), "ETag": hashlib.sha256(data).hexdigest()}


def _setup(tmp_path):
    root = tmp_path / "catalog"
    snapshot = root / "_catalog" / "source.sqlite"
    snapshot.parent.mkdir(parents=True)
    prefix, part = "binance/BTCUSDT/candle_1m/v1/2025-09-02", b"part"
    part_sha = hashlib.sha256(part).hexdigest()
    manifest = {
        "record_count": 1,
        "parts": [{"name": "part-00000.parquet", "bytes": len(part), "sha256": part_sha, "row_count": 1}],
        "validation": {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True},
    }
    manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
    with sqlite3.connect(snapshot) as connection:
        connection.executescript(catalog._DDL)
        connection.execute(
            "INSERT INTO dataset_versions VALUES (?, ?, ?, ?, ?, ?)",
            ("v1", "2026-09-16T00:00:00+00:00", "conversion/0.2", "market-observation/1", None, "PUBLISHED"),
        )
        connection.execute(
            "INSERT INTO partitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("instrument", "candle_1m", "v1", "2025-09-02", "binance", prefix, 1, 1, 0, 1, 1,
             "l" * 64, hashlib.sha256(manifest_bytes).hexdigest(), "2026-09-16T00:00:00+00:00", 0),
        )
    pointer = {"dataset_version": "v1", "catalog_key": snapshot.name,
               "catalog_sha256": catalog._sha256_file(snapshot)}
    client = FakeS3()
    store = s3_publish.Store(client, "bucket", "curated/binance")
    client.objects[store.key(prefix + "/_manifest.json")] = manifest_bytes
    client.objects[store.key(prefix + "/part-00000.parquet")] = part
    return root, snapshot, pointer, store


def test_attestation_verifies_remote_data_and_marks_only_the_new_snapshot_published(tmp_path):
    root, source, pointer, store = _setup(tmp_path)
    source_sha = catalog._sha256_file(source)
    output = root / "_catalog" / "attested.sqlite"

    result = attestation.attest(store, root, pointer, output, workers=2)

    assert result["catalog_key"] == output.name
    assert result["partition_count"] == 1
    assert catalog._sha256_file(source) == source_sha
    with sqlite3.connect(source) as connection:
        assert connection.execute("SELECT published_to_s3 FROM partitions").fetchone() == (0,)
    with sqlite3.connect(output) as connection:
        assert connection.execute("SELECT published_to_s3 FROM partitions").fetchone() == (1,)


def test_attestation_never_creates_an_output_when_a_remote_manifest_is_absent(tmp_path):
    root, _source, pointer, store = _setup(tmp_path)
    store.client.objects.clear()
    output = root / "_catalog" / "attested.sqlite"

    with pytest.raises(s3_publish.PublicationError, match="REMOTE_MANIFEST_UNAVAILABLE"):
        attestation.attest(store, root, pointer, output)

    assert not output.exists()


def test_attestation_refuses_a_stale_source_snapshot_before_remote_access(tmp_path):
    root, source, pointer, store = _setup(tmp_path)
    pointer["catalog_sha256"] = "0" * 64
    output = root / "_catalog" / "attested.sqlite"

    with pytest.raises(attestation.CatalogAttestationError, match="CATALOG_INTEGRITY_FAILURE"):
        attestation.attest(store, root, pointer, output)

    assert not output.exists()
    assert store.client.objects
