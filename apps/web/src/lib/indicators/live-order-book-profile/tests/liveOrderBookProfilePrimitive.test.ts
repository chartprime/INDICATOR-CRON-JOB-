// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SeriesAttachedParameter, Time } from "lightweight-charts";
import type { BarFrame, BookFrame, LiquidityFrame } from "../../../../types/frames";
import { EDGE_GAP_PX, MARKER_ARROW_PX, MARKER_GAP_PX, NEIGHBOUR_GAP_PX } from "../../axis-profile/axisProfilePrimitive";
import { LABEL_CHAR_EM, LABEL_PAD_PX } from "../../live-delta-profile/deltaProfileLayout";
import { LiquidityGrid } from "../../passive-liquidity/liquidityGrid";
import { BOOK_STALE_MS, BookProfileSource } from "../bookProfileSource";
import { bookStubPx } from "../bookProfileLayout";
import { BAR_EDGE_GAP_PX, BOOK_SPINE_PX, LABEL_INSET_PX, LiveOrderBookProfilePrimitive, RESTING_FONT_PX, RESTING_LABEL_PAD_PX, RESTING_REACH_MS } from "../liveOrderBookProfilePrimitive";
import { RESTING_APPEAR_MS, RESTING_FADE_MS, RESTING_FLASH_MS } from "../restingOrderLayout";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS } from "../liveOrderBookProfileSettings";

const T = 1_700_000_000_000;

function frame(ts: number, seq: number, reset: boolean): LiquidityFrame {
  return {
    type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts, seq, reset, row_width: 2, column_ms: 1_000,
    columns: [{ ts, lo: 100, hi: 107, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2.4]] }],
  };
}

const bar: BarFrame = {
  type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", interval_ms: 60_000, ts_open: T,
  open: 208, high: 210, low: 206, close: 208, volume: 1, trade_count: null, closed: true,
};

function fakeChart(candleX = 600, pxPerPrice = 4, top = 1_000, xOfLogical: (logical: number) => number = () => candleX, barSpacing = 10) {
  const options = { rightOffset: 0, barSpacing };
  const timeScale = {
    options: () => options,
    width: () => 1_000,
    applyOptions: (next: { rightOffset: number }) => { options.rightOffset = next.rightOffset; },
    scrollPosition: () => options.rightOffset,
    timeToIndex: () => 5,
    logicalToCoordinate: (logical: number) => (Number.isInteger(logical) ? xOfLogical(logical) : 0),
  };
  const series = { priceToCoordinate: (price: number) => top - price * pxPerPrice, data: () => [{ time: 5 }] };
  const chart = { timeScale: () => timeScale, paneSize: () => ({ height: 500 }), options: () => ({ layout: { fontFamily: "Inter", background: { type: "solid", color: "#101010" } } }) };
  return { chart: { timeScale: () => timeScale, paneSize: () => ({ height: 500 }), options: chart.options }, series, requestUpdate: () => {} } as unknown as SeriesAttachedParameter<Time>;
}

function fakeContext() {
  const calls: unknown[][] = [];
  const context = new Proxy({} as Record<string, unknown>, {
    get: (target, key) => {
      if (key === "measureText") return (text: string) => ({ width: text.length * 6 });
      if (key === "createLinearGradient") return (...args: unknown[]) => { calls.push(["createLinearGradient", ...args]); return { addColorStop: (...stop: unknown[]) => calls.push(["addColorStop", ...stop]) }; };
      if (typeof key === "string" && key in target) return target[key];
      return (...args: unknown[]) => { calls.push([key, ...args]); };
    },
    set: (target, key, value) => {
      target[key as string] = value;
      calls.push(["set", key, value]);
      return true;
    },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

function grid(): LiquidityGrid {
  const liquidity = new LiquidityGrid();
  liquidity.apply(frame(T, 1, true));
  return liquidity;
}

function bookFrame(bid: number, ask: number): BookFrame {
  return { type: "book", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", status: "READY", bids: [{ price: bid, size: 1 }], asks: [{ price: ask, size: 1 }] };
}

describe("the book beside the axis", () => {
  let primitive: LiveOrderBookProfilePrimitive | null = null;
  let now: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    primitive?.detached();
    primitive = null;
    now?.mockRestore();
    now = null;
  });

  it("frames the latest column's bands at the heatmap's cluster, scaled to the biggest, with the spread marked between the sides", () => {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart());
    primitive.setHeatmapSettings({ clusterRows: 4 });
    primitive.setSource(new BookProfileSource(grid()));
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    const built = primitive.frame!;
    expect(built.rowPx).toBe(32);
    expect(built.reach).toBe(120);
    expect(built.lastIndex).toBeNull();
    expect(built.bars.map((b) => [b.index, b.side, b.size, b.yTop, b.yBottom])).toEqual([
      [50, "bid", 4, 168, 200],
      [53, "ask", 6.4, 136, 168],
    ]);
    expect(built.widths.get(50)).toBeCloseTo((120 - BAR_EDGE_GAP_PX) * (4 / 6.4), 6);
    expect(built.widths.get(53)).toBe(120 - BAR_EDGE_GAP_PX);
    const grid2 = grid();
    grid2.apply({ ...frame(T + 1_000, 2, false), columns: [{ ts: T + 1_000, lo: 100, hi: 107, bid: [[0, 1], [2, 1.4]], ask: [[5, 4], [7, 640]] }] });
    primitive.setSource(new BookProfileSource(grid2));
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    expect(primitive.frame!.bars.find((b) => b.index === 50)?.size).toBe(2.4);
    expect(primitive.frame!.widths.get(50)).toBe(Math.ceil(LABEL_CHAR_EM * 11 + LABEL_PAD_PX));
    expect(primitive.frame!.widths.get(53)).toBe(120 - BAR_EDGE_GAP_PX);
    expect(primitive.spreadY).toBe(1_000 - 208 * 4);
  });

  it("marks the spread from the book frame the moment it moves, between the once-a-second columns", () => {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart());
    const liquidity = grid();
    const source = new BookProfileSource(liquidity);
    primitive.setSource(source);
    primitive.updateAllViews();
    expect(primitive.spreadY).toBe(1_000 - 208 * 4);
    const version = source.version;
    source.markBook(bookFrame(209.9, 212), T + 600);
    expect(source.version).toBe(version + 1);
    primitive.updateAllViews();
    expect(primitive.spreadY).toBe(1_000 - 211 * 4);
    liquidity.apply(frame(T + 5_000, 2, false));
    now.mockReturnValue(T + 5_700);
    primitive.updateAllViews();
    expect(primitive.spreadY).toBe(1_000 - 208 * 4);
  });

  it("keeps the rows of the row size setting at every zoom: zoomed out the rows only get thinner, never merged, and the numbers that fit go to the biggest rows", () => {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    const source = new BookProfileSource(grid());
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart(600, 4, 1_000));
    primitive.setHeatmapSettings({ clusterRows: 1 });
    primitive.setSource(source);
    primitive.updateAllViews();
    const near = primitive.frame!.bars.map((b) => [b.index, b.side, b.size]);
    expect(near).toEqual([[200, "bid", 1], [204, "bid", 3], [211, "ask", 4], [215, "ask", 2.4]]);
    primitive.detached();
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart(600, 1, 300));
    primitive.setHeatmapSettings({ clusterRows: 1 });
    primitive.setSource(source);
    primitive.updateAllViews();
    const far = primitive.frame!;
    expect(far.rowPx).toBe(2);
    expect(far.bars.map((b) => [b.index, b.side, b.size])).toEqual(near);
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    expect([...primitive.frame!.widths.values()]).toEqual([bookStubPx(8), 27, 36, bookStubPx(8)]);
    primitive.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, widthShare: 0.24 });
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    expect(primitive.frame!.reach).toBe(240);
    expect([...primitive.frame!.widths.values()].map((width) => Math.round(width * 10) / 10)).toEqual([bookStubPx(8), 57, 76, 45.6]);
    primitive.detached();
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart(600, 2.5, 625));
    primitive.setHeatmapSettings({ clusterRows: 1 });
    primitive.setSource(source);
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    expect(primitive.frame!.rowPx).toBe(5);
    expect([...primitive.frame!.widths.values()].map((width) => Math.round(width * 10) / 10)).toEqual([bookStubPx(8), 40.5, 54, 32.4]);
    primitive.detached();
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart(600, 1, 300));
    primitive.setHeatmapSettings({ clusterRows: 1 });
    primitive.setSource(source);
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    primitive.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, widthShare: 0.01 });
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    expect(primitive.frame!.reach).toBe(10);
    expect([...primitive.frame!.widths.values()]).toEqual([0, 0, 0, 0]);
    primitive.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS });
    const labels = fakeContext();
    primitive.drawLabels(far, { context: labels.context, hpr: 1, vpr: 1, look: { fontFamily: "Inter", background: "#101010" } });
    expect(labels.calls).toContainEqual(["set", "font", "600 8px Inter"]);
    expect(labels.calls.filter((call) => call[0] === "fillText")).toEqual([
      ["fillText", "1", far.right - LABEL_INSET_PX, 99],
      ["fillText", "4", far.right - LABEL_INSET_PX, 89],
    ]);
    const sharp = fakeContext();
    primitive.drawLabels(far, { context: sharp.context, hpr: 2, vpr: 2, look: { fontFamily: "Inter", background: "#101010" } });
    expect(sharp.calls.filter((call) => call[0] === "fillText")).toEqual([
      ["fillText", "1", (far.right - LABEL_INSET_PX) * 2, 198],
      ["fillText", "4", (far.right - LABEL_INSET_PX) * 2, 178],
    ]);
    primitive.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, rowFactor: 2 });
    primitive.updateAllViews();
    expect(primitive.frame!.rowPx).toBe(4);
    expect(primitive.frame!.bars.map((b) => [b.index, b.size])).toEqual([[100, 1], [102, 3], [105, 4], [107, 2.4]]);
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    expect([...primitive.frame!.widths.values()].map((width) => Math.round(width * 10) / 10)).toEqual([bookStubPx(8), 32.4, 43.2, 25.9]);
    const wider = fakeContext();
    primitive.drawLabels(primitive.frame!, { context: wider.context, hpr: 1, vpr: 1, look: { fontFamily: "Inter", background: "#101010" } });
    expect(wider.calls.filter((call) => call[0] === "fillText")).toEqual([
      ["fillText", "1", far.right - LABEL_INSET_PX, 98],
      ["fillText", "4", far.right - LABEL_INSET_PX, 90],
    ]);
    primitive.detached();
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart(600, 5, 1_250));
    primitive.setHeatmapSettings({ clusterRows: 1 });
    primitive.setSource(source);
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    expect(primitive.frame!.rowPx).toBe(10);
    expect(primitive.frame!.widths.get(211)).toBe(120 - BAR_EDGE_GAP_PX);
    expect(primitive.frame!.widths.get(204)).toBeCloseTo((120 - BAR_EDGE_GAP_PX) * 0.75, 6);
  });

  it("draws a thin strip against the axis over the whole book, the ask colour above the spread and the bid colour below, under the bars, so rows holding nothing or under one unit keep the profile continuous", () => {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    const liquidity = new LiquidityGrid();
    liquidity.apply({ ...frame(T, 1, true), columns: [{ ts: T, lo: 100, hi: 115, bid: [[0, 1], [2, 3]], ask: [[5, 4], [7, 2.4], [15, 0.02]] }] });
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart());
    primitive.setHeatmapSettings({ clusterRows: 4 });
    const source = new BookProfileSource(liquidity);
    primitive.setSource(source);
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    expect(primitive.frame!.bars.map((b) => b.index)).toEqual([50, 53]);
    const look = { fontFamily: "Inter", background: "#101010" };
    const right = 1_000 - EDGE_GAP_PX;
    const drawn = fakeContext();
    primitive.drawBars(primitive.frame!, { context: drawn.context, hpr: 1, vpr: 1, look });
    expect(BOOK_SPINE_PX).toBe(3);
    expect(drawn.calls.filter((call) => call[0] === "fillRect").slice(0, 2)).toEqual([
      ["fillRect", right - BOOK_SPINE_PX, 72, BOOK_SPINE_PX, 96],
      ["fillRect", right - BOOK_SPINE_PX, 168, BOOK_SPINE_PX, 32],
    ]);
    expect(drawn.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").map((call) => call[2]).slice(0, 2)).toEqual(["rgba(124, 58, 237, 1)", "rgba(14, 154, 102, 1)"]);
    const sharp = fakeContext();
    primitive.drawBars(primitive.frame!, { context: sharp.context, hpr: 2, vpr: 2, look });
    expect(sharp.calls.filter((call) => call[0] === "fillRect").slice(0, 2)).toEqual([
      ["fillRect", right * 2 - 6, 144, 6, 192],
      ["fillRect", right * 2 - 6, 336, 6, 64],
    ]);
    source.markBook(bookFrame(250, 252), T + 600);
    now.mockReturnValue(T + 600);
    primitive.updateAllViews();
    expect(primitive.spreadY).toBe(1_000 - 252 * 4);
    const ahead = fakeContext();
    primitive.drawBars(primitive.frame!, { context: ahead.context, hpr: 1, vpr: 1, look });
    expect(ahead.calls.filter((call) => call[0] === "fillRect")[0]).toEqual(["fillRect", right - BOOK_SPINE_PX, 72, BOOK_SPINE_PX, 128]);
    now.mockReturnValue(T + BOOK_STALE_MS + 1_000);
    primitive.updateAllViews();
    const dead = fakeContext();
    primitive.drawBars(primitive.frame!, { context: dead.context, hpr: 1, vpr: 1, look });
    expect(dead.calls.filter((call) => call[0] === "fillRect")).toEqual([]);
  });

  it("draws the bars as one solid silhouette, rows touching, and the size on every row in white against the axis", () => {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart());
    primitive.setHeatmapSettings({ clusterRows: 4 });
    primitive.setSource(new BookProfileSource(grid()));
    for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
    const built = primitive.frame!;
    const bars = fakeContext();
    primitive.drawBars(built, { context: bars.context, hpr: 1, vpr: 1, look: { fontFamily: "Inter", background: "#101010" } });
    const right = 1_000 - EDGE_GAP_PX;
    expect(bars.calls.filter((call) => call[0] === "fillRect")).toEqual([
      ["fillRect", right - BOOK_SPINE_PX, 136, BOOK_SPINE_PX, 32],
      ["fillRect", right - BOOK_SPINE_PX, 168, BOOK_SPINE_PX, 32],
      ["fillRect", right - 68, 168, 68, 32],
      ["fillRect", right - 108, 136, 108, 32],
    ]);
    expect(bars.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").map((call) => call[2])).toEqual(["rgba(124, 58, 237, 1)", "rgba(14, 154, 102, 1)", "rgba(14, 154, 102, 1)", "rgba(124, 58, 237, 1)"]);

    const labels = fakeContext();
    primitive.drawLabels(built, { context: labels.context, hpr: 1, vpr: 1, look: { fontFamily: "Inter", background: "#101010" } });
    expect(labels.calls.filter((call) => call[0] === "fillText")).toEqual([
      ["fillText", "4", right - LABEL_INSET_PX, 184],
      ["fillText", "6", right - LABEL_INSET_PX, 152],
    ]);
    expect(labels.calls).toContainEqual(["set", "fillStyle", "rgba(255, 255, 255, 0.95)"]);
    expect(labels.calls).toContainEqual(["set", "font", "600 11px Inter"]);
    expect(labels.calls).toContainEqual(["set", "strokeStyle", DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS.spreadColor]);
    const base = built.candleRight + MARKER_GAP_PX;
    expect(labels.calls).toContainEqual(["moveTo", base + MARKER_ARROW_PX, 168.5]);
    expect(labels.calls).toContainEqual(["lineTo", base, 168.5 - MARKER_ARROW_PX * 0.6]);
    expect(labels.calls).toContainEqual(["lineTo", right + EDGE_GAP_PX, 168.5]);
    expect(labels.calls).toContainEqual(["fillRect", right, 166, EDGE_GAP_PX, 4]);
    expect(labels.calls.some((call) => call[0] === "moveTo" && call[1] === right - 120)).toBe(false);

    primitive.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, showNumbers: false, opacity: 0.5 });
    const quiet = fakeContext();
    primitive.drawLabels(built, { context: quiet.context, hpr: 1, vpr: 1, look: { fontFamily: "Inter", background: "#101010" } });
    expect(quiet.calls.filter((call) => call[0] === "fillText")).toEqual([]);
    const faint = fakeContext();
    primitive.drawBars(built, { context: faint.context, hpr: 1, vpr: 1, look: { fontFamily: "Inter", background: "#101010" } });
    expect(faint.calls).toContainEqual(["set", "fillStyle", "rgba(14, 154, 102, 0.5)"]);
  });

  it("draws nothing from a dead book and says so once in the log, then says once when columns resume", () => {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const liquidity = grid();
      primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
      primitive.attached(fakeChart());
      primitive.setSource(new BookProfileSource(liquidity));
      primitive.updateAllViews();
      primitive.updateAllViews();
      expect(primitive.frame!.bars.length).toBeGreaterThan(0);
      expect(info.mock.calls).toEqual([["Live Order Book Profile: book live"]]);
      now.mockReturnValue(T + BOOK_STALE_MS + 1);
      primitive.updateAllViews();
      primitive.updateAllViews();
      expect(primitive.frame!.bars).toEqual([]);
      expect(primitive.spreadY).toBeNull();
      expect(warn.mock.calls).toEqual([["Live Order Book Profile: book stale, nothing drawn until columns resume"]]);
      liquidity.apply(frame(T + BOOK_STALE_MS, 2, false));
      primitive.updateAllViews();
      expect(primitive.frame!.bars.length).toBeGreaterThan(0);
      expect(info.mock.calls.length).toBe(2);
      primitive.setSource(new BookProfileSource(liquidity));
      primitive.updateAllViews();
      expect(info.mock.calls.length).toBe(3);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("shows a resize line only while the pointer is on it", () => {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart());
    primitive.setSource(new BookProfileSource(grid()));
    primitive.updateAllViews();
    const lines = (): unknown[][] => {
      const drawn = fakeContext();
      const target = { useBitmapCoordinateSpace: (draw: (space: unknown) => void) => draw({ context: drawn.context, horizontalPixelRatio: 1, verticalPixelRatio: 1 }) };
      primitive!.paneViews()[1].renderer()!.draw(target as never);
      return drawn.calls.filter((call) => call[0] === "fillRect" && call[2] === 0 && call[4] === 500);
    };
    expect(primitive.handlesShown()).toEqual({ edge: false, base: false });
    expect(lines()).toEqual([]);
    primitive.setHandleHover("edge");
    expect(primitive.handlesShown()).toEqual({ edge: true, base: false });
    expect(lines().map((call) => call[1])).toEqual([1_000 - EDGE_GAP_PX - primitive.frame!.reach]);
    primitive.setHandleHover("base");
    expect(lines().map((call) => call[1])).toEqual([1_000 - EDGE_GAP_PX]);
    primitive.setHandleHover(null);
    expect(lines()).toEqual([]);
  });

  it("keeps room for its bars and the spread marker, and sits left of a neighbour", () => {
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    const param = fakeChart();
    primitive.attached(param);
    primitive.setSource(new BookProfileSource(grid()));
    const marker = MARKER_GAP_PX + MARKER_ARROW_PX;
    expect(param.chart.timeScale().options().rightOffset).toBe(Math.ceil((120 + EDGE_GAP_PX + NEIGHBOUR_GAP_PX + marker) / 10));
    primitive.setNeighbour({ widthPx: () => 200, resize: () => {} });
    expect(param.chart.timeScale().options().rightOffset).toBe(Math.ceil((120 + 200 + NEIGHBOUR_GAP_PX + EDGE_GAP_PX + NEIGHBOUR_GAP_PX + marker) / 10));
    expect(primitive.reachShareAt(0)).toBeNull();
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    primitive.updateAllViews();
    expect(primitive.frame!.right).toBe(1_000 - EDGE_GAP_PX - 200 - NEIGHBOUR_GAP_PX);
    expect(primitive.reachShareAt(0)).toBe(0.6);
    expect(primitive.reachShareAt(primitive.frame!.right - 300)).toBe(0.3);
  });
});

function restingFrame(ts: number, seq: number, reset: boolean, ask: [number, number][] = []): LiquidityFrame {
  return {
    type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts, seq, reset, row_width: 2, column_ms: 1_000,
    columns: [{ ts, lo: 100, hi: 109, bid: [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]], ask }],
  };
}

describe("big resting orders drawn into the chart", () => {
  let primitive: LiveOrderBookProfilePrimitive | null = null;
  let now: ReturnType<typeof vi.spyOn> | null = null;
  const look = { fontFamily: "Inter", background: "#101010" };
  const EDGE = 1_000 - EDGE_GAP_PX;

  afterEach(() => {
    primitive?.detached();
    primitive = null;
    now?.mockRestore();
    now = null;
  });

  function rested(ask: [number, number][] = [[7, 9]], chart = fakeChart(), bars: readonly BarFrame[] = [bar]): { liquidity: LiquidityGrid; source: BookProfileSource } {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    const liquidity = new LiquidityGrid();
    liquidity.apply(restingFrame(T, 1, true));
    const source = new BookProfileSource(liquidity);
    primitive = new LiveOrderBookProfilePrimitive(() => bars);
    primitive.attached(chart);
    primitive.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3 });
    primitive.setSource(source);
    primitive.updateAllViews();
    for (let i = 1; i <= 3; i += 1) liquidity.apply(restingFrame(T + i * 1_000, i + 1, false, ask));
    now.mockReturnValue(T + 3_500);
    primitive.updateAllViews();
    expect(primitive.restingBars).toEqual([]);
    liquidity.apply(restingFrame(T + 4_000, 5, false, ask));
    now.mockReturnValue(T + 4_500);
    primitive.updateAllViews();
    now.mockReturnValue(T + 4_800);
    primitive.updateAllViews();
    return { liquidity, source };
  }

  it("shows an order once it has rested three seconds: a bar from the axis into the chart under the candles, as long as its share of the biggest, its size at the axis end over everything", () => {
    rested();
    expect(primitive!.restingBars.map((bar) => [bar.key, bar.side, bar.size, bar.share, bar.flash, bar.alpha])).toEqual([["ask:53", "ask", 9, 1, 0.7, 1]]);
    expect(primitive!.restingUntil).toBe(T + 4_500 + RESTING_APPEAR_MS);
    const built = primitive!.frame!;
    const bars = fakeContext();
    primitive!.drawBars(built, { context: bars.context, hpr: 1, vpr: 1, look });
    const rects = bars.calls.filter((call) => call[0] === "fillRect");
    expect(rects.at(-1)).toEqual(["fillRect", EDGE - 200, 136, 200 - 13, 16]);
    expect([primitive!.frame!.barSpacing, primitive!.frame!.intervalMs]).toEqual([10, 60_000]);
    expect(rects).toHaveLength(built.bars.length + 3);
    expect(bars.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").at(-1)).toEqual(["set", "fillStyle", "rgba(179, 141, 245, 1)"]);
    const labels = fakeContext();
    primitive!.drawLabels(built, { context: labels.context, hpr: 1, vpr: 1, look });
    const texts = labels.calls.filter((call) => call[0] === "fillText");
    expect(texts.slice(0, -1)).toHaveLength(built.bars.length);
    expect(texts.at(-1)).toEqual(["fillText", "9", EDGE - LABEL_INSET_PX, 144]);
    expect(labels.calls).toContainEqual(["fillRect", EDGE - 13, 136, 13, 16]);
    expect(labels.calls).toContainEqual(["set", "fillStyle", "rgba(255, 255, 255, 1)"]);
    expect(labels.calls.filter((call) => call[0] === "set" && call[1] === "font").at(-1)).toEqual(["set", "font", "600 11px Inter"]);
    expect([RESTING_FONT_PX, RESTING_LABEL_PAD_PX]).toEqual([11, 4]);
  });

  it("keeps the chart repainting while a bar grows or fades, and stops once every bar stands still", () => {
    const ticks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (tick: FrameRequestCallback) => ticks.push(tick));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
      const liquidity = new LiquidityGrid();
      liquidity.apply(restingFrame(T, 1, true));
      const param = fakeChart();
      const requestUpdate = vi.fn();
      (param as unknown as { requestUpdate: () => void }).requestUpdate = requestUpdate;
      primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
      primitive.attached(param);
      primitive.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3 });
      primitive.setSource(new BookProfileSource(liquidity));
      primitive.updateAllViews();
      for (let i = 1; i <= 4; i += 1) liquidity.apply(restingFrame(T + i * 1_000, i + 1, false, [[7, 9]]));
      now.mockReturnValue(T + 4_500);
      primitive.updateAllViews();
      now.mockReturnValue(T + 4_600);
      for (let i = 0; i < 60; i += 1) primitive.updateAllViews();
      expect(primitive.restingBars).toHaveLength(1);
      requestUpdate.mockClear();
      ticks.at(-1)!(0);
      expect(requestUpdate).toHaveBeenCalled();
      now.mockReturnValue(T + 4_500 + RESTING_APPEAR_MS);
      for (let i = 0; i < 3; i += 1) primitive.updateAllViews();
      requestUpdate.mockClear();
      ticks.at(-1)!(0);
      expect(requestUpdate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds the bar at its size from the moment the order drops under half, lets it go two seconds later, and fades it there over two seconds", () => {
    const { liquidity } = rested();
    liquidity.apply(restingFrame(T + 5_000, 6, false, [[7, 4]]));
    now!.mockReturnValue(T + 5_100);
    primitive!.updateAllViews();
    expect(primitive!.restingBars.map((bar) => [bar.size, bar.alpha, bar.flash])).toEqual([[9, 1, 0.4]]);
    liquidity.apply(restingFrame(T + 6_000, 7, false, [[7, 0]]));
    now!.mockReturnValue(T + 6_100);
    primitive!.updateAllViews();
    expect(primitive!.restingBars.map((bar) => [bar.size, bar.alpha, bar.flash])).toEqual([[9, 1, 0]]);
    liquidity.apply(restingFrame(T + 7_000, 8, false, [[7, 0]]));
    now!.mockReturnValue(T + 7_100);
    primitive!.updateAllViews();
    expect(primitive!.restingBars[0].alpha).toBe(1);
    expect(primitive!.restingBars[0].flash).toBe(1);
    expect(primitive!.restingBars[0].size).toBe(9);
    expect(primitive!.restingUntil).toBe(T + 7_100 + RESTING_FADE_MS);
    now!.mockReturnValue(T + 7_100 + RESTING_FLASH_MS / 2);
    primitive!.updateAllViews();
    const lit = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: lit.context, hpr: 1, vpr: 1, look });
    expect(lit.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").at(-1)).toEqual(["set", "fillStyle", "rgba(163, 117, 242, 0.925)"]);
    const litLabels = fakeContext();
    primitive!.drawLabels(primitive!.frame!, { context: litLabels.context, hpr: 1, vpr: 1, look });
    expect(litLabels.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").slice(-2)).toEqual([["set", "fillStyle", "rgba(163, 117, 242, 0.925)"], ["set", "fillStyle", "rgba(255, 255, 255, 0.925)"]]);
    now!.mockReturnValue(T + 7_100 + RESTING_FADE_MS / 2);
    primitive!.updateAllViews();
    expect(primitive!.restingBars[0].alpha).toBeCloseTo(0.5, 6);
    const bars = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: bars.context, hpr: 1, vpr: 1, look });
    expect(bars.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").at(-1)).toEqual(["set", "fillStyle", "rgba(124, 58, 237, 0.5)"]);
    const labels = fakeContext();
    primitive!.drawLabels(primitive!.frame!, { context: labels.context, hpr: 1, vpr: 1, look });
    expect(labels.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").slice(-2)).toEqual([["set", "fillStyle", "rgba(124, 58, 237, 0.5)"], ["set", "fillStyle", "rgba(255, 255, 255, 0.5)"]]);
    now!.mockReturnValue(T + 7_100 + RESTING_FADE_MS);
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
  });

  it("gives the biggest bar the share of the chart from the settings and the others their share of it, none shorter than its number, down to a sliver that leaves only the numbers", () => {
    rested([[7, 300], [6, 2], [8, 30]]);
    const drawn = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: drawn.context, hpr: 1, vpr: 1, look });
    const rects = drawn.calls.filter((call) => call[0] === "fillRect").slice(-2);
    expect(rects).toEqual([["fillRect", EDGE - 200, 136, 200 - 25, 16], ["fillRect", EDGE - 20, 120, 1, 16]]);
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3, restingShare: 0.01 });
    primitive!.updateAllViews();
    const near = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: near.context, hpr: 1, vpr: 1, look });
    const nearRects = near.calls.filter((call) => call[0] === "fillRect");
    expect(nearRects).toHaveLength(primitive!.frame!.bars.length + 2);
    const labels = fakeContext();
    primitive!.drawLabels(primitive!.frame!, { context: labels.context, hpr: 1, vpr: 1, look });
    expect(labels.calls).toContainEqual(["fillRect", EDGE - 25, 136, 25, 16]);
    expect(labels.calls).toContainEqual(["fillText", "302", EDGE - LABEL_INSET_PX, 144]);
    expect(labels.calls).toContainEqual(["fillText", "30", EDGE - LABEL_INSET_PX, 128]);
  });

  it("dims the big-order bars and their stubs with the profile's opacity, the numbers stay readable", () => {
    rested([[7, 300]]);
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3, opacity: 0.5 });
    primitive!.updateAllViews();
    const drawn = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: drawn.context, hpr: 1, vpr: 1, look });
    expect(drawn.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").at(-1)).toEqual(["set", "fillStyle", "rgba(179, 141, 245, 0.5)"]);
    const labels = fakeContext();
    primitive!.drawLabels(primitive!.frame!, { context: labels.context, hpr: 1, vpr: 1, look });
    expect(labels.calls.filter((call) => call[0] === "set" && call[1] === "fillStyle").slice(-2)).toEqual([["set", "fillStyle", "rgba(179, 141, 245, 0.5)"], ["set", "fillStyle", "rgba(255, 255, 255, 1)"]]);
  });

  it("starts every bar at the profile's own edge, so beside the delta profile the bars stay on the book and never run over it", () => {
    rested([[7, 300]]);
    primitive!.setNeighbour({ widthPx: () => 200, resize: () => {} });
    primitive!.updateAllViews();
    const right = 1_000 - EDGE_GAP_PX - 200 - NEIGHBOUR_GAP_PX;
    expect(primitive!.frame!.right).toBe(right);
    const drawn = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: drawn.context, hpr: 1, vpr: 1, look });
    expect(drawn.calls.filter((call) => call[0] === "fillRect").at(-1)).toEqual(["fillRect", right - 200, 136, 200 - 25, 16]);
    const labels = fakeContext();
    primitive!.drawLabels(primitive!.frame!, { context: labels.context, hpr: 1, vpr: 1, look });
    expect(labels.calls).toContainEqual(["fillRect", right - 25, 136, 25, 16]);
    expect(labels.calls).toContainEqual(["fillText", "300", right - LABEL_INSET_PX, 144]);
  });

  it("never runs a bar more than the last fifteen minutes past the last candle, whatever the timeframe or the setting, and draws it back to its number when the chart is scrolled into history", () => {
    rested([[7, 300]], fakeChart(), [{ ...bar, interval_ms: 3_600_000 }]);
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3, restingShare: 0.5 });
    primitive!.updateAllViews();
    const hourly = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: hourly.context, hpr: 1, vpr: 1, look });
    expect(hourly.calls.filter((call) => call[0] === "fillRect").at(-1)).toEqual(["fillRect", EDGE - 395, 104, 395 - 25, 128]);
    expect(RESTING_REACH_MS / 3_600_000 * 10).toBe(2.5);
    primitive!.detached();
    now!.mockRestore();
    rested([[7, 300]], fakeChart(600, 4, 1_000, () => 600, 4));
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3, restingShare: 0.5 });
    primitive!.updateAllViews();
    const zoomed = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: zoomed.context, hpr: 1, vpr: 1, look });
    expect(zoomed.calls.filter((call) => call[0] === "fillRect").at(-1)).toEqual(["fillRect", EDGE - 455, 136, 455 - 25, 16]);
    primitive!.detached();
    now!.mockRestore();
    rested([[7, 300]], fakeChart(1_100));
    const back = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: back.context, hpr: 1, vpr: 1, look });
    expect(back.calls.filter((call) => call[0] === "fillRect").at(-1)).toEqual(["fillRect", EDGE - 42, 136, 42 - 25, 16]);
    primitive!.detached();
    now!.mockRestore();
    rested([[7, 300]], fakeChart(1_300));
    const history = fakeContext();
    primitive!.drawBars(primitive!.frame!, { context: history.context, hpr: 1, vpr: 1, look });
    expect(history.calls.filter((call) => call[0] === "fillRect")).toHaveLength(primitive!.frame!.bars.length + 2);
    const labels = fakeContext();
    primitive!.drawLabels(primitive!.frame!, { context: labels.context, hpr: 1, vpr: 1, look });
    expect(labels.calls).toContainEqual(["fillText", "300", EDGE - LABEL_INSET_PX, 144]);
  });

  it("shows nothing with the switch off, and what already rests grows back in at once when it is switched back on", () => {
    const { liquidity } = rested();
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3, showResting: false });
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
    expect(primitive!.restingUntil).toBe(0);
    const drawn = fakeContext();
    primitive!.drawLabels(primitive!.frame!, { context: drawn.context, hpr: 1, vpr: 1, look });
    expect(drawn.calls.some((call) => call[0] === "fillRect" && (call[1] as number) < EDGE)).toBe(false);
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3 });
    now!.mockReturnValue(T + 4_900);
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
    expect(primitive!.restingUntil).toBe(T + 4_900 + RESTING_APPEAR_MS);
    now!.mockReturnValue(T + 5_000);
    primitive!.updateAllViews();
    expect(primitive!.restingBars.map((bar) => [bar.key, bar.alpha])).toEqual([["ask:53", 1 / 3]]);
    expect(liquidity.columns.length).toBe(5);
  });

  it("clears the bars when the book goes stale, and grows what still rests back in at once when it comes back", () => {
    rested();
    now!.mockReturnValue(T + 4_000 + BOOK_STALE_MS + 1_000);
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
    now!.mockReturnValue(T + 4_900);
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
    now!.mockReturnValue(T + 5_200);
    primitive!.updateAllViews();
    expect(primitive!.restingBars.map((bar) => [bar.key, bar.alpha])).toEqual([["ask:53", 1]]);
  });

  it("grows what already rests back in at once when the profile is switched off and on", () => {
    const { source } = rested();
    expect(primitive!.restingBars).toHaveLength(1);
    primitive!.setSource(null);
    primitive!.setSource(source);
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
    now!.mockReturnValue(T + 5_100);
    primitive!.updateAllViews();
    expect(primitive!.restingBars.map((bar) => bar.key)).toEqual(["ask:53"]);
  });

  it("waits the seconds from the settings, half a minute by default, and a change of the wait applies at once", () => {
    const { liquidity } = rested();
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS });
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
    liquidity.apply(restingFrame(T + 31_000, 6, false, [[7, 9]]));
    now!.mockReturnValue(T + 31_100);
    primitive!.updateAllViews();
    now!.mockReturnValue(T + 31_400);
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toHaveLength(1);
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 60 });
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
    expect(primitive!.restingUntil).toBe(0);
  });

  it("takes a bar off without a flash when the minimum size changes under it", () => {
    rested();
    primitive!.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingStandS: 3, restingMinSize: 12 });
    primitive!.updateAllViews();
    expect(primitive!.restingBars).toEqual([]);
    expect(primitive!.restingUntil).toBe(0);
  });

  it("takes the minimum size from the settings, in the book's own units", () => {
    now = vi.spyOn(Date, "now").mockReturnValue(T + 500);
    const liquidity = new LiquidityGrid();
    liquidity.apply(restingFrame(T, 1, true));
    primitive = new LiveOrderBookProfilePrimitive(() => [bar]);
    primitive.attached(fakeChart());
    primitive.setSettings({ ...DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, restingMinSize: 12, restingStandS: 3 });
    primitive.setSource(new BookProfileSource(liquidity));
    primitive.updateAllViews();
    for (let i = 1; i <= 4; i += 1) liquidity.apply(restingFrame(T + i * 1_000, i + 1, false, [[7, 9]]));
    now.mockReturnValue(T + 4_500);
    primitive.updateAllViews();
    now.mockReturnValue(T + 4_800);
    primitive.updateAllViews();
    expect(primitive.restingBars).toEqual([]);
  });
});
