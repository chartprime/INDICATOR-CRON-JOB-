const { createStorageDb } = require("../../src/storage/storage-db");
const {
  createStorageGapAudit,
  auditGapsForPair,
  auditAllPairs,
  auditAndRecordDepthContinuityDay,
  DEFAULT_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
} = require("../../src/storage/storage-gap-audit");
const { createBinanceBookAssembler } = require("../../src/providers/binance/binance-book-assembler");

function seedDepthEvent(storageDb, { symbol = "BTCUSDT", marketKind = "SPOT", firstUpdateId, lastUpdateId, previousUpdateId, ts = 1000 }) {
  storageDb.insert("l2_depth_events", {
    ts,
    receivedAt: ts,
    symbol,
    marketKind,
    firstUpdateId,
    lastUpdateId,
    previousUpdateId: marketKind === "PERPETUAL" ? (previousUpdateId ?? firstUpdateId - 1) : null,
    bids: "[]",
    asks: "[]",
  });
}

function assemblerGapCount(rows, marketKind) {
  let gapsDetected = 0;
  let assembler = null;
  for (const row of rows) {
    const event = { payload: {
      firstUpdateId: row.firstUpdateId,
      lastUpdateId: row.lastUpdateId,
      previousUpdateId: marketKind === "PERPETUAL" ? row.previousUpdateId : null,
      bids: [], asks: [],
    } };
    if (assembler === null) {
      assembler = createBinanceBookAssembler({ marketKind });
      assembler.applySnapshot({
        lastUpdateId: marketKind === "PERPETUAL" ? row.firstUpdateId : Math.max(0, row.firstUpdateId - 1),
        bids: [], asks: [],
      });
      assembler.applyDeltaEventStatus(event);
      continue;
    }
    const verdict = assembler.applyDeltaEventStatus(event);
    if (verdict.status !== "UNAVAILABLE" || verdict.reason !== "SEQUENCE_GAP") continue;
    gapsDetected += 1;
    // The durable audit keeps scanning after a break. Re-anchor the live
    // assembler on the broken row so both oracles evaluate the same suffix.
    assembler = createBinanceBookAssembler({ marketKind });
    assembler.applySnapshot({
      lastUpdateId: marketKind === "PERPETUAL" ? row.firstUpdateId : Math.max(0, row.firstUpdateId - 1),
      bids: [], asks: [],
    });
    assembler.applyDeltaEventStatus(event);
  }
  return gapsDetected;
}

describe("durable audit/live assembler gap equivalence", () => {
  let storageDb;
  afterEach(() => storageDb?.close());

  test.each([
    ["SPOT", [
      { firstUpdateId: 1, lastUpdateId: 5 },
      { firstUpdateId: 4, lastUpdateId: 10 }, // overlap
      { firstUpdateId: 1, lastUpdateId: 3 }, // obsolete duplicate
      { firstUpdateId: 20, lastUpdateId: 25 }, // hole
      { firstUpdateId: 26, lastUpdateId: 30 },
      { firstUpdateId: 40, lastUpdateId: 45 }, // second hole
    ]],
    ["PERPETUAL", [
      { firstUpdateId: 1, lastUpdateId: 5, previousUpdateId: 0 },
      { firstUpdateId: 4, lastUpdateId: 10, previousUpdateId: 5 }, // overlap, valid pu
      { firstUpdateId: 1, lastUpdateId: 3, previousUpdateId: 0 }, // obsolete duplicate
      { firstUpdateId: 11, lastUpdateId: 15, previousUpdateId: 9 }, // pu hole
      { firstUpdateId: 16, lastUpdateId: 20, previousUpdateId: 15 },
      { firstUpdateId: 21, lastUpdateId: 25, previousUpdateId: 19 }, // second pu hole
    ]],
  ])("%s reports the same break count for duplicates, overlaps and holes", async (marketKind, rows) => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    rows.forEach((row, index) => seedDepthEvent(storageDb, { marketKind, ts: 1000 + index, ...row }));

    const audit = await auditGapsForPair(storageDb, "BTCUSDT", marketKind);

    expect(audit.gapsDetected).toBe(2);
    expect(assemblerGapCount(rows, marketKind)).toBe(audit.gapsDetected);
  });
});

function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

describe("auditGapsForPair", () => {
  let storageDb;

  afterEach(() => {
    storageDb?.close();
  });

  test("a fully continuous sequence reports zero gaps", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5, ts: 1000 });
    seedDepthEvent(storageDb, { firstUpdateId: 6, lastUpdateId: 10, ts: 2000 });
    seedDepthEvent(storageDb, { firstUpdateId: 11, lastUpdateId: 15, ts: 3000 });

    const result = await auditGapsForPair(storageDb, "BTCUSDT", "SPOT");

    expect(result).toEqual({ rowsChecked: 3, gapsDetected: 0 });
  });

  test("a genuine discontinuity (missed update IDs between two rows) is flagged", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5, ts: 1000 });
    seedDepthEvent(storageDb, { firstUpdateId: 20, lastUpdateId: 25, ts: 2000 });

    const result = await auditGapsForPair(storageDb, "BTCUSDT", "SPOT");

    expect(result).toEqual({ rowsChecked: 2, gapsDetected: 1 });
  });

  test("multiple gaps across a longer sequence are all counted", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5, ts: 1000 });
    seedDepthEvent(storageDb, { firstUpdateId: 20, lastUpdateId: 25, ts: 2000 });
    seedDepthEvent(storageDb, { firstUpdateId: 26, lastUpdateId: 30, ts: 3000 });
    seedDepthEvent(storageDb, { firstUpdateId: 50, lastUpdateId: 55, ts: 4000 });

    const result = await auditGapsForPair(storageDb, "BTCUSDT", "SPOT");

    expect(result).toEqual({ rowsChecked: 4, gapsDetected: 2 });
  });

  test("a perpetual pu mismatch is detected even when update ranges overlap", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { marketKind: "PERPETUAL", firstUpdateId: 1, lastUpdateId: 5 });
    storageDb.insert("l2_depth_events", {
      ts: 2000,
      receivedAt: 2000,
      symbol: "BTCUSDT",
      marketKind: "PERPETUAL",
      firstUpdateId: 4,
      lastUpdateId: 10,
      previousUpdateId: 3,
      bids: "[]",
      asks: "[]",
    });

    await expect(auditGapsForPair(storageDb, "BTCUSDT", "PERPETUAL")).resolves.toEqual({ rowsChecked: 2, gapsDetected: 1 });
  });

  test("a spot range overlapping the prior update is continuous under Binance's documented bridge rule", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5 });
    seedDepthEvent(storageDb, { firstUpdateId: 4, lastUpdateId: 10, ts: 2000 });

    await expect(auditGapsForPair(storageDb, "BTCUSDT", "SPOT")).resolves.toEqual({ rowsChecked: 2, gapsDetected: 0 });
  });

  test("an obsolete out-of-order spot event cannot create a false gap in the following valid range", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5, ts: 1000 });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 3, ts: 2000 });
    seedDepthEvent(storageDb, { firstUpdateId: 6, lastUpdateId: 10, ts: 3000 });

    await expect(auditGapsForPair(storageDb, "BTCUSDT", "SPOT")).resolves.toEqual({ rowsChecked: 3, gapsDetected: 0 });
  });

  test("an obsolete perpetual event is ignored and the next pu is checked against the highest applied update id", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { marketKind: "PERPETUAL", firstUpdateId: 1, lastUpdateId: 5, ts: 1000 });
    storageDb.insert("l2_depth_events", {
      ts: 2000,
      receivedAt: 2000,
      symbol: "BTCUSDT",
      marketKind: "PERPETUAL",
      firstUpdateId: 1,
      lastUpdateId: 3,
      previousUpdateId: 0,
      bids: "[]",
      asks: "[]",
    });
    storageDb.insert("l2_depth_events", {
      ts: 3000,
      receivedAt: 3000,
      symbol: "BTCUSDT",
      marketKind: "PERPETUAL",
      firstUpdateId: 4,
      lastUpdateId: 10,
      previousUpdateId: 5,
      bids: "[]",
      asks: "[]",
    });

    await expect(auditGapsForPair(storageDb, "BTCUSDT", "PERPETUAL")).resolves.toEqual({ rowsChecked: 3, gapsDetected: 0 });
  });

  test("zero and one row both report zero gaps without throwing", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    await expect(auditGapsForPair(storageDb, "BTCUSDT", "SPOT")).resolves.toEqual({ rowsChecked: 0, gapsDetected: 0 });

    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5 });
    await expect(auditGapsForPair(storageDb, "BTCUSDT", "SPOT")).resolves.toEqual({ rowsChecked: 1, gapsDetected: 0 });
  });

  test("a different (symbol, marketKind) pair's rows never contribute to this pair's count", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { symbol: "BTCUSDT", marketKind: "SPOT", firstUpdateId: 1, lastUpdateId: 5 });
    seedDepthEvent(storageDb, { symbol: "BTCUSDT", marketKind: "PERPETUAL", firstUpdateId: 100, lastUpdateId: 105 });
    seedDepthEvent(storageDb, { symbol: "ETHUSDT", marketKind: "SPOT", firstUpdateId: 900, lastUpdateId: 905 });

    await expect(auditGapsForPair(storageDb, "BTCUSDT", "SPOT")).resolves.toEqual({ rowsChecked: 1, gapsDetected: 0 });
  });
});

describe("auditAllPairs", () => {
  let storageDb;

  afterEach(() => {
    storageDb?.close();
  });

  test("sums gaps and rows across all 4 known pairs, keyed per pair", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { symbol: "BTCUSDT", marketKind: "SPOT", firstUpdateId: 1, lastUpdateId: 5 });
    seedDepthEvent(storageDb, { symbol: "BTCUSDT", marketKind: "SPOT", firstUpdateId: 50, lastUpdateId: 55 });
    seedDepthEvent(storageDb, { symbol: "ETHUSDT", marketKind: "PERPETUAL", firstUpdateId: 1, lastUpdateId: 5 });
    seedDepthEvent(storageDb, { symbol: "ETHUSDT", marketKind: "PERPETUAL", firstUpdateId: 6, lastUpdateId: 10 });

    const report = await auditAllPairs(storageDb);

    expect(report.totalGaps).toBe(1);
    expect(report.totalRows).toBe(4);
    expect(report.perPair["BTCUSDT:SPOT"]).toEqual({ rowsChecked: 2, gapsDetected: 1 });
    expect(report.perPair["ETHUSDT:PERPETUAL"]).toEqual({ rowsChecked: 2, gapsDetected: 0 });
    expect(report.perPair["BTCUSDT:PERPETUAL"]).toEqual({ rowsChecked: 0, gapsDetected: 0 });
    expect(report.perPair["ETHUSDT:SPOT"]).toEqual({ rowsChecked: 0, gapsDetected: 0 });
  });
});

describe("auditAndRecordDepthContinuityDay", () => {
  let storageDb;

  afterEach(() => {
    storageDb?.close();
  });

  test("preserves a depth-sequence anchor after the prior day's raw rows are gone", () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5, ts: 1_000 });
    seedDepthEvent(storageDb, { firstUpdateId: 6, lastUpdateId: 10, ts: 2_000 });

    const first = auditAndRecordDepthContinuityDay(storageDb, { dayStartMs: 0, auditedAt: 86_400_000 });
    expect(first.perPair["BTCUSDT:SPOT"]).toMatchObject({ gapsDetected: 0, anchorStatus: "BASELINE", lastUpdateId: 10 });

    storageDb.raw.prepare("DELETE FROM l2_depth_events").run();
    seedDepthEvent(storageDb, { firstUpdateId: 15, lastUpdateId: 20, ts: 86_400_000 + 1_000 });
    const second = auditAndRecordDepthContinuityDay(storageDb, { dayStartMs: 86_400_000, auditedAt: 2 * 86_400_000 });

    expect(second.perPair["BTCUSDT:SPOT"]).toMatchObject({ gapsDetected: 1, anchorStatus: "ANCHORED", firstUpdateId: 15, lastUpdateId: 20 });
    expect(storageDb.raw.prepare("SELECT gaps_detected FROM depth_continuity_audits WHERE day_start = ? AND symbol = ? AND market_kind = ?").get(86_400_000, "BTCUSDT", "SPOT")).toEqual({ gaps_detected: 1 });
  });

  test("makes a day with no captured depth explicit rather than reporting it as clean", () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    const report = auditAndRecordDepthContinuityDay(storageDb, { dayStartMs: 0, auditedAt: 1 });

    expect(report).toMatchObject({ totalRows: 0, totalGaps: 0, noDataPairs: 4, unanchoredPairs: 0 });
    expect(report.perPair["BTCUSDT:SPOT"]).toMatchObject({ anchorStatus: "NO_DATA", rowsChecked: 0 });
  });
});

describe("createStorageGapAudit", () => {
  let storageDb;

  afterEach(() => {
    storageDb?.close();
    jest.useRealTimers();
  });

  test("rejects a storageDb without a raw handle, a logger missing info()/warn(), and a non-positive interval", () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    expect(() => createStorageGapAudit({ storageDb: {}, logger: fakeLogger() })).toThrow(/raw/);
    expect(() => createStorageGapAudit({ storageDb, logger: {} })).toThrow(/logger/);
    expect(() => createStorageGapAudit({ storageDb, logger: fakeLogger(), intervalMs: 0 })).toThrow(/intervalMs/);
  });

  test("logs info (not warn) when the sequence is clean", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5 });
    const logger = fakeLogger();
    const audit = createStorageGapAudit({ storageDb, logger });

    const report = await audit.runOnce();

    expect(report.totalGaps).toBe(0);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(audit.getLastReport()).toBe(report);
  });

  test("logs warn (not info) when gaps are found, including the gap count", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5 });
    seedDepthEvent(storageDb, { firstUpdateId: 50, lastUpdateId: 55 });
    const logger = fakeLogger();
    const audit = createStorageGapAudit({ storageDb, logger });

    await audit.runOnce();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ gaps: 1 });
    expect(logger.info).not.toHaveBeenCalled();
  });

  test("getLastReport() is null before the first run", () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    const audit = createStorageGapAudit({ storageDb, logger: fakeLogger() });
    expect(audit.getLastReport()).toBeNull();
  });

  test("start()/stop() run on the configured interval and can be cancelled", async () => {
    jest.useFakeTimers();
    storageDb = createStorageDb({ dbPath: ":memory:" });
    const logger = fakeLogger();
    const audit = createStorageGapAudit({ storageDb, logger, intervalMs: 1000 });

    audit.start();
    expect(audit.getLastReport()).toBeNull();
    await jest.advanceTimersByTimeAsync(1000);
    expect(audit.getLastReport()).not.toBeNull();

    await audit.stop();
    const afterStop = audit.getLastReport();
    jest.advanceTimersByTime(5000);
    expect(audit.getLastReport()).toBe(afterStop);
  });

  test("a scheduled failure is logged and reported via onError, never thrown out of the timer", async () => {
    jest.useFakeTimers();
    const brokenStorageDb = { raw: { prepare: () => ({ all: () => { throw new Error("db locked"); } }) } };
    const onError = jest.fn();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const audit = createStorageGapAudit({ storageDb: brokenStorageDb, logger: fakeLogger(), intervalMs: 1000, onError });

    audit.start();
    await expect(jest.advanceTimersByTimeAsync(1000)).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe("db locked");
    errorSpy.mockRestore();
    await audit.stop();
  });

  test("the default interval is a named constant, not a magic number", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_BATCH_SIZE).toBe(10_000);
  });

  test("large audits yield between bounded keyset batches and still preserve continuity state", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5, ts: 1000 });
    seedDepthEvent(storageDb, { firstUpdateId: 4, lastUpdateId: 10, ts: 2000 });
    seedDepthEvent(storageDb, { firstUpdateId: 20, lastUpdateId: 25, ts: 3000 });
    const yieldNow = jest.fn(() => Promise.resolve());

    const report = await auditGapsForPair(storageDb, "BTCUSDT", "SPOT", { batchSize: 1, yieldNow });

    expect(report).toEqual({ rowsChecked: 3, gapsDetected: 1 });
    expect(yieldNow).toHaveBeenCalledTimes(3);
  });

  test("overlapping runOnce calls share one audit instead of multiplying database load", async () => {
    storageDb = createStorageDb({ dbPath: ":memory:" });
    seedDepthEvent(storageDb, { firstUpdateId: 1, lastUpdateId: 5 });
    const audit = createStorageGapAudit({ storageDb, logger: fakeLogger(), batchSize: 1 });

    const first = audit.runOnce();
    const overlapping = audit.runOnce();

    expect(overlapping).toBe(first);
    await expect(first).resolves.toMatchObject({ totalRows: 1, totalGaps: 0 });
  });
});
