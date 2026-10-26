import hashlib
import datetime as dt
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import historical_l2_catalog as catalog
from s3_publish import Store
from test_s3_publish import FakeS3


def fixture():
    store = Store(FakeS3(), "bucket", catalog.PREFIX)
    instrument = json.dumps(catalog.PROFILES[0], separators=(",", ":"))
    derivation, source = "d" * 64, "c" * 64
    day = "2026-08-05"
    start = int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    prefix = catalog.PREFIX + "/databento/instrument=" + hashlib.sha256(instrument.encode()).hexdigest() + "/derivation=" + derivation + "/date=" + day
    objects, families = [], {}
    for name, schema in [("states", "historical-l2-second/1"), ("events", "historical-l2-level-event/1")]:
        part = {"name": "part-0000.parquet", "rows": 2, "bytes": 11, "sha256": hashlib.sha256(b"sealed part").hexdigest(),
                "decoded_bytes": 100, "first_known_ns": str(start + 1), "last_known_ns": str(start + 2)}
        key = prefix + "/" + name + "/manifest.json"
        manifest = {"schema": schema, "instrument_id": instrument, "derivation_id": derivation, "rows": 2, "parts": [part]}
        if name == "states":
            manifest.update(window_from_ns=str(start), window_to_ns=str(start + 86_400_000_000_000))
        data = catalog.encoded(manifest)
        store.client.objects[key] = data
        checksum = hashlib.sha256(data).hexdigest()
        objects += [{"key": key, "bytes": len(data), "sha256": checksum}, {"key": prefix + "/" + name + "/" + part["name"], **part}]
        families[name] = {"manifest_sha256": checksum, "rows": 2}
    descriptor = {"schema": "historical-l2-candidate/1", "status": "LOCAL_VERIFIED; NOT_PUBLISHED", "prefix": prefix,
                  "instrument_id": instrument, "date": day, "derivation_id": derivation,
                  "source_catalog_sha256": source, "depth_limit": 10, "families": families, "objects": objects,
                  "window_from_ns": str(start), "window_to_ns": str(start + 86_400_000_000_000), "tick_size": "0.25",
                  "units": {"price": "USD", "quantity": "CONTRACT", "time": "UTC nanoseconds", "inference": "engine-number"}}
    key = prefix + "/candidate.json"
    data = catalog.encoded(descriptor)
    store.client.objects[key] = data
    rows = []
    for profile in catalog.PROFILES:
        identity = json.dumps(profile, separators=(",", ":"))
        for number in range(1, 32):
            row = {"instrument_id": identity, "date": f"2026-08-{number:02d}", "state": "UNAVAILABLE", "reason": "NOT_YET_QUALIFIED"}
            if identity == instrument and number == 5:
                row.update(state="AVAILABLE", reason="FULL_DAY_VERIFIED", derivation_id=derivation,
                           descriptor_key=key.removeprefix(catalog.PREFIX + "/"),
                           descriptor_bytes=len(data), descriptor_sha256=hashlib.sha256(data).hexdigest())
            rows.append(row)
    payload = {"schema": "historical-l2-release/1", "month": "2026-08", "depth_limit": 10,
               "scope": "QUALIFIED_SUBSET", "plan_id": "a" * 64, "source_catalog_sha256": source, "sessions": rows,
               "inference": "top-ten depth inference; not order-level cancellation truth"}
    publish_catalog(store, payload)
    return store, instrument, payload, descriptor


def publish_catalog(store, payload):
    data = catalog.encoded(payload)
    release = hashlib.sha256(data).hexdigest()
    pointer = {"schema": "historical-l2-pointer/1", "release_id": release, "catalog_sha256": release,
               "catalog_bytes": len(data), "catalog_key": "_catalog/releases/" + release + ".json"}
    store.client.objects[store.key(pointer["catalog_key"])] = data
    store.client.objects[store.key("_catalog/CURRENT.json")] = catalog.encoded(pointer)
    return pointer


def test_catalog_descriptor_and_manifest_authenticate_complete_graph():
    store, instrument, expected, _descriptor = fixture()
    pointer, payload = catalog.current(store)
    assert payload == expected
    for family in ("states", "events"):
        _descriptor, manifest, prefix = catalog.family(store, pointer, payload, instrument, "2026-08-05", family)
        assert manifest["rows"] == 2 and prefix.startswith("databento/")
    with pytest.raises(LookupError, match="NOT_YET_QUALIFIED"):
        catalog.family(store, pointer, payload, instrument, "2026-08-06", "states")


def test_changed_remote_catalog_and_descriptor_fail_hashes():
    store, instrument, _payload, _descriptor = fixture()
    pointer, payload = catalog.current(store)
    row = next(row for row in payload["sessions"] if row["state"] == "AVAILABLE")
    store.client.objects[store.key(row["descriptor_key"])] += b" "
    with pytest.raises(ValueError, match="pinned size"):
        catalog.family(store, pointer, payload, instrument, row["date"], "events")
    store.client.objects[store.key(pointer["catalog_key"])] = b"x" * pointer["catalog_bytes"]
    with pytest.raises(ValueError, match="hash"):
        catalog.current(store)


@pytest.mark.parametrize("change", [
    lambda p: p["sessions"].pop(),
    lambda p: p["sessions"].__setitem__(1, p["sessions"][0]),
    lambda p: next(r for r in p["sessions"] if r["state"] == "AVAILABLE").update(descriptor_key="raw/secret"),
    lambda p: p["sessions"][0].update(instrument_id='["XCME","EQUITY","ESU6","USD","SHARE"]'),
    lambda p: p.update(depth_limit=20),
])
def test_authenticated_but_invalid_release_is_refused(change):
    store, _instrument, payload, _descriptor = fixture()
    change(payload)
    publish_catalog(store, payload)
    with pytest.raises(ValueError):
        catalog.current(store)


def test_snapshot_survives_pointer_change_and_binds_owner_expiry_and_capacity():
    store, _instrument, payload, _descriptor = fixture()
    now = [1000]
    registry = catalog.Snapshots(clock=lambda: now[0])
    token, pointer, _value = registry.issue(store, "alice")
    payload["scope"] = "COMPLETE_MONTH_DISPOSITIONS"
    publish_catalog(store, payload)
    assert registry.resolve(token, "alice")[0] == pointer
    with pytest.raises(ValueError, match="foreign"):
        registry.resolve(token, "bob")
    assert registry.issue(store, "alice")[0] != token
    for index in range(2):
        payload["plan_id"] = str(index + 1) * 64
        publish_catalog(store, payload)
        registry.issue(store, "alice")
    payload["plan_id"] = "9" * 64
    publish_catalog(store, payload)
    with pytest.raises(RuntimeError, match="capacity"):
        registry.issue(store, "alice")
    now[0] += catalog.TTL
    with pytest.raises(ValueError, match="expired"):
        registry.resolve(token, "alice")
    registry.issue(store, "alice")


def test_signed_cursor_rejects_wrong_query_tampering_and_expiry():
    now = [1000]
    registry = catalog.Snapshots(clock=lambda: now[0])
    token = registry.cursor("a" * 64, "99999999")
    assert len(token) <= 512 and registry.position(token, "a" * 64) == "99999999"
    with pytest.raises(ValueError, match="foreign"):
        registry.position(token, "b" * 64)
    with pytest.raises(ValueError):registry.position(token[:-5] + "abcde", "a" * 64)
    now[0] += catalog.TTL
    with pytest.raises(ValueError, match="expired"):
        registry.position(token, "a" * 64)


def test_missing_release_and_cancelled_metadata_are_explicit():
    store = Store(FakeS3(), "bucket", catalog.PREFIX)
    with pytest.raises(LookupError, match="not published"):catalog.current(store)
    store, _instrument, _payload, _descriptor = fixture()
    with pytest.raises(InterruptedError):catalog.current(store, cancelled=lambda: True)


@pytest.mark.parametrize("changes", [
    {"tick_size": "0.5"}, {"units": {"quantity": "SHARE"}}, {"window_from_ns": "0"},
    {"families": []}, {"objects": [None] * 4},
])
def test_authenticated_descriptor_cannot_change_geometry_or_structure(changes):
    store, instrument, payload, descriptor = fixture()
    descriptor.update(changes)
    data = catalog.encoded(descriptor)
    store.client.objects[descriptor["prefix"] + "/candidate.json"] = data
    row = next(r for r in payload["sessions"] if r["state"] == "AVAILABLE")
    row.update(descriptor_bytes=len(data), descriptor_sha256=hashlib.sha256(data).hexdigest())
    pointer = publish_catalog(store, payload)
    with pytest.raises(ValueError):
        catalog.family(store, pointer, payload, instrument, "2026-08-05", "events")


def test_repeated_discovery_reuses_same_viewer_snapshot_without_extending_expiry():
    store, _instrument, _payload, _descriptor = fixture()
    now = [1000]
    registry = catalog.Snapshots(clock=lambda: now[0])
    first = registry.issue(store, "alice")[0]
    now[0] += 100
    for _index in range(20):
        assert registry.issue(store, "alice")[0] == first
    assert len(registry.entries) == 1
    now[0] = 1000 + catalog.TTL
    with pytest.raises(ValueError):
        registry.resolve(first, "alice")
