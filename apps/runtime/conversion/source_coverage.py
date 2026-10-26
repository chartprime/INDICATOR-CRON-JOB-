from __future__ import annotations

import datetime as _dt

import identity as _identity
import roll_table as _roll_table
import split as _split

_NS_PER_DAY = 86_400 * 1_000_000_000
_EPOCH = _dt.date(1970, 1, 1)


class CoverageError(RuntimeError):
    pass


def cadence_from_s3_key(s3_key):
    if "/day=" in s3_key:
        return "daily"
    if "/month=" in s3_key:
        return "monthly"
    raise CoverageError(f"UNKNOWN_CADENCE:{s3_key}")


def _date_str(ns):
    return _dt.datetime.fromtimestamp(ns // 1_000_000_000, tz=_dt.timezone.utc).strftime("%Y-%m-%d")


def _day_bounds_ns(date_str):
    start = (_dt.date.fromisoformat(date_str) - _EPOCH).days * _NS_PER_DAY
    return start, start + _NS_PER_DAY


def dbn_coverage(metadata, family, raw_symbol):
    instrument = _identity.instrument_for(metadata.dataset, raw_symbol)
    instrument_id = _identity.instrument_id(instrument)
    symbol_partial = raw_symbol in metadata.partial

    date = _dt.date.fromisoformat(_date_str(metadata.start_ns))
    last = _dt.date.fromisoformat(_date_str(max(metadata.start_ns, metadata.end_ns - 1)))
    entries = []
    while date <= last:
        date_str = date.isoformat()
        day_start, day_end = _day_bounds_ns(date_str)
        from_ns = max(day_start, metadata.start_ns)
        to_ns = min(day_end, metadata.end_ns)
        entries.append({
            "instrument_id": instrument_id, "family": family, "date": date_str,
            "from_ns": from_ns, "to_ns": to_ns,
            "complete": (from_ns == day_start and to_ns == day_end and not symbol_partial),
        })
        date += _dt.timedelta(days=1)
    return entries


def roll_table_coverage(roll_rows, family, tolerance_ns=_roll_table.IDENTITY_RESOLUTION_TOLERANCE_NS,
                        file_start_ns=None, file_end_ns=None, partial=False):
    entries = []
    for row in roll_rows:
        instrument = {
            "venue": "XCME", "market": "FUTURE", "symbol": row["contract_code"],
            "currency": "USD", "sizeUnit": "CONTRACT", "contract": row["contract_code"],
        }
        instrument_id = _identity.instrument_id(instrument)
        widened_from = max(0, row["from_ns"] - tolerance_ns)
        widened_to = row["to_ns"] + tolerance_ns
        if file_start_ns is not None:
            widened_from = max(widened_from, file_start_ns)
        if file_end_ns is not None:
            widened_to = min(widened_to, file_end_ns)
        if widened_from >= widened_to:
            continue
        date = _dt.date.fromisoformat(_date_str(widened_from))
        last = _dt.date.fromisoformat(_date_str(max(widened_from, widened_to - 1)))
        while date <= last:
            date_str = date.isoformat()
            day_start, day_end = _day_bounds_ns(date_str)
            from_ns = max(day_start, widened_from)
            to_ns = min(day_end, widened_to)
            entries.append({
                "instrument_id": instrument_id, "family": family, "date": date_str,
                "from_ns": from_ns, "to_ns": to_ns,
                "complete": from_ns == day_start and to_ns == day_end and not partial,
            })
            date += _dt.timedelta(days=1)
    return entries


def csv_futures_coverage(family, day_units, mappings, complete=False):
    id_lookup = {m["sourceSymbol"]: _identity.instrument_id(m["instrument"]) for m in mappings}
    entries = []
    for date_str, unit in sorted(day_units.items()):
        seen = {row["instrument_id"] for _, row in _split.read_day(unit["path"])}
        day_start, day_end = _day_bounds_ns(date_str)
        for numeric_id in sorted(seen):
            entries.append({
                "instrument_id": id_lookup[numeric_id], "family": family, "date": date_str,
                "from_ns": day_start, "to_ns": day_end, "complete": complete, "coverage_unknown": not complete,
            })
    return entries


def stream_coverage(instrument_id, family, dates):
    entries = []
    for date_str in sorted(dates):
        day_start, day_end = _day_bounds_ns(date_str)
        entries.append({
            "instrument_id": instrument_id, "family": family, "date": date_str,
            "from_ns": day_start, "to_ns": day_end, "complete": True,
        })
    return entries


def csv_coverage(dataset, symbol, family, dates, complete=False):
    instrument = _identity.instrument_for(dataset, symbol)
    instrument_id = _identity.instrument_id(instrument)
    entries = []
    for date_str in sorted(dates):
        day_start, day_end = _day_bounds_ns(date_str)
        entries.append({
            "instrument_id": instrument_id, "family": family, "date": date_str,
            "from_ns": day_start, "to_ns": day_end, "complete": complete, "coverage_unknown": not complete,
        })
    return entries
