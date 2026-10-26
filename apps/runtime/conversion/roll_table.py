from __future__ import annotations

import datetime as _dt
import hashlib
import json
import re

_EPOCH = _dt.date(1970, 1, 1)
_NS_PER_DAY = 86_400 * 1_000_000_000
_CODE_PATTERN = {"ES": re.compile(r"^ES[FGHJKMNQUVXZ][0-9]$"), "NQ": re.compile(r"^NQ[FGHJKMNQUVXZ][0-9]$")}
_ROLL_BOUNDARY_WARN_NS = 3 * _NS_PER_DAY
IDENTITY_RESOLUTION_TOLERANCE_NS = 2_000_000_000

BUILDER_VERSION = "roll-table-builder/1"


class RollTableError(RuntimeError):
    pass


def _day_ns(date_str):
    return (_dt.date.fromisoformat(date_str) - _EPOCH).days * _NS_PER_DAY


def _utc_date(ts_event_ns):
    seconds = int(ts_event_ns) // 1_000_000_000
    return _dt.datetime.fromtimestamp(seconds, tz=_dt.timezone.utc).strftime("%Y-%m-%d")


def _fixed9_to_decimal(value_str):
    n = int(value_str)
    digits = str(abs(n)).rjust(10, "0")
    body = f"{digits[:-9]}.{digits[-9:]}"
    return ("-" if n < 0 else "") + body


def definition_snapshots_from_rows(rows):
    by_instrument = {}
    for row in rows:
        if row["unit_of_measure_qty"] is None:
            raise RollTableError(f"MISSING_UNIT_OF_MEASURE_QTY:{row['instrument_id']}:{row['ts_recv']}")
        date = _utc_date(row["ts_recv"])
        facts = {
            "raw_symbol": row["raw_symbol"],
            "tick_size": _fixed9_to_decimal(row["min_price_increment"]),
            "multiplier": _fixed9_to_decimal(row["unit_of_measure_qty"]),
            "expiration_ns": None if row["expiration"] is None else int(row["expiration"]),
        }
        dates = by_instrument.setdefault(row["instrument_id"], {})
        prior = dates.get(date)
        if prior is not None and prior != facts:
            raise RollTableError(f"CONFLICTING_DAILY_DEFINITION:{date}:{row['instrument_id']}")
        dates[date] = facts
    return {instrument_id: sorted(dates.items()) for instrument_id, dates in by_instrument.items()}


def _as_of(snapshots, date):
    entry = None
    for snap_date, facts in snapshots:
        if snap_date > date:
            break
        entry = facts
    return entry


def _dates_between(start_date, end_date):
    date = _dt.date.fromisoformat(start_date)
    end = _dt.date.fromisoformat(end_date)
    out = []
    while date < end:
        out.append(date.isoformat())
        date += _dt.timedelta(days=1)
    return out


def build(alias, continuous_intervals, definition_snapshots, roll_table_version):
    if not continuous_intervals:
        raise RollTableError(f"NO_CONTINUOUS_INTERVALS:{alias}")
    rows = []
    for interval in sorted(continuous_intervals, key=lambda i: i["start_date"]):
        instrument_id = str(interval["symbol"])
        dates = _dates_between(interval["start_date"], interval["end_date"])
        if not dates:
            raise RollTableError(f"EMPTY_CONTINUOUS_INTERVAL:{alias}:{interval['start_date']}")
        snapshots = definition_snapshots.get(instrument_id, [])
        facts = None
        for date in dates:
            entry = _as_of(snapshots, date)
            if entry is None:
                raise RollTableError(f"DEFINITION_GAP:{alias}:{date}:{instrument_id}")
            key = (entry["raw_symbol"], str(entry["tick_size"]), str(entry["multiplier"]))
            if facts is None:
                facts = {"raw_symbol": entry["raw_symbol"], "tick_size": entry["tick_size"],
                          "multiplier": entry["multiplier"], "expiration_ns": entry["expiration_ns"]}
            elif key != (facts["raw_symbol"], str(facts["tick_size"]), str(facts["multiplier"])):
                raise RollTableError(f"INCONSISTENT_DEFINITION:{alias}:{date}:{instrument_id}")
        rows.append({
            "alias": alias, "from_ns": _day_ns(interval["start_date"]), "to_ns": _day_ns(interval["end_date"]),
            "instrument_id": instrument_id, "contract_code": facts["raw_symbol"],
            "tick_size": facts["tick_size"], "multiplier": facts["multiplier"],
            "roll_table_version": roll_table_version, "_expiration_ns": facts["expiration_ns"],
        })
    return rows


def merge_intervals(alias, intervals):
    """Per-file symbol mappings folded into one interval per contract tenure.

    A daily source contributes one mapping per file, so a date with no file --
    a Saturday, a holiday -- leaves a hole between two intervals naming the same
    contract. Measured on the August 2026 `mbp-10` archive: ES and NQ both lose
    every Saturday, four per month, with an identical contract on either side.

    A continuous alias names one front contract at a time and never returns to
    one it has rolled away from, so a hole between two intervals of the same
    contract was that contract throughout. Bridging it states a fact rather than
    filling a gap with a guess, and every bridge is reported so it stays visible
    in the job summary. A hole between two *different* contracts is a roll
    boundary nobody recorded; it is left alone for `validate` to refuse."""
    merged, warnings = [], []
    for interval in sorted(intervals, key=lambda i: (i["start_date"], i["end_date"], i["symbol"])):
        if merged and merged[-1]["symbol"] == interval["symbol"]:
            if interval["start_date"] > merged[-1]["end_date"]:
                warnings.append(
                    f"BRIDGED_ABSENT_DATES:{alias}:{interval['symbol']}:"
                    f"{merged[-1]['end_date']}..{interval['start_date']}")
            merged[-1]["end_date"] = max(merged[-1]["end_date"], interval["end_date"])
        else:
            merged.append(dict(interval))
    return merged, warnings


def validate(alias, rows):
    mine = sorted((r for r in rows if r["alias"] == alias), key=lambda r: r["from_ns"])
    if not mine:
        raise RollTableError(f"NO_ROLL_INTERVALS:{alias}")
    for row in mine:
        if float(row["tick_size"]) <= 0:
            raise RollTableError(f"NON_POSITIVE_TICK_SIZE:{alias}:{row['from_ns']}")
        if float(row["multiplier"]) <= 0:
            raise RollTableError(f"NON_POSITIVE_MULTIPLIER:{alias}:{row['from_ns']}")
        pattern = _CODE_PATTERN.get(alias[:2])
        if pattern is None or not pattern.fullmatch(row["contract_code"]):
            raise RollTableError(f"INVALID_CONTRACT_CODE:{alias}:{row['contract_code']}")
        if row["from_ns"] >= row["to_ns"]:
            raise RollTableError(f"EMPTY_ROLL_INTERVAL:{alias}:{row['from_ns']}")
    for prev, nxt in zip(mine, mine[1:]):
        if prev["to_ns"] != nxt["from_ns"]:
            raise RollTableError(f"NON_CONTIGUOUS_ROLL_TABLE:{alias}:{prev['to_ns']}!={nxt['from_ns']}")

    warnings = []
    for index, row in enumerate(mine):
        expiration_ns = row.get("_expiration_ns")
        if expiration_ns is None:
            continue
        if index == len(mine) - 1:
            continue
        if abs(row["to_ns"] - expiration_ns) > _ROLL_BOUNDARY_WARN_NS:
            warnings.append(
                f"ROLL_BOUNDARY_FAR_FROM_EXPIRATION:{alias}:{row['contract_code']}:"
                f"boundary={row['to_ns']}:expiration={expiration_ns}"
            )
    return warnings


def version(source_hashes, dbn_metadata_hashes, builder_version=BUILDER_VERSION):
    material = {"sources": sorted(source_hashes), "dbn_metadata": sorted(dbn_metadata_hashes), "builder": builder_version}
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def to_mappings(rows, dataset, reference, tolerance_ns=IDENTITY_RESOLUTION_TOLERANCE_NS):
    return [
        {
            "provider": "DATABENTO", "dataset": dataset, "sourceSymbol": row["instrument_id"],
            "fromNs": str(max(0, row["from_ns"] - tolerance_ns)), "toNs": str(row["to_ns"] + tolerance_ns),
            "instrument": {
                "venue": "XCME", "market": "FUTURE", "symbol": row["contract_code"],
                "contract": row["contract_code"], "currency": "USD", "sizeUnit": "CONTRACT",
            },
            "mappingVersion": f"roll-table/{row['roll_table_version']}", "reference": reference,
        }
        for row in rows
    ]
