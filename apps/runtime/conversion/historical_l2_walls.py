"""Bounded wall-index admission and reads, anchored to the pinned L2 release."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
from pathlib import Path

import historical_l2_catalog as catalog
from historical_l2_events import exact, reject_constant
from historical_l2_reader import query_arguments, MAX_SCAN_BYTES, MAX_PAGE_BYTES, ENVELOPE_RESERVE

MAX_PART_BYTES = 4 * 1024**2


def encoded(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def pinned_file(path, size, checksum):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
        raise ValueError("wall-index local file identity differs")
    with path.open("rb") as source:
        body = source.read(size + 1)
    if len(body) != size or hashlib.sha256(body).hexdigest() != checksum:
        raise ValueError("wall-index local hash differs")
    return body


def manifest_parts(manifest):
    if not isinstance(manifest, dict) or manifest.get("schema") != "historical-l2-wall-index/1":
        raise ValueError("sealed wall-index required")
    for key in ("release_id", "descriptor_sha256", "event_manifest_sha256", "derivation_id", "profile_id"):
        catalog.sha(manifest.get(key))
    catalog.identity(manifest.get("instrument_id"))
    profile = manifest.get("profile")
    if not isinstance(profile, dict) or hashlib.sha256(encoded(profile)).hexdigest() != manifest["profile_id"]:
        raise ValueError("wall-index detector profile differs")
    start, end = exact(manifest.get("from_ns")), exact(manifest.get("to_ns"))
    if not 0 < end - start <= 86_400_000_000_000 or manifest.get("sample_ms") != 1000:
        raise ValueError("wall-index window/cadence unsupported")
    parts = manifest.get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 4096:
        raise ValueError("wall-index part inventory invalid")
    offset, total, previous = 0, 0, start
    for index, part in enumerate(parts):
        if (not isinstance(part, dict) or part.get("key") != f"part-{index:04d}.jsonl.gz"
                or type(part.get("bytes")) is not int or not 0 < part["bytes"] <= MAX_PART_BYTES + 4096
                or type(part.get("decoded_bytes")) is not int or not 0 < part["decoded_bytes"] <= MAX_PART_BYTES
                or type(part.get("rows")) is not int or not 0 < part["rows"] <= 4156
                or part.get("first_position") != offset or part.get("last_position") != offset + part["rows"] - 1):
            raise ValueError("wall-index part bounds invalid")
        catalog.sha(part.get("sha256"))
        catalog.sha(part.get("decoded_sha256"))
        lower, upper = exact(part.get("min_known_ns")), exact(part.get("max_known_ns"))
        if lower < previous or upper < lower or lower < start or upper > end:
            raise ValueError("wall-index knowledge bounds invalid")
        offset += part["rows"]
        total += part["bytes"]
        previous = upper
    if (offset != manifest.get("rows") or offset > 90500 or total != manifest.get("encoded_bytes")
            or total > 256 * 1024**2 or type(manifest.get("samples")) is not int
            or type(manifest.get("segments")) is not int or manifest["samples"] + manifest["segments"] != offset
            or not 1 <= manifest["segments"] <= 4096 or not 1 <= manifest["samples"] <= 86401):
        raise ValueError("wall-index totals differ")
    return parts


class Registry:
    """Operator-owned immutable local registry. Request bodies never supply paths."""

    def __init__(self, root, entries):
        self.root = Path(root).resolve(strict=True)
        self.entries = {}
        if not isinstance(entries, list) or len(entries) > 124:
            raise ValueError("wall-index registry exceeds scope")
        for entry in entries:
            instrument = catalog.identity(entry["instrument_id"])
            day = entry["date"]
            if catalog.DATE.fullmatch(day) is None:
                raise ValueError("wall-index registry date invalid")
            slug = hashlib.sha256(entry["instrument_id"].encode()).hexdigest()
            directory = self.root / slug / day
            if directory.is_symlink() or directory.parent.is_symlink():
                raise ValueError("wall-index directory symlink refused")
            size = entry["manifest_bytes"]
            if type(size) is not int or not 0 < size <= MAX_PART_BYTES:
                raise ValueError("wall-index manifest exceeds admission")
            body = pinned_file(directory / "manifest.json", size, catalog.sha(entry["manifest_sha256"]))
            manifest = json.loads(body, parse_constant=reject_constant)
            manifest_parts(manifest)
            if manifest["instrument_id"] != entry["instrument_id"] or manifest["profile"]["tick_size"] != ("0.25" if instrument[1] == "FUTURE" else "0.01"):
                raise ValueError("wall-index instrument/geometry differs")
            key = (entry["instrument_id"], day)
            if key in self.entries:
                raise ValueError("duplicate wall-index registry day")
            self.entries[key] = (directory, body, manifest)

    def admit(self, pointer, release, descriptor, event_manifest, instrument, day):
        entry = self.entries.get((instrument, day))
        if entry is None:
            raise catalog.Unavailable("WALL_INDEX_NOT_QUALIFIED")
        directory, body, manifest = entry
        pinned_file(directory / "manifest.json", len(body), hashlib.sha256(body).hexdigest())
        session = next(row for row in release["sessions"] if row["instrument_id"] == instrument and row["date"] == day)
        if (manifest["release_id"] != pointer["release_id"] or manifest["descriptor_sha256"] != session["descriptor_sha256"]
                or manifest["event_manifest_sha256"] != descriptor["families"]["events"]["manifest_sha256"]
                or manifest["derivation_id"] != descriptor["derivation_id"] or manifest["input_rows"] != event_manifest["rows"]
                or manifest["from_ns"] != descriptor["window_from_ns"] or manifest["to_ns"] != descriptor["window_to_ns"]):
            raise ValueError("wall-index source release differs")
        return manifest, directory


def read_page(manifest, paths, *, from_ns, to_ns, as_of_key, limit=1000, after_position=None,
              max_scan_bytes=MAX_SCAN_BYTES, max_page_bytes=MAX_PAGE_BYTES, cancelled=lambda: False):
    lower, upper, cut, after = query_arguments(from_ns, to_ns, as_of_key, limit, after_position, max_scan_bytes, max_page_bytes)
    parts = manifest_parts(manifest)
    if after is not None and after >= manifest["rows"]:
        raise ValueError("wall-index continuation outside partition")
    selected = [part for part in parts if exact(part["min_known_ns"]) < upper and exact(part["max_known_ns"]) >= lower
                and (after is None or part["last_position"] > after)]
    rows, used, scanned, opened, progress = [], ENVELOPE_RESERVE + 2, 0, 0, after

    def result(position=None, reason=None):
        return {"rows": rows, "nextPosition": None if position is None else str(position),
                "scanBytes": scanned, "partsOpened": opened, "truncatedBy": reason}

    for part in selected:
        if cancelled():
            raise InterruptedError("wall-index read cancelled")
        if scanned + part["bytes"] > max_scan_bytes:
            if progress is None or progress == after:
                raise ValueError("wall-index first part exceeds admission")
            return result(progress, "scan")
        body = pinned_file(paths[part["key"]], part["bytes"], part["sha256"])
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as compressed:
            decoded = compressed.read(part["decoded_bytes"] + 1)
        if len(decoded) != part["decoded_bytes"] or hashlib.sha256(decoded).hexdigest() != part["decoded_sha256"] or not decoded.endswith(b"\n"):
            raise ValueError("wall-index decoded identity differs")
        records = decoded.splitlines()
        if len(records) != part["rows"]:
            raise ValueError("wall-index row count differs")
        scanned += part["bytes"]
        opened += 1
        previous = None
        for offset, raw in enumerate(records):
            if cancelled():
                raise InterruptedError("wall-index read cancelled")
            value = json.loads(raw, parse_constant=reject_constant)
            known = exact(value["known_ns"])
            if (value.get("profile_id") != manifest["profile_id"] or known < exact(part["min_known_ns"])
                    or known > exact(part["max_known_ns"]) or previous is not None and known < previous
                    or offset == 0 and known != exact(part["min_known_ns"])
                    or offset == len(records) - 1 and known != exact(part["max_known_ns"])):
                raise ValueError("wall-index record bounds differ")
            previous = known
            sample = value.get("schema") == "historical-l2-wall-view/2"
            if not sample and value.get("schema") != "historical-l2-wall-segment-end/2":
                raise ValueError("wall-index record schema unsupported")
            key = value.get("through_known_key") if sample else None
            if sample and (value.get("instrument_id") != manifest["instrument_id"] or value.get("derivation_id") != manifest["derivation_id"]
                           or not isinstance(key, list) or len(key) != 4 or tuple(map(exact, key))[0] > known):
                raise ValueError("wall-index record identity differs")
            position = part["first_position"] + offset
            if position <= (after if after is not None else -1) or not lower <= known < upper or known > cut[0] or key is not None and tuple(map(exact, key)) > cut:
                continue
            row = {"schema": "historical-l2-wall-record/1", "instrument_id": manifest["instrument_id"],
                   "derivation_id": manifest["derivation_id"], "append_position": str(position), "known_ns": str(known),
                   "known_key": key, "payload": value, "record_id": hashlib.sha256(raw).hexdigest()}
            amount = len(encoded(row)) + bool(rows)
            if len(rows) >= limit or used + amount > max_page_bytes:
                if not rows:
                    raise ValueError("wall-index row exceeds response budget")
                return result(progress, "rows" if len(rows) >= limit else "bytes")
            rows.append(row)
            used += amount
            progress = position
        pinned_file(paths[part["key"]], part["bytes"], part["sha256"])
        progress = part["last_position"]
    return result()
