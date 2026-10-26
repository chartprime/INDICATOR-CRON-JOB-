from __future__ import annotations

import datetime as _dt
import os
import hashlib
import json
from contextlib import closing
from pathlib import Path

from checkpoint import _atomic_write_json
from local_lock import LocalLock


TARDIS_EXCHANGES = frozenset({"binance", "binance-futures"})


class RawSourceError(RuntimeError):
    pass


def is_tardis(dataset):
    return dataset in TARDIS_EXCHANGES


def raw_prefix(dataset, schema, symbol):
    if is_tardis(dataset):
        return f"raw/tardis/exchange={dataset}/data_type={schema}/symbol={symbol}/"
    return f"raw/databento/dataset={dataset}/schema={schema}/symbol={symbol}/"


def _parse_partitions(relative_key):
    segments = relative_key.split("/")
    segments.pop()
    parts = {}
    for segment in segments:
        if "=" not in segment:
            continue
        key, value = segment.split("=", 1)
        parts[key] = value
    return parts


def _covered_range(parts):
    if "year" not in parts or "month" not in parts:
        return None
    year, month = int(parts["year"]), int(parts["month"])
    if "day" in parts:
        start = _dt.date(year, month, int(parts["day"]))
        return start, start + _dt.timedelta(days=1)
    start = _dt.date(year, month, 1)
    end = _dt.date(year + (month == 12), (month % 12) + 1, 1)
    return start, end


def list_raw_objects(client, bucket, dataset, schema, symbol, start_date, end_date):
    start = _dt.date.fromisoformat(start_date)
    end = _dt.date.fromisoformat(end_date)
    if end <= start:
        raise RawSourceError(f"EMPTY_DATE_RANGE:{start_date}:{end_date}")
    prefix = raw_prefix(dataset, schema, symbol)
    objects = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            parts = _parse_partitions(obj["Key"][len(prefix):])
            covered = _covered_range(parts)
            if covered is None:
                continue
            etag = obj.get("ETag")
            if not etag:
                raise RawSourceError(f"MISSING_OBJECT_IDENTITY:{obj['Key']}")
            covered_start, covered_end = covered
            if covered_start < end and covered_end > start:
                objects.append({
                    "s3_key": obj["Key"],
                    "bytes": obj["Size"],
                    "etag": etag,
                    "last_modified": obj["LastModified"].astimezone(_dt.timezone.utc).isoformat(),
                    "covered_end": (covered_end - _dt.timedelta(days=1)).isoformat(),
                })
    return objects


def discover_date_range(client, bucket, dataset, schema, symbol):
    prefix = raw_prefix(dataset, schema, symbol)
    objects = list_raw_objects(client, bucket, dataset, schema, symbol, "1970-01-01", "2100-01-01")
    if not objects:
        raise RawSourceError(f"NO_OBJECTS_FOUND:{dataset}:{schema}:{symbol}")
    earliest = latest = None
    for obj in objects:
        parts = _parse_partitions(obj["s3_key"][len(prefix):])
        start, end = _covered_range(parts)
        if earliest is None or start < earliest:
            earliest = start
        if latest is None or end > latest:
            latest = end
    return earliest.isoformat(), (latest - _dt.timedelta(days=1)).isoformat()


def ensure_local(client, bucket, s3_key, local_dir, expected_etag=None):
    local_dir = os.fspath(local_dir)
    identity = hashlib.sha256((bucket + "\0" + s3_key).encode()).hexdigest()
    local_path = os.path.join(local_dir, identity + "-" + os.path.basename(s3_key))
    with LocalLock(os.path.join(local_dir, ".cache.guard")):
        return _download(client, bucket, s3_key, local_path, expected_etag)


def _download(client, bucket, s3_key, local_path, expected_etag):
    head = client.head_object(Bucket=bucket, Key=s3_key)
    expected_size = head["ContentLength"]
    etag = head.get("ETag")
    if not etag:
        raise RawSourceError(f"MISSING_OBJECT_IDENTITY:{s3_key}")
    if expected_etag is not None and expected_etag != etag:
        raise RawSourceError(f"FROZEN_SOURCE_CHANGED:{s3_key}")
    meta_path = local_path + ".identity.json"
    if os.path.isfile(local_path) and os.path.isfile(meta_path):
        meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
        if meta.get("etag") == etag and os.path.getsize(local_path) == expected_size:
            h = hashlib.sha256()
            with open(local_path, "rb") as fh:
                while chunk := fh.read(1024 * 1024):
                    h.update(chunk)
            if h.hexdigest() == meta.get("sha256"):
                return local_path
    tmp_path = f"{local_path}.partial"
    obj = client.get_object(Bucket=bucket, Key=s3_key, IfMatch=etag)
    try:
        count, h = 0, hashlib.sha256()
        with closing(obj["Body"]) as body, open(tmp_path, "wb") as fh:
            while chunk := body.read(1024 * 1024):
                count += len(chunk)
                if count > expected_size:
                    raise RawSourceError(f"DOWNLOAD_SIZE_MISMATCH:{s3_key}")
                h.update(chunk)
                fh.write(chunk)
            fh.flush()
            os.fsync(fh.fileno())
        if count != expected_size:
            raise RawSourceError(f"DOWNLOAD_SIZE_MISMATCH:{s3_key}:{count}!={expected_size}")
        os.replace(tmp_path, local_path)
        _atomic_write_json(meta_path, {"etag": etag, "sha256": h.hexdigest()})
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    return local_path
