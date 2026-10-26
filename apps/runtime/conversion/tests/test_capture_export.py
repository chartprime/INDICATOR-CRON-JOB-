from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import threading
from pathlib import Path

import pytest
import zstandard

import capture_export
from shared_fake_s3 import SharedFakeClient

RUNTIME = Path(__file__).parents[2]
DAY_MS = 86_400_000
T0 = 1_791_072_000_000
BUCKET = "chartprime-historical-data"

DX_COMMON = "event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state"
DX_VALUES = "?, ?, 'DXFEED', NULL, 'FUTURE', '/ESZ26', 0, 'READY'"


def create_databases(data_root):
    node = shutil.which("node")
    assert node is not None, "Node is required to build the collectors' real schemas"
    live = data_root / "live"
    live.mkdir(parents=True)
    script = (
        "const {createStorageDb}=require('./src/storage/storage-db');"
        "const {createDxFeedStorageDb}=require('./src/storage/dxfeed/dxfeed-storage-db');"
        "createStorageDb({dbPath:process.argv[1]}).close();createDxFeedStorageDb({dbPath:process.argv[2]}).close();"
    )
    subprocess.check_call([node, "-e", script, str(live / "market-data.sqlite"), str(live / "dxfeed-market-data.sqlite")],
                          cwd=RUNTIME, timeout=60)
    return live / "market-data.sqlite", live / "dxfeed-market-data.sqlite"


def seed_trades(path, rows):
    db = sqlite3.connect(path)
    db.executemany("INSERT INTO trades (id, ts, symbol, market_kind, price, size, side, trade_id) "
                   "VALUES (?, ?, 'BTCUSDT', 'SPOT', '100', '1', 'buy', ?)", [(i, ts, f"t{i}") for i, ts in rows])
    db.commit()
    db.close()


def seed_order_book(path, rows):
    db = sqlite3.connect(path)
    db.executemany(f"INSERT INTO dxfeed_order_book_capture (id, {DX_COMMON}, order_index, event_flags, time, action, price, "
                   f"size, side, scope, source) VALUES (?, {DX_VALUES}, '1', 0, ?, 'NEW', 5000, 1, 'BUY', 'ORDER', 'NTV')",
                   [(i, event, received, event) for i, event, received in rows])
    db.commit()
    db.close()


@pytest.fixture
def small_grid(monkeypatch):
    targets = {
        name: {"db": spec["db"], "tables": tuple((table, column, 10) for table, column, _ in spec["tables"])}
        for name, spec in capture_export.TARGETS.items()
    }
    monkeypatch.setattr(capture_export, "TARGETS", targets)
    return targets


@pytest.fixture
def capture(tmp_path, small_grid):
    binance, dxfeed = create_databases(tmp_path / "capture")
    return {"root": tmp_path / "capture", "binance": binance, "dxfeed": dxfeed, "tmp": tmp_path}


def fake_store():
    client = SharedFakeClient({}, {}, threading.Lock())
    return capture_export.CaptureStore(client, BUCKET), client


def args_for(capture, **overrides):
    values = ["--bucket", BUCKET, "--region", "eu-central-1", "--data-root", str(capture["root"]),
              "--watermark", str(capture["tmp"] / "state" / "watermark.json"),
              "--staging-dir", str(capture["tmp"] / "staging"), "--max-seconds", "600",
              "--credentials", str(capture["tmp"] / "s3")]
    for key, value in overrides.items():
        values += [f"--{key.replace('_', '-')}", str(value)]
    return capture_export.parse_args(values)


def slice_rows(blob, table):
    raw = zstandard.ZstdDecompressor().decompress(blob)
    db = sqlite3.connect(":memory:")
    db.deserialize(raw)
    return db.execute(f"SELECT id, * FROM {table} ORDER BY id").fetchall()


def test_ranges_finish_the_grid_and_seal_the_snapshot_tail():
    assert capture_export.next_chunk(10, None, 1, 25) == (1, 10)
    assert capture_export.next_chunk(10, 10, 1, 25) == (11, 20)
    assert capture_export.next_chunk(10, 20, 1, 25) == (21, 25)
    assert capture_export.next_chunk(10, None, 14, 25) == (14, 20)
    assert capture_export.next_chunk(10, None, None, None) is None
    assert capture_export.next_chunk(10, 15, 1, 40) == (16, 20)
    assert capture_export.next_chunk(10, 25, 1, 25) is None


def test_full_chunks_are_exported_exactly_and_the_watermark_advances(capture):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 26)])
    store, client = fake_store()
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    watermark = json.loads((capture["tmp"] / "state" / "watermark.json").read_text())
    assert watermark["targets"]["binance"]["trades"] == {"exportedThroughId": 25, "chunkRows": 10}
    keys = sorted(client.objects)
    assert keys == [
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000001-000000000010.json",
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000001-000000000010.sqlite.zst",
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000011-000000000020.json",
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000011-000000000020.sqlite.zst",
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000021-000000000025.json",
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000021-000000000025.sqlite.zst",
    ]
    source = sqlite3.connect(capture["binance"])
    expected = source.execute("SELECT id, * FROM trades ORDER BY id").fetchall()
    exported = [row for key in keys if key.endswith(".zst") for row in slice_rows(client.objects[key], "trades")]
    assert exported == expected
    manifest = json.loads(client.objects[keys[0]])
    assert manifest["rows"] == 10 and manifest["firstId"] == 1 and manifest["lastId"] == 10
    assert manifest["timeMin"] == T0 + 1 and manifest["timeMax"] == T0 + 10 and manifest["timeColumn"] == "ts"
    assert manifest["schemaSql"].startswith("CREATE TABLE trades")
    assert not any((capture["tmp"] / "staging").iterdir())


def test_losing_the_checkpoint_with_existing_exports_requires_recovery(capture):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 21)])
    store, client = fake_store()
    capture_export.run(args_for(capture, target="binance"), store)
    first = dict(client.objects)
    (capture["tmp"] / "state" / "watermark.json").unlink()
    assert capture_export.run(args_for(capture, target="binance"), store) == 1
    assert client.objects == first


def test_a_crash_between_the_slice_and_its_manifest_is_finished_by_the_next_run(capture):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 11)])
    store, client = fake_store()
    original_put = client.put_object

    def put_without_manifest(**args):
        if args["Key"].endswith(".json"):
            raise RuntimeError("connection reset")
        original_put(**args)

    client.put_object = put_without_manifest
    assert capture_export.run(args_for(capture, target="binance"), store) == 1
    assert json.loads((capture["tmp"] / "state" / "watermark.json").read_text())["targets"]["binance"]["trades"]["exportedThroughId"] is None
    assert [key.endswith(".zst") for key in client.objects] == [True]
    client.put_object = original_put
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    assert sorted(key.rsplit(".", 1)[-1] for key in client.objects) == ["json", "zst"]
    watermark = json.loads((capture["tmp"] / "state" / "watermark.json").read_text())
    assert watermark["targets"]["binance"]["trades"]["exportedThroughId"] == 10


def test_a_remote_object_with_other_content_fails_the_run_and_holds_the_watermark(capture, capsys, monkeypatch):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 11)])
    store, client = fake_store()
    with monkeypatch.context() as context:
        def fail_before_upload(*_args):
            raise RuntimeError("crash after sealing")
        context.setattr(store, "upload_once", fail_before_upload)
        assert capture_export.run(args_for(capture, target="binance"), store) == 1
    key = "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000001-000000000010.sqlite.zst"
    client.objects[key] = b"something else"
    client.last_modified[key] = None
    assert capture_export.run(args_for(capture, target="binance"), store) == 1
    assert client.objects[key] == b"something else"
    assert "already exists with different content" in capsys.readouterr().out
    watermark_path = capture["tmp"] / "state" / "watermark.json"
    assert json.loads(watermark_path.read_text())["targets"]["binance"]["trades"]["exportedThroughId"] is None


def test_an_object_that_reads_back_differently_is_not_counted(capture):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 11)])
    store, client = fake_store()
    original_put = client.put_object

    def corrupting_put(**args):
        body = args["Body"]
        data = body.read() if hasattr(body, "read") else body
        original_put(**{**args, "Body": data[:-1]})

    client.put_object = corrupting_put
    assert capture_export.run(args_for(capture, target="binance"), store) == 1
    assert json.loads((capture["tmp"] / "state" / "watermark.json").read_text())["targets"]["binance"]["trades"]["exportedThroughId"] is None


def test_keys_outside_the_live_capture_prefix_are_refused():
    store, client = fake_store()
    for key in ("raw/binance/x", "curated/x", "raw/live-capture/../binance/x", "raw/live-capture//x"):
        with pytest.raises(capture_export.ExportError, match="refusing key"):
            store.write_once(key, b"x")
    assert client.objects == {}


def test_order_book_rows_are_exported_once_by_id_whatever_their_native_times(capture):
    rows = [(i, T0 - 30 * DAY_MS if i % 3 == 0 else T0 + i, T0 + i) for i in range(1, 21)]
    seed_order_book(capture["dxfeed"], rows)
    store, client = fake_store()
    assert capture_export.run(args_for(capture, target="dxfeed"), store) == 0
    data = sorted(key for key in client.objects if "order_book" in key and key.endswith(".zst"))
    assert [key.split("/")[4] for key in data] == ["date=2026-10-04", "date=2026-10-04"]
    exported = [row[0] for key in data for row in slice_rows(client.objects[key], "dxfeed_order_book_capture")]
    assert exported == list(range(1, 21))


def test_an_empty_chunk_advances_the_watermark_without_an_object(capture):
    seed_trades(capture["binance"], [(5, T0), (25, T0 + 1), (31, T0 + 2)])
    store, client = fake_store()
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    watermark = json.loads((capture["tmp"] / "state" / "watermark.json").read_text())
    assert watermark["targets"]["binance"]["trades"]["exportedThroughId"] == 31
    assert sorted(key for key in client.objects if key.endswith(".zst")) == [
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000005-000000000010.sqlite.zst",
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000021-000000000030.sqlite.zst",
        "raw/live-capture/binance/trades/date=2026-10-04/ids-000000000031-000000000031.sqlite.zst",
    ]


def test_the_deadline_stops_before_the_next_chunk(capture, monkeypatch, capsys):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 31)])
    store, client = fake_store()
    clock = [0.0]
    original = capture_export.export_chunk

    def slow_chunk(*args):
        clock[0] += 300
        return original(*args)

    monkeypatch.setattr(capture_export, "export_chunk", slow_chunk)
    assert capture_export.run(args_for(capture, target="binance", max_seconds=600), store, now=lambda: clock[0]) == 0
    watermark = json.loads((capture["tmp"] / "state" / "watermark.json").read_text())
    assert watermark["targets"]["binance"]["trades"]["exportedThroughId"] == 10
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert summary["done"] is False and summary["tables"][0] == {
        "table": "trades", "chunks": 1, "rows": 10, "done": False, "exportedThroughId": 10,
    }


def test_a_malformed_watermark_fails_and_a_missing_one_starts_empty(tmp_path):
    path = tmp_path / "watermark.json"
    assert capture_export.load_watermark(path) == {"version": 2, "targets": {}, "sources": {}}
    path.write_text(json.dumps({"version": 3, "targets": {}}))
    with pytest.raises(capture_export.ExportError, match="not a version 2 watermark"):
        capture_export.load_watermark(path)


def test_a_missing_capture_database_fails_the_target(tmp_path, small_grid):
    store, _ = fake_store()
    args = capture_export.parse_args(["--bucket", BUCKET, "--region", "r", "--data-root", str(tmp_path / "none"),
                                      "--watermark", str(tmp_path / "w.json"), "--staging-dir", str(tmp_path / "s"),
                                      "--credentials", str(tmp_path / "c")])
    assert capture_export.run(args, store) == 1
    assert not (tmp_path / "none").exists()


def test_bad_options_exit_as_a_configuration_error():
    assert capture_export.main(["--region", "r"]) == capture_export.CONFIG_EXIT
    assert capture_export.main(["--bucket", "b", "--region", "r", "--staging-dir", "s", "--credentials", "c",
                                "--max-seconds", "0"]) == 2
    assert capture_export.main(["--bucket", "b", "--region", "r", "--staging-dir", "s"]) == capture_export.CONFIG_EXIT


def test_credentials_need_both_keys(tmp_path):
    path = tmp_path / "s3"
    path.write_text("AWS_ACCESS_KEY_ID=a\n")
    with pytest.raises(capture_export.ExportError, match="AWS_SECRET_ACCESS_KEY"):
        capture_export.read_credentials(path)
    path.write_text("AWS_ACCESS_KEY_ID=a\nAWS_SECRET_ACCESS_KEY=b=c\n")
    assert capture_export.read_credentials(path) == ("a", "b=c")


def test_a_quiet_table_exports_its_tail_without_waiting_for_another_full_grid(capture):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 16)])
    store, client = fake_store()
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    state = json.loads((capture["tmp"] / "state" / "watermark.json").read_text())
    assert state["targets"]["binance"]["trades"]["exportedThroughId"] == 15
    assert [row[0] for key in sorted(client.objects) if key.endswith(".zst") for row in slice_rows(client.objects[key], "trades")] == list(range(1, 16))


def test_a_sealed_tail_keeps_its_range_across_a_crash_and_new_arrivals(capture):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 6)])
    store, client = fake_store()
    original_put = client.put_object

    def no_manifest(**args):
        if args["Key"].endswith(".json"):
            raise RuntimeError("crash before manifest")
        return original_put(**args)

    client.put_object = no_manifest
    assert capture_export.run(args_for(capture, target="binance"), store) == 1
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(6, 10)])
    client.put_object = original_put
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    manifests = [json.loads(blob) for key, blob in client.objects.items() if key.endswith(".json")]
    assert sorted((m["chunkFrom"], m["chunkTo"]) for m in manifests) == [(1, 5), (6, 9)]
    assert sorted(row[0] for key, blob in client.objects.items() if key.endswith(".zst") for row in slice_rows(blob, "trades")) == list(range(1, 10))


def test_overlapping_exporters_are_rejected_before_touching_shared_staging(capture, monkeypatch):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 11)])
    store, _ = fake_store()
    args = args_for(capture, target="binance")
    original = capture_export.export_chunk
    nested = []

    def overlapping(*positional):
        if not nested:
            nested.append(None)
            nested[0] = capture_export.run(args, store)
        return original(*positional)

    monkeypatch.setattr(capture_export, "export_chunk", overlapping)
    assert capture_export.run(args, store) == 0
    assert nested == [1]


def test_a_replacement_database_cannot_reuse_an_old_export_watermark(capture):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 11)])
    store, client = fake_store()
    args = args_for(capture, target="binance")
    assert capture_export.run(args, store) == 0
    first = dict(client.objects)
    old = capture["binance"].with_suffix(".old")
    capture["binance"].rename(old)
    replacement = capture["tmp"] / "replacement"
    binance, _ = create_databases(replacement)
    shutil.copyfile(binance, capture["binance"])
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 11)])
    assert capture_export.run(args, store) == 1
    assert client.objects == first


def test_a_new_capture_session_generation_cannot_reuse_the_same_file_checkpoint(capture):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 11)])
    with sqlite3.connect(capture["binance"]) as db:
        db.execute("INSERT INTO capture_sessions (session_id, started_at, quality, clean_shutdown) VALUES ('first', 1, 'HEALTHY', 1)")
    store, client = fake_store()
    args = args_for(capture, target="binance")
    assert capture_export.run(args, store) == 0
    before = dict(client.objects)
    with sqlite3.connect(capture["binance"]) as db:
        db.execute("UPDATE capture_sessions SET session_id = 'reinitialized'")
    assert capture_export.run(args, store) == 1
    assert client.objects == before


def test_export_and_retention_use_the_same_source_bound_watermark(capture):
    seed_order_book(capture["dxfeed"], [(i, T0, T0) for i in range(1, 16)])
    store, client = fake_store()
    args = args_for(capture, target="dxfeed")
    assert capture_export.run(args, store) == 0
    script = (
        "const {main}=require('./scripts/maintain/prune-capture-retention');"
        "const logger={error:console.error,ok:()=>{},info:()=>{},warn:()=>{}};"
        "main({argv:['--target','dxfeed','--dxfeed-db',process.argv[1],'--export-watermark',process.argv[2]],"
        "logger,now:()=>Date.UTC(2027,0,1),exit:()=>{}}).then(code=>{process.exitCode=code;});"
    )
    result = subprocess.run([shutil.which("node"), "-e", script, str(capture["dxfeed"]), args.watermark], cwd=RUNTIME, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(capture["dxfeed"]) as db:
        assert db.execute("SELECT count(*) FROM dxfeed_order_book_capture").fetchone()[0] == 0
    assert sorted(row[0] for key, blob in client.objects.items() if key.endswith(".zst") for row in slice_rows(blob, "dxfeed_order_book_capture")) == list(range(1, 16))


def test_a_pass_does_not_chase_rows_committed_after_its_snapshot(capture, monkeypatch):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 6)])
    store, client = fake_store()
    original = store.upload_once
    added = []

    def append_after_sealing(key, path, sha256):
        if not added:
            added.append(True)
            seed_trades(capture["binance"], [(i, T0 + i) for i in range(6, 10)])
        return original(key, path, sha256)

    monkeypatch.setattr(store, "upload_once", append_after_sealing)
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    state = json.loads((capture["tmp"] / "state" / "watermark.json").read_text())
    assert state["targets"]["binance"]["trades"]["exportedThroughId"] == 5
    assert [row[0] for key, blob in client.objects.items() if key.endswith(".zst") for row in slice_rows(blob, "trades")] == list(range(1, 6))


def test_a_live_writer_can_commit_while_a_slice_read_transaction_is_open(capture, monkeypatch):
    seed_trades(capture["binance"], [(i, T0 + i) for i in range(1, 16)])
    original_source = capture_export._source
    inserted = []

    class Source:
        def __init__(self, path):
            self.connection = original_source(path)

        def execute(self, sql, *args):
            cursor = self.connection.execute(sql, *args)
            if not sql.startswith("SELECT * FROM"):
                return cursor

            class Reader:
                def fetchmany(self, count):
                    batch = cursor.fetchmany(count)
                    if batch and not inserted:
                        with sqlite3.connect(capture["binance"], timeout=0.1) as writer:
                            writer.execute("INSERT INTO trades (id, ts, symbol, market_kind, price, size, side, trade_id) "
                                           "VALUES (16, ?, 'BTCUSDT', 'SPOT', '100', '1', 'buy', 't16')", (T0 + 16,))
                        inserted.append(True)
                    return batch

            return Reader()

        def close(self):
            self.connection.close()

    monkeypatch.setattr(capture_export, "_source", Source)
    monkeypatch.setattr(capture_export, "READ_BATCH_ROWS", 3)
    store, client = fake_store()
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    assert inserted == [True]
    assert [row[0] for key in sorted(client.objects) if key.endswith(".zst") for row in slice_rows(client.objects[key], "trades")] == list(range(1, 16))


def test_denied_bootstrap_listing_fails_cleanly_without_a_checkpoint(capture, monkeypatch, capsys):
    from botocore.exceptions import ClientError

    store, client = fake_store()

    def denied(_name):
        raise ClientError({"Error": {"Code": "AccessDenied", "Message": "listing denied"},
                           "ResponseMetadata": {"HTTPStatusCode": 403}}, "ListObjectsV2")

    monkeypatch.setattr(client, "get_paginator", denied)
    assert capture_export.run(args_for(capture, target="binance"), store) == 1
    assert "listing denied" in capsys.readouterr().out
    assert not (capture["tmp"] / "state" / "watermark.json").exists()
    assert client.objects == {}


def seed_snapshots(path, rows, levels):
    side = json.dumps([[f"{100_000 + level}.12345678", "0.12345678"] for level in range(levels)])
    db = sqlite3.connect(path)
    db.executemany("INSERT INTO l2_depth_snapshots (id, captured_at, symbol, market_kind, last_update_id, bids, asks) "
                   "VALUES (?, ?, 'BTCUSDT', 'SPOT', ?, ?, ?)", [(i, T0 + i, i, side, side) for i in range(1, rows + 1)])
    db.commit()
    db.close()
    return 2 * len(side)


def test_wide_rows_are_read_in_byte_bounded_batches(capture, monkeypatch):
    row_bytes = seed_snapshots(capture["binance"], 10, 2_000)
    original_source = capture_export._source
    fetched = []

    class Source:
        def __init__(self, path):
            self.connection = original_source(path)

        def execute(self, sql, *args):
            cursor = self.connection.execute(sql, *args)
            if not sql.startswith("SELECT * FROM l2_depth_snapshots"):
                return cursor

            class Reader:
                def fetchmany(self, count):
                    batch = cursor.fetchmany(count)
                    fetched.append(len(batch))
                    return batch

            return Reader()

        def close(self):
            self.connection.close()

    monkeypatch.setattr(capture_export, "_source", Source)
    monkeypatch.setattr(capture_export, "READ_BATCH_BYTES", 3 * row_bytes)
    store, client = fake_store()
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    assert sum(fetched) == 10
    assert max(fetched) <= 3
    assert [row[0] for key, blob in client.objects.items() if key.endswith(".zst") for row in slice_rows(blob, "l2_depth_snapshots")] == list(range(1, 11))


def test_a_chunk_is_compressed_and_uploaded_as_a_stream(capture, monkeypatch):
    seed_snapshots(capture["binance"], 4, 500)
    store, client = fake_store()
    original_put = client.put_object
    bodies = {}

    def recording_put(**args):
        bodies[args["Key"]] = type(args["Body"])
        original_put(**args)

    client.put_object = recording_put
    original_compressor = zstandard.ZstdCompressor

    class StreamOnly:
        def __init__(self, **kwargs):
            self.inner = original_compressor(**kwargs)

        def copy_stream(self, *args, **kwargs):
            return self.inner.copy_stream(*args, **kwargs)

    monkeypatch.setattr(zstandard, "ZstdCompressor", StreamOnly)
    assert capture_export.run(args_for(capture, target="binance"), store) == 0
    [data_key] = [key for key in client.objects if key.endswith(".zst")]
    assert bodies[data_key] is not bytes
    blob = client.objects[data_key]
    manifest = json.loads(client.objects[data_key.replace(".sqlite.zst", ".json")])
    assert zstandard.get_frame_parameters(blob).content_size == manifest["rawBytes"]
    assert manifest["compressedBytes"] == len(blob)
    assert [row[0] for row in slice_rows(blob, "l2_depth_snapshots")] == [1, 2, 3, 4]
    assert list((capture["tmp"] / "staging").iterdir()) == []
