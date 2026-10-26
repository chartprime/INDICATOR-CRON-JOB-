"""Stream a pinned retained event day to the bounded wall-index writer, locally only."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "conversion"))
import historical_l2_lifecycles as events
from historical_l2_reader import manifest_parts, serialise
from prepare_historical_index_plan import hashed, load_job


def derive(plan, job, descriptor, out, node, worker):
    started = time.monotonic()
    root = Path(job["candidate_root"])
    manifest_path = root / "events" / "manifest.json"
    manifest_hash = descriptor["families"]["events"]["manifest_sha256"]
    if hashed(manifest_path) != manifest_hash:
        raise ValueError("event manifest differs from pinned descriptor")
    manifest = json.loads(manifest_path.read_bytes())
    parts = manifest_parts(manifest, "events")
    if (manifest["rows"] != job["event_rows"] or manifest["instrument_id"] != job["instrument_id"]
            or manifest["derivation_id"] != descriptor["derivation_id"]):
        raise ValueError("retained event manifest identity differs")
    objects = {item["key"]: item for item in descriptor["objects"]}
    config = {"derivationId": manifest["derivation_id"], "instrumentId": manifest["instrument_id"],
        "tickSize": descriptor["tick_size"], "releaseId": plan["pointer"]["release_id"],
        "descriptorSha256": job["descriptor_sha256"], "manifestSha256": manifest_hash,
        "expectedRows": manifest["rows"], "fromNs": descriptor["window_from_ns"], "toNs": descriptor["window_to_ns"],
        "sampleMs": 1000, "rowClusters": 1, "windowRows": 128, "referenceRows": 128, "fold": "max",
        "trackerOptions": {"minSize": job["minimum_size"], "multiplier": 3, "gapRows": 1,
            "keepEndedMs": 1200000, "deepKeepEndedMs": 1200000, "maxLevels": 60, "settleMs": 5000}}
    out = Path(out)
    out.mkdir(mode=0o700)
    (out / "config.json").write_text(json.dumps(config))
    count, scanned = 0, 0
    clean = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "TZ", "HOME")}
    with (out / "node.stdout").open("wb") as stdout, (out / "node.stderr").open("wb") as stderr:
        process = subprocess.Popen([node, "--max-old-space-size=768", str(worker), str(out / "config.json")],
            stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, env=clean)
        try:
            with duckdb.connect(config={"threads": "1", "memory_limit": "128MiB",
                "max_temp_directory_size": "256MiB", "temp_directory": str(out / "duckdb-temp")}) as connection:
                for part in parts:
                    path = manifest_path.parent / part["name"]
                    expected = objects[descriptor["prefix"] + "/events/" + part["name"]]
                    if expected["bytes"] != part["bytes"] or expected["sha256"] != part["sha256"]:
                        raise ValueError("part disagrees with pinned descriptor")
                    if path.stat().st_size != part["bytes"] or hashed(path) != part["sha256"]:
                        raise ValueError("retained event part integrity differs")
                    schema = [(name, kind) for name, kind, *_ in connection.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]).fetchall()]
                    if schema != list(events.COLUMNS.items()):
                        raise ValueError("retained part schema differs")
                    actual = connection.execute("SELECT count(*),count(DISTINCT append_position),min(append_position),max(append_position),min(known_ns),max(known_ns) FROM read_parquet(?)", [str(path)]).fetchone()
                    if actual != (part["rows"], part["rows"], part["first_position"], part["last_position"], int(part["first_known_ns"]), int(part["last_known_ns"])):
                        raise ValueError("retained part count/order/bounds differ")
                    cursor = connection.execute("SELECT * FROM read_parquet(?) ORDER BY append_position", [str(path)])
                    while values := cursor.fetchmany(128):
                        if time.monotonic() - started > 7200:
                            raise TimeoutError("wall day deadline exceeded")
                        rows = [serialise(value, events, manifest) for value in values]
                        if any(int(row["append_position"]) != count + i for i, row in enumerate(rows)):
                            raise ValueError("complete append prefix differs")
                        line = json.dumps(rows, separators=(",", ":"), allow_nan=False).encode() + b"\n"
                        if len(line) > 8 * 1024**2:
                            raise ValueError("input batch exceeds admission")
                        process.stdin.write(line)
                        count += len(rows)
                    if hashed(path) != part["sha256"]:
                        raise ValueError("source part changed during read")
                    scanned += part["bytes"]
                    progress = out / "progress.json"
                    progress.with_suffix(".pending").write_text(json.dumps({"status": "RUNNING",
                        "event_rows": count, "expected_rows": manifest["rows"],
                        "elapsed_seconds": time.monotonic() - started}))
                    progress.with_suffix(".pending").replace(progress)
            if (count != manifest["rows"] or hashed(manifest_path) != manifest_hash
                    or hashed(root / "candidate.json") != job["descriptor_sha256"]):
                raise ValueError("complete source identity differs")
            process.stdin.close()
            if process.wait(timeout=60) != 0:
                raise ValueError("wall index writer failed; inspect node.stderr")
            proof = json.loads((out / "index-proof.json").read_bytes())
            if proof["manifest"]["input_rows"] != count:
                raise ValueError("completed index input differs")
            result = {"status": "LOCAL_VERIFIED_INDEX", "release_id": plan["pointer"]["release_id"],
                "descriptor_sha256": job["descriptor_sha256"], "rows": count, "source_bytes": scanned,
                "samples": proof["manifest"]["samples"], "manifest_sha256": proof["manifestSha256"],
                "elapsed_seconds": time.monotonic() - started}
            with (out / "source-proof.json").open("x") as stream:
                json.dump(result, stream); stream.flush(); os.fsync(stream.fileno())
            return result
        except BaseException:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=15)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("plan", "plan-sha256", "instrument", "date", "out", "node", "worker"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    plan, job, descriptor = load_job(args.plan, args.plan_sha256, args.instrument, args.date)
    print(json.dumps(derive(plan, job, descriptor, args.out, args.node, args.worker)), flush=True)


if __name__ == "__main__":
    main()
