const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedStorageService } = require("../../../src/storage/dxfeed/dxfeed-storage-service");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { listCollectorInstruments } = require("../../../src/providers/dxfeed/dxfeed-instrument-catalog");
const { canonicalEnvelopes, orderV2Envelope } = require("../../../scripts/qualify/qualify-dxfeed-storage");
const { safeRm } = require("../../helpers/temp-files");

function tempDbPath() {
  return path.join(os.tmpdir(), `dxfeed-storage-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function removeDatabase(dbPath) {
  for (const suffix of ["", "-wal", "-shm", ".lock"]) safeRm(`${dbPath}${suffix}`, { force: true });
}

const QUOTE = {
  eventTime: 1_800_000_000_001, receivedAt: 1_800_000_000_002,
  provider: "DXFEED", venue: null, assetClass: "EQUITY", symbol: "TSLA",
  stale: 0, recoveryState: "READY", bidPrice: 249.75, bidSize: 2, bidTime: 1_800_000_000_001,
  bidExchangeCode: "Q", askPrice: 250.25, askSize: 3, askTime: 1_800_000_000_001,
  askExchangeCode: "Q",
};

describe("dxFeed storage WAL recovery and reader pressure", () => {
  test("committed WAL evidence is visible while an uncommitted transaction never leaks and rolls back", () => {
    const dbPath = tempDbPath();
    const storageDb = createDxFeedStorageDb({ dbPath, bootstrap: true });
    storageDb.raw.pragma("wal_autocheckpoint = 0");
    storageDb.insert("dxfeed_quotes", QUOTE);
    storageDb.raw.exec("BEGIN IMMEDIATE");
    storageDb.insert("dxfeed_quotes", {
      ...QUOTE, eventTime: QUOTE.eventTime + 1, receivedAt: QUOTE.receivedAt + 1,
      bidTime: QUOTE.bidTime + 1, askTime: QUOTE.askTime + 1,
    });

    const concurrentReader = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(concurrentReader.prepare("SELECT COUNT(*) AS count FROM dxfeed_quotes").get().count).toBe(1);
    concurrentReader.close();
    storageDb.close();

    const recovered = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(recovered.prepare("SELECT COUNT(*) AS count FROM dxfeed_quotes").get().count).toBe(1);
    expect(recovered.pragma("quick_check", { simple: true })).toBe("ok");
    recovered.close();
    removeDatabase(dbPath);
  });

  test("a long-lived reader remains available while 6,250 accepted multi-table rows (1,250 per table, five instruments) are durably written", async () => {
    const dbPath = tempDbPath();
    const service = createDxFeedStorageService({ dbPath, bootstrap: true });
    const reader = createDxFeedStorageReader({ dbPath, timeoutMs: 100 });
    const instruments = listCollectorInstruments();
    let pressureReads = 0;
    for (let pageStart = 1; pageStart <= 250; pageStart += 10) {
      const canonical = [];
      const exactOrders = [];
      for (let sequence = pageStart; sequence < pageStart + 10; sequence += 1) {
        for (const instrument of instruments) {
          canonical.push(...canonicalEnvelopes(instrument, sequence));
          exactOrders.push(orderV2Envelope(instrument, sequence));
        }
      }
      expect(service.handleEnvelopes(canonical).every(Boolean)).toBe(true);
      expect(service.handleOrderV2Envelopes(exactOrders).every(Boolean)).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(reader.readRecent("TSLA", "EQUITY", "TRADE", { limit: 10 }).available).toBe(true);
      pressureReads += 1;
    }
    expect(pressureReads).toBe(25);
    expect(reader.countAll()).toEqual({
      quotes: 1_250, trades: 1_250, orderBookCapture: 1_250, timeAndSales: 1_250, candles: 0,
    });
    expect(service.getCounters()).toMatchObject({
      quotes: 1_250, trades: 1_250, orderBookCapture: 1_250, timeAndSales: 1_250,
      rejected: 0, skipped: 0, tradeIdGaps: 0, tradeIdNonMonotonic: 0,
    });
    reader.close();
    service.close();
    removeDatabase(dbPath);
  }, 30_000);
});
