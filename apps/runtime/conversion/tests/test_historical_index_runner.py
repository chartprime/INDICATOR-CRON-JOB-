import hashlib
import json
from pathlib import Path
import subprocess
import sys
from threading import Event

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/verify/databento"))
import run_historical_index_plan as runner


def receipt(tmp_path, monkeypatch):
    plan = {"pointer": {"release_id": "a" * 64}}
    job = {"descriptor_sha256": "b" * 64}
    native = tmp_path / "native.json"
    native.write_text(json.dumps({"status": "PASS", "release_id": "a" * 64,
        "descriptor_sha256": "b" * 64, "index_manifest_sha256": "c" * 64}))
    identity = {"manifest_bytes": 1, "manifest_sha256": "c" * 64}
    result = {"status": "PASS", "native_receipt": str(native),
        "native_receipt_sha256": hashlib.sha256(native.read_bytes()).hexdigest(),
        "walls": {"directory": str(tmp_path), "identity": identity},
        "prints": {"directory": str(tmp_path), "identity": identity}}
    monkeypatch.setattr(runner, "check_index", lambda *_args: identity)
    return plan, job, result


def test_resume_requires_passing_bound_native_proof(tmp_path, monkeypatch):
    plan, job, result = receipt(tmp_path, monkeypatch)
    runner.check_receipt(result, plan, job)
    result["status"] = "FAILED"
    with pytest.raises(ValueError, match="not complete"):
        runner.check_receipt(result, plan, job)
    result["status"] = "PASS"
    plan["pointer"]["release_id"] = "d" * 64
    with pytest.raises(ValueError, match="pinned job"):
        runner.check_receipt(result, plan, job)


def test_resume_refuses_changed_receipt_or_index(tmp_path, monkeypatch):
    plan, job, result = receipt(tmp_path, monkeypatch)
    result["walls"]["identity"] = {"manifest_bytes": 1, "manifest_sha256": "d" * 64}
    with pytest.raises(ValueError, match="completed bytes"):
        runner.check_receipt(result, plan, job)
    result["native_receipt_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="receipt differs"):
        runner.check_receipt(result, plan, job)


def test_cancellation_cleans_entire_process_group_even_if_parent_exits(monkeypatch):
    class Process:
        pid = 12345
        returncode = None

        def poll(self):
            return self.returncode

        def wait(self, **_kwargs):
            self.returncode = 0
            return 0

    process, signals, options = Process(), [], []
    monkeypatch.setattr(runner.os, "name", "posix")
    monkeypatch.setattr(runner.os, "killpg", lambda pid, sig: signals.append((pid, sig)), raising=False)
    monkeypatch.setattr(runner.signal, "SIGKILL", 9, raising=False)
    def spawn(*_args, **kwargs):
        options.append(kwargs)
        return process
    monkeypatch.setattr(runner.subprocess, "Popen", spawn)
    stop = Event()
    stop.set()
    with pytest.raises(InterruptedError):
        runner.bounded_command(["unused"], stdout=None, stderr=None, env={}, stop=stop, timeout=10)
    assert options[0]["start_new_session"] is True
    assert signals == [(12345, runner.signal.SIGTERM), (12345, 9)]


def test_failed_subprocess_never_becomes_success(monkeypatch):
    class Process:
        pid = 12345
        returncode = 2
        def poll(self):
            return 2
        def wait(self, **_kwargs):
            return 2
    monkeypatch.setattr(runner.subprocess, "Popen", lambda *_args, **_kwargs: Process())
    monkeypatch.setattr(runner.os, "name", "posix")
    monkeypatch.setattr(runner.os, "killpg", lambda *_args: None, raising=False)
    monkeypatch.setattr(runner.signal, "SIGKILL", 9, raising=False)
    with pytest.raises(subprocess.CalledProcessError):
        runner.bounded_command(["unused"], stdout=None, stderr=None, env={}, stop=Event(), timeout=10)
