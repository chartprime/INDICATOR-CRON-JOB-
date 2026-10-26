"""Exact individual source prints, sealed locally and pinned to a qualified day."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

import historical_l2_catalog as catalog
from historical_l2_events import exact, reject_constant
from historical_l2_reader import query_arguments, MAX_PAGE_BYTES, MAX_SCAN_BYTES, ENVELOPE_RESERVE
from historical_l2_walls import encoded, pinned_file

PART_BYTES = 4 * 1024**2


def manifest_parts(manifest):
    if manifest.get("schema") != "historical-l2-print-index/1":
        raise ValueError("sealed source-print index required")
    for key in ("release_id", "descriptor_sha256", "derivation_id"):
        catalog.sha(manifest[key])
    catalog.identity(manifest["instrument_id"])
    start, end = exact(manifest["from_ns"]), exact(manifest["to_ns"])
    if not 0 < end - start <= 86_400_000_000_000:
        raise ValueError("print-index window differs")
    offset, total, previous = 0, 0, start
    parts = manifest["parts"]
    if not isinstance(parts, list) or not 0 <= len(parts) <= 4096 or (len(parts) == 0) != (manifest["rows"] == 0):
        raise ValueError("print-index inventory invalid")
    for index, part in enumerate(parts):
        if (part["key"] != f"part-{index:04d}.jsonl.gz" or type(part["rows"]) is not int or not 1 <= part["rows"] <= 10000
                or type(part["bytes"]) is not int or not 0 < part["bytes"] <= PART_BYTES + 4096
                or type(part["decoded_bytes"]) is not int or not 0 < part["decoded_bytes"] <= PART_BYTES
                or part["first_position"] != offset or part["last_position"] != offset + part["rows"] - 1):
            raise ValueError("print-index part bounds differ")
        catalog.sha(part["sha256"])
        catalog.sha(part["decoded_sha256"])
        lower, upper = exact(part["min_known_ns"]), exact(part["max_known_ns"])
        if not previous <= lower <= upper or lower < start or upper > end:
            raise ValueError("print-index time regresses")
        previous = upper
        offset += part["rows"]
        total += part["bytes"]
    if offset != manifest["rows"] or offset > 10_000_000 or total != manifest["encoded_bytes"] or total > 256 * 1024**2:
        raise ValueError("print-index totals differ")
    return parts


def write_index(observations, directory, *, descriptor, release_id, descriptor_sha256, expected_rows):
    directory = Path(directory)
    directory.mkdir(mode=0o700)
    parts, chunks, sizes = [], [], {side: {"count": 0, "volume": 0} for side in ("BUY", "SELL", "UNKNOWN")}
    rows, source_rows, byte_count, encoded_total, previous = 0, 0, 0, 0, -1
    previous_key = None
    digest = hashlib.sha256()

    def flush():
        nonlocal chunks, byte_count, encoded_total
        if not chunks:
            return
        if len(parts) >= 4096:
            raise ValueError("print-index part budget")
        raw = b"".join(chunks)
        body = gzip.compress(raw, mtime=0)
        first, last = map(json.loads, (chunks[0], chunks[-1]))
        part = {"key": f"part-{len(parts):04d}.jsonl.gz", "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                "decoded_bytes": len(raw), "decoded_sha256": hashlib.sha256(raw).hexdigest(), "rows": len(chunks),
                "first_position": rows - len(chunks), "last_position": rows - 1,
                "min_known_ns": first["known_ns"], "max_known_ns": last["known_ns"]}
        with (directory / part["key"]).open("xb") as target:
            target.write(body)
            target.flush()
            os.fsync(target.fileno())
        parts.append(part)
        encoded_total += len(body)
        if encoded_total > 256 * 1024**2:
            raise ValueError("print-index day budget")
        chunks, byte_count = [], 0

    for observation in observations:
        source_rows += 1
        if source_rows > expected_rows or observation["instrument_id"] != descriptor["instrument_id"]:
            raise ValueError("source print identity/count differs")
        trade = observation["matched_trade"]
        if trade is None:
            continue
        event, known = exact(trade["event_ns"]), exact(observation["known_ns"])
        side, size = trade["side"], exact(trade["size"])
        key = []
        for field in ("event_ns", "source_rank", "stable_position", "ordinal"):
            value = observation[field]
            if type(value) not in (str, int):
                raise ValueError("source print key type invalid")
            key.append(str(exact(str(value))))
        numeric_key = tuple(map(int, key))
        try:
            price = Decimal(trade["price"])
        except (InvalidOperation, TypeError) as error:
            raise ValueError("source print price invalid") from error
        record_id = trade["record_id"]
        native_id = re.fullmatch(r"raw:[a-f0-9]{64}:(0|[1-9][0-9]*)", record_id) if isinstance(record_id, str) else None
        if native_id is not None:
            if catalog.identity(descriptor["instrument_id"])[1] != "FUTURE" or native_id[1] != key[2]:
                raise ValueError("native source print position differs")
        else:
            catalog.sha(record_id)
        if not price.is_finite() or price <= 0 or known < numeric_key[0] or known == previous and previous_key is not None and numeric_key <= previous_key:
            raise ValueError("source print price/key invalid")
        if side not in sizes or size <= 0 or size > 9007199254740991 or known < max(event, previous):
            raise ValueError("source print time/quantity differs")
        previous = known
        previous_key = numeric_key
        payload = {"schema": "historical-l2-source-print/1", "known_ns": str(known), "event_ns": str(event),
                   "side": side, "price": trade["price"], "size": int(size), "record_id": trade["record_id"],
                   "known_key": key}
        line = encoded(payload) + b"\n"
        if len(line) > 16384:
            raise ValueError("source print record budget")
        if chunks and (len(chunks) >= 10000 or byte_count + len(line) > PART_BYTES):
            flush()
        chunks.append(line)
        byte_count += len(line)
        rows += 1
        if rows > 10_000_000:
            raise ValueError("source print row budget")
        digest.update(line)
        sizes[side]["count"] += 1
        sizes[side]["volume"] += size
    if source_rows != expected_rows or sizes != descriptor["flow_counts"]["observed"]:
        raise ValueError("source print totals differ from independently qualified day")
    flush()
    manifest = {"schema": "historical-l2-print-index/1", "release_id": release_id, "descriptor_sha256": descriptor_sha256,
                "instrument_id": descriptor["instrument_id"], "derivation_id": descriptor["derivation_id"],
                "from_ns": descriptor["window_from_ns"], "to_ns": descriptor["window_to_ns"], "rows": rows,
                "source_rows": source_rows, "counts": sizes, "prints_sha256": digest.hexdigest(),
                "encoded_bytes": encoded_total, "parts": parts}
    manifest_parts(manifest)
    temporary = directory / ".manifest.pending"
    with temporary.open("xb") as target:
        target.write(encoded(manifest))
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, directory / "manifest.json")
    if os.name != "nt":
        handle = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(handle)
        finally:
            os.close(handle)
    return manifest


class Registry:
    def __init__(self, root, entries):
        self.root = Path(root).resolve(strict=True)
        self.entries = {}
        if not isinstance(entries, list) or len(entries) > 124:
            raise ValueError("print registry scope differs")
        for entry in entries:
            instrument, day = entry["instrument_id"], entry["date"]
            catalog.identity(instrument)
            if not isinstance(day, str) or catalog.DATE.fullmatch(day) is None:
                raise ValueError("print registry day invalid")
            directory = self.root / hashlib.sha256(instrument.encode()).hexdigest() / day
            if directory.is_symlink() or directory.parent.is_symlink():
                raise ValueError("print registry symlink refused")
            size = entry["manifest_bytes"]
            if type(size) is not int or not 0 < size <= PART_BYTES:
                raise ValueError("print registry manifest budget")
            body = pinned_file(directory / "manifest.json", size, catalog.sha(entry["manifest_sha256"]))
            manifest = json.loads(body, parse_constant=reject_constant)
            manifest_parts(manifest)
            if manifest["instrument_id"] != instrument or (instrument, day) in self.entries:
                raise ValueError("print registry identity differs")
            self.entries[instrument, day] = directory, body, manifest

    def admit(self, pointer, release, descriptor, _events, instrument, day):
        value = self.entries.get((instrument, day))
        if value is None:
            raise catalog.Unavailable("SOURCE_PRINT_INDEX_NOT_QUALIFIED")
        directory, body, manifest = value
        pinned_file(directory / "manifest.json", len(body), hashlib.sha256(body).hexdigest())
        session = next(row for row in release["sessions"] if row["instrument_id"] == instrument and row["date"] == day)
        if (manifest["release_id"] != pointer["release_id"] or manifest["descriptor_sha256"] != session["descriptor_sha256"]
                or manifest["derivation_id"] != descriptor["derivation_id"] or manifest["from_ns"] != descriptor["window_from_ns"]
                or manifest["to_ns"] != descriptor["window_to_ns"] or manifest["source_rows"] != descriptor["flow_counts"]["rows"]
                or manifest["counts"] != descriptor["flow_counts"]["observed"]):
            raise ValueError("source print release differs")
        return manifest, directory


def read_page(manifest, paths, *, from_ns, to_ns, as_of_key, limit=1000, after_position=None,
              max_scan_bytes=MAX_SCAN_BYTES, max_page_bytes=MAX_PAGE_BYTES, cancelled=lambda: False):
    lower, upper, cut, after = query_arguments(from_ns, to_ns, as_of_key, limit, after_position, max_scan_bytes, max_page_bytes)
    parts = manifest_parts(manifest)
    if after is not None and after >= manifest["rows"]:
        raise ValueError("source print cursor outside partition")
    rows, used, scanned, opened, progress = [], ENVELOPE_RESERVE + 2, 0, 0, after

    def result(position=None, reason=None):
        return {"rows": rows, "nextPosition": None if position is None else str(position),
                "scanBytes": scanned, "partsOpened": opened, "truncatedBy": reason}

    for part in parts:
        if (exact(part["min_known_ns"]) >= upper or exact(part["max_known_ns"]) < lower
                or after is not None and part["last_position"] <= after):
            continue
        if cancelled():
            raise InterruptedError("source print read cancelled")
        if scanned + part["bytes"] > max_scan_bytes:
            if progress is None or progress == after:
                raise ValueError("source print first part exceeds admission")
            return result(progress, "scan")
        body = pinned_file(paths[part["key"]], part["bytes"], part["sha256"])
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as compressed:
            raw = compressed.read(part["decoded_bytes"] + 1)
        if len(raw) != part["decoded_bytes"] or hashlib.sha256(raw).hexdigest() != part["decoded_sha256"] or not raw.endswith(b"\n"):
            raise ValueError("source print decoded bytes differ")
        records = raw.splitlines()
        if len(records) != part["rows"]:
            raise ValueError("source print rows differ")
        scanned += part["bytes"]
        opened += 1
        previous = exact(part["min_known_ns"])
        for offset, line in enumerate(records):
            if cancelled():
                raise InterruptedError("source print read cancelled")
            payload = json.loads(line, parse_constant=reject_constant)
            known, event = exact(payload["known_ns"]), exact(payload["event_ns"])
            key = tuple(map(exact, payload["known_key"]))
            if (payload["schema"] != "historical-l2-source-print/1" or not previous <= known <= exact(part["max_known_ns"])
                    or known < event or len(key) != 4 or key[0] > known
                    or offset == 0 and known != exact(part["min_known_ns"])
                    or offset == len(records) - 1 and known != exact(part["max_known_ns"])):
                raise ValueError("source print time/schema differs")
            previous = known
            position = part["first_position"] + offset
            if position <= (after if after is not None else -1) or not lower <= known < upper or known > cut[0] or key > cut:
                continue
            row = {"schema": "historical-l2-print-record/1", "instrument_id": manifest["instrument_id"],
                   "derivation_id": manifest["derivation_id"], "append_position": str(position), "known_ns": str(known),
                   "known_key": payload["known_key"], "payload": payload, "record_id": hashlib.sha256(line).hexdigest()}
            amount = len(encoded(row)) + bool(rows)
            if len(rows) >= limit or used + amount > max_page_bytes:
                if not rows:
                    raise ValueError("source print row exceeds response budget")
                return result(progress, "rows" if len(rows) >= limit else "bytes")
            rows.append(row)
            used += amount
            progress = position
        progress = part["last_position"]
    return result()
