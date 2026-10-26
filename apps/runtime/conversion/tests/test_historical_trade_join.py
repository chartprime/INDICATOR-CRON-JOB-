from __future__ import annotations

import importlib
from pathlib import Path
import sys
import shutil

import duckdb
import pytest


SCRIPTS = Path(__file__).parents[2] / "scripts" / "verify" / "databento"
sys.path.insert(0, str(SCRIPTS))
inspector = importlib.import_module("inspect_historical_trade_join")


@pytest.fixture
def sources(tmp_path, monkeypatch):
    connection = duckdb.connect()
    event_ns = 1785916800000000001
    common = (f"{event_ns}::BIGINT AS event_ns, {event_ns + 100}::BIGINT AS receive_ns, "
              "10 AS sequence, 2 AS dbn_publisher_id, 'XNAS.ITCH' AS source_dataset, 'test' AS stream_id, "
              "'AAPL' AS instrument_id")
    paths = {family: tmp_path / f"{family}.json" for family in ("depth", "trade", "quote")}
    files = {family: tmp_path / f"{family}.parquet" for family in paths}
    try:
        connection.execute(f"""
            COPY (SELECT {common}, 'mbp-10' AS source_schema, 2 AS source_rank,
                         position AS stable_position, 0 AS ordinal, flags AS dbn_source_flags,
                         'SNAPSHOT' AS depth_action, 'TOP_N' AS depth_model,
                         10 AS depth_limit, 'OK' AS continuity, 1 AS book_epoch,
                         [{{'price': 100.0::DECIMAL(38,12), 'size': 5.0::DECIMAL(38,12)}}] AS bids,
                         [{{'price': 101.0::DECIMAL(38,12), 'size': ask_size::DECIMAL(38,12)}}] AS asks
                  FROM (VALUES (1, 0, 5), (2, 128, 2)) rows(position, flags, ask_size))
            TO ? (FORMAT PARQUET)
        """, [str(files["depth"])])
        connection.execute(f"""
            CREATE TABLE trades AS SELECT {common}, 'mbp-1' AS source_schema,
                'trade-1' AS record_id, 0 AS dbn_source_flags, 'T' AS dbn_source_action,
                'BUY' AS side, 'NEW' AS trade_action, true AS valid_tick,
                'UNVERIFIED' AS quality_state, 3.0::DECIMAL(38,12) AS size,
                101.0::DECIMAL(38,12) AS price, 'raw-hash' AS lineage_sha256, 50 AS lineage_row
        """)
        connection.execute("COPY trades TO ? (FORMAT PARQUET)", [str(files["trade"])])
        connection.execute(f"""
            CREATE TABLE quotes AS SELECT {common}, 0 AS dbn_source_flags, 'T' AS dbn_source_action,
                'raw-hash' AS lineage_sha256, 50 AS lineage_row,
                100.0::DECIMAL(38,12) AS bid_price, 5.0::DECIMAL(38,12) AS bid_size,
                101.0::DECIMAL(38,12) AS ask_price, 5.0::DECIMAL(38,12) AS ask_size
        """)
        connection.execute("COPY quotes TO ? (FORMAT PARQUET)", [str(files["quote"])])
    finally:
        connection.close()
    plans = {family: {"partition": {"family": family, "date": "2026-08-05",
                                   "instrument_id": "AAPL", "dataset_version": "pinned",
                                   "record_count": 2 if family == "depth" else 1},
                      "parts": [{"rows": 2 if family == "depth" else 1}]}
             for family in paths}
    monkeypatch.setattr(inspector, "verified_files",
                        lambda path, *_: (plans[path.stem], [str(files[path.stem])]))
    return paths, files, plans


def test_trade_quote_identifies_pre_reduction_book_without_choosing_a_merge(sources):
    paths, _, _ = sources
    result = inspector.inspect(paths["depth"], paths["trade"], paths["quote"])
    assert result["exactSequenceEventMatching"] == [{"matches": 2, "receive_matches": 2, "trades": 1}]
    assert result["tradeTimeQuoteMatching"] == [{"side": "BUY", "quotes": 1, "depth_rows": 2,
                                               "bbo_matches": 1, "first_matches": 1, "trades": 1}]
    assert result["tradeEventMultiplicity"] == [{"trades_per_event": 1, "events": 1}]
    assert result["tradeTimeQuoteFlagMatching"] == [{"flag_bbo_matches": 1, "trades": 1}]
    assert result["eventWitnesses"] == []
    assert result["tradeTimeQuoteMismatchSamples"] == []


def test_order_diagnostics_keep_a_later_matching_book_and_exact_times(sources):
    paths, files, _ = sources
    rewrite(files["quote"], "* REPLACE (2.0::DECIMAL(38,12) AS ask_size, 128 AS dbn_source_flags)")
    rewrite(files["trade"], "* REPLACE (128 AS dbn_source_flags)")
    result = inspector.inspect(paths["depth"], paths["trade"], paths["quote"])
    assert result["tradeTimeQuoteMatching"][0]["first_matches"] == 0
    assert result["tradeTimeQuoteFlagMatching"] == [{"flag_bbo_matches": 1, "trades": 1}]
    witness = result["eventWitnesses"][0]
    assert witness["key"]["event_ns"] == "1785916800000000001"
    assert witness["key"]["receive_ns"] == "1785916800000000101"
    assert [row["stable_position"] for row in witness["depth"]] == ["1", "2"]
    assert [row["dbn_source_flags"] for row in witness["depth"]] == [0, 128]
    assert result["scope"] == "source-order-diagnostics-only; not an accepted CME merge"


def test_flag_matching_does_not_choose_between_identical_trade_echoes(sources):
    paths, files, _ = sources
    rewrite(files["depth"], "* REPLACE (0 AS dbn_source_flags, "
            "[{'price':101.0::DECIMAL(38,12),'size':5.0::DECIMAL(38,12)}] AS asks)")
    result = inspector.inspect(paths["depth"], paths["trade"], paths["quote"])
    assert result["tradeTimeQuoteFlagMatching"] == [{"flag_bbo_matches": 2, "trades": 1}]


def test_witnesses_sort_native_integers_before_encoding_as_decimal_strings(sources):
    paths, files, plans = sources
    rewrite(files["depth"], "* REPLACE (CASE WHEN stable_position=1 THEN 2 ELSE 10 END AS stable_position)")
    connection = duckdb.connect()
    try:
        connection.execute("CREATE TEMP TABLE prints AS SELECT * REPLACE (2 AS lineage_row) FROM read_parquet(?) "
                           "UNION ALL SELECT * REPLACE ('trade-2' AS record_id, 10 AS lineage_row) FROM read_parquet(?)",
                           [str(files["trade"]), str(files["trade"])])
        connection.execute("COPY prints TO ? (FORMAT PARQUET)", [str(files["trade"].with_suffix(".new"))])
    finally:
        connection.close()
    files["trade"].with_suffix(".new").replace(files["trade"])
    plans["trade"]["partition"]["record_count"] = 2
    result = inspector.inspect(paths["depth"], paths["trade"], paths["quote"])
    witness = result["eventWitnesses"][0]
    assert [row["stable_position"] for row in witness["depth"]] == ["2", "10"]
    assert [row["lineage_row"] for row in witness["trades"]] == ["2", "10"]
    assert result["tradeEventMultiplicity"] == [{"trades_per_event": 2, "events": 1}]


def test_witness_limit_refuses_incomplete_order_evidence(sources):
    paths, files, plans = sources
    connection = duckdb.connect()
    try:
        connection.execute("CREATE TEMP TABLE repeated AS SELECT * REPLACE (i AS stable_position) "
                           "FROM read_parquet(?) CROSS JOIN range(1,66) r(i) WHERE stable_position=1",
                           [str(files["depth"])])
        connection.execute("COPY repeated TO ? (FORMAT PARQUET)", [str(files["depth"].with_suffix(".new"))])
    finally:
        connection.close()
    files["depth"].with_suffix(".new").replace(files["depth"])
    plans["depth"]["partition"]["record_count"] = 65
    rewrite(files["quote"], "* REPLACE (128 AS dbn_source_flags)")
    rewrite(files["trade"], "* REPLACE (128 AS dbn_source_flags)")
    with pytest.raises(ValueError, match="event witness exceeds 64 rows"):
        inspector.inspect(paths["depth"], paths["trade"], paths["quote"])


def test_trade_quote_requires_exact_nanoseconds_even_with_matching_lineage(sources):
    paths, files, _ = sources
    connection = duckdb.connect()
    try:
        connection.execute("CREATE TEMP TABLE shifted AS SELECT * REPLACE (event_ns + 1 AS event_ns) "
                           "FROM read_parquet(?)", [str(files["quote"])])
        connection.execute("COPY shifted TO ? (FORMAT PARQUET)", [str(files["quote"].with_suffix(".new"))])
    finally:
        connection.close()
    files["quote"].with_suffix(".new").replace(files["quote"])
    result = inspector.inspect(paths["depth"], paths["trade"], paths["quote"])
    assert result["tradeTimeQuoteMatching"][0]["quotes"] == 0
    assert result["tradeTimeQuoteMatching"][0]["first_matches"] == 0


def test_trade_quote_refuses_a_different_published_version(sources):
    paths, _, plans = sources
    plans["quote"]["partition"]["dataset_version"] = "other"
    with pytest.raises(ValueError, match="matching trade instrument/day/version"):
        inspector.inspect(paths["depth"], paths["trade"], paths["quote"])


def test_join_refuses_decoded_counts_that_disagree_with_the_catalog(sources):
    paths, _, plans = sources
    plans["trade"]["partition"]["record_count"] += 1
    with pytest.raises(ValueError, match="decoded row count differs"):
        inspector.inspect(paths["depth"], paths["trade"], paths["quote"])


@pytest.fixture
def flow_pilot(sources, monkeypatch):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node is required for the engine flow integration")
    flow = importlib.import_module("verify_historical_equity_flow")
    paths, files, plans = sources
    monkeypatch.setattr(flow, "verified_files", lambda path: (plans[path.stem], [str(files[path.stem])]))
    return flow, paths, files, node


def rewrite(path, projection):
    connection = duckdb.connect()
    try:
        connection.execute(f"CREATE TEMP TABLE changed AS SELECT {projection} FROM read_parquet(?)", [str(path)])
        connection.execute("COPY changed TO ? (FORMAT PARQUET)", [str(path.with_suffix(".new"))])
    finally:
        connection.close()
    path.with_suffix(".new").replace(path)


def test_equity_flow_reconciles_a_trade_before_its_same_event_reduction(flow_pilot):
    flow, paths, _, node = flow_pilot
    result = flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", node)
    assert result["independentFlowSamples"] == 1
    assert result["oracle"]["applied"] == 1
    assert result["oracle"]["samples"][0]["buyVolume"] == 3
    assert result["oracle"]["samples"][0]["sellVolume"] == 0
    assert result["oracle"]["samples"][0]["tradeCount"] == 1


def test_equity_flow_keeps_unknown_shares_without_assigning_direction(flow_pilot):
    flow, paths, files, node = flow_pilot
    rewrite(files["trade"], "* REPLACE ('UNKNOWN' AS side)")
    result = flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", node)
    assert result["oracle"]["observed"]["UNKNOWN"] == {"count": 1, "volume": 3}
    assert result["oracle"]["applied"] == 0
    assert result["oracle"]["samples"][0]["tradeCount"] == 0


def test_equity_flow_does_not_inject_an_untrusted_trade_into_the_later_seed(flow_pilot):
    flow, paths, files, node = flow_pilot
    rewrite(files["depth"], "* REPLACE (CASE WHEN stable_position=1 THEN [] ELSE asks END AS asks)")
    rewrite(files["quote"], "* REPLACE (NULL::DECIMAL(38,12) AS ask_price, NULL::DECIMAL(38,12) AS ask_size)")
    result = flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", node)
    assert result["oracle"]["trusted"] == 1
    assert result["oracle"]["outsideTrust"]["BUY"] == {"count": 1, "volume": 3}
    assert result["oracle"]["applied"] == 0
    assert result["oracle"]["samples"][0]["tradeCount"] == 0


def test_equity_flow_independent_reference_catches_wrong_engine_volume(flow_pilot, monkeypatch):
    flow, paths, _, node = flow_pilot
    reference = flow.reference_samples

    def corrupt(connection, result):
        result["samples"][0]["buyVolume"] = 0
        return reference(connection, result)

    monkeypatch.setattr(flow, "reference_samples", corrupt)
    with pytest.raises(ValueError, match="independent rolling flow disagrees"):
        flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", node)


def test_equity_flow_reconciles_minute_windows_after_trade_expiry(flow_pilot, sources):
    flow, paths, files, node = flow_pilot
    _, _, plans = sources
    connection = duckdb.connect()
    try:
        connection.execute("CREATE TEMP TABLE depth AS SELECT * FROM read_parquet(?)", [str(files["depth"])])
        for offset, position in ((60_000_000_000, 3), (120_000_000_000, 4)):
            connection.execute("INSERT INTO depth SELECT * REPLACE (event_ns+? AS event_ns, receive_ns+? AS receive_ns, "
                               "? AS stable_position, sequence+? AS sequence) FROM depth WHERE stable_position=2",
                               [offset, offset, position, position])
        connection.execute("COPY depth TO ? (FORMAT PARQUET)", [str(files["depth"].with_suffix(".new"))])
    finally:
        connection.close()
    files["depth"].with_suffix(".new").replace(files["depth"])
    plans["depth"]["partition"]["record_count"] = 4
    plans["depth"]["parts"][0]["rows"] = 4
    result = flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", node)
    assert result["independentFlowSamples"] == 3
    assert [sample["buyVolume"] for sample in result["oracle"]["samples"]] == [3, 0, 0]


def test_equity_flow_refuses_ambiguous_quote_candidates_before_launching_node(flow_pilot, monkeypatch):
    flow, paths, _, _ = flow_pilot
    inspect_original = flow.inspect

    def ambiguous(*args):
        proof = inspect_original(*args)
        proof["tradeTimeQuoteMatching"][0]["bbo_matches"] = 2
        return proof

    monkeypatch.setattr(flow, "inspect", ambiguous)
    with pytest.raises(ValueError, match="one quote-confirmed first depth candidate"):
        flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", "not-a-node-executable")


def test_equity_flow_diagnostic_report_cannot_overwrite_a_source_plan(flow_pilot):
    flow, paths, _, _ = flow_pilot
    with pytest.raises(ValueError, match="separate JSON file"):
        flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", "not-a-node-executable", paths["quote"])


def test_equity_flow_refuses_rows_bound_to_a_foreign_instrument(flow_pilot):
    flow, paths, files, _ = flow_pilot
    rewrite(files["trade"], "* REPLACE ('TSLA' AS instrument_id)")
    with pytest.raises(ValueError, match="decoded instrument identity differs"):
        flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", "not-a-node-executable")


def test_equity_flow_refuses_duplicate_quotes_even_when_all_values_agree(flow_pilot):
    flow, paths, files, _ = flow_pilot
    connection = duckdb.connect()
    try:
        connection.execute("CREATE TEMP TABLE repeated AS SELECT * FROM read_parquet(?) "
                           "UNION ALL SELECT * FROM read_parquet(?)", [str(files["quote"]), str(files["quote"])])
        connection.execute("COPY repeated TO ? (FORMAT PARQUET)", [str(files["quote"].with_suffix(".new"))])
    finally:
        connection.close()
    files["quote"].with_suffix(".new").replace(files["quote"])
    inspector.verified_files(paths["quote"])[0]["partition"]["record_count"] = 2
    with pytest.raises(ValueError, match="one quote-confirmed"):
        flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.01", "not-a-node-executable")


def test_equity_candidate_cannot_silently_admit_futures(flow_pilot):
    flow, paths, files, _ = flow_pilot
    for family in ("depth", "trade", "quote"):
        rewrite(files[family], "* REPLACE ('GLBX.MDP3' AS source_dataset, 1 AS dbn_publisher_id)")
    with pytest.raises(ValueError, match="XNAS.ITCH MBP-10 only"):
        flow.verify(paths["depth"], paths["trade"], paths["quote"], "0.25", "not-a-node-executable")
