from __future__ import annotations

import csv
import datetime as _dt
import gzip
import re

HEADERS = {
    "trades": ("exchange", "symbol", "timestamp", "local_timestamp", "id", "side", "price", "amount"),
}

_DAY_NS = 86_400 * 1_000_000_000
_EPOCH = _dt.date(1970, 1, 1)
_DIGITS = re.compile(r"[0-9]{1,19}")


class TardisDecodeError(RuntimeError):
    pass


def day_start_ns(iso_date):
    return (_dt.date.fromisoformat(iso_date) - _EPOCH).days * _DAY_NS


def stream_rows(files, data_type, first_date, last_date, counts):
    header = HEADERS.get(data_type)
    if header is None:
        raise TardisDecodeError(f"UNSUPPORTED_TARDIS_DATA_TYPE:{data_type}")
    if last_date < first_date:
        raise TardisDecodeError(f"EMPTY_TARDIS_WINDOW:{first_date}:{last_date}")
    window_from = day_start_ns(first_date)
    window_to = day_start_ns(last_date) + _DAY_NS
    offset = 0
    for index, source in enumerate(files):
        tally = {"s3_key": source["s3_key"], "rows": 0, "kept": 0, "before_window": 0, "after_window": 0}
        with gzip.open(source["local_path"], "rt", encoding="utf-8", newline="") as fh:
            reader = csv.reader(fh)
            found = tuple(next(reader, ()))
            if found != header:
                raise TardisDecodeError(f"TARDIS_HEADER_MISMATCH:{source['s3_key']}:{','.join(found)}")
            for file_row, values in enumerate(reader):
                if len(values) != len(header):
                    raise TardisDecodeError(f"TARDIS_ROW_WIDTH:{source['s3_key']}:{file_row}")
                row = dict(zip(header, values))
                if _DIGITS.fullmatch(row["timestamp"]) is None:
                    raise TardisDecodeError(f"TARDIS_TIMESTAMP_INVALID:{source['s3_key']}:{file_row}")
                tally["rows"] += 1
                event_ns = int(row["timestamp"]) * 1000
                if _DIGITS.fullmatch(row["local_timestamp"]) is None:
                    raise TardisDecodeError(f"TARDIS_RECEIVE_TIMESTAMP_INVALID:{source['s3_key']}:{file_row}")
                receive_ns = int(row["local_timestamp"]) * 1000
                if event_ns < (receive_ns // _DAY_NS - 1) * _DAY_NS:
                    raise TardisDecodeError(f"TARDIS_RECEIVE_DAY_LOOKAHEAD_EXCEEDED:{source['s3_key']}:{file_row}")
                if event_ns < window_from:
                    tally["before_window"] += 1
                    continue
                if event_ns >= window_to:
                    if receive_ns < window_to:
                        raise TardisDecodeError(f"TARDIS_EXCHANGE_TIME_CROSSES_WINDOW_END:{source['s3_key']}:{file_row}")
                    tally["after_window"] += 1
                    continue
                tally["kept"] += 1
                row["ts_event"] = str(event_ns)
                row["file"] = index
                row["file_row"] = file_row
                yield offset + file_row, row
        offset += tally["rows"]
        counts.append(tally)


def source_row(row, data_type):
    return {name: row[name] for name in HEADERS[data_type]}
