const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { openIcebergHostStore } = require("../../../src/indicators/iceberg/iceberg-host-store");
const { main } = require("../../../scripts/serve/run-iceberg-history");

const CHUNK_MS = 300_000;

function seedCapture(dbPath, from, to) {
  const storage = createStorageDb({ dbPath });
  const db = storage.raw;
  db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
    .run(from, "BTCUSDT", "PERPETUAL", 1, JSON.stringify([["81000.0", "1.0"], ["80999.0", "2.0"]]), JSON.stringify([["81001.0", "3.0"]]));
  const diff = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    let u = 2;
    for (let ts = from + 5_000; ts < to; ts += 5_000) {
      diff.run(ts, ts + 5, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify([["80999.0", String(2 + (u % 3))]]), "[]");
      u += 1;
    }
  })();
  storage.close();
}

describe("scripts/serve/run-iceberg-history", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-iceberg-history-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("a SIGTERM during the backlog stops the real builder after the chunk in hand, and main closes everything and exits cleanly", async () => {
    const capture = path.join(dir, "market-data.sqlite");
    const icebergDir = path.join(dir, "iceberg-history");
    const from = Date.now() - 2 * 3_600_000;
    seedCapture(capture, from, Date.now() - 120_000);
    const lines = [];
    const logger = { info: (line) => lines.push(line), ok: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line), banner: () => {}, flush: async () => {}, close: () => {} };
    const processImpl = new EventEmitter();
    const env = {
      TT_ICEBERG_DIR: icebergDir, TT_ICEBERG_BINANCE_DB_PATH: capture, TT_ICEBERG_DXFEED_DB_PATH: path.join(dir, "absent.sqlite"),
      TT_ICEBERG_PAIRS: "binance:PERPETUAL:BTCUSDT", TT_ICEBERG_WARMUP_HOURS: "0.0001",
    };
    setImmediate(() => processImpl.emit("SIGTERM"));
    const service = await main({ env, processImpl, logger });
    expect(service).not.toBeNull();
    expect(processImpl.exitCode).toBeUndefined();
    expect(processImpl.listenerCount("SIGTERM")).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(["received SIGTERM, finishing the current chunk", "iceberg history stopped"]));
    const store = openIcebergHostStore({ dir: icebergDir, pairKey: "binance:PERPETUAL:BTCUSDT", readonly: true });
    expect(store.checkpoint().cursor).toBe(from + CHUNK_MS);
    store.close();
    expect(JSON.parse(fs.readFileSync(path.join(icebergDir, "status.json"), "utf8")).pairs["binance:PERPETUAL:BTCUSDT"]).toMatchObject({ state: "RUNNING", chunks: 1, cursor: from + CHUNK_MS });
  });
});
