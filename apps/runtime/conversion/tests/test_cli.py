"""cli.py argument handling + a smoke run through convert_file."""
from __future__ import annotations

import io
import json
import os
from contextlib import redirect_stdout

import cli

HERE = os.path.dirname(os.path.abspath(__file__))
MBP1 = os.path.normpath(os.path.join(HERE, "..", "..", "test", "contracts", "fixtures", "market-observation-v1", "databento-mbp1.dbn"))


def test_cli_runs_a_conversion_and_prints_the_summary(tmp_path):
    argv = [
        "--source", MBP1, "--schema", "mbp-1", "--dataset-version", "20260910T000000Z",
        "--staging-root", str(tmp_path / "staging"),
        "--curated-root", str(tmp_path / "curated"),
        "--catalog-root", str(tmp_path / "curated" / "_catalog"),
    ]
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = cli.main(argv)
    assert code == 0
    summary = json.loads(buf.getvalue())
    assert summary["accepted"] == 2
    assert summary["catalog_pointer"]["publisher_fence"] == 1


def test_cli_reports_a_conversion_error_as_exit_2(tmp_path, capsys):
    cut = tmp_path / "cut.mbp-1.dbn"
    cut.write_bytes(open(MBP1, "rb").read()[:40])  # header only, no complete rows
    code = cli.main([
        "--source", str(cut), "--schema", "mbp-1", "--dataset-version", "v1",
        "--staging-root", str(tmp_path / "s"), "--curated-root", str(tmp_path / "c"),
        "--catalog-root", str(tmp_path / "c" / "_catalog"),
    ])
    assert code != 0
