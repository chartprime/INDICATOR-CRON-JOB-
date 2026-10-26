const {
  createLiveMemoryBinding, ledgerOptionsFromEnv, scalesFromEnv, clusterTicksFor,
  DEFAULT_BAND_BP, DEFAULT_MIN_SLICE_USD,
} = require("../../../src/indicators/l2-memory/live-binding");

const T0 = 1_700_000_000_000;
const iso = (ms) => new Date(ms).toISOString();

function depth({ ts, marketKind = "PERPETUAL", symbol = "BTCUSDT", bids = [], asks = [] }) {
  return {
    eventType: "DEPTH",
    marketKind,
    providerSymbol: symbol,
    eventTime: iso(ts),
    payload: { firstUpdateId: 1, lastUpdateId: 2, previousUpdateId: 0, bids, asks },
  };
}

function trade({ ts, marketKind = "PERPETUAL", symbol = "BTCUSDT", price, quantity, isBuyerMaker }) {
  return {
    eventType: "TRADE",
    marketKind,
    providerSymbol: symbol,
    eventTime: iso(ts),
    payload: { tradeId: 1, price, quantity, isBuyerMaker },
  };
}

const ready = (bids, asks) => ({ status: "READY", book: { bids, asks, lastUpdateId: 2 } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function resolver(tickSize = 0.1) {
  const calls = [];
  return {
    calls,
    getBinanceTickSize: jest.fn(async (marketKind, symbol) => {
      calls.push([marketKind, symbol]);
      return typeof tickSize === "function" ? tickSize() : tickSize;
    }),
  };
}

describe("live-binding", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("a pair off screen arrives as a light status: the diff feeds the ledger, and the whole book is fetched only to seed or resync", async () => {
    const r = resolver(0.1);
    const binding = createLiveMemoryBinding({ tickSizeResolver: r, clusterTicks: 1 });
    const light = (bestBid, bestAsk) => {
      const status = { status: "READY" };
      Object.defineProperties(status, { bestBid: { enumerable: false, value: bestBid }, bestAsk: { enumerable: false, value: bestAsk } });
      return status;
    };
    const fullBook = jest.fn(() => ready([["99.0", "5.0"]], [["101.0", "2.0"]]));
    // Not seeded yet: the binding fetches the whole book once to seed.
    binding.onDepth(depth({ ts: T0 }), light("99.0", "101.0"), fullBook);
    await flush();
    binding.onDepth(depth({ ts: T0 + 10 }), light("99.0", "101.0"), fullBook);
    const engine = binding.getEngine("PERPETUAL", "BTCUSDT");
    expect(engine).not.toBeNull();
    expect(engine.seeded).toBe(true);
    expect(fullBook).toHaveBeenCalledTimes(1);
    // Seeded and live: a light status plus a diff is enough. No fetch, the diff lands, the quote follows.
    binding.onDepth(depth({ ts: T0 + 100, bids: [["99.0", "4.0"]] }), light("99.0", "101.0"), fullBook);
    expect(fullBook).toHaveBeenCalledTimes(1);
    expect(engine.live).toBe(true);
    expect(engine.snapshot().bids.find((level) => level.key === 990).size).toBe(4);
    expect(engine.snapshot().bestBidKey).toBe(990);
    // Without a fetcher and without a book, an unseeded engine is left unseeded rather than crashed.
    const bare = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1), clusterTicks: 1 });
    bare.onDepth(depth({ ts: T0 }), light("99.0", "101.0"));
    await flush();
    expect(() => bare.onDepth(depth({ ts: T0 + 10 }), light("99.0", "101.0"))).not.toThrow();
    expect(bare.getEngine("PERPETUAL", "BTCUSDT").seeded).toBe(false);
  });

  test("requires a tick size resolver", () => {
    expect(() => createLiveMemoryBinding({})).toThrow(/tickSizeResolver/);
  });

  test("creates one engine per pair once the tick size resolves, then feeds it", async () => {
    const r = resolver(0.1);
    const binding = createLiveMemoryBinding({ tickSizeResolver: r, clusterTicks: 1 });

    // First depth arrives before the tick size is known: no engine yet, one lookup started.
    binding.onDepth(depth({ ts: T0 }), ready([["99.0", "5.0"]], [["101.0", "2.0"]]));
    binding.onDepth(depth({ ts: T0 + 10 }), ready([["99.0", "5.0"]], [["101.0", "2.0"]]));
    expect(binding.getEngine("PERPETUAL", "BTCUSDT")).toBeNull();
    expect(r.getBinanceTickSize).toHaveBeenCalledTimes(1);

    await flush();
    const engine = binding.getEngine("PERPETUAL", "BTCUSDT");
    expect(engine).not.toBeNull();
    expect(engine.seeded).toBe(false);

    binding.onDepth(depth({ ts: T0 + 100 }), ready([["99.0", "5.0"]], [["101.0", "2.0"]]));
    expect(engine.seeded).toBe(true);
    binding.onTrade(trade({ ts: T0 + 150, price: "99.0", quantity: "1", isBuyerMaker: true }));
    binding.onDepth(depth({ ts: T0 + 200, bids: [["99.0", "4.0"]] }), ready([["99.0", "4.0"]], [["101.0", "2.0"]]));
    expect(engine.snapshot().bids.find((l) => l.key === 990)).toMatchObject({ size: 4, tradedVisible: 1 });

    // A different pair gets its own engine and its own lookup.
    binding.onDepth(depth({ ts: T0 + 300, marketKind: "SPOT" }), ready([["99.0", "1.0"]], [["101.0", "1.0"]]));
    await flush();
    expect(r.calls).toEqual([["PERPETUAL", "BTCUSDT"], ["SPOT", "BTCUSDT"]]);
    expect(binding.getEngine("SPOT", "BTCUSDT")).not.toBe(engine);

    // Perpetual snapshots cover 1000 levels: a book deeper than that marks the tail as outside coverage.
    const deepBids = Array.from({ length: 1001 }, (_, i) => [(5000 - i * 0.1).toFixed(1), "1.0"]);
    const perpEngine = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1), clusterTicks: 1 });
    perpEngine.onDepth(depth({ ts: T0 }), ready(deepBids, [["5001.0", "1.0"]]));
    await flush();
    perpEngine.onDepth(depth({ ts: T0 + 1 }), ready(deepBids, [["5001.0", "1.0"]]));
    perpEngine.onDepth(
      depth({ ts: T0 + 2, bids: [["100.0", "7.0"]] }),
      ready([...deepBids, ["100.0", "7.0"]], [["5001.0", "1.0"]]),
    );
    expect(perpEngine.getEngine("PERPETUAL", "BTCUSDT").stats.outsideRangeSeeds).toBe(1);
    perpEngine.stop();

    binding.release("SPOT", "BTCUSDT");
    expect(binding.getEngine("SPOT", "BTCUSDT")).toBeNull();
    binding.stop();
  });

  test("env helpers: explicit dust floor, price-relative scales, and band derivation", () => {
    expect(ledgerOptionsFromEnv({})).toEqual({});
    expect(ledgerOptionsFromEnv({ L2_MIN_SLICE_SIZE: "0" })).toEqual({ minSliceSize: 0 });
    expect(ledgerOptionsFromEnv({ L2_MIN_SLICE_SIZE: "0.5" })).toEqual({ minSliceSize: 0.5 });
    expect(ledgerOptionsFromEnv({ L2_MIN_SLICE_SIZE: "nope" })).toEqual({});
    expect(scalesFromEnv({})).toEqual({ bandBp: DEFAULT_BAND_BP, minSliceUsd: DEFAULT_MIN_SLICE_USD });
    expect(scalesFromEnv({ L2_BAND_BP: "1", L2_MIN_SLICE_USD: "-3" })).toEqual({ bandBp: 1, minSliceUsd: DEFAULT_MIN_SLICE_USD });
    // BTC spot at 80k (tick 0.01) -> 50 ticks = $0.50; BTC perp (tick 0.1) -> 5 ticks; ETH at 4k (tick 0.01) -> 3 ticks; never below one tick.
    expect(clusterTicksFor(80_000, 0.01, DEFAULT_BAND_BP)).toBe(50);
    expect(clusterTicksFor(80_000, 0.1, DEFAULT_BAND_BP)).toBe(5);
    expect(clusterTicksFor(4_000, 0.01, DEFAULT_BAND_BP)).toBe(3);
    expect(clusterTicksFor(100, 0.01, DEFAULT_BAND_BP)).toBe(1);

  });

  test("a pair the catalog does not size converts the price-relative configuration into its own units from its first quote", async () => {
    // Quote 100, tick 0.01, band 1% -> 100 ticks; $50 dust floor -> 0.5 base units.
    const binding = createLiveMemoryBinding({ tickSizeResolver: resolver(0.01), scales: { bandBp: 100, minSliceUsd: 50 }, geometryFor: () => null });
    binding.onDepth(depth({ ts: T0 }), ready([["100.00", "5.0"]], [["101.00", "2.0"]]));
    await flush();
    const engine = binding.getEngine("PERPETUAL", "BTCUSDT");
    expect(engine.snapshot().clusterWidth).toBeCloseTo(1); // 100 ticks of 0.01
    // A 0.4 slice is dust here (under 0.5): it leaving and returning is not a cycle.
    binding.onDepth(depth({ ts: T0 + 200, bids: [["99.00", "0.4"]] }), ready([["100.00", "5.0"], ["99.00", "0.4"]], [["101.00", "2.0"]]));
    binding.onDepth(depth({ ts: T0 + 300, bids: [["99.00", "0"]] }), ready([["100.00", "5.0"]], [["101.00", "2.0"]]));
    binding.onDepth(depth({ ts: T0 + 400, bids: [["99.00", "0.4"]] }), ready([["100.00", "5.0"], ["99.00", "0.4"]], [["101.00", "2.0"]]));
    expect(engine.snapshot().bids.find((l) => l.key === engine.keyFor(99))).toMatchObject({ refills: 0, lastSlice: null });
    binding.stop();
  });

  test("the heatmap lane window comes from the instrument's l2.windowPct, and is absent when the catalog does not set one (report 61 P3c)", () => {
    const widened = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1), geometryFor: () => ({ clusterTicks: 5, minSliceSize: 0.01, windowPct: 12 }) });
    expect(widened.laneWindowPct("PERPETUAL", "BTCUSDT")).toBe(12);
    const plain = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1), geometryFor: () => ({ clusterTicks: 5, minSliceSize: 0.01 }) });
    expect(plain.laneWindowPct("PERPETUAL", "BTCUSDT")).toBeNull();
    const none = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1), geometryFor: () => null });
    expect(none.laneWindowPct("PERPETUAL", "BTCUSDT")).toBeNull();
    for (const binding of [widened, plain, none]) binding.stop();
  });

  test("a catalogued pair takes its fixed band and dust floor from the instrument catalog, whatever the price", async () => {
    // BTC perpetual in config/market-instruments.json: 5 ticks of 0.1, dust floor 0.01.
    for (const quote of ["20000.0", "150000.0"]) {
      const binding = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1), scales: { bandBp: 100, minSliceUsd: 50 } });
      binding.onDepth(depth({ ts: T0 }), ready([[quote, "5.0"]], [[String(Number(quote) + 1), "2.0"]]));
      await flush();
      const engine = binding.getEngine("PERPETUAL", "BTCUSDT");
      expect(engine.clusterTicks).toBe(5);
      expect(engine.snapshot().clusterWidth).toBeCloseTo(0.5);
      binding.stop();
    }
    const explicit = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1), clusterTicks: 1, ledgerOptions: { minSliceSize: 0 } });
    explicit.onDepth(depth({ ts: T0 }), ready([["100.0", "5.0"]], [["101.0", "2.0"]]));
    await flush();
    expect(explicit.getEngine("PERPETUAL", "BTCUSDT").clusterTicks).toBe(1);
    explicit.stop();
  });

  test("trades for a pair with no engine are dropped silently", async () => {
    const binding = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1) });
    expect(() => binding.onTrade(trade({ ts: T0, price: "99.0", quantity: "1", isBuyerMaker: true }))).not.toThrow();
    binding.stop();
  });

  test("a failed tick size lookup is retried only after the backoff", async () => {
    jest.useFakeTimers({ now: T0, doNotFake: ["setImmediate", "nextTick"] });
    let attempts = 0;
    const r = resolver(() => {
      attempts += 1;
      return attempts === 1 ? null : 0.1;
    });
    const binding = createLiveMemoryBinding({ tickSizeResolver: r, clusterTicks: 1 });

    binding.onDepth(depth({ ts: T0 }), ready([], []));
    await flush();
    expect(binding.getEngine("PERPETUAL", "BTCUSDT")).toBeNull();

    binding.onDepth(depth({ ts: T0 + 100 }), ready([], []));
    await flush();
    expect(r.getBinanceTickSize).toHaveBeenCalledTimes(1); // inside backoff: no retry

    jest.setSystemTime(T0 + 11_000);
    binding.onDepth(depth({ ts: T0 + 11_000 }), ready([], []));
    await flush();
    expect(r.getBinanceTickSize).toHaveBeenCalledTimes(2);
    expect(binding.getEngine("PERPETUAL", "BTCUSDT")).not.toBeNull();
    binding.stop();
  });

  test("a rejected lookup is logged, not thrown", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const r = { getBinanceTickSize: jest.fn(async () => { throw new Error("boom"); }) };
    const binding = createLiveMemoryBinding({ tickSizeResolver: r });
    binding.onDepth(depth({ ts: T0 }), ready([], []));
    await flush();
    expect(spy).toHaveBeenCalledWith("l2-memory: tick size lookup failed", "PERPETUAL:BTCUSDT", "boom");
    expect(binding.getEngine("PERPETUAL", "BTCUSDT")).toBeNull();
    spy.mockRestore();
    binding.stop();
  });

  test("stop drops engines and ignores anything arriving afterwards", async () => {
    const binding = createLiveMemoryBinding({ tickSizeResolver: resolver(0.1) });
    binding.onDepth(depth({ ts: T0 }), ready([], []));
    binding.stop();
    await flush();
    expect(binding.getEngine("PERPETUAL", "BTCUSDT")).toBeNull();
    binding.onDepth(depth({ ts: T0 + 1 }), ready([], []));
    await flush();
    expect(binding.getEngine("PERPETUAL", "BTCUSDT")).toBeNull();
  });

  test("timers prune on schedule and print debug output when enabled", async () => {
    jest.useFakeTimers({ now: T0, doNotFake: ["setImmediate", "nextTick"] });
    const lines = [];
    const binding = createLiveMemoryBinding({
      tickSizeResolver: resolver(0.1),
      clusterTicks: 1,
      debug: true,
      debugIntervalMs: 1_000,
      pruneIntervalMs: 2_000,
      log: (line) => lines.push(line),
      ledgerOptions: { forgetEmptyAfterMs: 500 },
    });
    binding.start();
    binding.onDepth(depth({ ts: T0 }), ready([], []));
    await flush();
    expect(lines[0]).toMatch(/engine ready for PERPETUAL:BTCUSDT \(tick 0.1, band 0.1, dust floor /);

    const engine = binding.getEngine("PERPETUAL", "BTCUSDT");
    binding.onDepth(depth({ ts: T0 }), ready([["99.0", "5.0"], ["98.0", "1.0"]], [["101.0", "2.0"]]));
    binding.onTrade(trade({ ts: T0 + 10, price: "101.0", quantity: "3", isBuyerMaker: false }));
    binding.onDepth(depth({ ts: T0 + 20, bids: [["98.0", "0"]] }), ready([["99.0", "5.0"]], [["101.0", "2.0"]]));
    binding.onTrade(trade({ ts: T0 + 30, price: "101.0", quantity: "1", isBuyerMaker: false }));
    binding.onDepth(depth({ ts: T0 + 40, asks: [["101.0", "2.0"]] }), ready([["99.0", "5.0"]], [["101.0", "2.0"]]));

    jest.advanceTimersByTime(1_000);
    const debugBlock = lines.slice(1);
    expect(debugBlock[0]).toMatch(/^l2-memory PERPETUAL:BTCUSDT: seeded=true live=true levels=2\/1 deltas=2 trades=2/);
    expect(debugBlock).toContain("  walls (largest anywhere):");
    expect(debugBlock.some((l) => /near book \(within \d+ bands of best\):/.test(l))).toBe(true);
    expect(debugBlock.some((l) => /ask\s+101\.0.*hidden 4\.000/.test(l))).toBe(true);
    expect(debugBlock.some((l) => /bid\s+99\.0.*size\s+5\.000/.test(l))).toBe(true);

    // The emptied 98.0 record is pruned after the prune interval.
    expect(engine.stats.bidRecords).toBe(2);
    jest.setSystemTime(T0 + 2_100);
    jest.advanceTimersByTime(1_100);
    expect(engine.stats.bidRecords).toBe(1);

    binding.stop();
    jest.advanceTimersByTime(5_000);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("Binance envelopes as input frames (report 61 P4f)", () => {
  const { binanceDepthFrame, binanceTradeFrame } = require("../../../src/indicators/l2-memory/live-binding");
  const { frameProblem } = require("../../../src/indicators/l2-memory/input-frames");

  test("a DEPTH envelope becomes a book frame: exchange time, the state's status and book, the envelope's own diff", () => {
    const envelope = depth({ ts: T0, bids: [["99.0", "4.0"]], asks: [["101.0", "0"]] });
    const state = ready([["99.0", "4.0"]], [["102.0", "1.0"]]);
    const frame = binanceDepthFrame(envelope, state);
    expect(frame).toEqual({ kind: "book", ts: iso(T0), status: "READY", book: state.book, delta: { bids: [["99.0", "4.0"]], asks: [["101.0", "0"]] } });
    expect(frameProblem(frame)).toBeNull();
    expect(binanceDepthFrame(envelope, { status: "BUFFERING" })).toMatchObject({ kind: "book", status: "BUFFERING" });
  });

  test("an unavailable envelope, a missing state or no envelope at all is a gap, never a book", () => {
    const gap = { kind: "gap", ts: null, cause: "UNAVAILABLE" };
    expect(binanceDepthFrame({ ...depth({ ts: T0 }), state: "UNAVAILABLE" }, ready([], []))).toEqual(gap);
    expect(binanceDepthFrame(depth({ ts: T0 }), null)).toEqual(gap);
    expect(binanceDepthFrame(depth({ ts: T0 }), undefined)).toEqual(gap);
    expect(binanceDepthFrame(null, ready([], []))).toEqual(gap);
  });

  test("a TRADE envelope becomes a trade frame whose side is the aggressor; an unavailable one is dropped", () => {
    expect(binanceTradeFrame(trade({ ts: T0, price: "99.0", quantity: "2", isBuyerMaker: true }))).toEqual({ kind: "trade", ts: iso(T0), price: "99.0", size: "2", side: "sell", tradeId: 1 });
    expect(binanceTradeFrame(trade({ ts: T0, price: "101.0", quantity: "1", isBuyerMaker: false })).side).toBe("buy");
    expect(binanceTradeFrame({ ...trade({ ts: T0, price: "99.0", quantity: "2", isBuyerMaker: true }), state: "UNAVAILABLE" })).toBeNull();
    expect(binanceTradeFrame(null)).toBeNull();
  });
});

test("a released pair cannot be recreated by its stale tick-size lookup", async () => {
  let resolveTick;
  const tickSizeResolver = { getBinanceTickSize: jest.fn(() => new Promise((resolve) => { resolveTick = resolve; })) };
  const binding = createLiveMemoryBinding({ tickSizeResolver, clusterTicks: 1, ledgerOptions: { minSliceSize: 0 } });
  binding.onDepth(depth({ ts: T0 }), ready([["99", "1"]], [["101", "1"]]));
  binding.release("PERPETUAL", "BTCUSDT");
  resolveTick(0.1);
  await flush();
  expect(binding.getEngine("PERPETUAL", "BTCUSDT")).toBeNull();
  binding.stop();
});

test("a new subscription resolves independently of the released subscription's lookup", async () => {
  const pending = [];
  const tickSizeResolver = { getBinanceTickSize: jest.fn(() => new Promise((resolve) => pending.push(resolve))) };
  const binding = createLiveMemoryBinding({ tickSizeResolver, clusterTicks: 1, ledgerOptions: { minSliceSize: 0 } });
  const first = depth({ ts: T0 });
  const book = ready([["99", "1"]], [["101", "1"]]);
  binding.onDepth(first, book);
  binding.release("PERPETUAL", "BTCUSDT");
  binding.onDepth(first, book);
  expect(tickSizeResolver.getBinanceTickSize).toHaveBeenCalledTimes(2);
  pending[0](0.1);
  await flush();
  expect(binding.getEngine("PERPETUAL", "BTCUSDT")).toBeNull();
  pending[1](0.2);
  await flush();
  expect(binding.getEngine("PERPETUAL", "BTCUSDT").tickSize).toBe(0.2);
  binding.stop();
});

test("a synchronous tick-size resolver failure does not strand the pair", async () => {
  const tickSizeResolver = { getBinanceTickSize: jest.fn()
    .mockImplementationOnce(() => { throw new Error("resolver unavailable"); })
    .mockResolvedValue(0.1) };
  const binding = createLiveMemoryBinding({ tickSizeResolver, clusterTicks: 1, ledgerOptions: { minSliceSize: 0 } });
  const envelope = depth({ ts: T0 });
  const book = ready([["99", "1"]], [["101", "1"]]);
  expect(() => binding.onDepth(envelope, book)).toThrow("resolver unavailable");
  binding.onDepth(envelope, book);
  await flush();
  expect(tickSizeResolver.getBinanceTickSize).toHaveBeenCalledTimes(2);
  expect(binding.getEngine("PERPETUAL", "BTCUSDT")).not.toBeNull();
  binding.stop();
});
