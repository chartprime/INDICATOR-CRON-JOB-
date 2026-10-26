"""Futures roll table build + validation (design lock 19 section 0.4a)."""
from __future__ import annotations

import pytest

import roll_table as rt

_INTERVALS = [
    {"start_date": "2025-09-01", "end_date": "2025-09-15", "symbol": "1001"},
    {"start_date": "2025-09-15", "end_date": "2025-10-01", "symbol": "1002"},
]


def _def(raw_symbol, tick_size="0.25", multiplier="50", expiration_ns=None):
    return {"raw_symbol": raw_symbol, "tick_size": tick_size, "multiplier": multiplier, "expiration_ns": expiration_ns}


def _day_ns(date_str):
    import datetime as dt
    return (dt.date.fromisoformat(date_str) - dt.date(1970, 1, 1)).days * 86_400 * 1_000_000_000


def _definition_snapshots(intervals, defs_by_instrument):
    by_instrument = {}
    for interval in intervals:
        by_instrument.setdefault(interval["symbol"], []).append((interval["start_date"], defs_by_instrument[interval["symbol"]]))
    return {symbol: sorted(snaps) for symbol, snaps in by_instrument.items()}


def _def_row(instrument_id, ts_recv, raw_symbol, min_price_increment="250000000", unit_of_measure_qty="50000000000", expiration=None):
    return {"instrument_id": instrument_id, "ts_recv": ts_recv, "raw_symbol": raw_symbol,
            "min_price_increment": min_price_increment, "unit_of_measure_qty": unit_of_measure_qty, "expiration": expiration}


def test_definition_snapshots_from_rows_groups_by_instrument_and_converts_fixed9_tick_size_and_multiplier():
    rows = [
        _def_row("1001", str(_day_ns("2025-09-01") + 1), "ESU5", expiration=str(_day_ns("2025-09-19"))),
        _def_row("1001", str(_day_ns("2025-09-02") + 1), "ESU5", expiration=str(_day_ns("2025-09-19"))),
    ]
    snapshots = rt.definition_snapshots_from_rows(rows)
    assert [date for date, _ in snapshots["1001"]] == ["2025-09-01", "2025-09-02"]
    assert snapshots["1001"][0][1] == {
        "raw_symbol": "ESU5", "tick_size": "0.250000000", "multiplier": "50.000000000",
        "expiration_ns": _day_ns("2025-09-19"),
    }


def test_definition_snapshots_from_rows_refuses_conflicting_same_day_facts():
    rows = [
        _def_row("1001", str(_day_ns("2025-09-01") + 1), "ESU5", min_price_increment="250000000"),
        _def_row("1001", str(_day_ns("2025-09-01") + 2), "ESU5", min_price_increment="500000000"),
    ]
    for ordered in (rows, list(reversed(rows))):
        with pytest.raises(rt.RollTableError, match="CONFLICTING_DAILY_DEFINITION"):
            rt.definition_snapshots_from_rows(ordered)


def test_definition_snapshots_from_rows_refuses_a_missing_unit_of_measure_qty():
    rows = [_def_row("1001", str(_day_ns("2025-09-01") + 1), "ESU5", unit_of_measure_qty=None)]
    with pytest.raises(rt.RollTableError, match="MISSING_UNIT_OF_MEASURE_QTY"):
        rt.definition_snapshots_from_rows(rows)


def test_definition_snapshots_from_rows_handles_no_expiration_set():
    rows = [_def_row("1001", str(_day_ns("2025-09-01") + 1), "ESU5", expiration=None)]
    snapshots = rt.definition_snapshots_from_rows(rows)
    assert snapshots["1001"][0][1]["expiration_ns"] is None


def test_a_clean_two_contract_roll_builds_and_validates_with_no_warnings():
    defs = {
        "1001": _def("ESU5", expiration_ns=_day_ns("2025-09-17")),  # within 3 days of the 09-15 roll boundary
        "1002": _def("ESZ5", expiration_ns=_day_ns("2025-10-03")),  # within 3 days of the 10-01 roll boundary
    }
    days = _definition_snapshots(_INTERVALS, defs)
    rows = rt.build("ES.n.0", _INTERVALS, days, "v1")
    assert [r["contract_code"] for r in rows] == ["ESU5", "ESZ5"]
    assert rows[0]["from_ns"] == _day_ns("2025-09-01") and rows[0]["to_ns"] == _day_ns("2025-09-15")
    warnings = rt.validate("ES.n.0", rows)
    assert warnings == []


def test_a_single_sparse_snapshot_carries_forward_across_the_whole_interval():
    # The real shape Databento actually delivers: one definition snapshot
    # roughly monthly, not one per day. A snapshot taken near a month's start
    # must cover every day up to the next snapshot -- a contract's tick size
    # and multiplier don't change day to day, they're just periodically
    # reconfirmed.
    interval = [{"start_date": "2026-06-01", "end_date": "2026-07-01", "symbol": "1001"}]
    snapshots = {"1001": [("2026-06-01", _def("NQM6"))]}
    rows = rt.build("NQ.n.0", interval, snapshots, "v1")
    assert rows[0]["contract_code"] == "NQM6"
    assert rows[0]["from_ns"] == _day_ns("2026-06-01") and rows[0]["to_ns"] == _day_ns("2026-07-01")


def test_a_later_snapshot_never_applies_retroactively_to_earlier_dates():
    interval = [{"start_date": "2026-06-01", "end_date": "2026-06-10", "symbol": "1001"}]
    snapshots = {"1001": [("2026-05-01", _def("NQM6")), ("2026-06-05", _def("NQM6", tick_size="0.50"))]}
    with pytest.raises(rt.RollTableError, match="INCONSISTENT_DEFINITION.*2026-06-05"):
        rt.build("NQ.n.0", interval, snapshots, "v1")


def test_a_date_before_the_earliest_known_snapshot_fails_loudly_not_silently():
    interval = [{"start_date": "2025-09-01", "end_date": "2025-09-15", "symbol": "1001"}]
    snapshots = {"1001": [("2025-09-05", _def("ESU5"))]}  # first known snapshot is mid-interval
    with pytest.raises(rt.RollTableError, match="DEFINITION_GAP.*2025-09-01"):
        rt.build("ES.n.0", interval, snapshots, "v1")


def test_no_snapshot_ever_observed_for_the_instrument_fails_loudly():
    with pytest.raises(rt.RollTableError, match="DEFINITION_GAP"):
        rt.build("ES.n.0", _INTERVALS, {}, "v1")


def test_inconsistent_definition_facts_within_one_interval_fails_loudly():
    interval = [{"start_date": "2025-09-01", "end_date": "2025-09-15", "symbol": "1001"}]
    snapshots = {"1001": [("2025-09-01", _def("ESU5")), ("2025-09-10", _def("ESU5", tick_size="0.50"))]}
    with pytest.raises(rt.RollTableError, match="INCONSISTENT_DEFINITION"):
        rt.build("ES.n.0", interval, snapshots, "v1")


def test_empty_continuous_intervals_list_is_refused():
    with pytest.raises(rt.RollTableError, match="NO_CONTINUOUS_INTERVALS"):
        rt.build("ES.n.0", [], {}, "v1")


def test_a_zero_length_continuous_interval_is_refused():
    bad = [{"start_date": "2025-09-01", "end_date": "2025-09-01", "symbol": "1001"}]
    with pytest.raises(rt.RollTableError, match="EMPTY_CONTINUOUS_INTERVAL"):
        rt.build("ES.n.0", bad, {}, "v1")


def test_validate_rejects_a_contract_code_that_does_not_match_the_expected_pattern():
    defs = {"1001": _def("BOGUS")}
    interval = [{"start_date": "2025-09-01", "end_date": "2025-09-02", "symbol": "1001"}]
    rows = rt.build("ES.n.0", interval, _definition_snapshots(interval, defs), "v1")
    with pytest.raises(rt.RollTableError, match="INVALID_CONTRACT_CODE"):
        rt.validate("ES.n.0", rows)


def test_validate_rejects_non_positive_tick_size_or_multiplier():
    for bad_field, bad_value in (("tick_size", "0"), ("multiplier", "-1")):
        defs = {"1001": _def("ESU5", **{bad_field: bad_value})}
        interval = [{"start_date": "2025-09-01", "end_date": "2025-09-02", "symbol": "1001"}]
        rows = rt.build("ES.n.0", interval, _definition_snapshots(interval, defs), "v1")
        with pytest.raises(rt.RollTableError, match="NON_POSITIVE"):
            rt.validate("ES.n.0", rows)


def test_validate_rejects_a_non_contiguous_roll_table():
    defs = {"1001": _def("ESU5"), "1002": _def("ESZ5")}
    gappy = [
        {"start_date": "2025-09-01", "end_date": "2025-09-10", "symbol": "1001"},
        {"start_date": "2025-09-15", "end_date": "2025-10-01", "symbol": "1002"},  # gap between 09-10 and 09-15
    ]
    rows = rt.build("ES.n.0", gappy, _definition_snapshots(gappy, defs), "v1")
    with pytest.raises(rt.RollTableError, match="NON_CONTIGUOUS_ROLL_TABLE"):
        rt.validate("ES.n.0", rows)


def test_merge_bridges_a_gap_when_the_same_contract_is_on_both_sides():
    # Daily sources contribute one mapping per file, so every Saturday leaves a
    # hole. Measured on the real August 2026 mbp-10 archive: ES and NQ each lose
    # 08-08, 08-15, 08-22 and 08-29, with an identical contract either side.
    weekend = [
        {"start_date": "2026-08-07", "end_date": "2026-08-08", "symbol": "42140870"},
        {"start_date": "2026-08-09", "end_date": "2026-08-10", "symbol": "42140870"},
    ]

    merged, warnings = rt.merge_intervals("ES.n.0", weekend)

    assert merged == [{"start_date": "2026-08-07", "end_date": "2026-08-10", "symbol": "42140870"}]
    assert warnings == ["BRIDGED_ABSENT_DATES:ES.n.0:42140870:2026-08-08..2026-08-09"]


def test_a_bridged_table_is_contiguous_where_the_unbridged_one_was_not():
    defs = {"42140870": _def("ESU6")}
    weekend = [
        {"start_date": "2026-08-07", "end_date": "2026-08-08", "symbol": "42140870"},
        {"start_date": "2026-08-09", "end_date": "2026-08-10", "symbol": "42140870"},
    ]

    unbridged = rt.build("ES.n.0", weekend, _definition_snapshots(weekend, defs), "v1")
    with pytest.raises(rt.RollTableError, match="NON_CONTIGUOUS_ROLL_TABLE"):
        rt.validate("ES.n.0", unbridged)

    merged, _ = rt.merge_intervals("ES.n.0", weekend)
    rows = rt.build("ES.n.0", merged, _definition_snapshots(weekend, defs), "v1")

    assert rt.validate("ES.n.0", rows) == []


def test_merge_never_bridges_across_two_different_contracts():
    # A hole between two different contracts is a roll nobody recorded. Bridging
    # it would invent which contract the alias pointed at on the missing dates,
    # which is exactly what the contiguity guard exists to refuse.
    defs = {"1001": _def("ESU5"), "1002": _def("ESZ5")}
    gappy = [
        {"start_date": "2025-09-01", "end_date": "2025-09-10", "symbol": "1001"},
        {"start_date": "2025-09-15", "end_date": "2025-10-01", "symbol": "1002"},
    ]

    merged, warnings = rt.merge_intervals("ES.n.0", gappy)

    assert merged == gappy
    assert warnings == []
    rows = rt.build("ES.n.0", merged, _definition_snapshots(gappy, defs), "v1")
    with pytest.raises(rt.RollTableError, match="NON_CONTIGUOUS_ROLL_TABLE"):
        rt.validate("ES.n.0", rows)


def test_merge_still_folds_overlapping_intervals_of_one_contract():
    overlapping = [
        {"start_date": "2025-09-01", "end_date": "2025-09-10", "symbol": "1001"},
        {"start_date": "2025-09-05", "end_date": "2025-09-20", "symbol": "1001"},
    ]

    merged, warnings = rt.merge_intervals("ES.n.0", overlapping)

    assert merged == [{"start_date": "2025-09-01", "end_date": "2025-09-20", "symbol": "1001"}]
    assert warnings == [], "an overlap is not an absence and must not be reported as one"


def test_a_contract_that_reappears_around_another_is_not_bridged_over_it():
    # Sorting puts the intervening contract between the two, so the same-symbol
    # run is broken and nothing bridges across it.
    intervals = [
        {"start_date": "2025-09-01", "end_date": "2025-09-10", "symbol": "1001"},
        {"start_date": "2025-09-10", "end_date": "2025-09-15", "symbol": "1002"},
        {"start_date": "2025-09-15", "end_date": "2025-09-20", "symbol": "1001"},
    ]

    merged, warnings = rt.merge_intervals("ES.n.0", intervals)

    assert [i["symbol"] for i in merged] == ["1001", "1002", "1001"]
    assert warnings == []


def test_validate_warns_but_does_not_fail_when_a_real_roll_is_far_from_expiration():
    defs = {"1001": _def("ESU5", expiration_ns=_day_ns("2025-01-01")),  # nowhere near the Sep-15 roll
            "1002": _def("ESZ5", expiration_ns=_day_ns("2025-12-19"))}
    intervals = [
        {"start_date": "2025-09-01", "end_date": "2025-09-15", "symbol": "1001"},
        {"start_date": "2025-09-15", "end_date": "2025-10-01", "symbol": "1002"},
    ]
    rows = rt.build("ES.n.0", intervals, _definition_snapshots(intervals, defs), "v1")
    warnings = rt.validate("ES.n.0", rows)
    assert len(warnings) == 1 and "ESU5" in warnings[0] and "ROLL_BOUNDARY_FAR_FROM_EXPIRATION" in warnings[0]


def test_the_final_interval_ends_at_the_source_window_so_it_is_not_a_roll_to_warn_about():
    # Every monthly raw file's last mapping interval stops at the file's own
    # horizon, not at a contract roll. Comparing that endpoint with expiration
    # made the warning fire on all 24 ES/NQ symbol-months, which is noise.
    defs = {"1002": _def("ESZ5", expiration_ns=_day_ns("2025-12-19"))}
    interval = [{"start_date": "2025-09-01", "end_date": "2025-10-01", "symbol": "1002"}]
    rows = rt.build("ES.n.0", interval, _definition_snapshots(interval, defs), "v1")
    assert rt.validate("ES.n.0", rows) == []


def test_version_is_stable_for_the_same_inputs_and_changes_when_inputs_change():
    a = rt.version(["sha:x"], ["sha:y"])
    b = rt.version(["sha:x"], ["sha:y"])
    c = rt.version(["sha:different"], ["sha:y"])
    assert a == b
    assert a != c


def test_to_mappings_matches_the_shape_identity_js_createIdentityResolver_actually_accepts():
    import json
    import os
    import shutil
    import subprocess

    defs = {"1001": _def("ESU5", expiration_ns=_day_ns("2025-09-19"))}
    interval = [{"start_date": "2025-09-01", "end_date": "2025-09-15", "symbol": "1001"}]
    rows = rt.build("ES.n.0", interval, _definition_snapshots(interval, defs), "v1")
    mappings = rt.to_mappings(rows, "GLBX.MDP3", "sha256:test")
    assert mappings[0]["instrument"]["contract"] == mappings[0]["instrument"]["symbol"] == "ESU5"

    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    here = os.path.dirname(os.path.abspath(__file__))
    identity_js = os.path.normpath(os.path.join(here, "..", "..", "src", "data-contracts", "v1", "identity.js"))
    script = (
        f"const {{ createIdentityResolver }} = require({json.dumps(identity_js)});"
        f"const resolver = createIdentityResolver({json.dumps(mappings)});"
        f"const m = resolver({{ provider: 'DATABENTO', dataset: 'GLBX.MDP3', sourceSymbol: '1001', eventNs: '{rt._day_ns('2025-09-05')}' }});"
        "console.log(JSON.stringify(m.instrument));"
    )
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    resolved = json.loads(out.stdout)
    assert resolved["symbol"] == "ESU5" and resolved["contract"] == "ESU5" and resolved["market"] == "FUTURE"


def test_to_mappings_widens_each_interval_by_the_identity_resolution_tolerance():
    interval = [{"start_date": "2025-09-01", "end_date": "2025-09-15", "symbol": "1001"}]
    defs = {"1001": _def("ESU5")}
    rows = rt.build("ES.n.0", interval, _definition_snapshots(interval, defs), "v1")
    mappings = rt.to_mappings(rows, "GLBX.MDP3", "sha256:test")
    assert int(mappings[0]["fromNs"]) == _day_ns("2025-09-01") - rt.IDENTITY_RESOLUTION_TOLERANCE_NS
    assert int(mappings[0]["toNs"]) == _day_ns("2025-09-15") + rt.IDENTITY_RESOLUTION_TOLERANCE_NS

    epoch_start_interval = [{"start_date": "1970-01-01", "end_date": "1970-01-02", "symbol": "9"}]
    defs2 = {"9": _def("ESZ9")}
    rows2 = rt.build("ES.n.0", epoch_start_interval, _definition_snapshots(epoch_start_interval, defs2), "v1")
    mappings2 = rt.to_mappings(rows2, "GLBX.MDP3", "sha256:test")
    assert mappings2[0]["fromNs"] == "0"


def _nq_june_2026_roll_fixture():
    old_symbol, new_symbol = "42004058", "42004177"
    intervals = [
        {"start_date": "2026-06-01", "end_date": "2026-06-17", "symbol": old_symbol},
        {"start_date": "2026-06-17", "end_date": "2026-07-01", "symbol": new_symbol},
    ]
    defs = {old_symbol: _def("NQM6"), new_symbol: _def("NQU6")}
    rows = rt.build("NQ.n.0", intervals, _definition_snapshots(intervals, defs), "v1")
    boundary_ns = _day_ns("2026-06-17")
    real_event_ns_just_before_boundary = str(boundary_ns - 46_167_509)
    return old_symbol, new_symbol, rows, boundary_ns, real_event_ns_just_before_boundary


def _resolve_via_real_identity_js(mappings, source_symbol, event_ns):
    import json
    import os
    import subprocess

    here = os.path.dirname(os.path.abspath(__file__))
    identity_js = os.path.normpath(os.path.join(here, "..", "..", "src", "data-contracts", "v1", "identity.js"))
    script = (
        f"const {{ createIdentityResolver }} = require({json.dumps(identity_js)});"
        f"const resolver = createIdentityResolver({json.dumps(mappings)});"
        f"try {{ const m = resolver({{ provider: 'DATABENTO', dataset: 'GLBX.MDP3', "
        f"sourceSymbol: {json.dumps(source_symbol)}, eventNs: {json.dumps(event_ns)} }}); "
        f"console.log(JSON.stringify({{ ok: true, symbol: m.instrument.symbol }})); }} "
        f"catch (error) {{ console.log(JSON.stringify({{ ok: false, code: error.code }})); }}"
    )
    out = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_a_real_row_46ms_before_its_documented_roll_boundary_now_resolves():
    import shutil

    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    old_symbol, new_symbol, rows, boundary_ns, event_ns = _nq_june_2026_roll_fixture()
    mappings = rt.to_mappings(rows, "GLBX.MDP3", "sha256:test")

    resolved_new = _resolve_via_real_identity_js(mappings, new_symbol, event_ns)
    assert resolved_new == {"ok": True, "symbol": "NQU6"}

    resolved_old = _resolve_via_real_identity_js(mappings, old_symbol, str(boundary_ns - 1_000_000_000))
    assert resolved_old == {"ok": True, "symbol": "NQM6"}


def test_without_the_tolerance_the_same_real_row_fails_exactly_as_it_did_on_the_real_host():
    import shutil

    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    _old_symbol, new_symbol, rows, _boundary_ns, event_ns = _nq_june_2026_roll_fixture()
    mappings_no_tolerance = rt.to_mappings(rows, "GLBX.MDP3", "sha256:test", tolerance_ns=0)

    resolved = _resolve_via_real_identity_js(mappings_no_tolerance, new_symbol, event_ns)
    assert resolved == {"ok": False, "code": "UNRESOLVED_IDENTITY"}


def test_a_negative_definition_keeps_its_sign_so_validation_refuses_it():
    rows = [_def_row("1001", str(_day_ns("2025-09-01") + 1), "ESU5", unit_of_measure_qty="-50000000000")]
    snapshots = rt.definition_snapshots_from_rows(rows)
    assert snapshots["1001"][0][1]["multiplier"] == "-50.000000000"
    table = rt.build("ES.c.0", [{"start_date": "2025-09-01", "end_date": "2025-09-02", "symbol": "1001"}], snapshots, "v1")
    with pytest.raises(rt.RollTableError, match="NON_POSITIVE_MULTIPLIER"):
        rt.validate("ES.c.0", table)


def test_the_version_does_not_depend_on_the_order_its_sources_are_listed():
    assert rt.version(["a", "b"], ["m1", "m2"]) == rt.version(["b", "a"], ["m2", "m1"])
    assert rt.version(["a", "b"], ["m1"]) != rt.version(["a", "c"], ["m1"])
