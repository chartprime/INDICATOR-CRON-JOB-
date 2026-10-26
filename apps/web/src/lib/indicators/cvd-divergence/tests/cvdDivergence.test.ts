import { describe, expect, it } from "vitest";
import type { BarFrame, FrameIdentity } from "../../../../types/frames";
import {
  CVD_TONE_COLORS,
  DEFAULT_CVD_MAX_PIVOT_DISTANCE,
  DEFAULT_CVD_MIN_PIVOT_DISTANCE,
  DEFAULT_CVD_PERIOD,
  DEFAULT_CVD_PIVOT_PERIODS,
  cvdToneAt,
  cvdToneColorsFor,
  detectCumulativeCvdDivergences,
  detectCvdDivergences,
  findSeriesPivots,
  isDataHole,
  rollingDeltaSeries,
  smaForSeries,
  trendAdmits,
} from "../cvdDivergence";

const ONE_MINUTE = 60_000;

type BarSpec = Readonly<{
  /** Total volume. */
  volume?: number;
  /**
   * Taker buy volume. Omit entirely for a bar with no side split at all --
   * barDelta() reports those as unknown, which is what the null paths test.
   */
  buy?: number;
  /** Explicit taker sell volume; omit to exercise barSides' volume-buy fallback. */
  sell?: number;
  close?: number;
  /** Overrides the implicit `previous ts_open + interval_ms`. */
  tsOpen?: number;
  closed?: boolean;
}>;

function makeBars(specs: readonly BarSpec[]): BarFrame[] {
  let nextTs = 0;
  return specs.map((spec) => {
    const tsOpen = spec.tsOpen ?? nextTs;
    nextTs = tsOpen + ONE_MINUTE;
    const volume = spec.volume ?? 100;
    const buy = spec.buy;
    return {
      type: "bar",
      symbol: "BTC-USDT",
      provider: "BINANCE",
      marketKind: "SPOT",
      interval_ms: ONE_MINUTE,
      ts_open: tsOpen,
      open: 100,
      high: 101,
      low: 99,
      close: spec.close ?? 100,
      volume,
      trade_count: 10,
      closed: spec.closed ?? true,
      ...(buy === undefined ? {} : { buy_volume: buy }),
      ...(spec.sell === undefined ? {} : { sell_volume: spec.sell }),
    } as BarFrame;
  });
}

/**
 * A bar whose side split yields exactly `delta`, at a chosen close.
 *
 * makeBars fixes high 101 / low 99, so this fixture drives the ROLLING SUM
 * through taker volume while still letting a test place the bar's close
 * wherever it needs it for the price side of a divergence.
 */
function deltaBar(delta: number, close = 100, tsOpen?: number): BarSpec {
  // volume 100, buy = 50 + delta/2 -> barDelta = buy - sell = delta.
  return {
    buy: 50 + delta / 2,
    volume: 100,
    close,
    ...(tsOpen === undefined ? {} : { tsOpen }),
  };
}

describe("rollingDeltaSeries", () => {
  it("is the rolling window sum of per-bar delta, not a cumulative total", () => {
    const bars = makeBars([
      deltaBar(10),
      deltaBar(-30),
      deltaBar(40),
      deltaBar(5),
    ]);
    expect(rollingDeltaSeries(bars, 2)).toEqual([null, -20, 10, 45]);
    expect(rollingDeltaSeries(bars, 1)).toEqual([10, -30, 40, 5]);
  });

  it("keeps the whole window as a sliding sum -- each value is exactly the sum of its own trailing `period` deltas", () => {
    // Deliberately non-monotonic so a cumulative running total could not
    // coincidentally match the expected values.
    const deltas = [3, -8, 5, 12, -2, -7, 4, 9, -1, 6];
    const bars = makeBars(deltas.map((delta) => deltaBar(delta)));
    const period = 4;
    const series = rollingDeltaSeries(bars, period);
    for (let index = 0; index < deltas.length; index += 1) {
      if (index < period - 1) {
        expect(series[index]).toBeNull();
        continue;
      }
      const expected = deltas
        .slice(index - period + 1, index + 1)
        .reduce((total, value) => total + value, 0);
      expect(series[index]).toBeCloseTo(expected, 6);
    }
  });

  it("has no value until the window is genuinely full, then reports the true running sum", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(2),
      deltaBar(3),
      deltaBar(4),
      deltaBar(5),
    ]);
    expect(rollingDeltaSeries(bars, 3)).toEqual([null, null, 6, 9, 12]);
  });

  it("empties the window on a bar with no side split and stays empty until it refills", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(2),
      { volume: 100 },
      deltaBar(3),
      deltaBar(4),
      deltaBar(5),
    ]);
    // The unknown bar cannot contribute, so the windows containing it are null
    // and the window restarts -- no partial sum is reported.
    expect(rollingDeltaSeries(bars, 2)).toEqual([null, 3, null, null, 7, 9]);
  });

  it("restarts the window across a ts_open discontinuity rather than summing across the gap", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(2),
      deltaBar(3),
      deltaBar(4),
      deltaBar(5, 100, 10 * ONE_MINUTE),
      deltaBar(6, 100, 11 * ONE_MINUTE),
      deltaBar(7, 100, 12 * ONE_MINUTE),
    ]);
    // The first four bars roll normally (1+2+3=6, then 2+3+4=9). The gap then
    // restarts the window, so the last three bars build 5+6+7=18 afresh
    // instead of dragging the pre-gap deltas into the sum.
    expect(rollingDeltaSeries(bars, 3)).toEqual([
      null,
      null,
      6,
      9,
      null,
      null,
      18,
    ]);
  });

  it("rejects a non-positive or non-integer period", () => {
    const bars = makeBars([deltaBar(1)]);
    expect(() => rollingDeltaSeries(bars, 0)).toThrow(/positive safe integer/);
    expect(() => rollingDeltaSeries(bars, 2.5)).toThrow(
      /positive safe integer/,
    );
    expect(() => rollingDeltaSeries(bars, -1)).toThrow(/positive safe integer/);
  });

  it("uses barSides' volume-minus-buy fallback when a bar carries no explicit sell volume", () => {
    // No sell_volume on either bar, so barSides derives it: 30 then 80.
    const bars = makeBars([
      { buy: 70, volume: 100 },
      { buy: 20, volume: 100 },
    ]);
    expect(rollingDeltaSeries(bars, 2)).toEqual([null, -20]);
  });
});

const HOUR_MS = 60 * ONE_MINUTE;
const DAY_MS = 24 * HOUR_MS;

/** Databento stock: a session-scoped instrument the market calendar models. */
const STOCK: FrameIdentity = { provider: "DATABENTO", assetClass: "EQUITY" };
/** Databento future: session-scoped, but the calendar does not describe it. */
const FUTURES: FrameIdentity = { provider: "DATABENTO", assetClass: "FUTURE" };
/** Binance spot: a 24/7 venue, so it has no scheduled closure at all. */
const CRYPTO: FrameIdentity = { provider: "BINANCE", marketKind: "SPOT" };

/**
 * Midnight UTC on the `index`-th weekday (Mon..Fri) counted from Monday
 * 2026-01-05. Weekends are skipped, which is exactly the gap a daily
 * equities/futures chart leaves.
 */
function weekdayMidnightMs(index: number): number {
  const anchor = Date.UTC(2026, 0, 5);
  return anchor + (Math.floor(index / 5) * 7 + (index % 5)) * DAY_MS;
}

/**
 * 09:30 New York on the `index`-th weekday. January 2026 is EST (UTC-5), so
 * 09:30 ET is 14:30 UTC and every fixture day below stays inside one DST
 * regime -- which keeps the calendar probe exercising the real session.
 */
function sessionOpenMs(index: number): number {
  return weekdayMidnightMs(index) + 14 * HOUR_MS + 30 * ONE_MINUTE;
}

/** A bar whose side split yields exactly `delta`, at a chosen close. */
function flowBar(
  identity: FrameIdentity,
  intervalMs: number,
  tsOpen: number,
  delta = 1,
  close = 100,
): BarFrame {
  return {
    ...identity,
    type: "bar",
    symbol: "TEST",
    interval_ms: intervalMs,
    ts_open: tsOpen,
    open: 100,
    high: 101,
    low: 99,
    close,
    volume: 100,
    buy_volume: 50 + delta / 2,
    trade_count: 10,
    closed: true,
  } as BarFrame;
}

/** `count` daily bars on consecutive weekdays, i.e. with weekend gaps only. */
function dailyBars(
  identity: FrameIdentity,
  count: number,
  firstWeekday = 0,
): BarFrame[] {
  return Array.from({ length: count }, (_, index) =>
    flowBar(identity, DAY_MS, weekdayMidnightMs(firstWeekday + index)),
  );
}

/** `tradingDays` sessions of seven hourly bars, 09:30 through 15:30 ET. */
function hourlySessionBars(
  identity: FrameIdentity,
  tradingDays: number,
): BarFrame[] {
  return Array.from({ length: tradingDays }, (_, day) =>
    Array.from({ length: 7 }, (_, hour) =>
      flowBar(identity, HOUR_MS, sessionOpenMs(day) + hour * HOUR_MS),
    ),
  ).flat();
}

/** `tradingDays` sessions of 390 one-minute bars, 09:30 through 15:59 ET. */
function minuteSessionBars(
  identity: FrameIdentity,
  tradingDays: number,
): BarFrame[] {
  return Array.from({ length: tradingDays }, (_, day) =>
    Array.from({ length: 390 }, (_, minute) =>
      flowBar(identity, ONE_MINUTE, sessionOpenMs(day) + minute * ONE_MINUTE),
    ),
  ).flat();
}

function nonNullCount(series: readonly (number | null)[]): number {
  return series.filter((value) => value !== null).length;
}

/**
 * The reviewer's table. `rollingDeltaSeries(bars, 21)` on synthetic bars that
 * ALL carry a known buy/sell split. Before the closure rule the 1D and 1H
 * rows produced ZERO values: a weekend (1D) or an overnight break (1H)
 * restarted the window, and a chart that only ever had five or seven
 * contiguous bars per session never refilled it. The pane was empty in
 * historical mode for exactly the archives `CANDLE_FLOW_POLICY` offers it for
 * -- Databento stocks and futures.
 */
describe("rollingDeltaSeries across scheduled market closes", () => {
  const PERIOD = DEFAULT_CVD_PERIOD; // 21

  it("fills on a 1D 24/7 chart, which has no scheduled closes at all", () => {
    const bars = Array.from({ length: 300 }, (_, index) =>
      flowBar(CRYPTO, DAY_MS, index * DAY_MS),
    );
    expect(nonNullCount(rollingDeltaSeries(bars, PERIOD))).toBe(
      300 - PERIOD + 1,
    );
  });

  it("now fills on a 1D stock chart that skips weekends", () => {
    const series = rollingDeltaSeries(dailyBars(STOCK, 300), PERIOD);
    // The weekend (48h of uncovered time) is a scheduled close, so the whole
    // weekday run is one window: 300 bars => 280 values, first at the 21st bar.
    expect(series.slice(0, PERIOD - 1).every((value) => value === null)).toBe(
      true,
    );
    expect(nonNullCount(series)).toBe(300 - PERIOD + 1);
  });

  it("now fills on a 1D futures chart that skips weekends", () => {
    expect(
      nonNullCount(rollingDeltaSeries(dailyBars(FUTURES, 300), PERIOD)),
    ).toBe(300 - PERIOD + 1);
  });

  it("now fills on a 1H regular-session stock chart, breaking only at the weekly close", () => {
    // Two whole weeks (10 trading days, 5 sessions each of 7 hourly bars). The
    // overnight break is scheduled, so each week is one contiguous run of 35
    // bars contributing 35 - 21 + 1 = 15 values; the weekend still breaks.
    const series = rollingDeltaSeries(hourlySessionBars(STOCK, 10), PERIOD);
    expect(nonNullCount(series)).toBe(2 * (35 - PERIOD + 1));
    expect(series.findIndex((value) => value !== null)).toBe(PERIOD - 1);
  });

  it("now fills across the overnight break on a 1m regular-session stock chart", () => {
    // Three sessions of 390 one-minute bars, contiguous through the two
    // scheduled overnight breaks (17.5h each, inside the intraday tolerance).
    expect(
      nonNullCount(rollingDeltaSeries(minuteSessionBars(STOCK, 3), PERIOD)),
    ).toBe(3 * 390 - PERIOD + 1);
  });

  it("still restarts at a real hole longer than the venue's ordinary close", () => {
    // Thirty weekdays, a fortnight's outage, then thirty more. The gap is far
    // longer than the three-day daily tolerance, so it IS a hole.
    const bars = [...dailyBars(STOCK, 30), ...dailyBars(STOCK, 30, 40)];
    const series = rollingDeltaSeries(bars, 3);
    expect(series[30]).toBeNull();
    expect(series[31]).toBeNull();
    expect(series[32]).not.toBeNull();
  });

  it("restarts at an intraday hole covering open regular-session time", () => {
    // A 1H stock session missing its 12:30 bar: only an hour of uncovered
    // time, well inside the 20h intraday tolerance, but the session calendar
    // says the market was open, so bars that should exist do not.
    const open = sessionOpenMs(0);
    const hours = [0, 1, 2, 4, 5, 6];
    expect(
      rollingDeltaSeries(
        hours.map((hour) => flowBar(STOCK, HOUR_MS, open + hour * HOUR_MS)),
        3,
      ),
    ).toEqual([null, null, 3, null, null, 3]);
    // An active futures session also cannot silently bridge a missing hour.
    expect(
      rollingDeltaSeries(
        hours.map((hour) => flowBar(FUTURES, HOUR_MS, open + hour * HOUR_MS)),
        3,
      ),
    ).toEqual([null, null, 3, null, null, 3]);
  });

  it("detects a short equity hole that crosses the half-hour market open", () => {
    const open = sessionOpenMs(0);
    expect(isDataHole([
      flowBar(STOCK, 5 * ONE_MINUTE, open - 10 * ONE_MINUTE),
      flowBar(STOCK, 5 * ONE_MINUTE, open + 5 * ONE_MINUTE),
    ], 1)).toBe(true);
  });

  it("preserves the existing weekly reset across a fully closed future weekend", () => {
    expect(isDataHole([
      flowBar(FUTURES, HOUR_MS, Date.parse("2026-09-18T20:00:00Z")),
      flowBar(FUTURES, HOUR_MS, Date.parse("2026-09-20T22:00:00Z")),
    ], 1)).toBe(true);
  });

  it("still restarts on a 24/7 chart's smallest gap", () => {
    // A venue with no scheduled closure has no scheduled gap: any uncovered
    // time is data that should be there and is not.
    const bars = [0, 1, 2, 3, 6, 7, 8].map((minute) =>
      flowBar(CRYPTO, ONE_MINUTE, minute * ONE_MINUTE),
    );
    expect(rollingDeltaSeries(bars, 3)).toEqual([
      null,
      null,
      3,
      3,
      null,
      null,
      3,
    ]);
  });

  it("pairs oscillator pivots that straddle a weekend on a stock chart, but not on a 24/7 one", () => {
    // The canonical bullish fixture: oscillator lows at index 2 (-8) and
    // index 8 (-4) against price closes 100 -> 90. Laid over two trading weeks
    // so a weekend falls between the pivots. The epoch guard used to reject
    // the pair outright because the weekend read as a discontinuity.
    const series = [-1, -2, -8, -2, -1, -3, -3, -3, -4, -1, -2];
    const closes = [105, 105, 100, 105, 105, 105, 105, 105, 90, 105, 105];
    const bullishFor = (identity: FrameIdentity) =>
      detectCvdDivergences(
        closes.map((close, index) =>
          flowBar(identity, DAY_MS, weekdayMidnightMs(index), 1, close),
        ),
        series,
        2,
        PIVOT_GAP_DISTANCE,
      ).filter((divergence) => divergence.type === "bullish");
    expect(bullishFor(STOCK)).toHaveLength(1);
    // The same weekday-only shape IS a hole on a 24/7 venue, whose gaps are
    // always real, so nothing pairs there.
    expect(bullishFor(CRYPTO)).toEqual([]);
  });

  it("never pairs cumulative pivots across a weekend, where the running total itself restarts at zero", () => {
    const series = [-1, -2, -8, -2, -1, -3, -3, -3, -4, -1, -2];
    const closes = [105, 105, 100, 105, 105, 105, 105, 105, 90, 105, 105];
    const bars = closes.map((close, index) =>
      flowBar(STOCK, DAY_MS, weekdayMidnightMs(index), 1, close),
    );
    expect(
      detectCumulativeCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE),
    ).toEqual([]);
    const contiguous = closes.map((close, index) =>
      flowBar(STOCK, DAY_MS, index * DAY_MS, 1, close),
    );
    expect(
      detectCumulativeCvdDivergences(contiguous, series, 2, PIVOT_GAP_DISTANCE),
    ).toHaveLength(1);
  });
});

describe("findSeriesPivots", () => {
  it("finds a strict high only once pivotPeriods bars on each side have been beaten", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(2),
      deltaBar(9),
      deltaBar(3),
      deltaBar(1),
    ]);
    const series = [1, 2, 9, 3, 1];
    expect(findSeriesPivots(bars, series, 2, "high")).toEqual([
      { index: 2, ts_open: 2 * ONE_MINUTE, value: 9 },
    ]);
  });

  it("does not report a pivot whose window still contains a higher value", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(2),
      deltaBar(5),
      deltaBar(6),
      deltaBar(1),
    ]);
    const series = [1, 2, 5, 6, 1];
    expect(findSeriesPivots(bars, series, 2, "high")).toEqual([]);
  });

  it("treats an equal neighbour as failing the strict test, so plateaus never pivot", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(9),
      deltaBar(9),
      deltaBar(9),
      deltaBar(9),
      deltaBar(1),
    ]);
    const series = [1, 9, 9, 9, 9, 1];
    expect(findSeriesPivots(bars, series, 1, "high")).toEqual([]);
  });

  it("skips pivots on bars that are not closed, so nothing is confirmed early", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(2),
      { ...deltaBar(9), closed: false },
      deltaBar(3),
      deltaBar(1),
    ]);
    const series = [1, 2, 9, 3, 1];
    expect(findSeriesPivots(bars, series, 2, "high")).toEqual([]);
  });

  it("never scans a null series value as an extreme", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(2),
      deltaBar(9),
      deltaBar(3),
      deltaBar(1),
    ]);
    const series = [1, 2, 9, null, 1];
    expect(findSeriesPivots(bars, series, 2, "low")).toEqual([]);
  });

  it("finds lows symmetrically", () => {
    const bars = makeBars([
      deltaBar(1),
      deltaBar(2),
      deltaBar(-9),
      deltaBar(3),
      deltaBar(1),
    ]);
    const series = [1, 2, -9, 3, 1];
    expect(findSeriesPivots(bars, series, 2, "low")).toEqual([
      { index: 2, ts_open: 2 * ONE_MINUTE, value: -9 },
    ]);
  });

  it("rejects mismatched inputs", () => {
    const bars = makeBars([deltaBar(1), deltaBar(2)]);
    expect(() => findSeriesPivots(bars, [1], 1, "high")).toThrow(
      /identical lengths/,
    );
  });
});

describe("cvdToneAt", () => {
  it("gives intense green to a column above zero that beats the average of the previous three", () => {
    // index 3 = 10 vs average(2, 3, 4) = 3 -> stronger -> intense green.
    expect(cvdToneAt([2, 3, 4, 10], 3)).toBe("intenseUp");
  });

  it("gives pale green to a column above zero that is weaker than that average", () => {
    // index 3 = 3.5 vs average(4, 6, 8) = 6 -> weaker -> pale green.
    expect(cvdToneAt([4, 6, 8, 3.5], 3)).toBe("paleUp");
  });

  it("gives intense red to a column below zero that is weaker than that average", () => {
    // index 3 = -12 vs average(-2, -4, -6) = -4 -> weaker (more negative) -> intense red.
    expect(cvdToneAt([-2, -4, -6, -12], 3)).toBe("intenseDown");
  });

  it("gives pale red to a column below zero that is recovering toward zero", () => {
    // index 3 = -1 vs average(-4, -6, -8) = -6 -> stronger, but still below
    // zero, so it is red at lower intensity rather than green.
    expect(cvdToneAt([-4, -6, -8, -1], 3)).toBe("paleDown");
  });

  it("treats an exact tie with the average as not-stronger -- strength is a strict test", () => {
    // Above zero, "not stronger" is the pale tone. Below zero, "not stronger"
    // means not rising, which is the intense red -- so the same tie lands on
    // different shadings on either side of the zero line, by design.
    expect(cvdToneAt([5, 5, 5, 5], 3)).toBe("paleUp");
    expect(cvdToneAt([-5, -5, -5, -5], 3)).toBe("intenseDown");
  });

  it("returns null until three earlier values exist, and for a null value", () => {
    expect(cvdToneAt([1, 2, 3], 2)).toBeNull();
    expect(cvdToneAt([1, 2, 3, null], 3)).toBeNull();
    expect(cvdToneAt([1, 2, null, 9], 3)).toBeNull();
  });

  it("honours an explicit lookback", () => {
    // With lookback 1 the comparison is simply against the previous column.
    expect(cvdToneAt([2, 10], 1, 1)).toBe("intenseUp");
    expect(cvdToneAt([10, 2], 1, 1)).toBe("paleUp");
  });

  it("never leaves a column with a value unshaded through cvdToneColorsFor", () => {
    const values = [5, 6, -3, -9, 2, 7, 1, -1, -20];
    const colors = cvdToneColorsFor(values);
    expect(colors).toHaveLength(values.length);
    const allowed = new Set(Object.values(CVD_TONE_COLORS));
    for (const color of colors) expect(allowed.has(color)).toBe(true);
  });

  it("shades the warm-up columns by sign rather than hiding them", () => {
    const colors = cvdToneColorsFor([4, 4, 4]);
    expect(colors).toEqual([
      CVD_TONE_COLORS.intenseUp,
      CVD_TONE_COLORS.intenseUp,
      CVD_TONE_COLORS.intenseUp,
    ]);
    expect(cvdToneColorsFor([-4])).toEqual([CVD_TONE_COLORS.intenseDown]);
  });

  it("keeps the four tones visually distinct", () => {
    const distinct = new Set(Object.values(CVD_TONE_COLORS));
    expect(distinct.size).toBe(4);
  });
});

describe("smaForSeries", () => {
  it("matches ta.sma's own plain moving average", () => {
    expect(smaForSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("passes a null through as null and restarts the window after it", () => {
    // ta.sma alone would average across the gap (1,2,_,3 -> a value at the
    // third slot spanning bars that are not adjacent). Restarting means the
    // average never spans an epoch break the oscillator itself restarts on.
    expect(smaForSeries([1, 2, null, 3, 4, 5], 2)).toEqual([
      null,
      1.5,
      null,
      null,
      3.5,
      4.5,
    ]);
  });

  it("has no value before the window is full", () => {
    expect(smaForSeries([5, 6, 7], 3)).toEqual([null, null, 6]);
  });

  it("rejects a non-positive or non-integer length", () => {
    expect(() => smaForSeries([1, 2], 0)).toThrow(/positive safe integer/);
    expect(() => smaForSeries([1, 2], 1.5)).toThrow(/positive safe integer/);
  });

  it("returns an empty series for empty input", () => {
    expect(smaForSeries([], 3)).toEqual([]);
  });
});

describe("trendAdmits", () => {
  it("admits a bullish divergence only ABOVE the average", () => {
    expect(trendAdmits(10, 5, "bullish")).toBe(true);
    expect(trendAdmits(3, 5, "bullish")).toBe(false);
  });

  it("admits a bearish divergence only BELOW the average", () => {
    expect(trendAdmits(3, 5, "bearish")).toBe(true);
    expect(trendAdmits(10, 5, "bearish")).toBe(false);
  });

  it("treats an exact tie as not-admitted in either direction", () => {
    // Strict comparison: sitting exactly ON the average is not a trend.
    expect(trendAdmits(5, 5, "bullish")).toBe(false);
    expect(trendAdmits(5, 5, "bearish")).toBe(false);
  });

  it("admits both directions while the average is undefined", () => {
    // Suppressing during warm-up would drop otherwise-valid signals from the
    // start of the chart rather than filtering them by trend.
    expect(trendAdmits(10, null, "bullish")).toBe(true);
    expect(trendAdmits(10, null, "bearish")).toBe(true);
    expect(trendAdmits(null, 5, "bullish")).toBe(true);
  });

  it("admits a bullish divergence only BELOW the average when inverted", () => {
    expect(trendAdmits(3, 5, "bullish", true)).toBe(true);
    expect(trendAdmits(10, 5, "bullish", true)).toBe(false);
  });

  it("admits a bearish divergence only ABOVE the average when inverted", () => {
    expect(trendAdmits(10, 5, "bearish", true)).toBe(true);
    expect(trendAdmits(3, 5, "bearish", true)).toBe(false);
  });

  it("inversion mirrors the default rule exactly, and only that rule", () => {
    // Each direction must be the exact negation of its default, so an inverted
    // filter is never MORE permissive than an upright one anywhere. The tie is
    // excluded here because it is admitted by NEITHER reading, which is what
    // makes it a tie -- see the dedicated test below.
    for (const value of [-3, 0, 10]) {
      for (const type of ["bullish", "bearish"] as const) {
        expect(trendAdmits(value, 5, type, true)).toBe(
          !trendAdmits(value, 5, type),
        );
      }
    }
  });

  it("still rejects an exact tie when inverted", () => {
    // Sitting exactly ON the average is not a trend in either direction, and
    // inverting does not turn that into a signal.
    expect(trendAdmits(5, 5, "bullish", true)).toBe(false);
    expect(trendAdmits(5, 5, "bearish", true)).toBe(false);
  });

  it("still admits both directions during warm-up when inverted", () => {
    // Inverting must not change what the first bars of a chart show.
    expect(trendAdmits(10, null, "bullish", true)).toBe(true);
    expect(trendAdmits(10, null, "bearish", true)).toBe(true);
    expect(trendAdmits(null, 5, "bullish", true)).toBe(true);
    expect(trendAdmits(null, 5, "bearish", true)).toBe(true);
  });
});

describe("detectCvdDivergences trend filter", () => {
  it("drops a bullish divergence when the series sits below its average at the confirming pivot", () => {
    const { series, bars } = higherOscillatorLowFixture();
    // Unfiltered this is a valid bullish divergence.
    const unfiltered = detectCvdDivergences(
      bars,
      series,
      2,
      PIVOT_GAP_DISTANCE,
    );
    expect(unfiltered.filter((d) => d.type === "bullish")).toHaveLength(1);

    // An average sitting ABOVE the value at the confirming pivot (index 8)
    // means "downtrend", which forbids a bullish divergence there.
    const average = new Array(series.length).fill(null);
    average[8] = 0;
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        requireZeroSide: true,
        trendAverage: average,
      }).filter((d) => d.type === "bullish"),
    ).toEqual([]);
  });

  it("keeps a bullish divergence when the series sits above its average", () => {
    const { series, bars } = higherOscillatorLowFixture();
    const average = new Array(series.length).fill(null);
    average[8] = -10; // below -4 -> uptrend -> bullish admitted
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        requireZeroSide: true,
        trendAverage: average,
      }).filter((d) => d.type === "bullish"),
    ).toHaveLength(1);
  });

  it("filters by the CONFIRMING pivot's trend, not the earlier pivot's", () => {
    const { series, bars } = higherOscillatorLowFixture();
    const average = new Array(series.length).fill(null);
    // Uptrend at the FIRST pivot (index 2) but downtrend at the confirming one.
    average[2] = -10;
    average[8] = 0;
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        requireZeroSide: true,
        trendAverage: average,
      }).filter((d) => d.type === "bullish"),
    ).toEqual([]);
  });

  it("rejects a misaligned average rather than comparing the wrong bars", () => {
    const bars = makeBars([deltaBar(1), deltaBar(2), deltaBar(3)]);
    const series = rollingDeltaSeries(bars, 1);
    expect(() =>
      detectCvdDivergences(
        bars,
        series,
        1,
        { min: 1, max: 30 },
        {
          requireZeroSide: true,
          trendAverage: [1, 2],
        },
      ),
    ).toThrow(/must align with the series/);
  });

  it("detects normally when no average is supplied", () => {
    const { series, bars } = higherOscillatorLowFixture();
    expect(detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE)).toEqual(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        requireZeroSide: true,
        trendAverage: undefined,
      }),
    );
  });

  it("ignores trendInverted when no average is supplied", () => {
    const { series, bars } = higherOscillatorLowFixture();
    // The distance range is passed explicitly and identically to both calls so
    // that trendInverted is the ONLY difference being asserted -- comparing
    // against a default-range call would also be measuring the default.
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        requireZeroSide: true,
        trendInverted: true,
      }),
    ).toEqual(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        requireZeroSide: true,
      }),
    );
  });

  it("keeps a bullish divergence that the upright filter would have dropped, when inverted", () => {
    const { series, bars } = higherOscillatorLowFixture();
    const average = new Array(series.length).fill(null);
    // The confirming pivot (index 8, value -4) sits BELOW this average, which
    // the default reading calls a downtrend and forbids -- but that is exactly
    // what the inverted reading wants from a bullish divergence.
    average[8] = -3;
    const options = { requireZeroSide: true, trendAverage: average };
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, options).filter(
        (d) => d.type === "bullish",
      ),
    ).toEqual([]);
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        ...options,
        trendInverted: true,
      }).filter((d) => d.type === "bullish"),
    ).toHaveLength(1);
  });
});

/**
 * The oscillator is supplied directly to these suites rather than through
 * rollingDeltaSeries: the two are independent units, and pinning the
 * divergence rules to a hand-written series keeps a change in the rolling
 * window from silently rewriting what the assertions mean.
 */
function barsFor(closes: readonly number[]): BarFrame[] {
  return makeBars(closes.map((close) => ({ close, buy: 50, volume: 100 })));
}

/** A close that is neither the high nor the low of the fixture bars. */
const FLAT = 105;

/**
 * The canonical divergence fixture: oscillator lows at index 2 (-8) and index
 * 8 (-4), a HIGHER low, while price closes LOWER (100 -> 90).
 *
 * The pivots sit SIX bars apart on purpose. The first pair used to be 4 bars
 * apart with index 6 confirming, which was only reachable while the default
 * `minPivotDistance` was 1; once that default rose to 5, four-bar fixtures
 * stopped being detected by the DEFAULT call path and these tests were
 * silently measuring the distance filter instead of the rule they name. Six
 * bars clears the default either way, and DEFAULT_RANGE is passed explicitly
 * wherever the test's subject is something else.
 */
const PIVOT_GAP_DISTANCE = { min: 1, max: 30 } as const;

function higherOscillatorLowFixture() {
  return {
    series: [-1, -2, -8, -2, -1, -3, -3, -3, -4, -1, -2],
    bars: barsFor([
      FLAT,
      FLAT,
      100,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      90,
      FLAT,
      FLAT,
    ]),
  };
}

function lowerOscillatorHighFixture() {
  return {
    series: [1, 2, 8, 2, 1, 3, 3, 3, 4, 1, 2],
    bars: barsFor([95, 95, 100, 95, 95, 95, 95, 95, 110, 95, 95]),
  };
}

describe("detectCvdDivergences", () => {
  describe("pivots on price", () => {
    const priceMode = { requireZeroSide: true, pivotSource: "price" } as const;

    it("flags bullish when price pivots lower while CVD, with no pivots of its own, rises", () => {
      const bars = barsFor([
        FLAT,
        FLAT,
        100,
        FLAT,
        FLAT,
        FLAT,
        FLAT,
        FLAT,
        90,
        FLAT,
        FLAT,
      ]);
      const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      expect(detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE)).toEqual(
        [],
      );
      const found = detectCvdDivergences(
        bars,
        series,
        2,
        PIVOT_GAP_DISTANCE,
        priceMode,
      );
      expect(found).toHaveLength(1);
      expect(found[0].type).toBe("bullish");
      expect(found[0].priceFrom.index).toBe(2);
      expect(found[0].priceTo.index).toBe(8);
      expect(found[0].cvdFrom.value).toBe(3);
      expect(found[0].cvdTo.value).toBe(9);
    });

    it("flags bearish when price pivots higher while CVD falls, regardless of its sign", () => {
      const bars = barsFor([95, 95, 100, 95, 95, 95, 95, 95, 110, 95, 95]);
      const series = [11, 10, 9, 8, 7, 6, 5, 4, -3, 2, 1];
      const found = detectCvdDivergences(
        bars,
        series,
        2,
        PIVOT_GAP_DISTANCE,
        priceMode,
      );
      expect(found).toHaveLength(1);
      expect(found[0].type).toBe("bearish");
      expect(found[0].cvdFrom.value).toBe(9);
      expect(found[0].cvdTo.value).toBe(-3);
    });

    it("does not flag when CVD confirms price", () => {
      const bars = barsFor([95, 95, 100, 95, 95, 95, 95, 95, 110, 95, 95]);
      const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      expect(
        detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, priceMode),
      ).toEqual([]);
    });

    it("never judges a price pivot against bars across a data hole", () => {
      // The price low at index 8 is only a pivot if bars 9 and 10 count, and a
      // day-long hole opens before bar 9. The CVD mode cannot pivot there (its
      // series is null after a hole); price mode keeps to the same rule.
      const closes = [FLAT, FLAT, 100, FLAT, FLAT, FLAT, FLAT, FLAT, 90, FLAT, FLAT];
      const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      const contiguous = barsFor(closes);
      expect(
        detectCvdDivergences(contiguous, series, 2, PIVOT_GAP_DISTANCE, priceMode),
      ).toHaveLength(1);
      const holed = makeBars(
        closes.map((close, index) => ({
          close,
          buy: 50,
          volume: 100,
          ...(index === 9 ? { tsOpen: 9 * ONE_MINUTE + 24 * 60 * ONE_MINUTE } : {}),
        })),
      );
      expect(
        detectCvdDivergences(holed, series, 2, PIVOT_GAP_DISTANCE, priceMode),
      ).toEqual([]);
    });

    it("pivots the cumulative CVD on price too", () => {
      const bars = barsFor([FLAT, FLAT, 100, FLAT, FLAT, FLAT, FLAT, FLAT, 90, FLAT, FLAT]);
      const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      expect(
        detectCumulativeCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE),
      ).toEqual([]);
      const found = detectCumulativeCvdDivergences(
        bars,
        series,
        2,
        PIVOT_GAP_DISTANCE,
        undefined,
        undefined,
        "price",
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        type: "bullish",
        cvdFrom: { value: 3 },
        cvdTo: { value: 9 },
      });
    });

    it("skips pairs whose CVD is missing at a price pivot", () => {
      const bars = barsFor([95, 95, 100, 95, 95, 95, 95, 95, 110, 95, 95]);
      const series = [11, 10, null, 8, 7, 6, 5, 4, 3, 2, 1];
      expect(
        detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, priceMode),
      ).toEqual([]);
    });
  });

  it("flags a bullish divergence when the oscillator fails to confirm a lower price low", () => {
    // Oscillator lows at index 2 (-8) and index 8 (-4): a HIGHER low.
    const { series, bars } = higherOscillatorLowFixture();
    // ... while price closes LOWER (100 -> 90).
    const bullish = detectCvdDivergences(
      bars,
      series,
      2,
      PIVOT_GAP_DISTANCE,
    ).filter((divergence) => divergence.type === "bullish");

    expect(bullish).toHaveLength(1);
    expect(bullish[0].priceTo.index).toBe(8);
    expect(bullish[0].priceTo.price).toBe(90);
    expect(bullish[0].priceFrom.index).toBe(2);
    expect(bullish[0].priceFrom.price).toBe(100);
    // The oscillator's own pivot values are what the shared type stores as "cvd".
    expect(bullish[0].cvdFrom.value).toBe(-8);
    expect(bullish[0].cvdTo.value).toBe(-4);
    expect(bullish[0].cvdTo.value).toBeGreaterThan(bullish[0].cvdFrom.value);
  });

  it("flags a bearish divergence when the oscillator fails to confirm a higher price high", () => {
    const { series, bars } = lowerOscillatorHighFixture();
    const bearish = detectCvdDivergences(
      bars,
      series,
      2,
      PIVOT_GAP_DISTANCE,
    ).filter((divergence) => divergence.type === "bearish");

    expect(bearish).toHaveLength(1);
    expect(bearish[0].priceTo.index).toBe(8);
    expect(bearish[0].priceTo.price).toBe(110);
    expect(bearish[0].priceFrom.price).toBe(100);
    expect(bearish[0].cvdTo.value).toBeLessThan(bearish[0].cvdFrom.value);
  });

  it("does NOT flag a bullish divergence when the oscillator confirms the lower low too", () => {
    // The same geometry as the bullish fixture, except the second oscillator
    // low (-12) is LOWER than the first (-8), so the flow confirmed price.
    const series = [-1, -2, -8, -2, -1, -3, -3, -3, -12, -1, -2];
    const bars = barsFor([
      FLAT,
      FLAT,
      100,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      90,
      FLAT,
      FLAT,
    ]);
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE).filter(
        (d) => d.type === "bullish",
      ),
    ).toEqual([]);
  });

  it("does NOT flag when price does not extend, even though the oscillator diverges", () => {
    // Higher oscillator low, but price makes a HIGHER low as well -> confirmed.
    // The wide-gap geometry means this also exercises the DEFAULT distance
    // range: the pair is admitted by it and then rejected by the price rule.
    const { series } = higherOscillatorLowFixture();
    const bars = barsFor([
      FLAT,
      FLAT,
      100,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      105,
      FLAT,
      FLAT,
    ]);
    expect(detectCvdDivergences(bars, series, 2)).toEqual([]);
  });

  it("treats a null oscillator value between two pivots as a new epoch and refuses to compare across it", () => {
    const series = [1, 2, -8, 2, null, 3, -4, 2, 1];
    const bars = barsFor([FLAT, FLAT, 100, FLAT, FLAT, FLAT, 90, FLAT, FLAT]);
    // With pivotPeriods 1 both pivots still form (the null sits between their
    // windows), so only the epoch guard can be what suppresses the result.
    expect(findSeriesPivots(bars, series, 1, "low")).toHaveLength(2);
    expect(detectCvdDivergences(bars, series, 1)).toEqual([]);
  });

  it("refuses to compare two pivots separated by a ts_open discontinuity", () => {
    const series = [1, 2, -8, 2, 1, 3, -4, 2, 1];
    const bars = makeBars([
      { close: FLAT, buy: 50 },
      { close: FLAT, buy: 50 },
      { close: 100, buy: 50 },
      { close: FLAT, buy: 50 },
      { close: FLAT, buy: 50, tsOpen: 20 * ONE_MINUTE },
      { close: FLAT, buy: 50, tsOpen: 21 * ONE_MINUTE },
      { close: 90, buy: 50, tsOpen: 22 * ONE_MINUTE },
      { close: FLAT, buy: 50, tsOpen: 23 * ONE_MINUTE },
      { close: FLAT, buy: 50, tsOpen: 24 * ONE_MINUTE },
    ]);
    expect(detectCvdDivergences(bars, series, 1)).toEqual([]);
  });

  it("does NOT flag a bearish divergence built entirely BELOW the zero line", () => {
    // Oscillator highs at index 2 (-1) and index 8 (-3), the second lower,
    // against a higher price high -- but both highs are below zero, so the
    // flow never turned positive and this is not distribution.
    const series = [-5, -4, -1, -4, -5, -6, -5, -4, -3, -4, -5];
    const bars = barsFor([
      FLAT,
      FLAT,
      100,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      110,
      FLAT,
      FLAT,
    ]);
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE).filter(
        (d) => d.type === "bearish",
      ),
    ).toEqual([]);
  });

  it("does NOT flag a bullish divergence built entirely ABOVE the zero line", () => {
    // Oscillator lows at index 2 (1) and index 8 (3), the second higher,
    // against a lower price low -- but both lows are above zero.
    const series = [5, 4, 1, 4, 5, 6, 5, 4, 3, 4, 5];
    const bars = barsFor([
      FLAT,
      FLAT,
      100,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      90,
      FLAT,
      FLAT,
    ]);
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE).filter(
        (d) => d.type === "bullish",
      ),
    ).toEqual([]);
  });

  it("still needs the zero gate to be met by BOTH pivots, not just one", () => {
    // The first high is POSITIVE (4) and the second is NEGATIVE (-2), which is
    // a lower high -- a bearish shape -- but the second pivot is on the wrong
    // side of zero, so the pair is rejected.
    const series = [3, 2, 4, 2, 3, -5, -5, -4, -2, -4, -5];
    const bars = barsFor([
      FLAT,
      FLAT,
      100,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      110,
      FLAT,
      FLAT,
    ]);
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE).filter(
        (d) => d.type === "bearish",
      ),
    ).toEqual([]);
  });

  it("can skip the zero-side gate, for a series the gate does not describe", () => {
    // Two strict oscillator HIGHS, both below zero, the second lower, against
    // a price that closes higher -- a textbook bearish divergence except that
    // the flow never turned positive.
    const series = [-5, -4, -1, -4, -5, -6, -5, -4, -3, -4, -5];
    const bars = barsFor([
      FLAT,
      FLAT,
      100,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      110,
      FLAT,
      FLAT,
    ]);
    // With the gate ON (the oscillator's default) this is suppressed.
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE).filter(
        (divergence) => divergence.type === "bearish",
      ),
    ).toEqual([]);
    // With it OFF -- the mode the drifting cumulative series uses -- the same
    // pivots are a real divergence.
    expect(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        requireZeroSide: false,
      }).filter((divergence) => divergence.type === "bearish"),
    ).toHaveLength(1);
  });

  it("defaults the zero-side gate ON, so existing behaviour is unchanged", () => {
    const series = [-5, -4, -1, -4, -5, -6, -5, -4, -3, -4, -5];
    const bars = barsFor([
      FLAT,
      FLAT,
      100,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      FLAT,
      110,
      FLAT,
      FLAT,
    ]);
    // The same call with and without an explicit options object must agree.
    expect(detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE)).toEqual(
      detectCvdDivergences(bars, series, 2, PIVOT_GAP_DISTANCE, {
        requireZeroSide: true,
      }),
    );
  });

  it("returns divergences oldest first, so consumers can rely on the ordering", () => {
    // Oscillator highs at 2, 10 and 18, each lower than the last, against a
    // price that keeps making higher highs -> two bearish divergences in a
    // row, each pair 8 bars apart so the default minimum admits both.
    const series = [
      1, 2, 8, 2, 1, 1, 1, 1, 1, 3, 5, 1, 1, 1, 1, 1, 1, 1, 4, 1, 2,
    ];
    const bars = barsFor([
      95, 95, 100, 95, 95, 95, 95, 95, 95, 95, 110, 95, 95, 95, 95, 95, 95, 95,
      120, 95, 95,
    ]);
    const bearish = detectCvdDivergences(bars, series, 2, {
      min: 1,
      max: 30,
    }).filter((divergence) => divergence.type === "bearish");

    expect(bearish.map((divergence) => divergence.priceTo.index)).toEqual([
      10, 18,
    ]);
    expect(bearish.every((divergence) => divergence.reasons.length === 0)).toBe(
      true,
    );
  });

  it("rejects a pivot period outside the supported range", () => {
    const bars = makeBars([deltaBar(1), deltaBar(2), deltaBar(3)]);
    const series = rollingDeltaSeries(bars, 1);
    expect(() => detectCvdDivergences(bars, series, 0)).toThrow(
      /pivotPeriods must be between/,
    );
    expect(() => detectCvdDivergences(bars, series, 21)).toThrow(
      /pivotPeriods must be between/,
    );
  });

  it("suppresses a divergence whose two pivots are closer than the minimum bar distance", () => {
    // Oscillator lows at index 2 (-8) and index 8 (-4) -> 6 bars apart.
    const { series, bars } = higherOscillatorLowFixture();
    expect(
      detectCvdDivergences(bars, series, 2, { min: 1, max: 30 }),
    ).toHaveLength(1);
    expect(
      detectCvdDivergences(bars, series, 2, { min: 7, max: 30 }).filter(
        (divergence) => divergence.type === "bullish",
      ),
    ).toEqual([]);
  });

  it("suppresses a divergence whose two pivots are further apart than the maximum bar distance", () => {
    const { series, bars } = higherOscillatorLowFixture();
    expect(
      detectCvdDivergences(bars, series, 2, { min: 1, max: 5 }).filter(
        (divergence) => divergence.type === "bullish",
      ),
    ).toEqual([]);
  });

  it("treats both distance bounds as inclusive", () => {
    // The two pivots are exactly 6 bars apart, and both ends of this range
    // admit exactly that -- so an exclusive reading of either would drop it.
    const { series, bars } = higherOscillatorLowFixture();
    expect(
      detectCvdDivergences(bars, series, 2, { min: 6, max: 6 }),
    ).toHaveLength(1);
  });

  it("rejects an inverted or non-positive distance range rather than returning a silently empty result", () => {
    const bars = makeBars([deltaBar(1), deltaBar(2), deltaBar(3)]);
    const series = rollingDeltaSeries(bars, 1);
    expect(() =>
      detectCvdDivergences(bars, series, 1, { min: 10, max: 2 }),
    ).toThrow(/minPivotDistance must not exceed maxPivotDistance/);
    expect(() =>
      detectCvdDivergences(bars, series, 1, { min: 0, max: 2 }),
    ).toThrow(/positive safe integer/);
  });

  it("defaults the distance range to 5..50 bars", () => {
    // Pins the defaults themselves rather than the detector's behaviour, and
    // pins the WINDOW: the bullish fixture's pivots are 6 bars apart, which is
    // inside it, and the range is wide enough that a caller omitting the
    // argument gets the same answer as one passing it explicitly.
    expect(DEFAULT_CVD_MIN_PIVOT_DISTANCE).toBe(5);
    expect(DEFAULT_CVD_MAX_PIVOT_DISTANCE).toBe(50);
    const { series, bars } = higherOscillatorLowFixture();
    expect(detectCvdDivergences(bars, series, 2)).toEqual(
      detectCvdDivergences(bars, series, 2, {
        min: DEFAULT_CVD_MIN_PIVOT_DISTANCE,
        max: DEFAULT_CVD_MAX_PIVOT_DISTANCE,
      }),
    );
  });

  it("defaults pivotPeriods to 5, so a pivot needs five closed bars on each side", () => {
    expect(DEFAULT_CVD_PIVOT_PERIODS).toBe(5);
  });

  it("is empty on an empty chart", () => {
    expect(detectCvdDivergences([], [], 2)).toEqual([]);
  });
});
