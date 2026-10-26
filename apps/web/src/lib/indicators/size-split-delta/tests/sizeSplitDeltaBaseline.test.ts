import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame, TradeFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import {
  SIZE_SPLIT_REGIME_SEEDS,
  busyTapeFor,
  countMarkers,
  judgeBudget,
  referenceClassify,
  referenceMarkers,
  referenceNearestRank,
  referenceScore,
  replayCapture,
  sizeSplitFixture,
  sizeSplitRegimeBars,
  summarizeBudget,
  tapeOf,
  ticksOf,
  trendBars,
  whaleVersusCrowd,
  type FixtureIdentity,
  type SizeSplitFixture,
  type SizeSplitPriceFollows,
} from "../../../chart/validation";
import { barSides } from "../../barSides";
import { SIZE_SPLIT_DEFAULT_SETTINGS, sizeSplitDeltaIndicator, type SizeSplitDeltaSettings } from "../sizeSplitDelta";
import { SIZE_RING_CAPACITY, TIER_MIN_SIZES, createSizeSplitEngine } from "../sizeSplitDeltaMath";
import { cvdDivergenceBaseline, fixtureTicks, markerIndices, withTapeVolume } from "./helpers";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * Protocol checks 5 and 7 and the brief's Acceptance, on the frozen fixtures:
 * the indicator in `auto` mode against the same indicator in `fixed` mode (the
 * one controlled comparison, identical detector) and against the `orderFlow`
 * CVD from `barSides` with the same divergence rule ("what candles alone
 * show"). Truth comes from the generators' hidden state; every arrow the
 * detector draws is also checked against the independent reference
 * implementation of the rule (amendment 8). Numbers are pinned here and
 * quoted in the doc page.
 */

const AUTO: SizeSplitDeltaSettings = { ...SIZE_SPLIT_DEFAULT_SETTINGS, anchor: "tape", showConflict: true, showBarLines: true };
const FIXED: SizeSplitDeltaSettings = { ...AUTO, tierMode: "fixed", tierSize: 0.5 };
const RULE = { K: 20, m: 2, q: 2 };
const MECHANISM = sizeSplitFixture();

interface Run {
  bearish: number[];
  bullish: number[];
  circles: number[];
  mask: Set<number>;
  outputs: Readonly<Record<string, readonly (number | null)[]>>;
  reference: ReturnType<typeof referenceMarkers>;
}

function runIndicator(fixture: SizeSplitFixture, settings: SizeSplitDeltaSettings): Run {
  const capture = replayCapture(sizeSplitDeltaIndicator, fixture.bars, settings, { ticks: fixtureTicks(fixture) });
  expect(capture.faulted).toBe(false);
  const reference = referenceMarkers(
    fixture.bars.map((bar, index) => ({ close: bar.close, largeBar: capture.outputs.largeBar[index], smallBar: capture.outputs.smallBar[index] })),
    RULE,
  );
  return {
    bearish: markerIndices(capture.markers, fixture.bars, "arrowDown"),
    bullish: markerIndices(capture.markers, fixture.bars, "arrowUp"),
    circles: markerIndices(capture.markers, fixture.bars, "circle"),
    mask: new Set(reference.evaluated),
    outputs: capture.outputs,
    reference,
  };
}

function runCvd(fixture: SizeSplitFixture): { bearish: number[]; bullish: number[]; reference: ReturnType<typeof referenceMarkers> } {
  const capture = replayCapture(cvdDivergenceBaseline, fixture.bars, { K: RULE.K, m: RULE.m });
  const reference = referenceMarkers(fixture.bars.map((bar) => ({ close: bar.close, largeBar: barSides(bar).delta, smallBar: 0 })), RULE);
  return { bearish: markerIndices(capture.markers, fixture.bars, "arrowDown"), bullish: markerIndices(capture.markers, fixture.bars, "arrowUp"), reference };
}

describe("sizeSplitDelta -- mechanism fixture (frozen, seed 20261102)", () => {
  const auto = runIndicator(MECHANISM, AUTO);
  const fixed = runIndicator(MECHANISM, FIXED);
  const cvd = runCvd(MECHANISM);

  it("the fixture is the frozen one: 300 bars, 100 prints each, 8 planted divergences at 45 + 30 j, exact tape volume", () => {
    expect(MECHANISM.bars).toHaveLength(300);
    expect(MECHANISM.prints).toHaveLength(30_000);
    expect(MECHANISM.labels.plantedIndices).toEqual([45, 75, 105, 135, 165, 195, 225, 255]);
    expect(MECHANISM.labels.direction).toEqual([-1, 1, -1, 1, -1, 1, -1, 1]);
    for (let index = 0; index < MECHANISM.bars.length; index += 1) {
      const prints = MECHANISM.printsByBar[index];
      expect(prints).toHaveLength(100);
      for (let k = 1; k < prints.length; k += 1) expect(prints[k].ts_exchange).toBeGreaterThanOrEqual(prints[k - 1].ts_exchange);
      expect(MECHANISM.bars[index].close).toBe(prints[prints.length - 1].price);
      expect(MECHANISM.bars[index].open).toBe(prints[0].price);
      expect(MECHANISM.bars[index].volume).toBe(prints.reduce((sum, print) => sum + print.size, 0));
    }
    for (const [position, p] of MECHANISM.labels.plantedIndices.entries()) {
      const d = MECHANISM.labels.direction[position];
      const window = MECHANISM.bars.slice(p - 20, p).map((bar) => bar.close);
      expect(MECHANISM.bars[p].close).toBe(d > 0 ? Math.max(...window) + 30 : Math.min(...window) - 30);
      for (let back = 0; back <= 2; back += 1) for (const print of MECHANISM.printsByBar[p - back].filter((print) => print.size === 1)) expect(print.side).toBe(d > 0 ? "sell" : "buy");
    }
  });

  it("the auto tier equals the nearest-rank p98 of the ring the fixture actually produces on every bar after the warm-up, and the contributions equal the reference classification with the boundary print large (amendment 6)", () => {
    const engine = createSizeSplitEngine({ tierMode: "auto", tierSize: 0.5, anchor: "tape", K: 20, m: 2, q: 2, minTapeShare: 0.5 });
    const ticks = fixtureTicks(MECHANISM);
    const ring: number[] = [];
    let firstTier = -1;
    MECHANISM.bars.forEach((bar, index) => {
      const reading = engine.onBar(bar, ticks);
      const expectedTier = ring.length < TIER_MIN_SIZES ? null : referenceNearestRank(ring.slice(-SIZE_RING_CAPACITY));
      expect(reading.tier).toBe(expectedTier);
      if (expectedTier !== null && firstTier < 0) firstTier = index;
      const expected = referenceClassify(MECHANISM.printsByBar[index], bar.ts_open, bar.ts_open + bar.interval_ms, expectedTier);
      expect(reading.largeBar).toBe(expected.largeBar);
      expect(reading.smallBar).toBe(expected.smallBar);
      expect(auto.outputs.largeBar[index]).toBe(expected.largeBar);
      for (const print of MECHANISM.printsByBar[index]) ring.push(print.size);
    });
    expect(firstTier).toBe(2);
    // With fewer than 4,096 sizes the p98 lands on the largest small print, which then classifies large; with a full ring it is 1.0.
    expect(auto.outputs.large[2]).not.toBeNull();
    expect(engine.committed[41].tierAtOpen).toBe(1);
    expect(engine.committed[2].tierAtOpen).toBeLessThan(0.05);
  });

  it("pins the arrows: auto and fixed hit all 8 planted bars exactly with no off-label arrow; every arrow equals the reference rule's; the planted bars are the condition's onsets", () => {
    expect(auto.reference.bearishHeld).toEqual(auto.reference.bearish);
    expect(auto.reference.bullishHeld).toEqual(auto.reference.bullish);
    expect(auto.bearish).toEqual([75, 135, 195, 255]);
    expect(auto.bullish).toEqual([45, 105, 165, 225]);
    expect(auto.reference.bearish).toEqual(auto.bearish);
    expect(auto.reference.bullish).toEqual(auto.bullish);
    expect(fixed.bearish).toEqual(auto.bearish);
    expect(fixed.bullish).toEqual(auto.bullish);
    expect(referenceScore(auto, MECHANISM.labels.plantedIndices, MECHANISM.labels.direction, auto.mask)).toEqual({ planted: 8, hits: 8, offLabel: 0, plantedEvaluable: 8 });
    expect(referenceScore(fixed, MECHANISM.labels.plantedIndices, MECHANISM.labels.direction, fixed.mask)).toEqual({ planted: 8, hits: 8, offLabel: 0, plantedEvaluable: 8 });
  });

  it("pins the conflict onsets to the count the reference implementation produces (17), on the same bars", () => {
    expect(auto.reference.conflictOnsets).toEqual([22, 50, 54, 56, 59, 78, 109, 111, 114, 117, 139, 175, 200, 232, 236, 257, 285]);
    expect(auto.circles).toEqual(auto.reference.conflictOnsets);
    expect(auto.circles).toHaveLength(17);
  });

  it("measured on the CVD baseline (amendment 9): the candle delta also hits all 8 planted bars, with 5 off-label arrows the split does not draw; the CVD def equals the reference rule", () => {
    expect(cvd.bearish).toEqual(cvd.reference.bearish);
    expect(cvd.bullish).toEqual(cvd.reference.bullish);
    expect(cvd.bearish).toEqual([75, 135, 190, 195, 255]);
    expect(cvd.bullish).toEqual([42, 45, 56, 105, 165, 222, 225, 288]);
    const score = referenceScore(cvd, MECHANISM.labels.plantedIndices, MECHANISM.labels.direction, auto.mask);
    expect(score).toEqual({ planted: 8, hits: 8, offLabel: 5, plantedEvaluable: 8 });
    // Acceptance: recall >= 7/8 on bar p exactly; false divergences <= 2 and <= the CVD baseline's.
    expect(referenceScore(auto, MECHANISM.labels.plantedIndices, MECHANISM.labels.direction, auto.mask).offLabel).toBeLessThanOrEqual(Math.min(2, score.offLabel));
  });

  it("marker budget at default settings (conflict circles off, day anchor) is within 40 per 1,000 on the mechanism fixture", () => {
    const budget = countMarkers(sizeSplitDeltaIndicator, MECHANISM.bars, SIZE_SPLIT_DEFAULT_SETTINGS, { extras: { ticks: fixtureTicks(MECHANISM) } });
    const verdict = judgeBudget(budget, 40, 2);
    console.log(summarizeBudget("sizeSplitDelta mechanism fixture, defaults", budget, verdict));
    // Seven, not eight: the default day anchor resets at the UTC midnight between bars 213 and 214, and planted bar 225 has no full ring yet.
    expect(budget.total).toBe(7);
    expect(verdict.ok).toBe(true);
    const withConflict = countMarkers(sizeSplitDeltaIndicator, MECHANISM.bars, { ...SIZE_SPLIT_DEFAULT_SETTINGS, showConflict: true }, { extras: { ticks: fixtureTicks(MECHANISM) } });
    console.log(summarizeBudget("sizeSplitDelta mechanism fixture, conflict circles on", withConflict, judgeBudget(withConflict, 40, 2)));
    expect(withConflict.total).toBe(budget.total + (withConflict.byShape.circle ?? 0));
    expect(withConflict.byShape.circle ?? 0).toBeGreaterThan(0);
    expect(withConflict.maxPerBar).toBeLessThanOrEqual(2);
  });
});

interface RegimeTotals {
  hits: number;
  offLabel: number;
  eligible: number;
  planted: number;
}

function regimeTable(priceFollows: SizeSplitPriceFollows): { auto: RegimeTotals; fixed: RegimeTotals; cvd: RegimeTotals; arrowsEqualReference: boolean } {
  const totals = { auto: { hits: 0, offLabel: 0, eligible: 0, planted: 0 }, fixed: { hits: 0, offLabel: 0, eligible: 0, planted: 0 }, cvd: { hits: 0, offLabel: 0, eligible: 0, planted: 0 } };
  let arrowsEqualReference = true;
  for (const seed of SIZE_SPLIT_REGIME_SEEDS) {
    const fixture = sizeSplitRegimeBars({ seed, priceFollows });
    const auto = runIndicator(fixture, AUTO);
    const fixed = runIndicator(fixture, FIXED);
    const cvd = runCvd(fixture);
    // The common evaluation mask: bars where both configurations have values and a full ring (amendment 8).
    const mask = new Set([...auto.mask].filter((index) => fixed.mask.has(index)));
    for (const [name, run] of [["auto", auto], ["fixed", fixed], ["cvd", cvd]] as const) {
      const score = referenceScore(run, fixture.labels.plantedIndices, fixture.labels.direction, mask);
      totals[name].hits += score.hits;
      totals[name].offLabel += score.offLabel;
      totals[name].eligible += mask.size;
      totals[name].planted += score.plantedEvaluable;
      if (JSON.stringify(run.bearish) !== JSON.stringify(run.reference.bearish) || JSON.stringify(run.bullish) !== JSON.stringify(run.reference.bullish)) arrowsEqualReference = false;
    }
  }
  return { ...totals, arrowsEqualReference };
}

describe("sizeSplitDelta -- regime fixtures, 10 seeds each (Acceptance, round 3 rulings 7 and 8)", () => {
  const large = regimeTable("large");
  const small = regimeTable("small");
  const none = regimeTable("none");

  it("prints the acceptance table", () => {
    const row = (regime: string, name: string, totals: RegimeTotals) => `| ${regime} | ${name} | ${totals.eligible} | ${totals.planted} | ${totals.hits} | ${totals.offLabel} |`;
    console.log(
      [
        "| regime | configuration | eligible bars | planted | hits | off-label arrows |",
        "|---|---|---|---|---|---|",
        row("large", "auto", large.auto),
        row("large", "fixed 0.5", large.fixed),
        row("large", "CVD", large.cvd),
        row("small", "auto", small.auto),
        row("small", "fixed 0.5", small.fixed),
        row("small", "CVD", small.cvd),
        row("none", "auto", none.auto),
        row("none", "fixed 0.5", none.fixed),
        row("none", "CVD", none.cvd),
      ].join("\n"),
    );
    expect(large.arrowsEqualReference && small.arrowsEqualReference && none.arrowsEqualReference).toBe(true);
  });

  it("pins the published counts over 10 seeds", () => {
    expect(large.auto).toEqual({ hits: 100, offLabel: 0, eligible: 5_780, planted: 100 });
    expect(large.fixed).toEqual({ hits: 100, offLabel: 0, eligible: 5_780, planted: 100 });
    expect(large.cvd).toEqual({ hits: 80, offLabel: 171, eligible: 5_780, planted: 100 });
    // Onset-only arrows (PM amendment to rule 11): the held condition would count 703/709/37 on small and 290/293/186 on none.
    expect(small.auto).toEqual({ hits: 0, offLabel: 488, eligible: 5_780, planted: 0 });
    expect(small.fixed).toEqual({ hits: 0, offLabel: 490, eligible: 5_780, planted: 0 });
    expect(small.cvd).toEqual({ hits: 0, offLabel: 37, eligible: 5_780, planted: 0 });
    expect(none.auto).toEqual({ hits: 0, offLabel: 256, eligible: 5_780, planted: 0 });
    expect(none.fixed).toEqual({ hits: 0, offLabel: 256, eligible: 5_780, planted: 0 });
    expect(none.cvd).toEqual({ hits: 0, offLabel: 180, eligible: 5_780, planted: 0 });
  });

  it("acceptance: auto beats or matches fixed (no more false markers on small and none at equal or better recall on large); the split beats the candle delta on its own regime", () => {
    expect(large.auto.hits).toBeGreaterThanOrEqual(large.fixed.hits);
    expect(small.auto.offLabel).toBeLessThanOrEqual(small.fixed.offLabel);
    expect(none.auto.offLabel).toBeLessThanOrEqual(none.fixed.offLabel);
    expect(large.auto.hits).toBeGreaterThan(large.cvd.hits);
    expect(large.auto.offLabel).toBeLessThan(large.cvd.offLabel);
  });
});

describe("sizeSplitDelta -- whale versus crowd (protocol check 7) in fixed mode, tier 1.0 (round 3 ruling 9)", () => {
  it("responds differently to the two tapes that make the same candle while the candle delta cannot", () => {
    const fixture = whaleVersusCrowd({ whaleSize: 50, crowdCount: 100 });
    const settings: SizeSplitDeltaSettings = { ...FIXED, tierSize: 1 };
    const whale = replayCapture(sizeSplitDeltaIndicator, [fixture.candle], settings, { ticks: ticksOf(fixture.whaleTape) });
    const crowd = replayCapture(sizeSplitDeltaIndicator, [fixture.candle], settings, { ticks: ticksOf(fixture.crowdTape) });
    expect(whale.outputs.largeBar[0]).toBeCloseTo(50, 9);
    expect(whale.outputs.smallBar[0]).toBe(0);
    expect(crowd.outputs.largeBar[0]).toBe(0);
    expect(crowd.outputs.smallBar[0]).toBeCloseTo(50, 9);
    expect(fixture.candle.trade_count).toBeNull();
    expect(barSides(fixture.whaleCandle).delta).toBeCloseTo(50, 9);
    expect(barSides(fixture.crowdCandle).delta).toBeCloseTo(50, 9);
    // In auto mode an isolated tape cannot classify before 200 sizes: honest null, not a guess.
    const auto = replayCapture(sizeSplitDeltaIndicator, [fixture.candle], AUTO, { ticks: ticksOf(fixture.whaleTape) });
    expect(auto.outputs.large[0]).toBeNull();
  });
});

describe("sizeSplitDelta -- 10,000 real BTC-USDT aggregate trades (recorded 2026-10-26)", () => {
  const BINANCE_SPOT: FixtureIdentity = { provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT" };

  function loadAggregates(): TradeFrame[] {
    const file = join(dirname(fileURLToPath(import.meta.url)), "../../../../workers/tests/fixtures/binance-mirror/aggtrades-btcusdt-10k.json.gz");
    const rows = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as [number, string, string, number, number][];
    return rows.map(([id, price, quantity, time, maker]) => ({ type: "trade", ...BINANCE_SPOT, ts_exchange: time, price: Number(price), size: Number(quantity), side: maker ? "sell" : "buy", trade_id: `a${id}` }) as TradeFrame);
  }

  it("the auto tier after each commit equals the test's nearest-rank p98 of the same ring, the share is 1 within 1e-9 and the tier totals equal the signed sum", () => {
    const prints = loadAggregates();
    expect(prints).toHaveLength(10_000);
    const firstMinute = Math.ceil(prints[0].ts_exchange / 60_000) * 60_000;
    const lastMinute = Math.floor(prints[prints.length - 1].ts_exchange / 60_000) * 60_000;
    const bars: BarFrame[] = [];
    const byBar: TradeFrame[][] = [];
    for (let tsOpen = firstMinute; tsOpen < lastMinute; tsOpen += 60_000) {
      const inside = prints.filter((print) => print.ts_exchange >= tsOpen && print.ts_exchange < tsOpen + 60_000);
      let volume = 0;
      let buy = 0;
      for (const print of inside) {
        volume += print.size;
        if (print.side === "buy") buy += print.size;
      }
      bars.push({ type: "bar", ...BINANCE_SPOT, interval_ms: 60_000, ts_open: tsOpen, open: inside[0].price, high: Math.max(...inside.map((print) => print.price)), low: Math.min(...inside.map((print) => print.price)), close: inside[inside.length - 1].price, volume, buy_volume: buy, sell_volume: volume - buy, trade_count: inside.length, closed: true } as BarFrame);
      byBar.push(inside);
    }
    expect(bars).toHaveLength(5);
    const ticks = ticksOf(tapeOf(prints, firstMinute));
    const engine = createSizeSplitEngine({ tierMode: "auto", tierSize: 0.5, anchor: "tape", K: 20, m: 2, q: 2, minTapeShare: 0.5 });
    const ring: number[] = [];
    let signed = 0;
    let tiered = 0;
    bars.forEach((bar, index) => {
      const reading = engine.onBar(bar, ticks);
      const expectedTier = ring.length < TIER_MIN_SIZES ? null : referenceNearestRank(ring.slice(-SIZE_RING_CAPACITY));
      expect(reading.tier).toBe(expectedTier);
      expect(reading.share).toBeCloseTo(1, 9);
      if (index > 0) {
        expect(expectedTier).not.toBeNull();
        expect(reading.valid).toBe(true);
        tiered += (reading.largeBar as number) + (reading.smallBar as number);
        for (const print of byBar[index]) signed += print.side === "buy" ? print.size : -print.size;
      }
      for (const print of byBar[index]) ring.push(print.size);
    });
    expect(tiered).toBeCloseTo(signed, 9);
    console.log(`sizeSplitDelta aggregates: ${bars.length} full minutes, ${bars.map((bar) => bar.trade_count).join("/")} aggregates per minute, tiers ${engine.committed.map((bar) => (bar.tierAtOpen === null ? "null" : bar.tierAtOpen.toFixed(5))).join(", ")}`);
  });
});

describe("sizeSplitDelta -- marker budget on the protocol's busy instrument (check 5)", () => {
  it("reports the budget on trendBars with busyTapeFor at default settings with onset-only arrows: 59 per 1,000, still above the 40 signal ceiling, because on a monotone trend the ring high is the previous bar and the condition rarely persists (PM decision)", () => {
    const { bars: raw } = trendBars({ count: 1000 });
    const printsByBar = busyTapeFor(raw, { printsPerBar: 60 });
    const bars = withTapeVolume(raw, printsByBar);
    const ticks = ticksOf(tapeOf(bars.flatMap((bar) => printsByBar.get(bar.ts_open) ?? []), bars[0].ts_open));
    const budget = countMarkers(sizeSplitDeltaIndicator, bars, SIZE_SPLIT_DEFAULT_SETTINGS, { extras: { ticks } });
    const verdict = judgeBudget(budget, 40, 2);
    console.log(summarizeBudget("sizeSplitDelta trendBars(1000) + busyTapeFor(60), defaults", budget, verdict));
    expect(budget.faulted).toBe(false);
    expect(budget.total).toBe(59);
    expect(budget.maxPerBar).toBe(1);
    // How often the condition persists from one bar to the next on this fixture: the onset rule can only remove those bars.
    const capture = replayCapture(sizeSplitDeltaIndicator, bars, { ...SIZE_SPLIT_DEFAULT_SETTINGS, showBarLines: true }, { ticks });
    const reference = referenceMarkers(bars.map((bar, index) => ({ close: bar.close, largeBar: capture.outputs.largeBar[index], smallBar: capture.outputs.smallBar[index] })), RULE);
    console.log(`sizeSplitDelta trendBars: condition held on ${reference.bearishHeld.length + reference.bullishHeld.length} bars, onsets ${reference.bearish.length + reference.bullish.length}`);
    expect(reference.bearish.length + reference.bullish.length).toBe(59);
    const deeper = countMarkers(sizeSplitDeltaIndicator, bars, { ...SIZE_SPLIT_DEFAULT_SETTINGS, m: 3 }, { extras: { ticks } });
    console.log(summarizeBudget("sizeSplitDelta same instrument, m = 3", deeper, judgeBudget(deeper, 40, 2)));
    const newHighs = bars.filter((bar, index) => index >= 20 && bar.close > Math.max(...bars.slice(index - 20, index).map((earlier) => earlier.close))).length;
    console.log(`sizeSplitDelta trendBars: ${newHighs} of ${bars.length - 20} bars close above their previous 20 closes`);
    expect(newHighs).toBeGreaterThan(500);
  }, 60_000);
});
