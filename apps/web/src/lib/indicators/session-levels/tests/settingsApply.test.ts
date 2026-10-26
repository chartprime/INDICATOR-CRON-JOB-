import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { BoxData } from "../../../chart/draw/box";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { createIndicatorRuntime } from "../../../chart/indicatorRuntime";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { sessionLevelsIndicator } from "../sessionLevelsIndicator";
import { DEFAULT_SESSION_LEVELS_SETTINGS, type SessionLevelsSettings } from "../sessionLevelsRules";

const MINUTE = 60_000;
const ID = sessionLevelsIndicator.id;

function ny(day: number, hh: number, mm: number): number {
  return Date.UTC(2026, 0, day, hh + 5, mm);
}

function bar(ts_open: number, closed = true, high = 101, low = 99): BarFrame {
  return {
    type: "bar", symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", interval_ms: MINUTE, ts_open,
    open: 100, high, low, close: 100, volume: 0, trade_count: 1, closed,
  } as BarFrame;
}

/**
 * Ten-second columns over rows 80..130 at a row of one from `from` for `minutes` minutes: an ask wall of 40 on row 101, and
 * 100 contracts bought into it at 09:36:20 -- NQ's floor of 75 and twice the wall, so an absorption.
 */
function bookOf(epoch: number, from: number, minutes: number): IndicatorLiquidity {
  const columns: LiquidityColumn[] = [];
  for (let ts = from; ts < from + minutes * MINUTE; ts += 10_000) {
    const ask = new Float64Array(51);
    ask[101 - 80] = 40;
    columns.push({ ts, lo: 80, hi: 130, ask, bid: new Float64Array(51), prints: [], buy: ts === ny(15, 9, 36) + 20_000 ? [[101, 100]] : [], sell: [] });
  }
  const feed = { epoch, deep: null, fine: { columns, columnMs: 10_000 } };
  return { get feed() { return feed; }, rowWidth: 1, baseAsset: "NQ", version: epoch };
}

/** NY AM from 09:28 to 09:40: 99..101 through the five-minute window, 99.5..100.5 after, but for 09:36, which wicks to 102 and closes back at 100: the five-minute high of 101 first touched at 09:36. */
function morning(): BarFrame[] {
  const bars: BarFrame[] = [];
  for (let ts = ny(15, 9, 28); ts <= ny(15, 9, 40); ts += MINUTE) bars.push(ts <= ny(15, 9, 34) ? bar(ts) : bar(ts, true, ts === ny(15, 9, 36) ? 102 : 100.5, 99.5));
  return bars;
}

function orb5High(runtime: ReturnType<typeof createIndicatorRuntime>): string | undefined {
  return drawn(runtime).find((text) => text.startsWith("ORB5.H"));
}

function drawn(runtime: ReturnType<typeof createIndicatorRuntime>): string[] {
  const owner = runtime.getDrawOwnerId(ID);
  if (owner === null) return [];
  return handlesForOwners([owner]).filter((record) => record.kind === "box").map((record) => String((record.data as BoxData).text)).filter((text) => text !== "");
}

/** The chart's own path: activate on NY AM's bars, then feed the bar after it as ChartPanel does. */
function chartWith(settings: SessionLevelsSettings) {
  resetDrawRegistryForTests();
  const runtime = createIndicatorRuntime([sessionLevelsIndicator as never]);
  const bars: BarFrame[] = [];
  for (let ts = ny(15, 9, 28); ts <= ny(15, 11, 0); ts += MINUTE) bars.push(bar(ts));
  runtime.setActive(new Set([ID]), { [ID]: settings }, bars);
  bars.push(bar(ny(15, 11, 1), false));
  runtime.onBar(bars[bars.length - 1], "APPENDED", bars);
  return { runtime, bars };
}

describe("a settings change reaches the chart", () => {
  it("shows NY AM's opening-range and session levels on the shipped defaults", () => {
    const { runtime } = chartWith(DEFAULT_SESSION_LEVELS_SETTINGS);
    expect(drawn(runtime)).toEqual([
      "ORB5.H", "ORB5.L", "ORB15.H", "ORB15.L", "ORB30.H", "ORB30.L", "NY AM.H", "NY AM.L",
    ]);
  });

  it("redraws the moment the trader turns a session or a window off, without waiting for another bar", () => {
    const { runtime, bars } = chartWith(DEFAULT_SESSION_LEVELS_SETTINGS);
    runtime.updateSettings(ID, { ...DEFAULT_SESSION_LEVELS_SETTINGS, windows: new Set([15]) }, bars);
    expect(drawn(runtime)).toEqual(["ORB15.H", "ORB15.L", "NY AM.H", "NY AM.L"]);
    runtime.updateSettings(ID, { ...DEFAULT_SESSION_LEVELS_SETTINGS, windows: new Set([15]), sessionLevels: false }, bars);
    expect(drawn(runtime)).toEqual(["ORB15.H", "ORB15.L"]);
    // The opening ranges do not hang on the NY AM session's box: with NY AM off they stay, the session's own high and low go.
    runtime.updateSettings(ID, { ...DEFAULT_SESSION_LEVELS_SETTINGS, sessions: new Set(["asia"]) }, bars);
    expect(drawn(runtime)).toEqual(["ORB5.H", "ORB5.L", "ORB15.H", "ORB15.L", "ORB30.H", "ORB30.L"]);
    runtime.updateSettings(ID, { ...DEFAULT_SESSION_LEVELS_SETTINGS, sessions: new Set(["asia"]), windows: new Set([30]) }, bars);
    expect(drawn(runtime)).toEqual(["ORB30.H", "ORB30.L"]);
    runtime.updateSettings(ID, { ...DEFAULT_SESSION_LEVELS_SETTINGS, sessions: new Set(["asia"]), windows: new Set() }, bars);
    expect(drawn(runtime)).toEqual([]);
    runtime.updateSettings(ID, DEFAULT_SESSION_LEVELS_SETTINGS, bars);
    expect(drawn(runtime)).toHaveLength(8);
  });
});

describe("the book reaches levels already on the chart", () => {
  it("reads the bars already drawn once the book arrives after them, though the runtime replays only L2 indicators then", () => {
    // The chart's order on a page load: bars first, the book a moment later, then the next live tick.
    resetDrawRegistryForTests();
    const runtime = createIndicatorRuntime([sessionLevelsIndicator as never]);
    const bars = morning();
    runtime.setActive(new Set([ID]), { [ID]: DEFAULT_SESSION_LEVELS_SETTINGS }, bars);
    expect(orb5High(runtime)).toBe("ORB5.H");
    runtime.setLiquidity(bookOf(1, ny(15, 9, 28), 14), bars);
    bars.push(bar(ny(15, 9, 41), false, 100.5, 99.5));
    runtime.onBar(bars[bars.length - 1], "APPENDED", bars);
    expect(orb5High(runtime)).toBe("ORB5.H · Absorbed · 100 contracts bought / 0 sold");
  });

  it("keeps a verdict once decided when the book is replaced by one whose columns no longer reach the window, and reads an undecided level again", () => {
    // The browser's book slides forward through the day: a level judged at 09:36 must not turn into "no book" at 21:00, on a
    // page reload or a deep-tier resync, because the columns it was judged on have gone.
    resetDrawRegistryForTests();
    const runtime = createIndicatorRuntime([sessionLevelsIndicator as never]);
    const bars = morning();
    runtime.setLiquidity(bookOf(1, ny(15, 9, 28), 14), bars);
    runtime.setActive(new Set([ID]), { [ID]: DEFAULT_SESSION_LEVELS_SETTINGS }, bars);
    expect(orb5High(runtime)).toBe("ORB5.H · Absorbed · 100 contracts bought / 0 sold");
    runtime.setLiquidity(bookOf(2, ny(15, 9, 45), 10), bars);
    bars.push(bar(ny(15, 9, 41), false, 100.5, 99.5));
    runtime.onBar(bars[bars.length - 1], "APPENDED", bars);
    expect(orb5High(runtime)).toBe("ORB5.H · Absorbed · 100 contracts bought / 0 sold");
    // The low of the same range was never reached: undecided, it is read again on the new book and shows what rests now.
    expect(drawn(runtime).find((text) => text.startsWith("ORB5.L"))).toBe("ORB5.L");
  });

  it("takes a no-book window's touch time from the new snapshot's book, not the bar's open, when the new book reaches it", () => {
    // The mid reaches the five-minute high's band at 09:36:20, twenty seconds into the touch bar, and 100 are bought into the
    // wall at 09:41:10: inside a window from 09:36:20, outside one from the bar's open.
    const book = (epoch: number, from: number, minutes: number): IndicatorLiquidity => {
      const columns: LiquidityColumn[] = [];
      for (let ts = from; ts < from + minutes * MINUTE; ts += 10_000) {
        const ask = new Float64Array(51);
        const bid = new Float64Array(51);
        ask[101 - 80] = 40;
        bid[(ts >= ny(15, 9, 36) + 20_000 ? 100 : 98) - 80] = 5;
        columns.push({ ts, lo: 80, hi: 130, ask, bid, prints: [], buy: ts === ny(15, 9, 41) + 10_000 ? [[101, 100]] : [], sell: [] });
      }
      const feed = { epoch, deep: null, fine: { columns, columnMs: 10_000 } };
      return { get feed() { return feed; }, rowWidth: 1, baseAsset: "NQ", version: epoch };
    };
    resetDrawRegistryForTests();
    const runtime = createIndicatorRuntime([sessionLevelsIndicator as never]);
    const bars = morning();
    runtime.setLiquidity(book(1, ny(15, 9, 38), 6), bars);
    runtime.setActive(new Set([ID]), { [ID]: DEFAULT_SESSION_LEVELS_SETTINGS }, bars);
    expect(orb5High(runtime)).toBe("ORB5.H · Liquidity sweep");
    runtime.setLiquidity(book(2, ny(15, 9, 28), 16), bars);
    for (const ts of [ny(15, 9, 41), ny(15, 9, 42), ny(15, 9, 43)]) {
      bars.push(bar(ts, true, 100.5, 99.5));
      runtime.onBar(bars[bars.length - 1], "APPENDED", bars);
    }
    expect(orb5High(runtime)).toBe("ORB5.H · Absorbed · 100 contracts bought / 0 sold");
  });

  it("reads the levels again when the book is replaced by a new snapshot that covers bars the old one did not: a window judged on no book gets its verdict", () => {
    resetDrawRegistryForTests();
    const runtime = createIndicatorRuntime([sessionLevelsIndicator as never]);
    const bars = morning();
    runtime.setLiquidity(bookOf(1, ny(15, 9, 38), 4), bars);
    runtime.setActive(new Set([ID]), { [ID]: DEFAULT_SESSION_LEVELS_SETTINGS }, bars);
    expect(orb5High(runtime)).toBe("ORB5.H · Liquidity sweep");
    runtime.setLiquidity(bookOf(2, ny(15, 9, 28), 14), bars);
    bars.push(bar(ny(15, 9, 41), false, 100.5, 99.5));
    runtime.onBar(bars[bars.length - 1], "APPENDED", bars);
    expect(orb5High(runtime)).toBe("ORB5.H · Absorbed · 100 contracts bought / 0 sold");
  });
});
