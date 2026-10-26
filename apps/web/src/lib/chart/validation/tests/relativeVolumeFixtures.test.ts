import { describe, expect, it } from "vitest";
import { nyLocalMinuteOfDay } from "../../../indicators/killzones/killzones";
import { barSides } from "../../../indicators/barSides";
import {
  MINUTE_MS,
  RVOL_CRYPTO_BARS,
  RVOL_EQUITY_ANOMALIES,
  RVOL_EQUITY_BARS_PER_SESSION,
  RVOL_EQUITY_SESSIONS,
  mulberry32,
  relativeVolumeCryptoFixture,
  relativeVolumeEquityFixture,
  relativeVolumeExpectedCrypto,
  relativeVolumeExpectedEquity,
  standardNormals,
} from "../fixtures";

// The frozen fixtures of PM/cycle1/brief-rvol-clock.md. The builder's baseline
// comparison and the validation loop both import these, so what is pinned here
// is what the doc page's numbers rest on.

describe("generators", () => {
  it("mulberry32 is deterministic and uniform on [0, 1)", () => {
    const a = mulberry32(20261026);
    const b = mulberry32(20261026);
    const draws = Array.from({ length: 1_000 }, () => a());
    expect(draws).toEqual(Array.from({ length: 1_000 }, () => b()));
    expect(draws.every((u) => u >= 0 && u < 1)).toBe(true);
    expect(draws.reduce((sum, u) => sum + u, 0) / 1_000).toBeCloseTo(0.5, 1);
  });

  it("Box-Muller consumes two uniforms per pair and yields both normals in order", () => {
    const consumed: number[] = [];
    const uniform = () => {
      consumed.push(consumed.length);
      return [0.25, 0.125, 0.5, 0.75][consumed.length - 1];
    };
    const normal = standardNormals(uniform);
    const r = Math.sqrt(-2 * Math.log(1 - 0.25));
    expect(normal()).toBeCloseTo(r * Math.cos(2 * Math.PI * 0.125), 12);
    expect(consumed).toHaveLength(2);
    expect(normal()).toBeCloseTo(r * Math.sin(2 * Math.PI * 0.125), 12);
    expect(consumed).toHaveLength(2);
    normal();
    expect(consumed).toHaveLength(4);
    const many = standardNormals(mulberry32(1));
    const sample = Array.from({ length: 20_000 }, () => many());
    const mean = sample.reduce((sum, z) => sum + z, 0) / sample.length;
    const variance = sample.reduce((sum, z) => sum + (z - mean) ** 2, 0) / sample.length;
    expect(mean).toBeCloseTo(0, 1);
    expect(variance).toBeCloseTo(1, 1);
  });
});

describe("relativeVolumeEquityFixture", () => {
  const { bars, labels } = relativeVolumeEquityFixture();

  it("is 15 sessions of 390 one-minute bars starting Monday 2026-03-02 09:30 New York, every session keyed identically across the DST change", () => {
    expect(bars).toHaveLength(RVOL_EQUITY_SESSIONS * RVOL_EQUITY_BARS_PER_SESSION);
    expect(labels.sessionDates[0]).toBe("2026-03-02");
    expect(labels.sessionDates).toHaveLength(15);
    expect(labels.sessionDates[4]).toBe("2026-03-06");
    expect(labels.sessionDates[5]).toBe("2026-03-09");
    expect(labels.sessionDates[14]).toBe("2026-03-20");
    for (const [session, start] of labels.sessionStarts.entries()) {
      expect(nyLocalMinuteOfDay(start)).toBe(9 * 60 + 30);
      expect(bars[session * 390].ts_open).toBe(start);
      expect(nyLocalMinuteOfDay(bars[session * 390 + 389].ts_open)).toBe(15 * 60 + 59);
    }
    // EST before the change, EDT after: the UTC offsets differ by one hour.
    expect((labels.sessionStarts[5] - labels.sessionStarts[4]) % (24 * 60 * MINUTE_MS)).toBe(23 * 60 * MINUTE_MS);
    expect(labels.sessionStarts[0] % (24 * 60 * MINUTE_MS)).toBe((9 * 60 + 30 + 5 * 60) * MINUTE_MS);
    expect(labels.sessionStarts[14] % (24 * 60 * MINUTE_MS)).toBe((9 * 60 + 30 + 4 * 60) * MINUTE_MS);
    expect(bars.every((bar, index) => index === 0 || bar.ts_open > bars[index - 1].ts_open)).toBe(true);
    expect(bars[0].provider).toBe("DXFEED");
    expect(barSides(bars[0]).known).toBe(false);
  });

  it("follows the U-curve: E(0) = 4V, E(60..330) = V, E(389) = 2V", () => {
    expect(relativeVolumeExpectedEquity(0)).toBe(4_000);
    expect(relativeVolumeExpectedEquity(30)).toBe(1_750);
    expect(relativeVolumeExpectedEquity(60)).toBe(1_000);
    expect(relativeVolumeExpectedEquity(330)).toBe(1_000);
    expect(relativeVolumeExpectedEquity(389)).toBe(2_000);
    expect(labels.expectedVolumes).toHaveLength(390);
    const meanAt = (minute: number) => labels.sessionStarts.reduce((sum, _, session) => sum + bars[session * 390 + minute].volume, 0) / 15;
    // Across 15 sessions the log-normal noise averages out to within a few percent of E(m) (anomalies are kept out of these minutes).
    expect(meanAt(0) / relativeVolumeExpectedEquity(0)).toBeGreaterThan(0.9);
    expect(meanAt(0) / relativeVolumeExpectedEquity(0)).toBeLessThan(1.15);
    expect(meanAt(385) / relativeVolumeExpectedEquity(385)).toBeGreaterThan(0.9);
    expect(meanAt(385) / relativeVolumeExpectedEquity(385)).toBeLessThan(1.15);
  });

  it("is deterministic and reproduces its own noise model bar for bar", () => {
    const again = relativeVolumeEquityFixture();
    expect(again.bars).toEqual(bars);
    expect(again.labels).toEqual(labels);
    const normal = standardNormals(mulberry32(labels.seed));
    for (let index = 0; index < 3 * 390; index += 1) {
      const minute = index % 390;
      expect(bars[index].volume).toBe(Math.round(relativeVolumeExpectedEquity(minute) * Math.exp(0.15 * normal())));
    }
  });

  it("holds exactly twelve distinct anomalies in sessions 4..15, minutes 90..330, each at 2.5 E(m)", () => {
    expect(labels.anomalies).toHaveLength(RVOL_EQUITY_ANOMALIES);
    expect(new Set(labels.anomalyIndices).size).toBe(12);
    for (const anomaly of labels.anomalies) {
      expect(anomaly.session).toBeGreaterThanOrEqual(4);
      expect(anomaly.session).toBeLessThanOrEqual(15);
      expect(anomaly.minute).toBeGreaterThanOrEqual(90);
      expect(anomaly.minute).toBeLessThanOrEqual(330);
      expect(anomaly.index).toBe((anomaly.session - 1) * 390 + anomaly.minute);
      expect(bars[anomaly.index].volume).toBe(Math.round(2.5 * relativeVolumeExpectedEquity(anomaly.minute)));
      expect(bars[anomaly.index].volume).toBe(2_500);
    }
    expect(labels.anomalyIndices).toEqual([...labels.anomalyIndices].sort((a, b) => a - b));
  });

  it("labels the predictable slots and the evaluation bars", () => {
    expect(labels.predictableSlotIndices).toHaveLength(15 * 20);
    for (const index of labels.predictableSlotIndices) {
      const minute = index % 390;
      expect(minute < 10 || minute >= 380).toBe(true);
    }
    expect(labels.evaluationIndices).toHaveLength(12 * 390);
    expect(labels.evaluationIndices[0]).toBe(3 * 390);
    expect(labels.evaluationSessions).toEqual({ first: 4, last: 15 });
    expect(labels.anomalyIndices.every((index) => labels.evaluationIndices.includes(index))).toBe(true);
  });

  it("the flat control keeps the same noise stream but no seasonality and anomalies anywhere in the session", () => {
    const flat = relativeVolumeEquityFixture({ flatSeasonality: true });
    expect(flat.labels.regime).toBe("relativeVolumeEquityFlat");
    expect(flat.labels.expectedVolumes.every((volume) => volume === 1_000)).toBe(true);
    const normal = standardNormals(mulberry32(flat.labels.seed));
    expect(flat.bars[0].volume).toBe(Math.round(1_000 * Math.exp(0.15 * normal())));
    expect(flat.labels.anomalies).toHaveLength(12);
    expect(flat.labels.anomalies.every((anomaly) => flat.bars[anomaly.index].volume === 2_500)).toBe(true);
    expect(flat.labels.anomalies.some((anomaly) => anomaly.minute < 90 || anomaly.minute > 330)).toBe(true);
  });
});

describe("relativeVolumeCryptoFixture", () => {
  const { bars, labels } = relativeVolumeCryptoFixture();

  it("is 12,000 contiguous one-minute Binance bars from 2026-03-02 00:00 UTC with a cosine day", () => {
    expect(bars).toHaveLength(RVOL_CRYPTO_BARS);
    expect(bars[0].ts_open).toBe(Date.UTC(2026, 2, 2));
    expect(bars.every((bar, index) => bar.ts_open === labels.startTs + index * MINUTE_MS)).toBe(true);
    expect(bars[0].provider).toBe("BINANCE");
    expect(barSides(bars[0])).toMatchObject({ known: true, unknown: 0 });
    expect(labels.minuteOfDay[0]).toBe(0);
    expect(labels.minuteOfDay[840]).toBe(840);
    expect(labels.minuteOfDay[1440]).toBe(0);
    expect(relativeVolumeExpectedCrypto(840)).toBe(1_500);
    expect(relativeVolumeExpectedCrypto(120)).toBeCloseTo(500, 9);
    expect(labels.expectedVolumes).toHaveLength(1440);
    expect(labels.timingIndices).toEqual({ first: 0, last: 10_079 });
    expect(labels.rebuiltFromIndex).toBe(1_920);
  });

  it("is deterministic and reproduces its noise model from seed 20261027", () => {
    expect(relativeVolumeCryptoFixture().bars).toEqual(bars);
    expect(labels.seed).toBe(20261027);
    const normal = standardNormals(mulberry32(labels.seed));
    for (let index = 0; index < 2_000; index += 1) {
      expect(bars[index].volume).toBe(Math.round(relativeVolumeExpectedCrypto(labels.minuteOfDay[index]) * Math.exp(0.15 * normal())));
    }
    const dayMean = (minute: number) => {
      let sum = 0;
      let count = 0;
      for (let index = minute; index < bars.length; index += 1440) {
        sum += bars[index].volume;
        count += 1;
      }
      return sum / count;
    };
    expect(dayMean(840)).toBeGreaterThan(dayMean(120) * 2.5);
  });
});
