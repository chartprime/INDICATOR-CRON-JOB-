import hashlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import rehearse_historical_core_day as rehearsal


class Transfer:
    def __init__(self, payload, status=0):
        self.stdout = io.BytesIO(payload)
        self.status = status
        self.killed = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.stdout.close()

    def kill(self):
        self.killed = True

    def wait(self):
        return self.status


@pytest.mark.parametrize("payload,status", [(b"short", 0), (b"corrupt", 0), (b"toolong!", 0), (b"correct", 1)])
def test_failed_transfers_never_leave_an_admitted_source(tmp_path, monkeypatch, payload, status):
    monkeypatch.setattr(rehearsal, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(rehearsal.shutil, "disk_usage", lambda _: SimpleNamespace(free=100 * 1024**3))
    child = Transfer(payload, status)
    monkeypatch.setattr(rehearsal.subprocess, "Popen", lambda *_args, **_kwargs: child)
    target = tmp_path / "source.parquet"
    with pytest.raises(ValueError):
        rehearsal.copy_verified("curated/databento/databento/day/part-00000.parquet", target, 7,
                                hashlib.sha256(b"correct").hexdigest())
    assert child.killed
    assert not target.exists()
    assert list(tmp_path.iterdir()) == []


def test_verified_transfer_can_be_reused_but_changed_source_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(rehearsal, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(rehearsal.shutil, "disk_usage", lambda _: SimpleNamespace(free=100 * 1024**3))
    monkeypatch.setattr(rehearsal.subprocess, "Popen", lambda *_args, **_kwargs: Transfer(b"correct"))
    target = tmp_path / "source.parquet"
    pin = hashlib.sha256(b"correct").hexdigest()
    key = "curated/databento/databento/day/part-00000.parquet"
    rehearsal.copy_verified(key, target, 7, pin)
    monkeypatch.setattr(rehearsal.subprocess, "Popen", lambda *_args, **_kwargs: pytest.fail("duplicate download"))
    rehearsal.copy_verified(key, target, 7, pin)
    target.write_bytes(b"changed")
    with pytest.raises(ValueError, match="existing source"):
        rehearsal.copy_verified(key, target, 7, pin)


def test_refused_day_starts_no_download_and_failed_preparation_has_durable_status(tmp_path, monkeypatch):
    monkeypatch.setattr(rehearsal, "DATA_ROOT", tmp_path)
    session = {"instrument": "NQU6", "date": "2026-08-02", "reason": "SINGLE_SNAPSHOT_SOURCE_WITH_TRADES"}
    monkeypatch.setattr(rehearsal, "plan", lambda *_args: {"plan_id": "a" * 64, "sessions": [session]})
    monkeypatch.setattr(rehearsal, "inspect", lambda *_args: pytest.fail("unqualified source fetched"))
    with pytest.raises(ValueError, match="no admitted source"):
        rehearsal.run(tmp_path / "catalog", "a" * 64, "NQU6", "2026-08-02", "node")
    assert not list(tmp_path.iterdir())
    session.update(reason="AWAITING_FULL_DAY_QUALIFICATION", sources={"depth": {"dataset_version": "v1"}})

    def failure(*_args):
        raise ValueError("hash mismatch")

    monkeypatch.setattr(rehearsal, "inspect", failure)
    with pytest.raises(ValueError, match="hash mismatch"):
        rehearsal.run(tmp_path / "catalog", "a" * 64, "NQU6", "2026-08-02", "node")
    status = json.loads((tmp_path / "stage3-nqu6-2026-08-02-status.json").read_text())
    assert status["state"] == "FAILED"
    assert status["stages"] == []
    assert status["error_type"] == "ValueError"
    with pytest.raises(FileExistsError):
        rehearsal.run(tmp_path / "catalog", "a" * 64, "NQU6", "2026-08-02", "node")
