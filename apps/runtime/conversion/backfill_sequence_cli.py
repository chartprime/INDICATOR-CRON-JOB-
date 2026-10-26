from __future__ import annotations

import argparse
import json
import sys
import traceback

import backfill_sequence


EXIT_OK = 0
EXIT_RETRYABLE = 1
EXIT_PERMANENT = 2
EXIT_PARTIAL = 3


def main(argv=None):
    parser = argparse.ArgumentParser(prog="backfill-sequence", description="Run one staged rollout phase (ohlcv/ohlcv1m/l1/l2) across every symbol in it.")
    parser.add_argument("--phase", required=True, choices=sorted(backfill_sequence.PHASE_SYMBOLS))
    parser.add_argument("--dataset-version", help="explicit override; omitted uses the registered phase version")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--curated-prefix", required=True, help="S3 prefix under curated/, e.g. curated/databento")
    parser.add_argument("--staging-root", required=True)
    parser.add_argument("--curated-root", required=True)
    parser.add_argument("--catalog-root", required=True)
    parser.add_argument("--min-free-bytes", type=int, default=None)
    parser.add_argument("--source-prefix", default=None,
                        help="derived phases only: namespace the source partitions are read from when it is not --curated-prefix")
    parser.add_argument("--source-catalog-root", default=None,
                        help="derived phases only: catalog the sources are planned from when it is not --catalog-root")
    parser.add_argument("--node-bin", default="node")
    parser.add_argument("--worker-path", default=None)
    parser.add_argument("--holder", default="conversion")
    parser.add_argument("--pool-size", type=int, default=1)
    parser.add_argument("--symbols", default=None,
                        help="comma-separated subset of the phase's symbols, run in the order given")
    parser.add_argument("--retry-quarantined", action="store_true",
                        help="deliberately clear durable quarantine entries and reconvert those dates")
    args = parser.parse_args(argv)

    kwargs = {
        "bucket": args.bucket, "curated_prefix": args.curated_prefix,
        "staging_root": args.staging_root, "curated_root": args.curated_root, "catalog_root": args.catalog_root,
        "node_bin": args.node_bin, "worker_path": args.worker_path, "holder": args.holder,
        "pool_size": args.pool_size, "retry_quarantined": args.retry_quarantined,
    }
    if args.symbols is not None:
        kwargs["symbols"] = [name.strip() for name in args.symbols.split(",") if name.strip()]
    if args.min_free_bytes is not None:
        kwargs["min_free_bytes"] = args.min_free_bytes
    for name in ("source_prefix", "source_catalog_root"):
        if getattr(args, name) is not None:
            kwargs[name] = getattr(args, name)

    dataset_version = args.dataset_version or backfill_sequence.dataset_version_for_phase(args.phase)
    try:
        outcomes = backfill_sequence.run_phase(args.phase, dataset_version, **kwargs)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({
            "phase": args.phase, "dataset_version": dataset_version,
            "error": f"{type(error).__name__}: {error}",
            "retryable": backfill_sequence.is_retryable(error),
        }), file=sys.stderr)
        return EXIT_RETRYABLE if backfill_sequence.is_retryable(error) else EXIT_PERMANENT

    partial_months = [p for o in outcomes for p in o.get("partial_months", [])]
    failed = [o for o in outcomes if o["status"] == "failed"]
    exit_code = EXIT_OK
    if partial_months or any(o["status"] == "partial" for o in outcomes):
        exit_code = EXIT_PARTIAL
    if failed:
        exit_code = EXIT_RETRYABLE if all(o.get("retryable") for o in failed) else EXIT_PERMANENT
    json.dump({"phase": args.phase, "dataset_version": dataset_version, "outcomes": outcomes,
               "partial_months": partial_months, "exit_code": exit_code},
              sys.stdout, indent=2, sort_keys=True, default=str)
    sys.stdout.write("\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
