from __future__ import annotations

import argparse
import datetime
import json
import sys
import traceback

import coverage_report
import s3_publish

EXIT_OK = 0
EXIT_ERROR = 2


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="coverage-report",
        description="Report what curated data exists, what it supports and where the real gaps are.")
    parser.add_argument("--catalog-root", required=True)
    parser.add_argument("--reference-root", required=True,
                        help="root holding definition/status/statistics mirrors")
    parser.add_argument("--staging-root", default=None,
                        help="optional; adds partial-month receipts and quarantined dates")
    parser.add_argument("--symbol", default=None, help="restrict reference lookups to one raw symbol")
    parser.add_argument("--observed-prices", default=None,
                        help="optional JSON file of {date: {first_price, last_price}} for reconciliation")
    parser.add_argument("--verify-manifests", action="store_true",
                        help="prove each catalogued partition is present and intact in S3")
    parser.add_argument("--verify-limit", type=int, default=None,
                        help="verify only the first N partitions; reported as a SAMPLE")
    parser.add_argument("--bucket", default=None, help="required with --verify-manifests")
    parser.add_argument("--curated-prefix", default=None, help="required with --verify-manifests")
    parser.add_argument("--omit-generated-at", action="store_true",
                        help="drop the timestamp so two runs over unchanged inputs are byte-identical")
    args = parser.parse_args(argv)

    observed = None
    if args.observed_prices:
        if not args.symbol:
            parser.error("--observed-prices requires --symbol; prices are matched on date alone")
        with open(args.observed_prices, encoding="utf-8") as handle:
            observed = json.load(handle)

    store = None
    if args.verify_manifests:
        if not args.bucket or not args.curated_prefix:
            parser.error("--verify-manifests requires --bucket and --curated-prefix")
        import backfill_driver
        store = s3_publish.Store(backfill_driver._build_s3_client(), args.bucket, args.curated_prefix)

    try:
        report = coverage_report.build(
            catalog_root=args.catalog_root,
            reference_root=args.reference_root,
            staging_root=args.staging_root,
            symbol=args.symbol,
            observed_prices=observed,
            store=store,
            verify_limit=args.verify_limit,
            generated_at=None if args.omit_generated_at
            else datetime.datetime.now(datetime.timezone.utc).isoformat(),
        )
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        return EXIT_ERROR

    json.dump(report, sys.stdout, indent=2, sort_keys=True, default=str)
    sys.stdout.write("\n")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
