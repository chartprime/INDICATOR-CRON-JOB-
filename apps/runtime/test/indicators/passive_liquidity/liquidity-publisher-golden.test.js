"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { dxfeedLiquidityFrame } = require("../../../src/server/frames");
const { createPublisherCapture } = require("../../../scripts/bench/publisher-capture");

// Golden output of the whole heatmap publisher (report 61 P3a), frozen before
// the publisher is split into lanes. A seeded synthetic market drives the real
// publisher through every tier it keeps: live 1 s columns, the deep and coarse
// tiers, walls and aggressive events, snapshot replays for new clients, store
// payloads, and a feed gap. The split must reproduce every byte, or name the
// difference and regenerate with UPDATE_L2_GOLDEN=1.

const GOLDEN_PATH = path.join(__dirname, "..", "..", "fixtures", "golden", "liquidity-publisher-p3a.json");
const T0 = 1_780_000_000_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PUBLISHER_OPTIONS = {
  historyS: 120,
  deepS: 600,
  deepColumnMs: 10_000,
  coarseS: 1_200,
  coarseColumnMs: 60_000,
  storeS: 60,
  storeDir: "liquidity-golden",
  levelMinUsd: 20_000,
};

function simulate({ seed, tickSize, clusterTicks, fullDepth, snapshotDepth, minSliceSize, depthTicks, seconds, dxfeed }, extraOptions = {}, { l2 = false } = {}) {
  const rand = mulberry32(seed);
  const engine = createMemoryEngine({ tickSize, clusterTicks, fullDepth, snapshotDepth, ledgerOptions: { minSliceSize } });
  const book = { bid: new Map(), ask: new Map() };
  let midTick = 20_000;
  const priceOf = (tick) => Number((tick * tickSize).toFixed(8));
  const sorted = (side) => [...book[side].entries()].sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0])).map(([tick, size]) => [String(priceOf(tick)), size]);
  const best = (side) => {
    const s = sorted(side);
    return s.length > 0 ? Number(s[0][0]) : null;
  };
  for (let offset = 1; offset <= depthTicks; offset += 1) {
    book.bid.set(midTick - offset, 1 + Math.floor(rand() * 20));
    book.ask.set(midTick + offset, 1 + Math.floor(rand() * 20));
  }
  engine.apply({ kind: "book", ts: T0, status: "READY", book: { bids: sorted("bid"), asks: sorted("ask") } });
  const capture = createPublisherCapture({
    engine,
    marketKind: dxfeed ? "FUTURE" : "PERPETUAL",
    symbol: dxfeed ? "/NQZ26:XCME" : "BTCUSDT",
    rowClusters: dxfeed ? 1 : null,
    snapshotEveryMs: 300_000,
    publisherOptions: { ...PUBLISHER_OPTIONS, ...(dxfeed ? { buildFrame: dxfeedLiquidityFrame } : {}), ...extraOptions },
    l2Identity: !l2 ? null : dxfeed
      ? { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" }
      : { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" },
  });

  const walls = [];
  const gapStart = Math.floor(seconds * 4 * 0.6);
  const gapEnd = gapStart + 40;
  for (let step = 1; step <= seconds * 4; step += 1) {
    const ts = T0 + step * 250;
    if (step === gapStart) {
      engine.apply({ kind: "book", ts, status: "UNAVAILABLE" });
    } else if (step === gapEnd) {
      engine.apply({ kind: "book", ts, status: "READY", book: { bids: sorted("bid"), asks: sorted("ask") } });
    } else if (step < gapStart || step > gapEnd) {
      const drift = rand();
      if (drift < 0.08) midTick += 1;
      else if (drift < 0.16) midTick -= 1;
      const delta = { bid: new Map(), ask: new Map() };
      const set = (side, tick, size) => {
        if (size <= 0) book[side].delete(tick);
        else book[side].set(tick, size);
        delta[side].set(tick, size > 0 ? size : 0);
      };
      for (const tick of [...book.bid.keys()]) if (tick >= midTick) set("bid", tick, 0);
      for (const tick of [...book.ask.keys()]) if (tick <= midTick) set("ask", tick, 0);
      for (let n = 0; n < 6; n += 1) {
        const side = rand() < 0.5 ? "bid" : "ask";
        const tick = side === "bid" ? midTick - 1 - Math.floor(rand() * depthTicks) : midTick + 1 + Math.floor(rand() * depthTicks);
        set(side, tick, rand() < 0.15 ? 0 : 1 + Math.floor(rand() * 20));
      }
      if (rand() < 0.02) {
        const side = rand() < 0.5 ? "bid" : "ask";
        const tick = side === "bid" ? midTick - 2 - Math.floor(rand() * 6) : midTick + 2 + Math.floor(rand() * 6);
        set(side, tick, 150 + Math.floor(rand() * 150));
        walls.push({ side, tick });
      }
      if (walls.length > 0 && rand() < 0.03) {
        const wall = walls.shift();
        if (book[wall.side].has(wall.tick)) set(wall.side, wall.tick, 0);
      }
      const tradeCount = Math.floor(rand() * 4);
      for (let n = 0; n < tradeCount; n += 1) {
        const aggressor = rand() < 0.5 ? "buy" : "sell";
        const hitSide = aggressor === "buy" ? "ask" : "bid";
        const levels = sorted(hitSide);
        if (levels.length === 0) continue;
        const [priceText, size] = levels[0];
        const tick = Math.round(Number(priceText) / tickSize);
        const qty = Math.min(size, 1 + Math.floor(rand() * 10));
        engine.apply({ kind: "trade", ts: ts - 50, price: priceText, size: qty, side: aggressor, tradeId: `${step}-${n}` });
        set(hitSide, tick, size - qty);
      }
      const toTuples = (side) => [...delta[side].entries()].map(([tick, size]) => [String(priceOf(tick)), size]);
      engine.apply({ kind: "book", ts, status: "READY", book: { bestBid: best("bid"), bestAsk: best("ask") }, delta: { bids: toTuples("bid"), asks: toTuples("ask") } });
    }
    if (step % 4 === 0) capture.tick(ts);
    if (step % 120 === 0) engine.prune(ts);
  }
  return capture.finish();
}

const SCENARIOS = {
  binanceStyle: { seed: 71, tickSize: 0.1, clusterTicks: 5, fullDepth: false, snapshotDepth: 60, minSliceSize: 2, depthTicks: 80, seconds: 1_800, dxfeed: false },
  dxfeedStyle: { seed: 72, tickSize: 0.25, clusterTicks: 1, fullDepth: true, snapshotDepth: Infinity, minSliceSize: 0, depthTicks: 40, seconds: 1_800, dxfeed: true },
};

const LANES_GOLDEN_PATH = path.join(__dirname, "..", "..", "fixtures", "golden", "liquidity-publisher-p3c-lanes.json");
const L2_GOLDEN_PATH = path.join(__dirname, "..", "..", "fixtures", "golden", "liquidity-publisher-p4a-l2.json");

describe("liquidity publisher golden output (report 61 P3a, before the lane split)", () => {
  const results = Object.fromEntries(Object.entries(SCENARIOS).map(([name, options]) => [name, simulate(options, { laneWindowPct: null })]));
  const withLanes = Object.fromEntries(Object.entries(SCENARIOS).map(([name, options]) => [name, simulate(options)]));

  if (process.env.UPDATE_L2_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    if (!fs.existsSync(GOLDEN_PATH)) fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(results, null, 2)}\n`);
    fs.writeFileSync(LANES_GOLDEN_PATH, `${JSON.stringify(withLanes, null, 2)}\n`);
  }

  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
  const lanesGolden = JSON.parse(fs.readFileSync(LANES_GOLDEN_PATH, "utf8"));

  test.each(Object.keys(SCENARIOS))("%s reproduces every frame, snapshot replay and store payload", (name) => {
    expect(results[name]).toEqual(golden[name]);
  });

  test.each(Object.keys(SCENARIOS))("%s with lanes on sends exactly the lane-0 frames and snapshots it froze before lanes existed", (name) => {
    expect(withLanes[name].digests.live).toBe(golden[name].digests.live);
    expect(withLanes[name].digests.snapshots).toBe(golden[name].digests.snapshots);
    expect(withLanes[name].counts.liveFrames).toBe(golden[name].counts.liveFrames);
    expect(withLanes[name]).toEqual(lanesGolden[name]);
  });

  test("the Binance-style scenario reaches its window with one coarser lane; the dxFeed-style one needs none", () => {
    expect(withLanes.binanceStyle.lanes.windowPct).toBe(7);
    expect(withLanes.binanceStyle.lanes.lanes).toEqual([expect.objectContaining({ k: 1, columnMs: 2_000, rows: 2_047 })]);
    expect(withLanes.binanceStyle.lanes.lanes[0].reachPct).toBeGreaterThanOrEqual(7);
    expect(withLanes.binanceStyle.lanes.lanes[0].recent).toBe(60);
    expect(withLanes.binanceStyle.lanes.lanes[0].deep).toBeGreaterThan(0);
    expect(withLanes.binanceStyle.digests.store).not.toBe(golden.binanceStyle.digests.store);
    expect(withLanes.dxfeedStyle.lanes).toBeUndefined();
    expect(withLanes.dxfeedStyle.digests.store).toBe(golden.dxfeedStyle.digests.store);
  });

  describe("the L2 channels on the wire (report 61 P4a)", () => {
    const withL2 = Object.fromEntries(Object.entries(SCENARIOS).map(([name, options]) => [name, simulate(options, {}, { l2: true })]));
    const withoutL2 = Object.fromEntries(Object.entries(SCENARIOS).map(([name, options]) => [name, simulate(options, { l2: false })]));
    const frozen = Object.fromEntries(Object.entries(withL2).map(([name, result]) => [name, result.l2]));
    if (process.env.UPDATE_L2_GOLDEN === "1") fs.writeFileSync(L2_GOLDEN_PATH, `${JSON.stringify(frozen, null, 2)}\n`);
    const l2Golden = JSON.parse(fs.readFileSync(L2_GOLDEN_PATH, "utf8"));

    test.each(Object.keys(SCENARIOS))("%s: a subscribed client changes nothing on the liquidity frames, snapshots or store", (name) => {
      const { l2, ...rest } = withL2[name];
      expect(rest).toEqual(lanesGolden[name]);
      expect(withoutL2[name]).toEqual(lanesGolden[name]);
      expect(l2).toBeDefined();
    });

    test.each(Object.keys(SCENARIOS))("%s: every chain is continuous and every mid-stream join equals the live client's state", (name) => {
      const { chainBreaks, joins } = withL2[name].l2;
      expect(chainBreaks).toEqual({ l2_view: 0, l2_walls: 0, l2_events: 0, l2_ladder: 0 });
      expect(joins.count).toBeGreaterThanOrEqual(5);
      expect(joins).toMatchObject({ wallMismatches: 0, eventSeqMismatches: 0, viewSeqMismatches: 0 });
    });

    test.each(Object.keys(SCENARIOS))("%s: reproduces every L2 frame it froze", (name) => {
      expect(frozen[name]).toEqual(l2Golden[name]);
    });

    test("the scenarios reach the paths the channels freeze", () => {
      for (const name of Object.keys(SCENARIOS)) {
        const { stats, eventKinds } = withL2[name].l2;
        expect(stats.l2_walls.frames).toBeGreaterThan(stats.l2_walls.resets);
        expect(stats.l2_events.frames).toBeGreaterThan(stats.l2_events.resets);
        expect(stats.l2_ladder.frames).toBeGreaterThan(100);
        for (const kind of ["wall_born", "wall_end", "trade", "segment"]) expect(eventKinds[kind]).toBeGreaterThan(0);
      }
      expect(withL2.binanceStyle.l2.stats.l2_view.frames).toBeGreaterThan(withL2.binanceStyle.l2.stats.l2_view.resets);
      expect(withL2.dxfeedStyle.l2.stats.l2_view.frames).toBe(0);
    });
  });

  test("the scenarios reach every tier and path they freeze", () => {
    for (const name of Object.keys(SCENARIOS)) {
      const { counts, columnMsSeen } = results[name];
      expect(Object.keys(columnMsSeen).sort()).toEqual(["1000", "10000", "60000"]);
      expect(counts.nullTicks).toBeGreaterThan(0);
      expect(counts.resets).toBeGreaterThan(1);
      expect(counts.snapshots).toBeGreaterThanOrEqual(5);
      expect(counts.snapshotFrames).toBeGreaterThan(counts.snapshots);
      expect(counts.stores).toBeGreaterThanOrEqual(25);
    }
  });
});
