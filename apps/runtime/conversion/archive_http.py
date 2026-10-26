from __future__ import annotations

import argparse
from dataclasses import dataclass
import hmac
import http.server
import json
import os
from pathlib import Path
import re
import select
import socket
import sys
import threading
import time

import archive_admission as _admission
import archive_cache as _cache
import archive_query as _archive_query
import archive_reader as _reader
import archive_reader_bridge as _reader_bridge
import archive_service as _service
import archive_telemetry as _telemetry
import s3_publish

CONTRACT_VERSION = _reader.CONTRACT_VERSION
MAX_REQUEST_BYTES = 64 * 1024
REQUEST_BODY_TIMEOUT_S = 5.0
REFUSAL_LINGER_S = 1.0
REFUSAL_LINGER_MAX_BYTES = 2 * MAX_REQUEST_BYTES
DISCONNECT_POLL_S = 0.25
DEFAULT_PORT = 8002
DEFAULT_HOST = "127.0.0.1"
MAX_INBOUND_HANDLERS = 16
SOURCE_CONFIG_VERSION = 1
SOURCE_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")

MALFORMED_REQUEST = "MALFORMED_REQUEST"
UNAUTHORIZED = "UNAUTHORIZED"
SERVICE_SECRET_HEADER = "x-archive-service-secret"
CLIENT_HEADER = "x-archive-client"
CLIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

ArchiveQueryError = _archive_query.ArchiveQueryError

REFUSAL_STATUS = {
    MALFORMED_REQUEST: 400,
    UNAUTHORIZED: 401,
    _archive_query.INVALID_WINDOW: 400,
    _archive_query.UNSUPPORTED_FAMILY: 400,
    _reader.CURSOR_MALFORMED: 400,
    _reader.CURSOR_POINTER_MISMATCH: 400,
    _archive_query.UNKNOWN_INSTRUMENT: 404,
    _cache.POINTER_TOKEN_INVALID: 409,
    _archive_query.RANGE_TOO_LARGE: 413,
    _archive_query.WINDOW_TOO_LARGE: 413,
    _admission.OVERLOADED: 429,
    _admission.CANCELLED: 499,
    _archive_query.CATALOG_INTEGRITY_FAILURE: 500,
    _cache.PARTITION_VERIFICATION_FAILED: 500,
    _archive_query.ESTIMATE_UNVERIFIED: 503,
    _cache.CACHE_CAPACITY_EXCEEDED: 503,
    _reader_bridge.READER_UNAVAILABLE: 503,
}

_REQUEST_FIELDS = {
    "instrumentId": "instrument_id",
    "family": "family",
    "from": "from_ns",
    "to": "to_ns",
    "limit": "limit",
    "cursor": "cursor",
    "maxScanBytes": "max_scan_bytes",
    "pointerToken": "pointer_token",
}


class MalformedRequest(RuntimeError):
    """A body that never became a contract request.

    This is a declared error envelope because the service is the first boundary
    that can observe malformed HTTP framing or non-finite JSON.
    """


def _error_body(code, detail):
    body = {"contractVersion": CONTRACT_VERSION, "error": code}
    detail = detail if isinstance(detail, dict) else {"reason": str(detail)}
    if detail:
        body["detail"] = json.dumps(
            detail, sort_keys=True, default=str, allow_nan=False)[:512]
    for field in ("family", "requestedWindowNs", "maxWindowNs", "estimatedScanBytes",
                  "effectiveMaxScanBytes", "retryAfterMs"):
        if field in detail:
            body[field] = detail[field]
    return body


def _malformed_body(reason):
    return _error_body(MALFORMED_REQUEST, {"reason": reason})


def _reject_json_constant(value):
    raise ValueError(f"NON_FINITE_JSON_CONSTANT:{value}")


def _build_query_s3_client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3", region_name=os.environ["TT_QUERY_S3_REGION"],
        aws_access_key_id=os.environ["TT_QUERY_S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["TT_QUERY_S3_SECRET_ACCESS_KEY"],
        config=Config(connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}),
    )


def request_kwargs(payload):
    """Contract request to `archive_service.query` keyword arguments."""
    if not isinstance(payload, dict):
        raise MalformedRequest("REQUEST_NOT_AN_OBJECT")
    if payload.get("contractVersion") != CONTRACT_VERSION:
        raise MalformedRequest("CONTRACT_VERSION_MISMATCH")
    unknown = set(payload) - set(_REQUEST_FIELDS) - {"contractVersion"}
    if unknown:
        raise MalformedRequest(f"UNKNOWN_REQUEST_FIELDS:{','.join(sorted(unknown))}")
    for required in ("instrumentId", "family", "from", "to"):
        if required not in payload:
            raise MalformedRequest(f"MISSING_REQUEST_FIELD:{required}")
    return {snake: payload[wire] for wire, snake in _REQUEST_FIELDS.items() if wire in payload}


@dataclass(frozen=True)
class ArchiveSource:
    """One trusted local catalog and cache serving declared identity providers."""
    name: str
    identities: frozenset[str]
    registry: object
    cache: object


@dataclass(frozen=True)
class ArchiveSourceConfig:
    """Trusted source routing and local paths supplied by the service operator."""
    name: str
    identities: frozenset[str]
    catalog_root: str
    cache_root: str


def load_source_config(path):
    """Read the all-or-nothing source map before the service opens any catalog."""
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("ARCHIVE_SOURCE_CONFIG_UNREADABLE") from error
    if not isinstance(value, dict) or set(value) != {"version", "sources"}:
        raise ValueError("ARCHIVE_SOURCE_CONFIG_INVALID")
    if value["version"] != SOURCE_CONFIG_VERSION or not isinstance(value["sources"], list):
        raise ValueError("ARCHIVE_SOURCE_CONFIG_INVALID")
    names, identities, result = set(), set(), []
    for source in value["sources"]:
        if not isinstance(source, dict) or set(source) != {
                "name", "identities", "catalogRoot", "cacheRoot"}:
            raise ValueError("ARCHIVE_SOURCE_CONFIG_INVALID")
        name = source["name"]
        raw_identities = source["identities"]
        catalog_root, cache_root = source["catalogRoot"], source["cacheRoot"]
        if (not isinstance(name, str) or SOURCE_NAME.fullmatch(name) is None
                or name in names or not isinstance(raw_identities, list)
                or not raw_identities or not isinstance(catalog_root, str)
                or not isinstance(cache_root, str) or not catalog_root or not cache_root):
            raise ValueError("ARCHIVE_SOURCE_CONFIG_INVALID")
        source_identities = frozenset(raw_identities)
        if (len(source_identities) != len(raw_identities)
                or any(not isinstance(identity, str) or not identity
                       for identity in source_identities)
                or identities.intersection(source_identities)):
            raise ValueError("ARCHIVE_SOURCE_CONFIG_INVALID")
        names.add(name)
        identities.update(source_identities)
        result.append(ArchiveSourceConfig(
            name=name,
            identities=source_identities,
            catalog_root=catalog_root,
            cache_root=cache_root,
        ))
    if not result:
        raise ValueError("ARCHIVE_SOURCE_CONFIG_INVALID")
    return tuple(result)


def _instrument_identity(instrument_id):
    try:
        decoded = json.loads(instrument_id)
    except (TypeError, json.JSONDecodeError) as error:
        raise ArchiveQueryError(_archive_query.UNKNOWN_INSTRUMENT,
                                instrumentId=instrument_id) from error
    if (not isinstance(decoded, list) or not decoded
            or not isinstance(decoded[0], str) or not decoded[0]):
        raise ArchiveQueryError(_archive_query.UNKNOWN_INSTRUMENT,
                                instrumentId=instrument_id)
    return decoded[0]


class ArchiveHttpService:
    """One process serving the archive query contract over loopback HTTP.

    Single by necessity, not by preference: `SnapshotRegistry` issues tokens and
    `archive_reader` signs cursors with process-local state, so a second process
    would hand out capabilities the first cannot resolve. Everything expensive --
    the snapshot registry, the part cache, the reader pool -- is built once here
    and shared, which is the whole reason this exists rather than a subprocess
    per request."""

    def __init__(self, *, registry, cache, store, connection, curated_prefix,
                 admission=None, service_secret=None, sources=None, telemetry=None):
        if sources is None:
            sources = (ArchiveSource("default", frozenset(), registry, cache),)
        if not isinstance(sources, tuple) or not sources:
            raise ValueError("ARCHIVE_SOURCES_INVALID")
        identities, names = {}, set()
        for source in sources:
            if (not isinstance(source, ArchiveSource) or not source.name
                    or source.name in names or source.registry is None or source.cache is None):
                raise ValueError("ARCHIVE_SOURCES_INVALID")
            names.add(source.name)
            for identity in source.identities:
                if not isinstance(identity, str) or not identity or identity in identities:
                    raise ValueError("ARCHIVE_SOURCES_INVALID")
                identities[identity] = source
        if len(sources) > 1 and not identities:
            raise ValueError("ARCHIVE_SOURCES_INVALID")
        self.sources = sources
        self._sources_by_identity = identities
        self.registry = sources[0].registry
        self.cache = sources[0].cache
        self.store = store
        self.connection = connection
        self.curated_prefix = curated_prefix
        self.admission = admission if admission is not None else _admission.Admission()
        self.telemetry = telemetry if telemetry is not None else _telemetry.StageTelemetry()
        self.service_secret = (os.environ.get("TT_QUERY_SERVICE_SECRET", "")
                               if service_secret is None else service_secret)

    def query(self, payload, *, client, cancel_token):
        kwargs = request_kwargs(payload)
        source = self._source(kwargs["instrument_id"])
        return _service.query(
            source.registry, source.cache, self.store, self.connection.cursor(),
            curated_prefix=self.curated_prefix, admission=self.admission,
            client=client, cancel_token=cancel_token, telemetry=self.telemetry, **kwargs)

    def _source(self, instrument_id):
        if len(self.sources) == 1 and not self.sources[0].identities:
            return self.sources[0]
        identity = _instrument_identity(instrument_id)
        source = self._sources_by_identity.get(identity)
        if source is None:
            raise ArchiveQueryError(_archive_query.UNKNOWN_INSTRUMENT,
                                    instrumentId=instrument_id)
        return source

    def health(self):
        """Ready means configured to answer, not proven able to.

        Without a service secret every query is refused, so a process that
        reported `ready` here would be indistinguishable from a working one to
        the only thing that reads it.

        The check is presence, not acceptance: a secret that does not match the
        one the gateway holds still reports ready while refusing every query.
        Proving the pair would mean an authenticated upstream probe on every
        health check, which is a deliberate non-goal here -- so a deploy must
        verify the pair with a real query, not with this endpoint."""
        configured = bool(self.service_secret)
        body = {
            "contractVersion": CONTRACT_VERSION,
            "ready": configured,
            "inFlight": self.admission.in_flight,
            "readerPoolSize": sum(
                _service.reader_pool(cache.root).size
                for cache in {source.cache for source in self.sources}),
            "sources": [source.name for source in self.sources],
            "telemetry": self.telemetry.snapshot(),
        }
        if not configured:
            body["reason"] = "SERVICE_SECRET_NOT_CONFIGURED"
        return body

    def close(self):
        for cache in {source.cache for source in self.sources}:
            _service.shutdown_readers(cache.root)
        self.connection.close()


def _watch_for_disconnect(connection, token, stop):
    """Cancel when the peer goes away.

    `http.server` reports a disconnect nowhere, so the socket is asked directly:
    readable with nothing to read is a closed peer. `MSG_PEEK` leaves whatever
    arrived for the handler rather than consuming it."""
    while not stop.wait(0):
        try:
            readable, _, _ = select.select([connection], [], [], DISCONNECT_POLL_S)
        except (OSError, ValueError):
            token.cancel()
            return
        if not readable:
            continue
        try:
            if connection.recv(1, socket.MSG_PEEK) == b"":
                token.cancel()
                return
        except (BlockingIOError, InterruptedError):
            continue
        except OSError:
            token.cancel()
            return
        return


def resolve_client(headers, service_secret):
    """Who the request is for, once the caller has proved it may say.

    `x-archive-client` is not an identity and must never be treated as one: it
    is a value the trusted gateway passes through after it has authenticated a
    user. Without the shared service secret the header is a caller-controlled
    string, and honouring it would let anything that can open the loopback port
    spend another client's concurrency cap and rate budget -- which is to say,
    make admission's per-client bounds mean nothing.

    User credentials never arrive here. Node authenticates the browser and sends
    only the identity it derived."""
    presented = headers.get(SERVICE_SECRET_HEADER) or ""
    if not isinstance(service_secret, str) or not service_secret:
        raise ArchiveQueryError(UNAUTHORIZED, reason="SERVICE_SECRET_NOT_CONFIGURED")
    if (not isinstance(presented, str)
            or not hmac.compare_digest(presented.encode(), service_secret.encode())):
        raise ArchiveQueryError(UNAUTHORIZED, reason="SERVICE_SECRET_MISMATCH")
    client = headers.get(CLIENT_HEADER) or ""
    if not isinstance(client, str) or CLIENT_ID_PATTERN.fullmatch(client) is None:
        raise ArchiveQueryError(UNAUTHORIZED, reason="CLIENT_IDENTITY_ABSENT")
    return client


def make_handler(service, *, service_secret=None):
    secret = service_secret if service_secret is not None else service.service_secret
    version = getattr(service, "contract_version", CONTRACT_VERSION)

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "archive-query/1"
        body_read = False
        contract_version = version

        def log_message(self, fmt, *args):
            print(json.dumps({"event": "archive_http", "message": fmt % args}),
                  file=sys.stderr, flush=True)

        def _send(self, status, body):
            if "contractVersion" in body:
                body = {**body, "contractVersion": version}
            payload = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
            try:
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.send_header("cache-control", "no-store")
                self.send_header("connection", "close")
                self.end_headers()
                self.wfile.write(payload)
                if self.command == "POST" and not self.body_read:
                    self._linger_for_unread_body()
            except (BrokenPipeError, ConnectionResetError, OSError):
                self.close_connection = True
            finally:
                self.close_connection = True

        def _linger_for_unread_body(self):
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_WR)
            deadline = time.monotonic() + REFUSAL_LINGER_S
            declared = self.headers.get_all("content-length") or []
            remaining = (int(declared[0]) if len(declared) == 1 and declared[0].isdigit()
                         else REFUSAL_LINGER_MAX_BYTES)
            remaining = min(remaining, REFUSAL_LINGER_MAX_BYTES)
            while remaining > 0:
                timeout = deadline - time.monotonic()
                if timeout <= 0:
                    return
                readable, _, _ = select.select([self.connection], [], [], timeout)
                if not readable:
                    return
                chunk = self.connection.recv(min(65_536, remaining))
                if not chunk:
                    return
                remaining -= len(chunk)

        def _read_body(self):
            values = self.headers.get_all("content-length") or []
            if len(values) != 1 or self.headers.get("transfer-encoding") is not None:
                raise MalformedRequest("AMBIGUOUS_BODY_FRAMING")
            try:
                length = int(values[0])
            except (TypeError, ValueError) as error:
                raise MalformedRequest("INVALID_CONTENT_LENGTH") from error
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise MalformedRequest(f"CONTENT_LENGTH:{length}")
            previous_timeout = self.connection.gettimeout()
            deadline = time.monotonic() + REQUEST_BODY_TIMEOUT_S
            chunks, remaining = [], length
            try:
                while remaining:
                    timeout = deadline - time.monotonic()
                    if timeout <= 0:
                        raise TimeoutError()
                    self.connection.settimeout(timeout)
                    chunk = self.rfile.read1(remaining)
                    if not chunk:
                        raise MalformedRequest("TRUNCATED_REQUEST_BODY")
                    chunks.append(chunk)
                    remaining -= len(chunk)
            except (OSError, TimeoutError) as error:
                self.close_connection = True
                raise MalformedRequest("REQUEST_BODY_TIMEOUT") from error
            finally:
                self.connection.settimeout(previous_timeout)
            self.body_read = True
            return b"".join(chunks)

        def do_GET(self):
            if self.path != "/health":
                self._send(404, {"error": "NOT_FOUND"})
                return
            self._send(200, service.health())

        def do_POST(self):
            if self.path != "/query":
                self._send(404, {"error": "NOT_FOUND"})
                return
            self._serve_query()

        def _serve_query(self):
            try:
                client = resolve_client(self.headers, secret)
            except ArchiveQueryError as error:
                self._send(REFUSAL_STATUS[error.code], _error_body(error.code, error.detail))
                return
            try:
                raw = self._read_body()
                payload = json.loads(raw, parse_constant=_reject_json_constant)
            except MalformedRequest as error:
                self._send(400, _malformed_body(str(error)[:512]))
                return
            except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
                self._send(400, _malformed_body("BODY_NOT_JSON"))
                return

            token = _admission.CancelToken()
            stop = threading.Event()
            watchdog = threading.Thread(
                target=_watch_for_disconnect, args=(self.connection, token, stop), daemon=True)
            watchdog.start()
            try:
                response = service.query(payload, client=client, cancel_token=token)
            except MalformedRequest as error:
                self._send(400, _malformed_body(str(error)[:512]))
            except ArchiveQueryError as error:
                self._send(REFUSAL_STATUS[error.code], _error_body(error.code, error.detail))
            else:
                self._send(200, response)
            finally:
                stop.set()

    return Handler


class ThreadingHttpServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, request_handler_class, *, max_inbound):
        self._inbound = threading.BoundedSemaphore(max_inbound)
        self._inbound_rejections = 0
        self._inbound_lock = threading.Lock()
        super().__init__(server_address, request_handler_class)

    @property
    def inbound_rejections(self):
        with self._inbound_lock:
            return self._inbound_rejections

    def _reject_inbound(self, request):
        body = _error_body(_admission.OVERLOADED, {
            "reason": "INBOUND_HANDLERS_EXHAUSTED", "retryAfterMs": 1_000})
        body["contractVersion"] = getattr(self.RequestHandlerClass, "contract_version", CONTRACT_VERSION)
        payload = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
        response = (b"HTTP/1.1 429 Too Many Requests\r\n"
                    b"content-type: application/json\r\n"
                    + f"content-length: {len(payload)}\r\n".encode()
                    + b"cache-control: no-store\r\nconnection: close\r\n\r\n" + payload)
        with self._inbound_lock:
            self._inbound_rejections += 1
        try:
            request.sendall(response)
            request.shutdown(socket.SHUT_WR)
            deadline = time.monotonic() + 0.1
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                readable, _, _ = select.select([request], [], [], remaining)
                if not readable or not request.recv(MAX_REQUEST_BYTES):
                    break
        except OSError:
            pass
        finally:
            try:
                request.close()
            except OSError:
                pass

    def process_request(self, request, client_address):
        if not self._inbound.acquire(blocking=False):
            self._reject_inbound(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._inbound.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._inbound.release()


class ThreadingHttpServerV6(ThreadingHttpServer):
    address_family = socket.AF_INET6


def build_service(*, bucket, curated_prefix, catalog_root=None, cache_root=None, client=None,
                  min_free_disk_bytes=None, source_configs=None):
    client = client if client is not None else _build_query_s3_client()
    cache_kwargs = {} if min_free_disk_bytes is None else {"min_free_disk_bytes": min_free_disk_bytes}
    if source_configs is None:
        if not isinstance(catalog_root, str) or not isinstance(cache_root, str):
            raise ValueError("ARCHIVE_SOURCE_CONFIG_INVALID")
        sources = (ArchiveSource(
            "default", frozenset(), _cache.SnapshotRegistry(catalog_root),
            _cache.PartCache(cache_root, **cache_kwargs)),)
    else:
        if catalog_root is not None or cache_root is not None or curated_prefix != "curated":
            raise ValueError("ARCHIVE_SOURCE_CONFIG_INVALID")
        sources = tuple(ArchiveSource(
            source.name, source.identities, _cache.SnapshotRegistry(source.catalog_root),
            _cache.PartCache(source.cache_root, **cache_kwargs))
            for source in source_configs)
    return ArchiveHttpService(
        registry=sources[0].registry,
        cache=sources[0].cache,
        store=s3_publish.Store(client, bucket, curated_prefix),
        connection=_reader.connect(),
        curated_prefix=curated_prefix,
        sources=sources)


def serve(service, *, host=DEFAULT_HOST, port=DEFAULT_PORT, service_secret=None,
          max_inbound=MAX_INBOUND_HANDLERS):
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise ValueError(f"LOOPBACK_BIND_REQUIRED:{host}")
    if host == "localhost":
        host = "127.0.0.1"
    if not isinstance(max_inbound, int) or isinstance(max_inbound, bool) or max_inbound < 1:
        raise ValueError(f"INVALID_MAX_INBOUND:{max_inbound!r}")
    server_class = ThreadingHttpServerV6 if host == "::1" else ThreadingHttpServer
    return server_class((host, port), make_handler(service, service_secret=service_secret),
                        max_inbound=max_inbound)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve the archive query contract over loopback HTTP.")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--curated-prefix", required=True)
    parser.add_argument("--catalog-root")
    parser.add_argument("--cache-root")
    parser.add_argument("--sources-file")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--min-free-disk-bytes", type=int, default=None)
    args = parser.parse_args(argv)

    if not os.environ.get("TT_QUERY_SERVICE_SECRET"):
        print(json.dumps({"event": "archive_http_refused_to_start",
                          "reason": "SERVICE_SECRET_NOT_CONFIGURED"}), file=sys.stderr, flush=True)
        return 2

    if args.sources_file is not None:
        if args.catalog_root is not None or args.cache_root is not None:
            parser.error("--sources-file cannot be combined with --catalog-root or --cache-root")
        source_configs = load_source_config(args.sources_file)
        for source in source_configs:
            os.makedirs(source.cache_root, exist_ok=True)
        service = build_service(
            bucket=args.bucket, curated_prefix=args.curated_prefix,
            min_free_disk_bytes=args.min_free_disk_bytes, source_configs=source_configs)
    else:
        if args.catalog_root is None or args.cache_root is None:
            parser.error("--catalog-root and --cache-root are required without --sources-file")
        os.makedirs(args.cache_root, exist_ok=True)
        service = build_service(
            bucket=args.bucket, curated_prefix=args.curated_prefix,
            catalog_root=args.catalog_root, cache_root=args.cache_root,
            min_free_disk_bytes=args.min_free_disk_bytes)
    server = serve(service, host=args.host, port=args.port)
    print(json.dumps({"event": "archive_http_listening", "host": args.host,
                      "port": server.server_address[1]}), file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        service.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
