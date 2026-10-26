from __future__ import annotations

import json
from pathlib import Path

import pytest

import archive_query as aq

SCHEMA_PATH = (
    Path(__file__).resolve().parents[4]
    / "docs/contracts/archive-query/v1/archive-query-v1.schema.json"
)


def _defs():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))["$defs"]


def _consts(name):
    return {family: spec["const"] for family, spec in _defs()[name]["properties"].items()}


# The contract states the schema is "the authority for every bound", but the
# engine held its own literals and nothing compared the two. Proven by mutation:
# moving the schema's cap to 64 MiB left archive_query admitting 256 MiB with the
# whole discovery suite green. Node and Python cannot share a module across this
# boundary, so -- exactly as ws-frame-contract-limits.test.js does for the
# runtime/web boundary -- an enforced reconciliation stands in for the shared
# constant that is not available.


def test_the_scan_budget_matches_the_schema():
    defs = _defs()
    assert aq.MAX_SCAN_BYTES == defs["scanBytes"]["maximum"]
    assert aq.MAX_SCAN_BYTES == defs["scanBytesDefault"]["const"]
    assert aq.MAX_SCAN_BYTES == defs["targets"]["properties"]["synchronousMaxScanBytes"]["const"]


def test_the_page_limits_match_the_schema():
    defs = _defs()
    assert aq.MAX_LIMIT == defs["limit"]["maximum"]
    assert aq.DEFAULT_LIMIT == defs["limit"]["default"]
    assert aq.DEFAULT_LIMIT == defs["targets"]["properties"]["defaultPageLimit"]["const"]


def test_the_family_set_matches_the_schema():
    assert sorted(aq.FAMILIES) == sorted(_defs()["family"]["enum"])


@pytest.mark.parametrize("family", sorted(aq.WINDOW_LIMIT_NS))
def test_every_window_cap_matches_the_schema(family):
    # These lived only in module constants and in prose. Node serves the terminal
    # and needs to refuse an oversized window before a round trip; prose is not
    # consumable, so the caps are declared in the schema and bound here.
    assert str(aq.WINDOW_LIMIT_NS[family]) == _consts("windowLimitNs")[family]


def test_the_schema_declares_a_window_cap_for_every_supported_family():
    assert sorted(_consts("windowLimitNs")) == sorted(aq.FAMILIES)
    assert sorted(aq.WINDOW_LIMIT_NS) == sorted(aq.FAMILIES)


@pytest.mark.parametrize("family", sorted(aq.BYTES_PER_ROW))
def test_every_bytes_per_row_rate_matches_the_schema(family):
    assert aq.BYTES_PER_ROW[family] == _consts("bytesPerRow")[family]


def test_the_schema_and_the_engine_agree_on_which_rates_are_uncalibrated():
    assert sorted(aq.UNVERIFIED_BYTES_PER_ROW) == sorted(_defs()["bytesPerRowUnverified"]["const"])


# The same drift this file exists to prevent recurred for every constant added
# after step 1: the cache bounds, the admission limits, the cursor and frame
# sizes were all declared in prose or in Python and bound to nothing. Worse, an
# earlier `cacheLimits` block was dropped entirely by a later schema rewrite and
# nothing noticed, because nothing read it. Every operator-visible bound below
# is now anchored to the schema.

def test_the_cache_bounds_match_the_schema():
    import archive_cache
    consts = _consts("cacheLimits")
    assert archive_cache.MAX_CACHE_BYTES == consts["maxCacheBytes"]
    assert archive_cache.MIN_FREE_DISK_BYTES == consts["minFreeDiskBytes"]
    assert archive_cache.FETCH_CONCURRENCY == consts["fetchConcurrency"]
    assert archive_cache.SNAPSHOT_TTL_SECONDS == consts["snapshotTtlSeconds"]
    assert archive_cache.MAX_SNAPSHOT_ENTRIES == consts["maxSnapshotEntries"]
    assert archive_cache.MAX_SNAPSHOT_ENTRIES_PER_CLIENT == consts["maxSnapshotEntriesPerClient"]


def test_the_admission_limits_match_the_schema():
    import archive_admission
    consts = _consts("admissionLimits")
    assert archive_admission.MAX_CONCURRENT_READS == consts["maxConcurrentReads"]
    assert archive_admission.MAX_QUEUED == consts["maxQueued"]
    assert archive_admission.MAX_QUEUE_WAIT_MS == consts["maxQueueWaitMs"]
    assert archive_admission.RATE_LIMIT_MAX == consts["rateLimitMax"]
    assert archive_admission.RATE_LIMIT_WINDOW_MS == consts["rateLimitWindowMs"]


def test_the_reader_transport_bounds_match_the_schema():
    import archive_reader
    consts = _consts("readerLimits")
    assert archive_reader.MAX_FRAME_BYTES == consts["maxFrameBytes"]
    assert archive_reader.MAX_PAGE_BYTES == consts["maxPageBytes"]
    assert archive_reader.MAX_CURSOR_BYTES == consts["maxCursorBytes"]
    assert archive_reader.CURSOR_TTL_SECONDS == consts["cursorTtlSeconds"]
    assert archive_reader.READER_THREADS == consts["readerThreads"]
    assert archive_reader.READER_TEMP_BYTES == consts["maxTempDirectoryBytes"]


def test_the_http_transport_bounds_and_refusal_statuses_match_the_schema():
    import archive_http

    defs = _defs()
    limits = _consts("httpLimits")
    statuses = {code: spec["const"] for code, spec in defs["httpStatusByError"]["properties"].items()}
    assert archive_http.MAX_REQUEST_BYTES == limits["maxRequestBytes"]
    assert archive_http.REQUEST_BODY_TIMEOUT_S == limits["requestBodyTimeoutSeconds"]
    assert archive_http.MAX_INBOUND_HANDLERS == limits["maxInboundHandlers"]
    assert archive_http.REFUSAL_STATUS == statuses
    assert set(statuses) == set(defs["errorCode"]["enum"])


def test_the_socket_bound_is_looser_than_the_reader_bound():
    # Two different things: admission bounds reader work, the semaphore bounds
    # HTTP handler threads. If the socket bound were the tighter of the two it
    # would refuse requests admission would have accepted, and a queue that
    # exists to absorb bursts would never be reached.
    import archive_admission
    import archive_http

    limits = _consts("httpLimits")
    admission = _consts("admissionLimits")
    assert limits["maxInboundHandlers"] > admission["maxConcurrentReads"]
    assert archive_http.MAX_INBOUND_HANDLERS > archive_admission.MAX_CONCURRENT_READS


def test_every_schema_valid_request_fits_inside_the_http_body_limit():
    import archive_http
    import jsonschema

    defs = _defs()
    request = {
        "contractVersion": "archive-query/1",
        "instrumentId": "\U0010ffff" * 256,
        "family": "candle",
        "from": "9" * 20,
        "to": "8" * 20,
        "limit": 10000,
        "cursor": "x" * defs["cursor"]["maxLength"],
        "maxScanBytes": aq.MAX_SCAN_BYTES,
        "pointerToken": "x" * defs["pointerToken"]["maxLength"],
    }
    jsonschema.validate(request, {**defs["request"], "$defs": defs})
    body = json.dumps(request, separators=(",", ":"), ensure_ascii=True).encode()
    assert len(body) <= archive_http.MAX_REQUEST_BYTES


def test_the_cursor_length_bound_is_one_number_not_two():
    import archive_reader
    assert archive_reader.MAX_CURSOR_BYTES == _defs()["cursor"]["maxLength"]


def test_the_worker_and_the_reader_agree_on_the_frame_size():
    # The worker enforces the frame bound the reader budgets against; two
    # independent copies could drift into a page the transport cannot carry.
    import archive_reader, archive_reader_worker, archive_reader_bridge
    assert archive_reader_worker.MAX_FRAME_BYTES == archive_reader.MAX_FRAME_BYTES
    assert archive_reader_bridge.MAX_FRAME_BYTES == archive_reader.MAX_FRAME_BYTES


def test_a_full_page_cannot_exceed_the_frame_it_must_travel_in():
    # Measured: 10,000 trade rows are 14.81 MB. The page budget must leave room
    # for the response envelope inside the frame, or a legal page is unsendable.
    import archive_reader
    assert archive_reader.MAX_PAGE_BYTES < archive_reader.MAX_FRAME_BYTES


def test_every_error_the_engine_raises_is_declared_by_the_contract():
    declared = set(_defs()["errorCode"]["enum"])
    raised = {aq.INVALID_WINDOW, aq.UNKNOWN_INSTRUMENT, aq.UNSUPPORTED_FAMILY,
              aq.RANGE_TOO_LARGE, aq.WINDOW_TOO_LARGE, aq.CATALOG_INTEGRITY_FAILURE,
              aq.ESTIMATE_UNVERIFIED}
    import archive_admission, archive_cache, archive_reader, archive_reader_bridge
    raised.update({
        archive_admission.CANCELLED,
        archive_admission.OVERLOADED,
        archive_cache.CACHE_CAPACITY_EXCEEDED,
        archive_cache.PARTITION_VERIFICATION_FAILED,
        archive_cache.POINTER_TOKEN_INVALID,
        archive_reader.CURSOR_MALFORMED,
        archive_reader.CURSOR_POINTER_MISMATCH,
        archive_reader_bridge.READER_UNAVAILABLE,
    })
    assert raised <= declared, sorted(raised - declared)
