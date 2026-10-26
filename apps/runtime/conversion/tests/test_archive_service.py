from __future__ import annotations

import hashlib
import json
import shutil
import threading
import time
from pathlib import Path

import duckdb
import jsonschema
import pytest

import archive_cache as ac
import archive_reader as ar
import archive_query as _aq
import archive_service as asvc
import archive_telemetry as at
import catalog
import s3_publish
from test_archive_cache import FakeS3
from writer import SORT_KEY, _COMMON_COLUMNS, _FAMILY_COLUMNS

CURATED = "curated"
IID = json.dumps(["XCME", "FUTURE", "NQU5", "USD", "CONTRACT"])
BASE = 1_756_684_800_000_000_000
SCHEMA_PATH = (Path(__file__).resolve().parents[4]
               / "docs/contracts/archive-query/v1/archive-query-v1.schema.json")


def _parquet(tmp_path, name, rows, family="trade", columns=None):
    path = str(tmp_path / name)
    sql_path = path.replace("'", "''")
    con = duckdb.connect()
    if rows and isinstance(rows[0], dict):
        columns = columns or {**_COMMON_COLUMNS, **_FAMILY_COLUMNS[family]}
        definition = ", ".join(f"{name} {kind}" for name, kind in columns.items())
        placeholders = ", ".join("?" for _ in columns)
        con.execute(f"CREATE TABLE records ({definition})")
        con.executemany(
            f"INSERT INTO records VALUES ({placeholders})",
            [[row[name] for name in columns] for row in rows])
        con.execute(f"COPY (SELECT * FROM records ORDER BY {', '.join(SORT_KEY)}) "
                    f"TO '{sql_path}' (FORMAT PARQUET)")
    else:
        values = ", ".join(
            f"({e}::UBIGINT, {s}::USMALLINT, {p}::UBIGINT, {o}::UINTEGER, 'rec-{e}-{o}')"
            for e, s, p, o in rows)
        con.execute(f"COPY (SELECT * FROM (VALUES {values}) "
                    f"AS t(event_ns, source_rank, stable_position, ordinal, record_id) "
                    f"ORDER BY {', '.join(SORT_KEY)}) TO '{sql_path}' (FORMAT PARQUET)")
    con.close()
    return open(path, "rb").read()


def _publish(client, tmp_path, *, date, rows, version="v1", family="trade", corrupt=False, columns=None):
    prefix = f"databento/{IID}/{family}/{version}/{date}"
    payload = _parquet(tmp_path, f"{date}.parquet", rows, family, columns)
    manifest = {"parts": [{"name": "part-00000.parquet", "bytes": len(payload),
                           "sha256": hashlib.sha256(payload).hexdigest(),
                           "row_count": len(rows)}],
                "record_count": len(rows)}
    client.put(f"{CURATED}/{_aq.partition_relative(prefix)}/part-00000.parquet",
               b"corrupted" + payload[9:] if corrupt else payload)
    raw = json.dumps(manifest).encode()
    client.put(f"{CURATED}/{_aq.partition_relative(prefix)}/_manifest.json", raw)
    return {
        "instrument_id": IID, "family": family, "dataset_version": version, "date": date,
        "record_count": len(rows), "rejected_count": 0,
        "event_ns_min": min(int(r["event_ns"] if isinstance(r, dict) else r[0]) for r in rows),
        "event_ns_max": max(int(r["event_ns"] if isinstance(r, dict) else r[0]) for r in rows),
        "logical_sha256": "a" * 64, "parts": manifest["parts"],
        "_prefix": prefix, "_manifest_sha": hashlib.sha256(raw).hexdigest(),
    }


def _catalog(tmp_path, manifests):
    root = tmp_path / "curated" / "_catalog"
    root.mkdir(parents=True)
    db = str(tmp_path / "cat.sqlite")
    builder = catalog.CatalogBuilder(db)
    for version in {m["dataset_version"] for m in manifests}:
        builder.record_dataset_version(version, converter_version="conversion/0.2",
                                       contract_version="market-observation/1")
    for m in manifests:
        builder.record_partition(m, m["_prefix"], m["_manifest_sha"], published_to_s3=True)
    for version in {m["dataset_version"] for m in manifests}:
        builder.mark_published(version)
    builder.close()
    catalog.publish(str(root), db, sorted({m["dataset_version"] for m in manifests})[0])
    return str(root)


def _install_catalog(source_root, live_root):
    live_root.mkdir(parents=True, exist_ok=True)
    pointer = json.loads((Path(source_root) / "CURRENT.json").read_text(encoding="utf-8"))
    shutil.copy2(Path(source_root) / pointer["catalog_key"], live_root / pointer["catalog_key"])
    (live_root / "CURRENT.json").write_text(json.dumps(pointer), encoding="utf-8")


@pytest.fixture
def rig(tmp_path):
    client = FakeS3()
    manifests = [
        _publish(client, tmp_path, date="2025-09-01",
                 rows=[(BASE + i, 0, i, 0) for i in range(6)]),
        _publish(client, tmp_path, date="2025-09-02",
                 rows=[(BASE + 100 + i, 0, i, 0) for i in range(6)]),
    ]
    root = _catalog(tmp_path, manifests)
    registry = ac.SnapshotRegistry(root)
    cache = ac.PartCache(tmp_path / "cache", min_free_disk_bytes=0)
    store = s3_publish.Store(client, "bucket", CURATED)
    connection = ar.connect()
    yield {"registry": registry, "cache": cache, "store": store, "connection": connection,
           "client": client, "tmp": tmp_path, "manifests": manifests}
    asvc.shutdown_readers(cache.root)
    connection.close()


@pytest.fixture(params=("trade", "quote", "candle"))
def valid_family_rig(tmp_path, request):
    from test_archive_query_contract import _candle_row, _quote_row, _trade_row

    family = request.param
    builders = {"trade": _trade_row, "quote": _quote_row, "candle": _candle_row}
    client = FakeS3()
    manifests = [_publish(client, tmp_path, date="2025-09-01",
                          rows=[builders[family](event_ns=str(BASE))], family=family)]
    root = _catalog(tmp_path, manifests)
    connection = ar.connect()
    registry = ac.SnapshotRegistry(root)
    cache = ac.PartCache(tmp_path / "cache", min_free_disk_bytes=0)
    store = s3_publish.Store(client, "bucket", CURATED)
    yield {"registry": registry, "cache": cache, "store": store, "connection": connection,
           "family": family}
    asvc.shutdown_readers(cache.root)
    connection.close()


def _query(rig, **overrides):
    kwargs = {"instrument_id": IID, "family": "trade", "from_ns": str(BASE),
              "to_ns": str(BASE + 1000), "curated_prefix": CURATED}
    kwargs.update(overrides)
    return asvc.query(rig["registry"], rig["cache"], rig["store"], rig["connection"], **kwargs)


def test_a_query_returns_an_ordered_page_with_a_token_and_coverage(rig):
    response = _query(rig, limit=100)

    assert response["contractVersion"] == "archive-query/1"
    assert response["pointerToken"]
    expected = [BASE + i for i in range(6)] + [BASE + 100 + i for i in range(6)]
    assert [int(r["event_ns"]) for r in response["rows"]] == expected
    assert response["coverage"]["states"] == {"PUBLISHED": 2, "UNKNOWN": 2}
    assert response["coverage"]["partitions"] == 2
    assert response["scan"]["cacheMisses"] == 2 and response["scan"]["cacheHits"] == 0


def _counts(telemetry):
    return {stage: entry["count"] for stage, entry in telemetry.snapshot()["stages"].items()}


def test_a_cold_query_records_every_stage_exactly_once(rig, monkeypatch):
    telemetry = at.StageTelemetry()
    get_object = rig["client"].get_object

    def timed_download(*args, **kwargs):
        if kwargs["Key"].endswith(".parquet"):
            time.sleep(0.02)
        return get_object(*args, **kwargs)

    monkeypatch.setattr(rig["client"], "get_object", timed_download)

    response = _query(rig, limit=100, telemetry=telemetry)

    assert response["scan"]["cacheMisses"] == 2
    assert _counts(telemetry) == {stage: 1 for stage in at.STAGES}
    stages = telemetry.snapshot()["stages"]
    assert stages["downloadMs"]["totalMs"] > 0.0
    assert stages["fetchMs"]["totalMs"] >= stages["manifestMs"]["totalMs"]
    assert stages["serviceMs"]["totalMs"] >= stages["fetchMs"]["totalMs"] + stages["queryMs"]["totalMs"]
    assert stages["queryMs"]["totalMs"] >= stages["readerRoundTripMs"]["totalMs"]


def test_a_warm_query_spends_no_time_downloading(rig):
    telemetry = at.StageTelemetry()
    _query(rig, limit=100, telemetry=telemetry)
    cold_download_ms = telemetry.snapshot()["stages"]["downloadMs"]["totalMs"]

    second = _query(rig, limit=100, telemetry=telemetry)

    assert second["scan"]["cacheHits"] == 2 and second["scan"]["cacheMisses"] == 0
    stages = telemetry.snapshot()["stages"]
    assert stages["downloadMs"]["count"] == 2
    assert stages["downloadMs"]["totalMs"] - cold_download_ms == pytest.approx(0.0, abs=1e-9)


def test_stage_names_stay_out_of_the_versioned_response_contract(rig):
    response = _query(rig, limit=100, telemetry=at.StageTelemetry())

    assert set(response["scan"]) == {
        "partitionsRead", "partitionsSelected", "partsOpened", "exactScanBytes",
        "bytesRead", "cacheHits", "cacheMisses", "fetchMs", "queryMs",
    }
    assert "stageMs" not in response


def test_a_refused_query_still_records_the_time_it_held_a_slot(rig):
    telemetry = at.StageTelemetry()

    with pytest.raises(_aq.ArchiveQueryError):
        _query(rig, family="not-a-family", limit=100, telemetry=telemetry)

    counts = _counts(telemetry)
    assert counts["admissionWaitMs"] == 1
    assert counts["serviceMs"] == 1
    assert counts["fetchMs"] == 0 and counts["queryMs"] == 0


def test_part_ranges_are_read_from_parquet_metadata_not_row_aggregation(rig):
    class Probe:
        def execute(self, query, arguments):
            assert "parquet_metadata" in query
            assert "read_parquet" not in query
            return rig["connection"].execute(query, arguments)

    path = rig["tmp"] / "range.parquet"
    payload = _parquet(rig["tmp"], "range.parquet", [(BASE + 2, 0, 2, 0), (BASE + 9, 0, 9, 0)])
    path.write_bytes(payload)
    low, high = asvc.part_range(Probe(), "e" * 64, str(path))

    assert (low, high) == (str(BASE + 2), str(BASE + 9))


def test_cold_part_range_lookups_never_use_the_shared_duckdb_connection_concurrently():
    class Probe:
        def __init__(self):
            self.lock = threading.Lock()
            self.active = 0
            self.concurrent = False

        def execute(self, _query, _arguments):
            with self.lock:
                self.active += 1
                self.concurrent = self.concurrent or self.active > 1
            time.sleep(0.05)
            with self.lock:
                self.active -= 1
            return self

        def fetchone(self):
            return BASE, BASE + 1

    probe = Probe()
    start = threading.Barrier(3)
    errors = []

    def read(sha):
        try:
            start.wait()
            asvc.part_range(probe, sha, f"/{sha}.parquet")
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    shas = ("1" * 64, "2" * 64)
    for sha in shas:
        asvc._ranges.pop(sha, None)
    threads = [threading.Thread(target=read, args=(sha,)) for sha in shas]
    for thread in threads:
        thread.start()
    start.wait()
    for thread in threads:
        thread.join(10)

    assert errors == []
    assert not probe.concurrent


def test_paging_through_a_query_concatenates_to_the_whole_window(rig):
    collected, cursor, token = [], None, None
    for _ in range(20):
        response = _query(rig, limit=2, cursor=cursor, pointer_token=token)
        collected.extend(int(r["event_ns"]) for r in response["rows"])
        cursor, token = response["nextCursor"], response["pointerToken"]
        if cursor is None:
            break

    assert collected == [BASE + i for i in range(6)] + [BASE + 100 + i for i in range(6)]
    assert len(collected) == len(set(collected))


def test_later_pages_reuse_the_pinned_snapshot(rig):
    first = _query(rig, limit=2)
    again = _query(rig, limit=2, cursor=first["nextCursor"],
                   pointer_token=first["pointerToken"])

    assert again["pointer"]["catalog_sha256"] == first["pointer"]["catalog_sha256"]
    assert again["pointerToken"] == first["pointerToken"]
    assert again["scan"]["cacheHits"] == 2, "the second page reuses cached parts"


def test_a_corrupt_partition_degrades_the_window_instead_of_failing_it(tmp_path):
    # The contract's choice: serve what is sound and name the casualty, rather
    # than discard good data and leave the caller nothing to draw.
    client = FakeS3()
    good = _publish(client, tmp_path, date="2025-09-01",
                    rows=[(BASE + i, 0, i, 0) for i in range(4)])
    bad = _publish(client, tmp_path, date="2025-09-02",
                   rows=[(BASE + 100 + i, 0, i, 0) for i in range(4)], corrupt=True)
    root = _catalog(tmp_path, [good, bad])
    connection = ar.connect()

    response = asvc.query(
        ac.SnapshotRegistry(root), ac.PartCache(tmp_path / "c", min_free_disk_bytes=0),
        s3_publish.Store(client, "bucket", CURATED), connection,
        instrument_id=IID, family="trade", from_ns=str(BASE), to_ns=str(BASE + 1000),
        curated_prefix=CURATED, limit=100)
    connection.close()

    assert [int(r["event_ns"]) for r in response["rows"]] == [BASE + i for i in range(4)]
    assert response["coverage"]["states"] == {"PUBLISHED": 1, "CORRUPT": 1, "UNKNOWN": 2}
    assert response["coverage"]["corrupt"][0]["date"] == "2025-09-02"
    assert response["coverage"]["partitions"] == 2
    # `partitionsRead` used to report what discovery selected, so a window with a
    # corrupt partition claimed to have read it. A field named "read" must count
    # what was read.
    assert response["scan"]["partitionsRead"] == 1
    assert response["scan"]["partitionsSelected"] == 2


def test_every_partition_corrupt_returns_an_empty_success_not_an_error(tmp_path):
    client = FakeS3()
    bad = _publish(client, tmp_path, date="2025-09-01",
                   rows=[(BASE + i, 0, i, 0) for i in range(4)], corrupt=True)
    root = _catalog(tmp_path, [bad])
    connection = ar.connect()

    response = asvc.query(
        ac.SnapshotRegistry(root), ac.PartCache(tmp_path / "c", min_free_disk_bytes=0),
        s3_publish.Store(client, "bucket", CURATED), connection,
        instrument_id=IID, family="trade", from_ns=str(BASE), to_ns=str(BASE + 1000),
        curated_prefix=CURATED, limit=100)
    connection.close()

    assert response["rows"] == []
    assert response["coverage"]["states"] == {"CORRUPT": 1, "UNKNOWN": 1}
    assert response["coverage"]["served"] is None


def test_a_window_with_no_partitions_is_an_empty_success(rig):
    response = _query(rig, from_ns=str(BASE + 900_000), to_ns=str(BASE + 950_000))

    assert response["rows"] == [] and response["nextCursor"] is None
    assert response["coverage"]["served"] is None
    assert response["coverage"]["partitions"] == 0
    assert response["coverage"]["states"] == {"UNKNOWN": 1}


def test_coverage_counts_one_internal_unknown_gap_not_a_phantom_tail():
    found = {
        "family": "trade",
        "selection": {"requested": {"from": str(BASE), "to": str(BASE + 200)},
                      "partitions": 2},
        "partitions": [
            {"event_ns_min": str(BASE), "event_ns_max": str(BASE + 5)},
            {"event_ns_min": str(BASE + 100), "event_ns_max": str(BASE + 199)},
        ],
    }

    coverage = asvc._coverage(found, served=None, corrupt=[], served_partitions=[])

    assert coverage["states"] == {"UNKNOWN": 1}


def test_the_served_window_never_extends_past_what_was_requested():
    # A candle spans a second (or a minute, hour, day) past its own key. The
    # gateway holds served inside requested and refused the page as a
    # contract violation whenever a window ended inside the last candle --
    # the real Node gateway test failed on exactly this from 2026-09-16.
    page = {"firstKey": (BASE, 0), "lastKey": (BASE + 3_000_000_000, 0)}
    requested = {"from": str(BASE - 5), "to": str(BASE + 3_000_000_100)}

    served = asvc._served_window(page, "candle", requested)

    assert served == {"from": str(BASE), "to": str(BASE + 3_000_000_100)}
    inside = asvc._served_window(page, "candle", {"from": str(BASE), "to": str(BASE + 10_000_000_000)})
    assert inside == {"from": str(BASE), "to": str(BASE + 4_000_000_000)}
    assert asvc._served_window(page, "trade", {"from": str(BASE + 7), "to": str(BASE + 3_000_000_001)}) == \
        {"from": str(BASE + 7), "to": str(BASE + 3_000_000_001)}
    assert asvc._served_window({"firstKey": None, "lastKey": None}, "candle", requested) is None


def test_a_window_ending_inside_the_last_candle_serves_a_span_inside_the_window(valid_family_rig):
    if valid_family_rig["family"] != "candle":
        return
    response = asvc.query(
        valid_family_rig["registry"], valid_family_rig["cache"], valid_family_rig["store"],
        valid_family_rig["connection"], instrument_id=IID, family="candle", from_ns=str(BASE),
        to_ns=str(BASE + 1000), curated_prefix=CURATED, limit=100)

    assert len(response["rows"]) == 1
    served = response["coverage"]["served"]
    assert int(served["from"]) >= BASE and int(served["to"]) <= BASE + 1000
    assert served == {"from": str(BASE), "to": str(BASE + 1000)}


def test_complete_minute_candle_days_do_not_be_described_as_unknown_gaps():
    minute = 60_000_000_000
    day = 24 * 60 * minute
    found = {
        "family": "candle_1m",
        "selection": {"requested": {"from": str(BASE), "to": str(BASE + 2 * day)},
                      "partitions": 2},
        "partitions": [
            {"event_ns_min": str(BASE), "event_ns_max": str(BASE + day - minute)},
            {"event_ns_min": str(BASE + day), "event_ns_max": str(BASE + 2 * day - minute)},
        ],
    }

    coverage = asvc._coverage(found, served={"from": str(BASE), "to": str(BASE + 2 * day)},
                               corrupt=[], served_partitions=found["partitions"])

    assert coverage["states"] == {"PUBLISHED": 2}


def test_an_actual_empty_service_response_obeys_the_wire_schema(rig):
    response = _query(rig, from_ns=str(BASE + 900_000), to_ns=str(BASE + 950_000))
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    jsonschema.validate(response, schema)


def _derived_minute_row(event_ns, **overrides):
    from test_archive_query_contract import _base_row

    row = _base_row(
        event_ns=str(event_ns), open_ns=str(event_ns), close_ns=str(event_ns + 60_000_000_000),
        volume="42.000000000000", buy_volume="23.000000000000", sell_volume="19.000000000000",
        undefined_volume="0.000000000000", buy_notional="577852.000000000000",
        sell_notional="477356.000000000000", trade_count="318", method="trade_minute/1")
    row.update(overrides)
    return row


def test_a_derived_family_serves_its_payload_and_not_the_identity_envelope(tmp_path):
    # The partition holds the full envelope on disk, as every family does. What
    # crosses the wire is the bucket alone: the request already named the
    # instrument and the catalog already vouched for the lineage, and the
    # envelope is about three quarters of the bytes of a row that exists to be
    # cheap to read over a slow link.
    client = FakeS3()
    manifests = [_publish(client, tmp_path, date="2025-09-01", family="trade_minute_1m",
                          rows=[_derived_minute_row(BASE + i * 60_000_000_000) for i in range(3)],
                          columns={**_COMMON_COLUMNS, **_FAMILY_COLUMNS["trade_minute"]})]
    root = _catalog(tmp_path, manifests)
    connection = ar.connect()
    cache = ac.PartCache(tmp_path / "cache", min_free_disk_bytes=0)
    try:
        response = asvc.query(
            ac.SnapshotRegistry(root), cache, s3_publish.Store(client, "bucket", CURATED), connection,
            instrument_id=IID, family="trade_minute_1m", from_ns=str(BASE),
            to_ns=str(BASE + 10 * 60_000_000_000), curated_prefix=CURATED, limit=100)
    finally:
        asvc.shutdown_readers(cache.root)
        connection.close()

    assert response["family"] == "trade_minute_1m"
    assert len(response["rows"]) == 3
    assert sorted(response["rows"][0]) == sorted(_aq.DERIVED_WIRE_FIELDS["trade_minute_1m"])
    assert response["rows"][0]["buy_notional"] == "577852.000000000000"
    jsonschema.validate(response, json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))


def test_a_cursor_inside_a_corrupt_partition_is_a_named_refusal(tmp_path):
    client = FakeS3()
    good = _publish(client, tmp_path, date="2025-09-01",
                    rows=[(BASE + i, 0, i, 0) for i in range(4)])
    bad = _publish(client, tmp_path, date="2025-09-02",
                   rows=[(BASE + 100 + i, 0, i, 0) for i in range(4)], corrupt=True)
    root = _catalog(tmp_path, [good, bad])
    connection = ar.connect()
    registry = ac.SnapshotRegistry(root)
    cache = ac.PartCache(tmp_path / "c", min_free_disk_bytes=0)
    store = s3_publish.Store(client, "bucket", CURATED)
    first = asvc.query(
        registry, cache, store, connection, instrument_id=IID, family="trade",
        from_ns=str(BASE), to_ns=str(BASE + 1000), curated_prefix=CURATED, limit=100)
    cursor = ar.encode_cursor(first["queryFingerprint"], first["pointer"]["catalog_sha256"],
                              (BASE + 100, 0, 0, 0))

    with pytest.raises(asvc.ArchiveQueryError) as raised:
        asvc.query(
            registry, cache, store, connection, instrument_id=IID, family="trade",
            from_ns=str(BASE), to_ns=str(BASE + 1000), curated_prefix=CURATED,
            pointer_token=first["pointerToken"], cursor=cursor, limit=100)
    connection.close()

    assert raised.value.code == ar.PARTITION_VERIFICATION_FAILED
    assert raised.value.detail["reason"] == "CURSOR_RESUME_PARTITION_CORRUPT"


def test_pins_are_released_even_when_the_read_fails(rig, monkeypatch):
    # A pin that outlives its request is invisible until the cache is full and
    # eviction can free nothing.
    def boom(*_a, **_k):
        raise RuntimeError("reader exploded")

    monkeypatch.setattr(asvc._reader_bridge.ReaderBridge, "read_page", boom)
    with pytest.raises(RuntimeError):
        _query(rig, limit=10)

    assert rig["cache"]._pinned() == set()


def test_the_service_defaults_to_an_isolated_worker(rig, monkeypatch):
    # The audit found this unwired: the service only ever called the in-process
    # reader, so D14's eight-concurrent-readers pass described a component the
    # query path did not use -- 101 ms measured for the worker against 800 ms
    # for the path that actually ran.
    import archive_reader_bridge as arb

    calls = []

    original = arb.ReaderBridge.read_page

    def spy(self, request, **kwargs):
        calls.append(request)
        return original(self, request, **kwargs)

    monkeypatch.setattr(arb.ReaderBridge, "read_page", spy)
    through_worker = _query(rig, limit=100)

    # Comparing results alone proves nothing: both paths return the same rows,
    # which is exactly why the service could ignore the reader entirely and look
    # correct. The page must actually have travelled through the worker.
    assert len(calls) == 1, "the query went beside the worker, not through it"
    assert len(through_worker["rows"]) == 12


def _spy_on_worker_pids(monkeypatch, pids):
    import archive_reader_bridge as arb

    original = arb.ReaderBridge.read_page

    def spy(self, request, **kwargs):
        pids.append(self._process.pid)
        return original(self, request, **kwargs)

    monkeypatch.setattr(arb.ReaderBridge, "read_page", spy)


def test_the_default_path_reuses_one_worker_across_queries(rig, monkeypatch):
    # Starting a worker per page measured 240.32 ms against 13.97 ms reused, and
    # only 4.17 ms of that gap was the protocol -- the rest was interpreter
    # start, `import duckdb`, mkdtemp and teardown, paid on every page. Comparing
    # rows would not catch it: a fresh worker returns the same rows, which is why
    # a correct-looking service was 17x slower than it needed to be.
    pids = []
    _spy_on_worker_pids(monkeypatch, pids)

    _query(rig, limit=100)
    _query(rig, limit=100)

    assert len(pids) == 2
    assert pids[0] == pids[1], "the second page started a second interpreter"


def test_a_worker_that_died_while_idle_is_replaced_not_handed_back(rig, monkeypatch):
    # `start()` returns early when `_process` is set, so an idle worker that died
    # between requests would be handed straight back and fail the next read. The
    # pool must check liveness on the way out, not only on the way in.
    pids = []
    _spy_on_worker_pids(monkeypatch, pids)

    _query(rig, limit=100)

    idle = asvc.reader_pool(rig["cache"].root)._idle[0]
    idle._process.kill()
    idle._process.wait(5)

    response = _query(rig, limit=100)

    assert len(response["rows"]) == 12
    assert pids[0] != pids[1], "a dead worker was handed back to the next query"


def test_the_pool_is_sized_to_the_admission_cap(rig):
    # Two independent limits on the same thing drift. The number of reader
    # processes and the number of admitted readers are one number.
    import archive_admission as aa

    assert asvc.reader_pool(rig["cache"].root).size == aa.MAX_CONCURRENT_READS


def test_the_service_is_bounded_by_admission_when_one_is_given(rig):
    import archive_admission as aa

    admission = aa.Admission(max_concurrent=1, max_queued=0)
    held = admission.acquire("other-client")

    with pytest.raises(aa.ArchiveQueryError) as raised:
        _query(rig, limit=10, admission=admission, client="me")

    assert raised.value.code == aa.OVERLOADED
    held.release()


def test_the_service_default_cannot_bypass_admission(rig, monkeypatch):
    import archive_admission as aa

    admission = aa.Admission(max_concurrent=1, max_queued=0)
    held = admission.acquire("other-client")
    monkeypatch.setattr(asvc, "_DEFAULT_ADMISSION", admission)

    with pytest.raises(aa.ArchiveQueryError) as raised:
        _query(rig, limit=10, client="me")

    assert raised.value.code == aa.OVERLOADED
    held.release()


def test_an_admitted_query_frees_its_slot_on_success_and_on_failure(rig, monkeypatch):
    import archive_admission as aa

    admission = aa.Admission(max_concurrent=1, max_queued=0)
    _query(rig, limit=10, admission=admission, client="me")
    assert admission.in_flight == 0, "a completed query releases its slot"

    monkeypatch.setattr(asvc._reader_bridge.ReaderBridge, "read_page", lambda *a, **k: 1 / 0)
    with pytest.raises(ZeroDivisionError):
        _query(rig, limit=10, admission=admission, client="me")
    assert admission.in_flight == 0, "a failed query releases its slot too"


def test_a_cancelled_query_stops_before_it_reads_and_releases_everything(rig):
    # AC: "cancellation releases work and resources". A cancelled query must not
    # hold a reader slot or a cache pin.
    import archive_admission as aa

    admission = aa.Admission(max_concurrent=1, max_queued=0)
    original = aa.Admission.acquire

    def cancel_on_acquire(self, client, *, token=None):
        slot = original(self, client, token=token)
        slot.token.cancel()
        return slot

    aa.Admission.acquire = cancel_on_acquire
    try:
        with pytest.raises(aa.ArchiveQueryError) as raised:
            _query(rig, limit=10, admission=admission, client="me")
    finally:
        aa.Admission.acquire = original

    assert raised.value.code == aa.CANCELLED
    assert admission.in_flight == 0
    assert rig["cache"]._pinned() == set()


def test_a_cursor_from_another_query_is_refused_by_the_service(rig):
    other = ar.encode_cursor(
        ar.query_fingerprint(pointer_sha256="c" * 64, instrument_id=IID, family="quote",
                             from_ns=str(BASE), to_ns=str(BASE + 1000), client="anonymous"),
        "c" * 64, (BASE, 0, 1, 0))

    with pytest.raises(asvc.ArchiveQueryError) as raised:
        _query(rig, cursor=other)

    assert raised.value.code == ar.CURSOR_POINTER_MISMATCH


def test_catalog_correction_switch_preserves_pins_and_refuses_cross_version_cursors(tmp_path):
    client = FakeS3()
    a_dir, b_dir = tmp_path / "a", tmp_path / "b"
    a_dir.mkdir(); b_dir.mkdir()
    manifest_a = _publish(client, a_dir, date="2025-09-01", version="v1",
                          rows=[(BASE + i, 0, i, 0) for i in range(3)])
    manifest_b = _publish(client, b_dir, date="2025-09-01", version="v2",
                          rows=[(BASE + 100 + i, 0, i, 0) for i in range(3)])
    root_a = _catalog(a_dir, [manifest_a])
    root_b = _catalog(b_dir, [manifest_b])
    live_root = tmp_path / "live-catalog"
    _install_catalog(root_a, live_root)
    registry = ac.SnapshotRegistry(str(live_root))
    cache = ac.PartCache(tmp_path / "cache", min_free_disk_bytes=0)
    store = s3_publish.Store(client, "bucket", CURATED)
    connection = ar.connect()
    try:
        args = dict(registry=registry, cache=cache, store=store, connection=connection,
                    instrument_id=IID, family="trade", from_ns=str(BASE),
                    to_ns=str(BASE + 1000), curated_prefix=CURATED, client="correction-test")
        page_a = asvc.query(**args, limit=1)
        pinned_a = asvc.query(**args, pointer_token=page_a["pointerToken"], limit=100)

        _install_catalog(root_b, live_root)
        page_b = asvc.query(**args, limit=100)
        pinned_a_after_switch = asvc.query(
            **args, pointer_token=page_a["pointerToken"], limit=100)

        assert pinned_a_after_switch["rows"] == pinned_a["rows"]
        assert page_b["rows"] != pinned_a["rows"]
        assert page_b["pointerToken"] != page_a["pointerToken"]
        with pytest.raises(asvc.ArchiveQueryError) as raised:
            asvc.query(**args, pointer_token=page_b["pointerToken"],
                       cursor=page_a["nextCursor"], limit=100)
        assert raised.value.code == ar.CURSOR_POINTER_MISMATCH
    finally:
        asvc.shutdown_readers(cache.root)
        connection.close()


def test_catalog_with_two_authorities_for_one_date_is_refused(tmp_path):
    client = FakeS3()
    manifests = [
        _publish(client, tmp_path, date="2025-09-01", version="v1",
                 rows=[(BASE, 0, 0, 0)]),
        _publish(client, tmp_path, date="2025-09-01", version="v2",
                 rows=[(BASE + 1, 0, 1, 0)]),
    ]
    root = _catalog(tmp_path, manifests)
    connection = ar.connect()
    cache = ac.PartCache(tmp_path / "cache", min_free_disk_bytes=0)
    try:
        with pytest.raises(asvc.ArchiveQueryError) as raised:
            asvc.query(ac.SnapshotRegistry(root), cache,
                       s3_publish.Store(client, "bucket", CURATED), connection,
                       instrument_id=IID, family="trade", from_ns=str(BASE),
                       to_ns=str(BASE + 1000), curated_prefix=CURATED, limit=100)
        assert raised.value.code == _aq.CATALOG_INTEGRITY_FAILURE
        assert raised.value.detail["reason"] == "DATE_IN_MULTIPLE_DATASET_VERSIONS"
    finally:
        asvc.shutdown_readers(cache.root)
        connection.close()


def test_a_legacy_candle_partition_reports_the_new_fields_as_unknown(tmp_path):
    """Every candle partition published so far was written before the Binance
    flow metrics existed, so its parquet has no such columns and a row is built
    from the columns its own file carries. The contract declares them
    required-and-nullable: absent would leave a consumer computing on undefined,
    which is how the trade_count NaN in the live resampler happens."""
    from test_archive_query_contract import _candle_row
    import archive_query as _aq

    legacy = _candle_row(event_ns=str(BASE))
    for field in _aq.CANDLE_SOURCE_METRIC_FIELDS:
        legacy.pop(field, None)

    client = FakeS3()
    legacy_columns = {**_COMMON_COLUMNS, **{k: v for k, v in _FAMILY_COLUMNS["candle"].items()
                                              if k not in _aq.CANDLE_SOURCE_METRIC_FIELDS}}
    manifests = [_publish(client, tmp_path, date="2025-09-01", rows=[legacy], family="candle",
                          columns=legacy_columns)]
    root = _catalog(tmp_path, manifests)
    connection = ar.connect()
    try:
        rig = {"registry": ac.SnapshotRegistry(root),
               "cache": ac.PartCache(tmp_path / "cache", min_free_disk_bytes=0),
               "store": s3_publish.Store(client, "bucket", CURATED),
               "connection": connection}
        page = _query(rig, family="candle")
        assert page["rows"], "expected the legacy partition to serve a row"
        row = page["rows"][0]
        for field in _aq.CANDLE_SOURCE_METRIC_FIELDS:
            assert field in row, f"{field} absent, not unknown"
            assert row[field] is None, field
        assert row["volume"] is not None
    finally:
        connection.close()


def test_a_page_crossing_legacy_and_new_candles_keeps_the_new_metrics(tmp_path):
    from test_archive_query_contract import _candle_row
    import archive_query as _aq

    client = FakeS3()
    legacy = _candle_row(event_ns=str(BASE))
    for field in _aq.CANDLE_SOURCE_METRIC_FIELDS:
        legacy.pop(field, None)
    legacy_columns = {**_COMMON_COLUMNS, **{name: kind for name, kind in _FAMILY_COLUMNS["candle"].items()
                                              if name not in _aq.CANDLE_SOURCE_METRIC_FIELDS}}
    current = _candle_row(event_ns=str(BASE + 100), quote_volume="1050.000000000000",
                          taker_buy_quote_volume="630.000000000000",
                          taker_sell_base_volume="4.000000000000",
                          taker_sell_quote_volume="420.000000000000", trade_count="37")
    manifests = [
        _publish(client, tmp_path, date="2025-09-01", rows=[legacy], family="candle", columns=legacy_columns),
        _publish(client, tmp_path, date="2025-09-02", rows=[current], family="candle"),
    ]
    root = _catalog(tmp_path, manifests)
    connection = ar.connect()
    try:
        rig = {"registry": ac.SnapshotRegistry(root),
               "cache": ac.PartCache(tmp_path / "cache", min_free_disk_bytes=0),
               "store": s3_publish.Store(client, "bucket", CURATED), "connection": connection}
        rows = _query(rig, family="candle", limit=10)["rows"]
    finally:
        connection.close()

    assert rows[0]["trade_count"] is None
    assert rows[1]["quote_volume"] == "1050.000000000000"
    assert rows[1]["trade_count"] == "37"
