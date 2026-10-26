import hashlib
import json
import sqlite3
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import validate_historical_core_day as validation
import prepare_historical_core_candidate as candidate
import check_historical_state_cuts as cuts
from test_derive_historical_cme_core import config, expected, node, rows
from test_plan_historical_core_month import catalog
import plan_historical_core_month as planner


def test_sealed_day_revalidation_checks_source_code_receipts_parts_and_strict_reads(tmp_path, monkeypatch):
    stem = "stage3-esu6-2026-08-05"
    output = tmp_path / (stem + "-core")
    instrument = '["XCME","FUTURE","ESU6","USD","CONTRACT"]'
    catalog_path = catalog(tmp_path)
    with sqlite3.connect(catalog_path) as connection:
        for family, count, pin in (("depth", 5, "d" * 64), ("trade", 2, "e" * 64)):
            connection.execute("UPDATE partitions SET record_count=?,manifest_sha256=? WHERE instrument_id=? AND family=?",
                               [count, pin, instrument, family])
    catalog_pin = validation.digest(catalog_path)
    inventory = planner.plan(catalog_path, "2026-08", catalog_pin)
    session = next(row for row in inventory["sessions"] if row["instrument"] == "ESU6" and row["date"] == "2026-08-05")
    plan_id = inventory["plan_id"]
    depth, trade = session["sources"]["depth"], session["sources"]["trade"]
    flow_path = tmp_path / (stem + "-flow.json")
    flow_path.write_text(json.dumps({"depth": depth, "trade": trade}))
    setup = config()
    opened = 1785888000000000000
    setup.update(instrumentId=instrument, fromNs=str(opened), toNs=str(opened + 86400000000000))
    setup["identity"].update(method="native-cme-full-day-encoding/1", depth=depth,
                            flowReportSha256=validation.digest(flow_path),
                            code=[[path.name, validation.digest(path)] for path in
                                  (Path(candidate.checker.core.lifecycle.__file__), Path(candidate.checker.core.seconds.__file__))])
    setup["derivationId"] = hashlib.sha256(json.dumps(setup["identity"], separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    source = rows()
    for row in source:
        row.update(instrument_id=instrument, date="2026-08-05", event_ns=str(int(row["event_ns"]) + opened),
                   known_ns=str(int(row["known_ns"]) + opened))
        if row["matched_trade"] is not None:
            row["matched_trade"]["event_ns"] = row["event_ns"]
    candidate.checker.core.encode(iter(source), setup, output, node(), expected_summary=expected())
    candidate.checker.check(output, iter(source))
    source_pin = validation.digest(output / "independent-check.json")
    cuts.check(output, source_pin)
    candidate.prepare(output, check_sha256=source_pin, state_check_sha256=validation.digest(output / "state-check.json"),
                      flow_report=flow_path, catalog_sha256=catalog_pin)
    validation.benchmark.measure(output, report_name="read-benchmark-strict.json")
    files = {"flow": flow_path, "derive": output / "result.json", "source-check": output / "independent-check.json",
             "state-check": output / "state-check.json", "candidate": output / "candidate.json",
             "reads": output / "read-benchmark-strict.json"}
    status_path = tmp_path / (stem + "-status.json")
    status = {"state": "LOCAL_VERIFIED", "plan_id": plan_id, "instrument": "ESU6", "date": depth["date"],
              "total_seconds": 1, "stages": [{"name": name, "receipt": path.name, "sha256": validation.digest(path)}
                                              for name, path in files.items()]}
    status_path.write_text(json.dumps(status))
    originals = {path: path.read_bytes() for path in files.values()}
    proof = validation.validate(tmp_path, stem, session, plan_id, catalog_pin)
    assert proof["inference_counts"]["source_rows"] == 5
    assert {path: path.read_bytes() for path in files.values()} == originals
    import publish_historical_core_month as publication
    from test_s3_publish import FakeS3
    run = {"schema": "historical-l2-month-run/1", "plan": inventory, "identity": publication.code_identity(node()),
           "sessions": {row["instrument"] + "/" + row["date"]:
                        {"state": "PENDING" if row["reason"] == "AWAITING_FULL_DAY_QUALIFICATION" else "UNAVAILABLE",
                         "reason": row["reason"]} for row in inventory["sessions"]}}
    run["sessions"]["ESU6/2026-08-05"] = {"state": "AVAILABLE", "proof": proof}
    journal = tmp_path / "run.json"
    journal.write_text(json.dumps(run))
    pointer, payload, artifacts = publication.prepare(tmp_path, journal, node(), partial=True)
    assert len(payload["sessions"]) == 124
    assert sum(row["state"] == "AVAILABLE" for row in payload["sessions"]) == 1
    store = publication.Store(FakeS3(), "bucket", publication.PREFIX)
    publication.publish(store, pointer, payload, artifacts, expected_parent=None)
    assert store.get_json(publication.CURRENT)[0] == pointer
    wrong = {**session, "sources": {"depth": {**depth, "record_count": 6}, "trade": trade}}
    with pytest.raises(ValueError, match="frozen inventory"):
        validation.validate(tmp_path, stem, wrong, plan_id, catalog_pin)
    for name, change, error in (
        ("source-check", lambda value: value.update(checker_sha256="b" * 64), "checker code"),
        ("state-check", lambda value: value.update(method_sha256="b" * 64), "checker code"),
        ("candidate", lambda value: value["units"].update(quantity="BTC"), "descriptor differs"),
        ("reads", lambda value: value["measurements"][3].update(refusal="too big"), "state read gate"),
    ):
        value = json.loads(originals[files[name]])
        change(value)
        files[name].write_text(json.dumps(value))
        patched = json.loads(json.dumps(status))
        next(stage for stage in patched["stages"] if stage["name"] == name)["sha256"] = validation.digest(files[name])
        status_path.write_text(json.dumps(patched))
        with pytest.raises(ValueError, match=error):
            validation.validate(tmp_path, stem, session, plan_id, catalog_pin)
        files[name].write_bytes(originals[files[name]])
        status_path.write_text(json.dumps(status))
    part = output / "events/part-0000.parquet"
    with part.open("ab") as sink:
        sink.write(b"corrupt")
    with pytest.raises(ValueError, match="part integrity"):
        validation.validate(tmp_path, stem, session, plan_id, catalog_pin)
