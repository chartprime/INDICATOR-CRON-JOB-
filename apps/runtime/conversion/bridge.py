"""Persistent Node contract-worker client: length-prefixed JSON frames over pipes.

One worker per conversion job. A worker crash, a malformed response, a count
mismatch, or a missed deadline raises BridgeError and fails the job -- never a
silent skip. Graceful stop closes stdin; the backstop for an abrupt parent kill
is the supervising unit's cgroup (see design lock 0.7), with a process-group
SIGTERM/SIGKILL here for local use.
"""
from __future__ import annotations

import atexit
import json
import os
import queue
import signal
import struct
import subprocess
import threading
import time
import weakref

MAX_FRAME_BYTES = 16 * 1024 * 1024
RESPONSE_DEADLINE_S = 30.0
STOP_GRACE_S = 5.0

_SENTINEL = object()


class BridgeError(RuntimeError):
    pass


def _read_exact(stream, n):
    chunks = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


class ContractBridge:
    def __init__(self, worker_path, node_bin="node"):
        self._worker_path = os.fspath(worker_path)
        self._node_bin = node_bin
        self._proc = None
        self._responses = queue.Queue()
        self._reader = None
        self._read_error = None
        self._closed = False

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_exc):
        self.close()

    def start(self):
        if self._proc is not None:
            raise BridgeError("bridge already started")
        kwargs = {}
        if os.name == "posix":
            kwargs["start_new_session"] = True
        else:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        self._proc = subprocess.Popen(
            [self._node_bin, self._worker_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
        self._reader = threading.Thread(target=self._read_loop, name="contract-bridge-reader", daemon=True)
        self._reader.start()
        atexit.register(_atexit_close, weakref.ref(self))

    def _read_loop(self):
        stdout = self._proc.stdout
        try:
            while True:
                header = _read_exact(stdout, 4)
                if header is None:
                    raise BridgeError("worker closed stdout")
                (length,) = struct.unpack(">I", header)
                if length > MAX_FRAME_BYTES:
                    raise BridgeError(f"response frame {length} exceeds {MAX_FRAME_BYTES}")
                body = _read_exact(stdout, length)
                if body is None:
                    raise BridgeError("worker closed stdout mid-frame")
                self._responses.put(json.loads(body.decode("utf-8")))
        except BaseException as error:
            self._read_error = error
            self._responses.put(_SENTINEL)

    def map_batch(self, batch_id, provider, family, rows, context):
        if self._proc is None or self._closed:
            raise BridgeError("bridge is not running")
        request = {"batchId": batch_id, "provider": provider, "family": family, "rows": rows, "context": context}
        payload = json.dumps(request, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_FRAME_BYTES:
            raise BridgeError(f"request frame {len(payload)} exceeds {MAX_FRAME_BYTES}; reduce the batch size")
        deadline = time.monotonic() + RESPONSE_DEADLINE_S
        sent = queue.Queue(maxsize=1)
        def send():
            try:
                self._proc.stdin.write(struct.pack(">I", len(payload)) + payload)
                self._proc.stdin.flush()
                sent.put(None)
            except (BrokenPipeError, ValueError, OSError) as error:
                sent.put(error)
        sender = threading.Thread(target=send, daemon=True)
        sender.start()
        try:
            error = sent.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty:
            self._kill()
            sender.join(timeout=STOP_GRACE_S)
            raise BridgeError(f"worker did not respond within {RESPONSE_DEADLINE_S}s (blocked stdin)")
        if error is not None:
            raise BridgeError(f"worker stdin unavailable: {error}") from error
        try:
            response = self._responses.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty:
            self._kill()
            raise BridgeError(f"worker did not respond within {RESPONSE_DEADLINE_S}s")
        if response is _SENTINEL:
            raise BridgeError(f"worker read loop failed: {self._read_error}")
        if isinstance(response, dict) and "fatal" in response:
            raise BridgeError(f"worker fatal: {response['fatal']}")
        if not isinstance(response, dict) or response.get("batchId") != batch_id:
            raise BridgeError(f"response batchId {response.get('batchId') if isinstance(response, dict) else response!r} != {batch_id!r}")
        results = response.get("results")
        if not isinstance(results, list) or len(results) != len(rows):
            raise BridgeError("worker returned a result count that does not match the batch")
        return results

    def close(self):
        if self._closed:
            return
        self._closed = True
        proc = self._proc
        if proc is None:
            return
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=STOP_GRACE_S)
        except subprocess.TimeoutExpired:
            self._kill()

    def _kill(self):
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            else:
                proc.terminate()
            proc.wait(timeout=STOP_GRACE_S)
        except (ProcessLookupError, PermissionError):
            return
        except subprocess.TimeoutExpired:
            try:
                if os.name == "posix":
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                else:
                    proc.kill()
                proc.wait(timeout=STOP_GRACE_S)
            except (ProcessLookupError, PermissionError, subprocess.TimeoutExpired):
                pass

    @property
    def returncode(self):
        return None if self._proc is None else self._proc.poll()

    def stderr_text(self):
        if self._proc is None or self._proc.stderr is None:
            return ""
        try:
            return self._proc.stderr.read().decode("utf-8", "replace")
        except OSError:
            return ""


def _atexit_close(ref):
    obj = ref()
    if obj is not None:
        obj.close()
