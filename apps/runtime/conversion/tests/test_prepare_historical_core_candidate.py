from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import prepare_historical_core_candidate as candidate
import check_historical_state_cuts as cuts
from test_derive_historical_cme_core import config, expected, node, rows


def test_descriptor_pins_source_and_verified_outputs_and_refuses_receipt_or_session_changes(tmp_path):
    output = tmp_path / "day"
    instrument = '["XCME","FUTURE","ESU6","USD","CONTRACT"]'
    depth = {"family": "depth", "date": "1970-01-01", "instrument_id": instrument, "record_count": 5, "manifest_sha256": "d" * 64}
    trade = {**depth, "family": "trade", "record_count": 2, "manifest_sha256": "e" * 64}
    flow_path = tmp_path / "flow.json"
    flow_path.write_text(json.dumps({"depth": depth, "trade": trade}))
    setup = config()
    setup.update(instrumentId=instrument, fromNs="0", toNs="86400000000000")
    setup["identity"].update(method="native-cme-full-day-encoding/1", depth=depth,
                            flowReportSha256=candidate.checker.core.lifecycle.digest(flow_path),
                            code=[[path.name, candidate.checker.core.lifecycle.digest(path)] for path in
                                  (Path(candidate.checker.core.lifecycle.__file__), Path(candidate.checker.core.seconds.__file__))])
    setup["derivationId"] = hashlib.sha256(json.dumps(setup["identity"], separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    source = rows()
    for row in source:
        row.update(instrument_id=instrument, date="1970-01-01")
    candidate.checker.core.encode(iter(source), setup, output, node(), expected_summary=expected())
    candidate.checker.check(output, iter(source))
    receipt = output / "independent-check.json"
    pin = candidate.checker.core.lifecycle.digest(receipt)
    cuts.check(output, pin)
    state_pin = candidate.checker.core.lifecycle.digest(output / "state-check.json")
    result = candidate.prepare(output, check_sha256=pin, state_check_sha256=state_pin, flow_report=flow_path, catalog_sha256="c" * 64)
    assert result["status"] == "LOCAL_VERIFIED; NOT_PUBLISHED"
    assert result["units"]["quantity"] == "CONTRACT"
    assert result["state_check_sha256"] == state_pin
    assert all(item["key"].startswith(result["prefix"]) and len(item["sha256"]) == 64 for item in result["objects"])
    assert result["source_admission"]["available"] is False
    candidate_pin = candidate.checker.core.lifecycle.digest(output / "candidate.json")
    assert candidate.describe(output, check_sha256=pin, state_check_sha256=state_pin,
                              flow_report=flow_path, catalog_sha256="c" * 64) == result
    assert candidate.checker.core.lifecycle.digest(output / "candidate.json") == candidate_pin
    with pytest.raises(FileExistsError):
        candidate.prepare(output, check_sha256=pin, state_check_sha256=state_pin, flow_report=flow_path, catalog_sha256="c" * 64)
    with pytest.raises(ValueError, match="receipt pin"):
        candidate.prepare(output, check_sha256="b" * 64, state_check_sha256=state_pin, flow_report=flow_path, catalog_sha256="c" * 64)
    with pytest.raises(ValueError, match="state receipt pin"):
        candidate.prepare(output, check_sha256=pin, state_check_sha256="b" * 64, flow_report=flow_path, catalog_sha256="c" * 64)
    receipt.write_text(json.dumps({**json.loads(receipt.read_text()), "source_rows": 999, "derivation_id": "b" * 64}))
    with pytest.raises(ValueError, match="receipt differs"):
        candidate.prepare(output, check_sha256=candidate.checker.core.lifecycle.digest(receipt), state_check_sha256=state_pin, flow_report=flow_path, catalog_sha256="c" * 64)
