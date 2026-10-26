"""Independent bounded writer process for one complete-day output family."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parents[3] / "conversion"))
import historical_l2_lifecycles
import historical_l2_seconds


def records():
    while line := sys.stdin.buffer.readline(16_386):
        if len(line) > 16_384 or not line.endswith(b"\n"):
            raise ValueError("family input row admission exceeded")
        yield json.loads(line)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("family", choices=("events", "states"))
    parser.add_argument("directory", type=Path)
    parser.add_argument("max_rows", type=int)
    args = parser.parse_args()
    module = historical_l2_lifecycles if args.family == "events" else historical_l2_seconds
    if not 1 <= args.max_rows <= module.MAX_ROWS:
        parser.error("writer row admission invalid")
    module.MAX_ROWS = args.max_rows
    manifest = module.write_parts(records(), args.directory)
    print(json.dumps({"rows": manifest["rows"], "parts": len(manifest["parts"])}), flush=True)
