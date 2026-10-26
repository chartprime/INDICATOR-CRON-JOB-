"""Measure authenticated bounded reads from complete local output, with refusals retained."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import time

import check_historical_core_day as checker


def measure(directory, *, repeats=3, report_name="read-benchmark.json"):
    if type(repeats) is not int or not 1 <= repeats <= 10:
        raise ValueError("read repetitions admission failed")
    if report_name not in ("read-benchmark.json", "read-benchmark-strict.json"):
        raise ValueError("read report name admission failed")
    method_pin = checker.core.lifecycle.digest(Path(__file__))
    readers = [Path(checker.core.lifecycle.__file__), Path(checker.core.seconds.__file__)]
    reader_pins = {path.name: checker.core.lifecycle.digest(path) for path in readers}
    config, result, manifests = checker.load_output(directory)
    measurements = []
    for family, reader in (("events", checker.core.lifecycle.read_events), ("states", checker.core.seconds.read_seconds)):
        manifest = manifests[family]
        indices = sorted({0, len(manifest["parts"]) // 2, len(manifest["parts"]) - 1})
        for index in indices:
            upper = int(manifest["parts"][index]["last_known_ns"])
            for span in (1, 10, 60):
                lower = max(int(config["fromNs"]), upper - span * 1_000_000_000)
                elapsed, rows, size, refusal = [], None, None, None
                for _ in range(repeats):
                    started = time.perf_counter()
                    try:
                        output = reader(directory / family, result["families"][family]["manifest_sha256"],
                                        from_ns=str(lower), as_of_ns=str(upper),
                                        as_of_key=[str(upper), "18446744073709551615", "18446744073709551615", "18446744073709551615"])
                        row_count = len(output)
                        byte_count = len(json.dumps(output, separators=(",", ":")).encode())
                        if rows is not None and (row_count, byte_count) != (rows, size):
                            raise ValueError("repeated immutable read differs")
                        rows, size = row_count, byte_count
                    except ValueError as error:
                        if not any(term in str(error) for term in ("output admission", "scan byte admission")):
                            raise
                        refusal = str(error)
                    elapsed.append(round((time.perf_counter() - started) * 1000, 3))
                scan = sum(part["bytes"] for part in manifest["parts"]
                           if int(part["first_known_ns"]) <= upper and int(part["last_known_ns"]) >= lower)
                measurements.append({"family": family, "part_index": index, "from_ns": str(lower), "as_of_ns": str(upper),
                    "span_seconds": span, "scan_bytes": scan, "rows": rows, "json_bytes": size, "refusal": refusal,
                    "samples_ms": elapsed, "median_ms": statistics.median(elapsed), "max_ms": max(elapsed)})
    if (checker.core.lifecycle.digest(Path(__file__)) != method_pin
            or any(checker.core.lifecycle.digest(path) != reader_pins[path.name] for path in readers)):
        raise ValueError("read benchmark code changed during measurement")
    report = {"scope": "local authenticated read timings; OS cache state uncontrolled; not host throughput or exact Replay proof",
              "result_sha256": checker.core.lifecycle.digest(directory / "result.json"), "method_sha256": method_pin,
              "reader_code_sha256": reader_pins,
              "limits": {"scan_bytes": 64 * 1024**2, "rows": 20_000, "json_bytes": 4 * 1024**2, "span_seconds": 3600},
              "measurements": measurements, "stored": result["families"]}
    with (directory / report_name).open("x", encoding="utf-8") as sink:
        sink.write(json.dumps(report, sort_keys=True))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--report-name", choices=("read-benchmark.json", "read-benchmark-strict.json"), default="read-benchmark.json")
    args = parser.parse_args()
    report = measure(args.output, repeats=args.repeats, report_name=args.report_name)
    print(json.dumps({"windows": len(report["measurements"]), "refused": sum(item["refusal"] is not None for item in report["measurements"])}))
