from __future__ import annotations

import contextlib
import json
import os
import queue
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time

import archive_query as _archive_query
import archive_reader as _reader

MAX_FRAME_BYTES = _reader.MAX_FRAME_BYTES
RESPONSE_DEADLINE_S = 30.0
STOP_GRACE_S = 5.0
POOL_ACQUIRE_TIMEOUT_S = 30.0

READER_UNAVAILABLE = "READER_UNAVAILABLE"
CANCELLED = "CANCELLED"

ArchiveQueryError = _archive_query.ArchiveQueryError

_WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "archive_reader_worker.py")


class ReaderBridge:
    """Owns one isolated reader process.

    Modelled on `conversion/bridge.py`, which already runs this exact protocol
    in the other direction. Its rules carry over because they were earned: a
    crash, a malformed reply or a missed deadline raises rather than returning a
    short page, because a silently truncated read is indistinguishable from a
    genuinely small one.

    Stopping closes stdin first so the worker exits of its own accord; the kill
    is only the backstop for a child that will not."""

    def __init__(self, python_bin=None, worker_path=None, deadline_s=RESPONSE_DEADLINE_S,
                 temp_root=None):
        self._python = python_bin or sys.executable
        self._worker = worker_path or _WORKER
        self._deadline = deadline_s
        self._temp_root = temp_root
        self._temp_dir = None
        self._process = None
        self._lock = threading.Lock()

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_exc):
        self.close()
        return False

    @property
    def alive(self):
        process = self._process
        return process is not None and process.poll() is None

    def start(self):
        if self._process is not None:
            return
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join(
            [os.path.dirname(os.path.abspath(__file__)), env.get("PYTHONPATH", "")])
        self._temp_dir = tempfile.mkdtemp(prefix="archive-reader-", dir=self._temp_root)
        env["TT_READER_TEMP_DIR"] = self._temp_dir
        try:
            self._process = subprocess.Popen(
                [self._python, self._worker], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=None, env=env,
                **({"start_new_session": True} if os.name != "nt" else {}))
        except BaseException:
            self._remove_temp_dir()
            raise

    def _fail(self, reason, **detail):
        self._stop(graceful=False)
        raise ArchiveQueryError(READER_UNAVAILABLE, reason=reason, **detail)

    @staticmethod
    def _close_streams(process):
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:
                pass

    def _stop(self, *, graceful):
        process, self._process = self._process, None
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except Exception:
            pass
        if process.poll() is None:
            if graceful:
                try:
                    process.wait(timeout=STOP_GRACE_S)
                except subprocess.TimeoutExpired:
                    graceful = False
            if not graceful and process.poll() is None:
                try:
                    if os.name == "nt":
                        process.terminate()
                    else:
                        os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=STOP_GRACE_S)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        if os.name == "nt":
                            process.kill()
                        else:
                            os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=STOP_GRACE_S)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
        self._close_streams(process)
        self._remove_temp_dir()

    def _remove_temp_dir(self):
        directory, self._temp_dir = self._temp_dir, None
        if directory is None:
            return
        try:
            import shutil
            shutil.rmtree(directory)
        except OSError:
            pass

    def _read_exact(self, stream, count, *, deadline, cancel_token):
        replies = queue.Queue(maxsize=1)

        def receive():
            try:
                replies.put((True, stream.read(count)))
            except BaseException as error:
                replies.put((False, error))

        reader = threading.Thread(target=receive, daemon=True)
        reader.start()
        while True:
            if cancel_token is not None and cancel_token.cancelled:
                self._stop(graceful=False)
                reader.join(STOP_GRACE_S)
                raise ArchiveQueryError(CANCELLED, reason="CALLER_CANCELLED")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._fail("RESPONSE_DEADLINE_EXCEEDED", deadlineSeconds=self._deadline)
            try:
                ok, result = replies.get(timeout=min(remaining, 0.05))
            except queue.Empty:
                continue
            if not ok:
                self._fail("WORKER_STDOUT_FAILED", error=type(result).__name__)
            return result

    def read_page(self, request, *, cancel_token=None):
        """One page from the isolated reader.

        Serialised per bridge: one request in flight at a time, because the
        frame protocol has no correlation id and a second concurrent request
        would read the first one's reply."""
        with self._lock:
            if self._process is None:
                self.start()
            if cancel_token is not None and cancel_token.cancelled:
                raise ArchiveQueryError(CANCELLED, reason="CALLER_CANCELLED")
            if not isinstance(request, dict):
                raise ArchiveQueryError(READER_UNAVAILABLE, reason="REQUEST_NOT_OBJECT")
            request = dict(request)
            request.setdefault("cursorSecret", _reader._CURSOR_SECRET.hex())
            payload = json.dumps(request, separators=(",", ":")).encode()
            if len(payload) > MAX_FRAME_BYTES:
                raise ArchiveQueryError(READER_UNAVAILABLE, reason="REQUEST_FRAME_TOO_LARGE",
                                        bytes=len(payload))
            try:
                self._process.stdin.write(struct.pack(">I", len(payload)) + payload)
                self._process.stdin.flush()
            except (BrokenPipeError, OSError):
                self._fail("WORKER_STDIN_CLOSED")

            deadline = time.monotonic() + self._deadline
            header = self._read_exact(self._process.stdout, 4, deadline=deadline,
                                      cancel_token=cancel_token)
            if not header or len(header) < 4:
                self._fail("WORKER_EXITED_WITHOUT_REPLY",
                           exitCode=self._process.poll() if self._process else None)
            (length,) = struct.unpack(">I", header)
            if length > MAX_FRAME_BYTES:
                self._fail("RESPONSE_FRAME_TOO_LARGE", bytes=length)
            body = self._read_exact(self._process.stdout, length, deadline=deadline,
                                    cancel_token=cancel_token)
            if body is None or len(body) < length:
                self._fail("TRUNCATED_RESPONSE_FRAME")
            try:
                reply = json.loads(body)
            except json.JSONDecodeError:
                self._fail("MALFORMED_RESPONSE_FRAME")

        if "ok" in reply:
            return reply["ok"]
        if "error" in reply:
            raise ArchiveQueryError(reply["error"], **(reply.get("detail") or {}))
        self._fail("WORKER_FATAL", message=str(reply.get("fatal"))[:2000])

    def close(self):
        with self._lock:
            self._stop(graceful=True)


class BridgePool:
    """A bounded set of reused reader processes.

    Starting a process per page cost a measured 240.32 ms against 13.97 ms for a
    reused bridge, of which only 4.17 ms was the protocol itself; the rest was
    interpreter start, `import duckdb`, mkdtemp and teardown. A bridge is handed
    out exclusively because `read_page` is serialised per bridge, so the pool
    size is the read concurrency and callers must size it to their own
    admission cap rather than assume one."""

    def __init__(self, size, *, acquire_timeout_s=POOL_ACQUIRE_TIMEOUT_S, **bridge_kwargs):
        if not isinstance(size, int) or isinstance(size, bool) or size < 1:
            raise ValueError(f"INVALID_POOL_SIZE:{size!r}")
        self._size = size
        self._acquire_timeout = acquire_timeout_s
        self._bridge_kwargs = bridge_kwargs
        self._idle = []
        self._bridges = set()
        self._checked_out = 0
        self._closed = False
        self._condition = threading.Condition()

    @property
    def size(self):
        return self._size

    def _checkout(self):
        deadline = time.monotonic() + self._acquire_timeout
        while True:
            dead = None
            with self._condition:
                if self._closed:
                    raise ArchiveQueryError(READER_UNAVAILABLE, reason="READER_POOL_CLOSED")
                if self._idle:
                    candidate = self._idle.pop()
                    if candidate.alive:
                        self._checked_out += 1
                        return candidate
                    dead = candidate
                elif self._checked_out < self._size:
                    self._checked_out += 1
                    bridge = ReaderBridge(**self._bridge_kwargs)
                    self._bridges.add(bridge)
                    return bridge
                else:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ArchiveQueryError(READER_UNAVAILABLE,
                                                reason="READER_POOL_EXHAUSTED", size=self._size)
                    self._condition.wait(remaining)
            if dead is not None:
                dead.close()

    def _checkin(self, bridge):
        keep = bridge.alive and not self._closed
        with self._condition:
            self._checked_out -= 1
            if keep:
                self._idle.append(bridge)
            else:
                self._bridges.discard(bridge)
            self._condition.notify()
        if not keep:
            bridge.close()

    @contextlib.contextmanager
    def acquire(self):
        bridge = self._checkout()
        try:
            bridge.start()
            yield bridge
        finally:
            self._checkin(bridge)

    def close(self):
        with self._condition:
            self._closed = True
            bridges, self._bridges = list(self._bridges), set()
            self._idle = []
            self._condition.notify_all()
        for bridge in bridges:
            bridge.close()
