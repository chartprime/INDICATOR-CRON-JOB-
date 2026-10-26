import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../types/frames";
import { barToCandleCloseTimerState, CandleCloseTimerPrimitive } from "../candleCloseTimerPrimitive";

function makeBar(overrides: Partial<BarFrame> = {}): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open: 960_000,
    open: 100, high: 105, low: 95, close: 102, volume: 10, trade_count: 4, closed: false,
    ...overrides,
  } as BarFrame;
}

describe("barToCandleCloseTimerState", () => {
  it("returns null when there is no bar", () => {
    expect(barToCandleCloseTimerState(null, 1_000_000)).toBeNull();
  });

  it("derives closeAtMs from ts_open + interval_ms for an open bar", () => {
    const state = barToCandleCloseTimerState(makeBar({ ts_open: 960_000, interval_ms: 60_000, closed: false }), 1_000_000);
    expect(state).toEqual({ price: 102, closeAtMs: 1_020_000, nowMs: 1_000_000, up: true });
  });

  it("reports closeAtMs as null once the bar has closed -- no countdown row for a closed bar", () => {
    const state = barToCandleCloseTimerState(makeBar({ closed: true }), 1_000_000);
    expect(state?.closeAtMs).toBeNull();
  });

  it("classifies up/down from close vs open, treating an unchanged close as up", () => {
    expect(barToCandleCloseTimerState(makeBar({ open: 100, close: 101 }), 0)?.up).toBe(true);
    expect(barToCandleCloseTimerState(makeBar({ open: 100, close: 100 }), 0)?.up).toBe(true);
    expect(barToCandleCloseTimerState(makeBar({ open: 100, close: 99 }), 0)?.up).toBe(false);
  });
});

function attach(primitive: CandleCloseTimerPrimitive) {
  const requestUpdate = vi.fn();
  primitive.attached({
    series: {
      priceToCoordinate: (price: number) => price * 2,
      priceFormatter: () => ({ format: (price: number) => price.toFixed(2) }),
    },
    requestUpdate,
  } as never);
  return requestUpdate;
}

describe("CandleCloseTimerPrimitive", () => {
  it("shows only a price row while the bar is closed (no closeAtMs)", () => {
    const primitive = new CandleCloseTimerPrimitive();
    const requestUpdate = attach(primitive);

    primitive.setState({ price: 77_838, closeAtMs: null, nowMs: 1_000_000, up: true });
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    primitive.updateAllViews();

    const views = primitive.priceAxisViews();
    expect(views).toHaveLength(1);
    expect(views[0].text()).toBe("77838.00");
    expect(views[0].fixedCoordinate?.()).toBe(155_676);
    expect(views[0].backColor()).toBe("#f8f8f5");
    expect(views[0].textColor()).toBe("#111111");
  });

  it("shows a price row and a countdown row, stacked, while the bar is open", () => {
    const primitive = new CandleCloseTimerPrimitive();
    attach(primitive);

    primitive.setState({ price: 77_838, closeAtMs: 1_020_000, nowMs: 1_000_000, up: true });
    primitive.updateAllViews();

    const views = primitive.priceAxisViews();
    expect(views).toHaveLength(2);
    expect(views[0].text()).toBe("77838.00");
    expect(views[1].text()).toBe("0:20");
    const priceY = views[0].fixedCoordinate?.();
    const countdownY = views[1].fixedCoordinate?.();
    expect(countdownY).toBeGreaterThan(priceY!);
    expect(countdownY! - priceY!).toBe(15);
  });

  it("uses down colors when the bar closed lower, and dims the countdown row relative to the price row", () => {
    const primitive = new CandleCloseTimerPrimitive();
    attach(primitive);

    primitive.setState({ price: 77_838, closeAtMs: 1_020_000, nowMs: 1_000_000, up: false });
    primitive.updateAllViews();

    const views = primitive.priceAxisViews();
    expect(views[0].backColor()).toBe("#111111");
    expect(views[1].backColor()).toBe("#111111");
    expect(views[0].textColor()).toBe("#f8f8f5");
    expect(views[1].textColor()).toBe("rgba(248, 248, 245, 0.55)");
  });

  it("recomputes the countdown text on each updateAllViews call as nowMs advances, without a new setState", () => {
    const primitive = new CandleCloseTimerPrimitive();
    attach(primitive);
    primitive.setState({ price: 77_838, closeAtMs: 1_020_000, nowMs: 1_000_000, up: true });
    primitive.updateAllViews();
    expect(primitive.priceAxisViews()[1].text()).toBe("0:20");

    primitive.setState({ price: 77_838, closeAtMs: 1_020_000, nowMs: 1_015_000, up: true });
    primitive.updateAllViews();
    expect(primitive.priceAxisViews()[1].text()).toBe("0:05");
  });

  it("clears an already-rendered tag once setState(null) is called -- the real path taken when a symbol switch clears the chart", () => {
    const primitive = new CandleCloseTimerPrimitive();
    attach(primitive);
    primitive.setState({ price: 77_838, closeAtMs: 1_020_000, nowMs: 1_000_000, up: true });
    primitive.updateAllViews();
    expect(primitive.priceAxisViews()).toHaveLength(2);

    primitive.setState(null);
    primitive.updateAllViews();
    expect(primitive.priceAxisViews()).toEqual([]);
  });

  it("renders nothing when there is no state, or when the series cannot resolve a coordinate for the price", () => {
    const primitive = new CandleCloseTimerPrimitive();
    attach(primitive);
    primitive.updateAllViews();
    expect(primitive.priceAxisViews()).toEqual([]);

    const unresolvable = new CandleCloseTimerPrimitive();
    unresolvable.attached({
      series: { priceToCoordinate: () => null, priceFormatter: () => ({ format: () => "" }) },
      requestUpdate: vi.fn(),
    } as never);
    unresolvable.setState({ price: 77_838, closeAtMs: null, nowMs: 1_000_000, up: true });
    unresolvable.updateAllViews();
    expect(unresolvable.priceAxisViews()).toEqual([]);
  });

  it("clears state and stops rendering once detached", () => {
    const primitive = new CandleCloseTimerPrimitive();
    attach(primitive);
    primitive.setState({ price: 77_838, closeAtMs: null, nowMs: 1_000_000, up: true });
    primitive.updateAllViews();
    expect(primitive.priceAxisViews()).toHaveLength(1);

    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.priceAxisViews()).toEqual([]);
  });
});
