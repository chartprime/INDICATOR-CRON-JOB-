import { describe, expect, it } from "vitest";
import { appendedBarIsContiguous, barCloseMs, candleBars, computeOutlierThreshold, enclosingBarTimeSec, mergeChartBar, toCandlestickSeries, toColoredLineData, toHistogramData } from "../chartData";
import type { BarFrame } from "../../../types/frames";

describe("toColoredLineData", () => {
  function bar(ts_open: number, overrides: Partial<BarFrame> = {}): BarFrame {
    return {
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open,
      open: 1, high: 2, low: 1, close: 1.5, volume: 1, trade_count: 1, closed: true,
      ...overrides,
    } as BarFrame;
  }

  it("attaches the per-bar color to each real point", () => {
    const bars = [bar(0), bar(60_000)];
    const points = toColoredLineData(bars, [1, 2], ["red", "blue"]);
    expect(points).toEqual([
      { time: 0, value: 1, color: "red" },
      { time: 60, value: 2, color: "blue" },
    ]);
  });

  it("a null value renders as whitespace regardless of what its color slot holds", () => {
    const bars = [bar(0), bar(60_000)];
    const points = toColoredLineData(bars, [null, 2], ["red", "blue"]);
    expect(points).toEqual([{ time: 0 }, { time: 60, value: 2, color: "blue" }]);
  });

  it("a real missing interval still renders one bounded whitespace sentinel, matching toLineData/toCandlestickSeries", () => {
    const points = toColoredLineData([bar(0), bar(240_000)], [1, 2], ["red", "blue"]);
    expect(points).toEqual([
      { time: 0, value: 1, color: "red" },
      { time: 60 },
      { time: 240, value: 2, color: "blue" },
    ]);
  });

  it("throws when the colors array length doesn't match the bars", () => {
    expect(() => toColoredLineData([bar(0)], [1], [])).toThrow();
  });
});

describe("enclosingBarTimeSec", () => {
  it("snaps a raw trade tick down to its enclosing bar's ts_open, in seconds", () => {
    expect(enclosingBarTimeSec(90_000, 60_000)).toBe(60); // falls in the [60_000, 120_000) minute bar -> 60s
  });

  it("a tick exactly on a bar boundary stays on that boundary", () => {
    expect(enclosingBarTimeSec(120_000, 60_000)).toBe(120);
  });
});

describe("computeOutlierThreshold", () => {
  it("computes the standard modified-Z-score threshold (median + 3.5 * 1.4826 * MAD) once there are enough samples", () => {
    const magnitudes = [...Array(10).fill(10), ...Array(10).fill(20)].sort((a, b) => a - b);
    // median = (10+20)/2 = 15; every deviation from 15 is exactly 5 either way -> MAD = 5.
    const threshold = computeOutlierThreshold(magnitudes);
    expect(threshold).toBe(15 + 3.5 * 1.4826 * 5);
  });

  it("falls back to 4x the median when MAD is zero -- a robust threshold can't be computed from zero spread", () => {
    const magnitudes = [5, ...Array(15).fill(10), 15, 20, 25, 30].sort((a, b) => a - b);
    // 15 of 20 values are exactly 10, so both the median and the median deviation collapse to it/0.
    expect(computeOutlierThreshold(magnitudes)).toBe(10 * 4);
  });

  it("falls back to 4x the median below the minimum sample size, even when there is real spread to measure", () => {
    const magnitudes = [5, 8, 12, 15, 20, 25, 30, 35, 40, 50]; // 10 samples, well under the MAD minimum
    // median of 10 sorted values = average of the 5th and 6th = (20+25)/2 = 22.5
    expect(computeOutlierThreshold(magnitudes)).toBe(22.5 * 4);
  });

  it("the same magnitude, at the same ratio to the same median, is judged differently depending on real dispersion -- the actual point of a robust threshold over a fixed multiplier", () => {
    const lowDispersion = [...Array(10).fill(19), ...Array(10).fill(21)].sort((a, b) => a - b);
    const highDispersion = [...Array(10).fill(10), ...Array(10).fill(30)].sort((a, b) => a - b);
    // Both datasets share the same median (20); only their spread around it differs.
    const lowThreshold = computeOutlierThreshold(lowDispersion);
    const highThreshold = computeOutlierThreshold(highDispersion);
    expect(lowThreshold).toBeLessThan(highThreshold);

    const testMagnitude = 50; // 2.5x the shared median in both datasets
    expect(testMagnitude).toBeGreaterThan(lowThreshold);
    expect(testMagnitude).toBeLessThan(highThreshold);
  });

  it("an empty series has no threshold to compute", () => {
    expect(computeOutlierThreshold([])).toBe(Infinity);
  });
});

describe("toHistogramData", () => {
  function bar(ts_open: number): BarFrame {
    return {
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open,
      open: 1, high: 1, low: 1, close: 1, volume: 1, trade_count: 1, closed: true,
    };
  }

  function valuesOf(points: ReturnType<typeof toHistogramData>): (number | null)[] {
    return points.map((point) => ("value" in point ? point.value : null));
  }

  it("colors a non-negative value up and a negative value down", () => {
    const bars = [bar(0), bar(60_000)];
    const points = toHistogramData(bars, [5, -3], "#0f0", "#f00");
    expect(points).toEqual([
      { time: 0, value: 5, color: "#0f0" },
      { time: 60, value: -3, color: "#f00" },
    ]);
  });

  it("colors an exact zero as up, not down -- zero is not a sell signal", () => {
    const points = toHistogramData([bar(0)], [0], "#0f0", "#f00");
    expect("color" in points[0] ? points[0].color : null).toBe("#0f0");
  });

  it("compresses a single outlier bar beyond the median-based threshold instead of flattening it", () => {
    const bars = [bar(0), bar(60_000), bar(120_000), bar(180_000), bar(240_000)];
    const values = [10, -12, 11, -9, 2000]; // median of |values| (10,12,11,9,2000) is 11 -> threshold 44
    const points = toHistogramData(bars, values, "#0f0", "#f00");
    expect(valuesOf(points)).toEqual([10, -12, 11, -9, 44 + Math.sqrt(2000 - 44)]);
  });

  it("two different outlier magnitudes still produce different, ordered heights -- the point of compressing instead of clipping", () => {
    const bars = [bar(0), bar(60_000), bar(120_000), bar(180_000), bar(240_000)];
    // The outlier itself is still part of the median calc, but sorting always puts it last regardless of
    // how large it is, so it never shifts the middle position: |values| sorted is (9,10,11,12,outlier) either
    // way, median stays 11 -> threshold 44 in both cases below, isolating the comparison to compression alone.
    const modest = toHistogramData(bars, [10, -12, 11, -9, 440], "#0f0", "#f00"); // 10x threshold
    const extreme = toHistogramData(bars, [10, -12, 11, -9, 4400], "#0f0", "#f00"); // 100x threshold
    const modestHeight = "value" in modest[4] ? modest[4].value : null;
    const extremeHeight = "value" in extreme[4] ? extreme[4].value : null;
    expect(modestHeight).not.toBe(extremeHeight);
    expect(extremeHeight!).toBeGreaterThan(modestHeight!);
  });

  it("compression always keeps the outlier's original sign -- it never flips it to the opposite color", () => {
    const bars = [bar(0), bar(60_000)];
    const values = [5, -2000];
    const points = toHistogramData(bars, values, "#0f0", "#f00");
    expect("value" in points[1] ? points[1].value : null).toBeLessThan(0);
    expect("color" in points[1] ? points[1].color : null).toBe("#f00");
  });

  it("normal-sized bars pass through completely uncompressed when nothing is a real outlier", () => {
    const bars = [bar(0), bar(60_000), bar(120_000)];
    const values = [10, -8, 9];
    const points = toHistogramData(bars, values, "#0f0", "#f00");
    expect(valuesOf(points)).toEqual(values);
  });

  it("an all-zero series doesn't divide by zero or produce NaN/Infinity", () => {
    const bars = [bar(0), bar(60_000)];
    const points = toHistogramData(bars, [0, 0], "#0f0", "#f00");
    expect(valuesOf(points)).toEqual([0, 0]);
  });

  it("renders missing flow as whitespace rather than a neutral green zero bar", () => {
    expect(toHistogramData([bar(0), bar(60_000)], [null, 1], "#0f0", "#f00")).toEqual([
      { time: 0 },
      { time: 60, value: 1, color: "#0f0" },
    ]);
  });

  it("rejects a length mismatch instead of producing an undefined/NaN histogram value", () => {
    expect(() => toHistogramData([bar(0)], [], "#0f0", "#f00")).toThrow(/equal length/);
  });
});

describe("toCandlestickSeries", () => {
  function bar(ts_open: number, overrides: Partial<BarFrame> = {}): BarFrame {
    return {
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open,
      open: 1, high: 2, low: 1, close: 1.5, volume: 1, trade_count: 1, closed: true,
      ...overrides,
    } as BarFrame;
  }

  function isWhitespace(point: ReturnType<typeof toCandlestickSeries>[number]): boolean {
    return !("open" in point);
  }

  it("an empty array produces an empty series without crashing", () => {
    expect(toCandlestickSeries([])).toEqual([]);
  });

  it("a fully contiguous, fully closed run of bars renders every point as a real candle, no whitespace", () => {
    const bars = [bar(0), bar(60_000), bar(120_000)];
    const points = toCandlestickSeries(bars);
    expect(points).toHaveLength(3);
    expect(points.every((point) => !isWhitespace(point))).toBe(true);
  });

  it("a real missing interval becomes one bounded whitespace sentinel, not a silent join or per-minute allocation", () => {
    // bar(0) and bar(240_000) are both real and closed, but three whole
    // minutes (60_000, 120_000, 180_000) never arrived -- a genuine gap,
    // not a quiet-but-present bar.
    const points = toCandlestickSeries([bar(0), bar(240_000)]);
    expect(points).toEqual([
      { time: 0, open: 1, high: 2, low: 1, close: 1.5 },
      { time: 60 },
      { time: 240, open: 1, high: 2, low: 1, close: 1.5 },
    ]);
  });

  it("a mid-history bar marked closed:false renders as whitespace -- an incomplete bucket is not a trustworthy candle", () => {
    const bars = [bar(0), bar(60_000, { closed: false }), bar(120_000)];
    const points = toCandlestickSeries(bars);
    expect(isWhitespace(points[0])).toBe(false);
    expect(points[1]).toEqual({ time: 60 });
    expect(isWhitespace(points[2])).toBe(false);
  });

  it("the LAST bar being closed:false is the normal live/still-forming edge, not a gap -- it still renders as a real candle", () => {
    const bars = [bar(0), bar(60_000, { closed: false })];
    const points = toCandlestickSeries(bars);
    expect(points[0]).toEqual({ time: 0, open: 1, high: 2, low: 1, close: 1.5 });
    expect(points[1]).toEqual({ time: 60, open: 1, high: 2, low: 1, close: 1.5 });
  });

  it("a single live-forming bar (array of length 1, closed:false) still renders as a real candle, not whitespace", () => {
    const points = toCandlestickSeries([bar(0, { closed: false })]);
    expect(points).toEqual([{ time: 0, open: 1, high: 2, low: 1, close: 1.5 }]);
  });

  it("a gap immediately followed by the live edge still exempts only the last bar, not the gap itself", () => {
    const points = toCandlestickSeries([bar(0), bar(120_000, { closed: false })]);
    expect(points).toEqual([
      { time: 0, open: 1, high: 2, low: 1, close: 1.5 },
      { time: 60 },
      { time: 120, open: 1, high: 2, low: 1, close: 1.5 },
    ]);
  });

  it("represents even a multi-year outage with one bounded sentinel", () => {
    const remote = 10 * 365 * 24 * 60 * 60_000;
    expect(toCandlestickSeries([bar(0), bar(remote)])).toHaveLength(3);
  });

  it("keeps adjacent calendar months contiguous even when their physical length changes", () => {
    const january = bar(Date.UTC(2026, 0, 1), { interval_ms: 30 * 24 * 60 * 60_000, calendar_interval: "month" });
    const february = bar(Date.UTC(2026, 1, 1), { interval_ms: 30 * 24 * 60 * 60_000, calendar_interval: "month" });
    expect(barCloseMs(january)).toBe(Date.UTC(2026, 1, 1));
    expect(toCandlestickSeries([january, february])).toHaveLength(2);
    expect(appendedBarIsContiguous(january, february)).toBe(true);
  });
});

describe("appendedBarIsContiguous", () => {
  function bar(ts_open: number, overrides: Partial<BarFrame> = {}): BarFrame {
    return {
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open,
      open: 1, high: 2, low: 1, close: 1.5, volume: 1, trade_count: 1, closed: true,
      ...overrides,
    } as BarFrame;
  }

  // This backs ChartPanel.applyBar's fast-path decision: a contiguous
  // append is safe for a single-point series.update() (matches the
  // existing candle at that position exactly); anything else needs a
  // full series.setData(toCandlestickSeries(bars)) recompute so a gap
  // or a superseded incomplete bar gets represented correctly.
  it("no prior bar at all is always contiguous -- nothing to gap against yet", () => {
    expect(appendedBarIsContiguous(undefined, bar(0))).toBe(true);
  });

  it("the very next interval after a properly closed prior bar is contiguous", () => {
    expect(appendedBarIsContiguous(bar(0), bar(60_000))).toBe(true);
  });

  it("a ts_open jump past the next interval is not contiguous -- a real gap needs representing", () => {
    expect(appendedBarIsContiguous(bar(0), bar(180_000))).toBe(false);
  });

  it("the next interval is not contiguous if the prior bar was never actually closed -- it needs re-evaluating now that it's no longer the live edge", () => {
    expect(appendedBarIsContiguous(bar(0, { closed: false }), bar(60_000))).toBe(false);
  });
});

describe("mergeChartBar", () => {
  function bar(ts_open: number, overrides: Partial<BarFrame> = {}): BarFrame {
    return {
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open,
      open: 1, high: 2, low: 1, close: 1.5, volume: 1, trade_count: 1, closed: true,
      ...overrides,
    } as BarFrame;
  }

  it("appends and replaces the developing edge incrementally", () => {
    const bars = [bar(0)];
    expect(mergeChartBar(bars, bar(60_000, { closed: false }))).toBe("APPENDED");
    expect(mergeChartBar(bars, bar(60_000, { closed: false, close: 1.7 }))).toBe("REPLACED_EDGE");
    expect(bars.at(-1)?.close).toBe(1.7);
  });

  it("accepts a closed historical correction and requests a full rebuild", () => {
    const bars = [bar(0), bar(60_000), bar(120_000)];
    expect(mergeChartBar(bars, bar(60_000, { close: 1.9 }))).toBe("REBUILT");
    expect(bars[1].close).toBe(1.9);
  });

  it("rejects closed-to-developing regression at both the edge and in history", () => {
    const bars = [bar(0), bar(60_000)];
    expect(mergeChartBar(bars, bar(60_000, { closed: false }))).toBe("REJECTED_REOPEN");
    expect(mergeChartBar(bars, bar(0, { closed: false }))).toBe("REJECTED_REOPEN");
    expect(bars.every((candidate) => candidate.closed)).toBe(true);
  });
});

describe("histogram threshold: typed-array pipeline is output-identical to the original comparator-sort algorithm", () => {
  function referenceMedian(sorted: readonly number[]): number {
    const n = sorted.length;
    if (n === 0) return 0;
    const mid = Math.floor(n / 2);
    return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  function referenceThreshold(magnitudes: readonly number[]): number {
    if (magnitudes.length === 0) return Infinity;
    const magMedian = referenceMedian(magnitudes);
    if (magnitudes.length < 20) return magMedian * 4;
    const deviations = magnitudes.map((value) => Math.abs(value - magMedian)).sort((a, b) => a - b);
    const mad = referenceMedian(deviations);
    if (mad === 0) return magMedian * 4;
    return magMedian + 3.5 * 1.4826 * mad;
  }

  function referenceCompress(raw: number, threshold: number): number {
    const magnitude = Math.abs(raw);
    if (!Number.isFinite(threshold) || magnitude <= threshold) return raw;
    return Math.sign(raw) * (threshold + Math.sqrt(magnitude - threshold));
  }

  function randomValues(count: number, seed: number): (number | null)[] {
    let state = seed;
    const next = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const values: (number | null)[] = [];
    for (let index = 0; index < count; index += 1) {
      const roll = next();
      if (roll < 0.04) values.push(null);
      else if (roll < 0.08) values.push(0);
      else values.push((next() - 0.5) * 200 + (next() < 0.03 ? (next() - 0.5) * 8000 : 0));
    }
    return values;
  }

  function barAt(index: number): BarFrame {
    return {
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open: index * 60_000,
      open: 1, high: 1, low: 1, close: 1, volume: 1, trade_count: 1, closed: true,
    } as BarFrame;
  }

  it("matches the reference threshold and every compressed histogram value across sizes, nulls, zeros and outliers", () => {
    for (const count of [0, 1, 2, 5, 19, 20, 21, 64, 500, 2000]) {
      for (let seed = 1; seed <= 6; seed += 1) {
        const values = randomValues(count, seed * 7919 + count);
        const bars = values.map((_, index) => barAt(index));
        const magnitudes = values
          .filter((value): value is number => value !== null)
          .map((value) => Math.abs(value))
          .filter((value) => value > 0)
          .sort((a, b) => a - b);
        const expectedThreshold = referenceThreshold(magnitudes);
        expect(computeOutlierThreshold(magnitudes)).toBe(expectedThreshold);

        const points = toHistogramData(bars, values, "#0f0", "#f00");
        const actual = points.map((point) => ("value" in point ? point.value : null));
        const expected = values.map((value) => (value === null ? null : referenceCompress(value, expectedThreshold)));
        expect(actual).toEqual(expected);
      }
    }
  });

  it("all-zero and all-null inputs yield no threshold and leave values untouched, exactly as before", () => {
    const bars = [barAt(0), barAt(1), barAt(2)];
    expect(computeOutlierThreshold(new Float64Array(0))).toBe(Infinity);
    expect(toHistogramData(bars, [0, 0, 0], "#0f0", "#f00").map((point) => ("value" in point ? point.value : null))).toEqual([0, 0, 0]);
    expect(toHistogramData(bars, [null, null, null], "#0f0", "#f00").every((point) => !("value" in point))).toBe(true);
  });
});

describe("candleBars (report 57 W4)", () => {
  it("is exactly the bars the candle series draws, across a session gap and an unclosed bar", () => {
    const bar = (ts_open: number, closed: boolean) => ({
      type: "bar", symbol: "ES", provider: "DXFEED", assetClass: "FUTURE", interval_ms: 60_000, ts_open,
      open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, trade_count: 1, closed,
    }) as BarFrame;
    const bars = [bar(0, true), bar(60_000, false), bar(3_600_000, true), bar(3_660_000, true), bar(3_720_000, false)];
    const drawn = toCandlestickSeries(bars).filter((point) => "close" in point).map((point) => Number(point.time) * 1000);
    expect(candleBars(bars).map((entry) => entry.ts_open)).toEqual(drawn);
    expect(drawn).toEqual([0, 3_600_000, 3_660_000, 3_720_000]);
  });
});
