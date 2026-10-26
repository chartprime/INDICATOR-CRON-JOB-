"""Depth (mbp-10) conversion wired into job.py: dual bridge dispatch
(depth always, trade when action=='T') and continuity/book_epoch tracking
that survives across the whole job (design lock 19 sections 0.4a/0.4b).

No real `mbp-10` fixture exists in the repo (only `mbp-1`/`tbbo`), and
`databento_dbn` exposes no encoder to synthesize one here. These tests
prove the *wiring* -- dispatch, continuity threading, checkpoint
persistence, writer integration -- using the real `mbp-1`/`tbbo` fixtures
with `convert._map_family_for` overridden to route them through the depth
path, which is honestly a test-only substitute: it is not proof against
real mbp-10 data. That proof is Phase 3's real ES/NQ/TSLA sample step.
"""
from __future__ import annotations

import os

import duckdb
import pytest

import job
from test_job import MBP1, TBBO, _MBP1_KEY, _TBBO_KEY, _roots


@pytest.fixture(autouse=True)
def _mbp_schemas_are_depth(monkeypatch):
    real = job._convert._map_family_for
    monkeypatch.setattr(job._convert, "_map_family_for", lambda schema: "depth" if schema in ("mbp-1", "tbbo") else real(schema))


def test_a_depth_only_source_produces_one_depth_partition_all_in_epoch_zero(tmp_path):
    # Both mbp1 fixture rows: action='A' (no reset), flags=128 (MAYBE_BAD_BOOK
    # bit not set) -- neither triggers a continuity transition.
    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    summary = job.run_job(inputs, "v1", **_roots(tmp_path))
    assert {p.split("/")[2] for p in summary["partitions"]} == {"depth"}

    part = os.path.join(tmp_path, "curated", summary["partitions"][0], "part-00000.parquet")
    con = duckdb.connect()
    try:
        rows = con.execute(
            "SELECT depth_action, book_epoch, continuity, reset, depth_limit FROM read_parquet(?) ORDER BY event_ns", [part]
        ).fetchall()
    finally:
        con.close()
    assert len(rows) == 2
    assert [r[1] for r in rows] == [0, 0]  # no transition -- stays in the stream's opening epoch
    assert [r[2] for r in rows] == ["OK", "OK"]
    assert all(r[0] == "SNAPSHOT" and r[3] is True and r[4] == 1 for r in rows)  # mbp-1 -> depth_limit 1


def test_a_source_with_trade_actions_produces_both_depth_and_trade_from_one_pass(tmp_path, monkeypatch):
    # Both tbbo fixture rows are action='T' -> dual dispatch must extract
    # both a depth snapshot AND a trade record from the very same rows --
    # and, end to end, the source must only be read/dispatched once, not
    # once per output family.
    real_read_day = job._split.read_day
    real_map_batch = job.ContractBridge.map_batch
    read_day_calls = {"n": 0}
    dispatched_families = []

    def counting_read_day(path):
        read_day_calls["n"] += 1
        return real_read_day(path)

    def counting_map_batch(self, batch_id, provider, family, rows, context):
        dispatched_families.append(family)
        return real_map_batch(self, batch_id, provider, family, rows, context)

    monkeypatch.setattr(job._split, "read_day", counting_read_day)
    monkeypatch.setattr(job.ContractBridge, "map_batch", counting_map_batch)

    inputs = [{"local_path": TBBO, "s3_key": _TBBO_KEY, "schema": "tbbo"}]
    summary = job.run_job(inputs, "v1", **_roots(tmp_path))
    families = {p.split("/")[2] for p in summary["partitions"]}
    assert families == {"depth", "trade"}
    assert read_day_calls["n"] == 2  # 1 has-trade probe + 1 shared dispatch pass, not 2
    assert dispatched_families == ["depth", "trade"]

    for prefix in summary["partitions"]:
        part = os.path.join(tmp_path, "curated", prefix, "part-00000.parquet")
        con = duckdb.connect()
        try:
            n = con.execute("SELECT count(*) FROM read_parquet(?)", [part]).fetchone()[0]
        finally:
            con.close()
        assert n == 2  # both rows contributed to both families


def test_a_depth_only_filter_keeps_trade_actions_out_of_the_output_and_its_own_job_identity(tmp_path, monkeypatch):
    # The ES/NQ August 2026 correction re-derives depth only: August trade is
    # owned by the L1 (mbp-1) versions, and a depth job that also wrote trade
    # would try to replace those good partitions.
    real_map_batch = job.ContractBridge.map_batch
    dispatched_families = []

    def counting_map_batch(self, batch_id, provider, family, rows, context):
        dispatched_families.append(family)
        return real_map_batch(self, batch_id, provider, family, rows, context)

    monkeypatch.setattr(job.ContractBridge, "map_batch", counting_map_batch)
    inputs = [{"local_path": TBBO, "s3_key": _TBBO_KEY, "schema": "tbbo"}]
    summary = job.run_job(inputs, "v1", families=["depth"], **_roots(tmp_path))
    assert {p.split("/")[2] for p in summary["partitions"]} == {"depth"}
    assert dispatched_families == ["depth"]

    descs = [job._describe_input(**i) for i in inputs]
    assert job.job_id_for(descs, "v1", (), ["depth"]) == summary["job_id"]
    assert job.job_id_for(descs, "v1", ()) != summary["job_id"]


@pytest.mark.parametrize("families", [[], ["book"], "depth", [""]])
def test_an_unknown_or_empty_family_filter_is_refused(tmp_path, families):
    inputs = [{"local_path": TBBO, "s3_key": _TBBO_KEY, "schema": "tbbo"}]
    with pytest.raises(job.JobError, match="INVALID_FAMILY_FILTER"):
        job.run_job(inputs, "v1", families=families, **_roots(tmp_path))


def test_continuity_summary_lands_in_the_catalog(tmp_path):
    import sqlite3

    import catalog

    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    roots = _roots(tmp_path)
    summary = job.run_job(inputs, "v1", **roots)
    pointer = catalog.read_current(roots["catalog_root"])
    assert pointer == summary["catalog_pointer"]

    con = sqlite3.connect(os.path.join(roots["catalog_root"], pointer["catalog_key"]))
    try:
        rows = con.execute(
            "SELECT instrument_id, family, book_epoch, state, observed_resets, suspected_gaps FROM continuity"
        ).fetchall()
    finally:
        con.close()
    assert len(rows) == 1  # one epoch: nothing in the fixture triggers a transition
    instrument_id, family, book_epoch, state, resets, gaps = rows[0]
    assert family == "depth" and book_epoch == 0 and state == "OK" and resets == 0 and gaps == 0
    assert instrument_id  # the real canonical instrument.id, not empty/null


def test_continuity_state_is_persisted_to_the_checkpoint_and_survives_a_reload(tmp_path):
    # The mechanism book_epoch continuity across dates/resumes actually
    # depends on: continuity_state must land in checkpoint.json and come
    # back byte-identical through a fresh load, exactly like every other
    # frozen/progressed job fact. (A genuine two-*date* continuation proof
    # needs a second real mbp-10 fixture at a different date, which the
    # repo doesn't have -- flagged for Phase 3's real-sample step.)
    import checkpoint as ckpt

    inputs = [{"local_path": MBP1, "s3_key": _MBP1_KEY, "schema": "mbp-1"}]
    roots = _roots(tmp_path)
    job.run_job(inputs, "v1", **roots)

    descs = [job._describe_input(**i) for i in inputs]
    job_id = job.job_id_for(descs, "v1")
    job_stage = os.path.join(roots["staging_root"], job_id)
    reloaded = ckpt.load(job_stage)
    assert "continuity_state" in reloaded
    instrument_id = next(iter(reloaded["continuity_state"]))
    state = reloaded["continuity_state"][instrument_id]
    assert state["epoch"] == 0 and state["have_predecessor"] is True
    assert state["observed_resets"] == 0 and state["suspected_gaps"] == 0

    # A second run of the same job_id (a clean no-op) must not mutate it.
    job.run_job(inputs, "v1", **roots)
    assert ckpt.load(job_stage)["continuity_state"] == reloaded["continuity_state"]
