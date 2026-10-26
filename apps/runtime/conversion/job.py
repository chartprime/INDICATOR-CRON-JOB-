from __future__ import annotations

import datetime as _dt
import glob as _glob
import hashlib
import json
import os
import time

import duckdb as _duckdb

import authority as _authority
import catalog as _catalog
import candle_rollup as _candle_rollup
import checkpoint as _ckpt
import continuity as _continuity
import convert as _convert
import csv_decode as _csv
import dbn as _dbn
import identity as _identity
import rejection_evidence as _rejections
import roll_table as _roll_table
import source_coverage as _coverage
import split as _split
import tardis_decode as _tardis
import throttle as _throttle
import writer as _writer
from bridge import ContractBridge


CANONICAL_FAMILIES = frozenset({"trade", "quote", "depth", "candle", "candle_1m", "candle_1h", "candle_1d"})


class JobError(RuntimeError):
    pass


def _continuous_alias(meta):
    if not meta.symbols:
        raise JobError("CONTINUOUS_INPUT_MISSING_SYMBOLS")
    if len(meta.symbols) != 1:
        raise JobError("CONTINUOUS_INPUT_MULTIPLE_SYMBOLS")
    return meta.symbols[0]


def _now_iso():
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _describe_stream(stream, s3_key, schema, dataset, symbol, window, last_modified):
    if not isinstance(stream, (list, tuple)) or not stream:
        raise JobError("STREAM_REQUIRES_FILES")
    if not isinstance(window, (list, tuple)) or len(window) != 2:
        raise JobError("STREAM_REQUIRES_WINDOW")
    for value in window:
        try:
            if _dt.date.fromisoformat(value).isoformat() != value:
                raise ValueError()
        except (ValueError, TypeError):
            raise JobError("STREAM_WINDOW_INVALID") from None
    files = []
    for item in stream:
        path = os.fspath(item["local_path"])
        files.append({"local_path": path, "s3_key": item["s3_key"],
                      "sha256": _convert._sha256_file(path), "bytes": os.path.getsize(path)})
    if len({f["s3_key"] for f in files}) != len(files):
        raise JobError("DUPLICATE_STREAM_FILE")
    identity = json.dumps([[f["s3_key"], f["sha256"]] for f in files], separators=(",", ":"))
    return {
        "local_path": None, "s3_key": s3_key, "schema": schema, "dataset": dataset, "symbol": symbol,
        "sha256": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
        "bytes": sum(f["bytes"] for f in files),
        "last_modified": last_modified or "1970-01-01T00:00:00Z",
        "cadence": "daily", "coverage_verified": True, "stream": files, "window": list(window),
    }


def _describe_input(local_path=None, s3_key=None, schema=None, dataset=None, symbol=None, last_modified=None,
                    coverage_verified=False, stream=None, window=None):
    if stream is not None:
        return _describe_stream(stream, s3_key, schema, dataset, symbol, window, last_modified)
    local_path = os.fspath(local_path)
    return {
        "local_path": local_path, "s3_key": s3_key, "schema": schema,
        "dataset": dataset, "symbol": symbol,
        "sha256": _convert._sha256_file(local_path), "bytes": os.path.getsize(local_path),
        "last_modified": last_modified or "1970-01-01T00:00:00Z",
        "cadence": _coverage.cadence_from_s3_key(s3_key), "coverage_verified": coverage_verified,
    }


def _resolve_stream(desc):
    data_type = desc["schema"]
    if data_type not in _tardis.HEADERS:
        raise JobError(f"UNSUPPORTED_TARDIS_DATA_TYPE:{data_type}")
    mappings = _identity.build_tardis_mappings(desc["dataset"], desc["symbol"], reference=f"s3-key:{desc['s3_key']}")
    counts = []
    return {
        "mappings": mappings, "dataset": desc["dataset"], "schema": data_type, "map_family": "trade",
        "provider": "TARDIS", "curated_provider": "binance", "stream_counts": counts, "meta": None,
        "row_iter": (lambda: _tardis.stream_rows(desc["stream"], data_type, desc["window"][0], desc["window"][1], counts)),
    }


def _resolve_input(desc, roll_tables=None, definition_snapshots=None):
    if desc.get("stream") is not None:
        return _resolve_stream(desc)
    if _convert._is_csv(desc["local_path"]):
        if desc["schema"] not in _convert._OHLCV_SCHEMAS:
            raise JobError(f"CSV_ONLY_SUPPORTED_FOR_OHLCV:{desc['schema']}")
        if not desc["symbol"] or not desc["dataset"]:
            raise JobError("CSV_SOURCE_REQUIRES_DATASET_AND_SYMBOL")
        for name, value in (("dataset", desc["dataset"]), ("symbol", desc["symbol"]), ("schema", desc["schema"])):
            declared = [p.split("=", 1)[1] for p in desc["s3_key"].split("/") if p.startswith(name + "=")]
            if declared and any(v != value for v in declared):
                raise JobError(f"CSV_SOURCE_IDENTITY_MISMATCH:{name}")
        instrument_ids = _csv.distinct_instrument_ids(desc["local_path"])
        if _identity.instrument_for(desc["dataset"], desc["symbol"])["market"] == "FUTURE":
            if not definition_snapshots:
                raise JobError("ROLL_TABLE_REQUIRES_DEFINITION_SOURCES:CSV_FUTURES")
            mappings = _identity.build_csv_futures_mappings(desc["dataset"], instrument_ids, definition_snapshots,
                                                             reference=f"s3-key:{desc['s3_key']}")
        else:
            mappings = _identity.build_csv_mappings(desc["dataset"], desc["symbol"], instrument_ids,
                                                     reference=f"s3-key:{desc['s3_key']}")
        return {
            "mappings": mappings, "dataset": desc["dataset"], "schema": desc["schema"], "map_family": "candle",
            "row_iter": (lambda p=desc["local_path"]: _csv.decode_ohlcv(p)), "meta": None,
        }
    meta = _dbn.read_metadata(desc["local_path"], expected_schema=desc["schema"])
    map_family = _convert._map_family_for(meta.schema)
    if meta.stype_in == "continuous":
        alias = _continuous_alias(meta)
        resolved = (roll_tables or {}).get(alias)
        if resolved is None:
            raise JobError(f"ROLL_TABLE_REQUIRES_DEFINITION_SOURCES:{alias}")
        rows, _warnings = resolved
        mappings = _roll_table.to_mappings(rows, meta.dataset, reference=f"s3-key:{desc['s3_key']}")
    else:
        mappings = _identity.build_mappings(meta, desc["sha256"])
    return {
        "mappings": mappings, "dataset": meta.dataset, "schema": meta.schema, "map_family": map_family,
        "row_iter": (lambda p=desc["local_path"], s=desc["schema"]: _dbn.decode(p, expected_schema=s)), "meta": meta,
    }


def _canonical_families(map_family, day_unit, instrument_ids=None, schema=None):
    rows = (row for _, row in _split.read_day(day_unit["path"]) if instrument_ids is None or row.get("instrument_id") in instrument_ids)
    seen = False
    has_trade = False
    for row in rows:
        seen = True
        has_trade = has_trade or row.get("action") == "T"
    if not seen:
        return []
    if map_family == "trade":
        return ["trade"]
    if map_family == "candle":
        family = _convert._partition_family_for("candle", schema)
        if family == "candle_1m":
            return ["candle_1m", "candle_1h", "candle_1d"]
        return [family]
    if map_family == "mbp":
        return ["trade", "quote"] if has_trade else ["quote"]
    if map_family == "depth":
        return ["trade", "depth"] if has_trade else ["depth"]
    raise JobError(f"UNSUPPORTED_MAP_FAMILY:{map_family}")


def _build_roll_tables(descs, definition_sources):
    aliases = {}
    needs_definitions = False
    for desc in descs:
        if desc.get("stream") is not None:
            continue
        if _convert._is_csv(desc["local_path"]):
            if (desc["dataset"] and desc["symbol"]
                    and _identity.instrument_for(desc["dataset"], desc["symbol"])["market"] == "FUTURE"):
                needs_definitions = True
            continue
        meta = _dbn.read_metadata(desc["local_path"], expected_schema=desc["schema"])
        if meta.stype_in != "continuous":
            continue
        needs_definitions = True
        alias = _continuous_alias(meta)
        intervals = meta.mappings.get(alias)
        if not intervals:
            raise JobError(f"CONTINUOUS_ALIAS_NOT_IN_METADATA:{alias}")
        aliases.setdefault(alias, []).extend(intervals)
    if not needs_definitions:
        return {}, {}, []
    if not definition_sources:
        raise JobError(f"ROLL_TABLE_REQUIRES_DEFINITION_SOURCES:{sorted(aliases) or 'CSV_FUTURES'}")

    definition_rows = []
    definition_hashes = []
    skipped_empty_sources = []
    for src in definition_sources:
        path = os.fspath(src["local_path"])
        definition_hashes.append(_convert._sha256_file(path))
        try:
            if _convert._is_csv(path):
                rows = list(row for _, row in _csv.decode_definition(path))
            else:
                rows = list(row for _, row in _dbn.decode(path, expected_schema="definition"))
        except _csv.CsvError as error:
            if str(error) != "EMPTY_CSV":
                raise
            skipped_empty_sources.append(src["s3_key"])
            continue
        definition_rows.extend(rows)
    definition_snapshots = _roll_table.definition_snapshots_from_rows(definition_rows)
    dbn_hashes = sorted({desc["sha256"] for desc in descs
                         if desc.get("stream") is None and not _convert._is_csv(desc["local_path"])})
    roll_table_version = _roll_table.version(definition_hashes, dbn_hashes)

    resolved = {}
    for alias, intervals in aliases.items():
        merged, bridged = _roll_table.merge_intervals(alias, intervals)
        rows = _roll_table.build(alias, merged, definition_snapshots, roll_table_version)
        warnings = bridged + _roll_table.validate(alias, rows)
        resolved[alias] = (rows, warnings)
    return resolved, definition_snapshots, sorted(skipped_empty_sources)


def _stream_fields(desc, resolved):
    if desc.get("stream") is None:
        return {}
    return {
        "provider": resolved["provider"], "curated_provider": resolved["curated_provider"],
        "window": desc["window"], "stream_counts": list(resolved["stream_counts"]),
        "stream_files": [{"s3_key": f["s3_key"], "sha256": f["sha256"], "bytes": f["bytes"]} for f in desc["stream"]],
    }


def _build_checkpoint(job_stage, job_id, dataset_version, descs, definition_sources, families=None):
    conversion_started_ns = time.time_ns()
    roll_tables, definition_snapshots, skipped_empty_definition_sources = _build_roll_tables(descs, definition_sources)
    resolved = {}
    coverage_inputs = []
    for desc in descs:
        r = _resolve_input(desc, roll_tables, definition_snapshots)
        day_units = _split.split_by_day(r["row_iter"](), job_stage, desc["s3_key"])
        units_by_date = {u["date"]: u for u in day_units}
        if desc.get("stream") is not None:
            first = _dt.date.fromisoformat(desc["window"][0])
            last = _dt.date.fromisoformat(desc["window"][1])
            expected = [(first + _dt.timedelta(days=offset)).isoformat() for offset in range((last - first).days + 1)]
            missing = [date for date in expected if date not in units_by_date]
            if missing:
                raise JobError(f"TARDIS_DAY_HAS_NO_SOURCE_ROWS:{','.join(missing)}")
            instrument_id = _identity.instrument_id(r["mappings"][0]["instrument"])
            file_coverage = _coverage.stream_coverage(instrument_id, r["map_family"], sorted(units_by_date))
        elif r["meta"] is not None:
            if r["meta"].stype_in == "continuous":
                alias = r["meta"].symbols[0]
                roll_rows, _warnings = roll_tables[alias]
                base_entries = _coverage.roll_table_coverage(
                    roll_rows, r["map_family"], file_start_ns=r["meta"].start_ns, file_end_ns=r["meta"].end_ns,
                    partial=alias in r["meta"].partial)
            else:
                base_entries = []
                for raw_symbol in r["meta"].mappings:
                    base_entries.extend(_coverage.dbn_coverage(r["meta"], r["map_family"], raw_symbol))
            file_coverage = []
            for entry in base_entries:
                unit = units_by_date.get(entry["date"])
                if unit is None:
                    continue
                for family in _canonical_families(r["map_family"], unit, {m["sourceSymbol"] for m in r["mappings"] if _identity.instrument_id(m["instrument"]) == entry["instrument_id"]}, schema=r["schema"]):
                    file_coverage.append({**entry, "family": family})
        elif _identity.instrument_for(desc["dataset"], desc["symbol"])["market"] == "FUTURE":
            base = _coverage.csv_futures_coverage(r["map_family"], units_by_date, r["mappings"], complete=desc["coverage_verified"])
            file_coverage = []
            for entry in base:
                unit = units_by_date[entry["date"]]
                instrument_ids = {m["sourceSymbol"] for m in r["mappings"] if _identity.instrument_id(m["instrument"]) == entry["instrument_id"]}
                for family in _canonical_families(r["map_family"], unit, instrument_ids, schema=r["schema"]):
                    file_coverage.append({**entry, "family": family})
        else:
            base = _coverage.csv_coverage(desc["dataset"], desc["symbol"], r["map_family"], sorted(units_by_date), complete=desc["coverage_verified"])
            file_coverage = [dict(entry, family=family) for entry in base for family in _canonical_families(r["map_family"], units_by_date[entry["date"]], schema=r["schema"])]
        coverage_inputs.append({"s3_key": desc["s3_key"], "cadence": desc["cadence"],
                                 "last_modified": desc["last_modified"], "coverage": file_coverage})
        if desc.get("stream") is not None:
            if any(_convert._sha256_file(f["local_path"]) != f["sha256"] for f in desc["stream"]):
                raise JobError("SOURCE_CHANGED_DURING_SPLIT")
        elif _convert._sha256_file(desc["local_path"]) != desc["sha256"]:
            raise JobError("SOURCE_CHANGED_DURING_SPLIT")
        resolved[desc["s3_key"]] = (r, day_units)

    plan, excluded, ranks = _authority.resolve(coverage_inputs)
    if families is not None:
        plan = [entry for entry in plan if entry["family"] in families]
    if not plan:
        raise JobError("NO_AUTHORITATIVE_COVERAGE")

    input_entries = [
        {
            "s3_key": desc["s3_key"], "sha256": desc["sha256"], "bytes": desc["bytes"],
            "last_modified": desc["last_modified"], "cadence": desc["cadence"],
            "mappings": resolved[desc["s3_key"]][0]["mappings"],
            "resolved_dataset": resolved[desc["s3_key"]][0]["dataset"],
            "resolved_schema": resolved[desc["s3_key"]][0]["schema"],
            "map_family": resolved[desc["s3_key"]][0]["map_family"],
            **_stream_fields(desc, resolved[desc["s3_key"]][0]),
        }
        for desc in descs
    ]
    checkpoint = _ckpt.new(job_id, dataset_version, conversion_started_ns, plan, input_entries)
    for desc in descs:
        _ckpt.mark_split_done(checkpoint, desc["s3_key"], resolved[desc["s3_key"]][1])
    checkpoint["overlap_excluded"] = excluded
    checkpoint["source_ranks"] = ranks
    checkpoint["roll_tables"] = {alias: {"rows": rows, "warnings": warnings} for alias, (rows, warnings) in roll_tables.items()}
    checkpoint["skipped_empty_definition_sources"] = skipped_empty_definition_sources
    return _ckpt.save(job_stage, checkpoint, _now_iso())


def _dispatch_values(map_family, wanted_families):
    if map_family == "trade":
        return ["trade"]
    if map_family == "candle":
        return ["candle"]
    if map_family == "mbp":
        return ["mbp"]
    if map_family == "depth":
        values = ["depth"]
        if "trade" in wanted_families:
            values.append("trade")
        return values
    raise JobError(f"UNSUPPORTED_MAP_FAMILY:{map_family}")


def _process_group(bridge, checkpoint, job_stage, dataset_version, curated_root,
                    s3_key, date, entries, full_group, writer_for, continuity_state):
    input_entry = _input_entry(checkpoint, s3_key)
    day_unit = _day_unit(checkpoint, s3_key, date)
    wanted = {(e["instrument_id"], e["family"]): e for e in entries}
    planned_keys = {(e["instrument_id"], e["family"]) for e in full_group[(s3_key, date)]}
    all_planned = {(e["instrument_id"], e["family"]) for e in checkpoint["authority_plan"] if e["date"] == date}
    pws = {key: writer_for(key[0], key[1], date) for key in wanted}
    wanted_families = {key[1] for key in wanted}
    dispatch_values = _dispatch_values(input_entry["map_family"], wanted_families)
    evidence = _rejections.new(source_objects=[{"s3_key": s3_key, "sha256": input_entry["sha256"]}])
    seen_symbols = set()
    contributors = {}
    provider = input_entry.get("provider", "DATABENTO")
    health_file = os.environ.get("TT_COLLECTOR_HEALTH_FILE")
    for batch in _convert._batches(_split.read_day(day_unit["path"]), _convert._batch_rows()):
        _throttle.wait_if_needed(health_file)
        for source_symbol, lineage_source, group in _source_groups(batch, input_entry, s3_key):
            is_first_group_for_symbol = source_symbol not in seen_symbols
            seen_symbols.add(source_symbol)
            contributors[lineage_source["s3_key"]] = lineage_source["sha256"]
            context = {
                "mappings": input_entry["mappings"], "dataset": input_entry["resolved_dataset"],
                "sourceSymbol": source_symbol,
                "population": f"{input_entry['resolved_dataset']}:{input_entry['resolved_schema']}",
                "datasetVersion": dataset_version,
                "streamId": f"{provider.lower()}:{input_entry['resolved_dataset']}:{input_entry['resolved_schema']}",
                "schema": input_entry["resolved_schema"], "ingestNs": str(checkpoint["conversion_started_ns"]),
                "lineage": {"object": f"s3://{lineage_source['s3_key']}", "sha256": lineage_source["sha256"]},
            }
            for dispatch_family in dispatch_values:
                batch_id = f"{checkpoint['job_id']}:{date}:{source_symbol}:{dispatch_family}:{group[0]['position']}"
                results = bridge.map_batch(batch_id, provider, dispatch_family, group, context)
                for row_index, (entry, res) in enumerate(zip(group, results)):
                    if not res["ok"]:
                        quarantine = res.get("quarantine")
                        reason = quarantine.get("reason") if isinstance(quarantine, dict) else None
                        _rejections.record(
                            evidence, reason,
                            source={"s3_key": lineage_source["s3_key"], "sha256": lineage_source["sha256"], "date": date,
                                    "source_symbol": source_symbol, "position": entry["position"],
                                    "dispatch_family": dispatch_family, "batch_id": batch_id},
                            row=entry["row"], quarantine=quarantine,
                        )
                        continue
                    for record in res["records"]:
                        key = (record["instrument"]["id"],
                               _convert._partition_family_for(record["family"], input_entry["resolved_schema"]))
                        if key not in planned_keys and key in all_planned:
                            continue
                        if key not in planned_keys:
                            raise JobError(f"UNPLANNED_OUTPUT_RECORD:{key}:{s3_key}:{date}")
                        if key not in pws:
                            continue
                        ev = int(record["time"]["eventNs"])
                        selected = [e for e in entries if (e["instrument_id"], e["family"]) == key and int(e["from_ns"]) <= ev < int(e["to_ns"])]
                        if not selected:
                            continue
                        continuity_info = None
                        if record["family"] == "depth":
                            state = continuity_state.setdefault(key[0], _continuity.new_state())
                            file_boundary = is_first_group_for_symbol and row_index == 0
                            continuity_info = _continuity.classify(state, entry["row"], file_boundary=file_boundary)
                        outcome = pws[key].add(record, source_rank=selected[0]["source_rank"], continuity=continuity_info)
                        if not outcome["accepted"]:
                            _rejections.record(
                                evidence, outcome["reason"],
                                source={"s3_key": lineage_source["s3_key"], "sha256": lineage_source["sha256"], "date": date,
                                        "source_symbol": source_symbol, "position": entry["position"],
                                        "dispatch_family": dispatch_family, "batch_id": batch_id},
                                row=entry["row"], canonical_record=record,
                            )
    if evidence["rejected"]:
        _rejections.write(job_stage, evidence)
        raise JobError(f"QUARANTINE_BLOCKS_PUBLICATION:{s3_key}:{date}:{evidence['rejected']}")

    if input_entry.get("stream_files") is not None:
        checkpoint.setdefault("stream_sources", {})[date] = [
            {"s3_key": key, "sha256": contributors[key]} for key in sorted(contributors)]
    return checkpoint


def _source_groups(batch, input_entry, s3_key):
    stream_files = input_entry.get("stream_files")
    if stream_files is None:
        own = {"s3_key": s3_key, "sha256": input_entry["sha256"]}
        for source_symbol, group in _convert._group_by_instrument(batch).items():
            yield source_symbol, own, group
        return
    data_type = input_entry["resolved_schema"]
    groups = {}
    for entry in batch:
        row = entry["row"]
        groups.setdefault((row["symbol"], row["file"]), []).append({
            "row": _tardis.source_row(row, data_type), "position": entry["position"], "lineageRow": row["file_row"],
        })
    for (source_symbol, file_index), group in groups.items():
        yield source_symbol, stream_files[file_index], group


def _finish(pws, checkpoint, job_stage, dataset_version, curated_root, date, sources, derivations=None,
            provider="databento"):
    for key, pw in pws.items():
        manifest = pw.finalize(sources, derivation=(derivations or {}).get(key))
        dest = _completed_partition_dest(curated_root, dataset_version, pw.instrument_id, pw.family, date, provider)
        if os.path.exists(dest):
            with open(os.path.join(dest, "_manifest.json"), encoding="utf-8") as fh:
                prior = json.load(fh)
            for field in ("instrument_id", "family", "dataset_version", "date", "record_count", "source_objects"):
                if prior.get(field) != manifest.get(field):
                    raise JobError("PUBLISHED_PARTITION_CONFLICT")
            if prior.get("logical_sha256") != manifest.get("logical_sha256"):
                if prior.get("logical_sha256") != _writer.legacy_sorted_logical_sha256(pw._ndjson):
                    raise JobError("PUBLISHED_PARTITION_CONFLICT")
            for part in prior["parts"]:
                if _convert._sha256_file(os.path.join(dest, part["name"])) != part["sha256"]:
                    raise JobError("PUBLISHED_PARTITION_CORRUPT")
            import shutil
            shutil.copyfile(os.path.join(dest, "_manifest.json"), os.path.join(pw.dir, "_manifest.json"))
            manifest = prior
        else:
            _convert._publish_partition(pw, curated_root, provider)
        manifest_sha = _convert._sha256_file(os.path.join(pw.dir, "_manifest.json"))
        _ckpt.mark_partition_complete(checkpoint, key[0], key[1], date, manifest, manifest_sha)
        if provider != "databento":
            checkpoint["completed_partitions"][-1]["provider"] = provider
        if key[1] == "depth":
            checkpoint = _record_depth_continuity_for_date(checkpoint, curated_root, dataset_version, key[0], date, job_stage)
        checkpoint = _ckpt.save(job_stage, checkpoint, _now_iso())
    return checkpoint


def _rollup_source(checkpoint, partition_entries, instrument_id, minute_rows):
    source_keys = {entry["s3_key"] for entry in partition_entries}
    if len(source_keys) != 1:
        raise JobError(f"ROLLUP_MULTIPLE_INPUT_SOURCES:{instrument_id}:{sorted(source_keys)}")
    source_key = next(iter(source_keys))
    source = _input_entry(checkpoint, source_key)
    if source["map_family"] != "candle" or source["resolved_schema"] != "ohlcv-1m":
        raise JobError(f"ROLLUP_REQUIRES_OHLCV_1M:{source_key}:{source['resolved_schema']}")
    source_symbols = {str(row["source_symbol"]) for row in minute_rows}
    if len(source_symbols) != 1:
        raise JobError(f"ROLLUP_MULTIPLE_SOURCE_SYMBOLS:{instrument_id}:{sorted(source_symbols)}")
    source_symbol = next(iter(source_symbols))
    mappings = [
        mapping for mapping in source["mappings"]
        if str(mapping["sourceSymbol"]) == source_symbol
        and _identity.instrument_id(mapping["instrument"]) == instrument_id
    ]
    if len(mappings) != 1:
        raise JobError(f"ROLLUP_MAPPING_AMBIGUOUS:{instrument_id}:{source_symbol}:{len(mappings)}")
    return source_key, source, source_symbol


def _derive_candle_rollups(bridge, checkpoint, job_stage, dataset_version, curated_root,
                           instrument_id, date, minute_entries, targets, writer_for):
    minute_dest = _completed_partition_dest(
        curated_root, dataset_version, instrument_id, "candle_1m", date)
    with open(os.path.join(minute_dest, "_manifest.json"), encoding="utf-8") as fh:
        minute_manifest = json.load(fh)
    minute_rows = _candle_rollup.read_minute_rows(
        _writer.manifest_part_paths(minute_dest, minute_manifest))
    if not minute_rows:
        raise JobError(f"ROLLUP_MINUTE_PARTITION_EMPTY:{instrument_id}:{date}")
    source_key, source, source_symbol = _rollup_source(
        checkpoint, minute_entries, instrument_id, minute_rows)
    lineage = {"object": f"s3://{source_key}", "sha256": source["sha256"]}
    source_objects = [{"s3_key": source_key, "sha256": source["sha256"]}]
    rollups = _candle_rollup.rollups_for(instrument_id)
    functions = {
        "candle_1h": ("ohlcv-1h", rollups["candle_1h"]),
        "candle_1d": ("ohlcv-1d", rollups["candle_1d"]),
    }
    for family, partition_entries in targets.items():
        schema, rollup = functions[family]
        rows = rollup(minute_rows)
        if not rows:
            raise JobError(f"ROLLUP_PRODUCED_NO_ROWS:{instrument_id}:{family}:{date}")
        context = {
            "mappings": source["mappings"], "dataset": source["resolved_dataset"],
            "sourceSymbol": source_symbol,
            "population": f"{source['resolved_dataset']}:{schema}",
            "datasetVersion": dataset_version,
            "streamId": f"derived:candle_1m:{family}", "schema": schema,
            "ingestNs": str(checkpoint["conversion_started_ns"]), "lineage": lineage,
        }
        pw = writer_for(instrument_id, family, date)
        for batch in _convert._batches(enumerate(rows), _convert._batch_rows()):
            batch_id = f"{checkpoint['job_id']}:{date}:{source_symbol}:{family}:{batch[0]['position']}"
            results = bridge.map_batch(batch_id, "DATABENTO", "candle", batch, context)
            for result in results:
                if not result.get("ok"):
                    reason = (result.get("quarantine") or {}).get("reason", "UNKNOWN")
                    raise JobError(f"ROLLUP_MAPPING_REJECTED:{instrument_id}:{family}:{date}:{reason}")
                for record in result["records"]:
                    key = (record["instrument"]["id"], _convert._partition_family_for(record["family"], schema))
                    if key != (instrument_id, family):
                        raise JobError(f"ROLLUP_UNPLANNED_OUTPUT_RECORD:{key}:{instrument_id}:{family}")
                    event_ns = int(record["time"]["eventNs"])
                    selected = [
                        entry for entry in partition_entries
                        if entry["s3_key"] == source_key
                        and int(entry["from_ns"]) <= event_ns < int(entry["to_ns"])
                    ]
                    if len(selected) != 1:
                        raise JobError(f"ROLLUP_AUTHORITY_GAP:{instrument_id}:{family}:{date}:{event_ns}")
                    outcome = pw.add(record, source_rank=selected[0]["source_rank"])
                    if not outcome["accepted"]:
                        raise JobError(f"ROLLUP_WRITER_REJECTED:{instrument_id}:{family}:{date}:{outcome['reason']}")
        checkpoint = _finish(
            {(instrument_id, family): pw}, checkpoint, job_stage, dataset_version,
            curated_root, date, source_objects)
    return checkpoint


def _record_depth_continuity_for_date(checkpoint, curated_root, dataset_version, instrument_id, date, job_stage):
    dest = _completed_partition_dest(curated_root, dataset_version, instrument_id, "depth", date)
    with open(os.path.join(dest, "_manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    paths = _writer.manifest_part_paths(dest, manifest)
    rows = list(_continuity.summarize_parquet(dataset_version, instrument_id, paths, job_stage))
    checkpoint.setdefault("continuity_summary", []).extend(rows)
    return checkpoint


def _partition_sources(checkpoint, partition_entries, date):
    keys = sorted({entry["s3_key"] for entry in partition_entries})
    providers = {_input_entry(checkpoint, key).get("curated_provider", "databento") for key in keys}
    if len(providers) != 1:
        raise JobError(f"MIXED_PROVIDER_PARTITION:{date}:{sorted(providers)}")
    sources = []
    for key in keys:
        entry = _input_entry(checkpoint, key)
        if entry.get("stream_files") is None:
            sources.append({"s3_key": key, "sha256": entry["sha256"]})
            continue
        contributed = checkpoint.get("stream_sources", {}).get(date)
        if not contributed:
            raise JobError(f"STREAM_SOURCES_MISSING:{key}:{date}")
        sources.extend(contributed)
    return sources, providers.pop()


def _input_entry(checkpoint, s3_key):
    for entry in checkpoint["inputs"]:
        if entry["s3_key"] == s3_key:
            return entry
    raise JobError(f"UNKNOWN_INPUT:{s3_key}")


def _day_unit(checkpoint, s3_key, date):
    for unit in _input_entry(checkpoint, s3_key)["day_units"]:
        if unit["date"] == date:
            return unit
    raise JobError(f"MISSING_DAY_UNIT:{s3_key}:{date}")


def _completed_partition_dest(curated_root, dataset_version, instrument_id, family, date, provider="databento"):
    if provider not in {"databento", "binance"}:
        raise JobError(f"UNSUPPORTED_CURATED_PROVIDER:{provider}")
    return os.path.join(curated_root, provider, _writer.instrument_slug(instrument_id), family, dataset_version, date)


def _read_published_manifest(curated_root, dataset_version, entry):
    dest = _completed_partition_dest(curated_root, dataset_version, entry["instrument_id"], entry["family"], entry["date"],
                                     entry.get("provider", "databento"))
    with open(os.path.join(dest, "_manifest.json"), encoding="utf-8") as fh:
        return json.load(fh), os.path.relpath(dest, curated_root).replace(os.sep, "/")


def _manifest_and_prefix_for(curated_root, dataset_version, entry):
    if not entry.get("evicted"):
        return _read_published_manifest(curated_root, dataset_version, entry)
    dest = _completed_partition_dest(curated_root, dataset_version, entry["instrument_id"], entry["family"], entry["date"],
                                     entry.get("provider", "databento"))
    prefix = os.path.relpath(dest, curated_root).replace(os.sep, "/")
    fields = entry["catalog_fields"]
    manifest = {
        "instrument_id": entry["instrument_id"], "family": entry["family"],
        "dataset_version": dataset_version, "date": entry["date"],
        "record_count": fields["record_count"], "rejected_count": fields["rejected_count"],
        "event_ns_min": fields["event_ns_min"], "event_ns_max": fields["event_ns_max"],
        "logical_sha256": fields["logical_sha256"],
        "parts": [{}] * fields["part_count"],
    }
    return manifest, prefix


def run_job(inputs, dataset_version, **kwargs):
    from local_lock import LocalLock, conversion_guard_path
    _writer.validate_version(dataset_version)
    root = os.path.realpath(os.fspath(kwargs["curated_root"]))
    stage = os.path.realpath(os.fspath(kwargs["staging_root"]))
    if stage == root or os.path.commonpath([stage, root]) in (stage, root):
        raise JobError("STAGING_CURATED_MUST_BE_DISJOINT")
    cleanup = kwargs.pop("cleanup_date_staging", False)
    with LocalLock(conversion_guard_path(root, dataset_version)), LocalLock(stage + ".stage.guard"):
        result = _run_job(inputs, dataset_version, **kwargs)
        if cleanup:
            from backfill_driver import clean_partition_staging_for_date
            result["cleaned_staging_dirs"] = clean_partition_staging_for_date(
                os.path.join(stage, result["job_id"]), result["partitions"], kwargs.get("target_date"))
        return result


def validate_families(families):
    if families is None:
        return None
    if (isinstance(families, str) or not all(isinstance(f, str) and f for f in families)
            or not families or not set(families) <= CANONICAL_FAMILIES):
        raise JobError("INVALID_FAMILY_FILTER")
    return frozenset(families)


def job_id_for(descs, dataset_version, definition_sources=(), families=None):
    scope = {
        "inputs": sorted((d["s3_key"], d["schema"], d["dataset"] or "", d["symbol"] or "", d["last_modified"], d["coverage_verified"]) for d in descs),
        "definition_sources": sorted((s["s3_key"], s["sha256"]) for s in definition_sources),
    }
    stream_windows = sorted((d["s3_key"], *d["window"]) for d in descs if d.get("stream") is not None)
    if stream_windows:
        scope["stream_windows"] = stream_windows
    families = validate_families(families)
    if families is not None:
        scope["families"] = sorted(families)
    return _convert._job_id(
        [{"s3_key": d["s3_key"], "sha256": d["sha256"]} for d in descs],
        dataset_version, None, scope,
    )


def _run_job(inputs, dataset_version, *, staging_root, curated_root, catalog_root,
             node_bin="node", worker_path=None, holder="conversion", definition_sources=None, target_date=None,
             on_partition_complete=None, on_catalog_publish=None, families=None):
    families = validate_families(families)
    staging_root = os.fspath(staging_root)
    worker_path = worker_path or _convert._WORKER
    if target_date is not None:
        try:
            if _dt.date.fromisoformat(target_date).isoformat() != target_date:
                raise ValueError()
        except (ValueError, TypeError):
            raise JobError("INVALID_TARGET_DATE") from None

    descs = [_describe_input(**i) for i in inputs]
    if len({d["s3_key"] for d in descs}) != len(descs):
        raise JobError("DUPLICATE_SOURCE_KEY")
    definition_sources = [dict(s, sha256=_convert._sha256_file(s["local_path"])) for s in (definition_sources or [])]
    if len({s["s3_key"] for s in definition_sources}) != len(definition_sources):
        raise JobError("DUPLICATE_DEFINITION_SOURCE_KEY")
    job_id = job_id_for(descs, dataset_version, definition_sources, families)
    job_stage = os.path.join(staging_root, job_id)
    os.makedirs(job_stage, exist_ok=True)
    _rejections.begin_attempt(job_stage)

    checkpoint = _ckpt.load(job_stage)
    if checkpoint is None:
        checkpoint = _build_checkpoint(job_stage, job_id, dataset_version, descs, definition_sources, families)
    else:
        if checkpoint["job_id"] != job_id or checkpoint.get("dataset_version") != dataset_version:
            raise JobError("CHECKPOINT_IDENTITY_MISMATCH")
        by_key = {e["s3_key"]: e for e in checkpoint["inputs"]}
        for desc in descs:
            entry = by_key.get(desc["s3_key"])
            if entry is None or entry["sha256"] != desc["sha256"]:
                raise JobError(f"JOB_INPUTS_CHANGED:{desc['s3_key']}")

    if target_date is not None:
        if not any(p["date"] == target_date for p in checkpoint["authority_plan"]):
            raise JobError(f"TARGET_DATE_NOT_IN_PLAN:{target_date}")
        if any(p["family"] == "depth" and p["date"] < target_date
               and not _ckpt.is_partition_complete(checkpoint, p["instrument_id"], p["family"], p["date"])
               for p in checkpoint["authority_plan"]):
            raise JobError("EARLIER_DEPTH_DATE_INCOMPLETE")

    for source in checkpoint["inputs"]:
        for unit in source["day_units"]:
            if not unit.get("sha256") or _convert._sha256_file(unit["path"]) != unit["sha256"]:
                raise JobError("SPLIT_INTEGRITY_FAILURE")
    for entry in checkpoint["completed_partitions"]:
        if entry.get("evicted"):
            continue
        dest = _completed_partition_dest(curated_root, dataset_version, entry["instrument_id"], entry["family"], entry["date"],
                                         entry.get("provider", "databento"))
        mp = os.path.join(dest, "_manifest.json")
        if _convert._sha256_file(mp) != entry["manifest_sha256"]:
            raise JobError("MANIFEST_INTEGRITY_FAILURE")
        with open(mp, encoding="utf-8") as fh:
            manifest = json.load(fh)
        for part in manifest["parts"]:
            if _convert._sha256_file(os.path.join(dest, part["name"])) != part["sha256"]:
                raise JobError("PART_INTEGRITY_FAILURE")

    writers = {}

    def writer_for(instrument_id, family, date):
        key = (instrument_id, family, date)
        if key not in writers:
            writers[key] = _writer.PartitionWriter(job_stage, instrument_id, family, dataset_version, date)
        return writers[key]

    remaining = [
        p for p in checkpoint["authority_plan"]
        if not _ckpt.is_partition_complete(checkpoint, p["instrument_id"], p["family"], p["date"])
        and (target_date is None or p["date"] == target_date)
    ]
    groups = {}
    for entry in remaining:
        groups.setdefault((entry["s3_key"], entry["date"]), []).append(entry)
    full_group = {}
    for entry in checkpoint["authority_plan"]:
        full_group.setdefault((entry["s3_key"], entry["date"]), []).append(entry)

    partitions = {}
    for entry in remaining:
        partitions.setdefault((entry["instrument_id"], entry["family"], entry["date"]), []).append(entry)
    pending_groups = {}
    partitions_for_group = {}
    for partition_key, partition_entries in partitions.items():
        source_groups = {(entry["s3_key"], entry["date"]) for entry in partition_entries}
        pending_groups[partition_key] = source_groups
        for source_group in source_groups:
            partitions_for_group.setdefault(source_group, set()).add(partition_key)
    continuity_state = checkpoint.get("continuity_state", {})
    with ContractBridge(worker_path, node_bin=node_bin) as bridge:
        try:
            completed = set()

            def notify_partition_complete(partition_key):
                if on_partition_complete is not None:
                    on_partition_complete(
                        checkpoint, job_stage, curated_root, dataset_version,
                        partition_key[0], partition_key[1], partition_key[2])

            def pending_rollup_targets(inst, date):
                if not any(
                    entry["instrument_id"] == inst and entry["family"] == "candle_1m" and entry["date"] == date
                    for entry in checkpoint["authority_plan"]
                ):
                    return {}
                return {
                    family: partitions[(inst, family, date)]
                    for family in ("candle_1h", "candle_1d")
                    if (inst, family, date) in partitions
                    and (inst, family, date) not in completed
                    and not _ckpt.is_partition_complete(checkpoint, inst, family, date)
                }

            def finish_rollups_from_minute(inst, date):
                nonlocal checkpoint
                targets = pending_rollup_targets(inst, date)
                if not targets:
                    return []
                if not _ckpt.is_partition_complete(checkpoint, inst, "candle_1m", date):
                    return []
                minute_entries = [
                    entry for entry in checkpoint["authority_plan"]
                    if entry["instrument_id"] == inst and entry["family"] == "candle_1m" and entry["date"] == date
                ]
                checkpoint = _derive_candle_rollups(
                    bridge, checkpoint, job_stage, dataset_version, curated_root,
                    inst, date, minute_entries, targets, writer_for)
                derived = [(inst, family, date) for family in targets]
                completed.update(derived)
                return derived

            def finish_ready_partitions():
                nonlocal checkpoint
                checkpoint["continuity_state"] = continuity_state
                for (inst, family, date), partition_entries in partitions.items():
                    partition_key = (inst, family, date)
                    if partition_key in completed or pending_groups[partition_key]:
                        continue
                    if family in {"candle_1h", "candle_1d"} and any(
                        entry["instrument_id"] == inst and entry["family"] == "candle_1m" and entry["date"] == date
                        for entry in checkpoint["authority_plan"]
                    ):
                        continue
                    sources, curated_provider = _partition_sources(checkpoint, partition_entries, date)
                    pw = writers[partition_key]
                    checkpoint = _finish({(inst, family): pw}, checkpoint, job_stage, dataset_version, curated_root, date,
                                         sources, provider=curated_provider)
                    completed.add(partition_key)
                    derived = finish_rollups_from_minute(inst, date) if family == "candle_1m" else []
                    for derived_key in derived:
                        notify_partition_complete(derived_key)
                    notify_partition_complete(partition_key)

            for inst, family, date in list(partitions):
                if family in {"candle_1h", "candle_1d"}:
                    derived = finish_rollups_from_minute(inst, date)
                    for derived_key in derived:
                        notify_partition_complete(derived_key)
                    if derived:
                        notify_partition_complete((inst, "candle_1m", date))
            dispatched = set()
            for (inst, family, date), partition_entries in partitions.items():
                if (inst, family, date) in completed:
                    continue
                for key in sorted({e["s3_key"] for e in partition_entries}):
                    source_group = (key, date)
                    if source_group in dispatched:
                        continue
                    checkpoint = _process_group(bridge, checkpoint, job_stage, dataset_version, curated_root,
                                                key, date, groups[(key, date)], full_group, writer_for, continuity_state)
                    dispatched.add(source_group)
                    for partition_key in partitions_for_group[source_group]:
                        pending_groups[partition_key].remove(source_group)
                    finish_ready_partitions()
            checkpoint["continuity_state"] = continuity_state
        finally:
            for other in writers.values():
                if not other._fh.closed:
                    other._fh.close()

    all_partitions_complete = all(
        _ckpt.is_partition_complete(checkpoint, p["instrument_id"], p["family"], p["date"])
        for p in _ckpt.planned_in_scope(checkpoint)
    )
    pointer = None
    if not all_partitions_complete:
        pass
    elif checkpoint.get("published"):
        pointer = _catalog.job_receipt(catalog_root, dataset_version, checkpoint["job_id"])
    else:
        local_db = os.path.join(job_stage, "catalog.local.sqlite")
        builder = _catalog.CatalogBuilder(local_db)
        builder.record_dataset_version(dataset_version)
        for entry in checkpoint["completed_partitions"]:
            manifest, prefix = _manifest_and_prefix_for(curated_root, dataset_version, entry)
            builder.record_partition(manifest, prefix, entry["manifest_sha256"], published_to_s3=entry.get("evicted", False),
                                     provider=entry.get("provider", "databento"))

        if checkpoint.get("continuity_summary"):
            builder.record_continuity(checkpoint["continuity_summary"])

        for alias, table in checkpoint.get("roll_tables", {}).items():
            if table["rows"]:
                builder.record_roll_intervals(table["rows"], table["rows"][0]["roll_table_version"])

        builder.mark_published(dataset_version)
        builder.close()

        pointer = _catalog.publish_job(catalog_root, local_db, dataset_version, checkpoint["job_id"],
                                       holder=holder, on_ready_to_publish=on_catalog_publish)
        checkpoint["published"] = True
        checkpoint = _ckpt.save(job_stage, checkpoint, _now_iso())

    return {
        "job_id": checkpoint["job_id"], "dataset_version": dataset_version,
        "conversion_started_ns": checkpoint["conversion_started_ns"],
        "partitions": sorted(
            f"{e.get('provider', 'databento')}/{_writer.instrument_slug(e['instrument_id'])}/{e['family']}/{dataset_version}/{e['date']}"
            for e in checkpoint["completed_partitions"]
        ),
        "overlap_excluded": checkpoint.get("overlap_excluded", []),
        "roll_table_warnings": sorted(
            w for table in checkpoint.get("roll_tables", {}).values() for w in table["warnings"]
        ),
        "skipped_empty_definition_sources": checkpoint.get("skipped_empty_definition_sources", []),
        "catalog_pointer": pointer,
        "fully_published": all_partitions_complete,
    }
