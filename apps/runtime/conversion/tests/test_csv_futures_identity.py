from __future__ import annotations

import datetime as dt
import os

import pytest

import job

_OHLCV_HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume"


def test_futures_mapping_is_bounded_by_definition_and_expiration():
    facts = {"raw_symbol": "NQU5", "expiration_ns": 1758288600000000000}
    mappings = job._identity.build_csv_futures_mappings("GLBX.MDP3", ["42008487"],
        {"42008487": [("2025-09-01", facts)]}, "provider-evidence")
    assert mappings[0]["fromNs"] == job._identity.day_ns("2025-09-01")
    assert mappings[0]["toNs"] == str(facts["expiration_ns"])
    assert int(mappings[0]["toNs"]) < int(job._identity.day_ns("2025-09-28"))
    with pytest.raises(job._identity.IdentityError, match="EXPIRATION_UNRESOLVED"):
        job._identity.build_csv_futures_mappings("GLBX.MDP3", ["42008487"],
            {"42008487": [("2025-09-01", {"raw_symbol": "NQU5", "expiration_ns": None})]}, "provider-evidence")


def _day_ns(date_str):
    return (dt.date.fromisoformat(date_str) - dt.date(1970, 1, 1)).days * 86_400 * 1_000_000_000


def _ohlcv_row(date_str, instrument_id, close="231460000000"):
    ts = _day_ns(date_str) + 1
    return f"{ts},32,2,{instrument_id},{close},{close},{close},{close},21"


def _ohlcv_csv(path, rows):
    path.write_text("\n".join([_OHLCV_HEADER, *rows]) + "\n")
    return str(path)


def _definition_row(instrument_id, ts_recv, raw_symbol, min_price_increment="250000000",
                    unit_of_measure_qty="50000000000", expiration=None):
    if expiration is None:
        expiration = str(_day_ns("2026-12-19"))
    values = {c: "" for c in job._csv._DEFINITION_COLUMNS}
    values.update({
        "ts_recv": str(ts_recv), "instrument_id": str(instrument_id), "raw_symbol": raw_symbol,
        "min_price_increment": min_price_increment, "unit_of_measure_qty": unit_of_measure_qty,
        "expiration": expiration,
    })
    return ",".join(values[c] for c in job._csv._DEFINITION_COLUMNS)


def _definition_csv(path, rows):
    header = ",".join(job._csv._DEFINITION_COLUMNS)
    path.write_text("\n".join([header, *rows]) + "\n")
    return str(path)


def _roots(tmp_path):
    return {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }


def test_a_futures_csv_input_resolves_each_contract_via_the_definition_snapshots(tmp_path):
    ohlcv_path = _ohlcv_csv(tmp_path / "es.ohlcv-1s.csv", [
        _ohlcv_row("2025-09-01", "1001", close="100000000000"),
        _ohlcv_row("2025-09-02", "1002", close="200000000000"),
    ])
    definition_path = _definition_csv(tmp_path / "def.csv", [
        _definition_row("1001", _day_ns("2025-08-01"), "ESZ5"),
        _definition_row("1002", _day_ns("2025-08-15"), "ESH6"),
    ])
    inputs = [{
        "local_path": ohlcv_path,
        "s3_key": "raw/databento/dataset=GLBX.MDP3/schema=ohlcv-1s/symbol=ES/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "GLBX.MDP3", "symbol": "ES",
    }]
    definition_sources = [{"local_path": definition_path, "s3_key": "raw/databento/dataset=GLBX.MDP3/schema=definition/symbol=ES/def.csv"}]

    summary = job.run_job(inputs, "v1", definition_sources=definition_sources, **_roots(tmp_path))

    assert len(summary["partitions"]) == 2
    slugs = {p.split("/")[1] for p in summary["partitions"]}
    assert len(slugs) == 2, "each real contract must land in its own partition, not merged under one alias"


def test_a_futures_csv_input_with_no_definition_sources_is_refused(tmp_path):
    ohlcv_path = _ohlcv_csv(tmp_path / "es.ohlcv-1s.csv", [_ohlcv_row("2025-09-01", "1001")])
    inputs = [{
        "local_path": ohlcv_path,
        "s3_key": "raw/databento/dataset=GLBX.MDP3/schema=ohlcv-1s/symbol=ES/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "GLBX.MDP3", "symbol": "ES",
    }]
    with pytest.raises(job.JobError, match="ROLL_TABLE_REQUIRES_DEFINITION_SOURCES"):
        job.run_job(inputs, "v1", **_roots(tmp_path))


def test_a_futures_csv_instrument_id_with_no_matching_definition_fails_loudly(tmp_path):
    ohlcv_path = _ohlcv_csv(tmp_path / "es.ohlcv-1s.csv", [_ohlcv_row("2025-09-01", "1001")])
    definition_path = _definition_csv(tmp_path / "def.csv", [_definition_row("9999", _day_ns("2025-08-01"), "ESZ5")])
    inputs = [{
        "local_path": ohlcv_path,
        "s3_key": "raw/databento/dataset=GLBX.MDP3/schema=ohlcv-1s/symbol=ES/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "GLBX.MDP3", "symbol": "ES",
    }]
    definition_sources = [{"local_path": definition_path, "s3_key": "raw/databento/dataset=GLBX.MDP3/schema=definition/symbol=ES/def.csv"}]
    with pytest.raises(job._identity.IdentityError, match="CSV_FUTURES_DEFINITION_GAP:1001"):
        job.run_job(inputs, "v1", definition_sources=definition_sources, **_roots(tmp_path))


def test_a_futures_csv_instrument_id_with_conflicting_definitions_fails_loudly(tmp_path):
    ohlcv_path = _ohlcv_csv(tmp_path / "es.ohlcv-1s.csv", [_ohlcv_row("2025-09-01", "1001")])
    definition_path = _definition_csv(tmp_path / "def.csv", [
        _definition_row("1001", _day_ns("2025-08-01"), "ESZ5"),
        _definition_row("1001", _day_ns("2025-08-15"), "ESH6"),
    ])
    inputs = [{
        "local_path": ohlcv_path,
        "s3_key": "raw/databento/dataset=GLBX.MDP3/schema=ohlcv-1s/symbol=ES/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "GLBX.MDP3", "symbol": "ES",
    }]
    definition_sources = [{"local_path": definition_path, "s3_key": "raw/databento/dataset=GLBX.MDP3/schema=definition/symbol=ES/def.csv"}]
    with pytest.raises(job._identity.IdentityError, match="CSV_FUTURES_INCONSISTENT_DEFINITION:1001"):
        job.run_job(inputs, "v1", definition_sources=definition_sources, **_roots(tmp_path))


def test_equity_csv_is_unaffected_and_needs_no_definition_sources(tmp_path):
    ohlcv_path = _ohlcv_csv(tmp_path / "aapl.ohlcv-1s.csv", [_ohlcv_row("2025-09-01", "38")])
    inputs = [{
        "local_path": ohlcv_path,
        "s3_key": "raw/databento/dataset=XNAS.ITCH/schema=ohlcv-1s/symbol=AAPL/year=2025/month=09/x.csv",
        "schema": "ohlcv-1s", "dataset": "XNAS.ITCH", "symbol": "AAPL",
    }]
    summary = job.run_job(inputs, "v1", **_roots(tmp_path))
    assert len(summary["partitions"]) == 1
