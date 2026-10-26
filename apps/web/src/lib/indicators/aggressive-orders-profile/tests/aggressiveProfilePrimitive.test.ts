// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeriesAttachedParameter, Time } from "lightweight-charts";
import type { BarFrame, LiquidityFrame, LiquidityPrint } from "../../../../types/frames";
import { LiquidityGrid } from "../../passive-liquidity/liquidityGrid";
import { AggressiveProfilePrimitive, visibleRangeOf } from "../aggressiveProfilePrimitive";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS } from "../aggressiveProfileSettings";
import { AggressiveProfileSource, READ_SETTLE_MS } from "../aggressiveProfileSource";

const T = 1_700_000_000_000;

function print(ts: number, side: "buy" | "sell", size: number, price: number): LiquidityPrint {
  return { ts, price, size, side, id: null };
}

function frame(ts: number, seq: number, reset: boolean, prints: LiquidityPrint[]): LiquidityFrame {
  return { type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts, seq, reset, row_width: 2, column_ms: 1_000, columns: [{ ts, lo: 100, hi: 107, bid: [[0, 1]], ask: [[5, 4]], prints, prints_floor: 1 }] };
}

const bar: BarFrame = {
  type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", interval_ms: 60_000, ts_open: T,
  open: 208, high: 210, low: 206, close: 208, volume: 1, trade_count: null, closed: true,
};

function fakeChart(visible: { from: number; to: number } | null, requestUpdate: () => void) {
  const timeScale = { getVisibleRange: () => visible };
  return { chart: { timeScale: () => timeScale }, series: {}, requestUpdate } as unknown as SeriesAttachedParameter<Time>;
}

const candle = (tsOpen: number, buyCount: number, buyVolume: number, sellCount: number, sellVolume: number) => ({ tsOpen, delta: buyVolume - sellVolume, buyCount, buyVolume, sellCount, sellVolume });

describe("visibleRangeOf", () => {
  it("runs from the first visible bar's open to the last visible bar's close, clamped to the bars on the chart, and is open while the newest candle is in view", () => {
    expect(visibleRangeOf({ from: T / 1000 + 30, to: T / 1000 + 600 }, [bar])).toEqual({ fromTs: T + 30_000, toTs: T + 60_000, open: true });
    expect(visibleRangeOf({ from: T / 1000, to: T / 1000 + 30 }, [bar, { ...bar, ts_open: T + 60_000 }])).toEqual({ fromTs: T, toTs: T + 90_000, open: false });
    expect(visibleRangeOf({ from: T / 1000, to: T / 1000 + 60 }, [bar, { ...bar, ts_open: T + 60_000 }])).toEqual({ fromTs: T, toTs: T + 120_000, open: true });
    expect(visibleRangeOf({ from: T / 1000 - 600, to: T / 1000 + 60 }, [bar])).toEqual({ fromTs: T, toTs: T + 60_000, open: true });
    expect(visibleRangeOf({ from: T / 1000 - 600, to: T / 1000 - 1 }, [bar])).toBeNull();
    expect(visibleRangeOf(null, [bar])).toBeNull();
    expect(visibleRangeOf({ from: T / 1000, to: T / 1000 + 60 }, [])).toBeNull();
  });
});

describe("the aggressive orders profile reader on the price series", () => {
  let primitive: AggressiveProfilePrimitive | null = null;
  let now: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    primitive?.detached();
    primitive = null;
    now?.mockRestore();
    now = null;
    vi.useRealTimers();
  });

  function setup({ visible = { from: T / 1000 - 600, to: T / 1000 + 60 } as { from: number; to: number } | null, requestUpdate = (() => {}) as () => void, bars = [bar] } = {}) {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    const grid = new LiquidityGrid();
    grid.apply(frame(T + 1_000, 1, true, [print(T + 100, "buy", 4, 201), print(T + 200, "sell", 6, 210)]));
    const source = new AggressiveProfileSource(grid);
    const onRead = vi.fn();
    primitive = new AggressiveProfilePrimitive(() => bars);
    primitive.onRead = onRead;
    primitive.attached(fakeChart(visible, requestUpdate));
    primitive.setSource(source);
    return { grid, source, onRead };
  }

  it("reads the big prints of the candles on screen through its source and reports them once, with the range and its settings, drawing nothing itself", () => {
    const { onRead } = setup();
    expect(primitive!.paneViews()).toEqual([]);
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenLastCalledWith([candle(T, 1, 4, 1, 6)], { fromTs: T, toTs: T + 60_000, open: true }, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
    expect(primitive!.range).toEqual({ fromTs: T, toTs: T + 60_000, open: true });
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it("keeps the last read while the inputs move and comes back on its own once they have stood still for READ_SETTLE_MS", () => {
    vi.useFakeTimers();
    const requestUpdate = vi.fn();
    const { grid, source, onRead } = setup({ requestUpdate });
    primitive!.updateAllViews();
    grid.apply(frame(T + 2_000, 2, false, [print(T + 1_500, "sell", 20, 211)]));
    now!.mockReturnValue(T + 600);
    requestUpdate.mockClear();
    primitive!.updateAllViews();
    now!.mockReturnValue(T + 700);
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(source.settleAt).toBe(T + 600 + READ_SETTLE_MS);
    expect(requestUpdate).not.toHaveBeenCalled();
    now!.mockReturnValue(T + 600 + READ_SETTLE_MS);
    vi.advanceTimersByTime(READ_SETTLE_MS);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenCalledTimes(2);
    expect(onRead).toHaveBeenLastCalledWith([candle(T, 1, 4, 2, 26)], { fromTs: T, toTs: T + 60_000, open: true }, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
    primitive!.repaint();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    primitive!.detached();
    expect(vi.getTimerCount()).toBe(0);
    expect(onRead).toHaveBeenLastCalledWith(null, null, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
  });

  it("drops a pending come-back when it is detached", () => {
    vi.useFakeTimers();
    const requestUpdate = vi.fn();
    const { grid } = setup({ requestUpdate });
    primitive!.updateAllViews();
    grid.apply(frame(T + 2_000, 2, false, [print(T + 1_500, "sell", 20, 211)]));
    now!.mockReturnValue(T + 600);
    primitive!.updateAllViews();
    primitive!.detached();
    expect(vi.getTimerCount()).toBe(0);
    requestUpdate.mockClear();
    vi.advanceTimersByTime(READ_SETTLE_MS);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("a scroll that comes back before the wait is over reads nothing new and gives up its come-back", () => {
    vi.useFakeTimers();
    const requestUpdate = vi.fn();
    const visible = { from: T / 1000 - 600, to: T / 1000 + 60 };
    const { source, onRead } = setup({ visible, requestUpdate });
    primitive!.updateAllViews();
    const version = source.version;
    visible.from = T / 1000 + 10;
    primitive!.updateAllViews();
    expect(source.settleAt).toBe(T + 500 + READ_SETTLE_MS);
    visible.from = T / 1000 - 600;
    primitive!.updateAllViews();
    expect(source.settleAt).toBeNull();
    requestUpdate.mockClear();
    vi.advanceTimersByTime(READ_SETTLE_MS);
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(source.version).toBe(version);
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it("reads at the floor set by hand, leaving out the prints under it", () => {
    const { onRead } = setup();
    primitive!.setSettings({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 5 });
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenLastCalledWith([candle(T, 0, 0, 1, 6)], { fromTs: T, toTs: T + 60_000, open: true }, { ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 5 });
  });

  it("clamps the range to the bars on the chart, and with nothing in view reports nothing", () => {
    const visible = { from: T / 1000 + 30, to: T / 1000 + 600 };
    const first = setup({ visible });
    primitive!.updateAllViews();
    expect(primitive!.range).toEqual({ fromTs: T + 30_000, toTs: T + 60_000, open: true });
    expect(first.onRead).toHaveBeenLastCalledWith([], { fromTs: T + 30_000, toTs: T + 60_000, open: true }, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
    visible.from = T / 1000 - 600;
    visible.to = T / 1000 - 1;
    primitive!.updateAllViews();
    expect(primitive!.range).toBeNull();
    expect(first.onRead).toHaveBeenCalledTimes(2);
    expect(first.onRead).toHaveBeenLastCalledWith(null, null, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
    primitive!.detached();
    const away = setup({ visible: { from: T / 1000 - 600, to: T / 1000 - 1 } });
    primitive!.updateAllViews();
    expect(primitive!.range).toBeNull();
    expect(away.onRead).not.toHaveBeenCalled();
    primitive!.detached();
    const none = setup({ visible: null });
    primitive!.updateAllViews();
    expect(primitive!.range).toBeNull();
    expect(none.onRead).not.toHaveBeenCalled();
  });

  it("starts over when its source changes, and reports the same read again when its settings change or a repaint is asked", () => {
    const requestUpdate = vi.fn();
    const { source, onRead } = setup({ requestUpdate });
    primitive!.updateAllViews();
    const read = onRead.mock.calls[0][0];
    primitive!.setSource(null);
    expect(primitive!.source).toBeNull();
    expect(primitive!.range).toBeNull();
    expect(onRead).toHaveBeenLastCalledWith(null, null, DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
    expect(onRead).toHaveBeenCalledTimes(2);
    primitive!.setSource(source);
    expect(primitive!.source).toBe(source);
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenCalledTimes(3);
    expect(onRead.mock.calls[2][0]).toBe(read);
    primitive!.setSource(source);
    expect(onRead).toHaveBeenCalledTimes(3);
    expect(primitive!.range).not.toBeNull();
    const coloured = { ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, buyColor: "#123456" };
    requestUpdate.mockClear();
    primitive!.setSettings(coloured);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(primitive!.settings).toEqual(coloured);
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenCalledTimes(4);
    expect(onRead).toHaveBeenLastCalledWith(read, { fromTs: T, toTs: T + 60_000, open: true }, coloured);
    primitive!.repaint();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenCalledTimes(5);
    primitive!.updateAllViews();
    expect(onRead).toHaveBeenCalledTimes(5);
  });
});
