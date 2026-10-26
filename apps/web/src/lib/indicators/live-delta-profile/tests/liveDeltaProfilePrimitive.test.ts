// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeriesAttachedParameter, Time } from "lightweight-charts";
import type { BarFrame } from "../../../../types/frames";
import { CandleDeltaSource, type DeltaSource } from "../candleDeltaSource";
import { EDGE_GAP_PX, LiveDeltaProfilePrimitive, MARKER_ARROW_PX, MARKER_GAP_PX, NEIGHBOUR_GAP_PX } from "../liveDeltaProfilePrimitive";
import { DEFAULT_LIVE_DELTA_PROFILE_SETTINGS } from "../liveDeltaProfileSettings";

function fakeChart() {
  const options = { rightOffset: 0, barSpacing: 10 };
  const applied: number[] = [];
  const timeScale = {
    options: () => options,
    width: () => 1_000,
    applyOptions: (next: { rightOffset: number }) => {
      applied.push(next.rightOffset);
      options.rightOffset = next.rightOffset;
    },
    scrollPosition: () => options.rightOffset,
  };
  const param = { chart: { timeScale: () => timeScale }, series: {}, requestUpdate: () => {} } as unknown as SeriesAttachedParameter<Time>;
  return { param, applied };
}

describe("the room the profile keeps beside the axis", () => {
  let primitive: LiveDeltaProfilePrimitive | null = null;

  afterEach(() => {
    primitive?.detached();
    primitive = null;
  });

  it("puts its right offset back after the chart was fitted to every candle, even though the option still reads the same", () => {
    const { param, applied } = fakeChart();
    primitive = new LiveDeltaProfilePrimitive(() => []);
    primitive.attached(param);
    primitive.setStore(new CandleDeltaSource(1, () => null));
    const room = applied.at(-1);
    expect(room).toBeGreaterThan(0);
    const before = applied.length;
    primitive.restoreRoom();
    expect(applied.length).toBe(before + 1);
    expect(applied.at(-1)).toBe(room);
  });

  it("leaves the chart alone when the profile is off", () => {
    const { param, applied } = fakeChart();
    primitive = new LiveDeltaProfilePrimitive(() => []);
    primitive.attached(param);
    const before = applied.length;
    primitive.restoreRoom();
    expect(applied.length).toBe(before);
  });
});

describe("the status log follows the store", () => {
  let primitive: LiveDeltaProfilePrimitive | null = null;

  afterEach(() => {
    primitive?.detached();
    primitive = null;
  });

  it("says where a new store stands even when the last store stood in the same place", () => {
    const timeScale = { options: () => ({ rightOffset: 0, barSpacing: 10 }), width: () => 1_000, applyOptions: () => {}, scrollPosition: () => 0, timeToIndex: () => 5, logicalToCoordinate: () => 600 };
    const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }), options: () => ({ layout: {} }) };
    const series = { priceToCoordinate: (price: number) => 500 - price * 10, data: () => [{ time: 5 }] };
    const param = { chart, series, requestUpdate: () => {} } as unknown as SeriesAttachedParameter<Time>;
    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((message: unknown) => { lines.push(String(message)); });
    const busy = (): DeltaSource => ({ rowWidth: 1, version: 0, lastIndex: null, recent: [], issue: "OVERLOADED", complete: false, pieces: [], rows: () => [] });
    try {
      const bar: BarFrame = {
        type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open: 0,
        open: 10, high: 11, low: 9, close: 10, volume: 1, trade_count: null, closed: true,
      };
      primitive = new LiveDeltaProfilePrimitive(() => [bar]);
      primitive.attached(param);
      primitive.setStore(busy());
      primitive.updateAllViews();
      primitive.updateAllViews();
      expect(lines).toEqual(["Live Delta Profile: history busy, retrying"]);
      primitive.setStore(busy());
      primitive.updateAllViews();
      expect(lines).toEqual(["Live Delta Profile: history busy, retrying", "Live Delta Profile: history busy, retrying"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("an indicator drawn against the axis", () => {
  let primitive: LiveDeltaProfilePrimitive | null = null;
  const frame = { bars: [], widths: new Map(), flash: new Map(), lastIndex: null, candleRight: 600, barSpacing: 10, intervalMs: 60_000, right: 900, reach: 150, rowPx: 10, width: 1_000, height: 500 };

  afterEach(() => {
    primitive?.detached();
    primitive = null;
  });

  it("gets more room kept beside the axis, and its width follows the pane", () => {
    const { param, applied } = fakeChart();
    primitive = new LiveDeltaProfilePrimitive(() => []);
    primitive.attached(param);
    primitive.setStore(new CandleDeltaSource(1, () => null));
    const alone = applied.at(-1) ?? 0;
    primitive.setNeighbour({ widthPx: (paneWidth) => paneWidth * 0.14, resize: () => {} });
    const marginPx = DEFAULT_LIVE_DELTA_PROFILE_SETTINGS.widthShare * 1_000 + 140 + NEIGHBOUR_GAP_PX + EDGE_GAP_PX + NEIGHBOUR_GAP_PX + MARKER_GAP_PX + MARKER_ARROW_PX;
    expect(applied.at(-1)).toBe(Math.ceil(marginPx / 10));
    expect(applied.at(-1)).toBeGreaterThan(alone);
  });

  it("makes the base line a handle that asks the neighbour for the width the drag points at", () => {
    const { param } = fakeChart();
    primitive = new LiveDeltaProfilePrimitive(() => []);
    primitive.attached(param);
    primitive.frame = frame;
    expect(primitive.baseHandleAt(900, 10)).toBe(false);
    const asked: [number, number][] = [];
    primitive.setNeighbour({ widthPx: () => 140, resize: (widthPx, paneWidth) => asked.push([widthPx, paneWidth]) });
    expect(primitive.baseHandleAt(900, 10)).toBe(true);
    primitive.resizeNeighbour(800);
    expect(asked).toEqual([[1_000 - EDGE_GAP_PX - NEIGHBOUR_GAP_PX - 800, 1_000]]);
    primitive.setNeighbour(null);
    primitive.resizeNeighbour(700);
    expect(asked.length).toBe(1);
  });
});
