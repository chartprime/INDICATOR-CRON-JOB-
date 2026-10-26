from __future__ import annotations

import backfill_driver
import budget
import raw_source
import writer
import datetime
import errno
import hashlib
import json
import multiprocessing
import os
import queue
import sys
import shutil
import socket
import time
import uuid
from pathlib import Path

import checkpoint
import s3_publish
from local_lock import LocalLock
from process_liveness import pid_alive

PHASE_SYMBOLS = {
    "ohlcv": [
        ("GLBX.MDP3", "ohlcv-1s", "ES", "ES"),
        ("GLBX.MDP3", "ohlcv-1s", "NQ", "NQ"),
        ("XNAS.ITCH", "ohlcv-1s", "AAPL", None),
        ("XNAS.ITCH", "ohlcv-1s", "TSLA", None),
    ],
    "ohlcv1m": [
        ("GLBX.MDP3", "ohlcv-1m", "ES", "ES"),
        ("GLBX.MDP3", "ohlcv-1m", "NQ", "NQ"),
        ("XNAS.ITCH", "ohlcv-1m", "AAPL", None),
        ("XNAS.ITCH", "ohlcv-1m", "TSLA", None),
    ],
    "l1": [
        ("GLBX.MDP3", "mbp-1", "ES", "ES"),
        ("GLBX.MDP3", "mbp-1", "NQ", "NQ"),
        ("XNAS.ITCH", "mbp-1", "AAPL", None),
        ("XNAS.ITCH", "mbp-1", "TSLA", None),
    ],
    "l2": [
        ("GLBX.MDP3", "mbp-10", "ES", "ES"),
        ("GLBX.MDP3", "mbp-10", "NQ", "NQ"),
        ("XNAS.ITCH", "mbp-10", "AAPL", None),
        ("XNAS.ITCH", "mbp-10", "TSLA", None),
    ],
    "l1agg": [
        ("XNAS.ITCH", "trade-derived", "AAPL", None),
        ("XNAS.ITCH", "trade-derived", "TSLA", None),
        ("GLBX.MDP3", "trade-derived", "ES", "ES"),
        ("GLBX.MDP3", "trade-derived", "NQ", "NQ"),
    ],
    "tardis-l1": [
        ("binance-futures", "trades", "BTCUSDT", None),
        ("binance-futures", "trades", "ETHUSDT", None),
        ("binance", "trades", "BTCUSDT", None),
        ("binance", "trades", "ETHUSDT", None),
    ],
    "tardis-l1agg": [
        ("BINANCE.UM", "trade-derived", "BTCUSDT", None),
        ("BINANCE.UM", "trade-derived", "ETHUSDT", None),
        ("BINANCE.SPOT", "trade-derived", "BTCUSDT", None),
        ("BINANCE.SPOT", "trade-derived", "ETHUSDT", None),
    ],
}

DERIVED_SCHEMA = "trade-derived"

PHASE_DATASET_VERSIONS = {
    "ohlcv": "w606-ohlcv-v1",
    "ohlcv1m": "w606-ohlcv-1m-v1",
    "l1": "w606-l1-v2",
    "l2": "w606-l2-v1",
    "l1agg": "w606-l1agg-v1",
    "tardis-l1": "w606-tardis-l1-v1",
    "tardis-l1agg": "w606-l1agg-v1",
}

PHASE_WINDOWS = {
    "tardis-l1": ("2025-09-06", "2026-08-31"),
}

QUARANTINE_SKIP_PHASES = frozenset({"ohlcv", "ohlcv1m", "l1", "tardis-l1"})


class SequenceError(RuntimeError):
    pass


def dataset_version_for_phase(phase):
    try:
        return PHASE_DATASET_VERSIONS[phase]
    except KeyError:
        raise SequenceError(f"UNKNOWN_PHASE:{phase}") from None


def run_phase(phase, dataset_version, *, bucket, curated_prefix, staging_root, curated_root, catalog_root,
             min_free_bytes=backfill_driver.DEFAULT_MIN_FREE_BYTES, client=None, pool_size=1,
             symbols=None, **job_kwargs):
    with LocalLock(str(Path(staging_root).resolve()) + ".sequence.guard"):
        return _run_phase(phase, dataset_version, bucket=bucket, curated_prefix=curated_prefix,
            staging_root=staging_root, curated_root=curated_root, catalog_root=catalog_root,
            min_free_bytes=min_free_bytes, client=client, pool_size=pool_size, symbols=symbols,
            **job_kwargs)


def _window_months(available, window):
    first, last = available
    if window is not None:
        first, last = max(first, window[0]), min(last, window[1])
        if last < first:
            raise SequenceError(f"NO_DATES_IN_PHASE_WINDOW:{window[0]}..{window[1]}")
        if (first, last) != tuple(window):
            raise SequenceError(f"PHASE_WINDOW_COVERAGE_MISSING:{window[0]}..{window[1]}:{first}..{last}")
    return list(_months(first, last))


def _months(start, end):
    current = datetime.date.fromisoformat(start)
    finish = datetime.date.fromisoformat(end)
    while current <= finish:
        following = datetime.date(current.year + (current.month == 12), current.month % 12 + 1, 1)
        last = min(finish, following - datetime.timedelta(days=1))
        yield current.isoformat(), last.isoformat()
        current = following


def _clean_derived_rows(job_stage, stage):
    if job_stage.is_symlink() or not job_stage.resolve().is_relative_to(stage.resolve()):
        raise SequenceError("UNSAFE_COMPLETED_SCRATCH")
    if not job_stage.exists():
        return
    targets = []
    for directory, children, files in os.walk(job_stage, followlinks=False):
        current = Path(directory)
        if current.is_symlink():
            raise SequenceError("UNSAFE_COMPLETED_SCRATCH")
        if any((current / child).is_symlink() for child in children):
            raise SequenceError("UNSAFE_COMPLETED_SCRATCH")
        if "rows.ndjson" in files:
            target = current / "rows.ndjson"
            if target.is_symlink() or not target.is_file() or not target.resolve().is_relative_to(job_stage.resolve()):
                raise SequenceError("UNSAFE_COMPLETED_SCRATCH")
            targets.append(target)
    for target in targets:
        target.unlink()


def _clean_completed_month(staging_root, version, outcome, *, derived=False):
    if not isinstance(version, str) or not version or Path(version).name != version:
        raise SequenceError("UNSAFE_COMPLETED_MONTH_VERSION")
    supplied_root = Path(staging_root).absolute()
    stage = supplied_root / version
    if supplied_root.is_symlink() or stage.is_symlink():
        raise SequenceError("UNSAFE_COMPLETED_SCRATCH")
    root = supplied_root.resolve()
    resolved_stage = stage.resolve()
    if not resolved_stage.is_relative_to(root):
        raise SequenceError("UNSAFE_COMPLETED_SCRATCH")
    with LocalLock(str(stage) + ".backfill.guard"), LocalLock(str(stage) + ".stage.guard"):
        for job_id in {r["job_id"] for r in outcome.get("results", [])}:
            if not job_id or any(c not in "0123456789abcdef" for c in job_id):
                raise SequenceError("UNSAFE_COMPLETED_JOB_ID")
            if derived and len(job_id) != 64:
                raise SequenceError("UNSAFE_COMPLETED_JOB_ID")
            try:
                if derived:
                    import derive_families
                    job_stage = stage / job_id[:derive_families.JOB_STAGE_NAME_LENGTH]
                else:
                    job_stage = stage / job_id
                backfill_driver.clean_completed_job_split_staging(job_stage, stage)
                if derived:
                    _clean_derived_rows(job_stage, stage)
            except backfill_driver.BackfillError as error:
                raise SequenceError(str(error)) from error


GLOBAL_SCRATCH_RESERVE_BYTES_DEFAULT = 200 * 1024**3
CAPACITY_RESERVATION_LOCK_WAIT_SECONDS = 30


def _source_bytes_for_capacity(objects):
    source_bytes = 0
    for obj in objects:
        size = obj.get("bytes") if isinstance(obj, dict) else None
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise SequenceError("INVALID_SOURCE_SIZE_FOR_CAPACITY_ADMISSION")
        source_bytes += size
    return source_bytes


def _check_global_capacity(staging_root, additional_bytes=0):
    reserve = budget.positive_env("TT_CONVERT_GLOBAL_RESERVE_BYTES", GLOBAL_SCRATCH_RESERVE_BYTES_DEFAULT)
    if (not isinstance(additional_bytes, int) or isinstance(additional_bytes, bool)
            or additional_bytes < 0):
        raise SequenceError("INVALID_GLOBAL_CAPACITY_ADMISSION")
    free = shutil.disk_usage(backfill_driver._nearest_existing_ancestor(str(staging_root))).free
    required = reserve + additional_bytes
    if free < required:
        raise SequenceError(f"GLOBAL_SCRATCH_RESERVE_EXCEEDED:{free}<{required}")


def _month_capacity_admission(staging_root, objects):
    source_bytes = _source_bytes_for_capacity(objects)
    scratch = budget.positive_env("TT_CONVERT_SCRATCH_BYTES", 8 * 1024**3)
    _check_global_capacity(staging_root, scratch + source_bytes)


def _boot_id():
    if os.name != "posix":
        return None
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _process_start(pid):
    """A Linux PID is reusable; pair it with its /proc start tick before
    treating a persisted capacity claim as still owned."""
    if os.name != "posix" or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        # comm is parenthesized and can contain spaces, hence rsplit rather
        # than a naive split of the full proc stat line. starttime is field 22.
        fields = stat.rsplit(") ", 1)[1].split()
        return fields[19]
    except (IndexError, OSError):
        return None


def _reservation_lock_busy(error):
    if isinstance(error, BlockingIOError):
        return True
    # msvcrt reports an occupied byte-range lock as an ordinary OSError.  Do
    # not retry arbitrary permissions failures: this exception can only be
    # treated as contention after the lock file itself has opened successfully.
    return os.name == "nt" and getattr(error, "errno", None) in {errno.EACCES, errno.EAGAIN}


def _acquire_reservation_lock(path):
    deadline = time.monotonic() + CAPACITY_RESERVATION_LOCK_WAIT_SECONDS
    while True:
        lock = LocalLock(str(path))
        try:
            return lock.acquire()
        except OSError as error:
            if not _reservation_lock_busy(error):
                raise
            if time.monotonic() >= deadline:
                raise SequenceError("CAPACITY_RESERVATION_LOCK_TIMEOUT") from error
            time.sleep(0.05)


class _CapacityReservation:
    """A durable, process-safe reservation for one active source month.

    Per-worker free-space checks alone race: two workers can both observe the
    same free bytes before either expands its split.  This ledger reserves the
    configured scratch ceiling plus every downloaded source while it is live.
    Existing retained staging is still represented by disk usage after a claim
    is released.  A killed process leaves a record which a later claimant
    removes only after proving its PID/boot/start identity is no longer live.
    """
    def __init__(self, staging_root):
        self.root = Path(staging_root).resolve()
        self.path = self.root / "_capacity-reservations.json"
        self.lock_path = self.root / ".capacity-reservations.guard"
        self.key = uuid.uuid4().hex
        self.claimed_sources = 0
        self.closed = False
        self.host = socket.gethostname()
        self.boot_id = _boot_id()
        self.process_start = _process_start(os.getpid())

    def _read(self):
        if not self.path.exists():
            return {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise SequenceError("CAPACITY_RESERVATION_STATE_INVALID") from error
        if not isinstance(value, dict) or set(value) != {"reservations"} or not isinstance(value["reservations"], dict):
            raise SequenceError("CAPACITY_RESERVATION_STATE_INVALID")
        for key, entry in value["reservations"].items():
            if not isinstance(key, str) or not isinstance(entry, dict):
                raise SequenceError("CAPACITY_RESERVATION_STATE_INVALID")
            amount = entry.get("bytes")
            if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
                raise SequenceError("CAPACITY_RESERVATION_STATE_INVALID")
            if (set(entry) != {"bytes", "host", "pid", "boot_id", "process_start"}
                    or not isinstance(entry["host"], str) or not entry["host"]
                    or not isinstance(entry["pid"], int) or isinstance(entry["pid"], bool)
                    or entry["pid"] <= 0
                    or entry["boot_id"] is not None and not isinstance(entry["boot_id"], str)
                    or entry["process_start"] is not None and not isinstance(entry["process_start"], str)):
                raise SequenceError("CAPACITY_RESERVATION_STATE_INVALID")
        return value["reservations"]

    def _write(self, reservations):
        self.root.mkdir(parents=True, exist_ok=True)
        checkpoint._atomic_write_json(str(self.path), {"reservations": reservations})

    def _owner_is_live(self, entry):
        # A claim from another host cannot be safely reclaimed from this host.
        if entry.get("host") != self.host:
            return True
        prior_boot = entry.get("boot_id")
        if prior_boot is not None and self.boot_id is not None and prior_boot != self.boot_id:
            return False
        pid = entry.get("pid")
        if os.name != "posix":
            return pid_alive(pid)
        current_start = _process_start(pid)
        if current_start is None:
            return False
        prior_start = entry.get("process_start")
        return prior_start is None or prior_start == current_start

    def _reap_stale(self, reservations):
        return {key: entry for key, entry in reservations.items() if self._owner_is_live(entry)}

    def admit(self, objects):
        if self.closed:
            raise SequenceError("CAPACITY_RESERVATION_CLOSED")
        source_bytes = _source_bytes_for_capacity(objects)
        scratch = budget.positive_env("TT_CONVERT_SCRATCH_BYTES", 8 * 1024**3)
        reserve = budget.positive_env("TT_CONVERT_GLOBAL_RESERVE_BYTES", GLOBAL_SCRATCH_RESERVE_BYTES_DEFAULT)
        candidate = scratch + self.claimed_sources + source_bytes
        lock = _acquire_reservation_lock(self.lock_path)
        try:
            reservations = self._reap_stale(self._read())
            others = sum(entry["bytes"] for key, entry in reservations.items() if key != self.key)
            free = shutil.disk_usage(backfill_driver._nearest_existing_ancestor(str(self.root))).free
            required = reserve + others + candidate
            if free < required:
                raise SequenceError(f"GLOBAL_SCRATCH_RESERVE_EXCEEDED:{free}<{required}")
            reservations[self.key] = {
                "bytes": candidate, "host": self.host, "pid": os.getpid(),
                "boot_id": self.boot_id, "process_start": self.process_start,
            }
            self._write(reservations)
        finally:
            lock.release()
        self.claimed_sources += source_bytes

    def release(self):
        if self.closed:
            return
        self.closed = True
        lock = _acquire_reservation_lock(self.lock_path)
        try:
            reservations = self._reap_stale(self._read())
            if self.key in reservations:
                del reservations[self.key]
                self._write(reservations)
        finally:
            lock.release()


def _write_partial_receipt(staging_root, version, dataset, schema, symbol, outcome):
    plan = Path(staging_root, version, "_plans", version + "-raw.json")
    raw_objects = []
    if plan.exists():
        raw_objects = [{"s3_key": o.get("s3_key"), "etag": o.get("etag"), "bytes": o.get("bytes")}
                       for o in json.loads(plan.read_text(encoding="utf-8")).get("objects", [])]
    receipt = {
        "version": version, "dataset": dataset, "schema": schema, "symbol": symbol,
        "status": "partial",
        "quarantined_dates": outcome.get("quarantined_dates", []),
        "skipped_dates": outcome.get("skipped_dates", []),
        "raw_objects": raw_objects,
        "recorded_at": _now_iso(),
        "operator_action_required": (
            "Review each quarantined date's evidence file, correct the source contract or data, "
            f"then re-run this symbol with retry_quarantined to reconvert them under {version}."
        ),
    }
    path = Path(staging_root, "_sequence", version + "-partial.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    checkpoint._atomic_write_json(str(path), receipt)
    return receipt


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


_TRANSIENT_ERROR_NAMES = frozenset({
    "EndpointConnectionError", "ConnectTimeoutError", "ReadTimeoutError",
    "ConnectionClosedError", "IncompleteReadError", "ConnectionError",
})


def is_retryable(error):
    """Default to non-retryable. botocore already retries transient S3 faults
    internally, so an error that reaches here is usually real, and an
    unclassified failure must stop for a person rather than loop."""
    if type(error).__name__ in _TRANSIENT_ERROR_NAMES:
        return True
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if isinstance(status, int) and status >= 500:
            return True
        if response.get("Error", {}).get("Code") in {"SlowDown", "RequestTimeout", "ThrottlingException"}:
            return True
    return False


def _run_one_symbol(dataset, schema, symbol, definition_symbol, dataset_version, *, client, bucket, curated_prefix,
                    staging_root, curated_root, catalog_root, min_free_bytes, job_kwargs):
    try:
        job_kwargs = dict(job_kwargs)
        window = job_kwargs.pop("phase_window", None)
        derived = schema == DERIVED_SCHEMA
        source_prefix = job_kwargs.get("source_prefix")
        source_catalog_root = job_kwargs.get("source_catalog_root") or catalog_root
        if derived:
            import derive_families
            stem = derive_families.version_stem(dataset_version, dataset, symbol)
            derived_plan = derive_families.plan_symbol(derive_families.snapshot_path(source_catalog_root), dataset, symbol)
            discover = lambda: [(f"{month}-01", month) for month in sorted(derived_plan["months"])]
        else:
            stem = f"{dataset_version}-{dataset.lower().replace('.', '-')}-{schema}-{symbol.lower()}"
            discover = lambda: _window_months(raw_source.discover_date_range(client, bucket, dataset, schema, symbol), window)
        plan = Path(staging_root, "_sequence", stem + ".json")
        binding = {"bucket": bucket, "prefix": curated_prefix, "dataset": dataset, "schema": schema, "symbol": symbol}
        if window is not None:
            binding["window"] = list(window)
        ranges = backfill_driver._inventory(plan, binding, discover)
        monthly = []
        partial = []
        for start_date, end_date in ranges:
            version = stem + "-" + start_date[:7]
            completed = Path(staging_root, "_sequence", version + "-complete.json")
            store = s3_publish.Store(client, bucket, curated_prefix)
            if completed.exists():
                saved = json.loads(completed.read_text(encoding="utf-8"))
                intent = saved["intent"]
                identity = hashlib.sha256(s3_publish._json(intent["pointer"])).hexdigest()
                receipt, _ = store.get_json(f"_catalog/receipts/{identity}.json")
                if receipt != intent:
                    raise SequenceError("REMOTE_COMPLETION_RECEIPT_MISMATCH")
                store.verify("_catalog/" + intent["pointer"]["catalog_key"], intent["pointer"]["catalog_sha256"], saved["catalog_bytes"])
                monthly.append(saved["outcome"])
                _clean_completed_month(staging_root, version, saved["outcome"], derived=derived)
                continue
            print(json.dumps({"event": "month_start", "version": version}), file=sys.stderr, flush=True)
            reservation = _CapacityReservation(staging_root)
            try:
                if derived:
                    outcome = derive_families.run_month(
                        derived_plan["months"][start_date[:7]], version, store=store,
                        source_store=s3_publish.Store(client, bucket, source_prefix) if source_prefix else None,
                        staging_root=str(Path(staging_root, version)), curated_root=curated_root,
                        catalog_root=catalog_root, min_free_bytes=min_free_bytes,
                        node_bin=job_kwargs.get("node_bin", "node"), worker_path=job_kwargs.get("worker_path"),
                        on_month_admission=reservation.admit,
                    )
                else:
                    dates = backfill_driver.inclusive_date_range(start_date, end_date)
                    outcome = backfill_driver.run_s3_backfill(
                        dataset, schema, symbol, dates, version,
                        bucket=bucket, curated_prefix=curated_prefix,
                        staging_root=str(Path(staging_root, version)), curated_root=curated_root, catalog_root=catalog_root,
                        min_free_bytes=min_free_bytes, definition_symbol=definition_symbol, client=client, **job_kwargs,
                        on_month_admission=reservation.admit,
                    )
            finally:
                reservation.release()
            if outcome.get("fully_published") is not True:
                if not outcome.get("quarantined_dates"):
                    raise SequenceError(f"INCOMPLETE_PUBLICATION:{dataset}:{schema}:{symbol}")
                receipt = _write_partial_receipt(staging_root, version, dataset, schema, symbol, outcome)
                partial.append(receipt)
                monthly.append(outcome)
                print(json.dumps({"event": "month_partial", "version": version,
                                  "quarantined_dates": [q["date"] for q in outcome["quarantined_dates"]]}),
                      file=sys.stderr, flush=True)
                continue
            local_intent = json.loads(Path(catalog_root, f"intent-{version}.json").read_text(encoding="utf-8"))
            intent = {"pointer": local_intent["pointer"], "parent": local_intent["parent"]}
            completed_payload = {"intent": intent, "outcome": outcome,
                "catalog_bytes": Path(catalog_root, intent["pointer"]["catalog_key"]).stat().st_size}
            partial_receipt = Path(staging_root, "_sequence", version + "-partial.json")
            if partial_receipt.exists():
                completed_payload["resolved_partial_receipt"] = {
                    "path": partial_receipt.name,
                    "sha256": hashlib.sha256(partial_receipt.read_bytes()).hexdigest(),
                }
            checkpoint._atomic_write_json(str(completed), completed_payload)
            monthly.append(outcome)
            _clean_completed_month(staging_root, version, outcome, derived=derived)
            print(json.dumps({"event": "month_complete", "version": version}), file=sys.stderr, flush=True)
        return {"dataset": dataset, "schema": schema, "symbol": symbol,
                "status": "partial" if partial else "ok", "months": monthly, "partial_months": partial}
    except Exception as error:
        retryable = is_retryable(error)
        print(json.dumps({"event": "symbol_failed", "dataset": dataset, "schema": schema, "symbol": symbol,
            "retryable": retryable, "error": f"{type(error).__name__}: {error}"}), file=sys.stderr, flush=True)
        return {
            "dataset": dataset, "schema": schema, "symbol": symbol, "status": "failed",
            "retryable": retryable, "error": f"{type(error).__name__}: {error}",
        }


def _run_one_symbol_worker_entry(index, result_queue, dataset, schema, symbol, definition_symbol, dataset_version, *,
                                 bucket, curated_prefix, staging_root, curated_root, catalog_root, min_free_bytes,
                                 job_kwargs, client_factory):
    try:
        result = _run_one_symbol(
            dataset, schema, symbol, definition_symbol, dataset_version, client=client_factory(),
            bucket=bucket, curated_prefix=curated_prefix, staging_root=staging_root, curated_root=curated_root,
            catalog_root=catalog_root, min_free_bytes=min_free_bytes, job_kwargs=job_kwargs,
        )
    except BaseException as error:
        result = {
            "dataset": dataset, "schema": schema, "symbol": symbol, "status": "failed",
            "error": f"{type(error).__name__}: {error}",
        }
    result_queue.put((index, result))


def _run_symbols_in_process_pool(symbols, dataset_version, *, bucket, curated_prefix, staging_root, curated_root,
                                 catalog_root, min_free_bytes, job_kwargs, client_factory, pool_size):
    result_queue = multiprocessing.Queue()
    pending = list(enumerate(symbols))
    running = {}
    results = [None] * len(symbols)
    try:
        while pending or running:
            while pending and len(running) < pool_size:
                index, (dataset, schema, symbol, definition_symbol) = pending.pop(0)
                proc = multiprocessing.Process(target=_run_one_symbol_worker_entry, args=(
                    index, result_queue, dataset, schema, symbol, definition_symbol, dataset_version,
                ), kwargs={
                    "bucket": bucket, "curated_prefix": curated_prefix, "staging_root": staging_root,
                    "curated_root": curated_root, "catalog_root": catalog_root, "min_free_bytes": min_free_bytes,
                    "job_kwargs": job_kwargs, "client_factory": client_factory,
                })
                proc.start()
                running[index] = proc
            try:
                index, result = result_queue.get(timeout=0.1)
            except queue.Empty:
                for exited_index, proc in list(running.items()):
                    if proc.is_alive():
                        continue
                    proc.join()
                    dataset, schema, symbol, _definition_symbol = symbols[exited_index]
                    results[exited_index] = {
                        "dataset": dataset, "schema": schema, "symbol": symbol, "status": "failed",
                        "error": f"WORKER_EXITED_WITHOUT_RESULT:{proc.exitcode}",
                    }
                    del running[exited_index]
                continue
            proc = running.pop(index)
            proc.join()
            if proc.exitcode != 0:
                dataset, schema, symbol, _definition_symbol = symbols[index]
                result = {
                    "dataset": dataset, "schema": schema, "symbol": symbol, "status": "failed",
                    "error": f"WORKER_EXITED_AFTER_RESULT:{proc.exitcode}",
                }
            results[index] = result
    finally:
        for proc in running.values():
            proc.terminate()
            proc.join()
    return results


def selection_key(phase, entry):
    symbols = [candidate[2] for candidate in PHASE_SYMBOLS[phase]]
    return entry[2] if symbols.count(entry[2]) == 1 else f"{entry[0]}:{entry[2]}"


def select_symbols(phase, requested=None):
    """The phase's symbols, optionally narrowed and reordered.

    A pass that ends with some symbols failed can only be resumed by running
    them again, and until now the set and its order were fixed in this module.
    The requested order is preserved, because the pool starts symbols in list
    order: pairing a heavy contract with a light one, and leaving another heavy
    one for last, is a scheduling decision the caller has to be able to make.
    """
    available = PHASE_SYMBOLS[phase]
    if requested is None:
        return list(available)
    by_symbol = {selection_key(phase, entry): entry for entry in available}
    chosen, seen = [], set()
    for name in requested:
        if name not in by_symbol:
            raise SequenceError(
                f"UNKNOWN_SYMBOL_FOR_PHASE:{phase}:{name}:expected_one_of={','.join(sorted(by_symbol))}")
        if name in seen:
            raise SequenceError(f"DUPLICATE_SYMBOL:{name}")
        seen.add(name)
        chosen.append(by_symbol[name])
    if not chosen:
        raise SequenceError("NO_SYMBOLS_SELECTED")
    return chosen


def validate_tardis_l1agg_sources(symbols, source_catalog_root):
    import derive_families
    import trade_families

    expected = list(backfill_driver.inclusive_date_range(*PHASE_WINDOWS["tardis-l1"]))
    expected_end = (datetime.date.fromisoformat(expected[-1]) + datetime.timedelta(days=1)).isoformat()
    if trade_families.CRYPTO_TRADE_WINDOW != (f"{expected[0]}T00:00:00.000Z", f"{expected_end}T00:00:00.000Z"):
        raise SequenceError("TARDIS_L1AGG_STUDY_WINDOW_MISMATCH")
    expected_months = {day[:7] for day in expected}
    snapshot = derive_families.snapshot_path(source_catalog_root)
    for dataset, _schema, symbol, _definition in symbols:
        plan = derive_families.plan_symbol(snapshot, dataset, symbol)
        months = plan["months"]
        if set(months) != expected_months:
            raise SequenceError(f"TARDIS_L1AGG_MONTH_COVERAGE_MISMATCH:{dataset}:{symbol}")
        actual = [entry["date"] for month in sorted(months) for entry in months[month]]
        if actual != expected:
            raise SequenceError(f"TARDIS_L1AGG_DAY_COVERAGE_MISMATCH:{dataset}:{symbol}")


def _run_phase(phase, dataset_version, *, bucket, curated_prefix, staging_root, curated_root, catalog_root,
              min_free_bytes, client, pool_size=1, client_factory=None, symbols=None, **job_kwargs):
    if phase not in PHASE_SYMBOLS:
        raise SequenceError(f"UNKNOWN_PHASE:{phase}")
    writer.validate_version(dataset_version)
    if not isinstance(pool_size, int) or isinstance(pool_size, bool) or pool_size < 1:
        raise SequenceError("INVALID_POOL_SIZE")
    symbols = select_symbols(phase, symbols)
    if phase == "tardis-l1agg":
        validate_tardis_l1agg_sources(symbols, job_kwargs.get("source_catalog_root") or catalog_root)
    if any(schema == DERIVED_SCHEMA for _dataset, schema, _symbol, _definition in symbols):
        job_kwargs.pop("allow_quarantine_skip", None)
        job_kwargs.pop("retry_quarantined", None)
    else:
        job_kwargs.pop("source_prefix", None)
        job_kwargs.pop("source_catalog_root", None)
        job_kwargs.setdefault("allow_quarantine_skip", phase in QUARANTINE_SKIP_PHASES)
        if phase in PHASE_WINDOWS:
            job_kwargs["phase_window"] = PHASE_WINDOWS[phase]

    if pool_size == 1:
        client = client or backfill_driver._build_s3_client()
        return [
            _run_one_symbol(dataset, schema, symbol, definition_symbol, dataset_version, client=client,
                            bucket=bucket, curated_prefix=curated_prefix, staging_root=staging_root,
                            curated_root=curated_root, catalog_root=catalog_root, min_free_bytes=min_free_bytes,
                            job_kwargs=job_kwargs)
            for dataset, schema, symbol, definition_symbol in symbols
        ]

    if client is not None:
        raise SequenceError("POOLED_EXECUTION_BUILDS_ITS_OWN_CLIENT_PER_WORKER")
    client_factory = client_factory or backfill_driver._build_s3_client
    return _run_symbols_in_process_pool(
        symbols, dataset_version, bucket=bucket, curated_prefix=curated_prefix, staging_root=staging_root,
        curated_root=curated_root, catalog_root=catalog_root, min_free_bytes=min_free_bytes,
        job_kwargs=job_kwargs, client_factory=client_factory, pool_size=pool_size,
    )
