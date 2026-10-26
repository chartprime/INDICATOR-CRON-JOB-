from __future__ import annotations

import json
import select
import socket
import threading
import time

import pytest

import archive_http as ah
from test_archive_service import CURATED, rig  # noqa: F401

# Report 57 W2, FA-5 (found by running the suite in parallel): a request refused
# before its body is read -- no service secret, a wrong secret, bad framing, no
# free inbound handler -- was answered and the socket closed at once. A client
# that sends its headers and its body as two writes (Python's http.client does;
# any client may under load) then lands the body on a closed socket, the peer
# answers with a reset, and the reset destroys the refusal before the caller
# reads it: a clean 401 or 429 surfaces as a connection error. Every refusal
# must reach the caller intact, whenever the rest of the body arrives.

BODY_BYTES = 4_096


def _post_headers_then_body(port, secret, content_length=BODY_BYTES):
    head = (f"POST /query HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n"
            f"content-length: {content_length}\r\n{ah.SERVICE_SECRET_HEADER}: {secret}\r\n"
            f"{ah.CLIENT_HEADER}: tester\r\n\r\n").encode()
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        sock.sendall(head)
        readable, _, _ = select.select([sock], [], [], 10)
        assert readable, "the service did not answer the refused request"
        time.sleep(0.2)
        sock.sendall(b"x" * BODY_BYTES)
        time.sleep(0.2)
        chunks = []
        while True:
            chunk = sock.recv(65_536)
            if not chunk:
                break
            chunks.append(chunk)
    raw = b"".join(chunks)
    status_line, _, rest = raw.partition(b"\r\n")
    return int(status_line.split()[1]), json.loads(rest.partition(b"\r\n\r\n")[2])


@pytest.mark.parametrize("configured, presented, content_length, status, reason", [
    ("", "anything", BODY_BYTES, 401, "SERVICE_SECRET_NOT_CONFIGURED"),
    ("right", "wrong", BODY_BYTES, 401, "SERVICE_SECRET_MISMATCH"),
    ("right", "right", ah.MAX_REQUEST_BYTES + 1, 400, "CONTENT_LENGTH"),
])
def test_a_refusal_reaches_the_caller_even_when_the_body_arrives_after_it(
        rig, configured, presented, content_length, status, reason):  # noqa: F811
    service = ah.ArchiveHttpService(
        registry=rig["registry"], cache=rig["cache"], store=rig["store"],
        connection=rig["connection"], curated_prefix=CURATED)
    server = ah.serve(service, port=0, service_secret=configured)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        answer = _post_headers_then_body(server.server_address[1], presented, content_length)
    finally:
        server.shutdown()
        server.server_close()
    assert (answer[0], reason in json.dumps(answer[1])) == (status, True)
