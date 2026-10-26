"""Fetch a manifest-inspected pilot partition into ignored local data, with bounded concurrency."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import shutil

from fetch_verified_part import DATA_ROOT, MAX_PART_BYTES, fetch


DEFAULT_SOURCE_BYTES = 256 * 1024 * 1024
MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024


def load_plan(path: Path, max_source_bytes: int = DEFAULT_SOURCE_BYTES) -> dict:
    if type(max_source_bytes) is not int or not 1 <= max_source_bytes <= MAX_SOURCE_BYTES:
        raise ValueError("local pilot source budget must be between 1 byte and 2 GiB")
    if not path.resolve().is_relative_to(DATA_ROOT.resolve()):
        raise ValueError("plan must be under ignored pilot data")
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("plan exceeds size limit")
    plan = json.loads(path.read_text(encoding="utf-8-sig"))
    parts = plan["parts"]
    if not isinstance(parts, list) or not parts or len(parts) != plan["partition"]["part_count"]:
        raise ValueError("part count differs from catalog")
    for part in parts:
        if (type(part.get("rows")) is not int or part["rows"] <= 0
                or type(part.get("bytes")) is not int or not 1 <= part["bytes"] <= MAX_PART_BYTES
                or not isinstance(part.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", part["sha256"])):
            raise ValueError("invalid part identity or size")
    names = [part["name"] for part in parts]
    if len(set(names)) != len(names) or any(not re.fullmatch(r"part-\d{5}\.parquet", name) for name in names):
        raise ValueError("invalid or duplicate part names")
    if sum(part["rows"] for part in parts) != plan["partition"]["record_count"]:
        raise ValueError("row count differs from catalog")
    if sum(part["bytes"] for part in parts) > max_source_bytes:
        raise ValueError("local pilot exceeds explicit source byte admission")
    return plan


def destination(plan: dict, name: str) -> Path:
    partition = plan["partition"]
    folder = f"{partition['family']}-{partition['date']}-{partition['manifest_sha256'][:12]}"
    if not re.fullmatch(r"(?:depth|trade|quote)-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}", folder):
        raise ValueError("invalid partition identity")
    return DATA_ROOT / folder / name


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--max-source-bytes", type=int, default=DEFAULT_SOURCE_BYTES)
    args = parser.parse_args()
    plan = load_plan(args.plan, args.max_source_bytes)
    source_bytes = sum(part["bytes"] for part in plan["parts"])
    if shutil.disk_usage(DATA_ROOT).free < source_bytes + DEFAULT_SOURCE_BYTES:
        raise RuntimeError("insufficient free disk for admitted pilot source plus reserve")

    def copy(part):
        fetch(host=args.host, relative_key=plan["relative_prefix"] + "/" + part["name"],
              expected_sha256=part["sha256"], expected_bytes=part["bytes"],
              output=destination(plan, part["name"]))
        print(json.dumps({"verified": part["name"], "bytes": part["bytes"]}), flush=True)

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(copy, plan["parts"]))
