from __future__ import annotations

import os

import pytest

import budget


# L2 NQ died with a bare "SCRATCH_BUDGET_EXCEEDED" after 1h53m of splitting.
# check() fails on either of two unrelated bounds and the message named neither,
# so the cause was not recoverable from the logs and a rerun would have been a
# guess. Its sibling GLOBAL_SCRATCH_RESERVE_EXCEEDED already reports free<required;
# this brings check() to the same standard.


def _write(root, name, size):
    path = root / name
    path.write_bytes(b"x" * size)
    return path


def test_a_stage_over_its_budget_names_the_bound_and_the_numbers(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "1000")
    monkeypatch.setenv("TT_CONVERT_FREE_RESERVE_BYTES", "1")
    _write(tmp_path, "a", 900)

    with pytest.raises(RuntimeError) as raised:
        budget.check(tmp_path, 200)

    message = str(raised.value)
    assert message.startswith("SCRATCH_BUDGET_EXCEEDED:STAGE_OVER_BUDGET:")
    assert "used=900" in message
    assert "additional=200" in message
    assert "maximum=1000" in message


def test_free_space_below_the_reserve_names_the_other_bound(tmp_path, monkeypatch):
    # An enormous reserve is the only portable way to drive this branch: the
    # free space of the test filesystem is not something a test may assume.
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", str(8 * 1024 ** 4))
    monkeypatch.setenv("TT_CONVERT_FREE_RESERVE_BYTES", str(8 * 1024 ** 5))

    with pytest.raises(RuntimeError) as raised:
        budget.check(tmp_path, 0)

    message = str(raised.value)
    assert message.startswith("SCRATCH_BUDGET_EXCEEDED:FREE_BELOW_RESERVE:")
    assert "free=" in message
    assert f"reserve={8 * 1024 ** 5}" in message
    assert "additional=0" in message


def test_the_two_bounds_are_reported_distinctly(tmp_path, monkeypatch):
    # Both bounds breached at once must still name the stage budget rather than
    # collapsing into one indistinguishable message, so the first thing to fix
    # is unambiguous.
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "10")
    monkeypatch.setenv("TT_CONVERT_FREE_RESERVE_BYTES", str(8 * 1024 ** 5))
    _write(tmp_path, "a", 100)

    with pytest.raises(RuntimeError) as raised:
        budget.check(tmp_path, 0)

    assert "STAGE_OVER_BUDGET" in str(raised.value)
    assert "FREE_BELOW_RESERVE" not in str(raised.value)


def test_a_check_inside_both_bounds_returns_the_remaining_budget(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "1000")
    monkeypatch.setenv("TT_CONVERT_FREE_RESERVE_BYTES", "1")
    _write(tmp_path, "a", 400)

    assert budget.check(tmp_path, 100) == 600


def test_nested_files_count_towards_the_stage_budget(tmp_path, monkeypatch):
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "1000")
    monkeypatch.setenv("TT_CONVERT_FREE_RESERVE_BYTES", "1")
    nested = tmp_path / "raw" / "deep"
    nested.mkdir(parents=True)
    _write(nested, "b", 900)

    with pytest.raises(RuntimeError, match="used=900"):
        budget.check(tmp_path, 200)


@pytest.mark.parametrize("name", ["TT_CONVERT_SCRATCH_BYTES", "TT_CONVERT_FREE_RESERVE_BYTES"])
def test_a_non_positive_limit_is_refused_rather_than_treated_as_unlimited(tmp_path, monkeypatch, name):
    monkeypatch.setenv("TT_CONVERT_SCRATCH_BYTES", "1000")
    monkeypatch.setenv("TT_CONVERT_FREE_RESERVE_BYTES", "1")
    monkeypatch.setenv(name, "0")

    with pytest.raises(ValueError, match=f"INVALID_LIMIT:{name}"):
        budget.check(tmp_path, 0)
