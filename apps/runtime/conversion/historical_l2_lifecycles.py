"""Bounded local lifecycle parts with source-anchored genealogy and knowledge cuts."""

from __future__ import annotations

import hashlib
from decimal import Decimal
import json
import math
from pathlib import Path
import re
import tempfile

import duckdb

from historical_l2_events import digest, exact, reject_constant


SCHEMA = "historical-l2-level-event/1"
ENGINE_TYPES = {"segment", "appeared", "shrank", "emptied", "verdict", "hidden", "coverage_exit", "trade"}
TYPES = {"segment_open", "segment_close", "lifecycle_start", "level_size", "quote", "engine_level_state", "observation_end"}
TYPES.update("engine_" + kind for kind in ENGINE_TYPES)
MAX_ROWS = 100_000_000
MAX_PART_ROWS = 100_000
MAX_PART_BYTES = 16 * 1024 * 1024
MAX_PART_DECODED = 128 * 1024 * 1024
MAX_PARTS = 1024
MAX_READ_ROWS = 20_000
MAX_READ_BYTES = 4 * 1024 * 1024
MAX_SCAN_BYTES = 64 * 1024 * 1024
COLUMNS = {
    "append_position": "UBIGINT", "derivation_id": "VARCHAR", "instrument_id": "VARCHAR", "segment_id": "VARCHAR",
    "event_id": "VARCHAR", "event_seq": "UBIGINT", "event_type": "VARCHAR", "source_ns": "UBIGINT",
    "known_ns": "UBIGINT", "known_event": "UBIGINT", "known_rank": "UBIGINT", "known_position": "UBIGINT",
    "known_ordinal": "UBIGINT", "observed_engine_ms": "UBIGINT", "engine_seq": "UBIGINT", "side": "VARCHAR",
    "price_key": "BIGINT", "observation_id": "VARCHAR", "lifecycle_id": "VARCHAR", "record_evidence_gap": "BOOLEAN",
    "evidence_quality": "VARCHAR", "payload": "VARCHAR",
}


def hashed(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("source-anchored identity required")
    return value


def natural(value):
    if type(value) is not int or not 0 <= value <= 2**53 - 1:
        raise ValueError("exact engine integer required")
    return value


def finite(value):
    if isinstance(value, dict):
        for item in value.values():
            finite(item)
    elif isinstance(value, list):
        for item in value:
            finite(item)
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError("nonfinite lifecycle payload")


def validate(row):
    if not isinstance(row, dict) or row.get("schema") != SCHEMA or row.get("event_type") not in TYPES:
        raise ValueError("invalid lifecycle schema or type")
    for field in ("derivation_id", "segment_id", "event_id"):
        identity(row.get(field))
    if not isinstance(row.get("instrument_id"), str) or not 1 <= len(row["instrument_id"]) <= 128:
        raise ValueError("instrument identity required")
    sequence = natural(row.get("event_seq"))
    if row["event_id"] != hashed([SCHEMA, row["segment_id"], sequence]):
        raise ValueError("event id differs from segment sequence")
    key = row.get("known_key")
    if not isinstance(key, list) or len(key) != 4:
        raise ValueError("four-field knowledge cursor required")
    cursor = tuple(map(exact, key))
    source, known = exact(row.get("source_ns")), exact(row.get("known_ns"))
    clock = natural(row.get("observed_engine_ms"))
    if source != cursor[0] or known < source or known < clock * 1_000_000:
        raise ValueError("lifecycle information precedes its evidence")
    side, price, observation, lifecycle = (row.get(field) for field in ("side", "price_key", "observation_id", "lifecycle_id"))
    if side is None:
        if any(value is not None for value in (price, observation, lifecycle)):
            raise ValueError("segment/quote cannot reference a level")
    elif side not in ("bid", "ask") or natural(price) == 0:
        raise ValueError("invalid lifecycle level")
    else:
        identity(observation)
        if lifecycle is not None:
            identity(lifecycle)
    if type(row.get("record_evidence_gap")) is not bool or row.get("evidence_quality") not in ("resting_unknown", "observed_depth_inference"):
        raise ValueError("explicit evidence quality required")
    payload = row.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("structured lifecycle payload required")
    finite(payload)
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if len(encoded.encode()) > 16_384:
        raise ValueError("lifecycle payload exceeds admission")
    kind = row["event_type"]
    if kind.startswith("engine_") and kind != "engine_level_state":
        if (natural(row.get("engine_seq")) != payload.get("seq") or kind != "engine_" + str(payload.get("type"))
                or payload.get("ts") != clock or payload.get("side") != side or payload.get("key") != price):
            raise ValueError("engine payload and indexed event disagree")
    elif row.get("engine_seq") is not None:
        raise ValueError("synthetic event cannot claim an engine sequence")
    if kind in ("segment_open", "segment_close", "quote", "engine_segment") and side is not None:
        raise ValueError("invalid segment/quote scope")
    if kind not in ("segment_open", "segment_close", "quote", "engine_segment") and side is None:
        raise ValueError("level event has no observation")
    if kind == "lifecycle_start":
        if (lifecycle is None or type(payload.get("age_unknown")) is not bool or payload.get("first_key") != key
                or natural(payload.get("size")) == 0 or type(payload.get("refill")) is not bool):
            raise ValueError("invalid source-anchored lifecycle start")
    elif kind == "segment_open":
        tick = payload.get("tick_size")
        if (not isinstance(tick, str) or not re.fullmatch(r"(0|[1-9][0-9]*)(\.[0-9]{1,12})?", tick)
                or Decimal(tick) <= 0 or not 1 <= natural(payload.get("depth_limit")) <= 10):
            raise ValueError("exact bounded segment geometry required")
    elif kind == "quote":
        if not 0 < natural(payload.get("bid")) < natural(payload.get("ask")):
            raise ValueError("invalid observed quote")
    elif kind == "level_size":
        if lifecycle is None or natural(payload.get("size")) < 0:
            raise ValueError("observed size needs a lifecycle")
        if payload.get("previous_size") is not None:
            natural(payload["previous_size"])
        if not isinstance(payload.get("source_price"), str) or not re.fullmatch(r"(0|[1-9][0-9]*)(\.[0-9]{1,12})?", payload["source_price"]):
            raise ValueError("exact source price required")
    elif kind == "engine_level_state":
        state = payload.get("state")
        if not isinstance(state, dict) or state.get("side") != side or state.get("key") != price:
            raise ValueError("engine state and observation disagree")
        if row["record_evidence_gap"] and row["evidence_quality"] != "resting_unknown":
            raise ValueError("engine totals lost their evidence gap")
    elif kind in ("observation_end", "segment_close"):
        if not isinstance(payload.get("cause"), str) or not 1 <= len(payload["cause"]) <= 128:
            raise ValueError("closure cause required")
    value = {name: row.get(name) for name in COLUMNS if name not in ("append_position", "payload")}
    value.update(source_ns=source, known_ns=known, known_event=cursor[0], known_rank=cursor[1], known_position=cursor[2], known_ordinal=cursor[3], payload=encoded)
    return value


def write_parts(rows, directory: Path, *, part_rows=MAX_PART_ROWS, cancelled=lambda: False):
    if type(part_rows) is not int or not 1 <= part_rows <= MAX_PART_ROWS:
        raise ValueError("part row admission failed")
    directory = Path(directory)
    directory.mkdir(exist_ok=False)
    with tempfile.TemporaryDirectory(dir=directory, prefix="pending-") as scratch:
        parts, count, decoded, in_part = [], 0, 0, 0
        source = previous = active_segment = None
        geometry = None
        first_ns = last_ns = None
        next_seq = next_engine_seq = 0
        seen_segments, observations, coordinates = set(), {}, {}
        closing_counts = {}
        staging = Path(scratch) / "rows.jsonl"
        sink = staging.open("w", encoding="utf-8", newline="\n")

        def seal():
            nonlocal sink, decoded, in_part, first_ns
            sink.close()
            if not in_part:
                return
            if len(parts) >= MAX_PARTS:
                raise ValueError("part count admission exceeded")
            name = f"part-{len(parts):04d}.parquet"
            pending = Path(scratch) / name
            columns = "{" + ",".join(f"'{field}':'{kind}'" for field, kind in COLUMNS.items()) + "}"
            with duckdb.connect(config={"threads": "1", "memory_limit": "128MB", "temp_directory": scratch,
                                        "max_temp_directory_size": "256MB"}) as connection:
                connection.execute("COPY (SELECT * FROM read_json($source, format='newline_delimited', columns=" + columns
                                   + ")) TO $output (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 2048)",
                                   {"source": str(staging), "output": str(pending)})
            size = pending.stat().st_size
            if size > MAX_PART_BYTES:
                raise ValueError("encoded part admission exceeded")
            parts.append({"name": name, "sha256": digest(pending, cancelled), "bytes": size, "rows": in_part,
                          "decoded_bytes": decoded, "first_known_ns": str(first_ns), "last_known_ns": str(last_ns)})
            pending.replace(directory / name)
            decoded = in_part = 0
            first_ns = None
            sink = staging.open("w", encoding="utf-8", newline="\n")

        try:
            for row in rows:
                if cancelled():
                    raise InterruptedError("lifecycle write cancelled")
                value = validate(row)
                key = tuple(map(exact, row["known_key"]))
                order = (value["known_ns"], key)
                current_source = (value["derivation_id"], value["instrument_id"])
                if (source is not None and source != current_source or previous is not None and (order < previous or key < previous[1])):
                    raise ValueError("source identity or knowledge order changed")
                kind, payload = row["event_type"], row["payload"]
                if kind == "segment_open":
                    if active_segment is not None or row["segment_id"] in seen_segments or row["event_seq"] != 0 or payload.get("seed_key") != row["known_key"]:
                        raise ValueError("segment open order failed")
                    expected = hashed([SCHEMA, *current_source, row["known_key"]])
                    if row["segment_id"] != expected or len(seen_segments) >= 1024:
                        raise ValueError("segment anchor or count failed")
                    active_segment = row["segment_id"]
                    current_geometry = (payload["tick_size"], payload["depth_limit"])
                    if geometry is not None and geometry != current_geometry:
                        raise ValueError("segment geometry changed within derivation")
                    geometry = current_geometry
                    next_seq = next_engine_seq = 0
                    seen_segments.add(active_segment)
                    closing_counts = {}
                if row["segment_id"] != active_segment or row["event_seq"] != next_seq:
                    raise ValueError("event segment or sequence changed")
                if row["engine_seq"] is not None:
                    if row["engine_seq"] != next_engine_seq:
                        raise ValueError("engine events missing or reordered")
                    next_engine_seq += 1
                observation = None
                if row["side"] is not None:
                    ident = row["observation_id"]
                    coordinate = (row["side"], row["price_key"])
                    if ident not in observations:
                        if (kind not in ("lifecycle_start", "engine_trade") or coordinate in coordinates or len(observations) >= 8192
                                or ident != hashed([SCHEMA, active_segment, "observation", *coordinate, row["known_key"]])):
                            raise ValueError("observation anchor missing or conflicting")
                        observations[ident] = {"coordinate": coordinate, "life": None, "ended": False, "pending": None, "gap": False, "last_size": None}
                        coordinates[coordinate] = ident
                    observation = observations[ident]
                    if observation["coordinate"] != coordinate or observation["gap"] and not row["record_evidence_gap"]:
                        raise ValueError("observation identity or evidence gap changed")
                    observation["gap"] = row["record_evidence_gap"]
                    if kind == "lifecycle_start":
                        expected_life = hashed([SCHEMA, ident, "lifecycle", row["known_key"]])
                        if (row["lifecycle_id"] != expected_life or observation["life"] is not None and not observation["ended"] or observation["pending"] is not None
                                or payload.get("previous_lifecycle_id") != observation["life"]):
                            raise ValueError("lifecycle genealogy failed")
                        observation.update(life=expected_life, ended=False)
                    elif row["lifecycle_id"] != observation["life"]:
                        raise ValueError("event references another lifecycle")
                    if kind == "level_size" and Decimal(payload["source_price"]) != Decimal(geometry[0]) * row["price_key"]:
                        raise ValueError("source price differs from indexed tick key")
                    if kind == "engine_emptied":
                        if observation["life"] is None or observation["ended"]:
                            raise ValueError("emptying has no active lifecycle")
                        observation.update(ended=True, pending=observation["life"])
                    elif kind == "engine_verdict":
                        if observation["pending"] != row["lifecycle_id"] or payload.get("endedBy") not in ("filled", "pulled"):
                            raise ValueError("verdict has no pending ending")
                        observation["pending"] = None
                    elif kind == "level_size":
                        if payload["previous_size"] is not None and payload["previous_size"] != (observation["last_size"] if observation["last_size"] is not None else 0):
                            raise ValueError("source size history discontinuity")
                        observation["last_size"] = payload["size"]
                    elif kind == "observation_end":
                        if payload.get("pending_verdict") != observation["pending"]:
                            raise ValueError("closure lost a pending verdict")
                        del observations[ident]
                        del coordinates[coordinate]
                        closure = closing_counts.setdefault(payload["cause"], [0, 0])
                        closure[0] += 1
                        closure[1] += int(payload.get("pending_verdict") is not None)
                if kind == "segment_close":
                    if (observations or [natural(payload.get("records")), natural(payload.get("unresolved_endings"))]
                            != closing_counts.get(payload["cause"], [0, 0])):
                        raise ValueError("segment closed before observations")
                    active_segment = None
                elif kind != "observation_end":
                    closing_counts = {}
                source, previous = current_source, order
                next_seq += 1
                value["append_position"] = count
                encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
                amount = len(encoded.encode()) + 1
                if amount + decoded > MAX_PART_DECODED and in_part:
                    seal()
                if amount > MAX_PART_DECODED or count >= MAX_ROWS:
                    raise ValueError("row or decoded admission exceeded")
                sink.write(encoded + "\n")
                count += 1
                in_part += 1
                decoded += amount
                first_ns = value["known_ns"] if first_ns is None else first_ns
                last_ns = value["known_ns"]
                if in_part == part_rows:
                    seal()
            if not count or active_segment is not None or observations:
                raise ValueError("closed segment proof missing")
            seal()
            manifest = {"schema": SCHEMA, "scope": "local lifecycle pilot; no full-session, publication or restore acceptance",
                        "derivation_id": source[0], "instrument_id": source[1], "rows": count, "segments": len(seen_segments),
                        "writer_sha256": digest(Path(__file__)), "duckdb_version": duckdb.__version__, "parts": parts}
            pending = directory / "manifest.pending"
            pending.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
            if cancelled():
                raise InterruptedError("lifecycle write cancelled")
            pending.replace(directory / "manifest.json")
            return manifest
        finally:
            sink.close()


def read_events(directory: Path, manifest_sha256: str, *, from_ns: str, as_of_ns: str, as_of_key: list[str], cancelled=lambda: False):
    directory = Path(directory)
    lower, upper = exact(from_ns), exact(as_of_ns)
    if not isinstance(as_of_key, list) or len(as_of_key) != 4:
        raise ValueError("four-field read cursor required")
    cursor = tuple(map(exact, as_of_key))
    if not 0 <= upper - lower <= 3_600_000_000_000 or cursor[0] > upper:
        raise ValueError("read window admission exceeded")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 1024 * 1024 or digest(manifest_path, cancelled) != manifest_sha256:
        raise ValueError("manifest pin changed")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"), parse_constant=reject_constant)
    parts = manifest["parts"]
    if manifest["schema"] != SCHEMA or not isinstance(parts, list) or not 1 <= len(parts) <= MAX_PARTS:
        raise ValueError("manifest admission failed")
    selected, scan_bytes, total = [], 0, 0
    for index, part in enumerate(parts):
        if (part["name"] != f"part-{index:04d}.parquet" or type(part["rows"]) is not int or not 0 < part["rows"] <= MAX_PART_ROWS
                or type(part["bytes"]) is not int or not 0 < part["bytes"] <= MAX_PART_BYTES
                or type(part["decoded_bytes"]) is not int or not 0 < part["decoded_bytes"] <= MAX_PART_DECODED
                or exact(part["first_known_ns"]) > exact(part["last_known_ns"])):
            raise ValueError("part admission failed")
        total += part["rows"]
        if exact(part["first_known_ns"]) <= upper and exact(part["last_known_ns"]) >= lower:
            scan_bytes += part["bytes"]
            if scan_bytes > MAX_SCAN_BYTES:
                raise ValueError("scan byte admission exceeded")
            selected.append(part)
    if type(manifest["rows"]) is not int or manifest["rows"] != total or not 0 < total <= MAX_ROWS:
        raise ValueError("manifest row count invalid")
    result, used = [], 2
    if used > MAX_READ_BYTES:
        raise ValueError("output admission exceeded; request a smaller window")
    with tempfile.TemporaryDirectory(prefix="historical-lifecycle-read-") as scratch:
        with duckdb.connect(config={"threads": "1", "memory_limit": "128MB", "temp_directory": scratch,
                                    "max_temp_directory_size": "256MB"}) as connection:
            for part in selected:
                path = directory / part["name"]
                if path.is_symlink() or path.stat().st_size != part["bytes"] or digest(path, cancelled) != part["sha256"]:
                    raise ValueError("part integrity failed")
                if connection.execute("SELECT sum(num_rows) FROM parquet_file_metadata(?)", [str(path)]).fetchone()[0] != part["rows"]:
                    raise ValueError("part row count differs")
                condition = "known_event<? OR (known_event=? AND (known_rank<? OR (known_rank=? AND " \
                            "(known_position<? OR (known_position=? AND known_ordinal<=?)))))"
                query = connection.execute("SELECT * FROM read_parquet(?) WHERE known_ns BETWEEN ? AND ? AND (" + condition
                                           + ") ORDER BY append_position LIMIT ?", [str(path), lower, upper, cursor[0], cursor[0], cursor[1], cursor[1],
                                                                                  cursor[2], cursor[2], cursor[3], MAX_READ_ROWS + 1])
                while batch := query.fetchmany(1000):
                    if cancelled():
                        raise InterruptedError("lifecycle read cancelled")
                    for values in batch:
                        row = dict(zip(COLUMNS, values))
                        row.pop("append_position")
                        row["schema"] = SCHEMA
                        row["known_key"] = [str(row.pop(field)) for field in ("known_event", "known_rank", "known_position", "known_ordinal")]
                        row["source_ns"] = str(row["source_ns"])
                        row["known_ns"] = str(row["known_ns"])
                        row["payload"] = json.loads(row["payload"], parse_constant=reject_constant)
                        validate(row)
                        if (row["derivation_id"], row["instrument_id"]) != (manifest["derivation_id"], manifest["instrument_id"]):
                            raise ValueError("read identity changed")
                        used += len(json.dumps(row, separators=(",", ":")).encode()) + bool(result)
                        if len(result) >= MAX_READ_ROWS or used > MAX_READ_BYTES:
                            raise ValueError("output admission exceeded; request a smaller window")
                        result.append(row)
                if digest(path, cancelled) != part["sha256"]:
                    raise ValueError("part changed during read")
    if cancelled():
        raise InterruptedError("lifecycle read cancelled")
    if digest(manifest_path, cancelled) != manifest_sha256:
        raise ValueError("manifest changed during read")
    return result
