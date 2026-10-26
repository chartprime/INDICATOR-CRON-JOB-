"""Inspect pinned CME/Nasdaq MBP-10 actions without approving a production merge."""

from __future__ import annotations

import argparse
from collections import Counter, deque
import datetime as dt
import hashlib
from itertools import chain
import json
from pathlib import Path
import tempfile

import databento_dbn as dbn
import duckdb

from fetch_verified_part import DATA_ROOT, MAX_DBN_BYTES
from fetch_verified_partition import MAX_SOURCE_BYTES
from verify_historical_topn_partition import verified_files

UNQUALIFIED_FLAGS = (1 << 2) | (1 << 3)


def validate_source_flags(flags, *, unused_seed_clock=False):
    rejected = (1 << 2) if unused_seed_clock else UNQUALIFIED_FLAGS
    if type(flags) is not int or not 0 <= flags <= 255 or flags & rejected:
        raise ValueError("native source quality flags require explicit gap/receive-clock qualification")


def unused_snapshot_seed_clock(record, index, start):
    return (index == 0 and int(record.ts_event) < start and int(record.ts_recv) == start
            and bool(int(record.flags) & (1 << 5)) and str(record.action) == "A")


def summarize(records, instrument: int, keys: set[tuple], start: int, end: int) -> dict:
    windows = {key: {"rows": [], "remaining": 0, "matched": 0} for key in keys}
    previous = deque(maxlen=8)
    previous_book = None
    counts = Counter()
    actions = Counter()
    outside = 0
    trade_changes = 0
    total = 0

    def encode(index, record):
        return {"native_index": str(index), "instrument_id": record.instrument_id,
                "event_ns": str(record.ts_event), "receive_ns": str(record.ts_recv),
                "sequence": record.sequence, "action": str(record.action), "side": str(record.side),
                "price": str(record.price), "size": record.size, "flags": record.flags,
                "levels": [{"bid_px": str(level.bid_px), "ask_px": str(level.ask_px),
                            "bid_sz": level.bid_sz, "ask_sz": level.ask_sz} for level in record.levels]}

    def book_fields(record):
        return tuple((level.bid_px, level.ask_px, level.bid_sz, level.ask_sz) for level in record.levels)

    for index, record in enumerate(records):
        total += 1
        counts[record.instrument_id] += 1
        if record.instrument_id != instrument:
            raise ValueError("unexpected native instrument")
        if len(record.levels) != 10:
            raise ValueError("native MBP-10 requires ten level slots")
        if not start <= record.ts_event < end:
            outside += 1
        else:
            actions[str(record.action)] += 1
        if str(record.action) == "T" and previous_book is not None:
            if book_fields(record) != book_fields(previous_book):
                trade_changes += 1
        previous_book = record
        key = (record.ts_event, record.ts_recv, record.sequence)
        for target, window in windows.items():
            if key == target:
                if not window["matched"]:
                    window["rows"].extend(encode(i, row) for i, row in previous)
                window["rows"].append(encode(index, record))
                window["matched"] += 1
                window["remaining"] = 8
            elif window["remaining"]:
                window["rows"].append(encode(index, record))
                window["remaining"] -= 1
            if len(window["rows"]) > 128:
                raise ValueError("native witness exceeds 128 rows")
        previous.append((index, record))
    if not total or any(not window["matched"] for window in windows.values()):
        raise ValueError("empty source or absent native witness")
    return {"decoded_rows": total, "rows_by_instrument": dict(counts), "outside_day": outside,
            "actions_in_day": dict(actions), "trade_book_change_count": trade_changes,
            "windows": [{"key": list(map(str, key)), **window} for key, window in sorted(windows.items())]}


def admit_source(raw_path: Path, depth_path: Path, expected_partition: dict | None = None) -> tuple[dict, list[str], str]:
    for path in (raw_path, depth_path):
        if not path.resolve().is_relative_to(DATA_ROOT.resolve()):
            raise ValueError("inputs must be under ignored pilot data")
    if not raw_path.name.endswith(".dbn.zst") or not 0 < raw_path.stat().st_size <= MAX_DBN_BYTES:
        raise ValueError("native file exceeds DBN admission or has wrong format")
    plan, files = verified_files(depth_path, MAX_SOURCE_BYTES)
    if plan["partition"]["family"] != "depth":
        raise ValueError("native source requires a depth partition")
    if expected_partition is not None and expected_partition != plan["partition"]:
        raise ValueError("native witness must match the pinned depth partition")
    with tempfile.TemporaryDirectory(dir=DATA_ROOT, prefix="native-lineage-") as scratch:
        with duckdb.connect(config={"threads": "1", "memory_limit": "256MB", "temp_directory": scratch,
                                    "max_temp_directory_size": "4GB"}) as connection:
            identities = connection.execute(
                "SELECT lineage_sha256, instrument_id, count(*) FROM read_parquet(?) GROUP BY ALL LIMIT 2", [files]).fetchall()
            unsafe_flags = connection.execute(
                "SELECT count(*) FROM read_parquet(?) WHERE dbn_source_flags IS NULL "
                "OR dbn_source_flags NOT BETWEEN 0 AND 255 OR (dbn_source_flags & ?) <> 0",
                [files, UNQUALIFIED_FLAGS]).fetchone()[0]
    if (len(identities) != 1 or identities[0][1] != plan["partition"]["instrument_id"]
            or identities[0][2] != plan["partition"]["record_count"]):
        raise ValueError("native inspection requires one reconciled raw lineage and instrument")
    if unsafe_flags:
        raise ValueError("native source quality flags require explicit gap/receive-clock qualification")
    with raw_path.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    if digest != identities[0][0]:
        raise ValueError("native source hash differs from verified canonical lineage")
    return plan, files, digest


def native_records(raw_path: Path, date: str, *, dataset: str = "GLBX.MDP3"):
    publishers = {"GLBX.MDP3": 1, "XNAS.ITCH": 2}
    if dataset not in publishers:
        raise ValueError("unsupported native dataset profile")
    start = int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    end = start + 86_400_000_000_000
    decoder = dbn.DBNDecoder(compression=dbn.Compression.ZSTD, upgrade_policy=dbn.VersionUpgradePolicy.AS_IS)
    metadata = []

    def records(handle):
        index = 0
        while chunk := handle.read(65536):
            decoded = decoder.write_and_decode(chunk)
            if len(decoder.buffer()) > 4 * 1024 * 1024:
                raise ValueError("native decoder buffer exceeds admission")
            for record in decoded:
                if isinstance(record, dbn.Metadata):
                    if (metadata or str(record.dataset) != dataset or str(record.schema.value) != "mbp-10"
                            or int(record.start) != start or int(record.end) != end):
                        raise ValueError("native metadata differs from the pinned day/schema")
                    ids = {int(interval["symbol"]) for intervals in dict(record.mappings).values()
                           for interval in intervals if str(interval["start_date"]) <= date < str(interval["end_date"])}
                    if len(ids) != 1 or record.partial or record.not_found:
                        raise ValueError("native inspection requires one mapped instrument")
                    metadata.append(ids.pop())
                elif (not metadata or not isinstance(record, dbn.MBP10Msg) or record.publisher_id != publishers[dataset]
                      or record.instrument_id != metadata[0] or len(record.levels) != 10):
                    raise ValueError("unexpected native record or missing metadata")
                else:
                    validate_source_flags(int(record.flags), unused_seed_clock=unused_snapshot_seed_clock(record, index, start))
                    index += 1
                    yield record
        if not metadata or decoder.buffer():
            raise ValueError("incomplete native DBN")

    with raw_path.open("rb") as handle:
        yield from records(handle)


def inspect(raw_path: Path, depth_path: Path, witness_path: Path) -> dict:
    if not witness_path.resolve().is_relative_to(DATA_ROOT.resolve()):
        raise ValueError("inputs must be under ignored pilot data")
    if witness_path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("witness report exceeds admission")
    proof = json.loads(witness_path.read_text(encoding="utf-8"))
    plan, files, digest = admit_source(raw_path, depth_path, proof["depth"])
    keys = {tuple(int(witness["key"][field]) for field in ("event_ns", "receive_ns", "sequence"))
            for witness in proof["eventWitnesses"]}
    if not keys or len(keys) > 13:
        raise ValueError("native witness target count must be between one and thirteen")
    date = plan["partition"]["date"]
    start = int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    end = start + 86_400_000_000_000
    stream = native_records(raw_path, date)
    try:
        first = next(stream, None)
        if first is None:
            raise ValueError("empty native source")
        result = summarize(chain((first,), stream), first.instrument_id, keys, start, end)
    finally:
        stream.close()
    if result["decoded_rows"] - result["outside_day"] != plan["partition"]["record_count"]:
        raise ValueError("native in-day count differs from canonical depth")
    return {"scope": "native action diagnostics only; flow and lifecycle remain unqualified",
            "depth": plan["partition"], "raw_sha256": digest, "raw_bytes": raw_path.stat().st_size, **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-path", type=Path, required=True)
    parser.add_argument("--depth-plan", type=Path, required=True)
    parser.add_argument("--witness-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if (args.output.parent.resolve() != DATA_ROOT.resolve() or args.output.suffix != ".json"
            or args.output.resolve() in {path.resolve() for path in (args.raw_path, args.depth_plan, args.witness_report)}):
        parser.error("output must be a separate JSON report under pilot data")
    result = inspect(args.raw_path, args.depth_plan, args.witness_report)
    args.output.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
    print(json.dumps({"nativeReport": args.output.name, "rows": result["decoded_rows"]}), flush=True)
