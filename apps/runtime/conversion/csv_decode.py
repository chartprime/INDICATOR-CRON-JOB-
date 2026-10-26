from __future__ import annotations

import csv
import gzip
import zipfile

_OHLCV_COLUMNS = ("ts_event", "rtype", "publisher_id", "instrument_id", "open", "high", "low", "close", "volume")

_KLINE_COLUMNS = (
    "open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume",
    "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore",
)

MAX_KLINE_MEMBER_BYTES = 512 * 1024 * 1024
MAX_KLINE_ROWS = 5_000_000

_DEFINITION_COLUMNS = (
    "ts_recv", "ts_event", "rtype", "publisher_id", "instrument_id", "raw_symbol",
    "security_update_action", "instrument_class", "min_price_increment", "display_factor",
    "expiration", "activation", "high_limit_price", "low_limit_price", "max_price_variation",
    "unit_of_measure_qty", "min_price_increment_amount", "price_ratio", "inst_attrib_value",
    "underlying_id", "raw_instrument_id", "market_depth_implied", "market_depth",
    "market_segment_id", "max_trade_vol", "min_lot_size", "min_lot_size_block",
    "min_lot_size_round_lot", "min_trade_vol", "contract_multiplier", "decay_quantity",
    "original_contract_size", "appl_id", "maturity_year", "decay_start_date", "channel_id",
    "currency", "settl_currency", "secsubtype", "group", "exchange", "asset", "cfi",
    "security_type", "unit_of_measure", "underlying", "strike_price_currency", "strike_price",
    "match_algorithm", "main_fraction", "price_display_format", "sub_fraction",
    "underlying_product", "maturity_month", "maturity_day", "maturity_week",
    "user_defined_instrument", "contract_multiplier_unit", "flow_schedule_type", "tick_rule",
    "leg_count", "leg_index", "leg_instrument_id", "leg_raw_symbol", "leg_instrument_class",
    "leg_side", "leg_price", "leg_delta", "leg_ratio_price_numerator",
    "leg_ratio_price_denominator", "leg_ratio_qty_numerator", "leg_ratio_qty_denominator",
    "leg_underlying_id",
)


class CsvError(RuntimeError):
    pass


def _io_text(raw):
    import io

    return io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")


def _open(path):
    return gzip.open(path, "rt", encoding="utf-8-sig", newline="") if path.endswith(".gz") else open(
        path, "rt", encoding="utf-8-sig", newline=""
    )


def decode_ohlcv(path):
    with _open(path) as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header != list(_OHLCV_COLUMNS):
            raise CsvError(f"OHLCV_CSV_HEADER_MISMATCH:{header}")
        index = 0
        for fields in reader:
            if len(fields) != len(_OHLCV_COLUMNS):
                raise CsvError(f"RAGGED_CSV_ROW:{index}")
            if any(value == "" for value in fields):
                raise CsvError(f"EMPTY_CSV_FIELD:{index}")
            yield index, dict(zip(_OHLCV_COLUMNS, fields))
            index += 1
        if index == 0:
            raise CsvError("EMPTY_CSV")


def distinct_instrument_ids(path):
    seen = set()
    for _, row in decode_ohlcv(path):
        seen.add(row["instrument_id"])
    return seen


def _kline_member(archive):
    members = [info for info in archive.infolist() if not info.is_dir()]
    if len(members) != 1:
        raise CsvError(f"KLINE_ZIP_MEMBER_COUNT:{len(members)}")
    member = members[0]
    if member.file_size > MAX_KLINE_MEMBER_BYTES:
        raise CsvError(f"KLINE_MEMBER_TOO_LARGE:{member.file_size}")
    return member


def kline_member_name(path):
    with zipfile.ZipFile(path) as archive:
        return _kline_member(archive).filename


def kline_rows(path):
    """Rows from one Binance monthly kline archive.

    Whether the file carries a header is a property of the source, not of the
    format: spot omits it and USDⓈ-M futures includes it. Both were checked
    against the real September 2025 BTCUSDT objects. Deciding from the first
    field rather than from the product means neither has to be configured, and
    a header that ever appears on spot is read correctly instead of being
    consumed as a bar.
    """
    with zipfile.ZipFile(path) as archive:
        member = _kline_member(archive)
        with archive.open(member) as raw:
            handle = _io_text(raw)
            reader = csv.reader(handle)
            first = next(reader, None)
            if first is None:
                raise CsvError("EMPTY_KLINE_CSV")
            if not first[0].isdigit():
                if tuple(first) != _KLINE_COLUMNS:
                    raise CsvError(f"KLINE_CSV_HEADER_MISMATCH:{first}")
                first = next(reader, None)
                if first is None:
                    raise CsvError("EMPTY_KLINE_CSV")
            index = 0
            fields = first
            while fields is not None:
                if len(fields) != len(_KLINE_COLUMNS):
                    raise CsvError(f"RAGGED_KLINE_ROW:{index}")
                if any(value == "" for value in fields):
                    raise CsvError(f"EMPTY_KLINE_FIELD:{index}")
                if index >= MAX_KLINE_ROWS:
                    raise CsvError(f"KLINE_ROW_LIMIT:{index}")
                yield index, dict(zip(_KLINE_COLUMNS, fields))
                index += 1
                fields = next(reader, None)
            if index == 0:
                raise CsvError("EMPTY_KLINE_CSV")


def kline_timestamp_unit(row, interval_ns):
    """Which clock the file's timestamps are in, proven rather than guessed.

    Binance close times are inclusive, so a bar's own span identifies its unit
    exactly: a one-minute bar spans 59,999,999 in microseconds and 59,999 in
    milliseconds. Spot switched to microseconds from 2025-01-01 while futures
    stayed on milliseconds, and reading one as the other shifts a year of bars
    by three orders of magnitude while still looking like plausible data.
    Deciding from magnitude would be a guess; this is an assertion."""
    span = int(row["close_time"]) - int(row["open_time"])
    for unit, per_ns in (("us", 1_000), ("ms", 1_000_000)):
        if span == interval_ns // per_ns - 1:
            return unit
    raise CsvError(f"KLINE_INTERVAL_UNRECOGNISED:span={span}:interval_ns={interval_ns}")


def validated_kline_month_rows(path, *, interval_ns, start_ns, end_ns):
    """Yield exactly one complete UTC-grid Binance kline month.

    The CSV can be syntactically correct while still being an incomplete
    provider archive. Every expected open is checked before it is yielded, so a
    caller cannot publish a month with a missing, duplicated, reordered, or
    off-grid bar. The final equality proves the tail of the month was present
    too, rather than merely proving that the prefix was well formed.
    """
    if (not isinstance(interval_ns, int) or isinstance(interval_ns, bool) or interval_ns <= 0
            or not isinstance(start_ns, int) or isinstance(start_ns, bool)
            or not isinstance(end_ns, int) or isinstance(end_ns, bool)
            or end_ns <= start_ns or start_ns % interval_ns or end_ns % interval_ns):
        raise CsvError("INVALID_KLINE_MONTH_WINDOW")
    expected = start_ns
    timestamp_unit = None
    unit_ns = {"us": 1_000, "ms": 1_000_000}
    for position, row in kline_rows(path):
        unit = kline_timestamp_unit(row, interval_ns)
        if timestamp_unit is None:
            timestamp_unit = unit
        elif unit != timestamp_unit:
            raise CsvError(f"MIXED_KLINE_TIMESTAMP_UNITS:{position}")
        open_ns = int(row["open_time"]) * unit_ns[unit]
        if open_ns % interval_ns:
            raise CsvError(f"KLINE_OPEN_NOT_UTC_GRID_ALIGNED:{position}")
        if open_ns < start_ns or open_ns >= end_ns:
            raise CsvError(f"KLINE_OPEN_OUTSIDE_DECLARED_MONTH:{position}")
        if open_ns != expected:
            raise CsvError(f"KLINE_MONTH_NONCONTIGUOUS:{position}")
        yield position, row
        expected += interval_ns
    if expected != end_ns:
        raise CsvError(f"KLINE_MONTH_INCOMPLETE:{expected}:{end_ns}")


def decode_definition(path):
    with _open(path) as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header != list(_DEFINITION_COLUMNS):
            raise CsvError(f"DEFINITION_CSV_HEADER_MISMATCH:{header}")
        index = 0
        for fields in reader:
            if len(fields) != len(_DEFINITION_COLUMNS):
                raise CsvError(f"RAGGED_CSV_ROW:{index}")
            yield index, dict(zip(_DEFINITION_COLUMNS, fields))
            index += 1
        if index == 0:
            raise CsvError("EMPTY_CSV")
