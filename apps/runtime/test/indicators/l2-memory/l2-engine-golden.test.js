"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { sampleLiquidityColumn } = require("../../../src/indicators/passive_liquidity/liquidity-sampler");
const { createColumnFlow } = require("../../../src/indicators/passive_liquidity/column-flow");
const { createWallService } = require("../../../src/indicators/l2-memory/wall-service");
const { encodeAfter } = require("../../../src/indicators/passive_liquidity/liquidity-history");

// Golden output of the L2 engine as it stands before the report 61 refactor.
// A seeded synthetic market (random-walk mid, walls placed, pulled and eaten,
// late trades, a feed gap and resync) runs through the engine, the heatmap
// sampler, the column flow and the wall tracker on the two live paths:
// dxFeed-style (one tick per record, full depth) and Binance-style (banded,
// dust floor, finite snapshot depth). Any later phase must reproduce these
// outputs exactly, or name the difference and regenerate with
// UPDATE_L2_GOLDEN=1.

const GOLDEN_PATH = path.join(__dirname, "..", "..", "fixtures", "golden", "l2-engine-p0.json");

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

function simulate({ seed, tickSize, clusterTicks, fullDepth, snapshotDepth, minSliceSize, seconds, depthTicks }) {
  const rand = mulberry32(seed);
  const engine = createMemoryEngine({ tickSize, clusterTicks, fullDepth, snapshotDepth, ledgerOptions: { minSliceSize } });
  const book = { bid: new Map(), ask: new Map() };
  const t0 = 1_780_000_000_000;
  let midTick = 20_000;
  const priceOf = (tick) => Number((tick * tickSize).toFixed(8));
  const sorted = (side) => [...book[side].entries()].sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0])).map(([tick, size]) => [String(priceOf(tick)), size]);
  const best = (side) => { const s = sorted(side); return s.length > 0 ? Number(s[0][0]) : null; };
  for (let offset = 1; offset <= depthTicks; offset += 1) {
    book.bid.set(midTick - offset, 1 + Math.floor(rand() * 20));
    book.ask.set(midTick + offset, 1 + Math.floor(rand() * 20));
  }
  engine.apply({ kind: "book", ts: t0, status: "READY", book: { bids: sorted("bid"), asks: sorted("ask") } });

  const rowClusters = 2;
  const flow = createColumnFlow({ keyFor: engine.keyFor, rowClusters, columnMs: 1_000 });
  const tracker = createWallService({ engine, minSize: 40, multiplier: 1.5, gapRows: 1, settleMs: 5_000, keepEndedMs: 600_000, deepKeepEndedMs: 600_000, maxLevels: 60 });
  const wires = [];
  let prev = null;
  const walls = [];

  const gapStart = Math.floor(seconds * 2);
  const gapEnd = gapStart + 8;
  for (let step = 1; step <= seconds * 4; step += 1) {
    const ts = t0 + step * 250;
    if (step === gapStart) {
      engine.apply({ kind: "book", ts, status: "UNAVAILABLE" });
      continue;
    }
    if (step === gapEnd) {
      engine.apply({ kind: "book", ts, status: "READY", book: { bids: sorted("bid"), asks: sorted("ask") } });
      continue;
    }
    const inGap = step > gapStart && step < gapEnd;
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
    const trades = [];
    const tradeCount = Math.floor(rand() * 4);
    for (let n = 0; n < tradeCount; n += 1) {
      const aggressor = rand() < 0.5 ? "buy" : "sell";
      const hitSide = aggressor === "buy" ? "ask" : "bid";
      const levels = sorted(hitSide);
      if (levels.length === 0) continue;
      const [priceText, size] = levels[0];
      const tick = Math.round(Number(priceText) / tickSize);
      const qty = Math.min(size, 1 + Math.floor(rand() * 10));
      trades.push({ ts: ts - 50, price: priceText, size: qty, side: aggressor, tradeId: `${step}-${n}`, late: rand() < 0.2 });
      set(hitSide, tick, size - qty);
    }
    for (const trade of trades.filter((t) => !t.late)) engine.apply({ kind: "trade", ...trade });
    const toTuples = (side) => [...delta[side].entries()].map(([tick, size]) => [String(priceOf(tick)), size]);
    if (!inGap) engine.apply({ kind: "book", ts, status: "READY", book: { bestBid: best("bid"), bestAsk: best("ask") }, delta: { bids: toTuples("bid"), asks: toTuples("ask") } });
    for (const trade of trades.filter((t) => t.late)) engine.apply({ kind: "trade", ...trade });
    if (step % 4 === 0 && engine.live) {
      const snapshot = engine.liteSnapshot();
      for (const print of engine.drainPrints()) flow.push(print);
      const sampled = sampleLiquidityColumn(snapshot, { ts, rowClusters, windowRows: depthTicks });
      if (sampled) {
        const column = flow.take(sampled);
        tracker.update({ ts, column, snapshot, rowClusters, referenceRows: 10 });
        wires.push(JSON.stringify(encodeAfter(prev, column)));
        prev = column;
      }
    }
    if (step % 120 === 0) engine.prune(ts);
  }

  const final = engine.snapshot();
  const detailed = tracker.levels();
  const levels = detailed.map((level) => {
    const wire = { ...level };
    delete wire.detail;
    return wire;
  });
  const details = detailed.map((level) => level.detail);
  const detailFacts = {
    walls: details.length,
    firstShrinkExact: details.filter((d) => d.firstShrinkExact).length,
    reachedAtFirstShrink: details.filter((d) => d.reachedAtFirstShrink === true).length,
    clearedByTrades: details.filter((d) => d.clearedByTrades).length,
    continuity: details.filter((d) => d.continuity !== null).length,
    repeated: details.filter((d) => d.repeats > 1).length,
    repeatsComplete: details.filter((d) => d.repeatsComplete).length,
    withCrossSide: details.filter((d) => d.crossSide > 0).length,
    withTrades: details.filter((d) => d.traded > 0).length,
    evidenceGap: details.filter((d) => d.evidenceGap).length,
  };
  const ledgerViews = JSON.stringify({ bids: final.bids, asks: final.asks });
  const withoutClosest = (views) => views.map((view) => {
    const rest = { ...view };
    delete rest.closestDistance;
    return rest;
  });
  const ledgerViewsWithoutClosest = JSON.stringify({ bids: withoutClosest(final.bids), asks: withoutClosest(final.asks) });
  const verdicts = {};
  for (const view of [...final.bids, ...final.asks]) if (view.endedBy) verdicts[view.endedBy] = (verdicts[view.endedBy] ?? 0) + 1;
  const wallVerdicts = {};
  for (const level of levels) wallVerdicts[level.endedBy ?? "active"] = (wallVerdicts[level.endedBy ?? "active"] ?? 0) + 1;
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  return {
    stats: engine.stats,
    records: final.bids.length + final.asks.length,
    ledgerVerdicts: verdicts,
    wallVerdicts,
    columns: wires.length,
    ledgerSha256: sha(ledgerViews),
    ledgerWithoutClosestSha256: sha(ledgerViewsWithoutClosest),
    columnsSha256: sha(wires.join("\n")),
    wallsSha256: sha(JSON.stringify(levels)),
    wallDetail: detailFacts,
    wallDetailSha256: sha(JSON.stringify(details)),
  };
}

const SCENARIOS = {
  dxfeedStyle: { seed: 61, tickSize: 0.25, clusterTicks: 1, fullDepth: true, snapshotDepth: Infinity, minSliceSize: 0, seconds: 600, depthTicks: 40 },
  binanceStyle: { seed: 62, tickSize: 0.1, clusterTicks: 5, fullDepth: false, snapshotDepth: 60, minSliceSize: 2, seconds: 600, depthTicks: 80 },
};

describe("L2 engine golden output (report 61 P0 baseline)", () => {
  const results = Object.fromEntries(Object.entries(SCENARIOS).map(([name, options]) => [name, simulate(options)]));

  if (process.env.UPDATE_L2_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(results, null, 2)}\n`);
  }

  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

  test.each(Object.keys(SCENARIOS))("%s reproduces the frozen engine, column and wall outputs", (name) => {
    expect(results[name]).toEqual(golden[name]);
  });

  test("the scenarios exercise the paths they claim to", () => {
    for (const name of Object.keys(SCENARIOS)) {
      const r = results[name];
      expect(r.stats.resyncs).toBeGreaterThanOrEqual(1);
      expect(r.stats.lateEvents + r.stats.trades).toBeGreaterThan(0);
      expect(r.columns).toBeGreaterThan(500);
      expect(Object.keys(r.ledgerVerdicts).length).toBeGreaterThan(0);
    }
    expect(results.binanceStyle.stats.outsideRangeSeeds).toBeGreaterThan(0);
  });
});
