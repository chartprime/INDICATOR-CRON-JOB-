"""The archive's hourly/daily rollup against the shared golden file.

Property: the Python rollup gives the answers pinned in
benchmarks/fixtures/golden/candle-rollup.json, which the browser resampler is
held to as well (apps/web/src/lib/chart/tests/resampleBarsGolden.test.ts).
Oracle: the hand-derived expectations in that file, not either implementation.
Where the two implementations differ the file pins both answers and the reason,
so a difference cannot appear or vanish unnoticed.
"""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

import candle_rollup as rollup

GOLDEN = json.loads((Path(__file__).resolve().parents[4] / "benchmarks" / "fixtures" / "golden" / "candle-rollup.json").read_text(encoding="utf-8"))
BASE_MS = GOLDEN["baseMs"]
MS_NS = 1_000_000
MINUTE_MS = 60_000
FIXED9 = Decimal(10) ** 9


def _minute_rows(runs):
    rows = []
    for run in runs:
        for index in range(run.get("count", 1)):
            open_ms = BASE_MS + int((run["atMinute"] + index) * MINUTE_MS)
            rows.append({
                "open_ns": open_ms * MS_NS,
                "close_ns": (open_ms + MINUTE_MS) * MS_NS,
                "open": Decimal(run["open"]), "high": Decimal(run["high"]),
                "low": Decimal(run["low"]), "close": Decimal(run["close"]),
                "volume": Decimal(run["volume"]),
                "source_symbol": run.get("symbol", "38"),
            })
    return rows


def _as_bars(rows):
    return [{
        "openMinute": (int(row["ts_event"]) // MS_NS - BASE_MS) // MINUTE_MS,
        "open": Decimal(row["open"]) / FIXED9, "high": Decimal(row["high"]) / FIXED9,
        "low": Decimal(row["low"]) / FIXED9, "close": Decimal(row["close"]) / FIXED9,
        "volume": Decimal(row["volume"]),
    } for row in rows]


def _expected(bars):
    return [{
        "openMinute": bar["openMinute"], "open": Decimal(bar["open"]), "high": Decimal(bar["high"]),
        "low": Decimal(bar["low"]), "close": Decimal(bar["close"]), "volume": Decimal(bar["volume"]),
    } for bar in bars]


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=[case["name"] for case in GOLDEN["cases"]])
def test_python_rollup_gives_the_golden_answer(case):
    rows = _minute_rows(case["minutes"])
    rollup_fn = rollup.hour_rows if case["target"] == "hour" else rollup.day_rows
    expected = case["python"]
    if isinstance(expected, dict):
        with pytest.raises(rollup.RollupError, match=expected["error"]):
            rollup_fn(rows)
        return
    assert _as_bars(rollup_fn(rows)) == _expected(expected)


def test_the_golden_file_exercises_every_kind_of_outcome():
    outcomes = {case["outcome"] for case in GOLDEN["cases"]}
    assert outcomes == {"agree", "differ", "both-refuse"}
    assert {case["target"] for case in GOLDEN["cases"]} == {"hour", "day"}
    assert any(isinstance(case["python"], dict) and case["outcome"] == "differ" for case in GOLDEN["cases"])
    assert any(not isinstance(case["python"], dict) and case["js"] == [] for case in GOLDEN["cases"])
