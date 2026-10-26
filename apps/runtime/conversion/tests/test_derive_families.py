"""The derived-family driver end to end: published trade partitions in, four
published families and a cumulative catalog out, through the real contract
bridge and a fake bucket. Resume, idempotence and every refusal are exercised
against the checkpoint and the remote state, not against log lines."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from pathlib import Path

import duckdb
import pytest

import backfill_sequence
import catalog as _catalog
import curated_partition
import derive_families as df
import s3_publish
import trade_families as tf
import trade_families_rederive as rederive
import writer as _writer
from test_backfill_driver import FakeBucket
from test_trade_families import GOLDEN, IDENTITY, write_trades

HERE = os.path.dirname(os.path.abspath(__file__))
SHORT_TMP_ROOT = Path(tempfile.gettempdir()) if os.name == "nt" else None


@pytest.fixture
def tmp_path(tmp_path):
    """Windows caps a path at 260 characters and a staged derived partition nests
    the version twice; the host is Linux. Keep the test tree short on Windows."""
    if SHORT_TMP_ROOT is None:
        yield tmp_path
        return
    import shutil
    short = Path(tempfile.mkdtemp(prefix="df-", dir=SHORT_TMP_ROOT))
    try:
        yield short
    finally:
        shutil.rmtree(short, ignore_errors=True)
WORKER = os.path.normpath(os.path.join(HERE, "..", "..", "scripts", "convert", "contract-worker.js"))
PREFIX = "curated/test"
SOURCE_VERSION = "w606-l1-v2-test-2026-08"
DATES = ("2026-08-03", "2026-08-04", "2026-08-05")
DAY_NS = 86_400_000_000_000


def _day_ns(date):
    import datetime as dt
    return int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000


def _trades_for(date, case):
    base = _day_ns(date) + 13 * 3_600_000_000_000 + 30 * 60_000_000_000
    return [{**t, "atMs": t["atMs"]} for t in case["trades"]], base


def _publish_trade_partition(bucket, tmp_path, instrument, date, case, *, corrupt=False, row_identity=None):
    """A curated trade partition in the fake bucket, as the L1 backfill would have left it."""
    identity = row_identity or IDENTITY[case["market"]]
    trades, base = _trades_for(date, case)
    part = tmp_path / "src" / instrument["slug"] / date / "part-00000.parquet"
    part.parent.mkdir(parents=True, exist_ok=True)
    import test_trade_families
    original = test_trade_families.BASE_NS
    test_trade_families.BASE_NS = base
    try:
        write_trades(part, trades, identity)
    finally:
        test_trade_families.BASE_NS = original
    data = part.read_bytes()
    if corrupt:
        data = data[:-1]
    prefix = f"databento/{instrument['slug']}/trade/{SOURCE_VERSION}/{date}"
    connection = duckdb.connect()
    try:
        low, high = connection.execute("SELECT min(event_ns), max(event_ns) FROM read_parquet(?)", [part.as_posix()]).fetchone()
    finally:
        connection.close()
    manifest = {
        "schema_version": "market-observation/1", "converter_version": "conversion/0.2", "contract_version": "market-observation/1",
        "roll_table_version": None, "instrument_id": IDENTITY[case["market"]]["instrument_id"], "family": "trade", "dataset_version": SOURCE_VERSION,
        "date": date, "source_objects": [{"s3_key": "raw/fixture", "sha256": "0" * 64}], "record_count": len(trades),
        "rejected_count": 0, "rejected_summary": {}, "event_ns_min": low, "event_ns_max": high, "logical_sha256": "1" * 64,
        "logical_sha256_format": "json-insertion-v2", "sort_key": list(_writer.SORT_KEY),
        "parts": [{"name": "part-00000.parquet", "bytes": len(part.read_bytes()), "sha256": hashlib.sha256(part.read_bytes()).hexdigest(),
                   "row_count": len(trades), "event_ns_min": low, "event_ns_max": high}],
        "validation": {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True},
    }
    manifest_bytes = json.dumps(manifest, indent=2).encode("utf-8")
    bucket.objects[f"{PREFIX}/{prefix}/part-00000.parquet"] = data
    bucket.objects[f"{PREFIX}/{prefix}/_manifest.json"] = manifest_bytes
    return manifest, hashlib.sha256(manifest_bytes).hexdigest(), prefix


def _world(tmp_path, market="EQUITY", dates=DATES, contracts=None, corrupt_date=None, row_identity=None):
    """A converter catalog whose CURRENT lists published trade partitions, mirrored in the bucket."""
    case = GOLDEN["cases"]["equity" if market == "EQUITY" else "futures"]
    identity = IDENTITY[market]
    bucket = FakeBucket()
    curated_root = tmp_path / "curated"
    catalog_root = curated_root / "_catalog"
    staging_root = tmp_path / "staging"
    for path in (curated_root, catalog_root, staging_root):
        path.mkdir(parents=True, exist_ok=True)
    instrument = {"id": identity["instrument_id"], "slug": _writer.instrument_slug(identity["instrument_id"])}
    db_path = tmp_path / "source.local.sqlite"
    builder = _catalog.CatalogBuilder(db_path)
    builder.record_dataset_version(SOURCE_VERSION)
    sources = {}
    for date in dates:
        manifest, sha, prefix = _publish_trade_partition(bucket, tmp_path, instrument, date, case, corrupt=(date == corrupt_date),
                                                         row_identity=row_identity)
        builder.record_partition(manifest, prefix, sha, published_to_s3=True)
        sources[date] = {"manifest": manifest, "sha": sha, "prefix": prefix}
    if market == "FUTURE":
        builder.record_roll_intervals([{
            "alias": "ES.n.0", "from_ns": _day_ns(dates[0]), "to_ns": _day_ns(dates[-1]) + DAY_NS, "instrument_id": "14160",
            "contract_code": "ESU6", "tick_size": "0.25", "multiplier": "50",
        }], "fixture-roll/1")
    builder.mark_published(SOURCE_VERSION)
    builder.close()
    pointer = _catalog.publish(catalog_root, db_path, SOURCE_VERSION)
    snapshot_bytes = (catalog_root / pointer["catalog_key"]).read_bytes()
    bucket.objects[f"{PREFIX}/_catalog/{pointer['catalog_key']}"] = snapshot_bytes
    bucket.objects[f"{PREFIX}/_catalog/CURRENT.json"] = json.dumps(pointer, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {"bucket": bucket, "store": s3_publish.Store(bucket, "bucket", PREFIX), "curated_root": curated_root,
            "catalog_root": catalog_root, "staging_root": staging_root, "case": case, "identity": identity,
            "instrument": instrument, "sources": sources, "pointer": pointer, "dataset": identity["source_dataset"],
            "symbol": identity["symbol"] if market == "EQUITY" else "ES"}


def _run(world, month="2026-08", **overrides):
    kwargs = {"client": world["bucket"], "bucket": "bucket", "curated_prefix": PREFIX,
              "staging_root": str(world["staging_root"]), "curated_root": str(world["curated_root"]),
              "catalog_root": str(world["catalog_root"]), "worker_path": WORKER, "min_free_bytes": 0, "months": [month]}
    kwargs.update(overrides)
    return df.run_symbol(world["dataset"], world["symbol"], df.BASE_VERSION, **kwargs)


def _remote_rows(world, version, family, date, prefix=PREFIX):
    slug = world["instrument"]["slug"]
    key = f"{prefix}/databento/{slug}/{family}/{version}/{date}/part-00000.parquet"
    path = world["staging_root"] / f"{family}-{date}.parquet"
    path.write_bytes(world["bucket"].objects[key])
    return rederive.read_published([path.as_posix()], _writer.DERIVED_PARTITION_FAMILIES[family])


def test_a_month_derives_four_published_families_per_day_and_a_cumulative_catalog(tmp_path):
    world = _world(tmp_path)
    outcome = _run(world)

    assert outcome["months"][0]["fully_published"] is True
    version = outcome["months"][0]["version"]
    assert version == f"{df.BASE_VERSION}-xnas-itch-aapl-2026-08"
    result = outcome["months"][0]["results"][0]
    assert len(result["partitions"]) == len(DATES) * 4 and result["empty_partitions"] == []
    bucket = world["bucket"]
    for date in DATES:
        for family in df.PARTITION_FAMILIES:
            key = f"{PREFIX}/databento/{world['instrument']['slug']}/{family}/{version}/{date}"
            manifest = json.loads(bucket.objects[key + "/_manifest.json"])
            assert manifest["derivation"]["source_partition"]["manifest_sha256"] == world["sources"][date]["sha"]
            assert manifest["derivation"]["family_method"] == tf.FAMILY_METHOD[df.PARTITION_FAMILIES[family]]
            assert manifest["source_objects"] == [{"s3_key": f"{PREFIX}/{world['sources'][date]['prefix']}/_manifest.json", "sha256": world["sources"][date]["sha"]}]
            assert not (world["curated_root"] / "databento" / world["instrument"]["slug"] / family / version / date).exists()
    current, _ = world["store"].get_json("_catalog/CURRENT.json")
    assert current["dataset_version"] == version and current["publisher_fence"] == world["pointer"]["publisher_fence"] + 1
    snapshot = world["catalog_root"] / current["catalog_key"]
    assert _catalog._sha256_file(snapshot) == current["catalog_sha256"]
    with sqlite3.connect(snapshot) as connection:
        families = dict(connection.execute("SELECT family, count(*) FROM partitions GROUP BY family").fetchall())
        published = connection.execute("SELECT count(*) FROM partitions WHERE published_to_s3=0").fetchone()[0]
        versions = dict(connection.execute("SELECT dataset_version, status FROM dataset_versions").fetchall())
    assert families == {"trade": len(DATES), "trade_minute_1m": len(DATES), "trade_level_1m": len(DATES),
                        "trade_slice_2s": len(DATES), "trade_prints_1m": len(DATES)}
    assert published == 0
    assert versions == {SOURCE_VERSION: "PUBLISHED", version: "PUBLISHED"}


def test_the_published_families_equal_the_independent_recomputation_of_their_source(tmp_path):
    world = _world(tmp_path)
    version = _run(world)["months"][0]["version"]
    for date in DATES:
        source = world["sources"][date]
        parts = curated_partition.fetch_verified(world["store"], {"instrument_id": world["instrument"]["id"], "family": "trade",
                                                                  "date": date, "s3_prefix": source["prefix"],
                                                                  "manifest_sha256": source["sha"], "record_count": None},
                                                 world["staging_root"] / "check")
        published = {record: _remote_rows(world, version, family, date) for family, record in df.PARTITION_FAMILIES.items()}
        report = rederive.compare(rederive.read_trades(parts), published, market="EQUITY", tick_size="0.01")
        assert all(entry["equal"] for entry in report.values()), report
        assert report["trade_level"]["rows"] == len(world["case"]["expected"]["trade_level"])


def test_a_qualification_run_reads_the_real_sources_and_publishes_only_into_its_own_namespace(tmp_path, monkeypatch):
    world = _world(tmp_path)
    qual_prefix = "curated/_qualification/test"
    qual_root = tmp_path / "qual" / "curated"
    qual_catalog = qual_root / "_catalog"
    qual_staging = tmp_path / "qual" / "staging"
    for path in (qual_root, qual_catalog, qual_staging):
        path.mkdir(parents=True)
    production_before = {k: v for k, v in world["bucket"].objects.items()}
    local_pointer_before = (world["catalog_root"] / "CURRENT.json").read_bytes()

    outcome = _run(world, curated_prefix=qual_prefix, curated_root=str(qual_root), catalog_root=str(qual_catalog),
                   staging_root=str(qual_staging), source_prefix=PREFIX, source_catalog_root=str(world["catalog_root"]))

    version = outcome["months"][0]["version"]
    assert outcome["months"][0]["fully_published"] is True
    slug = world["instrument"]["slug"]
    new_keys = {k for k in world["bucket"].objects if k not in production_before}
    assert new_keys and all(k.startswith(qual_prefix + "/") for k in new_keys)
    assert {k: v for k, v in world["bucket"].objects.items() if k in production_before} == production_before
    assert (world["catalog_root"] / "CURRENT.json").read_bytes() == local_pointer_before
    assert not (world["curated_root"] / "databento" / slug / "trade_minute_1m").exists()
    for date in DATES:
        manifest = json.loads(world["bucket"].objects[f"{qual_prefix}/databento/{slug}/trade_minute_1m/{version}/{date}/_manifest.json"])
        assert manifest["source_objects"] == [{"s3_key": f"{PREFIX}/{world['sources'][date]['prefix']}/_manifest.json",
                                               "sha256": world["sources"][date]["sha"]}]
    current = json.loads(world["bucket"].objects[f"{qual_prefix}/_catalog/CURRENT.json"])
    assert current["dataset_version"] == version
    with sqlite3.connect(qual_catalog / current["catalog_key"]) as connection:
        families = dict(connection.execute("SELECT family, count(*) FROM partitions GROUP BY family").fetchall())
        versions = dict(connection.execute("SELECT dataset_version, status FROM dataset_versions").fetchall())
    assert families == {"trade_minute_1m": len(DATES), "trade_level_1m": len(DATES), "trade_slice_2s": len(DATES),
                        "trade_prints_1m": len(DATES)}
    assert versions == {version: "PUBLISHED"}

    monkeypatch.setattr("backfill_driver._build_s3_client", lambda: world["bucket"])
    output = tmp_path / "rederive.json"
    code = rederive.main([
        "--snapshot", df.snapshot_path(world["catalog_root"]), "--bucket", "bucket", "--data-prefix", PREFIX,
        "--families-snapshot", df.snapshot_path(qual_catalog), "--families-prefix", qual_prefix,
        "--scratch", str(qual_staging), "--instrument", f"{world['instrument']['id']}:EQUITY:0.01",
        "--families-version", version, "--credentials", "convert", "--output", str(output),
        *[arg for date in DATES for arg in ("--date", date)],
    ])
    report = json.loads(output.read_text(encoding="utf-8"))
    assert code == 0 and report["equal"] is True and len(report["days"]) == len(DATES)
    assert all(day["candle_volume_check"]["skipped"].startswith("PARTITION_NOT_CATALOGUED") for day in report["days"])


def test_a_converter_catalog_written_before_the_provider_column_plans_and_derives(tmp_path):
    world = _world(tmp_path)
    snapshot = Path(df.snapshot_path(world["catalog_root"]))
    with sqlite3.connect(snapshot) as connection:
        connection.execute("ALTER TABLE partitions DROP COLUMN provider")
    assert "provider" not in {r[1] for r in sqlite3.connect(snapshot).execute("PRAGMA table_info(partitions)")}
    pointer = json.loads((world["catalog_root"] / "CURRENT.json").read_text(encoding="utf-8"))
    pointer["catalog_sha256"] = _catalog._sha256_file(snapshot)
    (world["catalog_root"] / "CURRENT.json").write_text(json.dumps(pointer), encoding="utf-8")
    world["bucket"].objects[f"{PREFIX}/_catalog/{pointer['catalog_key']}"] = snapshot.read_bytes()
    world["bucket"].objects[f"{PREFIX}/_catalog/CURRENT.json"] = json.dumps(pointer, sort_keys=True, separators=(",", ":")).encode("utf-8")

    resolved = curated_partition.resolve(snapshot, world["instrument"]["id"], "trade", DATES[0])
    assert resolved["provider"] == "databento" and resolved["published_to_s3"] is True
    outcome = _run(world)
    assert outcome["months"][0]["fully_published"] is True
    version = outcome["months"][0]["version"]
    key = f"{PREFIX}/databento/{world['instrument']['slug']}/trade_minute_1m/{version}/{DATES[0]}/_manifest.json"
    assert json.loads(world["bucket"].objects[key])["derivation"]["source_partition"]["date"] == DATES[0]


def test_a_futures_symbol_takes_its_contracts_and_tick_from_the_roll_table(tmp_path):
    world = _world(tmp_path, market="FUTURE", dates=DATES[:1])
    outcome = _run(world)
    version = outcome["months"][0]["version"]
    assert version == f"{df.BASE_VERSION}-glbx-mdp3-es-2026-08"
    levels = _remote_rows(world, version, "trade_level_1m", DATES[0])
    assert {row["tick_size"] for row in levels} == {"0.25"}
    assert [row["price_bucket"] for row in levels] == [str(r["priceBucket"]) for r in world["case"]["expected"]["trade_level"]]
    with pytest.raises(df.DeriveError, match="ROLL_TABLE_MISSING"):
        df.plan_symbol(df.snapshot_path(world["catalog_root"]), "GLBX.MDP3", "NQ")


def test_an_interrupted_month_resumes_without_republishing_and_a_finished_month_is_a_no_op(tmp_path, monkeypatch):
    world = _world(tmp_path)
    original = df._derive_source
    calls = []

    def stop_after_first_day(*args, **kwargs):
        calls.append(1)
        checkpoint = original(*args, **kwargs)
        if len(calls) == 1:
            raise RuntimeError("simulated crash after the first day")
        return checkpoint

    monkeypatch.setattr(df, "_derive_source", stop_after_first_day)
    with pytest.raises(RuntimeError, match="simulated crash"):
        _run(world)
    put_before = len([k for k in world["bucket"].objects if "/trade_minute_1m/" in k])
    assert put_before == 2

    monkeypatch.setattr(df, "_derive_source", original)
    puts = []
    world["bucket"].before_put = lambda key: puts.append(key)
    outcome = _run(world)
    assert outcome["months"][0]["fully_published"] is True
    assert not any("/2026-08-03/" in key and key.endswith("part-00000.parquet") for key in puts), "the first day was published once"
    assert sum(1 for key in puts if key.endswith("part-00000.parquet")) == (len(DATES) - 1) * 4

    puts.clear()
    again = _run(world)
    assert again["months"][0]["fully_published"] is True
    assert puts == []
    assert again["months"][0]["results"][0]["catalog_pointer"] == outcome["months"][0]["results"][0]["catalog_pointer"]


def test_a_source_whose_bytes_no_longer_match_its_manifest_is_refused(tmp_path):
    world = _world(tmp_path, dates=DATES[:2], corrupt_date=DATES[1])
    with pytest.raises(curated_partition.CuratedPartitionError, match="REMOTE_ARTIFACT_MISMATCH"):
        _run(world)
    assert not any("/2026-08-04/" in key and "/trade_minute_1m/" in key for key in world["bucket"].objects)
    assert not list((world["staging_root"]).rglob("_source/**/*.parquet"))


def test_an_unpublished_or_ambiguous_source_partition_is_refused_at_planning(tmp_path):
    world = _world(tmp_path, dates=DATES[:1])
    snapshot = df.snapshot_path(world["catalog_root"])
    scratch = tmp_path / "planning.sqlite"
    scratch.write_bytes(Path(snapshot).read_bytes())
    with sqlite3.connect(scratch) as connection:
        connection.execute("UPDATE partitions SET published_to_s3=0")
    with pytest.raises(df.DeriveError, match="SOURCE_PARTITION_NOT_PUBLISHED"):
        df.plan_symbol(scratch, world["dataset"], world["symbol"])
    with sqlite3.connect(scratch) as connection:
        connection.execute("UPDATE partitions SET published_to_s3=1")
        connection.execute(
            "INSERT INTO partitions SELECT instrument_id, family, 'other-version', date, provider, s3_prefix, part_count, "
            "record_count, rejected_count, event_ns_min, event_ns_max, logical_sha256, manifest_sha256, created_at, "
            "published_to_s3 FROM partitions")
    with pytest.raises(df.DeriveError, match="AUTHORITY_AMBIGUOUS"):
        df.plan_symbol(scratch, world["dataset"], world["symbol"])


def test_a_stale_catalog_pointer_and_a_source_whose_rows_belong_to_another_instrument_are_refused(tmp_path):
    world = _world(tmp_path, dates=DATES[:1])
    pointer = json.loads((world["catalog_root"] / "CURRENT.json").read_text(encoding="utf-8"))
    (world["catalog_root"] / "CURRENT.json").write_text(json.dumps({**pointer, "catalog_sha256": "f" * 64}), encoding="utf-8")
    with pytest.raises(df.DeriveError, match="CATALOG_INTEGRITY_FAILURE"):
        _run(world)

    tsla = {**IDENTITY["EQUITY"], "instrument_id": '["XNAS","EQUITY","TSLA","USD","SHARE"]', "symbol": "TSLA", "source_symbol": "TSLA"}
    swapped = _world(tmp_path / "swapped", dates=DATES[:1], row_identity=tsla)
    with pytest.raises(df.DeriveError, match="SOURCE_IDENTITY_MISMATCH"):
        _run(swapped)
    assert not any("/trade_minute_1m/" in key for key in swapped["bucket"].objects)


def test_the_sequence_routes_the_l1agg_phase_to_the_derived_driver_with_a_completion_receipt(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", "1")
    world = _world(tmp_path, dates=DATES[:2])
    outcomes = backfill_sequence.run_phase(
        "l1agg", df.BASE_VERSION, bucket="bucket", curated_prefix=PREFIX, staging_root=str(world["staging_root"]),
        curated_root=str(world["curated_root"]), catalog_root=str(world["catalog_root"]), min_free_bytes=0,
        client=world["bucket"], symbols=["AAPL"], worker_path=WORKER)

    assert [o["status"] for o in outcomes] == ["ok"]
    version = f"{df.BASE_VERSION}-xnas-itch-aapl-2026-08"
    receipt = json.loads((world["staging_root"] / "_sequence" / f"{version}-complete.json").read_text(encoding="utf-8"))
    assert receipt["intent"]["pointer"]["dataset_version"] == version
    assert receipt["outcome"]["fully_published"] is True
    puts = []
    world["bucket"].before_put = lambda key: puts.append(key)
    again = backfill_sequence.run_phase(
        "l1agg", df.BASE_VERSION, bucket="bucket", curated_prefix=PREFIX, staging_root=str(world["staging_root"]),
        curated_root=str(world["curated_root"]), catalog_root=str(world["catalog_root"]), min_free_bytes=0,
        client=world["bucket"], symbols=["AAPL"], worker_path=WORKER)
    assert [o["status"] for o in again] == ["ok"] and puts == []
    assert backfill_sequence.dataset_version_for_phase("l1agg") == df.BASE_VERSION
    assert [entry[2] for entry in backfill_sequence.select_symbols("l1agg")] == ["AAPL", "TSLA", "ES", "NQ"]


def test_the_sequence_can_publish_into_a_qualification_namespace_while_reading_the_real_sources(tmp_path, monkeypatch):
    # The production entry point itself has to be trialable: the same command,
    # the same routing, publishing where nothing is served from.
    monkeypatch.setenv("TT_CONVERT_GLOBAL_RESERVE_BYTES", "1")
    world = _world(tmp_path, dates=DATES[:2])
    qual_prefix = "curated/_qualification/sequence"
    qual_root = tmp_path / "q" / "curated"
    qual_catalog = qual_root / "_catalog"
    qual_staging = tmp_path / "q" / "staging"
    for path in (qual_root, qual_catalog, qual_staging):
        path.mkdir(parents=True)
    production_before = dict(world["bucket"].objects)

    outcomes = backfill_sequence.run_phase(
        "l1agg", df.BASE_VERSION, bucket="bucket", curated_prefix=qual_prefix, staging_root=str(qual_staging),
        curated_root=str(qual_root), catalog_root=str(qual_catalog), min_free_bytes=0, client=world["bucket"],
        symbols=["AAPL"], worker_path=WORKER, source_prefix=PREFIX, source_catalog_root=str(world["catalog_root"]))

    assert [o["status"] for o in outcomes] == ["ok"]
    new_keys = {k for k in world["bucket"].objects if k not in production_before}
    assert new_keys and all(k.startswith(qual_prefix + "/") for k in new_keys)
    assert {k: v for k, v in world["bucket"].objects.items() if k in production_before} == production_before
    version = f"{df.BASE_VERSION}-xnas-itch-aapl-2026-08"
    receipt = json.loads((qual_staging / "_sequence" / f"{version}-complete.json").read_text(encoding="utf-8"))
    assert receipt["outcome"]["fully_published"] is True
    assert len([k for k in new_keys if k.endswith("part-00000.parquet")]) == 2 * 4


def test_a_non_derived_phase_never_receives_the_derived_source_overrides(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(backfill_sequence, "_run_one_symbol",
                        lambda *args, **kwargs: seen.update(kwargs["job_kwargs"]) or {"status": "ok"})
    backfill_sequence.run_phase("ohlcv", "w606-ohlcv-v1", bucket="bucket", curated_prefix=PREFIX,
                                staging_root=str(tmp_path), curated_root=str(tmp_path), catalog_root=str(tmp_path),
                                min_free_bytes=0, client=object(), symbols=["AAPL"],
                                source_prefix="curated/_qualification/x", source_catalog_root=str(tmp_path))
    assert "source_prefix" not in seen and "source_catalog_root" not in seen


def test_a_symbol_with_nothing_to_derive_is_refused_not_reported_ok(tmp_path):
    # Pattern AE: a plan that finds nothing must not look like a finished symbol.
    world = _world(tmp_path, dates=DATES[:1])
    snapshot = df.snapshot_path(world["catalog_root"])
    with pytest.raises(df.DeriveError, match="NO_SOURCE_PARTITIONS:XNAS.ITCH:TSLA"):
        df.plan_symbol(snapshot, "XNAS.ITCH", "TSLA")
    with pytest.raises(df.DeriveError, match="NO_MONTHS_SELECTED"):
        _run(world, month="1999-01")
    assert not any("/trade_minute_1m/" in key for key in world["bucket"].objects)


def test_a_day_with_no_sided_execution_publishes_the_side_free_families_and_records_the_empty_ones(tmp_path):
    # Every trade of the day carries no aggressor side: minute and level rows
    # exist (all sides count there), slices and prints have nothing to say.
    world = _world(tmp_path, dates=DATES[:1],
                   row_identity=None)
    source = world["sources"][DATES[0]]
    trades, base = _trades_for(DATES[0], world["case"])
    unknown = [{**t, "side": "UNKNOWN"} for t in trades]
    import test_trade_families
    part = tmp_path / "unknown.parquet"
    original = test_trade_families.BASE_NS
    test_trade_families.BASE_NS = base
    try:
        write_trades(part, unknown, IDENTITY["EQUITY"])
    finally:
        test_trade_families.BASE_NS = original
    key = f"{PREFIX}/{source['prefix']}/part-00000.parquet"
    manifest_key = f"{PREFIX}/{source['prefix']}/_manifest.json"
    manifest = json.loads(world["bucket"].objects[manifest_key])
    manifest["parts"][0]["bytes"] = len(part.read_bytes())
    manifest["parts"][0]["sha256"] = hashlib.sha256(part.read_bytes()).hexdigest()
    manifest_bytes = json.dumps(manifest, indent=2).encode("utf-8")
    world["bucket"].objects[key] = part.read_bytes()
    world["bucket"].objects[manifest_key] = manifest_bytes
    snapshot = Path(df.snapshot_path(world["catalog_root"]))
    with sqlite3.connect(snapshot) as connection:
        connection.execute("UPDATE partitions SET manifest_sha256=? WHERE family='trade'", [hashlib.sha256(manifest_bytes).hexdigest()])
    pointer = json.loads((world["catalog_root"] / "CURRENT.json").read_text(encoding="utf-8"))
    pointer["catalog_sha256"] = _catalog._sha256_file(snapshot)
    (world["catalog_root"] / "CURRENT.json").write_text(json.dumps(pointer), encoding="utf-8")
    world["bucket"].objects[f"{PREFIX}/_catalog/{pointer['catalog_key']}"] = snapshot.read_bytes()
    world["bucket"].objects[f"{PREFIX}/_catalog/CURRENT.json"] = json.dumps(pointer, sort_keys=True, separators=(",", ":")).encode("utf-8")

    outcome = _run(world)

    result = outcome["months"][0]["results"][0]
    assert outcome["months"][0]["fully_published"] is True
    assert sorted(e["family"] for e in result["empty_partitions"]) == ["trade_prints_1m", "trade_slice_2s"]
    assert [p.split("/")[2] for p in result["partitions"]] == ["trade_level_1m", "trade_minute_1m"]
    minute = _remote_rows(world, outcome["months"][0]["version"], "trade_minute_1m", DATES[0])
    assert minute[0]["undefined_volume"] == minute[0]["volume"] and minute[0]["buy_notional"] == "0"
    with sqlite3.connect(world["catalog_root"] / outcome["months"][0]["results"][0]["catalog_pointer"]["catalog_key"]) as connection:
        assert dict(connection.execute("SELECT family, count(*) FROM partitions GROUP BY family").fetchall()) == \
            {"trade": 1, "trade_minute_1m": 1, "trade_level_1m": 1}
    again = _run(world)
    assert again["months"][0]["results"][0]["empty_partitions"] == result["empty_partitions"]
