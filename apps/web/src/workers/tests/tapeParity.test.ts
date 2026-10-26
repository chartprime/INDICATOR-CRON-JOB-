// Parity between the browser's tape derivations (lib/tape, lib/chart/markerRetention)
// and the runtime's CommonJS modules they mirror. vitest runs in Node, so the
// runtime files are required as they are and driven with the same 10,000
// recorded BTC-USDT aggregate trades (fixtures/binance-mirror/aggtrades-btcusdt-10k.json.gz,
// read from Binance's public mirror on 2026-10-26). Any divergence is a bug on
// one side; the runtime is the reference.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MarkerFrame, TradeFrame } from "../../types/frames";
import { createTimeCoveredMarkerRetentionBuffer } from "../../lib/chart/markerRetention";
import * as detection from "../../lib/tape/largeTradeDetection";
import { createAggressivePool, createPrintFloor, floorAbove, type AggressivePool } from "../../lib/tape/aggressivePool";
import { loadRecordedTrades } from "./recordedTape";

const here = path.dirname(fileURLToPath(import.meta.url));
const requireRuntime = createRequire(import.meta.url);
const runtimeSrc = path.resolve(here, "../../../../runtime/src");

type RuntimeDetection = {
  usesContractMagnitude(provider: string, assetClass: string | undefined): boolean;
  tradeMagnitude(provider: string, assetClass: string | undefined, price: number, size: number): number;
  markerMagnitude(marker: MarkerFrame): number;
  lowerMagnitudePriority(candidate: MarkerFrame, incumbent: MarkerFrame): boolean;
  resolveTopFractionCount(total: number, fraction: number, available: number): detection.TopFractionCount;
  [constant: string]: unknown;
};
type RuntimeHistoryBuffer = {
  recordMarker(marker: MarkerFrame): boolean;
  wouldRetainMarker(ts: number, side: string, magnitude: number): boolean;
  snapshotMarkers(): MarkerFrame[];
  markerCount(): number;
};
type RuntimePool = {
  record(trade: TradeFrame): boolean;
  seed(trades: readonly TradeFrame[], options?: { fromMs?: number; calibrate?: boolean }): number;
  snapshot(): { prints: readonly TradeFrame[]; floor: number; from: number };
  gate(): number;
  readonly size: number;
  readonly floor: number;
};

const runtimeDetection = requireRuntime(path.join(runtimeSrc, "indicators/large-trade/large-trade-detection.js")) as RuntimeDetection;
const { createHistoryBuffer } = requireRuntime(path.join(runtimeSrc, "server/history.js")) as {
  createHistoryBuffer(options: { markerBucketMs: number; maxMarkersPerBucketSide: number }): RuntimeHistoryBuffer;
};
const { createAggressivePool: createRuntimePool } = requireRuntime(path.join(runtimeSrc, "server/aggressive-pool.js")) as {
  createAggressivePool(options: { windowMs?: number; maxPrints?: number; now: () => number }): RuntimePool;
};
const { createPrintFloor: createRuntimePrintFloor } = requireRuntime(path.join(runtimeSrc, "indicators/passive_liquidity/print-floor.js")) as {
  createPrintFloor(options: { window: number; share: number; minSamples: number }): { push(size: number): void; value(): number };
};
const { floorAbove: runtimeFloorAbove } = requireRuntime(path.join(runtimeSrc, "indicators/passive_liquidity/bounded-prints.js")) as {
  floorAbove(size: number): number;
};

const trades = loadRecordedTrades();
const markers: MarkerFrame[] = trades.map((trade) => ({ ...trade, type: "marker" }));

/** A deterministic PRNG so the pairwise checks are the same run after run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("tape parity: the recorded tape", () => {
  it("is 10,000 trades of one pair with unique ids, in time order", () => {
    expect(trades).toHaveLength(10_000);
    expect(new Set(trades.map((trade) => trade.trade_id)).size).toBe(10_000);
    for (let i = 1; i < trades.length; i += 1) expect(trades[i].ts_exchange).toBeGreaterThanOrEqual(trades[i - 1].ts_exchange);
    expect(trades.every((trade) => trade.price > 0 && trade.size > 0)).toBe(true);
  });
});

describe("tape parity: large-trade-detection.js", () => {
  it("shares every constant", () => {
    for (const name of ["CONTRACT_MAGNITUDE_PROVIDER", "CONTRACT_MAGNITUDE_ASSET_CLASS", "MARKER_BUCKET_MS", "MARKERS_PER_BUCKET_SIDE", "MIN_TOP_FRACTION", "MAX_TOP_FRACTION", "DEFAULT_TOP_FRACTION"] as const) {
      expect(detection[name]).toBe(runtimeDetection[name]);
    }
  });

  it("ranks every recorded print by the same magnitude", () => {
    for (const marker of markers) {
      expect(detection.markerMagnitude(marker)).toBe(runtimeDetection.markerMagnitude(marker));
      expect(detection.tradeMagnitude("BINANCE", undefined, marker.price, marker.size)).toBe(runtimeDetection.tradeMagnitude("BINANCE", undefined, marker.price, marker.size));
    }
    expect(detection.tradeMagnitude("DXFEED", "FUTURE", 5_000, 3)).toBe(runtimeDetection.tradeMagnitude("DXFEED", "FUTURE", 5_000, 3));
    expect(detection.tradeMagnitude("DXFEED", "EQUITY", 5_000, 3)).toBe(runtimeDetection.tradeMagnitude("DXFEED", "EQUITY", 5_000, 3));
    expect(detection.usesContractMagnitude("DXFEED", "FUTURE")).toBe(runtimeDetection.usesContractMagnitude("DXFEED", "FUTURE"));
  });

  it("breaks every tie the same way over 10,000 random pairs", () => {
    const random = lcg(7);
    for (let i = 0; i < 10_000; i += 1) {
      const a = markers[Math.floor(random() * markers.length)];
      const b = markers[Math.floor(random() * markers.length)];
      expect(detection.lowerMagnitudePriority(a, b)).toBe(runtimeDetection.lowerMagnitudePriority(a, b));
    }
    const twin = { ...markers[0], trade_id: "a0" };
    expect(detection.lowerMagnitudePriority(markers[0], twin)).toBe(runtimeDetection.lowerMagnitudePriority(markers[0], twin));
  });

  it("resolves the same top-fraction counts", () => {
    for (const total of [0, 1, 7, 321, 10_000, 1_234_567]) {
      for (const fraction of [0.0002, 0.0005, 0.002, 0.0077, 0.02, 1]) {
        for (const available of [0, 1, 4, 300, 5_000]) {
          expect(detection.resolveTopFractionCount(total, fraction, available)).toEqual(runtimeDetection.resolveTopFractionCount(total, fraction, available));
        }
      }
    }
    expect(() => detection.resolveTopFractionCount(10, 0, 1)).toThrow();
    expect(() => runtimeDetection.resolveTopFractionCount(10, 0, 1)).toThrow();
  });
});

describe("tape parity: history.js marker retention", () => {
  it("admits the same prints as markers, trade by trade, and holds the same set afterwards", () => {
    const runtime = createHistoryBuffer({ markerBucketMs: detection.MARKER_BUCKET_MS, maxMarkersPerBucketSide: detection.MARKERS_PER_BUCKET_SIDE });
    const browser = createTimeCoveredMarkerRetentionBuffer(100_000, detection.MARKER_BUCKET_MS, detection.MARKERS_PER_BUCKET_SIDE);
    let admitted = 0;
    for (const marker of markers) {
      // The server only builds a marker frame when the buffer would retain it.
      const wouldRetain = runtime.wouldRetainMarker(marker.ts_exchange, marker.side, marker.price * marker.size);
      const recorded = runtime.recordMarker(marker);
      if (!wouldRetain) expect(recorded).toBe(false);
      expect(browser.insertAll([marker])).toBe(recorded);
      if (recorded) admitted += 1;
    }
    expect(admitted).toBeGreaterThan(markers.length / 100);
    const expected = runtime.snapshotMarkers();
    const actual = browser.snapshot();
    expect(actual.map((marker) => marker.trade_id)).toEqual(expected.map((marker) => marker.trade_id));
    expect(actual).toEqual(expected);
    expect(browser.size()).toBe(runtime.markerCount());
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(markers.length);
    // Never more than four per minute and side.
    const perBucket = new Map<string, number>();
    for (const marker of expected) {
      const key = `${Math.floor(marker.ts_exchange / detection.MARKER_BUCKET_MS)}:${marker.side}`;
      perBucket.set(key, (perBucket.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perBucket.values())).toBeLessThanOrEqual(detection.MARKERS_PER_BUCKET_SIDE);
  });

  it("agrees when the tape arrives out of order and with duplicates", () => {
    const random = lcg(11);
    const shuffled = [...markers].sort(() => random() - 0.5);
    const withDuplicates = [...shuffled, ...shuffled.slice(0, 500)];
    const runtime = createHistoryBuffer({ markerBucketMs: detection.MARKER_BUCKET_MS, maxMarkersPerBucketSide: detection.MARKERS_PER_BUCKET_SIDE });
    const browser = createTimeCoveredMarkerRetentionBuffer(100_000, detection.MARKER_BUCKET_MS, detection.MARKERS_PER_BUCKET_SIDE);
    for (const marker of withDuplicates) expect(browser.insertAll([marker])).toBe(runtime.recordMarker(marker));
    expect(browser.snapshot()).toEqual(runtime.snapshotMarkers());
  });
});

describe("tape parity: print-floor.js and bounded-prints.js", () => {
  it("computes the same floor after every size", () => {
    const runtime = createRuntimePrintFloor({ window: 4_096, share: 0.02, minSamples: 200 });
    const browser = createPrintFloor({ window: 4_096, share: 0.02, minSamples: 200 });
    for (const trade of trades) {
      runtime.push(trade.size);
      browser.push(trade.size);
      expect(browser.value()).toBe(runtime.value());
    }
    expect(browser.value()).toBeGreaterThan(0);
    const small = createRuntimePrintFloor({ window: 16, share: 0.25, minSamples: 4 });
    const smallBrowser = createPrintFloor({ window: 16, share: 0.25, minSamples: 4 });
    for (const trade of trades.slice(0, 2_000)) {
      small.push(trade.size);
      smallBrowser.push(trade.size);
      expect(smallBrowser.value()).toBe(small.value());
    }
  });

  it("steps above a size identically", () => {
    for (const size of [0, 1e-8, 0.5, 1, 12.345, 1e6, 1e9]) expect(floorAbove(size)).toBe(runtimeFloorAbove(size));
  });
});

type PoolPair = { runtime: RuntimePool; browser: AggressivePool<TradeFrame> };

function expectSamePool({ runtime, browser }: PoolPair): void {
  expect(browser.floor).toBe(runtime.floor);
  expect(browser.gate()).toBe(runtime.gate());
  expect(browser.size).toBe(runtime.size);
  const expected = runtime.snapshot();
  const actual = browser.snapshot();
  expect(actual.floor).toBe(expected.floor);
  expect(actual.from).toBe(expected.from);
  expect(actual.prints.map((print) => print.trade_id)).toEqual(expected.prints.map((print) => print.trade_id));
}

/**
 * Drives both pools as the transport drives its own: pages of 1,000 seeded
 * newest first, the newest `calibrationMs` calibrating, older rows admitted at
 * the floor, then live trades recorded one by one, the clock following the tape.
 */
function driveBootstrapThenLive(pair: PoolPair, clock: { now: number }, options: { calibrationMs: number; liveFrom: number }): void {
  const bootstrap = trades.filter((trade) => trade.ts_exchange < options.liveFrom);
  const live = trades.filter((trade) => trade.ts_exchange >= options.liveFrom);
  clock.now = trades[trades.length - 1].ts_exchange + 1_000;
  const calibrationFrom = clock.now - options.calibrationMs;
  for (let end = bootstrap.length; end > 0; end -= 1_000) {
    const page = bootstrap.slice(Math.max(0, end - 1_000), end);
    const calibration = page.filter((trade) => trade.ts_exchange >= calibrationFrom);
    const older = page.filter((trade) => trade.ts_exchange < calibrationFrom);
    const fromMs = page[0].ts_exchange;
    for (const pool of [pair.runtime, pair.browser]) {
      if (calibration.length > 0) pool.seed(calibration, { fromMs, calibrate: true });
      if (older.length > 0) pool.seed(older, { fromMs });
    }
    expectSamePool(pair);
  }
  live.forEach((trade, index) => {
    clock.now = Math.max(clock.now, trade.ts_exchange);
    expect(pair.browser.record(trade)).toBe(pair.runtime.record(trade));
    if (index % 100 === 0) expectSamePool(pair);
  });
  expectSamePool(pair);
}

describe("tape parity: aggressive-pool.js", () => {
  const liveFrom = trades[8_000].ts_exchange;

  it("holds the same prints, floor and coverage after a bootstrap and 2,000 live trades (default pool)", () => {
    const clock = { now: 0 };
    const now = () => clock.now;
    const pair: PoolPair = { runtime: createRuntimePool({ now }), browser: createAggressivePool<TradeFrame>({ now }) };
    driveBootstrapThenLive(pair, clock, { calibrationMs: 15 * 60 * 1000, liveFrom });
    const snapshot = pair.browser.snapshot();
    expect(snapshot.prints.length).toBeGreaterThan(0);
    expect(snapshot.floor).toBeGreaterThan(0);
  });

  it("agrees when only the newest two minutes calibrate and the rest is admitted at the floor", () => {
    const clock = { now: 0 };
    const now = () => clock.now;
    const pair: PoolPair = { runtime: createRuntimePool({ now }), browser: createAggressivePool<TradeFrame>({ now }) };
    driveBootstrapThenLive(pair, clock, { calibrationMs: 2 * 60 * 1000, liveFrom });
  });

  it("agrees through the size trim and the time window with a tight pool", () => {
    const clock = { now: 0 };
    const now = () => clock.now;
    const pair: PoolPair = {
      runtime: createRuntimePool({ now, maxPrints: 300, windowMs: 3 * 60 * 1000 }),
      browser: createAggressivePool<TradeFrame>({ now, maxPrints: 300, windowMs: 3 * 60 * 1000 }),
    };
    driveBootstrapThenLive(pair, clock, { calibrationMs: 60 * 1000, liveFrom });
    expect(pair.browser.snapshot().prints.length).toBeLessThanOrEqual(300);
  });

  it("agrees when the whole tape is recorded live, with duplicates and a late print", () => {
    const clock = { now: trades[0].ts_exchange };
    const now = () => clock.now;
    const pair: PoolPair = { runtime: createRuntimePool({ now }), browser: createAggressivePool<TradeFrame>({ now }) };
    trades.forEach((trade, index) => {
      clock.now = Math.max(clock.now, trade.ts_exchange);
      expect(pair.browser.record(trade)).toBe(pair.runtime.record(trade));
      if (index % 1_000 === 999) {
        expect(pair.browser.record(trade)).toBe(pair.runtime.record(trade));
        const late = { ...trades[index - 500], trade_id: `late${index}`, size: trades[index - 500].size * 50 };
        expect(pair.browser.record(late)).toBe(pair.runtime.record(late));
        expectSamePool(pair);
      }
    });
    expectSamePool(pair);
  });
});
