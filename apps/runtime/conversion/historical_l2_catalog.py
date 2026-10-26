"""Authenticate the separate L2 publication graph and pin it per viewer."""

from __future__ import annotations

import base64
import binascii
import datetime as dt
from collections import OrderedDict
import hashlib
import hmac
import json
import re
import secrets
import threading
import time

from historical_l2_events import reject_constant
from historical_l2_reader import manifest_parts
from s3_publish import _relative


PREFIX = "curated/l2-core"
CONTROL_BYTES = 4 * 1024**2
TTL = 900
SHA = re.compile(r"[a-f0-9]{64}\Z")
DATE = re.compile(r"2026-08-(0[1-9]|[12][0-9]|3[01])\Z")
PROFILES = (("XCME", "FUTURE", "ESU6", "USD", "CONTRACT"),
            ("XCME", "FUTURE", "NQU6", "USD", "CONTRACT"),
            ("XNAS", "EQUITY", "AAPL", "USD", "SHARE"),
            ("XNAS", "EQUITY", "TSLA", "USD", "SHARE"))


class Unavailable(LookupError):
    """An explicit unpublished release or unavailable catalog disposition."""


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha(value):
    if not isinstance(value, str) or SHA.fullmatch(value) is None:
        raise ValueError("invalid L2 SHA-256")
    return value


def identity(value):
    if not isinstance(value, str) or len(value) > 128:
        raise ValueError("invalid L2 instrument")
    try:
        fields = json.loads(value)
    except (ValueError, TypeError) as error:
        raise ValueError("invalid L2 instrument") from error
    if (not isinstance(fields, list) or len(fields) != 5 or not all(isinstance(v, str) and v for v in fields)
            or json.dumps(fields, separators=(",", ":")) != value
            or tuple(fields) not in PROFILES):
        raise ValueError("unsupported L2 instrument")
    return fields


def pinned_json(store, key, checksum, size, cancelled=lambda: False):
    sha(checksum)
    _relative(key)
    if type(size) is not int or not 0 < size <= CONTROL_BYTES:
        raise ValueError("L2 control object exceeds admission")
    if cancelled():
        raise InterruptedError("L2 catalog read cancelled")
    obj = store.client.get_object(Bucket=store.bucket, Key=store.key(key))
    if obj.get("ContentLength", size) != size:
        obj["Body"].close()
        raise ValueError("L2 control object length differs")
    chunks, count, digest = [], 0, hashlib.sha256()
    with obj["Body"] as body:
        while chunk := body.read(min(65_536, size - count + 1)):
            if cancelled():
                raise InterruptedError("L2 catalog read cancelled")
            count += len(chunk)
            store.read_bytes += len(chunk)
            if count > size:
                raise ValueError("L2 control object exceeds pinned size")
            digest.update(chunk)
            chunks.append(chunk)
    if count != size or digest.hexdigest() != checksum:
        raise ValueError("L2 control object hash differs")
    return json.loads(b"".join(chunks), parse_constant=reject_constant)


def current(store, cancelled=lambda: False):
    if store.prefix != PREFIX:
        raise ValueError("L2 serving namespace differs")
    pointer, _etag = store.get_json("_catalog/CURRENT.json")
    if pointer is None:
        raise Unavailable("L2 release not published")
    if (not isinstance(pointer, dict) or set(pointer) != {"schema", "release_id", "catalog_key", "catalog_sha256", "catalog_bytes"}
            or pointer["schema"] != "historical-l2-pointer/1"
            or sha(pointer["release_id"]) != pointer["catalog_sha256"]
            or pointer["catalog_key"] != "_catalog/releases/" + pointer["release_id"] + ".json"
            or type(pointer["catalog_bytes"]) is not int or not 0 < pointer["catalog_bytes"] <= 65_536):
        raise ValueError("invalid L2 pointer")
    payload = pinned_json(store, pointer["catalog_key"], pointer["catalog_sha256"], pointer["catalog_bytes"], cancelled)
    if (not isinstance(payload, dict) or payload.get("schema") != "historical-l2-release/1"
            or payload.get("month") != "2026-08" or payload.get("depth_limit") != 10
            or payload.get("scope") not in ("QUALIFIED_SUBSET", "COMPLETE_MONTH_DISPOSITIONS")
            or payload.get("inference") != "top-ten depth inference; not order-level cancellation truth"):
        raise ValueError("invalid L2 release")
    sha(payload.get("plan_id"))
    sha(payload.get("source_catalog_sha256"))
    rows = payload.get("sessions")
    if not isinstance(rows, list) or len(rows) != 124:
        raise ValueError("L2 release inventory incomplete")
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid L2 session")
        fields = identity(row.get("instrument_id"))
        day = row.get("date")
        if not isinstance(day, str) or DATE.fullmatch(day) is None or (row["instrument_id"], day) in seen:
            raise ValueError("invalid or duplicate L2 session date")
        seen.add((row["instrument_id"], day))
        if row.get("state") == "AVAILABLE":
            derivation = sha(row.get("derivation_id"))
            slug = hashlib.sha256(row["instrument_id"].encode()).hexdigest()
            key = f"databento/instrument={slug}/derivation={derivation}/date={day}/candidate.json"
            if (row.get("reason") != "FULL_DAY_VERIFIED" or row.get("descriptor_key") != key
                    or type(row.get("descriptor_bytes")) is not int or not 0 < row["descriptor_bytes"] <= CONTROL_BYTES):
                raise ValueError("invalid L2 available session")
            sha(row.get("descriptor_sha256"))
        elif row.get("state") != "UNAVAILABLE" or not isinstance(row.get("reason"), str) or not row["reason"]:
            raise ValueError("invalid L2 unavailable session")
        if fields[2] not in ("ESU6", "NQU6", "AAPL", "TSLA"):
            raise ValueError("L2 instrument outside qualified scope")
    instruments = {instrument for instrument, _day in seen}
    if len(instruments) != 4 or any(sum(i == instrument for i, _ in seen) != 31 for instrument in instruments):
        raise ValueError("L2 monthly coverage differs")
    return pointer, payload


def family(store, pointer, payload, instrument_id, day, name, cancelled=lambda: False):
    if name not in ("events", "states"):
        raise ValueError("unsupported L2 family")
    profile = identity(instrument_id)
    rows = [row for row in payload["sessions"] if row["instrument_id"] == instrument_id and row["date"] == day]
    if len(rows) != 1:
        raise Unavailable("L2 instrument or date unavailable")
    row = rows[0]
    if row["state"] != "AVAILABLE":
        raise Unavailable(row["reason"])
    descriptor = pinned_json(store, row["descriptor_key"], row["descriptor_sha256"], row["descriptor_bytes"], cancelled)
    prefix = PREFIX + "/" + row["descriptor_key"].removesuffix("/candidate.json")
    start = int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
    units = {"price": profile[3], "quantity": profile[4], "time": "UTC nanoseconds", "inference": "engine-number"}
    if (not isinstance(descriptor, dict) or descriptor.get("schema") != "historical-l2-candidate/1" or descriptor.get("status") != "LOCAL_VERIFIED; NOT_PUBLISHED"
            or descriptor.get("prefix") != prefix or descriptor.get("instrument_id") != instrument_id
            or descriptor.get("date") != day or descriptor.get("derivation_id") != row["derivation_id"]
            or descriptor.get("source_catalog_sha256") != payload["source_catalog_sha256"]
            or descriptor.get("depth_limit") != 10
            or descriptor.get("tick_size") != ("0.25" if profile[1] == "FUTURE" else "0.01")
            or descriptor.get("units") != units
            or descriptor.get("window_from_ns") != str(start)
            or descriptor.get("window_to_ns") != str(start + 86_400_000_000_000)):
        raise ValueError("L2 descriptor identity differs")
    objects = descriptor.get("objects")
    if not isinstance(objects, list) or not 4 <= len(objects) <= 2050:
        raise ValueError("L2 descriptor graph exceeds admission")
    graph = {}
    for obj in objects:
        if not isinstance(obj, dict):
            raise ValueError("invalid L2 descriptor object")
        key = obj.get("key")
        if (not isinstance(key, str) or not key.startswith(prefix + "/") or key in graph
                or type(obj.get("bytes")) is not int or not 0 < obj["bytes"] <= 16 * 1024**2):
            raise ValueError("L2 descriptor object admission failed")
        _relative(key)
        sha(obj.get("sha256"))
        graph[key] = obj
    key = prefix + "/" + name + "/manifest.json"
    entry = graph.get(key)
    if entry is None:
        raise ValueError("L2 manifest absent from descriptor")
    relative = key.removeprefix(PREFIX + "/")
    manifest = pinned_json(store, relative, entry["sha256"], entry["bytes"], cancelled)
    parts = manifest_parts(manifest, name)
    if any(int(part["first_known_ns"]) < start or int(part["last_known_ns"]) > start + 86_400_000_000_000 for part in parts):
        raise ValueError("L2 part knowledge outside selected day")
    families = descriptor.get("families")
    if not isinstance(families, dict) or not isinstance(families.get(name), dict):
        raise ValueError("invalid L2 family descriptor")
    if name == "states" and (manifest.get("window_from_ns") != descriptor["window_from_ns"]
                             or manifest.get("window_to_ns") != descriptor["window_to_ns"]):
        raise ValueError("L2 state window differs")
    if (manifest["instrument_id"] != instrument_id or manifest["derivation_id"] != row["derivation_id"]
            or descriptor["families"][name]["manifest_sha256"] != entry["sha256"]
            or descriptor["families"][name]["rows"] != manifest["rows"]):
        raise ValueError("L2 family identity differs")
    for part in parts:
        part_key = prefix + "/" + name + "/" + part["name"]
        if graph.get(part_key) != {"key": part_key, **{k: v for k, v in part.items() if k not in ("first_position", "last_position")}}:
            raise ValueError("L2 part graph differs from manifest")
    return descriptor, manifest, relative.removesuffix("/manifest.json")


class Snapshots:
    def __init__(self, *, clock=time.time):
        self.clock = clock
        self.entries = OrderedDict()
        self.lock = threading.Lock()
        self.secret = secrets.token_bytes(32)

    def issue(self, store, client, cancelled=lambda: False):
        if not isinstance(client, str) or not 1 <= len(client) <= 128:
            raise ValueError("L2 viewer identity required")
        pointer, payload = current(store, cancelled)
        with self.lock:
            now = self.clock()
            for key in list(self.entries):
                if self.entries[key][1] <= now:
                    del self.entries[key]
            for token, entry in self.entries.items():
                if entry[0] == client and entry[2] == pointer:
                    return token, entry[2], entry[3]
            if len(self.entries) >= 128 or sum(v[0] == client for v in self.entries.values()) >= 4:
                raise RuntimeError("L2 snapshot capacity exceeded")
            token = secrets.token_urlsafe(24)
            self.entries[token] = (client, now + TTL, pointer, payload)
            return token, pointer, payload

    def resolve(self, token, client):
        if not isinstance(token, str) or len(token) != 32:
            raise ValueError("invalid L2 snapshot token")
        with self.lock:
            entry = self.entries.get(token)
            if entry is None or entry[0] != client or entry[1] <= self.clock():
                raise ValueError("expired or foreign L2 snapshot token")
            return entry[2:]

    def cursor(self, fingerprint, position):
        if not isinstance(position, str) or re.fullmatch(r"0|[1-9][0-9]{0,8}", position) is None:
            raise ValueError("invalid L2 cursor position")
        body = {"v": 1, "q": sha(fingerprint), "p": str(position), "t": int(self.clock()) + TTL}
        raw = encoded(body)
        tag = hmac.new(self.secret, raw, hashlib.sha256).hexdigest()
        return base64.urlsafe_b64encode(encoded({**body, "h": tag})).decode().rstrip("=")

    def position(self, token, fingerprint):
        if not isinstance(token, str) or not 1 <= len(token) <= 512 or re.fullmatch(r"[A-Za-z0-9_-]+", token) is None:
            raise ValueError("invalid L2 cursor")
        try:
            body = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
        except (ValueError, binascii.Error) as error:
            raise ValueError("invalid L2 cursor") from error
        if not isinstance(body, dict) or set(body) != {"v", "q", "p", "t", "h"}:
            raise ValueError("invalid L2 cursor")
        tag = body.pop("h")
        if (not isinstance(tag, str) or not hmac.compare_digest(tag, hmac.new(self.secret, encoded(body), hashlib.sha256).hexdigest())
                or type(body["v"]) is not int or body["v"] != 1 or body["q"] != sha(fingerprint)
                or type(body["t"]) is not int or body["t"] <= self.clock()
                or not isinstance(body["p"], str) or re.fullmatch(r"0|[1-9][0-9]{0,8}", body["p"]) is None):
            raise ValueError("expired, tampered or foreign L2 cursor")
        return body["p"]
