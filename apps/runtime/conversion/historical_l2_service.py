"""Admitted single-day reads from a viewer-pinned, independently qualified L2 release."""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
import datetime as dt
import hashlib
from pathlib import Path
import re
import time

from archive_admission import Admission
from archive_query import ArchiveQueryError
from archive_reader_bridge import BridgePool
import historical_l2_catalog as catalog
import historical_l2_reader as reader
from s3_publish import Store


CONTRACT_VERSION = reader.CONTRACT
CATALOG_FIELDS = {"contractVersion", "operation"}
PAGE_FIELDS = {"contractVersion", "operation", "snapshotToken", "instrumentId", "date", "family",
               "from", "to", "asOfKey", "limit", "cursor", "maxScanBytes"}
REQUIRED = PAGE_FIELDS - {"cursor", "limit", "maxScanBytes"}


def request(payload):
    if not isinstance(payload, dict) or payload.get("contractVersion") != CONTRACT_VERSION:
        raise ValueError("L2 contract mismatch")
    if payload.get("operation") == "catalog":
        if set(payload) != CATALOG_FIELDS:
            raise ValueError("unknown L2 catalog fields")
        return payload
    if payload.get("operation") != "page" or set(payload) - PAGE_FIELDS or not REQUIRED <= set(payload):
        raise ValueError("invalid L2 page fields")
    catalog.identity(payload["instrumentId"])
    day = payload["date"]
    if (not isinstance(day, str) or catalog.DATE.fullmatch(day) is None
            or not isinstance(payload["family"], str) or payload["family"] not in (*reader.MODULES, "walls", "prints")):
        raise ValueError("L2 session outside supported scope")
    if not isinstance(payload["snapshotToken"], str) or re.fullmatch(r"[A-Za-z0-9_-]{32}", payload["snapshotToken"]) is None:
        raise ValueError("invalid L2 snapshot token")
    if payload.get("cursor") is not None and (not isinstance(payload["cursor"], str) or not 1 <= len(payload["cursor"]) <= 512):
        raise ValueError("invalid L2 cursor")
    lower, upper, _cut, _after = reader.query_arguments(payload["from"], payload["to"], payload["asOfKey"],
                                                       payload.get("limit", 1000), None,
                                                       payload.get("maxScanBytes", reader.MAX_SCAN_BYTES), reader.MAX_PAGE_BYTES)
    start = int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    if lower < start or upper > start + 86_400_000_000_001:
        raise ValueError("L2 page must stay inside its selected UTC day")
    return payload


class Service:
    contract_version = CONTRACT_VERSION

    def __init__(self, store, cache, *, service_secret, admission=None, snapshots=None, pool=None, wall_registry=None, print_registry=None):
        if store.prefix != catalog.PREFIX or not service_secret:
            raise ValueError("L2 service configuration required")
        self.store, self.cache, self.service_secret = store, cache, service_secret
        self.wall_registry = wall_registry
        self.print_registry = print_registry
        self.admission = admission or Admission()
        self.snapshots = snapshots or catalog.Snapshots()
        self.pool = pool or BridgePool(2, temp_root=cache.root,
                                      worker_path=str(Path(__file__).with_name("historical_l2_reader_worker.py")))

    def health(self):
        return {"contractVersion": CONTRACT_VERSION, "ready": bool(self.service_secret),
                "inFlight": self.admission.in_flight, "readerPoolSize": self.pool.size}

    def close(self):
        self.pool.close()

    def query(self, payload, *, client, cancel_token):
        try:
            payload = request(payload)
        except (ValueError, TypeError, KeyError) as error:
            raise ArchiveQueryError("MALFORMED_REQUEST", reason=str(error)[:256]) from error
        with self.admission.acquire(client, token=cancel_token):
            cancel_token.raise_if_cancelled()
            store = Store(self.store.client, self.store.bucket, self.store.prefix)
            cancelled = lambda: cancel_token.cancelled
            try:
                if payload["operation"] == "catalog":
                    try:
                        token, pointer, release = self.snapshots.issue(store, client, cancelled)
                    except RuntimeError as error:
                        raise ArchiveQueryError("OVERLOADED", reason=str(error), retryAfterMs=1000) from error
                    cancel_token.raise_if_cancelled()
                    return {"contractVersion": CONTRACT_VERSION, "operation": "catalog", "snapshotToken": token,
                            "releaseId": pointer["release_id"], "depthLimit": release["depth_limit"],
                            "inference": release["inference"],
                            "sessions": [{k: row[k] for k in ("instrument_id", "date", "state", "reason")}
                                         for row in release["sessions"]],
                            "indexes": self._indexes(pointer, release)}
                try:
                    pointer, release = self.snapshots.resolve(payload["snapshotToken"], client)
                except ValueError as error:
                    raise ArchiveQueryError("POINTER_TOKEN_INVALID", reason=str(error)) from error
                material = {k: v for k, v in payload.items() if k not in ("cursor", "limit")}
                material.update(client=client, releaseId=pointer["release_id"])
                fingerprint = hashlib.sha256(catalog.encoded(material)).hexdigest()
                after = None
                if payload.get("cursor") is not None:
                    try:
                        after = self.snapshots.position(payload["cursor"], fingerprint)
                    except ValueError as error:
                        raise ArchiveQueryError("CURSOR_MALFORMED", reason=str(error)) from error
                at = time.monotonic()
                is_wall = payload["family"] == "walls"
                indexed = payload["family"] in ("walls", "prints")
                descriptor, manifest, prefix = catalog.family(store, pointer, release, payload["instrumentId"],
                                                              payload["date"], "events" if indexed else payload["family"], cancelled)
                if indexed:
                    registry = self.wall_registry if is_wall else self.print_registry
                    if registry is None:
                        raise catalog.Unavailable("WALL_INDEX_NOT_QUALIFIED" if is_wall else "SOURCE_PRINT_INDEX_NOT_QUALIFIED")
                    if is_wall:
                        from historical_l2_walls import manifest_parts as indexed_parts
                    else:
                        from historical_l2_prints import manifest_parts as indexed_parts
                    manifest, directory = registry.admit(pointer, release, descriptor, manifest,
                                                                   payload["instrumentId"], payload["date"])
                    inventory = [{**part, "name": part["key"], "first_known_ns": part["min_known_ns"],
                                  "last_known_ns": part["max_known_ns"]} for part in indexed_parts(manifest)]
                else:
                    inventory = reader.manifest_parts(manifest, payload["family"])
                candidates, total = [], 0
                for part in inventory:
                    if (int(part["first_known_ns"]) >= int(payload["to"]) or int(part["last_known_ns"]) < int(payload["from"])
                            or after is not None and part["last_position"] <= int(after)):
                        continue
                    if total + part["bytes"] > payload.get("maxScanBytes", reader.MAX_SCAN_BYTES):
                        break
                    total += part["bytes"]
                    candidates.append(part)
                with ExitStack() as stack:
                    paths, hits, misses = {}, 0, 0
                    for part in candidates:
                        cancel_token.raise_if_cancelled()
                        if indexed:
                            path, hit = directory / part["name"], True
                        else:
                            path, hit = stack.enter_context(self._part(store, prefix, part, cancel_token))
                        paths[part["name"]] = str(path)
                        hits += int(hit)
                        misses += int(not hit)
                    fetch_ms = (time.monotonic() - at) * 1000
                    cancel_token.raise_if_cancelled()
                    query_at = time.monotonic()
                    with self.pool.acquire() as bridge:
                        result = bridge.read_page({"manifest": manifest, "paths": paths, "family": payload["family"],
                                                   "from": payload["from"], "to": payload["to"],
                                                   "asOfKey": payload["asOfKey"], "limit": payload.get("limit", 1000),
                                                   "afterPosition": after,
                                                   "maxScanBytes": payload.get("maxScanBytes", reader.MAX_SCAN_BYTES)},
                                                  cancel_token=cancel_token)
                    cancel_token.raise_if_cancelled()
                next_cursor = None if result["nextPosition"] is None else self.snapshots.cursor(fingerprint, result["nextPosition"])
                return {"contractVersion": CONTRACT_VERSION, "operation": "page", "releaseId": pointer["release_id"],
                        "snapshotToken": payload["snapshotToken"], "instrumentId": payload["instrumentId"],
                        "date": payload["date"], "family": payload["family"], "from": payload["from"], "to": payload["to"],
                        "asOfKey": payload["asOfKey"], "derivationId": descriptor["derivation_id"],
                        "depthLimit": descriptor["depth_limit"], "tickSize": descriptor["tick_size"],
                        "quantityUnit": descriptor["units"]["quantity"], "rows": result["rows"], "nextCursor": next_cursor,
                        "truncatedBy": result["truncatedBy"],
                        **({"wallProfile": manifest["profile"], "wallProfileId": manifest["profile_id"]} if is_wall else {}),
                        "scan": {"scanBytes": result["scanBytes"], "partsOpened": result["partsOpened"],
                                 "bytesRead": store.read_bytes, "cacheHits": hits, "cacheMisses": misses,
                                 "fetchMs": fetch_ms, "queryMs": (time.monotonic() - query_at) * 1000}}
            except catalog.Unavailable as error:
                raise ArchiveQueryError("UNKNOWN_INSTRUMENT", reason=str(error)[:256]) from error
            except InterruptedError as error:
                raise ArchiveQueryError("CANCELLED", reason="L2 read cancelled") from error
            except (ValueError, KeyError, TypeError) as error:
                raise ArchiveQueryError("PARTITION_VERIFICATION_FAILED", reason=str(error)[:256]) from error
            except ArchiveQueryError:
                raise
            except Exception as error:
                cancel_token.raise_if_cancelled()
                raise ArchiveQueryError("READER_UNAVAILABLE", reason="L2_STORAGE_OR_READER_FAILURE") from error

    @contextmanager
    def _part(self, store, prefix, part, cancel_token):
        self.cache.pin(part["sha256"])
        try:
            path = self.cache.warm(part["sha256"], part["bytes"])
            hit = path is not None
            if path is None:
                path = self.cache.admit(store, prefix + "/" + part["name"], part["sha256"], part["bytes"],
                                        cancel_check=cancel_token.raise_if_cancelled)
            yield path, hit
        finally:
            self.cache.release(part["sha256"])

    def _indexes(self, pointer, release):
        available = {(row["instrument_id"], row["date"]): row for row in release["sessions"] if row["state"] == "AVAILABLE"}
        result = []
        for family, registry in (("walls", self.wall_registry), ("prints", self.print_registry)):
            if registry is None:
                continue
            for (instrument, day), (_directory, _body, manifest) in registry.entries.items():
                row = available.get((instrument, day))
                if row is not None and manifest["release_id"] == pointer["release_id"] and manifest["descriptor_sha256"] == row["descriptor_sha256"]:
                    result.append({"family": family, "instrument_id": instrument, "date": day})
        return sorted(result, key=lambda row: (row["instrument_id"], row["date"], row["family"]))
