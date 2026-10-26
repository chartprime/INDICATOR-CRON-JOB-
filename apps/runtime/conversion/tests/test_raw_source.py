from __future__ import annotations

import datetime as dt
import os

import pytest

import raw_source as rs


class FakePaginator:
    def __init__(self, client):
        self._client = client

    def paginate(self, Bucket, Prefix):
        matching = [key for key in self._client.objects if key.startswith(Prefix)]
        matching.sort()
        page_size = 2  # force multiple pages even in small tests
        for i in range(0, len(matching), page_size):
            page = matching[i:i + page_size]
            yield {"Contents": [
                {"Key": key, "Size": len(self._client.objects[key]),
                 "LastModified": self._client.last_modified[key], "ETag": self._client.etag(key)}
                for key in page
            ]}


class FakeRawBucket:
    def __init__(self):
        self.objects = {}
        self.last_modified = {}

    def put(self, key, data, last_modified=dt.datetime(2025, 9, 1, tzinfo=dt.timezone.utc)):
        self.objects[key] = data
        self.last_modified[key] = last_modified

    def etag(self, key):
        import hashlib
        return hashlib.sha256(self.objects[key]).hexdigest()

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return FakePaginator(self)

    def head_object(self, Bucket, Key):
        return {"ContentLength": len(self.objects[Key]), "ETag": self.etag(Key)}

    def get_object(self, Bucket, Key, IfMatch=None):
        import io
        assert IfMatch is None or IfMatch == self.head_object(Bucket, Key)["ETag"]
        return {"Body": io.BytesIO(self.objects[Key])}


_PREFIX = "raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=NQ/"


def test_list_finds_a_daily_object_that_intersects_the_range():
    client = FakeRawBucket()
    client.put(_PREFIX + "year=2026/month=06/day=16/x.dbn.zst", b"day16")
    client.put(_PREFIX + "year=2026/month=06/day=17/x.dbn.zst", b"day17")
    objects = rs.list_raw_objects(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ", "2026-06-16", "2026-06-17")
    assert [o["s3_key"] for o in objects] == [_PREFIX + "year=2026/month=06/day=16/x.dbn.zst"]


def test_list_finds_a_monthly_object_covering_any_day_in_the_range():
    client = FakeRawBucket()
    client.put(_PREFIX + "year=2026/month=06/x-monthly.dbn.zst", b"month")
    objects = rs.list_raw_objects(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ", "2026-06-16", "2026-06-17")
    assert len(objects) == 1
    assert objects[0]["last_modified"].startswith("2025-09-01")


def test_list_excludes_objects_entirely_outside_the_range():
    client = FakeRawBucket()
    client.put(_PREFIX + "year=2026/month=05/day=31/x.dbn.zst", b"may")
    client.put(_PREFIX + "year=2026/month=07/day=01/x.dbn.zst", b"july")
    objects = rs.list_raw_objects(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ", "2026-06-01", "2026-06-30")
    assert objects == []


def test_list_ignores_objects_missing_the_year_month_partition_keys():
    client = FakeRawBucket()
    client.put("raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=NQ/README.txt", b"not partitioned")
    objects = rs.list_raw_objects(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ", "2026-06-01", "2026-06-30")
    assert objects == []


def test_list_refuses_an_object_without_a_stable_listing_identity():
    client = FakeRawBucket()
    key = _PREFIX + "year=2026/month=06/day=16/x.dbn.zst"
    client.put(key, b"day16")

    class MissingIdentityPaginator:
        def paginate(self, Bucket, Prefix):
            yield {"Contents": [{"Key": key, "Size": 5, "LastModified": client.last_modified[key]}]}

    client.get_paginator = lambda name: MissingIdentityPaginator()
    with pytest.raises(rs.RawSourceError, match="MISSING_OBJECT_IDENTITY"):
        rs.list_raw_objects(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ", "2026-06-16", "2026-06-17")


def test_list_refuses_an_empty_or_reversed_range():
    client = FakeRawBucket()
    with pytest.raises(rs.RawSourceError, match="EMPTY_DATE_RANGE"):
        rs.list_raw_objects(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ", "2026-06-17", "2026-06-16")


def test_discover_date_range_finds_the_true_min_and_max_across_many_objects():
    client = FakeRawBucket()
    client.put(_PREFIX + "year=2025/month=09/day=06/x.dbn.zst", b"first")
    client.put(_PREFIX + "year=2025/month=10/day=15/x.dbn.zst", b"middle")
    client.put(_PREFIX + "year=2026/month=06/day=01/x.dbn.zst", b"middle2")
    client.put(_PREFIX + "year=2026/month=08/day=31/x.dbn.zst", b"last")
    earliest, latest = rs.discover_date_range(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ")
    assert (earliest, latest) == ("2025-09-06", "2026-08-31")


def test_discover_date_range_treats_a_monthly_object_as_covering_the_whole_month():
    client = FakeRawBucket()
    client.put(_PREFIX + "year=2026/month=06/x-monthly.dbn.zst", b"month")
    earliest, latest = rs.discover_date_range(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ")
    assert (earliest, latest) == ("2026-06-01", "2026-06-30")


def test_discover_date_range_refuses_when_nothing_is_found():
    client = FakeRawBucket()
    with pytest.raises(rs.RawSourceError, match="NO_OBJECTS_FOUND"):
        rs.discover_date_range(client, "bucket", "GLBX.MDP3", "mbp-1", "NQ")


def test_ensure_local_downloads_and_is_idempotent(tmp_path):
    client = FakeRawBucket()
    key = _PREFIX + "year=2026/month=06/day=16/x.dbn.zst"
    client.put(key, b"the real bytes")
    local_dir = str(tmp_path / "raw-cache")

    path = rs.ensure_local(client, "bucket", key, local_dir)
    assert os.path.basename(path).endswith("-x.dbn.zst")
    with open(path, "rb") as fh:
        assert fh.read() == b"the real bytes"

    def fail(*a, **k):
        raise AssertionError("must not re-download an already-present, same-size file")
    client.get_object = fail
    path_again = rs.ensure_local(client, "bucket", key, local_dir)
    assert path_again == path


def test_ensure_local_rejects_a_truncated_download(tmp_path, monkeypatch):
    client = FakeRawBucket()
    key = _PREFIX + "year=2026/month=06/day=16/x.dbn.zst"
    client.put(key, b"twenty full bytes!!!")
    real_head = client.head_object
    monkeypatch.setattr(client, "head_object", lambda Bucket, Key: {**real_head(Bucket, Key), "ContentLength": 999})

    with pytest.raises(rs.RawSourceError, match="DOWNLOAD_SIZE_MISMATCH"):
        rs.ensure_local(client, "bucket", key, str(tmp_path / "raw-cache"))
    assert os.listdir(tmp_path / "raw-cache") == [".cache.guard"]


def test_cache_separates_same_basename_and_replaces_same_size_changed_object(tmp_path):
    client = FakeRawBucket()
    first, second = _PREFIX + "year=2026/month=06/x.csv", _PREFIX + "year=2026/month=07/x.csv"
    client.put(first, b"first")
    client.put(second, b"other")
    p1 = rs.ensure_local(client, "bucket", first, tmp_path)
    p2 = rs.ensure_local(client, "bucket", second, tmp_path)
    assert p1 != p2
    client.put(first, b"newer")
    assert open(rs.ensure_local(client, "bucket", first, tmp_path), "rb").read() == b"newer"
    with open(p1, "wb") as fh:
        fh.write(b"wrong")
    assert open(rs.ensure_local(client, "bucket", first, tmp_path), "rb").read() == b"newer"
