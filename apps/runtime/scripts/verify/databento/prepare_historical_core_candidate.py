"""Prepare an immutable local descriptor; uploads and catalog publication are separate gates."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

import check_historical_core_day as checker
from historical_l2_coverage import require_intraday_source


def describe(directory, *, check_sha256, state_check_sha256, flow_report, catalog_sha256, native_report=None):
    config, result, manifests = checker.load_output(directory)
    path = directory / "independent-check.json"
    if path.is_symlink() or path.stat().st_size > 1024**2 or checker.core.lifecycle.digest(path) != check_sha256:
        raise ValueError("independent receipt pin failed")
    receipt = json.loads(path.read_text())
    if (receipt.get("scope") != "complete source walk; top-ten inferred lifecycle accounting, not order-level cancellation truth"
            or receipt.get("result_sha256") != checker.core.lifecycle.digest(directory / "result.json")
            or receipt.get("derivation_id") != config["derivationId"] or receipt.get("families") != result["families"]
            or receipt.get("counts", {}).get("source_rows") != config["expectedRows"]):
        raise ValueError("independent receipt differs from combined output")
    from check_historical_state_cuts import validate_receipt
    validate_receipt(directory, state_check_sha256, check_sha256, receipt, config, result)
    identity = config["identity"]
    if identity.get("method") not in ("native-cme-full-day-encoding/1", "equity-first-depth-full-day-encoding/2"):
        raise ValueError("candidate producer method is not qualified")
    code = dict(identity.get("code", []))
    for writer in ("historical_l2_lifecycles.py", "historical_l2_seconds.py"):
        if writer not in code:
            raise ValueError("candidate writer revision is not pinned")
    if flow_report.is_symlink() or flow_report.stat().st_size > 1024**2 or checker.core.lifecycle.digest(flow_report) != identity["flowReportSha256"]:
        raise ValueError("source flow receipt pin failed")
    flow = json.loads(flow_report.read_text())
    if flow["depth"] != identity["depth"]:
        raise ValueError("source depth lineage differs")
    if identity["method"] == "equity-first-depth-full-day-encoding/2":
        from verify_historical_equity_native import validate_receipt
        if native_report is None:
            raise ValueError("candidate equity native ordering receipt required")
        validate_receipt(native_report, identity["nativeOrderReportSha256"], flow, identity["flowReportSha256"])
    disposition = require_intraday_source(flow["depth"], flow["trade"], catalog_sha256)
    date = disposition["date"]
    start = int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    if (config["instrumentId"] != disposition["instrument_id"] or int(config["fromNs"]) != start
            or int(config["toNs"]) != start + 86_400_000_000_000 or manifests["states"]["window_from_ns"] != config["fromNs"]
            or manifests["states"]["window_to_ns"] != config["toNs"]):
        raise ValueError("candidate window and source session differ")
    instrument = json.loads(config["instrumentId"])
    if not isinstance(instrument, list) or len(instrument) != 5 or instrument[1] not in ("FUTURE", "EQUITY"):
        raise ValueError("candidate instrument units unsupported")
    expected_tick = "0.25" if instrument[1] == "FUTURE" else "0.01"
    if config["tickSize"] != expected_tick:
        raise ValueError("candidate geometry differs from source profile")
    slug = hashlib.sha256(config["instrumentId"].encode()).hexdigest()
    prefix = f"curated/l2-core/databento/instrument={slug}/derivation={config['derivationId']}/date={date}"
    descriptor = {"schema": "historical-l2-candidate/1", "status": "LOCAL_VERIFIED; NOT_PUBLISHED", "prefix": prefix,
        "instrument_id": config["instrumentId"], "derivation_id": config["derivationId"], "date": date,
        "source_catalog_sha256": catalog_sha256, "source": identity, "source_admission": disposition,
        "window_from_ns": config["fromNs"], "window_to_ns": config["toNs"], "tick_size": expected_tick,
        "depth_limit": 10, "units": {"price": instrument[3], "quantity": "CONTRACT" if instrument[1] == "FUTURE" else "SHARE",
                                     "time": "UTC nanoseconds", "inference": "engine-number"},
        "result_sha256": receipt["result_sha256"], "independent_check_sha256": check_sha256,
        "state_check_sha256": state_check_sha256,
        "inference_counts": receipt["counts"], "flow_counts": result["completion"],
        "families": result["families"], "objects": [],
        "publication_gate": "verify each uploaded object and descriptor by SHA-256; publish catalog last; preserve previous catalog"}
    for family in ("events", "states"):
        descriptor["objects"].append({"key": f"{prefix}/{family}/manifest.json",
                                      "sha256": result["families"][family]["manifest_sha256"],
                                      "bytes": (directory / family / "manifest.json").stat().st_size})
        descriptor["objects"] += [{"key": f"{prefix}/{family}/{part['name']}", **part} for part in manifests[family]["parts"]]
    return descriptor


def prepare(directory, **proofs):
    descriptor = describe(directory, **proofs)
    output = directory / "candidate.json"
    with output.open("x", encoding="utf-8") as sink:
        sink.write(json.dumps(descriptor, sort_keys=True))
    return descriptor


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check-sha256", required=True)
    parser.add_argument("--state-check-sha256", required=True)
    parser.add_argument("--flow-report", type=Path, required=True)
    parser.add_argument("--catalog-sha256", required=True)
    parser.add_argument("--native-order-report", type=Path)
    args = parser.parse_args()
    descriptor = prepare(args.output, check_sha256=args.check_sha256, state_check_sha256=args.state_check_sha256, flow_report=args.flow_report,
                         catalog_sha256=args.catalog_sha256, native_report=args.native_order_report)
    print(json.dumps({"candidate": str(args.output / "candidate.json"), "objects": len(descriptor["objects"]), "status": descriptor["status"]}))
