"""Tardis trades as one ordered stream per series-month.

Tardis cuts its daily files by receive time; partitions are dated by exchange
time. A trade executed at 23:59:59.9996 and received after midnight sits in the
next day's file but belongs to the previous day, so each date is built from its
own file plus whatever the next file spilled back into it, in arrival order.
"""
from __future__ import annotations

import datetime as dt
import gzip
import io
import json
import os
from decimal import Decimal

import duckdb
import pytest
import derive_families

from test_backfill_driver import FakeBucket
import backfill_driver
import backfill_sequence
import job
import raw_source
import tardis_decode
import trade_families

HEADER = "exchange,symbol,timestamp,local_timestamp,id,side,price,amount"
D0 = "2025-10-10"
D1 = "2025-10-11"


def _us(day, seconds):
    base = dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc)
    return int(base.timestamp() * 1_000_000) + int(round(seconds * 1_000_000))


def _file(tmp_path, name, rows, header=HEADER):
    path = tmp_path / name
    with gzip.open(path, "wt", encoding="utf-8", newline="") as fh:
        fh.write(header + "\n")
        for row in rows:
            fh.write(",".join(str(v) for v in row) + "\n")
    return str(path)


def _key(day):
    y, m, d = day.split("-")
    return (f"raw/tardis/exchange=binance-futures/data_type=trades/symbol=BTCUSDT/year={y}/month={m}/day={d}/"
            f"binance-futures_trades_{day}_BTCUSDT.csv.gz")


def _trade(day, seconds, received_seconds, trade_id, side="buy", price="113000.1", amount="0.002"):
    return ("binance-futures", "BTCUSDT", _us(day, seconds), _us(day, received_seconds), trade_id, side, price, amount)


def _stream(tmp_path):
    day0 = [
        _trade("2025-10-09", 86399.998, 86400.003, 100),
        _trade(D0, 1.0, 1.004, 101),
        _trade(D0, 86399.999, 86399.9995, 102),
    ]
    day1 = [
        _trade(D0, 86399.999, 86400.0021, 103, side="sell"),
        _trade(D1, 0.0, 0.001, 104),
        _trade(D1, 5.0, 5.003, 105),
    ]
    return [
        {"local_path": _file(tmp_path, "d0.csv.gz", day0), "s3_key": _key(D0)},
        {"local_path": _file(tmp_path, "d1.csv.gz", day1), "s3_key": _key(D1)},
    ]


def test_the_stream_keeps_window_rows_in_arrival_order_and_accounts_for_every_other_row(tmp_path):
    files = _stream(tmp_path)
    counts = []
    rows = list(tardis_decode.stream_rows(files, "trades", D0, D0, counts))
    assert [row["id"] for _, row in rows] == ["101", "102", "103"]
    assert [position for position, _ in rows] == [1, 2, 3]
    assert [(row["file"], row["file_row"]) for _, row in rows] == [(0, 1), (0, 2), (1, 0)]
    assert counts == [
        {"s3_key": _key(D0), "rows": 3, "kept": 2, "before_window": 1, "after_window": 0},
        {"s3_key": _key(D1), "rows": 3, "kept": 1, "before_window": 0, "after_window": 2},
    ]


def test_a_changed_header_or_a_short_row_stops_the_stream(tmp_path):
    bad = [{"local_path": _file(tmp_path, "h.csv.gz", [], header=HEADER.replace("amount", "qty")), "s3_key": _key(D0)}]
    with pytest.raises(tardis_decode.TardisDecodeError, match="TARDIS_HEADER_MISMATCH"):
        list(tardis_decode.stream_rows(bad, "trades", D0, D0, []))
    short = [{"local_path": _file(tmp_path, "s.csv.gz", [("binance-futures", "BTCUSDT", "1")]), "s3_key": _key(D0)}]
    with pytest.raises(tardis_decode.TardisDecodeError, match="TARDIS_ROW_WIDTH"):
        list(tardis_decode.stream_rows(short, "trades", D0, D0, []))


def _roots(tmp_path):
    return {"staging_root": str(tmp_path / "staging"), "curated_root": str(tmp_path / "curated"),
            "catalog_root": str(tmp_path / "curated" / "_catalog")}


def _stream_input(tmp_path, first=D0, last=D0):
    return {"stream": _stream(tmp_path), "s3_key": raw_source.raw_prefix("binance-futures", "trades", "BTCUSDT") + f"stream={first}..{last}",
            "schema": "trades", "dataset": "binance-futures", "symbol": "BTCUSDT", "window": [first, last],
            "last_modified": "2026-09-26T00:00:00+00:00"}


def _partition_rows(tmp_path, version, date):
    root = tmp_path / "curated" / "binance"
    parts = sorted(str(p) for p in root.rglob(f"trade/{version}/{date}/part-*.parquet"))
    assert parts, "no published parts"
    return duckdb.connect().execute(
        "SELECT trade_entity_id, event_ns, stable_position, lineage_sha256, lineage_row, source_provider, "
        "source_dataset, time_origin, time_precision, side, market, venue FROM read_parquet(?) "
        "ORDER BY event_ns, source_rank, stable_position, ordinal", [parts]).fetchall()


def test_a_cross_midnight_trade_lands_on_its_exchange_date_with_its_own_file_lineage(tmp_path):
    item = _stream_input(tmp_path)
    shas = {f["s3_key"]: job._convert._sha256_file(f["local_path"]) for f in item["stream"]}
    result = job.run_job([item], "tardis-2025-10", **_roots(tmp_path))
    assert result["fully_published"] is True
    assert [p.split("/")[0] for p in result["partitions"]] == ["binance"]

    rows = _partition_rows(tmp_path, "tardis-2025-10", D0)
    assert [r[0] for r in rows] == ["101", "102", "103"]
    assert [(r[3], r[4]) for r in rows] == [(shas[_key(D0)], 1), (shas[_key(D0)], 2), (shas[_key(D1)], 0)]
    assert rows[1][1] == rows[2][1] and rows[1][2] < rows[2][2]
    assert {(r[5], r[6], r[7], r[8], r[10], r[11]) for r in rows} == {
        ("TARDIS", "binance-futures", "EXCHANGE", "ms", "PERPETUAL", "BINANCE")}

    manifest_path = next((tmp_path / "curated" / "binance").rglob(f"trade/tardis-2025-10/{D0}/_manifest.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert sorted(o["s3_key"] for o in manifest["source_objects"]) == sorted([_key(D0), _key(D1)])

    checkpoint = json.loads(next((tmp_path / "staging").rglob("checkpoint.json")).read_text(encoding="utf-8"))
    counts = checkpoint["inputs"][0]["stream_counts"]
    assert sum(c["rows"] for c in counts) == sum(c["kept"] + c["before_window"] + c["after_window"] for c in counts) == 6
    assert [e["date"] for e in checkpoint["authority_plan"]] == [D0]


def test_a_stream_resumes_without_reconverting_and_refuses_changed_files(tmp_path):
    item = _stream_input(tmp_path)
    first = job.run_job([item], "tardis-resume-2025-10", **_roots(tmp_path))
    again = job.run_job([item], "tardis-resume-2025-10", **_roots(tmp_path))
    assert again["partitions"] == first["partitions"]
    with open(item["stream"][1]["local_path"], "ab") as fh:
        fh.write(b"\x00")
    with pytest.raises(job.JobError, match="PUBLISHED_PARTITION_CONFLICT"):
        job.run_job([item], "tardis-resume-2025-10", **_roots(tmp_path))


def test_a_stream_window_is_part_of_the_checkpoint_identity(tmp_path):
    item = _stream_input(tmp_path)
    expanded = dict(item, window=[D0, D1])
    original_id = job.job_id_for([job._describe_input(**item)], "tardis-window")
    expanded_id = job.job_id_for([job._describe_input(**expanded)], "tardis-window")
    assert expanded_id != original_id


def test_a_present_but_empty_crypto_day_is_not_a_successful_month(tmp_path):
    client = FakeBucket()
    client.put_raw(_key(D0), _bytes([_trade(D0, 1.0, 1.004, 101)]))
    client.put_raw(_key(D1), _bytes([]))
    client.put_raw(_key("2025-10-12"), _bytes([_trade("2025-10-12", 5.0, 5.003, 105)]))
    with pytest.raises(job.JobError, match=f"TARDIS_DAY_HAS_NO_SOURCE_ROWS:{D1}"):
        backfill_driver.run_s3_backfill(
            "binance-futures", "trades", "BTCUSDT", [D0, D1], "tardis-empty-day",
            bucket="bucket", curated_prefix="curated/binance", min_free_bytes=1, client=client, **_roots(tmp_path))
    assert not any(key.startswith("curated/binance/") for key in client.objects)


def test_a_trade_delayed_beyond_the_next_receive_day_is_not_silently_filtered(tmp_path):
    files = [{"local_path": _file(tmp_path, "late.csv.gz", [_trade(D0, 1.0, 172800.004, 999)]),
              "s3_key": _key("2025-10-12")}]
    with pytest.raises(tardis_decode.TardisDecodeError, match="TARDIS_RECEIVE_DAY_LOOKAHEAD_EXCEEDED"):
        list(tardis_decode.stream_rows(files, "trades", D1, D1, []))


def test_a_trade_stamped_after_midnight_but_received_before_it_is_kept_or_stops_the_window(tmp_path):
    files = [{"local_path": _file(tmp_path, "lag0.csv.gz", [_trade(D1, 0.004, -0.002, 106)]), "s3_key": _key(D0)},
             {"local_path": _file(tmp_path, "lag1.csv.gz", [_trade(D1, 5.0, 5.003, 107)]), "s3_key": _key(D1)}]
    rows = list(tardis_decode.stream_rows(files, "trades", D0, D1, []))
    assert [row["id"] for _, row in rows] == ["106", "107"]
    with pytest.raises(tardis_decode.TardisDecodeError, match=f"TARDIS_EXCHANGE_TIME_CROSSES_WINDOW_END:{_key(D0)}:0"):
        list(tardis_decode.stream_rows(files, "trades", D0, D0, []))


def test_a_trade_received_on_a_lagging_clock_keeps_its_exchange_time_and_carries_the_flag(tmp_path):
    files = [{"local_path": _file(tmp_path, "lag0.csv.gz", [_trade(D0, 1.0, 1.004, 101), _trade(D0, 2.010, 2.0, 102)]),
              "s3_key": _key(D0)},
             {"local_path": _file(tmp_path, "lag1.csv.gz", [_trade(D1, 5.0, 5.003, 103)]), "s3_key": _key(D1)}]
    item = dict(_stream_input(tmp_path), stream=files)
    assert job.run_job([item], "tardis-lag-2025-10", **_roots(tmp_path))["fully_published"] is True
    parts = sorted(str(p) for p in (tmp_path / "curated" / "binance").rglob(f"trade/tardis-lag-2025-10/{D0}/part-*.parquet"))
    rows = duckdb.connect().execute(
        "SELECT trade_entity_id, time_origin, event_ns::BIGINT - receive_ns::BIGINT, "
        "list_contains(quality_flags, 'RECEIVE_BEFORE_EXCHANGE_TIME') FROM read_parquet(?) ORDER BY event_ns", [parts]).fetchall()
    assert rows == [("101", "EXCHANGE", -4_000_000, False), ("102", "EXCHANGE", 10_000_000, True)]


@pytest.mark.parametrize("available", [("2025-09-07", "2026-09-25"), ("2025-09-06", "2026-08-30")])
def test_the_owner_window_cannot_silently_shrink_to_the_available_files(available):
    with pytest.raises(backfill_sequence.SequenceError, match="PHASE_WINDOW_COVERAGE_MISSING"):
        backfill_sequence._window_months(available, backfill_sequence.PHASE_WINDOWS["tardis-l1"])


def _bytes(rows):
    buffer = io.BytesIO()
    with gzip.open(buffer, "wt", encoding="utf-8", newline="") as fh:
        fh.write(HEADER + "\n")
        for row in rows:
            fh.write(",".join(str(v) for v in row) + "\n")
    return buffer.getvalue()


def test_a_tardis_month_downloads_its_days_and_the_next_publishes_under_binance_and_frees_the_raw(tmp_path):
    client = FakeBucket()
    client.put_raw(_key(D0), _bytes([_trade(D0, 1.0, 1.004, 101), _trade(D0, 86399.999, 86399.9995, 102)]))
    client.put_raw(_key(D1), _bytes([_trade(D0, 86399.999, 86400.0021, 103), _trade(D1, 5.0, 5.003, 104)]))
    client.put_raw(_key("2025-10-12"), _bytes([_trade("2025-10-12", 5.0, 5.003, 105)]))
    roots = _roots(tmp_path)
    outcome = backfill_driver.run_s3_backfill(
        "binance-futures", "trades", "BTCUSDT", [D0], "tardis-s3-2025-10",
        bucket="bucket", curated_prefix="curated/binance", min_free_bytes=1, client=client, **roots)
    assert outcome["fully_published"] is True
    [prefix] = outcome["results"][-1]["partitions"]
    assert prefix.startswith("binance/") and prefix.endswith(f"/trade/tardis-s3-2025-10/{D0}")
    manifest = json.loads(client.objects[f"curated/binance/{prefix}/_manifest.json"])
    assert manifest["record_count"] == 3
    assert sorted(o["s3_key"] for o in manifest["source_objects"]) == sorted([_key(D0), _key(D1)])
    assert not [n for n in os.listdir(os.path.join(roots["staging_root"], "_raw_cache")) if n.endswith(".csv.gz")]


def test_a_tardis_month_without_its_next_day_file_stops_before_downloading(tmp_path):
    client = FakeBucket()
    client.put_raw(_key(D0), _bytes([_trade(D0, 1.0, 1.004, 101)]))
    with pytest.raises(backfill_driver.BackfillError, match=f"TARDIS_DAY_FILE_MISSING:{D1}"):
        backfill_driver.run_s3_backfill("binance-futures", "trades", "BTCUSDT", [D0], "tardis-gap-2025-10",
                                        bucket="bucket", curated_prefix="curated/binance", min_free_bytes=1, client=client, **_roots(tmp_path))
    assert not os.path.exists(os.path.join(_roots(tmp_path)["staging_root"], "_raw_cache"))


def test_the_month_needs_every_day_file_and_the_next_one_exactly_once():
    def obj(day, name="x"):
        return {"s3_key": f"{name}-{day}", "covered_end": day, "etag": "e", "bytes": 1, "last_modified": "t"}
    ordered = backfill_driver._tardis_day_files([obj(D1), obj(D0)], D0, D1)
    assert [o["covered_end"] for o in ordered] == [D0, D1]
    with pytest.raises(backfill_driver.BackfillError, match=f"TARDIS_DAY_FILE_MISSING:{D1}"):
        backfill_driver._tardis_day_files([obj(D0)], D0, D1)
    with pytest.raises(backfill_driver.BackfillError, match=f"TARDIS_DAY_FILE_AMBIGUOUS:{D0}"):
        backfill_driver._tardis_day_files([obj(D0), obj(D0, "y"), obj(D1)], D0, D1)


def test_tardis_raw_listing_reads_its_own_namespace_and_databento_is_unchanged():
    assert raw_source.raw_prefix("binance", "trades", "ETHUSDT") == "raw/tardis/exchange=binance/data_type=trades/symbol=ETHUSDT/"
    assert raw_source.raw_prefix("GLBX.MDP3", "mbp-1", "ES") == "raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=ES/"


def test_the_crypto_phase_is_clamped_to_the_owner_window_and_selects_spot_and_perpetual_apart():
    months = backfill_sequence._window_months(("2025-09-06", "2026-09-25"), backfill_sequence.PHASE_WINDOWS["tardis-l1"])
    assert months[0] == ("2025-09-06", "2025-09-30")
    assert months[-1] == ("2026-08-01", "2026-08-31")
    assert len(months) == 12
    chosen = backfill_sequence.select_symbols("tardis-l1", ["binance:BTCUSDT", "binance-futures:ETHUSDT"])
    assert chosen == [("binance", "trades", "BTCUSDT", None), ("binance-futures", "trades", "ETHUSDT", None)]
    with pytest.raises(backfill_sequence.SequenceError, match="UNKNOWN_SYMBOL_FOR_PHASE"):
        backfill_sequence.select_symbols("tardis-l1", ["BTCUSDT"])
    assert backfill_sequence.select_symbols("l1", ["ES"]) == [("GLBX.MDP3", "mbp-1", "ES", "ES")]


@pytest.mark.parametrize("dataset", ["BINANCE.SPOT", "BINANCE.UM"])
def test_the_family_qualification_cli_accepts_the_binance_datasets(monkeypatch, dataset):
    import derive_families_cli
    seen = {}
    monkeypatch.setattr(derive_families_cli.backfill_driver, "_build_s3_client", lambda: object())

    def run_symbol(ds, symbol, base_version, **kwargs):
        seen["args"] = (ds, symbol, kwargs["months"])
        return {"dataset": ds, "symbol": symbol, "market": "SPOT", "months": []}
    monkeypatch.setattr(derive_families_cli.derive_families, "run_symbol", run_symbol)
    code = derive_families_cli.main(["--dataset", dataset, "--symbol", "BTCUSDT", "--months", "2026-01",
                                     "--bucket", "b", "--curated-prefix", "p", "--staging-root", "s",
                                     "--curated-root", "c", "--catalog-root", "k"])
    assert code == 0 and seen["args"] == (dataset, "BTCUSDT", ["2026-01"])


def test_every_crypto_study_instrument_has_its_exchange_tick():
    for dataset, _schema, symbol, _definition in backfill_sequence.PHASE_SYMBOLS["tardis-l1agg"]:
        assert trade_families.declared_tick(dataset, symbol) is not None
    assert str(trade_families.declared_tick("BINANCE.UM", "BTCUSDT")) == "0.1"
    assert trade_families.declared_tick("BINANCE.UM", "SOLUSDT") is None


def test_derived_phase_refuses_missing_or_extra_source_days_before_workers(monkeypatch):
    import derive_families
    expected = list(backfill_driver.inclusive_date_range(*backfill_sequence.PHASE_WINDOWS["tardis-l1"]))
    monkeypatch.setattr(derive_families, "snapshot_path", lambda _root: "snapshot")
    dates = list(expected)
    monkeypatch.setattr(derive_families, "plan_symbol", lambda _snapshot, _dataset, _symbol: {
        "months": {month: [{"date": day} for day in dates if day[:7] == month]
                   for month in {day[:7] for day in dates}}
    })
    chosen = backfill_sequence.select_symbols("tardis-l1agg")
    backfill_sequence.validate_tardis_l1agg_sources(chosen, "catalog")
    dates.pop()
    with pytest.raises(backfill_sequence.SequenceError, match="DAY_COVERAGE_MISMATCH"):
        backfill_sequence.validate_tardis_l1agg_sources(chosen, "catalog")
    dates.append(expected[-1])
    dates.append("2026-09-01")
    with pytest.raises(backfill_sequence.SequenceError, match="MONTH_COVERAGE_MISMATCH"):
        backfill_sequence.validate_tardis_l1agg_sources(chosen, "catalog")


@pytest.mark.parametrize("exchange,dataset,market", [
    ("binance", "BINANCE.SPOT", "SPOT"), ("binance-futures", "BINANCE.UM", "PERPETUAL"),
])
@pytest.mark.parametrize("symbol", ["BTCUSDT", "ETHUSDT"])
def test_tardis_trades_publish_all_four_study_families_and_resume(tmp_path_factory, exchange, dataset, market, symbol):
    tmp_path = tmp_path_factory.mktemp("ta")
    client = FakeBucket()
    price = "113000.1" if symbol == "BTCUSDT" else "3000.01"
    def key(day):
        return _key(day).replace("binance-futures", exchange).replace("BTCUSDT", symbol)
    def row(day, seconds, entity, side, amount):
        return (exchange, symbol, _us(day, seconds), _us(day, seconds + 0.004), entity, side, price, amount)
    client.put_raw(key(D0), _bytes([row(D0, 1, 1, "buy", "0.002"), row(D0, 2, 2, "sell", "0.003")]))
    client.put_raw(key(D1), _bytes([row(D1, 1, 3, "buy", "0.004")]))
    roots = _roots(tmp_path)
    raw = backfill_driver.run_s3_backfill(exchange, "trades", symbol, [D0], "a1",
        bucket="bucket", curated_prefix="curated/binance", min_free_bytes=1, client=client, **roots)
    assert raw["fully_published"]
    kwargs = dict(bucket="bucket", curated_prefix="curated/binance", client=client, min_free_bytes=1,
                  **dict(roots, staging_root=str(tmp_path / "derived")))
    outcome = derive_families.run_symbol(dataset, symbol, "a1agg", **kwargs)
    month = outcome["months"][0]
    assert month["fully_published"] and outcome["market"] == market
    manifests = [json.loads(value) for key, value in client.objects.items()
                 if key.endswith("/_manifest.json") and "/a1agg-" in key]
    assert {m["family"] for m in manifests} == set(derive_families.PARTITION_FAMILIES)
    assert all(m["rejected_count"] == 0 for m in manifests)
    minute_key = next(key for key in client.objects if "/trade_minute_1m/a1agg-" in key and key.endswith(".parquet"))
    minute_path = tmp_path / "minute.parquet"
    minute_path.write_bytes(client.objects[minute_key])
    with duckdb.connect() as connection:
        row = connection.execute("SELECT source_provider, volume, buy_volume, sell_volume FROM read_parquet(?)",
                                 [str(minute_path)]).fetchone()
    assert row[0] == "TARDIS" and row[1:] == tuple(Decimal(v) for v in ("0.005", "0.002", "0.003"))
    before = dict(client.objects)
    again = derive_families.run_symbol(dataset, symbol, "a1agg", **kwargs)
    assert again["months"][0]["fully_published"] and client.objects == before
