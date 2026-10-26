"""L2 (`mbp-10`) depth continuity: observed vs inferred (design lock 19
section 0.4b, resolved by `Week-6/22-W6.06-Phase-3-Sequence-Research.md`).

Classifies each depth row's relationship to its kept predecessor within one
`(instrument, family)` stream, and tracks a monotonic `book_epoch` across
the whole stream -- which spans every source file/date in a
dataset_version, not just one day.

Research resolved a design-lock open question: Databento's `sequence` is
scoped to their internal delivery *channel*, not per-instrument, so a raw
`sequence` jump does not reliably mean *this instrument* missed messages
(other instruments sharing the channel advance the same counter). Databento
instead gives an authoritative signal directly: the `flags` byte's
`MAYBE_BAD_BOOK` bit (`1 << 2`), documented as "an unrecoverable gap was
detected in the channel." That flag -- not sequence arithmetic -- is what
triggers `GAP_SUSPECTED` here. A bare sequence jump without the flag is
recorded as informational evidence only; it never changes state or epoch.
"""
from __future__ import annotations

MAYBE_BAD_BOOK = 1 << 2  # dbn crate flags.rs -- "an unrecoverable gap was detected in the channel"

_STATES = ("OK", "RESET", "GAP_SUSPECTED", "UNKNOWN")


class ContinuityError(RuntimeError):
    pass


def new_state():
    """A fresh tracker for one (instrument, family) stream: no predecessor
    seen yet, epoch 0."""
    return {"epoch": 0, "have_predecessor": False, "prev_sequence": None,
            "observed_resets": 0, "suspected_gaps": 0}


def classify(state, row, *, file_boundary):
    """Classify one depth row against `state` (mutated in place) and return
    its own `{continuity, book_epoch, prev_sequence, sequence, delta,
    missing_estimate, basis}`.

    `file_boundary` must be True for the first row read from a new source
    day-unit for this stream (we never carry cross-file relation) and False
    for every subsequent row read from that same day-unit. Precedence when
    more than one condition is true on the same row: an observed `RESET` or
    a `MAYBE_BAD_BOOK` flag is *positive* evidence of exactly what happened
    and outranks a bare file-boundary `UNKNOWN` (an absence of information)
    -- e.g. a day-unit's very first row being an explicit reset is reported
    as RESET, not UNKNOWN.
    """
    sequence = int(row["sequence"])
    flags = int(row["flags"])
    action = row["action"]

    if not state["have_predecessor"]:
        continuity = "OK"
    elif action == "R":
        continuity = "RESET"
        state["observed_resets"] += 1
        state["epoch"] += 1
    elif flags & MAYBE_BAD_BOOK:
        continuity = "GAP_SUSPECTED"
        state["suspected_gaps"] += 1
        state["epoch"] += 1
    elif file_boundary:
        continuity = "UNKNOWN"
        state["epoch"] += 1
    else:
        continuity = "OK"

    result = {
        "continuity": continuity, "book_epoch": state["epoch"],
        "prev_sequence": state["prev_sequence"], "sequence": sequence,
        "delta": None if state["prev_sequence"] is None else sequence - state["prev_sequence"],
        "missing_estimate": None,
        "basis": "SEQUENCE_IS_CHANNEL_SCOPED_NOT_PER_INSTRUMENT",
    }
    state["have_predecessor"] = True
    state["prev_sequence"] = sequence
    return result


def summarize(dataset_version, instrument_id, family, classified_rows):
    """Fold a stream's classified rows (each carrying `event_ns` and the
    `classify()` output) into one row per `book_epoch`, matching
    `catalog.CatalogBuilder.record_continuity`'s expected shape. Every epoch
    interval contains at most one triggering event at its start (any
    reset/gap/unknown immediately opens a new epoch), so `observed_resets`/
    `suspected_gaps` are always 0 or 1 per row here; `state` names which
    kind of boundary opened the epoch (`OK` for the stream's own start).
    """
    if not classified_rows:
        return []
    by_epoch = {}
    for row in classified_rows:
        epoch = row["book_epoch"]
        entry = by_epoch.setdefault(epoch, {
            "instrument_id": instrument_id, "family": family, "dataset_version": dataset_version,
            "book_epoch": epoch, "from_ns": row["event_ns"], "to_ns": row["event_ns"],
            "state": row["continuity"], "observed_resets": 0, "suspected_gaps": 0,
        })
        entry["from_ns"] = min(entry["from_ns"], row["event_ns"])
        entry["to_ns"] = max(entry["to_ns"], row["event_ns"])
        if row["continuity"] == "RESET":
            entry["observed_resets"] += 1
        elif row["continuity"] == "GAP_SUSPECTED":
            entry["suspected_gaps"] += 1
    return [by_epoch[e] for e in sorted(by_epoch)]


def summarize_parquet(dataset_version, instrument_id, paths, scratch_root):
    """Aggregate in bounded DuckDB; never fetch the entire depth tape to Python."""
    import os
    import duckdb
    import budget
    spill = os.path.join(scratch_root, "continuity-spill")
    os.makedirs(spill, exist_ok=True)
    limit = min(budget.check(scratch_root), budget.positive_env("TT_CONVERT_SPILL_BYTES", 512 * 1024**2))
    finalize_threads = budget.positive_env("TT_CONVERT_FINALIZE_THREADS", 8)
    con = duckdb.connect(config={"memory_limit": "512MB", "threads": str(finalize_threads),
                                "temp_directory": spill, "max_temp_directory_size": f"{limit}B"})
    try:
        result = con.execute(
            "SELECT book_epoch, min(event_ns), max(event_ns), "
            "arg_min(continuity, (event_ns, source_rank, stable_position, ordinal)), "
            "count(*) FILTER (WHERE continuity='RESET'), "
            "count(*) FILTER (WHERE continuity='GAP_SUSPECTED') "
            "FROM read_parquet(?) GROUP BY book_epoch ORDER BY book_epoch", [paths])
        while batch := result.fetchmany(1024):
            for epoch, start, end, state, resets, gaps in batch:
                yield {"dataset_version": dataset_version, "instrument_id": instrument_id, "family": "depth",
                       "book_epoch": epoch, "from_ns": start, "to_ns": end, "state": state,
                       "observed_resets": resets, "suspected_gaps": gaps}
    finally:
        con.close()
