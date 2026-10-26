import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import type { PlotShapeOptions } from "../../../chart/draw/markers";
import {
  resetStreamCreationGuardForTests,
  withStreamCreationWindow,
} from "../../../chart/ta/creationGuard";
import {
  pivotPointsIndicator,
  type PivotPointsSettings,
  type PivotPointsState,
} from "../pivotPoints";

beforeEach(() => {
  resetStreamCreationGuardForTests();
});

function bar(
  index: number,
  high: number,
  low: number,
  closed = true,
): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open: index * 60_000,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 1,
    trade_count: 1,
    closed,
  } as BarFrame;
}

function context(
  state: PivotPointsState,
  nextBar: BarFrame,
  settings: PivotPointsSettings,
  plotshape: (options: PlotShapeOptions) => void,
  replace = false,
): IndicatorBarCtx<PivotPointsState, PivotPointsSettings> {
  return {
    bar: nextBar,
    trades: [],
    tradeAvailability: "HISTORICAL_UNAVAILABLE",
    state,
    settings,
    replace,
    replaying: false,
    ta: {},
    draw: { fill: () => {} },
    markers: { plotshape, plotchar: () => {} },
    pane: { paneIndex: 0 },
  };
}

function makeState(settings: PivotPointsSettings): PivotPointsState {
  return withStreamCreationWindow(() =>
    pivotPointsIndicator.createState(settings),
  );
}

describe("pivotPointsIndicator", () => {
  it("is markers-only and plots confirmed high and low arrows on the candidate bars", () => {
    const settings = {
      leftBars: 1,
      rightBars: 1,
      upperColor: "red" as const,
      lowerColor: "green" as const,
    };
    const state = makeState(settings);
    const plotshape = vi.fn<(options: PlotShapeOptions) => void>();

    for (const [index, high, low] of [
      [0, 2, 5],
      [1, 5, 1],
      [2, 3, 4],
    ]) {
      pivotPointsIndicator.onBar(
        context(state, bar(index, high, low), settings, plotshape),
      );
    }

    expect(pivotPointsIndicator.lines).toEqual([]);
    expect(plotshape).toHaveBeenCalledTimes(2);
    expect(plotshape.mock.calls).toEqual([
      [
        {
          time: 60_000,
          shape: "arrowDown",
          position: "aboveBar",
          color: "#dc2626",
          price: 5,
        },
      ],
      [
        {
          time: 60_000,
          shape: "arrowUp",
          position: "belowBar",
          color: "#16a34a",
          price: 1,
        },
      ],
    ]);
  });

  it("does not emit markers from an open confirmation bar", () => {
    const settings = {
      leftBars: 1,
      rightBars: 1,
      upperColor: "red" as const,
      lowerColor: "green" as const,
    };
    const state = makeState(settings);
    const plotshape = vi.fn<(options: PlotShapeOptions) => void>();
    pivotPointsIndicator.onBar(
      context(state, bar(0, 2, 5), settings, plotshape),
    );
    pivotPointsIndicator.onBar(
      context(state, bar(1, 5, 1), settings, plotshape),
    );
    pivotPointsIndicator.onBar(
      context(state, bar(2, 3, 4, false), settings, plotshape),
    );
    expect(plotshape).not.toHaveBeenCalled();
  });

  it("uses the final replacement value before confirming a pivot", () => {
    const settings = {
      leftBars: 1,
      rightBars: 1,
      upperColor: "red" as const,
      lowerColor: "green" as const,
    };
    const state = makeState(settings);
    const plotshape = vi.fn<(options: PlotShapeOptions) => void>();
    pivotPointsIndicator.onBar(
      context(state, bar(0, 2, 5), settings, plotshape),
    );
    pivotPointsIndicator.onBar(
      context(state, bar(1, 5, 1), settings, plotshape),
    );
    pivotPointsIndicator.onBar(
      context(state, bar(2, 4, 4, false), settings, plotshape),
    );
    pivotPointsIndicator.onBar(
      context(state, bar(2, 3, 4), settings, plotshape, true),
    );
    expect(plotshape).toHaveBeenCalledTimes(2);
    expect(plotshape.mock.calls[0][0]).toMatchObject({
      time: 60_000,
      price: 5,
    });
  });

  it("uses the configured colors independently for upper and lower markers", () => {
    const settings = {
      leftBars: 1,
      rightBars: 1,
      upperColor: "blue" as const,
      lowerColor: "orange" as const,
    };
    const state = makeState(settings);
    const plotshape = vi.fn<(options: PlotShapeOptions) => void>();
    for (const [index, high, low] of [
      [0, 2, 5],
      [1, 5, 1],
      [2, 3, 4],
    ]) {
      pivotPointsIndicator.onBar(
        context(state, bar(index, high, low), settings, plotshape),
      );
    }

    expect(plotshape.mock.calls[0][0]).toMatchObject({ color: "#2563eb" });
    expect(plotshape.mock.calls[1][0]).toMatchObject({ color: "#ea580c" });
  });
});
