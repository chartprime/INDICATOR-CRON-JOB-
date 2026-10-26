from __future__ import annotations

import io
import json
from contextlib import redirect_stderr, redirect_stdout

import pytest

import backfill_sequence_cli
import backfill_sequence as seq


@pytest.fixture(autouse=True)
def _tiny_global_reserve(monkeypatch):
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", "1")


def _roots_args(tmp_path):
    return [
        "--staging-root", str(tmp_path / "staging"),
        "--curated-root", str(tmp_path / "curated"),
        "--catalog-root", str(tmp_path / "curated" / "_catalog"),
    ]


# systemd cannot tell a transient fault from a permanent one, and a rate limit
# cannot bound retries when an attempt runs for hours, so the exit status is
# what decides whether the unit is allowed to come back.
@pytest.mark.parametrize("outcome,expected", [
    ({"status": "failed", "error": "boom", "retryable": False}, backfill_sequence_cli.EXIT_PERMANENT),
    ({"status": "failed", "error": "boom", "retryable": True}, backfill_sequence_cli.EXIT_RETRYABLE),
    ({"status": "partial", "months": [], "partial_months": [{"version": "v1-x"}]}, backfill_sequence_cli.EXIT_PARTIAL),
    ({"status": "ok", "outcome": {}}, backfill_sequence_cli.EXIT_OK),
])
def test_cli_exit_status_tells_systemd_whether_a_restart_is_allowed(tmp_path, monkeypatch, outcome, expected):
    monkeypatch.setattr(seq, "run_phase", lambda phase, dataset_version, **kw: [
        {"dataset": "GLBX.MDP3", "schema": "ohlcv-1s", "symbol": "ES", **outcome},
        {"dataset": "XNAS.ITCH", "schema": "ohlcv-1s", "symbol": "AAPL", "status": "ok", "outcome": {}},
    ])
    argv = [
        "--phase", "ohlcv", "--dataset-version", "v1", "--bucket", "bucket", "--curated-prefix", "curated/test",
        *_roots_args(tmp_path),
    ]
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = backfill_sequence_cli.main(argv)
    assert code == expected
    assert json.loads(buf.getvalue())["exit_code"] == expected


def test_cli_reports_exit_1_when_any_symbol_in_the_phase_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(seq, "run_phase", lambda phase, dataset_version, **kw: [
        {"dataset": "GLBX.MDP3", "schema": "ohlcv-1s", "symbol": "ES", "status": "failed", "error": "boom",
         "retryable": True},
        {"dataset": "XNAS.ITCH", "schema": "ohlcv-1s", "symbol": "AAPL", "status": "ok", "outcome": {}},
    ])
    argv = [
        "--phase", "ohlcv", "--dataset-version", "v1", "--bucket", "bucket", "--curated-prefix", "curated/test",
        *_roots_args(tmp_path),
    ]
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = backfill_sequence_cli.main(argv)
    assert code == 1
    payload = json.loads(buf.getvalue())
    assert payload["phase"] == "ohlcv"
    assert len(payload["outcomes"]) == 2


def test_cli_reports_exit_0_when_every_symbol_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr(seq, "run_phase", lambda phase, dataset_version, **kw: [
        {"dataset": "XNAS.ITCH", "schema": "ohlcv-1s", "symbol": "AAPL", "status": "ok", "outcome": {}},
    ])
    argv = [
        "--phase", "ohlcv", "--dataset-version", "v1", "--bucket", "bucket", "--curated-prefix", "curated/test",
        *_roots_args(tmp_path),
    ]
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = backfill_sequence_cli.main(argv)
    assert code == 0


def test_cli_defaults_to_pool_size_one_and_forwards_an_explicit_override(tmp_path, monkeypatch):
    seen = {}
    def fake_run_phase(phase, dataset_version, **kw):
        seen.update(kw)
        return [{"dataset": "XNAS.ITCH", "schema": "ohlcv-1s", "symbol": "AAPL", "status": "ok", "outcome": {}}]
    monkeypatch.setattr(seq, "run_phase", fake_run_phase)

    argv = [
        "--phase", "ohlcv", "--dataset-version", "v1", "--bucket", "bucket", "--curated-prefix", "curated/test",
        *_roots_args(tmp_path),
    ]
    backfill_sequence_cli.main(argv)
    assert seen["pool_size"] == 1

    backfill_sequence_cli.main([*argv, "--pool-size", "4"])
    assert seen["pool_size"] == 4

    backfill_sequence_cli.main([*argv, "--retry-quarantined"])
    assert seen["retry_quarantined"] is True


def test_cli_uses_the_registered_l1_recovery_version_when_no_override_is_given(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(seq, "run_phase", lambda phase, dataset_version, **kw: seen.update(
        phase=phase, dataset_version=dataset_version) or [])

    assert backfill_sequence_cli.main([
        "--phase", "l1", "--bucket", "bucket", "--curated-prefix", "curated/test", *_roots_args(tmp_path),
    ]) == 0
    assert seen == {"phase": "l1", "dataset_version": "w606-l1-v2"}


def test_cli_failure_records_the_resolved_dataset_version(tmp_path, monkeypatch):
    def fail(*_args, **_kwargs):
        raise seq.SequenceError("expected")
    monkeypatch.setattr(seq, "run_phase", fail)
    err = io.StringIO()

    with redirect_stderr(err):
        assert backfill_sequence_cli.main([
            "--phase", "l1", "--bucket", "bucket", "--curated-prefix", "curated/test", *_roots_args(tmp_path),
        ]) == 2

    assert json.loads(err.getvalue().splitlines()[-1]) == {
        "phase": "l1", "dataset_version": "w606-l1-v2", "error": "SequenceError: expected",
        "retryable": False,
    }


def test_cli_rejects_an_unknown_phase_at_the_argument_level(tmp_path):
    with pytest.raises(SystemExit):
        backfill_sequence_cli.main([
            "--phase", "bogus", "--dataset-version", "v1", "--bucket", "bucket", "--curated-prefix", "curated/test",
            *_roots_args(tmp_path),
        ])
