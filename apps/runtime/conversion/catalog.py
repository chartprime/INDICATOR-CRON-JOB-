from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import sqlite3
import time

CONVERTER_VERSION = "conversion/0.2"
CONTRACT_VERSION = "market-observation/1"
PUBLISH_LOCK_WAIT_S = None

_DDL = """
CREATE TABLE IF NOT EXISTS dataset_versions (
  dataset_version TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  converter_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  roll_table_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED'))
);
CREATE TABLE IF NOT EXISTS partitions (
  instrument_id TEXT NOT NULL,
  family TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  date TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'databento',
  s3_prefix TEXT NOT NULL,
  part_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  rejected_count INTEGER NOT NULL,
  event_ns_min INTEGER,
  event_ns_max INTEGER,
  logical_sha256 TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_to_s3 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (instrument_id, family, dataset_version, date)
);
CREATE TABLE IF NOT EXISTS roll_intervals (
  alias TEXT NOT NULL,
  from_ns INTEGER NOT NULL,
  to_ns INTEGER NOT NULL,
  instrument_id TEXT NOT NULL,
  contract_code TEXT NOT NULL,
  tick_size TEXT NOT NULL,
  multiplier TEXT NOT NULL,
  roll_table_version TEXT NOT NULL,
  PRIMARY KEY (alias, from_ns, roll_table_version)
);
CREATE TABLE IF NOT EXISTS continuity (
  instrument_id TEXT NOT NULL,
  family TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  book_epoch INTEGER NOT NULL,
  from_ns INTEGER NOT NULL,
  to_ns INTEGER NOT NULL,
  state TEXT NOT NULL,
  observed_resets INTEGER NOT NULL,
  suspected_gaps INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, family, dataset_version, book_epoch)
);
"""


class CatalogError(RuntimeError):
    pass


def _now_iso():
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_write_json(path, payload):
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    if os.name == "posix":
        fd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def _current_fence(catalog_root):
    current = _read_json(os.path.join(catalog_root, "CURRENT.json"))
    return int(current["publisher_fence"]) if current and "publisher_fence" in current else -1


class CatalogBuilder:
    def __init__(self, db_path):
        self.db_path = os.fspath(db_path)
        self._con = sqlite3.connect(self.db_path)
        self._con.execute("PRAGMA journal_mode=WAL")
        self._con.executescript(_DDL)
        self._con.commit()

    def record_dataset_version(self, dataset_version, roll_table_version=None,
                               converter_version=CONVERTER_VERSION, contract_version=CONTRACT_VERSION):
        self._con.execute(
            "INSERT OR REPLACE INTO dataset_versions "
            "(dataset_version, created_at, converter_version, contract_version, roll_table_version, status) "
            "VALUES (?, ?, ?, ?, ?, 'DRAFT')",
            [dataset_version, _now_iso(), converter_version, contract_version, roll_table_version],
        )
        self._con.commit()

    def record_partition(self, manifest, s3_prefix, manifest_sha256, published_to_s3=False, provider="databento"):
        if provider not in {"databento", "binance"}:
            raise CatalogError(f"UNSUPPORTED_PARTITION_PROVIDER:{provider}")
        self._con.execute(
            "INSERT OR REPLACE INTO partitions "
            "(instrument_id, family, dataset_version, date, provider, s3_prefix, part_count, record_count, "
            " rejected_count, event_ns_min, event_ns_max, logical_sha256, manifest_sha256, created_at, "
            " published_to_s3) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                manifest["instrument_id"], manifest["family"], manifest["dataset_version"], manifest["date"],
                provider, s3_prefix, len(manifest["parts"]), manifest["record_count"], manifest["rejected_count"],
                manifest["event_ns_min"], manifest["event_ns_max"], manifest["logical_sha256"],
                manifest_sha256, _now_iso(), int(bool(published_to_s3)),
            ],
        )
        self._con.commit()

    def record_roll_intervals(self, rows, roll_table_version):
        self._con.executemany(
            "INSERT OR REPLACE INTO roll_intervals "
            "(alias, from_ns, to_ns, instrument_id, contract_code, tick_size, multiplier, roll_table_version) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                [r["alias"], int(r["from_ns"]), int(r["to_ns"]), r["instrument_id"], r["contract_code"],
                 str(r["tick_size"]), str(r["multiplier"]), roll_table_version]
                for r in rows
            ],
        )
        self._con.commit()

    def record_continuity(self, rows):
        self._con.executemany(
            "INSERT OR REPLACE INTO continuity "
            "(instrument_id, family, dataset_version, book_epoch, from_ns, to_ns, state, observed_resets, suspected_gaps) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                [r["instrument_id"], r["family"], r["dataset_version"], int(r["book_epoch"]),
                 int(r["from_ns"]), int(r["to_ns"]), r["state"], int(r["observed_resets"]), int(r["suspected_gaps"])]
                for r in rows
            ),
        )
        self._con.commit()

    def mark_published(self, dataset_version):
        cur = self._con.execute(
            "UPDATE dataset_versions SET status='PUBLISHED' WHERE dataset_version=? AND status='DRAFT'",
            [dataset_version],
        )
        if cur.rowcount != 1:
            raise CatalogError(f"CANNOT_PUBLISH_DATASET_VERSION:{dataset_version}")
        self._con.execute(
            "UPDATE dataset_versions SET status='SUPERSEDED' WHERE status='PUBLISHED' AND dataset_version<>?",
            [dataset_version],
        )
        self._con.commit()

    def close(self):
        self._con.close()


_PUBLISH_LOCK_POLL_S = 0.05


class PublisherLock:
    def __init__(self, catalog_root, holder, lease_s=PUBLISH_LOCK_WAIT_S):
        from local_lock import LocalLock
        self.catalog_root = os.fspath(catalog_root)
        self.holder = holder
        self.lease_s = lease_s
        self.fence = None
        self._lock = LocalLock(os.path.join(self.catalog_root, ".publisher.guard"))

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_exc):
        self.release()

    def acquire(self):
        deadline = None if self.lease_s is None else time.monotonic() + self.lease_s
        while True:
            try:
                self._lock.acquire()
                break
            except OSError as error:
                if deadline is not None and time.monotonic() >= deadline:
                    raise CatalogError("PUBLISH_LOCK_HELD_BY:local-publisher") from error
                time.sleep(_PUBLISH_LOCK_POLL_S)
        try:
            self.fence = max(0, _current_fence(self.catalog_root)) + 1
        except BaseException:
            self.release()
            raise

    def check_owned(self):
        if self._lock.file is None:
            raise CatalogError("PUBLISH_LOCK_LOST")

    def release(self):
        self._lock.release()


def publish(catalog_root, db_path, dataset_version, roll_table_key=None,
            holder="conversion", lease_s=PUBLISH_LOCK_WAIT_S):
    from writer import validate_version
    validate_version(dataset_version)
    catalog_root = os.fspath(catalog_root)
    os.makedirs(catalog_root, exist_ok=True)
    snapshot_name = f"catalog-{dataset_version}.sqlite"
    snapshot_path = os.path.join(catalog_root, snapshot_name)
    current_path = os.path.join(catalog_root, "CURRENT.json")

    with PublisherLock(catalog_root, holder=holder, lease_s=lease_s) as lock:
        if os.path.exists(snapshot_path):
            raise CatalogError(f"SNAPSHOT_ALREADY_PUBLISHED:{snapshot_name}")
        con = sqlite3.connect(os.fspath(db_path))
        try:
            con.execute("VACUUM INTO ?", [snapshot_path])
        finally:
            con.close()
        snapshot_sha = _sha256_file(snapshot_path)

        lock.check_owned()
        existing_fence = _current_fence(catalog_root)
        if lock.fence < existing_fence:
            os.remove(snapshot_path)
            raise CatalogError(f"STALE_PUBLISHER_FENCE:{lock.fence}<{existing_fence}")

        payload = {
            "dataset_version": dataset_version,
            "catalog_key": snapshot_name,
            "catalog_sha256": snapshot_sha,
            "roll_table_key": roll_table_key,
            "converter_version": CONVERTER_VERSION,
            "contract_version": CONTRACT_VERSION,
            "publisher_fence": lock.fence,
            "published_at": _now_iso(),
        }
        _atomic_write_json(current_path, payload)
        return payload


def read_current(catalog_root):
    return _read_json(os.path.join(os.fspath(catalog_root), "CURRENT.json"))


def job_receipt(root, version, job_id):
    receipt = _read_json(os.path.join(root, f"receipt-{version}.json"))
    if not receipt or receipt.get("job_id") != job_id:
        raise CatalogError("PUBLICATION_RECEIPT_MISMATCH")
    payload = receipt["pointer"]
    if _sha256_file(os.path.join(root, payload["catalog_key"])) != payload["catalog_sha256"]:
        raise CatalogError("CATALOG_INTEGRITY_FAILURE")
    return payload


def publish_job(root, db_path, version, job_id, holder="conversion", on_ready_to_publish=None):
    from writer import validate_version
    validate_version(version)
    os.makedirs(root, exist_ok=True)
    with PublisherLock(root, holder) as lock:
        receipt_path = os.path.join(root, f"receipt-{version}.json")
        if os.path.exists(receipt_path):
            return job_receipt(root, version, job_id)
        intent_path = os.path.join(root, f"intent-{version}.json")
        intent = _read_json(intent_path)
        current = read_current(root)
        if intent is None:
            intent = {"job_id": job_id, "parent": current, "pointer": None}
            _atomic_write_json(intent_path, intent)
        if intent["job_id"] != job_id:
            raise CatalogError("VERSION_OWNED_BY_OTHER_JOB")
        payload = intent["pointer"]
        if payload is None:
            if current != intent["parent"]:
                raise CatalogError("PUBLICATION_PARENT_CHANGED")
            snap = os.path.join(root, f"catalog-{version}.sqlite")
            temporary = snap + ".preparing"
            if os.path.exists(temporary):
                os.remove(temporary)
            con = sqlite3.connect(db_path)
            try:
                parent = intent["parent"]
                if parent:
                    parent_path = os.path.join(root, parent["catalog_key"])
                    if _sha256_file(parent_path) != parent["catalog_sha256"]:
                        raise CatalogError("PARENT_CATALOG_CORRUPT")
                    con.execute("ATTACH DATABASE ? AS prior", [parent_path])
                    con.execute("INSERT OR IGNORE INTO dataset_versions SELECT * FROM prior.dataset_versions")
                    prior_columns = {row[1] for row in con.execute("PRAGMA prior.table_info(partitions)")}
                    provider = "COALESCE(p.provider, 'databento')" if "provider" in prior_columns else "'databento'"
                    con.execute(
                        "INSERT OR IGNORE INTO partitions "
                        "(instrument_id, family, dataset_version, date, provider, s3_prefix, part_count, "
                        "record_count, rejected_count, event_ns_min, event_ns_max, logical_sha256, "
                        "manifest_sha256, created_at, published_to_s3) "
                        "SELECT p.instrument_id, p.family, p.dataset_version, p.date, " + provider + ", "
                        "p.s3_prefix, p.part_count, p.record_count, p.rejected_count, p.event_ns_min, "
                        "p.event_ns_max, p.logical_sha256, p.manifest_sha256, p.created_at, p.published_to_s3 "
                        "FROM prior.partitions p WHERE NOT EXISTS (SELECT 1 FROM main.partitions n "
                        "WHERE n.instrument_id=p.instrument_id AND n.family=p.family AND n.date=p.date)"
                    )
                    con.execute("INSERT OR IGNORE INTO roll_intervals SELECT * FROM prior.roll_intervals")
                    con.execute("INSERT OR IGNORE INTO continuity SELECT * FROM prior.continuity")
                    con.commit()
                con.execute("VACUUM INTO ?", [temporary])
            finally:
                con.close()
            payload = {"dataset_version": version, "catalog_key": os.path.basename(snap),
                       "catalog_sha256": _sha256_file(temporary), "publisher_fence": lock.fence,
                       "converter_version": CONVERTER_VERSION, "contract_version": CONTRACT_VERSION,
                       "roll_table_key": None, "published_at": _now_iso()}
            intent["pointer"] = payload
            _atomic_write_json(intent_path, intent)
        snap = os.path.join(root, payload["catalog_key"])
        if not os.path.exists(snap):
            temporary = snap + ".preparing"
            if _sha256_file(temporary) != payload["catalog_sha256"]:
                raise CatalogError("PREPARED_CATALOG_CORRUPT")
            os.replace(temporary, snap)
        if _sha256_file(snap) != payload["catalog_sha256"]:
            raise CatalogError("CATALOG_INTEGRITY_FAILURE")
        if on_ready_to_publish is not None:
            on_ready_to_publish(payload, intent["parent"])
        current = read_current(root)
        if current != payload:
            if current != intent["parent"]:
                raise CatalogError("PUBLICATION_PARENT_CHANGED")
            _atomic_write_json(os.path.join(root, "CURRENT.json"), payload)
        _atomic_write_json(receipt_path, {"job_id": job_id, "pointer": payload})
        return payload
