import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import type { LiquidityPrint } from "../../../../types/frames";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { ColumnHistoryStream, STREAM_LEVEL_MS } from "../../passive-liquidity/columnHistoryStream";
import type { HistoryRequest } from "../../passive-liquidity/heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage } from "../../passive-liquidity/heatmapHistoryDecode";
import { DEFAULT_CANDLE_MS } from "../liveRangeGeometry";
import { LiveRangeHistory } from "../liveRangeHistory";
import { ACTIVE_LINE_WIDTH_PX, LINE_WIDTH_PX, LIVE_TICK_MS, LiveRangePrimitive, READ_SETTLE_MS, reportSignature, visibleSpan, type ClockedRangeGrid, type LiveRangeReport } from "../liveRangePrimitive";
import { noPrints } from "../liveRangePrints";
import { rangeNote, verdictOf } from "../liveRangeWords";
import type { LiveRangeRead } from "../liveRangeReader";
import { DEFAULT_LIVE_RANGE_SETTINGS, VERDICT_Z_FROM, type LiveRangeSettings } from "../liveRangeSettings";
import { WHOLE_WINDOW } from "../liveRangeWindow";

const T = Date.UTC(2026, 9, 16, 2, 0);
const MINUTE = 60_000;
const NOW = T + 9 * MINUTE + 30_000;
const RED = "#ff0000";
const LEFT_ON_CANVAS = { fillStyle: "#010101", strokeStyle: "#020202", lineWidth: 7, dash: [2, 2] };
const HOUR = 60 * MINUTE;
const READ: LiveRangeRead = { buys: 4, sells: 5, fromTs: T, toTs: T + 30 * MINUTE, coveredMs: 30 * MINUTE, tradedMs: 30 * MINUTE, missing: [], noise: 3, minutesWon: { buyers: 3, sellers: 4 }, impact: { buyers: { moved: 0, volume: 0 }, sellers: { moved: 0, volume: 0 } } };
const LIVE: LiveRangeSettings = { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live" };
const SELECTED: LiveRangeSettings = { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "selected" };

type Rows = CandlestickData<UTCTimestamp>[];

interface View {
  range: { from: number; to: number } | null;
  width: number;
  height: number;
}

function candles(count: number, close = 100): Rows {
  return Array.from({ length: count }, (_, i) => ({ time: ((T + i * MINUTE) / 1_000) as UTCTimestamp, open: close, high: close + 0.05, low: close - 0.05, close }));
}

function attach(primitive: LiveRangePrimitive, start: Partial<View> = {}) {
  const view: View = { range: { from: 0, to: 9 }, width: 600, height: 400, ...start };
  const requestUpdate = vi.fn();
  primitive.attached({
    chart: {
      timeScale: () => ({
        logicalToCoordinate: (logical: number) => (Number.isInteger(logical) ? logical * 10 : 0),
        coordinateToLogical: (x: number) => Math.ceil(x / 10),
        getVisibleLogicalRange: () => view.range,
      }),
      paneSize: (pane: number) => (pane === 0 ? { width: view.width, height: view.height } : { width: 0, height: 0 }),
    },
    series: {},
    requestUpdate,
  } as never);
  return { view, requestUpdate };
}

function zonePrimitive(rows: Rows, settings: LiveRangeSettings = LIVE, nowMs = NOW): LiveRangePrimitive {
  const primitive = new LiveRangePrimitive(() => rows, () => nowMs);
  primitive.setSettings(settings);
  return primitive;
}

function shownZone(window: { fromMs: number | null; toMs: number | null }, settings: LiveRangeSettings = SELECTED, rows = candles(10), nowMs = NOW) {
  const primitive = zonePrimitive(rows, settings, nowMs);
  const attached = attach(primitive);
  primitive.setShown(true);
  primitive.setWindow(window);
  primitive.updateAllViews();
  return { primitive, ...attached };
}

function harness(rows = candles(10), range: { from: number; to: number } | null = { from: 0, to: 9 }, settings: LiveRangeSettings = DEFAULT_LIVE_RANGE_SETTINGS, unit = "") {
  let now = NOW;
  const reports: (LiveRangeReport | null)[] = [];
  const primitive = new LiveRangePrimitive(() => rows, () => now);
  primitive.onRead = (report) => reports.push(report);
  primitive.setSettings(settings, unit);
  const { view, requestUpdate } = attach(primitive, { range });
  return { primitive, reports, view, requestUpdate, last: () => reports[reports.length - 1], setNow: (ms: number) => { now = ms; }, now: () => now };
}

interface Op {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: unknown;
  dash: number[];
}

function recorder(left: Record<string, unknown> = {}, mediaSize = { width: 600, height: 400 }) {
  const ops: Op[] = [];
  const { dash: leftDash = [], ...leftState } = left;
  let dash: number[] = [...(leftDash as number[])];
  const stack: Record<string, unknown>[] = [];
  const keys = ["fillStyle", "strokeStyle", "lineWidth"] as const;
  const context: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1, ...leftState };
  const state = () => ({ ...Object.fromEntries(keys.map((key) => [key, context[key]])), dash: [...dash] });
  const record = (op: string) => (...args: unknown[]) => {
    ops.push({ op, args, fillStyle: context.fillStyle, strokeStyle: context.strokeStyle, lineWidth: context.lineWidth, dash: [...dash] });
  };
  for (const op of ["beginPath", "moveTo", "lineTo", "stroke", "fillRect"]) context[op] = record(op);
  context.setLineDash = (next: number[]) => {
    dash = [...next];
  };
  context.save = () => {
    stack.push(state());
  };
  context.restore = () => {
    const top = stack.pop();
    if (top === undefined) return;
    for (const key of keys) context[key] = top[key];
    dash = top.dash as number[];
  };
  return { ops, stack, state, target: { useMediaCoordinateSpace: (paint: (scope: { context: unknown; mediaSize: { width: number; height: number } }) => void) => paint({ context, mediaSize }) } };
}

function draw(primitive: LiveRangePrimitive, view: number, canvas = recorder()) {
  primitive.paneViews()[view].renderer()?.draw(canvas.target as never);
  return canvas;
}

function calls(ops: readonly Op[]): unknown[][] {
  return ops.map(({ op, args }) => [op, ...args]);
}

function column(ts: number, buy: number, row = 100): LiquidityColumn {
  return { ts, lo: 99, hi: 101, bid: Float64Array.from([2, 0, 0]), ask: Float64Array.from([0, 3, 0]), buy: [[row, buy]] };
}

function print(ts: number, price: number, size: number, side: "buy" | "sell"): LiquidityPrint {
  return { ts, price, size, side, id: `${ts}:${side}:${size}` };
}

function grid(columns: LiquidityColumn[], now: number, deepColumns: LiquidityColumn[] = []): ClockedRangeGrid {
  return { columns, columnMs: 1_000, deepColumns, deepColumnMs: deepColumns.length > 0 ? 10_000 : 0, rowWidth: 1, clockMs: () => now };
}

function hostPage(request: HistoryRequest, columns: readonly LiquidityColumn[], rowWidth = 1): DecodedHistoryPage {
  const byWindow = new Map<number, LiquidityColumn[]>();
  for (const c of columns) {
    if (c.ts < request.fromTs || c.ts >= request.toTs) continue;
    const ts = Math.floor(c.ts / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS;
    byWindow.set(ts, [...(byWindow.get(ts) ?? []), c]);
  }
  const windows = [...byWindow.entries()].sort((a, b) => a[0] - b[0]).map(([ts, list]) => ({ ts, state: "COVERED" as const, columns: list }));
  return { available: true, generation: "g", levelMs: STREAM_LEVEL_MS, rowFactor: 1, rowWidth, span: { oldest: null, newest: null }, next: null, windows };
}

function btcStream() {
  const sent: HistoryRequest[] = [];
  const stream = new ColumnHistoryStream({ request: (request) => sent.push(request), maxPerMinute: 100_000, retryMs: 1 });
  stream.setIdentity({ provider: "BINANCE", marketKind: "SPOT", symbol: "BTC-USDT" });
  return { sent, stream };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the clock and the timer", () => {
  it("reads once a second while shown on a chart, and keeps no timer before it is on a chart, while hidden or once detached", () => {
    vi.useFakeTimers();
    expect(LIVE_TICK_MS).toBe(1_000);
    const rows = candles(10);
    const primitive = new LiveRangePrimitive(() => rows, () => NOW);
    const reads = vi.spyOn(primitive, "readNow");
    primitive.setShown(true);
    expect(vi.getTimerCount()).toBe(0);
    attach(primitive);
    expect(vi.getTimerCount()).toBe(1);
    reads.mockClear();
    vi.advanceTimersByTime(3 * LIVE_TICK_MS);
    expect(reads).toHaveBeenCalledTimes(3);
    primitive.setShown(false);
    expect(vi.getTimerCount()).toBe(0);
    primitive.setShown(true);
    expect(vi.getTimerCount()).toBe(1);
    primitive.detached();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tells the time by the browser's clock when it is given none", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rows = candles(10);
    const primitive = new LiveRangePrimitive(() => rows);
    const reports: (LiveRangeReport | null)[] = [];
    primitive.onRead = (report) => reports.push(report);
    attach(primitive);
    primitive.setShown(true);
    expect(reports[reports.length - 1]?.toTs).toBe(NOW);
  });
});

describe("visibleSpan", () => {
  it("runs from the first candle on screen to the end of the last one, never past now, from the logical range of the chart rounded to candles, and is nothing with no candles, no range or a range past the candles", () => {
    const rows = candles(10);
    expect(visibleSpan(rows, { from: 2.4, to: 6.6 }, NOW)).toEqual({ fromTs: T + 2 * MINUTE, toTs: T + 8 * MINUTE });
    expect(visibleSpan(rows, { from: 2.6, to: 6.4 }, NOW)).toEqual({ fromTs: T + 3 * MINUTE, toTs: T + 7 * MINUTE });
    expect(visibleSpan(rows, { from: -3.5, to: 12 }, NOW)).toEqual({ fromTs: T, toTs: NOW });
    expect(visibleSpan(rows, { from: 8.6, to: 9.2 }, NOW)).toEqual({ fromTs: T + 9 * MINUTE, toTs: NOW });
    expect(visibleSpan(rows, { from: 9.6, to: 12 }, NOW)).toBeNull();
    expect(visibleSpan(rows, null, NOW)).toBeNull();
    expect(visibleSpan([], { from: 0, to: 1 }, NOW)).toBeNull();
    expect(visibleSpan(rows, { from: 0, to: 0 }, T - 1)).toBeNull();
    expect(visibleSpan([rows[0]], { from: 0, to: 0 }, NOW)).toEqual({ fromTs: T, toTs: T + DEFAULT_CANDLE_MS });
    const hourly = rows.map((row, i) => ({ ...row, time: ((T + i * 60 * MINUTE) / 1_000) as UTCTimestamp }));
    expect(visibleSpan(hourly, { from: 0, to: 1 }, T + 10 * 60 * MINUTE)).toEqual({ fromTs: T, toTs: T + 2 * 60 * MINUTE });
  });
});

describe("LiveRangePrimitive in the visible range", () => {
  it("draws no zone, reads the candles on screen once shown and attached, once a second and again shortly after the chart repaints, and reports nothing while hidden, detached or without a span", () => {
    vi.useFakeTimers();
    const { primitive, reports, view, last } = harness();
    expect(reports).toEqual([null]);
    primitive.setShown(true);
    expect(last()).toMatchObject({ mode: "visible", fromTs: T, toTs: NOW, live: false });
    expect(last()?.read).toMatchObject({ buys: 0, sells: 0, coveredMs: 0 });
    expect(last()?.prints).toEqual(noPrints(0, ""));
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
    expect([draw(primitive, 0).ops, draw(primitive, 1).ops]).toEqual([[], []]);
    expect(primitive.lineAt(0, 10)).toBeNull();
    primitive.setGrid(grid([column(T + 9 * MINUTE + 1_000, 3)], NOW));
    expect(last()?.read?.buys).toBe(3);
    view.range = { from: 0, to: 4 };
    expect(last()?.toTs).toBe(NOW);
    primitive.updateAllViews();
    expect(last()?.toTs).toBe(NOW);
    vi.advanceTimersByTime(READ_SETTLE_MS);
    expect(last()).toMatchObject({ fromTs: T, toTs: T + 5 * MINUTE });
    expect(last()?.read?.buys).toBe(0);
    view.range = { from: 0, to: 9 };
    const before = reports.length;
    vi.advanceTimersByTime(LIVE_TICK_MS - READ_SETTLE_MS);
    expect(reports.length).toBe(before + 1);
    expect(last()?.read?.buys).toBe(3);
    view.range = null;
    primitive.readNow();
    expect(last()).toBeNull();
    view.range = { from: 0, to: 9 };
    primitive.readNow();
    expect(last()).not.toBeNull();
    primitive.setShown(false);
    expect(last()).toBeNull();
    const count = reports.length;
    vi.advanceTimersByTime(5 * LIVE_TICK_MS);
    expect(reports.length).toBe(count);
    primitive.setShown(true);
    expect(last()).not.toBeNull();
    primitive.detached();
    expect(last()).toBeNull();
    expect(primitive.span()).toBeNull();
  });

  it("reads once for all the repaints of a scroll, within the settle time of the last one, so a scroll costs the chart nothing, and a detach drops a read still due", () => {
    vi.useFakeTimers();
    const { primitive, reports, view, last } = harness();
    primitive.setShown(true);
    const count = reports.length;
    const reads = vi.spyOn(primitive, "readNow");
    for (let i = 1; i <= 30; i += 1) {
      view.range = { from: (i % 5) + 1, to: 9 };
      primitive.updateAllViews();
      vi.advanceTimersByTime(3);
    }
    expect([reports.length, reads.mock.calls.length]).toEqual([count, 0]);
    vi.advanceTimersByTime(READ_SETTLE_MS - 90);
    expect([reports.length, reads.mock.calls.length]).toEqual([count + 1, 1]);
    expect(last()).toMatchObject({ fromTs: T + MINUTE, toTs: NOW });
    vi.advanceTimersByTime(READ_SETTLE_MS);
    expect([reports.length, reads.mock.calls.length]).toEqual([count + 1, 1]);
    view.range = { from: 3, to: 9 };
    primitive.updateAllViews();
    vi.advanceTimersByTime(READ_SETTLE_MS);
    expect([reports.length, reads.mock.calls.length]).toEqual([count + 2, 2]);
    expect(last()).toMatchObject({ fromTs: T + 3 * MINUTE, toTs: NOW });
    view.range = { from: 2, to: 9 };
    primitive.updateAllViews();
    primitive.detached();
    reads.mockClear();
    vi.advanceTimersByTime(10 * READ_SETTLE_MS);
    expect(last()).toBeNull();
    expect([reports.length, reads.mock.calls.length]).toEqual([count + 3, 0]);
    expect(READ_SETTLE_MS).toBe(120);
  });

  it("reports only when the card would change: the same read again is kept quiet, a moved span is reported, and a new colour is not", () => {
    vi.useFakeTimers();
    const { primitive, reports, view } = harness();
    primitive.setShown(true);
    const count = reports.length;
    primitive.readNow();
    vi.advanceTimersByTime(3 * LIVE_TICK_MS);
    expect(reports.length).toBe(count);
    view.range = { from: 1, to: 9 };
    primitive.readNow();
    expect(reports.length).toBe(count + 1);
    primitive.updateAllViews();
    vi.advanceTimersByTime(READ_SETTLE_MS);
    expect(reports.length).toBe(count + 1);
    primitive.setSettings({ ...DEFAULT_LIVE_RANGE_SETTINGS, bidColor: "#123456" });
    expect(primitive.settings.bidColor).toBe("#123456");
    expect(reports.length).toBe(count + 1);
  });

  it("reports again when the verdict sensitivity changes what the card says, and stays quiet when the verdict stays", () => {
    vi.useFakeTimers();
    const { primitive, reports, last, now } = harness();
    primitive.setShown(true);
    const nets = [2, 2, 2, 2, 2, -1, -1, -1, -1];
    const flow = nets.flatMap((net, i) => [{ ...column(T + i * MINUTE + 1_000, Math.max(net, 0)), sell: net < 0 ? [[100, -net] as const] : [] }, column(T + i * MINUTE + 31_000, 0)]);
    primitive.setGrid(grid(flow, now()));
    expect([last()?.read?.buys, last()?.read?.sells, last()?.read?.missing]).toEqual([10, 4, []]);
    expect(last()?.read?.noise).toBeCloseTo(Math.sqrt(24), 12);
    const count = reports.length;
    primitive.setSettings({ ...DEFAULT_LIVE_RANGE_SETTINGS, verdictSensitivity: "high" });
    expect(reports.length).toBe(count);
    primitive.setSettings({ ...DEFAULT_LIVE_RANGE_SETTINGS, verdictSensitivity: "strict" });
    expect(reports.length).toBe(count + 1);
    primitive.setSettings({ ...DEFAULT_LIVE_RANGE_SETTINGS, verdictSensitivity: "strict", showDeltaRow: false, showTips: false });
    expect(reports.length).toBe(count + 1);
    primitive.setSettings({ ...DEFAULT_LIVE_RANGE_SETTINGS, verdictSensitivity: "normal" });
    expect(reports.length).toBe(count + 2);
  });

  it("the signature that gates a report changes with the head, the range line, the rows, the note and the verdict, not with what the card does not show", () => {
    const report: LiveRangeReport = { mode: "visible", fromTs: T, toTs: T + 30 * MINUTE, live: false, read: READ, prints: null, loading: false };
    const signature = reportSignature(report);
    expect(reportSignature(report, VERDICT_Z_FROM.normal)).toBe(signature);
    expect(reportSignature(report, VERDICT_Z_FROM.high)).not.toBe(signature);
    expect(reportSignature(report, VERDICT_Z_FROM.strict)).toBe(signature);
    expect(reportSignature(null)).toBe("off");
    expect(reportSignature({ ...report })).toBe(signature);
    expect(reportSignature({ ...report, toTs: T + 31 * MINUTE })).not.toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, buys: 5 } })).not.toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, coveredMs: 20 * MINUTE } })).toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, missing: [[T, T + 2 * MINUTE]] } })).toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, missing: [[T, T + 3 * MINUTE]] } })).not.toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, minutesWon: { buyers: 4, sellers: 0 } } })).not.toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, noise: 0.6 } })).not.toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, noise: 2.9 } })).toBe(signature);
    expect(reportSignature({ ...report, loading: true })).not.toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, impact: { buyers: { moved: 1, volume: 1 }, sellers: { moved: 0, volume: 0 } } } })).not.toBe(signature);
    expect(reportSignature({ ...report, read: { ...READ, minutesWon: { buyers: 2, sellers: 2 } } })).not.toBe(signature);
    expect(reportSignature({ ...report, prints: noPrints(5, "BTC") })).not.toBe(signature);
    expect(reportSignature({ ...report, read: null })).not.toBe(signature);
    expect(reportSignature({ ...report, live: true })).toBe(signature);
    const live: LiveRangeReport = { ...report, mode: "live", live: true };
    const zoned = reportSignature(live);
    expect(zoned).not.toBe(signature);
    expect(reportSignature({ ...live, live: false })).not.toBe(zoned);
    expect(reportSignature({ ...live, mode: "selected" })).not.toBe(zoned);
  });

  it("asks the host for the hours on screen before the oldest column of the runtime, folds what lands into the trades of the card, sums what it holds again when the screen moves without asking again, and stops asking once the history is taken away", () => {
    vi.useFakeTimers();
    const { sent, stream } = btcStream();
    const { primitive, view, last, now } = harness();
    const history = new LiveRangeHistory(stream, () => primitive.readNow());
    const deep = [column(now() - 30_000, 7), column(now() - 20_000, 2)];
    primitive.setHistory(history);
    primitive.setGrid(grid([column(now() - 10_000, 3)], now(), deep));
    primitive.setShown(true);
    expect(sent).toHaveLength(1);
    expect([sent[0].fromTs, sent[0].toTs, sent[0].levelMs]).toEqual([T, now() - 31_000, STREAM_LEVEL_MS]);
    expect([last()?.read?.buys, last()?.read?.coveredMs]).toEqual([12, 21_000]);
    const outside: LiquidityColumn = { ts: T + 60_000, lo: 90, hi: 92, bid: Float64Array.from([5, 5, 5]), ask: Float64Array.from([5, 5, 5]), buy: [[91, 50]] };
    stream.accept(sent[0].requestId, hostPage(sent[0], [column(T + 30_000, 4), column(T + 40_000, 6), outside, column(now() - 40_000, 4)]));
    expect(last()?.read?.buys).toBe(76);
    expect(last()?.read?.coveredMs).toBe(61_000);
    expect(sent).toHaveLength(1);
    view.range = { from: 2, to: 9 };
    primitive.readNow();
    expect(last()?.read?.buys).toBe(16);
    expect(sent).toHaveLength(1);
    view.range = { from: 0, to: 9 };
    primitive.readNow();
    expect(last()?.read?.buys).toBe(76);
    primitive.setHistory(null);
    expect(last()?.read?.buys).toBe(12);
    view.range = { from: 0, to: 5 };
    primitive.readNow();
    expect(sent).toHaveLength(1);
  });

  it("tells the card which part of a zone neither the runtime nor the host recorded where the chart has candles: a 60-minute zone with only its first 10 minutes recorded holds the verdict and says so, and a closed market is not missing", () => {
    vi.useFakeTimers();
    const bars = (minutes: number[]) => minutes.map((m) => ({ time: ((T + m * MINUTE) / 1_000) as UTCTimestamp, open: 100, high: 100.05, low: 99.95, close: 100 }));
    const recorded = Array.from({ length: 60 }, (_, k) => column(T + 1_000 + 10_000 * k, k % 3 === 0 ? 2 : 1));
    const open = harness(bars(Array.from({ length: 70 }, (_, m) => m)), { from: 0, to: 69 }, SELECTED);
    open.setNow(T + 70 * MINUTE);
    open.primitive.setWindow({ fromMs: T, toMs: T + 60 * MINUTE });
    open.primitive.setGrid(grid([column(T + 70 * MINUTE - 1_000, 1)], T + 70 * MINUTE, recorded));
    open.primitive.setShown(true);
    const read = open.last()?.read ?? null;
    expect([read?.tradedMs, read?.missing]).toEqual([60 * MINUTE, [[T + 10 * MINUTE, T + 60 * MINUTE]]]);
    expect([verdictOf(read)?.text, rangeNote(read, "selected", open.last()?.loading)]).toEqual(["Not enough data", "No data for 02:10–03:00 UTC · 83 % of the range"]);
    const closed = harness(bars([...Array.from({ length: 12 }, (_, m) => m), ...Array.from({ length: 10 }, (_, m) => 60 + m)]), { from: 0, to: 21 }, SELECTED);
    closed.setNow(T + 70 * MINUTE);
    closed.primitive.setWindow({ fromMs: T, toMs: T + 60 * MINUTE });
    closed.primitive.setGrid(grid([column(T + 70 * MINUTE - 1_000, 1)], T + 70 * MINUTE, recorded));
    closed.primitive.setShown(true);
    const shut = closed.last()?.read ?? null;
    expect([shut?.tradedMs, shut?.missing]).toEqual([12 * MINUTE, [[T + 10 * MINUTE, T + 12 * MINUTE]]]);
    expect([verdictOf(shut)?.key, rangeNote(shut, "selected", false)]).toEqual(["buyers", "No data for 02:10–02:12 UTC · 17 % of the range"]);
  });

  it("lets the host's hours go once the zone moves away from them by more than its own length, an hour at least", () => {
    vi.useFakeTimers();
    const { sent, stream } = btcStream();
    const { primitive, now } = harness(candles(10), { from: 0, to: 9 }, SELECTED);
    const history = new LiveRangeHistory(stream, () => primitive.readNow());
    primitive.setHistory(history);
    primitive.setWindow({ fromMs: T - 5 * HOUR, toMs: T - 5 * HOUR + 10 * MINUTE });
    primitive.setGrid(grid([column(now() - 10_000, 3)], now(), [column(now() - 30_000, 7)]));
    primitive.setShown(true);
    for (const request of [...sent]) stream.accept(request.requestId, hostPage(request, [column(request.fromTs + MINUTE, 1)]));
    expect(history.columns(-Infinity, Infinity).map((c) => c.ts)).toEqual([T - 5 * HOUR + MINUTE]);
    primitive.setWindow({ fromMs: T - 4 * HOUR + 30 * MINUTE, toMs: T - 4 * HOUR + 40 * MINUTE });
    expect(history.columns(-Infinity, Infinity).map((c) => c.ts)).toEqual([T - 5 * HOUR + MINUTE]);
    primitive.setWindow({ fromMs: T - 2 * HOUR, toMs: T - 2 * HOUR + 10 * MINUTE });
    expect(history.columns(-Infinity, Infinity)).toEqual([]);
  });

  it("asks the host for a zone's hours oldest first, so the hours land in time order, and for the hours on screen newest first", () => {
    vi.useFakeTimers();
    const zone = btcStream();
    const { primitive, now } = harness(candles(10), { from: 0, to: 9 }, LIVE);
    primitive.setHistory(new LiveRangeHistory(zone.stream, () => primitive.readNow()));
    primitive.setWindow({ fromMs: T - 3 * 60 * MINUTE, toMs: null });
    primitive.setGrid(grid([column(now() - 10_000, 3)], now(), [column(now() - 30_000, 7)]));
    primitive.setShown(true);
    expect(zone.sent.map((r) => (r.fromTs - T) / (60 * MINUTE))).toEqual([-3, -2, -1, 0]);
    const screen = btcStream();
    const hours = Array.from({ length: 4 }, (_, i) => ({ time: ((T - 3 * 60 * MINUTE + i * 60 * MINUTE) / 1_000) as UTCTimestamp, open: 100, high: 100.05, low: 99.95, close: 100 }));
    const visible = harness(hours, { from: 0, to: 3 });
    visible.primitive.setHistory(new LiveRangeHistory(screen.stream, () => visible.primitive.readNow()));
    visible.primitive.setGrid(grid([column(now() - 10_000, 3)], now(), [column(now() - 30_000, 7)]));
    visible.primitive.setShown(true);
    expect(screen.sent.map((r) => (r.fromTs - T) / (60 * MINUTE))).toEqual([0, -1, -2, -3]);
  });

  it("says the range is loading while any hour it asked the host for is still out, and loaded once every one landed or the range needs none", () => {
    vi.useFakeTimers();
    const { sent, stream } = btcStream();
    const { primitive, last, now } = harness(candles(10), { from: 0, to: 9 }, SELECTED);
    primitive.setHistory(new LiveRangeHistory(stream, () => primitive.readNow()));
    primitive.setWindow({ fromMs: T - 2 * 60 * MINUTE, toMs: T + 5 * MINUTE });
    primitive.setGrid(grid([column(now() - 10_000, 3)], now(), [column(now() - 30_000, 7)]));
    primitive.setShown(true);
    expect(sent).toHaveLength(3);
    expect(last()?.loading).toBe(true);
    stream.accept(sent[0].requestId, hostPage(sent[0], [column(T - 115 * MINUTE, 4)]));
    stream.accept(sent[1].requestId, hostPage(sent[1], [column(T - 55 * MINUTE, 6)]));
    expect(last()?.loading).toBe(true);
    stream.accept(sent[2].requestId, hostPage(sent[2], [column(T + 2 * MINUTE, 5)]));
    expect([last()?.loading, last()?.read?.buys]).toEqual([false, 15]);
    primitive.setWindow({ fromMs: T - 4 * 60 * MINUTE, toMs: T + 5 * MINUTE });
    expect(last()?.loading).toBe(true);
    primitive.setWindow({ fromMs: T - 2 * 60 * MINUTE, toMs: T + 5 * MINUTE });
    expect(last()?.loading).toBe(false);
    const inside = harness(candles(10), { from: 9, to: 9 });
    inside.primitive.setHistory(new LiveRangeHistory(btcStream().stream, () => inside.primitive.readNow()));
    inside.primitive.setGrid(grid([column(inside.now() - 10_000, 3)], inside.now(), [column(T - 60 * MINUTE, 7)]));
    inside.primitive.setShown(true);
    expect(inside.last()?.loading).toBe(false);
    const alone = harness();
    alone.primitive.setShown(true);
    alone.primitive.setGrid(grid([column(alone.now() - 10_000, 3)], alone.now()));
    expect(alone.last()?.loading).toBe(false);
  });

  it("asks the host for the stretches of the window the runtime holds no column for, up to the runtime's newest column, loads while any of their hours is out, and fills them with the host's columns, never over a time the runtime holds", () => {
    vi.useFakeTimers();
    const { sent, stream } = btcStream();
    const { primitive, last, now } = harness();
    primitive.setHistory(new LiveRangeHistory(stream, () => primitive.readNow()));
    primitive.setGrid(grid([column(now() - 10_000, 3)], now(), [column(T + 2 * MINUTE, 7), column(now() - 30_000, 7)]));
    primitive.setShown(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].fromTs).toBeLessThanOrEqual(T);
    expect(sent[0].toTs).toBeGreaterThanOrEqual(now() - 31_000);
    expect([last()?.loading, last()?.read?.buys]).toEqual([true, 17]);
    stream.accept(sent[0].requestId, hostPage(sent[0], [column(T + 30_000, 2), column(T + 3 * MINUTE, 5), column(now() - 30_000, 999)]));
    expect([last()?.loading, last()?.read?.buys]).toEqual([false, 24]);
    primitive.setGrid(grid([column(now() - 10_000, 3)], now(), [column(T + 2 * MINUTE, 7), column(T + 3 * MINUTE, 8), column(now() - 30_000, 7)]));
    expect([last()?.loading, last()?.read?.buys, sent.length]).toEqual([false, 27, 1]);
  });

  it("leaves a host page out when its rows are not those of the grid, and asks for nothing while the screen starts inside the columns of the runtime", () => {
    vi.useFakeTimers();
    const { sent, stream } = btcStream();
    const { primitive, view, last, now } = harness();
    primitive.setHistory(new LiveRangeHistory(stream, () => primitive.readNow()));
    primitive.setGrid(grid([column(now() - 10_000, 3)], now(), [column(now() - 30_000, 7)]));
    primitive.setShown(true);
    stream.accept(sent[0].requestId, hostPage(sent[0], [column(T + 30_000, 4)], 2));
    expect(last()?.read?.buys).toBe(10);
    view.range = { from: 9, to: 9 };
    primitive.readNow();
    expect(sent).toHaveLength(1);
    expect(last()?.read?.buys).toBeCloseTo(7 * 0.9 + 3, 12);
  });

  it("reads the big prints on screen from the threshold and in the unit it is given, every kept print without a threshold; a new unit alone changes nothing the card shows and is not reported", () => {
    vi.useFakeTimers();
    const { primitive, last, now } = harness(candles(10), { from: 0, to: 9 }, { ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 2 }, "BTC");
    expect(primitive.unit).toBe("BTC");
    primitive.setShown(true);
    const prints = [print(T + 5 * MINUTE + 100, 100, 2, "buy"), print(T + 5 * MINUTE + 200, 120, 3, "sell"), print(T + 5 * MINUTE + 300, 100, 1.5, "sell")];
    primitive.setGrid(grid([{ ...column(T + 5 * MINUTE + 1_000, 1), prints, printsFloor: 0.4 }], now()));
    expect(last()?.prints).toEqual({ buys: 2, sells: 3, buyCount: 1, sellCount: 1, threshold: 2, floor: 0.4, unit: "BTC" });
    primitive.setSettings({ ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 0 }, "ETH");
    expect(last()?.prints).toEqual({ buys: 2, sells: 4.5, buyCount: 1, sellCount: 2, threshold: 0, floor: 0.4, unit: "ETH" });
    primitive.setSettings(primitive.settings, "SOL");
    expect(last()?.prints?.unit).toBe("ETH");
  });
});

describe("LiveRangePrimitive drawing the zone", () => {
  it("draws nothing before it is attached, while hidden or in the visible range, and the zone in both zone modes", () => {
    const primitive = zonePrimitive(candles(10), LIVE);
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: null });
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
    attach(primitive);
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
    primitive.setShown(true);
    primitive.setSettings(DEFAULT_LIVE_RANGE_SETTINGS);
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
    primitive.setSettings(LIVE);
    primitive.updateAllViews();
    expect(primitive.lines).toEqual({ left: 15, right: 90, from: 15, to: null });
    primitive.setSettings(SELECTED);
    primitive.updateAllViews();
    expect(primitive.lines).toEqual({ left: 15, right: 90, from: 15, to: 90 });
  });

  it("draws no zone and offers no line to drag while the zone is switched off, in both zone modes, and draws it again once it is back on", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    expect(primitive.lines).toEqual({ left: 15, right: 45, from: 15, to: 45 });
    primitive.setSettings({ ...SELECTED, showZone: false });
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
    expect([primitive.lineAt(15, 100), primitive.lineAt(45, 100), primitive.hitTest(15, 100)]).toEqual([null, null, null]);
    primitive.setSettings({ ...LIVE, showZone: false });
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
    primitive.setSettings(LIVE);
    primitive.updateAllViews();
    expect(primitive.lines).toEqual({ left: 15, right: 90, from: 15, to: null });
    primitive.setSettings(SELECTED);
    primitive.updateAllViews();
    expect(primitive.lineAt(45, 100)).toBe("to");
  });

  it("reads the zone for the card while the zone is switched off, as when it is drawn", () => {
    vi.useFakeTimers();
    const { primitive, last, now } = harness(candles(10), { from: 0, to: 9 }, { ...SELECTED, showZone: false });
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    primitive.setShown(true);
    primitive.setGrid(grid([column(T + 3 * MINUTE + 1_000, 3), column(T + 6 * MINUTE + 1_000, 7)], now()));
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
    expect(last()).toMatchObject({ mode: "selected", fromTs: T + 2 * MINUTE, toTs: T + 5 * MINUTE, live: false });
    expect(last()?.read?.buys).toBe(3);
  });

  it("shades the zone between its two handles and puts a line on each, the end line at now while the end follows the clock", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    expect(primitive.lines).toEqual({ left: 15, right: 45, from: 15, to: 45 });
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: null });
    primitive.updateAllViews();
    expect(primitive.lines).toEqual({ left: 15, right: 90, from: 15, to: 90 });
  });

  it("in Live shades from the start line until now with no line at now, a fixed end left out", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE }, LIVE);
    expect(primitive.lines).toEqual({ left: 15, right: 90, from: 15, to: null });
  });

  it("places a moment inside its candle by the share of the candle that has run", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE + 30_000, toMs: T + 6 * MINUTE + 15_000 });
    expect(primitive.lines).toEqual({ left: 20, right: 57.5, from: 20, to: 57.5 });
  });

  it("starts at the edge of the last seven days with the whole window, far left of the candles the chart holds, and a start older than that rests at the edge", () => {
    const { primitive } = shownZone(WHOLE_WINDOW, LIVE);
    expect(primitive.lines).toEqual({ left: -100_715, right: 90, from: -100_715, to: null });
    primitive.setWindow({ fromMs: T - 8 * 24 * 60 * MINUTE, toMs: null });
    primitive.updateAllViews();
    expect(primitive.lines?.from).toBe(-100_715);
  });

  it("shades the zone in its colour at the zone opacity of the settings, a tenth by default, over the whole height of the pane, and only inside the pane", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE }, { ...SELECTED, zoneColor: RED });
    const shade = draw(primitive, 0);
    expect(calls(shade.ops)).toEqual([["fillRect", 15, 0, 30, 400]]);
    expect(shade.ops[0].fillStyle).toBe("rgba(255, 0, 0, 0.1)");
    primitive.setSettings({ ...SELECTED, zoneColor: RED, zoneOpacity: 25 });
    expect(draw(primitive, 0).ops[0].fillStyle).toBe("rgba(255, 0, 0, 0.25)");
    primitive.setSettings({ ...SELECTED, zoneColor: RED, zoneOpacity: 0 });
    expect(draw(primitive, 0).ops[0].fillStyle).toBe("rgba(255, 0, 0, 0.1)");
    expect(shade.stack).toHaveLength(0);
    expect(calls(draw(primitive, 0, recorder({}, { width: 30, height: 200 })).ops)).toEqual([["fillRect", 15, 0, 16, 200]]);
    expect(draw(primitive, 0, recorder({}, { width: 10, height: 200 })).ops).toEqual([]);
    expect(calls(draw(shownZone(WHOLE_WINDOW, LIVE).primitive, 0).ops)).toEqual([["fillRect", -1, 0, 91, 400]]);
    expect(draw(shownZone({ fromMs: T - 60 * MINUTE, toMs: T - 30 * MINUTE }).primitive, 0).ops).toEqual([]);
  });

  it("strokes each line in the zone colour over the whole height, solid over a dash left on the canvas, the active one thicker, and leaves the canvas as it found it", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE }, { ...SELECTED, zoneColor: RED });
    const canvas = draw(primitive, 1, recorder(LEFT_ON_CANVAS));
    expect(calls(canvas.ops)).toEqual([["beginPath"], ["moveTo", 15, 0], ["lineTo", 15, 400], ["stroke"], ["beginPath"], ["moveTo", 45, 0], ["lineTo", 45, 400], ["stroke"]]);
    expect(canvas.ops.filter((op) => op.op === "stroke").map((op) => [op.strokeStyle, op.lineWidth, op.dash])).toEqual([[RED, 1.5, []], [RED, 1.5, []]]);
    expect(canvas.state()).toEqual(LEFT_ON_CANVAS);
    expect(canvas.stack).toHaveLength(0);
    primitive.hoverLine("to");
    expect(draw(primitive, 1).ops.filter((op) => op.op === "stroke").map((op) => op.lineWidth)).toEqual([LINE_WIDTH_PX, ACTIVE_LINE_WIDTH_PX]);
    expect([LINE_WIDTH_PX, ACTIVE_LINE_WIDTH_PX]).toEqual([1.5, 3]);
    const live = shownZone({ fromMs: T + 2 * MINUTE, toMs: null }, LIVE).primitive;
    expect(calls(draw(live, 1).ops)).toEqual([["beginPath"], ["moveTo", 15, 0], ["lineTo", 15, 400], ["stroke"]]);
  });

  it("draws nothing at all without lines", () => {
    const primitive = new LiveRangePrimitive(() => candles(10));
    expect([draw(primitive, 0).ops, draw(primitive, 1).ops]).toEqual([[], []]);
  });

  it("drops the lines as soon as it is hidden or detached", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    expect(primitive.lines).not.toBeNull();
    primitive.setShown(false);
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
    expect([draw(primitive, 0).ops, draw(primitive, 1).ops]).toEqual([[], []]);
    primitive.setShown(true);
    primitive.updateAllViews();
    expect(primitive.lines).not.toBeNull();
    primitive.hoverLine("from");
    primitive.detached();
    expect([primitive.lines, primitive.activeLine]).toEqual([null, null]);
  });

  it("paints the shading under the candles and the lines above them, with views that stay the same", () => {
    const primitive = new LiveRangePrimitive(() => candles(3));
    const views = primitive.paneViews();
    expect(views.map((view) => view.zOrder?.())).toEqual(["bottom", "top"]);
    expect(primitive.paneViews()).toBe(views);
  });

  it("takes its settings, window and visibility before it is attached, and asks the chart to repaint after each once it is", () => {
    vi.useFakeTimers();
    const primitive = zonePrimitive(candles(10), LIVE);
    primitive.setWindow({ fromMs: T, toMs: null });
    primitive.setShown(true);
    primitive.setShown(false);
    const { requestUpdate } = attach(primitive);
    requestUpdate.mockClear();
    primitive.setShown(true);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    primitive.setWindow({ fromMs: T + MINUTE, toMs: null });
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    primitive.setWindow({ fromMs: T + MINUTE, toMs: null });
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    primitive.setSettings({ ...LIVE, zoneColor: RED });
    expect([requestUpdate.mock.calls.length, primitive.zoneColor]).toEqual([3, RED]);
    primitive.setSettings(primitive.settings, "BTC");
    expect(requestUpdate).toHaveBeenCalledTimes(4);
    primitive.setSettings(primitive.settings, "BTC");
    expect(requestUpdate).toHaveBeenCalledTimes(4);
    primitive.setShown(false);
    expect(requestUpdate).toHaveBeenCalledTimes(5);
  });
});

describe("LiveRangePrimitive lines under the pointer", () => {
  it("finds the line within reach of the pointer over the price pane, and none below the pane, while hidden, in the visible range or detached", () => {
    const { primitive, view } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    expect(primitive.lineAt(15, 100)).toBe("from");
    expect(primitive.lineAt(21, 100)).toBe("from");
    expect(primitive.lineAt(9, 100)).toBe("from");
    expect(primitive.lineAt(22, 100)).toBeNull();
    expect(primitive.lineAt(45, 0)).toBe("to");
    expect(primitive.lineAt(45, 400)).toBe("to");
    expect(primitive.lineAt(45, 401)).toBeNull();
    expect(primitive.lineAt(45, -1)).toBeNull();
    view.height = 300;
    expect(primitive.lineAt(45, 350)).toBeNull();
    primitive.setShown(false);
    expect(primitive.lineAt(15, 100)).toBeNull();
    primitive.setShown(true);
    primitive.setSettings(DEFAULT_LIVE_RANGE_SETTINGS);
    primitive.updateAllViews();
    expect(primitive.lineAt(15, 100)).toBeNull();
    primitive.detached();
    expect(primitive.lineAt(15, 100)).toBeNull();
  });

  it("gives the chart a resize cursor over a line through its hit test, and nothing elsewhere", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    expect(primitive.hitTest(17, 50)).toEqual({ cursorStyle: "ew-resize", externalId: "live-range-from", zOrder: "top", distance: 2, hitTestPriority: 1 });
    expect(primitive.hitTest(44, 50)).toEqual({ cursorStyle: "ew-resize", externalId: "live-range-to", zOrder: "top", distance: 1, hitTestPriority: 1 });
    expect(primitive.hitTest(30, 50)).toBeNull();
    expect(primitive.hitTest(15, 500)).toBeNull();
  });

  it("thickens the hovered line and asks for a repaint only when the hover changes", () => {
    const { primitive, requestUpdate } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    requestUpdate.mockClear();
    primitive.hoverLine("from");
    expect([primitive.activeLine, requestUpdate.mock.calls.length]).toEqual(["from", 1]);
    primitive.hoverLine("from");
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    primitive.hoverLine(null);
    expect([primitive.activeLine, requestUpdate.mock.calls.length]).toEqual([null, 2]);
  });
});

describe("LiveRangePrimitive dragging the lines", () => {
  it("moves the start line to the minute under the pointer and the end line likewise, pushing the other along a minute apart, and repaints without reading until the drag ends", () => {
    const { primitive, requestUpdate } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    const reads: (LiveRangeReport | null)[] = [];
    primitive.onRead = (report) => reads.push(report);
    requestUpdate.mockClear();
    expect(primitive.dragTo("from", 32)).toEqual({ fromMs: T + 4 * MINUTE, toMs: T + 5 * MINUTE });
    expect([primitive.window, primitive.activeLine, requestUpdate.mock.calls.length]).toEqual([{ fromMs: T + 4 * MINUTE, toMs: T + 5 * MINUTE }, "from", 1]);
    primitive.updateAllViews();
    expect(primitive.lines).toEqual({ left: 35, right: 45, from: 35, to: 45 });
    expect(primitive.dragTo("from", 60)).toEqual({ fromMs: T + 4 * MINUTE, toMs: T + 5 * MINUTE });
    expect(primitive.dragTo("to", 72)).toEqual({ fromMs: T + 4 * MINUTE, toMs: T + 8 * MINUTE });
    expect(primitive.dragTo("to", 10)).toEqual({ fromMs: T + MINUTE, toMs: T + 2 * MINUTE });
    expect(reads).toEqual([]);
    expect(primitive.endDrag()).toEqual({ fromMs: T + MINUTE, toMs: T + 2 * MINUTE });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ mode: "selected", fromTs: T + MINUTE, toTs: T + 2 * MINUTE, live: false });
    expect(primitive.activeLine).toBeNull();
  });

  it("lets the end line go to now, where it follows the clock again, and the start line back to the edge of the seven days", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    expect(primitive.dragTo("to", 95)).toEqual({ fromMs: T + 2 * MINUTE, toMs: null });
    expect(primitive.dragTo("from", -20_000)).toEqual({ fromMs: T - 1_999 * MINUTE, toMs: null });
    expect(primitive.dragTo("from", -200_000)).toEqual({ fromMs: null, toMs: null });
  });

  it("moves only the start in Live and drops a fixed end", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE }, LIVE);
    expect(primitive.dragTo("from", 62)).toEqual({ fromMs: T + 7 * MINUTE, toMs: null });
  });

  it("moves nothing in the visible range or once detached", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE }, DEFAULT_LIVE_RANGE_SETTINGS);
    expect(primitive.dragTo("from", 32)).toBeNull();
    expect(primitive.window).toEqual({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    const zone = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE }).primitive;
    zone.detached();
    expect(zone.dragTo("from", 32)).toBeNull();
    expect(zone.window).toEqual({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
  });

  it("keeps the dragged line thick and ignores hovering while the drag lasts", () => {
    const { primitive } = shownZone({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    primitive.dragTo("from", 32);
    primitive.hoverLine("to");
    expect(primitive.activeLine).toBe("from");
    primitive.hoverLine(null);
    expect(primitive.activeLine).toBe("from");
    primitive.endDrag();
    expect(primitive.activeLine).toBeNull();
    primitive.hoverLine("to");
    expect(primitive.activeLine).toBe("to");
  });
});

describe("LiveRangePrimitive reads in the zone modes", () => {
  it("reads the live zone from the start handle until now, every trade and big print in it at any price, wherever the chart is scrolled", () => {
    vi.useFakeTimers();
    const { primitive, view, last, now } = harness(candles(10), { from: 0, to: 9 }, { ...LIVE, bigPrint: 2 }, "BTC");
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: null });
    primitive.setShown(true);
    primitive.setGrid(grid([
      { ...column(T + MINUTE + 1_000, 50), prints: [print(T + MINUTE + 500, 100, 9, "buy")] },
      { ...column(T + 3 * MINUTE + 1_000, 3), prints: [print(T + 3 * MINUTE + 500, 100, 2, "buy"), print(T + 3 * MINUTE + 600, 100, 1.5, "sell"), print(T + 3 * MINUTE + 700, 102, 4, "sell")] },
      column(T + 4 * MINUTE + 1_000, 7, 101),
    ], now()));
    expect(last()).toMatchObject({ mode: "live", fromTs: T + 2 * MINUTE, toTs: now(), live: true });
    expect(last()?.read?.buys).toBe(10);
    expect(last()?.prints).toEqual({ buys: 2, sells: 4, buyCount: 1, sellCount: 1, threshold: 2, floor: null, unit: "BTC" });
    expect(last()?.read?.minutesWon).toEqual({ buyers: 2, sellers: 0 });
    expect(last()?.read?.impact).toEqual({ buyers: { moved: 101 - 100, volume: 7 }, sellers: { moved: 0, volume: 0 } });
    expect(last()?.loading).toBe(false);
    view.range = { from: 0, to: 1 };
    primitive.updateAllViews();
    primitive.readNow();
    expect(last()).toMatchObject({ fromTs: T + 2 * MINUTE, toTs: now() });
    expect(primitive.span()).toEqual({ fromTs: T + 2 * MINUTE, toTs: now() });
  });

  it("grows the live zone with the clock, a new end each second the card would show it", () => {
    vi.useFakeTimers();
    const { primitive, last, setNow } = harness(candles(12), { from: 0, to: 11 }, LIVE);
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: null });
    primitive.setShown(true);
    expect(last()?.toTs).toBe(NOW);
    setNow(T + 10 * MINUTE + 40_000);
    vi.advanceTimersByTime(LIVE_TICK_MS);
    expect(last()).toMatchObject({ fromTs: T + 2 * MINUTE, toTs: T + 10 * MINUTE + 40_000, live: true });
  });

  it("reads between the two handles in the selected zone and ends there, and runs on to now once the mode is Live", () => {
    vi.useFakeTimers();
    const { primitive, last, now } = harness(candles(10), { from: 0, to: 9 }, SELECTED);
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: T + 5 * MINUTE });
    primitive.setShown(true);
    primitive.setGrid(grid([column(T + 3 * MINUTE + 1_000, 3), column(T + 6 * MINUTE + 1_000, 7)], now()));
    expect(last()).toMatchObject({ mode: "selected", fromTs: T + 2 * MINUTE, toTs: T + 5 * MINUTE, live: false });
    expect(last()?.read?.buys).toBe(3);
    primitive.setSettings(LIVE);
    expect(last()).toMatchObject({ mode: "live", fromTs: T + 2 * MINUTE, toTs: now(), live: true });
    expect(last()?.read?.buys).toBe(10);
  });

  it("reads its window from the columns without a single candle, the lines waiting for the candles", () => {
    vi.useFakeTimers();
    const { primitive, last } = harness([], { from: 0, to: 9 }, LIVE);
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: null });
    primitive.setShown(true);
    primitive.setGrid(grid([column(T + 3 * MINUTE + 1_000, 3)], NOW));
    expect(last()).toMatchObject({ mode: "live", fromTs: T + 2 * MINUTE, toTs: NOW, live: true });
    expect(last()?.read?.buys).toBe(3);
    primitive.updateAllViews();
    expect(primitive.lines).toBeNull();
  });

  it("starts the card at the start handle, before every candle the chart holds too", () => {
    vi.useFakeTimers();
    const { primitive, last } = harness(candles(10), { from: 0, to: 9 }, LIVE);
    primitive.setWindow({ fromMs: T - 30 * MINUTE, toMs: null });
    primitive.setShown(true);
    expect(last()?.fromTs).toBe(T - 30 * MINUTE);
  });

  it("does nothing when the window is set to the handles it already has", () => {
    vi.useFakeTimers();
    const { primitive, reports, requestUpdate } = harness(candles(10), { from: 0, to: 9 }, LIVE);
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: null });
    primitive.setShown(true);
    const count = reports.length;
    requestUpdate.mockClear();
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: null });
    expect([reports.length, requestUpdate.mock.calls.length]).toEqual([count, 0]);
    primitive.setWindow({ fromMs: T + 2 * MINUTE, toMs: T + 8 * MINUTE });
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });
});
