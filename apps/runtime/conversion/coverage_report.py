from __future__ import annotations

import csv
import datetime as _dt
import decimal
import glob
import gzip
import json
import os
import sqlite3

import catalog as _catalog
import checkpoint as _ckpt
import identity as _identity
import s3_publish as _s3_publish

SCHEMA_VERSION = "coverage-report/1"

PUBLISHED = "PUBLISHED"
MARKET_CLOSED = "MARKET_CLOSED"
QUIET = "QUIET"
MISSING = "MISSING"
QUARANTINED = "QUARANTINED"
FAILED = "FAILED"
CORRUPT = "CORRUPT"
UNKNOWN = "UNKNOWN"

STATES = (PUBLISHED, MARKET_CLOSED, QUIET, MISSING, QUARANTINED, FAILED, CORRUPT, UNKNOWN)

VERIFY_NONE = "NONE"
VERIFY_FULL = "FULL"
VERIFY_SAMPLE = "SAMPLE"
NOT_REQUESTED = "NOT_REQUESTED"
NOT_SAMPLED = "NOT_SAMPLED"
VERIFIED_OK = "OK"
MANIFEST_ABSENT = "MANIFEST_ABSENT"

MODELLED_FAMILIES = ("candle", "candle_1m", "candle_1h", "candle_1d", "trade", "quote", "depth",
                     "trade_minute_1m", "trade_level_1m", "trade_slice_2s", "trade_prints_1m")
DEPTH_UNAVAILABLE_REASON = "NO_DEPTH_PARTITIONS_PUBLISHED"
NO_CONTINUITY_REASON = "NO_CONTINUITY_EVIDENCE"
CONTINUITY_GAPS_REASON = "CONTINUITY_GAPS_SUSPECTED"
ALL_DEPTH_CORRUPT_REASON = "ALL_DEPTH_PARTITIONS_CORRUPT"
CONTINUITY_SOUND_STATES = frozenset({"OK", "RESET"})

_STATUS_COLUMNS = (
    "ts_recv", "ts_event", "rtype", "publisher_id", "instrument_id", "action",
    "reason", "trading_event", "is_trading", "is_quoting", "is_short_sell_restricted",
)
_STATISTICS_COLUMNS = (
    "ts_recv", "ts_event", "rtype", "publisher_id", "instrument_id", "ts_ref", "price",
    "quantity", "sequence", "ts_in_delta", "stat_type", "channel_id", "update_action", "stat_flags",
)

STAT_OPEN = "1"
STAT_SETTLEMENT = "3"
STAT_CLOSE = "11"
UNDEFINED_INT64 = "9223372036854775807"


class CoverageReportError(RuntimeError):
    pass


def _open(path):
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8-sig", newline="")
    return open(path, "rt", encoding="utf-8-sig", newline="")


def _rows(path, columns):
    with _open(path) as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header is None:
            return
        if header != list(columns):
            raise CoverageReportError(f"REFERENCE_CSV_HEADER_MISMATCH:{os.path.basename(path)}")
        for fields in reader:
            if len(fields) != len(columns):
                raise CoverageReportError(f"RAGGED_REFERENCE_ROW:{os.path.basename(path)}")
            yield dict(zip(columns, fields))


def _utc_date(event_ns):
    seconds = int(event_ns) // 1_000_000_000
    return _dt.datetime.fromtimestamp(seconds, tz=_dt.timezone.utc).strftime("%Y-%m-%d")


def _month_of(date):
    return date[:7]


def _dates_in_month(month):
    year, month_number = (int(part) for part in month.split("-"))
    day = _dt.date(year, month_number, 1)
    out = []
    while day.month == month_number:
        out.append(day.isoformat())
        day += _dt.timedelta(days=1)
    return out


def _decimal_from_fixed9(value):
    if value in ("", None) or value == UNDEFINED_INT64:
        return None
    sign = "-" if value.startswith("-") else ""
    digits = value.lstrip("-").rjust(10, "0")
    whole, fraction = digits[:-9], digits[-9:].rstrip("0")
    return f"{sign}{whole}.{fraction}" if fraction else f"{sign}{whole}"


def read_catalog(catalog_root):
    pointer = _catalog.read_current(catalog_root)
    if not pointer:
        raise CoverageReportError("NO_CURRENT_POINTER")
    path = os.path.join(os.fspath(catalog_root), pointer["catalog_key"])
    if not os.path.isfile(path):
        raise CoverageReportError(f"CATALOG_SNAPSHOT_MISSING:{pointer['catalog_key']}")
    if _catalog._sha256_file(path) != pointer["catalog_sha256"]:
        raise CoverageReportError("CATALOG_INTEGRITY_FAILURE")
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        connection.row_factory = sqlite3.Row
        partitions = [dict(row) for row in connection.execute(
            "SELECT * FROM partitions ORDER BY instrument_id, family, dataset_version, date")]
        versions = {row["dataset_version"]: dict(row) for row in connection.execute(
            "SELECT * FROM dataset_versions")}
        continuity = [dict(row) for row in connection.execute("SELECT * FROM continuity")]
    finally:
        connection.close()
    return {"pointer": pointer, "partitions": partitions, "dataset_versions": versions,
            "continuity": continuity}


def _venue_of_path(path):
    parts = dict(p.split("=", 1) for p in path.replace("\\", "/").split("/") if "=" in p)
    base = _identity._DATASET_INSTRUMENT.get(parts.get("dataset"))
    return base["venue"] if base else None


def read_status_sessions(reference_root, symbol=None):
    """Trading sessions per venue and UTC date, plus the months the status objects
    actually cover. Venue matters: CME trades Sunday evenings and Nasdaq does not,
    so merging both calendars reported every Sunday as a missing equity day."""
    pattern = os.path.join(os.fspath(reference_root), "status", "**", "*.csv")
    sessions, months = {}, set()
    for path in sorted(glob.glob(pattern, recursive=True)):
        if symbol is not None and f"symbol={symbol}" not in path.replace("\\", "/"):
            continue
        venue = _venue_of_path(path)
        covered = None
        for row in _rows(path, _STATUS_COLUMNS):
            date = _utc_date(row["ts_event"])
            covered = covered or _month_of(date)
            key = (venue, date)
            sessions[key] = sessions.get(key, False) or row["is_trading"] == "Y"
            months.add((venue, _month_of(date)))
        if covered is None:
            months.add((venue, _month_from_path(path)))
    return {"sessions": sessions, "covered_months": months}


def _identity_fields(instrument_id):
    try:
        parsed = json.loads(instrument_id)
    except (TypeError, ValueError):
        return None, None
    if not isinstance(parsed, list) or len(parsed) < 2:
        return None, None
    return parsed[0], parsed[1]


def _market_of(instrument_id):
    return _identity_fields(instrument_id)[1]


def _venue_of(instrument_id):
    return _identity_fields(instrument_id)[0]


def _symbol_of(instrument_id):
    try:
        parsed = json.loads(instrument_id)
    except (TypeError, ValueError):
        return None
    return parsed[2] if isinstance(parsed, list) and len(parsed) >= 3 else None


def _expected_dates(instrument_id, published_dates, covered_months):
    """Which dates an instrument is even eligible for. A futures contract is only
    the front month for part of its life, so outside its own published span it is
    not applicable rather than missing -- enumerating whole months there reported
    330 false gaps against the OHLCV catalog. Anything else trades every session
    the venue holds, so a covered month enumerates in full."""
    months = sorted({_month_of(date) for date in published_dates} & covered_months)
    enumerated = {date for month in months for date in _dates_in_month(month)}
    if _market_of(instrument_id) == "FUTURE" and published_dates:
        first, last = min(published_dates), max(published_dates)
        enumerated = {date for date in enumerated if first <= date <= last}
    return enumerated


def _month_from_path(path):
    parts = dict(p.split("=", 1) for p in path.replace("\\", "/").split("/") if "=" in p)
    year, month = parts.get("year"), parts.get("month")
    return f"{year}-{month}" if year and month else None


def read_statistics(reference_root, symbol=None):
    pattern = os.path.join(os.fspath(reference_root), "statistics", "**", "*.csv")
    by_date = {}
    for path in sorted(glob.glob(pattern, recursive=True)):
        if symbol is not None and f"symbol={symbol}" not in path.replace("\\", "/"):
            continue
        for row in _rows(path, _STATISTICS_COLUMNS):
            date = _utc_date(row["ts_event"])
            by_date.setdefault((row["instrument_id"], date), {})[row["stat_type"]] = {
                "price": _decimal_from_fixed9(row["price"]),
                "quantity": None if row["quantity"] == UNDEFINED_INT64 else row["quantity"],
            }
    return by_date


def _checkpoint_paths(staging_root):
    """A job stage sits directly under the staging root when backfill_driver is
    driven per job, and one level deeper when backfill_sequence drives it, since
    that passes `staging_root/<version>` down. Both layouts are live on the host,
    so matching only one silently reads no checkpoint at all."""
    root = os.fspath(staging_root)
    found = set(glob.glob(os.path.join(root, "*", "checkpoint.json")))
    found.update(glob.glob(os.path.join(root, "*", "*", "checkpoint.json")))
    return sorted(found)


def read_outstanding(staging_root):
    """Partial-month receipts, durable quarantined dates and the authority plan --
    the reconciliation the operator still owes, distinct from anything the catalog
    knows about. Quarantine is attributed to an instrument only on evidence: a
    receipt names its raw symbol, a checkpoint names the instruments in its own
    plan. An entry that matches neither is reported at the top level and left
    unattributed rather than guessed onto every instrument in the catalog. Plan
    entries outside the job's own month are boundary artefacts rather than work
    it owed, so they are not carried as planned; the instruments they name still
    count, because quarantine attribution must not narrow."""
    partial, quarantined, by_instrument, planned = [], {}, {}, set()
    sequence = os.path.join(os.fspath(staging_root), "_sequence")
    for path in sorted(glob.glob(os.path.join(sequence, "*-partial.json"))):
        with open(path, encoding="utf-8") as handle:
            receipt = json.load(handle)
        partial.append(receipt)
        for entry in receipt.get("quarantined_dates", []):
            quarantined[(receipt.get("symbol"), entry["date"])] = {
                "version": receipt.get("version"), "evidence": entry.get("evidence"),
                "evidence_sha256": entry.get("evidence_sha256"), "error": entry.get("error"),
            }
    for path in _checkpoint_paths(staging_root):
        with open(path, encoding="utf-8") as handle:
            checkpoint = json.load(handle)
        instruments = {plan["instrument_id"] for plan in checkpoint.get("authority_plan", [])}
        for plan in _ckpt.planned_in_scope(checkpoint):
            planned.add((plan["instrument_id"], plan["family"], plan["date"]))
        for entry in checkpoint.get("quarantined_dates", []):
            record = {
                "version": checkpoint.get("dataset_version"), "evidence": entry.get("evidence"),
                "evidence_sha256": entry.get("evidence_sha256"), "error": entry.get("error"),
            }
            quarantined.setdefault((None, entry["date"]), record)
            for instrument_id in instruments:
                by_instrument.setdefault((instrument_id, entry["date"]), record)
    return {"partial_months": partial, "quarantined": quarantined,
            "quarantined_instruments": by_instrument, "planned": planned}


def _no_outstanding():
    return {"partial_months": [], "quarantined": {}, "quarantined_instruments": {}, "planned": set()}


def _quarantine_for(outstanding, instrument_id, date):
    attributed = outstanding["quarantined_instruments"].get((instrument_id, date))
    if attributed is not None:
        return attributed
    return outstanding["quarantined"].get((_symbol_of(instrument_id), date))


def sample_partitions(partitions, limit):
    """Spread a partial sweep across the whole sorted population. The list is
    ordered by instrument, family, version then date, so a head slice only ever
    checks the first instrument's earliest days and corruption anywhere later is
    invisible. A fixed stride is deterministic and still reaches every
    instrument."""
    if limit is None or limit >= len(partitions):
        return list(partitions)
    if limit <= 0:
        return []
    stride = len(partitions) / limit
    return [partitions[int(index * stride)] for index in range(limit)]


def verify_partitions(store, partitions, limit=None):
    """Prove each catalogued partition is really in S3 and intact, and recover the
    raw objects it came from. Reuses s3_publish.verify_remote_partition, which
    already checks the manifest hash, the validation flags, the row-count
    reconciliation and every part -- a partition that fails any of those must
    never be advertised as coverage. Re-reading the manifest after verification
    opens no window: s3_publish writes it with IfNoneMatch="*", so a published
    manifest can never change under us."""
    results = {}
    for row in sample_partitions(partitions, limit):
        key = (row["instrument_id"], row["family"], row["date"])
        prefix = row["s3_prefix"]
        try:
            _s3_publish.verify_remote_partition(store, prefix, row["manifest_sha256"])
        except _s3_publish.PublicationError as error:
            results[key] = {"result": str(error), "source_objects": None}
            continue
        except Exception as error:
            if _s3_publish._status(error) == 404:
                results[key] = {"result": MANIFEST_ABSENT, "source_objects": None}
                continue
            raise
        manifest, _etag = store.get_json(prefix + "/_manifest.json")
        results[key] = {"result": VERIFIED_OK,
                        "source_objects": (manifest or {}).get("source_objects")}
    return results


def classify_date(*, published, record_count, session, month_covered, quarantined, planned):
    """Inside a month a status object covers, a date with no trading session --
    whether that is rows saying is_trading=N or no rows at all -- is a closure.
    Verified on AAPL 2025-09: four rows on every trading day, none on Labor Day
    or a weekend. UNKNOWN is reserved for a month no status object covers, so an
    absent reference is never reported as a closed market. A date the job itself
    planned outranks both: the plan is built from raw inputs actually discovered,
    so an unpublished planned date is a failure, never a closure and never
    unknown."""
    if quarantined:
        return QUARANTINED
    if published:
        return QUIET if record_count == 0 else PUBLISHED
    if planned:
        return FAILED
    if not month_covered:
        return UNKNOWN
    if not session:
        return MARKET_CLOSED
    return MISSING


def capability(partitions_by_family, corrupt=frozenset(), continuity=()):
    """What the archive can actually answer for one instrument. A partition that
    failed verification is not coverage: demoting its calendar entry to CORRUPT
    while still counting it here would advertise the same bad data through the
    field queries read first."""
    result = {}
    for family in MODELLED_FAMILIES:
        entries = partitions_by_family.get(family, [])
        sound = [e for e in entries if (e["instrument_id"], family, e["date"]) not in corrupt]
        broken = len(entries) - len(sound)
        if sound:
            result[family] = {
                "available": True,
                "dates": len(sound),
                "records": sum(int(e["record_count"]) for e in sound),
                "corrupt": broken,
            }
        elif family == "depth":
            result[family] = {
                "available": UNKNOWN,
                "reason": ALL_DEPTH_CORRUPT_REASON if broken else DEPTH_UNAVAILABLE_REASON,
                "corrupt": broken,
            }
        else:
            result[family] = {"available": False, "dates": 0, "records": 0, "corrupt": broken}
    result["book_reconstructable"] = _book_reconstructable(
        result["depth"]["available"] is True, continuity)
    return result


def _book_reconstructable(has_sound_depth, continuity):
    """Depth partitions existing is not the same as a book that replays. The
    claim needs the continuity table's own verdict for the instrument; without
    rows there is no evidence either way, and a suspected gap means messages may
    be missing, so the book cannot be faithfully rebuilt."""
    if not has_sound_depth:
        return {"available": UNKNOWN, "reason": DEPTH_UNAVAILABLE_REASON}
    rows = [row for row in continuity if row["family"] == "depth"]
    if not rows:
        return {"available": UNKNOWN, "reason": NO_CONTINUITY_REASON}
    suspected = sum(int(row["suspected_gaps"]) for row in rows)
    unsound = [row for row in rows if row["state"] not in CONTINUITY_SOUND_STATES]
    if suspected or unsound:
        return {"available": False, "reason": CONTINUITY_GAPS_REASON,
                "suspected_gaps": suspected, "epochs": len(rows)}
    return {"available": True, "epochs": len(rows),
            "observed_resets": sum(int(row["observed_resets"]) for row in rows)}


def reconcile_prices(statistics, observed):
    """Session open/close against the provider's own statistics. Converted volume
    is deliberately not compared: measured against AAPL 2025-09 it runs
    3.19-4.01x statistics stat_type=11 quantity with a varying ratio, so the two
    measure different populations and any equality assertion there is false."""
    checks = []
    for (_source_id, date), stats in sorted(statistics.items()):
        seen = observed.get(date)
        if seen is None:
            continue
        for stat_type, label, value in (
            (STAT_OPEN, "open", seen.get("first_price")),
            (STAT_CLOSE, "close", seen.get("last_price")),
            (STAT_SETTLEMENT, "settlement", seen.get("last_price")),
        ):
            reference = stats.get(stat_type)
            if reference is None or reference["price"] is None:
                continue
            equal = _price_equal(value, reference["price"])
            checks.append({
                "date": date, "stat_type": stat_type, "label": label,
                "reference_price": reference["price"],
                "observed_price": value,
                "result": UNKNOWN if equal is None else ("MATCH" if equal else "DIFFERS"),
            })
    return checks


def _price_equal(observed, reference):
    """229.49 and 229.490 are the same price. String equality called them a
    mismatch, which would report a clean archive as diverging from the provider."""
    if observed is None:
        return None
    try:
        return decimal.Decimal(str(observed)) == decimal.Decimal(reference)
    except (decimal.InvalidOperation, ArithmeticError, ValueError, TypeError):
        return None


def build(*, catalog_root, reference_root, staging_root=None, symbol=None, observed_prices=None,
          generated_at=None, store=None, verify_limit=None):
    if observed_prices and symbol is None:
        raise CoverageReportError("PRICE_RECONCILIATION_REQUIRES_SYMBOL")
    snapshot = read_catalog(catalog_root)
    verified = verify_partitions(store, snapshot["partitions"], verify_limit) if store else {}
    corrupt = {key for key, check in verified.items() if check["result"] != VERIFIED_OK}
    status = read_status_sessions(reference_root, symbol=symbol)
    statistics = read_statistics(reference_root, symbol=symbol)
    outstanding = read_outstanding(staging_root) if staging_root else _no_outstanding()

    by_instrument = {}
    for row in snapshot["partitions"]:
        by_instrument.setdefault(row["instrument_id"], []).append(row)
    continuity_by_instrument = {}
    for row in snapshot["continuity"]:
        continuity_by_instrument.setdefault(row["instrument_id"], []).append(row)
    planned_by_instrument = {}
    for instrument_id, family, date in outstanding["planned"]:
        planned_by_instrument.setdefault((instrument_id, family), set()).add(date)

    covered_by_venue = {}
    for venue, month in status["covered_months"]:
        covered_by_venue.setdefault(venue, set()).add(month)

    instruments = []
    for instrument_id, rows in sorted(by_instrument.items()):
        families = {}
        for row in rows:
            families.setdefault(row["family"], []).append(row)
        calendar = []
        for family, entries in sorted(families.items()):
            published = {row["date"]: row for row in entries}
            covered_months = covered_by_venue.get(_venue_of(instrument_id), set())
            planned_dates = planned_by_instrument.get((instrument_id, family), set())
            candidate_dates = sorted(
                set(published) | planned_dates
                | _expected_dates(instrument_id, set(published), covered_months))
            for date in candidate_dates:
                row = published.get(date)
                quarantine = _quarantine_for(outstanding, instrument_id, date)
                state = classify_date(
                    published=row is not None,
                    record_count=int(row["record_count"]) if row else 0,
                    session=status["sessions"].get((_venue_of(instrument_id), date)),
                    month_covered=_month_of(date) in covered_months,
                    quarantined=quarantine is not None,
                    planned=date in planned_dates,
                )
                entry = {"date": date, "family": family, "state": state}
                if row is not None and state in (PUBLISHED, QUIET):
                    check = verified.get((instrument_id, family, date))
                    entry["verification"] = check["result"] if check else (
                        NOT_REQUESTED if store is None else NOT_SAMPLED)
                    if check and check["result"] != VERIFIED_OK:
                        entry["state"] = state = CORRUPT
                    if check and check["source_objects"] is not None:
                        entry["source_objects"] = check["source_objects"]
                if row is not None:
                    entry.update({
                        "record_count": int(row["record_count"]),
                        "rejected_count": int(row["rejected_count"]),
                        "dataset_version": row["dataset_version"],
                        "logical_sha256": row["logical_sha256"],
                        "manifest_sha256": row["manifest_sha256"],
                        "converter_version": snapshot["dataset_versions"].get(
                            row["dataset_version"], {}).get("converter_version"),
                        "contract_version": snapshot["dataset_versions"].get(
                            row["dataset_version"], {}).get("contract_version"),
                    })
                if quarantine is not None:
                    entry["quarantine"] = quarantine
                calendar.append(entry)
        newest = max((int(r["event_ns_max"]) for r in rows
                      if r["event_ns_max"] is not None
                      and (instrument_id, r["family"], r["date"]) not in corrupt), default=None)
        instruments.append({
            "instrument_id": instrument_id,
            "capability": capability(families, corrupt,
                                     continuity_by_instrument.get(instrument_id, [])),
            "freshness": {"newest_event_ns": newest,
                          "newest_event_date": _utc_date(newest) if newest is not None else None},
            "calendar": sorted(calendar, key=lambda e: (e["date"], e["family"])),
        })

    checks = reconcile_prices(statistics, observed_prices or {})

    failures = sorted(
        [{"instrument_id": k[0], "family": k[1], "date": k[2], "result": v["result"]}
         for k, v in verified.items() if v["result"] != VERIFIED_OK],
        key=lambda e: (e["instrument_id"], e["family"], e["date"]))
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "pointer": snapshot["pointer"],
        "verification": {
            "mode": VERIFY_NONE if store is None else (
                VERIFY_SAMPLE if len(verified) < len(snapshot["partitions"]) else VERIFY_FULL),
            "partitions_checked": len(verified),
            "partitions_catalogued": len(snapshot["partitions"]),
            "failures": failures,
        },
        "instruments": instruments,
        "price_reconciliation": checks,
        "outstanding": {
            "partial_months": outstanding["partial_months"],
            "quarantined_dates": sorted(
                [{"symbol": s, "date": d, **v} for (s, d), v in outstanding["quarantined"].items()],
                key=lambda e: (str(e["symbol"]), e["date"])),
        },
        "totals": summarise(instruments),
    }


def summarise(instruments):
    counts = {state: 0 for state in STATES}
    for instrument in instruments:
        for entry in instrument["calendar"]:
            counts[entry["state"]] += 1
    return {"instruments": len(instruments), "states": counts}
