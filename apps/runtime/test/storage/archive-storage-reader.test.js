const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageDb } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedStorageReader } = require("../../src/storage/dxfeed/dxfeed-storage-reader");
const { createArchiveStorageReader } = require("../../src/storage/archive-storage-reader");
const { MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } = require("../../src/indicators/large-trade/large-trade-detection");
const { VPIN_REMOTE_BACKFILL_SLICE_MS } = require("../../src/server/market-data-server-shared");
const { safeRm } = require("../helpers/temp-files");

// Report 54 phase 3. The archive reader answers the same questions as the live
// storage reader, from pre-computed buckets instead of individual executions.
// The binding check is that both give the same answer for the same trades, so
// this file derives the archive rows from the golden fixture exactly as the
// Python stage does, serves them as archive-query pages, and compares against
// the real live SQL over a real capture database. Oracle: the live reader.
const GOLDEN = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../../../benchmarks/fixtures/golden/trade-families.json"), "utf8"));
const MS_NS = 1_000_000;
const MINUTE_MS = 60_000;
const SYMBOLS = {
  FUTURE: { symbol: "/ESZ26:XCME", venue: "XCME", exchangeCode: "G" },
  EQUITY: { symbol: "AAPL", venue: "NTV", exchangeCode: "L" },
};
const INSTRUMENT_ID = '["XCME","FUTURE","ESU6","USD","CONTRACT"]';

function tempDbPath() {
  return path.join(os.tmpdir(), `archive-storage-reader-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function seed(dbPath, market, trades) {
  const storageDb = createDxFeedStorageDb({ dbPath });
  for (const [index, trade] of trades.entries()) {
    const eventTime = GOLDEN.baseMs + trade.atMs;
    storageDb.insert("dxfeed_time_and_sales", {
      eventTime, receivedAt: eventTime + 1, provider: "DXFEED", venue: SYMBOLS[market].venue, assetClass: market,
      symbol: SYMBOLS[market].symbol, stale: 0, recoveryState: "READY", price: Number(trade.price), size: Number(trade.size),
      time: eventTime, timeNanoPart: 0, sequence: index + 1, exchangeCode: SYMBOLS[market].exchangeCode,
      extendedTradingHours: 0, aggressorSide: trade.side === "UNKNOWN" ? "UNDEFINED" : trade.side, spreadLeg: 0,
      validTick: trade.validTick ? 1 : 0, eventKind: trade.action, providerIndex: null, providerTradeId: index + 1,
      bidPrice: null, askPrice: null,
    });
  }
  storageDb.close();
}

const decimal = (value) => Number(value).toFixed(12);
const nsOf = (ms) => String(BigInt(GOLDEN.baseMs + ms) * BigInt(MS_NS));

/** The golden expectations in the shape the archive publishes and serves. */
function archiveRows(testCase, family) {
  const expected = testCase.expected;
  if (family === "trade_minute_1m") {
    return expected.trade_minute.map((row) => ({
      event_ns: nsOf(row.minuteMs), open_ns: nsOf(row.minuteMs), close_ns: nsOf(row.minuteMs + MINUTE_MS),
      volume: decimal(row.volume), buy_volume: decimal(row.buyVolume), sell_volume: decimal(row.sellVolume),
      undefined_volume: decimal(row.undefinedVolume), buy_notional: decimal(row.buyNotional),
      sell_notional: decimal(row.sellNotional), trade_count: String(row.tradeCount), method: "trade_minute/1",
    }));
  }
  if (family === "trade_level_1m") {
    return expected.trade_level.map((row) => ({
      event_ns: nsOf(row.minuteMs), open_ns: nsOf(row.minuteMs), close_ns: nsOf(row.minuteMs + MINUTE_MS),
      tick_size: decimal(testCase.tickSize), price_bucket: String(row.priceBucket),
      volume: decimal(row.volume), buy_volume: decimal(row.buyVolume), sell_volume: decimal(row.sellVolume),
      trade_count: String(row.tradeCount), method: "trade_level/1",
    }));
  }
  if (family === "trade_slice_2s") {
    return expected.trade_slice.map((row) => ({
      event_ns: nsOf(row.sliceMs), open_ns: nsOf(row.sliceMs), close_ns: nsOf(row.sliceMs + GOLDEN.sliceMs),
      last_trade_ns: nsOf(row.lastTradeMs), buy_notional: decimal(row.buyNotional),
      sell_notional: decimal(row.sellNotional), trade_count: String(row.tradeCount), method: "trade_slice/1",
    }));
  }
  return expected.trade_prints.map((row) => ({
    event_ns: nsOf(row.minuteMs), open_ns: nsOf(row.minuteMs), close_ns: nsOf(row.minuteMs + MINUTE_MS),
    side: row.side, rank: String(row.rank), trade_ns: nsOf(row.tradeMs), price: decimal(row.price),
    size: decimal(row.size), trade_entity_id: row.entity, method: "trade_prints/1",
  }));
}

/** An archive-query transport that pages, so the reader's paging is exercised. */
function pagingFetch(byFamily, { pageSize = 2, onRequest = () => {} } = {}) {
  return async (request) => {
    onRequest(request);
    const rows = byFamily[request.family] ?? [];
    const from = BigInt(request.from);
    const to = BigInt(request.to);
    const inWindow = rows.filter((row) => BigInt(row.event_ns) >= from && BigInt(row.event_ns) < to);
    const offset = request.cursor === null || request.cursor === undefined ? 0 : Number(request.cursor);
    const page = inWindow.slice(offset, offset + pageSize);
    const next = offset + page.length;
    return {
      rows: page,
      nextCursor: next < inWindow.length ? String(next) : null,
      pointerToken: "token-1",
    };
  };
}

function readerFor(testCase, market, options = {}) {
  const byFamily = Object.fromEntries(
    ["trade_minute_1m", "trade_level_1m", "trade_slice_2s", "trade_prints_1m"]
      .map((family) => [family, archiveRows(testCase, family)]));
  return createArchiveStorageReader({
    fetchPage: options.fetchPage ?? pagingFetch(byFamily, options),
    instrumentIdFor: () => INSTRUMENT_ID,
    tickSizeFor: () => Number(testCase.tickSize),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
  });
}

function close(value, expected) {
  return Math.abs(value - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
}

describe.each(Object.entries(GOLDEN.cases))("the archive reader equals the live reader for the %s case", (name, testCase) => {
  const market = testCase.market;
  const from = GOLDEN.baseMs;
  const to = GOLDEN.baseMs + 2 * MINUTE_MS;
  let dbPath;
  let live;
  let archive;

  beforeAll(() => {
    dbPath = tempDbPath();
    seed(dbPath, market, testCase.trades);
    live = createDxFeedStorageReader({ dbPath });
    archive = readerFor(testCase, market);
  });

  afterAll(() => {
    live.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("readMinuteRollup returns the same price-level buckets", async () => {
    const options = { fromTs: from, toTs: to, tickSize: Number(testCase.tickSize) };
    const expected = live.readMinuteRollup(SYMBOLS[market].symbol, market, options);
    const actual = await archive.readMinuteRollup(SYMBOLS[market].symbol, market, options);

    expect(actual.available).toBe(true);
    expect(expected.available).toBe(true);
    expect(actual.rows.map((row) => [row.minuteTs, row.priceBucket, row.volume, row.buyVolume, row.sellVolume, row.tradeCount]))
      .toEqual(expected.rows.map((row) => [row.minuteTs, row.priceBucket, row.volume, row.buyVolume, row.sellVolume, row.tradeCount]));
  });

  test("readPriceRange spans the same traded prices and counts the same executions", async () => {
    const expected = live.readPriceRange(SYMBOLS[market].symbol, market, { fromTs: from, toTs: to });
    const actual = await archive.readPriceRange(SYMBOLS[market].symbol, market, { fromTs: from, toTs: to });

    expect(actual.available).toBe(true);
    expect(actual.tradeCount).toBe(expected.tradeCount);
    const tick = Number(testCase.tickSize);
    // The archive names the floor of each bucket, so its range sits inside the
    // live one by less than a tick at each end.
    expect(actual.minPrice).toBeLessThanOrEqual(expected.minPrice);
    expect(expected.minPrice - actual.minPrice).toBeLessThan(tick);
    expect(actual.maxPrice).toBeLessThanOrEqual(expected.maxPrice);
    expect(expected.maxPrice - actual.maxPrice).toBeLessThan(tick);
  });

  test("readVolumeProfile puts the same volume in the same rows", async () => {
    const options = { fromTs: from, toTs: to, originPrice: 0, rowWidth: Number(testCase.tickSize) };
    const expected = live.readVolumeProfile(SYMBOLS[market].symbol, market, options);
    const actual = await archive.readVolumeProfile(SYMBOLS[market].symbol, market, options);

    expect(actual.available).toBe(true);
    expect(actual.buckets.map((bucket) => bucket.bucket)).toEqual(expected.buckets.map((bucket) => bucket.bucket));
    for (const [index, bucket] of actual.buckets.entries()) {
      expect(close(bucket.volume, expected.buckets[index].volume)).toBe(true);
      expect(close(bucket.buyVolume, expected.buckets[index].buyVolume)).toBe(true);
      expect(close(bucket.sellVolume, expected.buckets[index].sellVolume)).toBe(true);
    }
  });

  test("readSlicedNotional returns the same slices anchored on the same last execution", async () => {
    const options = { fromTs: from, toTs: to, sliceMs: VPIN_REMOTE_BACKFILL_SLICE_MS };
    const expected = live.readSlicedNotional(SYMBOLS[market].symbol, market, options);
    const actual = await archive.readSlicedNotional(SYMBOLS[market].symbol, market, options);

    expect(actual.available).toBe(true);
    expect(actual.rows.map((row) => row.sliceTs)).toEqual(expected.rows.map((row) => row.sliceTs));
    for (const [index, row] of actual.rows.entries()) {
      expect(close(row.buyNotional, expected.rows[index].buyNotional)).toBe(true);
      expect(close(row.sellNotional, expected.rows[index].sellNotional)).toBe(true);
    }
  });

  test("readDailyNotional totals the same day", async () => {
    const options = { fromTs: from, toTs: to };
    const expected = live.readDailyNotional(SYMBOLS[market].symbol, market, options);
    const actual = await archive.readDailyNotional(SYMBOLS[market].symbol, market, options);

    expect(actual.available).toBe(true);
    expect(actual.rows.map((row) => row.dayTs)).toEqual(expected.rows.map((row) => row.dayTs));
    expect(close(actual.rows[0].notional, Number(testCase.expected.dailyNotional))).toBe(true);
    expect(close(actual.rows[0].notional, expected.rows[0].notional)).toBe(true);
  });

  test("readLargeTradesAsync returns the same prints in the same order", async () => {
    const options = {
      nowMs: to - 1, limit: 1_000, fromMs: from,
      bucketMs: MARKER_BUCKET_MS, perBucketSideLimit: MARKERS_PER_BUCKET_SIDE,
    };
    const expected = live.readLargeTrades(SYMBOLS[market].symbol, market, options);
    const actual = await archive.readLargeTradesAsync(SYMBOLS[market].symbol, market, options);

    expect(actual.available).toBe(true);
    const shape = ({ row }) => [row.event_time, row.aggressor_side, row.price, row.size];
    // Both readers select the same prints and order them by execution time.
    // Within one millisecond the live reader falls back to the capture
    // database's rowid -- the order rows happened to be written locally, which
    // is not a property of the market and which the archive has no way to know.
    // Comparing it would pin an artefact, so the prints are compared as a set.
    const ordered = (rows) => [...rows.map(shape)].sort((left, right) =>
      (left[0] - right[0]) || (left[2] - right[2]) || (left[3] - right[3]));
    expect(ordered(actual.rows)).toEqual(ordered(expected.rows));
    expect(actual.rows.map(({ row }) => row.event_time))
      .toEqual([...actual.rows.map(({ row }) => row.event_time)].sort((left, right) => left - right));
  });
});

describe("what the archive cannot answer, it refuses rather than approximates", () => {
  const testCase = GOLDEN.cases.futures;

  test("a slice narrower than the archived two seconds is refused", async () => {
    const archive = readerFor(testCase, "FUTURE");
    await expect(archive.readSlicedNotional(SYMBOLS.FUTURE.symbol, "FUTURE", {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + MINUTE_MS, sliceMs: 1_000,
    })).rejects.toThrow(/sliceMs must be a positive multiple of 2000/);
  });

  test("a row narrower than the archived tick is refused", async () => {
    const archive = readerFor(testCase, "FUTURE");
    await expect(archive.readVolumeProfile(SYMBOLS.FUTURE.symbol, "FUTURE", {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + MINUTE_MS, originPrice: 0, rowWidth: 0.05,
    })).rejects.toThrow(/finer than the archived tick/);
  });

  test("a tick finer than the archived one is refused by the minute rollup", async () => {
    const archive = readerFor(testCase, "FUTURE");
    await expect(archive.readMinuteRollup(SYMBOLS.FUTURE.symbol, "FUTURE", {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + MINUTE_MS, tickSize: 0.05,
    })).rejects.toThrow(/finer than the archived tick/);
  });

  test("trades themselves are not available, and say so instead of returning a partial series", async () => {
    const archive = readerFor(testCase, "FUTURE");
    await expect(archive.readTradesSince()).resolves.toEqual({ rows: [], nextCursor: null, available: false });
  });

  test("a minute whose explicit sides do not conserve volume is rejected", async () => {
    const rows = archiveRows(testCase, "trade_minute_1m");
    rows[0] = { ...rows[0], undefined_volume: decimal(Number(rows[0].undefined_volume) + 1) };
    const archive = readerFor(testCase, "FUTURE", {
      fetchPage: pagingFetch({ trade_minute_1m: rows }),
    });

    await expect(archive.readMinuteFlow(SYMBOLS.FUTURE.symbol, "FUTURE", {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS,
    })).rejects.toThrow(/side volumes do not equal total volume/);
  });

  test("a window that outruns the page budget is unavailable, never silently short", async () => {
    const archive = readerFor(testCase, "FUTURE", { pageSize: 1, maxPages: 1 });
    const answer = await archive.readMinuteRollup(SYMBOLS.FUTURE.symbol, "FUTURE", {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS, tickSize: 0.25,
    });

    expect(answer).toEqual({ rows: [], available: false });
  });
});

describe("a long range is split into requests the query service will accept, not capped", () => {
  const { REQUEST_WINDOW_MS } = require("../../src/storage/archive-storage-reader");
  const DAY_MS = 86_400_000;

  test("the request windows are the query service's own per-family caps", () => {
    // Pattern AL: these are copies of limits the Python service enforces; the
    // contract schema is the authority both sides must agree with.
    const schema = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "../../../../docs/contracts/archive-query/v1/archive-query-v1.schema.json"), "utf8"));
    const limits = schema.$defs.windowLimitNs.properties;
    for (const [family, windowMs] of Object.entries(REQUEST_WINDOW_MS)) {
      expect(BigInt(windowMs) * BigInt(MS_NS)).toBe(BigInt(limits[family].const));
    }
  });

  test("a sixty-day profile is read as seven-day requests and merged exactly", async () => {
    const tick = 0.25;
    const start = Date.UTC(2026, 0, 1);
    const rows = [];
    for (let day = 0; day < 60; day += 1) {
      const open = start + day * DAY_MS + 13 * 3_600_000;
      rows.push({
        event_ns: String(BigInt(open) * BigInt(MS_NS)), open_ns: String(BigInt(open) * BigInt(MS_NS)),
        close_ns: String(BigInt(open + MINUTE_MS) * BigInt(MS_NS)), tick_size: "0.250000000000",
        price_bucket: String(20_000 + (day % 5)), volume: "3.000000000000", buy_volume: "2.000000000000",
        sell_volume: "1.000000000000", trade_count: "2", method: "trade_level/1",
      });
    }
    const windows = [];
    const refusingFetch = async (request) => {
      const span = Number((BigInt(request.to) - BigInt(request.from)) / BigInt(MS_NS));
      windows.push(span);
      if (span > REQUEST_WINDOW_MS[request.family]) return null;
      const from = BigInt(request.from);
      const to = BigInt(request.to);
      return { rows: rows.filter((row) => BigInt(row.event_ns) >= from && BigInt(row.event_ns) < to), nextCursor: null };
    };
    const archive = createArchiveStorageReader({
      fetchPage: refusingFetch, instrumentIdFor: () => INSTRUMENT_ID, tickSizeFor: () => tick,
    });

    const profile = await archive.readVolumeProfile("NQ", "FUTURE", {
      fromTs: start, toTs: start + 60 * DAY_MS, originPrice: 0, rowWidth: tick,
    });

    expect(profile.available).toBe(true);
    expect(windows.length).toBe(Math.ceil(60 / 7));
    expect(Math.max(...windows)).toBeLessThanOrEqual(REQUEST_WINDOW_MS.trade_level_1m);
    expect(profile.buckets.reduce((sum, bucket) => sum + bucket.volume, 0)).toBe(180);
    expect(profile.buckets.map((bucket) => bucket.bucket)).toEqual([20_000, 20_001, 20_002, 20_003, 20_004]);
  });

  test("the price range and the profile of one window read the price levels once", async () => {
    let requests = 0;
    const archive = readerFor(GOLDEN.cases.futures, "FUTURE", { onRequest: () => { requests += 1; } });
    const window = { fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS };
    await archive.readPriceRange(SYMBOLS.FUTURE.symbol, "FUTURE", window);
    const afterRange = requests;
    await archive.readVolumeProfile(SYMBOLS.FUTURE.symbol, "FUTURE", { ...window, originPrice: 0, rowWidth: 0.25 });

    expect(afterRange).toBeGreaterThan(0);
    expect(requests).toBe(afterRange);
  });

  test("the same sliced window is read once, so consecutive VPIN weeks share the lead-in they overlap", async () => {
    let requests = 0;
    const archive = readerFor(GOLDEN.cases.futures, "FUTURE", { onRequest: () => { requests += 1; } });
    const window = { fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS, sliceMs: 2_000 };
    const first = await archive.readSlicedNotional(SYMBOLS.FUTURE.symbol, "FUTURE", window);
    const afterFirst = requests;
    const second = await archive.readSlicedNotional(SYMBOLS.FUTURE.symbol, "FUTURE", window);
    const afterSecond = requests;
    const other = await archive.readSlicedNotional(SYMBOLS.FUTURE.symbol, "FUTURE", { ...window, fromTs: window.toTs, toTs: window.toTs + 2 * MINUTE_MS });

    expect(afterFirst).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(afterSecond).toBe(afterFirst);
    expect(requests).toBeGreaterThan(afterSecond);
    expect(other.available).toBe(true);
  });
});

describe.each(Object.entries(GOLDEN.cases))("prints thinned to a coarser bar keep the biggest of that bar (%s)", (name, testCase) => {
  const market = testCase.market;
  const HOUR_MS = 3_600_000;
  let dbPath;
  let live;

  beforeAll(() => {
    dbPath = tempDbPath();
    seed(dbPath, market, testCase.trades);
    live = createDxFeedStorageReader({ dbPath });
  });

  afterAll(() => {
    live.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("an hour bar keeps the same prints the live reader keeps for an hour bucket", async () => {
    // A print outside the four largest of its minute cannot be among the four
    // largest of its hour, so re-ranking the stored per-minute winners by size
    // is exact; the live reader, ranking raw executions per hour, is the oracle.
    const options = {
      nowMs: GOLDEN.baseMs + 2 * MINUTE_MS - 1, limit: 1_000, fromMs: GOLDEN.baseMs,
      bucketMs: HOUR_MS, perBucketSideLimit: MARKERS_PER_BUCKET_SIDE,
    };
    const expected = live.readLargeTrades(SYMBOLS[market].symbol, market, options);
    const actual = await readerFor(testCase, market).readLargeTradesAsync(SYMBOLS[market].symbol, market, options);

    const shape = ({ row }) => [row.event_time, row.aggressor_side, row.price, row.size];
    const ordered = (rows) => [...rows.map(shape)].sort((left, right) =>
      (left[0] - right[0]) || (left[2] - right[2]) || (left[3] - right[3]));
    expect(actual.available).toBe(true);
    expect(ordered(actual.rows)).toEqual(ordered(expected.rows));
  });
});

describe("coarser geometry is aggregated, not re-read", () => {
  const testCase = GOLDEN.cases.futures;

  test("a four-second slice merges two archived slices and keeps the later execution", async () => {
    const archive = readerFor(testCase, "FUTURE");
    const fine = await archive.readSlicedNotional(SYMBOLS.FUTURE.symbol, "FUTURE", {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + MINUTE_MS, sliceMs: 2_000,
    });
    const coarse = await archive.readSlicedNotional(SYMBOLS.FUTURE.symbol, "FUTURE", {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + MINUTE_MS, sliceMs: 4_000,
    });

    expect(coarse.rows.length).toBeLessThan(fine.rows.length);
    const total = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0);
    expect(close(total(coarse.rows, "buyNotional"), total(fine.rows, "buyNotional"))).toBe(true);
    expect(close(total(coarse.rows, "sellNotional"), total(fine.rows, "sellNotional"))).toBe(true);
    expect(coarse.rows.every((row) => fine.rows.some((candidate) => candidate.sliceTs === row.sliceTs))).toBe(true);
  });

  test("a request only ever asks for the family it needs", async () => {
    const asked = [];
    const archive = readerFor(testCase, "FUTURE", { onRequest: (request) => asked.push(request.family) });
    await archive.readDailyNotional(SYMBOLS.FUTURE.symbol, "FUTURE", {
      fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + MINUTE_MS,
    });

    expect([...new Set(asked)]).toEqual(["trade_minute_1m"]);
  });
});

// Report 57 W1, GE-14: the archive fold is the one choke point for every
// Historical Mode study, so equity rows outside the regular session never
// reach a study, whichever family carries them; futures keep every hour.
describe("archive equity studies are regular-session only (GE-14)", () => {
  const PRE = Date.parse("2026-09-23T12:00:00Z"); // 08:00 EDT
  const RTH = Date.parse("2026-09-23T14:00:00Z"); // 10:00 EDT
  const POST = Date.parse("2026-09-23T21:00:00Z"); // 17:00 EDT
  const ns = (ms) => String(BigInt(ms) * BigInt(MS_NS));
  const minute = (ms, notional) => ({
    event_ns: ns(ms), open_ns: ns(ms), close_ns: ns(ms + MINUTE_MS), volume: decimal(1), buy_volume: decimal(1), sell_volume: decimal(0),
    undefined_volume: decimal(0), buy_notional: decimal(notional), sell_notional: decimal(0), trade_count: "1", method: "trade_minute/1",
  });
  const print = (ms, rank) => ({
    event_ns: ns(ms - (ms % MINUTE_MS)), open_ns: ns(ms - (ms % MINUTE_MS)), close_ns: ns(ms - (ms % MINUTE_MS) + MINUTE_MS),
    side: "BUY", rank: String(rank), trade_ns: ns(ms), price: decimal(100), size: decimal(1000), trade_entity_id: `e${rank}`, method: "trade_prints/1",
  });
  const byFamily = {
    trade_minute_1m: [minute(PRE, 1), minute(RTH, 10), minute(POST, 100)],
    trade_prints_1m: [print(PRE + 5_000, 1), print(RTH + 5_000, 2), print(POST + 5_000, 3)],
  };
  const reader = () => createArchiveStorageReader({ fetchPage: pagingFetch(byFamily, { pageSize: 1 }), instrumentIdFor: () => INSTRUMENT_ID, tickSizeFor: () => 0.01 });
  const window = { fromTs: PRE, toTs: POST + MINUTE_MS };
  const prints = { nowMs: POST + MINUTE_MS, limit: 10, fromMs: PRE, bucketMs: MINUTE_MS, perBucketSideLimit: 5 };

  test("equity: only the regular-session minute and print survive, across page boundaries", async () => {
    await expect(reader().readDailyNotional("AAPL", "EQUITY", window)).resolves.toEqual({ rows: [{ dayTs: RTH - (RTH % 86_400_000), notional: 10 }], available: true });
    const large = await reader().readLargeTradesAsync("AAPL", "EQUITY", prints);
    expect(large.rows.map(({ row }) => row.event_time)).toEqual([RTH + 5_000]);
  });

  test("futures: every hour is kept", async () => {
    await expect(reader().readDailyNotional("/ESZ26:XCME", "FUTURE", window)).resolves.toEqual({ rows: [{ dayTs: RTH - (RTH % 86_400_000), notional: 111 }], available: true });
    const large = await reader().readLargeTradesAsync("/ESZ26:XCME", "FUTURE", prints);
    expect(large.rows).toHaveLength(3);
  });
});
