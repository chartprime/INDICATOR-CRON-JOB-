from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import csv_decode
import preflight_l1 as preflight


def _inventory(symbol="AAPL", dataset="XNAS.ITCH", schema="mbp-1", definition_symbol=None):
    key = f"raw/databento/dataset={dataset}/schema={schema}/symbol={symbol}/year=2025/month=09/source.dbn.zst"
    return {
        f"{dataset}:{schema}:{symbol}": {
            "dataset": dataset,
            "schema": schema,
            "symbol": symbol,
            "definition_symbol": definition_symbol,
            "start": "2025-09-01",
            "end": "2025-09-30",
            "objects": [{"s3_key": key, "bytes": 100}],
        }
    }


def test_capacity_uses_the_installed_scratch_budget_source_set_and_pool_size(tmp_path, monkeypatch):
    class _Usage:
        free = 10_000

    monkeypatch.setattr(preflight.shutil, "disk_usage", lambda _path: _Usage())
    inventories = _inventory("ES", "GLBX.MDP3", definition_symbol="ES")
    definitions = {"ES": [{"bytes": 10}]}

    detail = preflight._capacity(
        inventories, definitions, tmp_path,
        {"TT_CONVERT_GLOBAL_RESERVE_BYTES": "10", "TT_CONVERT_SCRATCH_BYTES": "1000"}, 2,
    )

    assert detail["largest_raw_bytes"] == 100
    assert detail["largest_monthly_source_set_bytes"] == 110
    assert detail["nineteen_x_forecast_bytes"] == 1900
    assert detail["per_worker_bytes"] == 2010
    assert detail["required_bytes"] == 4030


def test_capacity_refuses_an_empty_inventory_before_reporting_a_spurious_pass(tmp_path):
    with pytest.raises(preflight.PreflightError, match="FROZEN_INVENTORY_REQUIRED"):
        preflight._capacity({}, {}, tmp_path, {}, 1)


class _Pages:
    def __init__(self, keys):
        self.keys = keys

    def paginate(self, **_kwargs):
        return [{"Contents": [{"Key": key} for key in self.keys]}]


class _ListingClient:
    def __init__(self, keys):
        self.keys = keys

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return _Pages(self.keys)


@pytest.mark.parametrize("key", [
    "curated/databento/instrument/trade/w606-l1-v2/2025-09-01/part.parquet",
    "curated/databento/instrument/trade/w606-l1-v2-xnas-itch-mbp-1-aapl-2025-09/2025-09-01/part.parquet",
])
def test_target_version_gate_rejects_direct_and_sequence_derived_versions(key):
    with pytest.raises(preflight.PreflightError, match="TARGET_VERSION_NOT_EMPTY"):
        preflight._target_version_absent(_ListingClient([key]), "bucket", "curated/databento", "w606-l1-v2")


def test_target_version_gate_does_not_confuse_another_version_with_the_target():
    detail = preflight._target_version_absent(
        _ListingClient(["curated/databento/instrument/trade/w606-l1-v20/2025-09-01/part.parquet"]),
        "bucket", "curated/databento", "w606-l1-v2",
    )
    assert detail == {"keys": 0}


@pytest.mark.skipif(os.name != "posix", reason="flock availability is a Linux deployment requirement")
def test_lock_gate_creates_and_checks_both_configured_worker_locks(tmp_path):
    staging = tmp_path / "staging"
    curated = tmp_path / "curated"
    detail = preflight._locks_available(staging, curated, "w606-l1-v2")

    paths = {entry["path"] for entry in detail["locks"]}
    assert paths == {
        str(tmp_path / "staging.sequence.guard"),
        str(staging / ".capacity-reservations.guard"),
        str(curated / "_locks" / "conversion.w606-l1-v2.guard"),
    }
    assert all(entry["present_before_check"] is False for entry in detail["locks"])
    assert (tmp_path / "staging.sequence.guard").is_file()
    assert (staging / ".capacity-reservations.guard").is_file()
    assert (curated / "_locks" / "conversion.w606-l1-v2.guard").is_file()


@pytest.mark.skipif(os.name != "posix", reason="flock availability is a Linux deployment requirement")
def test_lock_gate_rejects_leftover_capacity_reservations(tmp_path):
    staging = tmp_path / "staging"
    reservation = preflight.backfill_sequence._CapacityReservation(staging)
    reservation._write({"other-worker": {
        "bytes": 1, "host": "other-host", "pid": 1, "boot_id": None, "process_start": None,
    }})

    with pytest.raises(preflight.PreflightError, match="CAPACITY_RESERVATIONS_NOT_EMPTY:1"):
        preflight._locks_available(staging, tmp_path / "curated", "w606-l1-v2")


@pytest.mark.skipif(os.name != "posix", reason="flock availability is a Linux deployment requirement")
def test_lock_gate_fails_closed_on_a_malformed_capacity_reservation_ledger(tmp_path):
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "_capacity-reservations.json").write_text(
        '{"reservations":{"broken":{"bytes":1}}}', encoding="utf-8"
    )

    with pytest.raises(preflight.PreflightError, match="CAPACITY_RESERVATION_STATE_INVALID"):
        preflight._locks_available(staging, tmp_path / "curated", "w606-l1-v2")


def test_service_conversion_environment_reads_systemd_environment_tokens(monkeypatch):
    monkeypatch.setattr(preflight, "_service_property", lambda *_args: {
        "Environment": 'TT_CONVERT_SCRATCH_BYTES=400000000000 PYTHONUNBUFFERED=1'
    })
    assert preflight._service_conversion_environment("terminal-backfill@l1.service") == {
        "TT_CONVERT_SCRATCH_BYTES": "400000000000", "PYTHONUNBUFFERED": "1",
    }


def test_credentials_are_read_from_the_systemd_injected_environment(monkeypatch):
    values = {
        "RCLONE_CONFIG_TTCONVERT_REGION": "region",
        "RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID": "access",
        "RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY": "secret",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)

    assert preflight._credentials_from_environment() == values


def test_credentials_fail_closed_when_systemd_did_not_inject_one(monkeypatch):
    for key in (
        "RCLONE_CONFIG_TTCONVERT_REGION",
        "RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID",
        "RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY",
    ):
        monkeypatch.delenv(key, raising=False)

    with pytest.raises(preflight.PreflightError, match="MISSING_INJECTED_SERVICE_ENV_VALUES"):
        preflight._credentials_from_environment()


def test_roll_gate_refuses_to_treat_a_partial_raw_census_as_a_valid_roll_proof(tmp_path):
    """A rejected raw object must not leave the later roll/capacity evidence
    looking complete just because an earlier object happened to decode."""
    objects = [
        ("XNAS.ITCH", "mbp-1", "AAPL", {"s3_key": "one", "bytes": 1, "etag": "one"}),
        ("GLBX.MDP3", "mbp-1", "ES", {"s3_key": "two", "bytes": 1, "etag": "two"}),
    ]
    metadata = {
        "one": {"dataset": "XNAS.ITCH", "schema": "mbp-1", "symbol": "AAPL"},
    }

    with pytest.raises(preflight.PreflightError, match=r"INCOMPLETE_RAW_CENSUS:1!=2"):
        preflight._require_complete_raw_census(metadata, objects)


def test_roll_validation_records_each_downloaded_definition_identity(monkeypatch, tmp_path):
    definition = {"s3_key": "raw/definition.dbn.zst", "bytes": 7, "etag": "etag"}
    monkeypatch.setattr(preflight, "_download_verified", lambda *_args: (Path(tmp_path / "definition.dbn"), "d" * 64))
    monkeypatch.setattr(preflight.dbn, "decode", lambda *_args, **_kwargs: iter(()))
    monkeypatch.setattr(preflight.roll_table, "definition_snapshots_from_rows", lambda rows: {})
    monkeypatch.setattr(preflight.roll_table, "version", lambda *_args: "roll-v1")
    monkeypatch.setattr(preflight.roll_table, "build", lambda *_args: [])
    monkeypatch.setattr(preflight.roll_table, "validate", lambda *_args: [])

    detail = preflight._validate_roll_tables(
        object(), "bucket", {"raw": {"dataset": "GLBX.MDP3", "sha256": "r" * 64}}, tmp_path,
        aliases={"ES.c.0": [{"start_date": "2025-09-01", "end_date": "2025-09-30", "symbol": "ESU5"}]},
        definitions={"ES": [definition]},
    )

    assert detail["verified_definition_sources"] == [{
        "s3_key": "raw/definition.dbn.zst", "bytes": 7, "etag": "etag", "sha256": "d" * 64,
    }]


def test_main_creates_the_scan_directory_before_any_source_is_downloaded(tmp_path, monkeypatch):
    # Every gate passed its own unit test while main() never created the
    # directory all of them download into, because each test received a
    # tmp_path that pytest had already made. The first real object therefore
    # failed with FileNotFoundError and the census, roll-table and capacity
    # gates all cascaded from it. This exercises main()'s wiring, not a gate.
    staging = tmp_path / "staging"
    staging.mkdir()
    seen = {}

    def census(_client, _bucket, objects, directory):
        seen["directory"] = Path(directory)
        seen["existed"] = Path(directory).is_dir()
        return {"A": len(objects)}, {"raw/databento/x.dbn.zst": {
            "dataset": "GLBX.MDP3", "schema": "mbp-1", "symbol": "ES", "sha256": "a" * 64,
            "etag": '"e"', "bytes": 1, "stype_in": "raw_symbol", "symbols": ["ES"], "mappings": {}}}

    monkeypatch.setattr(preflight, "_credentials_from_environment", lambda: {})
    monkeypatch.setattr(preflight, "_client", lambda _env: object())
    monkeypatch.setattr(preflight, "_unit_and_release", lambda *a, **k: {})
    monkeypatch.setattr(preflight, "_service_conversion_environment",
                        lambda _s: {"TT_CONVERT_SCRATCH_BYTES": "400000000000"})
    monkeypatch.setattr(preflight, "_target_version_absent", lambda *a, **k: {})
    monkeypatch.setattr(preflight, "_all_phase_objects",
                        lambda *a, **k: ({}, [("GLBX.MDP3", "mbp-1", "ES", {"s3_key": "k", "bytes": 1})]))
    monkeypatch.setattr(preflight, "_head_verify", lambda *a, **k: None)
    monkeypatch.setattr(preflight, "_collector_health", lambda *a, **k: {})
    monkeypatch.setattr(preflight, "_locks_available", lambda *a, **k: {})
    monkeypatch.setattr(preflight, "_action_census_and_metadata", census)
    monkeypatch.setattr(preflight, "_definition_objects", lambda *a, **k: ({}, {}))
    monkeypatch.setattr(preflight, "_validate_roll_tables", lambda *a, **k: {"aliases": {}})
    monkeypatch.setattr(preflight, "_capacity", lambda *a, **k: {})

    preflight.main([
        "--expected-commit", "abc1234", "--report", str(tmp_path / "r.json"),
        "--staging-root", str(staging), "--curated-root", str(tmp_path / "curated"),
    ])

    assert seen["existed"] is True, "main() handed the census a directory it had not created"
    assert seen["directory"].parent.name == "_preflight"
    # _run_gate turns every exception into a FAIL record rather than letting it
    # escape main(), so asserting only the side effect above let a KeyError in
    # the census report pass as green while the real gate failed after nearly
    # four hours of decoding. Assert the outcome, not just the side effect.
    report = json.loads((tmp_path / "r.json").read_text(encoding="utf-8"))
    failed = {n: g["error"] for n, g in report["gates"].items() if g["status"] == "FAIL"}
    assert not failed, f"gates failed: {failed}"
    assert report["status"] == "PASS"


def _definition_csv(path, rows=1):
    columns = csv_decode._DEFINITION_COLUMNS
    lines = [",".join(columns)]
    for index in range(rows):
        values = ["0"] * len(columns)
        values[columns.index("raw_symbol")] = f"ESU{index}"
        lines.append(",".join(values))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_definition_sources_are_decoded_by_their_own_type_not_assumed_to_be_dbn(tmp_path):
    # Databento serves GLBX definitions as CSV. Assuming DBN made the roll-table
    # gate fail with "invalid DBN header" on every real definition object, which
    # only surfaced after the census had already run for nearly four hours.
    csv_path = _definition_csv(tmp_path / "glbx-mdp3-20250901-ESU5.definition.csv")

    rows = preflight._definition_rows(csv_path)

    assert len(rows) == 1
    assert rows[0]["raw_symbol"] == "ESU0"


def test_an_empty_definition_csv_is_skipped_rather_than_failing_the_gate(tmp_path):
    # job._build_roll_tables tolerates EMPTY_CSV; the gate must agree or it
    # rejects a source set the conversion itself accepts.
    empty = tmp_path / "glbx-mdp3-20250902.definition.csv"
    empty.write_text(",".join(csv_decode._DEFINITION_COLUMNS) + "\n", encoding="utf-8")

    with pytest.raises(csv_decode.CsvError, match="EMPTY_CSV"):
        preflight._definition_rows(empty)
