import { afterEach, describe, expect, it } from "vitest";
import { resetDrawOwnerScopeForTests } from "../../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../../chart/draw/registry";
import { countMarkers, judgeBudget, relativeVolumeEquityFixture, replayCapture, summarizeBudget } from "../../../../chart/validation";
import { RELATIVE_VOLUME_DEFAULT_SETTINGS, relativeVolumeIndicator } from "../../relativeVolume";
import { referenceSeries, type ReferenceRow } from "./reference";

// Validation loop 1, check 7 and Codex item 7: the baseline comparison recounted
// from the validator's batch reference (not from the engine under test), with
// the published counts pinned exactly and the false-positive rate divided by
// eligible non-anomaly bars as the code gate required.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const THRESHOLD = 2;
type Method = "timeOfDay" | "sameSlotMean" | "rolling";

interface Count {
  eligible: number;
  detections: number;
  anomaliesHit: number;
  falsePositives: number;
  predictableEligible: number;
  predictableFalsePositives: number;
}

function ratioFor(row: ReferenceRow, method: Method): number | null {
  return method === "timeOfDay" ? row.rvol : method === "sameSlotMean" ? row.slotMeanRatio : row.rolling;
}

function recount(fixture: ReturnType<typeof relativeVolumeEquityFixture>): Record<Method, Count> {
  const rows = referenceSeries(fixture.bars, { sessions: 10, minSessions: 3, clock: "newYork" });
  const anomalies = new Set(fixture.labels.anomalyIndices);
  const predictable = new Set(fixture.labels.predictableSlotIndices);
  const counts: Record<Method, Count> = {
    timeOfDay: { eligible: 0, detections: 0, anomaliesHit: 0, falsePositives: 0, predictableEligible: 0, predictableFalsePositives: 0 },
    sameSlotMean: { eligible: 0, detections: 0, anomaliesHit: 0, falsePositives: 0, predictableEligible: 0, predictableFalsePositives: 0 },
    rolling: { eligible: 0, detections: 0, anomaliesHit: 0, falsePositives: 0, predictableEligible: 0, predictableFalsePositives: 0 },
  };
  for (const index of fixture.labels.evaluationIndices) {
    const row = rows[index];
    if (row.rvol === null || row.slotMeanRatio === null || row.rolling === null) continue;
    for (const method of ["timeOfDay", "sameSlotMean", "rolling"] as const) {
      const count = counts[method];
      const detected = ratioFor(row, method)! >= THRESHOLD;
      count.eligible += 1;
      if (predictable.has(index)) count.predictableEligible += 1;
      if (!detected) continue;
      count.detections += 1;
      if (anomalies.has(index)) count.anomaliesHit += 1;
      else {
        count.falsePositives += 1;
        if (predictable.has(index)) count.predictableFalsePositives += 1;
      }
    }
  }
  return counts;
}

/** The code gate's denominator: eligible non-anomaly bars, not eligible minus hits. */
function falsePositiveRate(count: Count, anomaliesInEligible: number): number {
  return count.falsePositives / (count.eligible - anomaliesInEligible);
}

describe("baseline comparison recounted from the validator's reference", () => {
  const fixture = relativeVolumeEquityFixture();
  const counts = recount(fixture);

  it("pins the published equity-fixture table: 13/12/1 time of day, 12/12/0 same-slot mean, 32/12/20 rolling with 19 predictable-slot false positives", () => {
    expect(counts.timeOfDay).toEqual({ eligible: 4_680, detections: 13, anomaliesHit: 12, falsePositives: 1, predictableEligible: 240, predictableFalsePositives: 0 });
    expect(counts.sameSlotMean).toEqual({ eligible: 4_680, detections: 12, anomaliesHit: 12, falsePositives: 0, predictableEligible: 240, predictableFalsePositives: 0 });
    expect(counts.rolling).toEqual({ eligible: 4_680, detections: 32, anomaliesHit: 12, falsePositives: 20, predictableEligible: 240, predictableFalsePositives: 19 });
  });

  it("meets the brief's acceptance bounds", () => {
    expect(counts.timeOfDay.anomaliesHit).toBeGreaterThanOrEqual(11);
    expect(counts.timeOfDay.anomaliesHit).toBeGreaterThanOrEqual(counts.rolling.anomaliesHit - 1);
    const todPredictable = counts.timeOfDay.predictableFalsePositives / counts.timeOfDay.predictableEligible;
    const rollingPredictable = counts.rolling.predictableFalsePositives / counts.rolling.predictableEligible;
    expect(todPredictable).toBeLessThanOrEqual(0.1);
    expect(todPredictable).toBeLessThanOrEqual(rollingPredictable / 2);
    expect(rollingPredictable).toBeCloseTo(19 / 240, 12);
    // Overall false-positive rates on eligible non-anomaly bars (4,668).
    expect(falsePositiveRate(counts.timeOfDay, 12)).toBeCloseTo(1 / 4_668, 12);
    expect(falsePositiveRate(counts.rolling, 12)).toBeCloseTo(20 / 4_668, 12);
  });

  it("the indicator's own markers on the fixture are exactly the 13 time-of-day detections", () => {
    const capture = replayCapture(relativeVolumeIndicator, fixture.bars, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    const rows = referenceSeries(fixture.bars, { sessions: 10, minSessions: 3, clock: "newYork" });
    const detections = fixture.bars.map((bar, index) => ({ bar, index })).filter(({ index }) => rows[index].rvol !== null && rows[index].rvol! >= THRESHOLD);
    expect(detections).toHaveLength(13);
    expect(capture.markers.map((call) => call.time).sort((a, b) => a - b)).toEqual(detections.map(({ bar }) => bar.ts_open));
    for (const anomaly of fixture.labels.anomalyIndices) expect(capture.markers.some((call) => call.time === fixture.bars[anomaly].ts_open)).toBe(true);
  });

  it("pins the control experiment: flat seasonality makes the three methods agree except for the time-of-day method's one noise bar", () => {
    const control = recount(relativeVolumeEquityFixture({ flatSeasonality: true }));
    expect(control.timeOfDay).toEqual({ eligible: 4_680, detections: 13, anomaliesHit: 12, falsePositives: 1, predictableEligible: 240, predictableFalsePositives: 0 });
    expect(control.sameSlotMean).toEqual({ eligible: 4_680, detections: 12, anomaliesHit: 12, falsePositives: 0, predictableEligible: 240, predictableFalsePositives: 0 });
    expect(control.rolling).toEqual({ eligible: 4_680, detections: 12, anomaliesHit: 12, falsePositives: 0, predictableEligible: 240, predictableFalsePositives: 0 });
  });

  it("marker budget on the frozen fixture: 13 over 4,680 evaluated bars, 0.28 per 100, 2.8 per 1,000, with non-zero eligible outputs", () => {
    const budget = countMarkers(relativeVolumeIndicator, fixture.bars, RELATIVE_VOLUME_DEFAULT_SETTINGS);
    const eligible = replayCapture(relativeVolumeIndicator, fixture.bars, RELATIVE_VOLUME_DEFAULT_SETTINGS).outputs.rvol.filter((value) => value !== null).length;
    expect(eligible).toBe(4_680);
    expect(budget.total).toBe(13);
    expect((budget.total / fixture.labels.evaluationIndices.length) * 100).toBeCloseTo(0.2778, 3);
    expect(budget.maxPerBar).toBe(1);
    expect(judgeBudget(budget, 40, 3).ok).toBe(true);
    console.log(summarizeBudget("relativeVolume frozen equity fixture", budget, judgeBudget(budget, 40, 3)));
  });
});
