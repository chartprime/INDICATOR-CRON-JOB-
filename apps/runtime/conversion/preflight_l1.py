"""Fail-closed release gate for a long unattended L1 archive conversion.

This command intentionally performs the expensive checks instead of accepting
an old hand-written checklist: it inventories and HEAD-verifies raw inputs,
decodes every L1 row to census action codes, builds the futures roll tables
from the same source/definition universe, and checks the live release, unit,
capacity, collector and target namespace.  It writes a durable JSON report and
returns non-zero if any gate fails.

Run it under a bounded transient unit as ``ttconvert`` with the conversion
service environment.  It never writes raw S3 objects, deletes S3 objects,
starts the production backfill unit, or changes ``CURRENT``.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import time

import boto3
from botocore.config import Config

import backfill_sequence
import convert
import csv_decode
import dbn
import raw_source
import roll_table


ALLOWED_MBP_ACTIONS = frozenset({"A", "C", "F", "M", "R", "T"})
_NS_PER_DAY = 86_400 * 1_000_000_000


class PreflightError(RuntimeError):
    pass


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _next_day(value):
    return (dt.date.fromisoformat(value) + dt.timedelta(days=1)).isoformat()


def _json_file(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _service_property(unit, *properties):
    command = ["systemctl", "show", unit]
    for prop in properties:
        command.extend(["-p", prop])
    completed = subprocess.run(command, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pairs = (line.split("=", 1) for line in completed.stdout.splitlines() if "=" in line)
    return {key: value for key, value in pairs}


def _release_commit(path):
    values = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values[key] = value
    return values.get("commit")


def _credentials_from_environment():
    required = {
        "RCLONE_CONFIG_TTCONVERT_REGION",
        "RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID",
        "RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY",
    }
    values = {key: os.environ.get(key, "") for key in required}
    missing = sorted(key for key, value in values.items() if not value)
    if missing:
        raise PreflightError(f"MISSING_INJECTED_SERVICE_ENV_VALUES:{','.join(missing)}")
    return values


def _client(env):
    return boto3.client(
        "s3", region_name=env["RCLONE_CONFIG_TTCONVERT_REGION"],
        aws_access_key_id=env["RCLONE_CONFIG_TTCONVERT_ACCESS_KEY_ID"],
        aws_secret_access_key=env["RCLONE_CONFIG_TTCONVERT_SECRET_ACCESS_KEY"],
        config=Config(connect_timeout=10, read_timeout=120, retries={"max_attempts": 2}),
    )


def _all_phase_objects(client, bucket):
    inventories, flat = {}, []
    for dataset, schema, symbol, definition_symbol in backfill_sequence.PHASE_SYMBOLS["l1"]:
        start, end = raw_source.discover_date_range(client, bucket, dataset, schema, symbol)
        objects = raw_source.list_raw_objects(client, bucket, dataset, schema, symbol, start, _next_day(end))
        if not objects:
            raise PreflightError(f"EMPTY_PHASE_INVENTORY:{dataset}:{schema}:{symbol}")
        key = f"{dataset}:{schema}:{symbol}"
        inventories[key] = {
            "dataset": dataset, "schema": schema, "symbol": symbol, "definition_symbol": definition_symbol,
            "start": start, "end": end, "objects": objects,
        }
        flat.extend((dataset, schema, symbol, entry) for entry in objects)
    return inventories, flat


def _head_verify(client, bucket, objects):
    for _dataset, _schema, _symbol, entry in objects:
        head = client.head_object(Bucket=bucket, Key=entry["s3_key"])
        if head.get("ContentLength") != entry["bytes"] or head.get("ETag") != entry["etag"]:
            raise PreflightError(f"FROZEN_SOURCE_CHANGED:{entry['s3_key']}")


def _download_verified(client, bucket, entry, directory):
    head = client.head_object(Bucket=bucket, Key=entry["s3_key"])
    if head.get("ContentLength") != entry["bytes"] or head.get("ETag") != entry["etag"]:
        raise PreflightError(f"FROZEN_SOURCE_CHANGED:{entry['s3_key']}")
    suffix = Path(entry["s3_key"]).suffix or ".raw"
    handle = tempfile.NamedTemporaryFile(prefix="raw-", suffix=suffix, dir=directory, delete=False)
    path = Path(handle.name)
    count, digest = 0, hashlib.sha256()
    try:
        with handle, client.get_object(Bucket=bucket, Key=entry["s3_key"], IfMatch=entry["etag"])["Body"] as body:
            while chunk := body.read(1024 * 1024):
                count += len(chunk)
                if count > entry["bytes"]:
                    raise PreflightError(f"DOWNLOAD_SIZE_MISMATCH:{entry['s3_key']}")
                digest.update(chunk)
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        if count != entry["bytes"]:
            raise PreflightError(f"DOWNLOAD_SIZE_MISMATCH:{entry['s3_key']}:{count}!={entry['bytes']}")
        return path, digest.hexdigest()
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def _action_census_and_metadata(client, bucket, objects, directory):
    counts, metadata = {}, {}
    for index, (dataset, schema, symbol, entry) in enumerate(objects, start=1):
        print(json.dumps({"event": "preflight_source_start", "index": index, "total": len(objects),
                          "key": entry["s3_key"], "bytes": entry["bytes"]}), file=sys.stderr, flush=True)
        path, sha256 = _download_verified(client, bucket, entry, directory)
        holder = []
        try:
            for _position, row in dbn.decode(path, expected_schema=schema, on_metadata=holder.append):
                action = row.get("action")
                counts[action] = counts.get(action, 0) + 1
                if action not in ALLOWED_MBP_ACTIONS:
                    raise PreflightError(f"UNSUPPORTED_SOURCE_ACTION:{action!r}:{entry['s3_key']}")
        finally:
            path.unlink(missing_ok=True)
        if len(holder) != 1:
            raise PreflightError(f"MISSING_OR_MULTIPLE_METADATA:{entry['s3_key']}")
        meta = holder[0]
        metadata[entry["s3_key"]] = {
            "dataset": dataset, "schema": schema, "symbol": symbol, "sha256": sha256,
            "etag": entry["etag"], "bytes": entry["bytes"],
            "stype_in": meta.stype_in, "symbols": list(meta.symbols), "mappings": meta.mappings,
        }
        print(json.dumps({"event": "preflight_source_complete", "index": index, "key": entry["s3_key"]}),
              file=sys.stderr, flush=True)
    return counts, metadata


def _require_complete_raw_census(metadata, objects):
    """Downstream evidence is meaningful only if every frozen raw object was
    decoded successfully.  A partial census must not masquerade as roll proof."""
    if len(metadata) != len(objects):
        raise PreflightError(f"INCOMPLETE_RAW_CENSUS:{len(metadata)}!={len(objects)}")


def _definition_objects(client, bucket, raw_metadata):
    maximum = None
    aliases = {}
    for entry in raw_metadata.values():
        if entry["dataset"] != "GLBX.MDP3" or entry["stype_in"] != "continuous":
            continue
        if len(entry["symbols"]) != 1:
            raise PreflightError(f"CONTINUOUS_INPUT_INVALID_SYMBOLS:{entry['symbol']}")
        alias = entry["symbols"][0]
        intervals = entry["mappings"].get(alias)
        if not intervals:
            raise PreflightError(f"CONTINUOUS_ALIAS_NOT_IN_METADATA:{alias}")
        aliases.setdefault(alias, []).extend(intervals)
        for interval in intervals:
            if maximum is None or interval["end_date"] > maximum:
                maximum = interval["end_date"]
    if not aliases or maximum is None:
        return {}, {}
    definitions = {}
    for alias in sorted(aliases):
        symbol = alias.split(".", 1)[0]
        objects = raw_source.list_raw_objects(client, bucket, "GLBX.MDP3", "definition", symbol, "2000-01-01", maximum)
        if not objects:
            raise PreflightError(f"NO_DEFINITION_OBJECTS_FOUND:{symbol}")
        definitions[symbol] = objects
    return aliases, definitions


def _definition_rows(path):
    """Databento serves GLBX definitions as CSV, not DBN. Decoding by the file's
    own type is what job._build_roll_tables does; assuming DBN here made this
    gate fail with "invalid DBN header" on every real definition object."""
    source = os.fspath(path)
    if convert._is_csv(source):
        return [row for _position, row in csv_decode.decode_definition(source)]
    return [row for _position, row in dbn.decode(source, expected_schema="definition")]


def _validate_roll_tables(client, bucket, raw_metadata, directory, *, aliases=None, definitions=None):
    if aliases is None or definitions is None:
        aliases, definitions = _definition_objects(client, bucket, raw_metadata)
    if not aliases:
        return {"aliases": {}, "definition_objects": 0}
    rows, hashes, verified_sources = [], [], []
    seen_keys, skipped_empty = set(), []
    for entries in definitions.values():
        for entry in entries:
            if entry["s3_key"] in seen_keys:
                continue
            seen_keys.add(entry["s3_key"])
            path, sha256 = _download_verified(client, bucket, entry, directory)
            # Mirror job._build_roll_tables exactly: the hash of every source
            # counts toward the roll-table version whether or not it yields
            # rows, or this gate validates a different table than the one the
            # conversion will build.
            hashes.append(sha256)
            verified_sources.append({
                "s3_key": entry["s3_key"], "etag": entry["etag"],
                "bytes": entry["bytes"], "sha256": sha256,
            })
            try:
                rows.extend(_definition_rows(path))
            except csv_decode.CsvError as error:
                if str(error) != "EMPTY_CSV":
                    raise
                skipped_empty.append(entry["s3_key"])
            finally:
                path.unlink(missing_ok=True)
    snapshots = roll_table.definition_snapshots_from_rows(rows)
    raw_hashes = sorted(entry["sha256"] for entry in raw_metadata.values() if entry["dataset"] == "GLBX.MDP3")
    version = roll_table.version(hashes, raw_hashes)
    outcome = {}
    for alias, intervals in aliases.items():
        merged = []
        for interval in sorted(intervals, key=lambda i: (i["start_date"], i["end_date"], i["symbol"])):
            if merged and merged[-1]["symbol"] == interval["symbol"] and interval["start_date"] <= merged[-1]["end_date"]:
                merged[-1]["end_date"] = max(merged[-1]["end_date"], interval["end_date"])
            else:
                merged.append(dict(interval))
        built = roll_table.build(alias, merged, snapshots, version)
        warnings = roll_table.validate(alias, built)
        outcome[alias] = {"intervals": len(built), "warnings": warnings, "roll_table_version": version}
    return {"aliases": outcome, "definition_objects": len(seen_keys),
            "verified_definition_sources": verified_sources}


def _target_version_absent(client, bucket, curated_prefix, dataset_version):
    prefix = curated_prefix.rstrip("/") + "/"
    paginator = client.get_paginator("list_objects_v2")
    matches = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        # The phase registry supplies a base version, while the sequence gives
        # each symbol-month a derived version ending in ``-YYYY-MM``.  Reject
        # either form; accepting only the bare base would miss every previous
        # phase publication.
        matches.extend(obj["Key"] for obj in page.get("Contents", [])
                       if f"/{dataset_version}/" in obj["Key"] or f"/{dataset_version}-" in obj["Key"])
    if matches:
        raise PreflightError(f"TARGET_VERSION_NOT_EMPTY:{len(matches)}")
    return {"keys": 0}


def _service_conversion_environment(service):
    raw = _service_property(service, "Environment").get("Environment", "")
    values = {}
    for token in shlex.split(raw):
        key, separator, value = token.partition("=")
        if separator:
            values[key] = value
    return values


def _positive_environment_value(values, key, default):
    raw = values.get(key, os.environ.get(key, default))
    try:
        value = int(raw)
    except (TypeError, ValueError) as error:
        raise PreflightError(f"INVALID_CAPACITY_ENVIRONMENT:{key}") from error
    if value <= 0:
        raise PreflightError(f"INVALID_CAPACITY_ENVIRONMENT:{key}")
    return value


def _raw_covered_range(entry, dataset, schema, symbol):
    prefix = f"raw/databento/dataset={dataset}/schema={schema}/symbol={symbol}/"
    key = entry.get("s3_key")
    if not isinstance(key, str) or not key.startswith(prefix):
        raise PreflightError(f"INVALID_RAW_INVENTORY_KEY:{key!r}")
    covered = raw_source._covered_range(raw_source._parse_partitions(key[len(prefix):]))
    if covered is None:
        raise PreflightError(f"INVALID_RAW_INVENTORY_COVERAGE:{key}")
    return covered


def _largest_source_requirement(inventories, definitions):
    largest_raw = 0
    largest_source_set = 0
    for inventory in inventories.values():
        dataset, schema, symbol = inventory["dataset"], inventory["schema"], inventory["symbol"]
        objects = inventory["objects"]
        definition_bytes = sum(entry["bytes"] for entry in definitions.get(inventory["definition_symbol"], []))
        for start, end in backfill_sequence._months(inventory["start"], inventory["end"]):
            window_start = dt.date.fromisoformat(start)
            window_end = dt.date.fromisoformat(end) + dt.timedelta(days=1)
            selected = []
            for entry in objects:
                covered_start, covered_end = _raw_covered_range(entry, dataset, schema, symbol)
                if covered_start < window_end and covered_end > window_start:
                    selected.append(entry)
            if not selected:
                raise PreflightError(f"EMPTY_MONTHLY_SOURCE_SET:{dataset}:{schema}:{symbol}:{start}")
            raw_bytes = sum(entry["bytes"] for entry in selected)
            largest_raw = max(largest_raw, *(entry["bytes"] for entry in selected))
            largest_source_set = max(largest_source_set, raw_bytes + definition_bytes)
    if not largest_raw or not largest_source_set:
        raise PreflightError("FROZEN_INVENTORY_REQUIRED")
    return largest_raw, largest_source_set


def _capacity(inventories, definitions, staging_root, service_environment, pool_size):
    if not isinstance(pool_size, int) or isinstance(pool_size, bool) or pool_size < 1:
        raise PreflightError("INVALID_PREFLIGHT_POOL_SIZE")
    reserve = _positive_environment_value(service_environment, "TT_CONVERT_GLOBAL_RESERVE_BYTES", 200 * 1024**3)
    scratch = _positive_environment_value(service_environment, "TT_CONVERT_SCRATCH_BYTES", 8 * 1024**3)
    largest, largest_source_set = _largest_source_requirement(inventories, definitions)
    forecast = largest * 19
    per_worker = max(scratch, forecast) + largest_source_set
    required = reserve + pool_size * per_worker
    free = shutil.disk_usage(staging_root).free
    if free < required:
        raise PreflightError(f"INSUFFICIENT_PREFLIGHT_CAPACITY:{free}<{required}")
    return {"free_bytes": free, "required_bytes": required, "reserve_bytes": reserve,
            "scratch_bytes": scratch, "largest_raw_bytes": largest,
            "largest_monthly_source_set_bytes": largest_source_set,
            "nineteen_x_forecast_bytes": forecast, "pool_size": pool_size,
            "per_worker_bytes": per_worker}


def _collector_health(path, collector_service):
    state = _service_property(collector_service, "ActiveState", "SubState", "MainPID")
    if state.get("ActiveState") != "active" or state.get("SubState") != "running" or state.get("MainPID") in {None, "0"}:
        raise PreflightError(f"COLLECTOR_NOT_RUNNING:{state}")
    health = _json_file(path)
    updated = dt.datetime.fromisoformat(health["updatedAt"].replace("Z", "+00:00"))
    age = (dt.datetime.now(dt.timezone.utc) - updated).total_seconds()
    if age < 0 or age > 15:
        raise PreflightError(f"COLLECTOR_HEALTH_STALE:{age:.3f}")
    if health.get("pendingWriteItems", -1) > 20_000 or health.get("writeLagMs", -1) > 20_000:
        raise PreflightError(f"COLLECTOR_PRESSURE:{health.get('pendingWriteItems')}:{health.get('writeLagMs')}")
    return {"service": state, "health": health, "age_seconds": age}


def _unit_and_release(expected_commit, unit, ops_unit, service, service_env):
    metadata = Path("/opt/terminal-l1-l2/current/RELEASE_METADATA")
    commit = _release_commit(metadata)
    if not commit or not commit.startswith(expected_commit):
        raise PreflightError(f"APP_RELEASE_MISMATCH:{commit}!~{expected_commit}")
    installed = Path(unit).resolve()
    expected = Path(ops_unit).resolve()
    if installed != expected or _sha256_bytes(installed.read_bytes()) != _sha256_bytes(expected.read_bytes()):
        raise PreflightError("INSTALLED_UNIT_MISMATCH")
    if f"EnvironmentFile={service_env}" not in installed.read_text(encoding="utf-8"):
        raise PreflightError("SERVICE_ENVIRONMENT_FILE_MISMATCH")
    properties = _service_property(service, "Type", "Restart", "RestartPreventExitStatus", "StartLimitBurst", "MainPID", "ActiveState")
    expected_properties = {"Type": "oneshot", "Restart": "on-failure", "RestartPreventExitStatus": "2 3", "StartLimitBurst": "3"}
    for key, value in expected_properties.items():
        if properties.get(key) != value:
            raise PreflightError(f"SYSTEMD_PROPERTY_MISMATCH:{key}:{properties.get(key)}!={value}")
    if properties.get("MainPID") != "0" or properties.get("ActiveState") != "inactive":
        raise PreflightError(f"BACKFILL_NOT_STOPPED:{properties}")
    return {"app_commit": commit, "unit": str(installed), "properties": properties}


def _locks_available(staging_root, curated_root, dataset_version):
    if os.name != "posix":
        raise PreflightError("LOCK_CHECK_REQUIRES_POSIX")
    import fcntl
    paths = [
        Path(staging_root).resolve().with_name(Path(staging_root).name + ".sequence.guard"),
        Path(staging_root).resolve() / ".capacity-reservations.guard",
        Path(curated_root).resolve() / "_locks" / f"conversion.{dataset_version}.guard",
    ]
    checked = []
    for path in paths:
        if path.is_symlink():
            raise PreflightError(f"UNSAFE_LOCK_PATH:{path}")
        was_present = path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a+b") as fh:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise PreflightError(f"STALE_OR_LIVE_LOCK_HELD:{path}") from error
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        checked.append({"path": str(path), "present_before_check": was_present})
    try:
        reservations = backfill_sequence._CapacityReservation(staging_root)._read()
    except backfill_sequence.SequenceError as error:
        raise PreflightError("CAPACITY_RESERVATION_STATE_INVALID") from error
    if reservations:
        raise PreflightError(f"CAPACITY_RESERVATIONS_NOT_EMPTY:{len(reservations)}")
    return {"locks": checked}


def _run_gate(report, name, fn):
    started = time.monotonic()
    try:
        detail = fn()
    except Exception as error:
        report["gates"][name] = {"status": "FAIL", "seconds": round(time.monotonic() - started, 3),
                                 "error": f"{type(error).__name__}: {error}"}
        return False
    report["gates"][name] = {"status": "PASS", "seconds": round(time.monotonic() - started, 3), "detail": detail}
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-commit", required=True, help="reviewed application commit (full or prefix)")
    parser.add_argument("--dataset-version", default="w606-l1-v2")
    parser.add_argument("--bucket", default="chartprime-historical-data")
    parser.add_argument("--curated-prefix", default="curated/databento")
    parser.add_argument("--staging-root", default="/srv/terminal-data/curated-staging")
    parser.add_argument("--curated-root", default="/srv/terminal-data/curated")
    parser.add_argument("--pool-size", type=int, default=1,
                        help="workers whose simultaneous worst-case disk reservation must fit")
    parser.add_argument("--service-env", default="/etc/terminal-l1-l2/convert/service.env")
    parser.add_argument("--health-file", default="/run/terminal-l1-l2/collector-health.json")
    parser.add_argument("--report", required=True)
    parser.add_argument("--unit", default="/etc/systemd/system/terminal-backfill@.service")
    parser.add_argument("--ops-unit", default="/opt/terminal-l1-l2/ops/systemd/terminal-backfill@.service")
    parser.add_argument("--service", default="terminal-backfill@l1.service")
    parser.add_argument("--collector-service", default="terminal-collector.service")
    args = parser.parse_args(argv)

    report = {"started_at": _now(), "dataset_version": args.dataset_version, "expected_commit": args.expected_commit,
              "gates": {}, "scope": "read-only S3/raw verification; temporary local scan files are removed"}
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    passed = True
    client = None
    service_environment = {}

    def credentials_gate():
        nonlocal client
        client = _client(_credentials_from_environment())
        return {"required_values_present": True}

    def release_gate():
        nonlocal service_environment
        detail = _unit_and_release(args.expected_commit, args.unit, args.ops_unit, args.service, args.service_env)
        service_environment = _service_conversion_environment(args.service)
        detail["conversion_environment"] = {
            key: service_environment[key] for key in sorted(service_environment)
            if key.startswith("TT_CONVERT_")
        }
        return detail

    def require_client():
        if client is None:
            raise PreflightError("S3_CLIENT_UNAVAILABLE")
        return client

    passed &= _run_gate(report, "service_credentials_contract", credentials_gate)
    passed &= _run_gate(report, "release_and_installed_unit", release_gate)
    passed &= _run_gate(report, "target_version_empty", lambda: _target_version_absent(
        require_client(), args.bucket, args.curated_prefix, args.dataset_version))
    inventories = {}
    objects = []

    def inventory_gate():
        nonlocal inventories, objects
        inventories, objects = _all_phase_objects(require_client(), args.bucket)
        _head_verify(require_client(), args.bucket, objects)
        return {"objects": len(objects), "bytes": sum(entry["bytes"] for *_prefix, entry in objects),
                "inventories": inventories}

    passed &= _run_gate(report, "frozen_raw_identities", inventory_gate)
    passed &= _run_gate(report, "collector_health", lambda: _collector_health(args.health_file, args.collector_service))
    passed &= _run_gate(report, "backfill_locks_available", lambda: _locks_available(
        args.staging_root, args.curated_root, args.dataset_version))

    scan_root = Path(args.staging_root, "_preflight", f"l1-{args.dataset_version}-{os.getpid()}")
    scan_root.mkdir(parents=True, exist_ok=True)
    metadata = {}
    definitions = {}
    rolls_verified = False
    try:
        def actions_gate():
            nonlocal metadata
            if not objects:
                raise PreflightError("FROZEN_INVENTORY_REQUIRED")
            counts, metadata = _action_census_and_metadata(require_client(), args.bucket, objects, scan_root)
            return {
                "actions": counts, "allowed": sorted(ALLOWED_MBP_ACTIONS), "rows": sum(counts.values()),
                "verified_raw_sources": [
                    {"s3_key": key,
                     **{field: metadata[key][field] for field in ("etag", "bytes", "sha256")}}
                    for key in sorted(metadata)
                ],
            }

        def rolls_gate():
            nonlocal definitions, rolls_verified
            _require_complete_raw_census(metadata, objects)
            aliases, definitions = _definition_objects(require_client(), args.bucket, metadata)
            detail = _validate_roll_tables(require_client(), args.bucket, metadata, scan_root,
                                           aliases=aliases, definitions=definitions)
            rolls_verified = True
            return detail

        def capacity_gate():
            if not service_environment:
                raise PreflightError("INSTALLED_SERVICE_ENVIRONMENT_REQUIRED")
            if not rolls_verified:
                raise PreflightError("VERIFIED_ROLL_TABLES_REQUIRED")
            return _capacity(inventories, definitions, args.staging_root, service_environment, args.pool_size)

        passed &= _run_gate(report, "source_action_census", actions_gate)
        passed &= _run_gate(report, "futures_roll_tables", rolls_gate)
        passed &= _run_gate(report, "capacity", capacity_gate)
    finally:
        shutil.rmtree(scan_root, ignore_errors=True)

    report["finished_at"] = _now()
    report["status"] = "PASS" if passed else "FAIL"
    Path(args.report).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "report": args.report,
                      "gates": {name: value["status"] for name, value in report["gates"].items()}}, sort_keys=True))
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
