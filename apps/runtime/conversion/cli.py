"""CLI entry for one conversion job. Invoked by scripts/convert/run-conversion.js."""
from __future__ import annotations

import argparse
import json
import sys
import traceback

import convert
import job


def main(argv=None):
    parser = argparse.ArgumentParser(prog="conversion", description="Convert one raw source file to curated Parquet.")
    parser.add_argument("--inputs-json", help="local JSON list of Phase 2 input descriptors; mutually exclusive with --source")
    parser.add_argument("--definitions-json", help="JSON list of definition source descriptors for futures jobs")
    parser.add_argument("--source", help="local path to the raw DBN/CSV source file")
    parser.add_argument("--schema", help="databento schema, e.g. mbp-1 / tbbo / ohlcv-1s")
    parser.add_argument("--dataset-version", required=True, help="monotonic dataset version, e.g. 20260910T000000Z")
    parser.add_argument("--staging-root", required=True)
    parser.add_argument("--curated-root", required=True)
    parser.add_argument("--catalog-root", required=True)
    parser.add_argument("--dataset", default=None, help="required for CSV sources, e.g. XNAS.ITCH")
    parser.add_argument("--symbol", default=None, help="required for CSV sources, e.g. AAPL")
    parser.add_argument("--s3-key", default=None, help="the raw object key for lineage")
    parser.add_argument("--node-bin", default="node")
    parser.add_argument("--worker-path", default=None)
    parser.add_argument("--holder", default="conversion")
    args = parser.parse_args(argv)

    try:
        if bool(args.inputs_json) == bool(args.source):
            raise ValueError("CHOOSE_SOURCE_OR_INPUTS_JSON")
        definitions = None
        if args.definitions_json:
            if not args.inputs_json:
                raise ValueError("DEFINITIONS_REQUIRE_INPUTS_JSON")
            with open(args.definitions_json, encoding="utf-8-sig") as fh:
                definitions = json.load(fh)
            if not isinstance(definitions, list):
                raise ValueError("DEFINITIONS_MUST_BE_LIST")
        if args.inputs_json:
            with open(args.inputs_json, encoding="utf-8-sig") as fh:
                inputs = json.load(fh)
            if not isinstance(inputs, list):
                raise ValueError("INPUTS_MUST_BE_LIST")
            summary = job.run_job(inputs, args.dataset_version,
                staging_root=args.staging_root, curated_root=args.curated_root, catalog_root=args.catalog_root,
                node_bin=args.node_bin, worker_path=args.worker_path, holder=args.holder,
                definition_sources=definitions)
        else:
            if not args.schema:
                raise ValueError("SOURCE_REQUIRES_SCHEMA")
            summary = convert.convert_file(
                args.source, args.schema, args.dataset_version,
                staging_root=args.staging_root, curated_root=args.curated_root, catalog_root=args.catalog_root,
                dataset=args.dataset, symbol=args.symbol, s3_key=args.s3_key,
                node_bin=args.node_bin, worker_path=args.worker_path, holder=args.holder,
            )
    except Exception as error:  # any failure fails the job: diagnostic to stderr, non-zero exit
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        return 2

    json.dump(summary, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
