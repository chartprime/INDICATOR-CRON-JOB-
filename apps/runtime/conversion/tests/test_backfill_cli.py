"""backfill_cli.py argument handling + a smoke run through run_s3_backfill."""
from __future__ import annotations

import io
import json
from contextlib import redirect_stdout

import backfill_cli
import backfill_driver
from test_backfill_driver import FakeBucket, _S3_CSV_HEADER, _S3_CSV_ROWS, _S3_RAW_KEY


def _roots_args(tmp_path):
    return [
        "--staging-root", str(tmp_path / "staging"),
        "--curated-root", str(tmp_path / "curated"),
        "--catalog-root", str(tmp_path / "curated" / "_catalog"),
    ]


def test_cli_runs_an_s3_backfill_and_prints_the_summary(tmp_path, monkeypatch):
    client = FakeBucket()
    client.put_raw(_S3_RAW_KEY, ("\n".join([_S3_CSV_HEADER, *_S3_CSV_ROWS]) + "\n").encode())
    monkeypatch.setattr(backfill_driver, "_build_s3_client", lambda: client)

    argv = [
        "--dataset", "XNAS.ITCH", "--schema", "ohlcv-1s", "--symbol", "AAPL",
        "--start-date", "2025-09-02", "--end-date", "2025-09-03",
        "--dataset-version", "v1", "--bucket", "bucket", "--curated-prefix", "curated/test",
        *_roots_args(tmp_path),
    ]
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = backfill_cli.main(argv)
    assert code == 0
    payload = json.loads(buf.getvalue())
    assert payload["requested_dates"] == ["2025-09-02", "2025-09-03"]
    assert payload["fully_published"] is True
    assert payload["results"][-1]["fully_published"] is True


def test_cli_expands_an_inclusive_date_range():
    assert backfill_driver.inclusive_date_range("2026-06-16", "2026-06-18") == [
        "2026-06-16", "2026-06-17", "2026-06-18",
    ]


def test_cli_reports_exit_1_when_requested_work_is_not_fully_published(tmp_path, monkeypatch):
    monkeypatch.setattr(backfill_driver, "run_s3_backfill", lambda *args, **kwargs: {
        "results": [{"fully_published": False}], "skipped_dates": [], "fully_published": False,
    })
    argv = [
        "--dataset", "XNAS.ITCH", "--schema", "ohlcv-1s", "--symbol", "AAPL",
        "--start-date", "2025-09-02", "--end-date", "2025-09-03",
        "--dataset-version", "v1", "--bucket", "bucket", "--curated-prefix", "curated/test",
        *_roots_args(tmp_path),
    ]
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = backfill_cli.main(argv)

    assert code == 1
    assert json.loads(buf.getvalue())["fully_published"] is False


def test_cli_reports_an_end_date_before_start_date_as_exit_2(tmp_path, capsys):
    code = backfill_cli.main([
        "--dataset", "XNAS.ITCH", "--schema", "ohlcv-1s", "--symbol", "AAPL",
        "--start-date", "2025-09-03", "--end-date", "2025-09-02",
        "--dataset-version", "v1", "--bucket", "bucket", "--curated-prefix", "curated/test",
        *_roots_args(tmp_path),
    ])
    assert code == 2
