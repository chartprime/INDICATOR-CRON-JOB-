import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { BINANCE_PERP, DXFEED_EQUITY, barFrame } from "../../../chart/validation";
import {
  DAY_MS,
  DENOMINATOR_LENGTH,
  MAX_HELD_RANGES,
  RANGE_LIFETIME,
  createCompressionBreakoutEngine,
  isPriceValid,
  qualificationOf,
  normalizedSettings,
  trueRangeOf,
  type CommittedState,
  type CompressionBreakoutMathSettings,
  type Reading,
} from "../compressionBreakoutMath";

/**
 * Success criterion 1, hand-computed. The base pattern alternates a down bar
 * (open 60050, close 59950) and an up bar (open 59950, close 60050) with wicks
 * of 5, so every bar's true range is 110, every 20-bar window spans
 * 59945..60055 (width 110), the reference mean true range is 110 and the
 * width ratio is exactly 1. Volume is 100 on every base bar. At the defaults
 * the range opens at the commit of index 39 with age 0, bars 40..45 inside
 * make it eligible, and index 46 is the first bar that can break (amendment 2).
 */

const T0 = 1_780_000_000_000;
const MINUTE = 60_000;
const SETTINGS: CompressionBreakoutMathSettings = {
  rangeLength: 20,
  widthMultiple: 2,
  minCompressionBars: 6,
  confirmMultiple: 1.5,
  failBars: 5,
  holdBars: 40,
  trendFast: 50,
  trendSlow: 200,
};

interface Spec {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function baseSpec(index: number): Spec {
  const up = index % 2 === 1;
  return up ? { open: 59_950, high: 60_055, low: 59_945, close: 60_050, volume: 100 } : { open: 60_050, high: 60_055, low: 59_945, close: 59_950, volume: 100 };
}

function bar(index: number, spec: Spec, overrides: Partial<BarFrame> = {}, intervalMs = MINUTE): BarFrame {
  const frame = barFrame(T0 + index * intervalMs, { ...spec, tradeCount: 10 }, BINANCE_PERP, intervalMs);
  return { ...frame, ...overrides } as BarFrame;
}

/** `count` base bars with `specAt` overriding any index. */
function series(count: number, specAt: (index: number) => Spec | null = () => null, intervalMs = MINUTE): BarFrame[] {
  return Array.from({ length: count }, (_, index) => bar(index, specAt(index) ?? baseSpec(index), {}, intervalMs));
}

function run(bars: readonly BarFrame[], settings: CompressionBreakoutMathSettings = SETTINGS): { readings: Reading[]; committed: CommittedState } {
  const engine = createCompressionBreakoutEngine(settings);
  const readings = bars.map((frame) => engine.onBar(frame));
  return { readings, committed: engine.committed };
}

/** Index 46 is even, so its previous committed close is 60050: true range = max(260, 255, 5) = 260 ≥ 1.5 × 110. */
const BREAK_UP: Spec = { open: 60_050, high: 60_305, low: 60_045, close: 60_300, volume: 200 };

describe("compressionBreakoutMath -- validity and true range", () => {
  it("price validity needs finite values with low ≤ open, close ≤ high", () => {
    expect(isPriceValid(bar(0, baseSpec(0)))).toBe(true);
    expect(isPriceValid(bar(0, baseSpec(0), { high: 59_000 }))).toBe(false);
    expect(isPriceValid(bar(0, baseSpec(0), { open: 70_000 }))).toBe(false);
    expect(isPriceValid(bar(0, baseSpec(0), { close: 50_000 }))).toBe(false);
    expect(isPriceValid(bar(0, baseSpec(0), { low: Number.NaN }))).toBe(false);
  });

  it("true range uses the previous committed close, and high − low on the first bar and after a gap", () => {
    const up = bar(1, baseSpec(1));
    expect(trueRangeOf(up, null, false)).toBe(110);
    expect(trueRangeOf(up, 59_950, false)).toBe(110);
    expect(trueRangeOf(up, 50_000, false)).toBe(10_055);
    expect(trueRangeOf(up, 50_000, true)).toBe(110);
  });

  it("settings are brought into their schema ranges", () => {
    const n = normalizedSettings({ ...SETTINGS, rangeLength: 5, widthMultiple: 9, trendFast: 0, trendSlow: 1_000 });
    expect(n.rangeLength).toBe(10);
    expect(n.widthMultiple).toBe(4);
    expect(n.trendFast).toBe(10);
    expect(n.trendSlow).toBe(400);
    expect(n.qualifier).toBe("width");
  });
});

describe("compressionBreakoutMath -- establishment timeline (amendment 2)", () => {
  it("readiness, qualification and the opening commit at index 39 with age 0; eligible at 46", () => {
    const { readings, committed } = run(series(46));
    for (let index = 0; index < 39; index += 1) {
      expect(readings[index].rangeReady).toBe(false);
      expect(readings[index].qualified).toBeNull();
      expect(readings[index].rangeHigh).toBeNull();
    }
    expect(readings[39].rangeReady).toBe(true);
    expect(readings[39].warmupCount).toBe(40);
    expect(readings[39].qualified).toBe(true);
    expect(readings[39].widthRatio).toBe(1);
    expect(readings[39].rangeHigh).toBeNull(); // the range opens at this bar's commit, after the snapshot
    expect(readings[40].rangeHigh).toBe(60_055);
    expect(readings[40].rangeLow).toBe(59_945);
    expect(readings[40].rangeAge).toBe(0);
    expect(readings[45].rangeAge).toBe(5);
    expect(committed.active).not.toBeNull();
    expect(committed.active!.openedAt).toBe(39);
    expect(committed.active!.age).toBe(6);
    expect(committed.committedIndex).toBe(46);
    expect(committed.validCount).toBe(46);
  });

  it("a close outside before six bars inside abandons the range silently", () => {
    const { readings, committed } = run(series(44, (index) => (index === 42 ? BREAK_UP : null)));
    expect(readings[42].rangeAge).toBe(2);
    expect(readings[42].decision.kind).toBe("abandoned");
    expect(readings[43].rangeHigh).toBeNull();
    expect(committed.lastEvent).toBeNull();
    expect(committed.held).toEqual([]);
  });

  it("qualificationOf reads the committed window: width 110 over a reference of 110", () => {
    const { committed } = run(series(40));
    const q = qualificationOf(committed.highs, committed.lows, committed.trs, committed.closes, normalizedSettings(SETTINGS));
    expect(q).toEqual({ ready: true, qualified: true, widthRatio: 1, hi: 60_055, lo: 59_945 });
    expect(qualificationOf(committed.highs, committed.lows, committed.trs, committed.closes, normalizedSettings({ ...SETTINGS, widthMultiple: 1 })).qualified).toBe(true);
    const wide = { ...committed, highs: [...committed.highs.slice(0, 19), 60_300] };
    expect(qualificationOf(wide.highs, wide.lows, wide.trs, wide.closes, normalizedSettings(SETTINGS)).qualified).toBe(false);
  });
});

describe("compressionBreakoutMath -- break grading with pinned denominators", () => {
  it("true range 260 ≥ 165 and volume 200 ≥ 150: grade 3, basis 3, pulses on the break bar only", () => {
    const { readings, committed } = run(series(47, (index) => (index === 46 ? BREAK_UP : null)));
    const r = readings[46];
    expect(r.avgRange).toBe(110);
    expect(r.avgVolume).toBe(100);
    expect(r.trueRange).toBe(260);
    expect(r.decision).toMatchObject({ kind: "break", dir: 1, grade: 3, basis: 3, rangePassed: true, volumePassed: true });
    expect(r.pending).toBe(0);
    expect(committed.active!.broken).toMatchObject({ index: 46, dir: 1, grade: 3, basis: 3 });
    expect(committed.active!.excursionHi).toBe(60_305);
    expect(committed.lastEvent).toMatchObject({ kind: "break", index: 46 });
  });

  it("range only, volume only and neither: grades 1, 2 and 0", () => {
    const rangeOnly = run(series(47, (index) => (index === 46 ? { ...BREAK_UP, volume: 100 } : null))).readings[46].decision;
    expect(rangeOnly).toMatchObject({ kind: "break", grade: 1, basis: 3 });
    const volumeOnly = run(series(47, (index) => (index === 46 ? { open: 60_050, high: 60_070, low: 60_045, close: 60_060, volume: 200 } : null))).readings[46].decision;
    expect(volumeOnly).toMatchObject({ kind: "break", grade: 2, basis: 3 });
    const neither = run(series(47, (index) => (index === 46 ? { open: 60_050, high: 60_070, low: 60_045, close: 60_060, volume: 100 } : null))).readings[46].decision;
    expect(neither).toMatchObject({ kind: "break", grade: 0, basis: 3 });
  });

  it("an invalid volume on the break bar keeps the price context: basis 1, the volume test not taken", () => {
    const bars = series(47, (index) => (index === 46 ? BREAK_UP : null));
    bars[46] = { ...bars[46], volume: Number.NaN } as BarFrame;
    const r = run(bars).readings[46];
    expect(r.volumeValid).toBe(false);
    expect(r.gradeBasis).toBe(1);
    expect(r.decision).toMatchObject({ kind: "break", grade: 1, basis: 1 });
  });

  it("fewer than 20 valid volume observations: the volume denominator is unavailable, basis 1", () => {
    const bars = series(47, (index) => (index === 46 ? BREAK_UP : null)).map((frame, index) => (index < 30 ? ({ ...frame, volume: Number.NaN } as BarFrame) : frame));
    const r = run(bars).readings[46];
    expect(r.avgVolume).toBeNull();
    expect(r.gradeBasis).toBe(1);
    expect(r.decision).toMatchObject({ kind: "break", grade: 1, basis: 1 });
  });

  it("a zero-mean denominator is unavailable, never a free pass", () => {
    const bars = series(47, (index) => (index === 46 ? BREAK_UP : null)).map((frame, index) => (index >= 26 && index < 46 ? ({ ...frame, volume: 0 } as BarFrame) : frame));
    const r = run(bars).readings[46];
    expect(r.avgVolume).toBeNull();
    expect(r.decision).toMatchObject({ kind: "break", grade: 1, basis: 1 });
  });
});

describe("compressionBreakoutMath -- outcomes (amendments 1, 3 and 5)", () => {
  const breakThenInside = (insideClose: number) => series(48, (index) => (index === 46 ? BREAK_UP : index === 47 ? { open: 60_300, high: 60_305, low: Math.min(insideClose, 60_300) - 5, close: insideClose, volume: 100 } : null));

  it("a close back inside the frozen edges is a failure; the edges are still reported on that bar; the range is held", () => {
    const { readings, committed } = run(breakThenInside(60_000));
    expect(readings[47].pending).toBe(1);
    expect(readings[47].pendingBars).toBe(1);
    expect(readings[47].decision).toMatchObject({ kind: "failed", dir: 1, grade: 3 });
    expect(readings[47].rangeHigh).toBe(60_055);
    expect(committed.active).toBeNull();
    expect(committed.held).toHaveLength(1);
    expect(committed.held[0]).toMatchObject({ hi: 60_055, lo: 59_945, outcome: "failed", remaining: 40 });
    expect(committed.lastEvent).toMatchObject({ kind: "failed", index: 47 });
  });

  it("a close beyond the opposite edge is a failure too (it passed back through the range)", () => {
    const { readings } = run(breakThenInside(59_900));
    expect(readings[47].decision.kind).toBe("failed");
  });

  it("five bars outside, the last included: held outside at index 51 with the edges still reported; nothing from 52", () => {
    const outside = { open: 60_300, high: 60_315, low: 60_295, close: 60_310, volume: 100 };
    const { readings, committed } = run(series(53, (index) => (index === 46 ? BREAK_UP : index > 46 ? outside : null)));
    for (let index = 47; index <= 50; index += 1) {
      expect(readings[index].decision.kind).toBe("pending");
      expect(readings[index].pending).toBe(1);
    }
    expect(readings[51].decision).toMatchObject({ kind: "heldOutside", dir: 1, grade: 3 });
    expect(readings[51].pending).toBe(1);
    expect(readings[51].rangeHigh).toBe(60_055);
    expect(readings[52].pending).toBe(0);
    expect(readings[52].rangeHigh).toBeNull();
    expect(committed.held[0].outcome).toBe("heldOutside");
    expect(committed.lastEvent).toMatchObject({ kind: "heldOutside", index: 51 });
  });

  it("an invalid-price bar inside the window counts for the clock but decides nothing: still held outside at 51", () => {
    const outside = { open: 60_300, high: 60_315, low: 60_295, close: 60_310, volume: 100 };
    const bars = series(53, (index) => (index === 46 ? BREAK_UP : index > 46 ? outside : null));
    bars[48] = { ...bars[48], high: 1 } as BarFrame;
    const { readings } = run(bars);
    expect(readings[48].decision.kind).toBe("invalidPrice");
    expect(readings[48].pending).toBe(1);
    expect(readings[51].decision.kind).toBe("heldOutside");
    expect(run(bars).committed.validCount).toBe(52);
    expect(run(bars).committed.committedIndex).toBe(53);
  });

  it("the held countdown: drawn for holdBars bars after the outcome bar and freed at the commit after; holdBars 0 keeps nothing", () => {
    const long = series(100, (index) => (index === 46 ? BREAK_UP : index === 47 ? { open: 60_300, high: 60_305, low: 59_995, close: 60_000, volume: 100 } : null));
    const { readings } = run(long);
    expect(readings[47].held).toHaveLength(1);
    expect(readings[47].held[0].remaining).toBe(40);
    expect(readings[87].held).toHaveLength(1);
    expect(readings[87].held[0].remaining).toBe(0);
    expect(readings[88].held).toHaveLength(0);
    const none = run(long, { ...SETTINGS, holdBars: 0 }).readings;
    expect(none[47].held).toHaveLength(1);
    expect(none[47].held[0].remaining).toBe(0);
    expect(none[48].held).toHaveLength(0);
  });

  it("the pool keeps the seven newest held ranges: the oldest gives way to the eighth", () => {
    // Cycles of a small break (close one above the edge) and a return inside, so every window qualifies again at once.
    const bars: BarFrame[] = [];
    let hi = 60_055;
    let index = 0;
    const push = (spec: Spec) => {
      bars.push(bar(index, spec));
      index += 1;
    };
    for (let base = 0; base < 40; base += 1) push(baseSpec(base));
    for (let cycle = 0; cycle < 9; cycle += 1) {
      // The range re-opens at the commit of the bar after a failure, which does not count as inside: one more base bar per later cycle.
      for (let inside = 0; inside < (cycle === 0 ? 6 : 7); inside += 1) push(baseSpec(index));
      const close = hi + 1;
      push({ open: 60_050, high: close + 5, low: 60_045, close, volume: 200 });
      push({ open: close, high: close + 5, low: 59_995, close: 60_000, volume: 100 });
      hi = close + 5;
    }
    const { readings, committed } = run(bars, { ...SETTINGS, holdBars: 200 });
    const failures = readings.filter((reading) => reading.decision.kind === "failed");
    expect(failures).toHaveLength(9);
    expect(committed.held).toHaveLength(MAX_HELD_RANGES);
    expect(committed.held[0].closedTs).toBe(failures[2].tsOpen);
    expect(committed.held[MAX_HELD_RANGES - 1].closedTs).toBe(failures[8].tsOpen);
  });
});

describe("compressionBreakoutMath -- lifetime and trend with reduced fixtures (amendment 8)", () => {
  it("a range that never breaks expires 500 committed bars after it opened and a new one opens on the next bar", () => {
    const { readings, committed } = run(series(560));
    expect(readings[39 + RANGE_LIFETIME].decision.kind).toBe("expired");
    expect(readings[39 + RANGE_LIFETIME].rangeHigh).toBe(60_055);
    expect(readings[39 + RANGE_LIFETIME].rangeAge).toBe(RANGE_LIFETIME - 1);
    expect(readings[540].rangeHigh).toBeNull();
    expect(readings[541].rangeHigh).toBe(60_055);
    expect(readings[541].rangeAge).toBe(0);
    expect(readings[540].held[0]).toMatchObject({ outcome: "expired", remaining: 39 });
    expect(readings[541].held[0].remaining).toBe(38);
    expect(committed.active!.openedAt).toBe(540);
    expect(readings.filter((reading) => reading.decision.kind === "expired")).toHaveLength(1);
  });

  it("trend is unknown until trendSlow + 5 valid closes, flat on the base pattern, and off when fast ≥ slow", () => {
    const settings = { ...SETTINGS, trendFast: 10, trendSlow: 20 };
    const { readings } = run(series(30), settings);
    for (let index = 0; index < 25; index += 1) {
      expect(readings[index].trendStatus).toBe("warming");
      expect(readings[index].trend).toBeNull();
    }
    expect(readings[25].trendStatus).toBe("ready");
    expect(readings[25].trend).toBe(0);
    expect(readings[25].closesCount).toBe(25);
    const rising = run(
      Array.from({ length: 30 }, (_, index) => bar(index, { open: 60_000 + index * 10, high: 60_010 + index * 10, low: 59_995 + index * 10, close: 60_010 + index * 10, volume: 100 })),
      settings,
    ).readings;
    expect(rising[29].trend).toBe(1);
    const off = run(series(30), { ...settings, trendFast: 20, trendSlow: 20 }).readings;
    expect(off[29].trendStatus).toBe("fastGeSlow");
    expect(off[29].trend).toBeNull();
  });
});

describe("compressionBreakoutMath -- gaps, invalid tails, corrections and supersession (amendments 4, 5 and 6)", () => {
  it("an intraday gap resets the active range (a fresh one may open at once), its true range is high − low, and nothing is held", () => {
    const bars = series(44);
    bars[43] = bar(46, baseSpec(43)); // three minutes later than the bar before it
    const { readings, committed } = run(bars);
    expect(readings[43].gap).toBe(true);
    expect(readings[43].rangeHigh).toBeNull();
    expect(readings[43].trueRange).toBe(110);
    // The window still qualifies, so a fresh range opens at the gap bar's own commit; nothing is held.
    expect(committed.active!.openedAt).toBe(43);
    expect(committed.active!.age).toBe(0);
    expect(committed.held).toEqual([]);
    expect(committed.trs.at(-1)).toBe(110);
  });

  it("daily bars never reset on a calendar gap", () => {
    const bars = series(44, () => null, DAY_MS);
    bars[43] = bar(46, baseSpec(43), {}, DAY_MS);
    const { readings } = run(bars);
    expect(readings[43].gap).toBe(false);
    expect(readings[43].rangeHigh).toBe(60_055);
  });

  it("an invalid-price tail across a gap cannot reset the range; the gap stays pending and the next valid-price bar resets, with true range high − low", () => {
    const bars = series(46);
    bars[43] = bar(46, baseSpec(43), { high: 1 });
    bars[44] = bar(47, { open: 60_050, high: 60_151, low: 60_050, close: 60_150, volume: 100 }); // an overnight jump of 100
    bars[45] = bar(48, baseSpec(45));
    const { readings, committed } = run(bars);
    expect(readings[43].gap).toBe(true);
    expect(readings[43].decision.kind).toBe("invalidPrice");
    expect(readings[43].rangeHigh).toBe(60_055);
    expect(readings[44].gap).toBe(true);
    expect(readings[44].rangeHigh).toBeNull();
    expect(readings[44].decision.kind).toBe("none");
    expect(readings[44].trueRange).toBe(101);
    expect(readings[45].gap).toBe(false);
    expect(readings[45].trueRange).toBe(Math.max(110, Math.abs(60_055 - 60_150), Math.abs(59_945 - 60_150)));
    expect(committed.pendingGapReset).toBe(false);
    // Without the pending reset the stale range would have been broken by bar 44: no event may exist.
    expect(readings.some((reading) => reading.decision.kind === "break")).toBe(false);
  });

  it("non-finite intermediates never escape: overflowing volumes make the volume test untestable, overflowing prices make the range test untestable and the window unqualifiable", () => {
    // The frames are built directly: the fixture helper's rounding would itself overflow these values to Infinity.
    const hugeVolumes = series(47, (index) => (index === 46 ? BREAK_UP : null)).map((frame, index) => (index >= 26 && index < 46 ? ({ ...frame, volume: 1e308 } as BarFrame) : frame));
    expect(hugeVolumes[30].volume).toBe(1e308);
    const v = run(hugeVolumes).readings[46];
    expect(v.avgVolume).toBeNull();
    expect(v.decision).toMatchObject({ kind: "break", grade: 1, basis: 1 });
    const wild = Array.from({ length: 60 }, (_, index) => ({ ...bar(index, baseSpec(index)), open: 0, high: 1e308, low: -1e308, close: 0, volume: 100 }) as BarFrame);
    expect(wild[0].high).toBe(1e308);
    const { readings, committed } = run(wild);
    for (const reading of readings) {
      expect(reading.trueRange).toBeNull();
      expect(reading.widthRatio).toBeNull();
      expect(reading.qualified === null || reading.qualified === false).toBe(true);
      expect(reading.rangeHigh).toBeNull();
      for (const value of [reading.avgRange, reading.avgVolume, reading.widthRatio]) expect(value === null || Number.isFinite(value)).toBe(true);
    }
    expect(committed.trs).toEqual([]);
    expect(committed.highs).toHaveLength(20);
    expect(committed.active).toBeNull();
  });

  it("a closed re-dispatch of the tail recomputes C from the untouched P: cancelled break, invalid-to-valid volume, removed failure", () => {
    const base = series(46);
    const breakBar = bar(46, BREAK_UP);
    const insideBar = bar(46, baseSpec(46));
    const engine = createCompressionBreakoutEngine(SETTINGS);
    for (const frame of base) engine.onBar(frame);
    expect(engine.onBar(breakBar).decision.kind).toBe("break");
    // P is the committed state before this tail; it must survive the tail's re-dispatch untouched.
    const pre = JSON.stringify(engine.pre);
    expect(engine.pre.committedIndex).toBe(46);
    const cancelled = engine.onBar(insideBar);
    expect(JSON.stringify(engine.pre)).toBe(pre);
    expect(cancelled.decision.kind).toBe("none");
    expect(engine.committed.active!.broken).toBeNull();
    expect(engine.committed.active!.age).toBe(7);
    expect(engine.committed.lastEvent).toBeNull();
    const clean = run([...base, insideBar]).committed;
    expect(JSON.stringify(engine.committed)).toBe(JSON.stringify(clean));

    const flip = createCompressionBreakoutEngine(SETTINGS);
    for (const frame of base) flip.onBar(frame);
    expect(flip.onBar({ ...breakBar, volume: Number.NaN } as BarFrame).decision).toMatchObject({ kind: "break", grade: 1, basis: 1 });
    expect(flip.committed.volumes).toHaveLength(DENOMINATOR_LENGTH);
    expect(flip.onBar(breakBar).decision).toMatchObject({ kind: "break", grade: 3, basis: 3 });
    expect(JSON.stringify(flip.committed)).toBe(JSON.stringify(run([...base, breakBar]).committed));

    const failure = createCompressionBreakoutEngine(SETTINGS);
    for (const frame of [...base, breakBar]) failure.onBar(frame);
    const inside47 = bar(47, { open: 60_300, high: 60_305, low: 59_995, close: 60_000, volume: 100 });
    const outside47 = bar(47, { open: 60_300, high: 60_315, low: 60_295, close: 60_310, volume: 100 });
    expect(failure.onBar(inside47).decision.kind).toBe("failed");
    expect(failure.committed.held).toHaveLength(1);
    expect(failure.onBar(outside47).decision.kind).toBe("pending");
    expect(failure.committed.held).toHaveLength(0);
    expect(failure.committed.active!.broken).not.toBeNull();
    expect(JSON.stringify(failure.committed)).toBe(JSON.stringify(run([...base, breakBar, outside47]).committed));
  });

  it("a tail superseded without closing writes nothing, and the hole it leaves is a gap", () => {
    const base = series(46);
    const engine = createCompressionBreakoutEngine(SETTINGS);
    for (const frame of base) engine.onBar(frame);
    const forming = engine.onBar({ ...bar(46, BREAK_UP), closed: false } as BarFrame);
    expect(forming.confirmed).toBe(false);
    expect(forming.decision.kind).toBe("break");
    expect(engine.committed.committedIndex).toBe(46);
    const next = engine.onBar(bar(47, baseSpec(47)));
    expect(engine.committed.trs).not.toContain(260);
    expect(next.gap).toBe(true);
    expect(engine.committed.committedIndex).toBe(47);
  });

  it("a dispatch older than the tail is ignored and a forming revision never commits", () => {
    const base = series(46);
    const engine = createCompressionBreakoutEngine(SETTINGS);
    for (const frame of base) engine.onBar(frame);
    const before = JSON.stringify(engine.committed);
    engine.onBar(base[10]);
    expect(JSON.stringify(engine.committed)).toBe(before);
    engine.onBar({ ...bar(46, BREAK_UP), closed: false } as BarFrame);
    expect(JSON.stringify(engine.committed)).toBe(before);
  });

  it("works on an equity identity exactly as on crypto: no side is ever read", () => {
    const equity = series(47, (index) => (index === 46 ? BREAK_UP : null)).map((frame) => ({ ...frame, ...DXFEED_EQUITY, buy_volume: undefined, sell_volume: undefined }) as BarFrame);
    const { readings } = run(equity);
    expect(readings[46].decision).toMatchObject({ kind: "break", grade: 3, basis: 3 });
  });
});
