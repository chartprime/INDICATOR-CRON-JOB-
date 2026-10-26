from __future__ import annotations

import hashlib
import json

import pytest

import archive_catalog_sync as syncer
import s3_publish


class Body:
    def __init__(self, value):
        self._value = value
        self._offset = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size=-1):
        if size < 0:
            size = len(self._value) - self._offset
        result = self._value[self._offset:self._offset + size]
        self._offset += len(result)
        return result


class Client:
    def __init__(self, objects):
        self.objects = objects

    def get_object(self, *, Bucket, Key):
        del Bucket
        return {"Body": Body(self.objects[Key]), "ETag": '"etag"'}


def _store(snapshot, *, pointer=None):
    if pointer is None:
        pointer = {
            "catalog_key": "catalog-history.sqlite",
            "catalog_sha256": hashlib.sha256(snapshot).hexdigest(),
        }
    prefix = "curated/databento/_historical/_catalog/"
    return s3_publish.Store(Client({
        prefix + "CURRENT.json": json.dumps(pointer).encode(),
        prefix + pointer["catalog_key"]: snapshot,
    }), "bucket", "curated/databento/_historical")


def test_sync_installs_a_hash_verified_snapshot_before_moving_local_current(tmp_path):
    snapshot = b"immutable sqlite snapshot bytes"
    result = syncer.sync(_store(snapshot), tmp_path)

    assert result == {
        "catalog_key": "catalog-history.sqlite",
        "catalog_sha256": hashlib.sha256(snapshot).hexdigest(),
        "catalog_bytes": len(snapshot),
    }
    assert (tmp_path / "catalog-history.sqlite").read_bytes() == snapshot
    assert json.loads((tmp_path / "CURRENT.json").read_text(encoding="utf-8")) == {
        "catalog_key": "catalog-history.sqlite",
        "catalog_sha256": hashlib.sha256(snapshot).hexdigest(),
    }


def test_hash_failure_leaves_an_existing_reader_pointer_untouched(tmp_path):
    previous = {"catalog_key": "old.sqlite", "catalog_sha256": "a" * 64}
    (tmp_path / "CURRENT.json").write_text(json.dumps(previous), encoding="utf-8")
    snapshot = b"wrong bytes"
    pointer = {"catalog_key": "catalog-history.sqlite", "catalog_sha256": "b" * 64}

    with pytest.raises(syncer.CatalogSyncError, match="REMOTE_CATALOG_HASH_MISMATCH"):
        syncer.sync(_store(snapshot, pointer=pointer), tmp_path)

    assert json.loads((tmp_path / "CURRENT.json").read_text(encoding="utf-8")) == previous
    assert not (tmp_path / "catalog-history.sqlite").exists()


@pytest.mark.parametrize("pointer", [
    {"catalog_key": "../outside.sqlite", "catalog_sha256": "a" * 64},
    {"catalog_key": "catalog.sqlite", "catalog_sha256": "not-a-digest"},
    {"catalog_key": "catalog.sqlite"},
])
def test_sync_rejects_an_unsafe_or_incomplete_remote_pointer(pointer):
    with pytest.raises(syncer.CatalogSyncError, match="REMOTE_POINTER_INVALID"):
        syncer._pointer(pointer)
