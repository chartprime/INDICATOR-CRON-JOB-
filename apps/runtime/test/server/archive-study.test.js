const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageDb } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedStorageReader } = require("../../src/storage/dxfeed/dxfeed-storage-reader");
const { createArchiveStorageReader } = require("../../src/storage/archive-storage-reader");
const { createSegmentedArchiveReader } = require("../../src/storage/segmented-archive-reader");
const {
  runStudy, validateStudy, WEEK_MS, FIRST_MONDAY_MS, VPIN_LEAD_IN_MS, MAX_PRINT_BARS, MAX_BAR_FLOW_BARS,
} = require("../../src/server/archive-study");
const { VPIN_CALIBRATION_WINDOW_MS } = require("../../src/server/market-data-server-shared");
const { computeVpin } = require("../../src/indicators/vpin/vpin-compute");
const { createDxFeedVolumeProfileAdapter } = require("../../src/indicators/volume-profile/volume-profile-adapters");
const { safeRm } = require("../helpers/temp-files");

// Report 54 phase 3. A study is the live engine run over a reader. The live
// SQLite reader and the archive reader expose the same surface, so the oracle
// for every study is the same study run over the live capture database with
// the same trades: any difference is the archive's, not the engine's.
const GOLDEN = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../../../benchmarks/fixtures/golden/trade-families.json"), "utf8"));
const MS_NS = 1_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SYMBOLS = {
  FUTURE: { symbol: "/ESZ26:XCME", venue: "XCME", exchangeCode: "G" },
  EQUITY: { symbol: "AAPL", venue: "NTV", exchangeCode: "L" },
};

function tempDbPath() {
  return path.join(os.tmpdir(), `archive-study-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
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

function archiveRows(testCase) {
  const expected = testCase.expected;
  return {
    trade_minute_1m: expected.trade_minute.map((row) => ({
      event_ns: nsOf(row.minuteMs), open_ns: nsOf(row.minuteMs), close_ns: nsOf(row.minuteMs + MINUTE_MS),
      volume: decimal(row.volume), buy_volume: decimal(row.buyVolume), sell_volume: decimal(row.sellVolume),
      undefined_volume: decimal(row.undefinedVolume), buy_notional: decimal(row.buyNotional),
      sell_notional: decimal(row.sellNotional), trade_count: String(row.tradeCount), method: "trade_minute/1",
    })),
    trade_level_1m: expected.trade_level.map((row) => ({
      event_ns: nsOf(row.minuteMs), open_ns: nsOf(row.minuteMs), close_ns: nsOf(row.minuteMs + MINUTE_MS),
      tick_size: decimal(testCase.tickSize), price_bucket: String(row.priceBucket),
      volume: decimal(row.volume), buy_volume: decimal(row.buyVolume), sell_volume: decimal(row.sellVolume),
      trade_count: String(row.tradeCount), method: "trade_level/1",
    })),
    trade_slice_2s: expected.trade_slice.map((row) => ({
      event_ns: nsOf(row.sliceMs), open_ns: nsOf(row.sliceMs), close_ns: nsOf(row.sliceMs + GOLDEN.sliceMs),
      last_trade_ns: nsOf(row.lastTradeMs), buy_notional: decimal(row.buyNotional),
      sell_notional: decimal(row.sellNotional), trade_count: String(row.tradeCount), method: "trade_slice/1",
    })),
    trade_prints_1m: expected.trade_prints.map((row) => ({
      event_ns: nsOf(row.minuteMs), open_ns: nsOf(row.minuteMs), close_ns: nsOf(row.minuteMs + MINUTE_MS),
      side: row.side, rank: String(row.rank), trade_ns: nsOf(row.tradeMs), price: decimal(row.price),
      size: decimal(row.size), trade_entity_id: row.entity, method: "trade_prints/1",
    })),
  };
}

function servingFetch(byInstrument, requests = []) {
  return async (request) => {
    requests.push(request);
    const rows = byInstrument[request.instrumentId]?.[request.family] ?? [];
    const from = BigInt(request.from);
    const to = BigInt(request.to);
    return { rows: rows.filter((row) => BigInt(row.event_ns) >= from && BigInt(row.event_ns) < to), nextCursor: null };
  };
}

function printsShape(result) {
  return [...result.prints].map((print) => [print.ts_exchange, print.side, print.price, print.size])
    .sort((left, right) => (left[0] - right[0]) || (left[2] - right[2]) || (left[3] - right[3]));
}

describe.each(Object.entries(GOLDEN.cases))("a study over the archive equals the same study over the live capture (%s)", (name, testCase) => {
  const market = testCase.market;
  const symbol = SYMBOLS[market].symbol;
  const tickSize = Number(testCase.tickSize);
  const window = { fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS };
  let dbPath;
  let live;

  function archiveReader() {
    return createArchiveStorageReader({
      fetchPage: servingFetch({ one: archiveRows(testCase) }),
      instrumentIdFor: () => "one",
      tickSizeFor: () => tickSize,
    });
  }

  beforeAll(() => {
    dbPath = tempDbPath();
    seed(dbPath, market, testCase.trades);
    live = createDxFeedStorageReader({ dbPath });
  });

  afterAll(() => {
    live.close();
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test.each([["one minute", MINUTE_MS], ["one hour", HOUR_MS]])("large prints per %s bar", async (_label, bucketMs) => {
    const aligned = { fromTs: Math.floor(window.fromTs / bucketMs) * bucketMs, toTs: Math.ceil(window.toTs / bucketMs) * bucketMs };
    const request = { symbol, study: "large_prints", assetClass: market, tickSize, ranges: [aligned], requestId: 1, options: { bucketMs } };
    const expected = await runStudy({ ...request, reader: live });
    const actual = await runStudy({ ...request, reader: archiveReader() });

    expect(actual.complete).toBe(true);
    expect(printsShape(actual)).toEqual(printsShape(expected));
    expect(actual.prints.length).toBeGreaterThan(0);
  });

  test.each([["one minute", MINUTE_MS], ["one hour", HOUR_MS]])("the buy/sell split of a %s bar equals the live reader's own minutes", async (_label, bucketMs) => {
    const aligned = { fromTs: Math.floor(window.fromTs / bucketMs) * bucketMs, toTs: Math.ceil(window.toTs / bucketMs) * bucketMs };
    const actual = await runStudy({
      symbol, study: "bar_flow", assetClass: market, tickSize, ranges: [aligned], requestId: 1,
      options: { bucketMs }, reader: archiveReader(),
    });

    const liveRollup = await live.readMinuteRollup(symbol, market, { ...aligned, tickSize });
    const expected = new Map();
    for (const row of liveRollup.rows) {
      const tsOpen = Math.floor(row.minuteTs / bucketMs) * bucketMs;
      const bar = expected.get(tsOpen) ?? { ts_open: tsOpen, volume: 0, buy_volume: 0, sell_volume: 0 };
      bar.volume += row.volume;
      bar.buy_volume += row.buyVolume;
      bar.sell_volume += row.sellVolume;
      expected.set(tsOpen, bar);
    }

    expect(actual.complete).toBe(true);
    expect(actual.bars.map(({ ts_open, volume, buy_volume, sell_volume }) => ({ ts_open, volume, buy_volume, sell_volume })))
      .toEqual([...expected.values()].sort((left, right) => left.ts_open - right.ts_open));
    expect(actual.bars.length).toBeGreaterThan(0);
    for (const bar of actual.bars) {
      expect(bar.buy_volume + bar.sell_volume + bar.unknown_volume).toBeCloseTo(bar.volume, 9);
    }
    // Where the fixture carries UNDEFINED-side executions, they stay out of both
    // sides: counted in volume, reported as unknown, never as selling.
    const unsided = testCase.expected.trade_minute.reduce((sum, row) => sum + Number(row.undefinedVolume), 0);
    expect(actual.bars.reduce((sum, bar) => sum + bar.unknown_volume, 0)).toBeCloseTo(unsided, 9);
    expect(actual.bars.every((bar) => bar.buy_volume + bar.sell_volume <= bar.volume)).toBe(true);
    expect(actual.bars.some((bar) => bar.buy_volume + bar.sell_volume < bar.volume)).toBe(unsided > 0);
  });

  test("a volume profile over the range", async () => {
    const request = {
      symbol, study: "volume_profile", assetClass: market, tickSize, ranges: [window], requestId: 3,
      options: { mode: "fixed_range", ticksPerRow: 1 },
    };
    const expected = await runStudy({ ...request, reader: live });
    const actual = await runStudy({ ...request, reader: archiveReader() });

    expect(actual.complete).toBe(true);
    expect(actual.profiles).toHaveLength(1);
    const volumes = (profile) => profile.buckets.map((bucket) => [bucket.price, bucket.volume, bucket.buy_volume, bucket.sell_volume]);
    expect(volumes(actual.profiles[0])).toEqual(volumes(expected.profiles[0]));
    expect(actual.profiles[0].poc_price).toBe(expected.profiles[0].poc_price);
    expect(actual.profiles[0].delivery_scope).toBe("HISTORICAL");
    expect(actual.profiles[0].history_request_id).toBe(3);
  });
});

describe("a contract roll is stitched, not dropped", () => {
  const testCase = GOLDEN.cases.futures;
  const tickSize = Number(testCase.tickSize);
  const boundary = GOLDEN.baseMs + MINUTE_MS;
  const whole = archiveRows(testCase);
  const before = {};
  const after = {};
  for (const [family, rows] of Object.entries(whole)) {
    before[family] = rows.filter((row) => BigInt(row.event_ns) < BigInt(boundary) * BigInt(MS_NS));
    after[family] = rows.filter((row) => BigInt(row.event_ns) >= BigInt(boundary) * BigInt(MS_NS));
  }

  test("a range across two contracts reads each for its own stretch and merges to the single-contract answer", async () => {
    const requests = [];
    const segmented = createSegmentedArchiveReader({
      segments: [
        { instrumentId: "ESU6", fromTs: GOLDEN.baseMs, toTs: boundary },
        { instrumentId: "ESZ6", fromTs: boundary, toTs: GOLDEN.baseMs + 2 * MINUTE_MS },
      ],
      fetchPage: servingFetch({ ESU6: before, ESZ6: after }, requests),
    });
    const single = createArchiveStorageReader({
      fetchPage: servingFetch({ one: whole }), instrumentIdFor: () => "one", tickSizeFor: () => tickSize,
    });
    const request = {
      symbol: "ES", study: "volume_profile", assetClass: "FUTURE", tickSize, requestId: 1,
      ranges: [{ fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS }], options: { mode: "fixed_range", ticksPerRow: 1 },
    };

    const stitched = await runStudy({ ...request, reader: segmented });
    const reference = await runStudy({ ...request, reader: single });

    expect(stitched.profiles).toEqual(reference.profiles);
    expect(new Set(requests.map((entry) => entry.instrumentId))).toEqual(new Set(["ESU6", "ESZ6"]));
    for (const entry of requests) {
      const from = Number(BigInt(entry.from) / BigInt(MS_NS));
      const to = Number(BigInt(entry.to) / BigInt(MS_NS));
      expect(entry.instrumentId === "ESU6" ? to <= boundary : from >= boundary).toBe(true);
    }
  });

  test("a bar's buy/sell split across two contracts equals the single-contract answer", async () => {
    const segmented = createSegmentedArchiveReader({
      segments: [
        { instrumentId: "ESU6", fromTs: GOLDEN.baseMs, toTs: boundary },
        { instrumentId: "ESZ6", fromTs: boundary, toTs: GOLDEN.baseMs + 2 * MINUTE_MS },
      ],
      fetchPage: servingFetch({ ESU6: before, ESZ6: after }),
    });
    const single = createArchiveStorageReader({
      fetchPage: servingFetch({ one: whole }), instrumentIdFor: () => "one", tickSizeFor: () => tickSize,
    });
    const request = {
      symbol: "ES", study: "bar_flow", assetClass: "FUTURE", tickSize, requestId: 1,
      ranges: [{ fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 2 * MINUTE_MS }], options: { bucketMs: 2 * MINUTE_MS },
    };

    const stitched = await runStudy({ ...request, reader: segmented });
    const reference = await runStudy({ ...request, reader: single });

    expect(stitched.bars).toEqual(reference.bars);
    expect(stitched.bars).toHaveLength(1);
    expect(stitched.complete).toBe(true);
  });

  test("overlapping or unaligned contract stretches are refused", () => {
    expect(() => createSegmentedArchiveReader({
      segments: [{ instrumentId: "A", fromTs: 0, toTs: 2 * MINUTE_MS }, { instrumentId: "B", fromTs: MINUTE_MS, toTs: 3 * MINUTE_MS }],
      fetchPage: async () => null,
    })).toThrow(/must not overlap/);
    expect(() => createSegmentedArchiveReader({
      segments: [{ instrumentId: "A", fromTs: 1, toTs: MINUTE_MS }],
      fetchPage: async () => null,
    })).toThrow(/start and end on a minute/);
  });

  test("a read outside the declared segment coverage is unavailable rather than silently clipped", async () => {
    const segmented = createSegmentedArchiveReader({
      segments: [{ instrumentId: "ESU6", fromTs: boundary, toTs: GOLDEN.baseMs + 2 * MINUTE_MS }],
      fetchPage: servingFetch({ ESU6: after }),
    });

    await expect(segmented.readDailyNotional("ES", "FUTURE", {
      fromTs: GOLDEN.baseMs,
      toTs: GOLDEN.baseMs + 2 * MINUTE_MS,
    })).resolves.toEqual({ rows: [], available: false });
  });
});

describe("VPIN is computed per UTC week, so a reading never depends on the viewport", () => {
  const WEEK_0 = FIRST_MONDAY_MS + 2_900 * WEEK_MS;

  function syntheticReader(calls) {
    const notionalAt = (minute) => {
      const phase = Math.floor(minute / 180) % 4;
      const imbalance = [0.2, 0.5, 0.8, 0.5][phase];
      return { buy: 1_000_000 * imbalance, sell: 1_000_000 * (1 - imbalance) };
    };
    return {
      readDailyNotional: async (_symbol, _assetClass, { fromTs, toTs }) => {
        calls.push({ read: "daily", fromTs, toTs });
        const rows = [];
        for (let day = Math.ceil(fromTs / DAY_MS) * DAY_MS; day < toTs; day += DAY_MS) rows.push({ dayTs: day, notional: 1_440 * 1_000_000 });
        return { rows, available: true };
      },
      readSlicedNotional: async (_symbol, _assetClass, { fromTs, toTs }) => {
        calls.push({ read: "sliced", fromTs, toTs });
        const rows = [];
        for (let minute = Math.ceil(fromTs / MINUTE_MS) * MINUTE_MS; minute < toTs; minute += MINUTE_MS) {
          const { buy, sell } = notionalAt(minute / MINUTE_MS);
          rows.push({ sliceTs: minute + 1_000, buyNotional: buy, sellNotional: sell });
        }
        return { rows, available: true };
      },
      readVolumeProfile: async () => ({ buckets: [], available: false }),
      readTradesSince: async () => ({ rows: [], nextCursor: null, available: false }),
    };
  }

  function vpinRequest(fromTs, toTs) {
    return { symbol: "NQ", study: "vpin", assetClass: "FUTURE", tickSize: 0.25, ranges: [{ fromTs, toTs }], requestId: 1 };
  }

  test("a week's readings are identical whether it is asked for alone or inside a longer range", async () => {
    const alone = await runStudy({ ...vpinRequest(WEEK_0 + WEEK_MS, WEEK_0 + 2 * WEEK_MS), reader: syntheticReader([]) });
    const inside = await runStudy({ ...vpinRequest(WEEK_0, WEEK_0 + 2 * WEEK_MS), reader: syntheticReader([]) });

    const secondWeek = inside.readings.filter((reading) => reading.seal_ts >= WEEK_0 + WEEK_MS);
    expect(alone.complete).toBe(true);
    expect(alone.readings.length).toBeGreaterThan(0);
    expect(secondWeek).toEqual(alone.readings);
  });

  test("each week warms up from the live lead-in and calibrates on the weeks before it", async () => {
    const calls = [];
    await runStudy({ ...vpinRequest(WEEK_0, WEEK_0 + WEEK_MS), reader: syntheticReader(calls) });

    const daily = calls.filter((call) => call.read === "daily");
    const sliced = calls.filter((call) => call.read === "sliced");
    expect(daily).toEqual([{ read: "daily", fromTs: WEEK_0 - VPIN_CALIBRATION_WINDOW_MS, toTs: WEEK_0 }]);
    expect(Math.min(...sliced.map((call) => call.fromTs))).toBe(WEEK_0 - VPIN_LEAD_IN_MS);
    expect(Math.max(...sliced.map((call) => call.toTs))).toBe(WEEK_0 + WEEK_MS);
    expect(VPIN_LEAD_IN_MS).toBe(7 * DAY_MS);
  });

  test("the host reads the slices a week at a time, on the week grid, so a later week reuses the lead-in it shares", async () => {
    const calls = [];
    await runStudy({ ...vpinRequest(WEEK_0, WEEK_0 + 2 * WEEK_MS), reader: syntheticReader(calls) });

    const sliced = calls.filter((call) => call.read === "sliced").map((call) => [call.fromTs, call.toTs]);
    expect(sliced).toEqual([
      [WEEK_0 - WEEK_MS, WEEK_0], [WEEK_0, WEEK_0 + WEEK_MS],
      [WEEK_0, WEEK_0 + WEEK_MS], [WEEK_0 + WEEK_MS, WEEK_0 + 2 * WEEK_MS],
    ]);
    expect(new Set(sliced.map((window) => window.join(":"))).size).toBe(3);
  });

  test("the chunk size is a read-shape choice: the readings are identical at the live six-hour chunk", async () => {
    const adapterFor = (calls) => createDxFeedVolumeProfileAdapter(syntheticReader(calls), "NQ", "FUTURE");
    const week = async (chunkMs) => (await computeVpin({
      adapter: adapterFor([]), tickSize: 0.25, nowMs: WEEK_0 + WEEK_MS, calibrationEndTs: WEEK_0,
      calibrationWindowMs: VPIN_CALIBRATION_WINDOW_MS, backfillWindowMs: VPIN_LEAD_IN_MS + WEEK_MS,
      engineOptions: { nBaseline: 100 },
      backfill: { backfillMode: "SLICED_APPROXIMATE", sliceMs: 2_000, chunkMs },
    })).history;

    expect(await week(6 * HOUR_MS)).toEqual(await week(WEEK_MS));
  });

  test("every reading returned belongs to the weeks asked for", async () => {
    const result = await runStudy({ ...vpinRequest(WEEK_0, WEEK_0 + 2 * WEEK_MS), reader: syntheticReader([]) });

    expect(result.readings.every((reading) => reading.seal_ts >= WEEK_0 && reading.seal_ts < WEEK_0 + 2 * WEEK_MS)).toBe(true);
  });
});

describe("a period the market was closed is empty, not missing", () => {
  const day = FIRST_MONDAY_MS + 2_900 * WEEK_MS;
  const closed = {
    readPriceRange: async () => ({ minPrice: null, maxPrice: null, tradeCount: 0, available: true }),
    readVolumeProfile: async () => ({ buckets: [], available: true }),
    readTradesSince: async () => ({ rows: [], nextCursor: null, available: false }),
  };
  const unreadable = { ...closed, readPriceRange: async () => ({ minPrice: null, maxPrice: null, tradeCount: 0, available: false }) };
  const request = (reader) => runStudy({
    reader, symbol: "ES", study: "volume_profile", assetClass: "FUTURE", tickSize: 0.25, requestId: 1,
    ranges: [{ fromTs: day, toTs: day + DAY_MS }], options: { mode: "continuous" },
  });

  test("a day with no trades is reported empty and the study is still complete", async () => {
    const result = await request(closed);

    expect(result).toMatchObject({ complete: true, missing: [], profiles: [] });
    expect(result.empty).toEqual([{ fromTs: day, toTs: day + DAY_MS }]);
  });

  test("a day the archive cannot read is still missing, never empty", async () => {
    const result = await request(unreadable);

    expect(result).toMatchObject({ complete: false, empty: [], profiles: [] });
    expect(result.missing).toEqual([{ fromTs: day, toTs: day + DAY_MS }]);
  });
});

describe("what a study cannot answer as asked, it refuses by name", () => {
  const base = { symbol: "ES", assetClass: "FUTURE", tickSize: 0.25, requestId: 1 };
  const monday = FIRST_MONDAY_MS + 2_900 * WEEK_MS;

  test.each([
    ["an unknown study", { study: "footprint", ranges: [{ fromTs: 0, toTs: MINUTE_MS }] }, "UNKNOWN_STUDY"],
    ["a VPIN range that is not whole UTC weeks", { study: "vpin", ranges: [{ fromTs: monday + DAY_MS, toTs: monday + WEEK_MS }] }, "VPIN_RANGE_NOT_WHOLE_WEEKS"],
    ["print bars that are not whole minutes", { study: "large_prints", ranges: [{ fromTs: 0, toTs: MINUTE_MS }], options: { bucketMs: 30_000 } }, "PRINT_BUCKET_NOT_WHOLE_MINUTES"],
    ["a print range not on the bar grid", { study: "large_prints", ranges: [{ fromTs: MINUTE_MS, toTs: HOUR_MS * 2 }], options: { bucketMs: HOUR_MS } }, "PRINT_RANGE_NOT_BAR_ALIGNED"],
    ["more bars than one request carries", { study: "large_prints", ranges: [{ fromTs: 0, toTs: (MAX_PRINT_BARS + 1) * MINUTE_MS }], options: { bucketMs: MINUTE_MS } }, "TOO_MANY_BARS"],
    ["flow bars that are not whole minutes", { study: "bar_flow", ranges: [{ fromTs: 0, toTs: MINUTE_MS }], options: { bucketMs: 30_000 } }, "FLOW_BUCKET_NOT_WHOLE_MINUTES"],
    ["a flow range off the bar grid", { study: "bar_flow", ranges: [{ fromTs: MINUTE_MS, toTs: 2 * HOUR_MS }], options: { bucketMs: HOUR_MS } }, "FLOW_RANGE_NOT_BAR_ALIGNED"],
    ["more flow bars than one request carries", { study: "bar_flow", ranges: [{ fromTs: 0, toTs: (MAX_BAR_FLOW_BARS + 1) * MINUTE_MS }], options: { bucketMs: MINUTE_MS } }, "FLOW_TOO_MANY_BARS"],
    ["two ranges for one flow request", { study: "bar_flow", ranges: [{ fromTs: 0, toTs: MINUTE_MS }, { fromTs: MINUTE_MS, toTs: 2 * MINUTE_MS }], options: { bucketMs: MINUTE_MS } }, "SINGLE_RANGE_REQUIRED"],
    ["an unknown profile mode", { study: "volume_profile", ranges: [{ fromTs: 0, toTs: MINUTE_MS }], options: { mode: "session" } }, "UNKNOWN_PROFILE_MODE"],
    ["overlapping ranges", { study: "volume_profile", ranges: [{ fromTs: 0, toTs: 2 * MINUTE_MS }, { fromTs: MINUTE_MS, toTs: 3 * MINUTE_MS }], options: { mode: "per_candle" } }, "RANGES_OVERLAP_OR_UNORDERED"],
  ])("%s", (_label, fields, reason) => {
    expect(() => validateStudy({ ...base, options: {}, ...fields })).toThrow(expect.objectContaining({ reason }));
  });

  test("a long range is not refused for its length", () => {
    const year = 365 * DAY_MS;
    expect(() => validateStudy({ ...base, study: "volume_profile", ranges: [{ fromTs: 0, toTs: year }], options: { mode: "fixed_range" } })).not.toThrow();
    expect(() => validateStudy({ ...base, study: "large_prints", ranges: [{ fromTs: 0, toTs: year }], options: { bucketMs: DAY_MS } })).not.toThrow();
  });
});

describe("crypto trade families through the archive study reader", () => {
  const start = Math.floor(GOLDEN.baseMs / MINUTE_MS) * MINUTE_MS;
  const minute = {
    event_ns: String(BigInt(start) * 1_000_000n),
    open_ns: String(BigInt(start) * 1_000_000n),
    volume: "3.000000", buy_volume: "1.000000", sell_volume: "1.000000",
    undefined_volume: "1.000000", buy_notional: "100.000000",
    sell_notional: "100.000000", trade_count: "3",
  };
  const prints = [
    { event_ns: minute.event_ns, trade_ns: String(BigInt(start + 1_000) * 1_000_000n),
      side: "BUY", rank: "1", price: "100", size: "1" },
    { event_ns: minute.event_ns, trade_ns: String(BigInt(start + 2_000) * 1_000_000n),
      side: "BUY", rank: "2", price: "200", size: "0.75" },
  ];
  const reader = createArchiveStorageReader({
    instrumentIdFor: () => '["BINANCE","PERPETUAL","BTCUSDT","USDT","COIN"]',
    tickSizeFor: () => 0.1,
    fetchPage: async (request) => ({
      rows: (request.family === "trade_minute_1m" ? [minute] : request.family === "trade_prints_1m" ? prints : [])
        .filter((row) => BigInt(row.event_ns) >= BigInt(request.from) && BigInt(row.event_ns) < BigInt(request.to)),
      nextCursor: null,
    }),
  });

  test("spot and perpetual flow preserve unsided volume", async () => {
    for (const assetClass of ["SPOT", "PERPETUAL"]) {
      const answer = await runStudy({ reader, symbol: "BTCUSDT", assetClass, tickSize: assetClass === "SPOT" ? 0.01 : 0.1,
        study: "bar_flow", requestId: 1, ranges: [{ fromTs: start, toTs: start + MINUTE_MS }],
        options: { bucketMs: MINUTE_MS } });
      expect(answer).toMatchObject({ complete: true, bars: [{ volume: 3, buy_volume: 1, sell_volume: 1, unknown_volume: 1 }] });
    }
  });

  test("perpetual prints rank by quote notional rather than base size", async () => {
    const answer = await reader.readLargeTradesAsync("BTCUSDT", "PERPETUAL", {
      fromMs: start, nowMs: start + MINUTE_MS - 1, limit: 1, bucketMs: MINUTE_MS, perBucketSideLimit: 1,
    });
    expect(answer.available).toBe(true);
    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0].row).toMatchObject({ price: 200, size: 0.75 });
  });
});
