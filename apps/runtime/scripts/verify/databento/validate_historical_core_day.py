"""Revalidate a complete day without rewriting its sealed output or receipts."""

from __future__ import annotations

import json
from pathlib import Path
import re
from historical_l2_events import reject_constant

import bench_historical_core_reads as benchmark
import check_historical_core_day as checker
import check_historical_state_cuts as cuts
from plan_historical_core_month import digest
from prepare_historical_core_candidate import describe


def read_json(path, maximum=1024**2):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ValueError("qualification envelope admission failed")
    with path.open("rb") as source:
        data = source.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("qualification envelope exceeded admission during read")
    return json.loads(data, parse_constant=reject_constant)


def validate(root, stem, session, plan_id, catalog_sha256):
    symbol, day = session["instrument"], session["date"]
    if not re.fullmatch(r"stage3-" + re.escape(symbol.lower() + "-" + day) + r"(?:-a[0-9]{4})?", stem):
        raise ValueError("day identity admission failed")
    status_path = root / (stem + "-status.json")
    status_pin = digest(status_path)
    status = read_json(status_path)
    if (status.get("state") != "LOCAL_VERIFIED" or status.get("plan_id") != plan_id
            or status.get("instrument") != symbol or status.get("date") != day):
        raise ValueError("day is not complete under the frozen plan")
    output = root / (stem + "-core")
    if output.is_symlink() or any((output / name).is_symlink() for name in ("events", "states")):
        raise ValueError("sealed directory must not be a symlink")
    equity = session["profile"][1] == "EQUITY"
    names = ["flow", *( ["native"] if equity else []), "derive", "source-check", "state-check", "candidate", "reads"]
    expected = {"flow": root / (stem + "-flow.json"), "native": root / (stem + "-native.json"),
                "derive": output / "result.json", "source-check": output / "independent-check.json",
                "state-check": output / "state-check.json", "candidate": output / "candidate.json",
                "reads": output / "read-benchmark-strict.json"}
    stages = status.get("stages")
    if not isinstance(stages, list) or [item.get("name") for item in stages] != names:
        raise ValueError("complete receipt chain required")
    pins = {}
    for item in stages:
        path = expected[item["name"]]
        if (item.get("receipt") != path.name or not isinstance(item.get("sha256"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) or path.is_symlink()
                or digest(path) != item["sha256"]):
            raise ValueError("day receipt pin differs")
        pins[item["name"]] = item["sha256"]
    source = read_json(expected["source-check"])
    state = read_json(expected["state-check"])
    if (source.get("checker_sha256") != digest(Path(checker.__file__))
            or state.get("method_sha256") != digest(Path(cuts.__file__))):
        raise ValueError("qualification checker code differs")
    candidate = describe(output, check_sha256=pins["source-check"], state_check_sha256=pins["state-check"],
                         flow_report=expected["flow"], catalog_sha256=catalog_sha256,
                         native_report=expected["native"] if equity else None)
    if read_json(expected["candidate"], 4 * 1024**2) != candidate:
        raise ValueError("sealed descriptor differs from verified output")
    flow = read_json(expected["flow"])
    for family in session["sources"]:
        for field in ("instrument_id", "family", "date", "manifest_sha256", "record_count", "dataset_version"):
            if flow.get(family, {}).get(field) != session["sources"][family].get(field):
                raise ValueError("day source differs from frozen inventory")
    reads = read_json(expected["reads"])
    if (reads.get("result_sha256") != pins["derive"] or reads.get("stored") != candidate["families"]
            or reads.get("method_sha256") != digest(Path(benchmark.__file__))
            or reads.get("reader_code_sha256") != {Path(module.__file__).name: digest(Path(module.__file__))
                                                   for module in (checker.core.lifecycle, checker.core.seconds)}
            or reads.get("limits") != {"scan_bytes": 64 * 1024**2, "rows": 20_000,
                                        "json_bytes": 4 * 1024**2, "span_seconds": 3600}):
        raise ValueError("strict reads differ from sealed output or admitted reader")
    measurements = reads.get("measurements")
    if (not isinstance(measurements, list) or not measurements
            or not any(item.get("family") == "events" for item in measurements)
            or not any(item.get("family") == "states" for item in measurements)
            or any(item.get("family") == "states" and item.get("refusal") is not None for item in measurements)):
        raise ValueError("strict state read gate failed")
    if digest(status_path) != status_pin:
        raise ValueError("day status changed during revalidation")
    return {"stem": stem, "status_sha256": status_pin, "candidate_sha256": pins["candidate"],
            "prefix": candidate["prefix"], "derivation_id": candidate["derivation_id"],
            "families": candidate["families"], "inference_counts": candidate["inference_counts"],
            "state_counts": state["counts"], "total_seconds": status["total_seconds"],
            "read_windows": len(measurements), "event_refusals": sum(item.get("refusal") is not None for item in measurements)}
