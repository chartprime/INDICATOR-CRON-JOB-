from __future__ import annotations

import datetime as _dt
import glob
import hashlib
import json
import os
import re
import shutil
import time

import duckdb
import budget

CONVERTER_VERSION = "conversion/0.2"
LOGICAL_SHA256_FORMAT = "json-insertion-v2"
SCHEMA_VERSION = "market-observation/1"
MAX_DECIMAL_SCALE = 12
DUCKDB_MEMORY_LIMIT_BYTES_DEFAULT = 4 * 1024**3
FINALIZE_THREADS_DEFAULT = 8
ROW_GROUP_SIZE = 262144
SORT_KEY = ("event_ns", "source_rank", "stable_position", "ordinal")
BUDGET_CHECK_GRANULARITY_BYTES = 64 * 1024 * 1024

_COMMON_COLUMNS = {
    "record_id": "VARCHAR", "event_ns": "UBIGINT", "source_rank": "USMALLINT",
    "stable_position": "UBIGINT", "ordinal": "UINTEGER", "sequence": "BIGINT",
    "receive_ns": "UBIGINT", "ingest_ns": "UBIGINT", "time_precision": "VARCHAR",
    "time_origin": "VARCHAR", "instrument_id": "VARCHAR", "venue": "VARCHAR",
    "market": "VARCHAR", "symbol": "VARCHAR", "currency": "VARCHAR", "size_unit": "VARCHAR",
    "contract": "VARCHAR", "source_provider": "VARCHAR", "source_dataset": "VARCHAR",
    "source_schema": "VARCHAR", "source_population": "VARCHAR", "source_dataset_version": "VARCHAR",
    "source_method_version": "VARCHAR", "source_symbol": "VARCHAR", "mapping_version": "VARCHAR",
    "mapping_reference": "VARCHAR", "stream_id": "VARCHAR", "lineage_sha256": "VARCHAR",
    "lineage_row": "UBIGINT", "quality_state": "VARCHAR", "quality_flags": "VARCHAR[]",
}
_FAMILY_COLUMNS = {
    "trade": {
        "trade_entity_id": "VARCHAR", "price": "DECIMAL(38,12)", "size": "DECIMAL(38,12)",
        "side": "VARCHAR", "trade_action": "VARCHAR", "valid_tick": "BOOLEAN", "replaces": "VARCHAR",
        "dbn_publisher_id": "BIGINT", "dbn_source_flags": "INTEGER", "dbn_source_action": "VARCHAR",
    },
    "quote": {
        "bid_price": "DECIMAL(38,12)", "bid_size": "DECIMAL(38,12)",
        "ask_price": "DECIMAL(38,12)", "ask_size": "DECIMAL(38,12)",
        "dbn_source_flags": "INTEGER", "dbn_publisher_id": "BIGINT", "dbn_source_action": "VARCHAR",
    },
    "candle": {
        "open_ns": "UBIGINT", "close_ns": "UBIGINT", "open": "DECIMAL(38,12)", "high": "DECIMAL(38,12)",
        "low": "DECIMAL(38,12)", "close": "DECIMAL(38,12)", "volume": "DECIMAL(38,12)",
        "buy_volume": "DECIMAL(38,12)", "closed": "BOOLEAN", "method": "VARCHAR",
        "quote_volume": "DECIMAL(38,12)", "taker_buy_quote_volume": "DECIMAL(38,12)",
        "taker_sell_base_volume": "DECIMAL(38,12)", "taker_sell_quote_volume": "DECIMAL(38,12)",
        "trade_count": "BIGINT",
    },
    "depth": {
        "depth_action": "VARCHAR", "depth_model": "VARCHAR", "depth_limit": "INTEGER",
        "bids": "STRUCT(price DECIMAL(38,12), size DECIMAL(38,12))[]",
        "asks": "STRUCT(price DECIMAL(38,12), size DECIMAL(38,12))[]",
        "first_sequence": "BIGINT", "last_sequence": "BIGINT", "previous_sequence": "BIGINT",
        "batch_id": "VARCHAR", "batch_end": "BOOLEAN", "reset": "BOOLEAN",
        "book_epoch": "UINTEGER", "continuity": "VARCHAR",
        "dbn_source_flags": "INTEGER", "dbn_publisher_id": "BIGINT",
    },
    "trade_minute": {
        "open_ns": "UBIGINT", "close_ns": "UBIGINT", "volume": "DECIMAL(38,12)",
        "buy_volume": "DECIMAL(38,12)", "sell_volume": "DECIMAL(38,12)", "undefined_volume": "DECIMAL(38,12)",
        "buy_notional": "DECIMAL(38,12)", "sell_notional": "DECIMAL(38,12)", "trade_count": "BIGINT",
        "method": "VARCHAR",
    },
    "trade_level": {
        "open_ns": "UBIGINT", "close_ns": "UBIGINT", "tick_size": "DECIMAL(38,12)", "price_bucket": "BIGINT",
        "volume": "DECIMAL(38,12)", "buy_volume": "DECIMAL(38,12)", "sell_volume": "DECIMAL(38,12)",
        "trade_count": "BIGINT", "method": "VARCHAR",
    },
    "trade_slice": {
        "open_ns": "UBIGINT", "close_ns": "UBIGINT", "last_trade_ns": "UBIGINT",
        "buy_notional": "DECIMAL(38,12)", "sell_notional": "DECIMAL(38,12)", "trade_count": "BIGINT",
        "method": "VARCHAR",
    },
    "trade_prints": {
        "open_ns": "UBIGINT", "close_ns": "UBIGINT", "side": "VARCHAR", "rank": "USMALLINT",
        "trade_ns": "UBIGINT", "price": "DECIMAL(38,12)", "size": "DECIMAL(38,12)",
        "trade_entity_id": "VARCHAR", "method": "VARCHAR",
    },
}


class WriterError(RuntimeError):
    pass


def manifest_part_paths(directory, manifest):
    paths = []
    for part in manifest["parts"]:
        name = part["name"]
        if not isinstance(name, str) or not re.fullmatch(r"part-[0-9]+\.parquet", name):
            raise WriterError("INVALID_MANIFEST_PART_NAME")
        path = os.path.join(directory, name)
        if path in paths or os.path.islink(path):
            raise WriterError("INVALID_MANIFEST_PART_PATH")
        if _sha256_file(path) != part["sha256"]:
            raise WriterError("PART_INTEGRITY_FAILURE")
        paths.append(path)
    return paths


class QuarantineRow(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _dec_text(value):
    coef = str(value["coefficient"])
    scale = int(value["scale"])
    if scale > MAX_DECIMAL_SCALE:
        raise QuarantineRow(f"DECIMAL_SCALE_EXCEEDS_{MAX_DECIMAL_SCALE}")
    neg = coef.startswith("-")
    coefficient = coef[1:] if neg else coef
    if len(coefficient.lstrip("0") or "0") > 38:
        raise QuarantineRow("DECIMAL_PRECISION_EXCEEDS_38")
    digits = coefficient.rjust(scale + 1, "0")
    body = digits if scale == 0 else f"{digits[:-scale]}.{digits[-scale:]}"
    return ("-" if neg else "") + body


def _dec_or_none(value):
    return None if value is None else _dec_text(value)


def _int_or_none(value):
    return None if value is None else int(value)


def _common(record, source_rank):
    inst, src, tm, order, lin, q = (
        record["instrument"], record["source"], record["time"], record["order"], record["lineage"], record["quality"],
    )
    return {
        "record_id": record["id"], "event_ns": int(tm["eventNs"]), "source_rank": int(source_rank),
        "stable_position": int(order["position"]), "ordinal": int(order["ordinal"]),
        "sequence": _int_or_none(order["sequence"]), "receive_ns": _int_or_none(tm["receiveNs"]),
        "ingest_ns": int(tm["ingestNs"]), "time_precision": tm["precision"], "time_origin": tm["origin"],
        "instrument_id": inst["id"], "venue": inst["venue"], "market": inst["market"], "symbol": inst["symbol"],
        "currency": inst["currency"], "size_unit": inst["sizeUnit"], "contract": inst["contract"],
        "source_provider": src["provider"], "source_dataset": src["dataset"], "source_schema": src["schema"],
        "source_population": src["population"], "source_dataset_version": src["datasetVersion"],
        "source_method_version": src["methodVersion"], "source_symbol": src["sourceSymbol"],
        "mapping_version": src["mappingVersion"], "mapping_reference": src["mappingReference"], "stream_id": src["streamId"],
        "lineage_sha256": lin["sha256"], "lineage_row": int(lin["row"]),
        "quality_state": q["state"], "quality_flags": list(q["flags"]),
    }


def _trade(d):
    return {
        "trade_entity_id": d["entityId"], "price": _dec_or_none(d["price"]), "size": _dec_or_none(d["size"]),
        "side": d["side"], "trade_action": d["action"], "valid_tick": d["validTick"], "replaces": d["replaces"],
        "dbn_publisher_id": _int_or_none(d.get("publisherId")), "dbn_source_flags": _int_or_none(d.get("sourceFlags")),
        "dbn_source_action": d.get("sourceAction"),
    }


def _quote(d):
    return {
        "bid_price": _dec_or_none(d["bid"]["price"]), "bid_size": _dec_or_none(d["bid"]["size"]),
        "ask_price": _dec_or_none(d["ask"]["price"]), "ask_size": _dec_or_none(d["ask"]["size"]),
        "dbn_source_flags": _int_or_none(d.get("sourceFlags")), "dbn_publisher_id": _int_or_none(d.get("publisherId")),
        "dbn_source_action": d.get("sourceAction"),
    }


def _candle(d):
    return {
        "open_ns": int(d["openNs"]), "close_ns": int(d["closeNs"]), "open": _dec_text(d["open"]),
        "high": _dec_text(d["high"]), "low": _dec_text(d["low"]), "close": _dec_text(d["close"]),
        "volume": _dec_text(d["volume"]), "buy_volume": _dec_or_none(d["buyVolume"]),
        "closed": d["closed"], "method": d["method"],
        "quote_volume": _dec_or_none(d.get("quoteVolume")),
        "taker_buy_quote_volume": _dec_or_none(d.get("takerBuyQuoteVolume")),
        "taker_sell_base_volume": _dec_or_none(d.get("takerSellBaseVolume")),
        "taker_sell_quote_volume": _dec_or_none(d.get("takerSellQuoteVolume")),
        "trade_count": _int_or_none(d.get("tradeCount")),
    }


def _levels(entries):
    return [{"price": _dec_text(e["price"]), "size": _dec_text(e["size"])} for e in entries]


def _depth(d):
    return {
        "depth_action": d["action"], "depth_model": d["model"], "depth_limit": _int_or_none(d["depthLimit"]),
        "bids": _levels(d["bids"]), "asks": _levels(d["asks"]),
        "first_sequence": _int_or_none(d["firstSequence"]), "last_sequence": _int_or_none(d["lastSequence"]),
        "previous_sequence": _int_or_none(d["previousSequence"]),
        "batch_id": d["batchId"], "batch_end": d["batchEnd"], "reset": d["reset"],
        "book_epoch": None, "continuity": None,
        "dbn_source_flags": _int_or_none(d.get("sourceFlags")), "dbn_publisher_id": _int_or_none(d.get("publisherId")),
    }


def _trade_minute(d):
    return {
        "open_ns": int(d["openNs"]), "close_ns": int(d["closeNs"]), "volume": _dec_text(d["volume"]),
        "buy_volume": _dec_text(d["buyVolume"]), "sell_volume": _dec_text(d["sellVolume"]),
        "undefined_volume": _dec_text(d["undefinedVolume"]), "buy_notional": _dec_text(d["buyNotional"]),
        "sell_notional": _dec_text(d["sellNotional"]), "trade_count": int(d["tradeCount"]), "method": d["method"],
    }


def _trade_level(d):
    return {
        "open_ns": int(d["openNs"]), "close_ns": int(d["closeNs"]), "tick_size": _dec_text(d["tickSize"]),
        "price_bucket": int(d["priceBucket"]), "volume": _dec_text(d["volume"]),
        "buy_volume": _dec_text(d["buyVolume"]), "sell_volume": _dec_text(d["sellVolume"]),
        "trade_count": int(d["tradeCount"]), "method": d["method"],
    }


def _trade_slice(d):
    return {
        "open_ns": int(d["openNs"]), "close_ns": int(d["closeNs"]), "last_trade_ns": int(d["lastTradeNs"]),
        "buy_notional": _dec_text(d["buyNotional"]), "sell_notional": _dec_text(d["sellNotional"]),
        "trade_count": int(d["tradeCount"]), "method": d["method"],
    }


def _trade_prints(d):
    return {
        "open_ns": int(d["openNs"]), "close_ns": int(d["closeNs"]), "side": d["side"], "rank": int(d["rank"]),
        "trade_ns": int(d["tradeNs"]), "price": _dec_text(d["price"]), "size": _dec_text(d["size"]),
        "trade_entity_id": d["tradeEntityId"], "method": d["method"],
    }


_FAMILY_FLATTEN = {
    "trade": _trade, "quote": _quote, "candle": _candle, "depth": _depth,
    "trade_minute": _trade_minute, "trade_level": _trade_level, "trade_slice": _trade_slice, "trade_prints": _trade_prints,
}

DERIVED_PARTITION_FAMILIES = {
    "trade_minute_1m": "trade_minute", "trade_level_1m": "trade_level",
    "trade_slice_2s": "trade_slice", "trade_prints_1m": "trade_prints",
}

_PARTITION_RECORD_FAMILY = {
    "candle": "candle", "candle_1m": "candle", "candle_1h": "candle", "candle_1d": "candle",
    "trade": "trade", "quote": "quote", "depth": "depth",
    **DERIVED_PARTITION_FAMILIES,
}

_PARTITION_BAR_INTERVAL_NS = {
    "candle": 1_000_000_000,
    "candle_1m": 60_000_000_000,
    "candle_1h": 3_600_000_000_000,
    "candle_1d": 86_400_000_000_000,
    "trade_minute_1m": 60_000_000_000,
    "trade_level_1m": 60_000_000_000,
    "trade_slice_2s": 2_000_000_000,
    "trade_prints_1m": 60_000_000_000,
}


def validate_version(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value):
        raise WriterError("INVALID_DATASET_VERSION")


def validate_date(value):
    try:
        if not isinstance(value, str) or _dt.date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except ValueError:
        raise WriterError("INVALID_PARTITION_DATE") from None


def instrument_slug(instrument_id):
    readable = re.sub(r"[^A-Za-z0-9]+", "_", instrument_id).strip("_")[:80]
    digest = hashlib.sha256(instrument_id.encode("utf-8")).hexdigest()[:8]
    return f"{readable}-{digest}"


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def legacy_sorted_logical_sha256(path):
    h = hashlib.sha256()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            h.update(json.dumps(json.loads(line), sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return h.hexdigest()


class _StageTimer:
    def __init__(self, sink, name):
        self._sink, self._name = sink, name

    def __enter__(self):
        self._started = time.monotonic()
        return self

    def __exit__(self, *exc_info):
        self._sink[self._name] = round(time.monotonic() - self._started, 3)
        return False


class PartitionWriter:
    def __init__(self, staging_dir, instrument_id, family, dataset_version, date):
        validate_version(dataset_version)
        validate_date(date)
        record_family = _PARTITION_RECORD_FAMILY.get(family)
        if record_family is None:
            raise WriterError(f"UNSUPPORTED_FAMILY:{family}")
        self.instrument_id = instrument_id
        self.family = family
        self.record_family = record_family
        self.bar_interval_ns = _PARTITION_BAR_INTERVAL_NS.get(family)
        self.dataset_version = dataset_version
        self.date = date
        self.columns = {**_COMMON_COLUMNS, **_FAMILY_COLUMNS[record_family]}
        self.dir = os.path.join(staging_dir, instrument_slug(instrument_id), family, dataset_version, date)
        os.makedirs(self.dir, exist_ok=True)
        for stale in glob.glob(os.path.join(self.dir, "part-*.parquet")):
            os.remove(stale)
        stale_manifest = os.path.join(self.dir, "_manifest.json")
        if os.path.exists(stale_manifest):
            os.remove(stale_manifest)
        stale_spill = os.path.join(self.dir, "_spill")
        if os.path.lexists(stale_spill):
            if os.path.islink(stale_spill) or not os.path.isdir(stale_spill):
                raise WriterError("UNSAFE_SPILL_PATH")
            shutil.rmtree(stale_spill)
        self._ndjson = os.path.join(self.dir, "rows.ndjson")
        self._fh = open(self._ndjson, "w", encoding="utf-8")
        self._count = 0
        self._rejected = 0
        self._rejected_reasons = {}
        self._logical = hashlib.sha256()
        self._min_ns = None
        self._max_ns = None
        self._stage_root = os.fspath(staging_dir)
        self._budget_left = 0
        self._finalized = False

    def close_input(self):
        if not self._fh.closed:
            self._fh.close()

    def _open_input(self):
        if self._fh.closed:
            self._fh = open(self._ndjson, "a", encoding="utf-8")

    def add(self, record, source_rank=0, continuity=None):
        if self._finalized:
            raise WriterError("WRITER_ALREADY_FINALIZED")
        if record["family"] != self.record_family:
            raise WriterError(f"FAMILY_MISMATCH:{record['family']}!={self.record_family}")
        if self.record_family == "depth" and continuity is None:
            raise WriterError("DEPTH_REQUIRES_CONTINUITY")
        if self.record_family != "depth" and continuity is not None:
            raise WriterError("CONTINUITY_ONLY_APPLIES_TO_DEPTH")
        if self.bar_interval_ns is not None:
            span = int(record["data"]["closeNs"]) - int(record["data"]["openNs"])
            if span != self.bar_interval_ns:
                raise WriterError(
                    f"BAR_INTERVAL_MISMATCH:{self.family}:{span}!={self.bar_interval_ns}")
        try:
            flat = _common(record, source_rank)
            flat.update(_FAMILY_FLATTEN[self.record_family](record["data"]))
            if continuity is not None:
                flat["book_epoch"] = int(continuity["book_epoch"])
                flat["continuity"] = continuity["continuity"]
        except QuarantineRow as rejected:
            self._rejected += 1
            self._rejected_reasons[rejected.reason] = self._rejected_reasons.get(rejected.reason, 0) + 1
            return {"accepted": False, "reason": rejected.reason}
        flat["quality_flags"] = sorted(set(flat["quality_flags"]) | {"INGEST_NS_IS_CONVERSION_TIME", "SOURCE_AVAILABILITY_UNKNOWN"})
        line = json.dumps(flat, separators=(",", ":"))
        needed = len((line + "\n").encode("utf-8"))
        self._open_input()
        if needed > self._budget_left:
            self._fh.flush()
            self._budget_left = max(needed, BUDGET_CHECK_GRANULARITY_BYTES)
            budget.check(self._stage_root, self._budget_left)
        self._budget_left -= needed
        self._fh.write(line + "\n")
        self._logical.update(line.encode("utf-8"))
        self._count += 1
        ev = flat["event_ns"]
        self._min_ns = ev if self._min_ns is None else min(self._min_ns, ev)
        self._max_ns = ev if self._max_ns is None else max(self._max_ns, ev)

        return {"accepted": True, "reason": None}

    def finalize(self, source_objects, derivation=None):
        if self._finalized:
            raise WriterError("WRITER_ALREADY_FINALIZED")
        if (derivation is None) != (self.family not in DERIVED_PARTITION_FAMILIES):
            raise WriterError(f"DERIVATION_BLOCK_MISMATCH:{self.family}")
        if derivation is not None and (not isinstance(derivation, dict) or not derivation):
            raise WriterError("INVALID_DERIVATION_BLOCK")
        self._finalized = True
        self.close_input()
        if self._count == 0:
            raise WriterError("NO_RECORDS")

        part_path = os.path.join(self.dir, "part-00000.parquet")
        order_by = ", ".join(SORT_KEY)
        spill_dir = os.path.join(self.dir, "_spill")
        os.makedirs(spill_dir, exist_ok=True)
        spill_budget = min(budget.check(self._stage_root, os.path.getsize(self._ndjson) * 2) - os.path.getsize(self._ndjson) * 2,
                           budget.positive_env("TT_CONVERT_SPILL_BYTES", 512 * 1024**2))
        budget.check(self._stage_root, os.path.getsize(self._ndjson) * 2 + spill_budget)
        duckdb_memory_bytes = budget.positive_env("TT_CONVERT_DUCKDB_MEMORY_BYTES", DUCKDB_MEMORY_LIMIT_BYTES_DEFAULT)
        finalize_threads = budget.positive_env("TT_CONVERT_FINALIZE_THREADS", FINALIZE_THREADS_DEFAULT)
        con = duckdb.connect(config={"memory_limit": f"{duckdb_memory_bytes}B", "threads": str(finalize_threads), "temp_directory": spill_dir, "max_temp_directory_size": f"{spill_budget}B"})
        timings = {}
        def _stage(name):
            return _StageTimer(timings, name)
        try:
            with _stage("materialize_staged"):
                staged = con.read_json(self._ndjson, format="newline_delimited", columns=self.columns)
                staged.create("_staged")
            max_rows = budget.positive_env("TT_CONVERT_PART_ROWS", ROW_GROUP_SIZE)
            ranges = []
            def divide(lo, hi):
                n, low, high = con.execute("SELECT count(*), min(event_ns), max(event_ns) FROM _staged WHERE event_ns >= ? AND event_ns <= ?", [lo, hi]).fetchone()
                if not n:
                    return
                if n <= max_rows:
                    ranges.append((lo, hi, n))
                    return
                if low == high:
                    raise WriterError("PARTITION_UNSPLITTABLE")
                middle = (low + high) // 2
                divide(lo, middle)
                divide(middle + 1, hi)
            with _stage("split_plan"):
                divide(self._min_ns, self._max_ns)
            paths = []
            with _stage("sort_and_write_parts"):
                for i, (lo, hi, rows) in enumerate(ranges):
                    part = os.path.join(self.dir, f"part-{i:05d}.parquet")
                    row_group = 8192 if self.family == "depth" else ROW_GROUP_SIZE
                    con.execute(f"COPY (SELECT * FROM _staged WHERE event_ns >= {lo} AND event_ns <= {hi} ORDER BY {order_by}) TO '{_sql_literal(part)}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {row_group})")
                    paths.append(part)
                    budget.check(self._stage_root)
            part_path = paths
            with _stage("validate_count_and_uniqueness"):
                n, distinct = con.execute(
                    "SELECT count(*), count(DISTINCT record_id) FROM read_parquet(?)", [part_path]
                ).fetchone()
                if n != self._count:
                    raise WriterError(f"PARQUET_COUNT_MISMATCH:{n}!={self._count}")
                if distinct != n:
                    raise WriterError("PARQUET_DUPLICATE_RECORD_ID")
                if con.execute("SELECT count(DISTINCT record_id) FROM _staged").fetchone()[0] != self._count:
                    raise WriterError("STAGED_DUPLICATE_RECORD_ID")
            with _stage("validate_sorted"):
                unsorted = con.execute(
                    f"SELECT count(*) FROM ("
                    f"  SELECT ({order_by}) AS k, lag(({order_by})) OVER () AS prev FROM read_parquet(?)"
                    f") WHERE prev IS NOT NULL AND k < prev",
                    [part_path],
                ).fetchone()[0]
                if unsorted:
                    raise WriterError("PARQUET_NOT_SORTED")
            with _stage("validate_content_round_trip"):
                for path, (lo, hi, expected_rows) in zip(paths, ranges):
                    subset = f"SELECT * FROM _staged WHERE event_ns >= {lo} AND event_ns <= {hi}"
                    matched, mismatch = con.execute(
                        f"SELECT count(*), count(*) FILTER (WHERE s IS DISTINCT FROM p) "
                        f"FROM ({subset}) s JOIN read_parquet(?) p ON s.record_id=p.record_id", [path]
                    ).fetchone()
                    if matched != expected_rows or mismatch:
                        raise WriterError("PARQUET_VALUE_MISMATCH")
        finally:
            con.close()

        budget.check(self._stage_root)
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "converter_version": CONVERTER_VERSION,
            "contract_version": SCHEMA_VERSION,
            "roll_table_version": None,
            "instrument_id": self.instrument_id,
            "family": self.family,
            "dataset_version": self.dataset_version,
            "date": self.date,
            "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "source_objects": list(source_objects),
            "record_count": self._count,
            "rejected_count": self._rejected,
            "rejected_summary": dict(self._rejected_reasons),
            "event_ns_min": self._min_ns,
            "event_ns_max": self._max_ns,
            "logical_sha256": self._logical.hexdigest(),
            "logical_sha256_format": LOGICAL_SHA256_FORMAT,
            "sort_key": list(SORT_KEY),
            "parts": [{"name": os.path.basename(path), "bytes": os.path.getsize(path),
                       "sha256": _sha256_file(path), "row_count": interval[2],
                       "event_ns_min": interval[0], "event_ns_max": interval[1]}
                      for path, interval in zip(paths, ranges)],
            "validation": {"round_trip_ok": True, "id_unique": True, "sorted": True, "count_reconciled": True},
            "stage_timings_s": timings,
        }
        if derivation is not None:
            manifest["derivation"] = json.loads(json.dumps(derivation, sort_keys=True))
        with open(os.path.join(self.dir, "_manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)
        return manifest


def _sql_literal(value):
    return value.replace("'", "''")


def _row_hash_expr(columns):
    return f"hash(struct_pack({', '.join(f'{c} := {c}' for c in columns)}))"
