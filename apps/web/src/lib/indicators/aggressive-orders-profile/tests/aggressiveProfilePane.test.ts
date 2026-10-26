// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistogramSeries, LineStyle, type IChartApi } from "lightweight-charts";
import type { BarFrame } from "../../../../types/frames";
import { withAlpha } from "../../axis-profile/axisProfileLayout";
import { AggressiveProfilePane, DIM_ALPHA, LIVE_EASE_MS, LIVE_PULSE_LIGHTEN, LIVE_PULSE_MS, PANE_LABEL, ZERO_LINE_DARK, ZERO_LINE_LIGHT, barColour, lighten, outlierThreshold, panePoints, pulseAt, tweened, type PaneLook } from "../aggressiveProfilePane";
import { PANE_TAG_DARK, PANE_TAG_LIGHT, PaneTagPrimitive } from "../paneTagPrimitive";

const T = 1_700_000_000_000;
const look: PaneLook = { buyColor: "#00aa00", sellColor: "#aa0000", profileView: "delta", outlierFrom: 0 };
const dimBuy = withAlpha("#00aa00", DIM_ALPHA);
const dimSell = withAlpha("#aa0000", DIM_ALPHA);

function bar(tsOpen: number): BarFrame {
  return { type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", interval_ms: 60_000, ts_open: tsOpen, open: 1, high: 1, low: 1, close: 1, volume: 1, trade_count: null, closed: true };
}

const candle = (tsOpen: number, buyCount: number, buyVolume: number, sellCount: number, sellVolume: number) => ({ tsOpen, delta: buyVolume - sellVolume, buyCount, buyVolume, sellCount, sellVolume });

function fakePane() {
  return { attachPrimitive: vi.fn(), detachPrimitive: vi.fn() };
}

function fakeChart(paneCount = 2) {
  const state = { panes: Array.from({ length: paneCount }, fakePane), profileIndex: paneCount };
  const series: { createPriceLine: ReturnType<typeof vi.fn>; attachPrimitive: ReturnType<typeof vi.fn>; detachPrimitive: ReturnType<typeof vi.fn>; setData: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; getPane: () => { paneIndex: () => number } }[] = [];
  const chart = {
    addSeries: vi.fn((_kind: unknown, _options: unknown, _paneIndex: number) => {
      const next = { createPriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), setData: vi.fn(), update: vi.fn(), getPane: () => ({ paneIndex: () => state.profileIndex }) };
      series.push(next);
      return next;
    }),
    removeSeries: vi.fn(),
    panes: vi.fn(() => state.panes),
    options: () => ({ layout: { fontFamily: "Inter" } }),
  };
  return { chart: chart as unknown as IChartApi, api: chart, series, state };
}

const open = { fromTs: T, toTs: T + 60_000, open: true };
const bars = [bar(T - 60_000), bar(T), bar(T + 60_000), bar(T + 120_000), bar(T + 180_000)];
const candles = [candle(T, 2, 7, 1, 4), candle(T + 60_000, 1, 2, 1, 4), candle(T + 120_000, 0, 0, 0, 0)];
const inView = { fromTs: T + 30_000, toTs: T + 150_000 };

describe("panePoints", () => {
  it("as a net delta gives one bar per candle on screen in the buy colour from zero up and the sell colour down, a gap where no big print traded, nothing outside the range", () => {
    expect(panePoints(candles, bars, inView, look)).toEqual({
      main: [
        { time: T / 1000, value: 3, color: "#00aa00" },
        { time: T / 1000 + 60, value: -2, color: "#aa0000" },
        { time: T / 1000 + 120 },
      ],
      sells: [],
      threshold: null,
    });
    expect(panePoints([candle(T + 60_000, 1, 5, 1, 5)], bars, { fromTs: T - 60_000, toTs: T + 240_000 }, look)).toEqual({
      main: [{ time: T / 1000 - 60 }, { time: T / 1000 }, { time: T / 1000 + 60, value: 0, color: "#00aa00" }, { time: T / 1000 + 120 }, { time: T / 1000 + 180 }],
      sells: [],
      threshold: null,
    });
    expect(panePoints(candles, bars, null, look)).toEqual({ main: [], sells: [], threshold: null });
  });

  it("as buys and sells gives the buys up on the first series and the sells down on the second", () => {
    expect(panePoints(candles, bars, inView, { ...look, profileView: "sides" })).toEqual({
      main: [
        { time: T / 1000, value: 7, color: "#00aa00" },
        { time: T / 1000 + 60, value: 2, color: "#00aa00" },
        { time: T / 1000 + 120 },
      ],
      sells: [
        { time: T / 1000, value: -4, color: "#aa0000" },
        { time: T / 1000 + 60, value: -4, color: "#aa0000" },
        { time: T / 1000 + 120 },
      ],
      threshold: null,
    });
    expect(panePoints([candle(T, 1, 5, 0, 0)], [bar(T)], open, { ...look, profileView: "sides" }).sells).toEqual([{ time: T / 1000, value: 0, color: "#aa0000" }]);
  });

  it("dims every bar under the highlight threshold and leaves the outliers at full colour, by the average bar on screen in the view shown", () => {
    const spread = [candle(T, 1, 10, 0, 0), candle(T + 60_000, 0, 0, 1, 2), candle(T + 120_000, 1, 1, 0, 0)];
    const delta = panePoints(spread, bars, inView, { ...look, outlierFrom: 2 });
    expect(delta.threshold).toBeCloseTo((13 / 3) * 2, 9);
    expect(delta.main).toEqual([
      { time: T / 1000, value: 10, color: "#00aa00" },
      { time: T / 1000 + 60, value: -2, color: dimSell },
      { time: T / 1000 + 120, value: 1, color: dimBuy },
    ]);
    const sides = panePoints([candle(T, 1, 10, 1, 2), candle(T + 60_000, 1, 3, 1, 1)], bars, inView, { ...look, profileView: "sides", outlierFrom: 1.5 });
    expect(sides.threshold).toBe(6);
    expect(sides.main.map((point) => ("color" in point ? point.color : null))).toEqual(["#00aa00", dimBuy, null]);
    expect(sides.sells.map((point) => ("color" in point ? point.color : null))).toEqual([dimSell, dimSell, null]);
    const sellHeavy = panePoints([candle(T, 0, 0, 1, 10), candle(T + 60_000, 1, 2, 0, 0), candle(T + 120_000, 1, 1, 0, 0)], bars, inView, { ...look, outlierFrom: 2 });
    expect(sellHeavy.main.map((point) => ("color" in point ? point.color : null))).toEqual(["#aa0000", dimBuy, dimBuy]);
    expect(panePoints(spread, bars, { fromTs: T + 90_000, toTs: T + 150_000 }, { ...look, outlierFrom: 2 }).threshold).toBe(3);
    expect(panePoints(candles, bars, { fromTs: T + 120_000, toTs: T + 150_000 }, { ...look, outlierFrom: 2 }).threshold).toBeNull();
  });
});

describe("the outlier threshold and the bar colour", () => {
  it("is the multiple of the average bar with prints, over the deltas or over both sides, and nothing at zero or with no bar", () => {
    const shown = [candle(T, 1, 10, 1, 4), candle(T + 60_000, 0, 0, 1, 2), candle(T + 120_000, 0, 0, 0, 0)];
    expect(outlierThreshold(shown, "delta", 2)).toBe(8);
    expect(outlierThreshold(shown, "sides", 3)).toBe(16);
    expect(outlierThreshold(shown, "delta", 0)).toBeNull();
    expect(outlierThreshold([], "delta", 2)).toBeNull();
    expect(outlierThreshold([candle(T, 0, 0, 0, 0)], "sides", 2)).toBeNull();
  });

  it("keeps a bar at or over the threshold in its colour and dims one under it, and never dims without a threshold", () => {
    expect(barColour("#00aa00", 5, null)).toBe("#00aa00");
    expect(barColour("#00aa00", 6, 6)).toBe("#00aa00");
    expect(barColour("#00aa00", 5, 6)).toBe(dimBuy);
    expect(DIM_ALPHA).toBe(0.45);
  });
});

describe("the live bar's motion", () => {
  it("eases from where it was to the target over LIVE_EASE_MS, and pulses for LIVE_PULSE_MS", () => {
    expect(LIVE_EASE_MS).toBe(150);
    expect(LIVE_PULSE_MS).toBe(300);
    expect([tweened(0, 10, 1_000, 900), tweened(0, 10, 1_000, 1_000), tweened(0, 10, 1_000, 1_075), tweened(0, 10, 1_000, 1_150), tweened(0, 10, 1_000, 2_000), tweened(4, -2, 1_000, 1_100)]).toEqual([0, 0, 5, 10, 10, 0]);
    expect([tweened(10, 0.3, 1_000, 1_150), tweened(10, 0.3, 1_000, 2_000)]).toEqual([0.3, 0.3]);
    expect([pulseAt(1_000, 1_000), pulseAt(1_000, 1_150), pulseAt(1_000, 1_300), pulseAt(1_000, 1_400), pulseAt(-Infinity, 1_000)]).toEqual([1, 0.5, 0, 0, 0]);
  });

  it("lightens a hex or rgb colour towards white by the amount, and leaves a named colour alone", () => {
    expect(lighten("#000000", 0.5)).toBe("rgb(128, 128, 128)");
    expect(lighten("#102030", 0)).toBe("rgb(16, 32, 48)");
    expect(lighten("rgb(0, 100, 200)", 1)).toBe("rgb(255, 255, 255)");
    expect(lighten("rgba(0, 100, 200, 0.5)", 0)).toBe("rgba(0, 100, 200, 0.5)");
    expect(lighten("rgba(0, 100, 200, 0.45)", 0.5)).toBe("rgba(128, 178, 228, 0.45)");
    expect(lighten("#00aa00", 2)).toBe("rgb(255, 255, 255)");
    expect(lighten("red", 0.5)).toBe("red");
    expect(LIVE_PULSE_LIGHTEN).toBe(0.45);
  });
});

describe("AggressiveProfilePane", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("adds two histograms in one new pane under the chart, the zero line on the first, once, and sets each series' points", () => {
    const { chart, api, series } = fakeChart();
    const pane = new AggressiveProfilePane({ chart, dark: true });
    expect(pane.attached).toBe(false);
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], open, look);
    expect(series).toHaveLength(0);
    pane.attach();
    pane.attach();
    expect(pane.attached).toBe(true);
    expect(api.addSeries).toHaveBeenCalledTimes(2);
    const histogram = { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "volume" } };
    expect(api.addSeries.mock.calls).toEqual([
      [HistogramSeries, histogram, 2],
      [HistogramSeries, histogram, 2],
    ]);
    const [main, sells] = series;
    expect(main.createPriceLine).toHaveBeenCalledWith({ price: 0, color: ZERO_LINE_DARK, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true });
    expect(sells.createPriceLine).not.toHaveBeenCalled();
    for (const each of series) expect(each.attachPrimitive).not.toHaveBeenCalled();
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], open, look);
    expect(main.setData).toHaveBeenCalledWith([{ time: T / 1000, value: 3, color: "#00aa00" }]);
    expect(sells.setData).toHaveBeenCalledWith([]);
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], open, { ...look, profileView: "sides" });
    expect(main.setData).toHaveBeenLastCalledWith([{ time: T / 1000, value: 3, color: "#00aa00" }]);
    expect(sells.setData).toHaveBeenLastCalledWith([{ time: T / 1000, value: 0, color: "#aa0000" }]);
    pane.detach();
    pane.detach();
    expect(pane.attached).toBe(false);
    expect(api.removeSeries.mock.calls).toEqual([[sells], [main]]);
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], open, look);
    expect(main.setData).toHaveBeenCalledTimes(2);
  });

  it("puts its name on a chip at the bottom of the pane directly above it, follows when that pane changes, and takes it away when it goes", () => {
    const { chart, state } = fakeChart(2);
    const pane = new AggressiveProfilePane({ chart, dark: true });
    pane.attach();
    const [first, second] = state.panes;
    expect(second.attachPrimitive).toHaveBeenCalledTimes(1);
    const tag = second.attachPrimitive.mock.calls[0][0] as PaneTagPrimitive;
    expect(tag).toBeInstanceOf(PaneTagPrimitive);
    expect([tag.text, tag.colours, tag.fontFamily]).toEqual([PANE_LABEL, PANE_TAG_DARK, "Inter"]);
    expect(pane.tagHost).toBe(second);
    expect(first.attachPrimitive).not.toHaveBeenCalled();
    pane.render([], [bar(T)], open, look);
    expect(second.attachPrimitive).toHaveBeenCalledTimes(1);
    expect(second.detachPrimitive).not.toHaveBeenCalled();
    state.profileIndex = 1;
    pane.render([], [bar(T)], open, look);
    expect(second.detachPrimitive).toHaveBeenCalledWith(tag);
    expect(first.attachPrimitive).toHaveBeenCalledWith(tag);
    expect(pane.tagHost).toBe(first);
    state.profileIndex = 0;
    pane.render([], [bar(T)], open, look);
    expect(first.detachPrimitive).toHaveBeenCalledWith(tag);
    expect(pane.tagHost).toBeNull();
    state.profileIndex = 1;
    pane.render([], [bar(T)], open, look);
    expect(first.attachPrimitive).toHaveBeenCalledTimes(2);
    state.profileIndex = 2;
    pane.placeTag();
    expect(first.detachPrimitive).toHaveBeenCalledTimes(2);
    expect(second.attachPrimitive).toHaveBeenCalledTimes(2);
    expect(pane.tagHost).toBe(second);
    state.profileIndex = 1;
    pane.placeTag();
    pane.detach();
    expect(first.detachPrimitive).toHaveBeenCalledTimes(3);
    expect(pane.tagHost).toBeNull();
  });

  it("uses the light zero line and chip on a light chart", () => {
    const { chart, series, state } = fakeChart(1);
    new AggressiveProfilePane({ chart, dark: false }).attach();
    expect(series[0].createPriceLine.mock.calls[0][0]).toMatchObject({ color: ZERO_LINE_LIGHT });
    expect((state.panes[0].attachPrimitive.mock.calls[0][0] as PaneTagPrimitive).colours).toBe(PANE_TAG_LIGHT);
    expect(ZERO_LINE_LIGHT).not.toBe(ZERO_LINE_DARK);
  });

  function liveSetup(dark = true) {
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const now = vi.spyOn(Date, "now").mockReturnValue(T + 10_000);
    const { chart, series } = fakeChart();
    const pane = new AggressiveProfilePane({ chart, dark });
    pane.attach();
    const [main, sells] = series;
    return { pane, main, sells, frames, cancel, now };
  }

  it("moves the forming candle's bar with every big print it is handed: from where it stood to the new delta over LIVE_EASE_MS, brightened by a pulse that fades, swapping colour across zero, frame by frame until it rests", () => {
    const { pane, main, sells, frames, now } = liveSetup();
    pane.render([candle(T - 60_000, 1, 5, 0, 0), candle(T, 1, 3, 0, 0)], [bar(T - 60_000), bar(T)], { fromTs: T - 60_000, toTs: T + 60_000, open: true }, look);
    expect(pane.liveCandle).toBe(T);
    expect(frames).toHaveLength(0);
    pane.pushLive({ ts: T + 1_000, size: 4, buy: false });
    expect(frames).toHaveLength(1);
    expect(pane.tick(T + 10_000)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 3, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN) });
    expect(pane.tick(T + 10_075)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 1, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN * 0.75) });
    expect(pane.tick(T + 10_150)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: -1, color: lighten("#aa0000", LIVE_PULSE_LIGHTEN * 0.5) });
    expect(pane.tick(T + 10_300)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: -1, color: "#aa0000" });
    expect(sells.update).not.toHaveBeenCalled();
    now.mockReturnValue(T + 10_300);
    frames[0](0);
    expect(frames).toHaveLength(1);
    pane.pushLive({ ts: T + 2_000, size: 2, buy: true });
    expect(frames).toHaveLength(2);
    frames[1](0);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: -1, color: lighten("#aa0000", LIVE_PULSE_LIGHTEN) });
    expect(frames).toHaveLength(3);
    expect(pane.tick(T + 10_450)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 1, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN * 0.5) });
    expect(pane.tick(T + 10_600)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 1, color: "#00aa00" });
  });

  it("as buys and sells moves each side's bar on its own series", () => {
    const { pane, main, sells } = liveSetup();
    pane.render([candle(T, 1, 3, 1, 1)], [bar(T)], open, { ...look, profileView: "sides" });
    pane.pushLive({ ts: T + 1_000, size: 4, buy: false });
    expect(pane.tick(T + 10_075)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 3, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN * 0.75) });
    expect(sells.update).toHaveBeenLastCalledWith({ time: T / 1000, value: -3, color: lighten("#aa0000", LIVE_PULSE_LIGHTEN * 0.75) });
    expect(pane.tick(T + 10_300)).toBe(false);
    expect(sells.update).toHaveBeenLastCalledWith({ time: T / 1000, value: -5, color: "#aa0000" });
  });

  it("dims the live bar while it sits under the highlight threshold and brightens it when it crosses", () => {
    const { pane, main } = liveSetup();
    pane.render([candle(T - 60_000, 1, 100, 0, 0), candle(T, 1, 3, 0, 0)], [bar(T - 60_000), bar(T)], { fromTs: T - 60_000, toTs: T + 60_000, open: true }, { ...look, outlierFrom: 1 });
    expect(pane.tick(T + 10_000)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 3, color: dimBuy });
    pane.pushLive({ ts: T + 1_000, size: 100, buy: true });
    expect(pane.tick(T + 10_300)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 103, color: "#00aa00" });
  });

  it("keeps a dimmed live bar dimmed through its pulse, lightening it at the same alpha", () => {
    const { pane, main } = liveSetup();
    pane.render([candle(T - 60_000, 1, 100, 0, 0), candle(T, 1, 3, 0, 0)], [bar(T - 60_000), bar(T)], { fromTs: T - 60_000, toTs: T + 60_000, open: true }, { ...look, outlierFrom: 1 });
    pane.pushLive({ ts: T + 1_000, size: 1, buy: true });
    expect(pane.tick(T + 10_150)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 4, color: "rgba(57, 189, 57, 0.45)" });
  });

  it("retargets from where the bar stands when a new read of the same candle comes in, or a print lands mid-motion, and asks for one frame at a time", () => {
    const { pane, main, frames, now } = liveSetup();
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], open, look);
    pane.pushLive({ ts: T + 1_000, size: 4, buy: false });
    expect(frames).toHaveLength(1);
    now.mockReturnValue(T + 10_075);
    const wider = { fromTs: T - 60_000, toTs: T + 60_000, open: true };
    pane.render([candle(T - 60_000, 1, 5, 0, 0), candle(T, 2, 9, 0, 0)], [bar(T - 60_000), bar(T)], wider, look);
    expect(pane.liveCandle).toBe(T);
    expect(frames).toHaveLength(1);
    expect(pane.tick(T + 10_075)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 1, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN * 0.75) });
    pane.tick(T + 10_150);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 5, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN * 0.5) });
    expect(pane.tick(T + 10_225)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 9, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN * 0.25) });
    expect(pane.tick(T + 10_300)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 9, color: "#00aa00" });
    now.mockReturnValue(T + 10_300);
    pane.pushLive({ ts: T + 1_500, size: 2, buy: true });
    now.mockReturnValue(T + 10_375);
    pane.pushLive({ ts: T + 1_600, size: 2, buy: true });
    expect(frames).toHaveLength(1);
    expect(pane.tick(T + 10_375)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 10, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN) });
    pane.tick(T + 10_450);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 11.5, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN * 0.75) });
    pane.tick(T + 10_525);
    expect(main.update.mock.calls.at(-1)![0]).toMatchObject({ value: 13 });
    expect(pane.tick(T + 10_700)).toBe(false);
    now.mockReturnValue(T + 11_000);
    pane.render([candle(T - 60_000, 1, 5, 0, 0), candle(T, 2, 13, 1, 4)], [bar(T - 60_000), bar(T)], wider, look);
    expect(pane.tick(T + 11_075)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 11, color: "#00aa00" });
    expect(pane.tick(T + 11_200)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 9, color: "#00aa00" });
    now.mockReturnValue(T + 11_300);
    pane.render([candle(T - 60_000, 1, 5, 0, 0), candle(T, 3, 17, 1, 4)], [bar(T - 60_000), bar(T)], wider, look);
    expect(pane.tick(T + 11_375)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 11, color: "#00aa00" });
    expect(pane.tick(T + 11_450)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 13, color: "#00aa00" });
  });

  it("rests exactly on its target once the ease is over, even where the floating-point step lands a hair off", () => {
    const { pane, main } = liveSetup();
    pane.render([candle(T, 1, 10, 0, 0)], [bar(T)], open, look);
    pane.render([candle(T, 1, 0.3, 0, 0)], [bar(T)], open, look);
    expect(pane.tick(T + 10_000 + LIVE_EASE_MS)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 0.3, color: "#00aa00" });
  });

  it("keeps the live prints on the forming candle's bar when the read it started from is shown again, after a repaint or a change of look", () => {
    const { pane, main, frames, now } = liveSetup();
    pane.render([candle(T, 1, 1, 0, 0)], [bar(T)], open, look);
    const read = [candle(T, 1, 3, 0, 0)];
    pane.render(read, [bar(T)], open, look);
    pane.pushLive({ ts: T + 1_000, size: 2, buy: true });
    now.mockReturnValue(T + 10_300);
    frames[0](0);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 5, color: "#00aa00" });
    expect(frames).toHaveLength(1);
    pane.render(read, [bar(T)], open, { ...look, buyColor: "#00bb00" });
    expect(frames).toHaveLength(2);
    expect(pane.tick(T + 10_300 + LIVE_EASE_MS)).toBe(false);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 5, color: "#00bb00" });
  });

  it("keeps one animation loop when the chart reads again from inside a frame, and leaves the sells alone when that read moved to a new candle", () => {
    const { pane, main, sells, frames } = liveSetup();
    const sides = { ...look, profileView: "sides" as const };
    const read = [candle(T, 1, 3, 1, 1)];
    pane.render(read, [bar(T)], open, sides);
    pane.pushLive({ ts: T + 1_000, size: 2, buy: true });
    expect(frames).toHaveLength(1);
    main.update.mockImplementationOnce(() => pane.render(read, [bar(T)], open, sides));
    frames[0](0);
    expect(frames).toHaveLength(2);
    main.update.mockImplementationOnce(() => pane.render(read, [bar(T), bar(T + 60_000)], { fromTs: T, toTs: T + 120_000, open: true }, sides));
    sells.update.mockClear();
    frames[1](0);
    expect(sells.update).not.toHaveBeenCalled();
    expect(pane.liveCandle).toBe(T + 60_000);
  });

  it("a candle with no big print yet draws nothing until its first print, which starts the bar from zero", () => {
    const { pane, main } = liveSetup();
    pane.render([], [bar(T)], open, look);
    expect(pane.liveCandle).toBe(T);
    expect(pane.tick(T + 10_000)).toBe(false);
    expect(main.update).not.toHaveBeenCalled();
    pane.pushLive({ ts: T + 1_000, size: 4, buy: true });
    expect(pane.tick(T + 10_150)).toBe(true);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 4, color: lighten("#00aa00", LIVE_PULSE_LIGHTEN * 0.5) });
  });

  it("ignores a print outside the forming candle, follows only the newest candle while it is in view, and lets go on a new candle, a closed view or a detach", () => {
    const { pane, main, frames, cancel } = liveSetup();
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], open, look);
    pane.pushLive({ ts: T - 1, size: 4, buy: false });
    pane.pushLive({ ts: T + 60_000, size: 4, buy: false });
    expect(frames).toHaveLength(0);
    expect(pane.tick(T + 10_000)).toBe(false);
    expect(main.update).toHaveBeenCalledTimes(1);
    expect(main.update).toHaveBeenLastCalledWith({ time: T / 1000, value: 3, color: "#00aa00" });
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T), bar(T + 60_000)], { fromTs: T, toTs: T + 120_000, open: true }, look);
    expect(pane.liveCandle).toBe(T + 60_000);
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T), bar(T + 60_000)], { fromTs: T, toTs: T + 60_000, open: true }, look);
    expect(pane.liveCandle).toBeNull();
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], { ...open, open: false }, look);
    expect(pane.liveCandle).toBeNull();
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], null, look);
    expect(pane.liveCandle).toBeNull();
    pane.render([candle(T, 1, 3, 0, 0)], [], open, look);
    expect(pane.liveCandle).toBeNull();
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], open, look);
    pane.pushLive({ ts: T + 1_000, size: 4, buy: false });
    expect(frames).toHaveLength(1);
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T), bar(T + 60_000)], { fromTs: T, toTs: T + 120_000, open: true }, look);
    expect(cancel).toHaveBeenCalledTimes(1);
    pane.pushLive({ ts: T + 61_000, size: 4, buy: false });
    pane.detach();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(pane.liveCandle).toBeNull();
    pane.pushLive({ ts: T + 61_000, size: 4, buy: false });
    expect(pane.tick(T + 10_000)).toBe(false);
    expect(main.update).toHaveBeenCalledTimes(1);
  });

  it("without animation frames draws each print at once", () => {
    const { pane, main } = liveSetup();
    vi.stubGlobal("requestAnimationFrame", undefined);
    pane.render([candle(T, 1, 3, 0, 0)], [bar(T)], open, look);
    pane.pushLive({ ts: T + 1_000, size: 4, buy: false });
    expect(main.update).toHaveBeenCalledTimes(1);
  });
});
