import { afterEach, describe, expect, it } from "vitest";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import type { BarFrame } from "../../../../types/frames";
import { BINANCE_PERP, MINUTE_MS, RVOL_EQUITY_ANOMALIES, barFrame, countMarkers, judgeBudget, relativeVolumeEquityFixture, replayCapture, summarizeBudget } from "../../../chart/validation";
import { RELATIVE_VOLUME_DEFAULT_SETTINGS, relativeVolumeIndicator } from "../relativeVolume";
import { createRelativeVolumeEngine } from "../relativeVolumeMath";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * Brief, "Baseline comparison": three methods at the same threshold on the same
 * eligible bars. Time of day (slot median) is the indicator; rolling (mean of
 * the previous 20 committed volumes) is the baseline a plain RVOL gives; the
 * same-slot mean separates the benefit of the clock from the benefit of the
 * median. Counts and rates are printed as the table the doc page quotes.
 */

const THRESHOLD = 2;
const METHODS = ["timeOfDay", "sameSlotMean", "rolling"] as const;
type Method = (typeof METHODS)[number];

interface MethodResult {
  eligible: number;
  detections: number;
  anomaliesHit: number;
  falsePositives: number;
  predictableEligible: number;
  predictableFalsePositives: number;
}

export interface ComparisonTable {
  anomalies: number;
  results: Record<Method, MethodResult>;
}

function emptyResult(): MethodResult {
  return { eligible: 0, detections: 0, anomaliesHit: 0, falsePositives: 0, predictableEligible: 0, predictableFalsePositives: 0 };
}

export function compareMethods(fixture: ReturnType<typeof relativeVolumeEquityFixture>): ComparisonTable {
  const { bars, labels } = fixture;
  const engine = createRelativeVolumeEngine({ sessions: RELATIVE_VOLUME_DEFAULT_SETTINGS.sessions, minSessions: RELATIVE_VOLUME_DEFAULT_SETTINGS.minSessions, clock: "auto" });
  const results: Record<Method, MethodResult> = { timeOfDay: emptyResult(), sameSlotMean: emptyResult(), rolling: emptyResult() };
  const anomalyIndices = new Set(labels.anomalyIndices);
  const predictableSlotIndices = new Set(labels.predictableSlotIndices);
  const evaluationIndices = new Set(labels.evaluationIndices);
  for (let index = 0; index < bars.length; index += 1) {
    const reading = engine.onBar(bars[index]);
    if (!evaluationIndices.has(index)) continue;
    const ratios: Record<Method, number | null> = { timeOfDay: reading.rvol, sameSlotMean: reading.slotMeanRatio, rolling: reading.rolling };
    // Readiness is asserted from actual prior observations per key, never from a calendar day number.
    if (METHODS.some((method) => ratios[method] === null)) continue;
    const anomaly = anomalyIndices.has(index);
    const predictable = predictableSlotIndices.has(index);
    for (const method of METHODS) {
      const result = results[method];
      const detected = (ratios[method] as number) >= THRESHOLD;
      result.eligible += 1;
      if (predictable) result.predictableEligible += 1;
      if (detected) result.detections += 1;
      if (anomaly && detected) result.anomaliesHit += 1;
      if (!anomaly && detected) {
        result.falsePositives += 1;
        if (predictable) result.predictableFalsePositives += 1;
      }
    }
  }
  return { anomalies: labels.anomalies.length, results };
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "n/a" : `${((100 * numerator) / denominator).toFixed(2)}%`;
}

/** Eligible non-anomaly bars: the denominator of the overall false-positive rate, whatever the recall. */
export function nonAnomalyBars(result: MethodResult, anomaliesEligible: number): number {
  return result.eligible - anomaliesEligible;
}

/** Fraction of eligible non-anomaly bars a method marked; `anomaliesEligible` counts the anomalies among the eligible bars, hit or missed. */
export function falsePositiveRate(result: MethodResult, anomaliesEligible: number): number {
  const denominator = nonAnomalyBars(result, anomaliesEligible);
  return denominator === 0 ? 0 : result.falsePositives / denominator;
}

const METHOD_LABELS: Record<Method, string> = {
  timeOfDay: "Time of day (slot median)",
  sameSlotMean: "Same-slot mean",
  rolling: "Rolling 20 mean",
};

export function formatComparison(title: string, table: ComparisonTable): string {
  // Every anomaly lies in sessions 4..15 and every method is ready there, so all of them are eligible.
  const anomaliesEligible = table.anomalies;
  const lines = [
    `${title} (threshold ${THRESHOLD.toFixed(1)}, ${table.anomalies} anomalies)`,
    "| Method | Eligible bars | Detections | Anomalies hit | Recall | False positives | FP rate | Predictable-slot bars | Predictable-slot FPs | Predictable-slot FP rate |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const method of METHODS) {
    const r = table.results[method];
    lines.push(
      `| ${METHOD_LABELS[method]} | ${r.eligible} | ${r.detections} | ${r.anomaliesHit}/${table.anomalies} | ${pct(r.anomaliesHit, table.anomalies)} | ${r.falsePositives} | ${pct(r.falsePositives, nonAnomalyBars(r, anomaliesEligible))} | ${r.predictableEligible} | ${r.predictableFalsePositives} | ${pct(r.predictableFalsePositives, r.predictableEligible)} |`,
    );
  }
  return lines.join("\n");
}

describe("relativeVolume beats the baseline on labelled fixtures (brief: baseline comparison)", () => {
  const fixture = relativeVolumeEquityFixture();
  const table = compareMethods(fixture);
  const tod = table.results.timeOfDay;
  const rolling = table.results.rolling;

  it("the fixture is the frozen one: 15 sessions, 12 anomalies in sessions 4..15 and minutes 90..330", () => {
    expect(fixture.bars).toHaveLength(15 * 390);
    expect(fixture.labels.anomalies).toHaveLength(RVOL_EQUITY_ANOMALIES);
    for (const anomaly of fixture.labels.anomalies) {
      expect(anomaly.session).toBeGreaterThanOrEqual(4);
      expect(anomaly.session).toBeLessThanOrEqual(15);
      expect(anomaly.minute).toBeGreaterThanOrEqual(90);
      expect(anomaly.minute).toBeLessThanOrEqual(330);
    }
    expect(fixture.labels.evaluationIndices).toHaveLength(12 * 390);
    expect(fixture.labels.predictableSlotIndices.filter((index) => index >= 3 * 390)).toHaveLength(12 * 20);
  });

  it("every evaluation bar is eligible for all three methods", () => {
    console.log(formatComparison("Equity fixture", table));
    expect(tod.eligible).toBe(12 * 390);
    expect(table.results.sameSlotMean.eligible).toBe(tod.eligible);
    expect(rolling.eligible).toBe(tod.eligible);
  });

  it("pins the published counts: time of day 13/12/1 with 0 of 240 predictable, same-slot mean 12/12/0, rolling 32/12/20 with 19 of 240 predictable", () => {
    const counts = (r: MethodResult) => [r.detections, r.anomaliesHit, r.falsePositives, r.predictableEligible, r.predictableFalsePositives];
    expect(counts(tod)).toEqual([13, 12, 1, 240, 0]);
    expect(counts(table.results.sameSlotMean)).toEqual([12, 12, 0, 240, 0]);
    expect(counts(rolling)).toEqual([32, 12, 20, 240, 19]);
    // Overall false-positive rates divide by the eligible non-anomaly bars (4,668), not by eligible minus hits.
    expect(nonAnomalyBars(tod, table.anomalies)).toBe(4_668);
    expect(falsePositiveRate(tod, table.anomalies)).toBeCloseTo(1 / 4_668, 12);
    expect(falsePositiveRate(rolling, table.anomalies)).toBeCloseTo(20 / 4_668, 12);
    expect(formatComparison("x", table)).toContain("| 20 | 0.43% | 240 | 19 | 7.92% |");
  });

  it("hand-computed: a method that misses an anomaly still divides its false positives by the non-anomaly bars", () => {
    // 100 eligible bars, 3 anomalies, the method hits 2 of them and marks 4 other bars.
    const missed: MethodResult = { eligible: 100, detections: 6, anomaliesHit: 2, falsePositives: 4, predictableEligible: 10, predictableFalsePositives: 1 };
    expect(nonAnomalyBars(missed, 3)).toBe(97);
    expect(falsePositiveRate(missed, 3)).toBeCloseTo(4 / 97, 12);
    // `eligible - anomaliesHit` would be 98, the wrong denominator once an anomaly is missed.
    expect(missed.eligible - missed.anomaliesHit).toBe(98);
    const line = formatComparison("missed", { anomalies: 3, results: { timeOfDay: missed, sameSlotMean: missed, rolling: missed } }).split("\n")[3];
    expect(line).toBe("| Time of day (slot median) | 100 | 6 | 2/3 | 66.67% | 4 | 4.12% | 10 | 1 | 10.00% |");
  });

  it("time-of-day recall on the 12 anomalies is at least 11/12 and at least rolling recall minus one", () => {
    expect(tod.anomaliesHit).toBeGreaterThanOrEqual(11);
    expect(tod.anomaliesHit).toBeGreaterThanOrEqual(rolling.anomaliesHit - 1);
  });

  it("time-of-day predictable-slot false positives are at most 10 percent of those bars and at most half of rolling's rate", () => {
    const todRate = tod.predictableFalsePositives / tod.predictableEligible;
    const rollingRate = rolling.predictableFalsePositives / rolling.predictableEligible;
    expect(todRate).toBeLessThanOrEqual(0.1);
    expect(todRate).toBeLessThanOrEqual(rollingRate / 2);
  });

  it("the time-of-day method has strictly fewer false positives than rolling at equal or better recall", () => {
    expect(tod.falsePositives).toBeLessThan(rolling.falsePositives);
    expect(tod.anomaliesHit).toBeGreaterThanOrEqual(rolling.anomaliesHit - 1);
  });

  it("the indicator's rvol line equals the engine's ratio bar for bar", () => {
    const capture = replayCapture(relativeVolumeIndicator, fixture.bars, { ...RELATIVE_VOLUME_DEFAULT_SETTINGS, showRolling: true });
    const engine = createRelativeVolumeEngine({ sessions: 10, minSessions: 3, clock: "auto" });
    expect(capture.faulted).toBe(false);
    fixture.bars.forEach((bar, index) => {
      const reading = engine.onBar(bar);
      expect(capture.outputs.rvol[index]).toBe(reading.rvol);
      expect(capture.outputs.rolling[index]).toBe(reading.rolling);
    });
  });

  it("control experiment: flat seasonality, anomalies from every minute (reported, not a gate)", () => {
    const control = relativeVolumeEquityFixture({ flatSeasonality: true });
    expect(control.labels.regime).toBe("relativeVolumeEquityFlat");
    const controlTable = compareMethods(control);
    console.log(formatComparison("Control fixture (flat seasonality)", controlTable));
    expect(controlTable.results.timeOfDay.eligible).toBe(12 * 390);
    // Published control counts: when the clock explains nothing the three methods agree on the anomalies and rolling stops misfiring.
    const counts = (r: MethodResult) => [r.detections, r.anomaliesHit, r.falsePositives];
    expect(counts(controlTable.results.timeOfDay)).toEqual([13, 12, 1]);
    expect(counts(controlTable.results.sameSlotMean)).toEqual([12, 12, 0]);
    expect(counts(controlTable.results.rolling)).toEqual([12, 12, 0]);
    expect(controlTable.results.rolling.predictableFalsePositives).toBe(0);
  });
});

/** Eligible bars: the ones with a ratio; a budget judged on an indicator that drew nothing proves nothing. */
function eligibleOutputs(bars: readonly BarFrame[]): number {
  return replayCapture(relativeVolumeIndicator, bars, RELATIVE_VOLUME_DEFAULT_SETTINGS).outputs.rvol.filter((value) => value !== null).length;
}

function minuteBars(count: number, volumeAt: (index: number) => number): BarFrame[] {
  const t0 = Date.UTC(2026, 2, 2);
  return Array.from({ length: count }, (_, index) => barFrame(t0 + index * MINUTE_MS, { open: 1, close: 1, high: 1, low: 1, volume: volumeAt(index) }, BINANCE_PERP));
}

describe("relativeVolume marker budget (success criterion 5 and protocol check 5)", () => {
  it("emits fewer than 2 hot markers per 100 evaluated bars on the equity fixture, anomalies included: 13 over 4,680", () => {
    const { bars, labels } = relativeVolumeEquityFixture();
    const budget = countMarkers(relativeVolumeIndicator, bars, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    const evaluated = labels.evaluationIndices.length;
    const per100 = (budget.total / evaluated) * 100;
    console.log(`${summarizeBudget("relativeVolume equity fixture", budget)}; ${budget.total} over ${evaluated} evaluated bars = ${per100.toFixed(2)} per 100`);
    expect(eligibleOutputs(bars)).toBe(evaluated);
    expect(budget.total).toBe(13);
    expect(per100).toBeLessThan(2);
    expect(budget.maxPerBar).toBe(1);
    expect(budget.byShape).toEqual({ circle: budget.total });
    expect(budget.byPosition).toEqual({ aboveBar: budget.total });
    expect(judgeBudget(budget, 200, 3).ok).toBe(true);
    expect(judgeBudget(budget, 40, 3).ok).toBe(true);
  });

  it("a session-wide volume shift marks every eligible bar (1,000 per 1,000), which is the correct reading of such a session; a one-hour burst marks exactly that hour", () => {
    const shift = minuteBars(4 * 1_440, (index) => (index < 3 * 1_440 ? 100 : 250));
    const shiftBudget = countMarkers(relativeVolumeIndicator, shift, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    const shiftEligible = eligibleOutputs(shift);
    expect(shiftEligible).toBe(1_440);
    expect(shiftBudget.total).toBe(1_440);
    expect(shiftBudget.maxPerBar).toBe(1);
    console.log(`${summarizeBudget("session-wide shift (3 days at 100, then 250)", shiftBudget)}; ${shiftBudget.total} of ${shiftEligible} eligible = ${((shiftBudget.total / shiftEligible) * 1_000).toFixed(0)} per 1,000 eligible`);
    const burst = minuteBars(4 * 1_440, (index) => (index >= 3 * 1_440 + 600 && index < 3 * 1_440 + 660 ? 300 : 100));
    const burstBudget = countMarkers(relativeVolumeIndicator, burst, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(eligibleOutputs(burst)).toBe(1_440);
    expect(burstBudget.total).toBe(60);
    expect(judgeBudget(burstBudget, 200, 3).ok).toBe(true);
  });

  it("stays under the protocol ceilings on four quiet UTC days with eligible outputs on the fourth", () => {
    const quiet = minuteBars(4 * 1_440, (index) => 100 + ((index * 7919) % 41));
    const budget = countMarkers(relativeVolumeIndicator, quiet, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(eligibleOutputs(quiet)).toBe(1_440);
    expect(budget.total).toBe(0);
    expect(judgeBudget(budget, 40, 3).ok).toBe(true);
  });
});
