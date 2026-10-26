"""End-to-end orchestration on the repo's pinned DBN fixtures."""
from __future__ import annotations

import json
import os
import sqlite3

import duckdb
import pytest

import catalog
import convert

HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.normpath(os.path.join(HERE, "..", "..", "test", "contracts", "fixtures", "market-observation-v1"))
MBP1 = os.path.join(FX, "databento-mbp1.dbn")
TBBO = os.path.join(FX, "databento-tbbo.dbn")


def _roots(tmp_path):
    return {
        "staging_root": str(tmp_path / "staging"),
        "curated_root": str(tmp_path / "curated"),
        "catalog_root": str(tmp_path / "curated" / "_catalog"),
    }


def test_full_spine_on_the_mbp1_fixture_publishes_a_partition_and_a_fenced_catalog(tmp_path):
    roots = _roots(tmp_path)
    summary = convert.convert_file(MBP1, "mbp-1", "20260910T000000Z", **roots)

    assert summary["accepted"] == 2
    assert summary["rejected"] == 0
    assert len(summary["partitions"]) == 1
    prefix = summary["partitions"][0]
    assert prefix.startswith("databento/XCME_FUTURE_ESH1_USD_CONTRACT-")
    assert prefix.endswith("/quote/20260910T000000Z/2020-12-28")

    part_dir = os.path.join(roots["curated_root"], prefix)
    assert os.path.isfile(os.path.join(part_dir, "part-00000.parquet"))
    manifest = json.loads(open(os.path.join(part_dir, "_manifest.json")).read())
    assert manifest["record_count"] == 2
    assert manifest["source_objects"][0]["sha256"] == summary["raw_sha256"]

    pointer = catalog.read_current(roots["catalog_root"])
    assert pointer["publisher_fence"] == 1
    snap = os.path.join(roots["catalog_root"], pointer["catalog_key"])
    con = sqlite3.connect(snap)
    try:
        row = con.execute("SELECT family, record_count, dataset_version, manifest_sha256 FROM partitions").fetchone()
        assert row[0] == "quote" and row[1] == 2 and row[2] == "20260910T000000Z"
        assert con.execute("SELECT status FROM dataset_versions").fetchone()[0] == "PUBLISHED"
    finally:
        con.close()

    con = duckdb.connect()
    try:
        n, distinct = con.execute(
            "SELECT count(*), count(DISTINCT record_id) FROM read_parquet(?)",
            [os.path.join(part_dir, "part-00000.parquet")],
        ).fetchone()
    finally:
        con.close()
    assert n == 2 and distinct == 2

    assert every_record_carries_conversion_ingest_ns(part_dir, summary["conversion_started_ns"])


def every_record_carries_conversion_ingest_ns(part_dir, started_ns):
    con = duckdb.connect()
    try:
        values = {r[0] for r in con.execute(
            "SELECT ingest_ns FROM read_parquet(?)", [os.path.join(part_dir, "part-00000.parquet")]
        ).fetchall()}
    finally:
        con.close()
    return values == {started_ns}


def test_tbbo_fixture_produces_both_trade_and_quote_partitions(tmp_path):
    roots = _roots(tmp_path)
    summary = convert.convert_file(TBBO, "tbbo", "v1", **roots)
    # tbbo = trade + BBO per record: 2 rows -> 2 trades + 2 quotes.
    assert summary["accepted"] == 4
    families = sorted(p.split("/")[2] for p in summary["partitions"])
    assert families == ["quote", "trade"]
    trade_dir = os.path.join(roots["curated_root"], next(p for p in summary["partitions"] if "/trade/" in p))
    con = duckdb.connect()
    try:
        action, side = con.execute(
            "SELECT trade_action, side FROM read_parquet(?) LIMIT 1", [os.path.join(trade_dir, "part-00000.parquet")]
        ).fetchone()
    finally:
        con.close()
    assert action == "NEW"


def test_rerunning_the_same_job_refuses_to_republish(tmp_path):
    roots = _roots(tmp_path)
    convert.convert_file(MBP1, "mbp-1", "v1", **roots)
    with pytest.raises(convert.ConversionError, match="PARTITION_ALREADY_PUBLISHED"):
        convert.convert_file(MBP1, "mbp-1", "v1", **roots)


def test_a_truncated_source_fails_the_job_and_publishes_nothing(tmp_path):
    roots = _roots(tmp_path)
    cut = tmp_path / "cut.mbp-1.dbn"
    cut.write_bytes(open(MBP1, "rb").read()[:-20])
    with pytest.raises(Exception):
        convert.convert_file(str(cut), "mbp-1", "v1", **roots)
    assert not os.path.exists(os.path.join(roots["curated_root"], "databento"))
    assert not os.path.exists(os.path.join(roots["catalog_root"], "CURRENT.json"))


def test_schema_family_routing_and_depth_deferral():
    assert convert._map_family_for("mbp-1") == "mbp"
    assert convert._map_family_for("tbbo") == "mbp"
    assert convert._map_family_for("ohlcv-1s") == "candle"
    assert convert._map_family_for("mbp-10") == "depth"
    with pytest.raises(convert.ConversionError, match="UNSUPPORTED_SCHEMA"):
        convert._map_family_for("statistics")
    # a real mbp-10 file would reach the DEPTH_CONVERSION_IS_PHASE_3 guard in convert_file;
    # no mbp-10 fixture ships in the repo, so the family routing above is the proxy.


def test_invalid_version_cannot_escape_output_roots(tmp_path):
    with pytest.raises(Exception, match="INVALID_DATASET_VERSION"):
        convert.convert_file(MBP1, "mbp-1", "../../escape", **_roots(tmp_path))
    assert not (tmp_path / "curated").exists()


def test_an_interrupted_publish_does_not_permanently_block_resume(tmp_path):
    # shutil.copytree is not atomic: a process kill partway through it left
    # a partial *destination* directory before this fix, which then
    # permanently blocked every future retry with PARTITION_ALREADY_PUBLISHED
    # -- exactly the failure mode a resumable job (job.py) must survive. The
    # fix copies into a `.publishing` staging sibling first; reproduce a
    # crash leaving that staging dir behind (populated, `dest` never
    # created) and confirm a retry still succeeds and cleans up after it.
    import writer as _writer

    roots = _roots(tmp_path)
    os.makedirs(roots["staging_root"])
    src = os.path.join(roots["staging_root"], "src")
    os.makedirs(src)
    with open(os.path.join(src, "part-00000.parquet"), "w") as fh:
        fh.write("x")
    with open(os.path.join(src, "_manifest.json"), "w") as fh:
        json.dump({"parts": [{"name": "part-00000.parquet", "sha256": convert._sha256_file(os.path.join(src, "part-00000.parquet"))}]}, fh)
    with open(os.path.join(src, "part-99999.parquet"), "w") as fh:
        fh.write("unlisted orphan")

    class FakePW:
        instrument_id = '["XNAS","EQUITY","AAPL","USD","SHARE"]'
        family = "candle"
        dataset_version = "v1"
        date = "2025-09-02"
        dir = src

    dest = os.path.join(roots["curated_root"], "databento", _writer.instrument_slug(FakePW.instrument_id),
                        FakePW.family, FakePW.dataset_version, FakePW.date)
    staging = dest + ".publishing"
    os.makedirs(staging)
    with open(os.path.join(staging, "leftover-from-crashed-copy.txt"), "w") as fh:
        fh.write("x")
    assert not os.path.exists(dest)  # the crash happened before the atomic rename into place

    prefix = convert._publish_partition(FakePW(), roots["curated_root"])
    assert not os.path.exists(os.path.join(dest, "part-99999.parquet"))
    assert sorted(os.listdir(os.path.join(roots["curated_root"], prefix))) == ["_manifest.json", "part-00000.parquet"]
    assert not os.path.exists(staging)  # leftover staging dir cleaned up, nothing left dangling


def test_a_pre_fix_style_partial_directory_sitting_directly_at_dest_still_blocks_republication(tmp_path):
    # The guard against re-publishing a *genuinely already-published*
    # partition must still hold -- only the staging-side interruption case
    # (above) is meant to recover automatically.
    import writer as _writer

    roots = _roots(tmp_path)
    os.makedirs(roots["staging_root"])
    src = os.path.join(roots["staging_root"], "src")
    os.makedirs(src)

    class FakePW:
        instrument_id = '["XNAS","EQUITY","AAPL","USD","SHARE"]'
        family = "candle"
        dataset_version = "v1"
        date = "2025-09-02"
        dir = src

    dest = os.path.join(roots["curated_root"], "databento", _writer.instrument_slug(FakePW.instrument_id),
                        FakePW.family, FakePW.dataset_version, FakePW.date)
    os.makedirs(dest)
    with pytest.raises(convert.ConversionError, match="PARTITION_ALREADY_PUBLISHED"):
        convert._publish_partition(FakePW(), roots["curated_root"])


def test_rejection_blocks_publication_and_retains_evidence(tmp_path, monkeypatch):
    original = convert.ContractBridge.map_batch
    def reject_one(self, *args, **kwargs):
        results = original(self, *args, **kwargs)
        results[0] = {"ok": False, "quarantine": {"reason": "TEST_BAD_ROW"}}
        return results
    monkeypatch.setattr(convert.ContractBridge, "map_batch", reject_one)
    with pytest.raises(convert.ConversionError, match="QUARANTINE_BLOCKS_PUBLICATION"):
        convert.convert_file(MBP1, "mbp-1", "v1", **_roots(tmp_path))
    assert not (tmp_path / "curated" / "_catalog" / "CURRENT.json").exists()
    [evidence_path] = list((tmp_path / "staging").glob("*/rejections.json"))
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["schema_version"] == "conversion-rejections/1"
    assert evidence["rejected"] == 1
    assert evidence["reasons"] == {"TEST_BAD_ROW": 1}
    assert evidence["samples"][0]["source"]["s3_key"].endswith(os.path.basename(MBP1))
    assert evidence["samples"][0]["row"]


def test_batch_rows_defaults_to_the_module_constant(monkeypatch):
    monkeypatch.delenv("TT_CONVERT_BATCH_ROWS", raising=False)
    assert convert._batch_rows() == convert.BATCH_ROWS


def test_batch_rows_is_overridable_via_env(monkeypatch):
    monkeypatch.setenv("TT_CONVERT_BATCH_ROWS", "17")
    assert convert._batch_rows() == 17


def test_batch_rows_rejects_a_non_positive_override(monkeypatch):
    monkeypatch.setenv("TT_CONVERT_BATCH_ROWS", "0")
    with pytest.raises(ValueError, match="INVALID_LIMIT"):
        convert._batch_rows()
