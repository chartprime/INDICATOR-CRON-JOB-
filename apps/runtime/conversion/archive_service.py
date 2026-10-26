from __future__ import annotations

import atexit
import collections
import os
import threading
import time

import archive_admission as _admission_module
import archive_cache as _cache_module
import archive_query as _archive_query
import archive_reader as _reader
import archive_reader_bridge as _reader_bridge
import archive_telemetry as _telemetry_module

CONTRACT_VERSION = _reader.CONTRACT_VERSION

ArchiveQueryError = _archive_query.ArchiveQueryError
_DEFAULT_ADMISSION = _admission_module.Admission()

_ranges_lock = threading.Lock()
_ranges = {}

_reader_pools_lock = threading.Lock()
_reader_pools = {}


def _reader_pool_key(temp_root):
    return os.path.realpath(os.fspath(temp_root)) if temp_root is not None else ""


def reader_pool(temp_root):
    """The process's reader pool for one scratch root.

    Sized to `MAX_CONCURRENT_READS` so the number of reader processes and the
    number of admitted readers are the same number by construction. Keyed by
    scratch root because the root is the caller's, not this module's."""
    key = _reader_pool_key(temp_root)
    with _reader_pools_lock:
        pool = _reader_pools.get(key)
        if pool is None:
            pool = _reader_bridge.BridgePool(
                _admission_module.MAX_CONCURRENT_READS, temp_root=temp_root)
            _reader_pools[key] = pool
        return pool


def shutdown_readers(temp_root=None):
    """Stop one cache root's reader pool, or every pool at process exit."""
    with _reader_pools_lock:
        if temp_root is None:
            pools = list(_reader_pools.values())
            _reader_pools.clear()
        else:
            pool = _reader_pools.pop(_reader_pool_key(temp_root), None)
            pools = [] if pool is None else [pool]
    for pool in pools:
        pool.close()


atexit.register(shutdown_readers)


def part_range(connection, sha, path):
    """The `event_ns` span of one cached part.

    The catalog records a range per partition and the manifest records none per
    part, but the reader skips by part, so the span has to come from the file.
    It is read from Parquet column statistics rather than by scanning, and it is
    memoised by content hash: a part is named by its own bytes, so its span can
    never change under that name."""
    with _ranges_lock:
        cached = _ranges.get(sha)
        if cached is not None:
            return cached
        low, high = connection.execute(
            "SELECT min(CAST(stats_min_value AS UBIGINT)), max(CAST(stats_max_value AS UBIGINT)) "
            "FROM parquet_metadata(?) WHERE path_in_schema='event_ns'", [path]).fetchone()
        if low is None or high is None:
            raise ArchiveQueryError(_cache_module.PARTITION_VERIFICATION_FAILED,
                                    reason="PART_MISSING_EVENT_RANGE_STAT", sha256=sha)
        span = (str(low), str(high))
        _ranges[sha] = span
    return span


def _reader_parts(connection, materialised):
    """Cached parts in canonical order, carrying the span each one covers.

    `materialise` preserves the order discovery resolved and the order the
    writer named its parts in, which is the canonical order -- proven on the
    production archive, including a 59-part partition, as equal to a global sort
    with zero mismatched rows across 10,113,547."""
    parts = []
    for part in materialised["parts"]:
        low, high = part_range(connection, part["sha256"], part["path"])
        parts.append({"path": part["path"], "event_ns_min": low, "event_ns_max": high,
                      "sha256": part["sha256"], "bytes": part["bytes"]})
    return parts


PUBLISHED = "PUBLISHED"
QUIET = "QUIET"
CORRUPT = "CORRUPT"
UNKNOWN = "UNKNOWN"

_FAMILY_EVENT_SPAN_NS = {
    "candle": 1_000_000_000,
    "candle_1m": 60_000_000_000,
    "candle_1h": 3_600_000_000_000,
    "candle_1d": 86_400_000_000_000,
    "trade_minute_1m": 60_000_000_000,
    "trade_level_1m": 60_000_000_000,
    "trade_slice_2s": 2_000_000_000,
    "trade_prints_1m": 60_000_000_000,
}


def _partition_of(detail, partitions):
    """Which partition a verification failure belongs to.

    Both failure modes name the object that failed -- a manifest by its own key,
    a part by its partition prefix plus name -- so the partition is recoverable
    without the cache having to know about coverage."""
    key = detail.get("key")
    if not isinstance(key, str):
        return None
    for partition in partitions:
        if (key == partition["manifest_key"]
                or key.startswith(_archive_query.partition_relative(
                    partition["s3_prefix"], partition.get("provider")) + "/")):
            return partition
    return None


def _materialise_serving_what_is_sound(store, cache, partitions, budget, *, token=None):
    """Fetch every partition that can be verified, and set aside the ones that
    cannot.

    A `CORRUPT` partition degrades its window rather than failing it: the
    surviving partitions are served and coverage names the casualty. Failing the
    whole window atomically would discard good data and leave a caller with
    nothing to draw and no way to tell why. A bad part is only discovered when
    its bytes arrive, so this retries without the offender -- bounded, because
    every pass removes at least one partition."""
    remaining, corrupt = list(partitions), []
    while True:
        if token is not None:
            token.raise_if_cancelled()
        if not remaining:
            return None, corrupt
        try:
            return _cache_module.materialise(
                store, cache, remaining, max_scan_bytes=budget,
                cancel_check=token.raise_if_cancelled if token is not None else None), corrupt
        except ArchiveQueryError as error:
            if error.code != _cache_module.PARTITION_VERIFICATION_FAILED:
                raise
            offender = _partition_of(error.detail, remaining)
            if offender is None:
                raise
            corrupt.append({"partition": offender, "date": offender["date"],
                            "reason": error.detail.get("reason")})
            remaining = [p for p in remaining if p is not offender]


def _served_window(page, family, requested):
    """The span actually returned, half-open like every other window here.

    A candle family's last row spans past its own key, and a caller's window
    may end inside that span; what was served is then the part inside the
    window, never more than was asked for."""
    if page["firstKey"] is None:
        return None
    span = _FAMILY_EVENT_SPAN_NS.get(family, 1)
    start = max(int(page["firstKey"][0]), int(requested["from"]))
    end = min(int(page["lastKey"][0]) + span, int(requested["to"]))
    return {"from": str(start), "to": str(end)}


def _coverage(found, *, served, corrupt, served_partitions):
    """What was actually served against what was asked for.

    States are reported, never inferred. A partition the engine read is
    `PUBLISHED`; one that failed verification is `CORRUPT`. Time inside the window that no partition covers is a gap the
    query engine genuinely cannot classify -- distinguishing a closed market
    from an unconverted day needs the venue's status reference, which this path
    does not read -- so it is reported as `UNKNOWN` rather than guessed into
    something more specific."""
    requested = found["selection"]["requested"]
    states = collections.Counter()
    for partition in served_partitions:
        states[PUBLISHED] += 1
    states[CORRUPT] += len(corrupt)

    span = _FAMILY_EVENT_SPAN_NS.get(found["family"], 1)
    cursor = int(requested["from"])
    for partition in found["partitions"]:
        low, high = int(partition["event_ns_min"]), int(partition["event_ns_max"]) + span
        if low > cursor:
            states[UNKNOWN] += 1
        cursor = max(cursor, high)
    if cursor < int(requested["to"]):
        states[UNKNOWN] += 1

    return {
        "requested": requested,
        "served": served,
        "partitions": found["selection"]["partitions"],
        "states": {state: count for state, count in states.items() if count},
        "corrupt": [{"date": item["date"], "reason": item["reason"]} for item in corrupt],
    }


def _cursor_resumes_from_corrupt_partition(after_key, partitions, corrupt):
    if after_key is None:
        return None
    corrupt_ids = {id(item["partition"]) for item in corrupt}
    event_ns = int(after_key[0])
    for partition in partitions:
        if int(partition["event_ns_min"]) <= event_ns <= int(partition["event_ns_max"]):
            return partition if id(partition) in corrupt_ids else None
    return None


def query(registry, cache, store, connection, *, instrument_id, family, from_ns, to_ns,
          curated_prefix, limit=None, cursor=None, pointer_token=None, max_scan_bytes=None,
          admission=None, client="anonymous", reader=None, cancel_token=None,
          cursor_secret=None, telemetry=None):
    """One contract-shaped historical read.

    The order of operations is the contract's: pin a verified snapshot, resolve
    the window to exact partitions from metadata alone, refuse on the manifest's
    exact byte count before any part is fetched, serve from the cache, and only
    then read a page. Every refusal that can be reached without touching S3 is
    reached before S3 is touched.

    Pins taken to read are released on every exit path. A pin that outlives its
    request is invisible until the cache is full and eviction can free nothing.

    `admission` bounds concurrency, queueing and rate, and carries the token a
    caller cancels through. The process-wide admission instance is the default,
    so no public call can accidentally make readers unbounded. `reader` is an
    explicit in-process test seam; the default is an isolated worker drawn from
    a pool. The pool is the point: starting one per page measured 240.32 ms
    against 13.97 ms reused, and only 4.17 ms of that gap was the protocol."""
    resolved_limit = _archive_query.resolve_limit(limit)
    admission = _DEFAULT_ADMISSION if admission is None else admission
    telemetry = _telemetry_module.DEFAULT_TELEMETRY if telemetry is None else telemetry
    wait_started = time.monotonic()
    with admission.acquire(client, token=cancel_token) as slot:
        service_started = time.monotonic()
        telemetry.observe("admissionWaitMs", (service_started - wait_started) * 1000.0)
        try:
            return _query_admitted(
                registry, cache, store, connection, instrument_id=instrument_id, family=family,
                from_ns=from_ns, to_ns=to_ns, curated_prefix=curated_prefix,
                resolved_limit=resolved_limit, cursor=cursor, pointer_token=pointer_token,
                max_scan_bytes=max_scan_bytes, reader=reader, token=slot.token,
                cursor_secret=cursor_secret, client=client, telemetry=telemetry)
        finally:
            telemetry.observe("serviceMs", (time.monotonic() - service_started) * 1000.0)


def _query_admitted(registry, cache, store, connection, *, instrument_id, family, from_ns,
                    to_ns, curated_prefix, resolved_limit, cursor, pointer_token,
                    max_scan_bytes, reader, token, cursor_secret, client, telemetry):
    if token is not None:
        token.raise_if_cancelled()

    discover_started = time.monotonic()
    found = _cache_module.discover(
        registry, client=client, pointer_token=pointer_token, instrument_id=instrument_id,
        family=family, from_ns=from_ns, to_ns=to_ns, curated_prefix=curated_prefix,
        max_scan_bytes=max_scan_bytes)
    telemetry.observe("discoverMs", (time.monotonic() - discover_started) * 1000.0)

    pointer = found["pointer"]
    fingerprint = _reader.query_fingerprint(
        pointer_sha256=pointer["catalog_sha256"], instrument_id=instrument_id,
        family=family, from_ns=from_ns, to_ns=to_ns, client=client)

    after_key = None
    if cursor is not None:
        after_key = _reader.decode_cursor(
            cursor, fingerprint=fingerprint, pointer_sha256=pointer["catalog_sha256"],
            secret=cursor_secret)

    if not found["partitions"]:
        return _response(found, fingerprint, rows=[], next_cursor=None, exact_bytes=0,
                         bytes_read=0, hits=0, misses=0, parts_opened=0,
                         partitions_read=0,
                         coverage=_coverage(found, served=None, corrupt=[],
                                            served_partitions=[]))

    budget = _archive_query.MAX_SCAN_BYTES if max_scan_bytes is None else max_scan_bytes
    fetch_started = time.monotonic()
    materialised, corrupt = _materialise_serving_what_is_sound(
        store, cache, found["partitions"], budget, token=token)
    fetch_ms = (time.monotonic() - fetch_started) * 1000.0
    telemetry.observe("fetchMs", fetch_ms)
    if materialised is not None:
        for stage, value in materialised["stageMs"].items():
            telemetry.observe(stage, value)

    resume_partition = _cursor_resumes_from_corrupt_partition(
        after_key, found["partitions"], corrupt)
    if resume_partition is not None:
        raise ArchiveQueryError(_cache_module.PARTITION_VERIFICATION_FAILED,
                                reason="CURSOR_RESUME_PARTITION_CORRUPT",
                                date=resume_partition["date"])

    if materialised is None:
        return _response(found, fingerprint, rows=[], next_cursor=None, exact_bytes=0,
                         bytes_read=0, hits=0, misses=0, parts_opened=0,
                         partitions_read=0,
                         fetch_ms=fetch_ms,
                         coverage=_coverage(found, served=None, corrupt=corrupt,
                                            served_partitions=[]))

    served_partitions = {id(part["partition"]): part["partition"]
                         for part in materialised["parts"]}.values()
    try:
        if token is not None:
            token.raise_if_cancelled()
        query_started = time.monotonic()
        parts = _reader_parts(connection, materialised)
        secret = _reader._cursor_secret(cursor_secret)
        wire_fields = _archive_query.wire_fields(found["family"])
        request = {
            "parts": parts, "fromNs": str(int(from_ns)), "toNs": str(int(to_ns)),
            "limit": resolved_limit, "afterKey": list(after_key) if after_key else None,
            "fingerprint": fingerprint, "pointerSha256": pointer["catalog_sha256"],
            "cursorSecret": secret.hex(),
            **({"wireFields": list(wire_fields)} if wire_fields is not None else {}),
        }
        if reader is None:
            acquire_started = time.monotonic()
            with reader_pool(cache.root).acquire() as bridge:
                round_trip_started = time.monotonic()
                telemetry.observe("readerAcquireMs", (round_trip_started - acquire_started) * 1000.0)
                page = bridge.read_page(request, cancel_token=token)
                telemetry.observe("readerRoundTripMs", (time.monotonic() - round_trip_started) * 1000.0)
        elif isinstance(reader, _reader_bridge.ReaderBridge):
            page = reader.read_page(request, cancel_token=token)
        else:
            page = reader.read_page(
                connection, parts, from_ns=int(from_ns), to_ns=int(to_ns),
                limit=resolved_limit, after_key=after_key, fingerprint=fingerprint,
                pointer_sha256=pointer["catalog_sha256"], cursor_secret=cursor_secret,
                wire_fields=wire_fields)
    finally:
        _cache_module.release_materialised(cache, materialised)
    query_ms = (time.monotonic() - query_started) * 1000.0
    telemetry.observe("queryMs", query_ms)

    return _response(found, fingerprint, rows=page["rows"], next_cursor=page["nextCursor"],
                     exact_bytes=materialised["exactScanBytes"],
                     bytes_read=materialised["bytesRead"],
                     hits=materialised["cacheHits"], misses=materialised["cacheMisses"],
                     parts_opened=page["partsOpened"],
                     partitions_read=materialised["partitionsRead"],
                     fetch_ms=fetch_ms, query_ms=query_ms,
                         coverage=_coverage(found, served=_served_window(page, found["family"], found["selection"]["requested"]),
                                            corrupt=corrupt, served_partitions=list(served_partitions)))


def _response(found, fingerprint, *, rows, next_cursor, exact_bytes, bytes_read,
              hits, misses, parts_opened, coverage, partitions_read, fetch_ms=0.0, query_ms=0.0):
    return {
        "contractVersion": CONTRACT_VERSION,
        "pointer": found["pointer"],
        "pointerToken": found["pointerToken"],
        "family": found["family"],
        "rows": _archive_query.with_declared_candle_fields(found["family"], rows),
        "nextCursor": next_cursor,
        "queryFingerprint": fingerprint,
        "coverage": coverage,
        "scan": {
            "partitionsRead": partitions_read,
            "partitionsSelected": found["selection"]["partitions"],
            "partsOpened": parts_opened,
            "exactScanBytes": exact_bytes,
            "bytesRead": bytes_read,
            "cacheHits": hits,
            "cacheMisses": misses,
            "fetchMs": fetch_ms,
            "queryMs": query_ms,
        },
    }
