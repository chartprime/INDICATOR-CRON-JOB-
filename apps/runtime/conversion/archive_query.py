from __future__ import annotations

import re

import coverage_report as _coverage_report

FAMILIES = ("candle", "candle_1m", "candle_1h", "candle_1d", "trade", "quote", "depth",
            "trade_minute_1m", "trade_level_1m", "trade_slice_2s", "trade_prints_1m")

_DAY_NS = 86_400_000_000_000

WINDOW_LIMIT_NS = {
    "candle": 31 * _DAY_NS,
    "candle_1m": 400 * _DAY_NS,
    "candle_1h": 1825 * _DAY_NS,
    "candle_1d": 9125 * _DAY_NS,
    "trade": 7 * _DAY_NS,
    "quote": _DAY_NS,
    "depth": _DAY_NS,
    "trade_minute_1m": 31 * _DAY_NS,
    "trade_level_1m": 7 * _DAY_NS,
    "trade_slice_2s": 7 * _DAY_NS,
    "trade_prints_1m": 31 * _DAY_NS,
}

BYTES_PER_ROW = {
    "candle": 59,
    "candle_1m": 59,
    "candle_1h": 59,
    "candle_1d": 59,
    "trade": 60,
    "quote": 49,
    "depth": 600,
    "trade_minute_1m": 99,
    "trade_level_1m": 47,
    "trade_slice_2s": 70,
    "trade_prints_1m": 60,
}

UNVERIFIED_BYTES_PER_ROW = frozenset({"depth"})

CANDLE_FAMILIES = frozenset({"candle", "candle_1m", "candle_1h", "candle_1d"})

CANDLE_SOURCE_METRIC_FIELDS = (
    "quote_volume", "taker_buy_quote_volume", "taker_sell_base_volume",
    "taker_sell_quote_volume", "trade_count",
)

DERIVED_WIRE_FIELDS = {
    "trade_minute_1m": ("event_ns", "open_ns", "close_ns", "volume", "buy_volume", "sell_volume",
                        "undefined_volume", "buy_notional", "sell_notional", "trade_count", "method"),
    "trade_level_1m": ("event_ns", "open_ns", "close_ns", "tick_size", "price_bucket",
                       "volume", "buy_volume", "sell_volume", "trade_count", "method"),
    "trade_slice_2s": ("event_ns", "open_ns", "close_ns", "last_trade_ns",
                       "buy_notional", "sell_notional", "trade_count", "method"),
    "trade_prints_1m": ("event_ns", "open_ns", "close_ns", "side", "rank", "trade_ns",
                        "price", "size", "trade_entity_id", "method"),
}


def wire_fields(family):
    """The columns a family puts on the wire, or None for every column.

    A partition carries the full common envelope -- 31 identity, lineage and
    quality columns -- because on disk that is what makes a row self-describing.
    A consumer of a derived aggregate needs none of it: the request already names
    the instrument, and the catalog already vouches for the lineage. Serving the
    whole envelope costs about four times the bytes of the payload itself, on
    families whose whole purpose is to be cheap to read over a slow link. The
    families that existed before this declaration keep every column, so nothing
    that reads them today sees a different shape."""
    return DERIVED_WIRE_FIELDS.get(family)


def with_declared_candle_fields(family, rows):
    """Present every declared candle field, including on partitions written
    before those fields existed.

    A row is built from the columns its own parquet file happens to carry, so a
    partition published earlier yields rows with these keys simply absent. The
    contract declares them required-and-nullable, and the difference matters: a
    consumer reading an absent field gets `undefined` and computes silently
    wrong arithmetic, where `null` is a value it has to handle. Filling them in
    here keeps the wire shape independent of when a partition was written."""
    if family not in CANDLE_FAMILIES:
        return rows
    filled = []
    for row in rows:
        missing = {field: None for field in CANDLE_SOURCE_METRIC_FIELDS if field not in row}
        filled.append({**row, **missing} if missing else row)
    return filled

MAX_SCAN_BYTES = 268_435_456

DEFAULT_LIMIT = 1000
MAX_LIMIT = 10000

INVALID_WINDOW = "INVALID_WINDOW"
UNKNOWN_INSTRUMENT = "UNKNOWN_INSTRUMENT"
UNSUPPORTED_FAMILY = "UNSUPPORTED_FAMILY"
RANGE_TOO_LARGE = "RANGE_TOO_LARGE"
WINDOW_TOO_LARGE = "WINDOW_TOO_LARGE"
CATALOG_INTEGRITY_FAILURE = "CATALOG_INTEGRITY_FAILURE"
ESTIMATE_UNVERIFIED = "ESTIMATE_UNVERIFIED"


class ArchiveQueryError(RuntimeError):
    """Carries the contract's error code plus the fields that code promises, so a
    caller can act on a refusal instead of re-deriving why it happened."""

    def __init__(self, code, **detail):
        super().__init__(code if not detail else f"{code}:{detail}")
        self.code = code
        self.detail = detail


def _event_ns(value, field):
    """Epoch nanoseconds arrive as decimal strings because they exceed 2^53 and a
    JSON number would silently lose precision. Accepting an int here would let a
    caller that had already lost precision look correct."""
    if not isinstance(value, str) or re.fullmatch(r"[0-9]+", value) is None:
        raise ArchiveQueryError(INVALID_WINDOW, field=field)
    if len(value) > 1 and value[0] == "0":
        raise ArchiveQueryError(INVALID_WINDOW, field=field)
    if len(value) > 20:
        raise ArchiveQueryError(INVALID_WINDOW, field=field)
    return int(value)


def resolve_limit(limit):
    if limit is None:
        return DEFAULT_LIMIT
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIMIT:
        raise ArchiveQueryError(INVALID_WINDOW, field="limit")
    return limit


def estimated_bytes(family, record_count):
    """Rows to bytes, from the only fields the catalog actually carries. The
    partitions table records record_count and part_count but no byte size, so a
    scan estimate has to come from a measured per-family rate rather than being
    read off. Calibrated against published manifests: quote holds within 3% of
    its median, candle 8%, trade 21%, and each rate here is that family's
    measured maximum so the estimate errs high -- an admission bound that
    under-estimates is worse than one that refuses a borderline request."""
    return record_count * BYTES_PER_ROW[family]


PROVIDER_ROOT_SEGMENT = {"databento": "databento", "binance": "binance"}
LEGACY_PROVIDER = "databento"


def partition_provider(provider):
    return LEGACY_PROVIDER if provider is None else provider


def partition_key(curated_prefix, s3_prefix, provider=None):
    """Where a partition's bytes actually live.

    `curated_prefix` is the bucket root and carries no provider. The provider
    comes from the catalog row, with only legacy rows defaulting to Databento.
    A caller never supplies it.

    Databento's published keys carry the provider twice -- verified against the
    live bucket -- because the prefix used to end with it and the stored prefix
    begins with it. That doubling is where 1,144 published dates are, so the map
    reproduces it rather than correcting it; moving objects to tidy a path is
    not worth a migration. Binance was never published under the old prefix and
    carries its provider twice for the same historical reason. Both layouts are
    established immutable object identities, not path-normalisation mistakes a
    reader may silently correct.

    An unrecognised provider is refused. Defaulting one would silently resolve a
    partition to a key that does not exist and report it as absent data."""
    return "/".join(part for part in (curated_prefix.rstrip("/"), partition_relative(s3_prefix, provider)) if part)


def partition_relative(s3_prefix, provider=None):
    """The partition's path below the bucket root, provider segment included.

    Every route to a partition's bytes has to agree on this or the manifest key
    and the part keys address different objects. `archive_cache` already refuses
    that disagreement outright, so the segment is computed here once and used by
    all of them rather than being spelled out per call site."""
    relative = s3_prefix.lstrip("/")
    provider = partition_provider(provider)
    segment = PROVIDER_ROOT_SEGMENT.get(provider)
    if segment is None:
        raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                reason="UNSUPPORTED_PARTITION_PROVIDER",
                                provider=provider, supported=sorted(PROVIDER_ROOT_SEGMENT))
    if not relative.startswith(provider + "/"):
        raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                reason="PARTITION_PROVIDER_PREFIX_MISMATCH",
                                provider=provider, s3Prefix=relative)
    return "/".join(part for part in (segment, relative) if part)


def _overlaps(row, from_ns, to_ns):
    """Half-open [from, to) against validated inclusive event bounds. A
    partition ending exactly at `from` still holds that row; one beginning
    exactly at `to` does not."""
    minimum, maximum = row["event_ns_min"], row["event_ns_max"]
    return minimum < to_ns and maximum >= from_ns


def _sort_key(row):
    return (row["event_ns_min"], row["date"], row["dataset_version"])


def _assert_usable_metadata(rows):
    """A non-empty partition without an ordered time range cannot be pruned,
    ordered, or proven non-overlapping. Refusing it is safer than treating it
    as every window, which used to make discovery crash while building served
    coverage. Empty partitions contain no rows and therefore never serve a
    query; Step 7 will report their coverage state separately."""
    usable = []
    for row in rows:
        count = row["record_count"]
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                    reason="INVALID_PARTITION_RECORD_COUNT",
                                    date=row["date"])
        part_count = row["part_count"]
        if (not isinstance(part_count, int) or isinstance(part_count, bool)
                or part_count < 0 or (count > 0 and part_count == 0)):
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                    reason="INVALID_PARTITION_PART_COUNT",
                                    date=row["date"])
        manifest_sha256 = row["manifest_sha256"]
        if not isinstance(manifest_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                    reason="INVALID_PARTITION_MANIFEST_HASH",
                                    date=row["date"])
        prefix = row["s3_prefix"]
        if (not isinstance(prefix, str) or not prefix
                or any(not segment or segment in (".", "..") or "\\" in segment
                       for segment in prefix.split("/"))):
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                    reason="INVALID_PARTITION_S3_PREFIX",
                                    date=row["date"])
        provider = partition_provider(row.get("provider"))
        partition_relative(prefix, provider)
        if count == 0:
            continue
        minimum, maximum = row["event_ns_min"], row["event_ns_max"]
        if (not isinstance(minimum, int) or isinstance(minimum, bool)
                or not isinstance(maximum, int) or isinstance(maximum, bool)):
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                    reason="NONEMPTY_PARTITION_MISSING_EVENT_RANGE",
                                    date=row["date"])
        if minimum > maximum:
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                    reason="INVALID_PARTITION_EVENT_RANGE",
                                    date=row["date"])
        usable.append(row)
    return usable


def _assert_single_authority(selected):
    """The catalog's primary key is (instrument, family, dataset_version, date),
    so one date may legitimately exist under two dataset versions and two
    partitions may carry overlapping event ranges. Neither is true of the
    archive today -- verified zero of each across 1,418 published partitions --
    but serving both would silently double every row in the overlap, and a
    reprocessed month is exactly how it would arrive. Refuse rather than
    concatenate work the catalog cannot disambiguate."""
    by_date = {}
    for row in selected:
        by_date.setdefault(row["date"], []).append(row["dataset_version"])
    for date, versions in sorted(by_date.items()):
        if len(versions) > 1:
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                    reason="DATE_IN_MULTIPLE_DATASET_VERSIONS",
                                    date=date, dataset_versions=sorted(versions))
    ordered = sorted((r for r in selected if r["event_ns_min"] is not None),
                     key=lambda r: r["event_ns_min"])
    for earlier, later in zip(ordered, ordered[1:]):
        if later["event_ns_min"] <= earlier["event_ns_max"]:
            raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE,
                                    reason="OVERLAPPING_PARTITION_RANGES",
                                    dates=[earlier["date"], later["date"]])


def _validate_request_shape(instrument_id, family, from_ns, to_ns, max_scan_bytes):
    """Reject malformed request shapes before the catalog is opened.

    The public discovery path and the internally pinned path share this check;
    keeping it separate preserves the documented cheapest-first refusal order.
    """
    if family not in FAMILIES:
        raise ArchiveQueryError(UNSUPPORTED_FAMILY, family=family, supported=list(FAMILIES))
    if not isinstance(instrument_id, str) or not 1 <= len(instrument_id) <= 256:
        raise ArchiveQueryError(UNKNOWN_INSTRUMENT, instrumentId=instrument_id)

    start = _event_ns(from_ns, "from")
    end = _event_ns(to_ns, "to")
    if end <= start:
        raise ArchiveQueryError(INVALID_WINDOW, field="to", reason="TO_NOT_AFTER_FROM")

    window_limit = WINDOW_LIMIT_NS[family]
    if end - start > window_limit:
        raise ArchiveQueryError(WINDOW_TOO_LARGE, reason="WINDOW_TOO_LONG", family=family,
                                requestedWindowNs=str(end - start),
                                maxWindowNs=str(window_limit))

    budget = MAX_SCAN_BYTES if max_scan_bytes is None else max_scan_bytes
    if not isinstance(budget, int) or isinstance(budget, bool) or not 1 <= budget <= MAX_SCAN_BYTES:
        raise ArchiveQueryError(INVALID_WINDOW, field="maxScanBytes")
    return start, end, budget


def _discover_verified_snapshot(snapshot, *, instrument_id, family, from_ns, to_ns, curated_prefix,
                                max_scan_bytes=None):
    """Resolve from a server-owned snapshot that was already hash-verified.

    This deliberately remains private. The public :func:`discover` reads and
    verifies CURRENT itself; SnapshotRegistry is the only second caller and
    only returns snapshots it resolved itself. Accepting a caller-supplied
    snapshot here would recreate the catalog-pointer bypass closed in Step 1.

    The window is bounded in time before anything else happens, per family,
    because density differs by nearly two orders of magnitude -- a day of
    candles is 3.5 MB against 491 MB for the busiest measured day of quotes. A
    time bound is exact and knowable before any I/O, where a byte bound is a
    calibrated estimate; `aggressive-history` already bounds the terminal's
    other paged history path the same way, at a day."""
    start, end, budget = _validate_request_shape(
        instrument_id, family, from_ns, to_ns, max_scan_bytes)

    for_instrument = [r for r in snapshot["partitions"] if r["instrument_id"] == instrument_id]
    if not for_instrument:
        raise ArchiveQueryError(UNKNOWN_INSTRUMENT, instrumentId=instrument_id)

    in_family = _assert_usable_metadata(
        [r for r in for_instrument if r["family"] == family])
    selected = sorted((r for r in in_family if _overlaps(r, start, end)), key=_sort_key)
    _assert_single_authority(selected)

    if selected and family in UNVERIFIED_BYTES_PER_ROW:
        raise ArchiveQueryError(ESTIMATE_UNVERIFIED, family=family,
                                reason="NO_CALIBRATED_BYTES_PER_ROW")

    partitions, total = [], 0
    for row in selected:
        size = estimated_bytes(family, row["record_count"])
        total += size
        partitions.append({
            "instrument_id": row["instrument_id"],
            "family": row["family"],
            "provider": partition_provider(row.get("provider")),
            "dataset_version": row["dataset_version"],
            "date": row["date"],
            "s3_prefix": row["s3_prefix"],
            "key_prefix": partition_key(curated_prefix, row["s3_prefix"], row.get("provider")),
            "manifest_key": partition_key(curated_prefix, row["s3_prefix"], row.get("provider")) + "/_manifest.json",
            "manifest_sha256": row["manifest_sha256"],
            "part_count": row["part_count"],
            "record_count": row["record_count"],
            "event_ns_min": str(row["event_ns_min"]) if row["event_ns_min"] is not None else None,
            "event_ns_max": str(row["event_ns_max"]) if row["event_ns_max"] is not None else None,
            "estimated_bytes": size,
        })

    if total > budget:
        raise ArchiveQueryError(RANGE_TOO_LARGE, reason="SCAN_ESTIMATE_EXCEEDS_BUDGET",
                                estimatedScanBytes=total, effectiveMaxScanBytes=budget,
                                partitions=len(partitions))

    return {
        "family": family,
        "pointer": snapshot["pointer"],
        "partitions": partitions,
        "estimatedScanBytes": total,
        "estimateVerified": family not in UNVERIFIED_BYTES_PER_ROW,
        "selection": {
            "requested": {"from": str(start), "to": str(end)},
            "partitions": len(partitions),
        },
    }


def discover(catalog_root, *, instrument_id, family, from_ns, to_ns, curated_prefix,
             max_scan_bytes=None):
    """Resolve a window to the exact partitions that serve it, reading only the
    catalog. No part is fetched and no byte of data is read, so this is the
    cheapest possible place to refuse a request: resolution measured at 0.57 ms
    for one instrument-month against the production catalog."""
    _validate_request_shape(instrument_id, family, from_ns, to_ns, max_scan_bytes)
    try:
        snapshot = _coverage_report.read_catalog(catalog_root)
    except _coverage_report.CoverageReportError as error:
        raise ArchiveQueryError(CATALOG_INTEGRITY_FAILURE, reason=str(error)) from error
    return _discover_verified_snapshot(
        snapshot, instrument_id=instrument_id, family=family, from_ns=from_ns, to_ns=to_ns,
        curated_prefix=curated_prefix, max_scan_bytes=max_scan_bytes)
