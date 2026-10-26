"""Measure source identity and exact depth/trade matching without selecting an inferred merge order."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import tempfile

import duckdb

from verify_historical_topn_partition import verified_files
from fetch_verified_partition import DEFAULT_SOURCE_BYTES


def inspect(depth_path: Path, trade_path: Path, quote_path: Path | None = None,
            max_source_bytes: int = DEFAULT_SOURCE_BYTES) -> dict:
    depth_plan, depth_files = verified_files(depth_path, max_source_bytes)
    trade_plan, trade_files = verified_files(trade_path, max_source_bytes)
    if (depth_plan["partition"]["family"] != "depth" or trade_plan["partition"]["family"] != "trade"
            or depth_plan["partition"]["instrument_id"] != trade_plan["partition"]["instrument_id"]
            or depth_plan["partition"]["date"] != trade_plan["partition"]["date"]):
        raise ValueError("matching instrument/day depth and trade authorities are required")
    quote_plan, quote_files = verified_files(quote_path, max_source_bytes) if quote_path is not None else (None, None)
    if quote_plan is not None and (
            quote_plan["partition"]["family"] != "quote"
            or quote_plan["partition"]["instrument_id"] != trade_plan["partition"]["instrument_id"]
            or quote_plan["partition"]["date"] != trade_plan["partition"]["date"]
            or quote_plan["partition"]["dataset_version"] != trade_plan["partition"]["dataset_version"]):
        raise ValueError("quote must be the matching trade instrument/day/version authority")
    scratch = tempfile.TemporaryDirectory(dir=depth_path.parent, prefix="trade-join-")
    connection = duckdb.connect(config={"threads": "1", "memory_limit": "256MB", "temp_directory": scratch.name,
                                       "max_temp_directory_size": "4GB", "preserve_insertion_order": "false"})

    def query(sql, params=None):
        result = connection.execute(sql, params or [])
        fields = [column[0] for column in result.description]
        return [dict(zip(fields, row)) for row in result.fetchall()]

    try:
        sources = [(depth_plan, depth_files), (trade_plan, trade_files)]
        if quote_plan is not None:
            sources.append((quote_plan, quote_files))
        for plan, files in sources:
            foreign = connection.execute("SELECT count(*) FROM read_parquet(?) WHERE instrument_id IS NULL "
                                         "OR instrument_id<>?", [files, plan["partition"]["instrument_id"]]).fetchone()[0]
            if foreign:
                raise ValueError("decoded instrument identity differs from pinned catalog")
        connection.execute("CREATE TEMP TABLE depth AS SELECT event_ns, receive_ns, sequence, "
                           "dbn_publisher_id, dbn_source_flags, source_dataset, source_schema, stream_id, "
                           "source_rank, stable_position, ordinal, hash(bids, asks) AS book_hash, "
                           "bids[1].price::VARCHAR AS best_bid, bids[1].size::VARCHAR AS bid_size, "
                           "asks[1].price::VARCHAR AS best_ask, asks[1].size::VARCHAR AS ask_size "
                           "FROM read_parquet(?)", [depth_files])
        connection.execute("CREATE TEMP TABLE trades AS SELECT record_id, event_ns, receive_ns, sequence, "
                           "dbn_publisher_id, dbn_source_flags, dbn_source_action, source_dataset, source_schema, "
                           "stream_id, side, trade_action, valid_tick, quality_state, size, price, "
                           "lineage_sha256, lineage_row FROM read_parquet(?)",
                           [trade_files])
        for table, plan in (("depth", depth_plan), ("trades", trade_plan)):
            if connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] != plan["partition"]["record_count"]:
                raise ValueError("decoded row count differs from pinned catalog")
        depth_identity = query("SELECT source_dataset, source_schema, dbn_publisher_id, "
                               "count(*) AS rows, count(*) FILTER (WHERE sequence IS NULL OR receive_ns IS NULL) "
                               "AS missing_order FROM depth GROUP BY ALL")
        trade_identity = query("SELECT source_dataset, source_schema, dbn_publisher_id, side, trade_action, "
                               "dbn_source_action, valid_tick, quality_state, count(*) AS rows, "
                               "CAST(sum(size) AS VARCHAR) AS volume FROM trades GROUP BY ALL")
        matching = query("""
            WITH paired AS (
                SELECT t.record_id, count(d.sequence) AS matches,
                       count(d.sequence) FILTER (WHERE d.receive_ns=t.receive_ns) AS receive_matches
                FROM trades t LEFT JOIN depth d
                  ON t.sequence=d.sequence AND t.dbn_publisher_id=d.dbn_publisher_id
                 AND t.event_ns=d.event_ns AND t.source_dataset=d.source_dataset
                GROUP BY t.record_id
            ) SELECT matches, receive_matches, count(*) AS trades FROM paired GROUP BY ALL ORDER BY ALL
        """)
        duplicates = query("SELECT count(*) AS duplicate_groups FROM "
                           "(SELECT event_ns, sequence, dbn_publisher_id, count(*) AS n "
                           "FROM depth GROUP BY ALL HAVING n>1)")
        trade_duplicates = query("SELECT count(*)-count(DISTINCT record_id) AS duplicate_record_ids FROM trades")
        trade_multiplicity = query("""
            SELECT trades_per_event, count(*) AS events FROM (
                SELECT count(*) AS trades_per_event FROM trades
                GROUP BY source_dataset, dbn_publisher_id, sequence, event_ns, receive_ns
            ) GROUP BY ALL ORDER BY ALL
        """)
        ordering = query("""
            WITH ordered AS (
                SELECT event_ns, receive_ns,
                       lag(event_ns) OVER (ORDER BY source_rank, stable_position, ordinal) AS previous_event,
                       lag(receive_ns) OVER (ORDER BY source_rank, stable_position, ordinal) AS previous_receive
                FROM depth
            ) SELECT count(*) FILTER (WHERE event_ns < previous_event) AS event_time_regressions,
                     count(*) FILTER (WHERE receive_ns < previous_receive) AS receive_time_regressions
              FROM ordered
        """)
        event_flags = query("""
            SELECT rows, last_rows, count(*) AS groups FROM (
                SELECT event_ns, receive_ns, sequence, dbn_publisher_id, count(*) AS rows,
                       count(*) FILTER (WHERE (dbn_source_flags & 128) <> 0) AS last_rows
                FROM depth GROUP BY ALL
            ) GROUP BY ALL ORDER BY ALL
        """)
        samples = query("""
            WITH repeated AS (
                SELECT event_ns, receive_ns, sequence, dbn_publisher_id
                FROM depth GROUP BY ALL HAVING count(*) > 1 ORDER BY event_ns LIMIT 3
            ) SELECT CAST(d.event_ns AS VARCHAR) AS event_ns, d.sequence, d.stable_position,
                     d.ordinal, d.dbn_source_flags, d.best_bid, d.bid_size, d.best_ask,
                     d.ask_size, t.side, t.size::VARCHAR AS trade_size
              FROM depth d JOIN repeated r USING(event_ns, receive_ns, sequence, dbn_publisher_id)
              LEFT JOIN trades t USING(event_ns, receive_ns, sequence, dbn_publisher_id)
              ORDER BY d.event_ns, d.stable_position, d.ordinal
        """)
        first_trade_book = query("""
            WITH ordered AS (
                SELECT *, lag(book_hash) OVER(ORDER BY event_ns, source_rank, stable_position, ordinal)
                          AS previous_book_hash FROM depth
            ), first_match AS (
                SELECT t.record_id, d.book_hash, d.previous_book_hash, d.dbn_source_flags
                FROM trades t JOIN ordered d
                  ON t.sequence=d.sequence AND t.dbn_publisher_id=d.dbn_publisher_id
                 AND t.event_ns=d.event_ns AND t.receive_ns=d.receive_ns AND t.source_dataset=d.source_dataset
                QUALIFY row_number() OVER(PARTITION BY t.record_id ORDER BY d.stable_position, d.ordinal)=1
            ) SELECT count(*) AS trades, count(*) FILTER(WHERE previous_book_hash IS NULL) AS no_previous,
                     count(*) FILTER(WHERE book_hash<>previous_book_hash) AS first_match_changes_book,
                     count(*) FILTER(WHERE (dbn_source_flags & 128)<>0) AS first_match_last
              FROM first_match
        """)
        quote_checks = None
        quote_mismatches = None
        quote_flag_checks = None
        event_witnesses = None
        if quote_plan is not None:
            if connection.execute("SELECT count(*) FROM read_parquet(?)", [quote_files]).fetchone()[0] != quote_plan["partition"]["record_count"]:
                raise ValueError("decoded quote row count differs from pinned catalog")
            connection.execute("CREATE TEMP TABLE quotes AS SELECT lineage_sha256, lineage_row, event_ns, "
                               "receive_ns, sequence, source_dataset, dbn_publisher_id, dbn_source_action, "
                               "dbn_source_flags, bid_price::VARCHAR AS best_bid, bid_size::VARCHAR AS bid_size, "
                               "ask_price::VARCHAR AS best_ask, ask_size::VARCHAR AS ask_size FROM read_parquet(?) "
                               "WHERE dbn_source_action='T'",
                               [quote_files])
            connection.execute("CREATE TEMP TABLE depth_ordered AS SELECT *, row_number() OVER ("
                               "PARTITION BY source_dataset, dbn_publisher_id, sequence, event_ns, receive_ns "
                               "ORDER BY source_rank, stable_position, ordinal) AS event_position FROM depth")
            quote_checks = query("""
                WITH quote_match AS (
                    SELECT t.record_id, t.side, count(q.lineage_row) AS quotes,
                           min(q.best_bid) AS best_bid, min(q.bid_size) AS bid_size,
                           min(q.best_ask) AS best_ask, min(q.ask_size) AS ask_size,
                           min(q.dbn_source_flags) AS quote_flags
                    FROM trades t LEFT JOIN quotes q
                      ON q.lineage_sha256=t.lineage_sha256 AND q.lineage_row=t.lineage_row
                     AND q.sequence=t.sequence AND q.event_ns=t.event_ns AND q.receive_ns=t.receive_ns
                     AND q.source_dataset=t.source_dataset AND q.dbn_publisher_id=t.dbn_publisher_id
                     AND q.dbn_source_action='T' AND q.dbn_source_flags=t.dbn_source_flags
                    GROUP BY t.record_id, t.side
                ), candidates AS (
                    SELECT t.record_id, q.side, q.quotes, count(d.sequence) AS depth_rows,
                           count(d.sequence) FILTER (
                             WHERE d.best_bid IS NOT DISTINCT FROM q.best_bid
                               AND d.bid_size IS NOT DISTINCT FROM q.bid_size
                               AND d.best_ask IS NOT DISTINCT FROM q.best_ask
                               AND d.ask_size IS NOT DISTINCT FROM q.ask_size) AS bbo_matches,
                           count(d.sequence) FILTER (
                             WHERE d.event_position=1 AND d.dbn_source_flags=q.quote_flags
                               AND d.best_bid IS NOT DISTINCT FROM q.best_bid
                               AND d.bid_size IS NOT DISTINCT FROM q.bid_size
                               AND d.best_ask IS NOT DISTINCT FROM q.best_ask
                               AND d.ask_size IS NOT DISTINCT FROM q.ask_size) AS first_matches
                    FROM trades t JOIN quote_match q USING(record_id)
                    LEFT JOIN depth_ordered d
                      ON t.sequence=d.sequence AND t.event_ns=d.event_ns AND t.receive_ns=d.receive_ns
                     AND t.source_dataset=d.source_dataset AND t.dbn_publisher_id=d.dbn_publisher_id
                    GROUP BY t.record_id, q.side, q.quotes
                ) SELECT side, quotes, depth_rows, bbo_matches, first_matches, count(*) AS trades
                  FROM candidates GROUP BY ALL ORDER BY ALL
            """)
            quote_mismatches = query("""
                SELECT t.record_id, t.side, t.price::VARCHAR AS price, t.size::VARCHAR AS size,
                       t.event_ns::VARCHAR AS event_ns, t.receive_ns::VARCHAR AS receive_ns, t.sequence,
                       d.stable_position::VARCHAR AS depth_position, d.ordinal,
                       d.dbn_source_flags AS depth_flags, q.dbn_source_flags AS quote_flags,
                       d.best_bid AS depth_bid, d.bid_size AS depth_bid_size,
                       d.best_ask AS depth_ask, d.ask_size AS depth_ask_size,
                       q.best_bid AS quote_bid, q.bid_size AS quote_bid_size,
                       q.best_ask AS quote_ask, q.ask_size AS quote_ask_size
                  FROM trades t JOIN quotes q
                    ON q.lineage_sha256=t.lineage_sha256 AND q.lineage_row=t.lineage_row
                   AND q.sequence=t.sequence AND q.event_ns=t.event_ns AND q.receive_ns=t.receive_ns
                   AND q.source_dataset=t.source_dataset AND q.dbn_publisher_id=t.dbn_publisher_id
                   AND q.dbn_source_flags=t.dbn_source_flags
                  JOIN depth_ordered d
                    ON t.sequence=d.sequence AND t.event_ns=d.event_ns AND t.receive_ns=d.receive_ns
                   AND t.source_dataset=d.source_dataset AND t.dbn_publisher_id=d.dbn_publisher_id
                 WHERE d.event_position=1 AND (
                       d.dbn_source_flags IS DISTINCT FROM q.dbn_source_flags
                       OR d.best_bid IS DISTINCT FROM q.best_bid OR d.bid_size IS DISTINCT FROM q.bid_size
                       OR d.best_ask IS DISTINCT FROM q.best_ask OR d.ask_size IS DISTINCT FROM q.ask_size)
                 ORDER BY t.event_ns, t.record_id LIMIT 10
            """)
            quote_flag_checks = query("""
                WITH candidates AS (
                    SELECT t.record_id, count(d.sequence) FILTER (
                        WHERE d.dbn_source_flags=q.dbn_source_flags
                          AND d.best_bid IS NOT DISTINCT FROM q.best_bid
                          AND d.bid_size IS NOT DISTINCT FROM q.bid_size
                          AND d.best_ask IS NOT DISTINCT FROM q.best_ask
                          AND d.ask_size IS NOT DISTINCT FROM q.ask_size) AS flag_bbo_matches
                    FROM trades t LEFT JOIN quotes q
                      ON q.lineage_sha256=t.lineage_sha256 AND q.lineage_row=t.lineage_row
                     AND q.sequence=t.sequence AND q.event_ns=t.event_ns AND q.receive_ns=t.receive_ns
                     AND q.source_dataset=t.source_dataset AND q.dbn_publisher_id=t.dbn_publisher_id
                     AND q.dbn_source_flags=t.dbn_source_flags
                    LEFT JOIN depth_ordered d
                      ON t.sequence=d.sequence AND t.event_ns=d.event_ns AND t.receive_ns=d.receive_ns
                     AND t.source_dataset=d.source_dataset AND t.dbn_publisher_id=d.dbn_publisher_id
                    GROUP BY t.record_id
                ) SELECT flag_bbo_matches, count(*) AS trades FROM candidates GROUP BY ALL ORDER BY ALL
            """)
            witness_keys = query("""
                SELECT source_dataset, dbn_publisher_id, sequence, event_ns, receive_ns
                  FROM trades GROUP BY ALL HAVING count(*)>1
                 ORDER BY count(*) DESC, event_ns, receive_ns, sequence,
                          source_dataset, dbn_publisher_id LIMIT 3
            """)
            for mismatch in quote_mismatches:
                keys = query("SELECT source_dataset, dbn_publisher_id, sequence, event_ns, receive_ns "
                             "FROM trades WHERE record_id=?", [mismatch["record_id"]])
                for key in keys:
                    if key not in witness_keys:
                        witness_keys.append(key)
            event_witnesses = []
            for key in witness_keys:
                params = list(key.values())
                predicate = "source_dataset=? AND dbn_publisher_id=? AND sequence=? AND event_ns=? AND receive_ns=?"
                depth_rows = query(
                    "SELECT event_ns::VARCHAR AS event_ns, receive_ns::VARCHAR AS receive_ns, "
                    "source_rank, stable_position::VARCHAR AS stable_position, ordinal, "
                    "dbn_source_flags, event_position, best_bid, bid_size, best_ask, ask_size, "
                    "book_hash::VARCHAR AS book_hash FROM depth_ordered WHERE " + predicate +
                    " ORDER BY depth_ordered.source_rank, depth_ordered.stable_position, depth_ordered.ordinal LIMIT 65", params)
                trade_rows = query(
                    "SELECT record_id, lineage_sha256, lineage_row::VARCHAR AS lineage_row, "
                    "dbn_source_flags, side, price::VARCHAR AS price, size::VARCHAR AS size "
                    "FROM trades WHERE " + predicate + " ORDER BY trades.lineage_sha256, trades.lineage_row LIMIT 65", params)
                if len(depth_rows) > 64 or len(trade_rows) > 64:
                    raise ValueError("event witness exceeds 64 rows; no truncated ordering evidence is admitted")
                event_witnesses.append({"key": {field: str(value) if field in ("event_ns", "receive_ns") else value
                                                for field, value in key.items()},
                                        "depth": depth_rows, "trades": trade_rows,
                                        "tradeOrder": "lineage within each file only; cross-file order unqualified"})
        return {"depth": depth_plan["partition"], "trade": trade_plan["partition"],
                "depthIdentity": depth_identity, "tradeIdentity": trade_identity,
                "exactSequenceEventMatching": matching, "depthDuplicateKeys": duplicates,
                "tradeDuplicateIds": trade_duplicates, "eventLastFlags": event_flags,
                "tradeEventMultiplicity": trade_multiplicity,
                "depthSourceOrdering": ordering,
                "repeatedEventSamples": samples, "firstTradeBook": first_trade_book,
                "quote": quote_plan["partition"] if quote_plan is not None else None,
                "tradeTimeQuoteMatching": quote_checks, "tradeTimeQuoteMismatchSamples": quote_mismatches,
                "tradeTimeQuoteFlagMatching": quote_flag_checks, "eventWitnesses": event_witnesses,
                "scope": "source-order-diagnostics-only; not an accepted CME merge"}
    finally:
        connection.close()
        scratch.cleanup()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--depth-plan", type=Path, required=True)
    parser.add_argument("--trade-plan", type=Path, required=True)
    parser.add_argument("--quote-plan", type=Path)
    parser.add_argument("--max-source-bytes", type=int, default=DEFAULT_SOURCE_BYTES)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output is not None and (
            args.output.parent.resolve() != args.depth_plan.parent.resolve() or args.output.suffix != ".json"
            or args.output.resolve() in {path.resolve() for path in
                                        (args.depth_plan, args.trade_plan, args.quote_plan) if path is not None}):
        parser.error("output must be a separate JSON file next to the local pilot plans")
    result = inspect(args.depth_plan, args.trade_plan, args.quote_plan, args.max_source_bytes)
    if args.output is None:
        print(json.dumps(result, sort_keys=True))
    else:
        args.output.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
        print(json.dumps({"inspectedReport": args.output.name, "trades": result["trade"]["record_count"]}))
