"""PartitionWriter against real canonical records from the pinned fixtures."""
from __future__ import annotations

import hashlib
import json
import os
from decimal import Decimal

import duckdb
import pytest

import dbn
import identity
import writer
from bridge import ContractBridge

HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.normpath(os.path.join(HERE, "..", "..", "test", "contracts", "fixtures", "market-observation-v1"))
WORKER = os.path.normpath(os.path.join(HERE, "..", "..", "scripts", "convert", "contract-worker.js"))


def _records(fixture_name, schema):
    path = os.path.join(FX, fixture_name)
    raw = open(path, "rb").read()
    sha = hashlib.sha256(raw).hexdigest()
    meta = dbn.read_metadata(path, expected_schema=schema)
    mappings = identity.build_mappings(meta, sha)
    rows = [{"row": r, "position": i} for i, r in dbn.decode(path, expected_schema=schema)]
    ctx = {
        "mappings": mappings, "dataset": meta.dataset, "sourceSymbol": rows[0]["row"]["instrument_id"],
        "population": f"{meta.dataset}:{meta.schema}", "datasetVersion": "20260910T000000Z",
        "streamId": f"databento:{meta.dataset}:{meta.schema}", "schema": meta.schema,
        "ingestNs": "1789000000000000000", "lineage": {"object": f"file://{fixture_name}", "sha256": sha},
    }
    with ContractBridge(WORKER) as bridge:
        results = bridge.map_batch("b1", "DATABENTO", "mbp", rows, ctx)
    return [rec for r in results if r["ok"] for rec in r["records"]], sha


def _by_family(records, family):
    return [r for r in records if r["family"] == family]


def test_exact_validator_rejects_changed_price_with_same_ids_and_counts(tmp_path, monkeypatch):
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    for record in quotes:
        pw.add(record)
    enter = writer._StageTimer.__enter__
    def corrupt_before_validation(timer):
        if timer._name == "validate_content_round_trip":
            path = os.path.join(pw.dir, "part-00000.parquet")
            changed = path + ".changed"
            con = duckdb.connect()
            try:
                con.read_parquet(path).create("original")
                con.execute("COPY (SELECT * REPLACE (bid_price + 1 AS bid_price) FROM original) TO ? (FORMAT PARQUET)", [changed])
            finally:
                con.close()
            os.replace(changed, path)
        return enter(timer)
    monkeypatch.setattr(writer._StageTimer, "__enter__", corrupt_before_validation)
    with pytest.raises(writer.WriterError, match="PARQUET_VALUE_MISMATCH"):
        pw.finalize([{"s3_key": "raw/fixture", "sha256": sha}])
    assert not os.path.exists(os.path.join(pw.dir, "_manifest.json"))


def test_quote_partition_from_mbp1_writes_sorted_parquet_and_a_reconciled_manifest(tmp_path):
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    assert len(quotes) == 2

    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "20260910T000000Z", "2020-12-28")
    for rec in quotes:
        assert pw.add(rec)["accepted"] is True
    manifest = pw.finalize([{"s3_key": "raw/x.dbn", "sha256": sha, "bytes": 513}])

    assert manifest["record_count"] == 2
    assert manifest["rejected_count"] == 0
    assert manifest["event_ns_min"] == int(quotes[0]["time"]["eventNs"])
    assert manifest["validation"] == {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True}
    assert manifest["parts"][0]["sha256"] == writer._sha256_file(os.path.join(pw.dir, "part-00000.parquet"))

    part = os.path.join(pw.dir, "part-00000.parquet")
    con = duckdb.connect()
    try:
        rows = con.execute(
            "SELECT record_id, event_ns, bid_price, ask_price, quality_flags, source_schema "
            "FROM read_parquet(?) ORDER BY event_ns", [part]
        ).fetchall()
    finally:
        con.close()
    assert [r[0] for r in rows] == [q["id"] for q in quotes]
    assert rows[0][2] == Decimal("3720.25")
    assert rows[0][3] == Decimal("3720.5")
    assert rows[0][4] == ["DBN_FLAGS_128", "INGEST_NS_IS_CONVERSION_TIME", "SOURCE_AVAILABILITY_UNKNOWN"]
    assert rows[0][5] == "mbp-1"


def test_a_closed_input_reopens_without_losing_earlier_rows(tmp_path):
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    assert pw.add(quotes[0])["accepted"] is True
    pw.close_input()
    assert pw._fh.closed
    assert pw.add(quotes[1])["accepted"] is True
    manifest = pw.finalize([{"s3_key": "raw/x.dbn", "sha256": sha}])
    assert manifest["record_count"] == 2


def test_trade_partition_from_tbbo_carries_exact_price_and_dbn_fields(tmp_path):
    records, sha = _records("databento-tbbo.dbn", "tbbo")
    trades = _by_family(records, "trade")
    assert len(trades) == 2

    pw = writer.PartitionWriter(str(tmp_path), trades[0]["instrument"]["id"], "trade", "v1", "2020-12-28")
    for rec in trades:
        pw.add(rec)
    manifest = pw.finalize([{"s3_key": "raw/tbbo.dbn", "sha256": sha, "bytes": 513}])
    assert manifest["record_count"] == 2

    con = duckdb.connect()
    try:
        got = con.execute(
            "SELECT trade_action, side, price, dbn_source_action, dbn_publisher_id FROM read_parquet(?) ORDER BY event_ns",
            [os.path.join(pw.dir, "part-00000.parquet")],
        ).fetchone()
    finally:
        con.close()
    assert got[0] == "NEW"
    assert got[3] == "T"
    assert got[4] == 1


def test_scale_over_twelve_is_quarantined_not_written(tmp_path):
    records, _ = _records("databento-mbp1.dbn", "mbp-1")
    rec = json.loads(json.dumps(records[0]))
    rec["data"]["bid"]["price"] = {"coefficient": "1234567890123456789", "scale": 13}
    pw = writer.PartitionWriter(str(tmp_path), rec["instrument"]["id"], "quote", "v1", "2020-12-28")
    outcome = pw.add(rec)
    assert outcome["accepted"] is False
    assert outcome["reason"] == "DECIMAL_SCALE_EXCEEDS_12"
    assert pw.add(records[1])["accepted"] is True
    manifest = pw.finalize([])
    assert manifest["record_count"] == 1
    assert manifest["rejected_count"] == 1
    assert manifest["rejected_summary"] == {"DECIMAL_SCALE_EXCEEDS_12": 1}


def test_decimal_over_the_declared_parquet_precision_is_quarantined_not_deferred_to_finalize(tmp_path):
    records, _ = _records("databento-mbp1.dbn", "mbp-1")
    rec = json.loads(json.dumps(records[0]))
    rec["data"]["bid"]["price"] = {"coefficient": "9" * 39, "scale": 0}
    pw = writer.PartitionWriter(str(tmp_path), rec["instrument"]["id"], "quote", "v1", "2020-12-28")
    outcome = pw.add(rec)
    assert outcome == {"accepted": False, "reason": "DECIMAL_PRECISION_EXCEEDS_38"}
    assert pw.add(records[1])["accepted"] is True
    assert pw.finalize([])["rejected_summary"] == {"DECIMAL_PRECISION_EXCEEDS_38": 1}


def test_family_mismatch_and_empty_partition_are_errors(tmp_path):
    records, _ = _records("databento-mbp1.dbn", "mbp-1")
    pw = writer.PartitionWriter(str(tmp_path), records[0]["instrument"]["id"], "trade", "v1", "2020-12-28")
    with pytest.raises(writer.WriterError, match="FAMILY_MISMATCH"):
        pw.add(records[0])
    with pytest.raises(writer.WriterError, match="NO_RECORDS"):
        pw.finalize([])


def test_a_stale_part_file_from_a_prior_attempt_does_not_survive_a_fresh_writer(tmp_path):
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")

    first = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    stale_part = os.path.join(first.dir, "part-00003.parquet")
    with open(stale_part, "wb") as fh:
        fh.write(b"STALE DATA FROM A PRIOR ATTEMPT")
    stale_manifest = os.path.join(first.dir, "_manifest.json")
    with open(stale_manifest, "w", encoding="utf-8") as fh:
        fh.write("{\"stale\": true}")

    second = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    assert not os.path.exists(stale_part)
    assert not os.path.exists(stale_manifest)

    for rec in quotes:
        second.add(rec)
    manifest = second.finalize([{"s3_key": "raw/x.dbn", "sha256": sha, "bytes": 513}])

    on_disk = sorted(name for name in os.listdir(second.dir) if name.startswith("part-"))
    assert on_disk == [p["name"] for p in manifest["parts"]]


def _depth_records(fixture_name, schema):
    path = os.path.join(FX, fixture_name)
    raw = open(path, "rb").read()
    sha = hashlib.sha256(raw).hexdigest()
    meta = dbn.read_metadata(path, expected_schema=schema)
    mappings = identity.build_mappings(meta, sha)
    rows = [{"row": r, "position": i} for i, r in dbn.decode(path, expected_schema=schema)]
    ctx = {
        "mappings": mappings, "dataset": meta.dataset, "sourceSymbol": rows[0]["row"]["instrument_id"],
        "population": f"{meta.dataset}:{meta.schema}", "datasetVersion": "20260910T000000Z",
        "streamId": f"databento:{meta.dataset}:{meta.schema}", "schema": meta.schema,
        "ingestNs": "1789000000000000000", "lineage": {"object": f"file://{fixture_name}", "sha256": sha},
    }
    with ContractBridge(WORKER) as bridge:
        results = bridge.map_batch("b1", "DATABENTO", "depth", rows, ctx)
    return [rec for r in results if r["ok"] for rec in r["records"]], sha


def test_depth_partition_carries_book_levels_and_writer_supplied_continuity(tmp_path):
    records, sha = _depth_records("databento-mbp1.dbn", "mbp-1")
    depths = _by_family(records, "depth")
    assert len(depths) == 2  # both fixture rows produce a depth snapshot

    pw = writer.PartitionWriter(str(tmp_path), depths[0]["instrument"]["id"], "depth", "v1", "2020-12-28")
    with pytest.raises(writer.WriterError, match="DEPTH_REQUIRES_CONTINUITY"):
        pw.add(depths[0])  # continuity is mandatory for depth, not optional

    assert pw.add(depths[0], continuity={"continuity": "OK", "book_epoch": 0})["accepted"] is True
    assert pw.add(depths[1], continuity={"continuity": "GAP_SUSPECTED", "book_epoch": 1})["accepted"] is True
    manifest = pw.finalize([{"s3_key": "raw/x.dbn", "sha256": sha, "bytes": 513}])
    assert manifest["record_count"] == 2

    part = os.path.join(pw.dir, "part-00000.parquet")
    con = duckdb.connect()
    try:
        rows = con.execute(
            "SELECT depth_action, depth_model, depth_limit, bids, asks, reset, book_epoch, continuity "
            "FROM read_parquet(?) ORDER BY event_ns", [part]
        ).fetchall()
    finally:
        con.close()
    assert rows[0][0] == "SNAPSHOT" and rows[0][1] == "TOP_N" and rows[0][2] == 1
    assert rows[0][3] == [{"price": Decimal("3720.25"), "size": Decimal("24")}]  # bid_px_00/bid_sz_00
    assert rows[0][4] == [{"price": Decimal("3720.5"), "size": Decimal("11")}]  # ask_px_00/ask_sz_00
    assert rows[0][5] is True  # every mbp row is inherently a self-contained snapshot
    assert [r[6] for r in rows] == [0, 1]
    assert [r[7] for r in rows] == ["OK", "GAP_SUSPECTED"]


def test_a_non_depth_writer_rejects_a_continuity_argument(tmp_path):
    records, _ = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    with pytest.raises(writer.WriterError, match="CONTINUITY_ONLY_APPLIES_TO_DEPTH"):
        pw.add(quotes[0], continuity={"continuity": "OK", "book_epoch": 0})


def test_row_hash_expr_matches_identical_content_regardless_of_row_order():
    con = duckdb.connect()
    con.execute("CREATE TABLE a (id VARCHAR, price DECIMAL(38,12), bids STRUCT(price DECIMAL(38,12), size DECIMAL(38,12))[])")
    con.execute("CREATE TABLE b (id VARCHAR, price DECIMAL(38,12), bids STRUCT(price DECIMAL(38,12), size DECIMAL(38,12))[])")
    con.execute("INSERT INTO a VALUES ('r1', 1.5, [{'price': 10, 'size': 1}]), ('r2', 2.5, [{'price': 11, 'size': 2}])")
    con.execute("INSERT INTO b VALUES ('r2', 2.5, [{'price': 11, 'size': 2}]), ('r1', 1.5, [{'price': 10, 'size': 1}])")  # reversed order
    expr = writer._row_hash_expr({"id": None, "price": None, "bids": None})
    sum_a = con.execute(f"SELECT sum({expr}) FROM a").fetchone()[0]
    sum_b = con.execute(f"SELECT sum({expr}) FROM b").fetchone()[0]
    assert sum_a == sum_b


def test_row_hash_expr_catches_a_changed_scalar_value():
    con = duckdb.connect()
    con.execute("CREATE TABLE a (id VARCHAR, price DECIMAL(38,12))")
    con.execute("CREATE TABLE b (id VARCHAR, price DECIMAL(38,12))")
    con.execute("INSERT INTO a VALUES ('r1', 1.5), ('r2', 2.5)")
    con.execute("INSERT INTO b VALUES ('r1', 1.5), ('r2', 2.500000000001)")  # one price nudged
    expr = writer._row_hash_expr({"id": None, "price": None})
    sum_a = con.execute(f"SELECT sum({expr}) FROM a").fetchone()[0]
    sum_b = con.execute(f"SELECT sum({expr}) FROM b").fetchone()[0]
    assert sum_a != sum_b


def test_row_hash_expr_catches_a_changed_value_inside_a_nested_depth_array():
    # This is the case the writer actually has to catch: bids/asks are
    # LIST<STRUCT>, and a round-trip bug altering a level's price/size deep
    # inside that array must not slip past as "same row".
    con = duckdb.connect()
    con.execute("CREATE TABLE a (id VARCHAR, bids STRUCT(price DECIMAL(38,12), size DECIMAL(38,12))[])")
    con.execute("CREATE TABLE b (id VARCHAR, bids STRUCT(price DECIMAL(38,12), size DECIMAL(38,12))[])")
    con.execute("INSERT INTO a VALUES ('r1', [{'price': 10, 'size': 1}, {'price': 9, 'size': 5}])")
    con.execute("INSERT INTO b VALUES ('r1', [{'price': 10, 'size': 1}, {'price': 9, 'size': 500}])")  # size corrupted
    expr = writer._row_hash_expr({"id": None, "bids": None})
    sum_a = con.execute(f"SELECT sum({expr}) FROM a").fetchone()[0]
    sum_b = con.execute(f"SELECT sum({expr}) FROM b").fetchone()[0]
    assert sum_a != sum_b


def test_row_hash_expr_catches_a_missing_row():
    con = duckdb.connect()
    con.execute("CREATE TABLE a (id VARCHAR)")
    con.execute("CREATE TABLE b (id VARCHAR)")
    con.execute("INSERT INTO a VALUES ('r1'), ('r2')")
    con.execute("INSERT INTO b VALUES ('r1')")  # r2 silently dropped
    expr = writer._row_hash_expr({"id": None})
    sum_a, n_a = con.execute(f"SELECT sum({expr}), count(*) FROM a").fetchone()
    sum_b, n_b = con.execute(f"SELECT sum({expr}), count(*) FROM b").fetchone()
    assert n_a != n_b
    assert sum_a != sum_b


def test_a_real_finalize_run_actually_exercises_the_content_round_trip_check(tmp_path):
    # End-to-end proof (not just the SQL fragment in isolation): a genuine
    # PartitionWriter.finalize() over real records must produce a manifest
    # whose validation actually ran the round-trip check, not skip it.
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    for rec in quotes:
        pw.add(rec)
    manifest = pw.finalize([{"s3_key": "raw/x.dbn", "sha256": sha, "bytes": 513}])
    assert manifest["validation"]["round_trip_ok"] is True
    assert set(manifest["stage_timings_s"]) == {
        "materialize_staged", "split_plan", "sort_and_write_parts",
        "validate_count_and_uniqueness", "validate_sorted", "validate_content_round_trip",
    }
    assert all(isinstance(v, float) for v in manifest["stage_timings_s"].values())


def _finalize_capturing_duckdb_config(tmp_path, monkeypatch, sha, quotes):
    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    for rec in quotes:
        pw.add(rec)
    captured = {}
    real_connect = duckdb.connect

    def spy_connect(*args, **kwargs):
        captured.update(kwargs.get("config", {}))
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(writer.duckdb, "connect", spy_connect)
    pw.finalize([{"s3_key": "raw/x.dbn", "sha256": sha, "bytes": 513}])
    return captured


def test_finalize_defaults_to_a_generous_duckdb_memory_limit_not_the_512mb_that_oomed_on_real_nq_scale(tmp_path, monkeypatch):
    monkeypatch.delenv("TT_CONVERT_DUCKDB_MEMORY_BYTES", raising=False)
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    captured = _finalize_capturing_duckdb_config(tmp_path, monkeypatch, sha, quotes)
    assert captured["memory_limit"] == f"{writer.DUCKDB_MEMORY_LIMIT_BYTES_DEFAULT}B"
    assert writer.DUCKDB_MEMORY_LIMIT_BYTES_DEFAULT >= 4 * 1024**3


def test_finalize_respects_a_real_env_override_of_the_duckdb_memory_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_DUCKDB_MEMORY_BYTES", str(7 * 1024**3))
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    captured = _finalize_capturing_duckdb_config(tmp_path, monkeypatch, sha, quotes)
    assert captured["memory_limit"] == f"{7 * 1024**3}B"


def test_finalize_defaults_to_multiple_threads_not_the_single_thread_that_serialized_json_parsing(tmp_path, monkeypatch):
    monkeypatch.delenv("TT_CONVERT_FINALIZE_THREADS", raising=False)
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    captured = _finalize_capturing_duckdb_config(tmp_path, monkeypatch, sha, quotes)
    assert captured["threads"] == str(writer.FINALIZE_THREADS_DEFAULT)
    assert writer.FINALIZE_THREADS_DEFAULT > 1


def test_finalize_respects_a_real_env_override_of_the_thread_count(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_FINALIZE_THREADS", "3")
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    captured = _finalize_capturing_duckdb_config(tmp_path, monkeypatch, sha, quotes)
    assert captured["threads"] == "3"


def _finalize_at(tmp_path, monkeypatch, threads):
    monkeypatch.setenv("TT_CONVERT_FINALIZE_THREADS", str(threads))
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    for rec in quotes:
        pw.add(rec)
    manifest = pw.finalize([{"s3_key": "raw/x.dbn", "sha256": sha, "bytes": 513}])
    con = duckdb.connect()
    try:
        rows = con.execute(
            "SELECT * FROM read_parquet(?) ORDER BY event_ns, source_rank, stable_position, ordinal",
            [os.path.join(pw.dir, part["name"]) for part in manifest["parts"]],
        ).fetchall()
    finally:
        con.close()
    return manifest, rows


def test_finalize_output_is_identical_regardless_of_thread_count(tmp_path, monkeypatch):
    manifest_1, rows_1 = _finalize_at(tmp_path / "t1", monkeypatch, 1)
    manifest_16, rows_16 = _finalize_at(tmp_path / "t16", monkeypatch, 16)
    assert rows_1 == rows_16
    assert manifest_1["logical_sha256"] == manifest_16["logical_sha256"]
    assert manifest_1["record_count"] == manifest_16["record_count"]


def test_add_no_longer_sorts_json_keys_but_still_round_trips_correctly(tmp_path):
    records, sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    for rec in quotes:
        pw.add(rec)
    pw._fh.flush()
    with open(pw._ndjson, encoding="utf-8") as fh:
        first_line = fh.readline()
    keys = list(json.loads(first_line).keys())
    assert keys != sorted(keys), "expected insertion order (record_id first), not alphabetically sorted keys"
    assert keys[0] == "record_id"
    manifest = pw.finalize([{"s3_key": "raw/x.dbn", "sha256": sha, "bytes": 513}])
    assert manifest["record_count"] == len(quotes)
    assert manifest["validation"] == {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True}


def test_a_stale_duckdb_spill_directory_from_an_interrupted_attempt_is_removed_on_resume(tmp_path):
    records, _ = _records("databento-mbp1.dbn", "mbp-1")
    quote = _by_family(records, "quote")[0]
    first = writer.PartitionWriter(str(tmp_path), quote["instrument"]["id"], "quote", "v1", "2020-12-28")
    spill = os.path.join(first.dir, "_spill")
    os.makedirs(spill)
    marker = os.path.join(spill, "duckdb-interrupted.tmp")
    with open(marker, "wb") as fh:
        fh.write(b"stale spill bytes")

    second = writer.PartitionWriter(str(tmp_path), quote["instrument"]["id"], "quote", "v1", "2020-12-28")

    assert not os.path.exists(spill)
    second._fh.close()


@pytest.mark.parametrize("date", ["2025-9-2", "2025-09-02/../../escape", "", None])
def test_partition_writer_rejects_noncanonical_dates_before_creating_a_path(tmp_path, date):
    records, _ = _records("databento-mbp1.dbn", "mbp-1")
    quote = _by_family(records, "quote")[0]

    with pytest.raises(writer.WriterError, match="INVALID_PARTITION_DATE"):
        writer.PartitionWriter(str(tmp_path), quote["instrument"]["id"], "quote", "v1", date)

    assert not list(tmp_path.iterdir())


def test_instrument_slug_is_readable_and_collision_resistant():
    a = writer.instrument_slug('["XCME","FUTURE","ESH1","USD","CONTRACT"]')
    b = writer.instrument_slug('["XCME","FUTURE","ESH2","USD","CONTRACT"]')
    assert a.startswith("XCME_FUTURE_ESH1_USD_CONTRACT-")
    assert a != b and a.split("-")[-1] != b.split("-")[-1]


# ---------------------------------------------------------- derived families

_ES = {"venue": "XCME", "market": "FUTURE", "symbol": "ESU6", "currency": "USD", "sizeUnit": "CONTRACT", "contract": "ESU6"}
_ES_ID = '["XCME","FUTURE","ESU6","USD","CONTRACT"]'
_OPEN = 1_785_850_200_000_000_000
_SOURCE_SHA = "c" * 64


def _derived_context(record_family):
    return {
        "mappings": [{"provider": "DATABENTO", "dataset": "GLBX.MDP3", "sourceSymbol": "ESU6", "fromNs": "0",
                      "toNs": "18446744073709551614", "instrument": _ES, "mappingVersion": "derived-from-trade/1",
                      "reference": f"curated:{_SOURCE_SHA}"}],
        "dataset": "GLBX.MDP3", "sourceSymbol": "ESU6", "population": "GLBX.MDP3:mbp-1",
        "datasetVersion": "w606-l1agg-v1-glbx-mdp3-es-2026-08", "streamId": f"derived:trade:{record_family}",
        "schema": f"{record_family}/1", "ingestNs": "1790000000000000000",
        "lineage": {"object": f"curated://trade/{_SOURCE_SHA}", "sha256": _SOURCE_SHA},
    }


def _derived_rows(record_family):
    if record_family == "trade_minute":
        return [{"source_symbol": "ESU6", "open_ns": str(_OPEN + i * 60_000_000_000), "ordinal": "0", "volume": "42",
                 "buy_volume": "23", "sell_volume": "19", "undefined_volume": "0", "buy_notional": "176005.5",
                 "sell_notional": "145453.25", "trade_count": "318"} for i in range(3)]
    if record_family == "trade_level":
        return [{"source_symbol": "ESU6", "open_ns": str(_OPEN), "ordinal": str(i), "tick_size": "0.25",
                 "price_bucket": str(30630 + i), "volume": "5", "buy_volume": "2", "sell_volume": "2", "trade_count": "4"}
                for i in range(3)]
    if record_family == "trade_slice":
        return [{"source_symbol": "ESU6", "open_ns": str(_OPEN + i * 2_000_000_000), "ordinal": "0",
                 "last_trade_ns": str(_OPEN + i * 2_000_000_000 + 1_999_999_999), "buy_notional": "7657.5",
                 "sell_notional": "0", "trade_count": "1"} for i in range(3)]
    return [{"source_symbol": "ESU6", "open_ns": str(_OPEN), "ordinal": str(i), "side": "SELL", "rank": str(i + 1),
             "trade_ns": str(_OPEN + 30_000_000_000 + i), "price": "7657.25", "size": str(40 - i),
             "trade_entity_id": f"raw:{'a' * 64}:{91 + i}"} for i in range(3)]


def _derived_records(record_family):
    rows = [{"row": row, "position": index} for index, row in enumerate(_derived_rows(record_family))]
    with ContractBridge(WORKER) as bridge:
        results = bridge.map_batch("d1", "DATABENTO", record_family, rows, _derived_context(record_family))
    assert all(r["ok"] for r in results), [r.get("quarantine") for r in results if not r["ok"]]
    return [rec for r in results for rec in r["records"]]


@pytest.mark.parametrize("partition_family,record_family", sorted(writer.DERIVED_PARTITION_FAMILIES.items()))
def test_a_derived_partition_round_trips_its_columns_and_carries_the_derivation_block(tmp_path, partition_family, record_family):
    records = _derived_records(record_family)
    pw = writer.PartitionWriter(str(tmp_path), _ES_ID, partition_family, "v1", "2026-08-04")
    for record in records:
        assert pw.add(record)["accepted"]
    derivation = {"family_method": f"{record_family}/1", "source_partition": {"family": "trade", "manifest_sha256": _SOURCE_SHA}}
    manifest = pw.finalize([{"s3_key": "curated/x/_manifest.json", "sha256": _SOURCE_SHA}], derivation=derivation)

    assert manifest["family"] == partition_family and manifest["record_count"] == 3
    assert manifest["derivation"] == derivation
    con = duckdb.connect()
    try:
        columns = {row[0] for row in con.execute("DESCRIBE SELECT * FROM read_parquet(?)", [os.path.join(pw.dir, "part-00000.parquet")]).fetchall()}
        assert set(writer._FAMILY_COLUMNS[record_family]) <= columns
        assert set(writer._COMMON_COLUMNS) <= columns
        ordinals = [r[0] for r in con.execute("SELECT ordinal FROM read_parquet(?) ORDER BY event_ns, ordinal", [os.path.join(pw.dir, "part-00000.parquet")]).fetchall()]
        method = con.execute("SELECT DISTINCT method FROM read_parquet(?)", [os.path.join(pw.dir, "part-00000.parquet")]).fetchone()[0]
    finally:
        con.close()
    assert method == f"{record_family}/1"
    assert ordinals == [int(r["order"]["ordinal"]) for r in sorted(records, key=lambda r: (int(r["time"]["eventNs"]), int(r["order"]["ordinal"])))]


def test_a_derived_partition_refuses_the_wrong_geometry_and_a_missing_or_stray_derivation_block(tmp_path):
    minute = _derived_records("trade_minute")
    pw = writer.PartitionWriter(str(tmp_path), _ES_ID, "trade_slice_2s", "v1", "2026-08-04")
    with pytest.raises(writer.WriterError, match="FAMILY_MISMATCH"):
        pw.add(minute[0])
    with pytest.raises(writer.WriterError, match="UNSUPPORTED_FAMILY"):
        writer.PartitionWriter(str(tmp_path), _ES_ID, "trade_minute", "v1", "2026-08-04")
    pw = writer.PartitionWriter(str(tmp_path), _ES_ID, "trade_minute_1m", "v1", "2026-08-04")
    pw.add(minute[0])
    with pytest.raises(writer.WriterError, match="DERIVATION_BLOCK_MISMATCH"):
        pw.finalize([])
    pw = writer.PartitionWriter(str(tmp_path), _ES_ID, "trade_minute_1m", "v1", "2026-08-04")
    pw.add(minute[0])
    with pytest.raises(writer.WriterError, match="INVALID_DERIVATION_BLOCK"):
        pw.finalize([], derivation={})
    records, _sha = _records("databento-mbp1.dbn", "mbp-1")
    quotes = _by_family(records, "quote")
    pw = writer.PartitionWriter(str(tmp_path), quotes[0]["instrument"]["id"], "quote", "v1", "2020-12-28")
    pw.add(quotes[0])
    with pytest.raises(writer.WriterError, match="DERIVATION_BLOCK_MISMATCH"):
        pw.finalize([], derivation={"family_method": "x"})


def test_a_derived_slice_record_with_a_minute_interval_is_refused_by_the_geometry_guard(tmp_path):
    record = _derived_records("trade_slice")[0]
    record["data"]["closeNs"] = str(int(record["data"]["openNs"]) + 60_000_000_000)
    pw = writer.PartitionWriter(str(tmp_path), _ES_ID, "trade_slice_2s", "v1", "2026-08-04")
    with pytest.raises(writer.WriterError, match="BAR_INTERVAL_MISMATCH:trade_slice_2s"):
        pw.add(record)
