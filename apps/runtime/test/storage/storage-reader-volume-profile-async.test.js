const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { safeRm } = require("../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-storage-reader-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function seedTrade(storageDb, ts, overrides = {}) {
  storageDb.insert("trades", {
    ts, symbol: "BTCUSDT", marketKind: "PERPETUAL", price: 84610, size: 1, side: "buy",
    tradeId: `t-${ts}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });
}

describe("createStorageReader.readVolumeProfileAsync", () => {
  let dbPath;

  afterEach(() => {
    try {
      if (dbPath && fs.existsSync(dbPath)) safeRm(dbPath, { force: true });
    } catch {
      void 0;
    }
  });

  test("sums buy and sell volume per row on the absolute grid through the worker, the same answer as the synchronous read", async () => {
    dbPath = tempDbPath();
    const writer = createStorageDb({ dbPath });
    seedTrade(writer, 1_000, { price: 84610.4, size: 2 });
    seedTrade(writer, 2_000, { price: 84610.9, size: 1, side: "sell" });
    seedTrade(writer, 3_000, { price: 84611, size: 3, side: "sell" });
    seedTrade(writer, 4_000, { price: 84611, size: 3 }); // at toMs: excluded
    writer.close();

    const reader = createStorageReader({ dbPath });
    try {
      const options = { fromTs: 1_000, toTs: 4_000, originPrice: 0, rowWidth: 1 };
      const viaWorker = await reader.readVolumeProfileAsync("BTCUSDT", "PERPETUAL", options);
      expect(viaWorker).toEqual({
        available: true,
        buckets: [
          { bucket: 84610, volume: 3, buyVolume: 2, sellVolume: 1, tradeCount: 2 },
          { bucket: 84611, volume: 3, buyVolume: 0, sellVolume: 3, tradeCount: 1 },
        ],
      });
      expect(viaWorker).toEqual(reader.readVolumeProfile("BTCUSDT", "PERPETUAL", options));
    } finally {
      await reader.close();
    }
  });

  test("an abort signal settles the read with the empty shape at once instead of waiting for the worker", async () => {
    dbPath = tempDbPath();
    const writer = createStorageDb({ dbPath });
    seedTrade(writer, 1_000);
    writer.close();

    const reader = createStorageReader({ dbPath });
    try {
      const controller = new AbortController();
      const read = reader.readVolumeProfileAsync("BTCUSDT", "PERPETUAL", { fromTs: 0, toTs: 2_000, originPrice: 0, rowWidth: 1 }, { signal: controller.signal });
      controller.abort();
      await expect(read).resolves.toEqual({ buckets: [], available: false });
    } finally {
      await reader.close();
    }
  });
});
