"""Verified local conversion of a declared set of Binance monthly klines."""
from __future__ import annotations

import re

import convert as _convert


class BinanceBackfillError(RuntimeError):
    pass


_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _checked_sources(sources):
    if not isinstance(sources, (list, tuple)) or not sources:
        raise BinanceBackfillError("BINANCE_SOURCES_REQUIRED")
    checked, covered = [], set()
    for source in sources:
        if not isinstance(source, dict):
            raise BinanceBackfillError("INVALID_BINANCE_SOURCE")
        try:
            expected = source["expected_sha256"]
            interval, start_ns, end_ns = _convert._binance_kline_month(
                source["s3_key"], source["dataset"], source["symbol"], source["schema"])
            actual = _convert._sha256_file(source["source_path"])
        except (KeyError, TypeError, OSError) as error:
            raise BinanceBackfillError("INVALID_BINANCE_SOURCE") from error
        if not isinstance(expected, str) or _SHA256.fullmatch(expected) is None:
            raise BinanceBackfillError("INVALID_BINANCE_SOURCE_SHA256")
        if actual != expected:
            raise BinanceBackfillError("BINANCE_SOURCE_SHA256_MISMATCH")
        identity = (source["dataset"], source["symbol"], source["schema"], start_ns, end_ns)
        if identity in covered:
            raise BinanceBackfillError("DUPLICATE_BINANCE_SOURCE_MONTH")
        covered.add(identity)
        checked.append({
            "source_path": source["source_path"], "schema": source["schema"], "dataset": source["dataset"],
            "symbol": source["symbol"], "s3_key": source["s3_key"], "expected_sha256": expected,
        })
    return checked


def convert_months(sources, dataset_version, **kwargs):
    """Convert only checksum-verified, unique Binance source months locally.

    This function never contacts S3. Publication belongs to the separate A6
    qualification flow after its source receipt, archive read-back and coverage
    checks have passed.
    """
    return _convert.convert_files(_checked_sources(sources), dataset_version, **kwargs)
