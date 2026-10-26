from __future__ import annotations

import hashlib
import io
import json
import multiprocessing
import os
import subprocess
import sys
import threading

import pytest

import archive_cache as ac
import archive_query as _aq
import s3_publish


class _Body(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class _ShortBody(_Body):
    """A legal short-reading stream: callers must not mistake one read for EOF."""

    def read(self, size=-1):
        return super().read(min(size, 7) if size >= 0 else 7)


class FakeS3:
    """Enough of the client surface for the cache, plus a deliberate corruption
    hook so a hash mismatch can be produced without editing the cache."""

    def __init__(self):
        self.objects = {}
        self.gets = []

    def put(self, key, data):
        self.objects[key] = data

    def get_object(self, Bucket, Key, IfMatch=None):
        self.gets.append(Key)
        if Key not in self.objects:
            raise KeyError(Key)
        return {"Body": _Body(self.objects[Key])}


class ShortReadS3(FakeS3):
    def get_object(self, Bucket, Key, IfMatch=None):
        self.gets.append(Key)
        if Key not in self.objects:
            raise KeyError(Key)
        return {"Body": _ShortBody(self.objects[Key])}


class BlockingS3(FakeS3):
    def __init__(self, blocked_key, started, release):
        super().__init__()
        self.blocked_key, self.started, self.release = blocked_key, started, release

    def get_object(self, Bucket, Key, IfMatch=None):
        self.gets.append(Key)
        if Key not in self.objects:
            raise KeyError(Key)
        if Key == self.blocked_key:
            outer = self

            class _BlockingBody(_Body):
                def read(self, size=-1):
                    if not outer.started.is_set():
                        outer.started.set()
                        assert outer.release.wait(5), "test did not release the blocked S3 body"
                    return super().read(size)

            return {"Body": _BlockingBody(self.objects[Key])}
        return {"Body": _Body(self.objects[Key])}


def _store(client, prefix="curated"):
    return s3_publish.Store(client, "bucket", prefix)


def _publish_partition(client, *, prefix="databento/inst/quote/v1/2025-09-01",
                       parts=(b"alpha-payload", b"beta-payload"), corrupt_part=None,
                       break_manifest=False, part_count=None):
    manifest = {"parts": [], "record_count": 10}
    row_counts = [10 // len(parts) + (index < 10 % len(parts)) for index in range(len(parts))]
    for index, payload in enumerate(parts):
        name = f"part-{index:05d}.parquet"
        manifest["parts"].append({
            "name": name, "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(), "row_count": row_counts[index],
        })
        stored = corrupt_part if (corrupt_part is not None and index == 0) else payload
        client.put(f"curated/{_aq.partition_relative(prefix)}/{name}", stored)
    if part_count is not None:
        manifest["parts"] = manifest["parts"][:part_count] or manifest["parts"]
    raw = json.dumps(manifest).encode()
    client.put(f"curated/{_aq.partition_relative(prefix)}/_manifest.json", raw)
    sha = hashlib.sha256(raw).hexdigest()
    if break_manifest:
        sha = "f" * 64
    return {
        "s3_prefix": prefix, "date": "2025-09-01",
        "manifest_key": f"curated/{_aq.partition_relative(prefix)}/_manifest.json",
        "manifest_sha256": sha, "part_count": len(manifest["parts"]),
        "record_count": 10,
    }


def _cache(tmp_path, **kwargs):
    kwargs.setdefault("min_free_disk_bytes", 0)
    return ac.PartCache(tmp_path / "cache", **kwargs)


def _child_attempt_reservation(root, queue):
    cache = ac.PartCache(root, max_bytes=30, min_free_disk_bytes=0)
    try:
        with cache.reserve(18):
            queue.put(("admitted", None))
    except ac.ArchiveQueryError as error:
        queue.put((error.code, error.detail["reason"]))


def test_process_liveness_check_preserves_live_process_and_detects_exit(monkeypatch):
    if os.name == "nt":
        def unsafe_signal(*args):
            pytest.fail("Windows liveness checks must not send process signals")
        monkeypatch.setattr(os, "kill", unsafe_signal)
    worker = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.buffer.read()"],
                              stdin=subprocess.PIPE)
    try:
        assert ac.PartCache._pid_alive(worker.pid)
        assert worker.poll() is None
        worker.communicate(timeout=10)
        assert worker.returncode == 0
        assert not ac.PartCache._pid_alive(worker.pid)
    finally:
        if worker.poll() is None:
            worker.terminate()
        worker.wait(timeout=10)


# ---------------------------------------------------------------- 2a tokens

def test_a_token_is_opaque_and_carries_no_catalog_path(tmp_path, monkeypatch):
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {"catalog_key": "catalog-secret.sqlite"},
                                      "partitions": []})
    registry = ac.SnapshotRegistry(str(tmp_path))

    token, snapshot = registry.issue("client-a")

    assert "catalog" not in token and "sqlite" not in token
    assert snapshot["pointer"]["catalog_key"] not in token
    assert registry.resolve(token, "client-a") is snapshot


@pytest.mark.parametrize("token,reason", [
    ("not-a-real-token", "UNKNOWN"), ("", "MALFORMED"), (None, "MALFORMED"), (17, "MALFORMED"),
])
def test_an_unusable_token_fails_and_never_falls_back_to_current(tmp_path, monkeypatch, token, reason):
    # Falling back to resolving CURRENT would silently move a paging caller onto
    # a newer snapshot, which is the exact mid-operation change the pin prevents.
    calls = []
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: calls.append(root) or {"pointer": {}, "partitions": []})
    registry = ac.SnapshotRegistry(str(tmp_path))

    with pytest.raises(ac.ArchiveQueryError) as raised:
        registry.resolve(token, "client-a")

    assert raised.value.code == ac.POINTER_TOKEN_INVALID
    assert raised.value.detail["reason"] == reason
    assert calls == [], "resolving an invalid token must not read the catalog"


def test_an_invalid_discovery_request_cannot_issue_or_consume_a_snapshot(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(ac._coverage_report, "read_catalog", lambda root: calls.append(root))
    registry = ac.SnapshotRegistry(str(tmp_path))

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.discover(registry, client="client-a", instrument_id="instrument", family="unsupported",
                    from_ns="1", to_ns="2", curated_prefix="curated")

    assert raised.value.code == ac._archive_query.UNSUPPORTED_FAMILY
    assert calls == []


def test_an_expired_token_is_refused_rather_than_silently_renewed(tmp_path, monkeypatch):
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    now = [1000.0]
    registry = ac.SnapshotRegistry(str(tmp_path), ttl_seconds=60, clock=lambda: now[0])
    token, _ = registry.issue("client-a")
    assert registry.resolve(token, "client-a") is not None

    now[0] += 61
    with pytest.raises(ac.ArchiveQueryError) as raised:
        registry.resolve(token, "client-a")
    assert raised.value.detail["reason"] == "EXPIRED"


def test_two_tokens_are_never_the_same(tmp_path, monkeypatch):
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    registry = ac.SnapshotRegistry(str(tmp_path))
    assert registry.issue("client-a")[0] != registry.issue("client-a")[0]


def test_snapshot_registry_is_bounded_before_another_catalog_read(tmp_path, monkeypatch):
    reads = []
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: reads.append(root) or {"pointer": {}, "partitions": []})
    # A client is now held to its own share, so it can always make room for
    # itself; the global bound is reached by client diversity instead.
    registry = ac.SnapshotRegistry(str(tmp_path), max_entries=1, max_entries_per_client=1)
    registry.issue("client-a")

    with pytest.raises(ac.ArchiveQueryError) as raised:
        registry.issue("client-b")

    assert raised.value.code == ac.CACHE_CAPACITY_EXCEEDED
    assert raised.value.detail["reason"] == "SNAPSHOT_REGISTRY_CAPACITY_EXCEEDED"
    assert reads == [str(tmp_path)]


def test_discovery_reuses_the_server_owned_token_snapshot(tmp_path, monkeypatch):
    snapshot = {
        "pointer": {"catalog_key": "snap.sqlite", "catalog_sha256": "a" * 64},
        "partitions": [{
            "instrument_id": "instrument", "family": "trade", "dataset_version": "v1",
            "date": "2025-09-01", "s3_prefix": "databento/inst/trade/v1/2025-09-01",
            "manifest_sha256": "b" * 64, "part_count": 1, "record_count": 1,
            "event_ns_min": 10, "event_ns_max": 20,
        }],
    }
    reads = []
    monkeypatch.setattr(ac._coverage_report, "read_catalog", lambda root: reads.append(root) or snapshot)
    registry = ac.SnapshotRegistry(str(tmp_path))

    first = ac.discover(registry, client="client-a", instrument_id="instrument", family="trade",
                        from_ns="10", to_ns="21", curated_prefix="curated")
    second = ac.discover(registry, client="client-a", pointer_token=first["pointerToken"],
                         instrument_id="instrument", family="trade", from_ns="10", to_ns="21",
                         curated_prefix="curated")

    assert reads == [str(tmp_path)]
    assert first["pointerToken"] == second["pointerToken"]
    assert first["partitions"] == second["partitions"]


# ------------------------------------------------------------- 2b manifests

def test_a_manifest_that_does_not_match_its_catalogued_hash_is_refused(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client, break_manifest=True)

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.read_manifest(_store(client), partition)

    assert raised.value.code == ac.PARTITION_VERIFICATION_FAILED
    assert raised.value.detail["reason"] == "MANIFEST_HASH_MISMATCH"


def test_a_manifest_whose_part_count_disagrees_with_the_catalog_is_refused(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client)
    partition["part_count"] = 99

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.read_manifest(_store(client), partition)
    assert raised.value.detail["reason"] == "PART_COUNT_DISAGREES_WITH_CATALOG"


def test_manifest_semantics_must_agree_with_its_catalogue(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client)
    raw = json.loads(client.objects[partition["manifest_key"]])
    raw["parts"][0]["row_count"] += 1
    raw = json.dumps(raw).encode()
    client.put(partition["manifest_key"], raw)
    partition["manifest_sha256"] = hashlib.sha256(raw).hexdigest()

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.read_manifest(_store(client), partition)

    assert raised.value.detail["reason"] == "RECORD_COUNT_DISAGREES_WITH_MANIFEST"


def test_manifest_name_and_key_must_identify_exactly_one_safe_object(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client)
    raw = json.loads(client.objects[partition["manifest_key"]])
    raw["parts"][1]["name"] = raw["parts"][0]["name"]
    raw = json.dumps(raw).encode()
    client.put(partition["manifest_key"], raw)
    partition["manifest_sha256"] = hashlib.sha256(raw).hexdigest()

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.read_manifest(_store(client), partition)
    assert raised.value.detail["reason"] == "DUPLICATE_PART_NAME"

    partition = _publish_partition(client, prefix="databento/elsewhere")
    partition["manifest_key"] = "curated/databento/untrusted/_manifest.json"
    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.read_manifest(_store(client), partition)
    assert raised.value.detail["reason"] == "MANIFEST_KEY_DISAGREES_WITH_PREFIX"


def test_manifest_reader_handles_short_stream_reads(tmp_path):
    client = ShortReadS3()
    partition = _publish_partition(client)

    assert ac.read_manifest(_store(client), partition)["record_count"] == 10


@pytest.mark.parametrize("name", ["../escape.parquet", "nested/part.parquet", "", ".", ".."])
def test_a_part_name_that_could_escape_its_partition_is_refused(tmp_path, name):
    client = FakeS3()
    manifest = {"parts": [{"name": name, "bytes": 1, "sha256": "a" * 64, "row_count": 1}],
                "record_count": 1}
    raw = json.dumps(manifest).encode()
    client.put("curated/databento/databento/p/_manifest.json", raw)
    partition = {"s3_prefix": "databento/p", "date": "d",
                 "manifest_key": "curated/databento/databento/p/_manifest.json",
                 "manifest_sha256": hashlib.sha256(raw).hexdigest(), "part_count": 1,
                 "record_count": 1}

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.read_manifest(_store(client), partition)
    assert raised.value.detail["reason"] == "UNSAFE_PART_NAME"


# ------------------------------------------------- 2c admission and integrity

def test_a_part_is_admitted_only_once_its_own_bytes_prove_it(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client)
    cache = _cache(tmp_path)

    result = ac.materialise(_store(client), cache, [partition], max_scan_bytes=10_000)

    assert [os.path.isfile(p["path"]) for p in result["parts"]] == [True, True]
    for part in result["parts"]:
        assert hashlib.sha256(open(part["path"], "rb").read()).hexdigest() == part["sha256"]


def test_a_part_whose_content_does_not_match_its_hash_is_never_admitted(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client, corrupt_part=b"tampered-----")
    cache = _cache(tmp_path)

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(_store(client), cache, [partition], max_scan_bytes=10_000)

    assert raised.value.code == ac.PARTITION_VERIFICATION_FAILED
    assert raised.value.detail["reason"] == "PART_HASH_MISMATCH"
    leftovers = [f for _r, _d, files in os.walk(cache.root) for f in files if "partial" in f]
    assert leftovers == [], "a failed fetch must leave nothing behind"

    # The invariant is that no *unverified* bytes are admitted, not that the
    # cache is emptied. The partition's other part passed its own hash, so when
    # its fetch ran it stays: entries are content-addressed and a retry finds it
    # warm. Whether it ran is scheduling: once the corrupt part's error reaches
    # Executor.map, a fetch that had not started yet is cancelled. Only the part
    # whose bytes disagreed with the manifest must be absent, always.
    declared = hashlib.sha256(b"alpha-payload").hexdigest()
    assert not os.path.exists(cache.path_for(declared))
    assert not os.path.exists(cache.path_for(hashlib.sha256(b"tampered-----").hexdigest()))
    verified = hashlib.sha256(b"beta-payload").hexdigest()
    if os.path.exists(cache.path_for(verified)):
        assert hashlib.sha256(open(cache.path_for(verified), "rb").read()).hexdigest() == verified
        assert cache.total_bytes() == len(b"beta-payload")
    else:
        assert cache.total_bytes() == 0


def test_a_failed_partition_leaves_no_pin_behind(tmp_path):
    # Pins survive the request that took them unless released on every exit
    # path; a leaked pin is invisible until the cache is full and eviction
    # cannot free anything.
    client = FakeS3()
    partition = _publish_partition(client, corrupt_part=b"tampered-----")
    cache = _cache(tmp_path)

    with pytest.raises(ac.ArchiveQueryError):
        ac.materialise(_store(client), cache, [partition], max_scan_bytes=10_000)

    assert cache._pinned() == set()


def test_a_part_longer_than_its_manifest_declares_is_cut_off_not_written(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client, corrupt_part=b"x" * 5000)

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(_store(client), _cache(tmp_path), [partition], max_scan_bytes=10_000)
    assert raised.value.detail["reason"] == "PART_LONGER_THAN_MANIFEST"


def test_cache_keys_are_validated_before_they_can_name_a_lock_or_file(tmp_path):
    cache = _cache(tmp_path)
    client = FakeS3()

    with pytest.raises(ac.ArchiveQueryError) as raised:
        cache.admit(_store(client), "databento/part.parquet", "../../outside", 1)

    assert raised.value.detail["reason"] == "INVALID_CACHE_KEY"
    assert not (tmp_path / "outside").exists()


def test_cache_startup_reclaims_a_crash_leftover_only_under_its_artifact_lock(tmp_path):
    cache = _cache(tmp_path)
    sha = hashlib.sha256(b"partial").hexdigest()
    partial = cache.path_for(sha) + ".partial.crashed"
    os.makedirs(os.path.dirname(partial), exist_ok=True)
    with open(partial, "wb") as handle:
        handle.write(b"incomplete")

    _cache(tmp_path)

    assert not os.path.exists(partial)


def test_cache_startup_accounts_for_a_verified_file_left_before_its_index_write(tmp_path):
    cache = _cache(tmp_path, max_bytes=5)
    payload = b"four"
    sha = hashlib.sha256(payload).hexdigest()
    path = cache.path_for(sha)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(payload)

    restarted = _cache(tmp_path, max_bytes=5)
    restarted.pin(sha)

    assert restarted.total_bytes() == len(payload)
    with pytest.raises(ac.ArchiveQueryError) as raised:
        restarted.reserve(2)
    assert raised.value.detail["reason"] == "ALL_ENTRIES_PINNED"
    restarted.release(sha)


@pytest.mark.parametrize("kwargs", [
    {"max_bytes": 0}, {"max_bytes": True}, {"min_free_disk_bytes": -1},
])
def test_cache_rejects_invalid_capacity_configuration(tmp_path, kwargs):
    with pytest.raises(ValueError):
        ac.PartCache(tmp_path / "cache", **kwargs)


def test_standalone_admission_reserves_capacity_before_fetching(tmp_path):
    client = FakeS3()
    payload = b"too-large"
    sha = hashlib.sha256(payload).hexdigest()
    client.put("curated/databento/part.parquet", payload)
    cache = _cache(tmp_path, max_bytes=len(payload) - 1)

    with pytest.raises(ac.ArchiveQueryError) as raised:
        cache.admit(_store(client), "part.parquet", sha, len(payload))

    assert raised.value.detail["reason"] == "LARGER_THAN_CACHE"
    assert client.gets == []


# ------------------------------------------------------- 2f the warm path

def test_a_warm_hit_does_not_re_read_the_object(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client)
    cache = _cache(tmp_path)
    store = _store(client)

    first = ac.materialise(store, cache, [partition], max_scan_bytes=10_000)
    gets_after_cold = len(client.gets)
    second = ac.materialise(store, cache, [partition], max_scan_bytes=10_000)

    assert first["cacheMisses"] == 2 and first["cacheHits"] == 0
    assert second["cacheHits"] == 2 and second["cacheMisses"] == 0
    # A warm read touches S3 for nothing at all. This used to re-read the
    # manifest every time, which measured 115 ms against a 100 ms warm budget --
    # one network round trip on the one path that exists to avoid them. The
    # manifest is content-addressed like a part, so a verified one is reusable.
    assert len(client.gets) - gets_after_cold == 0
    assert first["partitionsRead"] == second["partitionsRead"] == 1
    assert first["bytesRead"] > 0 and second["bytesRead"] == 0


def test_warm_acquire_and_release_do_not_scan_every_lease_owner(tmp_path, monkeypatch):
    client = FakeS3()
    partition = _publish_partition(client)
    cache = _cache(tmp_path)
    first = ac.materialise(_store(client), cache, [partition], max_scan_bytes=10_000)
    ac.release_materialised(cache, first)

    monkeypatch.setattr(cache, "_prune_dead_leases", lambda *_a: 1 / 0)
    second = ac.materialise(_store(client), cache, [partition], max_scan_bytes=10_000)
    ac.release_materialised(cache, second)

    assert second["cacheHits"] == 2


def test_two_callers_wanting_the_same_cold_part_share_one_fetch(tmp_path):
    # LocalLock is non-blocking, so taking it directly made the second caller
    # raise PermissionError -- a raw OS error outside the contract's taxonomy.
    # Content addressing makes this the common case, not an exotic one: two
    # readers scrolling the same region want the same bytes, which is exactly
    # what the cache exists to serve.
    payload = b"shared-cold-part-payload"
    sha = hashlib.sha256(payload).hexdigest()

    class SlowS3(FakeS3):
        def get_object(self, Bucket, Key, IfMatch=None):
            self.gets.append(Key)
            threading.Event().wait(0.3)
            return {"Body": _Body(self.objects[Key])}

    client = SlowS3()
    client.put("curated/p/part-00000.parquet", payload)
    cache = _cache(tmp_path)
    store = _store(client)
    outcomes = []

    def fetch():
        try:
            outcomes.append(("ok", cache.admit(store, "p/part-00000.parquet", sha, len(payload))))
        except BaseException as error:
            outcomes.append((type(error).__name__, str(error)[:80]))

    threads = [threading.Thread(target=fetch) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)

    assert [kind for kind, _ in outcomes] == ["ok"] * 3, outcomes
    assert len(client.gets) == 1, "the part is fetched once and shared"


def test_a_cached_manifest_is_still_checked_against_the_catalogued_hash(tmp_path):
    # Reuse is keyed by the hash the catalog recorded, so a partition whose
    # catalogued hash changes cannot be served from another partition's entry.
    client = FakeS3()
    partition = _publish_partition(client)
    cache = _cache(tmp_path)
    ac.materialise(_store(client), cache, [partition], max_scan_bytes=10_000)

    impostor = dict(partition, manifest_sha256="f" * 64)
    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.read_manifest(_store(client), impostor, manifests=cache.manifests)
    assert raised.value.code == ac.PARTITION_VERIFICATION_FAILED


def test_a_cached_entry_of_the_wrong_size_is_evicted_and_re_fetched(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client)
    cache = _cache(tmp_path)
    store = _store(client)
    first = ac.materialise(store, cache, [partition], max_scan_bytes=10_000)

    truncated = first["parts"][0]["path"]
    with open(truncated, "wb") as handle:
        handle.write(b"short")

    again = ac.materialise(store, cache, [partition], max_scan_bytes=10_000)

    assert again["cacheMisses"] == 1, "the damaged entry is re-fetched, not served"
    assert open(again["parts"][0]["path"], "rb").read() == b"alpha-payload"


# --------------------------------------------------- 2e capacity and pinning

def test_the_byte_gate_uses_the_manifest_not_the_row_estimate(tmp_path):
    # Step 1's estimate is record_count x a per-row rate and errs high by design.
    # The manifest carries the exact published byte count, and that is what must
    # decide admission -- before any Parquet part is downloaded.
    client = FakeS3()
    partition = _publish_partition(client)
    cache = _cache(tmp_path)

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(_store(client), cache, [partition], max_scan_bytes=5)

    assert raised.value.code == ac.RANGE_TOO_LARGE
    assert raised.value.detail["reason"] == "MANIFEST_BYTES_EXCEED_BUDGET"
    assert raised.value.detail["estimatedScanBytes"] == len(b"alpha-payload") + len(b"beta-payload")
    assert client.gets == [partition["manifest_key"]], "no part may be fetched before the gate"


def test_a_request_larger_than_the_whole_cache_is_refused_before_download(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client)
    cache = _cache(tmp_path, max_bytes=4)

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(_store(client), cache, [partition], max_scan_bytes=10_000)

    assert raised.value.code == ac.CACHE_CAPACITY_EXCEEDED
    assert raised.value.detail["reason"] == "LARGER_THAN_CACHE"
    assert client.gets == [partition["manifest_key"]]


def test_the_free_disk_reserve_refuses_before_download(tmp_path):
    client = FakeS3()
    partition = _publish_partition(client)
    cache = ac.PartCache(tmp_path / "cache", min_free_disk_bytes=1 << 62)

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(_store(client), cache, [partition], max_scan_bytes=10_000)

    assert raised.value.detail["reason"] == "FREE_DISK_RESERVE"
    assert client.gets == [partition["manifest_key"]]


def test_a_pinned_entry_is_never_evicted_to_make_room(tmp_path):
    client = FakeS3()
    held = _publish_partition(client, prefix="databento/inst/quote/v1/held",
                              parts=(b"held-payload-aaaa",))
    cache = _cache(tmp_path, max_bytes=20)
    store = _store(client)
    first = ac.materialise(store, cache, [held], max_scan_bytes=10_000)
    pinned_path = first["parts"][0]["path"]

    other = _publish_partition(client, prefix="databento/inst/quote/v1/other",
                               parts=(b"other-payload-bbb",))
    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(store, cache, [other], max_scan_bytes=10_000)

    assert raised.value.detail["reason"] == "ALL_ENTRIES_PINNED"
    assert os.path.isfile(pinned_path), "the pinned entry survived"


def test_a_pin_is_durable_across_separate_cache_instances(tmp_path):
    client = FakeS3()
    held = _publish_partition(client, prefix="databento/inst/quote/v1/held-durable",
                              parts=(b"held-payload-aaaa",))
    first_cache = _cache(tmp_path, max_bytes=20)
    first = ac.materialise(_store(client), first_cache, [held], max_scan_bytes=10_000)
    second_cache = _cache(tmp_path, max_bytes=20)
    other = _publish_partition(client, prefix="databento/inst/quote/v1/other-durable",
                               parts=(b"other-payload-bbb",))

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(_store(client), second_cache, [other], max_scan_bytes=10_000)

    assert raised.value.detail["reason"] == "ALL_ENTRIES_PINNED"
    assert os.path.isfile(first["parts"][0]["path"])
    ac.release_materialised(first_cache, first)


def test_inflight_reservations_prevent_concurrent_requests_from_overcommitting(tmp_path):
    first = _publish_partition(FakeS3(), prefix="databento/inst/quote/v1/reserved-first",
                               parts=(b"a" * 18,))
    blocked_key = first["manifest_key"].replace("_manifest.json", "part-00000.parquet")
    started, release = threading.Event(), threading.Event()
    client = BlockingS3(blocked_key, started, release)
    # Publish into the blocking client after its exact target key is known.
    first = _publish_partition(client, prefix="databento/inst/quote/v1/reserved-first", parts=(b"a" * 18,))
    second = _publish_partition(client, prefix="databento/inst/quote/v1/reserved-second", parts=(b"b" * 18,))
    cache = _cache(tmp_path, max_bytes=30)
    first_outcome = []

    def load_first():
        try:
            first_outcome.append(ac.materialise(_store(client), cache, [first], max_scan_bytes=10_000))
        except BaseException as error:  # surfaced below, after the producer is always released
            first_outcome.append(error)

    worker = threading.Thread(target=load_first)
    worker.start()
    assert started.wait(5), "first request never reached its part fetch"
    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(_store(client), cache, [second], max_scan_bytes=10_000)
    assert raised.value.detail["reason"] == "CAPACITY_RESERVED"

    release.set()
    worker.join(5)
    assert len(first_outcome) == 1 and not isinstance(first_outcome[0], BaseException)
    ac.release_materialised(cache, first_outcome[0])


def test_inflight_reservations_are_visible_across_a_real_process_boundary(tmp_path):
    cache = _cache(tmp_path, max_bytes=30)
    context = multiprocessing.get_context("spawn")
    queue = context.Queue()

    with cache.reserve(18):
        worker = context.Process(target=_child_attempt_reservation, args=(cache.root, queue))
        worker.start()
        outcome = queue.get(timeout=10)
        worker.join(10)

    assert worker.exitcode == 0
    assert outcome == (ac.CACHE_CAPACITY_EXCEEDED, "CAPACITY_RESERVED")


def test_an_unpinned_entry_is_evicted_to_make_room(tmp_path):
    client = FakeS3()
    first_partition = _publish_partition(client, prefix="databento/inst/quote/v1/first",
                                         parts=(b"first-payload-aaa",))
    cache = _cache(tmp_path, max_bytes=20)
    store = _store(client)
    first = ac.materialise(store, cache, [first_partition], max_scan_bytes=10_000)
    for part in first["parts"]:
        cache.release(part["sha256"])

    second_partition = _publish_partition(client, prefix="databento/inst/quote/v1/second",
                                          parts=(b"second-payload-bb",))
    second = ac.materialise(store, cache, [second_partition], max_scan_bytes=10_000)

    assert os.path.isfile(second["parts"][0]["path"])
    assert not os.path.isfile(first["parts"][0]["path"]), "the unpinned entry made room"


def test_identical_content_published_twice_occupies_one_cache_entry(tmp_path):
    client = FakeS3()
    same = (b"identical-bytes",)
    left = _publish_partition(client, prefix="databento/inst/quote/v1/left", parts=same)
    right = _publish_partition(client, prefix="databento/inst/quote/v2/right", parts=same)
    cache = _cache(tmp_path)
    store = _store(client)

    a = ac.materialise(store, cache, [left], max_scan_bytes=10_000)
    b = ac.materialise(store, cache, [right], max_scan_bytes=10_000)

    assert a["parts"][0]["path"] == b["parts"][0]["path"]
    assert cache.total_bytes() == len(same[0])


class _MeteredS3(FakeS3):
    """Records how many manifest reads overlap and delays each so overlap can happen."""

    def __init__(self, delay_s=0.02):
        super().__init__()
        self.delay_s = delay_s
        self._lock = threading.Lock()
        self.in_flight, self.max_in_flight = 0, 0

    def get_object(self, Bucket, Key, IfMatch=None):
        import time
        if Key.endswith("/_manifest.json"):
            with self._lock:
                self.in_flight += 1
                self.max_in_flight = max(self.max_in_flight, self.in_flight)
            try:
                time.sleep(self.delay_s)
            finally:
                with self._lock:
                    self.in_flight -= 1
        return super().get_object(Bucket, Key, IfMatch)


def _pin_counts(cache):
    import sqlite3
    with sqlite3.connect(cache._index_path) as connection:
        return dict(connection.execute("SELECT sha, count FROM pins").fetchall())


def _many_partitions(client, count):
    return [_publish_partition(client, prefix=f"databento/inst/candle_1d/v1/2026-01-{day:02d}",
                               parts=(f"day-{day:02d}".encode(),)) for day in range(1, count + 1)]


def test_manifests_of_one_request_are_read_concurrently_and_kept_in_partition_order(tmp_path):
    # Measured on the host 2026-09-21: a year of daily candles is 251 partitions,
    # and reading their manifests one after another cost 22.5 s of a 27.8 s
    # request. The reads share the download pool; the order the caller gave is
    # what the caller gets back.
    client = _MeteredS3()
    partitions = _many_partitions(client, 24)
    cache = _cache(tmp_path)

    result = ac.materialise(_store(client), cache, partitions, max_scan_bytes=10_000, concurrency=8)

    assert client.max_in_flight > 1
    assert [part["partition"]["s3_prefix"] for part in result["parts"]] == [p["s3_prefix"] for p in partitions]
    assert result["partitionsRead"] == 24 and result["cacheMisses"] == 24
    ac.release_materialised(cache, result)


def test_warm_parts_of_one_request_are_observed_and_pinned_in_one_index_transaction(tmp_path, monkeypatch):
    # Measured on the host 2026-09-21: pinning 251 already-cached parts one
    # transaction at a time cost 9.3 s with nothing left to download.
    client = FakeS3()
    partitions = _many_partitions(client, 12)
    cache = _cache(tmp_path)
    first = ac.materialise(_store(client), cache, partitions, max_scan_bytes=10_000)
    ac.release_materialised(cache, first)
    opened = []
    original = cache._connect

    def counting_connect():
        opened.append(1)
        return original()

    monkeypatch.setattr(cache, "_connect", counting_connect)
    second = ac.materialise(_store(client), cache, partitions, max_scan_bytes=10_000)

    assert second["cacheHits"] == 12 and second["cacheMisses"] == 0
    assert len(opened) == 1
    assert sum(_pin_counts(cache).values()) == 12
    ac.release_materialised(cache, second)
    assert _pin_counts(cache) == {}


def test_acquire_warm_many_pins_each_artifact_as_often_as_the_request_names_it(tmp_path):
    client = FakeS3()
    shared = (b"shared-bytes",)
    left = _publish_partition(client, prefix="databento/inst/quote/v1/left", parts=shared)
    right = _publish_partition(client, prefix="databento/inst/quote/v1/right", parts=shared)
    lone = _publish_partition(client, prefix="databento/inst/quote/v1/lone", parts=(b"lone-bytes",))
    cache = _cache(tmp_path)
    warm = ac.materialise(_store(client), cache, [left, lone], max_scan_bytes=10_000)
    ac.release_materialised(cache, warm)
    shared_sha = hashlib.sha256(shared[0]).hexdigest()
    lone_sha = hashlib.sha256(b"lone-bytes").hexdigest()
    cold_sha = hashlib.sha256(b"never-cached").hexdigest()

    paths, counts = cache.acquire_warm_many([
        (shared_sha, len(shared[0])), (lone_sha, len(b"lone-bytes")), (shared_sha, len(shared[0])), (cold_sha, 12),
    ])

    assert set(paths) == {shared_sha, lone_sha}
    assert counts == {shared_sha: 2, lone_sha: 1}
    assert _pin_counts(cache) == {shared_sha: 2, lone_sha: 1}
    cache.release_many(counts)
    assert _pin_counts(cache) == {}
    assert cache.acquire_warm_many([]) == ({}, {})
    with pytest.raises(ac.ArchiveQueryError):
        cache.acquire_warm_many([("not-a-sha", 1)])
    both = ac.materialise(_store(client), cache, [left, right], max_scan_bytes=10_000)
    assert _pin_counts(cache) == {shared_sha: 2}
    ac.release_materialised(cache, both)
    assert _pin_counts(cache) == {}


def test_a_cancelled_request_stops_at_the_manifest_stage_and_pins_nothing(tmp_path):
    client = _MeteredS3(delay_s=0.0)
    partitions = _many_partitions(client, 6)
    cache = _cache(tmp_path)
    calls = []

    def cancel_check():
        calls.append(1)
        raise ac.ArchiveQueryError("CANCELLED", reason="TEST")

    with pytest.raises(ac.ArchiveQueryError) as raised:
        ac.materialise(_store(client), cache, partitions, max_scan_bytes=10_000, cancel_check=cancel_check)

    assert raised.value.code == "CANCELLED"
    assert not any(key.endswith(".parquet") for key in client.gets)
    assert _pin_counts(cache) == {}


def test_a_pointer_token_is_refused_for_a_different_client(tmp_path, monkeypatch):
    # Unguessable is not the same as unusable by someone else. A token that
    # leaked through a log or a copied request must not be a working capability
    # for a different authenticated caller.
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    registry = ac.SnapshotRegistry(str(tmp_path))
    token, _ = registry.issue("client-a")

    with pytest.raises(ac.ArchiveQueryError) as raised:
        registry.resolve(token, "client-b")

    assert raised.value.code == ac.POINTER_TOKEN_INVALID
    assert raised.value.detail["reason"] == "CLIENT_MISMATCH"
    assert registry.resolve(token, "client-a") is not None, "the owner must keep working"


def test_the_study_budget_suffix_reads_its_own_viewers_pin_and_no_one_elses(tmp_path, monkeypatch):
    # `.study` is the gateway's budget class for the reads it makes on a viewer's
    # behalf, not a second identity: a study pinned to the chart's snapshot must
    # resolve that viewer's token, so it keeps the study budget instead of
    # spending the chart's. It never widens who may read a pin.
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    registry = ac.SnapshotRegistry(str(tmp_path))
    token, _ = registry.issue("viewer-1")
    study_token, _ = registry.issue("viewer-1.study")

    assert registry.resolve(token, "viewer-1.study") is not None
    assert registry.resolve(study_token, "viewer-1") is not None
    for stranger in ("viewer-2", "viewer-2.study", "viewer-1.study.study", "viewer-10.study"):
        with pytest.raises(ac.ArchiveQueryError) as raised:
            registry.resolve(token, stranger)
        assert raised.value.detail["reason"] == "CLIENT_MISMATCH"
    assert ac.pointer_owner(".study") == ".study"


@pytest.mark.parametrize("client", ["", None, 17])
def test_a_pin_cannot_be_issued_or_resolved_without_a_client(tmp_path, monkeypatch, client):
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    registry = ac.SnapshotRegistry(str(tmp_path))

    with pytest.raises(ac.ArchiveQueryError) as issuing:
        registry.issue(client)
    assert issuing.value.detail["reason"] == "CLIENT_IDENTITY_ABSENT"

    token, _ = registry.issue("client-a")
    with pytest.raises(ac.ArchiveQueryError) as resolving:
        registry.resolve(token, client)
    assert resolving.value.detail["reason"] == "CLIENT_IDENTITY_ABSENT"


def test_one_client_cannot_exhaust_the_registry_for_everyone(tmp_path, monkeypatch):
    # Reproduced before this was written: nothing releases a pin early, so at the
    # permitted 60 requests/minute one client filled all 256 entries in about four
    # minutes and every other client's next query was refused for the remaining
    # eleven of the fifteen-minute TTL. Capacity is shared; the blast radius must
    # not be.
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    now = [1000.0]
    registry = ac.SnapshotRegistry(str(tmp_path), max_entries=32, max_entries_per_client=4,
                                   clock=lambda: now[0])

    noisy = [registry.issue("noisy")[0] for _ in range(50)]

    assert registry.resolve(noisy[-1], "noisy") is not None, "its newest pin must survive"
    assert registry.issue("innocent")[0], "a different client must still be served"


def test_a_client_is_held_to_its_own_share_of_the_registry(tmp_path, monkeypatch):
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    now = [1000.0]
    registry = ac.SnapshotRegistry(str(tmp_path), max_entries=32, max_entries_per_client=4,
                                   clock=lambda: now[0])

    tokens = [registry.issue("noisy")[0] for _ in range(20)]
    alive = [t for t in tokens if t in registry._entries]

    assert len(alive) == 4
    assert alive == tokens[-4:], "the share it keeps is its newest, not an arbitrary four"


def test_an_evicted_pin_reads_as_a_restart_not_a_server_fault(tmp_path, monkeypatch):
    # The contract already has a restart path for an unusable pin. Losing your own
    # oldest pin must land there, not on the 503 that used to hit every client.
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    now = [1000.0]
    registry = ac.SnapshotRegistry(str(tmp_path), max_entries=32, max_entries_per_client=2,
                                   clock=lambda: now[0])

    first = registry.issue("viewer")[0]
    for _ in range(5):
        registry.issue("viewer")

    with pytest.raises(ac.ArchiveQueryError) as raised:
        registry.resolve(first, "viewer")
    assert raised.value.code == ac.POINTER_TOKEN_INVALID


def test_a_failed_replacement_does_not_evict_a_working_page_chain(tmp_path, monkeypatch):
    snapshots = [{"pointer": {}, "partitions": []}, ac._coverage_report.CoverageReportError("broken")]

    def read_catalog(_root):
        result = snapshots.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(ac._coverage_report, "read_catalog", read_catalog)
    registry = ac.SnapshotRegistry(str(tmp_path), max_entries=1, max_entries_per_client=1)
    token, _ = registry.issue("viewer")

    with pytest.raises(ac.ArchiveQueryError) as raised:
        registry.issue("viewer")

    assert raised.value.code == ac.CATALOG_INTEGRITY_FAILURE
    assert registry.resolve(token, "viewer") is not None


def test_one_client_evicting_its_own_pins_never_touches_another_clients(tmp_path, monkeypatch):
    monkeypatch.setattr(ac._coverage_report, "read_catalog",
                        lambda root: {"pointer": {}, "partitions": []})
    now = [1000.0]
    registry = ac.SnapshotRegistry(str(tmp_path), max_entries=32, max_entries_per_client=3,
                                   clock=lambda: now[0])

    quiet = registry.issue("quiet")[0]
    for _ in range(30):
        registry.issue("noisy")

    assert registry.resolve(quiet, "quiet") is not None


@pytest.mark.parametrize("per_client,total", [(0, 8), (-1, 8), (9, 8)])
def test_an_impossible_per_client_share_is_refused_at_construction(tmp_path, per_client, total):
    with pytest.raises(ValueError):
        ac.SnapshotRegistry(str(tmp_path), max_entries=total, max_entries_per_client=per_client)
