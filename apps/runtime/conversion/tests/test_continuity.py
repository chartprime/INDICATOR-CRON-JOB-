"""L2 depth continuity classification (design lock 19 section 0.4b, resolved
by Week-6/22-W6.06-Phase-3-Sequence-Research.md)."""
from __future__ import annotations

import continuity as cont


def _row(sequence, action="A", flags=0):
    return {"sequence": str(sequence), "action": action, "flags": str(flags)}


def test_the_very_first_row_a_stream_ever_sees_is_ok_regardless_of_its_own_flags():
    state = cont.new_state()
    result = cont.classify(state, _row(100, action="R"), file_boundary=True)
    assert result["continuity"] == "OK"
    assert result["book_epoch"] == 0
    assert result["prev_sequence"] is None and result["delta"] is None


def test_two_ordinary_consecutive_rows_stay_ok_in_the_same_epoch():
    state = cont.new_state()
    cont.classify(state, _row(1), file_boundary=True)
    result = cont.classify(state, _row(2), file_boundary=False)
    assert result["continuity"] == "OK" and result["book_epoch"] == 0
    assert result["prev_sequence"] == 1 and result["sequence"] == 2 and result["delta"] == 1


def test_an_observed_reset_action_opens_a_new_epoch():
    state = cont.new_state()
    cont.classify(state, _row(1), file_boundary=True)
    result = cont.classify(state, _row(2, action="R"), file_boundary=False)
    assert result["continuity"] == "RESET"
    assert result["book_epoch"] == 1
    assert state["observed_resets"] == 1


def test_a_maybe_bad_book_flag_opens_a_new_epoch_as_gap_suspected():
    state = cont.new_state()
    cont.classify(state, _row(1), file_boundary=True)
    result = cont.classify(state, _row(2, flags=cont.MAYBE_BAD_BOOK), file_boundary=False)
    assert result["continuity"] == "GAP_SUSPECTED"
    assert result["book_epoch"] == 1
    assert state["suspected_gaps"] == 1
    assert result["missing_estimate"] is None
    assert result["basis"] == "SEQUENCE_IS_CHANNEL_SCOPED_NOT_PER_INSTRUMENT"


def test_a_bare_sequence_jump_without_the_flag_is_not_suspicious():
    # The key regression test for the research finding: sequence is
    # channel-scoped, not per-instrument, so a jump alone proves nothing.
    state = cont.new_state()
    cont.classify(state, _row(1), file_boundary=True)
    result = cont.classify(state, _row(500), file_boundary=False)  # huge jump, no flag
    assert result["continuity"] == "OK"
    assert result["book_epoch"] == 0
    assert result["delta"] == 499
    assert state["suspected_gaps"] == 0


def test_a_file_boundary_with_no_other_signal_is_unknown_and_opens_a_new_epoch():
    state = cont.new_state()
    cont.classify(state, _row(1), file_boundary=True)
    cont.classify(state, _row(2), file_boundary=False)
    result = cont.classify(state, _row(999), file_boundary=True)  # new day-unit
    assert result["continuity"] == "UNKNOWN"
    assert result["book_epoch"] == 1


def test_a_reset_at_a_file_boundary_wins_over_bare_unknown():
    state = cont.new_state()
    cont.classify(state, _row(1), file_boundary=True)
    result = cont.classify(state, _row(2, action="R"), file_boundary=True)
    assert result["continuity"] == "RESET"


def test_a_flagged_gap_at_a_file_boundary_wins_over_bare_unknown():
    state = cont.new_state()
    cont.classify(state, _row(1), file_boundary=True)
    result = cont.classify(state, _row(2, flags=cont.MAYBE_BAD_BOOK), file_boundary=True)
    assert result["continuity"] == "GAP_SUSPECTED"


def test_summarize_folds_a_stream_into_one_row_per_epoch():
    state = cont.new_state()
    rows = []
    for i, (seq, action, boundary, ns) in enumerate([
        (1, "A", True, 100), (2, "A", False, 200),              # epoch 0
        (3, "R", False, 300), (4, "A", False, 400),              # epoch 1 (reset)
        (500, "A", True, 500),                                   # epoch 2 (unknown, new day-unit)
    ]):
        result = cont.classify(state, _row(seq, action=action), file_boundary=boundary)
        rows.append({**result, "event_ns": ns})

    summary = cont.summarize("v1", "AAPL-id", "depth", rows)
    assert [r["book_epoch"] for r in summary] == [0, 1, 2]
    assert summary[0] == {
        "instrument_id": "AAPL-id", "family": "depth", "dataset_version": "v1",
        "book_epoch": 0, "from_ns": 100, "to_ns": 200, "state": "OK",
        "observed_resets": 0, "suspected_gaps": 0,
    }
    assert summary[1]["state"] == "RESET" and summary[1]["from_ns"] == 300 and summary[1]["to_ns"] == 400
    assert summary[1]["observed_resets"] == 1
    assert summary[2]["state"] == "UNKNOWN" and summary[2]["from_ns"] == 500 and summary[2]["to_ns"] == 500


def test_summarize_spans_an_epoch_from_its_earliest_to_its_latest_event_in_any_order():
    state = cont.new_state()
    rows = []
    for seq, ns in [(1, 300), (2, 100), (3, 200)]:
        rows.append({**cont.classify(state, _row(seq), file_boundary=False), "event_ns": ns})
    summary = cont.summarize("v1", "AAPL-id", "depth", rows)
    assert (summary[0]["from_ns"], summary[0]["to_ns"]) == (100, 300)


def test_summarize_of_no_rows_is_empty():
    assert cont.summarize("v1", "x", "depth", []) == []


def test_per_day_summarize_calls_equal_one_combined_call(tmp_path):
    # job.py now folds each day's depth partition into the catalog's continuity
    # summary right after that day finalizes (so an evicted day's Parquet is
    # never read again), instead of one final scan over every accumulated
    # Parquet file. That's only correct because a file boundary always opens a
    # new book_epoch (continuity.classify), so two different days' partitions
    # never share an epoch. Prove the two call patterns agree, not just assert
    # it from reading the code.
    import duckdb

    def _make(path, epochs):
        con = duckdb.connect()
        rows = ", ".join(f"({i}, {epoch}, '{state}')" for i, (epoch, state) in enumerate(epochs))
        con.execute(f"CREATE TABLE d AS SELECT * FROM (VALUES {rows}) AS t(event_ns, book_epoch, continuity)")
        con.execute("ALTER TABLE d ADD COLUMN source_rank INTEGER DEFAULT 0")
        con.execute("ALTER TABLE d ADD COLUMN stable_position BIGINT DEFAULT 0")
        con.execute("ALTER TABLE d ADD COLUMN ordinal INTEGER DEFAULT 0")
        con.execute("COPY d TO ? (FORMAT PARQUET)", [str(path)])
        con.close()

    day1 = tmp_path / "day1.parquet"
    day2 = tmp_path / "day2.parquet"
    _make(day1, [(0, "OK"), (0, "OK"), (1, "RESET")])
    _make(day2, [(2, "UNKNOWN"), (2, "OK"), (3, "GAP_SUSPECTED")])

    combined = list(cont.summarize_parquet("v1", "x", [str(day1), str(day2)], str(tmp_path)))
    per_day = list(cont.summarize_parquet("v1", "x", [str(day1)], str(tmp_path))) + \
        list(cont.summarize_parquet("v1", "x", [str(day2)], str(tmp_path)))

    assert [r["book_epoch"] for r in combined] == [0, 1, 2, 3]
    assert per_day == combined


def test_parquet_summary_matches_reference_without_materializing_tape(tmp_path):
    import duckdb
    path = tmp_path / "depth.parquet"
    con = duckdb.connect()
    con.execute("CREATE TABLE d AS SELECT i AS event_ns, 0 AS source_rank, i AS stable_position, "
                "0 AS ordinal, CAST(i//10000 AS INTEGER) AS book_epoch, "
                "CASE WHEN i=10000 THEN 'RESET' WHEN i=20000 THEN 'GAP_SUSPECTED' ELSE 'OK' END AS continuity "
                "FROM range(30000) t(i)")
    con.execute("COPY d TO ? (FORMAT PARQUET)", [str(path)])
    con.close()
    rows = list(cont.summarize_parquet("v1", "x", [str(path)], str(tmp_path)))
    assert len(rows) == 3
    assert rows[0]["from_ns"] == 0 and rows[0]["to_ns"] == 9999
    assert rows[1]["state"] == "RESET" and rows[1]["observed_resets"] == 1
    assert rows[2]["state"] == "GAP_SUSPECTED" and rows[2]["suspected_gaps"] == 1


def test_summarize_parquet_honors_finalize_thread_budget(tmp_path, monkeypatch):
    import duckdb

    path = tmp_path / "depth.parquet"
    con = duckdb.connect()
    try:
        con.execute(
            "CREATE TABLE d AS SELECT 1::BIGINT AS event_ns, 0::INTEGER AS source_rank, "
            "0::BIGINT AS stable_position, 0::INTEGER AS ordinal, 0::INTEGER AS book_epoch, "
            "'OK'::VARCHAR AS continuity"
        )
        con.execute("COPY d TO ? (FORMAT PARQUET)", [str(path)])
    finally:
        con.close()

    real_connect = duckdb.connect
    captured = {}

    def capturing_connect(*args, **kwargs):
        captured.update(kwargs.get("config", {}))
        return real_connect(*args, **kwargs)

    monkeypatch.setenv("TT_CONVERT_FINALIZE_THREADS", "3")
    monkeypatch.setattr(duckdb, "connect", capturing_connect)

    rows = list(cont.summarize_parquet("v1", "x", [str(path)], str(tmp_path)))

    assert rows[0]["book_epoch"] == 0
    assert captured["threads"] == "3"
