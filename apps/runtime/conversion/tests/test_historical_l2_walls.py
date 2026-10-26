import gzip
import hashlib
import json

import pytest

from historical_l2_walls import Registry, encoded, manifest_parts, read_page
import historical_l2_catalog as catalog
from test_historical_l2_catalog import fixture


def index(tmp_path):
    store, instrument, _release, descriptor = fixture()
    pointer, release = catalog.current(store)
    _, events, _ = catalog.family(store, pointer, release, instrument, "2026-08-05", "events")
    start = int(descriptor["window_from_ns"])
    profile = {"tick_size": "0.25", "sample_ms": 1000}
    profile_id = hashlib.sha256(encoded(profile)).hexdigest()
    values = [{"schema": "historical-l2-wall-view/2", "profile_id": profile_id, "segment_id": "e" * 64,
               "instrument_id": instrument, "derivation_id": descriptor["derivation_id"], "known_ns": str(start + i * 10**9),
               "through_known_key": [str(start + i * 10**9 - 1), "2", "1", "0"], "walls": [], "lifecycle": [],
               "trades": [], "wall_trades": []} for i in range(1, 4)]
    values.append({"schema": "historical-l2-wall-segment-end/2", "known_ns": str(start + 4 * 10**9),
                   "profile_id": profile_id, "segment_id": "e" * 64, "cause": "gap"})
    directory = tmp_path / hashlib.sha256(instrument.encode()).hexdigest() / "2026-08-05"
    directory.mkdir(parents=True)
    parts = []
    for i in range(2):
        raw = b"".join(encoded(v) + b"\n" for v in values[i * 2:i * 2 + 2])
        body = gzip.compress(raw)
        part = {"key": f"part-{i:04d}.jsonl.gz", "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                "decoded_bytes": len(raw), "decoded_sha256": hashlib.sha256(raw).hexdigest(), "rows": 2,
                "first_position": i * 2, "last_position": i * 2 + 1,
                "min_known_ns": values[i * 2]["known_ns"], "max_known_ns": values[i * 2 + 1]["known_ns"]}
        (directory / part["key"]).write_bytes(body)
        parts.append(part)
    manifest = {"schema": "historical-l2-wall-index/1", "release_id": pointer["release_id"],
                "descriptor_sha256": next(r["descriptor_sha256"] for r in release["sessions"] if r["state"] == "AVAILABLE"),
                "event_manifest_sha256": descriptor["families"]["events"]["manifest_sha256"],
                "instrument_id": instrument, "derivation_id": descriptor["derivation_id"], "profile_id": profile_id,
                "profile": profile, "from_ns": str(start), "to_ns": descriptor["window_to_ns"], "sample_ms": 1000,
                "input_rows": events["rows"], "rows": 4, "samples": 3, "segments": 1, "parts": parts,
                "encoded_bytes": sum(p["bytes"] for p in parts)}
    raw = encoded(manifest)
    (directory / "manifest.json").write_bytes(raw)
    entry = {"instrument_id": instrument, "date": "2026-08-05", "manifest_bytes": len(raw), "manifest_sha256": hashlib.sha256(raw).hexdigest()}
    return store, pointer, release, descriptor, events, manifest, directory, entry, values


def test_pages_equal_independent_full_read_and_never_expose_future(tmp_path):
    *_, manifest, directory, _entry, values = index(tmp_path)
    paths = {p["key"]: str(directory / p["key"]) for p in manifest["parts"]}
    query = dict(from_ns=manifest["from_ns"], to_ns=str(int(manifest["from_ns"]) + 5 * 10**9),
                 as_of_key=[str(int(manifest["from_ns"]) + 4 * 10**9), "999", "999", "999"], limit=1)
    rows, position = [], None
    for _ in range(10):
        page = read_page(manifest, paths, **query, after_position=position)
        rows.extend(page["rows"])
        if page["nextPosition"] is None:
            break
        assert page["nextPosition"] != position
        position = page["nextPosition"]
    else:
        pytest.fail("no forward progress")
    assert [row["payload"] for row in rows] == values
    early = read_page(manifest, paths, **{**query, "limit": 100, "as_of_key": [values[0]["known_ns"], "999", "999", "999"]})
    assert [row["payload"] for row in early["rows"]] == values[:1]


def test_registry_requires_matching_published_release_and_exact_bytes(tmp_path):
    _store, pointer, release, descriptor, events, manifest, directory, entry, _ = index(tmp_path)
    registry = Registry(tmp_path, [entry])
    assert registry.admit(pointer, release, descriptor, events, manifest["instrument_id"], entry["date"])[0] == manifest
    with pytest.raises(ValueError, match="source release"):
        registry.admit({**pointer, "release_id": "a" * 64}, release, descriptor, events, manifest["instrument_id"], entry["date"])
    with pytest.raises(LookupError, match="NOT_QUALIFIED"):
        registry.admit(pointer, release, descriptor, events, manifest["instrument_id"], "2026-08-06")
    (directory / "manifest.json").write_bytes(b"x" * entry["manifest_bytes"])
    with pytest.raises(ValueError, match="hash"):
        registry.admit(pointer, release, descriptor, events, manifest["instrument_id"], entry["date"])


@pytest.mark.parametrize("change", [lambda m: m.update(rows=5), lambda m: m["parts"][1].update(first_position=1),
                                  lambda m: m["parts"][0].update(decoded_bytes=5 * 1024**2),
                                  lambda m: m["profile"].update(sample_ms=2000)])
def test_invalid_manifests_fail_before_part_read(tmp_path, change):
    *_, manifest, _directory, _entry, _values = index(tmp_path)
    change(manifest)
    with pytest.raises(ValueError):
        manifest_parts(manifest)


def test_corrupt_part_scan_budget_and_cancellation_are_explicit(tmp_path):
    *_, manifest, directory, _entry, _values = index(tmp_path)
    paths = {p["key"]: str(directory / p["key"]) for p in manifest["parts"]}
    query = dict(from_ns=manifest["from_ns"], to_ns=str(int(manifest["from_ns"]) + 5 * 10**9),
                 as_of_key=[str(int(manifest["from_ns"]) + 4 * 10**9), "999", "999", "999"])
    with pytest.raises(InterruptedError):
        read_page(manifest, paths, **query, cancelled=lambda: True)
    with pytest.raises(ValueError, match="first part"):
        read_page(manifest, paths, **query, max_scan_bytes=1)
    first = directory / manifest["parts"][0]["key"]
    raw = first.read_bytes()
    first.write_bytes(b"X" + raw[1:])
    with pytest.raises(ValueError, match="hash"):
        read_page(manifest, paths, **query)
