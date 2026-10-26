const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { tradeMagnitude, MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } = require("../../../src/indicators/large-trade/large-trade-detection");
const { VPIN_REMOTE_BACKFILL_SLICE_MS } = require("../../../src/server/market-data-server-shared");
const { safeRm } = require("../../helpers/temp-files");

// Report 54 phase 1. The archive's four trade-derived families are defined as
// "what the live storage reads return", so the same hand-derived golden trades
// that pin the Python stage are loaded into a real dxFeed capture database and
// read through the real live SQL. Oracle: the golden file, not either side.
// Live sums are REAL; the archive is exact decimal. Sizes here are integers so
// volumes are exact; notionals carry float rounding and are compared within
// one part in a million.
const GOLDEN = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../../benchmarks/fixtures/golden/trade-families.json"), "utf8"));
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const SYMBOLS = { FUTURE: { symbol: "/ESZ26:XCME", venue: "XCME", exchangeCode: "G" }, EQUITY: { symbol: "AAPL", venue: "NTV", exchangeCode: "L" } };

function tempDbPath() {
  return path.join(os.tmpdir(), `terminal-l1-l2-trade-families-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function seed(dbPath, market, trades) {
  const storageDb = createDxFeedStorageDb({ dbPath });
  for (const [index, trade] of trades.entries()) {
    const eventTime = GOLDEN.baseMs + trade.atMs;
    storageDb.insert("dxfeed_time_and_sales", {
      eventTime, receivedAt: eventTime + 1, provider: "DXFEED", venue: SYMBOLS[market].venue, assetClass: market,
      symbol: SYMBOLS[market].symbol, stale: 0, recoveryState: "READY", price: Number(trade.price), size: Number(trade.size),
      time: eventTime, timeNanoPart: 0, sequence: index + 1, exchangeCode: SYMBOLS[market].exchangeCode, extendedTradingHours: 0,
      aggressorSide: trade.side === "UNKNOWN" ? "UNDEFINED" : trade.side, spreadLeg: 0, validTick: trade.validTick ? 1 : 0,
      eventKind: trade.action, providerIndex: null, providerTradeId: index + 1, bidPrice: null, askPrice: null,
    });
  }
  storageDb.close();
}

function close(value, expected) {
  const tolerance = 1e-6 * Math.max(1, Math.abs(expected));
  return Math.abs(value - expected) <= tolerance;
}

describe("the golden geometry is the live system's own, not a copy that can drift", () => {
  test("slice width, prints per side and the marker bucket come from the live modules", () => {
    expect(GOLDEN.sliceMs).toBe(VPIN_REMOTE_BACKFILL_SLICE_MS);
    expect(GOLDEN.printsPerSide).toBe(MARKERS_PER_BUCKET_SIDE);
    expect(MINUTE_MS).toBe(MARKER_BUCKET_MS);
  });
});

describe.each(Object.entries(GOLDEN.cases))("live dxFeed reads equal the golden %s families", (name, testCase) => {
  const market = testCase.market;
  let dbPath;
  let reader;
  beforeAll(() => {
    dbPath = tempDbPath();
    seed(dbPath, market, testCase.trades);
    reader = createDxFeedStorageReader({ dbPath });
  });
  afterAll(() => {
    reader.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("readMinuteRollup at the instrument tick is trade_level, and its minute sums are trade_minute", () => {
    const result = reader.readMinuteRollup(SYMBOLS[market].symbol, market, {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS, tickSize: Number(testCase.tickSize),
    });
    expect(result.available).toBe(true);
    const levels = [...result.rows].sort((a, b) => (a.minuteTs - b.minuteTs) || (a.priceBucket - b.priceBucket));
    expect(levels.map(row => ({ minuteMs: row.minuteTs - GOLDEN.baseMs, priceBucket: row.priceBucket, volume: row.volume, buyVolume: row.buyVolume, sellVolume: row.sellVolume, tradeCount: row.tradeCount })))
      .toEqual(testCase.expected.trade_level.map(row => ({ minuteMs: row.minuteMs, priceBucket: row.priceBucket, volume: Number(row.volume), buyVolume: Number(row.buyVolume), sellVolume: Number(row.sellVolume), tradeCount: row.tradeCount })));

    const minutes = new Map();
    for (const row of levels) {
      const minute = minutes.get(row.minuteTs) ?? { volume: 0, buyVolume: 0, sellVolume: 0, tradeCount: 0 };
      minute.volume += row.volume; minute.buyVolume += row.buyVolume; minute.sellVolume += row.sellVolume; minute.tradeCount += row.tradeCount;
      minutes.set(row.minuteTs, minute);
    }
    expect([...minutes.entries()].map(([minuteTs, m]) => ({ minuteMs: minuteTs - GOLDEN.baseMs, ...m, undefinedVolume: m.volume - m.buyVolume - m.sellVolume })))
      .toEqual(testCase.expected.trade_minute.map(row => ({ minuteMs: row.minuteMs, volume: Number(row.volume), buyVolume: Number(row.buyVolume), sellVolume: Number(row.sellVolume), tradeCount: row.tradeCount, undefinedVolume: Number(row.undefinedVolume) })));
  });

  test("readSlicedNotional at 2 s is trade_slice, and its minute sums are trade_minute's notionals", () => {
    const result = reader.readSlicedNotional(SYMBOLS[market].symbol, market, {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS, sliceMs: VPIN_REMOTE_BACKFILL_SLICE_MS,
    });
    expect(result.available).toBe(true);
    expect(result.rows.length).toBe(testCase.expected.trade_slice.length);
    for (const [index, row] of result.rows.entries()) {
      const expected = testCase.expected.trade_slice[index];
      expect(row.sliceTs - GOLDEN.baseMs).toBe(expected.lastTradeMs);
      expect(Math.floor((row.sliceTs - GOLDEN.baseMs) / GOLDEN.sliceMs) * GOLDEN.sliceMs).toBe(expected.sliceMs);
      expect(close(row.buyNotional, Number(expected.buyNotional))).toBe(true);
      expect(close(row.sellNotional, Number(expected.sellNotional))).toBe(true);
    }
    for (const minute of testCase.expected.trade_minute) {
      const inMinute = result.rows.filter(row => Math.floor((row.sliceTs - GOLDEN.baseMs) / MINUTE_MS) * MINUTE_MS === minute.minuteMs);
      expect(close(inMinute.reduce((sum, row) => sum + row.buyNotional, 0), Number(minute.buyNotional))).toBe(true);
      expect(close(inMinute.reduce((sum, row) => sum + row.sellNotional, 0), Number(minute.sellNotional))).toBe(true);
    }
  });

  test("readLargeTrades with the marker geometry is trade_prints, rank by rank", () => {
    const result = reader.readLargeTrades(SYMBOLS[market].symbol, market, {
      nowMs: GOLDEN.baseMs + 2 * MINUTE_MS, limit: 1000, fromMs: GOLDEN.baseMs, bucketMs: MARKER_BUCKET_MS, perBucketSideLimit: MARKERS_PER_BUCKET_SIDE,
    });
    expect(result.available).toBe(true);
    const ranked = [];
    const buckets = new Map();
    for (const { row } of result.rows) {
      const key = `${Math.floor(row.event_time / MINUTE_MS) * MINUTE_MS}:${row.aggressor_side}`;
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    }
    for (const rows of buckets.values()) {
      rows.sort((a, b) => (tradeMagnitude("DXFEED", market, b.price, b.size) - tradeMagnitude("DXFEED", market, a.price, a.size)) || (b.event_time - a.event_time) || (b.id - a.id));
      rows.forEach((row, index) => ranked.push({ minuteMs: Math.floor(row.event_time / MINUTE_MS) * MINUTE_MS - GOLDEN.baseMs, side: row.aggressor_side, rank: index + 1, tradeMs: row.event_time - GOLDEN.baseMs, price: row.price, size: row.size }));
    }
    ranked.sort((a, b) => (a.minuteMs - b.minuteMs) || (a.side === b.side ? 0 : a.side === "BUY" ? -1 : 1) || (a.rank - b.rank));
    expect(ranked).toEqual(testCase.expected.trade_prints.map(row => ({ minuteMs: row.minuteMs, side: row.side, rank: row.rank, tradeMs: row.tradeMs, price: Number(row.price), size: Number(row.size) })));
  });

  test("readDailyNotional is the BUY plus SELL notional of trade_minute per UTC day", () => {
    const dayStart = Math.floor(GOLDEN.baseMs / DAY_MS) * DAY_MS;
    const result = reader.readDailyNotional(SYMBOLS[market].symbol, market, { fromTs: dayStart, toTs: dayStart + DAY_MS });
    expect(result.available).toBe(true);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].dayTs).toBe(dayStart);
    expect(close(result.rows[0].notional, Number(testCase.expected.dailyNotional))).toBe(true);
  });
});
