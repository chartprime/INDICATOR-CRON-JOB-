from __future__ import annotations

import collections
import threading
import time

import archive_query as _archive_query

MAX_CONCURRENT_READS = 2
MAX_QUEUED = 32
MAX_QUEUE_WAIT_MS = 15_000
RATE_LIMIT_MAX = 72
STUDY_RATE_LIMIT_MAX = 360
STUDY_CLIENT_SUFFIX = ".study"
RATE_LIMIT_WINDOW_MS = 60_000

OVERLOADED = "OVERLOADED"
CANCELLED = "CANCELLED"

ArchiveQueryError = _archive_query.ArchiveQueryError


class CancelToken:
    """Cooperative cancellation.

    A cancelled query must release the reader, not merely have its result
    discarded. Fast scrolling abandons queries continuously, so a cancelled
    query that still holds a slot is a leak that only shows up under real use --
    and the symptom is the whole engine appearing to hang rather than anything
    pointing at the abandoned reads."""

    __slots__ = ("_event",)

    def __init__(self):
        self._event = threading.Event()

    def cancel(self):
        self._event.set()

    @property
    def cancelled(self):
        return self._event.is_set()

    def raise_if_cancelled(self):
        if self._event.is_set():
            raise ArchiveQueryError(CANCELLED, reason="CALLER_CANCELLED")


class Admission:
    """Bounds interactive reads the way the terminal's other paged history path
    already does.

    Three independent limits, because they fail differently. A rate budget stops
    one caller spending the archive's whole capacity on retries. A global
    concurrency cap keeps readers from contending with each other and with the
    live collector. A per-client cap stops one caller occupying every slot while
    others wait, which a global cap alone permits.

    A refused request carries `retryAfterMs` so the caller backs off by
    instruction rather than by guess."""

    def __init__(self, *, max_concurrent=MAX_CONCURRENT_READS, max_queued=MAX_QUEUED,
                 max_queue_wait_ms=MAX_QUEUE_WAIT_MS, rate_limit_max=RATE_LIMIT_MAX,
                 study_rate_limit_max=STUDY_RATE_LIMIT_MAX,
                 rate_limit_window_ms=RATE_LIMIT_WINDOW_MS, clock=None):
        for name, value, floor in (("max_concurrent", max_concurrent, 1),
                                   ("max_queued", max_queued, 0),
                                   ("max_queue_wait_ms", max_queue_wait_ms, 1),
                                   ("rate_limit_max", rate_limit_max, 1),
                                   ("study_rate_limit_max", study_rate_limit_max, 1),
                                   ("rate_limit_window_ms", rate_limit_window_ms, 1)):
            if not isinstance(value, int) or isinstance(value, bool) or value < floor:
                raise ValueError(f"{name} must be an integer >= {floor}")
        self._max_concurrent = max_concurrent
        self._max_queued = max_queued
        self._max_queue_wait_ms = max_queue_wait_ms
        self._rate_max = rate_limit_max
        self._study_rate_max = study_rate_limit_max
        self._rate_window_ms = rate_limit_window_ms
        self._clock = clock or (lambda: time.monotonic() * 1000.0)
        self._lock = threading.Condition()
        self._reading = 0
        self._reading_clients = set()
        self._queued = 0
        self._requests = collections.defaultdict(collections.deque)
        self.counters = collections.Counter()

    def _rate_max_for(self, client):
        """A study reads whole families sequentially beside the data; an interactive
        client pages what a screen shows. They are the same reader with different
        shapes of work, so they get different budgets. The suffix is the gateway's
        own label for its study reads -- only the holder of the service secret can
        set `x-archive-client` at all -- and it is a budget class, never an identity."""
        return self._study_rate_max if client.endswith(STUDY_CLIENT_SUFFIX) else self._rate_max

    def _rate_retry_after(self, client, at):
        recent = self._requests[client]
        while recent and at - recent[0] >= self._rate_window_ms:
            recent.popleft()
        if len(recent) >= self._rate_max_for(client):
            return max(1, int(recent[0] + self._rate_window_ms - at))
        recent.append(at)
        return None

    def _slot_free(self, client):
        return self._reading < self._max_concurrent and client not in self._reading_clients

    def acquire(self, client, *, token=None):
        """Take a reader slot, waiting only as long as the queue allows."""
        token = token or CancelToken()
        deadline = self._clock() + self._max_queue_wait_ms
        with self._lock:
            retry_after = self._rate_retry_after(client, self._clock())
            if retry_after is not None:
                self.counters["rejected_rate"] += 1
                raise ArchiveQueryError(OVERLOADED, reason="RATE_BUDGET",
                                        retryAfterMs=retry_after)
            if not self._slot_free(client):
                if self._queued >= self._max_queued:
                    self.counters["rejected_queue_full"] += 1
                    raise ArchiveQueryError(OVERLOADED, reason="QUEUE_FULL",
                                            retryAfterMs=self._max_queue_wait_ms,
                                            queued=self._queued)
                self._queued += 1
                self.counters["queued"] += 1
                try:
                    while not self._slot_free(client):
                        if token.cancelled:
                            self.counters["cancelled_in_queue"] += 1
                            raise ArchiveQueryError(CANCELLED, reason="CANCELLED_WHILE_QUEUED")
                        remaining = deadline - self._clock()
                        if remaining <= 0:
                            self.counters["rejected_queue_wait"] += 1
                            raise ArchiveQueryError(OVERLOADED, reason="QUEUE_WAIT_EXCEEDED",
                                                    retryAfterMs=self._max_queue_wait_ms)
                        self._lock.wait(min(remaining, 50) / 1000.0)
                finally:
                    self._queued -= 1
            self._reading += 1
            self._reading_clients.add(client)
            self.counters["admitted"] += 1
        return _Slot(self, client, token)

    def _release(self, client, outcome):
        with self._lock:
            self._reading -= 1
            self._reading_clients.discard(client)
            self.counters[outcome] += 1
            self._lock.notify_all()

    @property
    def in_flight(self):
        with self._lock:
            return self._reading


class _Slot:
    """A held reader slot. Released on every exit path, including cancellation
    and failure -- a slot that outlives its request is invisible until the
    engine stops admitting anything."""

    def __init__(self, admission, client, token):
        self._admission = admission
        self._client = client
        self.token = token
        self._released = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, _tb):
        outcome = "completed"
        if exc_type is not None:
            outcome = "cancelled" if getattr(exc, "code", None) == CANCELLED else "failed"
        self.release(outcome)
        return False

    def release(self, outcome="completed"):
        if self._released:
            return
        self._released = True
        self._admission._release(self._client, outcome)
