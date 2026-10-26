"""Bounded, knowledge-filtered pages over authenticated historical L2 parts."""

from __future__ import annotations

import json
from pathlib import Path

import historical_l2_lifecycles as events
import historical_l2_seconds as states
from historical_l2_events import digest, exact, reject_constant


CONTRACT = "historical-l2-query/1"
MAX_WINDOW_NS = 3600 * states.SECOND
MAX_ROWS = 10_000
MAX_SCAN_BYTES = 64 * 1024**2
MAX_PAGE_BYTES = 4 * 1024**2
ENVELOPE_RESERVE = 4096
MODULES = {"events": events, "states": states}


def manifest_parts(manifest, family):
    module = MODULES.get(family)
    if module is None or not isinstance(manifest, dict) or manifest.get("schema") != module.SCHEMA:
        raise ValueError("unsupported L2 family or manifest")
    module.identity(manifest.get("derivation_id"))
    if not isinstance(manifest.get("instrument_id"), str) or not 1 <= len(manifest["instrument_id"]) <= 128:
        raise ValueError("invalid manifest instrument")
    parts = manifest.get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= module.MAX_PARTS:
        raise ValueError("invalid part inventory")
    result, offset, previous = [], 0, None
    for index, item in enumerate(parts):
        if (not isinstance(item, dict) or item.get("name") != f"part-{index:04d}.parquet"
                or type(item.get("rows")) is not int or not 0 < item["rows"] <= module.MAX_PART_ROWS
                or type(item.get("bytes")) is not int or not 0 < item["bytes"] <= module.MAX_PART_BYTES
                or type(item.get("decoded_bytes")) is not int
                or not 0 < item["decoded_bytes"] <= module.MAX_PART_DECODED):
            raise ValueError("invalid part admission")
        module.identity(item.get("sha256"))
        first, last = exact(item.get("first_known_ns")), exact(item.get("last_known_ns"))
        if first > last or previous is not None and first < previous:
            raise ValueError("part knowledge bounds regress")
        result.append({**item, "first_position": offset, "last_position": offset + item["rows"] - 1})
        offset += item["rows"]
        previous = last
    if type(manifest.get("rows")) is not int or manifest["rows"] != offset or offset > module.MAX_ROWS:
        raise ValueError("manifest count differs")
    return result


def query_arguments(from_ns, to_ns, as_of_key, limit, after_position, max_scan_bytes, max_page_bytes):
    lower, upper = exact(from_ns), exact(to_ns)
    if not 0 < upper - lower <= MAX_WINDOW_NS:
        raise ValueError("invalid half-open L2 window")
    if not isinstance(as_of_key, list) or len(as_of_key) != 4:
        raise ValueError("four-field knowledge cut required")
    cut = tuple(map(exact, as_of_key))
    if cut[0] >= upper:
        raise ValueError("knowledge cut must precede exclusive window end")
    if type(limit) is not int or not 1 <= limit <= MAX_ROWS:
        raise ValueError("invalid L2 page limit")
    if after_position is not None:
        after_position = exact(after_position)
    if (type(max_scan_bytes) is not int or not 1 <= max_scan_bytes <= MAX_SCAN_BYTES
            or type(max_page_bytes) is not int or not ENVELOPE_RESERVE < max_page_bytes <= MAX_PAGE_BYTES):
        raise ValueError("invalid L2 resource budget")
    return lower, upper, cut, after_position


def serialise(values, module, manifest):
    row = dict(zip(module.COLUMNS, values))
    position = row["append_position"]
    if type(position) is not int:
        raise ValueError("invalid append position")
    keys = [row.pop(field) for field in ("known_event", "known_rank", "known_position", "known_ordinal")]
    if any(value is None for value in keys) and not all(value is None for value in keys):
        raise ValueError("partial knowledge key")
    row["known_key"] = None if all(value is None for value in keys) else [str(value) for value in keys]
    row["known_ns"] = str(row["known_ns"])
    if module is events:
        row["source_ns"] = str(row["source_ns"])
    row["schema"] = module.SCHEMA
    row["payload"] = json.loads(row["payload"], parse_constant=reject_constant)
    module.validate(row)
    if (row["derivation_id"], row["instrument_id"]) != (manifest["derivation_id"], manifest["instrument_id"]):
        raise ValueError("L2 row identity differs")
    row["append_position"] = str(position)
    return row


def read_page(connection, manifest, family, resolve_part, *, from_ns, to_ns, as_of_key,
              limit=1000, after_position=None, max_scan_bytes=MAX_SCAN_BYTES,
              max_page_bytes=MAX_PAGE_BYTES, cancelled=lambda: False):
    lower, upper, cut, after = query_arguments(from_ns, to_ns, as_of_key, limit, after_position,
                                               max_scan_bytes, max_page_bytes)
    parts = manifest_parts(manifest, family)
    module = MODULES[family]
    selected = [part for part in parts if exact(part["first_known_ns"]) < upper
                and exact(part["last_known_ns"]) >= lower
                and (after is None or part["last_position"] > after)]
    if after is not None and after >= manifest["rows"]:
        raise ValueError("L2 continuation outside partition")
    rows, used, scanned, opened, progress = [], ENVELOPE_RESERVE + 2, 0, 0, after

    def page(next_position=None, cause=None):
        result = {"rows": rows, "nextPosition": None if next_position is None else str(next_position),
                  "scanBytes": scanned, "partsOpened": opened, "truncatedBy": cause}
        if len(json.dumps(result, separators=(",", ":"), allow_nan=False).encode()) > max_page_bytes:
            raise ValueError("L2 frame exceeds admission")
        return result

    for index, part in enumerate(selected):
        if cancelled():
            raise InterruptedError("L2 page cancelled")
        if scanned + part["bytes"] > max_scan_bytes:
            if progress is None or progress == after:
                raise ValueError("L2 first part exceeds scan admission")
            return page(progress, "scan")
        scanned += part["bytes"]
        with resolve_part(part) as resolved:
            path = Path(resolved)
            if path.is_symlink() or path.stat().st_size != part["bytes"] or digest(path, cancelled) != part["sha256"]:
                raise ValueError("L2 part integrity failed")
            schema = [(name, kind) for name, kind, *_rest in connection.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]).fetchall()]
            if schema != list(module.COLUMNS.items()):
                raise ValueError("L2 part schema differs")
            actual = connection.execute("SELECT count(*),count(DISTINCT append_position),min(append_position),"
                                        "max(append_position),min(known_ns),max(known_ns) FROM read_parquet(?)",
                                        [str(path)]).fetchone()
            if actual != (part["rows"], part["rows"], part["first_position"], part["last_position"],
                          exact(part["first_known_ns"]), exact(part["last_known_ns"])):
                raise ValueError("L2 part bounds or positions differ")
            nulls = "known_event IS NULL AND known_rank IS NULL AND known_position IS NULL AND known_ordinal IS NULL"
            predicate = "(known_event,known_rank,known_position,known_ordinal) <= (?,?,?,?)"
            if module is states:
                predicate = "((" + nulls + ") OR " + predicate + ")"
            query = connection.execute("SELECT * FROM read_parquet(?) WHERE known_ns >= ? AND known_ns < ? AND "
                                       "append_position > ? AND " + predicate + " ORDER BY append_position LIMIT ?",
                                       [str(path), lower, upper, after if after is not None else -1, *cut, limit - len(rows) + 1])
            stop = None
            while values := query.fetchone():
                if cancelled():
                    raise InterruptedError("L2 page cancelled")
                row = serialise(values, module, manifest)
                position = int(row["append_position"])
                if progress is not None and position <= progress:
                    raise ValueError("L2 page positions regress")
                amount = len(json.dumps(row, separators=(",", ":"), allow_nan=False).encode()) + bool(rows)
                if len(rows) >= limit or used + amount > max_page_bytes:
                    if not rows:
                        raise ValueError("L2 row exceeds response admission")
                    stop = "rows" if len(rows) >= limit else "bytes"
                    break
                rows.append(row)
                used += amount
                progress = position
            if digest(path, cancelled) != part["sha256"]:
                raise ValueError("L2 part changed during page")
            opened += 1
            if stop:
                return page(progress, stop)
            progress = part["last_position"]
            if len(rows) == limit and index + 1 < len(selected):
                return page(progress, "rows")
    if cancelled():
        raise InterruptedError("L2 page cancelled")
    return page()
