from __future__ import annotations

from pathlib import Path
import sys

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts/verify/databento"))
import derive_historical_equity_core as equity


def test_retained_source_rank_is_pinned_without_rewriting_the_archive_order(tmp_path):
    file = tmp_path / "rank.parquet"
    with duckdb.connect() as connection:
        connection.execute("CREATE TABLE depth(source_rank BIGINT, ordinal BIGINT)")
        connection.execute("INSERT INTO depth VALUES (3,0),(3,0)")
        connection.execute("COPY depth TO ? (FORMAT PARQUET)", [str(file)])
        assert equity.pinned_source_rank(connection, [str(file)]) == "3"
        for sql in ("UPDATE depth SET source_rank=NULL", "UPDATE depth SET source_rank=-1",
                    "UPDATE depth SET source_rank=65536", "UPDATE depth SET source_rank=3,ordinal=1"):
            connection.execute(sql)
            connection.execute("COPY depth TO ? (FORMAT PARQUET)", [str(file)])
            with pytest.raises(ValueError, match="retained rank"):
                equity.pinned_source_rank(connection, [str(file)])
        connection.execute("DELETE FROM depth")
        connection.execute("INSERT INTO depth VALUES (2,0),(3,0)")
        connection.execute("COPY depth TO ? (FORMAT PARQUET)", [str(file)])
        with pytest.raises(ValueError, match="retained rank"):
            equity.pinned_source_rank(connection, [str(file)])


def test_equity_join_preserves_tied_source_order_receipt_high_water_and_decimal_prices(tmp_path):
    file = tmp_path / "depth.parquet"
    with duckdb.connect() as connection:
        connection.execute("""
            CREATE TABLE depth AS SELECT 1000000000::BIGINT AS event_ns,
                (1000000200-i*100)::BIGINT AS receive_ns, 2 AS source_rank, i AS stable_position,
                i AS lineage_row, i AS sequence, 128 AS dbn_source_flags,
                0 AS ordinal, 'AAPL' AS instrument_id, 'SNAPSHOT' AS depth_action,
                'TOP_N' AS depth_model, 10 AS depth_limit, 'OK' AS continuity, 1 AS book_epoch,
                [{'price':99::DECIMAL(38,12), 'size':5::DECIMAL(38,12)}] AS bids,
                [{'price':101::DECIMAL(38,12), 'size':7::DECIMAL(38,12)}] AS asks
                FROM range(2) r(i)
        """)
        connection.execute("COPY depth TO ? (FORMAT PARQUET)", [str(file)])
        connection.execute("""
            CREATE TABLE anchors AS SELECT 1000000000::BIGINT AS event_ns, 2 AS source_rank,
                0 AS stable_position, 0 AS ordinal, 'print' AS record_id, 'UNKNOWN' AS side,
                101.005::DECIMAL(38,12) AS price, 3::DECIMAL(38,12) AS size
        """)
        parts = [(None, None, str(file))]
        output = list(equity.joined_rows(connection, parts, "2026-08-05", 1000000000, 2))
        assert [row["stable_position"] for row in output] == ["0", "1"]
        assert [row["known_ns"] for row in output] == ["1000000200", "1000000200"]
        assert output[0]["matched_trade"]["price"] == "101.005000000000"
        assert output[0]["matched_trade"]["size"] == "3"
        assert output[1]["matched_trade"] is None
        assert not any(row["observation_only"] for row in output)
        with pytest.raises(ValueError, match="row count"):
            list(equity.joined_rows(connection, parts, "2026-08-05", 1000000000, 3))
        connection.execute("UPDATE anchors SET size=3.5")
        with pytest.raises(ValueError, match="integer shares"):
            list(equity.joined_rows(connection, parts, "2026-08-05", 1000000000, 2))
        connection.execute("UPDATE anchors SET size=3")
        for flags in (4, 8, 12, None):
            connection.execute("UPDATE depth SET dbn_source_flags=? WHERE stable_position=0", [flags])
            connection.execute("COPY depth TO ? (FORMAT PARQUET)", [str(file)])
            with pytest.raises(ValueError, match="source quality flags"):
                list(equity.joined_rows(connection, parts, "2026-08-05", 1000000000, 2))


def test_unchanged_anchored_trades_observe_and_changed_trade_books_settle_prior_prints(tmp_path):
    file = tmp_path / "depth.parquet"
    with duckdb.connect() as connection:
        connection.execute("""
            CREATE TABLE depth AS SELECT 1000000000+i::BIGINT AS event_ns,
                1000000100+i::BIGINT AS receive_ns, 2 AS source_rank, i AS stable_position,
                i AS lineage_row, i AS sequence, 0 AS dbn_source_flags, 0 AS ordinal,
                'AAPL' AS instrument_id, 'SNAPSHOT' AS depth_action, 'TOP_N' AS depth_model,
                10 AS depth_limit, 'OK' AS continuity, 1 AS book_epoch,
                [{'price':99::DECIMAL(38,12),'size':5::DECIMAL(38,12)}] AS bids,
                [{'price':101::DECIMAL(38,12),'size':(7-CASE WHEN i=2 THEN 2 ELSE 0 END)::DECIMAL(38,12)}] AS asks
                FROM range(3) r(i)
        """)
        connection.execute("COPY depth TO ? (FORMAT PARQUET)", [str(file)])
        connection.execute("CREATE TABLE anchors AS SELECT event_ns,source_rank,stable_position,ordinal, "
                           "'p'||stable_position AS record_id,'BUY' AS side,101::DECIMAL(38,12) AS price, "
                           "2::DECIMAL(38,12) AS size FROM depth WHERE stable_position>0")
        result = list(equity.joined_rows(connection, [(None,None,str(file))], "2026-08-05", 1000000000, 3))
        assert [r["observation_only"] for r in result] == [False, True, False]
        legacy = list(equity.joined_rows(connection, [(None,None,str(file))], "2026-08-05", 1000000000, 3,
                                        trade_observation=False))
        assert not any(r["observation_only"] for r in legacy)
