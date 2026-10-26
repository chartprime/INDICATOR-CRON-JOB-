"""Derive the trade families for one symbol outside the phase sequence.

The production path is `backfill_sequence_cli.py --phase l1agg`; this entry
exists for a bounded run -- a qualification namespace, a single month -- with
the same driver, the same locks and the same receipts.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback

import backfill_driver
import backfill_sequence
import derive_families

EXIT_OK = 0
EXIT_PERMANENT = 2
EXIT_RETRYABLE = 3


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, choices=["GLBX.MDP3", "XNAS.ITCH", "BINANCE.SPOT", "BINANCE.UM"])
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--months", default=None, help="comma-separated YYYY-MM subset; omitted runs every catalogued month")
    parser.add_argument("--base-version", default=derive_families.BASE_VERSION)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--curated-prefix", required=True)
    parser.add_argument("--staging-root", required=True)
    parser.add_argument("--curated-root", required=True)
    parser.add_argument("--catalog-root", required=True)
    parser.add_argument("--source-prefix", default=None,
                        help="namespace the trade partitions are read from when it differs from --curated-prefix")
    parser.add_argument("--source-catalog-root", default=None,
                        help="converter catalog the sources are planned from when it differs from --catalog-root")
    parser.add_argument("--node-bin", default="node")
    parser.add_argument("--worker-path", default=None)
    parser.add_argument("--min-free-bytes", type=int, default=None)
    args = parser.parse_args(argv)

    months = None
    if args.months is not None:
        months = [part.strip() for part in args.months.split(",") if part.strip()]
    kwargs = {
        "client": backfill_driver._build_s3_client(), "bucket": args.bucket, "curated_prefix": args.curated_prefix,
        "staging_root": args.staging_root, "curated_root": args.curated_root, "catalog_root": args.catalog_root,
        "node_bin": args.node_bin, "worker_path": args.worker_path, "months": months,
        "source_prefix": args.source_prefix, "source_catalog_root": args.source_catalog_root,
    }
    if args.min_free_bytes is not None:
        kwargs["min_free_bytes"] = args.min_free_bytes
    try:
        outcome = derive_families.run_symbol(args.dataset, args.symbol, args.base_version, **kwargs)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"dataset": args.dataset, "symbol": args.symbol, "error": f"{type(error).__name__}: {error}",
                          "retryable": backfill_sequence.is_retryable(error)}), file=sys.stderr)
        return EXIT_RETRYABLE if backfill_sequence.is_retryable(error) else EXIT_PERMANENT
    print(json.dumps({
        "dataset": outcome["dataset"], "symbol": outcome["symbol"], "market": outcome["market"],
        "months": [{"version": month["version"], "fully_published": month["fully_published"],
                    "partitions": len(month["results"][0]["partitions"]),
                    "empty_partitions": month["results"][0]["empty_partitions"],
                    "catalog_pointer": month["results"][0]["catalog_pointer"]} for month in outcome["months"]],
    }, sort_keys=True))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
