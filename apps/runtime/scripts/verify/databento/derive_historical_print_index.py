"""Build an individual-print index from the day’s independently qualified source."""

import argparse
import hashlib
import json
from pathlib import Path
import sys

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "conversion"))
from historical_l2_prints import write_index


def hashed(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qualified-root", required=True)
    parser.add_argument("--candidate-root", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--descriptor-sha256", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    root, candidate_root, out = map(Path, (args.qualified_root, args.candidate_root, args.out))
    descriptor_path = candidate_root / "candidate.json"
    if hashed(descriptor_path) != args.descriptor_sha256:
        raise ValueError("qualified descriptor differs")
    descriptor = json.loads(descriptor_path.read_bytes())
    sys.path.insert(0, str(root / "src/apps/runtime/scripts/verify/databento"))
    import fetch_verified_part
    import fetch_verified_partition
    fetch_verified_part.DATA_ROOT = root / "data"
    fetch_verified_partition.DATA_ROOT = root / "data"
    import derive_historical_cme_core as cme
    import derive_historical_equity_core as equity
    from verify_historical_topn_partition import verified_files, ordered_depth_parts
    stem = candidate_root.name.removesuffix("-core")
    depth_path, trade_path = (root / "data" / (stem + "-" + family + ".json") for family in ("depth", "trade"))
    source = descriptor["source"]
    start, end = int(descriptor["window_from_ns"]), int(descriptor["window_to_ns"])
    date = descriptor["date"]
    expected = descriptor["flow_counts"]["rows"]
    connection = duckdb.connect(config={"threads": "1", "memory_limit": "512MB", "temp_directory": str(out.parent / (out.name + "-temp")),
                                       "max_temp_directory_size": "4GB", "preserve_insertion_order": "false"})
    try:
        if source["method"] == "native-cme-full-day-encoding/1":
            raw = root / "data" / (stem + ".dbn.zst")
            depth, files, raw_hash = cme.admit_source(raw, depth_path, source["depth"])
            if raw_hash != source["rawSha256"]:
                raise ValueError("native source hash differs")
            rows = cme.normalized(cme.native_records(raw, date), instrument=descriptor["instrument_id"], start=start,
                                  end=end, expected=expected, raw_hash=raw_hash)
            pins = [(path, part["sha256"]) for path, part in zip(files, depth["parts"])] + [(raw, raw_hash)]
        elif source["method"] == "equity-first-depth-full-day-encoding/2":
            hashes = dict(source["sourcePlans"])
            for path in (depth_path, trade_path):
                if hashed(path) != hashes[path.name]:
                    raise ValueError("equity source plan differs")
            depth, files = verified_files(depth_path, 2 * 1024**3)
            trade, trade_files = verified_files(trade_path, 2 * 1024**3)
            parts = ordered_depth_parts(connection, depth, files)
            rank = equity.pinned_source_rank(connection, files)
            if "sourceRank" in source and rank != source["sourceRank"]:
                raise ValueError("equity rank differs")
            connection.execute("CREATE TEMP TABLE trades AS SELECT record_id,event_ns,receive_ns,sequence,source_dataset,dbn_publisher_id,side,price,size FROM read_parquet(?)", [trade_files])
            connection.execute("""CREATE TEMP TABLE anchors AS WITH first_depth AS (
                SELECT event_ns,source_rank,stable_position,ordinal,receive_ns,sequence,source_dataset,dbn_publisher_id FROM read_parquet(?)
                QUALIFY row_number() OVER(PARTITION BY source_dataset,dbn_publisher_id,sequence,event_ns,receive_ns ORDER BY source_rank,stable_position,ordinal)=1)
                SELECT d.event_ns,d.source_rank,d.stable_position,d.ordinal,t.record_id,t.side,t.price,t.size FROM first_depth d JOIN trades t
                ON t.event_ns=d.event_ns AND t.receive_ns=d.receive_ns AND t.sequence=d.sequence
                AND t.source_dataset=d.source_dataset AND t.dbn_publisher_id=d.dbn_publisher_id""", [files])
            if connection.execute("SELECT count(*),count(DISTINCT record_id) FROM anchors").fetchone() != (trade["partition"]["record_count"],) * 2:
                raise ValueError("exact equity trade anchors differ")
            rows = equity.joined_rows(connection, parts, date, start, expected)
            pins = [(path, part["sha256"]) for paths, plan in ((files, depth), (trade_files, trade)) for path, part in zip(paths, plan["parts"])]
        else:
            raise ValueError("independently qualified native source required")

        def checked():
            yield from rows
            if any(hashed(path) != digest for path, digest in pins) or hashed(descriptor_path) != args.descriptor_sha256:
                raise ValueError("source changed during derivation")

        manifest = write_index(checked(), out, descriptor=descriptor, release_id=args.release_id,
                               descriptor_sha256=args.descriptor_sha256, expected_rows=expected)
        print(json.dumps({"status": "PASS", "source_rows": expected, "prints": manifest["rows"],
                          "counts": manifest["counts"], "encoded_bytes": manifest["encoded_bytes"],
                          "manifest_sha256": hashed(out / "manifest.json")}))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
