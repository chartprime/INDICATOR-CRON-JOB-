"""Isolated archive reader: length-prefixed JSON frames over stdin and stdout.

One worker per concurrent read. Process isolation is a measured requirement,
not a preference: eight readers sharing a process measured p95 800 ms against
491 ms across separate processes here, and W6.03 recorded the same shape far
more starkly at 5.58 s versus 101.5 ms. The GIL serialises row serialisation,
which is the part of a page read that cannot release it.

This is `scripts/convert/contract-worker.js` inverted. There Node holds the
contract and Python asks; here Python holds the reader and the caller asks. The
frame format is deliberately identical -- a four-byte big-endian length then a
JSON body -- so one protocol serves both directions of the boundary.

A crash, a malformed request or an oversized response is an error frame and a
non-zero exit, never a silent short page.
"""
from __future__ import annotations

import json
import os
import struct
import sys
import traceback

import duckdb

import archive_reader as _reader

MAX_FRAME_BYTES = _reader.MAX_FRAME_BYTES


def _read_exact(stream, count):
    chunks, remaining = [], count
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream):
    header = _read_exact(stream, 4)
    if header is None:
        return None
    (length,) = struct.unpack(">I", header)
    if length > MAX_FRAME_BYTES:
        raise ValueError(f"request frame {length} exceeds {MAX_FRAME_BYTES}")
    body = _read_exact(stream, length)
    if body is None:
        raise ValueError("truncated request frame")
    return json.loads(body)


def write_frame(stream, payload):
    """An oversized response is refused rather than written.

    A frame the reader cannot send is a protocol violation, and writing a
    truncated one would hand the caller a short page it has no way to detect.
    The page's own byte budget should make this unreachable; if it is ever
    reached, the budget is wrong and the caller must be told so."""
    body = json.dumps(payload, separators=(",", ":")).encode()
    if len(body) > MAX_FRAME_BYTES:
        raise ValueError(f"response frame {len(body)} exceeds {MAX_FRAME_BYTES}")
    stream.write(struct.pack(">I", len(body)) + body)
    stream.flush()


def write_reply(stream, payload):
    try:
        write_frame(stream, payload)
    except ValueError as error:
        write_frame(stream, {"error": "READER_UNAVAILABLE", "detail": {
            "reason": "RESPONSE_FRAME_TOO_LARGE", "message": str(error)[:400]}})


def handle(connection, request):
    """Read one page, turning a missing cached part into a named refusal.

    Parts are pinned before their paths leave the cache, so a file that is gone
    by read time means that guarantee was broken -- an eviction race, or the
    disk. It has to fail loudly, but it does not have to kill the reader: the
    caller can act on `PART_MISSING_FROM_CACHE` by re-fetching, and cannot act
    on a dead worker at all."""
    parts = request["parts"]
    after_key = request.get("afterKey")
    try:
        page = _reader.read_page(
            connection, parts,
            from_ns=int(request["fromNs"]), to_ns=int(request["toNs"]),
            limit=int(request["limit"]),
            after_key=tuple(after_key) if after_key else None,
            fingerprint=request.get("fingerprint"),
            pointer_sha256=request.get("pointerSha256"),
            cursor_secret=request.get("cursorSecret"),
            max_page_bytes=int(request.get("maxPageBytes", _reader.MAX_PAGE_BYTES)),
            wire_fields=request.get("wireFields"))
    except duckdb.IOException as error:
        raise _reader.ArchiveQueryError(
            _reader.PARTITION_VERIFICATION_FAILED,
            reason="PART_MISSING_FROM_CACHE", detail=str(error)[:400]) from error
    return {
        "rows": page["rows"],
        "nextCursor": page["nextCursor"],
        "partsOpened": page["partsOpened"],
        "partsCandidate": page["partsCandidate"],
        "pageBytes": page["pageBytes"],
        "truncatedByBytes": page["truncatedByBytes"],
        "firstKey": list(page["firstKey"]) if page["firstKey"] else None,
        "lastKey": list(page["lastKey"]) if page["lastKey"] else None,
    }


def main(stdin=None, stdout=None):
    stdin = stdin if stdin is not None else sys.stdin.buffer
    stdout = stdout if stdout is not None else sys.stdout.buffer
    connection = _reader.connect(temp_dir=os.environ.get("TT_READER_TEMP_DIR"))
    try:
        while True:
            try:
                request = read_frame(stdin)
            except (ValueError, json.JSONDecodeError) as error:
                write_frame(stdout, {"fatal": str(error)[:4000]})
                return 1
            if request is None:
                return 0
            try:
                reply = {"ok": handle(connection, request)}
            except _reader.ArchiveQueryError as error:
                reply = {"error": error.code, "detail": error.detail}
            except Exception as error:
                reply = {"fatal": f"{type(error).__name__}: {error}"[:4000]}
                print(traceback.format_exc(), file=sys.stderr)
                write_reply(stdout, reply)
                return 1
            write_reply(stdout, reply)
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(main())
