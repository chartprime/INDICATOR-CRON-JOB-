"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { l2ViewFrame, l2WallsFrame, l2EventsFrame, l2LadderFrame } = require("../../src/server/l2-frames");

// Report 61 P4b. The browser's contract corpus pins a producer sample of every
// kind the browser can be sent. The four L2 samples are not hand-typed: this
// test rebuilds them with the real builders and requires the corpus to hold
// exactly those frames, so a builder change that the corpus did not follow
// fails here, not in a browser. UPDATE_L2_CORPUS=1 rewrites them.

const CORPUS_PATH = path.resolve(__dirname, "../../../web/src/test-fixtures/market-data-contract-v1.json");
const L2_TYPES = ["l2_view", "l2_walls", "l2_events", "l2_ladder"];
const IDENTITIES = [
  { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" },
  { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
];
const TS = 1_789_000_060_000;
const SEGMENT = (identity) => ({ id: `${identity.marketKind ?? identity.assetClass}:${identity.symbol}:1789000000000:LIVE`, state: "LIVE" });

function samples(identity) {
  const segment = SEGMENT(identity);
  const detail = {
    lifeMs: 42_000, firstShrinkTs: TS - 20_000, firstShrinkExact: true, reachedAtFirstShrink: true, traded: 30, absorbed: 25, swept: 5,
    hidden: 2, cleared: 60, fillRatio: 0.5, crossSide: 4, crossSideShare: 0.04, endDistanceRows: 1, endDistancePct: 0.01,
    clearedByTrades: true, continuity: { gapMs: 3_000 }, repeats: 2, repeatsComplete: true, evidenceGap: false,
  };
  return [
    l2ViewFrame(identity, {
      lane: 2, tier: "recent", ts: TS, seq: 15, reset: false, rowWidth: 1, columnMs: 4_000,
      columns: [{ ts: TS - 4_000, lo: 20_000, hi: 20_003, bid: [[0, 5], [1, 2.5]], ask: [[3, 1]] }, { ts: TS, lo: 20_000, hi: 20_003, bid: [[1, 0]], ask: [] }],
      segment,
    }),
    l2WallsFrame(identity, {
      ts: TS, seq: 9, reset: false, rowWidth: 0.25,
      walls: [
        { id: 17, side: "bid", row: 80_000, span: 2, startTs: TS - 42_000, endTs: TS - 1_000, size: 40, peak: 100, endedBy: "filled", ratio: 5, chain: 0, fill: 0.5, eaten: 0.3, absorbing: false, detail },
        { id: 18, side: "ask", row: 80_010, span: 1, startTs: TS - 5_000, endTs: null, size: 70, peak: 70, endedBy: null, ratio: 4, chain: 0, fill: 0, eaten: 0, absorbing: true, detail: { ...detail, lifeMs: 0, endDistanceRows: null, endDistancePct: null, clearedByTrades: false, continuity: null, repeats: 1 } },
      ],
      removed: [12],
      segment,
    }),
    l2EventsFrame(identity, {
      ts: TS, seq: 108, reset: false, missed: 3,
      events: [
        { event: "segment", ts: TS - 50_000, segment: segment.id, state: "LIVE", cause: "RESYNC" },
        { event: "wall_born", ts: TS - 42_000, wall: 17, side: "bid", row: 80_000, span: 2, size: 100 },
        { event: "wall_shrink", ts: TS - 20_000, wall: 17, exact: true, reached: true },
        { event: "wall_trade", ts: TS - 10_000, wall: 17, mode: "absorbed", price: 20_000, size: 25 },
        { event: "wall_hidden", ts: TS - 9_000, wall: 17, volume: 2 },
        { event: "trade", ts: TS - 5_000, side: "ask", aggressor: "buy", mode: "swept", price: 20_002.5, size: 1.5, late: false },
        { event: "hidden", ts: TS - 4_000, side: "bid", price: 20_000, volume: 0.5 },
        { event: "wall_end", ts: TS - 1_000, wall: 17, endedBy: "filled", distanceRows: 1 },
      ],
    }),
    l2LadderFrame(identity, { ts: TS, depth: 50, bids: [[20_000, 12], [19_999.75, 4]], asks: [[20_000.25, 3], [20_000.5, 9]], segment }),
  ].map((frame) => JSON.parse(JSON.stringify(frame)));
}

describe("contract corpus: the L2 samples are the builders' own output (report 61 P4b)", () => {
  const built = IDENTITIES.flatMap(samples);
  if (process.env.UPDATE_L2_CORPUS === "1") {
    const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
    corpus.frames = [...corpus.frames.filter((frame) => !L2_TYPES.includes(frame.type)), ...built];
    const note = {
      types: L2_TYPES,
      builtBy: "apps/runtime/test/contracts/l2-corpus.test.js, which rebuilds them with apps/runtime/src/server/l2-frames.js and holds this corpus equal to them",
      note: "The four opt-in L2 channel kinds (report 61 P4a/P4b), sent only to a client that declared the capability.",
    };
    corpus.extensions = [...corpus.extensions.filter((entry) => !entry.types.includes("l2_view")), note];
    fs.writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));

  test("the corpus holds exactly the rebuilt L2 samples, for both providers", () => {
    expect(corpus.frames.filter((frame) => L2_TYPES.includes(frame.type))).toEqual(built);
    expect(new Set(built.map((frame) => `${frame.type}:${frame.provider}`)).size).toBe(8);
  });

  test("the samples reach every event kind and both an active and an ended wall", () => {
    const events = built.find((frame) => frame.type === "l2_events").events.map((event) => event.event);
    expect(new Set(events).size).toBe(8);
    const walls = built.find((frame) => frame.type === "l2_walls").walls;
    expect(walls.map((wall) => wall.detail.life_ms)).toEqual([42_000, null]);
  });
});
