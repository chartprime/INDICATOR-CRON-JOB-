"""Roll table wired into job.py's real identity resolution (design lock 19
section 0.4a): a continuous-symbol DBN input (`ES.n.0`-style) routes through
the resolved roll table instead of `identity.build_mappings` (which
correctly refuses continuous aliases on their own).

No real continuous-request `mbp-1`/`mbp-10` fixture or `definition` schema
fixture exists in the repo, and `databento_dbn` has no encoder to synthesize
either. This proves the wiring honestly: real row *content* comes from the
pinned `mbp-1` fixture (real decode, unmodified), with only the metadata's
`stype_in`/`symbols`/`mappings` overridden to look like a continuous request
-- and a `definition` decode faked to return synthetic-but-realistic rows.
Both overrides are the minimum needed to exercise the real code path; real
ES/NQ archive + `definition` data is still Phase 3's outstanding real-sample
proof (Week-6/21-22 already flag this pattern for depth; same boundary
applies here).
"""
from __future__ import annotations

import os

import duckdb
import pytest

import job
from test_job import MBP1, _roots

_MBP1_CONTINUOUS_KEY = "raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=ES.n.0/year=2020/month=12/day=28/x.dbn"
_DEFINITION_KEY = "raw/databento/dataset=GLBX.MDP3/schema=definition/year=2020/month=12/day=28/def.dbn"


def _day_ns(date_str):
    import datetime as dt
    return (dt.date.fromisoformat(date_str) - dt.date(1970, 1, 1)).days * 86_400 * 1_000_000_000


@pytest.fixture
def _continuous_metadata(monkeypatch):
    real_read_metadata = job._dbn.read_metadata

    def faked(path, expected_schema=None):
        meta = real_read_metadata(path, expected_schema=expected_schema)
        if path == MBP1:
            meta.stype_in = "continuous"
            meta.symbols = ["ES.n.0"]
            meta.mappings = {"ES.n.0": [{"start_date": "2020-12-28", "end_date": "2020-12-29", "symbol": "5482"}]}
        return meta

    monkeypatch.setattr(job._dbn, "read_metadata", faked)


@pytest.fixture
def _definition_source(tmp_path, monkeypatch):
    real_decode = job._dbn.decode
    definition_path = str(tmp_path / "definition.dbn")
    with open(definition_path, "w") as fh:
        fh.write("placeholder -- decode is faked below, content is never read")

    def faked(path, expected_schema=None, on_metadata=None):
        if expected_schema == "definition":
            def rows():
                yield 0, {
                    "instrument_id": "5482", "ts_recv": str(_day_ns("2020-12-28") + 1), "raw_symbol": "ESH1",
                    "min_price_increment": "250000000", "unit_of_measure_qty": "50000000000",
                    "expiration": str(_day_ns("2021-03-19")),
                }
            return rows()
        return real_decode(path, expected_schema=expected_schema, on_metadata=on_metadata)

    monkeypatch.setattr(job._dbn, "decode", faked)
    return [{"local_path": definition_path, "s3_key": _DEFINITION_KEY}]


def test_a_continuous_input_resolves_through_the_roll_table_not_raw_identity(tmp_path, _continuous_metadata, _definition_source):
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"}]
    roots = _roots(tmp_path)
    summary = job.run_job(inputs, "v1", definition_sources=_definition_source, **roots)

    assert len(summary["partitions"]) == 1
    prefix = summary["partitions"][0]
    assert prefix.split("/")[2] == "quote"  # both fixture rows are action='A', no trade extraction
    assert "XCME_FUTURE_ESH1_USD_CONTRACT" in prefix  # the resolved real contract, not "ES.n.0" or "5482"

    part = os.path.join(tmp_path, "curated", prefix, "part-00000.parquet")
    con = duckdb.connect()
    try:
        rows = con.execute("SELECT venue, market, symbol, contract, mapping_version FROM read_parquet(?)", [part]).fetchall()
    finally:
        con.close()
    assert all(r[:4] == ("XCME", "FUTURE", "ESH1", "ESH1") for r in rows)
    assert all(r[4].startswith("roll-table/") for r in rows)


def test_overlapping_sources_share_one_roll_interval(tmp_path, _continuous_metadata, _definition_source):
    inputs = [
        {"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"},
        {"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY.replace("x.dbn", "other.dbn"), "schema": "mbp-1"},
    ]
    summary = job.run_job(inputs, "overlap", definition_sources=_definition_source, **_roots(tmp_path))
    assert len(summary["partitions"]) == 1
    assert summary["overlap_excluded"]


def test_roll_intervals_land_in_the_catalog(tmp_path, _continuous_metadata, _definition_source):
    import sqlite3

    import catalog

    inputs = [{"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"}]
    roots = _roots(tmp_path)
    summary = job.run_job(inputs, "v1", definition_sources=_definition_source, **roots)
    pointer = catalog.read_current(roots["catalog_root"])

    con = sqlite3.connect(os.path.join(roots["catalog_root"], pointer["catalog_key"]))
    try:
        rows = con.execute(
            "SELECT alias, contract_code, tick_size, multiplier, instrument_id FROM roll_intervals"
        ).fetchall()
    finally:
        con.close()
    assert len(rows) == 1
    alias, contract_code, tick_size, multiplier, instrument_id = rows[0]
    assert alias == "ES.n.0" and contract_code == "ESH1" and instrument_id == "5482"
    from decimal import Decimal
    assert Decimal(tick_size) == Decimal("0.25") and Decimal(multiplier) == Decimal("50")
    assert summary["partitions"]  # sanity: the job actually produced output too


def test_roll_table_warnings_reach_the_job_summary_not_just_the_checkpoint(tmp_path, monkeypatch, _continuous_metadata):
    real_decode = job._dbn.decode
    real_read_metadata = job._dbn.read_metadata

    # Two intervals, so the first endpoint is a genuine roll. A single-interval
    # table ends at the source window's own horizon, which is not a roll and no
    # longer warns.
    def faked_metadata(path, expected_schema=None):
        meta = real_read_metadata(path, expected_schema=expected_schema)
        if path == MBP1:
            meta.stype_in = "continuous"
            meta.symbols = ["ES.n.0"]
            meta.mappings = {"ES.n.0": [
                {"start_date": "2020-12-28", "end_date": "2020-12-29", "symbol": "5482"},
                {"start_date": "2020-12-29", "end_date": "2020-12-30", "symbol": "5483"},
            ]}
        return meta

    def faked(path, expected_schema=None, on_metadata=None):
        if expected_schema == "definition":
            def rows():
                yield 0, {
                    "instrument_id": "5482", "ts_recv": str(_day_ns("2020-12-28") + 1), "raw_symbol": "ESH1",
                    "min_price_increment": "250000000", "unit_of_measure_qty": "50000000000",
                    "expiration": str(_day_ns("2021-06-18")),  # nowhere near the 2020-12-29 roll boundary
                }
                yield 1, {
                    "instrument_id": "5483", "ts_recv": str(_day_ns("2020-12-28") + 1), "raw_symbol": "ESM1",
                    "min_price_increment": "250000000", "unit_of_measure_qty": "50000000000",
                    "expiration": str(_day_ns("2021-06-18")),
                }
            return rows()
        return real_decode(path, expected_schema=expected_schema, on_metadata=on_metadata)

    monkeypatch.setattr(job._dbn, "read_metadata", faked_metadata)
    monkeypatch.setattr(job._dbn, "decode", faked)
    definition_path = str(tmp_path / "definition.dbn")
    with open(definition_path, "w") as fh:
        fh.write("placeholder")

    inputs = [{"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"}]
    summary = job.run_job(inputs, "v1", definition_sources=[{"local_path": definition_path, "s3_key": _DEFINITION_KEY}],
                          **_roots(tmp_path))
    assert len(summary["roll_table_warnings"]) == 1
    assert "ROLL_BOUNDARY_FAR_FROM_EXPIRATION" in summary["roll_table_warnings"][0]


def test_a_continuous_input_without_definition_sources_is_refused_not_silently_mismapped(tmp_path, _continuous_metadata):
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"}]
    with pytest.raises(job.JobError, match="ROLL_TABLE_REQUIRES_DEFINITION_SOURCES"):
        job.run_job(inputs, "v1", **_roots(tmp_path))


def test_a_definition_gap_fails_the_whole_job_loudly(tmp_path, monkeypatch, _continuous_metadata):
    real_decode = job._dbn.decode

    def faked(path, expected_schema=None, on_metadata=None):
        if expected_schema == "definition":
            def rows():
                yield 0, {
                    "instrument_id": "5482", "ts_recv": str(_day_ns("2020-12-28") + 1), "raw_symbol": "ESH1",
                    "min_price_increment": "250000000", "unit_of_measure_qty": "50000000000", "expiration": None,
                }
            return rows()
        return real_decode(path, expected_schema=expected_schema, on_metadata=on_metadata)

    monkeypatch.setattr(job._dbn, "decode", faked)

    real_read_metadata = job._dbn.read_metadata

    def widened(path, expected_schema=None):
        meta = real_read_metadata(path, expected_schema=expected_schema)
        if path == MBP1:
            meta.stype_in = "continuous"
            meta.symbols = ["ES.n.0"]
            # The interval starts a day before the only known definition
            # snapshot (2020-12-28) -- 2020-12-27 has no as-of coverage at
            # all, a real gap. 2020-12-29 is not: the roll table resolves
            # each day to the most recent snapshot at or before it, so it
            # correctly carries the 12-28 snapshot forward.
            meta.mappings = {"ES.n.0": [{"start_date": "2020-12-27", "end_date": "2020-12-29", "symbol": "5482"}]}
        return meta

    monkeypatch.setattr(job._dbn, "read_metadata", widened)

    definition_path = str(tmp_path / "definition.dbn")
    with open(definition_path, "w") as fh:
        fh.write("placeholder")

    inputs = [{"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"}]
    # Propagates as roll_table.RollTableError, uncaught -- consistent with
    # every other lower-level builder error (IdentityError, CsvError,
    # SplitError) never getting wrapped into JobError by this layer.
    with pytest.raises(job._roll_table.RollTableError, match="DEFINITION_GAP"):
        job.run_job(inputs, "v1", definition_sources=[{"local_path": definition_path, "s3_key": _DEFINITION_KEY}],
                    **_roots(tmp_path))


def test_an_empty_definition_source_is_skipped_not_fatal(tmp_path, _continuous_metadata, _definition_source):
    empty_path = tmp_path / "empty-definition.csv"
    empty_path.write_text(",".join(job._csv._DEFINITION_COLUMNS) + "\n")
    empty_key = "raw/databento/dataset=GLBX.MDP3/schema=definition/year=2020/month=11/day=01/def.csv"

    inputs = [{"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"}]
    roots = _roots(tmp_path)
    sources = _definition_source + [{"local_path": str(empty_path), "s3_key": empty_key}]
    summary = job.run_job(inputs, "v1", definition_sources=sources, **roots)

    assert summary["skipped_empty_definition_sources"] == [empty_key]
    assert len(summary["partitions"]) == 1


def test_an_empty_definition_source_alone_still_fails_the_real_gap_check(tmp_path, _continuous_metadata):
    empty_path = tmp_path / "empty-definition.csv"
    empty_path.write_text(",".join(job._csv._DEFINITION_COLUMNS) + "\n")
    empty_key = "raw/databento/dataset=GLBX.MDP3/schema=definition/year=2020/month=11/day=01/def.csv"

    inputs = [{"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"}]
    with pytest.raises(job._roll_table.RollTableError, match="DEFINITION_GAP"):
        job.run_job(inputs, "v1", definition_sources=[{"local_path": str(empty_path), "s3_key": empty_key}],
                    **_roots(tmp_path))


def _setup_two_contract_roll(tmp_path, monkeypatch):
    """Real ESH1 fixture rows plus one synthetic ESM1 row landing 0.5s
    before a same-day-aligned roll boundary -- the same shape as the real
    ESU5->ESZ5 production incident (a real tick tagged with the new raw
    instrument id, inside the identity-resolution tolerance, before the
    documented cutover).
    """
    real_read_metadata = job._dbn.read_metadata
    real_decode = job._dbn.decode
    boundary_ns = _day_ns("2020-12-29")
    early_ts = str(boundary_ns - 500_000_000)

    def faked_metadata(path, expected_schema=None):
        meta = real_read_metadata(path, expected_schema=expected_schema)
        if path == MBP1:
            meta.stype_in = "continuous"
            meta.symbols = ["ES.n.0"]
            meta.mappings = {"ES.n.0": [
                {"start_date": "2020-12-28", "end_date": "2020-12-29", "symbol": "5482"},
                {"start_date": "2020-12-29", "end_date": "2020-12-30", "symbol": "9999"},
            ]}
        return meta

    def faked_decode(path, expected_schema=None, on_metadata=None):
        if expected_schema == "definition":
            def rows():
                yield 0, {
                    "instrument_id": "5482", "ts_recv": str(_day_ns("2020-12-28") + 1), "raw_symbol": "ESH1",
                    "min_price_increment": "250000000", "unit_of_measure_qty": "50000000000",
                    "expiration": str(_day_ns("2021-03-19")),
                }
                yield 1, {
                    "instrument_id": "9999", "ts_recv": str(_day_ns("2020-12-29") + 1), "raw_symbol": "ESM1",
                    "min_price_increment": "250000000", "unit_of_measure_qty": "50000000000",
                    "expiration": str(_day_ns("2021-06-18")),
                }
            return rows()
        if path == MBP1 and expected_schema == "mbp-1":
            decoded = list(real_decode(path, expected_schema=expected_schema, on_metadata=on_metadata))
            last_index, last_row = decoded[-1]
            early_row = dict(last_row)
            early_row["instrument_id"] = "9999"
            early_row["ts_event"] = early_ts
            early_row["ts_recv"] = str(int(early_ts) + 100_000)
            early_row["sequence"] = str(int(last_row["sequence"]) + 1)
            decoded.append((last_index + 1, early_row))

            def mbp_rows():
                yield from decoded
            return mbp_rows()
        return real_decode(path, expected_schema=expected_schema, on_metadata=on_metadata)

    monkeypatch.setattr(job._dbn, "read_metadata", faked_metadata)
    monkeypatch.setattr(job._dbn, "decode", faked_decode)

    definition_path = str(tmp_path / "definition.dbn")
    with open(definition_path, "w") as fh:
        fh.write("placeholder -- decode is faked above")

    inputs = [{"local_path": MBP1, "s3_key": _MBP1_CONTINUOUS_KEY, "schema": "mbp-1"}]
    definition_sources = [{"local_path": definition_path, "s3_key": _DEFINITION_KEY}]
    return inputs, definition_sources


def test_a_record_landing_in_the_tolerance_window_is_no_longer_unplanned(tmp_path, monkeypatch):
    inputs, definition_sources = _setup_two_contract_roll(tmp_path, monkeypatch)
    summary = job.run_job(inputs, "v1", definition_sources=definition_sources, **_roots(tmp_path))

    assert {p.split("/")[-1] for p in summary["partitions"]} == {"2020-12-28"}
    by_contract = {p.split("/")[2]: p for p in summary["partitions"]}
    assert any("XCME_FUTURE_ESH1_USD_CONTRACT" in p for p in summary["partitions"])
    assert any("XCME_FUTURE_ESM1_USD_CONTRACT" in p for p in summary["partitions"])
    assert len(summary["partitions"]) == 2


def test_a_continuous_file_claims_coverage_only_inside_its_own_time_window(tmp_path, monkeypatch):
    # Report 57 FA-18: without the file window, a daily continuous file claimed the whole roll
    # interval and the next day's file won depth for the previous day (21 ES / 22 NQ stub days).
    inputs, definition_sources = _setup_two_contract_roll(tmp_path, monkeypatch)
    real_roll_table_coverage = job._coverage.roll_table_coverage
    calls = []

    def spy(roll_rows, family, **kwargs):
        calls.append(kwargs)
        return real_roll_table_coverage(roll_rows, family, **kwargs)

    monkeypatch.setattr(job._coverage, "roll_table_coverage", spy)
    job.run_job(inputs, "v1", definition_sources=definition_sources, **_roots(tmp_path))

    meta = job._dbn.read_metadata(MBP1, expected_schema="mbp-1")
    assert calls, "the continuous input never asked for roll-table coverage"
    for kwargs in calls:
        assert kwargs["file_start_ns"] == meta.start_ns
        assert kwargs["file_end_ns"] == meta.end_ns
        assert kwargs["partial"] is ("ES.n.0" in meta.partial)


def test_without_the_coverage_fix_the_same_scenario_raises_unplanned_output_record(tmp_path, monkeypatch):
    inputs, definition_sources = _setup_two_contract_roll(tmp_path, monkeypatch)
    real_roll_table_coverage = job._coverage.roll_table_coverage
    monkeypatch.setattr(
        job._coverage, "roll_table_coverage",
        lambda roll_rows, family, **kwargs: real_roll_table_coverage(roll_rows, family, tolerance_ns=0, **kwargs),
    )

    with pytest.raises(job.JobError, match="UNPLANNED_OUTPUT_RECORD"):
        job.run_job(inputs, "v1", definition_sources=definition_sources, **_roots(tmp_path))
