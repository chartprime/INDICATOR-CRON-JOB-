from __future__ import annotations

import io
import json
import os
import struct
import threading

import duckdb
import pytest

import archive_reader as ar
import archive_admission as aa
import archive_reader_bridge as arb
import archive_reader_worker as arw
from writer import SORT_KEY

FP, PSHA = "a" * 64, "b" * 64
BASE = 1_756_684_800_000_000_000


def _part(tmp_path, rows, name="part-00000.parquet"):
    path = str(tmp_path / name)
    con = duckdb.connect()
    values = ", ".join(
        f"({e}::UBIGINT, {s}::USMALLINT, {p}::UBIGINT, {o}::UINTEGER, 'rec-{e}-{o}')"
        for e, s, p, o in rows)
    con.execute(f"COPY (SELECT * FROM (VALUES {values}) "
                f"AS t(event_ns, source_rank, stable_position, ordinal, record_id) "
                f"ORDER BY {', '.join(SORT_KEY)}) TO '{path}' (FORMAT PARQUET)")
    con.close()
    return {"path": path, "event_ns_min": str(min(r[0] for r in rows)),
            "event_ns_max": str(max(r[0] for r in rows))}


def _request(parts, **overrides):
    request = {"parts": parts, "fromNs": "0", "toNs": str(BASE * 2), "limit": 10,
               "fingerprint": FP, "pointerSha256": PSHA,
               "cursorSecret": ar._CURSOR_SECRET.hex()}
    request.update(overrides)
    return request


@pytest.fixture
def parts(tmp_path):
    return [_part(tmp_path, [(BASE + i, 0, i, 0) for i in range(8)])]


def test_a_page_crosses_the_process_boundary_intact(parts):
    with arb.ReaderBridge() as bridge:
        page = bridge.read_page(_request(parts, limit=5))

    assert [int(r["event_ns"]) for r in page["rows"]] == [BASE + i for i in range(5)]
    assert page["nextCursor"] is not None


def test_the_bridge_supplies_its_own_cursor_integrity_key(parts):
    request = _request(parts, limit=2)
    request.pop("cursorSecret")

    with arb.ReaderBridge() as bridge:
        page = bridge.read_page(request)

    assert ar.decode_cursor(page["nextCursor"], fingerprint=FP, pointer_sha256=PSHA)


def test_paging_across_the_boundary_concatenates_to_the_whole_window(parts):
    collected, cursor = [], None
    with arb.ReaderBridge() as bridge:
        for _ in range(20):
            after = None
            if cursor is not None:
                after = list(ar.decode_cursor(cursor, fingerprint=FP, pointer_sha256=PSHA))
            page = bridge.read_page(_request(parts, limit=3, afterKey=after))
            collected.extend(int(r["event_ns"]) for r in page["rows"])
            cursor = page["nextCursor"]
            if cursor is None:
                break

    assert collected == [BASE + i for i in range(8)]


def test_a_missing_cached_part_is_a_named_refusal_and_the_worker_survives(parts):
    # Parts are pinned before their paths leave the cache, so a vanished file
    # means that guarantee broke. It must fail loudly and specifically -- and
    # not by killing the reader, which tells the caller nothing it can act on.
    bad = [dict(parts[0], path=parts[0]["path"] + ".missing")]

    with arb.ReaderBridge() as bridge:
        bridge.start()
        before = bridge._process.pid

        with pytest.raises(arb.ArchiveQueryError) as raised:
            bridge.read_page(_request(bad))
        assert raised.value.code == ar.PARTITION_VERIFICATION_FAILED
        assert raised.value.detail["reason"] == "PART_MISSING_FROM_CACHE"

        page = bridge.read_page(_request(parts, limit=2))
        assert bridge._process.pid == before, "the same worker served the next request"

    assert len(page["rows"]) == 2


def test_a_dead_worker_is_an_error_never_a_short_page(parts):
    bridge = arb.ReaderBridge()
    bridge.start()
    bridge._process.kill()
    bridge._process.wait(5)

    with pytest.raises(arb.ArchiveQueryError) as raised:
        bridge.read_page(_request(parts))

    assert raised.value.code == arb.READER_UNAVAILABLE
    bridge.close()


def test_closing_stops_the_worker():
    bridge = arb.ReaderBridge()
    bridge.start()
    process = bridge._process
    bridge.close()

    assert process.poll() is not None, "the worker exits when its stdin closes"


def test_a_deadline_stops_a_worker_that_never_replies(tmp_path):
    worker = tmp_path / "never-replies.py"
    worker.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
    bridge = arb.ReaderBridge(worker_path=str(worker), deadline_s=0.05)

    with pytest.raises(arb.ArchiveQueryError) as raised:
        bridge.read_page({})

    assert raised.value.code == arb.READER_UNAVAILABLE
    assert raised.value.detail["reason"] == "RESPONSE_DEADLINE_EXCEEDED"
    assert bridge._process is None


def test_cancellation_stops_a_worker_waiting_for_a_reply(tmp_path):
    worker = tmp_path / "never-replies.py"
    worker.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
    token = aa.CancelToken()
    bridge = arb.ReaderBridge(worker_path=str(worker), deadline_s=10)
    threading.Timer(0.05, token.cancel).start()

    with pytest.raises(arb.ArchiveQueryError) as raised:
        bridge.read_page({}, cancel_token=token)

    assert raised.value.code == aa.CANCELLED
    assert bridge._process is None


def test_worker_scratch_directory_is_removed_after_exit(tmp_path):
    root = tmp_path / "scratch"
    root.mkdir()
    bridge = arb.ReaderBridge(temp_root=str(root))
    bridge.start()
    scratch = bridge._temp_dir
    assert os.path.isdir(scratch)
    bridge.close()
    assert not os.path.exists(scratch)


def test_an_oversized_request_frame_is_refused_before_it_is_written(parts):
    with arb.ReaderBridge() as bridge:
        with pytest.raises(arb.ArchiveQueryError) as raised:
            bridge.read_page(_request(parts, fingerprint="x" * (arb.MAX_FRAME_BYTES + 10)))
        assert raised.value.detail["reason"] == "REQUEST_FRAME_TOO_LARGE"


# ------------------------------------------------------------------ the pool

def test_the_pool_hands_the_same_worker_back_after_it_is_returned(parts):
    pool = arb.BridgePool(2)
    try:
        with pool.acquire() as first:
            first_pid = first._process.pid
        with pool.acquire() as second:
            assert second._process.pid == first_pid
    finally:
        pool.close()


def test_a_worker_is_never_held_by_two_callers_at_once(parts):
    # `read_page` is serialised per bridge because the frame protocol has no
    # correlation id, so a shared worker would read another caller's reply.
    pool = arb.BridgePool(1, acquire_timeout_s=0.2)
    try:
        with pool.acquire():
            with pytest.raises(arb.ArchiveQueryError) as raised:
                with pool.acquire():
                    pass
        assert raised.value.detail["reason"] == "READER_POOL_EXHAUSTED"
    finally:
        pool.close()


def test_a_closed_pool_refuses_rather_than_starting_a_worker():
    pool = arb.BridgePool(1)
    pool.close()

    with pytest.raises(arb.ArchiveQueryError) as raised:
        with pool.acquire():
            pass
    assert raised.value.detail["reason"] == "READER_POOL_CLOSED"


@pytest.mark.parametrize("size", [0, -1, True, 1.5, "2"])
def test_the_pool_refuses_a_size_that_is_not_a_positive_integer(size):
    with pytest.raises(ValueError, match="INVALID_POOL_SIZE"):
        arb.BridgePool(size)


def test_closing_the_pool_stops_its_workers(parts):
    pool = arb.BridgePool(1)
    with pool.acquire() as bridge:
        process = bridge._process
    pool.close()

    assert process.poll() is not None, "a pooled worker outlived its pool"


def test_closing_the_pool_stops_a_worker_checked_out_at_shutdown(parts):
    pool = arb.BridgePool(1)
    with pool.acquire() as bridge:
        process = bridge._process
        pool.close()
        assert process.poll() is not None, "a checked-out worker outlived its pool"


# ------------------------------------------------------------ worker framing

def test_the_worker_speaks_the_same_frame_format_as_the_converter_bridge(parts, tmp_path):
    request = _request(parts, limit=2)
    body = json.dumps(request, separators=(",", ":")).encode()
    stdin = io.BytesIO(struct.pack(">I", len(body)) + body)
    stdout = io.BytesIO()

    assert arw.main(stdin=stdin, stdout=stdout) == 0

    stdout.seek(0)
    (length,) = struct.unpack(">I", stdout.read(4))
    reply = json.loads(stdout.read(length))
    assert len(reply["ok"]["rows"]) == 2


def test_a_malformed_request_frame_is_fatal_not_ignored():
    stdin = io.BytesIO(struct.pack(">I", 5) + b"{ bad")
    stdout = io.BytesIO()

    assert arw.main(stdin=stdin, stdout=stdout) == 1

    stdout.seek(0)
    (length,) = struct.unpack(">I", stdout.read(4))
    assert "fatal" in json.loads(stdout.read(length))


def test_a_request_frame_larger_than_the_limit_is_refused():
    stdin = io.BytesIO(struct.pack(">I", arw.MAX_FRAME_BYTES + 1))
    stdout = io.BytesIO()

    assert arw.main(stdin=stdin, stdout=stdout) == 1
    stdout.seek(0)
    (length,) = struct.unpack(">I", stdout.read(4))
    assert "exceeds" in json.loads(stdout.read(length))["fatal"]


def test_closed_stdin_ends_the_worker_cleanly():
    assert arw.main(stdin=io.BytesIO(b""), stdout=io.BytesIO()) == 0


def test_an_oversized_response_is_refused_rather_than_truncated():
    # A truncated frame would hand the caller a short page it cannot detect.
    with pytest.raises(ValueError, match="exceeds"):
        arw.write_frame(io.BytesIO(), {"ok": {"blob": "x" * (arw.MAX_FRAME_BYTES + 100)}})


def test_an_oversized_page_returns_a_named_error_without_killing_the_worker(monkeypatch):
    monkeypatch.setattr(arw, "handle", lambda *_args: {"blob": "x" * (arw.MAX_FRAME_BYTES + 100)})
    request = json.dumps({}).encode()
    stdin = io.BytesIO(struct.pack(">I", len(request)) + request)
    stdout = io.BytesIO()

    assert arw.main(stdin=stdin, stdout=stdout) == 0

    stdout.seek(0)
    (length,) = struct.unpack(">I", stdout.read(4))
    reply = json.loads(stdout.read(length))
    assert reply["error"] == "READER_UNAVAILABLE"
    assert reply["detail"]["reason"] == "RESPONSE_FRAME_TOO_LARGE"
