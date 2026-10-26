from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import check_historical_core_day as check
from test_derive_historical_cme_core import config, expected, node, rows


def groups(directory):
    _setup, _result, manifests = check.load_output(directory)
    with check.core.lifecycle.duckdb.connect(config={"threads": "1", "memory_limit": "128MB"}) as connection:
        return list(check.stored_groups(connection, directory / "events", manifests["events"]))


def test_whole_source_walk_checks_size_history_prints_and_engine_counters(tmp_path):
    output = tmp_path / "day"
    setup = config()
    setup["derivationId"] = check.hashlib.sha256(check.json.dumps(setup["identity"], separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    check.core.encode(iter(rows()), setup, output, node(), expected_summary=expected())
    result = check.check(output, iter(rows()))
    assert result["counts"]["source_rows"] == 5
    assert result["counts"]["engine_trade"] == 1
    assert result["counts"]["level_size"] == 8
    assert result["checker_sha256"] == check.core.lifecycle.digest(Path(check.__file__))
    stored = groups(output)
    for fault in ("drop", "size", "trade", "accounting", "cursor"):
        changed = deepcopy(stored)
        if fault == "drop":
            changed.pop(0)
        elif fault == "cursor":
            changed[0] = ((0, 2, 0, 0), changed[0][1])
        else:
            target = {"size": "level_size", "trade": "engine_trade", "accounting": "engine_level_state"}[fault]
            payload = next(value[3] for _key, group in changed for value in group if value[0] == target)
            if fault == "accounting":
                payload["state"]["cancelled"] += 1
            else:
                payload["size"] += 1
        with pytest.raises(ValueError):
            check.reconcile(iter(rows()), changed, "0.25", 5)


def test_checker_code_change_during_source_walk_cannot_seal_receipt(tmp_path, monkeypatch):
    output = tmp_path / "changing-checker"
    setup = config()
    setup["derivationId"] = check.hashlib.sha256(check.json.dumps(setup["identity"], separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    check.core.encode(iter(rows()), setup, output, node(), expected_summary=expected())
    changed = {"value": False}
    original = check.core.lifecycle.digest
    method = Path(check.__file__).resolve()
    def digest(path, *args):
        if Path(path).resolve() == method and changed["value"]:
            return "f" * 64
        return original(path, *args)
    def source():
        for row in rows():
            changed["value"] = True
            yield row
    monkeypatch.setattr(check.core.lifecycle, "digest", digest)
    with pytest.raises(ValueError, match="checker changed"):
        check.check(output, source())
    assert not (output / "independent-check.json").exists()


def test_independent_reference_resolves_two_trades_and_later_reduction_without_hidden_volume():
    source = rows()[0]
    source["asks"][0]["size"] = "10"
    reference = check.Reference("0.25")
    reference.step(source)
    for index, amount in ((1, "2"), (2, "3")):
        echo = deepcopy(source)
        echo.update(stable_position=str(index), observation_only=True,
                    matched_trade={"side": "BUY", "price": "101", "size": amount})
        reference.step(echo)
    reduced = deepcopy(source)
    reduced["stable_position"] = "3"
    reduced["asks"][0]["size"] = "5"
    reference.step(reduced)
    value = reference.records[("ask", 404)]
    assert value["traded"] == value["tradedVisible"] == 5
    assert value["cancelled"] == 0
    assert value["absorbed"] - value["absorbedVisible"] == 0


def test_ending_waits_for_grace_or_refill_and_unknown_prints_do_not_explain_it():
    reference = check.Reference("0.25")
    source = rows()[0]
    reference.step(source)
    empty = deepcopy(source)
    empty.update(event_ns="1200000000", stable_position="1")
    empty["asks"] = [{"price": "101.25", "size": "7"}]
    assert reference.step(empty)[2] == []
    unknown = deepcopy(empty)
    unknown.update(event_ns="2000000000", stable_position="2", observation_only=True,
                   matched_trade={"side": "UNKNOWN", "price": "101", "size": "20"})
    assert reference.step(unknown)[2] == []
    refill = deepcopy(source)
    refill.update(event_ns="2100000000", stable_position="3")
    assert reference.step(refill)[2] == [("ask", 404, "pulled", 5, 0)]


def test_a_cached_empty_level_returning_from_beyond_depth_cannot_inherit_its_old_ending():
    reference = check.Reference("0.25")
    source = rows()[0]
    source["bids"] = [{"price": str(100 - i / 4), "size": "2"} for i in range(10)]
    reference.step(source)
    reference.records[("bid", 389)] = check.record(empty_at=1000)
    reference.records[("bid", 389)].update(cancelled=9, ending=9, explained=0)
    returned = deepcopy(source)
    returned["bids"] = [{"price": str(99.5 - i / 4), "size": "2"} for i in range(10)]
    result = reference.step(returned)
    assert ("bid", 389) in result[1]
    assert reference.records[("bid", 389)]["cancelled"] == 0
    assert reference.records[("bid", 389)]["ending"] is None
