from __future__ import annotations

import json

import pytest

import archive_query as aq
import catalog

CURATED_PREFIX = "curated"
IID = json.dumps(["XCME", "FUTURE", "NQU5", "USD", "CONTRACT"])
OTHER = json.dumps(["XCME", "FUTURE", "ESU5", "USD", "CONTRACT"])

DAY = aq._DAY_NS
BASE = 1_756_684_800_000_000_000


def _manifest(instrument_id, family, date, *, records, event_ns_min, event_ns_max,
              version="w606-l1-v2-glbx-mdp3-mbp-1-nq-2025-09", parts=1):
    return {
        "instrument_id": instrument_id, "family": family, "dataset_version": version,
        "date": date, "record_count": records, "rejected_count": 0,
        "event_ns_min": event_ns_min, "event_ns_max": event_ns_max,
        "logical_sha256": "a" * 64,
        "parts": [{"name": f"part-{index:05d}.parquet"} for index in range(parts)],
    }


def _catalog_with(tmp_path, manifests):
    root = tmp_path / "curated" / "_catalog"
    root.mkdir(parents=True)
    db = str(tmp_path / "catalog.local.sqlite")
    builder = catalog.CatalogBuilder(db)
    for index, manifest in enumerate({m["dataset_version"] for m in manifests}):
        builder.record_dataset_version(manifest, converter_version="conversion/0.2",
                                       contract_version="market-observation/1")
    for manifest in manifests:
        prefix = (f"databento/{manifest['instrument_id']}/{manifest['family']}"
                  f"/{manifest['dataset_version']}/{manifest['date']}")
        builder.record_partition(manifest, prefix, "b" * 64, published_to_s3=True)
    for version in {m["dataset_version"] for m in manifests}:
        builder.mark_published(version)
    builder.close()
    catalog.publish(str(root), db, sorted({m["dataset_version"] for m in manifests})[0])
    return str(root)


def _discover(root, **overrides):
    kwargs = {
        "instrument_id": IID, "family": "trade",
        "from_ns": str(BASE), "to_ns": str(BASE + DAY),
        "curated_prefix": CURATED_PREFIX,
    }
    kwargs.update(overrides)
    return aq.discover(root, **kwargs)


def test_a_window_resolves_to_exactly_the_overlapping_partitions_in_order(tmp_path):
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-03", records=10, event_ns_min=BASE + 2 * DAY, event_ns_max=BASE + 3 * DAY - 1),
        _manifest(IID, "trade", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + DAY - 1),
        _manifest(IID, "trade", "2025-09-02", records=10, event_ns_min=BASE + DAY, event_ns_max=BASE + 2 * DAY - 1),
    ])

    result = _discover(root, from_ns=str(BASE), to_ns=str(BASE + 2 * DAY), family="trade")

    assert [p["date"] for p in result["partitions"]] == ["2025-09-01", "2025-09-02"]
    assert result["selection"]["partitions"] == 2
    assert "coverage" not in result, "Step 7 owns user-facing gap and coverage semantics"


def test_partitions_are_ordered_by_event_time_not_by_how_the_catalog_returns_them(tmp_path):
    # read_catalog orders by (instrument, family, dataset_version, date), so for
    # the current monthly version names SQL order happens to match time order and
    # a missing sort is invisible. Version naming is not constrained to sort by
    # time, and a window spanning two versions is ordinary: this fixture names
    # the earlier data "zz" and the later "aa" so the two orders disagree.
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-02", records=10, version="aa-later",
                  event_ns_min=BASE + DAY, event_ns_max=BASE + DAY + 5),
        _manifest(IID, "trade", "2025-09-01", records=10, version="zz-earlier",
                  event_ns_min=BASE, event_ns_max=BASE + 5),
    ])

    result = _discover(root, from_ns=str(BASE), to_ns=str(BASE + 2 * DAY))

    assert [p["dataset_version"] for p in result["partitions"]] == ["zz-earlier", "aa-later"], (
        "pages concatenate in the order discovery returns, so it must be event order")
    assert [p["event_ns_min"] for p in result["partitions"]] == [str(BASE), str(BASE + DAY)]


def test_the_window_is_half_open_at_both_partition_edges(tmp_path):
    # A partition whose last row sits exactly at `from` still holds that row; one
    # whose first row sits exactly at `to` does not. Getting this wrong duplicates
    # or drops the boundary record wherever two ranges meet.
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=1, event_ns_min=BASE - DAY, event_ns_max=BASE),
        _manifest(IID, "trade", "2025-09-02", records=1, event_ns_min=BASE + DAY, event_ns_max=BASE + DAY),
    ])

    result = _discover(root, from_ns=str(BASE), to_ns=str(BASE + DAY))

    assert [p["date"] for p in result["partitions"]] == ["2025-09-01"]


def test_the_resolved_key_joins_what_the_catalog_recorded(tmp_path):
    # Published keys carry the provider segment twice because the stored
    # s3_prefix already includes it. Rebuilding the path returns nothing.
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + 1),
    ])

    partition = _discover(root)["partitions"][0]

    assert partition["key_prefix"].startswith("curated/databento/databento/")
    assert partition["manifest_key"] == partition["key_prefix"] + "/_manifest.json"


@pytest.mark.parametrize("family,days,refused", [
    ("quote", 1, False), ("quote", 2, True),
    ("trade", 7, False), ("trade", 8, True),
    ("candle", 31, False), ("candle", 32, True),
    ("trade_level_1m", 7, False), ("trade_level_1m", 8, True),
    ("trade_slice_2s", 7, False), ("trade_slice_2s", 8, True),
    ("trade_minute_1m", 31, False), ("trade_minute_1m", 32, True),
    ("trade_prints_1m", 31, False), ("trade_prints_1m", 32, True),
])
def test_the_window_is_bounded_in_time_per_family(tmp_path, family, days, refused):
    # Density differs by nearly two orders of magnitude between families, so one
    # window cap across all of them is either useless for candles or lets a
    # single day of quotes through at 491 MB.
    root = _catalog_with(tmp_path, [
        _manifest(IID, family, "2025-09-01", records=1, event_ns_min=BASE, event_ns_max=BASE + 1),
    ])

    if not refused:
        _discover(root, family=family, to_ns=str(BASE + days * DAY))
        return
    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root, family=family, to_ns=str(BASE + days * DAY))
    assert raised.value.code == aq.WINDOW_TOO_LARGE
    assert raised.value.detail["reason"] == "WINDOW_TOO_LONG"
    assert raised.value.detail["maxWindowNs"] == str(aq.WINDOW_LIMIT_NS[family])


def test_a_scan_estimate_over_the_budget_is_refused_before_any_fetch(tmp_path):
    root = _catalog_with(tmp_path, [
        _manifest(IID, "quote", "2025-09-01", records=10_113_547, parts=59,
                  event_ns_min=BASE, event_ns_max=BASE + DAY - 1),
    ])

    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root, family="quote")

    assert raised.value.code == aq.RANGE_TOO_LARGE
    assert raised.value.detail["reason"] == "SCAN_ESTIMATE_EXCEEDS_BUDGET"
    assert raised.value.detail["effectiveMaxScanBytes"] == aq.MAX_SCAN_BYTES
    assert raised.value.detail["estimatedScanBytes"] > aq.MAX_SCAN_BYTES


def test_one_date_under_two_dataset_versions_is_refused_not_concatenated(tmp_path):
    # The catalog's primary key permits this and reprocessing is how it arrives.
    # Serving both silently doubles every row in the overlap.
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + 1, version="v-a"),
        _manifest(IID, "trade", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + 1, version="v-b"),
    ])

    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root)

    assert raised.value.code == aq.CATALOG_INTEGRITY_FAILURE
    assert raised.value.detail["reason"] == "DATE_IN_MULTIPLE_DATASET_VERSIONS"


def test_partitions_whose_event_ranges_overlap_are_refused(tmp_path):
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + 5_000),
        _manifest(IID, "trade", "2025-09-02", records=10, event_ns_min=BASE + 4_000, event_ns_max=BASE + 9_000),
    ])

    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root)

    assert raised.value.code == aq.CATALOG_INTEGRITY_FAILURE
    assert raised.value.detail["reason"] == "OVERLAPPING_PARTITION_RANGES"


def test_an_empty_partition_without_time_bounds_never_serves_every_window(tmp_path):
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=0,
                  event_ns_min=None, event_ns_max=None),
    ])

    result = _discover(root, from_ns=str(BASE + 20 * DAY), to_ns=str(BASE + 21 * DAY))

    assert result["partitions"] == []
    assert result["selection"]["partitions"] == 0


@pytest.mark.parametrize(
    "minimum,maximum,reason",
    [
        (None, None, "NONEMPTY_PARTITION_MISSING_EVENT_RANGE"),
        (BASE + 2, BASE + 1, "INVALID_PARTITION_EVENT_RANGE"),
    ],
)
def test_nonempty_partitions_need_a_valid_time_range(tmp_path, minimum, maximum, reason):
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=1,
                  event_ns_min=minimum, event_ns_max=maximum),
    ])

    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root)

    assert raised.value.code == aq.CATALOG_INTEGRITY_FAILURE
    assert raised.value.detail["reason"] == reason


@pytest.mark.parametrize(
    "field,value,reason",
    [
        ("record_count", -1, "INVALID_PARTITION_RECORD_COUNT"),
        ("part_count", 0, "INVALID_PARTITION_PART_COUNT"),
        ("manifest_sha256", "not-a-sha", "INVALID_PARTITION_MANIFEST_HASH"),
        ("s3_prefix", "databento/../escape", "INVALID_PARTITION_S3_PREFIX"),
    ],
)
def test_a_hash_valid_catalog_still_needs_semantically_usable_partition_metadata(field, value, reason):
    row = {
        "date": "2025-09-01", "record_count": 1, "part_count": 1,
        "manifest_sha256": "a" * 64, "s3_prefix": "databento/safe",
        "event_ns_min": BASE, "event_ns_max": BASE + 1,
    }
    row[field] = value

    with pytest.raises(aq.ArchiveQueryError) as raised:
        aq._assert_usable_metadata([row])

    assert raised.value.code == aq.CATALOG_INTEGRITY_FAILURE
    assert raised.value.detail["reason"] == reason


def test_an_unknown_instrument_is_distinguished_from_an_empty_window(tmp_path):
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + 1),
    ])

    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root, instrument_id=OTHER)
    assert raised.value.code == aq.UNKNOWN_INSTRUMENT

    empty = _discover(root, from_ns=str(BASE + 10 * DAY), to_ns=str(BASE + 11 * DAY))
    assert empty["partitions"] == []
    assert empty["selection"]["partitions"] == 0


def test_an_unsupported_family_is_refused_before_the_catalog_is_opened(tmp_path):
    with pytest.raises(aq.ArchiveQueryError) as raised:
        aq.discover(str(tmp_path / "nonexistent"), instrument_id=IID, family="orderbook",
                    from_ns=str(BASE), to_ns=str(BASE + 1), curated_prefix=CURATED_PREFIX)
    assert raised.value.code == aq.UNSUPPORTED_FAMILY


def test_discovery_cannot_accept_a_caller_supplied_unverified_catalog(tmp_path):
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=10,
                  event_ns_min=BASE, event_ns_max=BASE + 1),
    ])

    with pytest.raises(TypeError):
        _discover(root, snapshot={"pointer": {}, "partitions": []})


@pytest.mark.parametrize("value", [BASE, 1.5, None, "", "0012", "abc", "١٢", "1" * 21])
def test_a_timestamp_that_is_not_an_exact_decimal_string_is_refused(tmp_path, value):
    # An int is refused too: nanoseconds exceed 2^53, so a caller that arrived
    # here with a JSON number has already lost precision and must not look valid.
    root = _catalog_with(tmp_path, [
        _manifest(IID, "trade", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + 1),
    ])

    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root, from_ns=value)
    assert raised.value.code == aq.INVALID_WINDOW


def test_the_estimate_uses_the_measured_per_family_rate_and_flags_the_unmeasured_one():
    assert aq.estimated_bytes("quote", 1_000_000) == 49_000_000
    assert aq.estimated_bytes("trade", 1_000_000) == 60_000_000
    assert aq.estimated_bytes("candle", 1_000_000) == 59_000_000
    assert "depth" in aq.UNVERIFIED_BYTES_PER_ROW, "no depth partition has ever been published"


def test_every_derived_family_is_estimated_from_its_own_measurement():
    # Each was measured on the production archive (the six largest partitions of
    # the family). Sharing trade's rate would be a guess, and the level family
    # is less than half of it while the minute family is more than half again.
    assert aq.estimated_bytes("trade_minute_1m", 1_000) == 99_000
    assert aq.estimated_bytes("trade_level_1m", 1_000) == 47_000
    assert aq.estimated_bytes("trade_slice_2s", 1_000) == 70_000
    assert aq.estimated_bytes("trade_prints_1m", 1_000) == 60_000
    assert not set(aq.DERIVED_WIRE_FIELDS) & aq.UNVERIFIED_BYTES_PER_ROW


@pytest.mark.parametrize("family", sorted(aq.DERIVED_WIRE_FIELDS))
def test_a_derived_family_declares_its_wire_fields_and_the_others_declare_none(family):
    fields = aq.wire_fields(family)
    assert fields is not None and fields[0] == "event_ns"
    assert "record_id" not in fields and "instrument_id" not in fields
    assert aq.wire_fields("trade") is None and aq.wire_fields("candle") is None


def test_an_over_long_depth_window_is_refused_for_its_window_not_its_estimate(tmp_path):
    # depth is the one family with both an uncalibrated estimate and a window
    # cap, so it is the only place the two refusals can be confused. The window
    # check runs first by design -- it needs no catalog at all -- and a caller
    # narrows its window for one and cannot act on the other, so the precedence
    # is the behaviour, not an implementation detail.
    root = _catalog_with(tmp_path, [
        _manifest(IID, "depth", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + 1),
    ])

    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root, family="depth", to_ns=str(BASE + 2 * DAY))

    assert raised.value.code == aq.WINDOW_TOO_LARGE
    assert raised.value.detail["maxWindowNs"] == str(aq.WINDOW_LIMIT_NS["depth"])


@pytest.mark.parametrize("limit,expected", [
    (None, aq.DEFAULT_LIMIT), (1, 1), (aq.MAX_LIMIT, aq.MAX_LIMIT),
])
def test_a_page_limit_inside_the_contract_is_accepted(limit, expected):
    assert aq.resolve_limit(limit) == expected


@pytest.mark.parametrize("limit", [0, -1, aq.MAX_LIMIT + 1, True, False, 1.0, "1000"])
def test_a_page_limit_outside_the_contract_is_refused(limit):
    # Booleans are ints in Python, so `limit=True` would otherwise pass the range
    # check and silently page one row at a time.
    with pytest.raises(aq.ArchiveQueryError) as raised:
        aq.resolve_limit(limit)
    assert raised.value.code == aq.INVALID_WINDOW


def test_unmeasured_depth_is_refused_before_a_future_part_can_be_fetched(tmp_path):
    root = _catalog_with(tmp_path, [
        _manifest(IID, "depth", "2025-09-01", records=10, event_ns_min=BASE, event_ns_max=BASE + 1),
    ])

    with pytest.raises(aq.ArchiveQueryError) as raised:
        _discover(root, family="depth")
    assert raised.value.code == aq.ESTIMATE_UNVERIFIED
    assert _discover(root, family="trade")["estimateVerified"] is True
