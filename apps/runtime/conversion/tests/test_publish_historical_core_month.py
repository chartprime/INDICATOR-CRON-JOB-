from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import publish_historical_core_month as publication
from test_s3_publish import FakeS3


def fixture(tmp_path, day="2026-08-05"):
    tmp_path.mkdir(parents=True, exist_ok=True)
    client = FakeS3()
    store = publication.Store(client, "bucket", publication.PREFIX)
    path = tmp_path / "part.parquet"
    path.write_bytes(b"sealed data")
    prefix = "curated/l2-core/databento/instrument=i/derivation=d/date=" + day
    part_key = prefix.removeprefix(publication.PREFIX + "/") + "/states/part-0000.parquet"
    descriptor_key = prefix.removeprefix(publication.PREFIX + "/") + "/candidate.json"
    candidate = {"schema": "historical-l2-candidate/1", "status": "LOCAL_VERIFIED; NOT_PUBLISHED", "prefix": prefix,
                 "instrument_id": "instrument", "date": day, "derivation_id": "d",
                 "objects": [{"key": publication.PREFIX + "/" + part_key,
                              "sha256": publication.digest(path), "bytes": path.stat().st_size}]}
    descriptor = tmp_path / "candidate.json"
    descriptor.write_bytes(publication.encoded(candidate))
    row = {"instrument_id": "instrument", "date": day, "state": "AVAILABLE", "reason": "FULL_DAY_VERIFIED",
           "derivation_id": "d", "descriptor_key": descriptor_key, "descriptor_sha256": publication.digest(descriptor),
           "descriptor_bytes": descriptor.stat().st_size}
    payload = {"schema": "historical-l2-release/1", "month": "2026-08", "sessions": [row]}
    artifacts = {part_key: (path, publication.digest(path), path.stat().st_size),
                 descriptor_key: (descriptor, publication.digest(descriptor), descriptor.stat().st_size)}
    return store, payload, artifacts


def pointer(payload):
    data = publication.encoded(payload)
    sha = hashlib.sha256(data).hexdigest()
    return {"schema": "historical-l2-pointer/1", "release_id": sha, "catalog_key": "_catalog/releases/" + sha + ".json",
            "catalog_sha256": sha, "catalog_bytes": len(data)}


def test_remote_verification_precedes_pointer_and_other_catalogs_stay_unchanged(tmp_path):
    store, payload, artifacts = fixture(tmp_path)
    prior_candles = "curated/databento/_catalog/CURRENT.json"
    store.client.objects[prior_candles] = b"existing candles and L1"
    order = []
    store.client.before_put = order.append
    result = publication.publish(store, pointer(payload), payload, artifacts, expected_parent=None, workers=1)
    assert result["status"] == "PUBLISHED"
    assert store.client.objects[prior_candles] == b"existing candles and L1"
    assert order.index(store.key(publication.CURRENT)) > max(order.index(store.key(key)) for key in artifacts)
    assert result["verified_read_bytes"] > sum(value[2] for value in artifacts.values())
    assert publication.publish(store, pointer(payload), payload, artifacts, expected_parent=None)["status"] == "PUBLISHED"


def test_upload_failure_and_pointer_timeout_leave_no_false_visibility_and_retry_recovers(tmp_path):
    store, payload, artifacts = fixture(tmp_path)

    def failure(key):
        if key.endswith("CURRENT.json"):
            raise TimeoutError()

    store.client.before_put = failure
    with pytest.raises(TimeoutError):
        publication.publish(store, pointer(payload), payload, artifacts, expected_parent=None, workers=1)
    assert store.get_json(publication.CURRENT)[0] is None
    store.client.before_put = None
    publication.publish(store, pointer(payload), payload, artifacts, expected_parent=None)
    assert store.get_json(publication.CURRENT)[0] == pointer(payload)


def test_parent_race_refuses_transition_and_old_retry_never_rolls_back(tmp_path):
    store, payload, artifacts = fixture(tmp_path)
    current_key = store.key(publication.CURRENT)

    def race(key):
        if key == current_key:
            store.client.objects[current_key] = publication.encoded({"newer": True})

    store.client.before_put = race
    with pytest.raises(publication.PublicationError, match="PARENT_CHANGED"):
        publication.publish(store, pointer(payload), payload, artifacts, expected_parent=None, workers=1)
    assert store.get_json(publication.CURRENT)[0] == {"newer": True}
    store.client.before_put = None
    with pytest.raises(publication.PublicationError, match="PARENT_CHANGED"):
        publication.publish(store, pointer(payload), payload, artifacts, expected_parent=None)


def test_completed_parent_days_cannot_be_dropped_or_replaced(tmp_path):
    store, payload, artifacts = fixture(tmp_path)
    parent = pointer(payload)
    publication.publish(store, parent, payload, artifacts, expected_parent=None)
    changed = deepcopy(payload)
    _other_store, other_payload, other_artifacts = fixture(tmp_path / "other", "2026-08-06")
    changed["sessions"] = [{"instrument_id": "instrument", "date": "2026-08-05", "state": "UNAVAILABLE", "reason": "oops"},
                           other_payload["sessions"][0]]
    with pytest.raises(publication.PublicationError, match="DAY_DROPPED_OR_REPLACED"):
        publication.publish(store, pointer(changed), changed, other_artifacts, expected_parent=parent)
    newer = deepcopy(payload)
    newer["scope"] = "subset"
    publication.publish(store, pointer(newer), newer, artifacts, expected_parent=parent)
    assert store.get_json(publication.CURRENT)[0] == pointer(newer)
    assert store.get_json(parent["catalog_key"])[0] == payload


def test_corrupt_remote_object_and_missing_artifact_refuse_before_catalog(tmp_path):
    store, payload, artifacts = fixture(tmp_path)
    part_key = next(key for key in artifacts if key.endswith(".parquet"))
    store.client.objects[store.key(part_key)] = b"corrupt data"
    with pytest.raises(publication.PublicationError, match="MISMATCH"):
        publication.publish(store, pointer(payload), payload, artifacts, expected_parent=None)
    assert store.get_json(publication.CURRENT)[0] is None
    artifacts.pop(part_key)
    with pytest.raises(ValueError, match="artifact missing"):
        publication.publish(store, pointer(payload), payload, artifacts, expected_parent=None)
    assert store.get_json(publication.CURRENT)[0] is None


def test_partial_month_preparation_revalidates_available_days_and_refuses_full_claim(tmp_path, monkeypatch):
    from test_run_historical_core_month import setup
    import run_historical_core_month as runner
    source, pin, data, _identity, _calls, _maximum, _driver = setup(tmp_path, monkeypatch)
    stopped = __import__("threading").Event()
    stopped.set()
    result = runner.run(source, pin, "node", stopped=stopped)
    root = data / ("month-2026-08-" + result["plan"]["plan_id"][:12])
    monkeypatch.setattr(publication, "code_identity", runner.code_identity)
    with pytest.raises(ValueError, match="unfinished"):
        publication.prepare(data, root / "run.json", "node")
    with pytest.raises(ValueError, match="no qualified days"):
        publication.prepare(data, root / "run.json", "node", partial=True)
