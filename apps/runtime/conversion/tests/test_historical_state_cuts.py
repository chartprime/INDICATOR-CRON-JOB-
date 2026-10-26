from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import check_historical_state_cuts as cuts
from test_historical_l2_lifecycles import native


@pytest.mark.parametrize("instrument", ["ES", "NQ"])
def test_native_second_books_and_price_flow_match_qualified_events(instrument):
    _metadata, events, states = native(instrument)
    report = cuts.reconcile(events, states)
    assert report["level_rows"] == sum(row["payload"].get("row_kind") == "level" for row in states)
    assert report["known_prints"] == sum(row["event_type"] == "engine_trade" for row in events)


def test_book_only_session_keeps_zero_print_count_explicit():
    _metadata, events, states = native("ES")
    events = [row for row in events if row["event_type"] != "engine_trade"]
    for row in states:
        payload = row["payload"]
        if payload.get("row_kind") == "coverage":
            payload["flow"] = dict(BUY=0, SELL=0, UNKNOWN=0, count=0)
        elif payload.get("row_kind") == "level":
            payload.update(buy_volume=0, sell_volume=0)
    assert cuts.reconcile(events, states)["known_prints"] == 0


@pytest.mark.parametrize("fault", ["size", "range", "flow", "missing", "duplicate", "segment", "cursor", "clock", "level_cursor"])
def test_corrupt_second_cannot_pass_even_when_day_flow_totals_agree(fault):
    _metadata, events, states = native("NQ")
    states = deepcopy(states)
    level = next(row for row in states if row["payload"].get("row_kind") == "level")
    coverage = next(row for row in states if row["payload"].get("row_kind") == "coverage" and row["payload"]["trusted"])
    if fault == "size":
        level["payload"]["ask_size"] = 999
    elif fault == "range":
        coverage["payload"]["bid_range"][0] -= 1
    elif fault == "flow":
        level["payload"]["buy_volume"] += 1
    elif fault == "missing":
        states.remove(level)
    elif fault == "duplicate":
        states.insert(states.index(level), deepcopy(level))
    elif fault == "segment":
        coverage["payload"]["segment_id"] = "f" * 64
    elif fault == "cursor":
        coverage["known_key"] = ["0", "2", "0", "0"]
    elif fault == "clock":
        coverage["known_ns"] = "0"
    else:
        level["known_key"] = ["0", "2", "0", "0"]
    with pytest.raises(ValueError, match="state|second"):
        cuts.reconcile(events, states)
