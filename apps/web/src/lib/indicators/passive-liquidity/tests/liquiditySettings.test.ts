import { describe, expect, it } from "vitest";
import { LIQUIDITY_HISTORY_OPTIONS, historyDaysLabel, historyDaysOf, historyReachFor } from "../liquiditySettings";

describe("the history reach setting", () => {
  it("starts at one day, offers 1, 3, 5 and 7, and reads anything else saved as one day", () => {
    expect(DEFAULT_LIQUIDITY_SETTINGS.historyDays).toBe(1);
    expect(LIQUIDITY_HISTORY_OPTIONS.map(([days]) => days)).toEqual([1, 3, 5, 7]);
    expect(historyDaysOf({ historyDays: 5 })).toBe(5);
    expect(historyDaysOf({ historyDays: 2 })).toBe(1);
    expect(historyDaysOf({ historyDays: Number.NaN })).toBe(1);
    expect(historyDaysLabel(7)).toBe("1 week");
    expect(historyDaysLabel(1)).toBe("1 day");
  });

  it("loads a day at one-minute columns and longer reaches at five minutes, each over its whole span", () => {
    expect(historyReachFor(1)).toEqual({ levelMs: 60_000, reachMs: 86_400_000 });
    expect(historyReachFor(3)).toEqual({ levelMs: 300_000, reachMs: 3 * 86_400_000 });
    expect(historyReachFor(7)).toEqual({ levelMs: 300_000, reachMs: 7 * 86_400_000 });
  });
});
import {
  BAND_FACTOR_STEPS,
  BAND_MIN_SHARE,
  bandFactorFor,
  bandSpan,
  clusterRowsFor,
  minBandSizeFor,
  clusterIndex,
  DEFAULT_LIQUIDITY_SETTINGS,
  formatLiquiditySize,
  formatLiquiditySpan,
  formatWholeSize,
  liquidityReference,
  formatWallAge,
} from "../liquiditySettings";

describe("formatWallAge", () => {
  it("formats ages compactly", () => {
    expect(formatWallAge(0)).toBe("0s");
    expect(formatWallAge(45_000)).toBe("45s");
    expect(formatWallAge(12 * 60_000)).toBe("12m");
    expect(formatWallAge(90 * 60_000)).toBe("1.5h");
  });
});

describe("defaults", () => {
  it("clusters two server rows to a band and paints everything until a floor is set", () => {
    expect(DEFAULT_LIQUIDITY_SETTINGS.clusterRows).toBe(2);
    expect(DEFAULT_LIQUIDITY_SETTINGS.quietBands).toBe(16); // about $128 either side of price on BTC: walls only there
    expect(DEFAULT_LIQUIDITY_SETTINGS.minBandSize).toBe(0); // everything shows until the trader sets a floor
    expect(DEFAULT_LIQUIDITY_SETTINGS.levelFilter).toBe("all");
    expect(DEFAULT_LIQUIDITY_SETTINGS.showPulled).toBe(true); // "Display pulled": yes by default, its own switch
  });

  it("assigns rows to bands by absolute index, so a band never moves with the view", () => {
    expect([0, 1, 2, 3, 4].map((row) => clusterIndex(row, 2))).toEqual([0, 0, 1, 1, 2]);
    expect(clusterIndex(19_950, 4)).toBe(4_987);
    expect(clusterIndex(7, 1)).toBe(7);
    expect(clusterIndex(7, 0)).toBe(7); // never fewer than one row to a band
  });

  it("makes a band thicker with size, centred in its row, never past the row", () => {
    expect(bandSpan(0, 12)).toEqual({ offset: 4, size: 3 }); // a quarter of the row when empty-ish
    expect(bandSpan(1, 12)).toEqual({ offset: 0, size: 12 }); // the whole row when saturated
    expect(bandSpan(0.5, 12).size).toBeGreaterThan(bandSpan(0.25, 12).size);
    expect(bandSpan(2, 12)).toEqual({ offset: 0, size: 12 }); // clamped
    expect(bandSpan(0.5, 1)).toEqual({ offset: 0, size: 1 }); // a one-pixel row is still drawn
    expect(BAND_MIN_SHARE).toBeGreaterThan(0);
    for (const h of [3, 7, 20]) for (const i of [0, 0.3, 0.9, 1]) {
      const { offset, size } = bandSpan(i, h);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset + size).toBeLessThanOrEqual(h);
    }
  });
});

describe("bandFactorFor", () => {
  const MIN = 60_000;

  it("widens the band with the chart: as set under the hour, x3 from 15m, x8 from the hour, x30 from four hours, x80 from the day", () => {
    // The trader's ask of 2026-09-24: a level on 4h is a size a $400 band holds, not a $12 one.
    expect([1, 3, 5, 10, 14].map((m) => bandFactorFor(m * MIN))).toEqual([1, 1, 1, 1, 1]);
    expect([15, 30, 59].map((m) => bandFactorFor(m * MIN))).toEqual([3, 3, 3]);
    expect([60, 120, 239].map((m) => bandFactorFor(m * MIN))).toEqual([8, 8, 8]);
    expect([240, 720, 1439].map((m) => bandFactorFor(m * MIN))).toEqual([30, 30, 30]);
    expect([1440, 7 * 1440].map((m) => bandFactorFor(m * MIN))).toEqual([80, 80]);
    expect(BAND_FACTOR_STEPS.map(([, factor]) => factor)).toEqual([80, 30, 8, 3]);
  });

  it("multiplies the trader's cluster by the factor, in whole rows, never under one", () => {
    expect(clusterRowsFor({ clusterRows: 3 }, MIN)).toBe(3);
    expect(clusterRowsFor({ clusterRows: 3 }, 15 * MIN)).toBe(9);
    expect(clusterRowsFor({ clusterRows: 3 }, 60 * MIN)).toBe(24);
    expect(clusterRowsFor({ clusterRows: 12 }, 240 * MIN)).toBe(360);
    expect(clusterRowsFor({ clusterRows: 2.9 }, MIN)).toBe(2);
    expect(clusterRowsFor({ clusterRows: 0 }, 240 * MIN)).toBe(1);
  });

  it("raises the trader's size floor with the band on crypto, which sums its rows, and not on an index, which reads its biggest", () => {
    expect(minBandSizeFor({ minBandSize: 8 }, "crypto", MIN)).toBe(8);
    expect(minBandSizeFor({ minBandSize: 8 }, "crypto", 60 * MIN)).toBe(64);
    expect(minBandSizeFor({ minBandSize: 20 }, "index", 60 * MIN)).toBe(20);
    expect(minBandSizeFor({ minBandSize: -1 }, "crypto", 60 * MIN)).toBe(0);
  });
});

describe("liquidityReference", () => {
  it("follows the grid in auto mode and the setting in fixed mode; on a lane of wider rows the fixed size, set per row of the finest lane, grows with the row", () => {
    expect(liquidityReference(DEFAULT_LIQUIDITY_SETTINGS, { referenceSize: 7 })).toBe(7);
    expect(liquidityReference(DEFAULT_LIQUIDITY_SETTINGS, { referenceSize: 7 }, 2)).toBe(7);
    expect(liquidityReference({ ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "fixed", scaleSize: 3 }, { referenceSize: 7 })).toBe(3);
    expect(liquidityReference({ ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "fixed", scaleSize: 3 }, { referenceSize: 7 }, 2)).toBe(6);
    expect(liquidityReference({ ...DEFAULT_LIQUIDITY_SETTINGS, scaleMode: "fixed", scaleSize: 0 }, { referenceSize: 7 }, 2)).toBe(0);
  });
});

describe("formatLiquiditySpan", () => {
  it("says minutes under an hour and a half, hours beyond", () => {
    expect(formatLiquiditySpan(0)).toBe("0 min");
    expect(formatLiquiditySpan(20 * 60_000)).toBe("20 min");
    expect(formatLiquiditySpan(89 * 60_000)).toBe("89 min");
    expect(formatLiquiditySpan(150 * 60_000)).toBe("2.5 h");
  });
});

describe("formatLiquiditySize", () => {
  it("keeps the ladder short", () => {
    expect(formatLiquiditySize(0)).toBe("");
    expect(formatLiquiditySize(0.4237)).toBe("0.42");
    expect(formatLiquiditySize(3.46)).toBe("3.46");
    expect(formatLiquiditySize(12.34)).toBe("12.3");
    expect(formatLiquiditySize(128.7)).toBe("129");
    expect(formatLiquiditySize(1234)).toBe("1.2k");
  });
});

describe("formatWholeSize", () => {
  it("counts contracts and shares in whole numbers, thousands and millions past that", () => {
    expect(formatWholeSize(0)).toBe("");
    expect(formatWholeSize(-3)).toBe("");
    expect(formatWholeSize(Number.NaN)).toBe("");
    expect(formatWholeSize(0.4)).toBe("1");
    expect(formatWholeSize(7.4)).toBe("7");
    expect(formatWholeSize(96)).toBe("96");
    expect(formatWholeSize(9_999)).toBe("9999");
    expect(formatWholeSize(12_500)).toBe("12.5k");
    expect(formatWholeSize(2_400_000)).toBe("2.4M");
  });
});

import { MAX_LEVEL_WIDTH, nearestStop, quietZoneMaxFor, sensitivitySizes, sensitivityStops, sliderAnchorFor, sliderSizes } from "../liquiditySettings";

describe("the dialog's sliders", () => {
  it("are built around the market's own minimum level, else the book's typical row, else a usual level for its kind of book", () => {
    expect(sliderAnchorFor({ minBandSize: 20 }, 480, "contracts")).toBe(20);
    expect(sliderAnchorFor({ minBandSize: 0 }, 2_132, "shares")).toBe(2_000);
    expect(sliderAnchorFor({ minBandSize: 0 }, 0, "shares")).toBe(1_000);
    expect(sliderAnchorFor({ minBandSize: 0 }, 0, "contracts")).toBe(10);
  });

  it("step through round sizes from a quarter of the anchor to fifty times it, the anchor among them", () => {
    const sizes = sliderSizes(20, "crypto");
    expect(sizes[0]).toBe(5);
    expect(sizes[sizes.length - 1]).toBe(1_000);
    expect(sizes.slice(0, 8)).toEqual([5, 6, 7, 8, 9, 10, 12, 15]);
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    for (const size of sizes) expect(Number(size.toPrecision(2))).toBe(size);
    expect(sizes).toContain(20);
    expect(sizes).toContain(30);
  });

  it("keep to whole contracts and shares on an index, and widen to take in the sizes asked for", () => {
    expect(sliderSizes(50, "index").every((size) => Number.isInteger(size))).toBe(true);
    expect(sliderSizes(50, "index")[0]).toBe(15);
    expect(sliderSizes(8, "crypto")).toContain(2.5);
    expect(sliderSizes(8, "index")).not.toContain(2.5);
    expect(sliderSizes(8, "index").slice(0, 3)).toEqual([2, 3, 4]);
    expect(sliderSizes(8, "crypto")[0]).toBe(2);
    expect(sliderSizes(1_000, "index", [10])[0]).toBe(10);
  });

  it("give an index's sensitivity every whole size of two significant digits, one contract at a time from 10 to 99; crypto keeps the round sizes", () => {
    const sizes = sensitivitySizes(20, "index");
    expect(sizes.slice(0, 7)).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(sizes[sizes.length - 1]).toBe(1_000);
    expect(sizes).toHaveLength(5 + 90 + 90 + 1);
    for (let size = 10; size <= 99; size += 1) expect(sizes).toContain(size);
    expect(sizes.filter((size) => size >= 100 && size < 1_000)).toEqual(Array.from({ length: 90 }, (_, i) => 100 + 10 * i));
    for (const size of sizes) {
      expect(Number.isInteger(size)).toBe(true);
      expect(Number(size.toPrecision(2))).toBe(size);
    }
    // A quarter of the anchor off the grid starts at the next whole size; the anchor itself is always there.
    expect(sensitivitySizes(50, "index")[0]).toBe(13);
    expect(sensitivitySizes(125, "index")[0]).toBe(32);
    expect(sensitivitySizes(125, "index")).toContain(125);
    expect(sensitivitySizes(800, "index").slice(0, 3)).toEqual([200, 210, 220]);
    expect(sensitivitySizes(800, "index")).toContain(1_100);
    expect(sensitivitySizes(20, "crypto")).toEqual(sliderSizes(20, "crypto"));
  });

  it("run sensitivity from the largest size down to 0, no minimum", () => {
    expect(sensitivityStops([1, 2, 5])).toEqual([5, 2, 1, 0]);
  });

  it("find the stop nearest a size on a log scale, and 0 only for 0", () => {
    const stops = [400, 100, 10, 1, 0];
    expect(nearestStop(stops, 30)).toBe(2);
    expect(nearestStop(stops, 40)).toBe(1);
    expect(nearestStop(stops, 5_000)).toBe(0);
    expect(nearestStop(stops, 0.01)).toBe(3);
    expect(nearestStop(stops, 0)).toBe(4);
    expect(nearestStop([1, 2], 0)).toBe(0);
  });

  it("let the level width run to 50 and the quiet zone to 100 bands, or twice a market's own", () => {
    expect(MAX_LEVEL_WIDTH).toBe(50);
    expect(quietZoneMaxFor({ quietBands: 16 })).toBe(100);
    expect(quietZoneMaxFor({ quietBands: 100 })).toBe(200);
  });
});

import { MAX_WIDENING_STEP, MIN_WIDENING_STEP, timeframeWideningOf, widenedBandFactorFor, wideningOfStep, wideningStepOf } from "../liquiditySettings";

describe("the higher-timeframe width", () => {
  const M = 60_000;
  const HIGHER = [15, 60, 240, 1_440].map((minutes) => minutes * M);

  it("widens 15m, 1h, 4h and 1D as before at auto, and leaves 1m and 5m alone whatever is set", () => {
    expect(HIGHER.map((intervalMs) => widenedBandFactorFor({ timeframeWidening: 1 }, intervalMs))).toEqual([3, 8, 30, 80]);
    expect(HIGHER.map((intervalMs) => widenedBandFactorFor({}, intervalMs))).toEqual([3, 8, 30, 80]);
    expect([1, 5].map((minutes) => widenedBandFactorFor({ timeframeWidening: 4 }, minutes * M))).toEqual([1, 1]);
  });

  it("halves the widening per step left and doubles it per step right, never finer than the 1m width", () => {
    expect(HIGHER.map((intervalMs) => widenedBandFactorFor({ timeframeWidening: 0.5 }, intervalMs))).toEqual([1.5, 4, 15, 40]);
    expect(HIGHER.map((intervalMs) => widenedBandFactorFor({ timeframeWidening: 2 }, intervalMs))).toEqual([6, 16, 60, 160]);
    expect(HIGHER.map((intervalMs) => widenedBandFactorFor({ timeframeWidening: wideningOfStep(MIN_WIDENING_STEP) }, intervalMs))).toEqual([1, 1, 1, 1]);
    expect(clusterRowsFor({ clusterRows: 12, timeframeWidening: 0.25 }, 60 * M)).toBe(24);
    expect(clusterRowsFor({ clusterRows: 12 }, 60 * M)).toBe(96);
  });

  it("scales the crypto minimum level with the widened bands, and leaves an index's alone", () => {
    expect(minBandSizeFor({ minBandSize: 100, timeframeWidening: 0.5 }, "crypto", 60 * M)).toBe(400);
    expect(minBandSizeFor({ minBandSize: 100, timeframeWidening: 0.5 }, "index", 60 * M)).toBe(100);
  });

  it("steps through powers of two from -7 to +3, and reads a saved width it cannot use as auto", () => {
    expect([MIN_WIDENING_STEP, MAX_WIDENING_STEP]).toEqual([-7, 3]);
    expect(wideningOfStep(-2)).toBe(0.25);
    expect(wideningOfStep(0)).toBe(1);
    expect(wideningStepOf(0.25)).toBe(-2);
    expect(wideningStepOf(0.3)).toBe(-2);
    expect(timeframeWideningOf({ timeframeWidening: Number.NaN })).toBe(1);
    expect(timeframeWideningOf({ timeframeWidening: 0 })).toBe(1);
    expect(timeframeWideningOf({ timeframeWidening: 1_000 })).toBe(8);
    expect(timeframeWideningOf({ timeframeWidening: 0.001 })).toBe(1 / 128);
  });
});
