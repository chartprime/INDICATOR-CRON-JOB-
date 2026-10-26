import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/verify/databento"))
from prepare_historical_index_plan import build_plan, load_job
import prepare_historical_index_plan as planner
from test_historical_l2_catalog import fixture
import historical_l2_catalog as catalog


def retained(tmp_path):
    store, instrument, _release, _descriptor = fixture()
    pointer, release = catalog.current(store)
    row = next(row for row in release["sessions"] if row["state"] == "AVAILABLE")
    descriptor, _events, _ = catalog.family(store, pointer, release, instrument, row["date"], "events")
    # Planner needs source-count evidence; retain the descriptor bytes exactly.
    root = tmp_path / "data" / "retained-core"
    root.mkdir(parents=True)
    body = json.dumps(descriptor).encode()
    (root / "candidate.json").write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    job = {"instrument_id": instrument, "date": row["date"], "candidate_root": str(root),
           "descriptor_sha256": digest, "event_rows": 3, "source_rows": 2, "minimum_size": 40}
    return store, instrument, job, descriptor


def frozen(tmp_path, job):
    path = tmp_path / "plan.json"
    body = json.dumps({"schema": "historical-l2-index-plan/1", "qualified_root": str(tmp_path), "jobs": [job]}).encode()
    path.write_bytes(body)
    return path, hashlib.sha256(body).hexdigest()


def test_pinned_job_rejects_changed_source_and_wrong_plan(tmp_path):
    _store, instrument, job, descriptor = retained(tmp_path)
    path, sha = frozen(tmp_path, job)
    assert load_job(path, sha, instrument, job["date"])[2] == descriptor
    with pytest.raises(ValueError, match="plan hash"):
        load_job(path, "0" * 64, instrument, job["date"])
    (Path(job["candidate_root"]) / "candidate.json").write_text("{}")
    with pytest.raises(ValueError, match="published plan"):
        load_job(path, sha, instrument, job["date"])


def test_exact_day_and_root_required(tmp_path):
    _store, instrument, job, _descriptor = retained(tmp_path)
    path, sha = frozen(tmp_path, job)
    with pytest.raises(ValueError, match="unique"):
        load_job(path, sha, instrument, "2026-08-06")
    job["candidate_root"] = str(tmp_path)
    path, sha = frozen(tmp_path, job)
    with pytest.raises(ValueError, match="escapes"):
        load_job(path, sha, instrument, job["date"])


def test_all_published_days_must_have_retained_descriptors(tmp_path):
    store, _instrument, _job, _descriptor = retained(tmp_path)
    with pytest.raises(ValueError, match="lacks retained"):
        build_plan(store, tmp_path)


def test_source_counts_and_unavailable_dates_are_preserved(tmp_path, monkeypatch):
    store, instrument, job, descriptor = retained(tmp_path)
    descriptor["flow_counts"] = {"rows": 2}
    release = {"sessions": [{"state": "AVAILABLE", **job},
        {"state": "UNAVAILABLE", "instrument_id": instrument, "date": "2026-08-06", "reason": "NO_SOURCE"}]}
    monkeypatch.setattr(planner.catalog, "current", lambda _store: ({"release_id": "a" * 64}, release))
    monkeypatch.setattr(planner.catalog, "family", lambda *_args: (descriptor, {"rows": 3, "parts": [{"bytes": 10}]}, ""))
    plan = build_plan(store, tmp_path)
    assert len(plan["jobs"]) == 1
    assert plan["jobs"][0]["source_rows"] == 2
    assert plan["unavailable"][0]["reason"] == "NO_SOURCE"
    monkeypatch.setattr(planner.catalog, "family", lambda *_args: (descriptor, {"rows": 100_000_001}, ""))
    with pytest.raises(ValueError, match="admission"):
        build_plan(store, tmp_path)
