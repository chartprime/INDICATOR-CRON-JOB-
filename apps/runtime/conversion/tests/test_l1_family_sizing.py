import hashlib
import io
import json
import math
import sqlite3
from collections import defaultdict

import duckdb
import pytest

import catalog
import l1_family_sizing as sizing
import s3_publish


T0 = 1_756_684_800_000_000_000
MINUTE = 60 * 1_000_000_000
SECOND = 1_000_000_000


class S3Error(Exception):
    def __init__(self, status):
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}}


class FakeS3:
    def __init__(self):
        self.objects = {}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise S3Error(404)
        data = self.objects[Key]
        return {"Body": io.BytesIO(data), "ETag": hashlib.sha256(data).hexdigest()}


def synthetic_trades():
    # A day's worth of shapes, not volume: ties at one timestamp, more than four
    # buys inside one minute (the prints cap), trades one second apart inside a
    # 2 s slice (slice width), an UNKNOWN side and a null side (excluded from
    # buy/sell but counted), a CANCEL row (not an execution), and prices on
    # both sides of a 0.25 bucket edge (floor, not round).
    rows = []
    rows += [(T0 + i * SECOND, 100.25, 1.0, "BUY", "NEW") for i in range(6)]
    rows += [(T0 + 10 * SECOND, 100.26, 2.0, "SELL", "NEW")] * 3
    rows += [(T0 + 11 * SECOND, 100.49, 5.0, "SELL", "NEW")]
    rows += [(T0 + 12 * SECOND, 100.50, 0.5, "UNKNOWN", "NEW")]
    rows += [(T0 + 13 * SECOND, 100.74, 0.5, None, "NEW")]
    rows += [(T0 + 14 * SECOND, 100.75, 9.0, "BUY", "CANCEL")]
    rows += [(T0 + MINUTE + 3 * SECOND, 101.0, 3.0, "BUY", "NEW"), (T0 + MINUTE + 4 * SECOND, 101.0, 4.0, "SELL", "NEW")]
    rows += [(T0 + 5 * MINUTE + 59 * SECOND + 999_000_000, 99.99, 1.5, "SELL", "NEW")]
    return rows


def write_parquet(path, rows):
    connection = duckdb.connect()
    try:
        connection.execute(
            "CREATE TABLE t (event_ns UBIGINT, price DECIMAL(38,12), size DECIMAL(38,12), side VARCHAR, trade_action VARCHAR)"
        )
        connection.executemany("INSERT INTO t VALUES (?, ?, ?, ?, ?)", rows)
        connection.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        connection.close()
    return path.read_bytes()


def expected(rows, tick):
    executed = [r for r in rows if r[4] == "NEW"]
    minute = lambda ns: ns // MINUTE
    slice_ = lambda ns: ns // (2 * SECOND)
    bucket = lambda price: math.floor(price / tick + 1e-9)
    minutes = {minute(r[0]) for r in executed}
    levels = {(minute(r[0]), bucket(r[1])) for r in executed}
    slices = {slice_(r[0]) for r in executed if r[3] in ("BUY", "SELL")}
    per_minute_side = defaultdict(int)
    for r in executed:
        if r[3] in ("BUY", "SELL"):
            per_minute_side[(minute(r[0]), r[3])] += 1
    prints = sum(min(4, n) for n in per_minute_side.values())
    per_minute = defaultdict(int)
    for r in executed:
        per_minute[minute(r[0])] += 1
    return {
        "trades_new": len(executed), "minutes": len(minutes), "levels": len(levels), "slices": len(slices),
        "prints": prints, "max_per_minute": max(per_minute.values()),
    }


def test_measure_parts_matches_an_independent_computation_on_every_family(tmp_path):
    rows = synthetic_trades()
    part = tmp_path / "part-00000.parquet"
    write_parquet(part, rows)
    result = sizing.measure_parts([part.as_posix()], tick_size=0.25, coarse_ticks=4)
    want = expected(rows, 0.25)
    assert result["rows_total"] == len(rows)
    assert result["trades_new"] == want["trades_new"]
    assert result["actions"] == {"CANCEL": 1, "NEW": len(rows) - 1}
    assert result["sides"] == {"BUY": 7, "NULL": 1, "SELL": 6, "UNKNOWN": 1}
    assert result["minutes_with_trades"] == want["minutes"]
    assert result["max_trades_per_minute"] == want["max_per_minute"]
    families = result["families"]
    assert families["trade_minute_1m"]["rows"] == want["minutes"]
    assert families["trade_level_1m"]["rows"] == want["levels"]
    assert families["trade_slice_2s"]["rows"] == want["slices"]
    assert families["trade_prints_1m"]["rows"] == want["prints"]
    assert families["trade_level_1m_coarse"]["rows"] == len({(r[0] // MINUTE, math.floor(r[1] / 1.0 + 1e-9)) for r in rows if r[4] == "NEW"})
    assert families["trade_level_1m_coarse"]["ticks"] == 4
    for figures in families.values():
        assert 0 < figures["gzip_bytes"] <= figures["json_bytes"]
        assert figures["json_bytes"] >= figures["rows"]


def test_the_shapes_the_probe_exists_to_distinguish_are_all_present():
    rows = synthetic_trades()
    want = expected(rows, 0.25)
    assert want["prints"] < sum(1 for r in rows if r[4] == "NEW" and r[3] in ("BUY", "SELL"))
    assert want["slices"] < sum(1 for r in rows if r[4] == "NEW" and r[3] in ("BUY", "SELL"))
    assert want["levels"] > want["minutes"]
    assert expected(rows, 0.25)["levels"] != len({(r[0] // MINUTE, round(r[1] / 0.25)) for r in rows if r[4] == "NEW"})


def _snapshot_and_store(tmp_path, part_bytes, record_count):
    snapshot = tmp_path / "catalog.sqlite"
    prefix = "XCME_FUTURE_ESU6_USD_CONTRACT-27fd4585/trade/v2/2026-08-04"
    manifest = {
        "record_count": record_count,
        "parts": [{"name": "part-00000.parquet", "bytes": len(part_bytes),
                   "sha256": hashlib.sha256(part_bytes).hexdigest(), "row_count": record_count}],
        "validation": {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True},
    }
    manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
    with sqlite3.connect(snapshot) as connection:
        connection.executescript(catalog._DDL)
        connection.execute(
            "INSERT INTO dataset_versions VALUES (?, ?, ?, ?, ?, ?)",
            ("v2", "2026-09-16T00:00:00+00:00", "conversion/0.2", "market-observation/1", None, "PUBLISHED"),
        )
        for date, count in (("2026-08-04", record_count), ("2026-08-03", 5), ("2026-08-05", 40)):
            connection.execute(
                "INSERT INTO partitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("XCME_FUTURE_ESU6_USD_CONTRACT", "trade", "v2", date, "databento", prefix.replace("2026-08-04", date),
                 1, count, 0, T0, T0 + 6 * MINUTE, "l" * 64,
                 hashlib.sha256(manifest_bytes).hexdigest(), "2026-09-16T00:00:00+00:00", 1),
            )
    client = FakeS3()
    store = s3_publish.Store(client, "bucket", "curated/databento")
    client.objects[store.key(prefix + "/_manifest.json")] = manifest_bytes
    client.objects[store.key(prefix + "/part-00000.parquet")] = part_bytes
    return snapshot, store, client


def test_measure_partition_resolves_verifies_downloads_measures_and_cleans_up(tmp_path):
    rows = synthetic_trades()
    part_bytes = write_parquet(tmp_path / "source.parquet", rows)
    snapshot, store, client = _snapshot_and_store(tmp_path, part_bytes, len(rows))
    scratch = tmp_path / "scratch"
    day = sizing.measure_partition(store, snapshot, "XCME_FUTURE_ESU6_USD_CONTRACT", "2026-08-04", scratch, tick_size=0.25)
    assert day["record_count"] == len(rows)
    assert day["curated_bytes"] == len(part_bytes)
    assert day["families"]["trade_prints_1m"]["rows"] == expected(rows, 0.25)["prints"]
    assert not any(scratch.rglob("*.parquet"))
    assert sizing.busiest_days(snapshot, "XCME_FUTURE_ESU6_USD_CONTRACT", "2026-08")[0]["date"] == "2026-08-05"

    client.objects[store.key("XCME_FUTURE_ESU6_USD_CONTRACT-27fd4585/trade/v2/2026-08-04/part-00000.parquet")] = part_bytes[:-1]
    with pytest.raises(sizing.SizingError, match="REMOTE_ARTIFACT_MISMATCH"):
        sizing.measure_partition(store, snapshot, "XCME_FUTURE_ESU6_USD_CONTRACT", "2026-08-04", scratch, tick_size=0.25)
    assert not any(scratch.rglob("*.parquet"))
    with pytest.raises(sizing.SizingError, match="PARTITION_NOT_CATALOGUED"):
        sizing.measure_partition(store, snapshot, "XCME_FUTURE_ESU6_USD_CONTRACT", "2026-08-09", scratch, tick_size=0.25)


def test_summary_totals_rows_and_bytes_per_instrument_and_keeps_the_busiest_day():
    days = [
        {"instrument_id": "A", "trades_new": 10, "families": {"trade_slice_2s": {"rows": 3, "json_bytes": 30, "gzip_bytes": 20}}},
        {"instrument_id": "A", "trades_new": 20, "families": {"trade_slice_2s": {"rows": 7, "json_bytes": 70, "gzip_bytes": 40}}},
        {"instrument_id": "B", "trades_new": 1, "families": {"trade_slice_2s": {"rows": 1, "json_bytes": 9, "gzip_bytes": 9}}},
    ]
    summary = sizing.summarise(days)
    assert summary["A"] == {"days": 2, "trades_new": 30, "families": {"trade_slice_2s": {"rows": 10, "json_bytes": 100, "gzip_bytes": 60, "max_day_rows": 7}}}
    assert summary["B"]["families"]["trade_slice_2s"]["max_day_rows"] == 1
