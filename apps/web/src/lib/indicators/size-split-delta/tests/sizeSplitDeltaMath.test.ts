import { describe, expect, it } from "vitest";
import type { BarFrame, Side } from "../../../../types/frames";
import { AggressiveTape } from "../../aggressive-orders/aggressiveTape";
import { indicatorTicksOf } from "../../../chart/indicatorTicks";
import { BINANCE_PERP, FIXTURE_T0, MINUTE_MS, referenceNearestRank, tradeFrame } from "../../../chart/validation";
import { nyLocalMinuteOfDay } from "../../killzones/killzones";
import {
  DAY_MS,
  MAX_TAPE_SHARE,
  SIZE_RING_CAPACITY,
  TIER_MIN_SIZES,
  anchorStartFor,
  createSizeRing,
  createSizeSplitEngine,
  evaluateMarkers,
  formatClock,
  formatMagnitude,
  formatSigned,
  scanWindow,
  shareEligible,
  statusOf,
  tapeShareOf,
  type SizeSplitMathSettings,
} from "../sizeSplitDeltaMath";

const FIXED: SizeSplitMathSettings = { tierMode: "fixed", tierSize: 1, anchor: "tape", K: 20, m: 2, q: 2, minTapeShare: 0.5 };

interface HandPrint {
  offsetMs: number;
  price: number;
  size: number;
  side: Side;
}

/** A store that records live from `liveSince`, holding the given prints. */
function storeOf(prints: readonly ReturnType<typeof tradeFrame>[], liveSince: number): { tape: AggressiveTape; ticks: NonNullable<ReturnType<typeof indicatorTicksOf>> } {
  const tape = new AggressiveTape(() => liveSince);
  tape.reset();
  for (const print of prints) tape.add(print);
  const ticks = indicatorTicksOf(tape);
  if (ticks === null) throw new Error("a tape always yields ticks");
  return { tape, ticks };
}

function barAt(tsOpen: number, close: number, volume: number, closed = true): BarFrame {
  return { type: "bar", ...BINANCE_PERP, interval_ms: MINUTE_MS, ts_open: tsOpen, open: close, high: close, low: close, close, volume, trade_count: null, closed } as BarFrame;
}

function printsAt(tsOpen: number, hand: readonly HandPrint[], tag: string) {
  return hand.map((print, index) => tradeFrame(tsOpen + print.offsetMs, print.price, print.size, print.side, BINANCE_PERP, `${tag}-${index}`));
}

/**
 * The hand-computed three-bar fixture (success criterion 1), fixed tier 1.0:
 *   A: buy 2.0, sell 0.5, buy 0.3   -> large +2.0, small -0.2, volume 2.8
 *   B: sell 1.5, sell 0.4, buy 0.1  -> large -1.5, small -0.3, volume 2.0
 *   C: buy 1.0 (boundary), buy 0.2  -> large +1.0, small +0.2, volume 1.2
 * cumulative large 2.0, 0.5, 1.5; small -0.2, -0.5, -0.3; share 1 on every bar.
 */
const A = FIXTURE_T0;
const B = A + MINUTE_MS;
const C = B + MINUTE_MS;
const HAND_A: HandPrint[] = [
  { offsetMs: 1_000, price: 100, size: 2, side: "buy" },
  { offsetMs: 2_000, price: 99.5, size: 0.5, side: "sell" },
  { offsetMs: 3_000, price: 100.2, size: 0.3, side: "buy" },
];
const HAND_B: HandPrint[] = [
  { offsetMs: 1_000, price: 99, size: 1.5, side: "sell" },
  { offsetMs: 2_000, price: 98.8, size: 0.4, side: "sell" },
  { offsetMs: 3_000, price: 99.1, size: 0.1, side: "buy" },
];
const HAND_C: HandPrint[] = [
  { offsetMs: 1_000, price: 99.5, size: 1, side: "buy" },
  { offsetMs: 2_000, price: 99.6, size: 0.2, side: "buy" },
];

describe("sizeSplitDeltaMath -- hand-computed three-bar fixture", () => {
  it("classifies with the boundary print large, sums signed sizes per tier and cumulates since the anchor", () => {
    const { ticks } = storeOf([...printsAt(A, HAND_A, "a"), ...printsAt(B, HAND_B, "b"), ...printsAt(C, HAND_C, "c")], A);
    const engine = createSizeSplitEngine(FIXED);
    const a = engine.onBar(barAt(A, 100.2, 2.8), ticks);
    expect(a.largeBar).toBeCloseTo(2, 12);
    expect(a.smallBar).toBeCloseTo(-0.2, 12);
    expect(a.large).toBeCloseTo(2, 12);
    expect(a.small).toBeCloseTo(-0.2, 12);
    expect(a.share).toBeCloseTo(1, 12);
    expect(a.valid).toBe(true);
    expect(a.confirmed).toBe(true);
    expect(a.status).toBe("ready");
    expect(a.tier).toBe(1);
    const b = engine.onBar(barAt(B, 99.1, 2), ticks);
    expect(b.largeBar).toBeCloseTo(-1.5, 12);
    expect(b.smallBar).toBeCloseTo(-0.3, 12);
    expect(b.large).toBeCloseTo(0.5, 12);
    expect(b.small).toBeCloseTo(-0.5, 12);
    const c = engine.onBar(barAt(C, 99.6, 1.2), ticks);
    expect(c.largeBar).toBeCloseTo(1, 12);
    expect(c.smallBar).toBeCloseTo(0.2, 12);
    expect(c.large).toBeCloseTo(1.5, 12);
    expect(c.small).toBeCloseTo(-0.3, 12);
    // The ring a bar is judged against holds the valid committed bars before it: A and B.
    expect(c.ringLength).toBe(2);
    expect(c.state).toBeNull();
    expect(engine.committed.map((bar) => bar.valid)).toEqual([true, true, true]);
    expect(engine.base.large).toBeCloseTo(1.5, 12);
  });

  it("in auto mode nothing is classified until 200 sizes have trained the ring, while the sizes still train it (amendment 3)", () => {
    const { ticks } = storeOf([...printsAt(A, HAND_A, "a"), ...printsAt(B, HAND_B, "b")], A);
    const engine = createSizeSplitEngine({ ...FIXED, tierMode: "auto" });
    const a = engine.onBar(barAt(A, 100.2, 2.8), ticks);
    expect(a.tier).toBeNull();
    expect(a.largeBar).toBeNull();
    expect(a.large).toBeNull();
    expect(a.valid).toBe(false);
    expect(a.status).toBe("learning");
    // Sizes train the ring at commit, so the bar's own reading still counts none.
    expect(a.sizesLearned).toBe(0);
    engine.onBar(barAt(B, 99.1, 2), ticks);
    expect(engine.sizeRing.count).toBe(6);
    expect(engine.sizeRing.values()).toEqual([2, 0.5, 0.3, 1.5, 0.4, 0.1]);
  });
});

describe("sizeSplitDeltaMath -- size ring and threshold", () => {
  it("nearest-rank p98 equals the reference on every push, evicting the oldest size first", () => {
    const ring = createSizeRing(8, 3);
    expect(ring.threshold()).toBeNull();
    ring.push([5, 1, 3]);
    expect(ring.threshold()).toBe(5);
    expect(ring.threshold()).toBe(referenceNearestRank(ring.values()));
    ring.push([2, 4, 6, 7, 8]);
    expect(ring.count).toBe(8);
    expect(ring.threshold()).toBe(8);
    ring.push([0.5]);
    expect(ring.values()).toEqual([1, 3, 2, 4, 6, 7, 8, 0.5]);
    expect(ring.threshold()).toBe(referenceNearestRank(ring.values()));
    ring.push([9]);
    expect(ring.values()).toEqual([3, 2, 4, 6, 7, 8, 0.5, 9]);
    expect(ring.threshold()).toBe(9);
    ring.push([Number.NaN, -1, 0]);
    expect(ring.count).toBe(8);
  });

  it("the production ring holds 4,096 sizes, needs 200 and matches the reference on a random stream", () => {
    const ring = createSizeRing();
    let state = 7;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const all: number[] = [];
    for (let batch = 0; batch < 60; batch += 1) {
      const sizes = Array.from({ length: 100 }, () => (random() < 0.02 ? 1 : 0.01 + 0.039 * random()));
      ring.push(sizes);
      all.push(...sizes);
      const expected = all.length < TIER_MIN_SIZES ? null : referenceNearestRank(all.slice(-SIZE_RING_CAPACITY));
      expect(ring.threshold()).toBe(expected);
    }
    expect(ring.count).toBe(SIZE_RING_CAPACITY);
  });
});

describe("sizeSplitDeltaMath -- window scan", () => {
  it("takes prints in [from, to) only, skips invalid sizes and prices, and bounds the size list to 4,096", () => {
    const prints = [
      tradeFrame(A - 1, 100, 1, "buy", BINANCE_PERP, "before"),
      tradeFrame(A, 100, 2, "buy", BINANCE_PERP, "at-open"),
      tradeFrame(A + 30_000, 100, Number.NaN, "buy", BINANCE_PERP, "nan-size"),
      tradeFrame(A + 30_001, 0, 3, "sell", BINANCE_PERP, "zero-price"),
      tradeFrame(A + 30_002, 100, 0, "sell", BINANCE_PERP, "zero-size"),
      tradeFrame(A + 59_999, 100, 0.5, "sell", BINANCE_PERP, "last-inside"),
      tradeFrame(A + 60_000, 100, 4, "buy", BINANCE_PERP, "at-end"),
    ];
    const { ticks } = storeOf(prints, A - 1);
    const scan = scanWindow(ticks, A, A + MINUTE_MS, 1);
    expect(scan.coverage).toBe("all");
    expect(scan.largeBar).toBe(2);
    expect(scan.smallBar).toBe(-0.5);
    expect(scan.tapeVolume).toBe(2.5);
    expect(scan.printCount).toBe(2);
    expect(scan.sizes).toEqual([2, 0.5]);
    const untiered = scanWindow(ticks, A, A + MINUTE_MS, null);
    expect(untiered.largeBar).toBeNull();
    expect(untiered.sizes).toEqual([2, 0.5]);
    expect(scanWindow(undefined, A, A + MINUTE_MS, 1).coverage).toBe("noStore");
    const many = Array.from({ length: 5_000 }, (_, index) => tradeFrame(A + index, 100, 0.001 + index * 1e-7, "buy", BINANCE_PERP, `m${index}`));
    const big = scanWindow(storeOf(many, A).ticks, A, A + MINUTE_MS, 1).sizes;
    expect(big).toHaveLength(SIZE_RING_CAPACITY);
    expect(big[0]).toBe(many[5_000 - SIZE_RING_CAPACITY].size);
  });
});

describe("sizeSplitDeltaMath -- tape share gate, fail closed (rule 5, amendment 5)", () => {
  it("pins the share cases", () => {
    expect(tapeShareOf(2.8, 2.8)).toBeCloseTo(1, 12);
    expect(tapeShareOf(2.8, 0)).toBeNull();
    expect(tapeShareOf(2.8, Number.NaN)).toBeNull();
    expect(tapeShareOf(0, 5)).toBe(0);
    expect(tapeShareOf(0, 0)).toBeNull();
    expect(shareEligible(1, 0.5)).toBe(true);
    expect(shareEligible(0.5, 0.5)).toBe(true);
    expect(shareEligible(0.49, 0.5)).toBe(false);
    expect(shareEligible(MAX_TAPE_SHARE, 0.5)).toBe(true);
    expect(shareEligible(1.26, 0.5)).toBe(false);
    expect(shareEligible(null, 0.5)).toBe(false);
  });

  it("zero or missing candle volume with prints is ineligible; no prints with positive volume is share 0; no prints and zero volume is unknown; above 1.25 is a mismatch", () => {
    const { ticks } = storeOf(printsAt(A, HAND_A, "a"), A);
    const zeroVolume = createSizeSplitEngine(FIXED).onBar(barAt(A, 100, 0), ticks);
    expect(zeroVolume.share).toBeNull();
    expect(zeroVolume.valid).toBe(false);
    expect(zeroVolume.large).toBeNull();
    expect(zeroVolume.status).toBe("shareUnknown");
    const noPrints = createSizeSplitEngine(FIXED).onBar(barAt(B, 100, 3), ticks);
    expect(noPrints.share).toBe(0);
    expect(noPrints.valid).toBe(false);
    expect(noPrints.status).toBe("shareLow");
    const nothing = createSizeSplitEngine(FIXED).onBar(barAt(B, 100, 0), ticks);
    expect(nothing.share).toBeNull();
    expect(nothing.status).toBe("shareUnknown");
    const mismatch = createSizeSplitEngine(FIXED).onBar(barAt(A, 100, 1.75), ticks);
    expect(mismatch.share).toBeCloseTo(1.6, 12);
    expect(mismatch.valid).toBe(false);
    expect(mismatch.status).toBe("shareMismatch");
    const low = createSizeSplitEngine(FIXED).onBar(barAt(A, 100, 7), ticks);
    expect(low.share).toBeCloseTo(0.4, 12);
    expect(low.status).toBe("shareLow");
  });

  it("status precedence, first match wins", () => {
    const base = { coverage: "all" as const, tapeStarting: false, tierAtOpen: 1, share: 1, eligible: true, committed: true };
    expect(statusOf({ ...base, coverage: "noStore" }, 0, 0, 20)).toBe("noFeed");
    expect(statusOf({ ...base, coverage: "none" }, 0, 0, 20)).toBe("noFeed");
    expect(statusOf({ ...base, coverage: "none", tapeStarting: true }, 0, 0, 20)).toBe("tapeStarting");
    expect(statusOf({ ...base, coverage: "thin", tierAtOpen: null }, 0, 0, 20)).toBe("thinned");
    expect(statusOf({ ...base, tierAtOpen: null, share: null }, 0, 0, 20)).toBe("learning");
    expect(statusOf({ ...base, share: null, eligible: false }, 0, 0, 20)).toBe("shareUnknown");
    expect(statusOf({ ...base, share: 1.6, eligible: false }, 0, 0, 20)).toBe("shareMismatch");
    expect(statusOf({ ...base, share: 0.3, eligible: false }, 0, 0, 20)).toBe("shareLow");
    expect(statusOf(base, 3, 5, 20)).toBe("gap");
    expect(statusOf(base, 3, 20, 20)).toBe("ready");
    expect(statusOf({ ...base, committed: false }, 0, 0, 20)).toBe("forming");
    expect(statusOf(base, 0, 0, 20)).toBe("ready");
  });
});

describe("sizeSplitDeltaMath -- commit paths (rule 6, amendment 1)", () => {
  it("an explicit close rescans from the store: a print that landed after the last revision is in the committed flow and trains the next threshold", () => {
    const { tape, ticks } = storeOf(printsAt(A, HAND_A.slice(0, 2), "a"), A);
    const engine = createSizeSplitEngine(FIXED);
    const revision = engine.onBar(barAt(A, 100, 2.5, false), ticks);
    expect(revision.largeBar).toBe(2);
    expect(revision.smallBar).toBe(-0.5);
    expect(revision.confirmed).toBe(false);
    tape.add(tradeFrame(A + 3_000, 100.2, 0.3, "buy", BINANCE_PERP, "late"));
    const closed = engine.onBar(barAt(A, 100.2, 2.8), ticks);
    expect(closed.smallBar).toBeCloseTo(-0.2, 12);
    expect(closed.confirmed).toBe(true);
    expect(engine.sizeRing.values()).toEqual([2, 0.5, 0.3]);
    // A later dispatch of the same bar changes nothing, whatever the store or the candle now say.
    tape.add(tradeFrame(A + 4_000, 100.2, 7, "buy", BINANCE_PERP, "after-commit"));
    const again = engine.onBar(barAt(A, 100.2, 50), ticks);
    expect(again).toEqual(closed);
    expect(engine.sizeRing.count).toBe(3);
  });

  it("a supersession commits the last revision values without a rescan: a print between the last revision and the next bar is excluded from the flow and from the next threshold until a rebuild", () => {
    const { tape, ticks } = storeOf(printsAt(A, HAND_A.slice(0, 2), "a"), A);
    const engine = createSizeSplitEngine(FIXED);
    const revision = engine.onBar(barAt(A, 100, 2.5, false), ticks);
    tape.add(tradeFrame(A + 3_000, 100.2, 0.7777, "buy", BINANCE_PERP, "between"));
    for (const print of printsAt(B, HAND_B, "b")) tape.add(print);
    const next = engine.onBar(barAt(B, 99.1, 2, false), ticks);
    const committed = engine.committed[0];
    expect(committed.tsOpen).toBe(A);
    expect(committed.largeBar).toBe(revision.largeBar);
    expect(committed.smallBar).toBe(revision.smallBar);
    expect(committed.confirmed).toBe(false);
    expect(engine.sizeRing.values()).toEqual([2, 0.5]);
    expect(engine.sizeRing.values()).not.toContain(0.7777);
    expect(next.large).toBeCloseTo(2 - 1.5, 12);
    // A rebuild (a fresh engine over the same store) sees the print.
    const rebuilt = createSizeSplitEngine(FIXED);
    rebuilt.onBar(barAt(A, 100, 2.5, false), ticks);
    rebuilt.onBar(barAt(B, 99.1, 2, false), ticks);
    expect(rebuilt.committed[0].smallBar).toBeCloseTo(-0.5 + 0.7777, 12);
    expect(rebuilt.sizeRing.values()).toContain(0.7777);
  });

  it("ignores a dispatch older than the tail", () => {
    const { ticks } = storeOf([...printsAt(A, HAND_A, "a"), ...printsAt(B, HAND_B, "b")], A);
    const engine = createSizeSplitEngine(FIXED);
    engine.onBar(barAt(A, 100.2, 2.8), ticks);
    const b = engine.onBar(barAt(B, 99.1, 2), ticks);
    const stale = engine.onBar(barAt(A, 100.2, 2.8), ticks);
    expect(stale).toEqual(b);
    expect(engine.committed).toHaveLength(2);
  });
});

describe("sizeSplitDeltaMath -- anchor and gaps (rules 8 and 9, round 3 ruling 3)", () => {
  const midnight = Math.ceil(FIXTURE_T0 / DAY_MS) * DAY_MS;
  const lastOfDay = midnight - MINUTE_MS;

  it("anchor windows are UTC-aligned days or weeks, or none for the tape", () => {
    expect(anchorStartFor(lastOfDay, "day")).toBe(midnight - DAY_MS);
    expect(anchorStartFor(midnight, "day")).toBe(midnight);
    expect(anchorStartFor(midnight + 5 * MINUTE_MS, "week")).toBe(Math.floor(midnight / (7 * DAY_MS)) * 7 * DAY_MS);
    expect(anchorStartFor(midnight, "tape")).toBeNull();
  });

  it("the first dispatch inside a new day resets the base, empties the marker ring and clears the condition, the forming bar showing only its own contribution", () => {
    const { ticks } = storeOf([...printsAt(lastOfDay, HAND_A, "x"), ...printsAt(midnight, HAND_B, "y")], lastOfDay);
    const engine = createSizeSplitEngine({ ...FIXED, anchor: "day" });
    const x = engine.onBar(barAt(lastOfDay, 100.2, 2.8), ticks);
    expect(x.large).toBeCloseTo(2, 12);
    expect(engine.markerRing).toHaveLength(1);
    const y = engine.onBar(barAt(midnight, 99.1, 2, false), ticks);
    expect(engine.anchorStart).toBe(midnight);
    expect(y.large).toBeCloseTo(-1.5, 12);
    expect(y.small).toBeCloseTo(-0.3, 12);
    expect(y.ringLength).toBe(0);
    expect(y.lastDivergence).toBeNull();
    expect(y.lastConflict).toBeNull();
    expect(engine.base).toEqual({ large: 0, small: 0 });
    const yClosed = engine.onBar(barAt(midnight, 99.1, 2), ticks);
    expect(yClosed.large).toBeCloseTo(-1.5, 12);
    expect(engine.markerRing).toHaveLength(1);
  });

  it("a gap carries the cumulative, empties the ring and is named until K valid bars have followed", () => {
    const settings = { ...FIXED, K: 2 };
    const bars = [A, B, C, C + MINUTE_MS, C + 2 * MINUTE_MS];
    const prints = bars.flatMap((tsOpen, index) => printsAt(tsOpen, HAND_C, `g${index}`));
    const { ticks } = storeOf(prints, A);
    const engine = createSizeSplitEngine(settings);
    const r0 = engine.onBar(barAt(bars[0], 99.6, 1.2), ticks);
    expect(r0.status).toBe("ready");
    const r1 = engine.onBar(barAt(bars[1], 99.6, 1.2), ticks);
    expect(r1.large).toBeCloseTo(2, 12);
    const gap = engine.onBar(barAt(bars[2], 99.6, 0), ticks);
    expect(gap.large).toBeNull();
    expect(gap.status).toBe("shareUnknown");
    const after = engine.onBar(barAt(bars[3], 99.6, 1.2), ticks);
    expect(after.large).toBeCloseTo(3, 12);
    expect(after.status).toBe("gap");
    expect(after.gapBars).toBe(1);
    expect(after.ringLength).toBe(0);
    const later = engine.onBar(barAt(bars[4], 99.6, 1.2), ticks);
    expect(later.status).toBe("gap");
    expect(engine.markerRing).toHaveLength(2);
    const ready = engine.onBar(barAt(bars[4] + MINUTE_MS, 99.6, 0), ticks);
    expect(ready.status).toBe("shareUnknown");
  });
});

describe("sizeSplitDeltaMath -- marker rule (rule 11, amendment 2, PM onset amendment)", () => {
  const settings = { K: 2, m: 2, q: 2 };
  const NONE = { conflict: false, divergence: null };
  const ring = [
    { close: 100, largeBar: 2, smallBar: -1, large: 2 },
    { close: 101, largeBar: 1, smallBar: -1, large: 3 },
  ];

  it("a strict new high confirms when large_t exceeds large_h, lags on equality, and arrows at depth m times the mean absolute contribution", () => {
    expect(evaluateMarkers(ring, { close: 102, largeBar: 0.5, smallBar: 0, large: 3.5 }, NONE, settings).state).toBe("confirms");
    expect(evaluateMarkers(ring, { close: 102, largeBar: 0, smallBar: 0, large: 3 }, NONE, settings).state).toBe("lags");
    expect(evaluateMarkers(ring, { close: 101, largeBar: 0, smallBar: 0, large: 3 }, NONE, settings).state).toBe("noExtreme");
    // mabsL = 1.5, depth needed 3: large_t <= 0
    const shallow = evaluateMarkers(ring, { close: 102, largeBar: -2.5, smallBar: 0, large: 0.5 }, NONE, settings);
    expect(shallow.state).toBe("lags");
    expect(shallow.divergence).toBeNull();
    const bearish = evaluateMarkers(ring, { close: 102, largeBar: -3, smallBar: 0, large: 0 }, NONE, settings);
    expect(bearish.divergence).toBe("bearish");
    expect(bearish.depth).toBe(-3);
    const bullish = evaluateMarkers(ring, { close: 99, largeBar: 3, smallBar: 0, large: 6 }, NONE, settings);
    // l is the bar with close 100 (large 2); 6 >= 2 + 3
    expect(bullish.divergence).toBe("bullish");
    expect(bullish.state).toBe("lags");
    expect(bullish.depth).toBe(4);
    expect(evaluateMarkers(ring.slice(0, 1), { close: 102, largeBar: -3, smallBar: 0, large: 0 }, NONE, settings).state).toBeNull();
    // Onset only: the same condition held at the previous valid bar draws nothing but still reads as held.
    const continuing = evaluateMarkers(ring, { close: 102, largeBar: -3, smallBar: 0, large: 0 }, { conflict: false, divergence: "bearish" }, settings);
    expect(continuing.divergenceHeld).toBe("bearish");
    expect(continuing.divergence).toBeNull();
    expect(continuing.depth).toBeNull();
    const flipped = evaluateMarkers(ring, { close: 102, largeBar: -3, smallBar: 0, large: 0 }, { conflict: false, divergence: "bullish" }, settings);
    expect(flipped.divergence).toBe("bearish");
  });

  it("the conflict holds when the two tier sums oppose at strength q·sqrt(K+1) and fires only at its onset", () => {
    // ring sums: large 3, small -2; mabsL 1.5, mabsS 1; strength 2*sqrt(3) = 3.464 -> need |sumL| >= 5.2, |sumS| >= 3.46
    const held = evaluateMarkers(ring, { close: 101, largeBar: 3, smallBar: -2, large: 6 }, NONE, settings);
    expect(held.conflictHeld).toBe(true);
    expect(held.conflictOnset).toBe(true);
    expect(held.conflictSums).toEqual([6, -4]);
    const continuing = evaluateMarkers(ring, { close: 101, largeBar: 3, smallBar: -2, large: 6 }, { conflict: true, divergence: null }, settings);
    expect(continuing.conflictHeld).toBe(true);
    expect(continuing.conflictOnset).toBe(false);
    const sameSign = evaluateMarkers(ring, { close: 101, largeBar: 3, smallBar: 5, large: 6 }, NONE, settings);
    expect(sameSign.conflictHeld).toBe(false);
  });
});

describe("sizeSplitDeltaMath -- formatting (amendment 7)", () => {
  it("three significant digits with k/M suffixes and an explicit sign", () => {
    expect(formatSigned(12.4)).toBe("+12.4");
    expect(formatSigned(-8.1)).toBe("−8.1");
    expect(formatSigned(0)).toBe("0");
    expect(formatSigned(1234)).toBe("+1.23k");
    expect(formatSigned(-2_500_000)).toBe("−2.5M");
    expect(formatSigned(0.00608)).toBe("+0.00608");
    expect(formatSigned(100)).toBe("+100");
    expect(formatMagnitude(0.106)).toBe("0.106");
    expect(formatMagnitude(20)).toBe("20");
    expect(formatMagnitude(2_000)).toBe("2k");
    expect(formatMagnitude(Number.NaN)).toBe("—");
  });

  it("formats the clock in UTC for Binance and New York for dxFeed", () => {
    expect(formatClock(FIXTURE_T0, "BINANCE")).toBe("20:26");
    const ny = nyLocalMinuteOfDay(FIXTURE_T0);
    expect(formatClock(FIXTURE_T0, "DXFEED")).toBe(`${String(Math.floor(ny / 60)).padStart(2, "0")}:${String(ny % 60).padStart(2, "0")}`);
  });
});

describe("sizeSplitDeltaMath -- the tape starting inside the window (UX finding 2)", () => {
  it("a window that began before the live recording reads tapeStarting, not noFeed; a store without a live stretch reads noFeed", () => {
    const tape = new AggressiveTape(() => A + 20_000);
    tape.reset();
    tape.add(tradeFrame(A + 20_000, 100, 1, "buy", BINANCE_PERP, "first-live"));
    const ticks = indicatorTicksOf(tape)!;
    expect(ticks.liveSince).toBe(A + 20_000);
    const engine = createSizeSplitEngine(FIXED);
    const first = engine.onBar(barAt(A, 100, 1, false), ticks);
    expect(first.status).toBe("tapeStarting");
    expect(first.large).toBeNull();
    tape.add(tradeFrame(B + 1_000, 100, 1, "buy", BINANCE_PERP, "next"));
    const next = engine.onBar(barAt(B, 100, 1, false), ticks);
    expect(next.status).toBe("forming");
    expect(next.large).toBe(1);
    const empty = new AggressiveTape(() => A);
    empty.reset();
    const silent = createSizeSplitEngine(FIXED).onBar(barAt(A, 100, 1, false), indicatorTicksOf(empty)!);
    expect(silent.status).toBe("noFeed");
    expect(createSizeSplitEngine(FIXED).onBar(barAt(A, 100, 1, false), undefined).status).toBe("noFeed");
  });

  it("a REST-only snapshot (absorb of no trades) sets liveSince but has never held a print: noFeed until the first print arrives", () => {
    const tape = new AggressiveTape(() => A + 20_000);
    tape.reset();
    tape.absorb([]);
    const ticks = indicatorTicksOf(tape)!;
    expect(ticks.liveSince).toBe(A + 20_000);
    expect(ticks.prints.length).toBe(0);
    const engine = createSizeSplitEngine(FIXED);
    expect(engine.onBar(barAt(A, 100, 1, false), ticks).status).toBe("noFeed");
    tape.add(tradeFrame(A + 30_000, 100, 1, "buy", BINANCE_PERP, "first-live"));
    expect(engine.onBar(barAt(A, 100, 1, false), ticks).status).toBe("tapeStarting");
  });
});
