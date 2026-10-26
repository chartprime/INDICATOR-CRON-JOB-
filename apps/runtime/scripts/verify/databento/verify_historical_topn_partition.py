"""Stream hash-verified, exactly ordered pilot parts into the JavaScript engine oracle."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import duckdb

from export_topn_part import FIELDS
from fetch_verified_partition import DEFAULT_SOURCE_BYTES, destination, load_plan


def verified_files(plan_path: Path, max_source_bytes: int = DEFAULT_SOURCE_BYTES) -> tuple[dict, list[str]]:
    plan = load_plan(plan_path, max_source_bytes)
    files = []
    for part in plan["parts"]:
        path = destination(plan, part["name"])
        if path.stat().st_size != part["bytes"]:
            raise ValueError("part byte count differs from manifest")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != part["sha256"]:
            raise ValueError("part hash differs from manifest")
        files.append(str(path))
    return plan, files


def ordered_depth_parts(connection, plan: dict, files: list[str]) -> list[tuple]:
    keys = ', '.join(FIELDS[:4])
    ordered = []
    for part, path in zip(plan["parts"], files):
        if connection.execute("SELECT count(*) FROM read_parquet(?) WHERE instrument_id IS NULL OR instrument_id<>?",
                              [path, plan["partition"]["instrument_id"]]).fetchone()[0]:
            raise ValueError("decoded instrument identity differs from pinned catalog")
        rows, first, last = connection.execute(
            f"SELECT count(*), min(row({keys})), max(row({keys})) FROM read_parquet(?)", [path]).fetchone()
        if rows != part["rows"] or not rows:
            raise ValueError("part row count differs from manifest")
        ordered.append((first, last, path))
    ordered.sort()
    for previous, current in zip(ordered, ordered[1:]):
        if current[0] <= previous[1]:
            raise ValueError("parts overlap in archive order; pilot requires a bounded merge")
    return ordered


def json_depth_fields(alias: str = "") -> str:
    fields = []
    for field in FIELDS:
        name = alias + field
        if field in FIELDS[:4]:
            expression = f"CAST({name} AS VARCHAR)"
        elif field in ("bids", "asks"):
            expression = (f"list_transform({name}, level -> struct_pack("
                          "price := CAST(level.price AS VARCHAR), size := CAST(level.size AS VARCHAR)))")
        else:
            expression = name
        fields.append(f"{field} := {expression}")
    return ', '.join(fields)


def verify(plan_path: Path, tick_size: str, node: str, max_source_bytes: int = DEFAULT_SOURCE_BYTES) -> dict:
    plan, files = verified_files(plan_path, max_source_bytes)
    if plan["partition"]["family"] != "depth":
        raise ValueError("book oracle requires a depth partition")
    started = time.monotonic()
    folder = destination(plan, plan["parts"][0]["name"]).parent
    scratch = tempfile.TemporaryDirectory(dir=folder, prefix="duckdb-")
    connection = duckdb.connect(config={"threads": "1", "memory_limit": "256MB",
                                        "temp_directory": scratch.name, "max_temp_directory_size": "4GB"})
    count = 0
    source_quality = {"incomplete": 0, "crossed": 0, "gapSuspected": 0}
    script = Path(__file__).with_name("verify-historical-topn-part.js")
    try:
        fields = json_depth_fields()
        ordered_parts = ordered_depth_parts(connection, plan, files)
        for _first, _last, path in ordered_parts:
            quality = connection.execute("SELECT count(*) FILTER (WHERE len(bids)=0 OR len(asks)=0), "
                                         "count(*) FILTER (WHERE bids[1].price>=asks[1].price), "
                                         "count(*) FILTER (WHERE continuity='GAP_SUSPECTED') "
                                         "FROM read_parquet(?)", [path]).fetchone()
            for name, value in zip(source_quality, quality):
                source_quality[name] += value
        keys = ', '.join(FIELDS[:4])
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            with subprocess.Popen([node, str(script), "-", tick_size, "10"], stdin=subprocess.PIPE,
                                  stdout=output, stderr=errors) as process:
                assert process.stdin is not None
                try:
                    reported = 0
                    for _first, _last, path in ordered_parts:
                        cursor = connection.execute(
                            f"SELECT to_json(struct_pack({fields}, date := ?)) "
                            f"FROM read_parquet(?) ORDER BY {keys}", [plan["partition"]["date"], path])
                        while rows := cursor.fetchmany(1000):
                            process.stdin.write("".join(values[0] + "\n" for values in rows).encode("utf-8"))
                            count += len(rows)
                            if count - reported >= 100_000:
                                reported = count
                                print(json.dumps({"replayed": count, "expected": plan["partition"]["record_count"]}),
                                      file=sys.stderr, flush=True)
                    process.stdin.close()
                    status = process.wait()
                except BaseException:
                    process.kill()
                    process.wait()
                    errors.seek(0)
                    message = errors.read(4096).decode("utf-8", errors="replace")
                    if message:
                        raise RuntimeError(message) from None
                    raise
            if status:
                errors.seek(0)
                raise RuntimeError(errors.read(4096).decode("utf-8", errors="replace"))
            output.seek(0)
            result = json.loads(output.read(65536))
    finally:
        connection.close()
        scratch.cleanup()
    if count != plan["partition"]["record_count"] or result["rows"] != count:
        raise ValueError("replayed row count differs from catalog")
    if source_quality["gapSuspected"] == 0 and result["trusted"] != count - source_quality["incomplete"] - source_quality["crossed"]:
        raise ValueError("trusted book count differs from independent source quality counts")
    return {"partition": plan["partition"], "partCount": len(files),
            "sourceBookQuality": source_quality,
            "sourceBytes": sum(part["bytes"] for part in plan["parts"]),
            "totalElapsedSeconds": round(time.monotonic() - started, 2), "oracle": result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--tick-size", required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--max-source-bytes", type=int, default=DEFAULT_SOURCE_BYTES)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output is not None and (args.output.parent.resolve() != args.plan.parent.resolve()
                                   or args.output.suffix != ".json" or args.output.resolve() == args.plan.resolve()):
        parser.error("output must be a separate JSON file next to the local pilot plan")
    result = verify(args.plan, args.tick_size, args.node, args.max_source_bytes)
    if args.output is None:
        print(json.dumps(result, sort_keys=True))
    else:
        args.output.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
        print(json.dumps({"verifiedReport": args.output.name, "rows": result["oracle"]["rows"]}))
