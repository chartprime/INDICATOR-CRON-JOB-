from __future__ import annotations

import argparse
import json
import sys
import traceback

import backfill_driver


def main(argv=None):
    parser = argparse.ArgumentParser(prog="backfill", description="Discover, convert, and publish one instrument/schema's raw archive range to S3, one day at a time.")
    parser.add_argument("--dataset", required=True, help="Databento dataset, e.g. GLBX.MDP3")
    parser.add_argument("--schema", required=True, help="Databento schema, e.g. mbp-1 / mbp-10 / ohlcv-1s")
    parser.add_argument("--symbol", required=True, help="raw symbol as it appears in the S3 key, e.g. NQ")
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True, help="inclusive")
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--curated-prefix", required=True, help="S3 prefix under curated/, e.g. curated/databento")
    parser.add_argument("--staging-root", required=True)
    parser.add_argument("--curated-root", required=True)
    parser.add_argument("--catalog-root", required=True)
    parser.add_argument("--min-free-bytes", type=int, default=backfill_driver.DEFAULT_MIN_FREE_BYTES)
    parser.add_argument("--definition-symbol", default=None, help="required for futures continuous aliases, e.g. NQ; omit for equities")
    parser.add_argument("--node-bin", default="node")
    parser.add_argument("--worker-path", default=None)
    parser.add_argument("--holder", default="conversion")
    parser.add_argument("--families", default=None,
                        help="comma-separated partition families to convert, e.g. depth; default: every family the source yields")
    parser.add_argument("--supersede-allowlist", default=None,
                        help="JSON {reason, approved_by, authorities: [[instrument_id, family, date], ...]} of published days this run may replace")
    args = parser.parse_args(argv)

    try:
        dates = backfill_driver.inclusive_date_range(args.start_date, args.end_date)
        families = None if args.families is None else [f.strip() for f in args.families.split(",") if f.strip()]
        allowlist = None if args.supersede_allowlist is None else backfill_driver.load_supersede_allowlist(args.supersede_allowlist)
        outcome = backfill_driver.run_s3_backfill(
            args.dataset, args.schema, args.symbol, dates, args.dataset_version,
            bucket=args.bucket, curated_prefix=args.curated_prefix,
            staging_root=args.staging_root, curated_root=args.curated_root, catalog_root=args.catalog_root,
            min_free_bytes=args.min_free_bytes, definition_symbol=args.definition_symbol,
            node_bin=args.node_bin, worker_path=args.worker_path, holder=args.holder,
            families=families, supersede_allowlist=allowlist,
        )
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        return 2

    json.dump({"requested_dates": dates, **outcome}, sys.stdout, indent=2, sort_keys=True, default=str)
    sys.stdout.write("\n")
    return 0 if outcome.get("fully_published") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
