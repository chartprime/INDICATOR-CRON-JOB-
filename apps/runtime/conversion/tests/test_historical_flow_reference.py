from __future__ import annotations

import importlib
from pathlib import Path
import sys

import duckdb
import pytest


sys.path.insert(0, str(Path(__file__).parents[2] / "scripts" / "verify" / "databento"))
reference = importlib.import_module("verify_historical_equity_flow").reference_samples


def sample(ts, segment, first, last, buy, sell, count):
    return {"ts": ts, "segment": segment, "fromKey": list(map(str, first)), "throughKey": list(map(str, last)),
            "buyVolume": buy, "sellVolume": sell, "tradeCount": count}


def test_reference_handles_exact_ties_expiry_unknown_and_segment_reset():
    with duckdb.connect() as connection:
        connection.execute("CREATE TABLE anchors(event_ns BIGINT, source_rank BIGINT, stable_position BIGINT, "
                           "ordinal BIGINT, side VARCHAR, size DECIMAL(38,12))")
        connection.executemany("INSERT INTO anchors VALUES (?,2,?,0,?,?)", [
            (0, 0, "BUY", 7), (0, 1, "BUY", 2), (0, 2, "SELL", 3), (0, 3, "BUY", 11),
            (1_000_000, 4, "UNKNOWN", 5), (60_000_000_000, 5, "SELL", 13),
            (60_001_000_000, 6, "BUY", 17),
        ])
        first = (0, 2, 1, 0)
        samples = [sample(0, 1, first, (0, 2, 2, 0), 2, 3, 2),
                   sample(60_000, 1, first, (60_000_000_000, 2, 5, 0), 0, 13, 1),
                   sample(60_001, 2, (60_001_000_000, 2, 6, 0), (60_001_000_000, 2, 6, 0), 17, 0, 1)]
        result = {"samples": samples, "observed": {"BUY": {"count": 4}, "SELL": {"count": 2}},
                  "outsideTrust": {"BUY": {"count": 1, "volume": 7}, "SELL": {"count": 0, "volume": 0},
                                   "UNKNOWN": {"count": 0, "volume": 0}}, "applied": 5}
        assert reference(connection, result) == 3
        result["samples"][0]["buyVolume"] = 13
        with pytest.raises(ValueError, match="sample 0"):
            reference(connection, result)


def test_reference_sorts_large_anchor_set_under_bounded_memory(tmp_path):
    with duckdb.connect(config={"threads": "1", "memory_limit": "64MB", "temp_directory": str(tmp_path),
                                "preserve_insertion_order": "false", "max_temp_directory_size": "256MB"}) as connection:
        connection.execute("CREATE TABLE anchors AS SELECT i*1000::BIGINT AS event_ns, 2::BIGINT AS source_rank, "
                           "i::BIGINT AS stable_position, 0::BIGINT AS ordinal, 'BUY' AS side, "
                           "1::DECIMAL(38,12) AS size FROM range(300000) r(i) ORDER BY i DESC")
        result = {"samples": [sample(300, 1, (0, 2, 0, 0), (299999000, 2, 299999, 0), 300000, 0, 300000)],
                  "observed": {"BUY": {"count": 300000}, "SELL": {"count": 0}}, "applied": 300000,
                  "outsideTrust": {side: {"count": 0, "volume": 0} for side in ("BUY", "SELL", "UNKNOWN")}}
        assert reference(connection, result) == 1
