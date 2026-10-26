import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayBars } from "../../../chart/replayBars";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { resetStreamCreationGuardForTests, withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import {
  LARGE_TRADE_BUBBLES_LOOKBACK,
  LARGE_TRADE_BUBBLES_MAX_MARKERS_PER_BAR,
  largeTradeBubblesIndicator,
  type LargeTradeBubblesState,
} from "../largeTradeBubbles";
import type { BarFrame, Side, TradeFrame } from "../../../../types/frames";
import type { IndicatorBarCtx, TradeAvailability } from "../../../chart/indicatorTypes";

beforeEach(() => {
  resetStreamCreationGuardForTests();
});

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

function bar(ts_open: number, overrides: Partial<BarFrame> = {}): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open,
    open: 100, high: 100, low: 100, close: 100, volume: 1, trade_count: 1, closed: true,
    ...overrides,
  } as BarFrame;
}

function trade(ts_exchange: number, price: number, size: number, side: Side = "buy"): TradeFrame {
  return {
    type: "trade", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", ts_exchange,
    price, size, side, trade_id: `t-${ts_exchange}`,
  } as TradeFrame;
}

function ctxOf(
  state: LargeTradeBubblesState,
  nextBar: BarFrame,
  trades: readonly TradeFrame[],
  replace: boolean,
  multiplier = 3,
  tradeAvailability: TradeAvailability = "LIVE_COMPLETE",
): IndicatorBarCtx<LargeTradeBubblesState, { multiplier: number }> {
  return {
    bar: nextBar,
    trades,
    tradeAvailability,
    state,
    settings: { multiplier },
    replace,
    replaying: false,
    ta: {},
    draw: { fill: () => {} },
    markers: { plotshape: () => {}, plotchar: () => {} },
    pane: { paneIndex: 0 },
  } as IndicatorBarCtx<LargeTradeBubblesState, { multiplier: number }>;
}

function warmedState(multiplier = 3): LargeTradeBubblesState {
  const state = withStreamCreationWindow(() => largeTradeBubblesIndicator.createState({ multiplier }));
  for (let index = 0; index < LARGE_TRADE_BUBBLES_LOOKBACK; index += 1) {
    largeTradeBubblesIndicator.onBar(ctxOf(state, bar(index * 60_000), [trade(index * 60_000, 100, 1)], false, multiplier));
  }
  return state;
}

describe("largeTradeBubblesIndicator", () => {
  it("does not emit price-series outputs or historical bubbles", () => {
    const bars = Array.from({ length: 30 }, (_, index) => bar(index * 60_000));
    expect(largeTradeBubblesIndicator.lines).toEqual([]);
    expect(replayBars(largeTradeBubblesIndicator, bars, { multiplier: 3 }).perBar).toEqual({});
  });

  it("requires a complete observed baseline before drawing a price-anchored bubble", () => {
    const state = warmedState();
    const plotshape = vi.fn();
    const ctx = ctxOf(state, bar(20 * 60_000), [trade(20 * 60_000, 12_345, 500)], false);
    ctx.markers.plotshape = plotshape;

    largeTradeBubblesIndicator.onBar(ctx);

    expect(plotshape).toHaveBeenCalledTimes(1);
    expect(plotshape.mock.calls[0][0]).toMatchObject({
      shape: "circle",
      position: "atPriceMiddle",
      price: 12_345,
      color: "#22c55e",
      text: "$6,172,500",
    });
  });

  it("uses sell styling for sell-side prints", () => {
    const state = warmedState();
    const plotshape = vi.fn();
    const ctx = ctxOf(state, bar(20 * 60_000), [trade(20 * 60_000, 100, 500, "sell")], false);
    ctx.markers.plotshape = plotshape;

    largeTradeBubblesIndicator.onBar(ctx);

    expect(plotshape.mock.calls[0][0]).toMatchObject({ color: "#ef4444" });
  });

  it("uses contracts rather than false dollar notional for dxFeed futures", () => {
    const state = warmedState();
    const plotshape = vi.fn();
    const futureBar = bar(20 * 60_000, {
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
    } as Partial<BarFrame>);
    const futureTrade = {
      type: "trade",
      symbol: "/NQU26:XCME",
      provider: "DXFEED",
      assetClass: "FUTURE",
      ts_exchange: 20 * 60_000,
      price: 20_000,
      size: 500,
      side: "buy",
      trade_id: "nq-1",
    } as TradeFrame;
    const ctx = ctxOf(state, futureBar, [futureTrade], false);
    ctx.markers.plotshape = plotshape;

    largeTradeBubblesIndicator.onBar(ctx);

    expect(plotshape.mock.calls[0][0]).toMatchObject({ price: 20_000, text: "500 ct" });
  });

  it("caps a busy bar to its largest qualifying prints", () => {
    const state = warmedState();
    const plotshape = vi.fn();
    const trades = Array.from(
      { length: LARGE_TRADE_BUBBLES_MAX_MARKERS_PER_BAR + 25 },
      (_, index) => trade(20 * 60_000 + index, 1_000 + index, 1),
    );
    const ctx = ctxOf(state, bar(20 * 60_000), trades, false);
    ctx.markers.plotshape = plotshape;

    largeTradeBubblesIndicator.onBar(ctx);

    expect(plotshape).toHaveBeenCalledTimes(LARGE_TRADE_BUBBLES_MAX_MARKERS_PER_BAR);
    expect(plotshape.mock.calls[0][0]).toMatchObject({ price: 1_025 });
    expect(plotshape.mock.calls.at(-1)?.[0]).toMatchObject({ price: 1_074 });
  });

  it("uses a robust baseline so one extreme closed bar does not suppress the next signal", () => {
    const state = warmedState();
    largeTradeBubblesIndicator.onBar(ctxOf(state, bar(20 * 60_000), [trade(20 * 60_000, 100_000, 1)], false));
    const plotshape = vi.fn();
    const ctx = ctxOf(state, bar(21 * 60_000), [trade(21 * 60_000, 200, 1)], false);
    ctx.markers.plotshape = plotshape;

    largeTradeBubblesIndicator.onBar(ctx);

    expect(plotshape).toHaveBeenCalledTimes(1);
  });

  it("applies a live-only multiplier adjustment without losing the observed baseline", () => {
    const state = withStreamCreationWindow(() => largeTradeBubblesIndicator.createState({ multiplier: 3 }));
    for (let index = 0; index < LARGE_TRADE_BUBBLES_LOOKBACK; index += 1) {
      const price = index % 2 === 0 ? 90 : 110;
      largeTradeBubblesIndicator.onBar(ctxOf(state, bar(index * 60_000), [trade(index * 60_000, price, 1)], false));
    }
    const strictPlotshape = vi.fn();
    const strictCtx = ctxOf(state, bar(20 * 60_000, { closed: false }), [trade(20 * 60_000, 120, 1)], false, 3);
    strictCtx.markers.plotshape = strictPlotshape;
    largeTradeBubblesIndicator.onBar(strictCtx);

    const relaxedPlotshape = vi.fn();
    const relaxedCtx = ctxOf(state, bar(20 * 60_000, { closed: false }), [trade(20 * 60_000, 120, 1)], true, 1);
    relaxedCtx.markers.plotshape = relaxedPlotshape;
    largeTradeBubblesIndicator.onBar(relaxedCtx);

    expect(strictPlotshape).not.toHaveBeenCalled();
    expect(relaxedPlotshape).toHaveBeenCalledTimes(1);
    expect(state.baselineSamples).toHaveLength(LARGE_TRADE_BUBBLES_LOOKBACK);
  });

  it("does not create a baseline or bubble from incomplete evidence", () => {
    const state = withStreamCreationWindow(() => largeTradeBubblesIndicator.createState({ multiplier: 3 }));
    const plotshape = vi.fn();
    const ctx = ctxOf(state, bar(0), [trade(0, 100, 500)], false, 3, "LIVE_PARTIAL");
    ctx.markers.plotshape = plotshape;

    largeTradeBubblesIndicator.onBar(ctx);

    expect(plotshape).not.toHaveBeenCalled();
    expect(state.baselineSamples).toEqual([]);
    expect(state.maxMagnitudeThisBar).toBeNull();
  });
});
