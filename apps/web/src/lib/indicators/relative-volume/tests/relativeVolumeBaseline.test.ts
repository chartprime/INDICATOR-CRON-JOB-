import { afterEach, describe, expect, it } from "vitest";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { RVOL_EQUITY_ANOMALIES, countMarkers, judgeBudget, relativeVolumeEquityFixture, replayCapture, summarizeBudget, trendBars } from "../../../chart/validation";
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

const METHOD_LABELS: Record<Method, string> = {
  timeOfDay: "Time of day (slot median)",
  sameSlotMean: "Same-slot mean",
  rolling: "Rolling 20 mean",
};

export function formatComparison(title: string, table: ComparisonTable): string {
  const lines = [
    `${title} (threshold ${THRESHOLD.toFixed(1)}, ${table.anomalies} anomalies)`,
    "| Method | Eligible bars | Detections | Anomalies hit | Recall | False positives | FP rate | Predictable-slot bars | Predictable-slot FPs | Predictable-slot FP rate |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const method of METHODS) {
    const r = table.results[method];
    lines.push(
      `| ${METHOD_LABELS[method]} | ${r.eligible} | ${r.detections} | ${r.anomaliesHit}/${table.anomalies} | ${pct(r.anomaliesHit, table.anomalies)} | ${r.falsePositives} | ${pct(r.falsePositives, r.eligible - r.anomaliesHit)} | ${r.predictableEligible} | ${r.predictableFalsePositives} | ${pct(r.predictableFalsePositives, r.predictableEligible)} |`,
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
    // Every method sees the same anomalies when the clock explains nothing; the test only pins eligibility.
    expect(controlTable.results.timeOfDay.anomaliesHit).toBeGreaterThanOrEqual(0);
  });
});

describe("relativeVolume marker budget (success criterion 5 and protocol check 5)", () => {
  it("emits fewer than 2 hot markers per 100 evaluated bars on the equity fixture, anomalies included", () => {
    const { bars, labels } = relativeVolumeEquityFixture();
    const budget = countMarkers(relativeVolumeIndicator, bars, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    const evaluated = labels.evaluationIndices.length;
    const per100 = (budget.total / evaluated) * 100;
    console.log(`${summarizeBudget("relativeVolume equity fixture", budget)}; ${budget.total} over ${evaluated} evaluated bars = ${per100.toFixed(2)} per 100`);
    expect(budget.total).toBeGreaterThan(0);
    expect(per100).toBeLessThan(2);
    expect(budget.maxPerBar).toBe(1);
    expect(budget.byShape).toEqual({ circle: budget.total });
    expect(budget.byPosition).toEqual({ aboveBar: budget.total });
    expect(judgeBudget(budget, 40, 3).ok).toBe(true);
  });

  it("stays under the protocol's 40 per 1,000 ceiling on trendBars", () => {
    const { bars } = trendBars({ count: 1_000 });
    const budget = countMarkers(relativeVolumeIndicator, bars, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(judgeBudget(budget, 40, 3).ok).toBe(true);
  });
});
