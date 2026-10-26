"""Paging and the part cache must not change what the archive returns.

Properties, each with its oracle:

* Page-size transparency. The rows a client reads by paging through the real
  Node gateway and the real Python service are the same rows, in the same
  order, whatever page size it asks for. Oracle: the twelve event times the
  fixture published (an independent list, not a second run of the code), plus a
  digest of the full rows compared across page sizes.
* Page shape is pinned, not just tolerated: a query whose row count is an
  exact multiple of the page size ends with one extra EMPTY terminal page (the
  server cannot know a full page was the last), while a non-multiple ends on a
  short page. That extra round trip is a cost, not a correctness defect.
* Cache transparency. A cold cache (parts fetched from the object store) and a
  warm one (parts already local) serve identical pages. Oracle: the same
  published rows; the `scan` counters prove the two runs really were cold and
  warm, so the test cannot pass by never exercising the cache.

Deliberately excluded from the comparison: `scan` (timings and byte counts
differ by design), `pointerToken` and `nextCursor` (issued per request with an
expiry). Their presence is still asserted.
"""
from __future__ import annotations

import hashlib
import json

import pytest

from test_archive_http import _query, _through_real_node_gateway, served  # noqa: F401
from test_archive_service import BASE, rig  # noqa: F401

PUBLISHED_EVENT_NS = [BASE + index for index in range(6)] + [BASE + 100 + index for index in range(6)]
VOLATILE = ("scan", "pointerToken", "nextCursor")


def _gateway(served, limit):
    result = _through_real_node_gateway(served["base"] + "/query", _query(limit=limit))
    assert all(page["status"] == 200 for page in result["pages"]), [page["body"] for page in result["pages"]]
    return [page["body"] for page in result["pages"]]


def _rows(pages):
    return [row for page in pages for row in page["rows"]]


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _stable(page):
    return {key: value for key, value in page.items() if key not in VOLATILE}


def test_no_page_size_changes_the_rows_the_client_reads(served):
    baseline_pages = _gateway(served, 1000)
    baseline_rows = _rows(baseline_pages)
    assert [int(row["event_ns"]) for row in baseline_rows] == PUBLISHED_EVENT_NS
    assert len(baseline_pages) == 1

    for limit, expected_row_counts in ((1, [1] * 12 + [0]), (2, [2] * 6 + [0]), (5, [5, 5, 2])):
        pages = _gateway(served, limit)
        assert [len(page["rows"]) for page in pages] == expected_row_counts, f"limit {limit}"
        assert all(len(page["rows"]) <= limit for page in pages)
        assert [int(row["event_ns"]) for row in _rows(pages)] == PUBLISHED_EVENT_NS, f"limit {limit}"
        assert _digest(_rows(pages)) == _digest(baseline_rows), f"limit {limit}"
        assert [page["nextCursor"] is None for page in pages] == [False] * (len(pages) - 1) + [True]
        for page in pages:
            assert page["pointerToken"]
            assert page["pointer"] == baseline_pages[0]["pointer"]
            assert page["queryFingerprint"] == baseline_pages[0]["queryFingerprint"]
            assert page["coverage"]["requested"] == baseline_pages[0]["coverage"]["requested"]
            page_times = [int(row["event_ns"]) for row in page["rows"]]
            if page_times:
                window = page["coverage"]["served"]
                assert (int(window["from"]), int(window["to"])) == (page_times[0], page_times[-1] + 1), f"limit {limit}"


def test_a_cold_cache_and_a_warm_cache_serve_identical_pages(served):
    cold = _gateway(served, 5)
    warm = _gateway(served, 5)

    assert cold[0]["scan"]["cacheMisses"] > 0 and cold[0]["scan"]["cacheHits"] == 0
    assert warm[0]["scan"]["cacheMisses"] == 0 and warm[0]["scan"]["cacheHits"] > 0

    assert [_stable(page) for page in cold] == [_stable(page) for page in warm]
    assert [int(row["event_ns"]) for row in _rows(warm)] == PUBLISHED_EVENT_NS
    assert all(page["pointerToken"] for page in cold + warm)
