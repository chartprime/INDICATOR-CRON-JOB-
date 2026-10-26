"""Source presence never substitutes for an independently qualified L2 session."""

from __future__ import annotations

import datetime as dt
import re


def source_disposition(depth, trade, catalog_sha256):
    if not isinstance(catalog_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", catalog_sha256):
        raise ValueError("immutable source catalog pin required")
    for partition, family in ((depth, "depth"), (trade, "trade")):
        if (partition.get("family") != family or not partition.get("instrument_id")
                or not isinstance(partition.get("manifest_sha256"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", partition["manifest_sha256"])
                or type(partition.get("record_count")) is not int or partition["record_count"] < 0):
            raise ValueError("source partition identity/count required")
        if dt.date.fromisoformat(partition["date"]).isoformat() != partition["date"]:
            raise ValueError("canonical ISO source date required")
    if any(depth[field] != trade[field] for field in ("instrument_id", "date")):
        raise ValueError("depth and trade refer to different sessions")
    reason = "AWAITING_FULL_DAY_QUALIFICATION"
    if depth["record_count"] < 2:
        reason = "SINGLE_SNAPSHOT_SOURCE_WITH_TRADES" if trade["record_count"] else "NO_INTRADAY_SOURCE_PROOF"
    return {"schema": "historical-l2-source-disposition/1", "catalog_sha256": catalog_sha256,
            "date": depth["date"], "instrument_id": depth["instrument_id"], "available": False, "reason": reason,
            "depth_manifest_sha256": depth["manifest_sha256"], "depth_rows": depth["record_count"],
            "trade_manifest_sha256": trade["manifest_sha256"], "trade_rows": trade["record_count"]}


def require_intraday_source(depth, trade, catalog_sha256):
    disposition = source_disposition(depth, trade, catalog_sha256)
    if disposition["reason"] != "AWAITING_FULL_DAY_QUALIFICATION":
        raise ValueError(disposition["reason"])
    return disposition
