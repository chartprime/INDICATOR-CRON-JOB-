"""List exact daily L2 partition presence from a read-only pinned catalog."""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import date
from pathlib import Path


def inspect(catalog: Path, month: str) -> dict[str, object]:
    start = date.fromisoformat(f"{month}-01")
    if start.strftime("%Y-%m") != month:
        raise ValueError("invalid month")
    end = date(start.year + (start.month == 12), (start.month % 12) + 1, 1)
    connection = sqlite3.connect(f"file:{catalog.resolve().as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT instrument_id, family, date, dataset_version, record_count, published_to_s3 "
            "FROM partitions WHERE family IN ('depth', 'trade') AND date >= ? AND date < ? "
            "ORDER BY instrument_id, family, date, dataset_version",
            (start.isoformat(), end.isoformat()),
        ).fetchall()
    finally:
        connection.close()
    grouped = defaultdict(lambda: defaultdict(list))
    for instrument, family, day, version, count, published in rows:
        grouped[instrument][family].append({"date": day, "version": version,
                                            "rows": count, "published": bool(published)})
    return {"month": month, "instruments": grouped}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--month", required=True)
    options = parser.parse_args()
    print(json.dumps(inspect(options.catalog, options.month), sort_keys=True))
