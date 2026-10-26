"""Per-file, per-date coverage computation feeding cross-file authority (0.10)."""
from __future__ import annotations

import types

import pytest

import identity
import source_coverage as cov


def _meta(start_ns, end_ns, partial=None, dataset="XNAS.ITCH"):
    return types.SimpleNamespace(start_ns=start_ns, end_ns=end_ns, partial=partial or [], dataset=dataset)


_DAY = 86_400 * 1_000_000_000
_SEP_02 = 1756771200000000000  # 2025-09-02 00:00:00 UTC


def test_cadence_from_s3_key_reads_the_archive_partitioning():
    assert cov.cadence_from_s3_key("raw/databento/.../day=02/x.dbn") == "daily"
    assert cov.cadence_from_s3_key("raw/databento/.../month=09/x.dbn") == "monthly"
    with pytest.raises(cov.CoverageError, match="UNKNOWN_CADENCE"):
        cov.cadence_from_s3_key("raw/databento/.../x.dbn")


def test_dbn_coverage_a_full_single_day_file_is_complete():
    meta = _meta(_SEP_02, _SEP_02 + _DAY)
    entries = cov.dbn_coverage(meta, "candle", "AAPL")
    assert len(entries) == 1
    assert entries[0]["date"] == "2025-09-02"
    assert entries[0]["complete"] is True
    assert entries[0]["from_ns"] == _SEP_02 and entries[0]["to_ns"] == _SEP_02 + _DAY
    assert entries[0]["instrument_id"] == identity.instrument_id(identity.instrument_for("XNAS.ITCH", "AAPL"))


def test_dbn_coverage_spans_multiple_days_with_partial_boundaries():
    start = _SEP_02 + 3 * 3_600 * 1_000_000_000  # starts 3h into 2025-09-02
    end = _SEP_02 + 3 * _DAY - 3_600 * 1_000_000_000  # ends 1h before the close of 2025-09-04
    meta = _meta(start, end)
    entries = cov.dbn_coverage(meta, "candle", "AAPL")
    assert [e["date"] for e in entries] == ["2025-09-02", "2025-09-03", "2025-09-04"]
    assert entries[0]["complete"] is False  # partial start
    assert entries[1]["complete"] is True  # interior day, fully covered
    assert entries[2]["complete"] is False  # partial end


def test_dbn_coverage_marks_every_date_incomplete_when_the_symbol_is_in_metadata_partial():
    meta = _meta(_SEP_02, _SEP_02 + _DAY, partial=["AAPL"])
    entries = cov.dbn_coverage(meta, "candle", "AAPL")
    assert entries[0]["complete"] is False


def test_dbn_coverage_only_flags_the_named_symbol_not_other_symbols_in_the_same_file():
    meta = _meta(_SEP_02, _SEP_02 + _DAY, partial=["TSLA"])
    entries = cov.dbn_coverage(meta, "candle", "AAPL")
    assert entries[0]["complete"] is True


def test_csv_coverage_defaults_to_unverified_and_uses_the_one_canonical_instrument_id():
    entries = cov.csv_coverage("XNAS.ITCH", "AAPL", "candle", ["2025-09-02", "2025-09-01"])
    assert [e["date"] for e in entries] == ["2025-09-01", "2025-09-02"]
    expected_id = identity.instrument_id(identity.instrument_for("XNAS.ITCH", "AAPL"))
    assert all(e["instrument_id"] == expected_id and not e["complete"] and e["coverage_unknown"] for e in entries)


def test_csv_coverage_can_be_told_the_file_is_not_actually_complete():
    entries = cov.csv_coverage("XNAS.ITCH", "AAPL", "candle", ["2025-09-02"], complete=False)
    assert entries[0]["complete"] is False


def test_roll_table_coverage_matches_the_instrument_id_to_mappings_would_produce():
    import roll_table
    rows = [{"alias": "ES.n.0", "from_ns": _SEP_02, "to_ns": _SEP_02 + _DAY,
             "instrument_id": "1001", "contract_code": "ESU5", "tick_size": "0.25",
             "multiplier": "50", "roll_table_version": "v1"}]
    entries = cov.roll_table_coverage(rows, "trade", tolerance_ns=0)
    assert len(entries) == 1 and entries[0]["date"] == "2025-09-02" and entries[0]["complete"] is True

    mappings = roll_table.to_mappings(rows, "GLBX.MDP3", "sha256:test")
    assert entries[0]["instrument_id"] == identity.instrument_id(mappings[0]["instrument"])


def test_roll_table_coverage_splits_a_multi_day_interval_into_one_entry_per_utc_date():
    rows = [{"alias": "ES.n.0", "from_ns": _SEP_02, "to_ns": _SEP_02 + 3 * _DAY,
             "instrument_id": "1001", "contract_code": "ESU5", "tick_size": "0.25",
             "multiplier": "50", "roll_table_version": "v1"}]
    entries = cov.roll_table_coverage(rows, "trade")
    assert [e["date"] for e in entries] == ["2025-09-01", "2025-09-02", "2025-09-03", "2025-09-04", "2025-09-05"]
    assert [e["complete"] for e in entries] == [False, True, True, True, False]


def test_roll_table_coverage_widens_using_the_real_es_production_boundary():
    import roll_table
    boundary = 1758067200000000000  # 2025-09-17T00:00:00Z, the real ESU5->ESZ5 cutover
    real_trigger_ts = 1758067199904576981  # 2025-09-16T23:59:59.904576981Z, ~95.4ms early
    rows = [{"alias": "ES.n.0", "from_ns": boundary, "to_ns": boundary + _DAY,
             "instrument_id": "294973", "contract_code": "ESZ5", "tick_size": "0.25",
             "multiplier": "50", "roll_table_version": "v1"}]
    entries = cov.roll_table_coverage(rows, "quote")
    by_date = {e["date"]: e for e in entries}

    assert "2025-09-16" in by_date
    sliver = by_date["2025-09-16"]
    assert sliver["from_ns"] == boundary - roll_table.IDENTITY_RESOLUTION_TOLERANCE_NS
    assert sliver["to_ns"] == boundary
    assert sliver["complete"] is False
    assert sliver["from_ns"] <= real_trigger_ts < sliver["to_ns"]

    main_day = by_date["2025-09-17"]
    assert main_day["from_ns"] == boundary
    assert main_day["complete"] is True


def test_roll_table_coverage_claims_only_the_time_its_own_file_covers():
    # Report 57 FA-18: every daily ES.n.0 file claimed complete coverage of the whole roll interval,
    # so the next day's file (holding one pre-midnight book record) won the authority tie on depth
    # and 21 ES / 22 NQ August days were published with a single row.
    aug_03 = 1785715200000000000
    rows = [{"alias": "ES.n.0", "from_ns": aug_03, "to_ns": aug_03 + 29 * _DAY,
             "instrument_id": "42140870", "contract_code": "ESU6", "tick_size": "0.25",
             "multiplier": "50", "roll_table_version": "v1"}]
    aug_04 = aug_03 + _DAY
    entries = cov.roll_table_coverage(rows, "depth", file_start_ns=aug_04, file_end_ns=aug_04 + _DAY)
    assert [(e["date"], e["complete"]) for e in entries] == [("2026-08-04", True)]

    partial = cov.roll_table_coverage(rows, "depth", file_start_ns=aug_04, file_end_ns=aug_04 + _DAY, partial=True)
    assert [(e["date"], e["complete"]) for e in partial] == [("2026-08-04", False)]


def test_daily_continuous_files_each_stay_authoritative_for_their_own_day():
    import authority
    aug_03 = 1785715200000000000
    rows = [{"alias": "ES.n.0", "from_ns": aug_03, "to_ns": aug_03 + 29 * _DAY,
             "instrument_id": "42140870", "contract_code": "ESU6", "tick_size": "0.25",
             "multiplier": "50", "roll_table_version": "v1"}]
    inputs = []
    for offset, key, modified in ((0, "day=03", "2026-09-14T10:00:00Z"), (1, "day=04", "2026-09-14T11:00:00Z")):
        start = aug_03 + offset * _DAY
        coverage = [e for e in cov.roll_table_coverage(rows, "depth", file_start_ns=start, file_end_ns=start + _DAY)]
        inputs.append({"s3_key": key, "cadence": "daily", "last_modified": modified, "coverage": coverage})
    plan, excluded, _ranks = authority.resolve(inputs)
    by_date = {(p["date"], p["s3_key"]) for p in plan}
    assert by_date == {("2026-08-03", "day=03"), ("2026-08-04", "day=04")}
    assert excluded == []


def test_roll_table_coverage_with_tolerance_ns_zero_reproduces_the_original_gap():
    boundary = 1758067200000000000
    rows = [{"alias": "ES.n.0", "from_ns": boundary, "to_ns": boundary + _DAY,
             "instrument_id": "294973", "contract_code": "ESZ5", "tick_size": "0.25",
             "multiplier": "50", "roll_table_version": "v1"}]
    entries = cov.roll_table_coverage(rows, "quote", tolerance_ns=0)
    assert [e["date"] for e in entries] == ["2025-09-17"]
