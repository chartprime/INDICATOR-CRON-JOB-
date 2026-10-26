"""Compare every sealed index sample with a retained independent native receipt."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "conversion"))
from historical_l2_walls import manifest_parts, pinned_file


def verify(directory, native_receipt):
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError("index directory symlink refused")
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 4 * 1024**2:
        raise ValueError("index manifest too large")
    with manifest_path.open("rb") as source:
        raw = source.read(4 * 1024**2 + 1)
    if len(raw) > 4 * 1024**2:
        raise ValueError("index manifest too large")
    manifest = json.loads(raw)
    parts = manifest_parts(manifest)
    native = json.loads(Path(native_receipt).read_bytes())
    if (native.get("status") != "PASS" or native.get("release_id") != manifest["release_id"]
            or native.get("descriptor_sha256") != manifest["descriptor_sha256"]):
        raise ValueError("independent native source identity differs")
    digest, count, closures = hashlib.sha256(), 0, 0
    for part in parts:
        data = pinned_file(directory / part["key"], part["bytes"], part["sha256"])
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
            decoded = compressed.read(part["decoded_bytes"] + 1)
        if len(decoded) != part["decoded_bytes"] or hashlib.sha256(decoded).hexdigest() != part["decoded_sha256"]:
            raise ValueError("index decoded bytes differ")
        values = decoded.splitlines()
        if len(values) != part["rows"]:
            raise ValueError("index count differs")
        for line in values:
            row = json.loads(line)
            if row["schema"] == "historical-l2-wall-view/2":
                value = {key: row[key] for key in ("known_ns", "walls", "lifecycle", "trades", "wall_trades")}
                digest.update(json.dumps(value, separators=(",", ":"), sort_keys=True, allow_nan=False).encode() + b"\n")
                count += 1
            elif row["schema"] == "historical-l2-wall-segment-end/2":
                closures += 1
            else:
                raise ValueError("unrecognised index record")
    if (count != manifest["samples"] or count != native["samples_compared"] or closures != manifest["segments"]
            or digest.hexdigest() != native["canonical_samples_sha256"]):
        raise ValueError("index differs from independent native samples")
    return {"status": "PASS", "manifest_sha256": hashlib.sha256(raw).hexdigest(), "manifest_bytes": len(raw),
            "instrument_id": manifest["instrument_id"], "samples_compared": count, "segments": closures,
            "native_receipt_sha256": hashlib.sha256(Path(native_receipt).read_bytes()).hexdigest(),
            "canonical_samples_sha256": digest.hexdigest(), "profile_id": manifest["profile_id"],
            "encoded_bytes": manifest["encoded_bytes"], "parts": len(parts)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--native-receipt", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    result = verify(args.directory, args.native_receipt)
    with Path(args.out).open("x") as target:
        json.dump(result, target)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
