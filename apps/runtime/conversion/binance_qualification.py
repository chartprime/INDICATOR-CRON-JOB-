"""Acquire, receipt and prepare the fixed Binance candle qualification scope."""
from __future__ import annotations

import argparse
import base64
import calendar
import datetime as dt
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

import csv_decode


SCOPE_START = (2025, 9)
SCOPE_END = (2026, 8)
SOURCE_BASE = "https://data.binance.vision/data"
RAW_PREFIX = "raw/binance"
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_CHECKSUM_BYTES = 16 * 1024
MAX_RECEIPT_BYTES = 64 * 1024
MAX_CATALOG_BYTES = 64 * 1024 * 1024

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_PRODUCTS = (
    ("spot", "BINANCE.SPOT", "BTCUSDT"),
    ("spot", "BINANCE.SPOT", "ETHUSDT"),
    ("um", "BINANCE.UM", "BTCUSDT"),
    ("um", "BINANCE.UM", "ETHUSDT"),
)

_INTERVALS = (
    ("1m", "klines-1m", "candle_1m", 60_000_000_000),
    ("1h", "klines-1h", "candle_1h", 3_600_000_000_000),
    ("1d", "klines-1d", "candle_1d", 86_400_000_000_000),
)

_INTERVAL_LABELS = frozenset(label for label, _schema, _family, _ns in _INTERVALS)


class BinanceQualificationError(RuntimeError):
    pass


def _next_month(year, month):
    return (year + (month == 12), 1 if month == 12 else month + 1)


def _month_window(year, month):
    start = dt.datetime(year, month, 1, tzinfo=dt.timezone.utc)
    next_year, next_month = _next_month(year, month)
    end = dt.datetime(next_year, next_month, 1, tzinfo=dt.timezone.utc)
    return (calendar.timegm(start.utctimetuple()) * 1_000_000_000,
            calendar.timegm(end.utctimetuple()) * 1_000_000_000)


def inventory(start=SCOPE_START, end=SCOPE_END):
    """The fixed four-instrument, twelve-month, three-rung A6 source plan.

    Binance publishes 1m, 1h and 1d as separate monthly objects, so every rung
    is fetched from the provider rather than derived here. A derived rung would
    make the qualification's own arithmetic the thing under test instead of the
    delivered data."""
    if (not isinstance(start, tuple) or not isinstance(end, tuple) or len(start) != 2 or len(end) != 2
            or not all(isinstance(value, int) for value in (*start, *end))
            or not 1 <= start[1] <= 12 or not 1 <= end[1] <= 12 or start > end):
        raise BinanceQualificationError("INVALID_QUALIFICATION_MONTH_RANGE")
    months, year, month = [], *start
    while (year, month) <= end:
        months.append((year, month))
        year, month = _next_month(year, month)
    sources = []
    for product, dataset, symbol in _PRODUCTS:
        surface = "spot" if product == "spot" else "futures/um"
        for interval, schema, family, interval_ns in _INTERVALS:
            for year, month in months:
                label = f"{year}-{month:02d}"
                filename = f"{symbol}-{interval}-{label}.zip"
                url = f"{SOURCE_BASE}/{surface}/monthly/klines/{symbol}/{interval}/{filename}"
                start_ns, end_ns = _month_window(year, month)
                sources.append({
                    "product": product,
                    "dataset": dataset,
                    "symbol": symbol,
                    "interval": interval,
                    "interval_ns": interval_ns,
                    "family": family,
                    "schema": schema,
                    "month": label,
                    "start_ns": start_ns,
                    "end_ns": end_ns,
                    "url": url,
                    "checksum_url": url + ".CHECKSUM",
                    "filename": filename,
                })
    return sources


def _scope_days(sources):
    """UTC days the scope covers, from the month windows themselves.

    Every rung spans every day of the scope -- a day holds 1,440 minute bars,
    24 hourly bars or one daily bar -- so the day census is the same for all
    three and only the bar count differs."""
    windows = {(source["start_ns"], source["end_ns"]) for source in sources}
    return sum((end - start) // 86_400_000_000_000 for start, end in windows)


def expected_bars(source):
    """How many bars a complete month of this rung must contain, derived from
    the month's own UTC span rather than asserted.

    A constant would be right only for the window it was written against: a
    leap February and a 31-day month differ, and 2026 not being a leap year is
    a property of this scope, not of the code."""
    return bars_in_window(source["interval_ns"], source["start_ns"], source["end_ns"])


def bars_in_window(interval_ns, start_ns, end_ns):
    span = end_ns - start_ns
    if interval_ns <= 0 or span <= 0 or span % interval_ns:
        raise BinanceQualificationError(
            f"QUALIFICATION_MONTH_NOT_WHOLE_BARS:{start_ns}:{end_ns}:{interval_ns}")
    return span // interval_ns


def _fixed_source(source):
    """Return the one allowed A6 source with this identity.

    Acquisition is deliberately not a general URL fetcher. Its authority is
    the fixed four-instrument, twelve-month qualification inventory; accepting
    a caller-supplied URL here would turn the raw-write credential into an
    arbitrary-object fetch capability.
    """
    if not isinstance(source, dict):
        raise BinanceQualificationError("INVALID_BINANCE_SOURCE")
    identity = (source.get("product"), source.get("dataset"), source.get("symbol"),
                source.get("schema"), source.get("month"))
    for candidate in inventory():
        candidate_identity = (candidate["product"], candidate["dataset"], candidate["symbol"],
                              candidate["schema"], candidate["month"])
        if candidate_identity == identity:
            if source != candidate:
                raise BinanceQualificationError("BINANCE_SOURCE_IDENTITY_MISMATCH")
            return candidate
    raise BinanceQualificationError("BINANCE_SOURCE_OUTSIDE_QUALIFICATION_SCOPE")


def raw_key(source, sha256):
    """The immutable S3 key for one exact upstream archive candidate."""
    source = _fixed_source(source)
    if not _SHA256.fullmatch(sha256 or ""):
        raise BinanceQualificationError("INVALID_RAW_CANDIDATE")
    return (f"{RAW_PREFIX}/{source['product']}/{source['symbol']}/{source['interval']}"
            f"/{source['month']}/{sha256}.zip")


def receipt_key(s3_key):
    if not isinstance(s3_key, str) or not s3_key.startswith(RAW_PREFIX + "/") or not s3_key.endswith(".zip"):
        raise BinanceQualificationError("INVALID_RAW_RECEIPT_KEY")
    return s3_key + ".receipt.json"


def _source_for_raw_key(key):
    """Recover the fixed A6 source identity encoded by a raw candidate key."""
    if not isinstance(key, str) or not key.startswith(RAW_PREFIX + "/") or not key.endswith(".zip"):
        raise BinanceQualificationError("RAW_OBJECT_KEY_OUTSIDE_BINANCE")
    parts = key.split("/")
    if len(parts) != 7 or parts[:2] != ["raw", "binance"] or parts[4] not in _INTERVAL_LABELS:
        raise BinanceQualificationError("RAW_OBJECT_KEY_OUTSIDE_BINANCE")
    product, symbol, interval, month = parts[2], parts[3], parts[4], parts[5]
    sha256 = parts[6].removesuffix(".zip")
    if not _SHA256.fullmatch(sha256):
        raise BinanceQualificationError("RAW_OBJECT_KEY_OUTSIDE_BINANCE")
    for source in inventory():
        if ((source["product"], source["symbol"], source["interval"], source["month"])
                == (product, symbol, interval, month)):
            if key == raw_key(source, sha256):
                return source
    raise BinanceQualificationError("RAW_OBJECT_KEY_OUTSIDE_BINANCE")


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_checksum(raw, filename):
    """Accept exactly the one checksum line belonging to the requested ZIP."""
    if not isinstance(raw, bytes) or len(raw) > MAX_CHECKSUM_BYTES:
        raise BinanceQualificationError("INVALID_BINANCE_CHECKSUM_DOCUMENT")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BinanceQualificationError("INVALID_BINANCE_CHECKSUM_DOCUMENT") from error
    lines = [line for line in text.splitlines() if line]
    if len(lines) != 1:
        raise BinanceQualificationError("INVALID_BINANCE_CHECKSUM_DOCUMENT")
    match = re.fullmatch(r"([0-9A-Fa-f]{64})\s+\*?" + re.escape(filename), lines[0])
    if match is None:
        raise BinanceQualificationError("BINANCE_CHECKSUM_IDENTITY_MISMATCH")
    return match.group(1).lower(), text


def _read_response(response, *, limit, error):
    data = bytearray()
    with response as body:
        while True:
            chunk = body.read(min(1024 * 1024, limit + 1 - len(data)))
            if not chunk:
                return bytes(data)
            data.extend(chunk)
            if len(data) > limit:
                raise BinanceQualificationError(error)


def _fetch_bytes(url, *, limit, opener=urlopen, timeout=30):
    try:
        return _read_response(opener(Request(url, headers={"User-Agent": "terminal-l1-l2/1"}), timeout=timeout),
                              limit=limit, error="BINANCE_DOWNLOAD_SIZE_EXCEEDED")
    except BinanceQualificationError:
        raise
    except Exception as error:
        raise BinanceQualificationError(f"BINANCE_DOWNLOAD_FAILED:{url}") from error


def _atomic_download(url, destination, expected_sha256, *, opener=urlopen, timeout=30):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if (destination.is_symlink() or not destination.is_file()
                or destination.stat().st_size > MAX_ARCHIVE_BYTES
                or _sha256_file(destination) != expected_sha256):
            raise BinanceQualificationError("LOCAL_RAW_CANDIDATE_CONFLICT")
        return destination
    handle = tempfile.NamedTemporaryFile(prefix=destination.name + ".", suffix=".partial",
                                         dir=destination.parent, delete=False)
    temporary = Path(handle.name)
    digest, count = hashlib.sha256(), 0
    try:
        try:
            response = opener(Request(url, headers={"User-Agent": "terminal-l1-l2/1"}), timeout=timeout)
            with handle, response as body:
                while True:
                    chunk = body.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > MAX_ARCHIVE_BYTES:
                        raise BinanceQualificationError("BINANCE_DOWNLOAD_SIZE_EXCEEDED")
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
        except BinanceQualificationError:
            raise
        except Exception as error:
            raise BinanceQualificationError(f"BINANCE_DOWNLOAD_FAILED:{url}") from error
        if digest.hexdigest() != expected_sha256:
            raise BinanceQualificationError("BINANCE_DOWNLOAD_SHA256_MISMATCH")
        os.replace(temporary, destination)
        if os.name == "posix":
            fd = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        return destination
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _status(error):
    return getattr(error, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")


def _canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _receipt_checksum_matches(value, source, sha256):
    text = value.get("checksum_text") if isinstance(value, dict) else None
    if not isinstance(text, str):
        return False
    try:
        return parse_checksum(text.encode("utf-8"), source["filename"])[0] == sha256
    except BinanceQualificationError:
        return False


def _aware_timestamp(value):
    if not isinstance(value, str):
        return False
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


class RawStore:
    """The narrow append-only authority for checksum-addressed Binance ZIPs."""
    def __init__(self, client, bucket):
        self.client, self.bucket = client, bucket

    def _read(self, key):
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            if _status(error) == 404:
                return None
            raise
        with response["Body"] as body:
            data = body.read(MAX_RECEIPT_BYTES + 1)
        if len(data) > MAX_RECEIPT_BYTES:
            raise BinanceQualificationError("RAW_RECEIPT_OVERSIZED")
        return data

    def _verify_file(self, key, sha256, size):
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            if _status(error) == 404:
                return False
            raise
        digest, count = hashlib.sha256(), 0
        with response["Body"] as body:
            while chunk := body.read(1024 * 1024):
                count += len(chunk)
                if count > MAX_ARCHIVE_BYTES:
                    raise BinanceQualificationError("RAW_OBJECT_INTEGRITY_FAILURE")
                digest.update(chunk)
        if count != size or digest.hexdigest() != sha256:
            raise BinanceQualificationError("RAW_OBJECT_INTEGRITY_FAILURE")
        return True

    @staticmethod
    def _same_receipt(prior, value):
        if not isinstance(prior, dict):
            raise BinanceQualificationError("RAW_RECEIPT_INVALID")
        comparable = dict(value)
        comparable.pop("retrieved_at", None)
        prior_comparable = dict(prior)
        prior_comparable.pop("retrieved_at", None)
        if prior_comparable != comparable:
            raise BinanceQualificationError("RAW_RECEIPT_CONFLICT")
        return prior

    @staticmethod
    def _valid_receipt(key, value):
        raw_key = key.removesuffix(".receipt.json")
        sha256 = raw_key.rsplit("/", 1)[-1].removesuffix(".zip")
        source = _source_for_raw_key(raw_key)
        expected = {
            "receipt_version", "product", "dataset", "symbol", "schema", "month", "source_url",
            "checksum_url", "checksum_text", "retrieved_at", "raw_s3_key", "raw_sha256", "raw_bytes",
            "zip_member", "validated_rows",
        }
        if (not isinstance(value, dict) or set(value) != expected or not _SHA256.fullmatch(sha256)
                or value.get("receipt_version") != "binance-raw/1"
                or value.get("product") != source["product"] or value.get("dataset") != source["dataset"]
                or value.get("symbol") != source["symbol"] or value.get("schema") != source["schema"]
                or value.get("month") != source["month"] or value.get("source_url") != source["url"]
                or value.get("checksum_url") != source["checksum_url"]
                or not _receipt_checksum_matches(value, source, sha256)
                or value.get("raw_s3_key") != raw_key
                or value.get("raw_sha256") != sha256
                or not isinstance(value.get("raw_bytes"), int)
                or not 1 <= value["raw_bytes"] <= MAX_ARCHIVE_BYTES
                or not _aware_timestamp(value.get("retrieved_at"))
                or not isinstance(value.get("zip_member"), str)
                or value["zip_member"] != source["filename"].removesuffix(".zip") + ".csv"
                or not isinstance(value.get("validated_rows"), int) or value["validated_rows"] < 1):
            raise BinanceQualificationError("INVALID_RAW_RECEIPT")
        return value

    def _existing_receipt(self, key, value):
        existing = self._read(key)
        if existing is None:
            return None
        try:
            prior = self._valid_receipt(key, json.loads(existing))
            return self._same_receipt(prior, value)
        except (UnicodeDecodeError, json.JSONDecodeError, BinanceQualificationError) as error:
            raise BinanceQualificationError("RAW_RECEIPT_INVALID") from error

    def put_file(self, key, path, sha256):
        _source_for_raw_key(key)
        path = Path(path)
        size = path.stat().st_size
        if not _SHA256.fullmatch(sha256 or "") or not 1 <= size <= MAX_ARCHIVE_BYTES:
            raise BinanceQualificationError("INVALID_RAW_OBJECT")
        if self._verify_file(key, sha256, size):
            return
        try:
            with path.open("rb") as body:
                self.client.put_object(
                    Bucket=self.bucket, Key=key, Body=body, ContentLength=size, IfNoneMatch="*",
                    ChecksumSHA256=base64.b64encode(bytes.fromhex(sha256)).decode("ascii"),
                )
        except Exception as error:
            if _status(error) != 412:
                raise
        if not self._verify_file(key, sha256, size):
            raise BinanceQualificationError("RAW_OBJECT_INTEGRITY_FAILURE")

    def put_receipt(self, key, value):
        if not key.startswith(RAW_PREFIX + "/") or not key.endswith(".zip.receipt.json"):
            raise BinanceQualificationError("RAW_RECEIPT_KEY_OUTSIDE_BINANCE")
        value = self._valid_receipt(key, value)
        data = _canonical_json(value)
        if len(data) > MAX_RECEIPT_BYTES:
            raise BinanceQualificationError("RAW_RECEIPT_OVERSIZED")
        existing = self._existing_receipt(key, value)
        if existing is not None:
            return existing
        sha256 = hashlib.sha256(data).hexdigest()
        try:
            self.client.put_object(
                Bucket=self.bucket, Key=key, Body=data, ContentLength=len(data), IfNoneMatch="*",
                ChecksumSHA256=base64.b64encode(bytes.fromhex(sha256)).decode("ascii"),
            )
        except Exception as error:
            if _status(error) != 412:
                raise
        stored = self._existing_receipt(key, value)
        if stored is None:
            raise BinanceQualificationError("RAW_RECEIPT_INTEGRITY_FAILURE")
        return stored


def _validate_source(path, source):
    count = sum(1 for _ in csv_decode.validated_kline_month_rows(
        path, interval_ns=source["interval_ns"], start_ns=source["start_ns"], end_ns=source["end_ns"]))
    return csv_decode.kline_member_name(path), count


def acquire(source, raw_root, store, *, opener=urlopen, now=None, archive_raw=True):
    """Acquire one verified archive candidate and return its conversion source spec.

    `archive_raw=False` keeps every integrity check and skips only the durable
    copy. The upstream `.CHECKSUM` is still fetched, the download is still
    rejected unless its SHA-256 matches, and the month grid is still validated
    before any row is admitted. What is lost is provenance after the fact: with
    no stored object there is nothing to re-verify against if Binance later
    replaces the file, so a future re-run proves itself against the provider
    rather than against what we actually converted.
    """
    source = _fixed_source(source)
    expected_sha256, checksum_text = parse_checksum(
        _fetch_bytes(source["checksum_url"], limit=MAX_CHECKSUM_BYTES, opener=opener), source["filename"])
    path = Path(raw_root) / source["product"] / source["symbol"] / source["month"] / (expected_sha256 + ".zip")
    path = _atomic_download(source["url"], path, expected_sha256, opener=opener)
    member, rows = _validate_source(path, source)
    key = raw_key(source, expected_sha256)
    if not archive_raw:
        return {
            "source_path": str(path), "schema": source["schema"], "dataset": source["dataset"],
            "symbol": source["symbol"], "s3_key": key, "expected_sha256": expected_sha256,
            "source_delivered_at": (now or dt.datetime.now(dt.timezone.utc)).isoformat(),
            "source_receipt_key": None,
        }
    store.put_file(key, path, expected_sha256)
    retrieved_at = (now or dt.datetime.now(dt.timezone.utc)).isoformat()
    receipt = store.put_receipt(receipt_key(key), {
        "receipt_version": "binance-raw/1",
        "product": source["product"],
        "dataset": source["dataset"],
        "symbol": source["symbol"],
        "schema": source["schema"],
        "month": source["month"],
        "source_url": source["url"],
        "checksum_url": source["checksum_url"],
        "checksum_text": checksum_text,
        "retrieved_at": retrieved_at,
        "raw_s3_key": key,
        "raw_sha256": expected_sha256,
        "raw_bytes": path.stat().st_size,
        "zip_member": member,
        "validated_rows": rows,
    })
    return {
        "source_path": str(path), "schema": source["schema"], "dataset": source["dataset"],
        "symbol": source["symbol"], "s3_key": key, "expected_sha256": expected_sha256,
        "source_delivered_at": receipt["retrieved_at"], "source_receipt_key": receipt_key(key),
    }


def qualification_prefix(run_id):
    """The only remote namespace A6 is allowed to publish to."""
    if not isinstance(run_id, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", run_id) is None:
        raise BinanceQualificationError("INVALID_QUALIFICATION_RUN_ID")
    return f"curated/_qualification/{run_id}"


def _fresh_work_layout(work_root):
    root = Path(work_root)
    if root.exists():
        if root.is_symlink() or not root.is_dir() or any(root.iterdir()):
            raise BinanceQualificationError("QUALIFICATION_WORK_ROOT_NOT_FRESH")
    else:
        root.mkdir(parents=True)
    return {
        "root": root.resolve(),
        "raw": (root / "raw").resolve(),
        "stage": (root / "stage").resolve(),
        "curated": (root / "curated").resolve(),
        "catalog": (root / "curated" / "_catalog").resolve(),
        "readback_catalog": (root / "readback" / "_catalog").resolve(),
        "cache": (root / "cache").resolve(),
    }


def _assert_fresh_namespace(store, prefix):
    if getattr(store, "prefix", None) != prefix:
        raise BinanceQualificationError("QUALIFICATION_NAMESPACE_MISMATCH")
    if store.get_json("_catalog/CURRENT.json")[0] is not None:
        raise BinanceQualificationError("QUALIFICATION_NAMESPACE_NOT_FRESH")
    try:
        existing = store.client.list_objects_v2(Bucket=store.bucket, Prefix=prefix + "/", MaxKeys=1)
    except Exception as error:
        raise BinanceQualificationError("QUALIFICATION_NAMESPACE_LIST_UNAVAILABLE") from error
    if existing.get("KeyCount", 0) or existing.get("Contents"):
        raise BinanceQualificationError("QUALIFICATION_NAMESPACE_NOT_EMPTY")


def _atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp.{os.getpid()}")
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name == "posix":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _remote_catalog_snapshot(store, pointer, catalog_root):
    """Make a new local catalog root solely from the remote publication."""
    import catalog
    import s3_publish

    remote_pointer, _etag = store.get_json("_catalog/CURRENT.json")
    if remote_pointer != pointer:
        raise BinanceQualificationError("QUALIFICATION_REMOTE_POINTER_MISMATCH")
    try:
        catalog_key, catalog_sha256 = pointer["catalog_key"], pointer["catalog_sha256"]
    except (KeyError, TypeError) as error:
        raise BinanceQualificationError("QUALIFICATION_POINTER_INVALID") from error
    relative = "_catalog/" + s3_publish._relative(catalog_key)
    try:
        response = store.client.get_object(Bucket=store.bucket, Key=store.key(relative))
    except Exception as error:
        raise BinanceQualificationError("QUALIFICATION_REMOTE_CATALOG_UNAVAILABLE") from error
    digest, data = hashlib.sha256(), bytearray()
    with response["Body"] as body:
        while chunk := body.read(1024 * 1024):
            data.extend(chunk)
            if len(data) > MAX_CATALOG_BYTES:
                raise BinanceQualificationError("QUALIFICATION_REMOTE_CATALOG_OVERSIZED")
            digest.update(chunk)
    if digest.hexdigest() != catalog_sha256:
        raise BinanceQualificationError("QUALIFICATION_REMOTE_CATALOG_HASH_MISMATCH")
    root = Path(catalog_root)
    if root.exists() and any(root.iterdir()):
        raise BinanceQualificationError("QUALIFICATION_READBACK_CATALOG_NOT_FRESH")
    _atomic_bytes(root / catalog_key, bytes(data))
    catalog._atomic_write_json(root / "CURRENT.json", pointer)
    return {"catalog_sha256": catalog_sha256, "catalog_bytes": len(data)}


def _decimal(value):
    number = Decimal(str(value))
    return "0" if number == 0 else format(number.normalize(), "f")


_RECONCILIATION_FIELDS = (
    "event_ns", "source_rank", "stable_position", "ordinal", "instrument_id", "family", "open_ns", "close_ns",
    "open", "high", "low", "close", "volume", "buy_volume", "quote_volume",
    "taker_buy_quote_volume", "taker_sell_base_volume", "taker_sell_quote_volume", "trade_count",
    "time_precision", "time_origin", "source_provider", "source_dataset", "source_schema",
    "source_dataset_version", "source_symbol", "mapping_version", "mapping_reference", "stream_id",
    "lineage_sha256", "lineage_row", "quality_state", "quality_flags", "closed", "method",
)


def _source_context(source):
    import convert
    import identity

    interval, start_ns, end_ns = convert._binance_kline_month(
        source["s3_key"], source["dataset"], source["symbol"], source["schema"])
    instrument = identity.build_binance_mappings(
        source["dataset"], source["symbol"], f"s3-key:{source['s3_key']}")[0]["instrument"]
    family = convert._partition_family_for("candle", source["schema"])
    declared = source.get("family")
    if declared is not None and declared != family:
        raise BinanceQualificationError(
            f"QUALIFICATION_FAMILY_DISAGREES_WITH_SCHEMA:{source['schema']}:{family}:{declared}")
    return {"interval_ns": interval, "start_ns": start_ns, "end_ns": end_ns, "family": family,
            "instrument_id": identity.instrument_id(instrument)}


def _source_projection(source, row, position, dataset_version, context=None):
    context = _source_context(source) if context is None else context
    interval = context["interval_ns"]
    unit = csv_decode.kline_timestamp_unit(row, interval)
    unit_ns = 1_000 if unit == "us" else 1_000_000
    event_ns = int(row["open_time"]) * unit_ns
    volume = Decimal(row["volume"])
    buy_volume = Decimal(row["taker_buy_volume"])
    quote_volume = Decimal(row["quote_volume"])
    buy_quote_volume = Decimal(row["taker_buy_quote_volume"])
    return {
        "event_ns": str(event_ns), "source_rank": 0, "stable_position": str(position), "ordinal": 0,
        "instrument_id": context["instrument_id"], "family": context["family"],
        "open_ns": str(event_ns), "close_ns": str(event_ns + interval),
        "open": _decimal(row["open"]), "high": _decimal(row["high"]), "low": _decimal(row["low"]),
        "close": _decimal(row["close"]), "volume": _decimal(volume), "buy_volume": _decimal(buy_volume),
        "quote_volume": _decimal(quote_volume), "taker_buy_quote_volume": _decimal(buy_quote_volume),
        "taker_sell_base_volume": _decimal(volume - buy_volume),
        "taker_sell_quote_volume": _decimal(quote_volume - buy_quote_volume),
        "trade_count": int(row["count"]), "time_precision": unit, "time_origin": "EXCHANGE",
        "source_provider": "BINANCE", "source_dataset": source["dataset"], "source_schema": source["schema"],
        "source_dataset_version": dataset_version, "source_symbol": source["symbol"],
        "mapping_version": "path-symbology/1", "mapping_reference": f"s3-key:{source['s3_key']}",
        "stream_id": f"binance:{source['dataset']}:{source['schema']}", "lineage_sha256": source["expected_sha256"],
        "lineage_row": position, "quality_state": "UNVERIFIED",
        "quality_flags": ["INGEST_NS_IS_CONVERSION_TIME", "SOURCE_AVAILABILITY_UNKNOWN"],
        "closed": True, "method": f"binance-{source['schema']}/1",
    }


def _output_projection(row, family):
    try:
        projection = {
            "event_ns": str(int(row["event_ns"])), "source_rank": int(row["source_rank"]),
            "stable_position": str(int(row["stable_position"])),
            "ordinal": int(row["ordinal"]), "instrument_id": row["instrument_id"], "family": family,
            "open_ns": str(int(row["open_ns"])), "close_ns": str(int(row["close_ns"])),
            "open": _decimal(row["open"]), "high": _decimal(row["high"]), "low": _decimal(row["low"]),
            "close": _decimal(row["close"]), "volume": _decimal(row["volume"]),
            "buy_volume": _decimal(row["buy_volume"]), "quote_volume": _decimal(row["quote_volume"]),
            "taker_buy_quote_volume": _decimal(row["taker_buy_quote_volume"]),
            "taker_sell_base_volume": _decimal(row["taker_sell_base_volume"]),
            "taker_sell_quote_volume": _decimal(row["taker_sell_quote_volume"]),
            "trade_count": int(row["trade_count"]), "time_precision": row["time_precision"],
            "time_origin": row["time_origin"], "source_provider": row["source_provider"],
            "source_dataset": row["source_dataset"], "source_schema": row["source_schema"],
            "source_dataset_version": row["source_dataset_version"], "source_symbol": row["source_symbol"],
            "mapping_version": row["mapping_version"], "mapping_reference": row["mapping_reference"],
            "stream_id": row["stream_id"], "lineage_sha256": row["lineage_sha256"],
            "lineage_row": int(row["lineage_row"]), "quality_state": row["quality_state"],
            "quality_flags": sorted(row["quality_flags"]), "closed": row["closed"], "method": row["method"],
        }
    except (KeyError, TypeError, ValueError, ArithmeticError) as error:
        raise BinanceQualificationError("QUALIFICATION_OUTPUT_ROW_INVALID") from error
    return projection


def _add_projection(state, projection):
    material = json.dumps({field: projection[field] for field in _RECONCILIATION_FIELDS},
                          sort_keys=True, separators=(",", ":")).encode()
    state["digest"].update(material)
    state["rows"] += 1
    event_ns = int(projection["event_ns"])
    state["first_ns"] = event_ns if state["first_ns"] is None else min(state["first_ns"], event_ns)
    state["last_ns"] = event_ns if state["last_ns"] is None else max(state["last_ns"], event_ns)


def source_reconciliation(sources, dataset_version):
    """Independently digest every accepted source row in reader order."""
    states = {}
    ordered = []
    for source in sources:
        context = _source_context(source)
        ordered.append((source["dataset"], source["symbol"], context["family"],
                        context["start_ns"], source, context))
    ordered.sort(key=lambda entry: entry[:4])
    for _dataset, _symbol, _family, _start, source, context in ordered:
        if _sha256_file(source["source_path"]) != source["expected_sha256"]:
            raise BinanceQualificationError("QUALIFICATION_SOURCE_CHANGED")
        key = (context["instrument_id"], context["family"])
        state = states.setdefault(key, {"digest": hashlib.sha256(), "rows": 0, "first_ns": None, "last_ns": None,
                                        "days": set(), "interval_ns": context["interval_ns"],
                                        "expected_rows": 0})
        state["expected_rows"] += bars_in_window(
            context["interval_ns"], context["start_ns"], context["end_ns"])
        for position, row in csv_decode.validated_kline_month_rows(
                source["source_path"], interval_ns=context["interval_ns"], start_ns=context["start_ns"],
                end_ns=context["end_ns"]):
            projection = _source_projection(source, row, position, dataset_version, context)
            _add_projection(state, projection)
            state["days"].add(dt.datetime.fromtimestamp(
                int(projection["event_ns"]) // 1_000_000_000, tz=dt.timezone.utc).date().isoformat())
    for state in states.values():
        state["digest"] = state["digest"].hexdigest()
    return states


def _candle_contract_shape():
    schema_path = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "archive-query" / "v1" / "archive-query-v1.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    defs = schema["$defs"]
    base = defs["archiveRowBase"]
    candle = defs["candleRow"]["allOf"][1]
    response = defs["response"]
    pointer = defs["pointer"]
    coverage = defs["coverage"]
    return {
        "response_fields": set(response["properties"]),
        "response_required": set(response["required"]),
        "row_fields": set(base["properties"]) | set(candle["properties"]),
        "row_required": set(base["required"]) | set(candle["required"]),
        "pointer_fields": set(pointer["properties"]),
        "pointer_required": set(pointer["required"]),
        "coverage_fields": set(coverage["properties"]),
        "coverage_required": set(coverage["required"]),
        "coverage_states": set(coverage["properties"]["states"]["propertyNames"]["enum"]),
        "gap_states": set(coverage["properties"]["gaps"]["items"]["properties"]["state"]["enum"]),
    }


_UNSIGNED_WIRE = re.compile(r"(?:0|[1-9][0-9]{0,19})\Z")
_INTEGER64_WIRE = re.compile(r"-?(?:0|[1-9][0-9]{0,18})\Z")
_DECIMAL_WIRE = re.compile(r"-?(?:0|[1-9][0-9]{0,25})(?:\.[0-9]{1,12})?\Z")


def _unsigned_wire(value):
    return (isinstance(value, str) and _UNSIGNED_WIRE.fullmatch(value) is not None
            and int(value) <= 18_446_744_073_709_551_615)


def _integer64_wire(value):
    return (isinstance(value, str) and _INTEGER64_WIRE.fullmatch(value) is not None
            and -9_223_372_036_854_775_808 <= int(value) <= 9_223_372_036_854_775_807)


def _nullable_text(value):
    return value is None or isinstance(value, str)


def _nullable_unsigned(value):
    return value is None or _unsigned_wire(value)


def _nullable_integer64(value):
    return value is None or _integer64_wire(value)


def _nullable_decimal(value):
    return value is None or (isinstance(value, str) and _DECIMAL_WIRE.fullmatch(value) is not None)


def _assert_candle_response(response, shape, family):
    """Validate the actual candle response shape from the contract's field set.

    Python jsonschema's 2020-12 evaluator spends minutes re-evaluating the
    `oneOf`/`unevaluatedProperties` archive-row union over a real page in this
    environment. This gate reads its allowed and required field names directly
    from that schema, then checks every row's exact candle wire representation
    and the response envelope. The source/output digest below remains the
    independent semantic check for every value.
    """
    if (not isinstance(response, dict) or set(response) != shape["response_fields"]
            or not shape["response_required"] <= set(response)
            or response.get("contractVersion") != "archive-query/1"
            or response.get("family") != family):
        raise BinanceQualificationError("QUALIFICATION_READER_RESPONSE_SHAPE_MISMATCH")
    pointer = response["pointer"]
    if (not isinstance(pointer, dict) or set(pointer) - shape["pointer_fields"]
            or not shape["pointer_required"] <= set(pointer) or not isinstance(pointer["dataset_version"], str)
            or not isinstance(pointer["catalog_key"], str) or not _SHA256.fullmatch(pointer["catalog_sha256"])
            or not isinstance(pointer["publisher_fence"], int) or isinstance(pointer["publisher_fence"], bool)
            or not 0 <= pointer["publisher_fence"] <= 9_007_199_254_740_991
            or not all(pointer.get(name) is None or isinstance(pointer[name], str) for name in
                       ("converter_version", "contract_version", "roll_table_key", "published_at"))):
        raise BinanceQualificationError("QUALIFICATION_READER_POINTER_SHAPE_MISMATCH")
    if (not isinstance(response["pointerToken"], str) or not response["pointerToken"]
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,512}", response["pointerToken"])
            or response["nextCursor"] is not None and (
                not isinstance(response["nextCursor"], str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,512}", response["nextCursor"]))
            or not isinstance(response["queryFingerprint"], str)
            or _SHA256.fullmatch(response["queryFingerprint"]) is None
            or not isinstance(response["rows"], list) or len(response["rows"]) > 10_000):
        raise BinanceQualificationError("QUALIFICATION_READER_RESPONSE_SHAPE_MISMATCH")
    coverage, scan = response["coverage"], response["scan"]
    if (not isinstance(coverage, dict) or set(coverage) - shape["coverage_fields"]
            or not shape["coverage_required"] <= set(coverage)
            or not isinstance(coverage["requested"], dict)
            or set(coverage["requested"]) != {"from", "to"}
            or not all(_unsigned_wire(coverage["requested"].get(name)) for name in ("from", "to"))
            or int(coverage["requested"]["from"]) >= int(coverage["requested"]["to"])
            or coverage["served"] is not None and (
                not isinstance(coverage["served"], dict) or set(coverage["served"]) != {"from", "to"}
                or not all(_unsigned_wire(coverage["served"].get(name)) for name in ("from", "to"))
                or int(coverage["served"]["from"]) >= int(coverage["served"]["to"]))
            or not isinstance(coverage["partitions"], int) or coverage["partitions"] < 0
            or not isinstance(coverage["states"], dict)
            or not all(state in shape["coverage_states"] and isinstance(value, int)
                       and not isinstance(value, bool) and value >= 0 for state, value in coverage["states"].items())
            or "gaps" in coverage and (
                not isinstance(coverage["gaps"], list) or len(coverage["gaps"]) > 512
                or not all(isinstance(gap, dict) and set(gap) == {"date", "state"}
                           and isinstance(gap["date"], str)
                           and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", gap["date"])
                           and gap["state"] in shape["gap_states"] for gap in coverage["gaps"]))
            or "corrupt" in coverage and (
                not isinstance(coverage["corrupt"], list) or len(coverage["corrupt"]) > 512
                or not all(isinstance(item, dict) and set(item) <= {"date", "reason"} and "date" in item
                           and isinstance(item["date"], str)
                           and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", item["date"])
                           and (item.get("reason") is None or isinstance(item.get("reason"), str)
                                and len(item["reason"]) <= 128) for item in coverage["corrupt"]))
            or not isinstance(scan, dict)
            or set(scan) != {"partitionsRead", "partitionsSelected", "partsOpened", "exactScanBytes", "bytesRead",
                             "cacheHits", "cacheMisses", "fetchMs", "queryMs"}
            or not all(isinstance(scan[name], int) and not isinstance(scan[name], bool) and scan[name] >= 0 for name in
                       ("partitionsRead", "partitionsSelected", "partsOpened", "exactScanBytes", "bytesRead",
                        "cacheHits", "cacheMisses"))
            or not all(isinstance(scan[name], (int, float)) and not isinstance(scan[name], bool)
                       and scan[name] >= 0 for name in ("fetchMs", "queryMs"))):
        raise BinanceQualificationError("QUALIFICATION_READER_RESPONSE_SHAPE_MISMATCH")
    for row in response["rows"]:
        if not isinstance(row, dict) or set(row) != shape["row_fields"] or not shape["row_required"] <= set(row):
            raise BinanceQualificationError("QUALIFICATION_READER_ROW_SHAPE_MISMATCH")
        if (not isinstance(row["record_id"], str) or not row["record_id"] or len(row["record_id"]) > 128
                or not _unsigned_wire(row["event_ns"])
                or not isinstance(row["source_rank"], int) or not 0 <= row["source_rank"] <= 65_535
                or not _unsigned_wire(row["stable_position"])
                or not isinstance(row["ordinal"], int) or not 0 <= row["ordinal"] <= 4_294_967_295
                or not _nullable_integer64(row["sequence"])
                or not _nullable_unsigned(row["receive_ns"]) or not _nullable_unsigned(row["ingest_ns"])
                or not all(_nullable_text(row[name]) for name in (
                    "time_precision", "time_origin", "venue", "market", "symbol", "currency", "size_unit",
                    "contract", "source_provider", "source_dataset", "source_schema", "source_population",
                    "source_dataset_version", "source_method_version", "source_symbol", "mapping_version",
                    "mapping_reference", "stream_id", "quality_state", "method"))
                or not isinstance(row["instrument_id"], str) or not 1 <= len(row["instrument_id"]) <= 256
                or row["lineage_sha256"] is not None and _SHA256.fullmatch(row["lineage_sha256"]) is None
                or not _nullable_unsigned(row["lineage_row"])
                or not isinstance(row["quality_flags"], list) or not all(isinstance(flag, str) for flag in row["quality_flags"])
                or not all(_nullable_unsigned(row[name]) for name in ("open_ns", "close_ns"))
                or not all(_nullable_decimal(row[name]) for name in (
                    "open", "high", "low", "close", "volume", "buy_volume", "quote_volume",
                    "taker_buy_quote_volume", "taker_sell_base_volume", "taker_sell_quote_volume"))
                or row["closed"] is not None and not isinstance(row["closed"], bool)
                or not _nullable_integer64(row["trade_count"])):
            raise BinanceQualificationError("QUALIFICATION_READER_ROW_VALUE_MISMATCH")


def reader_reconciliation(pointer, catalog_root, cache_root, store, expected, *, client="a6-qualification",
                          cache_max_bytes=None, cache_min_free_disk_bytes=None, page_limit=1_000, reader=None):
    """Page the remote publication through the normal archive-service path."""
    import archive_cache
    import archive_reader
    import archive_service

    shape = _candle_contract_shape()
    registry = archive_cache.SnapshotRegistry(catalog_root)
    if not isinstance(page_limit, int) or isinstance(page_limit, bool) or not 1 <= page_limit <= 10_000:
        raise BinanceQualificationError("INVALID_QUALIFICATION_PAGE_LIMIT")
    cache_options = {}
    if cache_max_bytes is not None:
        cache_options["max_bytes"] = cache_max_bytes
    if cache_min_free_disk_bytes is not None:
        cache_options["min_free_disk_bytes"] = cache_min_free_disk_bytes
    cache = archive_cache.PartCache(cache_root, **cache_options)
    spill = Path(cache.root) / "duckdb-spill"
    spill.mkdir(exist_ok=True)
    connection = archive_reader.connect(temp_dir=os.fspath(spill))
    result = {"instruments": {}, "cache_root": os.fspath(cache_root)}
    try:
        for (instrument_id, family), source_state in sorted(expected.items()):
            digest = hashlib.sha256()
            state = {"rows": 0, "first_ns": None, "last_ns": None, "digest": digest}
            cursor, pointer_token, seen_cursors, scan = None, None, set(), {
                "bytesRead": 0, "cacheHits": 0, "cacheMisses": 0, "fetchMs": 0.0, "queryMs": 0.0,
            }
            while True:
                response = archive_service.query(
                    registry, cache, store, connection, instrument_id=instrument_id, family=family,
                    from_ns=str(source_state["first_ns"]),
                    to_ns=str(source_state["last_ns"] + source_state["interval_ns"]),
                    curated_prefix=store.prefix, limit=page_limit, cursor=cursor, pointer_token=pointer_token,
                    client=client, reader=reader)
                _assert_candle_response(response, shape, family)
                if response["pointer"] != pointer:
                    raise BinanceQualificationError("QUALIFICATION_READER_POINTER_MISMATCH")
                if response["coverage"]["states"] != {"PUBLISHED": len(source_state["days"])}:
                    raise BinanceQualificationError("QUALIFICATION_READER_COVERAGE_MISMATCH")
                for row in response["rows"]:
                    _add_projection(state, _output_projection(row, family))
                for name in scan:
                    scan[name] += response["scan"][name]
                cursor, pointer_token = response["nextCursor"], response["pointerToken"]
                if cursor is None:
                    break
                if cursor in seen_cursors:
                    raise BinanceQualificationError("QUALIFICATION_READER_CURSOR_CYCLE")
                seen_cursors.add(cursor)
            state["digest"] = state["digest"].hexdigest()
            if (state["rows"] != source_state["rows"] or state["digest"] != source_state["digest"]
                    or state["first_ns"] != source_state["first_ns"] or state["last_ns"] != source_state["last_ns"]):
                raise BinanceQualificationError("QUALIFICATION_SOURCE_OUTPUT_RECONCILIATION_FAILED")
            result["instruments"][instrument_id] = {
                "rows": state["rows"], "first_ns": state["first_ns"], "last_ns": state["last_ns"],
                "digest": state["digest"], "days": len(source_state["days"]), "scan": scan,
            }
    finally:
        archive_service.shutdown_readers(cache.root)
        connection.close()
    return result


def _validate_acquired_sources(acquired, source_plan):
    if len(acquired) != len(source_plan):
        raise BinanceQualificationError("QUALIFICATION_SOURCE_COUNT_MISMATCH")
    keys = set()
    for source, acquired_source in zip(source_plan, acquired):
        required = {"source_path", "schema", "dataset", "symbol", "s3_key", "expected_sha256",
                    "source_delivered_at", "source_receipt_key"}
        if not isinstance(acquired_source, dict) or set(acquired_source) != required:
            raise BinanceQualificationError("QUALIFICATION_ACQUISITION_RESULT_INVALID")
        if (acquired_source["schema"], acquired_source["dataset"], acquired_source["symbol"]) != (
                source["schema"], source["dataset"], source["symbol"]):
            raise BinanceQualificationError("QUALIFICATION_ACQUISITION_IDENTITY_MISMATCH")
        expected_key = raw_key(source, acquired_source["expected_sha256"])
        receipt = acquired_source["source_receipt_key"]
        if (acquired_source["s3_key"] != expected_key
                or (receipt is not None and receipt != receipt_key(expected_key))):
            raise BinanceQualificationError("QUALIFICATION_ACQUISITION_IDENTITY_MISMATCH")
        if acquired_source["s3_key"] in keys:
            raise BinanceQualificationError("QUALIFICATION_ACQUISITION_DUPLICATE_KEY")
        keys.add(acquired_source["s3_key"])


def _write_evidence(root, value):
    _atomic_bytes(Path(root) / "evidence.json", json.dumps(value, indent=2, sort_keys=True).encode("utf-8") + b"\n")


def verify_node(node_bin, repository_root):
    """A6 uses the repository's exact Node release, not a newer local one."""
    expected = (Path(repository_root) / ".nvmrc").read_text(encoding="utf-8").strip().removeprefix("v")
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", expected) is None:
        raise BinanceQualificationError("INVALID_NODE_VERSION_PIN")
    try:
        observed = subprocess.run([node_bin, "--version"], check=True, capture_output=True, text=True,
                                  timeout=15).stdout.strip().removeprefix("v")
    except (OSError, subprocess.SubprocessError) as error:
        raise BinanceQualificationError("QUALIFICATION_NODE_UNAVAILABLE") from error
    if observed != expected:
        raise BinanceQualificationError(f"QUALIFICATION_NODE_VERSION_MISMATCH:{observed}!={expected}")
    return observed


def run(*, run_id, dataset_version, work_root, raw_store, qualification_store, node_bin, repository_root,
        acquire_fn=acquire, convert_fn=None, publish_fn=None, snapshot_fn=_remote_catalog_snapshot,
        source_reconciliation_fn=source_reconciliation, reader_reconciliation_fn=reader_reconciliation,
        archive_raw=True, reader_cache_min_free_disk_bytes=None):
    """The A6 all-or-nothing qualification workflow.

    Raw receipt writes are append-only. Curated objects and the catalog pointer
    are confined to a fresh qualification namespace; no production prefix is
    addressable through this entry point.
    """
    import convert
    import s3_publish

    prefix = qualification_prefix(run_id)
    if not isinstance(dataset_version, str) or not dataset_version.startswith("qual-"):
        raise BinanceQualificationError("QUALIFICATION_DATASET_VERSION_REQUIRED")
    phase = "preflight"
    layout = _fresh_work_layout(work_root)
    started = time.monotonic()
    evidence = {
        "qualification_version": "binance-a6/1", "run_id": run_id, "dataset_version": dataset_version,
        "namespace": prefix, "started_at": dt.datetime.now(dt.timezone.utc).isoformat(), "status": "RUNNING",
    }
    try:
        if raw_store.bucket != qualification_store.bucket:
            raise BinanceQualificationError("QUALIFICATION_BUCKET_MISMATCH")
        _assert_fresh_namespace(qualification_store, prefix)
        evidence["node_version"] = verify_node(node_bin, repository_root)
        source_plan = inventory()
        phase = "acquisition"
        acquired = [acquire_fn(source, layout["raw"], raw_store, archive_raw=archive_raw)
                    for source in source_plan]
        _validate_acquired_sources(acquired, source_plan)
        evidence["sources"] = [{
            "dataset": source["dataset"], "symbol": source["symbol"], "month": source["month"],
            "raw_s3_key": acquired_source["s3_key"], "raw_sha256": acquired_source["expected_sha256"],
            "source_receipt_key": acquired_source["source_receipt_key"],
        } for source, acquired_source in zip(source_plan, acquired)]
        phase = "source-reconciliation"
        expected = source_reconciliation_fn(acquired, dataset_version)
        scope_days = _scope_days(source_plan)
        if len(expected) != len(_PRODUCTS) * len(_INTERVALS) or any(
                state["rows"] != state["expected_rows"] or len(state["days"]) != scope_days
                for state in expected.values()):
            raise BinanceQualificationError("QUALIFICATION_SOURCE_CENSUS_MISMATCH")
        phase = "conversion"
        convert_fn = convert.convert_files if convert_fn is None else convert_fn
        conversion = convert_fn(acquired, dataset_version, staging_root=os.fspath(layout["stage"]),
                                curated_root=os.fspath(layout["curated"]), catalog_root=os.fspath(layout["catalog"]),
                                node_bin=node_bin, holder="binance-qualification")
        if conversion["accepted"] != sum(state["rows"] for state in expected.values()) or conversion["rejected"]:
            raise BinanceQualificationError("QUALIFICATION_CONVERSION_RECONCILIATION_FAILED")
        if len(conversion["partitions"]) != sum(len(state["days"]) for state in expected.values()):
            raise BinanceQualificationError("QUALIFICATION_PARTITION_CENSUS_MISMATCH")
        phase = "publication"
        publish_fn = s3_publish.publish if publish_fn is None else publish_fn
        publication = publish_fn(qualification_store, layout["curated"], conversion["catalog_pointer"],
                                 expected_parent=None)
        if publication.get("status") != "PUBLISHED":
            raise BinanceQualificationError("QUALIFICATION_PUBLICATION_NOT_FRESH")
        phase = "remote-catalog-readback"
        remote_catalog = snapshot_fn(qualification_store, conversion["catalog_pointer"], layout["readback_catalog"])
        phase = "reader-reconciliation"
        readback = reader_reconciliation_fn(conversion["catalog_pointer"], layout["readback_catalog"],
                                            layout["cache"], qualification_store, expected,
                                            cache_min_free_disk_bytes=reader_cache_min_free_disk_bytes)
        evidence.update({"status": "PASS", "conversion": conversion, "publication": publication,
                         "remote_catalog": remote_catalog, "readback": readback,
                         "elapsed_seconds": round(time.monotonic() - started, 3),
                         "completed_at": dt.datetime.now(dt.timezone.utc).isoformat()})
        _write_evidence(layout["root"], evidence)
        return evidence
    except Exception as error:
        evidence.update({"status": "FAIL", "phase": phase, "error": str(error),
                         "elapsed_seconds": round(time.monotonic() - started, 3),
                         "completed_at": dt.datetime.now(dt.timezone.utc).isoformat()})
        _write_evidence(layout["root"], evidence)
        raise


def _s3_client_from_environment(prefix):
    import boto3
    from botocore.config import Config

    names = (f"{prefix}_REGION", f"{prefix}_ACCESS_KEY_ID", f"{prefix}_SECRET_ACCESS_KEY")
    values = [os.environ.get(name) for name in names]
    if not all(values):
        raise BinanceQualificationError("QUALIFICATION_S3_CREDENTIALS_MISSING:" + ",".join(names))
    return boto3.client(
        "s3", region_name=values[0], aws_access_key_id=values[1], aws_secret_access_key=values[2],
        config=Config(connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}),
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--work-root", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--node-bin", required=True)
    parser.add_argument("--repository-root", default=Path(__file__).resolve().parents[3])
    parser.add_argument("--skip-raw-archive", action="store_true",
                        help="verify every source but do not store a durable copy under raw/binance")
    parser.add_argument("--reader-cache-min-free-disk-bytes", type=int, default=None,
                        help="override the reader-reconciliation cache's free-disk floor, "
                             "which otherwise defaults to a host-sized 200 GiB")
    args = parser.parse_args(argv)
    import s3_publish

    raw_client = _s3_client_from_environment("TT_A6_RAW_S3")
    qualification_client = _s3_client_from_environment("TT_A6_QUALIFICATION_S3")
    result = run(
        run_id=args.run_id, dataset_version=args.dataset_version, work_root=args.work_root,
        raw_store=RawStore(raw_client, args.bucket),
        qualification_store=s3_publish.Store(qualification_client, args.bucket, qualification_prefix(args.run_id)),
        node_bin=args.node_bin, repository_root=args.repository_root,
        archive_raw=not args.skip_raw_archive,
        reader_cache_min_free_disk_bytes=args.reader_cache_min_free_disk_bytes,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
