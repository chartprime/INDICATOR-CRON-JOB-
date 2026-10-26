import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import run_historical_core_month as runner
from test_plan_historical_core_month import catalog


def setup(tmp_path, monkeypatch):
    source = catalog(tmp_path)
    pin = runner.digest(source)
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(runner, "DATA_ROOT", data)
    identity = {"code": "a", "runtime": "pinned"}
    monkeypatch.setattr(runner, "code_identity", lambda _: dict(identity))

    def validate(root, stem, session, plan_id, _pin):
        value = runner.read_json(root / (stem + "-status.json"))
        if value != {"state": "LOCAL_VERIFIED", "plan_id": plan_id, "instrument": session["instrument"]}:
            raise ValueError("fake output changed")
        return {"stem": stem, "candidate_sha256": runner.digest(root / (stem + "-status.json"))}

    monkeypatch.setattr(runner, "validate", validate)
    plan_id = runner.plan(source, "2026-08", pin)["plan_id"]
    calls, active, maximum = [], [0], [0]
    guard = threading.Lock()

    def driver(_catalog, _pin, session, _node, stem, stopped):
        with guard:
            calls.append(stem)
            active[0] += 1
            maximum[0] = max(maximum[0], active[0])
        try:
            time.sleep(0.02)
            if stopped.is_set():
                raise InterruptedError()
            runner.atomic_json(data / (stem + "-status.json"),
                               {"state": "LOCAL_VERIFIED", "plan_id": plan_id, "instrument": session["instrument"]})
        finally:
            with guard:
                active[0] -= 1

    return source, pin, data, identity, calls, maximum, driver


def test_bounded_complete_month_resumes_only_after_revalidation(tmp_path, monkeypatch):
    source, pin, data, _identity, calls, maximum, driver = setup(tmp_path, monkeypatch)
    result = runner.run(source, pin, "node", driver=driver)
    assert result["state"] == "LOCAL_VERIFIED"
    assert result["summary"] == {"AVAILABLE": 4, "UNAVAILABLE": 120}
    assert maximum[0] == 2
    assert len(calls) == len(set(calls)) == 4
    assert runner.run(source, pin, "node", driver=driver)["sessions"] == result["sessions"]
    assert len(calls) == 4
    (data / (calls[0] + "-status.json")).write_text('{}')
    with pytest.raises(ValueError, match="changed"):
        runner.run(source, pin, "node", driver=driver)
    assert len(calls) == 4


def test_failed_attempt_stays_visible_and_retry_preserves_previous_files(tmp_path, monkeypatch):
    source, pin, data, _identity, calls, _maximum, driver = setup(tmp_path, monkeypatch)

    def faulty(*args):
        if args[2]["instrument"] == "NQU6":
            (data / (args[4] + "-partial")).write_text("diagnostic")
            raise RuntimeError("producer failed")
        driver(*args)

    failed = runner.run(source, pin, "node", driver=faulty)
    assert failed["state"] == "INCOMPLETE"
    assert failed["summary"] == {"AVAILABLE": 3, "FAILED": 1, "UNAVAILABLE": 120}
    assert runner.run(source, pin, "node", driver=driver)["state"] == "INCOMPLETE"
    assert len(calls) == 3
    resumed = runner.run(source, pin, "node", retry_failed=True, driver=driver)
    assert resumed["state"] == "LOCAL_VERIFIED"
    assert resumed["sessions"]["NQU6/2026-08-05"]["attempts"] == [
        "stage3-nqu6-2026-08-05-a0001", "stage3-nqu6-2026-08-05-a0002"]
    assert (data / "stage3-nqu6-2026-08-05-a0001-partial").read_text() == "diagnostic"


def test_code_change_refuses_resume_and_single_month_owner(tmp_path, monkeypatch):
    source, pin, data, identity, calls, _maximum, driver = setup(tmp_path, monkeypatch)
    runner.run(source, pin, "node", driver=driver)
    root = data / ("month-2026-08-" + runner.plan(source, "2026-08", pin)["plan_id"][:12])
    with runner.LocalLock(root / "run.guard"):
        with pytest.raises(OSError):
            runner.run(source, pin, "node", driver=driver)
    identity["code"] = "b"
    with pytest.raises(ValueError, match="differs"):
        runner.run(source, pin, "node", driver=driver)
    assert len(calls) == 4


@pytest.mark.parametrize("stem", ["stage3-nqu6-2026-08-05", "stage3-nqu6-2026-08-05-a0003"])
def test_adopt_revalidates_sealed_rehearsals_and_numbered_attempts(tmp_path, monkeypatch, stem):
    source, pin, data, _identity, calls, _maximum, driver = setup(tmp_path, monkeypatch)
    session = next(row for row in runner.plan(source, "2026-08", pin)["sessions"]
                   if row["instrument"] == "NQU6" and row["date"] == "2026-08-05")
    driver(source, pin, session, "node", stem, threading.Event())
    result = runner.run(source, pin, "node", adopt=(stem,), driver=driver)
    assert result["state"] == "LOCAL_VERIFIED" and len(calls) == 4
    assert result["sessions"]["NQU6/2026-08-05"]["proof"]["stem"] == stem
    assert result["sessions"]["NQU6/2026-08-05"]["attempts"] == []
    with pytest.raises(ValueError, match="outside the admitted inventory"):
        runner.run(source, pin, "node", adopt=("../" + stem,), driver=driver)


def test_stop_launches_no_work_and_completed_crash_window_is_recovered(tmp_path, monkeypatch):
    source, pin, data, _identity, calls, _maximum, driver = setup(tmp_path, monkeypatch)
    stopped = threading.Event()
    stopped.set()
    result = runner.run(source, pin, "node", driver=driver, stopped=stopped)
    assert result["summary"] == {"PENDING": 4, "UNAVAILABLE": 120}
    assert calls == []
    finished = runner.run(source, pin, "node", driver=driver)
    root = data / ("month-2026-08-" + finished["plan"]["plan_id"][:12])
    finished["sessions"]["ESU6/2026-08-05"]["state"] = "RUNNING"
    finished["sessions"]["ESU6/2026-08-05"].pop("proof")
    runner.atomic_json(root / "run.json", finished)
    recovered = runner.run(source, pin, "node", driver=driver)
    assert recovered["state"] == "LOCAL_VERIFIED"
    assert len(calls) == 4


def test_overlapping_day_attempts_hold_one_lock_and_refuse_bad_attempt_names(tmp_path, monkeypatch):
    import rehearse_historical_core_day as rehearsal
    monkeypatch.setattr(rehearsal, "DATA_ROOT", tmp_path)
    inventory = {"plan_id": "a" * 64, "sessions": [{"instrument": "NQU6", "date": "2026-08-05",
                                                     "reason": "AWAITING_FULL_DAY_QUALIFICATION"}]}
    monkeypatch.setattr(rehearsal, "plan", lambda *_: inventory)
    with runner.LocalLock(tmp_path / "_locks/day-NQU6-2026-08-05.guard"):
        with pytest.raises(OSError):
            rehearsal.run(tmp_path / "catalog", "a" * 64, "NQU6", "2026-08-05", "node")
    with pytest.raises(ValueError, match="attempt identity"):
        rehearsal.run(tmp_path / "catalog", "a" * 64, "NQU6", "2026-08-05", "node", stem="../escape")


@pytest.mark.parametrize("workers", [0, 3, True])
def test_worker_budget_refuses_before_inventory(tmp_path, workers):
    with pytest.raises(ValueError, match="worker admission"):
        runner.run(tmp_path / "missing", "a" * 64, "node", workers=workers)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux converter process-group contract")
@pytest.mark.parametrize("leader_exits", [False, True])
def test_cancellation_stops_descendants_even_after_worker_leader_exits(tmp_path, leader_exits):
    pid_file = tmp_path / "descendant.pid"
    descendant = ("import os,signal,time; from pathlib import Path; "
                  "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                  f"Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)")
    leader = ("import subprocess,sys,time; "
              f"subprocess.Popen([sys.executable,'-c',{descendant!r}]); "
              + ("time.sleep(0.2)" if leader_exits else "time.sleep(60)"))
    child = subprocess.Popen([sys.executable, "-c", leader], start_new_session=True)
    try:
        deadline = time.monotonic() + 10
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert pid_file.exists(), "descendant failed to initialize"
        pid = int(pid_file.read_text())
        if leader_exits:
            assert child.wait(timeout=10) == 0
        os.kill(pid, 0)
        runner.stop_child(child)
        assert child.poll() is not None
        proc = Path(f"/proc/{pid}/stat")
        deadline = time.monotonic() + 5
        while proc.exists() and proc.read_text().split(") ", 1)[1].split()[0] != "Z" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not proc.exists() or proc.read_text().split(") ", 1)[1].split()[0] == "Z"
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
