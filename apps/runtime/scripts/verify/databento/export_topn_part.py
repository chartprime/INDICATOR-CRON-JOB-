"""Export exact ordered top-N columns from one locally verified pilot part."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

import duckdb


DATA_ROOT = Path(__file__).resolve().parents[3] / "data" / "historical-l2-pilot"
FIELDS = ("event_ns", "source_rank", "stable_position", "ordinal", "instrument_id",
          "depth_action", "depth_model", "depth_limit", "bids", "asks", "continuity", "book_epoch")


def export(part: Path, expected_sha256: str, output: Path, date: str) -> int:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("invalid part identity or date")
    root = DATA_ROOT.resolve()
    source, target = part.resolve(), output.resolve()
    if not source.is_relative_to(root) or source.suffix != ".parquet":
        raise ValueError("part must be under ignored pilot data")
    if not target.is_relative_to(root) or target.suffix != ".jsonl":
        raise ValueError("output must be JSONL under ignored pilot data")
    if hashlib.sha256(source.read_bytes()).hexdigest() != expected_sha256:
        raise ValueError("part hash mismatch")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError("pilot JSONL output already exists")
    connection = duckdb.connect(config={"threads": "1", "memory_limit": "256MB"})
    count = 0
    try:
        names = ", ".join(FIELDS)
        order = ", ".join(FIELDS[:4])
        cursor = connection.execute(f"SELECT {names} FROM read_parquet(?) ORDER BY {order}", [str(source)])
        with target.open("x", encoding="utf-8", newline="\n") as sink:
            while rows := cursor.fetchmany(1000):
                for values in rows:
                    record = dict(zip(FIELDS, values))
                    for field in FIELDS[:4]:
                        record[field] = str(record[field])
                    sink.write(json.dumps({**record, "date": date}, default=str,
                                          separators=(",", ":")) + "\n")
                    count += 1
    finally:
        connection.close()
    return count


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--part", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--date", required=True)
    options = parser.parse_args()
    print(json.dumps({"rows": export(options.part, options.sha256, options.out, options.date)}))
