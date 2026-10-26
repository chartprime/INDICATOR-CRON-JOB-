"""Monthly-file day-splitting (design lock 19 section 0.11)."""
from __future__ import annotations

import os

import pytest

import split as sp

_S3_KEY = "raw/databento/dataset=GLBX.MDP3/schema=mbp-1/symbol=ES/year=2025/month=09/es-2025-09.dbn.zst"


def _row(ts_event):
    return {"ts_event": str(ts_event), "price": "1"}


def _ns(date, seconds=0):
    import datetime as dt
    return int(dt.datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000 + seconds * 1_000_000_000


def test_splits_rows_into_one_ndjson_file_per_utc_date_in_chronological_order(tmp_path):
    rows = [
        (0, _row(_ns("2025-09-01", 0))),
        (1, _row(_ns("2025-09-01", 10))),
        (2, _row(_ns("2025-09-02", 5))),
        (3, _row(_ns("2025-09-03", 1))),
    ]
    units = sp.split_by_day(iter(rows), tmp_path, _S3_KEY)
    assert [u["date"] for u in units] == ["2025-09-01", "2025-09-02", "2025-09-03"]
    assert units[0] == {
        "sha256": sp._sha(units[0]["path"]), "date": "2025-09-01", "path": units[0]["path"], "first_row": 0, "last_row": 1, "row_count": 2,
    }
    for u in units:
        assert os.path.isfile(u["path"])
        assert not os.path.isfile(u["path"] + ".partial")


def test_read_day_round_trips_index_and_row_in_original_order(tmp_path):
    rows = [(0, _row(_ns("2025-09-01", 0))), (1, _row(_ns("2025-09-01", 1)))]
    units = sp.split_by_day(iter(rows), tmp_path, _S3_KEY)
    roundtrip = list(sp.read_day(units[0]["path"]))
    assert roundtrip == rows


def test_interleaved_dates_are_grouped_correctly_not_just_by_contiguity(tmp_path):
    rows = [
        (0, _row(_ns("2025-09-01"))),
        (1, _row(_ns("2025-09-02"))),
        (2, _row(_ns("2025-09-01"))),  # out of order relative to date, must still group correctly
    ]
    units = sp.split_by_day(iter(rows), tmp_path, _S3_KEY)
    by_date = {u["date"]: u for u in units}
    assert by_date["2025-09-01"]["row_count"] == 2
    assert by_date["2025-09-01"]["first_row"] == 0
    assert by_date["2025-09-01"]["last_row"] == 2
    assert by_date["2025-09-02"]["row_count"] == 1


def test_missing_timestamp_field_raises_and_a_retry_still_succeeds_cleanly(tmp_path):
    bad_rows = [(0, {"no_ts": "x"})]
    with pytest.raises(sp.SplitError, match="MISSING_TS_FIELD"):
        sp.split_by_day(iter(bad_rows), tmp_path, _S3_KEY)
    # Simulates resuming after a crash mid-split: calling again with a clean
    # decode must succeed and must not be confused by any leftover state.
    good_rows = [(0, _row(_ns("2025-09-01")))]
    units = sp.split_by_day(iter(good_rows), tmp_path, _S3_KEY)
    assert [u["date"] for u in units] == ["2025-09-01"]


def test_a_second_split_of_the_same_job_and_key_overwrites_the_first_cleanly(tmp_path):
    first = sp.split_by_day(iter([(0, _row(_ns("2025-09-01"))), (1, _row(_ns("2025-09-02")))]), tmp_path, _S3_KEY)
    assert [u["date"] for u in first] == ["2025-09-01", "2025-09-02"]
    second = sp.split_by_day(iter([(0, _row(_ns("2025-09-05")))]), tmp_path, _S3_KEY)
    assert [u["date"] for u in second] == ["2025-09-05"]
    assert not os.path.isfile(first[0]["path"])  # stale day file from the first attempt is gone


def test_empty_input_raises_no_rows_to_split(tmp_path):
    with pytest.raises(sp.SplitError, match="NO_ROWS_TO_SPLIT"):
        sp.split_by_day(iter([]), tmp_path, _S3_KEY)


def test_split_dir_is_deterministic_and_filesystem_safe_for_a_slashy_s3_key(tmp_path):
    d1 = sp.split_dir(tmp_path, _S3_KEY)
    d2 = sp.split_dir(tmp_path, _S3_KEY)
    assert d1 == d2
    assert "/" not in os.path.basename(d1) and "\\" not in os.path.basename(d1)
