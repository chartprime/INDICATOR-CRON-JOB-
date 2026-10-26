import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { StatusLog, barPx, fitsInside, holesIn, labelFontPx, layoutDelta, mergeRows, neighbourWidthAt, onBaseHandle, onReachHandle, placeLabels, profileStatus, reachShareAt, spanWords, withAlpha } from "../deltaProfileLayout";
import { autoRowFactorFor, drawnRowFactor, rowFactorFor } from "../liveDeltaProfileSettings";
import { formatDelta } from "../liveDeltaProfileNumbers";

describe("mergeRows", () => {
  it("sums fine rows into wider ones on the absolute grid, ascending, and leaves them alone at factor 1", () => {
    const rows = [
      { price: 84_609, buy: 1, sell: 0 },
      { price: 84_610, buy: 2, sell: 1 },
      { price: 84_611, buy: 0, sell: 3 },
      { price: 84_613, buy: 5, sell: 0 },
    ];
    expect(mergeRows(rows, 1, 1).map((row) => [row.price, row.priceTo, row.buy, row.sell])).toEqual([
      [84_609, 84_610, 1, 0], [84_610, 84_611, 2, 1], [84_611, 84_612, 0, 3], [84_613, 84_614, 5, 0],
    ]);
    expect(mergeRows(rows, 1, 4).map((row) => [row.index, row.price, row.priceTo, row.buy, row.sell])).toEqual([
      [21_152, 84_608, 84_612, 3, 4], [21_153, 84_612, 84_616, 5, 0],
    ]);
    expect(mergeRows([{ price: 84_610.3, buy: 1, sell: 0 }, { price: 84_610.4, buy: 1, sell: 0 }], 0.1, 4)).toEqual([
      { index: 211_525, price: 84_610, priceTo: 84_610.4, buy: 1, sell: 0 },
      { index: 211_526, price: 84_610.4, priceTo: 84_610.8, buy: 1, sell: 0 },
    ]);
  });
});

describe("layoutDelta", () => {
  const yOf = (price: number) => (price < 84_600 ? null : 100 - (price - 84_600) * 10);

  it("places the rows in view with their net against the biggest net in view, dropping rows off the pane or half off the price scale", () => {
    const bars = layoutDelta([
      { index: 0, price: 84_601, priceTo: 84_602, buy: 12.4, sell: 3.1 },
      { index: 1, price: 84_602, priceTo: 84_603, buy: 0, sell: 7.75 },
      { index: 2, price: 84_620, priceTo: 84_621, buy: 100, sell: 0 },
      { index: 3, price: 84_590, priceTo: 84_591, buy: 100, sell: 0 },
      { index: 4, price: 84_605, priceTo: 84_606, buy: 1, sell: 1 },
      { index: 5, price: 84_599, priceTo: 84_600, buy: 100, sell: 0 },
      { index: 6, price: 84_600, priceTo: 84_601, buy: 100, sell: 0 },
    ], yOf, 85);
    expect(bars.map((bar) => [bar.index, bar.yTop, bar.yBottom, bar.net, bar.share])).toEqual([
      [0, 80, 90, 9.3, 1],
      [1, 70, 80, -7.75, 7.75 / 9.3],
      [4, 40, 50, 0, 0],
    ]);
    expect(layoutDelta([], yOf, 100)).toEqual([]);
  });

  it("scales against the biggest net whichever side won it, and a pane where every row is balanced draws nothing", () => {
    const bars = layoutDelta([
      { index: 0, price: 84_601, priceTo: 84_602, buy: 0, sell: 10 },
      { index: 1, price: 84_602, priceTo: 84_603, buy: 2, sell: 0 },
    ], yOf, 100);
    expect(bars.map((bar) => bar.share)).toEqual([1, 0.2]);
    expect(layoutDelta([{ index: 0, price: 84_601, priceTo: 84_602, buy: 3, sell: 3 }], yOf, 100).map((bar) => bar.share)).toEqual([0]);
  });
});

describe("row factor", () => {
  it("auto follows the timeframe and merges further while a drawn row would be too thin", () => {
    expect([60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000].map(autoRowFactorFor)).toEqual([1, 4, 12, 40, 120, 400]);
    expect(rowFactorFor({ rowFactor: 0 }, 300_000)).toBe(4);
    expect(rowFactorFor({ rowFactor: 12 }, 300_000)).toBe(12);
    expect(drawnRowFactor(1, 10)).toBe(1);
    expect(drawnRowFactor(1, 2)).toBe(3);
    expect(drawnRowFactor(4, 1)).toBe(8);
    expect(drawnRowFactor(4, 0)).toBe(4);
  });
});

describe("holesIn", () => {
  const bar = (tsOpen: number, volume: number, intervalMs = 60_000): BarFrame => ({
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", interval_ms: intervalMs, ts_open: tsOpen,
    open: 1, high: 1, low: 1, close: 1, volume, trade_count: null, closed: true,
  });

  it("names a piece whose volume is far under the candles' over the same hours, in time order, and only when candles cover it", () => {
    const H = 3_600_000;
    const pieces = [
      { from: 4 * H, to: 6 * H, volume: 900 },
      { from: 2 * H, to: 4 * H, volume: 10 },
      { from: 0, to: 2 * H, volume: 0 },
    ];
    const bars = [bar(2 * H, 500), bar(3 * H, 500), bar(4 * H, 500), bar(5 * H, 500)];
    expect(holesIn(pieces, bars)).toEqual([{ from: 2 * H, to: 4 * H, volume: 10 }]);
    expect(holesIn(pieces, [bar(2 * H, 500, 4 * H)])).toEqual([]);
    expect(holesIn(pieces, [])).toEqual([]);
    expect(holesIn([
      { from: 6 * H, to: 8 * H, volume: 0 },
      { from: 2 * H, to: 4 * H, volume: 0 },
    ], [bar(2 * H, 500), bar(6 * H, 500)]).map((hole) => hole.from)).toEqual([2 * H, 6 * H]);
    expect(holesIn([{ from: 2 * H, to: 4 * H, volume: 500 }], [bar(2 * H, 1_000)])).toEqual([]);
    expect(holesIn([{ from: 2 * H, to: 4 * H, volume: 499 }], [bar(2 * H, 1_000)])).toHaveLength(1);
    expect(holesIn([{ from: 2 * H, to: 4 * H, volume: 500 }], [bar(2 * H, 1_000)], 0.6)).toHaveLength(1);
  });

  it("does not call unclassified dxFeed equity volume a missing recording", () => {
    const equity: BarFrame = {
      ...bar(0, 1_000), provider: "DXFEED", marketKind: undefined, assetClass: "EQUITY", symbol: "AAPL",
      buy_volume: 80, sell_volume: 20,
    };
    expect(holesIn([{ from: 0, to: 60_000, volume: 100 }], [equity])).toEqual([]);
    expect(holesIn([{ from: 0, to: 60_000, volume: 40 }], [equity])).toHaveLength(1);
    const noSideVolumes: BarFrame = { ...equity, buy_volume: undefined, sell_volume: undefined };
    expect(holesIn([{ from: 0, to: 60_000, volume: 0 }], [noSideVolumes])).toEqual([]);
  });

  it("spells a span in the viewer's clock", () => {
    expect(spanWords(Date.UTC(2026, 8, 23, 14), Date.UTC(2026, 8, 23, 20))).toMatch(/^\d\d:\d\d–\d\d:\d\d$/);
  });
});

describe("the numbers beside the bars", () => {
  it("writes the net as a whole number, rounded, with k and M only for the big ones", () => {
    expect(formatDelta(70.6)).toBe("71");
    expect(formatDelta(-70.6)).toBe("-71");
    expect(formatDelta(70.4)).toBe("70");
    expect(formatDelta(9_999)).toBe("9999");
    expect(formatDelta(9_999.6)).toBe("10k");
    expect(formatDelta(12_345)).toBe("12k");
    expect(formatDelta(-5_912_900)).toBe("-5913k");
    expect(formatDelta(9_999_600)).toBe("10M");
    expect(formatDelta(-12_400_000)).toBe("-12M");
  });

  it("says under one instead of a zero when a small net rounds away", () => {
    expect(formatDelta(0.3)).toBe("<1");
    expect(formatDelta(-0.3)).toBe("<1");
    expect(formatDelta(0.5)).toBe("1");
    expect(formatDelta(-0.5)).toBe("-1");
  });

  it("never draws a bar shorter than its own number, and never longer than the room there is", () => {
    expect(barPx(1, 200, "441", 11)).toBe(200);
    expect(barPx(0.5, 200, "<1", 11)).toBe(100);
    expect(barPx(0.05, 200, "12", 11)).toBe(22);
    expect(barPx(0.02, 200, "5", 11)).toBe(15);
    expect(barPx(0.02, 200, "5", 8)).toBe(13);
    expect(barPx(0.05, 12, "12", 11)).toBe(12);
    expect(barPx(0, 200, "<1", 11)).toBe(0);
  });

  it("sizes the floor by the digits, not the sign: a single digit stays shorter than a ten, whichever side won", () => {
    expect(barPx(0.02, 200, "-5", 11)).toBe(15);
    expect(barPx(0.02, 200, "-10", 11)).toBe(22);
    expect(barPx(0.02, 200, "-5", 11)).toBeLessThan(barPx(0.02, 200, "10", 11));
  });

  it("counts a number as inside its bar when it clears the bar by the inside margin", () => {
    expect(fitsInside(15, 11)).toBe(true);
    expect(fitsInside(15, 11.5)).toBe(false);
    expect(fitsInside(0, 0)).toBe(false);
  });

  it("shrinks the font with the row, never under the floor nor over the full size", () => {
    expect(labelFontPx(40)).toBe(11);
    expect(labelFontPx(12)).toBe(10);
    expect(labelFontPx(6)).toBe(8);
    expect(labelFontPx(2)).toBe(8);
  });

  it("gives the biggest bars their number first and skips a bar whose number would sit on one already placed", () => {
    const row = (index: number, yTop: number, yBottom: number, net: number, share: number) => ({ index, yTop, yBottom, net, share });
    const bars = [row(3, 0, 6, 5, 1), row(2, 6, 12, -4, 0.8), row(1, 12, 18, 0, 0), row(0, 18, 24, 2, 0.4), row(-1, 30, 36, -1, 0.2)];
    expect(placeLabels(bars, 6).map((bar) => bar.index)).toEqual([3, 2, 0, -1]);
    expect(placeLabels(bars, 8).map((bar) => bar.index)).toEqual([3, 0, -1]);
    expect(placeLabels([row(9, 0, 6, 1, 0.3), row(8, 4, 10, 9, 1)], 8).map((bar) => bar.index)).toEqual([8]);
    expect(placeLabels([], 8)).toEqual([]);
  });

  it("numbers the small bars too, however far the chart is zoomed out, and never a balanced row", () => {
    const row = (index: number, yTop: number, yBottom: number, net: number, share: number) => ({ index, yTop, yBottom, net, share });
    const bars = [row(3, 0, 6, 5, 1), row(2, 20, 26, -4, 0.8), row(0, 40, 46, 2, 0.24), row(-1, 60, 66, -1, 0.001), row(-2, 80, 86, 0, 0)];
    expect(placeLabels(bars, 8).map((bar) => bar.index)).toEqual([3, 2, 0, -1]);
  });

  it("gives a label its backdrop in the chart's own background colour", () => {
    expect(withAlpha("#1a1b1e", 0.85)).toBe("rgba(26, 27, 30, 0.85)");
    expect(withAlpha("rgb(26, 27, 30)", 0.85)).toBe("rgba(26, 27, 30, 0.85)");
    expect(withAlpha("rgba(1, 2, 3, 1)", 0.5)).toBe("rgba(1, 2, 3, 0.5)");
    expect(withAlpha("white", 0.85)).toBe("white");
  });
});

describe("profileStatus and StatusLog", () => {
  const H = 3_600_000;
  const candle = (tsOpen: number, volume: number): BarFrame => ({
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", interval_ms: 60_000, ts_open: tsOpen,
    open: 1, high: 1, low: 1, close: 1, volume, trade_count: null, closed: true,
  });
  const base = { issue: null, complete: true, pieces: [] as { from: number; to: number; volume: number }[] };

  it("says why the profile is not the whole story, for the log only, and nothing when it is", () => {
    expect(profileStatus(base, [])).toBeNull();
    expect(profileStatus({ ...base, complete: false }, [])).toEqual({ level: "info", text: "loading history" });
    expect(profileStatus({ ...base, issue: "OVERLOADED" }, [])).toEqual({ level: "warn", text: "history busy, retrying" });
    expect(profileStatus({ ...base, issue: "ROWS_CAPPED" }, [])).toEqual({ level: "warn", text: "history refused: rows too fine for this instrument" });
    expect(profileStatus({ ...base, issue: "READ_FAILED", complete: false }, [])).toEqual({ level: "warn", text: "history unavailable (READ_FAILED)" });
    const status = profileStatus({ ...base, pieces: [{ from: 2 * H, to: 4 * H, volume: 0 }, { from: 6 * H, to: 8 * H, volume: 0 }] }, [candle(2 * H, 100), candle(6 * H, 100)]);
    expect(status?.level).toBe("warn");
    expect(status?.text).toMatch(/^partial, the recording is missing \d\d:\d\d–\d\d:\d\d, \d\d:\d\d–\d\d:\d\d$/);
  });

  it("logs a status once when it appears or changes, says when history completes, and logs again after a reset", () => {
    const log = vi.fn();
    const statusLog = new StatusLog(log);
    statusLog.report(null);
    expect(log).not.toHaveBeenCalled();
    statusLog.report({ level: "info", text: "loading history" });
    statusLog.report({ level: "info", text: "loading history" });
    expect(log.mock.calls).toEqual([["info", "Live Delta Profile: loading history"]]);
    statusLog.report({ level: "warn", text: "history busy, retrying" });
    statusLog.report(null);
    statusLog.report(null);
    expect(log.mock.calls.slice(1)).toEqual([["warn", "Live Delta Profile: history busy, retrying"], ["info", "Live Delta Profile: history complete"]]);
    statusLog.report({ level: "info", text: "loading history" });
    statusLog.reset();
    statusLog.report({ level: "info", text: "loading history" });
    expect(log).toHaveBeenCalledTimes(5);
  });

  it("the default log goes to the browser console, warnings as warnings", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const statusLog = new StatusLog();
      statusLog.report({ level: "info", text: "loading history" });
      statusLog.report({ level: "warn", text: "history busy, retrying" });
      expect(info).toHaveBeenCalledWith("Live Delta Profile: loading history");
      expect(warn).toHaveBeenCalledWith("Live Delta Profile: history busy, retrying");
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("the resize handle", () => {
  const frame = { right: 900, reach: 150, height: 500, width: 1_000 };

  it("is hit within a few pixels of the profile's left edge, anywhere down the pane", () => {
    expect(onReachHandle(frame, 750, 10)).toBe(true);
    expect(onReachHandle(frame, 756, 499)).toBe(true);
    expect(onReachHandle(frame, 744, 250)).toBe(true);
    expect(onReachHandle(frame, 757, 250)).toBe(false);
    expect(onReachHandle(frame, 743, 250)).toBe(false);
    expect(onReachHandle(frame, 750, -1)).toBe(false);
    expect(onReachHandle(frame, 750, 501)).toBe(false);
    expect(onReachHandle(frame, 740, 250, 10)).toBe(true);
  });

  it("turns a dragged x into a reach share inside the settings' bounds", () => {
    expect(reachShareAt(frame, 700, 0.05, 0.6)).toBe(0.2);
    expect(reachShareAt(frame, 890, 0.05, 0.6)).toBe(0.05);
    expect(reachShareAt(frame, 100, 0.05, 0.6)).toBe(0.6);
    expect(reachShareAt({ ...frame, width: 0 }, 700, 0.05, 0.6)).toBe(0.05);
  });
});

describe("the base line as the axis neighbour's handle", () => {
  const frame = { right: 900, reach: 150, height: 500, width: 1_000 };

  it("is hit within a few pixels of the profile's base, anywhere down the pane", () => {
    expect(onBaseHandle(frame, 900, 10)).toBe(true);
    expect(onBaseHandle(frame, 906, 499)).toBe(true);
    expect(onBaseHandle(frame, 894, 250)).toBe(true);
    expect(onBaseHandle(frame, 907, 250)).toBe(false);
    expect(onBaseHandle(frame, 893, 250)).toBe(false);
    expect(onBaseHandle(frame, 900, -1)).toBe(false);
    expect(onBaseHandle(frame, 900, 501)).toBe(false);
    expect(onBaseHandle(frame, 890, 250, 10)).toBe(true);
  });

  it("turns a dragged x into the width the neighbour should take against the axis, the gap between the two taken out, never negative", () => {
    expect(neighbourWidthAt(frame, 800, 11)).toBe(189);
    expect(neighbourWidthAt(frame, 995, 11)).toBe(0);
    expect(neighbourWidthAt(frame, 100, 11)).toBe(889);
    expect(neighbourWidthAt({ ...frame, width: 0 }, 800, 11)).toBe(0);
  });
});
