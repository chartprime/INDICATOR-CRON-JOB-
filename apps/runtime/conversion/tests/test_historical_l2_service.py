import hashlib
import http.client
import json
from pathlib import Path
import threading
from contextlib import contextmanager
import subprocess

import pytest

from archive_admission import CancelToken
from archive_cache import PartCache
from archive_http import serve
from archive_query import ArchiveQueryError
import historical_l2_catalog as catalog
import historical_l2_lifecycles as events
from historical_l2_service import Service, CONTRACT_VERSION
from test_historical_l2_catalog import fixture, publish_catalog
from test_historical_l2_lifecycles import delayed


@pytest.fixture
def rig(tmp_path):
    store, instrument, payload, descriptor = fixture()
    start = int(descriptor["window_from_ns"])
    rows = delayed(instrument=instrument, derivation=descriptor["derivation_id"], start_ns=start)
    directory = tmp_path / "events"
    manifest = events.write_parts(rows, directory, part_rows=3)
    prefix = descriptor["prefix"] + "/events/"
    descriptor["objects"] = [o for o in descriptor["objects"] if not o["key"].startswith(prefix)]
    for part in manifest["parts"]:
        data = (directory / part["name"]).read_bytes()
        store.client.objects[prefix + part["name"]] = data
        descriptor["objects"].append({"key": prefix + part["name"], **part})
    data = (directory / "manifest.json").read_bytes()
    store.client.objects[prefix + "manifest.json"] = data
    checksum = hashlib.sha256(data).hexdigest()
    descriptor["objects"].append({"key": prefix + "manifest.json", "bytes": len(data), "sha256": checksum})
    descriptor["families"]["events"] = {"manifest_sha256": checksum, "rows": len(rows)}
    data = catalog.encoded(descriptor)
    store.client.objects[descriptor["prefix"] + "/candidate.json"] = data
    available = next(r for r in payload["sessions"] if r["state"] == "AVAILABLE")
    available.update(descriptor_bytes=len(data), descriptor_sha256=hashlib.sha256(data).hexdigest())
    publish_catalog(store, payload)
    cache = PartCache(tmp_path / "cache", min_free_disk_bytes=0)
    service = Service(store, cache, service_secret="test-service-secret")
    request = {"contractVersion": CONTRACT_VERSION, "operation": "page", "instrumentId": instrument,
               "date": "2026-08-05", "family": "events", "from": str(start), "to": str(start + 5_000_000_000),
               "asOfKey": [str(start + 4_999_999_999), "999", "999", "999"], "limit": 3}
    yield service, request, rows, payload
    service.close()
    assert not list(Path(cache.root).glob("archive-reader-*"))


def call(service, request, client="alice", token=None):
    return service.query(request, client=client, cancel_token=token or CancelToken())


def discover(service, request):
    result = call(service, {"contractVersion": CONTRACT_VERSION, "operation": "catalog"})
    request["snapshotToken"] = result["snapshotToken"]
    return result


def assert_released(service):
    with service.cache._connect() as connection:
        assert connection.execute("SELECT count(*) FROM pins").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM reservations").fetchone()[0] == 0
    assert service.admission.in_flight == 0


def test_real_worker_cold_warm_pages_preserve_every_field_and_release_pins(rig):
    service, request, expected, payload = rig
    release = discover(service, request)
    received, pages = [], []
    for _index in range(100):
        page = call(service, request)
        assert page["releaseId"] == release["releaseId"]
        received += page["rows"]
        pages.append(page)
        assert_released(service)
        if page["nextCursor"] is None:
            break
        request["cursor"] = page["nextCursor"]
        payload["scope"] = "COMPLETE_MONTH_DISPOSITIONS"
        publish_catalog(service.store, payload)
    else:
        pytest.fail("page sequence never ended")
    assert received == [{**row, "append_position": str(i)} for i, row in enumerate(expected)]
    assert pages[0]["scan"]["cacheMisses"] > 0
    assert any(p["scan"]["cacheHits"] > 0 for p in pages[1:])


def test_cursor_binds_viewer_window_and_family_before_any_part_read(rig):
    service, request, _rows, _payload = rig
    discover(service, request)
    request["cursor"] = call(service, request)["nextCursor"]
    with pytest.raises(ArchiveQueryError) as error:
        call(service, request, client="bob")
    assert error.value.code == "POINTER_TOKEN_INVALID"
    for changes in ({"from": str(int(request["from"]) + 1)}, {"family": "states"}, {"cursor": request["cursor"][:-2] + "xx"}):
        with pytest.raises(ArchiveQueryError) as error:
            call(service, {**request, **changes})
        assert error.value.code == "CURSOR_MALFORMED"
    assert_released(service)


def test_corruption_and_cancellation_fail_explicitly_without_pin_leaks(rig):
    service, request, _rows, _payload = rig
    discover(service, request)
    token = CancelToken()
    token.cancel()
    with pytest.raises(ArchiveQueryError) as error:
        call(service, request, token=token)
    assert error.value.code == "CANCELLED"
    call(service, request)
    pointer, payload = service.snapshots.resolve(request["snapshotToken"], "alice")
    descriptor, _manifest, _prefix = catalog.family(service.store, pointer, payload, request["instrumentId"], request["date"], "events")
    part = next(Path(service.cache.path_for(o["sha256"])) for o in descriptor["objects"]
                if "part-" in o["key"] and Path(service.cache.path_for(o["sha256"])).exists())
    data = part.read_bytes()
    part.write_bytes(b"X" + data[1:])
    with pytest.raises(ArchiveQueryError) as error:
        call(service, request)
    assert error.value.code == "PARTITION_VERIFICATION_FAILED"
    assert_released(service)


@pytest.mark.parametrize("changes", [{"family": []}, {"limit": True}, {"from": "0"}, {"extra": 1}])
def test_invalid_request_does_no_storage_work(rig, changes, monkeypatch):
    service, request, _rows, _payload = rig
    request["snapshotToken"] = "a" * 32
    calls = []
    monkeypatch.setattr(service.store.client, "get_object", lambda **kwargs: calls.append(kwargs))
    with pytest.raises(ArchiveQueryError) as error:
        call(service, {**request, **changes})
    assert error.value.code == "MALFORMED_REQUEST"
    assert calls == []


def test_storage_failure_is_named_and_http_errors_keep_l2_contract(rig, monkeypatch):
    service, request, _rows, _payload = rig
    discover(service, request)
    monkeypatch.setattr(service.store.client, "get_object", lambda **_kwargs: (_ for _ in ()).throw(OSError("private endpoint text")))
    with pytest.raises(ArchiveQueryError) as error:
        call(service, request)
    assert error.value.code == "READER_UNAVAILABLE"
    assert "private" not in str(error.value.detail)
    server = serve(service, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for headers, expected in [({}, 401), ({"x-archive-service-secret": service.service_secret, "x-archive-client": "alice"}, 503)]:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1])
            connection.request("POST", "/query", body=json.dumps(request), headers=headers)
            response = connection.getresponse()
            assert response.status == expected
            assert json.loads(response.read())["contractVersion"] == CONTRACT_VERSION
            connection.close()
    finally:
        server.shutdown()
        server.server_close()
    assert_released(service)


@pytest.mark.parametrize("code", ["CANCELLED", "READER_UNAVAILABLE"])
def test_reader_failure_after_part_pin_releases_every_lease(rig, monkeypatch, code):
    service, request, _rows, _payload = rig
    discover(service, request)

    class BrokenReader:
        def read_page(self, _request, **_kwargs):
            with service.cache._connect() as connection:
                assert connection.execute("SELECT count(*) FROM pins").fetchone()[0] > 0
            raise ArchiveQueryError(code, reason="injected reader failure")

    @contextmanager
    def acquire():
        yield BrokenReader()

    monkeypatch.setattr(service.pool, "acquire", acquire)
    with pytest.raises(ArchiveQueryError) as error:
        call(service, request)
    assert error.value.code == code
    assert_released(service)


def test_real_node_gateway_pages_real_python_worker_without_loss(rig):
    service, request, expected, _payload = rig
    server = serve(service, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    script = r'''
const http = require('node:http');
const {createArchiveAuth} = require('./src/server/archive-auth');
const {createHistoricalL2Route} = require('./src/server/historical-l2-route');
const [serviceUrl, raw] = process.argv.slice(1);
async function main() {
 const token='b'.repeat(24);
 const route=createHistoricalL2Route({serviceUrl,serviceSecret:'test-service-secret',auth:createArchiveAuth({clientTokens:`alice:${token}`}),log:()=>{}});
 const server=http.createServer((req,res)=>{ if(!route.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 async function send(body) {
  const response=await fetch(`http://127.0.0.1:${server.address().port}/archive/l2`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  const result=await response.json();
  if(response.status!==200) throw new Error(JSON.stringify(result));
  return result;
 }
 try {
  const catalog=await send({contractVersion:'historical-l2-query/1',operation:'catalog'});
  const request={...JSON.parse(raw),snapshotToken:catalog.snapshotToken};
  const rows=[];
  for(let i=0;i<100;i++) {
   const page=await send(request);rows.push(...page.rows);
   if(page.nextCursor===null) {process.stdout.write(JSON.stringify(rows));return;}
   request.cursor=page.nextCursor;
  }
  throw new Error('pagination failed to terminate');
 } finally {route.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
'''
    try:
        run = subprocess.run(["node", "-e", script, f"http://127.0.0.1:{server.server_address[1]}/query", json.dumps(request)],
                             cwd=Path(__file__).parents[2], capture_output=True, text=True, timeout=30)
        assert run.returncode == 0, run.stderr
        assert json.loads(run.stdout) == [{**row, "append_position": str(i)} for i, row in enumerate(expected)]
    finally:
        server.shutdown()
        server.server_close()
    assert_released(service)
