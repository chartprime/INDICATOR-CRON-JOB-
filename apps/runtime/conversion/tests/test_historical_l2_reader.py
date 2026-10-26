from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sys

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import historical_l2_reader as reader
from test_historical_l2_lifecycles import delayed
from test_historical_l2_seconds import sampled


@pytest.fixture(params=["events", "states"])
def source(tmp_path, request):
    family = request.param
    module = reader.MODULES[family]
    rows = delayed() if family == "events" else sampled()
    directory = tmp_path / family
    manifest = module.write_parts(rows, directory, part_rows=3)
    expected = [{**row, "append_position": str(index)} for index, row in enumerate(rows)]
    return family, directory, manifest, expected


def run(source, *, from_ns="0", to_ns="5000000000", cut=None, limit=1000, after=None, **options):
    family, directory, manifest, _rows = source

    @contextmanager
    def resolve(part):
        yield directory / part["name"]

    with duckdb.connect(config={"threads": "1", "memory_limit": "128MB"}) as connection:
        return reader.read_page(connection, manifest, family, resolve, from_ns=from_ns, to_ns=to_ns,
                                as_of_key=cut or ["4999999999", "999", "999", "999"],
                                limit=limit, after_position=after, **options)


def collect(source, **options):
    after, received, pages = None, [], []
    for _attempt in range(1000):
        page = run(source, after=after, **options)
        received.extend(page["rows"])
        pages.append(page)
        if page["nextPosition"] is None:
            return received, pages
        assert after is None or int(page["nextPosition"]) > int(after)
        after = page["nextPosition"]
    pytest.fail("pagination did not terminate")


@pytest.mark.parametrize("limit", [1, 3, 10_000])
def test_every_field_matches_independent_full_reference_across_ties_and_parts(source, limit):
    rows, pages = collect(source, limit=limit)
    assert rows == source[3]
    assert len({row["append_position"] for row in rows}) == len(rows)
    assert all(len(page["rows"]) <= limit for page in pages)


@pytest.mark.parametrize("window,cut", [
    (("1200000000", "2900000000"), ["2899999999", "2", "99", "0"]),
    (("0", "2900000001"), ["2900000000", "2", "1", "0"]),
    (("0", "2800000000"), ["2799999999", "2", "99", "0"]),
    (("4500000000", "5000000000"), ["4999999999", "2", "99", "0"]),
])
def test_half_open_windows_and_exact_knowledge_cut_never_leak_delayed_evidence(source, window, cut):
    expected = [row for row in source[3] if int(window[0]) <= int(row["known_ns"]) < int(window[1])
                and (row["known_key"] is None or tuple(map(int, row["known_key"])) <= tuple(map(int, cut)))]
    received, _pages = collect(source, from_ns=window[0], to_ns=window[1], cut=cut, limit=1)
    assert received == expected


def test_byte_and_scan_pages_progress_without_loss(source):
    largest = max(len(json.dumps(row, separators=(",", ":")).encode()) for row in source[3])
    budget = reader.ENVELOPE_RESERVE + largest + 2
    received, pages = collect(source, max_page_bytes=budget)
    assert received == source[3]
    assert any(page["truncatedBy"] == "bytes" for page in pages)
    assert all(len(json.dumps(page, separators=(",", ":")).encode()) <= budget for page in pages)
    scan_budget = max(part["bytes"] for part in source[2]["parts"])
    received, pages = collect(source, max_scan_bytes=scan_budget)
    assert received == source[3]
    assert any(page["truncatedBy"] == "scan" for page in pages)
    assert all(page["scanBytes"] <= scan_budget for page in pages)


def test_too_small_first_part_or_row_is_an_explicit_refusal(source):
    with pytest.raises(ValueError, match="first part exceeds"):
        run(source, max_scan_bytes=1)
    with pytest.raises(ValueError, match="row exceeds"):
        run(source, max_page_bytes=reader.ENVELOPE_RESERVE + 3)


def test_corruption_and_cancellation_never_return_short_success(source):
    with pytest.raises(InterruptedError):
        run(source, cancelled=lambda: True)
    file = source[1] / source[2]["parts"][0]["name"]
    with file.open("ab") as sink:
        sink.write(b"corrupt")
    with pytest.raises(ValueError, match="integrity"):
        run(source)


@pytest.mark.parametrize("change", [
    lambda manifest: manifest["parts"][0].update(name="../escape.parquet"),
    lambda manifest: manifest["parts"][0].update(bytes=True),
    lambda manifest: manifest["parts"][0].update(sha256="0" * 63),
    lambda manifest: manifest.update(rows=manifest["rows"] + 1),
    lambda manifest: manifest["parts"][1].update(first_known_ns="0"),
])
def test_malformed_manifest_cannot_select_files(source, change):
    family, directory, manifest, rows = source
    changed = deepcopy(manifest)
    change(changed)
    with pytest.raises(ValueError):
        run((family, directory, changed, rows))


@pytest.mark.parametrize("options", [
    {"limit": True}, {"limit": 10_001}, {"from_ns": "0", "to_ns": "0"},
    {"to_ns": "3600000000001"}, {"cut": ["5000000000", "2", "0", "0"]},
    {"cut": ["0"]}, {"after": "18446744073709551615"},
])
def test_invalid_requests_are_refused_before_read(source, options):
    with pytest.raises(ValueError):
        run(source, **options)


def test_continuation_resumes_strictly_after_the_last_delivered_row(source):
    first = run(source, limit=1)
    token = first["nextPosition"]
    assert token is not None
    second = run(source, limit=1, after=token)
    assert int(second["rows"][0]["append_position"]) > int(token)
