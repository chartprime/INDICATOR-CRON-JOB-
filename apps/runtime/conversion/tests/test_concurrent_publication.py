"""Real-subprocess proof that the on_catalog_publish hook (job.py/catalog.py)
closes the remote-publish race: two independent dataset_versions, run as two
real OS processes against the same curated_root/catalog_root, started at the
same instant via a real barrier so they genuinely contend for the same
PublisherLock. Threads would not exercise this -- LocalLock's flock is per
open file description, not meaningfully racy within a single interpreter,
and a real process kill has no thread equivalent.

The barrier synchronizes the *start* of each worker's run, not the publish
step itself -- PublisherLock is a real mutual-exclusion lock, so only one
worker can ever be inside the hook at a time; having both wait on a second
barrier from inside it would be a structural deadlock, not a race. A
deliberate hold inside the hook widens the window so the second worker
reliably arrives while the first still holds the lock, and a shared,
timestamped event log proves that overlap actually happened rather than
hoping the timing worked out.
"""
from __future__ import annotations

import multiprocessing
import os
import sqlite3
import time

import pytest

import backfill_driver
import catalog
import job
import s3_publish
from shared_fake_s3 import SharedFakeClient as _SharedFakeClient

_CSV_HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"
_CSV_ROWS = [
    "1756800000000000000,32,2,38,231460000000,231460000000,231460000000,231460000000,21",
    "1756886400000000000,32,2,38,232000000000,232500000000,231900000000,232400000000,1000",
]
_HOOK_HOLD_S = 3.0


def _csv_file(path):
    path.write_text("\n".join([_CSV_HEADER, *_CSV_ROWS]) + "\n")
    return str(path)


def _worker(objects, last_modified, guard, start_barrier, events, worker_id, csv_path, symbol,
            dataset_version, staging_root, curated_root, catalog_root, result_queue,
            hold_s=_HOOK_HOLD_S, kill_signal=None, recover_stale_intent=False):
    client = _SharedFakeClient(objects, last_modified, guard)
    store = s3_publish.Store(client, "bucket", "curated/test")

    # PublisherLock is a real mutual-exclusion lock, so a waiter's hook can
    # only ever run *after* the holder's has finished -- "enter" timestamps
    # can never overlap by construction. The actual proof of contention is
    # catching the moment a worker *starts trying* to acquire, which can and
    # should fall inside another worker's held window.
    real_acquire = catalog.PublisherLock.acquire
    def tracking_acquire(self):
        events.append((worker_id, "acquire_attempt", time.monotonic()))
        return real_acquire(self)
    catalog.PublisherLock.acquire = tracking_acquire

    def hook(payload, parent):
        events.append((worker_id, "enter", time.monotonic()))
        if kill_signal is not None:
            kill_signal.set()
            time.sleep(30)  # parent kills this process well before this returns
        time.sleep(hold_s)
        s3_publish.publish(store, curated_root, payload, expected_parent=parent)
        events.append((worker_id, "exit", time.monotonic()))

    try:
        start_barrier.wait(timeout=30)
        inputs = [{
            "local_path": csv_path,
            "s3_key": f"raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol={symbol}/year=2025/month=09/x.csv",
            "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": symbol,
        }]
        run = lambda: job.run_job(
            inputs, dataset_version, staging_root=staging_root, curated_root=curated_root,
            catalog_root=catalog_root, on_catalog_publish=hook,
        )
        if recover_stale_intent:
            summary = backfill_driver.recover_from_stale_intent(
                run, catalog_root=catalog_root, dataset_version=dataset_version,
            )
        else:
            summary = run()
        result_queue.put(("ok", summary["catalog_pointer"]))
    except Exception as error:
        result_queue.put(("error", f"{type(error).__name__}: {error}"))


def _roots(base, name):
    return {
        "staging_root": str(base / name / "staging"),
        "curated_root": str(base / "shared" / "curated"),
        "catalog_root": str(base / "shared" / "curated" / "_catalog"),
    }


def test_two_real_processes_racing_to_publish_both_succeed_and_chain_correctly(tmp_path):
    manager = multiprocessing.Manager()
    objects, last_modified = manager.dict(), manager.dict()
    guard = manager.Lock()
    start_barrier = manager.Barrier(2)
    events = manager.list()
    result_queue = manager.Queue()

    roots_a = _roots(tmp_path, "a")
    roots_b = _roots(tmp_path, "b")
    os.makedirs(tmp_path / "a", exist_ok=True)
    os.makedirs(tmp_path / "b", exist_ok=True)
    csv_a = _csv_file(tmp_path / "a" / "aapl.csv")
    csv_b = _csv_file(tmp_path / "b" / "tsla.csv")

    proc_a = multiprocessing.Process(target=_worker, args=(
        objects, last_modified, guard, start_barrier, events, "A", csv_a, "AAPL", "v1",
        roots_a["staging_root"], roots_a["curated_root"], roots_a["catalog_root"], result_queue,
    ))
    proc_b = multiprocessing.Process(target=_worker, args=(
        objects, last_modified, guard, start_barrier, events, "B", csv_b, "TSLA", "v2",
        roots_b["staging_root"], roots_b["curated_root"], roots_b["catalog_root"], result_queue,
    ))
    proc_a.start()
    proc_b.start()
    proc_a.join(timeout=60)
    proc_b.join(timeout=60)
    assert proc_a.exitcode == 0 and proc_b.exitcode == 0

    outcomes = [result_queue.get(timeout=5), result_queue.get(timeout=5)]
    assert [o[0] for o in outcomes] == ["ok", "ok"], outcomes

    # Real proof of contention, not assumed. PublisherLock is a real mutual
    # exclusion lock, so the two "enter" events (hook actually running)
    # structurally cannot overlap -- that would disprove the lock, not prove
    # the race handling. The real proof: whichever worker acquires second
    # must have *started trying* (acquire_attempt) before the first worker
    # released (exit), i.e. it queued behind a live holder rather than
    # racing past it or failing -- and it only entered its own hook after
    # that holder exited.
    by_worker = {}
    for worker_id, kind, t in events:
        by_worker.setdefault(worker_id, {})[kind] = t
    assert set(by_worker) == {"A", "B"}
    first_id, second_id = sorted(by_worker, key=lambda w: by_worker[w]["enter"])
    first, second = by_worker[first_id], by_worker[second_id]
    assert first["enter"] < first["exit"] < second["enter"]
    assert second["acquire_attempt"] < first["exit"], (
        "the second worker never actually queued behind the first while it held the lock"
    )

    catalog_root = roots_a["catalog_root"]
    current = catalog.read_current(catalog_root)
    assert current["dataset_version"] in ("v1", "v2")

    con = sqlite3.connect(":memory:")
    con.execute("ATTACH DATABASE ? AS snap", [os.path.join(catalog_root, current["catalog_key"])])
    try:
        versions = {r[0] for r in con.execute("SELECT dataset_version FROM snap.dataset_versions")}
        partitions = con.execute("SELECT count(*) FROM snap.partitions").fetchone()[0]
    finally:
        con.close()
    assert versions == {"v1", "v2"}
    assert partitions == 4  # each symbol's fixture spans 2 days -- both symbols' both days present, none lost


def test_killing_the_lock_holder_frees_the_waiter_and_a_later_retry_recovers_cleanly(tmp_path):
    manager = multiprocessing.Manager()
    objects, last_modified = manager.dict(), manager.dict()
    guard = manager.Lock()
    events = manager.list()
    kill_signal = manager.Event()
    result_queue = manager.Queue()

    roots_a = _roots(tmp_path, "a")
    roots_b = _roots(tmp_path, "b")
    os.makedirs(tmp_path / "a", exist_ok=True)
    os.makedirs(tmp_path / "b", exist_ok=True)
    csv_a = _csv_file(tmp_path / "a" / "aapl.csv")
    csv_b = _csv_file(tmp_path / "b" / "tsla.csv")

    # The victim wins the race to acquire PublisherLock (its hook signals
    # kill_signal the instant it's inside, then blocks) -- the survivor
    # starts shortly after and will find the lock held and must wait. Each
    # gets its own single-party (no-op) barrier: the explicit stagger below
    # is what establishes ordering here, not a shared rendezvous -- a shared
    # 2-party barrier reached before either does any real work would just
    # cancel the head start. Each barrier is kept in a named variable -- an
    # inline manager.Barrier(1) with no surviving reference in the parent
    # gets garbage-collected out of the manager's registry before the child
    # can use it (a real multiprocessing.Manager proxy-lifetime gotcha).
    victim_barrier = manager.Barrier(1)
    survivor_barrier = manager.Barrier(1)
    victim = multiprocessing.Process(target=_worker, args=(
        objects, last_modified, guard, victim_barrier, events, "victim", csv_a, "AAPL", "v1",
        roots_a["staging_root"], roots_a["curated_root"], roots_a["catalog_root"], result_queue,
    ), kwargs={"kill_signal": kill_signal})
    survivor = multiprocessing.Process(target=_worker, args=(
        objects, last_modified, guard, survivor_barrier, events, "survivor", csv_b, "TSLA", "v2",
        roots_b["staging_root"], roots_b["curated_root"], roots_b["catalog_root"], result_queue,
    ))

    victim.start()
    time.sleep(0.2)  # give the victim a head start so it reliably wins the lock
    survivor.start()
    assert kill_signal.wait(timeout=30)  # victim is inside the lock, about to hold -- kill it now
    victim.terminate()
    victim.join(timeout=30)
    assert victim.exitcode != 0

    survivor.join(timeout=60)
    survivor_status, survivor_pointer = result_queue.get(timeout=5)
    assert survivor_status == "ok", survivor_pointer  # the OS released the flock when the victim died

    retry_queue = manager.Queue()
    retry_barrier = manager.Barrier(1)
    retry = multiprocessing.Process(target=_worker, args=(
        objects, last_modified, guard, retry_barrier, events, "retry", csv_a, "AAPL", "v1",
        roots_a["staging_root"], roots_a["curated_root"], roots_a["catalog_root"], retry_queue,
    ), kwargs={"recover_stale_intent": True})
    retry.start()
    retry.join(timeout=60)
    assert retry.exitcode == 0
    retry_status, retry_pointer = retry_queue.get(timeout=5)
    assert retry_status == "ok", retry_pointer

    catalog_root = roots_a["catalog_root"]
    con = sqlite3.connect(":memory:")
    con.execute("ATTACH DATABASE ? AS snap", [os.path.join(catalog_root, retry_pointer["catalog_key"])])
    try:
        versions = {r[0] for r in con.execute("SELECT dataset_version FROM snap.dataset_versions")}
        partitions = con.execute("SELECT count(*) FROM snap.partitions").fetchone()[0]
    finally:
        con.close()
    assert versions == {"v1", "v2"}
    assert partitions == 4  # each symbol's fixture spans 2 days -- both symbols' both days present, none lost
