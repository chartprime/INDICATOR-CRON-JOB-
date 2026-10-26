from __future__ import annotations

import base64
import binascii
import decimal
import hashlib
import hmac
import json
import secrets
import time

import duckdb

import archive_query as _archive_query
from writer import SORT_KEY

duckdb.default_connection().execute("SET threads=1")

CONTRACT_VERSION = "archive-query/1"

CURSOR_MALFORMED = "CURSOR_MALFORMED"
CURSOR_POINTER_MISMATCH = "CURSOR_POINTER_MISMATCH"
PARTITION_VERIFICATION_FAILED = "PARTITION_VERIFICATION_FAILED"

MAX_CURSOR_BYTES = 512
CURSOR_TTL_SECONDS = 900
READER_THREADS = 1
READER_MEMORY_BYTES = 512 * 1024 ** 2
READER_TEMP_BYTES = 2 * 1024 ** 3

MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_PAGE_BYTES = 8 * 1024 * 1024

ArchiveQueryError = _archive_query.ArchiveQueryError

_STRING_TYPES = ("BIGINT", "UBIGINT", "HUGEINT", "UHUGEINT", "DECIMAL")
_CURSOR_SECRET = secrets.token_bytes(32)


def query_fingerprint(*, pointer_sha256, instrument_id, family, from_ns, to_ns, client):
    """Identity of the whole query a cursor was issued for.

    Pointer identity alone does not distinguish ES trades from NQ quotes over
    the same catalog, so a cursor bound only to the pointer could be replayed
    against a different query and paginate silently wrong rows. The sort key is
    included because a cursor's meaning depends on the order it names a position
    in; changing that order must invalidate every outstanding cursor.

    The client is included for the same reason and one more: a cursor is a
    capability, and one that verifies for any caller is a capability the holder
    was never granted. Binding it here means a leaked cursor fails signature
    verification for everyone except the client it was minted for."""
    if not isinstance(client, str) or not client:
        raise ValueError("query fingerprint requires a client identity")
    material = json.dumps({
        "contractVersion": CONTRACT_VERSION,
        "pointerSha256": pointer_sha256,
        "instrumentId": instrument_id,
        "family": family,
        "from": from_ns,
        "to": to_ns,
        "sortKey": list(SORT_KEY),
        "client": client,
    }, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(material).hexdigest()


def _cursor_secret(secret):
    if secret is None:
        return _CURSOR_SECRET
    if isinstance(secret, str):
        try:
            secret = bytes.fromhex(secret)
        except ValueError:
            secret = secret.encode("ascii")
    if not isinstance(secret, bytes) or len(secret) < 32:
        raise ValueError("cursor secret must contain at least 32 bytes")
    return secret


def _cursor_body(fingerprint, pointer_sha256, key, expires_at):
    event_ns, source_rank, stable_position, ordinal = key
    return {
        "version": 1,
        "expiresAt": expires_at,
        "queryFingerprint": fingerprint,
        "pointerSha256": pointer_sha256,
        "eventNs": str(event_ns),
        "sourceRank": int(source_rank),
        "stablePosition": str(stable_position),
        "ordinal": int(ordinal),
    }


def _cursor_bytes(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def encode_cursor(fingerprint, pointer_sha256, key, *, secret=None, now=None,
                  ttl_seconds=CURSOR_TTL_SECONDS):
    """A cursor names exactly one row, by the full canonical key.

    `stable_position` travels as a string because it is UBIGINT in the stored
    Parquet and exceeds JSON's safe integer range; `event_ns` likewise."""
    if not isinstance(ttl_seconds, int) or isinstance(ttl_seconds, bool) or ttl_seconds < 1:
        raise ValueError("ttl_seconds must be a positive integer")
    issued_at = int(time.time() if now is None else now)
    body = _cursor_body(fingerprint, pointer_sha256, key, issued_at + ttl_seconds)
    payload = dict(body)
    payload["tag"] = hmac.new(_cursor_secret(secret), _cursor_bytes(body), hashlib.sha256).hexdigest()
    token = base64.urlsafe_b64encode(_cursor_bytes(payload)).decode().rstrip("=")
    if len(token) > MAX_CURSOR_BYTES:
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="ENCODED_CURSOR_TOO_LONG",
                                bytes=len(token))
    return token


def decode_cursor(token, *, fingerprint, pointer_sha256, secret=None, now=None):
    """Strict validation against the live request, never trust of the decoded
    contents. A caller must not parse a cursor, so the server treats one as
    hostile input: shape first, then identity, then the key itself."""
    if not isinstance(token, str) or not token or len(token) > MAX_CURSOR_BYTES:
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="SHAPE")
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        payload = json.loads(raw)
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="UNDECODABLE") from error
    if not isinstance(payload, dict):
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="UNDECODABLE")
    expected = {"version", "expiresAt", "queryFingerprint", "pointerSha256", "eventNs",
                "sourceRank", "stablePosition", "ordinal", "tag"}
    if set(payload) != expected:
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="UNEXPECTED_FIELDS")
    tag = payload.pop("tag")
    if (not isinstance(tag, str) or len(tag) != 64
            or not hmac.compare_digest(tag, hmac.new(
                _cursor_secret(secret), _cursor_bytes(payload), hashlib.sha256).hexdigest())):
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="UNAUTHENTICATED")
    if payload["version"] != 1:
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="UNSUPPORTED_VERSION")
    expires_at = payload["expiresAt"]
    if not isinstance(expires_at, int) or isinstance(expires_at, bool):
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="INVALID_EXPIRY")
    if expires_at <= int(time.time() if now is None else now):
        raise ArchiveQueryError(CURSOR_MALFORMED, reason="EXPIRED")
    if payload["queryFingerprint"] != fingerprint or payload["pointerSha256"] != pointer_sha256:
        raise ArchiveQueryError(CURSOR_POINTER_MISMATCH, reason="ISSUED_FOR_A_DIFFERENT_QUERY")
    for field in ("eventNs", "stablePosition"):
        value = payload[field]
        if not isinstance(value, str) or not value.isascii() or not value.isdigit():
            raise ArchiveQueryError(CURSOR_MALFORMED, reason="NON_DECIMAL_KEY_FIELD", field=field)
    for field in ("sourceRank", "ordinal"):
        value = payload[field]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ArchiveQueryError(CURSOR_MALFORMED, reason="NON_INTEGER_KEY_FIELD", field=field)
    return (int(payload["eventNs"]), payload["sourceRank"],
            int(payload["stablePosition"]), payload["ordinal"])


def parts_for(parts, *, from_ns, to_ns, after_key=None):
    """The parts a page can possibly draw from, in canonical order.

    Proven on the production archive, including a 59-part partition: parts are
    disjoint and ascending in `event_ns` by name order, each internally sorted
    by the full key, and concatenating them in that order equals a global sort
    with zero mismatched rows across 10,113,547. The writer splits ranges on
    `event_ns` alone, so a tied group never straddles two parts -- which is what
    makes skipping by `event_ns` safe rather than merely usually right.

    Skipping matters: page N of a 59-part partition should open one part, not
    fifty-nine."""
    floor = from_ns if after_key is None else max(from_ns, after_key[0])
    selected = []
    for part in parts:
        low, high = int(part["event_ns_min"]), int(part["event_ns_max"])
        if high < floor or low >= to_ns:
            continue
        selected.append(part)
    return selected


def _nested_serialise(value):
    if isinstance(value, decimal.Decimal):
        return format(value, "f")
    if isinstance(value, list):
        return [_nested_serialise(item) for item in value]
    if isinstance(value, tuple):
        return [_nested_serialise(item) for item in value]
    if isinstance(value, dict):
        return {key: _nested_serialise(item) for key, item in value.items()}
    return value


def _serialise(value, declared_type):
    """Exact values cross the boundary as strings.

    The rule is derived from the column's declared DuckDB type rather than a
    hardcoded list of names, so a writer that adds a column does not silently
    get a lossy one here. `event_ns` and `stable_position` are UBIGINT and price
    and size are DECIMAL(38,12); all of them lose precision as JSON numbers."""
    if value is None:
        return None
    if isinstance(value, decimal.Decimal):
        return format(value, "f")
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and declared_type.startswith(_STRING_TYPES):
        return str(value)
    if isinstance(value, (list, tuple, dict)):
        return _nested_serialise(value)
    return value


def _row_bytes(row):
    """Serialised size of one row, close enough to bound a frame by."""
    return len(json.dumps(row, separators=(",", ":")).encode())


def _assert_page_is_ordered(keys):
    """Pages are served in the order the parts were written, which every
    measured partition satisfies. Asserting it per page costs one comparison per
    row and is the only check that covers a window nobody thought to test -- a
    test proves the windows it was given."""
    for earlier, later in zip(keys, keys[1:]):
        if later <= earlier:
            raise ArchiveQueryError(PARTITION_VERIFICATION_FAILED,
                                    reason="ROWS_OUT_OF_CANONICAL_ORDER")


def connect(*, threads=READER_THREADS, memory_bytes=READER_MEMORY_BYTES,
            temp_bytes=READER_TEMP_BYTES, temp_dir=None):
    """A reader is deliberately single-threaded.

    Order within a part is the order it was written in, and a parallel scan of
    one file's row groups is free to interleave them. A page is small, so
    parallelism buys nothing here and would cost the guarantee the whole page
    contract rests on. It also bounds one reader's CPU, which is what makes
    eight concurrent readers a sane target."""
    config = {"threads": str(threads), "memory_limit": f"{memory_bytes}B",
              "max_temp_directory_size": f"{temp_bytes}B"}
    if temp_dir is not None:
        config["temp_directory"] = temp_dir
    return duckdb.connect(config=config)


def read_page(connection, parts, *, from_ns, to_ns, limit, after_key=None,
              fingerprint=None, pointer_sha256=None, cursor_secret=None,
              max_page_bytes=MAX_PAGE_BYTES, wire_fields=None):
    """One ordered page plus the cursor that resumes exactly after it.

    The redundant `event_ns >= cursor.event_ns` alongside the tuple comparison
    is not belt-and-braces: DuckDB cannot push a row-value comparison down to
    Parquet row-group statistics, so without it every page rescans its part from
    the beginning. Measured on a 2,000,000-row part, resuming 99% of the way
    through costs 93.3 ms without it and 53.7 ms with it. The tuple comparison
    still decides correctness; this one only lets whole row groups be skipped.

    Resume uses a row-value comparison over the whole key. A hand-expanded
    chain of OR/AND clauses is the classic place a lexicographic resume loses a
    clause, and one wrong clause against a 54-row tied group drops 53 rows while
    every other check still passes. Ties are not an edge case here: 12.5% of
    quote rows and 23.2% of trade rows share an `event_ns` with another row."""
    """A page is bounded by rows and by bytes, and either may bind first.

    `limit` alone is not a safe bound. Measured on the production archive, ten
    thousand trade rows serialise to 14.81 MB against a 16 MB frame -- 8% of
    headroom -- and only about 11,343 rows fit at all. Depth carries level
    arrays in 46 columns and is wider again, so a row cap that is comfortable
    for candles can overflow the transport for another family. Stopping on
    bytes and issuing a cursor is what pagination is for; the caller asked for
    at most `limit` rows and is never promised exactly that many."""
    """`wire_fields` narrows what is emitted, never what decides order.

    The cursor is a row-value comparison over `SORT_KEY`, so those columns are
    always selected and always read, whatever the caller wants on the wire; a
    projection that dropped one of them would resume from the wrong row while
    every ordering check still passed."""
    key_columns = ", ".join(SORT_KEY)
    emitted = None if wire_fields is None else frozenset(wire_fields)
    selected = "*" if wire_fields is None else ", ".join(dict.fromkeys((*wire_fields, *SORT_KEY)))
    rows, keys = [], []
    candidates = parts_for(parts, from_ns=from_ns, to_ns=to_ns, after_key=after_key)
    opened, page_bytes, truncated = 0, 0, False

    for part in candidates:
        if len(rows) >= limit:
            break
        opened += 1
        predicate = ["event_ns >= ?", "event_ns < ?"]
        arguments = [from_ns, to_ns]
        if after_key is not None:
            predicate.append("event_ns >= ?")
            arguments.append(after_key[0])
            predicate.append(f"({key_columns}) > (?, ?, ?, ?)")
            arguments.extend(after_key)
        query = (f"SELECT {selected} FROM read_parquet(?) WHERE {' AND '.join(predicate)} "
                 f"LIMIT {int(limit) - len(rows)}")
        cursor = connection.execute(query, [part["path"], *arguments])
        columns = [d[0] for d in cursor.description]
        types = [str(d[1]) for d in cursor.description]
        index = {name: position for position, name in enumerate(columns)}
        for record in cursor.fetchall():
            serialised = {
                column: _serialise(value, declared)
                for column, value, declared in zip(columns, record, types)
                if emitted is None or column in emitted
            }
            row_bytes = _row_bytes(serialised)
            if rows and page_bytes + row_bytes > max_page_bytes:
                truncated = True
                break
            page_bytes += row_bytes
            rows.append(serialised)
            keys.append(tuple(record[index[name]] for name in SORT_KEY))
        if truncated:
            break

    _assert_page_is_ordered(keys)

    next_cursor = None
    if keys and (truncated or len(rows) >= limit):
        next_cursor = encode_cursor(fingerprint, pointer_sha256, keys[-1], secret=cursor_secret)

    return {
        "rows": rows,
        "nextCursor": next_cursor,
        "pageBytes": page_bytes,
        "truncatedByBytes": truncated,
        "firstKey": keys[0] if keys else None,
        "lastKey": keys[-1] if keys else None,
        "partsOpened": opened,
        "partsCandidate": len(candidates),
    }
