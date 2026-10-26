"""Build W6.02 contract identity mappings from DBN metadata (raw_symbol only)."""
from __future__ import annotations

import datetime as _dt
import json as _json

_EPOCH = _dt.date(1970, 1, 1)
_NS_PER_DAY = 86_400 * 1_000_000_000

_DATASET_INSTRUMENT = {
    "XNAS.ITCH": {"venue": "XNAS", "market": "EQUITY", "currency": "USD", "sizeUnit": "SHARE"},
    "GLBX.MDP3": {"venue": "XCME", "market": "FUTURE", "currency": "USD", "sizeUnit": "CONTRACT"},
    "BINANCE.SPOT": {"venue": "BINANCE", "market": "SPOT", "currency": "USDT", "sizeUnit": "COIN"},
    "BINANCE.UM": {"venue": "BINANCE", "market": "PERPETUAL", "currency": "USDT", "sizeUnit": "COIN"},
}

BINANCE_DATASETS = ("BINANCE.SPOT", "BINANCE.UM")
TARDIS_EXCHANGE_DATASET = {"binance": "BINANCE.SPOT", "binance-futures": "BINANCE.UM"}

_CONTINUOUS_MARKERS = (".n.", ".c.", ".d.")


class IdentityError(RuntimeError):
    pass


def day_ns(iso_date):
    return str((_dt.date.fromisoformat(iso_date) - _EPOCH).days * _NS_PER_DAY)


def instrument_id(instrument):
    """Mirror `identity.js` `instrument().id` exactly: a compact JSON array of
    venue/market/symbol/currency/sizeUnit (contract is deliberately excluded —
    for futures it always equals symbol). Pinned against the real Node
    implementation in `tests/test_identity.py` so the two cannot silently
    drift; this is a read-only precomputation for the authority plan, never
    the value written to a record (that always comes back from the bridge).
    """
    return _json.dumps(
        [instrument["venue"], instrument["market"], instrument["symbol"], instrument["currency"], instrument["sizeUnit"]],
        separators=(",", ":"),
    )


def instrument_for(dataset, raw_symbol):
    base = _DATASET_INSTRUMENT.get(dataset)
    if base is None:
        raise IdentityError(f"UNSUPPORTED_DATASET:{dataset}")
    contract = raw_symbol if base["market"] == "FUTURE" else None
    return {
        "venue": base["venue"], "market": base["market"], "symbol": raw_symbol,
        "currency": base["currency"], "sizeUnit": base["sizeUnit"], "contract": contract,
    }


_WIDE_TO_NS = "18446744073709551614"


def build_csv_mappings(dataset, symbol, instrument_ids, reference):
    """CSV exports carry no metadata symbology; the S3 partition (`symbol=`) is authoritative.

    One wide-interval mapping per instrument_id -> the path's symbol. Futures are
    rejected here (no roll table); Phase 3 owns dated futures identity.
    """
    ids = sorted(str(i) for i in instrument_ids)
    if not ids:
        raise IdentityError("NO_INSTRUMENT_IDS_IN_CSV")
    instrument = instrument_for(dataset, symbol)
    if instrument["market"] == "FUTURE":
        raise IdentityError("CSV_FUTURES_IDENTITY_REQUIRES_ROLL_TABLE")
    return [
        {
            "provider": "DATABENTO", "dataset": dataset, "sourceSymbol": instrument_id,
            "fromNs": "0", "toNs": _WIDE_TO_NS, "instrument": instrument,
            "mappingVersion": "path-symbology/1", "reference": reference,
        }
        for instrument_id in ids
    ]


def build_binance_mappings(dataset, symbol, reference):
    """A Binance monthly kline archive names its product in the object path, not
    in any row, so the path is the authority exactly as it is for Databento CSV.

    Spot and USDⓈ-M carry the same ticker for different instruments, which is
    why they are separate datasets here: `instrument_id` is built from
    venue/market/symbol/currency/sizeUnit, so the market segment is what keeps
    spot BTCUSDT and perpetual BTCUSDT permanently distinct.

    The quote currency is a property of the dataset rather than of the symbol,
    so a product that does not settle in it is refused instead of being labelled
    with the wrong currency forever."""
    if dataset not in BINANCE_DATASETS:
        raise IdentityError(f"NOT_A_BINANCE_DATASET:{dataset}")
    base = _DATASET_INSTRUMENT[dataset]
    if not symbol or not symbol.endswith(base["currency"]):
        raise IdentityError(f"BINANCE_SYMBOL_CURRENCY_MISMATCH:{symbol}:{base['currency']}")
    return [{
        "provider": "BINANCE", "dataset": dataset, "sourceSymbol": symbol,
        "fromNs": "0", "toNs": _WIDE_TO_NS, "instrument": instrument_for(dataset, symbol),
        "mappingVersion": "path-symbology/1", "reference": reference,
    }]


def build_tardis_mappings(exchange, symbol, reference):
    dataset = TARDIS_EXCHANGE_DATASET.get(exchange)
    if dataset is None:
        raise IdentityError(f"UNSUPPORTED_TARDIS_EXCHANGE:{exchange}")
    base = _DATASET_INSTRUMENT[dataset]
    if not symbol or not symbol.endswith(base["currency"]):
        raise IdentityError(f"TARDIS_SYMBOL_CURRENCY_MISMATCH:{symbol}:{base['currency']}")
    return [{
        "provider": "TARDIS", "dataset": exchange, "sourceSymbol": symbol,
        "fromNs": "0", "toNs": _WIDE_TO_NS, "instrument": instrument_for(dataset, symbol),
        "mappingVersion": "path-symbology/1", "reference": reference,
    }]


def build_csv_futures_mappings(dataset, instrument_ids, definition_snapshots, reference):
    base = _DATASET_INSTRUMENT.get(dataset)
    if base is None:
        raise IdentityError(f"UNSUPPORTED_DATASET:{dataset}")
    ids = sorted(str(i) for i in instrument_ids)
    if not ids:
        raise IdentityError("NO_INSTRUMENT_IDS_IN_CSV")
    mappings = []
    for instrument_id in ids:
        snapshots = definition_snapshots.get(instrument_id)
        if not snapshots:
            raise IdentityError(f"CSV_FUTURES_DEFINITION_GAP:{instrument_id}")
        raw_symbols = {facts["raw_symbol"] for _date, facts in snapshots}
        if len(raw_symbols) > 1:
            raise IdentityError(f"CSV_FUTURES_INCONSISTENT_DEFINITION:{instrument_id}:{sorted(raw_symbols)}")
        raw_symbol = snapshots[-1][1]["raw_symbol"]
        expirations = {facts.get("expiration_ns") for _, facts in snapshots}
        if None in expirations or len(expirations) != 1:
            raise IdentityError(f"CSV_FUTURES_EXPIRATION_UNRESOLVED:{instrument_id}")
        from_ns = day_ns(min(date for date, _ in snapshots))
        to_ns = str(next(iter(expirations)))
        if int(to_ns) <= int(from_ns):
            raise IdentityError(f"CSV_FUTURES_INVALID_VALIDITY:{instrument_id}")
        instrument = {
            "venue": base["venue"], "market": base["market"], "symbol": raw_symbol,
            "currency": base["currency"], "sizeUnit": base["sizeUnit"], "contract": raw_symbol,
        }
        mappings.append({
            "provider": "DATABENTO", "dataset": dataset, "sourceSymbol": instrument_id,
            "fromNs": from_ns, "toNs": to_ns, "instrument": instrument,
            "mappingVersion": "csv-definition-lookup/2", "reference": reference,
        })
    return mappings


def build_mappings(metadata, raw_sha256):
    if metadata.stype_in == "continuous":
        raise IdentityError("CONTINUOUS_REQUIRES_ROLL_TABLE")
    if metadata.stype_in != "raw_symbol" or metadata.stype_out != "instrument_id":
        raise IdentityError(f"UNSUPPORTED_STYPE:{metadata.stype_in}->{metadata.stype_out}")

    rows = []
    for raw_symbol, intervals in metadata.mappings.items():
        if any(marker in raw_symbol for marker in _CONTINUOUS_MARKERS):
            raise IdentityError(f"CONTINUOUS_ALIAS_IN_MAPPINGS:{raw_symbol}")
        instrument = instrument_for(metadata.dataset, raw_symbol)
        for interval in intervals:
            from_ns = day_ns(interval["start_date"])
            to_ns = day_ns(interval["end_date"])
            if int(from_ns) >= int(to_ns):
                raise IdentityError(f"EMPTY_MAPPING_INTERVAL:{raw_symbol}")
            rows.append({
                "provider": "DATABENTO", "dataset": metadata.dataset, "sourceSymbol": str(interval["symbol"]),
                "fromNs": from_ns, "toNs": to_ns, "instrument": instrument,
                "mappingVersion": "dbn-metadata/1", "reference": f"sha256:{raw_sha256}:metadata",
            })
    if not rows:
        raise IdentityError("NO_SYMBOL_MAPPINGS")
    return rows
