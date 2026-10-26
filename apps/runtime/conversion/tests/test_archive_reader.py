from __future__ import annotations

import base64
import decimal
import hashlib
import hmac
import json

import duckdb
import pytest

import archive_reader as ar
from writer import SORT_KEY

FP = "a" * 64
PSHA = "b" * 64
BASE = 1_756_684_800_000_000_000


def _fingerprint(**overrides):
    kwargs = {"pointer_sha256": PSHA, "instrument_id": "iid", "family": "trade",
              "from_ns": "1", "to_ns": "2", "client": "client-a"}
    kwargs.update(overrides)
    return ar.query_fingerprint(**kwargs)


def _write_parts(tmp_path, groups):
    """Each group becomes one Parquet part, written sorted by the canonical key,
    mirroring how writer.py produces them."""
    con = duckdb.connect()
    parts = []
    for index, rows in enumerate(groups):
        path = str(tmp_path / f"part-{index:05d}.parquet")
        values = ", ".join(
            f"({e}::UBIGINT, {s}::USMALLINT, {p}::UBIGINT, {o}::UINTEGER, "
            f"'rec-{e}-{s}-{p}-{o}', 1.5::DECIMAL(38,12))"
            for e, s, p, o in rows)
        con.execute(
            f"COPY (SELECT * FROM (VALUES {values}) "
            f"AS t(event_ns, source_rank, stable_position, ordinal, record_id, price) "
            f"ORDER BY {', '.join(SORT_KEY)}) TO '{path}' (FORMAT PARQUET)")
        parts.append({"path": path,
                      "event_ns_min": str(min(r[0] for r in rows)),
                      "event_ns_max": str(max(r[0] for r in rows))})
    con.close()
    return parts


def _read_all(connection, parts, *, limit, from_ns=0, to_ns=BASE * 2):
    """Page through the whole window and concatenate, as a caller would."""
    collected, cursor_key, pages = [], None, 0
    while True:
        page = ar.read_page(connection, parts, from_ns=from_ns, to_ns=to_ns, limit=limit,
                            after_key=cursor_key, fingerprint=FP, pointer_sha256=PSHA)
        collected.extend(page["rows"])
        pages += 1
        if page["nextCursor"] is None:
            return collected, pages
        cursor_key = ar.decode_cursor(page["nextCursor"], fingerprint=FP, pointer_sha256=PSHA)
        assert pages < 10_000, "paging did not terminate"


@pytest.fixture
def connection():
    con = ar.connect()
    yield con
    con.close()


def test_importing_the_reader_shrinks_duckdbs_default_connection_to_one_thread():
    # Gate E GE-12: `import duckdb` opens a default connection with one thread
    # per core. Every archive-query process imports the reader, so on the 32-core
    # host 31 idle threads per process filled the unit's TasksMax=128 and new
    # queries died with "can't start new thread". A fresh interpreter proves the
    # import alone does it.
    import os
    import subprocess
    import sys

    probe = ("import archive_reader, duckdb; "
             "print(duckdb.default_connection().execute(\"select current_setting('threads')\").fetchone()[0])")
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = dict(os.environ, PYTHONPATH=os.pathsep.join([here, os.environ.get("PYTHONPATH", "")]))
    result = subprocess.run([sys.executable, "-c", probe], cwd=here, env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "1"


# ------------------------------------------------------------------ cursors

def test_a_cursor_round_trips_the_exact_key():
    key = (BASE, 0, 5, 0)
    token = ar.encode_cursor(FP, PSHA, key)
    assert ar.decode_cursor(token, fingerprint=FP, pointer_sha256=PSHA) == key


def test_a_cursor_issued_for_another_query_is_refused():
    # One catalog covers every instrument and family, so a cursor bound only to
    # the pointer would satisfy a pointer check while paginating a different
    # query -- returning wrong rows rather than an error.
    token = ar.encode_cursor(_fingerprint(family="trade"), PSHA, (BASE, 0, 1, 0))

    with pytest.raises(ar.ArchiveQueryError) as raised:
        ar.decode_cursor(token, fingerprint=_fingerprint(family="quote"), pointer_sha256=PSHA)

    assert raised.value.code == ar.CURSOR_POINTER_MISMATCH


def test_a_cursor_cannot_be_rewritten_to_skip_rows():
    token = ar.encode_cursor(FP, PSHA, (BASE, 0, 1, 0))
    raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    payload = json.loads(raw)
    payload["eventNs"] = str(BASE + 999)
    forged = base64.urlsafe_b64encode(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")

    with pytest.raises(ar.ArchiveQueryError) as raised:
        ar.decode_cursor(forged, fingerprint=FP, pointer_sha256=PSHA)

    assert raised.value.code == ar.CURSOR_MALFORMED
    assert raised.value.detail["reason"] == "UNAUTHENTICATED"


def test_an_expired_cursor_is_refused_before_its_position_is_used():
    token = ar.encode_cursor(FP, PSHA, (BASE, 0, 1, 0), now=100, ttl_seconds=1)

    with pytest.raises(ar.ArchiveQueryError) as raised:
        ar.decode_cursor(token, fingerprint=FP, pointer_sha256=PSHA, now=101)

    assert raised.value.code == ar.CURSOR_MALFORMED
    assert raised.value.detail["reason"] == "EXPIRED"


def test_the_fingerprint_changes_with_every_part_of_the_query_identity():
    baseline = _fingerprint()
    for field, value in (("instrument_id", "other"), ("family", "quote"),
                         ("from_ns", "99"), ("to_ns", "98"), ("pointer_sha256", "c" * 64),
                         ("client", "client-b")):
        assert _fingerprint(**{field: value}) != baseline, field


def test_a_fingerprint_without_a_client_is_refused_rather_than_shared():
    # A falsy client must not quietly produce a fingerprint every caller shares,
    # which is what a default would have done.
    for value in ("", None, 17):
        with pytest.raises(ValueError):
            _fingerprint(client=value)


@pytest.mark.parametrize("token,reason", [
    ("", "SHAPE"), (None, "SHAPE"), ("x" * 600, "SHAPE"),
    ("!!!not-base64!!!", "UNDECODABLE"),
])
def test_a_malformed_cursor_is_refused(token, reason):
    with pytest.raises(ar.ArchiveQueryError) as raised:
        ar.decode_cursor(token, fingerprint=FP, pointer_sha256=PSHA)
    assert raised.value.code == ar.CURSOR_MALFORMED


def test_a_cursor_carrying_extra_or_missing_fields_is_refused():
    payload = {"queryFingerprint": FP, "pointerSha256": PSHA, "eventNs": "1",
               "sourceRank": 0, "stablePosition": "1", "ordinal": 0, "extra": True}
    token = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")

    with pytest.raises(ar.ArchiveQueryError) as raised:
        ar.decode_cursor(token, fingerprint=FP, pointer_sha256=PSHA)
    assert raised.value.detail["reason"] == "UNEXPECTED_FIELDS"


@pytest.mark.parametrize("field,value", [
    ("eventNs", 1), ("eventNs", "1.5"), ("stablePosition", "٣"),
    ("sourceRank", "0"), ("ordinal", True), ("sourceRank", -1),
])
def test_a_cursor_key_that_is_not_an_exact_value_is_refused(field, value):
    # A non-ASCII digit passes str.isdigit() and would reach int() as a number
    # nobody wrote; a JSON number has already lost precision past 2^53.
    original = ar.encode_cursor(FP, PSHA, (1, 0, 1, 0))
    payload = json.loads(base64.urlsafe_b64decode(original + "=" * (-len(original) % 4)))
    payload[field] = value
    unsigned = dict(payload)
    unsigned.pop("tag")
    payload["tag"] = hmac.new(
        ar._CURSOR_SECRET, json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode(),
        hashlib.sha256).hexdigest()
    token = base64.urlsafe_b64encode(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")

    with pytest.raises(ar.ArchiveQueryError) as raised:
        ar.decode_cursor(token, fingerprint=FP, pointer_sha256=PSHA)
    assert raised.value.code == ar.CURSOR_MALFORMED


# ------------------------------------------------------------- part skipping

def test_a_cursor_skips_parts_it_is_already_past(tmp_path, connection):
    parts = _write_parts(tmp_path, [
        [(BASE + i, 0, i, 0) for i in range(10)],
        [(BASE + 100 + i, 0, i, 0) for i in range(10)],
        [(BASE + 200 + i, 0, i, 0) for i in range(10)],
    ])

    page = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=5,
                        after_key=(BASE + 205, 0, 5, 0), fingerprint=FP, pointer_sha256=PSHA)

    assert page["partsCandidate"] == 1, "two earlier parts are skipped without being opened"
    assert page["partsOpened"] == 1
    assert [int(r["event_ns"]) for r in page["rows"]] == [BASE + 206, BASE + 207, BASE + 208, BASE + 209]


def test_only_the_parts_a_page_needs_are_opened(tmp_path, connection):
    parts = _write_parts(tmp_path, [[(BASE + g * 100 + i, 0, i, 0) for i in range(10)]
                                    for g in range(6)])

    page = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=3,
                        fingerprint=FP, pointer_sha256=PSHA)

    assert page["partsCandidate"] == 6
    assert page["partsOpened"] == 1, "a small page must not open every part"


# --------------------------------------------------- the page-seam invariant

@pytest.mark.parametrize("limit", [1, 2, 3, 7, 10, 1000])
def test_concatenated_pages_equal_an_independent_sorted_read(tmp_path, connection, limit):
    # The binding invariant. Ties are the hazard and they are not rare: 23.2% of
    # real trade rows share an event_ns with another row, in groups up to 54.
    groups = [
        [(BASE, 0, 1, 0), (BASE, 0, 1, 1), (BASE, 0, 2, 0), (BASE, 1, 0, 0), (BASE + 1, 0, 0, 0)],
        [(BASE + 50, 0, 0, 0)] + [(BASE + 51, 0, 0, i) for i in range(8)],
        [(BASE + 90, 0, 0, 0), (BASE + 90, 0, 0, 1)],
    ]
    parts = _write_parts(tmp_path, groups)
    expected = sorted(row for group in groups for row in group)

    collected, pages = _read_all(connection, parts, limit=limit)

    actual = [(int(r["event_ns"]), r["source_rank"], int(r["stable_position"]), r["ordinal"])
              for r in collected]
    assert actual == expected, f"limit={limit} lost or duplicated rows at a page seam"
    assert len(actual) == len(set(actual)), "a row was served twice"


def test_a_projected_page_emits_only_the_declared_fields(tmp_path, connection):
    parts = _write_parts(tmp_path, [[(BASE, 0, 1, 0), (BASE + 1, 0, 0, 0)]])

    page = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=10,
                        fingerprint=FP, pointer_sha256=PSHA, wire_fields=("event_ns", "price"))

    assert [sorted(row) for row in page["rows"]] == [["event_ns", "price"], ["event_ns", "price"]]
    assert page["rows"][0]["price"] == "1.500000000000"


def test_a_projection_that_omits_the_sort_key_still_pages_without_losing_a_row(tmp_path, connection):
    # The cursor is a row-value comparison over SORT_KEY, so those columns are
    # read whatever the wire asks for. A projection that dropped one would
    # resume from the wrong row while every ordering assertion still passed.
    tied = [(BASE, 0, 0, i) for i in range(9)]
    parts = _write_parts(tmp_path, [tied])
    collected, cursor_key, pages = [], None, 0
    while True:
        page = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=2,
                            after_key=cursor_key, fingerprint=FP, pointer_sha256=PSHA,
                            wire_fields=("event_ns", "price"))
        collected.extend(page["rows"])
        pages += 1
        assert all(sorted(row) == ["event_ns", "price"] for row in page["rows"])
        if page["nextCursor"] is None:
            break
        cursor_key = ar.decode_cursor(page["nextCursor"], fingerprint=FP, pointer_sha256=PSHA)
        assert pages < 100

    assert len(collected) == len(tied)
    unprojected, _ = _read_all(connection, parts, limit=2)
    assert [row["event_ns"] for row in collected] == [row["event_ns"] for row in unprojected]


def test_a_family_without_a_projection_still_carries_every_column(tmp_path, connection):
    parts = _write_parts(tmp_path, [[(BASE, 0, 1, 0)]])

    page = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=10,
                        fingerprint=FP, pointer_sha256=PSHA)

    assert sorted(page["rows"][0]) == sorted(
        ["event_ns", "source_rank", "stable_position", "ordinal", "record_id", "price"])


def test_a_tied_group_split_across_a_page_boundary_is_not_dropped(tmp_path, connection):
    # 54 rows on one timestamp is the largest tied group measured in real trade
    # data. Paging through it two at a time puts 26 boundaries inside one tie.
    tied = [(BASE, 0, 0, i) for i in range(54)]
    parts = _write_parts(tmp_path, [tied])

    collected, pages = _read_all(connection, parts, limit=2)

    assert [r["ordinal"] for r in collected] == list(range(54))
    assert pages == 28


def test_the_window_is_half_open_at_the_page_level(tmp_path, connection):
    parts = _write_parts(tmp_path, [[(BASE, 0, 0, 0), (BASE + 1, 0, 0, 0), (BASE + 2, 0, 0, 0)]])

    page = ar.read_page(connection, parts, from_ns=BASE, to_ns=BASE + 2, limit=10,
                        fingerprint=FP, pointer_sha256=PSHA)

    assert [int(r["event_ns"]) for r in page["rows"]] == [BASE, BASE + 1], "to is exclusive"


def test_a_final_page_that_exactly_fills_the_limit_terminates(tmp_path, connection):
    # A page filled to the limit issues a cursor even when nothing follows, so
    # the next page must come back empty and end the walk rather than loop.
    parts = _write_parts(tmp_path, [[(BASE + i, 0, 0, 0) for i in range(4)]])

    collected, pages = _read_all(connection, parts, limit=4)

    assert len(collected) == 4 and pages == 2


# ------------------------------------------------------------ serialisation

def test_exact_values_cross_the_boundary_as_strings(tmp_path, connection):
    parts = _write_parts(tmp_path, [[(BASE, 0, 9_007_199_254_740_993, 0)]])

    row = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=1,
                       fingerprint=FP, pointer_sha256=PSHA)["rows"][0]

    assert row["event_ns"] == str(BASE), "UBIGINT exceeds 2^53 and must not be a JSON number"
    assert row["stable_position"] == "9007199254740993"
    assert row["price"] == "1.500000000000", "DECIMAL keeps its exact scale"
    assert row["source_rank"] == 0 and isinstance(row["source_rank"], int)
    assert row["ordinal"] == 0 and isinstance(row["ordinal"], int)


def _write_unsorted_part(tmp_path, rows):
    """A part whose rows are not in canonical order -- what a writer regression
    or a damaged file looks like from the reader's side."""
    con = duckdb.connect()
    path = str(tmp_path / "part-00000.parquet")
    values = ", ".join(
        f"({e}::UBIGINT, {s}::USMALLINT, {p}::UBIGINT, {o}::UINTEGER, "
        f"'rec-{e}-{s}-{p}-{o}', 1.5::DECIMAL(38,12))" for e, s, p, o in rows)
    con.execute(
        f"COPY (SELECT * FROM (VALUES {values}) "
        f"AS t(event_ns, source_rank, stable_position, ordinal, record_id, price)) "
        f"TO '{path}' (FORMAT PARQUET)")
    con.close()
    return [{"path": path, "event_ns_min": str(min(r[0] for r in rows)),
             "event_ns_max": str(max(r[0] for r in rows))}]


def test_a_page_served_out_of_order_is_refused_rather_than_returned(tmp_path, connection):
    # Reading relies on the order the parts were written in, which every
    # measured partition satisfies. If that ever stops being true the rows are
    # silently wrong, so the reader must refuse the page rather than return it.
    parts = _write_unsorted_part(tmp_path, [(BASE + 5, 0, 0, 0), (BASE + 1, 0, 0, 0)])

    with pytest.raises(ar.ArchiveQueryError) as raised:
        ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=10,
                     fingerprint=FP, pointer_sha256=PSHA)

    assert raised.value.code == ar.PARTITION_VERIFICATION_FAILED
    assert raised.value.detail["reason"] == "ROWS_OUT_OF_CANONICAL_ORDER"


def test_a_page_stops_on_bytes_before_it_overflows_the_frame(tmp_path, connection):
    # Measured on the production archive: 10,000 trade rows serialise to 14.81 MB
    # against a 16 MB frame, and depth carries level arrays and is wider again.
    # A row cap alone cannot bound the transport, so bytes bind too.
    parts = _write_parts(tmp_path, [[(BASE + i, 0, i, 0) for i in range(200)]])

    page = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=200,
                        fingerprint=FP, pointer_sha256=PSHA, max_page_bytes=400)

    assert page["truncatedByBytes"] is True
    assert 0 < len(page["rows"]) < 200
    assert page["pageBytes"] <= 400
    assert page["nextCursor"] is not None, "a byte-truncated page must be resumable"


def test_a_byte_truncated_walk_still_concatenates_to_the_whole_window(tmp_path, connection):
    rows = [(BASE + i, 0, i, 0) for i in range(120)]
    parts = _write_parts(tmp_path, [rows])

    collected, cursor_key, pages = [], None, 0
    while True:
        page = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=1000,
                            after_key=cursor_key, fingerprint=FP, pointer_sha256=PSHA,
                            max_page_bytes=500)
        collected.extend(page["rows"])
        pages += 1
        if page["nextCursor"] is None:
            break
        cursor_key = ar.decode_cursor(page["nextCursor"], fingerprint=FP, pointer_sha256=PSHA)
        assert pages < 500

    assert [int(r["event_ns"]) for r in collected] == [r[0] for r in rows]
    assert pages > 1, "the budget must actually have split the walk"


def test_one_row_larger_than_the_whole_budget_is_still_served(tmp_path, connection):
    # Otherwise a single oversized row stalls the walk forever: every page would
    # return nothing and re-issue the same cursor.
    parts = _write_parts(tmp_path, [[(BASE, 0, 1, 0), (BASE + 1, 0, 2, 0)]])

    page = ar.read_page(connection, parts, from_ns=0, to_ns=BASE * 2, limit=10,
                        fingerprint=FP, pointer_sha256=PSHA, max_page_bytes=1)

    assert len(page["rows"]) == 1, "progress is made even when no row fits the budget"
    assert page["nextCursor"] is not None


def test_the_reader_uses_the_writers_sort_key_not_a_copy():
    assert ar.SORT_KEY is SORT_KEY
    assert SORT_KEY == ("event_ns", "source_rank", "stable_position", "ordinal")


def test_nested_depth_decimals_are_safe_for_the_json_transport():
    levels = [{"price": decimal.Decimal("25123.250000000000"),
               "size": decimal.Decimal("4.000000000000")}]

    serialised = ar._serialise(levels, "STRUCT(price DECIMAL(38,12), size DECIMAL(38,12))[]")

    assert serialised == [{"price": "25123.250000000000", "size": "4.000000000000"}]
    assert json.dumps(serialised, separators=(",", ":"))
