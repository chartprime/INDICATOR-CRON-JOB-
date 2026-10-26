from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

import zstandard

PREFIX = "raw/live-capture/"
EXPORTER_VERSION = 2
WATERMARK_VERSION = 2
READ_BATCH_ROWS = 50_000
READ_BATCH_BYTES = 32 * 1024 * 1024
COPY_BYTES = 8 * 1024 * 1024
ZSTD_LEVEL = 6
DEFAULT_MAX_SECONDS = 3_000
DEFAULT_WATERMARK = "/var/lib/terminal-l1-l2/capture-export/watermark.json"
DEFAULT_DATA_ROOT = "/srv/terminal-data/capture"
CONFIG_EXIT = 2

TARGETS = {
    "binance": {
        "db": os.path.join("live", "market-data.sqlite"),
        "tables": (
            ("trades", "ts", 2_000_000),
            ("l2_depth_events", "ts", 150_000),
            ("l2_depth_snapshots", "captured_at", 3_000),
        ),
    },
    "dxfeed": {
        "db": os.path.join("live", "dxfeed-market-data.sqlite"),
        "tables": (
            ("dxfeed_order_book_capture", "received_at", 2_000_000),
            ("dxfeed_time_and_sales", "event_time", 2_000_000),
            ("dxfeed_quotes", "event_time", 2_000_000),
            ("dxfeed_trades", "event_time", 2_000_000),
        ),
    },
}


class ExportError(RuntimeError):
    pass


def _log(**fields):
    print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields}, sort_keys=True), flush=True)


def _status(error):
    return getattr(error, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")


def _sha256_of(handle):
    digest = hashlib.sha256()
    size = 0
    for block in iter(lambda: handle.read(COPY_BYTES), b""):
        digest.update(block)
        size += len(block)
    return digest.hexdigest(), size


class CaptureStore:
    def __init__(self, client, bucket):
        self.client, self.bucket = client, bucket

    @staticmethod
    def _checked(key):
        if not key.startswith(PREFIX) or ".." in key.split("/") or "//" in key:
            raise ExportError(f"refusing key outside {PREFIX}: {key}")
        return key

    def digest(self, key):
        try:
            body = self.client.get_object(Bucket=self.bucket, Key=self._checked(key))["Body"]
        except Exception as error:
            if _status(error) == 404:
                return None
            raise
        try:
            return _sha256_of(body)[0]
        finally:
            body.close()

    def _put_once(self, checked, body, sha256):
        try:
            self.client.put_object(Bucket=self.bucket, Key=checked, Body=body, IfNoneMatch="*")
        except Exception as error:
            if _status(error) != 412:
                raise
            if self.digest(checked) != sha256:
                raise ExportError(f"{checked} already exists with different content") from error
        if self.digest(checked) != sha256:
            raise ExportError(f"{checked} read back differently from what was written")

    def write_once(self, key, data):
        self._put_once(self._checked(key), data, hashlib.sha256(data).hexdigest())

    def upload_once(self, key, path, sha256):
        checked = self._checked(key)
        with open(path, "rb") as body:
            self._put_once(checked, body, sha256)

    def has_exports(self):
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=PREFIX):
            if page.get("Contents"):
                return True
        return False


def chunk_key(target, table, chunk_from, chunk_to, first_time_ms, suffix):
    day = time.strftime("%Y-%m-%d", time.gmtime(first_time_ms / 1000))
    return f"{PREFIX}{target}/{table}/date={day}/ids-{chunk_from:012d}-{chunk_to:012d}{suffix}"


def next_chunk(chunk_rows, exported_through, min_id, max_id):
    start = exported_through + 1 if exported_through is not None else min_id
    if start is None or max_id is None or start > max_id:
        return None
    index = (start - 1) // chunk_rows
    return start, min((index + 1) * chunk_rows, max_id)


def source_identity(path, name):
    source = _source(path)
    try:
        table = "capture_sessions" if name == "binance" else "dxfeed_capture_sessions"
        first = source.execute(f"SELECT session_id FROM {table} ORDER BY rowid LIMIT 1").fetchone()
        return {"path": str(Path(path).resolve()).replace("\\", "/"), "fileId": str(os.stat(path).st_ino),
                "firstSessionId": first[0] if first else None}
    finally:
        source.close()


def load_watermark(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {"version": WATERMARK_VERSION, "targets": {}, "sources": {}}
    if not isinstance(data, dict) or data.get("version") != WATERMARK_VERSION or not isinstance(data.get("targets"), dict) or not isinstance(data.get("sources"), dict):
        raise ExportError(f"{path} is not a version {WATERMARK_VERSION} watermark")
    return data


def save_watermark(path, data):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    temporary = f"{path}.tmp-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(data, handle, sort_keys=True, indent=1)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    if os.name == "posix":
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


@contextmanager
def export_lock(watermark_path):
    os.makedirs(os.path.dirname(watermark_path) or ".", exist_ok=True)
    with open(f"{watermark_path}.lock", "a+b") as handle:
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(handle.fileno()).st_size == 0:
                    handle.write(b"0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise ExportError("another capture export owns this watermark") from error
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _source(path):
    if not os.path.exists(path):
        raise ExportError(f"capture database not found at {path}")
    return sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True, isolation_level=None, timeout=60)


def _bounds(source, table):
    low = source.execute(f"SELECT min(id) FROM {table}").fetchone()[0]
    high = source.execute(f"SELECT max(id) FROM {table}").fetchone()[0]
    return low, high


def write_slice(source, table, time_column, chunk_from, chunk_to, slice_path):
    create_sql = source.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()[0]
    columns = [row[1] for row in source.execute(f"PRAGMA table_info({table})")]
    id_index, time_index = columns.index("id"), columns.index(time_column)
    if os.path.exists(slice_path):
        os.remove(slice_path)
    target = sqlite3.connect(slice_path, isolation_level=None)
    stats = {"rows": 0, "firstId": None, "lastId": None, "timeMin": None, "timeMax": None}
    try:
        target.execute("PRAGMA journal_mode = OFF")
        target.execute("PRAGMA synchronous = OFF")
        target.execute(create_sql)
        insert = f"INSERT INTO {table} VALUES ({', '.join('?' * len(columns))})"
        target.execute("BEGIN")
        source.execute("BEGIN")
        try:
            cursor = source.execute(f"SELECT * FROM {table} WHERE id >= ? AND id <= ? ORDER BY id", (chunk_from, chunk_to))
            batch_rows = 1
            while True:
                batch = cursor.fetchmany(batch_rows)
                if not batch:
                    break
                target.executemany(insert, batch)
                batch_bytes = sum(_row_bytes(row) for row in batch)
                batch_rows = max(1, min(READ_BATCH_ROWS, len(batch) * READ_BATCH_BYTES // max(1, batch_bytes)))
                stats["rows"] += len(batch)
                if stats["firstId"] is None:
                    stats["firstId"] = batch[0][id_index]
                stats["lastId"] = batch[-1][id_index]
                times = [row[time_index] for row in batch]
                stats["timeMin"] = min(times) if stats["timeMin"] is None else min(stats["timeMin"], min(times))
                stats["timeMax"] = max(times) if stats["timeMax"] is None else max(stats["timeMax"], max(times))
        finally:
            source.execute("COMMIT")
        target.execute("COMMIT")
    finally:
        target.close()
    return create_sql, stats


def _row_bytes(row):
    return sum(len(value) if isinstance(value, (str, bytes)) else 8 for value in row)


def _compress(slice_path, packed_path):
    raw_bytes = os.path.getsize(slice_path)
    with open(slice_path, "rb") as source, open(packed_path, "wb") as packed:
        zstandard.ZstdCompressor(level=ZSTD_LEVEL).copy_stream(source, packed, size=raw_bytes, read_size=COPY_BYTES)
    with open(packed_path, "rb") as packed:
        sha256, compressed_bytes = _sha256_of(packed)
    return raw_bytes, compressed_bytes, sha256


def export_chunk(store, source, target, table, time_column, chunk_from, chunk_to, staging_dir, identity):
    os.makedirs(staging_dir, exist_ok=True)
    slice_path = os.path.join(staging_dir, f"{target}-{table}-{chunk_from}-{chunk_to}.sqlite")
    packed_path = f"{slice_path}.zst"
    try:
        create_sql, stats = write_slice(source, table, time_column, chunk_from, chunk_to, slice_path)
        if stats["rows"] == 0:
            return {"chunkFrom": chunk_from, "chunkTo": chunk_to, "rows": 0, "object": None}
        raw_bytes, compressed_bytes, sha256 = _compress(slice_path, packed_path)
        os.remove(slice_path)
        data_key = chunk_key(target, table, chunk_from, chunk_to, stats["timeMin"], ".sqlite.zst")
        manifest = {
            "exporterVersion": EXPORTER_VERSION,
            "source": identity,
            "target": target,
            "table": table,
            "chunkFrom": chunk_from,
            "chunkTo": chunk_to,
            "object": data_key,
            "rawBytes": raw_bytes,
            "compressedBytes": compressed_bytes,
            "sha256": sha256,
            "schemaSql": create_sql,
            "timeColumn": time_column,
            **stats,
        }
        store.upload_once(data_key, packed_path, sha256)
    finally:
        for path in (slice_path, packed_path):
            if os.path.exists(path):
                os.remove(path)
    store.write_once(chunk_key(target, table, chunk_from, chunk_to, stats["timeMin"], ".json"),
                     json.dumps(manifest, sort_keys=True, indent=1).encode("utf-8"))
    return {"chunkFrom": chunk_from, "chunkTo": chunk_to, "rows": stats["rows"], "object": data_key}


def export_target(store, name, db_path, watermark, watermark_path, staging_dir, deadline, now=time.monotonic):
    spec = TARGETS[name]
    identity = source_identity(db_path, name)
    previous = watermark["sources"].get(name)
    if previous is not None and previous != identity and watermark["targets"].get(name):
        raise ExportError(f"{name} capture database identity changed; refusing its previous watermark")
    if previous is None and watermark["targets"].get(name):
        raise ExportError(f"{name} watermark has no source identity")
    watermark["sources"][name] = identity
    entries = watermark["targets"].setdefault(name, {})
    source = _source(db_path)
    tables = []
    try:
        for index, (table, time_column, chunk_rows) in enumerate(spec["tables"]):
            table_deadline = now() + max(0.0, deadline - now()) / (len(spec["tables"]) - index)
            summary = {"table": table, "chunks": 0, "rows": 0, "done": True}
            low, high = _bounds(source, table)
            entry = entries.get(table, {})
            through = entry.get("exportedThroughId")
            if entry and entry.get("chunkRows") != chunk_rows:
                raise ExportError(f"{table} chunk grid changed")
            if through is not None:
                sequence = source.execute("SELECT seq FROM sqlite_sequence WHERE name = ?", (table,)).fetchone()
                if type(through) is not int or through < 0 or sequence is None or through > sequence[0]:
                    raise ExportError(f"{table} watermark exceeds its source sequence")
            while True:
                if now() >= table_deadline:
                    summary["done"] = False
                    break
                through = entries.get(table, {}).get("exportedThroughId")
                pending = entries.get(table, {}).get("pending")
                chunk = tuple(pending) if pending is not None else next_chunk(chunk_rows, through, low, high)
                if chunk is None:
                    break
                if (len(chunk) != 2 or any(type(value) is not int for value in chunk) or
                        chunk[0] != (through + 1 if through is not None else low) or
                        chunk[0] < 1 or chunk[1] < chunk[0] or high is None or chunk[1] > high or
                        chunk[1] > ((chunk[0] - 1) // chunk_rows + 1) * chunk_rows):
                    raise ExportError(f"{table} pending range does not match its source")
                if pending is None:
                    entries[table] = {"exportedThroughId": through, "chunkRows": chunk_rows, "pending": list(chunk)}
                    save_watermark(watermark_path, watermark)
                result = export_chunk(store, source, name, table, time_column, chunk[0], chunk[1], staging_dir, identity)
                if source_identity(db_path, name) != identity:
                    raise ExportError(f"{name} capture database changed during export")
                entries[table] = {"exportedThroughId": chunk[1], "chunkRows": chunk_rows}
                save_watermark(watermark_path, watermark)
                summary["chunks"] += 1
                summary["rows"] += result["rows"]
            summary["exportedThroughId"] = entries.get(table, {}).get("exportedThroughId")
            tables.append(summary)
    finally:
        source.close()
    return {"target": name, "done": len(tables) == len(spec["tables"]) and all(t["done"] for t in tables), "tables": tables}


def read_credentials(path):
    values = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if "=" in line:
                key, value = line.strip().split("=", 1)
                values[key] = value
    missing = [key for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY") if not values.get(key)]
    if missing:
        raise ExportError(f"credentials file lacks {', '.join(missing)}")
    return values["AWS_ACCESS_KEY_ID"], values["AWS_SECRET_ACCESS_KEY"]


def build_client(region, credentials_path):
    import boto3
    from botocore.config import Config

    access_key, secret_key = read_credentials(credentials_path)
    return boto3.client(
        "s3", region_name=region, aws_access_key_id=access_key, aws_secret_access_key=secret_key,
        config=Config(connect_timeout=10, read_timeout=300, retries={"max_attempts": 3}),
    )


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="capture_export")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--target", choices=("all", *TARGETS), default="all")
    parser.add_argument("--data-root", default=os.environ.get("TT_DATA_ROOT", DEFAULT_DATA_ROOT))
    parser.add_argument("--watermark", default=DEFAULT_WATERMARK)
    parser.add_argument("--staging-dir", required=True)
    parser.add_argument("--max-seconds", type=int, default=DEFAULT_MAX_SECONDS)
    parser.add_argument("--credentials", required=True)
    args = parser.parse_args(argv)
    if args.max_seconds < 1:
        parser.error("--max-seconds must be a positive integer")
    return args


def _run_locked(args, store, now):
    deadline = now() + args.max_seconds
    watermark = load_watermark(args.watermark)
    if not watermark["targets"] and store.has_exports():
        raise ExportError("remote capture exports exist without a local checkpoint; recovery is required")
    destination = {"bucket": args.bucket, "prefix": PREFIX}
    if watermark.get("destination", destination) != destination:
        raise ExportError("export destination changed; refusing its previous watermark")
    watermark["destination"] = destination
    names = list(TARGETS) if args.target == "all" else [args.target]
    exit_code = 0
    for index, name in enumerate(names):
        target_deadline = now() + max(0.0, deadline - now()) / (len(names) - index)
        db_path = os.path.join(args.data_root, TARGETS[name]["db"])
        try:
            summary = export_target(store, name, db_path, watermark, args.watermark, args.staging_dir, target_deadline, now)
            _log(step="capture export pass finished", **summary)
        except Exception as error:
            exit_code = 1
            _log(step="capture export pass failed", target=name, reason=str(error))
    return exit_code


def run(args, store, now=time.monotonic):
    try:
        with export_lock(args.watermark):
            return _run_locked(args, store, now)
    except Exception as error:
        _log(step="capture export failed", reason=str(error))
        return 1


def main(argv=None, store=None, now=time.monotonic):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as error:
        return CONFIG_EXIT if error.code else 0
    try:
        if store is None:
            store = CaptureStore(build_client(args.region, args.credentials), args.bucket)
        return run(args, store, now)
    except (ExportError, OSError) as error:
        _log(step="capture export failed", reason=str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
