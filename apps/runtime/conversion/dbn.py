from __future__ import annotations

import datetime as _dt
import os

import databento_dbn as _dbn

CHUNK_BYTES = 65536
BUFFER_LIMIT_BYTES = 4 * 1024 * 1024

_MBP_SCALARS = ("instrument_id", "publisher_id", "ts_event", "ts_recv", "price", "size", "action", "side", "flags", "sequence")
_LEVEL_KEYS = ("bid_px", "ask_px", "bid_sz", "ask_sz")
_OHLCV_SCALARS = ("instrument_id", "ts_event", "open", "high", "low", "close", "volume")
_DEFINITION_SCALARS = ("instrument_id", "ts_recv", "raw_symbol", "min_price_increment", "unit_of_measure_qty")
_SCHEMA_KIND = {"mbp-1": "mbp", "tbbo": "mbp", "mbp-10": "mbp", "ohlcv-1s": "ohlcv", "ohlcv-1m": "ohlcv",
                "definition": "definition"}


class DbnError(RuntimeError):
    pass


def _enum_value(value):
    return str(getattr(value, "value", value))


def _as_iso(value):
    if isinstance(value, _dt.datetime):
        return value.date().isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    return str(value)


class DbnMetadata:
    __slots__ = ("version", "dataset", "schema", "stype_in", "stype_out", "mappings", "symbols",
                 "start_ns", "end_ns", "partial", "not_found")

    def __init__(self, record):
        self.version = int(record.version)
        self.dataset = str(record.dataset)
        self.schema = _enum_value(record.schema)
        self.stype_in = _enum_value(record.stype_in)
        self.stype_out = _enum_value(record.stype_out)
        self.symbols = [str(s) for s in record.symbols]
        self.start_ns = int(record.start)
        self.end_ns = int(record.end)
        self.partial = [str(s) for s in record.partial]
        self.not_found = [str(s) for s in record.not_found]
        self.mappings = {
            str(symbol): [
                {"start_date": _as_iso(iv["start_date"]), "end_date": _as_iso(iv["end_date"]), "symbol": str(iv["symbol"])}
                for iv in intervals
            ]
            for symbol, intervals in dict(record.mappings).items()
        }


def _mbp_row(record):
    row = {k: str(getattr(record, k)) for k in _MBP_SCALARS}
    for i, level in enumerate(record.levels):
        suffix = f"{i:02d}"
        for key in _LEVEL_KEYS:
            row[f"{key}_{suffix}"] = str(getattr(level, key))
    return row


def _ohlcv_row(record):
    return {k: str(getattr(record, k)) for k in _OHLCV_SCALARS}


def _definition_row(record):
    row = {k: str(getattr(record, k)) for k in _DEFINITION_SCALARS}
    if int(row["unit_of_measure_qty"]) == 9223372036854775807:
        row["unit_of_measure_qty"] = None
    expiration = int(record.expiration)
    row["expiration"] = None if expiration == 18446744073709551615 else str(expiration)
    return row


def decode(path, expected_schema=None, on_metadata=None):
    p = os.fspath(path)
    compression = _dbn.Compression.ZSTD if p.endswith(".zst") else _dbn.Compression.NONE
    decoder = _dbn.DBNDecoder(compression=compression, upgrade_policy=_dbn.VersionUpgradePolicy.AS_IS)
    kind = None
    index = 0
    metadata = None
    with open(p, "rb") as handle:
        while True:
            chunk = handle.read(CHUNK_BYTES)
            if not chunk:
                break
            records = decoder.write_and_decode(chunk)
            if len(decoder.buffer()) > BUFFER_LIMIT_BYTES:
                raise DbnError("DBN_BUFFER_LIMIT")
            for record in records:
                if isinstance(record, _dbn.Metadata):
                    if metadata is not None:
                        raise DbnError("MULTIPLE_METADATA_RECORDS")
                    metadata = DbnMetadata(record)
                    if expected_schema is not None and metadata.schema != expected_schema:
                        raise DbnError(f"SCHEMA_MISMATCH:{metadata.schema}!={expected_schema}")
                    kind = _SCHEMA_KIND.get(metadata.schema)
                    if kind is None:
                        raise DbnError(f"UNSUPPORTED_DBN_SCHEMA:{metadata.schema}")
                    if on_metadata is not None:
                        on_metadata(metadata)
                    continue
                if metadata is None:
                    raise DbnError("ROW_BEFORE_METADATA")
                if kind == "mbp" and isinstance(record, (_dbn.MBP1Msg, _dbn.MBP10Msg)):
                    yield index, _mbp_row(record)
                elif kind == "ohlcv" and isinstance(record, _dbn.OHLCVMsg):
                    yield index, _ohlcv_row(record)
                elif kind == "definition" and isinstance(record, _dbn.InstrumentDefMsg):
                    yield index, _definition_row(record)
                else:
                    raise DbnError(f"UNSUPPORTED_DBN_RECORD:{type(record).__name__}")
                index += 1
    if metadata is None:
        raise DbnError("MISSING_DBN_METADATA")
    if decoder.buffer():
        raise DbnError("TRUNCATED_DBN")


def read_metadata(path, expected_schema=None):
    holder = []
    gen = decode(path, expected_schema=expected_schema, on_metadata=holder.append)
    try:
        next(gen)
    except StopIteration:
        pass
    finally:
        gen.close()
    if not holder:
        raise DbnError("MISSING_DBN_METADATA")
    return holder[0]
