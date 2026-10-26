from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from historical_l2_coverage import require_intraday_source, source_disposition


def partitions(depth_rows=1, trade_rows=12706):
    depth = {"date": "2026-08-02", "instrument_id": "ESU6", "family": "depth",
             "manifest_sha256": "a" * 64, "record_count": depth_rows}
    trade = {**depth, "family": "trade", "manifest_sha256": "b" * 64, "record_count": trade_rows}
    return depth, trade


def test_single_snapshot_with_real_trades_never_becomes_a_trusted_day():
    for count in (12706, 14458):
        depth, trade = partitions(trade_rows=count)
        result = source_disposition(depth, trade, "c" * 64)
        assert result["reason"] == "SINGLE_SNAPSHOT_SOURCE_WITH_TRADES" and result["available"] is False
        with pytest.raises(ValueError, match="SINGLE_SNAPSHOT"):
            require_intraday_source(depth, trade, "c" * 64)


def test_empty_or_single_source_without_trades_is_not_assumed_to_be_a_holiday():
    depth, trade = partitions(trade_rows=0)
    assert source_disposition(depth, trade, "c" * 64)["reason"] == "NO_INTRADAY_SOURCE_PROOF"
    depth["record_count"] = 0
    with pytest.raises(ValueError, match="NO_INTRADAY"):
        require_intraday_source(depth, trade, "c" * 64)
    depth["record_count"] = 200
    result = require_intraday_source(depth, trade, "c" * 64)
    assert result["available"] is False and result["reason"] == "AWAITING_FULL_DAY_QUALIFICATION"


@pytest.mark.parametrize("field,value", [("date", "2026-08-03"), ("instrument_id", "NQU6"),
                                        ("manifest_sha256", "unversioned"), ("record_count", -1)])
def test_mismatched_unpinned_source_refused(field, value):
    depth, trade = deepcopy(partitions())
    trade[field] = value
    with pytest.raises(ValueError):
        source_disposition(depth, trade, "c" * 64)
