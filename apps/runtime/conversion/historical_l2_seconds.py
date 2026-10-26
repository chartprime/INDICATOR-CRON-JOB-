"""Local bounded state/coverage pilot. A terminal proof is required before sealing."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import tempfile

import duckdb

from historical_l2_events import digest, exact, reject_constant


SCHEMA = "historical-l2-second/1"
SECOND = 1_000_000_000
MAX_INTEGER = 2**53 - 1
MAX_ROWS = 3_000_000
MAX_PART_ROWS = 100_000
MAX_PART_BYTES = 16 * 1024 * 1024
MAX_PART_DECODED = 128 * 1024 * 1024
MAX_PARTS = 1024
MAX_READ_ROWS = 20_000
MAX_READ_BYTES = 4 * 1024 * 1024
MAX_SCAN_BYTES = 64 * 1024 * 1024
COLUMNS = {
    "append_position": "UBIGINT", "derivation_id": "VARCHAR", "instrument_id": "VARCHAR",
    "record_id": "VARCHAR", "family": "VARCHAR", "known_ns": "UBIGINT",
    "known_event": "UBIGINT", "known_rank": "UBIGINT", "known_position": "UBIGINT",
    "known_ordinal": "UBIGINT", "payload": "VARCHAR",
}


def hashed(value) -> str:
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("invalid source identity")
    return value


def natural(value):
    if type(value) is not int or not 0 <= value <= MAX_INTEGER:
        raise ValueError("exact nonnegative integer required")
    return value


def flow(value):
    if not isinstance(value, dict) or set(value) != {"BUY", "SELL", "UNKNOWN", "count"}:
        raise ValueError("explicit known/unknown flow required")
    for amount in value.values():
        natural(amount)
    volume = sum(value[side] for side in ("BUY", "SELL", "UNKNOWN"))
    if (volume == 0) != (value["count"] == 0) or volume < value["count"]:
        raise ValueError("flow volume/count disagree")


def bounds(value):
    if value is not None:
        if not isinstance(value, list) or len(value) != 2 or natural(value[0]) > natural(value[1]):
            raise ValueError("invalid observed range")


def validate(row: dict) -> dict:
    if not isinstance(row, dict) or row.get("schema") != SCHEMA:
        raise ValueError("unsupported second schema")
    derivation = identity(row.get("derivation_id"))
    instrument = row.get("instrument_id")
    if not isinstance(instrument, str) or not 1 <= len(instrument) <= 128:
        raise ValueError("invalid instrument identity")
    sequence = natural(row.get("append_position"))
    if identity(row.get("record_id")) != hashed([SCHEMA, derivation, instrument, sequence]):
        raise ValueError("record id differs from anchored sequence")
    known = exact(row.get("known_ns"))
    cursor = row.get("known_key")
    if cursor is not None:
        if not isinstance(cursor, list) or len(cursor) != 4:
            raise ValueError("four-field knowledge key required")
        cursor = tuple(map(exact, cursor))
        if known < cursor[0]:
            raise ValueError("knowledge precedes source")
    payload = row.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("structured payload required")
    encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
    if len(encoded.encode()) > 16_384:
        raise ValueError("payload admission exceeded")
    segment = payload.get("segment_id")
    if segment is not None:
        identity(segment)
    if (type(payload.get("trusted")) is not bool or payload["trusted"] != (segment is not None)
            or type(payload.get("depth_limit")) is not int or not 1 <= payload["depth_limit"] <= 10
            or not isinstance(payload.get("reason"), str) or not 1 <= len(payload["reason"]) <= 128):
        raise ValueError("explicit trust and depth required")
    if row.get("family") == "l2_book_segment":
        begin, end = exact(payload.get("open_ns")), exact(payload.get("boundary_ns"))
        if payload.get("action") not in ("open", "close") or begin > end or known < end:
            raise ValueError("invalid segment boundary")
        if payload.get("final") is not None:
            if payload["final"] is not True or payload["action"] != "close":
                raise ValueError("invalid terminal proof")
            first, last = exact(payload.get("window_from_ns")), exact(payload.get("window_to_ns"))
            if not 0 < last - first <= 86_400 * SECOND or end != last or begin < first:
                raise ValueError("invalid terminal window")
    elif row.get("family") == "l2_level_state_1s":
        opened, closed, covered = map(exact, (payload.get("open_ns"), payload.get("close_ns"), payload.get("covered_from_ns")))
        if (opened % SECOND or not opened <= covered <= closed <= opened + SECOND or known < closed
                or type(payload.get("complete")) is not bool or type(payload.get("point_prefix")) is not bool
                or payload["point_prefix"] != (covered == closed)
                or payload["complete"] != (covered == opened and closed == opened + SECOND)):
            raise ValueError("invalid half-open state interval")
        if payload.get("row_kind") == "coverage":
            bounds(payload.get("bid_range"))
            bounds(payload.get("ask_range"))
            if (segment is None and (payload.get("bid_range") is not None or payload.get("ask_range") is not None)
                    or segment is not None and (payload.get("bid_range") is None or payload.get("ask_range") is None)):
                raise ValueError("coverage and trust disagree")
            if segment is not None and payload["bid_range"][1] >= payload["ask_range"][0]:
                raise ValueError("crossed coverage")
            tick = payload.get("tick_size")
            if not isinstance(tick, str) or not re.fullmatch(r"(0|[1-9][0-9]*)(\.[0-9]{1,12})?", tick) or not any(c in "123456789" for c in tick):
                raise ValueError("exact positive tick required")
            flow(payload.get("flow"))
            flow(payload.get("outside_trust"))
            invalid_flow = any(payload["flow"].values()) if segment is None else any(payload["outside_trust"].values())
            if invalid_flow:
                raise ValueError("flow crossed trust boundary")
        elif payload.get("row_kind") == "level":
            if segment is None or natural(payload.get("price_key")) == 0:
                raise ValueError("untrusted level state")
            for field in ("bid_size", "ask_size"):
                if payload.get(field) is not None:
                    natural(payload[field])
            for field in ("buy_volume", "sell_volume"):
                natural(payload.get(field))
        else:
            raise ValueError("invalid state row kind")
    else:
        raise ValueError("invalid second family")
    return dict(zip(COLUMNS, (sequence, derivation, instrument, row["record_id"], row["family"], known,
                              *(cursor if cursor is not None else (None,) * 4), encoded)))


def write_parts(rows, directory: Path, *, part_rows=MAX_PART_ROWS, cancelled=lambda: False) -> dict:
    if type(part_rows) is not int or not 1 <= part_rows <= MAX_PART_ROWS:
        raise ValueError("invalid part row admission")
    directory = Path(directory)
    directory.mkdir(exist_ok=False)
    with tempfile.TemporaryDirectory(dir=directory, prefix="pending-") as scratch:
        parts, batch_count, decoded, count = [], 0, 0, 0
        source = previous = terminal = None
        source_cursor = first_source = None
        depth = tick = None
        active_segment = None
        segment_open = False
        coverage = None
        covered_to = initial = None
        price = None
        totals = {"BUY": 0, "SELL": 0}
        observed_levels = {"bid": [], "ask": []}
        first_known = last_known = None
        staging = Path(scratch) / "rows.jsonl"
        sink = staging.open("w", encoding="utf-8", newline="\n")

        def close_coverage():
            if coverage is not None and any(totals[side] != coverage["flow"][side] for side in totals):
                raise ValueError("price flow differs from coverage")
            if coverage is not None and coverage["trusted"]:
                for side, keys in observed_levels.items():
                    if (not 1 <= len(keys) <= coverage["depth_limit"]
                            or [min(keys), max(keys)] != coverage[side + "_range"]):
                        raise ValueError("observed book rows missing from coverage")

        def seal():
            nonlocal batch_count, decoded, first_known, sink
            sink.close()
            if not batch_count:
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
            parts.append({"name": name, "bytes": size, "sha256": digest(pending, cancelled), "rows": batch_count,
                          "decoded_bytes": decoded, "first_known_ns": str(first_known), "last_known_ns": str(last_known)})
            pending.replace(directory / name)
            batch_count = decoded = 0
            first_known = None
            sink = staging.open("w", encoding="utf-8", newline="\n")

        try:
            for row in rows:
                if cancelled():
                    raise InterruptedError("second write cancelled")
                value = validate(row)
                current_source = (value["derivation_id"], value["instrument_id"])
                current = (value["known_ns"], *(value[name] if value[name] is not None else -1 for name in
                           ("known_event", "known_rank", "known_position", "known_ordinal")))
                if (terminal is not None or value["append_position"] != count or source is not None and source != current_source
                        or previous is not None and current < previous):
                    raise ValueError("truncated, reordered or mixed second stream")
                cursor_fields = ("known_event", "known_rank", "known_position", "known_ordinal")
                current_cursor = tuple(value[field] for field in cursor_fields) if value["known_event"] is not None else None
                if (current_cursor is None and source_cursor is not None
                        or current_cursor is not None and source_cursor is not None and current_cursor < source_cursor):
                    raise ValueError("source cursor regressed")
                if current_cursor is not None:
                    first_source = current_cursor[0] if first_source is None else first_source
                    source_cursor = current_cursor
                payload = row["payload"]
                depth = payload["depth_limit"] if depth is None else depth
                if payload["depth_limit"] != depth:
                    raise ValueError("observation depth changed")
                if row["family"] == "l2_book_segment":
                    close_coverage()
                    coverage = None
                    if payload["action"] == "open":
                        at = exact(payload["boundary_ns"])
                        if segment_open or exact(payload["open_ns"]) != at or covered_to is not None and covered_to != at:
                            raise ValueError("segment continuity failed")
                        initial = at if initial is None else initial
                        covered_to = at
                        active_segment = (payload["segment_id"], payload["open_ns"])
                        segment_open = True
                    else:
                        if (not segment_open or active_segment != (payload["segment_id"], payload["open_ns"])
                                or covered_to != exact(payload["boundary_ns"])):
                            raise ValueError("segment closed before coverage")
                        segment_open = False
                        if payload.get("final"):
                            if exact(payload["window_from_ns"]) != initial:
                                raise ValueError("terminal start differs from coverage")
                            terminal = payload
                elif payload["row_kind"] == "coverage":
                    close_coverage()
                    tick = payload["tick_size"] if tick is None else tick
                    if payload["tick_size"] != tick:
                        raise ValueError("tick geometry changed")
                    if not segment_open or active_segment[0] != payload["segment_id"] or covered_to != exact(payload["covered_from_ns"]):
                        raise ValueError("coverage omitted or crosses a segment")
                    covered_to = exact(payload["close_ns"])
                    coverage = payload
                    price = None
                    totals = {"BUY": 0, "SELL": 0}
                    observed_levels = {"bid": [], "ask": []}
                else:
                    fields = ("open_ns", "close_ns", "covered_from_ns", "complete", "point_prefix", "segment_id", "trusted", "reason", "depth_limit")
                    if coverage is None or any(payload[field] != coverage[field] for field in fields):
                        raise ValueError("level has no matching coverage")
                    key = payload["price_key"]
                    if price is not None and key <= price:
                        raise ValueError("duplicate or unordered price")
                    price = key
                    for side in ("bid", "ask"):
                        observed = coverage[side + "_range"]
                        inside = observed is not None and observed[0] <= key <= observed[1]
                        if (payload[side + "_size"] is not None) != inside:
                            raise ValueError("unknown resting size converted to zero")
                        if payload[side + "_size"]:
                            observed_levels[side].append(key)
                    for side, field in (("BUY", "buy_volume"), ("SELL", "sell_volume")):
                        totals[side] += payload[field]
                source, previous = current_source, current
                encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
                amount = len(encoded.encode()) + 1
                if amount + decoded > MAX_PART_DECODED and batch_count:
                    seal()
                if amount > MAX_PART_DECODED or count >= MAX_ROWS:
                    raise ValueError("decoded or total row admission exceeded")
                sink.write(encoded + "\n")
                decoded += amount
                batch_count += 1
                count += 1
                first_known = value["known_ns"] if first_known is None else first_known
                last_known = value["known_ns"]
                if batch_count == part_rows:
                    seal()
            close_coverage()
            if terminal is None or segment_open:
                raise ValueError("terminal coverage proof missing")
            if first_source is not None and not exact(terminal["window_from_ns"]) <= first_source <= source_cursor[0] < exact(terminal["window_to_ns"]):
                raise ValueError("source cursor outside declared window")
            seal()
            if cancelled():
                raise InterruptedError("second write cancelled")
            manifest = {"schema": SCHEMA, "scope": "state/coverage pilot only; no lifecycle or publication acceptance",
                        "derivation_id": source[0], "instrument_id": source[1], "rows": count, "parts": parts,
                        "writer_sha256": digest(Path(__file__)), "duckdb_version": duckdb.__version__,
                        "tick_size": tick, "depth_limit": depth,
                        "window_from_ns": terminal["window_from_ns"], "window_to_ns": terminal["window_to_ns"]}
            pending = directory / "manifest.pending"
            pending.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
            if cancelled():
                raise InterruptedError("second write cancelled")
            pending.replace(directory / "manifest.json")
            return manifest
        finally:
            sink.close()


def read_seconds(directory: Path, manifest_sha256: str, *, from_ns: str, as_of_ns: str,
                 as_of_key: list[str], cancelled=lambda: False) -> list[dict]:
    directory = Path(directory)
    lower, upper = exact(from_ns), exact(as_of_ns)
    if not isinstance(as_of_key, list) or len(as_of_key) != 4:
        raise ValueError("four-field read cursor required")
    cursor = tuple(map(exact, as_of_key))
    if not 0 <= upper - lower <= 3600 * SECOND or cursor[0] > upper:
        raise ValueError("read window admission exceeded")
    path = directory / "manifest.json"
    if path.is_symlink() or path.stat().st_size > 1024 * 1024 or digest(path, cancelled) != manifest_sha256:
        raise ValueError("manifest pin changed")
    manifest = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)
    parts = manifest["parts"]
    if manifest["schema"] != SCHEMA or not isinstance(parts, list) or not 1 <= len(parts) <= MAX_PARTS:
        raise ValueError("manifest admission failed")
    selected, scanned, total = [], 0, 0
    for index, part in enumerate(parts):
        if (part["name"] != f"part-{index:04d}.parquet" or type(part["rows"]) is not int or not 0 < part["rows"] <= MAX_PART_ROWS
                or type(part["bytes"]) is not int or not 0 < part["bytes"] <= MAX_PART_BYTES
                or type(part["decoded_bytes"]) is not int or not 0 < part["decoded_bytes"] <= MAX_PART_DECODED):
            raise ValueError("part admission failed")
        first, last = exact(part["first_known_ns"]), exact(part["last_known_ns"])
        if first > last:
            raise ValueError("part time bounds invalid")
        total += part["rows"]
        if first <= upper and last >= lower:
            scanned += part["bytes"]
            if scanned > MAX_SCAN_BYTES:
                raise ValueError("scan byte admission exceeded")
            selected.append(part)
    if type(manifest["rows"]) is not int or manifest["rows"] != total or total > MAX_ROWS:
        raise ValueError("manifest row count invalid")
    result, used = [], 2
    if used > MAX_READ_BYTES:
        raise ValueError("output admission exceeded; request a smaller window")
    with tempfile.TemporaryDirectory(prefix="historical-second-read-") as scratch:
        with duckdb.connect(config={"threads": "1", "memory_limit": "128MB", "temp_directory": scratch,
                                    "max_temp_directory_size": "256MB"}) as connection:
            for part in selected:
                path = directory / part["name"]
                if path.is_symlink() or path.stat().st_size != part["bytes"] or digest(path, cancelled) != part["sha256"]:
                    raise ValueError("part integrity failed")
                if connection.execute("SELECT sum(num_rows) FROM parquet_file_metadata(?)", [str(path)]).fetchone()[0] != part["rows"]:
                    raise ValueError("part row count invalid")
                condition = "known_event IS NULL OR known_event<? OR (known_event=? AND (known_rank<? OR (known_rank=? AND " \
                            "(known_position<? OR (known_position=? AND known_ordinal<=?)))))"
                query = connection.execute("SELECT * FROM read_parquet(?) WHERE known_ns BETWEEN ? AND ? AND (" + condition + ") "
                                           "ORDER BY append_position LIMIT ?", [str(path), lower, upper, cursor[0], cursor[0], cursor[1],
                                           cursor[1], cursor[2], cursor[2], cursor[3], MAX_READ_ROWS + 1])
                while batch := query.fetchmany(1000):
                    if cancelled():
                        raise InterruptedError("second read cancelled")
                    for values in batch:
                        value = dict(zip(COLUMNS, values))
                        keys = [value.pop(field) for field in ("known_event", "known_rank", "known_position", "known_ordinal")]
                        value["known_key"] = None if all(item is None for item in keys) else [str(item) for item in keys]
                        value["known_ns"] = str(value["known_ns"])
                        value["schema"] = SCHEMA
                        value["payload"] = json.loads(value["payload"], parse_constant=reject_constant)
                        validate(value)
                        if (value["derivation_id"], value["instrument_id"]) != (manifest["derivation_id"], manifest["instrument_id"]):
                            raise ValueError("read identity changed")
                        used += len(json.dumps(value, separators=(",", ":")).encode()) + bool(result)
                        if len(result) >= MAX_READ_ROWS or used > MAX_READ_BYTES:
                            raise ValueError("output admission exceeded; request a smaller window")
                        result.append(value)
                if digest(path, cancelled) != part["sha256"]:
                    raise ValueError("part changed during read")
    if cancelled():
        raise InterruptedError("second read cancelled")
    if digest(directory / "manifest.json", cancelled) != manifest_sha256:
        raise ValueError("manifest changed during read")
    return result
