from __future__ import annotations
import argparse
import csv
import datetime as dt
from decimal import Decimal, localcontext
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid

import databento_dbn as dbn
import duckdb
import psutil

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
METHOD = "local-conversion-prototype/1"
BATCH = 256
MAX_INPUT = 64 * 1024**2
MAX_SCRATCH = 512 * 1024**2


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def write_json(path, value):
    with Path(path).open("xb") as f:
        f.write(json.dumps(value, indent=2).encode() + b"\n")
        f.flush()
        os.fsync(f.fileno())


def source_version():
    paths = [HERE / "convert.py", HERE / "map-batch.cjs", HERE / "uv.lock"]
    paths += sorted((REPO / "apps/runtime/src/data-contracts/v1").glob("*.js"))
    return hashlib.sha256(json_bytes({p.relative_to(REPO).as_posix(): digest(p) for p in paths})).hexdigest()


def day_ns(value):
    day = dt.date.fromisoformat(str(value))
    return str((day - dt.date(1970, 1, 1)).days * 86400 * 10**9)


def dbn_rows(path, metadata):
    decoder = dbn.DBNDecoder(compression=dbn.Compression.ZSTD if path.suffix == ".zst" else dbn.Compression.NONE,
                             upgrade_policy=dbn.VersionUpgradePolicy.AS_IS)
    with path.open("rb") as f:
        while chunk := f.read(16384):
            records = decoder.write_and_decode(chunk)
            if len(decoder.buffer()) > 4 * 1024**2:
                raise ValueError("DBN_METADATA_BUFFER_LIMIT")
            for r in records:
                if isinstance(r, dbn.Metadata):
                    metadata.update(version=r.version, dataset=r.dataset, schema=str(r.schema),
                                    stype_in=str(r.stype_in), stype_out=str(r.stype_out),
                                    mappings=r.mappings, symbols=r.symbols)
                    continue
                if not isinstance(r, (dbn.MBP1Msg, dbn.MBP10Msg)):
                    raise ValueError("UNSUPPORTED_DBN_RECORD")
                row = {k: str(getattr(r, k)) for k in ("instrument_id", "publisher_id", "ts_event", "ts_recv", "price", "size", "action", "side", "flags", "sequence")}
                for i, level in enumerate(r.levels):
                    for key in ("bid_px", "ask_px", "bid_sz", "ask_sz"):
                        row[f"{key}_{i:02}"] = str(getattr(level, key))
                yield row
    if decoder.buffer():
        raise ValueError("TRUNCATED_DBN")


def csv_rows(path):
    opener = gzip.open if path.suffix == ".gz" else open
    csv.field_size_limit(65536)
    with opener(path, "rt", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, strict=True)
        if not reader.fieldnames or len(reader.fieldnames) != len(set(reader.fieldnames)):
            raise ValueError("INVALID_CSV_HEADER")
        required = {"exchange", "symbol", "timestamp", "local_timestamp", "id", "side", "price", "amount"}
        if not required.issubset(reader.fieldnames):
            raise ValueError("MISSING_TRADE_COLUMNS")
        for row in reader:
            if None in row or any(v is None for v in row.values()):
                raise ValueError("RAGGED_CSV")
            yield row


def mappings_for(kind, row, metadata, sha):
    if kind == "tardis-trades":
        if row["exchange"] != "binance" or row["symbol"] != "BTCUSDT":
            raise ValueError("PROTOTYPE_SCOPE_MISMATCH")
        return [{"provider": "TARDIS", "dataset": "binance", "sourceSymbol": "BTCUSDT", "fromNs": "0", "toNs": "18446744073709551614",
                 "instrument": {"venue": "BINANCE", "market": "SPOT", "symbol": "BTCUSDT", "currency": "USDT", "sizeUnit": "BASE", "contract": None},
                 "mappingVersion": "btc-spot/1", "reference": "config/market-instruments.json"}]
    if metadata.get("stype_in") != "raw_symbol" or metadata.get("stype_out") != "instrument_id":
        raise ValueError("ACTUAL_SYMBOL_MAPPING_REQUIRED")
    mappings = []
    for symbol, intervals in metadata["mappings"].items():
        if metadata["dataset"] == "XNAS.ITCH" and symbol == "AAPL":
            instrument = {"venue": "XNAS", "market": "EQUITY", "symbol": symbol, "currency": "USD", "sizeUnit": "SHARE", "contract": None}
        elif metadata["dataset"] == "GLBX.MDP3" and symbol == "ESH1":
            instrument = {"venue": "XCME", "market": "FUTURE", "symbol": symbol, "currency": "USD", "sizeUnit": "CONTRACT", "contract": symbol}
        else:
            raise ValueError("UNSUPPORTED_ACTUAL_SYMBOL")
        for interval in intervals:
            mappings.append({"provider": "DATABENTO", "dataset": metadata["dataset"], "sourceSymbol": str(interval["symbol"]),
                             "fromNs": day_ns(interval["start_date"]), "toNs": day_ns(interval["end_date"]), "instrument": instrument,
                             "mappingVersion": "dbn-metadata/1", "reference": f"sha256:{sha}:metadata"})
    return mappings


def connect():
    return duckdb.connect(config={"memory_limit": "128MB", "threads": "1", "max_temp_directory_size": "128MB"})


def verify_commit(directory):
    m = json.loads((directory / "manifest.json").read_text())
    if m["status"] != "COMMITTED_CANDIDATE":
        raise ValueError("UNCOMMITTED")
    for item in m["outputs"]:
        name = item["name"]
        if Path(name).name != name or digest(directory / name) != item["sha256"]:
            raise ValueError("OUTPUT_HASH_MISMATCH")
    return m


def convert(source, output, kind, max_rows=10000, fail_after_batch=None):
    started = time.perf_counter()
    source, output = Path(source).resolve(), Path(output).resolve()
    if kind not in ("tardis-trades", "databento-mbp") or not 1 <= max_rows <= 100000:
        raise ValueError("INVALID_PROTOTYPE_LIMIT")
    if not source.is_file() or not 0 < source.stat().st_size <= MAX_INPUT:
        raise ValueError("INPUT_BYTE_LIMIT")
    if output == source or source.is_relative_to(output):
        raise ValueError("OUTPUT_MUST_NOT_CONTAIN_SOURCE")
    node = shutil.which("node")
    if not node:
        raise ValueError("NODE_REQUIRED")
    raw_hash = digest(source)
    identity = {"method": METHOD, "codeHash": source_version(), "rawHash": raw_hash, "kind": kind, "maxRows": max_rows}
    job_id = hashlib.sha256(json_bytes(identity)).hexdigest()
    output.mkdir(parents=True, exist_ok=True)
    destination = output / job_id
    if destination.exists():
        m = verify_commit(destination)
        if m["identity"] != identity:
            raise ValueError("COMMIT_IDENTITY_MISMATCH")
        return {"reused": True, "directory": str(destination), "manifest": m}
    stage = output / (".stage-" + uuid.uuid4().hex)
    stage.mkdir()
    metadata = {}
    iterator = csv_rows(source) if kind == "tardis-trades" else dbn_rows(source, metadata)
    raw_count = accepted = rejected = batch_count = 0
    minimum = maximum = None
    logical_hash = hashlib.sha256()
    family_counts = {}
    reasons = {}
    sampled_rss = psutil.Process().memory_info().rss
    bridge_seconds = 0.0
    raw_volume = Decimal(0)
    canonical_volume = Decimal(0)
    staged_bytes = 0
    truncated = False
    stream_name = "sha256:" + raw_hash
    mappings = None
    try:
        with (stage / "records.ndjson").open("xb") as records_file, (stage / "rejected.ndjson").open("xb") as rejects_file:
            while raw_count < max_rows:
                rows = []
                for _ in range(min(BATCH, max_rows - raw_count)):
                    try:
                        row = next(iterator)
                    except StopIteration:
                        break
                    rows.append({"row": row, "position": raw_count})
                    raw_count += 1
                    if kind == "tardis-trades":
                        with localcontext() as dc:
                            dc.prec = 80
                            raw_volume += Decimal(row["amount"])
                if not rows:
                    break
                if mappings is None:
                    mappings = mappings_for(kind, rows[0]["row"], metadata, raw_hash)
                provider = "TARDIS" if kind == "tardis-trades" else "DATABENTO"
                schema = "trades" if kind == "tardis-trades" else metadata["schema"]
                if provider == "DATABENTO" and schema not in ("mbp-1", "mbp-10", "tbbo"):
                    raise ValueError("UNSUPPORTED_DBN_SCHEMA")
                ids = {r["row"]["symbol" if provider == "TARDIS" else "instrument_id"] for r in rows}
                if len(ids) != 1:
                    raise ValueError("MULTI_IDENTITY_BATCH_REQUIRES_PARTITIONER")
                request = {"provider": provider, "family": "trade" if provider == "TARDIS" else "depth" if schema == "mbp-10" else "mbp",
                           "mappings": mappings, "rows": rows,
                           "context": {"dataset": "binance" if provider == "TARDIS" else metadata["dataset"], "schema": schema,
                                       "sourceSymbol": next(iter(ids)), "population": "binance-spot-trades" if provider == "TARDIS" else metadata["dataset"] + ":" + schema,
                                       "datasetVersion": "raw-" + raw_hash, "streamId": stream_name,
                                       "ingestNs": "0",
                                       "lineage": {"object": stream_name, "sha256": raw_hash, "row": "0"}}}
                before = time.perf_counter()
                result = subprocess.run([node, str(HERE / "map-batch.cjs")], input=json_bytes(request), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True,
                                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                bridge_seconds += time.perf_counter() - before
                payload = json.loads(result.stdout)
                if len(payload) != len(rows):
                    raise ValueError("MAPPER_COUNT_MISMATCH")
                for mapped in payload:
                    if not mapped["ok"]:
                        rejected += 1
                        reason = mapped["quarantine"]["reason"]
                        reasons[reason] = reasons.get(reason, 0) + 1
                        line = json_bytes(mapped["quarantine"]) + b"\n"
                        rejects_file.write(line)
                        staged_bytes += len(line)
                        continue
                    accepted += 1
                    for record in mapped["records"]:
                        event = int(record["time"]["eventNs"])
                        minimum = event if minimum is None else min(minimum, event)
                        maximum = event if maximum is None else max(maximum, event)
                        family = record["family"]
                        if kind == "tardis-trades":
                            with localcontext() as dc:
                                dc.prec = 80
                                size = record["data"]["size"]
                                canonical_volume += Decimal(size["coefficient"]) * Decimal(10) ** -size["scale"]
                        family_counts[family] = family_counts.get(family, 0) + 1
                        line = json_bytes(record) + b"\n"
                        logical_hash.update(line)
                        flat = {"id": record["id"], "family": family, "instrument_id": record["instrument"]["id"], "event_ns": str(event),
                                "capture_position": record["order"]["position"], "payload": json.dumps(record, sort_keys=True, separators=(",", ":"))}
                        line = json_bytes(flat) + b"\n"
                        staged_bytes += len(line)
                        if staged_bytes > MAX_SCRATCH:
                            raise ValueError("STAGED_BYTE_LIMIT")
                        records_file.write(line)
                batch_count += 1
                sampled_rss = max(sampled_rss, psutil.Process().memory_info().rss)
                if fail_after_batch == batch_count:
                    raise RuntimeError("INJECTED_INTERRUPTION")
                if time.perf_counter() - started > 300:
                    raise ValueError("CONVERSION_DEADLINE")
            if raw_count == max_rows:
                try:
                    next(iterator)
                    truncated = True
                except StopIteration:
                    pass
            for f in (records_file, rejects_file):
                f.flush()
                os.fsync(f.fileno())
        iterator.close()
        if digest(source) != raw_hash:
            raise ValueError("SOURCE_CHANGED")
        if rejected or not family_counts:
            raise ValueError("QUARANTINED_ROWS_BLOCK_COMMIT" if rejected else "NO_OUTPUT_RECORDS")
        if kind == "tardis-trades" and raw_volume != canonical_volume:
            raise ValueError("TRADE_VOLUME_MISMATCH")
        db = connect()
        try:
            db.execute("SET temp_directory = ?", [str(stage / "spill")])
            db.execute("CREATE TABLE records AS SELECT id, family, instrument_id, CAST(event_ns AS UBIGINT) event_ns, CAST(capture_position AS UBIGINT) capture_position, payload FROM read_json(?, format='newline_delimited', columns={id:'VARCHAR',family:'VARCHAR',instrument_id:'VARCHAR',event_ns:'VARCHAR',capture_position:'VARCHAR',payload:'VARCHAR'})", [str(stage / "records.ndjson")])
            count, distinct = db.execute("SELECT count(*), count(DISTINCT id) FROM records").fetchone()
            if count != sum(family_counts.values()) or distinct != count:
                raise ValueError("OUTPUT_COUNT_OR_ID_MISMATCH")
            db.execute("COPY (SELECT * FROM records ORDER BY instrument_id, family, event_ns, capture_position, id) TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 2048)", [str(stage / "observations.parquet")])
            rows = db.execute("SELECT payload FROM read_parquet(?) ORDER BY capture_position, family", [str(stage / "observations.parquet")])
            reread = 0
            for chunk in iter(lambda: rows.fetchmany(BATCH), []):
                for (payload,) in chunk:
                    parsed = json.loads(payload)
                    if not isinstance(parsed["time"]["eventNs"], str):
                        raise ValueError("TIME_PRECISION_LOST")
                    reread += 1
            if reread != count:
                raise ValueError("PARQUET_ROUNDTRIP_COUNT")
            mismatch = db.execute("SELECT count(*) FROM records a FULL JOIN read_parquet(?) b USING(id) WHERE a.id IS NULL OR b.id IS NULL OR a.payload != b.payload OR a.event_ns != b.event_ns", [str(stage / "observations.parquet")]).fetchone()[0]
            if mismatch:
                raise ValueError("PARQUET_ROUNDTRIP_MISMATCH")
        finally:
            db.close()
        sampled_rss = max(sampled_rss, psutil.Process().memory_info().rss)
        outputs = [{"name": name, "bytes": (stage / name).stat().st_size, "sha256": digest(stage / name)} for name in ("observations.parquet", "records.ndjson", "rejected.ndjson")]
        manifest = {"status": "COMMITTED_CANDIDATE", "quality": "UNVERIFIED", "identity": identity, "scope": "PREFIX_SAMPLE" if truncated else "COMPLETE_INPUT",
                    "source": {"path": str(source), "bytes": source.stat().st_size, "sha256": raw_hash}, "rawRows": raw_count, "acceptedRows": accepted, "rejectedRows": rejected,
                    "familyCounts": family_counts, "minimumEventNs": str(minimum), "maximumEventNs": str(maximum), "logicalSha256": logical_hash.hexdigest(), "outputs": outputs,
                    "seconds": time.perf_counter() - started, "mapperSeconds": bridge_seconds, "sampledParentRssBytes": sampled_rss,
                    "stagedJsonBytes": staged_bytes, "batches": batch_count,
                    "volumeCheck": {"raw": str(raw_volume), "canonical": str(canonical_volume), "equal": raw_volume == canonical_volume} if kind == "tardis-trades" else None,
                    "versions": {k: importlib.metadata.version(k) for k in ("databento-dbn", "duckdb", "psutil", "zstandard")},
                    "limits": {"maxInputBytes": MAX_INPUT, "maxRows": max_rows, "batchRows": BATCH, "maxStagedJsonBytes": MAX_SCRATCH, "duckdbBufferMemory": "128MB", "duckdbSpill": "128MB"},
                    "limitations": ["not published to production", "not book continuity certification", "ingestNs=0 is an explicit prototype unknown marker", "RSS samples do not establish whole-process peak", "DuckDB memory limit is not an OS RSS cap"],
                    "metadata": json.loads(json.dumps(metadata, default=str))}
        write_json(stage / "manifest.json", manifest)
        try:
            stage.rename(destination)
        except FileExistsError:
            existing = verify_commit(destination)
            if existing["logicalSha256"] != manifest["logicalSha256"]:
                raise ValueError("CONCURRENT_COMMIT_CONFLICT")
        return {"reused": False, "directory": str(destination), "manifest": manifest}
    except Exception as error:
        iterator.close()
        write_json(stage / "failure.json", {"status": "FAILED_UNPUBLISHED", "reason": type(error).__name__ + ":" + str(error)[:200], "rawRows": raw_count, "rejectedRows": rejected, "reasons": reasons})
        raise


def query(directory, family, start_ns, end_ns, limit=100):
    directory = Path(directory).resolve()
    verify_commit(directory)
    if not 1 <= limit <= 1000 or not 0 <= int(start_ns) < int(end_ns) < 2**64:
        raise ValueError("INVALID_QUERY_BOUND")
    with connect() as db:
        begin = time.perf_counter()
        rows = db.execute("SELECT payload FROM read_parquet(?) WHERE family=? AND event_ns>=CAST(? AS UBIGINT) AND event_ns<CAST(? AS UBIGINT) ORDER BY event_ns, capture_position, id LIMIT ?", [str(directory / "observations.parquet"), family, str(start_ns), str(end_ns), limit]).fetchall()
        return {"querySeconds": time.perf_counter()-begin, "rows": [json.loads(r[0]) for r in rows]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--kind", required=True, choices=["tardis-trades", "databento-mbp"])
    parser.add_argument("--max-rows", type=int, default=10000)
    args = parser.parse_args()
    result = convert(args.source, args.output, args.kind, args.max_rows)
    print(json.dumps(result, indent=2))
