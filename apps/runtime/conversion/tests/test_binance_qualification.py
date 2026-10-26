from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import zipfile

import pytest

import binance_qualification as qualification
import convert
import s3_publish


class S3Error(Exception):
    def __init__(self, status):
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}}


class FakeS3:
    def __init__(self):
        self.objects = {}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise S3Error(404)
        return {"Body": io.BytesIO(self.objects[Key]), "ETag": '"fixture"'}

    def put_object(self, **kwargs):
        key = kwargs["Key"]
        if kwargs.get("IfNoneMatch") == "*" and key in self.objects:
            raise S3Error(412)
        body = kwargs["Body"]
        data = body.read() if hasattr(body, "read") else body
        assert len(data) == kwargs["ContentLength"]
        self.objects[key] = data

    def list_objects_v2(self, *, Bucket, Prefix, MaxKeys):
        found = [key for key in self.objects if key.startswith(Prefix)][:MaxKeys]
        return {"KeyCount": len(found), "Contents": [{"Key": key} for key in found]}


class Opener:
    def __init__(self, responses):
        self.responses = responses
        self.urls = []

    def __call__(self, request, timeout):
        self.urls.append(request.full_url)
        return io.BytesIO(self.responses[request.full_url])


def _month_zip(year=2025, month=9):
    start = dt.datetime(year, month, 1, tzinfo=dt.timezone.utc)
    if month == 12:
        end = dt.datetime(year + 1, 1, 1, tzinfo=dt.timezone.utc)
    else:
        end = dt.datetime(year, month + 1, 1, tzinfo=dt.timezone.utc)
    start_ms = int(start.timestamp() * 1000)
    count = int((end - start).total_seconds() // 60)
    rows = "\n".join(
        f"{start_ms + index * 60000},1,1,1,1,1,{start_ms + index * 60000 + 59999},1,1,1,1,0"
        for index in range(count)
    ) + "\n"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("BTCUSDT-1m-2025-09.csv", rows)
    return buffer.getvalue(), count


def _source():
    source = qualification.inventory()[0]
    assert source["product"] == "spot" and source["symbol"] == "BTCUSDT" and source["month"] == "2025-09"
    return source


def _receipt(source, sha256, *, retrieved_at="2026-09-15T00:00:00+00:00"):
    key = qualification.raw_key(source, sha256)
    return {
        "receipt_version": "binance-raw/1", "product": source["product"], "dataset": source["dataset"],
        "symbol": source["symbol"], "schema": source["schema"], "month": source["month"],
        "source_url": source["url"], "checksum_url": source["checksum_url"],
        "checksum_text": f"{sha256}  {source['filename']}\n", "retrieved_at": retrieved_at,
        "raw_s3_key": key, "raw_sha256": sha256, "raw_bytes": 1,
        "zip_member": source["filename"].removesuffix(".zip") + ".csv", "validated_rows": 1,
    }


def test_the_fixed_scope_is_exactly_four_permanent_instruments_by_twelve_months():
    sources = qualification.inventory()
    # Four instruments x twelve months x three rungs. Binance publishes 1m, 1h
    # and 1d as separate monthly objects, so every rung is fetched rather than
    # derived -- a derived rung would put this runner's own arithmetic under
    # test instead of the delivered data.
    assert len(sources) == 144
    assert {s["interval"] for s in sources} == {"1m", "1h", "1d"}
    assert {s["family"] for s in sources} == {"candle_1m", "candle_1h", "candle_1d"}
    assert len({qualification.raw_key(s, "a" * 64) for s in sources}) == 144
    assert {(s["product"], s["dataset"], s["symbol"]) for s in sources} == {
        ("spot", "BINANCE.SPOT", "BTCUSDT"),
        ("spot", "BINANCE.SPOT", "ETHUSDT"),
        ("um", "BINANCE.UM", "BTCUSDT"),
        ("um", "BINANCE.UM", "ETHUSDT"),
    }
    assert {(s["month"]) for s in sources} == {f"2025-{month:02d}" for month in range(9, 13)} | {
        f"2026-{month:02d}" for month in range(1, 9)
    }
    assert all(s["url"].startswith(qualification.SOURCE_BASE + "/") and s["checksum_url"] == s["url"] + ".CHECKSUM"
               for s in sources)


def test_a_verified_source_is_immutable_checksum_addressed_and_receipted(tmp_path):
    source = _source()
    payload, count = _month_zip()
    sha256 = hashlib.sha256(payload).hexdigest()
    opener = Opener({
        source["checksum_url"]: f"{sha256}  {source['filename']}\n".encode(),
        source["url"]: payload,
    })
    client = FakeS3()
    spec = qualification.acquire(
        source, tmp_path / "raw", qualification.RawStore(client, "bucket"), opener=opener,
        now=dt.datetime(2026, 9, 15, tzinfo=dt.timezone.utc),
    )

    expected_key = f"raw/binance/spot/BTCUSDT/1m/2025-09/{sha256}.zip"
    assert spec["s3_key"] == expected_key
    assert spec["expected_sha256"] == sha256
    assert spec["source_receipt_key"] == expected_key + ".receipt.json"
    assert client.objects[expected_key] == payload
    receipt = __import__("json").loads(client.objects[spec["source_receipt_key"]])
    assert receipt["checksum_text"] == f"{sha256}  {source['filename']}\n"
    assert receipt["zip_member"] == "BTCUSDT-1m-2025-09.csv"
    assert receipt["validated_rows"] == count
    assert receipt["raw_sha256"] == sha256


def test_an_changed_download_cannot_leave_a_raw_object_or_partial_file(tmp_path):
    source = _source()
    expected, _count = _month_zip()
    actual = expected + b"changed"
    sha256 = hashlib.sha256(expected).hexdigest()
    opener = Opener({
        source["checksum_url"]: f"{sha256}  {source['filename']}\n".encode(),
        source["url"]: actual,
    })
    client = FakeS3()

    with pytest.raises(qualification.BinanceQualificationError, match="BINANCE_DOWNLOAD_SHA256_MISMATCH"):
        qualification.acquire(source, tmp_path / "raw", qualification.RawStore(client, "bucket"), opener=opener)

    assert client.objects == {}
    assert not list((tmp_path / "raw").rglob("*.partial"))


def test_a_receipt_retry_reuses_only_the_same_verified_candidate(tmp_path):
    source = _source()
    payload, _count = _month_zip()
    sha256 = hashlib.sha256(payload).hexdigest()
    opener = Opener({
        source["checksum_url"]: f"{sha256}  {source['filename']}\n".encode(),
        source["url"]: payload,
    })
    store = qualification.RawStore(FakeS3(), "bucket")
    first = qualification.acquire(source, tmp_path / "raw", store, opener=opener,
                                  now=dt.datetime(2026, 9, 15, tzinfo=dt.timezone.utc))
    second = qualification.acquire(source, tmp_path / "raw", store, opener=opener,
                                   now=dt.datetime(2026, 9, 16, tzinfo=dt.timezone.utc))

    assert second["s3_key"] == first["s3_key"]
    assert second["source_delivered_at"] == first["source_delivered_at"]


def test_a_receipt_race_accepts_only_the_same_immutable_receipt():
    source, sha256 = _source(), "a" * 64
    key = qualification.receipt_key(qualification.raw_key(source, sha256))
    first = _receipt(source, sha256, retrieved_at="2026-09-15T00:00:00+00:00")
    winner = _receipt(source, sha256, retrieved_at="2026-09-14T00:00:00+00:00")

    class RacingS3(FakeS3):
        def put_object(self, **kwargs):
            if kwargs["Key"] == key:
                self.objects[key] = __import__("json").dumps(winner).encode()
                raise S3Error(412)
            return super().put_object(**kwargs)

    assert qualification.RawStore(RacingS3(), "bucket").put_receipt(key, first) == winner


def test_a_raw_receipt_cannot_describe_a_different_checksum_addressed_object():
    source, sha256 = _source(), "a" * 64
    key = qualification.receipt_key(qualification.raw_key(source, sha256))
    value = _receipt(source, sha256)
    value["raw_sha256"] = "b" * 64
    with pytest.raises(qualification.BinanceQualificationError, match="INVALID_RAW_RECEIPT"):
        qualification.RawStore(FakeS3(), "bucket").put_receipt(key, value)


def test_raw_storage_cannot_be_repurposed_for_an_unplanned_symbol(tmp_path):
    path = tmp_path / "candidate.zip"
    path.write_bytes(b"x")
    key = "raw/binance/spot/UNPLANNED/1m/2025-09/" + "a" * 64 + ".zip"
    with pytest.raises(qualification.BinanceQualificationError, match="RAW_OBJECT_KEY_OUTSIDE_BINANCE"):
        qualification.RawStore(FakeS3(), "bucket").put_file(key, path, "a" * 64)


def test_acquisition_is_confined_to_the_fixed_source_inventory(tmp_path):
    source = dict(_source(), url="https://unexpected.invalid/file.zip")
    with pytest.raises(qualification.BinanceQualificationError, match="BINANCE_SOURCE_IDENTITY_MISMATCH"):
        qualification.acquire(source, tmp_path / "raw", qualification.RawStore(FakeS3(), "bucket"))


def test_a_checksum_document_must_name_the_requested_archive():
    with pytest.raises(qualification.BinanceQualificationError, match="BINANCE_CHECKSUM_IDENTITY_MISMATCH"):
        qualification.parse_checksum(b"a" * 64 + b"  ETHUSDT-1m-2025-09.zip\n", "BTCUSDT-1m-2025-09.zip")


def test_source_reconciliation_counts_and_digests_each_grid_validated_bar(tmp_path):
    source = _source()
    payload, count = _month_zip()
    path = tmp_path / "source.zip"
    path.write_bytes(payload)
    sha256 = hashlib.sha256(payload).hexdigest()
    spec = {
        "source_path": str(path), "schema": source["schema"], "dataset": source["dataset"],
        "symbol": source["symbol"], "s3_key": qualification.raw_key(source, sha256),
        "expected_sha256": sha256, "source_delivered_at": "2026-09-15T00:00:00+00:00",
        "source_receipt_key": qualification.receipt_key(qualification.raw_key(source, sha256)),
    }

    states = qualification.source_reconciliation([spec], "qual-v1")

    assert len(states) == 1
    state = next(iter(states.values()))
    assert state["rows"] == count
    assert len(state["days"]) == 30
    assert len(state["digest"]) == 64


def test_a6_refuses_a_nonempty_qualification_namespace_before_acquisition(tmp_path, monkeypatch):
    class Store:
        bucket = "bucket"
        prefix = qualification.qualification_prefix("r1")
        client = FakeS3()

        def get_json(self, _key):
            return {"already": "published"}, "etag"

    called = []
    monkeypatch.setattr(qualification, "verify_node", lambda *_args: "24.21.0")
    with pytest.raises(qualification.BinanceQualificationError, match="QUALIFICATION_NAMESPACE_NOT_FRESH"):
        qualification.run(
            run_id="r1", dataset_version="qual-v1", work_root=tmp_path / "work", raw_store=Store(),
            qualification_store=Store(), node_bin="node", repository_root=tmp_path,
            acquire_fn=lambda *_args: called.append(True),
        )
    assert called == []


def test_a6_refuses_orphaned_objects_in_an_otherwise_pointerless_namespace(tmp_path, monkeypatch):
    class Store:
        bucket = "bucket"
        prefix = qualification.qualification_prefix("r1")
        client = FakeS3()

        def get_json(self, _key):
            return None, None

    Store.client.objects[Store.prefix + "/orphan"] = b"previous-run"
    monkeypatch.setattr(qualification, "verify_node", lambda *_args: "24.21.0")
    with pytest.raises(qualification.BinanceQualificationError, match="QUALIFICATION_NAMESPACE_NOT_EMPTY"):
        qualification.run(
            run_id="r1", dataset_version="qual-v1", work_root=tmp_path / "work", raw_store=Store(),
            qualification_store=Store(), node_bin="node", repository_root=tmp_path,
            acquire_fn=lambda *_args: pytest.fail("acquisition must not start"),
        )


def test_a6_orchestrates_only_the_fixed_scope_and_leaves_reviewable_evidence(tmp_path, monkeypatch):
    class Store:
        bucket = "bucket"
        prefix = qualification.qualification_prefix("r1")
        client = FakeS3()

        def get_json(self, _key):
            return None, None

    store, acquired, converted, published, snapshotted, read = Store(), [], [], [], [], []

    def acquire_one(source, raw_root, _raw_store, *, archive_raw=True):
        sha = hashlib.sha256(source["url"].encode()).hexdigest()
        result = {
            "source_path": str(raw_root / (sha + ".zip")), "schema": source["schema"],
            "dataset": source["dataset"], "symbol": source["symbol"],
            "s3_key": qualification.raw_key(source, sha), "expected_sha256": sha,
            "source_delivered_at": "2026-09-15T00:00:00+00:00",
            "source_receipt_key": qualification.receipt_key(qualification.raw_key(source, sha)),
        }
        acquired.append((source, result))
        return result

    # Four instruments across three rungs. Every rung spans every day of the
    # scope, so the day census is identical and only the bar count differs:
    # 1,440 minute bars, 24 hourly bars or one daily bar per UTC day.
    expected = {
        (f"instrument-{index}", family): {
            "rows": 365 * per_day, "expected_rows": 365 * per_day, "days": set(range(365)),
            "first_ns": index, "last_ns": index + 1, "interval_ns": interval_ns,
            "digest": "a" * 64,
        }
        for index in range(4)
        for family, interval_ns, per_day in (
            ("candle_1m", 60_000_000_000, 1440),
            ("candle_1h", 3_600_000_000_000, 24),
            ("candle_1d", 86_400_000_000_000, 1),
        )
    }
    pointer = {"catalog_key": "catalog.sqlite", "catalog_sha256": "b" * 64, "dataset_version": "qual-v1"}

    def convert_all(sources, _version, **kwargs):
        converted.append((sources, kwargs))
        accepted = sum(state["rows"] for state in expected.values())
        partitions = sum(len(state["days"]) for state in expected.values())
        return {"accepted": accepted, "rejected": 0,
                "partitions": [str(n) for n in range(partitions)],
                "catalog_pointer": pointer}

    def publish_all(_store, _root, received_pointer, *, expected_parent):
        published.append((received_pointer, expected_parent))
        return {"status": "PUBLISHED"}

    def reader_reconciliation_all(*args, **kwargs):
        read.append(kwargs.get("cache_min_free_disk_bytes"))
        return {"instruments": {}}

    monkeypatch.setattr(qualification, "verify_node", lambda *_args: "24.21.0")
    result = qualification.run(
        run_id="r1", dataset_version="qual-v1", work_root=tmp_path / "work", raw_store=store,
        qualification_store=store, node_bin="node", repository_root=tmp_path, acquire_fn=acquire_one,
        convert_fn=convert_all, publish_fn=publish_all, source_reconciliation_fn=lambda *_args: expected,
        snapshot_fn=lambda *_args: snapshotted.append(True) or {"catalog_bytes": 1},
        reader_reconciliation_fn=reader_reconciliation_all,
        reader_cache_min_free_disk_bytes=12345,
    )

    assert len(acquired) == 144
    assert converted and len(converted[0][0]) == 144
    assert published == [(pointer, None)]
    assert snapshotted == [True] and read == [12345]
    assert result["status"] == "PASS"
    assert json.loads((tmp_path / "work" / "evidence.json").read_text())["status"] == "PASS"


def test_a6_requires_an_explicit_qualification_dataset_version(tmp_path):
    with pytest.raises(qualification.BinanceQualificationError, match="QUALIFICATION_DATASET_VERSION_REQUIRED"):
        qualification.run(
            run_id="r1", dataset_version="w606-binance-v1", work_root=tmp_path / "work",
            raw_store=object(), qualification_store=object(), node_bin="node", repository_root=tmp_path,
        )


def test_a6_rejects_an_acquisition_result_substituted_from_another_month():
    source, other = _source(), qualification.inventory()[1]
    sha256 = "a" * 64
    acquired = {
        "source_path": "candidate.zip", "schema": source["schema"], "dataset": source["dataset"],
        "symbol": source["symbol"], "s3_key": qualification.raw_key(other, sha256),
        "expected_sha256": sha256, "source_delivered_at": "2026-09-15T00:00:00+00:00",
        "source_receipt_key": qualification.receipt_key(qualification.raw_key(other, sha256)),
    }
    with pytest.raises(qualification.BinanceQualificationError, match="QUALIFICATION_ACQUISITION_IDENTITY_MISMATCH"):
        qualification._validate_acquired_sources([acquired], [source])


def test_a6_cli_builds_separate_raw_and_qualification_clients(monkeypatch, tmp_path):
    raw_client, qualification_client = FakeS3(), FakeS3()
    clients = iter((raw_client, qualification_client))
    captured = {}
    monkeypatch.setattr(qualification, "_s3_client_from_environment", lambda _prefix: next(clients))

    def run_stub(**kwargs):
        captured.update(kwargs)
        return {"status": "PASS"}

    monkeypatch.setattr(qualification, "run", run_stub)
    assert qualification.main([
        "--run-id", "r1", "--dataset-version", "qual-v1", "--work-root", str(tmp_path / "work"),
        "--bucket", "bucket", "--node-bin", "node", "--repository-root", str(tmp_path),
    ]) == 0
    assert captured["raw_store"].client is raw_client
    assert captured["qualification_store"].client is qualification_client
    assert captured["qualification_store"].prefix == qualification.qualification_prefix("r1")


def test_reader_response_check_rejects_a_missing_required_candle_field():
    from test_archive_query_contract import _candle_row, _response

    valid = _response("candle_1m", [_candle_row()])
    qualification._assert_candle_response(valid, qualification._candle_contract_shape(), "candle_1m")
    invalid = _response("candle_1m", [_candle_row()])
    invalid["rows"][0].pop("trade_count")
    with pytest.raises(qualification.BinanceQualificationError, match="QUALIFICATION_READER_ROW_SHAPE_MISMATCH"):
        qualification._assert_candle_response(invalid, qualification._candle_contract_shape(), "candle_1m")


def test_reader_response_check_refuses_an_out_of_range_unsigned_wire_value():
    from test_archive_query_contract import _candle_row, _response

    invalid = _response("candle_1m", [_candle_row(stable_position="18446744073709551616")])
    with pytest.raises(qualification.BinanceQualificationError, match="QUALIFICATION_READER_ROW_VALUE_MISMATCH"):
        qualification._assert_candle_response(invalid, qualification._candle_contract_shape(), "candle_1m")


def test_a_complete_month_survives_the_real_conversion_publication_and_reader_path(tmp_path):
    source = _source()
    payload, count = _month_zip()
    sha256 = hashlib.sha256(payload).hexdigest()
    opener = Opener({
        source["checksum_url"]: f"{sha256}  {source['filename']}\n".encode(),
        source["url"]: payload,
    })
    client = FakeS3()
    raw = qualification.RawStore(client, "bucket")
    acquired = qualification.acquire(source, tmp_path / "raw", raw, opener=opener,
                                     now=dt.datetime(2026, 9, 15, tzinfo=dt.timezone.utc))
    expected = qualification.source_reconciliation([acquired], "qual-v1")
    roots = {
        "staging_root": str(tmp_path / "stage"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }
    conversion = convert.convert_files([acquired], "qual-v1", **roots)
    assert conversion["accepted"] == count and conversion["rejected"] == 0
    assert len(conversion["partitions"]) == 30

    # Production always writes through a provider-scoped prefix (e.g.
    # "curated/binance") and reads through the bare root (e.g. "curated"),
    # relying on partition_relative() to add the provider segment on the
    # read side only. This mirrors that split rather than reusing one
    # store for both, which would either miss the doubled real-bucket path
    # (pre-fix) or double it a second time (naive same-store fix).
    write_store = s3_publish.Store(client, "bucket", "curated/_qualification/month/binance")
    read_store = s3_publish.Store(client, "bucket", "curated/_qualification/month")
    publication = s3_publish.publish(write_store, tmp_path / "curated", conversion["catalog_pointer"],
                                     expected_parent=None)
    assert publication["status"] == "PUBLISHED"
    snapshot = qualification._remote_catalog_snapshot(write_store, conversion["catalog_pointer"],
                                                       tmp_path / "readback" / "_catalog")
    assert snapshot["catalog_sha256"] == conversion["catalog_pointer"]["catalog_sha256"]
    readback = qualification.reader_reconciliation(
        conversion["catalog_pointer"], tmp_path / "readback" / "_catalog", tmp_path / "cache", read_store, expected,
        cache_min_free_disk_bytes=0)
    assert next(iter(readback["instruments"].values()))["rows"] == count


def _rung_zip(source):
    """One complete UTC month of whichever rung this source names."""
    step_ms = source["interval_ns"] // 1_000_000
    start_ms = source["start_ns"] // 1_000_000
    count = (source["end_ns"] - source["start_ns"]) // source["interval_ns"]
    rows = "\n".join(
        f"{start_ms + index * step_ms},1,1,1,1,1,{start_ms + index * step_ms + step_ms - 1},1,1,1,1,0"
        for index in range(count)
    ) + "\n"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(source["filename"].removesuffix(".zip") + ".csv", rows)
    return buffer.getvalue(), count


@pytest.mark.parametrize("interval,per_day", [("1m", 1440), ("1h", 24), ("1d", 1)])
def test_the_expected_census_is_derived_from_the_rung_not_a_constant(tmp_path, interval, per_day):
    """The census a PASS is judged against must come from the month and the
    interval. A constant is right only for the window it was written against:
    525,600 is a minute-rung, 365-day number and says nothing about an hourly
    rung, a daily rung, a leap February, or a 31-day month.
    """
    source = next(s for s in qualification.inventory()
                  if s["interval"] == interval and s["month"] == "2025-09"
                  and s["product"] == "spot" and s["symbol"] == "BTCUSDT")
    payload, count = _rung_zip(source)
    assert count == 30 * per_day

    path = tmp_path / source["filename"]
    path.write_bytes(payload)
    sha256 = hashlib.sha256(payload).hexdigest()
    spec = {
        "source_path": str(path), "schema": source["schema"], "dataset": source["dataset"],
        "symbol": source["symbol"], "s3_key": qualification.raw_key(source, sha256),
        "expected_sha256": sha256, "source_delivered_at": "2026-09-15T00:00:00+00:00",
        "source_receipt_key": qualification.receipt_key(qualification.raw_key(source, sha256)),
    }

    states = qualification.source_reconciliation([spec], "qual-v1")
    (instrument_id, family), state = next(iter(states.items()))

    assert family == source["family"]
    assert state["rows"] == count
    assert state["expected_rows"] == count, "the census must match what the month actually holds"
    assert len(state["days"]) == 30


def test_the_derived_census_tracks_month_length_and_leap_years():
    """The two cases a hardcoded 525,600 / 365 gets wrong."""
    february_2024 = qualification.inventory((2024, 2), (2024, 2))
    february_2026 = qualification.inventory((2026, 2), (2026, 2))
    january = qualification.inventory((2025, 1), (2025, 1))

    per_day = {"1m": 1440, "1h": 24, "1d": 1}
    for label, plan, days in (("leap", february_2024, 29), ("non-leap", february_2026, 28),
                              ("31-day", january, 31)):
        assert qualification._scope_days(plan) == days, label
        for source in plan:
            assert qualification.expected_bars(source) == days * per_day[source["interval"]], (
                label, source["interval"])
    assert qualification._scope_days(qualification.inventory((2024, 1), (2024, 12))) == 366


def test_reconciliation_orders_many_rungs_of_one_month_without_comparing_sources(tmp_path):
    """Three rungs share a product and month, so the reader order cannot be keyed
    on (dataset, symbol, start) alone -- ties fall through to comparing the raw
    source dicts, which raises. The family makes the order total."""
    specs = []
    for interval in ("1m", "1h", "1d"):
        source = next(s for s in qualification.inventory()
                      if s["interval"] == interval and s["month"] == "2025-09"
                      and s["product"] == "spot" and s["symbol"] == "BTCUSDT")
        payload, _count = _rung_zip(source)
        path = tmp_path / source["filename"]
        path.write_bytes(payload)
        sha256 = hashlib.sha256(payload).hexdigest()
        specs.append({
            "source_path": str(path), "schema": source["schema"], "dataset": source["dataset"],
            "symbol": source["symbol"], "s3_key": qualification.raw_key(source, sha256),
            "expected_sha256": sha256, "source_delivered_at": "2026-09-15T00:00:00+00:00",
            "source_receipt_key": qualification.receipt_key(qualification.raw_key(source, sha256)),
        })

    states = qualification.source_reconciliation(specs, "qual-v1")

    assert {family for _instrument, family in states} == {"candle_1m", "candle_1h", "candle_1d"}
    for (_instrument, _family), state in states.items():
        assert state["rows"] == state["expected_rows"]
        assert len(state["days"]) == 30
