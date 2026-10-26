const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { createStorageReader } = require("../../../src/storage/storage-reader");
const { createRemoteStorageReader } = require("../../../src/storage/remote-storage-reader");
const { createService } = require("../../../scripts/serve/run-live-storage-service");
const { createGateway } = require("../../../scripts/serve/run-archive-gateway");
const { MIN_TOKEN_LENGTH } = require("../../../src/server/archive-auth");
const { createIcebergHostService } = require("../../../src/indicators/iceberg/iceberg-host-service");
const { createIcebergHostBuilder } = require("../../../src/indicators/iceberg/iceberg-host-builder");
const { openIcebergHostStore } = require("../../../src/indicators/iceberg/iceberg-host-store");
const { createIcebergIndicator } = require("../../../src/indicators/iceberg/iceberg-indicator");

const DEV_SECRET = "d".repeat(MIN_TOKEN_LENGTH);
const SERVICE_SECRET = "internal-service-secret-under-test-icebergs";
const T0 = 1_700_000_100_000;
const FIXED = Object.freeze({ ready: true, visibleFloor: 0.35, minDurationMs: 5000, ratioCut: 2, strongRatio: 3, minRatioSamples: 1 });
const fixedCuts = () => ({ current: () => FIXED, observeTouch() {}, observeEpisode() {} });
const CATALOG = { version: 1, binance: [{ group: "Crypto", label: "BTC", symbol: "BTC-USDT", marketKind: "PERPETUAL", l2: { clusterTicks: 1, minSliceSize: 0 } }], dxfeed: [] };
const BTC = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };

function seedCapture(dbPath) {
  const storage = createStorageDb({ dbPath });
  const db = storage.raw;
  db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)")
    .run(T0 - 5_000, "BTCUSDT", "PERPETUAL", 1, JSON.stringify([["81000.0", "1.0"], ["80999.0", "2.0"]]), JSON.stringify([["81001.0", "3.0"]]));
  const diff = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const trade = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let u = 2;
  for (let i = 0; i < 8; i += 1) {
    const ts = T0 + 10_000 + i * 1000;
    trade.run(ts, "BTCUSDT", "PERPETUAL", "81000.0", "0.3", "sell", `d${i}`);
    diff.run(ts + 50, ts + 55, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify([["81000.0", "1.0"]]), "[]");
    u += 1;
  }
  for (let ts = T0 + 20_000; ts < T0 + 600_000; ts += 5_000) {
    diff.run(ts, ts + 5, "BTCUSDT", "PERPETUAL", u, u + 1, u, JSON.stringify([["80999.0", String(2 + (u % 3))]]), "[]");
    u += 1;
  }
  storage.close();
}

describe("iceberg history on the host, end to end: the builder builds it, live-storage serves it through the gateway, the runtime takes what it did not watch", () => {
  let dir = null;
  let service = null;
  let gateway = null;
  let indicator = null;

  afterEach(async () => {
    indicator?.stop();
    if (gateway) await gateway.stop();
    if (service) await service.stop();
    indicator = null;
    gateway = null;
    service = null;
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* the capture file may still be mapped on Windows; the temp dir is left behind */ } }
    dir = null;
  });

  test("a probable iceberg the capture shows reaches a runtime that was not watching, with the host's spans vouched for, and the runtime asks only for its own gaps", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-chain-"));
    const dbPath = path.join(dir, "capture.sqlite");
    const icebergDir = path.join(dir, "iceberg-history");
    fs.mkdirSync(icebergDir);
    seedCapture(dbPath);
    const at = T0 + 700_000;
    const host = createIcebergHostService({
      catalog: CATALOG, now: () => at,
      options: { dir: icebergDir, dbPaths: { binance: dbPath, dxfeed: path.join(dir, "none.sqlite") }, retentionMs: 7 * 86_400_000, warmupMs: { binance: 0, dxfeed: 0 }, cycleMs: 1000, chunksPerCycle: 100 },
      createBuilder: (options) => createIcebergHostBuilder({ ...options, chunkMs: 60_000, lagMs: 0, captureMarginMs: 0, cutsFactory: fixedCuts }),
    });
    expect(host.runOnce()).toBeGreaterThan(0);
    host.close();
    const store = openIcebergHostStore({ dir: icebergDir, pairKey: "binance:PERPETUAL:BTCUSDT", readonly: true });
    const built = store.readPage({ fromTs: 0, toTs: at }).icebergs;
    expect(built).toEqual([expect.objectContaining({ kind: "probable", side: "bid", price: 81000, markedAt: T0 + 16_000, status: "ended" })]);
    const taken = built.map((entry) => ({ ...entry, origin: "host" }));
    const checkpoint = store.checkpoint();
    store.close();
    expect(checkpoint.coverage).toEqual([[T0 - 5_000, T0 + 595_000]]);

    service = createService({
      port: 0, host: "127.0.0.1", dbPath, storageReader: createStorageReader({ dbPath }), icebergDir,
      tickSizeResolver: { getBinanceTickSize: async () => 1, getDxFeedTickSize: () => 0.01 },
      env: { TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET }, log: () => {},
    });
    await service.start();
    gateway = createGateway({
      port: 0, host: "127.0.0.1", log: () => {},
      env: { TT_ARCHIVE_CLIENT_TOKENS: `laptop-1:${DEV_SECRET}`, TT_LIVE_STORAGE_INTERNAL_URL: `http://127.0.0.1:${service.server.address().port}`, TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET },
    });
    await gateway.start();
    const baseUrl = `http://127.0.0.1:${gateway.server.address().port}/live-storage`;
    const remote = createRemoteStorageReader({ baseUrl, token: DEV_SECRET, log: () => {} });
    const direct = await remote.readIcebergHistory("BTCUSDT", "PERPETUAL", { fromTs: T0 - 60_000, toTs: at, limit: 10 });
    await remote.close();
    expect(direct).toMatchObject({ available: true, rulesVersion: 1, span: { from: T0 - 5_000, to: T0 + 595_000 }, watched: [[T0 - 5_000, T0 + 595_000]], icebergs: built, next: null });
    expect(service.health().icebergHistory).toMatchObject({ dir: icebergDir, open: 1 });

    const asked = [];
    const published = [];
    const clock = { at };
    indicator = createIcebergIndicator({
      provider: "BINANCE", storeDir: path.join(dir, "runtime-icebergs"), now: () => clock.at, cutsFactory: fixedCuts, hostFillDelayMs: 0,
      host: { baseUrl, token: DEV_SECRET },
      createRemoteReader: (options) => {
        const reader = createRemoteStorageReader(options);
        return { readIcebergHistory: (symbol, marketKind, options2, context) => { asked.push(options2); return reader.readIcebergHistory(symbol, marketKind, options2, context); }, close: () => reader.close() };
      },
      publish: (wire, pair, when, watched) => published.push({ wire, when, watched }),
      log: { warn: () => {}, error: () => {} },
    });
    indicator.onDepth(BTC, [["bid", 81000, 1]], at - 1000);
    clock.at = at + 1000;
    indicator.onDepth(BTC, [["bid", 81000, 1]], at + 500);
    indicator.tick();
    for (let i = 0; i < 20 && published.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(asked).toEqual([{ fromTs: at + 1000 - 5 * 86_400_000, toTs: at + 1000 - 600_000, limit: 2000 }]);
    expect(published).toEqual([{ wire: taken, when: at + 1000, watched: [[T0 - 5_000, at + 1000 - 600_000], [at - 1000, at + 500]] }]);
    const page = indicator.snapshot(BTC, at + 2000);
    expect(page.icebergs).toEqual(taken);
    expect(page.watched).toEqual([[T0 - 5_000, at + 1000 - 600_000], [at - 1000, at + 500]]);
    clock.at = at + 2000;
    indicator.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveLength(1);
    await gateway.stop();
    gateway = null;
    await service.stop();
    expect(service.health().icebergHistory.open).toBe(0);
    service = null;
  });
});
