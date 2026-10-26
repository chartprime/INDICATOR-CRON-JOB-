from __future__ import annotations

import threading

import pytest

import archive_admission as aa


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, ms):
        self.now += ms


def _admission(**kwargs):
    kwargs.setdefault("clock", Clock())
    return aa.Admission(**kwargs), kwargs["clock"]


def test_concurrent_reads_are_capped_globally():
    admission, _ = _admission(max_concurrent=2, max_queued=0)
    first = admission.acquire("a")
    second = admission.acquire("b")

    with pytest.raises(aa.ArchiveQueryError) as raised:
        admission.acquire("c")

    assert raised.value.code == aa.OVERLOADED
    assert raised.value.detail["reason"] == "QUEUE_FULL"
    assert raised.value.detail["retryAfterMs"] >= 1
    first.release(); second.release()


def test_one_client_cannot_hold_every_slot():
    # A global cap alone lets one caller occupy every reader while others wait.
    admission, _ = _admission(max_concurrent=2, max_queued=0)
    held = admission.acquire("greedy")

    with pytest.raises(aa.ArchiveQueryError) as raised:
        admission.acquire("greedy")
    assert raised.value.detail["reason"] == "QUEUE_FULL"

    other = admission.acquire("polite")
    assert admission.in_flight == 2
    held.release(); other.release()


def test_the_rate_budget_refuses_with_a_time_to_wait():
    admission, clock = _admission(rate_limit_max=3, rate_limit_window_ms=60_000, max_concurrent=10)
    for _ in range(3):
        admission.acquire("a").release()

    with pytest.raises(aa.ArchiveQueryError) as raised:
        admission.acquire("a")

    assert raised.value.detail["reason"] == "RATE_BUDGET"
    assert raised.value.detail["retryAfterMs"] == 60_000


def test_the_rate_budget_is_a_sliding_window_not_a_fixed_one():
    admission, clock = _admission(rate_limit_max=2, rate_limit_window_ms=1_000, max_concurrent=10)
    admission.acquire("a").release()
    admission.acquire("a").release()
    with pytest.raises(aa.ArchiveQueryError):
        admission.acquire("a")

    clock.advance(1_001)
    admission.acquire("a").release()


def test_the_rate_budget_is_per_client():
    admission, _ = _admission(rate_limit_max=1, max_concurrent=10)
    admission.acquire("a").release()
    with pytest.raises(aa.ArchiveQueryError):
        admission.acquire("a")

    admission.acquire("b").release()


def test_a_study_client_reads_on_its_own_larger_budget():
    # A study pages whole families beside the data; an interactive client pages
    # what one screen shows. The gateway labels its own study reads, and only the
    # holder of the service secret can set that label at all.
    admission, _ = _admission(rate_limit_max=2, study_rate_limit_max=4, max_concurrent=10)
    for _ in range(2):
        admission.acquire("terminal-web").release()
    with pytest.raises(aa.ArchiveQueryError):
        admission.acquire("terminal-web")

    for _ in range(4):
        admission.acquire("terminal-web.study").release()
    with pytest.raises(aa.ArchiveQueryError) as refusal:
        admission.acquire("terminal-web.study")
    assert refusal.value.code == aa.OVERLOADED


def test_the_study_budget_is_still_per_client_and_still_a_sliding_window():
    admission, clock = _admission(rate_limit_max=1, study_rate_limit_max=1,
                                  rate_limit_window_ms=1_000, max_concurrent=10)
    admission.acquire("one.study").release()
    with pytest.raises(aa.ArchiveQueryError):
        admission.acquire("one.study")
    admission.acquire("two.study").release()

    clock.advance(1_000)
    admission.acquire("one.study").release()


def test_a_queued_request_is_admitted_when_a_slot_frees():
    admission, _ = _admission(max_concurrent=1, max_queued=4)
    held = admission.acquire("a")
    outcome = {}

    def waiter():
        try:
            with admission.acquire("b"):
                outcome["ok"] = True
        except aa.ArchiveQueryError as error:
            outcome["error"] = error.detail["reason"]

    thread = threading.Thread(target=waiter)
    thread.start()
    threading.Event().wait(0.05)
    held.release()
    thread.join(5)

    assert outcome == {"ok": True}
    assert admission.in_flight == 0


def test_a_queue_that_is_full_refuses_rather_than_growing():
    admission, _ = _admission(max_concurrent=1, max_queued=1, max_queue_wait_ms=5_000)
    held = admission.acquire("a")
    started = threading.Event()
    results = []

    def waiter(name):
        started.set()
        try:
            admission.acquire(name).release()
        except aa.ArchiveQueryError as error:
            results.append(error.detail["reason"])

    thread = threading.Thread(target=waiter, args=("b",))
    thread.start()
    started.wait(1)
    threading.Event().wait(0.05)

    with pytest.raises(aa.ArchiveQueryError) as raised:
        admission.acquire("c")
    assert raised.value.detail["reason"] == "QUEUE_FULL"

    held.release()
    thread.join(5)


def test_waiting_longer_than_the_queue_allows_is_refused_not_held():
    admission, clock = _admission(max_concurrent=1, max_queued=4, max_queue_wait_ms=100)
    held = admission.acquire("a")
    results = []

    def waiter():
        try:
            admission.acquire("b").release()
        except aa.ArchiveQueryError as error:
            results.append((error.code, error.detail["reason"]))

    thread = threading.Thread(target=waiter)
    thread.start()
    threading.Event().wait(0.05)
    clock.advance(200)
    thread.join(5)
    held.release()

    assert results == [(aa.OVERLOADED, "QUEUE_WAIT_EXCEEDED")]


# ------------------------------------------------------------- cancellation

def test_cancelling_while_queued_releases_the_waiter():
    admission, _ = _admission(max_concurrent=1, max_queued=4, max_queue_wait_ms=60_000)
    held = admission.acquire("a")
    token = aa.CancelToken()
    results = []

    def waiter():
        try:
            admission.acquire("b", token=token).release()
        except aa.ArchiveQueryError as error:
            results.append((error.code, error.detail["reason"]))

    thread = threading.Thread(target=waiter)
    thread.start()
    threading.Event().wait(0.05)
    token.cancel()
    thread.join(5)

    assert results == [(aa.CANCELLED, "CANCELLED_WHILE_QUEUED")]
    assert thread.is_alive() is False
    held.release()


def test_a_cancelled_read_frees_its_slot():
    # The whole point: a cancelled query must release the reader, not merely
    # have its result thrown away.
    admission, _ = _admission(max_concurrent=1, max_queued=0)
    slot = admission.acquire("a")

    with pytest.raises(aa.ArchiveQueryError):
        with slot:
            slot.token.cancel()
            slot.token.raise_if_cancelled()

    assert admission.in_flight == 0
    assert admission.counters["cancelled"] == 1
    admission.acquire("b").release()


def test_a_failed_read_frees_its_slot_too():
    admission, _ = _admission(max_concurrent=1, max_queued=0)

    with pytest.raises(ValueError):
        with admission.acquire("a"):
            raise ValueError("reader blew up")

    assert admission.in_flight == 0
    assert admission.counters["failed"] == 1
    admission.acquire("b").release()


def test_releasing_twice_does_not_free_a_slot_twice():
    # A double release would let in_flight drift below zero and silently raise
    # the effective concurrency cap.
    admission, _ = _admission(max_concurrent=1, max_queued=0)
    slot = admission.acquire("a")
    slot.release()
    slot.release()

    assert admission.in_flight == 0
    admission.acquire("b").release()
    assert admission.in_flight == 0


@pytest.mark.parametrize("field", ["max_concurrent", "max_queued", "max_queue_wait_ms",
                                   "rate_limit_max", "study_rate_limit_max", "rate_limit_window_ms"])
@pytest.mark.parametrize("value", [0, -1, True, 1.5, "2", None])
def test_an_invalid_limit_is_refused_at_construction(field, value):
    if field == "max_queued" and value == 0:
        # A zero-length queue is a real configuration: refuse immediately rather
        # than make a caller wait. Only the other limits have no meaningful zero.
        aa.Admission(max_queued=0)
        return
    with pytest.raises(ValueError):
        aa.Admission(**{field: value})
