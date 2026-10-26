import hashlib
import json

import pytest

from archive_admission import CancelToken
from archive_cache import PartCache
from archive_query import ArchiveQueryError
import historical_l2_catalog as catalog
from historical_l2_prints import Registry, write_index, read_page
from historical_l2_service import Service, CONTRACT_VERSION
from test_historical_l2_catalog import fixture, publish_catalog


def rig(tmp_path):
    store, instrument, release, descriptor = fixture()
    start = int(descriptor["window_from_ns"])
    counts = {"BUY": {"count": 1, "volume": 2}, "SELL": {"count": 1, "volume": 4}, "UNKNOWN": {"count": 1, "volume": 5}}
    descriptor["flow_counts"] = {"rows": 3, "observed": counts}
    body = catalog.encoded(descriptor)
    row = next(row for row in release["sessions"] if row["state"] == "AVAILABLE")
    store.client.objects[store.key(row["descriptor_key"])] = body
    row.update(descriptor_bytes=len(body), descriptor_sha256=hashlib.sha256(body).hexdigest())
    pointer = publish_catalog(store, release)
    values = []
    for index, (side, size) in enumerate((("BUY", 2), ("SELL", 4), ("UNKNOWN", 5))):
        event, known = start + index * 10**9, start + (index + 1) * 10**9
        values.append({"instrument_id": instrument, "known_ns": str(known), "event_ns": str(event), "source_rank": 2,
                       "stable_position": index, "ordinal": 0, "matched_trade": {"event_ns": str(event), "side": side,
                       "price": "100.0001", "size": str(size), "record_id": hashlib.sha256(str(index).encode()).hexdigest()}})
    root = tmp_path / "prints"
    directory = root / hashlib.sha256(instrument.encode()).hexdigest() / row["date"]
    directory.parent.mkdir(parents=True)
    manifest = write_index(values, directory, descriptor=descriptor, release_id=pointer["release_id"],
                           descriptor_sha256=row["descriptor_sha256"], expected_rows=3)
    raw = (directory / "manifest.json").read_bytes()
    entry = {"instrument_id": instrument, "date": row["date"], "manifest_bytes": len(raw), "manifest_sha256": hashlib.sha256(raw).hexdigest()}
    registry = Registry(root, [entry])
    return store, instrument, descriptor, pointer, manifest, directory, registry, values


def test_source_prints_preserve_exact_sizes_unknown_and_causal_cuts(tmp_path):
    _store, _instrument, _descriptor, _pointer, manifest, directory, _registry, _values = rig(tmp_path)
    paths = {part["key"]: str(directory / part["key"]) for part in manifest["parts"]}
    start = int(manifest["from_ns"])
    query = dict(from_ns=str(start), to_ns=str(start + 4 * 10**9), as_of_key=[str(start + 2 * 10**9), "9", "9", "9"], limit=1)
    first = read_page(manifest, paths, **query)
    second = read_page(manifest, paths, **query, after_position=first["nextPosition"])
    rows = first["rows"] + second["rows"]
    assert [row["payload"]["size"] for row in rows] == [2, 4]
    assert all(all(isinstance(value, str) for value in row["known_key"]) for row in rows)
    assert second["nextPosition"] is None
    assert manifest["counts"]["UNKNOWN"] == {"count": 1, "volume": 5}


def test_failure_never_seals_an_incomplete_or_invalid_source_index(tmp_path):
    *_parts, values = rig(tmp_path)
    descriptor = _parts[2]
    for reason, changed in (("count", values[:-1]), ("price", [{**values[0], "matched_trade": {**values[0]["matched_trade"], "price": "NaN"}}])):
        target = tmp_path / reason
        with pytest.raises(ValueError):
            write_index(changed, target, descriptor=descriptor, release_id="a" * 64, descriptor_sha256="b" * 64, expected_rows=3)
        assert not (target / "manifest.json").exists()


def test_native_trade_identity_preserves_raw_file_and_record_position(tmp_path):
    _store, _instrument, descriptor, pointer, _manifest, _directory, _registry, values = rig(tmp_path)
    for index, value in enumerate(values):
        value["matched_trade"]["record_id"] = f"raw:{'a' * 64}:{index}"
    target = tmp_path / "native"
    result = write_index(values, target, descriptor=descriptor, release_id=pointer["release_id"], descriptor_sha256="b" * 64, expected_rows=3)
    assert result["rows"] == 3
    values[0]["matched_trade"]["record_id"] = f"raw:{'a' * 64}:99"
    with pytest.raises(ValueError, match="position"):
        write_index(values, tmp_path / "wrong", descriptor=descriptor, release_id=pointer["release_id"], descriptor_sha256="b" * 64, expected_rows=3)


def test_real_worker_admits_index_and_binds_cursor_to_family_and_viewer(tmp_path):
    store, instrument, descriptor, _pointer, manifest, directory, registry, _values = rig(tmp_path)
    service = Service(store, PartCache(tmp_path / "cache", min_free_disk_bytes=0), service_secret="test-secret", print_registry=registry)
    token = CancelToken()
    try:
        discovery = service.query({"contractVersion": CONTRACT_VERSION, "operation": "catalog"}, client="alice", cancel_token=token)
        assert discovery["indexes"] == [{"family": "prints", "instrument_id": instrument, "date": "2026-08-05"}]
        start = int(descriptor["window_from_ns"])
        query = {"contractVersion": CONTRACT_VERSION, "operation": "page", "family": "prints", "date": "2026-08-05",
                 "snapshotToken": discovery["snapshotToken"], "instrumentId": instrument, "from": str(start),
                 "to": str(start + 4 * 10**9), "asOfKey": [str(start + 3 * 10**9), "9", "9", "9"], "limit": 1}
        page = service.query(query, client="alice", cancel_token=token)
        assert page["rows"][0]["payload"]["side"] == "BUY"
        with pytest.raises(ArchiveQueryError, match="CURSOR_MALFORMED"):
            service.query({**query, "family": "walls", "cursor": page["nextCursor"]}, client="alice", cancel_token=token)
        with pytest.raises(ArchiveQueryError, match="POINTER_TOKEN_INVALID"):
            service.query(query, client="bob", cancel_token=token)
        part = directory / manifest["parts"][0]["key"]
        body = part.read_bytes()
        part.write_bytes(b"X" + body[1:])
        with pytest.raises(ArchiveQueryError, match="PARTITION_VERIFICATION_FAILED"):
            service.query(query, client="alice", cancel_token=token)
        assert service.admission.in_flight == 0
        with service.cache._connect() as connection:
            assert connection.execute("SELECT count(*) FROM pins").fetchone()[0] == 0
    finally:
        service.close()
