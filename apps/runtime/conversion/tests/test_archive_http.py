from __future__ import annotations

import json
import http.client
import socket
import subprocess
import sys
import threading
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import archive_admission as aa
import archive_http as ah
import archive_query as aq
import archive_reader as ar
import archive_service as asvc
import archive_cache as ac
import s3_publish
from test_archive_service import BASE, CURATED, IID, rig, valid_family_rig  # noqa: F401


SERVICE_SECRET = "service-secret-under-test"
RUNTIME_ROOT = Path(__file__).resolve().parents[2]


def _through_real_node_gateway(service_url, payload, *, service_secret=SERVICE_SECRET):
    script = r'''
"use strict";
const http = require("node:http");
const { createArchiveAuth } = require("./src/server/archive-auth");
const { createArchiveRoute } = require("./src/server/archive-route");
const [serviceUrl, payloadText, serviceSecret] = process.argv.slice(1);
const token = "b".repeat(24);
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
async function main() {
  const route = createArchiveRoute({
    auth: createArchiveAuth({ clientTokens: `viewer-1:${token}` }),
    serviceUrl,
    serviceSecret,
    log: () => {},
  });
  const server = http.createServer((request, response) => {
    if (route.handle(request, response)) return;
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const request = async (body, authorization = `Bearer ${token}`) => {
      const response = await fetch(`${base}/archive/query`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === null ? {} : { authorization }),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
    };
    const first = await request(JSON.parse(payloadText));
    const unauthorised = await request(JSON.parse(payloadText), null);
    const pages = [first];
    while (pages.at(-1).status === 200 && pages.at(-1).body.nextCursor !== null) {
      const previous = pages.at(-1).body;
      pages.push(await request({
        ...JSON.parse(payloadText), cursor: previous.nextCursor, pointerToken: previous.pointerToken,
      }));
    }
    process.stdout.write(JSON.stringify({ first, unauthorised, pages }));
  } finally {
    route.dispose();
    await close(server);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
'''
    completed = subprocess.run(
        ["node", "-e", script, service_url, json.dumps(payload), service_secret],
        cwd=RUNTIME_ROOT, capture_output=True, text=True, timeout=30, check=False)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


@pytest.fixture
def served(rig):  # noqa: F811
    service = ah.ArchiveHttpService(
        registry=rig["registry"], cache=rig["cache"], store=rig["store"],
        connection=rig["connection"], curated_prefix=CURATED,
        admission=aa.Admission(max_concurrent=2, max_queued=32),
        service_secret=SERVICE_SECRET)
    server = ah.serve(service, port=0, service_secret=SERVICE_SECRET)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    yield {"base": base, "service": service, "server": server}
    server.shutdown()
    server.server_close()


def _headers(client="tester", secret=SERVICE_SECRET):
    headers = {"content-type": "application/json"}
    if secret is not None:
        headers[ah.SERVICE_SECRET_HEADER] = secret
    if client is not None:
        headers[ah.CLIENT_HEADER] = client
    return headers


def _post(base, payload, *, client="tester", secret=SERVICE_SECRET):
    request = urllib.request.Request(
        base + "/query", data=json.dumps(payload).encode(),
        headers=_headers(client, secret), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def _query(**overrides):
    payload = {"contractVersion": ah.CONTRACT_VERSION, "instrumentId": IID,
               "family": "trade", "from": str(BASE), "to": str(BASE + 1000)}
    payload.update(overrides)
    return payload


def test_the_query_client_uses_only_the_query_identity(monkeypatch):
    captured = {}

    def client(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return object()

    for name, value in {
        "TT_QUERY_S3_REGION": "region",
        "TT_QUERY_S3_ACCESS_KEY_ID": "query-access",
        "TT_QUERY_S3_SECRET_ACCESS_KEY": "query-secret",
    }.items():
        monkeypatch.setenv(name, value)
    for name in ("RCLONE_CONFIG_TTCONVERT_REGION", "RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID",
                 "RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setitem(sys.modules, "boto3", types.SimpleNamespace(client=client))

    ah._build_query_s3_client()

    assert captured["args"] == ("s3",)
    assert captured["kwargs"]["region_name"] == "region"
    assert captured["kwargs"]["aws_access_key_id"] == "query-access"
    assert captured["kwargs"]["aws_secret_access_key"] == "query-secret"


def _manual_post(base, body, headers):
    connection = http.client.HTTPConnection(base.removeprefix("http://"), timeout=10)
    connection.putrequest("POST", "/query")
    for name, value in headers:
        connection.putheader(name, value)
    connection.endheaders(body)
    response = connection.getresponse()
    payload = json.loads(response.read())
    connection.close()
    return response.status, payload


def _read_response(connection):
    chunks = []
    while True:
        try:
            chunk = connection.recv(65536)
        except ConnectionResetError:
            break
        if not chunk:
            break
        chunks.append(chunk)
    header, _, body = b"".join(chunks).partition(b"\r\n\r\n")
    return int(header.split(b" ", 2)[1]), json.loads(body)


def test_a_real_request_over_a_real_socket_returns_contract_rows(served):
    status, body = _post(served["base"], _query(limit=100))

    assert status == 200
    assert body["contractVersion"] == ah.CONTRACT_VERSION
    assert [int(r["event_ns"]) for r in body["rows"]] == \
           [BASE + i for i in range(6)] + [BASE + 100 + i for i in range(6)]
    # The window runs past both catalogued ranges, so the uncovered intervals
    # are UNKNOWN rather than invented as QUIET -- this engine has no session
    # authority to call them anything else.
    assert body["pointerToken"]
    assert body["coverage"]["states"] == {"PUBLISHED": 2, "UNKNOWN": 2}


def test_paging_over_http_concatenates_to_the_whole_window(served):
    collected, cursor, token = [], None, None
    for _ in range(20):
        extra = {"limit": 2}
        if cursor is not None:
            extra["cursor"] = cursor
        if token is not None:
            extra["pointerToken"] = token
        status, body = _post(served["base"], _query(**extra))
        assert status == 200
        collected.extend(int(r["event_ns"]) for r in body["rows"])
        cursor, token = body["nextCursor"], body["pointerToken"]
        if cursor is None:
            break

    assert collected == [BASE + i for i in range(6)] + [BASE + 100 + i for i in range(6)]
    assert len(collected) == len(set(collected))


def test_a_refusal_becomes_the_declared_error_envelope_not_a_stack_trace(served):
    status, body = _post(served["base"], _query(**{"from": str(BASE + 10), "to": str(BASE)}))

    assert status == 400
    assert body["error"] == aq.INVALID_WINDOW
    assert body["contractVersion"] == ah.CONTRACT_VERSION
    assert "Traceback" not in json.dumps(body)


def test_an_unknown_family_is_refused_with_its_own_code(served):
    status, body = _post(served["base"], _query(family="nonsense"))

    assert status == 400
    assert body["error"] == aq.UNSUPPORTED_FAMILY


@pytest.mark.parametrize("payload,reason", [
    ({"contractVersion": "archive-query/0"}, "CONTRACT_VERSION_MISMATCH"),
    ({"contractVersion": ah.CONTRACT_VERSION}, "MISSING_REQUEST_FIELD"),
    ({"contractVersion": ah.CONTRACT_VERSION, "instrumentId": IID, "family": "trade",
      "from": "1", "to": "2", "surprise": 1}, "UNKNOWN_REQUEST_FIELDS"),
])
def test_a_body_that_never_became_a_request_is_refused(served, payload, reason):
    status, body = _post(served["base"], payload)

    assert status == 400
    assert body["error"] == "MALFORMED_REQUEST"
    assert reason in body["detail"]


@pytest.mark.parametrize("secret,client,reason", [
    (None, "tester", "SERVICE_SECRET_MISMATCH"),
    ("wrong-secret", "tester", "SERVICE_SECRET_MISMATCH"),
    (SERVICE_SECRET, None, "CLIENT_IDENTITY_ABSENT"),
    (SERVICE_SECRET, "", "CLIENT_IDENTITY_ABSENT"),
    (SERVICE_SECRET, "x" * 129, "CLIENT_IDENTITY_ABSENT"),
    (SERVICE_SECRET, "viewer-\u00e9", "CLIENT_IDENTITY_ABSENT"),
])
def test_a_caller_without_the_service_secret_cannot_name_a_client(served, secret, client, reason):
    # `x-archive-client` is not an identity. Until the shared secret verifies it
    # is a caller-controlled string, and honouring it would let anything able to
    # open the loopback port spend another client's concurrency cap and rate
    # budget -- which would make admission's per-client bounds mean nothing.
    status, body = _post(served["base"], _query(limit=100), client=client, secret=secret)

    assert status == 401
    assert body["error"] == ah.UNAUTHORIZED
    assert reason in body["detail"]


def test_a_non_ascii_service_secret_header_is_an_unauthorized_refusal_not_a_handler_error():
    with pytest.raises(ah.ArchiveQueryError) as raised:
        ah.resolve_client({ah.SERVICE_SECRET_HEADER: "\u00ff", ah.CLIENT_HEADER: "viewer-1"},
                          SERVICE_SECRET)

    assert raised.value.code == ah.UNAUTHORIZED


def test_an_unauthorized_refusal_never_reaches_the_engine(served, monkeypatch):
    # The refusal must happen before the body is read and before a slot is
    # taken, or an unauthenticated caller still costs the work it was refused.
    calls = []
    monkeypatch.setattr(ah.ArchiveHttpService, "query",
                        lambda self, *a, **k: calls.append(1))

    status, _ = _post(served["base"], _query(limit=100), secret="wrong-secret")

    assert status == 401
    assert calls == [], "an unauthenticated request reached the query engine"
    assert served["service"].admission.in_flight == 0


def test_an_unauthorized_refusal_validates_against_the_root_schema(served):
    from test_archive_query_contract import _validator

    _, body = _post(served["base"], _query(limit=100), secret=None)

    _validator().validate(body)


def test_the_identity_the_gateway_supplies_is_the_one_admission_sees(served, monkeypatch):
    seen = []
    original = ah.ArchiveHttpService.query

    def spy(self, payload, *, client, cancel_token):
        seen.append(client)
        return original(self, payload, client=client, cancel_token=cancel_token)

    monkeypatch.setattr(ah.ArchiveHttpService, "query", spy)
    _post(served["base"], _query(limit=100), client="viewer-7")

    assert seen == ["viewer-7"]


def test_a_service_with_no_secret_configured_refuses_everything(rig):  # noqa: F811
    # An unset secret must fail closed. Defaulting to "no secret required" would
    # turn a misconfigured deployment into an open one.
    service = ah.ArchiveHttpService(
        registry=rig["registry"], cache=rig["cache"], store=rig["store"],
        connection=rig["connection"], curated_prefix=CURATED)
    server = ah.serve(service, port=0, service_secret="")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, body = _post(f"http://127.0.0.1:{server.server_address[1]}",
                             _query(limit=100), secret="anything")
    finally:
        server.shutdown()
        server.server_close()

    assert status == 401
    assert "SERVICE_SECRET_NOT_CONFIGURED" in body["detail"]


def test_inbound_handlers_are_bounded_before_a_body_is_parsed(rig):  # noqa: F811
    # ThreadingHTTPServer starts a thread per connection and archive admission
    # bounds reader work, not inbound sockets. Without this gate a flood costs
    # threads before anything refuses it.
    service = ah.ArchiveHttpService(
        registry=rig["registry"], cache=rig["cache"], store=rig["store"],
        connection=rig["connection"], curated_prefix=CURATED)
    handler = ah.make_handler(service, service_secret=SERVICE_SECRET)

    assert handler is not None
    server = ah.serve(service, port=0, service_secret=SERVICE_SECRET, max_inbound=1)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    holding = threading.Event()
    release = threading.Event()
    statuses = []

    def slow_query(self, payload, *, client, cancel_token):
        holding.set()
        release.wait(10)
        raise ah.ArchiveQueryError(aq.INVALID_WINDOW, reason="TEST")

    original = ah.ArchiveHttpService.query
    ah.ArchiveHttpService.query = slow_query
    try:
        first = threading.Thread(target=lambda: statuses.append(
            _post(base, _query(limit=1))[0]))
        first.start()
        assert holding.wait(10), "the first request never occupied the handler"
        statuses.append(_post(base, _query(limit=1))[0])
        release.set()
        first.join(20)
    finally:
        ah.ArchiveHttpService.query = original
        server.shutdown()
        server.server_close()

    assert 429 in statuses, "a second request was admitted past the inbound bound"
    assert server.inbound_rejections == 1


def test_a_completed_response_releases_its_inbound_handler_before_the_client_closes(rig):  # noqa: F811
    # HTTP/1.1 keeps a handler in BaseHTTPRequestHandler's request loop unless
    # the response closes the connection. With a bounded listener that turns an
    # otherwise idle keep-alive socket into a permanently consumed slot.
    service = ah.ArchiveHttpService(
        registry=rig["registry"], cache=rig["cache"], store=rig["store"],
        connection=rig["connection"], curated_prefix=CURATED,
        service_secret=SERVICE_SECRET)
    server = ah.serve(service, port=0, service_secret=SERVICE_SECRET, max_inbound=1)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    first = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
    body = json.dumps(_query(limit=1)).encode()
    try:
        first.request("POST", "/query", body=body,
                      headers={**_headers(), "content-length": str(len(body))})
        response = first.getresponse()
        response.read()
        assert response.getheader("connection") == "close"

        # The handler thread frees its slot after it has written the response
        # and shut the socket, so the client can finish reading first. Wait for
        # the slot while the first client is still connected: a handler held
        # by the keep-alive loop would never free it.
        deadline = time.monotonic() + 2
        while not server._inbound.acquire(blocking=False):
            assert time.monotonic() < deadline, "the handler kept its inbound slot"
            time.sleep(0.005)
        server._inbound.release()

        status, _ = _post(base, _query(limit=1))
    finally:
        first.close()
        server.shutdown()
        server.server_close()

    assert status == 200
    assert server.inbound_rejections == 0


def test_a_body_that_is_not_json_is_refused_before_the_engine(served):
    request = urllib.request.Request(
        served["base"] + "/query", data=b"{ not json",
        headers=_headers(), method="POST")
    with pytest.raises(urllib.error.HTTPError) as raised:
        urllib.request.urlopen(request, timeout=10)

    assert raised.value.code == 400
    assert "BODY_NOT_JSON" in json.loads(raised.value.read())["detail"]


@pytest.mark.parametrize("body,headers,reason", [
    (b"{}", [("content-length", "not-a-number")], "INVALID_CONTENT_LENGTH"),
    (b"{}", [("content-length", "2"), ("content-length", "3")], "AMBIGUOUS_BODY_FRAMING"),
    (b'{"contractVersion":"archive-query/1","instrumentId":"x","family":NaN,"from":"1","to":"2"}',
     [("content-length", "BODY_LENGTH")], "BODY_NOT_JSON"),
])
def test_malformed_http_framing_and_non_finite_json_are_declared_refusals(served, body, headers, reason):
    from test_archive_query_contract import _validator

    resolved_headers = [(name, str(len(body)) if value == "BODY_LENGTH" else value)
                        for name, value in headers]
    resolved_headers += [(ah.SERVICE_SECRET_HEADER, SERVICE_SECRET),
                         (ah.CLIENT_HEADER, "tester")]
    status, response = _manual_post(served["base"], body, resolved_headers)

    assert status == 400
    assert response["error"] == ah.MALFORMED_REQUEST
    assert reason in response["detail"]
    _validator().validate(response)


def test_an_incomplete_request_body_has_a_total_deadline_and_a_declared_refusal(served, monkeypatch):
    from test_archive_query_contract import _validator
    import time

    monkeypatch.setattr(ah, "REQUEST_BODY_TIMEOUT_S", 0.15)
    port = served["server"].server_address[1]
    request = (b"POST /query HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 3\r\n"
               + f"{ah.SERVICE_SECRET_HEADER}: {SERVICE_SECRET}\r\n".encode()
               + f"{ah.CLIENT_HEADER}: tester\r\n".encode()
               + b"Content-Type: application/json\r\n\r\n{")
    with socket.create_connection(("127.0.0.1", port), timeout=10) as connection:
        connection.sendall(request)
        started = time.monotonic()
        time.sleep(0.1)
        connection.sendall(b'"')
        connection.settimeout(10)
        status, response = _read_response(connection)
    elapsed = time.monotonic() - started

    assert status == 400
    assert response["error"] == ah.MALFORMED_REQUEST
    assert "REQUEST_BODY_TIMEOUT" in response["detail"]
    assert elapsed < 0.22
    _validator().validate(response)


def test_health_refuses_to_call_an_unconfigured_service_ready(rig):  # noqa: F811
    # A service with no secret starts, binds, and refuses every query. Reporting
    # `ready` here made that process indistinguishable from a working one to the
    # only thing that reads it. Reproduced directly before this test existed.
    service = ah.ArchiveHttpService(
        registry=rig["registry"], cache=rig["cache"], store=rig["store"],
        connection=rig["connection"], curated_prefix=CURATED, service_secret="")
    server = ah.serve(service, port=0, service_secret="")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_address[1]}/health", timeout=10) as response:
            body = json.loads(response.read())
    finally:
        server.shutdown()
        server.server_close()

    assert body["ready"] is False
    assert body["reason"] == "SERVICE_SECRET_NOT_CONFIGURED"


def test_main_refuses_to_start_without_a_service_secret(monkeypatch, tmp_path):
    # The unit gates this with check-service-env.sh, but local development --
    # which the ticket lists as an acceptance criterion -- has no such gate.
    monkeypatch.delenv("TT_QUERY_SERVICE_SECRET", raising=False)

    code = ah.main(["--bucket", "b", "--curated-prefix", "curated/databento",
                    "--catalog-root", str(tmp_path), "--cache-root", str(tmp_path / "c"),
                    "--port", "0"])

    assert code == 2


def test_main_passes_the_free_disk_reserve_through_to_the_cache(monkeypatch, tmp_path):
    # The 200 GiB default makes the service unstartable on any machine with less
    # free space, which is every developer laptop. build_service has always taken
    # the override; without a flag main() could not reach it, so the acceptance
    # criterion "local development works through the same versioned interface"
    # was unreachable for a reason that had nothing to do with the interface.
    monkeypatch.setenv("TT_QUERY_SERVICE_SECRET", "secret-under-test")
    captured = {}

    def fake_build_service(**kwargs):
        captured.update(kwargs)
        raise RuntimeError("STOP_AFTER_BUILD")

    monkeypatch.setattr(ah, "build_service", fake_build_service)
    with pytest.raises(RuntimeError, match="STOP_AFTER_BUILD"):
        ah.main(["--bucket", "b", "--curated-prefix", "curated/databento",
                 "--catalog-root", str(tmp_path), "--cache-root", str(tmp_path / "c"),
                 "--min-free-disk-bytes", "1073741824", "--port", "0"])

    assert captured["min_free_disk_bytes"] == 1_073_741_824


def test_main_leaves_the_free_disk_reserve_at_its_default_when_not_given(monkeypatch, tmp_path):
    monkeypatch.setenv("TT_QUERY_SERVICE_SECRET", "secret-under-test")
    captured = {}

    def fake_build_service(**kwargs):
        captured.update(kwargs)
        raise RuntimeError("STOP_AFTER_BUILD")

    monkeypatch.setattr(ah, "build_service", fake_build_service)
    with pytest.raises(RuntimeError, match="STOP_AFTER_BUILD"):
        ah.main(["--bucket", "b", "--curated-prefix", "curated/databento",
                 "--catalog-root", str(tmp_path), "--cache-root", str(tmp_path / "c"),
                 "--port", "0"])

    assert captured["min_free_disk_bytes"] is None


def test_source_config_rejects_shared_provider_identity_before_any_catalog_opens(tmp_path):
    source_map = {
        "version": ah.SOURCE_CONFIG_VERSION,
        "sources": [
            {"name": "databento", "identities": ["XCME", "XNAS"],
             "catalogRoot": str(tmp_path / "catalogs" / "databento"),
             "cacheRoot": str(tmp_path / "cache" / "databento")},
            {"name": "binance", "identities": ["BINANCE", "XNAS"],
             "catalogRoot": str(tmp_path / "catalogs" / "binance"),
             "cacheRoot": str(tmp_path / "cache" / "binance")},
        ],
    }
    path = tmp_path / "sources.json"
    path.write_text(json.dumps(source_map), encoding="utf-8")

    with pytest.raises(ValueError, match="ARCHIVE_SOURCE_CONFIG_INVALID"):
        ah.load_source_config(path)


def test_local_historical_source_example_routes_each_published_provider_once():
    example = Path(ah.__file__).with_name("archive-sources.example.json")
    sources = ah.load_source_config(example)

    assert [(source.name, source.identities) for source in sources] == [
        ("databento", frozenset({"XCME", "XNAS"})),
        ("binance", frozenset({"BINANCE"})),
    ]


def test_provider_identity_selects_only_its_configured_catalog_and_cache(monkeypatch):
    databento_registry, databento_cache = object(), object()
    binance_registry, binance_cache = object(), object()
    service = ah.ArchiveHttpService(
        registry=databento_registry,
        cache=databento_cache,
        store=object(),
        connection=types.SimpleNamespace(cursor=lambda: object()),
        curated_prefix="curated",
        sources=(
            ah.ArchiveSource("databento", frozenset({"XCME", "XNAS"}),
                             databento_registry, databento_cache),
            ah.ArchiveSource("binance", frozenset({"BINANCE"}),
                             binance_registry, binance_cache),
        ),
    )
    selected = []

    def query(registry, cache, *_args, **_kwargs):
        selected.append((registry, cache))
        return {"rows": []}

    monkeypatch.setattr(ah._service, "query", query)
    payload = {
        "contractVersion": ah.CONTRACT_VERSION,
        "family": "candle_1m",
        "from": "1",
        "to": "2",
    }
    service.query({**payload, "instrumentId": '["BINANCE","SPOT","BTCUSDT","USDT","COIN"]'},
                  client="viewer", cancel_token=aa.CancelToken())
    service.query({**payload, "instrumentId": '["XNAS","EQUITY","AAPL","USD","SHARE"]'},
                  client="viewer", cancel_token=aa.CancelToken())

    assert selected == [(binance_registry, binance_cache), (databento_registry, databento_cache)]


def test_an_unmapped_provider_never_falls_back_to_another_catalog():
    registry, cache = object(), object()
    service = ah.ArchiveHttpService(
        registry=registry,
        cache=cache,
        store=object(),
        connection=types.SimpleNamespace(cursor=lambda: object()),
        curated_prefix="curated",
        sources=(ah.ArchiveSource("binance", frozenset({"BINANCE"}), registry, cache),),
    )

    with pytest.raises(aq.ArchiveQueryError) as raised:
        service._source('["XNAS","EQUITY","AAPL","USD","SHARE"]')

    assert raised.value.code == aq.UNKNOWN_INSTRUMENT


def test_health_reports_the_pool_and_the_admission_cap(served):
    with urllib.request.urlopen(served["base"] + "/health", timeout=10) as response:
        body = json.loads(response.read())

    assert body["ready"] is True
    assert body["inFlight"] == 0
    assert body["readerPoolSize"] == aa.MAX_CONCURRENT_READS


def test_health_exposes_bounded_stage_telemetry_that_a_real_query_advances(served):
    def stages():
        with urllib.request.urlopen(served["base"] + "/health", timeout=10) as response:
            return json.loads(response.read())["telemetry"]["stages"]

    before = stages()
    assert set(before) >= {"admissionWaitMs", "serviceMs", "discoverMs", "fetchMs", "queryMs"}
    assert before["serviceMs"]["count"] == 0

    status, _body = _post(served["base"], _query(limit=100))

    after = stages()
    assert status == 200
    assert after["serviceMs"]["count"] == 1
    assert after["queryMs"]["count"] == 1
    assert after["serviceMs"]["maxMs"] > 0.0


def test_an_unknown_route_is_not_found(served):
    with pytest.raises(urllib.error.HTTPError) as raised:
        urllib.request.urlopen(served["base"] + "/nope", timeout=10)
    assert raised.value.code == 404


def test_concurrent_requests_each_get_their_own_duckdb_cursor(served):
    # ThreadingHTTPServer runs a thread per request and a DuckDB connection is
    # not safe across threads. Sharing one would corrupt or crash rather than
    # merely slow down, so the failure this guards is not a timing artefact.
    results = []
    errors = []

    def run():
        try:
            results.append(_post(served["base"], _query(limit=100)))
        except Exception as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=run) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)

    assert errors == []
    assert len(results) == 6
    assert {status for status, _ in results} == {200}
    assert all(len(body["rows"]) == 12 for _, body in results)


def test_a_refusal_that_travelled_the_wire_validates_against_the_root_schema(served):
    # A refusal carries no rows, so the bytes a client receives can be validated
    # whole -- envelope and all -- against the contract's own authority.
    from test_archive_query_contract import _validator

    _, refusal = _post(served["base"], _query(**{"from": str(BASE + 10), "to": str(BASE)}))
    _validator().validate(refusal)


def test_every_envelope_field_survives_the_wire_intact(served):
    # The rows come straight from the engine and test_archive_query_contract
    # already validates each row variant. What only this layer can break is the
    # envelope around them, so each envelope field is checked against its own
    # definition. The fixture's synthetic parts cannot produce schema-valid
    # `tradeRow`s, so a whole-page validation waits for a real-data run.
    import jsonschema
    from test_archive_query_contract import _schema

    schema = _schema()
    defs = schema["$defs"]
    _, page = _post(served["base"], _query(limit=100))

    for field, ref in (("pointer", "pointer"), ("pointerToken", "pointerToken"),
                       ("family", "family"), ("coverage", "coverage"), ("scan", "scan")):
        jsonschema.validate(page[field], {**defs[ref], "$defs": defs})

    assert page["contractVersion"] == defs["response"]["properties"]["contractVersion"]["const"]
    assert page["nextCursor"] is None
    jsonschema.validate(page["queryFingerprint"], defs["response"]["properties"]["queryFingerprint"])


def test_a_real_full_row_page_over_http_obeys_the_root_contract(valid_family_rig):
    service = ah.ArchiveHttpService(
        registry=valid_family_rig["registry"], cache=valid_family_rig["cache"],
        store=valid_family_rig["store"], connection=valid_family_rig["connection"],
        curated_prefix=CURATED, admission=aa.Admission(max_concurrent=2, max_queued=32))
    server = ah.serve(service, port=0, service_secret=SERVICE_SECRET)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, page = _post(f"http://127.0.0.1:{server.server_address[1]}",
                             _query(family=valid_family_rig["family"], limit=100))
    finally:
        server.shutdown()
        server.server_close()
        service.close()

    from test_archive_query_contract import _validator

    assert status == 200
    _validator().validate(page)


def test_the_real_node_gateway_and_python_service_return_a_full_contract_page(valid_family_rig):
    service = ah.ArchiveHttpService(
        registry=valid_family_rig["registry"], cache=valid_family_rig["cache"],
        store=valid_family_rig["store"], connection=valid_family_rig["connection"],
        curated_prefix=CURATED, admission=aa.Admission(max_concurrent=2, max_queued=32),
        service_secret=SERVICE_SECRET)
    server = ah.serve(service, port=0, service_secret=SERVICE_SECRET)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = _through_real_node_gateway(
            f"http://127.0.0.1:{server.server_address[1]}/query",
            _query(family=valid_family_rig["family"], limit=100))
    finally:
        server.shutdown()
        server.server_close()
        service.close()

    from test_archive_query_contract import _validator

    assert result["first"]["status"] == 200
    _validator().validate(result["first"]["body"])
    assert result["unauthorised"]["status"] == 401
    assert result["unauthorised"]["body"]["error"] == ah.UNAUTHORIZED


def test_the_real_node_gateway_pages_the_real_python_service_without_loss_or_duplication(served):
    result = _through_real_node_gateway(served["base"] + "/query", _query(limit=2))

    assert result["first"]["status"] == 200
    assert [int(row["event_ns"]) for page in result["pages"] for row in page["body"]["rows"]] == \
        [BASE + i for i in range(6)] + [BASE + 100 + i for i in range(6)]


def test_closing_one_service_keeps_another_cache_roots_reader_alive(rig, tmp_path):
    first = ah.ArchiveHttpService(
        registry=rig["registry"], cache=ac.PartCache(tmp_path / "first", min_free_disk_bytes=0),
        store=rig["store"], connection=ar.connect(), curated_prefix=CURATED)
    second = ah.ArchiveHttpService(
        registry=rig["registry"], cache=ac.PartCache(tmp_path / "second", min_free_disk_bytes=0),
        store=s3_publish.Store(rig["client"], "bucket", CURATED), connection=ar.connect(),
        curated_prefix=CURATED)
    try:
        first.query(_query(limit=100), client="first", cancel_token=aa.CancelToken())
        second.query(_query(limit=100), client="second", cancel_token=aa.CancelToken())
        second_pool = asvc.reader_pool(second.cache.root)
        worker = second_pool._idle[0]

        first.close()

        assert worker.alive, "closing one service stopped another service's reader"
        assert len(second.query(_query(limit=100), client="second", cancel_token=aa.CancelToken())["rows"]) == 12
    finally:
        second.close()


def test_a_client_that_disappears_mid_read_cancels_the_query(served, monkeypatch):
    # AC: "network timeout and cancellation do not leak workers or sessions".
    # http.server reports a disconnect nowhere, so the socket is watched
    # directly. The first version of this test asserted only that the slot and
    # pins were free afterwards -- which a query that simply ran to completion
    # also satisfies, so it passed with the watchdog disabled and proved
    # nothing. The reader must observe the cancellation itself.
    import archive_reader_bridge as arb

    reading = threading.Event()
    saw_cancellation = threading.Event()

    def blocking_read(self, request, *, cancel_token=None, **kwargs):
        reading.set()
        for _ in range(600):
            if cancel_token is not None and cancel_token.cancelled:
                saw_cancellation.set()
                raise aa.ArchiveQueryError(aa.CANCELLED, reason="CALLER_CANCELLED")
            threading.Event().wait(0.02)
        raise AssertionError("the read was never cancelled")

    monkeypatch.setattr(arb.ReaderBridge, "read_page", blocking_read)

    import http.client

    connection = http.client.HTTPConnection(
        "127.0.0.1", served["server"].server_address[1], timeout=30)
    body = json.dumps(_query(limit=100)).encode()
    connection.request("POST", "/query", body=body,
                       headers={**_headers(), "content-length": str(len(body))})
    assert reading.wait(20), "the reader never started"
    connection.close()

    assert saw_cancellation.wait(20), "the vanished client never cancelled the read"

    waiter = threading.Event()
    for _ in range(200):
        if served["service"].admission.in_flight == 0 and served["service"].cache._pinned() == set():
            break
        waiter.wait(0.05)

    assert served["service"].admission.in_flight == 0, "a cancelled query kept its slot"
    assert served["service"].cache._pinned() == set(), "a cancelled query kept its cache pins"


def test_the_service_refuses_to_bind_anything_but_loopback(rig):  # noqa: F811
    service = ah.ArchiveHttpService(
        registry=rig["registry"], cache=rig["cache"], store=rig["store"],
        connection=rig["connection"], curated_prefix=CURATED)

    with pytest.raises(ValueError, match="LOOPBACK_BIND_REQUIRED"):
        ah.serve(service, host="0.0.0.0", port=0)


def test_ipv6_loopback_uses_an_ipv6_server_class(rig):
    service = ah.ArchiveHttpService(
        registry=rig["registry"], cache=rig["cache"], store=rig["store"],
        connection=rig["connection"], curated_prefix=CURATED)
    try:
        server = ah.serve(service, host="::1", port=0)
    except OSError as error:
        pytest.skip(f"IPv6 loopback unavailable: {error}")
    try:
        assert server.address_family == socket.AF_INET6
    finally:
        server.server_close()


def test_one_client_cannot_use_another_clients_pointer_token(served):
    status, first = _post(served["base"], _query(limit=1), client="viewer-a")
    assert status == 200

    status, body = _post(served["base"], _query(limit=1, pointerToken=first["pointerToken"]),
                         client="viewer-b")

    assert status == 409
    assert body["error"] == ah._cache.POINTER_TOKEN_INVALID
    assert "CLIENT_MISMATCH" in body["detail"]


def test_one_client_cannot_resume_another_clients_cursor(served):
    status, first = _post(served["base"], _query(limit=1), client="viewer-a")
    assert status == 200
    assert first["nextCursor"] is not None, "this fixture must page for the test to mean anything"

    status, own = _post(served["base"], _query(limit=1), client="viewer-b")
    assert status == 200

    # The realistic leak is a cursor copied out of a URL or a log, presented
    # against the holder's own legitimate pin.
    status, body = _post(served["base"],
                         _query(limit=1, cursor=first["nextCursor"],
                                pointerToken=own["pointerToken"]),
                         client="viewer-b")

    assert status == 400
    assert body["error"] in (ah._reader.CURSOR_MALFORMED, ah._reader.CURSOR_POINTER_MISMATCH)


def test_a_client_still_pages_its_own_chain(served):
    # The isolation must not break the ordinary case it exists to guard.
    status, first = _post(served["base"], _query(limit=1), client="viewer-a")
    assert status == 200

    status, second = _post(served["base"],
                           _query(limit=1, cursor=first["nextCursor"],
                                  pointerToken=first["pointerToken"]),
                           client="viewer-a")

    assert status == 200
    assert second["rows"], "the owner's own cursor must continue to resolve"
    assert second["rows"][0] != first["rows"][0]
