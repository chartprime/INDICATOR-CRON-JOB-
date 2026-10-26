"""Read-only, real-release page equivalence proof with a separate ordered reference."""

from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import time

import duckdb

from archive_admission import CancelToken
from archive_cache import PartCache
from archive_http import _build_query_s3_client
import historical_l2_catalog as catalog
import historical_l2_reader as reader
from historical_l2_service import Service
from s3_publish import Store


def reference(connection, paths, family, request):
    columns = reader.MODULES[family].COLUMNS
    parameters = [paths, int(request["from"]), int(request["to"])]
    count = connection.execute("SELECT count(*) FROM read_parquet(?) WHERE known_ns >= ? AND known_ns < ?", parameters).fetchone()[0]
    if count > (200_000 if family == "states" else 20_000):
        raise ValueError("reference proof window exceeds admission")
    values = connection.execute("SELECT * FROM read_parquet(?) WHERE known_ns >= ? AND known_ns < ? "
                                "ORDER BY append_position", parameters).fetchall()
    rows, cut = [], tuple(map(int, request["asOfKey"]))
    for values_row in values:
        row = dict(zip(columns, values_row))
        key = [row.pop(field) for field in ("known_event", "known_rank", "known_position", "known_ordinal")]
        if all(v is None for v in key):
            row["known_key"] = None
        else:
            if any(v is None for v in key) or tuple(key) > cut:
                continue
            row["known_key"] = list(map(str, key))
        row["schema"] = reader.MODULES[family].SCHEMA
        for field in ("append_position", "known_ns", "source_ns"):
            if field in row:
                row[field] = str(row[field])
        row["payload"] = json.loads(row["payload"])
        rows.append(row)
    return rows


def prove(service, instrument, day):
    token, pointer, payload = service.snapshots.issue(service.store, "proof")
    cases = []
    last_request = 0.0
    with duckdb.connect(config={"threads": "1", "memory_limit": "256MB"}) as connection:
        for family in ("states", "events"):
            _descriptor, manifest, prefix = catalog.family(service.store, pointer, payload, instrument, day, family)
            parts = reader.manifest_parts(manifest, family)
            windows = [(int(parts[0]["first_known_ns"]), int(parts[0]["first_known_ns"]) + 1, (1, 1000, 10000))]
            if len(parts) > 1:
                windows.append((int(parts[0]["last_known_ns"]), int(parts[1]["first_known_ns"]) + 1, (1000, 10000)))
            if family == "states":
                start = int(manifest["window_from_ns"]) + 14 * 3600 * 1_000_000_000 + 30 * 60 * 1_000_000_000
                windows.append((start, start + reader.MAX_WINDOW_NS, (1000, 10000)))
            for lower, upper, limits in windows:
                request = {"contractVersion": reader.CONTRACT, "operation": "page", "snapshotToken": token,
                           "instrumentId": instrument, "date": day, "family": family, "from": str(lower), "to": str(upper),
                           "asOfKey": [str(upper - 1), "18446744073709551615", "18446744073709551615", "18446744073709551615"]}
                selected = [p for p in parts if int(p["first_known_ns"]) < upper and int(p["last_known_ns"]) >= lower]
                if sum(p["bytes"] for p in selected) > reader.MAX_SCAN_BYTES:
                    raise ValueError("reference selection exceeds scan admission")
                for limit in limits:
                    at, rows, pages, metrics, timings = time.monotonic(), [], 0, [], []
                    page_request = {**request, "limit": limit}
                    while True:
                        pause = 1.0 - (time.monotonic() - last_request)
                        if pause > 0:
                            time.sleep(pause)
                        last_request = time.monotonic()
                        page = service.query(page_request, client="proof", cancel_token=CancelToken())
                        timings.append((time.monotonic() - last_request) * 1000)
                        rows.extend(page["rows"])
                        metrics.append(page["scan"])
                        pages += 1
                        if page["nextCursor"] is None:
                            break
                        if pages >= 256:
                            raise ValueError("proof page count exceeds admission")
                        page_request["cursor"] = page["nextCursor"]
                    elapsed = time.monotonic() - at
                    with ExitStack() as stack:
                        paths = [str(stack.enter_context(service._part(service.store, prefix, p, CancelToken()))[0]) for p in selected]
                        expected = reference(connection, paths, family, request)
                    if rows != expected:
                        raise ValueError("paged rows differ from independent ordered reference")
                    cases.append({"family": family, "window": [str(lower), str(upper)], "limit": limit,
                                  "rows": len(rows), "pages": pages, "seconds": elapsed, "scan": metrics,
                                  "page_ms": timings, "request_pacing_seconds": 1,
                                  "reference_sha256": hashlib.sha256(catalog.encoded(expected)).hexdigest(),
                                  "manifest_sha256": hashlib.sha256(catalog.encoded(manifest)).hexdigest()})
    with service.cache._connect() as connection:
        if connection.execute("SELECT count(*) FROM pins").fetchone()[0] or connection.execute("SELECT count(*) FROM reservations").fetchone()[0]:
            raise ValueError("cache leases remain after proof")
    return {"status": "PASS", "pointer": pointer, "instrument_id": instrument, "date": day, "cases": cases}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--cache-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--instrument", choices=("ESU6", "NQU6", "AAPL", "TSLA"), default="ESU6")
    parser.add_argument("--date", default="2026-08-05")
    args = parser.parse_args(argv)
    import os
    service = Service(Store(_build_query_s3_client(), args.bucket, catalog.PREFIX),
                      PartCache(args.cache_root, max_bytes=256 * 1024**2, min_free_disk_bytes=40 * 1024**3),
                      service_secret=os.environ["TT_QUERY_SERVICE_SECRET"])
    instrument = next(json.dumps(p, separators=(",", ":")) for p in catalog.PROFILES if p[2] == args.instrument)
    try:
        result = prove(service, instrument, args.date)
        args.output.write_bytes(catalog.encoded(result))
        print(json.dumps({"status": result["status"], "cases": len(result["cases"]), "release_id": result["pointer"]["release_id"]}), flush=True)
    finally:
        service.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
