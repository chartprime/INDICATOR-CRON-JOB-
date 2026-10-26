"""Bounded local engine-event parts for the historical L2 pilot; no publication path."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import tempfile

import duckdb


SCHEMA = "historical-l2-engine-event/1"
MAX_ROWS = 100_000
MAX_PART_BYTES = 16 * 1024 * 1024
MAX_PAYLOAD_BYTES = 16_384
MAX_DECODED_BYTES = 128 * 1024 * 1024
MAX_READ_ROWS = 20_000
MAX_READ_BYTES = 4 * 1024 * 1024
MAX_SPAN_NS = 3_600_000_000_000
TYPES = {"segment", "appeared", "shrank", "emptied", "verdict", "hidden", "coverage_exit", "trade"}
COLUMNS = {
    "append_position": "UBIGINT",
    "derivation_id": "VARCHAR", "instrument_id": "VARCHAR", "segment_id": "VARCHAR", "event_id": "VARCHAR",
    "event_seq": "UBIGINT", "event_type": "VARCHAR", "observed_engine_ms": "UBIGINT", "known_ns": "UBIGINT",
    "known_event": "UBIGINT", "known_rank": "UBIGINT", "known_position": "UBIGINT", "known_ordinal": "UBIGINT",
    "side": "VARCHAR", "price_key": "BIGINT", "evidence_quality": "VARCHAR", "payload": "VARCHAR",
}


def digest(path: Path, cancelled=lambda: False) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            if cancelled():
                raise InterruptedError("historical event read cancelled")
            value.update(chunk)
    return value.hexdigest()


def exact(value) -> int:
    if (not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value)
            or int(value) > 2**64 - 1):
        raise ValueError("exact unsigned 64-bit string required")
    return int(value)


def reject_constant(_value):
    raise ValueError("nonfinite event payload")


def validate(row: dict) -> tuple:
    if not isinstance(row, dict) or row.get("schema") != SCHEMA:
        raise ValueError("unsupported engine event schema")
    for field in ("derivation_id", "segment_id", "event_id"):
        if not isinstance(row.get(field), str) or not re.fullmatch(r"[a-f0-9]{64}", row[field]):
            raise ValueError("event identity must be source anchored")
    if (not isinstance(row.get("instrument_id"), str) or not 1 <= len(row["instrument_id"]) <= 128
            or row.get("event_type") not in TYPES
            or row.get("evidence_quality") not in ("observed_depth_inference", "resting_unknown")):
        raise ValueError("invalid event identity, type or evidence")
    for field in ("event_seq", "observed_engine_ms"):
        if type(row.get(field)) is not int or not 0 <= row[field] <= 2**53 - 1:
            raise ValueError("engine integers must be exactly representable")
    key = row.get("known_key")
    if not isinstance(key, list) or len(key) != 4:
        raise ValueError("four-field knowledge cursor required")
    key = tuple(map(exact, key))
    at = exact(row["known_ns"])
    if at < key[0] or at < row["observed_engine_ms"] * 1_000_000:
        raise ValueError("event cannot be known before its source or engine observation")
    price = row.get("price_key")
    if (price is not None and (type(price) is not int or not 0 <= price <= 2**53 - 1
                              or row.get("side") not in ("bid", "ask"))
            or price is None and row.get("side") is not None):
        raise ValueError("invalid event level")
    payload = row.get("payload")
    if not isinstance(payload, str) or len(payload.encode()) > MAX_PAYLOAD_BYTES:
        raise ValueError("event payload exceeds admission")
    decoded = json.loads(payload, parse_constant=reject_constant)
    if (not isinstance(decoded, dict) or decoded.get("seq") != row["event_seq"]
            or decoded.get("type") != row["event_type"] or decoded.get("ts") != row["observed_engine_ms"]
            or decoded.get("side") != row.get("side") or decoded.get("key") != price):
        raise ValueError("event payload and indexed fields disagree")
    expected_id = hashlib.sha256(json.dumps([SCHEMA, row["segment_id"], row["event_seq"]],
                                           separators=(",", ":")).encode()).hexdigest()
    if row["event_id"] != expected_id:
        raise ValueError("event id does not match its segment and sequence")
    return (row["derivation_id"], row["instrument_id"], row["segment_id"], row["event_id"], row["event_seq"],
            row["event_type"], row["observed_engine_ms"], at, *key, row.get("side"), price,
            row["evidence_quality"], payload)


def write_part(rows, directory: Path) -> dict:
    directory = Path(directory)
    directory.mkdir(exist_ok=False)
    with tempfile.TemporaryDirectory(dir=directory, prefix="pending-") as scratch:
        with duckdb.connect(config={"threads": "1", "memory_limit": "128MB", "temp_directory": scratch,
                                    "max_temp_directory_size": "256MB"}) as connection:
            connection.execute("CREATE TABLE events (" + ",".join(f"{name} {kind}" for name, kind in COLUMNS.items()) + ")")
            batch, count, decoded_bytes = [], 0, 0
            identity, previous = None, None
            last_sequence = {}
            first_ns = last_ns = None
            for row in rows:
                values = validate(row)
                current = (values[7], *values[8:12])
                source = values[:2]
                if (identity is not None and source != identity or previous is not None and current < previous
                        or values[4] != last_sequence.get(values[2], -1) + 1):
                    raise ValueError("event identity, knowledge order or segment sequence changed")
                identity, previous = source, current
                last_sequence[values[2]] = values[4]
                count += 1
                decoded_bytes += len(json.dumps(row, separators=(",", ":")).encode())
                if count > MAX_ROWS or decoded_bytes > MAX_DECODED_BYTES or len(last_sequence) > 1024:
                    raise ValueError("event part exceeds row, decoded byte or segment admission")
                first_ns = values[7] if first_ns is None else first_ns
                last_ns = values[7]
                batch.append((count - 1, *values))
                if len(batch) == 1000:
                    connection.executemany("INSERT INTO events VALUES (" + ",".join("?" for _ in COLUMNS) + ")", batch)
                    batch.clear()
            if not count:
                raise ValueError("empty event part")
            if batch:
                connection.executemany("INSERT INTO events VALUES (" + ",".join("?" for _ in COLUMNS) + ")", batch)
            temporary = Path(scratch) / "part.parquet"
            connection.execute("COPY events TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 2048)", [str(temporary)])
            if temporary.stat().st_size > MAX_PART_BYTES:
                raise ValueError("encoded event part exceeds byte admission")
            part = {"name": "part.parquet", "bytes": temporary.stat().st_size, "sha256": digest(temporary), "rows": count}
            manifest = {"schema": SCHEMA, "scope": "engine-event-pilot-only; incomplete compact core; not published",
                        "derivation_id": identity[0], "instrument_id": identity[1], "part": part,
                        "first_known_ns": str(first_ns), "last_known_ns": str(last_ns), "decoded_bytes": decoded_bytes}
            temporary.replace(directory / part["name"])
            pending = directory / "manifest.pending"
            pending.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
            pending.replace(directory / "manifest.json")
            return manifest


def read_events(directory: Path, manifest_sha256: str, *, from_ns: str, as_of_ns: str,
                as_of_key: list[str], cancelled=lambda: False) -> list[dict]:
    directory = Path(directory)
    lower, upper = exact(from_ns), exact(as_of_ns)
    if not isinstance(as_of_key, list):
        raise ValueError("four-field knowledge cursor required")
    cursor = tuple(map(exact, as_of_key))
    if len(cursor) != 4 or not 0 <= upper - lower <= MAX_SPAN_NS or cursor[0] > upper:
        raise ValueError("event read exceeds time or cursor admission")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 64 * 1024:
        raise ValueError("invalid manifest admission")
    if digest(manifest_path, cancelled) != manifest_sha256:
        raise ValueError("manifest pin changed")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    part = manifest["part"]
    path = directory / "part.parquet"
    if (manifest["schema"] != SCHEMA or part["name"] != path.name or path.is_symlink()
            or type(part["rows"]) is not int or not 0 < part["rows"] <= MAX_ROWS
            or type(part["bytes"]) is not int or not 0 < part["bytes"] <= MAX_PART_BYTES
            or type(manifest["decoded_bytes"]) is not int or not 0 < manifest["decoded_bytes"] <= MAX_DECODED_BYTES
            or path.stat().st_size != part["bytes"] or digest(path, cancelled) != part["sha256"]):
        raise ValueError("event part integrity or admission failed")
    with tempfile.TemporaryDirectory(prefix="historical-event-read-") as scratch:
        with duckdb.connect(config={"threads": "1", "memory_limit": "128MB", "temp_directory": scratch,
                                    "max_temp_directory_size": "256MB"}) as connection:
            if connection.execute("SELECT sum(num_rows) FROM parquet_file_metadata(?)", [str(path)]).fetchone()[0] != part["rows"]:
                raise ValueError("event part row count differs from manifest")
            bounded = "known_event<? OR (known_event=? AND (known_rank<? OR (known_rank=? AND " \
                      "(known_position<? OR (known_position=? AND known_ordinal<=?)))))"
            parameters = [str(path), lower, upper, cursor[0], cursor[0], cursor[1], cursor[1], cursor[2], cursor[2], cursor[3]]
            query = connection.execute("SELECT * FROM read_parquet(?) WHERE known_ns BETWEEN ? AND ? AND (" + bounded + ") "
                                       "ORDER BY known_ns, known_event, known_rank, known_position, known_ordinal, append_position "
                                       f"LIMIT {MAX_READ_ROWS + 1}", parameters)
            result, used = [], 2
            if used > MAX_READ_BYTES:
                raise ValueError("event read exceeds output admission; request a smaller window")
            while batch := query.fetchmany(1000):
                if cancelled():
                    raise InterruptedError("historical event read cancelled")
                for values in batch:
                    row = dict(zip(COLUMNS, values))
                    row.pop("append_position")
                    row["schema"] = SCHEMA
                    row["known_key"] = [str(row.pop(name)) for name in
                                        ("known_event", "known_rank", "known_position", "known_ordinal")]
                    row["known_ns"] = str(row["known_ns"])
                    validate(row)
                    if (row["derivation_id"], row["instrument_id"]) != (manifest["derivation_id"], manifest["instrument_id"]):
                        raise ValueError("event identity differs from manifest")
                    used += len(json.dumps(row, separators=(",", ":")).encode()) + bool(result)
                    if len(result) >= MAX_READ_ROWS or used > MAX_READ_BYTES:
                        raise ValueError("event read exceeds output admission; request a smaller window")
                    result.append(row)
    if cancelled():
        raise InterruptedError("historical event read cancelled")
    if digest(path, cancelled) != part["sha256"]:
        raise ValueError("event part changed during read")
    if digest(manifest_path, cancelled) != manifest_sha256:
        raise ValueError("manifest changed during read")
    return result
