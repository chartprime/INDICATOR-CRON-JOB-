"""Copy completed qualification indexes into a sealed operator registry, locally only."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    for family, source_name in (("walls", "index"), ("prints", "prints")):
        destination = args.root / ("served-" + family)
        destination.mkdir(mode=0o700)
        entries = []
        for symbol in ("es", "nq", "aapl", "tsla"):
            source = args.root / "data" / symbol / source_name
            body = (source / "manifest.json").read_bytes()
            manifest = json.loads(body)
            instrument = manifest["instrument_id"]
            day = "2026-08-03" if symbol == "aapl" else "2026-08-05"
            target = destination / hashlib.sha256(instrument.encode()).hexdigest() / day
            target.parent.mkdir(mode=0o700, exist_ok=True)
            shutil.copytree(source, target)
            entries.append({"instrument_id": instrument, "date": day, "manifest_bytes": len(body),
                            "manifest_sha256": hashlib.sha256(body).hexdigest()})
        registry = args.root / (family + "-registry.json")
        with registry.open("x") as stream:
            json.dump(entries, stream, separators=(",", ":"))
        print(json.dumps({"family": family, "qualified_days": len(entries)}), flush=True)


if __name__ == "__main__":
    main()
