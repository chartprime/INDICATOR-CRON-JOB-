from __future__ import annotations

import json
import sqlite3
import io
import hashlib
from contextlib import redirect_stdout

import pytest

import catalog
import checkpoint
import s3_publish
import coverage_report as cr
import coverage_report_cli

_STATUS_HEADER = ",".join(cr._STATUS_COLUMNS)
_STATISTICS_HEADER = ",".join(cr._STATISTICS_COLUMNS)
_DAY_NS = 86_400_000_000_000
_EPOCH_2025_09_02 = 1_756_771_200_000_000_000


def _ns(date):
    import datetime as dt
    day = dt.date.fromisoformat(date)
    return int(dt.datetime(day.year, day.month, day.day, 15, tzinfo=dt.timezone.utc).timestamp() * 1e9)


def _status_file(root, symbol, dates, instrument_id="38", trading=True):
    path = root / "status" / f"dataset=XNAS.ITCH" / "schema=status" / f"symbol={symbol}" / "year=2025" / "month=09"
    path.mkdir(parents=True, exist_ok=True)
    lines = [_STATUS_HEADER]
    for date in dates:
        lines.append(",".join([
            str(_ns(date)), str(_ns(date)), "18", "2", instrument_id, "1", "0", "0",
            "Y" if trading else "N", "Y" if trading else "N", "N",
        ]))
    (path / "x.status.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _statistics_file(root, symbol, rows, instrument_id="38"):
    path = root / "statistics" / "dataset=XNAS.ITCH" / "schema=statistics" / f"symbol={symbol}" / "year=2025" / "month=09"
    path.mkdir(parents=True, exist_ok=True)
    lines = [_STATISTICS_HEADER]
    for date, stat_type, price in rows:
        lines.append(",".join([
            str(_ns(date)), str(_ns(date)), "24", "2", instrument_id, cr.UNDEFINED_INT64,
            price, "100", "1", "0", stat_type, "0", "1", "0",
        ]))
    (path / "x.statistics.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _manifest_bytes(manifest):
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()


def _manifest_sha(manifest):
    return hashlib.sha256(_manifest_bytes(manifest)).hexdigest()


def _catalog_with(tmp_path, partitions, version="v1", manifest_sha256="b" * 64):
    root = tmp_path / "curated" / "_catalog"
    root.mkdir(parents=True)
    db = str(tmp_path / f"catalog-{version}.local.sqlite")
    builder = catalog.CatalogBuilder(db)
    builder.record_dataset_version(version, converter_version="conversion/0.2",
                                   contract_version="market-observation/1")
    for manifest in partitions:
        prefix = (f"databento/{manifest['instrument_id']}/{manifest['family']}"
                  f"/{manifest['dataset_version']}/{manifest['date']}")
        builder.record_partition(manifest, prefix, manifest_sha256, published_to_s3=True)
    builder.mark_published(version)
    builder.close()
    catalog.publish(str(root), db, version)
    return str(root)


def _iid(symbol="AAPL", venue="XNAS", market="EQUITY", size_unit="SHARE"):
    """The canonical identity shape the catalog actually stores; venue drives the
    trading calendar, so a placeholder string would bypass the lookup entirely."""
    return json.dumps([venue, market, symbol, "USD", size_unit])


def _partition(instrument_id, family, date, records=10, version="v1"):
    return {
        "instrument_id": instrument_id, "family": family, "dataset_version": version, "date": date,
        "record_count": records, "rejected_count": 0,
        "event_ns_min": _ns(date), "event_ns_max": _ns(date) + 1,
        "logical_sha256": "a" * 64, "parts": [{"name": "part-00000.parquet"}],
    }


def test_the_state_vocabulary_is_closed_and_every_state_is_reachable():
    assert set(cr.STATES) == {"PUBLISHED", "MARKET_CLOSED", "QUIET", "MISSING",
                              "QUARANTINED", "FAILED", "CORRUPT", "UNKNOWN"}


# The criterion W6.07 states as "a date picker can distinguish unavailable data
# from a valid quiet interval". Verified against real data: AAPL 2025-09-01 has
# zero status rows inside a covered month and no partition.
@pytest.mark.parametrize("published,records,session,covered,quarantined,planned,expected", [
    (True, 10, True, True, False, False, cr.PUBLISHED),
    (True, 0, True, True, False, False, cr.QUIET),
    (False, 0, False, True, False, False, cr.MARKET_CLOSED),
    (False, 0, True, True, False, False, cr.MISSING),
    (False, 0, True, True, True, False, cr.QUARANTINED),
    (False, 0, True, True, False, True, cr.FAILED),
    (False, 0, True, False, False, False, cr.UNKNOWN),
    (False, 0, None, False, False, False, cr.UNKNOWN),
    (False, 0, None, True, False, False, cr.MARKET_CLOSED),
])
def test_each_date_state_is_derived_not_guessed(published, records, session, covered,
                                                quarantined, planned, expected):
    assert cr.classify_date(published=published, record_count=records, session=session,
                            month_covered=covered, quarantined=quarantined,
                            planned=planned) == expected


def test_a_closure_and_a_real_gap_are_never_the_same_answer(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02", "2025-09-03"])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")

    calendar = {e["date"]: e["state"] for e in report["instruments"][0]["calendar"]}
    assert calendar["2025-09-02"] == cr.PUBLISHED
    assert calendar["2025-09-03"] == cr.MISSING, "a traded day with no partition is a real gap"
    # A holiday has no status rows at all, so it is only distinguishable from a
    # gap by enumerating the covered month. A date picker cannot grey out a day
    # the report never mentions.
    assert calendar["2025-09-01"] == cr.MARKET_CLOSED
    assert calendar["2025-09-06"] == cr.MARKET_CLOSED, "weekends are closures, not gaps"


def test_a_month_without_status_reference_reports_unknown_rather_than_closed(tmp_path):
    reference = tmp_path / "reference"
    (reference / "status").mkdir(parents=True)
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")

    states = {e["state"] for e in report["instruments"][0]["calendar"]}
    assert states == {cr.PUBLISHED}
    assert report["totals"]["states"][cr.MARKET_CLOSED] == 0


def test_depth_capability_is_unknown_until_depth_partitions_exist(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    catalog_root = _catalog_with(tmp_path, [
        _partition(_iid(), "trade", "2025-09-02"),
        _partition(_iid(), "quote", "2025-09-02"),
    ])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")
    cap = report["instruments"][0]["capability"]

    assert cap["trade"]["available"] is True and cap["quote"]["available"] is True
    assert cap["depth"] == {"available": cr.UNKNOWN, "reason": cr.DEPTH_UNAVAILABLE_REASON,
                            "corrupt": 0}
    assert cap["book_reconstructable"] == {"available": cr.UNKNOWN,
                                           "reason": cr.DEPTH_UNAVAILABLE_REASON}


def test_a_partition_traces_to_its_inputs_and_converter_version(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")
    entry = next(e for e in report["instruments"][0]["calendar"] if e["state"] == cr.PUBLISHED)

    assert entry["logical_sha256"] == "a" * 64
    assert entry["manifest_sha256"] == "b" * 64
    assert entry["converter_version"] == "conversion/0.2"
    assert entry["contract_version"] == "market-observation/1"


def test_a_tampered_snapshot_is_refused_rather_than_reported(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])
    pointer = catalog.read_current(catalog_root)
    target = tmp_path / "curated" / "_catalog" / pointer["catalog_key"]
    with sqlite3.connect(str(target)) as con:
        con.execute("UPDATE partitions SET record_count = record_count + 1")

    with pytest.raises(cr.CoverageReportError, match="CATALOG_INTEGRITY_FAILURE"):
        cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")


def test_price_reconciliation_reports_unknown_instead_of_inventing_a_match(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    _statistics_file(reference, "AAPL", [
        ("2025-09-02", cr.STAT_OPEN, "229490000000"),
        ("2025-09-02", cr.STAT_CLOSE, "229720000000"),
    ])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])

    matched = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL",
                       observed_prices={"2025-09-02": {"first_price": "229.49", "last_price": "229.72"}})
    unseen = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")
    wrong = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL",
                     observed_prices={"2025-09-02": {"first_price": "1.00", "last_price": "2.00"}})

    assert {c["result"] for c in matched["price_reconciliation"]} == {"MATCH"}
    assert unseen["price_reconciliation"] == []
    assert {c["result"] for c in wrong["price_reconciliation"]} == {"DIFFERS"}


def test_an_undefined_reference_price_is_skipped_not_compared(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    _statistics_file(reference, "AAPL", [("2025-09-02", cr.STAT_OPEN, cr.UNDEFINED_INT64)])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL",
                      observed_prices={"2025-09-02": {"first_price": "229.49"}})

    assert report["price_reconciliation"] == []


def test_outstanding_reconciliation_surfaces_partial_months_and_quarantined_dates(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02", "2025-09-03"])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])
    staging = tmp_path / "staging" / "_sequence"
    staging.mkdir(parents=True)
    (staging / "v1-aapl-2025-09-partial.json").write_text(json.dumps({
        "version": "v1-aapl-2025-09", "symbol": "AAPL", "status": "partial",
        "quarantined_dates": [{"date": "2025-09-03", "evidence": "/e.json",
                               "evidence_sha256": "c" * 64, "error": "JobError: QUARANTINE"}],
        "operator_action_required": "review",
    }), encoding="utf-8")

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference),
                      staging_root=str(tmp_path / "staging"), symbol="AAPL")

    assert [p["version"] for p in report["outstanding"]["partial_months"]] == ["v1-aapl-2025-09"]
    assert report["outstanding"]["quarantined_dates"][0]["evidence_sha256"] == "c" * 64
    calendar = {e["date"]: e["state"] for e in report["instruments"][0]["calendar"]}
    assert calendar["2025-09-03"] == cr.QUARANTINED, "a known-bad day is not an unexplained gap"


def test_two_runs_over_unchanged_inputs_are_byte_identical(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02", "2025-09-03"])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])
    argv = ["--catalog-root", catalog_root, "--reference-root", str(reference),
            "--symbol", "AAPL", "--omit-generated-at"]

    outputs = []
    for _ in range(2):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            assert coverage_report_cli.main(argv) == coverage_report_cli.EXIT_OK
        outputs.append(buffer.getvalue())

    assert outputs[0] == outputs[1]
    assert json.loads(outputs[0])["generated_at"] is None


def test_the_cli_fails_loudly_on_an_unreadable_catalog(tmp_path, capsys):
    reference = tmp_path / "reference"
    (reference / "status").mkdir(parents=True)
    empty = tmp_path / "nowhere"
    empty.mkdir()

    code = coverage_report_cli.main(["--catalog-root", str(empty), "--reference-root", str(reference)])

    assert code == coverage_report_cli.EXIT_ERROR
    assert "NO_CURRENT_POINTER" in capsys.readouterr().err


def _futures_status_file(root, symbol, dates, instrument_id="4916"):
    path = (root / "status" / "dataset=GLBX.MDP3" / "schema=status"
            / f"symbol={symbol}" / "year=2025" / "month=09")
    path.mkdir(parents=True, exist_ok=True)
    lines = [_STATUS_HEADER]
    for date in dates:
        lines.append(",".join([
            str(_ns(date)), str(_ns(date)), "18", "2", instrument_id, "1", "0", "0", "Y", "Y", "N",
        ]))
    (path / "x.status.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_a_venue_that_trades_on_sunday_does_not_make_another_venues_sunday_a_gap(tmp_path):
    # Found only against production data: CME trades Sunday evenings, so merging
    # every venue's sessions reported all four September Sundays plus Labor Day
    # as missing equity days -- 120 fabricated gaps across AAPL and TSLA.
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02", "2025-09-03"])
    _futures_status_file(reference, "ES", ["2025-09-02", "2025-09-03", "2025-09-07"])
    catalog_root = _catalog_with(tmp_path, [
        _partition(_iid(), "trade", "2025-09-02"),
        _partition(_iid(), "trade", "2025-09-03"),
    ])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference))
    equity = next(i for i in report["instruments"] if "EQUITY" in i["instrument_id"])
    calendar = {e["date"]: e["state"] for e in equity["calendar"]}

    assert calendar["2025-09-07"] == cr.MARKET_CLOSED, "a CME Sunday is not a Nasdaq session"
    assert report["totals"]["states"][cr.MISSING] == 0


def test_a_futures_contract_is_not_missing_outside_the_span_it_was_front_month(tmp_path):
    # Each contract is front month for only part of a quarter; enumerating whole
    # months for every contract reported 330 fabricated gaps on the real catalog.
    reference = tmp_path / "reference"
    _futures_status_file(reference, "ES", ["2025-09-%02d" % d for d in range(2, 26)])
    esu5 = _iid("ESU5", venue="XCME", market="FUTURE", size_unit="CONTRACT")
    catalog_root = _catalog_with(tmp_path, [
        _partition(esu5, "trade", "2025-09-15"),
        _partition(esu5, "trade", "2025-09-16"),
    ])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference))
    calendar = {e["date"]: e["state"] for e in report["instruments"][0]["calendar"]}

    assert set(calendar) == {"2025-09-15", "2025-09-16"}
    assert report["totals"]["states"][cr.MISSING] == 0


class _FakeStore:
    """Enough of s3_publish.Store for verification: manifests keyed by prefix and
    a part inventory, so a partition can be made absent or corrupt deliberately."""

    def __init__(self, manifests, parts, bucket="bucket", prefix="curated/test"):
        self.manifests, self.parts = manifests, parts
        self.bucket, self.prefix = bucket, prefix
        self.client = self
        self.read_bytes = 0

    def key(self, relative):
        return f"{self.prefix}/{relative}"

    def get_object(self, Bucket, Key, IfMatch=None):
        relative = Key[len(self.prefix) + 1:]
        prefix = relative.rsplit("/_manifest.json", 1)[0]
        if relative.endswith("_manifest.json") and prefix in self.manifests:
            data = json.dumps(self.manifests[prefix], sort_keys=True, separators=(",", ":")).encode()
            return {"Body": io.BytesIO(data)}
        raise _S3Missing(404)

    def get_json(self, relative):
        prefix = relative.rsplit("/_manifest.json", 1)[0]
        return self.manifests.get(prefix), "etag"

    def verify_stored(self, relative, sha, size):
        if relative not in self.parts:
            raise s3_publish.PublicationError("REMOTE_ARTIFACT_MISMATCH")


class _S3Missing(Exception):
    def __init__(self, status):
        super().__init__(str(status))
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}}


def _remote_manifest(instrument_id, family, date, records=10, version="v1"):
    return {
        "instrument_id": instrument_id, "family": family, "dataset_version": version, "date": date,
        "record_count": records, "rejected_count": 0, "event_ns_min": _ns(date),
        "event_ns_max": _ns(date) + 1, "logical_sha256": "a" * 64,
        "source_objects": [{"s3_key": "raw/databento/x.dbn.zst", "sha256": "d" * 64}],
        "parts": [{"name": "part-00000.parquet", "row_count": records, "sha256": "p" * 64, "bytes": 1}],
        "validation": {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True},
    }


def _store_for(prefixes, manifests_by_prefix, missing_parts=()):
    parts = {f"{p}/part-00000.parquet" for p in prefixes if p not in missing_parts}
    return _FakeStore(manifests_by_prefix, parts)


def _prefix(instrument_id, family, date, version="v1"):
    return f"databento/{instrument_id}/{family}/{version}/{date}"


def test_without_verification_the_report_says_so_rather_than_implying_validity(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")

    assert report["verification"]["mode"] == cr.VERIFY_NONE
    assert report["verification"]["partitions_checked"] == 0
    entry = next(e for e in report["instruments"][0]["calendar"] if e["state"] == cr.PUBLISHED)
    assert entry["verification"] == cr.NOT_REQUESTED, "an unchecked partition is a weaker claim"


def test_a_verified_partition_reports_ok_and_traces_to_its_raw_inputs(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    iid = _iid()
    remote = _remote_manifest(iid, "trade", "2025-09-02")
    catalog_root = _catalog_with(tmp_path, [_partition(iid, "trade", "2025-09-02")],
                                 manifest_sha256=_manifest_sha(remote))
    prefix = _prefix(iid, "trade", "2025-09-02")
    store = _store_for([prefix], {prefix: remote})

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL",
                      store=store)

    entry = next(e for e in report["instruments"][0]["calendar"] if e["state"] == cr.PUBLISHED)
    assert report["verification"]["mode"] == cr.VERIFY_FULL
    assert report["verification"]["failures"] == []
    assert entry["verification"] == cr.VERIFIED_OK
    assert entry["source_objects"] == [{"s3_key": "raw/databento/x.dbn.zst", "sha256": "d" * 64}]


@pytest.mark.parametrize("scenario", ["manifest_absent", "part_absent", "manifest_tampered"])
def test_a_partition_that_does_not_verify_is_never_advertised_as_coverage(tmp_path, scenario):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    iid = _iid()
    prefix = _prefix(iid, "trade", "2025-09-02")
    manifest = _remote_manifest(iid, "trade", "2025-09-02")
    catalog_root = _catalog_with(tmp_path, [_partition(iid, "trade", "2025-09-02")],
                                 manifest_sha256=_manifest_sha(manifest))
    if scenario == "manifest_tampered":
        manifest = dict(manifest, record_count=999)
    manifests = {} if scenario == "manifest_absent" else {prefix: manifest}
    missing = [prefix] if scenario == "part_absent" else []
    store = _store_for([prefix], manifests, missing_parts=missing)

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL",
                      store=store)

    entry = next(e for e in report["instruments"][0]["calendar"] if e["date"] == "2025-09-02")
    assert entry["state"] == cr.CORRUPT, f"{scenario} must not read as PUBLISHED"
    assert entry["verification"] != cr.VERIFIED_OK
    assert report["totals"]["states"][cr.PUBLISHED] == 0
    assert len(report["verification"]["failures"]) == 1


def test_a_corrupt_partition_is_not_counted_as_available_capability(tmp_path):
    # Demoting the calendar entry alone leaves capability advertising the same
    # partition as usable -- the risk relocated rather than eliminated.
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    iid = _iid()
    prefix = _prefix(iid, "trade", "2025-09-02")
    manifest = _remote_manifest(iid, "trade", "2025-09-02")
    catalog_root = _catalog_with(tmp_path, [_partition(iid, "trade", "2025-09-02")],
                                 manifest_sha256=_manifest_sha(manifest))
    store = _store_for([prefix], {}, missing_parts=[prefix])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL",
                      store=store)
    instrument = report["instruments"][0]

    assert instrument["capability"]["trade"]["available"] is False
    assert instrument["capability"]["trade"]["corrupt"] == 1
    assert instrument["capability"]["trade"]["records"] == 0
    assert instrument["freshness"]["newest_event_ns"] is None, "a corrupt partition is not freshness"


def test_a_quarantine_receipt_for_one_symbol_never_marks_another(tmp_path):
    # The lookup keyed on the CLI argument, so one symbol's quarantine marked
    # that date on every instrument in the catalog -- the venue-bug class again.
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02", "2025-09-03"])
    _futures_status_file(reference, "ES", ["2025-09-02", "2025-09-03", "2025-09-04"])
    esu5 = _iid("ESU5", venue="XCME", market="FUTURE", size_unit="CONTRACT")
    # ESU5 must straddle the quarantined date, or _expected_dates never
    # enumerates 2025-09-03 for it and the assertion below passes vacuously.
    catalog_root = _catalog_with(tmp_path, [
        _partition(_iid(), "trade", "2025-09-02"),
        _partition(esu5, "trade", "2025-09-02"),
        _partition(esu5, "trade", "2025-09-04"),
    ])
    staging = tmp_path / "staging" / "_sequence"
    staging.mkdir(parents=True)
    (staging / "v1-aapl-2025-09-partial.json").write_text(json.dumps({
        "version": "v1-aapl-2025-09", "symbol": "AAPL",
        "quarantined_dates": [{"date": "2025-09-03", "evidence": "/e.json",
                               "evidence_sha256": "c" * 64, "error": "JobError: QUARANTINE"}],
    }), encoding="utf-8")

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference),
                      staging_root=str(tmp_path / "staging"))
    states = {i["instrument_id"]: {e["date"]: e["state"] for e in i["calendar"]}
              for i in report["instruments"]}

    assert states[_iid()]["2025-09-03"] == cr.QUARANTINED
    assert states[esu5]["2025-09-03"] == cr.MISSING, "AAPL's bad day is not ESU5's"


def test_book_reconstructability_is_never_claimed_without_continuity_evidence(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "depth", "2025-09-02")])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")
    cap = report["instruments"][0]["capability"]

    assert cap["depth"]["available"] is True
    assert cap["book_reconstructable"] == {"available": cr.UNKNOWN,
                                           "reason": cr.NO_CONTINUITY_REASON},         "depth alone is not a book"


def test_a_planned_date_that_never_published_is_failed_not_missing(tmp_path):
    # FAILED was in the published vocabulary but unreachable, because build()
    # hardcoded planned=False. A state consumers can never see is a false promise.
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02", "2025-09-03"])
    iid = _iid()
    catalog_root = _catalog_with(tmp_path, [_partition(iid, "trade", "2025-09-02")])
    job = tmp_path / "staging" / "v1-aapl-2025-09" / "abc123"
    job.mkdir(parents=True)
    (job / "checkpoint.json").write_text(json.dumps({
        "job_id": "abc123", "dataset_version": "v1-aapl-2025-09",
        "authority_plan": [
            {"instrument_id": iid, "family": "trade", "date": "2025-09-02"},
            {"instrument_id": iid, "family": "trade", "date": "2025-09-03"},
        ],
    }), encoding="utf-8")

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference),
                      staging_root=str(tmp_path / "staging"), symbol="AAPL")
    calendar = {e["date"]: e["state"] for e in report["instruments"][0]["calendar"]}

    assert calendar["2025-09-02"] == cr.PUBLISHED
    assert calendar["2025-09-03"] == cr.FAILED, "planned but never published is not merely missing"


def test_a_plan_date_before_the_jobs_own_month_is_not_a_failure(tmp_path):
    # Measured on the live L1 run: the ES and NQ September plans carry a
    # 2025-08-31 entry because the GLBX monthly file opens with a book snapshot
    # stamped 16 ms before midnight. The driver iterates 09-01..09-30 and never
    # visits it, so reporting it FAILED fails the closure gate on an artefact.
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    iid = _iid()
    catalog_root = _catalog_with(tmp_path, [_partition(iid, "trade", "2025-09-02")])
    job = tmp_path / "staging" / "v1-aapl-2025-09" / "abc123"
    job.mkdir(parents=True)
    (job / "checkpoint.json").write_text(json.dumps({
        "job_id": "abc123", "dataset_version": "v1-aapl-2025-09",
        "authority_plan": [
            {"instrument_id": iid, "family": "trade", "date": "2025-08-31"},
            {"instrument_id": iid, "family": "trade", "date": "2025-09-02"},
        ],
    }), encoding="utf-8")

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference),
                      staging_root=str(tmp_path / "staging"), symbol="AAPL")
    calendar = {e["date"]: e["state"] for e in report["instruments"][0]["calendar"]}

    assert "2025-08-31" not in calendar, "a date outside the job's month was never owed"
    assert calendar["2025-09-02"] == cr.PUBLISHED


def test_an_unparseable_dataset_version_still_reports_every_planned_date(tmp_path):
    # The scope filter must fail open. A version it cannot read must leave the
    # planned set whole, because an empty planned set is indistinguishable from
    # a clean run and makes FAILED unreachable -- the W6.07 defect, reintroduced.
    staging = tmp_path / "staging"
    job = staging / "job1"
    job.mkdir(parents=True)
    iid = _iid()
    (job / "checkpoint.json").write_text(json.dumps({
        "job_id": "job1", "dataset_version": "aapl-latest",
        "authority_plan": [{"instrument_id": iid, "family": "trade", "date": "2025-08-31"}],
    }), encoding="utf-8")

    assert cr.read_outstanding(str(staging))["planned"] == {(iid, "trade", "2025-08-31")}


@pytest.mark.parametrize("version", ["v1-aapl-2025-13", "v1-aapl-2025-00", "v1-aapl-25-09", "v1"])
def test_only_a_real_year_month_suffix_is_read_as_scope(version):
    assert checkpoint.scoped_month(version) is None, version


def test_price_reconciliation_refuses_to_run_across_unfiltered_instruments(tmp_path):
    # Observed prices are keyed by date alone, so without a symbol filter the
    # comparison silently crosses instruments.
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    catalog_root = _catalog_with(tmp_path, [_partition(_iid(), "trade", "2025-09-02")])

    with pytest.raises(cr.CoverageReportError, match="PRICE_RECONCILIATION_REQUIRES_SYMBOL"):
        cr.build(catalog_root=catalog_root, reference_root=str(reference),
                 observed_prices={"2025-09-02": {"first_price": "1"}})


def test_a_partial_sweep_reaches_every_instrument_not_just_the_first():
    # partitions are sorted by instrument, so a head slice can only ever see
    # instrument A -- corruption in Z would be reported as a clean sample.
    partitions = [{"instrument_id": name, "date": f"2025-09-{day:02d}"}
                  for name in ("A", "B", "C", "D") for day in range(1, 26)]

    sampled = cr.sample_partitions(partitions, 8)

    assert len(sampled) == 8
    assert {row["instrument_id"] for row in sampled} == {"A", "B", "C", "D"}
    assert sampled == cr.sample_partitions(partitions, 8), "sampling must be deterministic"
    assert cr.sample_partitions(partitions, 500) == partitions


def test_trailing_zeroes_do_not_make_a_price_differ():
    statistics = {("1234", "2025-09-02"): {cr.STAT_CLOSE: {"price": "229.49", "quantity": None}}}

    checks = cr.reconcile_prices(statistics, {"2025-09-02": {"last_price": "229.490"}})

    assert [c["result"] for c in checks] == ["MATCH"]


def test_an_unparseable_observed_price_is_unknown_not_a_difference():
    statistics = {("1234", "2025-09-02"): {cr.STAT_CLOSE: {"price": "229.49", "quantity": None}}}

    checks = cr.reconcile_prices(statistics, {"2025-09-02": {"last_price": "n/a"}})

    assert [c["result"] for c in checks] == [cr.UNKNOWN]


def test_an_unsampled_partition_says_so_instead_of_borrowing_the_sample_label(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02", "2025-09-03"])
    iid = _iid()
    rows = [_partition(iid, "trade", "2025-09-02"), _partition(iid, "trade", "2025-09-03")]
    manifest = _remote_manifest(iid, "trade", "2025-09-02")
    catalog_root = _catalog_with(tmp_path, rows, manifest_sha256=_manifest_sha(manifest))
    prefix = _prefix(iid, "trade", "2025-09-02")
    store = _store_for([prefix], {prefix: manifest})

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL",
                      store=store, verify_limit=1)
    labels = {e["date"]: e["verification"] for e in report["instruments"][0]["calendar"]
              if "verification" in e}

    assert labels["2025-09-02"] == cr.VERIFIED_OK
    assert labels["2025-09-03"] == cr.NOT_SAMPLED
    assert report["verification"]["mode"] == cr.VERIFY_SAMPLE


def test_a_limit_that_covers_everything_is_a_full_sweep_not_a_sample(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    iid = _iid()
    manifest = _remote_manifest(iid, "trade", "2025-09-02")
    catalog_root = _catalog_with(tmp_path, [_partition(iid, "trade", "2025-09-02")],
                                 manifest_sha256=_manifest_sha(manifest))
    prefix = _prefix(iid, "trade", "2025-09-02")
    store = _store_for([prefix], {prefix: manifest})

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL",
                      store=store, verify_limit=50)

    assert report["verification"]["mode"] == cr.VERIFY_FULL
    assert report["verification"]["partitions_checked"] == 1


def test_the_modelled_families_are_all_publishable():
    # MODELLED_FAMILIES names what capability() reports, so every entry must be a
    # family something can actually publish under -- otherwise this module
    # advertises a capability no writer can ever satisfy.
    #
    # It used to be a hand-copied slice of record.js. The candle resolution ladder
    # broke that identity: candle_1m and candle_1h are partition families, not
    # record families, and a bar stays a `candle` record at every resolution so
    # the live contract is untouched. The invariant is therefore checked through
    # the writer's partition map, which still lands on record.js at the far end.
    import os
    import re

    import writer

    here = os.path.dirname(os.path.abspath(__file__))
    record_js = os.path.normpath(os.path.join(here, "..", "..", "src", "data-contracts", "v1", "record.js"))
    source = io.open(record_js, encoding="utf-8").read()
    match = re.search(r"const FAMILIES\s*=\s*Object\.freeze\(\[(.*?)\]\)", source, re.S)
    assert match, "record.js no longer declares FAMILIES the way this test reads it"
    contract_families = set(re.findall(r'"([a-z_]+)"', match.group(1)))
    assert contract_families, "failed to parse any family out of record.js"

    unpublishable = set(cr.MODELLED_FAMILIES) - set(writer._PARTITION_RECORD_FAMILY)
    assert not unpublishable, (
        f"coverage_report models families no writer can publish: {sorted(unpublishable)}")

    undefined = set(writer._PARTITION_RECORD_FAMILY.values()) - contract_families
    assert not undefined, (
        f"partition families map to record families the contract does not define: "
        f"{sorted(undefined)}")


def _continuity_row(instrument_id, epoch, state="OK", resets=0, gaps=0, version="v1"):
    return {"instrument_id": instrument_id, "family": "depth", "dataset_version": version,
            "book_epoch": epoch, "from_ns": 0, "to_ns": 1, "state": state,
            "observed_resets": resets, "suspected_gaps": gaps}


def _catalog_with_continuity(tmp_path, partitions, continuity, version="v1"):
    root = tmp_path / "curated" / "_catalog"
    root.mkdir(parents=True)
    db = str(tmp_path / f"catalog-{version}.local.sqlite")
    builder = catalog.CatalogBuilder(db)
    builder.record_dataset_version(version, converter_version="conversion/0.2",
                                   contract_version="market-observation/1")
    for manifest in partitions:
        prefix = (f"databento/{manifest['instrument_id']}/{manifest['family']}"
                  f"/{manifest['dataset_version']}/{manifest['date']}")
        builder.record_partition(manifest, prefix, "b" * 64, published_to_s3=True)
    builder.record_continuity(continuity)
    builder.mark_published(version)
    builder.close()
    catalog.publish(str(root), db, version)
    return str(root)


def test_a_book_replays_only_when_continuity_says_the_epochs_are_sound(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    iid = _iid()
    catalog_root = _catalog_with_continuity(
        tmp_path, [_partition(iid, "depth", "2025-09-02")],
        [_continuity_row(iid, 1, state="OK", resets=2)])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")
    book = report["instruments"][0]["capability"]["book_reconstructable"]

    assert book == {"available": True, "epochs": 1, "observed_resets": 2}, \
        "an explicit reset is a book event, not a hole"


def test_a_suspected_gap_denies_book_reconstruction(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    iid = _iid()
    catalog_root = _catalog_with_continuity(
        tmp_path, [_partition(iid, "depth", "2025-09-02")],
        [_continuity_row(iid, 1, state="GAP_SUSPECTED", gaps=4)])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")
    book = report["instruments"][0]["capability"]["book_reconstructable"]

    assert book["available"] is False
    assert book["reason"] == cr.CONTINUITY_GAPS_REASON
    assert book["suspected_gaps"] == 4


def test_one_instruments_continuity_does_not_vouch_for_another(tmp_path):
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    _status_file(reference, "MSFT", ["2025-09-02"])
    aapl, msft = _iid(), _iid("MSFT")
    catalog_root = _catalog_with_continuity(
        tmp_path, [_partition(aapl, "depth", "2025-09-02"), _partition(msft, "depth", "2025-09-02")],
        [_continuity_row(aapl, 1, state="OK")])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference))
    books = {i["instrument_id"]: i["capability"]["book_reconstructable"]
             for i in report["instruments"]}

    assert books[aapl]["available"] is True
    assert books[msft] == {"available": cr.UNKNOWN, "reason": cr.NO_CONTINUITY_REASON}


def test_continuity_recorded_for_another_family_does_not_vouch_for_the_book(tmp_path):
    # The continuity table is keyed by family and only depth conversion writes
    # into it today, so a non-depth row is the case that proves the filter is
    # doing work rather than decorating the query.
    reference = tmp_path / "reference"
    _status_file(reference, "AAPL", ["2025-09-02"])
    iid = _iid()
    row = _continuity_row(iid, 1, state="OK")
    row["family"] = "trade"
    catalog_root = _catalog_with_continuity(
        tmp_path, [_partition(iid, "depth", "2025-09-02")], [row])

    report = cr.build(catalog_root=catalog_root, reference_root=str(reference), symbol="AAPL")
    book = report["instruments"][0]["capability"]["book_reconstructable"]

    assert book == {"available": cr.UNKNOWN, "reason": cr.NO_CONTINUITY_REASON}


@pytest.mark.parametrize("depth,driver", [
    (["job1"], "backfill_driver drives one job directly"),
    (["v1-aapl-2025-09", "job1"], "backfill_sequence nests staging_root/<version>"),
])
def test_the_authority_plan_is_found_under_both_live_staging_layouts(tmp_path, depth, driver):
    # Both layouts exist on the host. A glob matching only one reads no
    # checkpoint at all and silently reports zero planned dates, which is how a
    # failed date would masquerade as a market closure.
    staging = tmp_path / "staging"
    job = staging.joinpath(*depth)
    job.mkdir(parents=True)
    iid = _iid()
    (job / "checkpoint.json").write_text(json.dumps({
        "job_id": "job1", "dataset_version": "v1-aapl-2025-09",
        "authority_plan": [{"instrument_id": iid, "family": "trade", "date": "2025-09-02"}],
        "quarantined_dates": [{"date": "2025-09-03", "evidence": "/e.json",
                               "evidence_sha256": "c" * 64, "error": "JobError: X"}],
    }), encoding="utf-8")

    outstanding = cr.read_outstanding(str(staging))

    assert outstanding["planned"] == {(iid, "trade", "2025-09-02")}, driver
    assert (iid, "2025-09-03") in outstanding["quarantined_instruments"]
