import json
from pathlib import Path
import sqlite3
import sys

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import plan_historical_core_month as inventory


def catalog(tmp_path):
    path = tmp_path / "source.sqlite"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE partitions(instrument_id, family, date, s3_prefix, manifest_sha256, "
                           "record_count, dataset_version, part_count, provider, published_to_s3)")
        for profile in inventory.PROFILES:
            for family in ("depth", "trade", "quote"):
                connection.execute("INSERT INTO partitions VALUES(?,?,?,?,?,?,?,?,?,?)",
                                   [json.dumps(profile, separators=(",", ":")), family, "2026-08-05",
                                    "databento/test/" + family, "a" * 64, 100, "version-1", 1, "databento", 1])
    return path


def test_inventory_covers_every_calendar_day_without_claiming_availability(tmp_path):
    path = catalog(tmp_path)
    pin = inventory.digest(path)
    value = inventory.plan(path, "2026-08", pin)
    assert value == inventory.plan(path, "2026-08", pin)
    assert len(value["sessions"]) == 124
    assert value["summary"] == {"AWAITING_FULL_DAY_QUALIFICATION": 4, "SOURCE_ABSENT": 120}
    assert not any(day["available"] for day in value["sessions"])
    assert sum(len(day["sources"]) for day in value["sessions"]) == 10
    assert {(day["instrument"], day["date"]) for day in value["sessions"]} == {
        (profile[2], f"2026-08-{day:02d}") for profile in inventory.PROFILES for day in range(1, 32)}


def test_sparse_unpublished_and_missing_reference_sources_are_distinct(tmp_path):
    path = catalog(tmp_path)
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE partitions SET record_count=1 WHERE instrument_id LIKE '%ESU6%' AND family='depth'")
        connection.execute("UPDATE partitions SET published_to_s3=0 WHERE instrument_id LIKE '%NQU6%' AND family='trade'")
        connection.execute("DELETE FROM partitions WHERE instrument_id LIKE '%AAPL%' AND family='quote'")
    value = inventory.plan(path, "2026-08", inventory.digest(path))
    reasons = {day["instrument"]: day["reason"] for day in value["sessions"] if day["date"] == "2026-08-05"}
    assert reasons == {"ESU6": "SINGLE_SNAPSHOT_SOURCE_WITH_TRADES", "NQU6": "SOURCE_NOT_PUBLISHED",
                       "AAPL": "SOURCE_ABSENT", "TSLA": "AWAITING_FULL_DAY_QUALIFICATION"}


def test_ambiguous_versions_and_changed_catalog_are_refused(tmp_path):
    path = catalog(tmp_path)
    pin = inventory.digest(path)
    with sqlite3.connect(path) as connection:
        connection.execute("INSERT INTO partitions SELECT instrument_id,family,date,s3_prefix,manifest_sha256,"
                           "record_count,'version-2',part_count,provider,published_to_s3 FROM partitions LIMIT 1")
    with pytest.raises(ValueError, match="catalog pin"):
        inventory.plan(path, "2026-08", pin)
    with pytest.raises(ValueError, match="ambiguous"):
        inventory.plan(path, "2026-08", inventory.digest(path))


def test_inventory_refuses_changes_during_read(tmp_path, monkeypatch):
    path = catalog(tmp_path)
    pin = inventory.digest(path)
    calls = iter([pin, "b" * 64])
    monkeypatch.setattr(inventory, "digest", lambda _path: next(calls))
    with pytest.raises(ValueError, match="changed during"):
        inventory.plan(path, "2026-08", pin)


@pytest.mark.parametrize("month", ["2026-8", "2026-00", "2026-13", "2026-08-01"])
def test_invalid_month_is_refused(tmp_path, month):
    path = catalog(tmp_path)
    with pytest.raises(ValueError):
        inventory.plan(path, month, inventory.digest(path))
