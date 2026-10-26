import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { historicalL2, type IndicatorL2 } from "../../../chart/indicatorL2";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import { INDICATOR_REGISTRY, historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../../../chart/indicatorTypes";
import { createIndicatorRuntime } from "../../../chart/indicatorRuntime";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import type { BoxData } from "../../../chart/draw/box";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import { HISTORY_CHUNK_MS, MAX_CHUNK_ATTEMPTS } from "../../absorption-detector/engineAbsorption";
import type { L2HistoryRange } from "../../../l2/history";
import type { L2Event } from "../../../l2/types";
import { withAlpha } from "../../classic-order-blocks/orderBlockRender";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { BOOK_COLOR, BOOK_LABEL, BOOK_UNKNOWN, HISTORY_HELD_RETRY_MS, HISTORY_RETRY_MS, MAX_HISTORY_SLOTS, VOID_STATUS_TEXT, historySlotFor, liquidityVoidsIndicator, resetHistorySlotsForTests, type LiquidityVoidsState } from "../liquidityVoidsIndicator";
import type { TableData } from "../../../chart/draw/table";
import { VOID_BORDER_ALPHA, VOID_FILL_ALPHA } from "../liquidityVoidsRender";
import { NO_CARD, ZONE_TEXT } from "../../institutional-order-blocks/institutionalRender";
import { DEFAULT_LIQUIDITY_VOIDS_SETTINGS, type LiquidityVoidsSettings } from "../liquidityVoidsRules";
import { liveSweeps, stepSweeps } from "../sweepModel";
import { resetPastSlotsForTests } from "../voidsPast";
import { ColumnHistoryStream, STREAM_LEVEL_MS } from "../../passive-liquidity/columnHistoryStream";
import type { HistoryRequest } from "../../passive-liquidity/heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage } from "../../passive-liquidity/heatmapHistoryDecode";

vi.mock("../sweepModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sweepModel")>();
  return { ...actual, stepSweeps: vi.fn(actual.stepSweeps) };
});

const T0 = 1_700_000_011_000;
const S = 1_000;
const STEP = 60 * S;
const ROW = 4;
const SETTINGS: LiquidityVoidsSettings = { ...DEFAULT_LIQUIDITY_VOIDS_SETTINGS, sensitivity: "high" };

function makeBar(ts_open: number, close = 4_004, closed = true): BarFrame {
  return { type: "bar", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", interval_ms: STEP, ts_open, open: close, high: close + ROW, low: close - ROW, close, volume: 100, trade_count: 10, closed };
}

function column(ts: number, bidRow: number, flow: readonly (readonly [number, number])[] = []): LiquidityColumn {
  const lo = bidRow - 40;
  const hi = bidRow + 41;
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  bid[bidRow - lo] = 5;
  ask[bidRow + 1 - lo] = 5;
  return { ts, lo, hi, bid, ask, buy: flow.map(([row, size]) => [row, size / 2] as const), sell: flow.map(([row, size]) => [row, size / 2] as const) };
}

function spread(rowLo: number, rowHi: number, perRow: number): [number, number][] {
  const out: [number, number][] = [];
  for (let row = rowLo; row <= rowHi; row += 1) out.push([row, perRow]);
  return out;
}

/** Appends a column; the trades that moved price into it printed during the previous column's window, so they go on that column. */
function pushMove(out: LiquidityColumn[], next: LiquidityColumn): void {
  const previous = out[out.length - 1];
  if (previous !== undefined) {
    previous.buy = [...(previous.buy ?? []), ...(next.buy ?? [])];
    previous.sell = [...(previous.sell ?? []), ...(next.sell ?? [])];
    next.buy = [];
    next.sell = [];
  }
  out.push(next);
}

/** 240 s of a slow drift (one row every ten seconds) printing 10 per row crossed, then a 30 s move of `rows` rows printing `perRow`, then `holdS` seconds flat. */
function columnsOf(from: number, rows: number, perRow: number, holdS = 0, direction: 1 | -1 = 1, startRow = 1000): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  let ts = from;
  let row = startRow;
  for (let i = 0; i < 240; i += 1) {
    const next = row + (i % 10 === 0 ? (Math.floor(i / 60) % 2 === 0 ? 1 : -1) : 0);
    pushMove(out, column(ts, next, spread(Math.min(row, next), Math.max(row, next), 10)));
    row = next;
    ts += S;
  }
  let previous = row;
  for (let i = 1; i <= 30; i += 1) {
    const at = row + direction * Math.round((rows * i) / 30);
    const flow = at === previous ? [] : spread(Math.min(previous, at) + (direction > 0 ? 1 : 0), Math.max(previous, at) - (direction > 0 ? 0 : 1), perRow);
    pushMove(out, column(ts, at, flow));
    previous = at;
    ts += S;
  }
  for (let i = 0; i < holdS; i += 1) {
    out.push(column(ts, previous));
    ts += S;
  }
  return out;
}

function feedOf(columns: LiquidityColumn[], epoch = 1): ColumnFeed {
  return { epoch, deep: null, fine: { columns, columnMs: S } };
}

function liquidityOf(feed: ColumnFeed, rowWidth = ROW): IndicatorLiquidity {
  return { get feed() { return feed; }, rowWidth, baseAsset: "BTC", version: 1 };
}

/** An engine that has not sent a frame yet: no events, no coverage. */
function l2Blind(feed: ColumnFeed, trusted = true): IndicatorL2 {
  return {
    availability: "LIVE", version: 1, status: () => ({ synced: trusted, seq: 1, lastTs: null, lastFrameAt: null }), segment: () => null, trusted: () => trusted,
    lanes: () => [], view: (lane) => (lane === 0 ? feed : null), laneFor: () => 0, walls: () => [], wall: () => null,
    events: () => ({ seq: 0, events: [], missed: 0, complete: false }), ladder: () => null, wallHistory: async () => null, eventHistory: async () => null, hostWalls: null,
  };
}

/** An engine whose trade events are the feed's own prints, covering every column. */
function l2Of(feed: ColumnFeed, trusted = true): IndicatorL2 {
  const last = feed.fine.columns[feed.fine.columns.length - 1];
  return l2With(feed, eventsOf(feed.fine.columns), last === undefined ? 0 : last.ts + feed.fine.columnMs, undefined, trusted);
}

function eventsOf(columns: readonly LiquidityColumn[]): L2Event[] {
  return columns.flatMap((c) => [
    ...(c.buy ?? []).map(([row, size]) => ({ kind: "trade" as const, ts: c.ts, side: "ask" as const, aggressor: "buy" as const, mode: "swept" as const, price: row * ROW + ROW / 2, size, late: false })),
    ...(c.sell ?? []).map(([row, size]) => ({ kind: "trade" as const, ts: c.ts, side: "bid" as const, aggressor: "sell" as const, mode: "swept" as const, price: row * ROW + ROW / 2, size, late: false })),
  ]);
}

function l2With(feed: ColumnFeed, events: L2Event[], lastTs: number, eventHistory: IndicatorL2["eventHistory"] = async () => null, trusted = true): IndicatorL2 {
  return { ...l2Blind(feed, trusted), status: () => ({ synced: trusted, seq: 1, lastTs, lastFrameAt: lastTs }), events: (since) => ({ seq: events.length + 1, events: since === events.length + 1 ? [] : events, missed: 0, complete: true }), eventHistory };
}

function printedInto(columns: readonly LiquidityColumn[], side: "buy" | "sell", box: { rowLo: number; rowHi: number; startTs: number; endTs: number }): number {
  return columns.filter((c) => c.ts > box.startTs && c.ts <= box.endTs).flatMap((c) => c[side] ?? []).filter(([row]) => row >= box.rowLo && row <= box.rowHi).reduce((sum, [, size]) => sum + size, 0);
}

function context(state: LiquidityVoidsState, bar: BarFrame, settings: LiquidityVoidsSettings, liquidity?: IndicatorLiquidity, l2?: IndicatorL2, drawNow = true): IndicatorBarCtx<LiquidityVoidsState, LiquidityVoidsSettings> {
  return { bar, trades: [], tradeAvailability: "LIVE_COMPLETE", liquidity, l2, state, settings, replace: false, replaying: false, drawNow, ta: {}, draw: { fill: vi.fn() }, markers: { plotshape: vi.fn(), plotchar: vi.fn() }, pane: { paneIndex: 0 } };
}

function hostLane() {
  const sent: HistoryRequest[] = [];
  const stream = new ColumnHistoryStream({ request: (request) => sent.push(request), maxInFlight: 2 });
  stream.setIdentity({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTCUSDT" });
  return { stream, sent };
}

function hostPage(request: HistoryRequest, columns: readonly LiquidityColumn[]): DecodedHistoryPage {
  const byWindow = new Map<number, LiquidityColumn[]>();
  for (const c of columns) {
    if (c.ts < request.fromTs || c.ts >= request.toTs) continue;
    const ts = Math.floor(c.ts / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS;
    const list = byWindow.get(ts) ?? [];
    list.push(c);
    byWindow.set(ts, list);
  }
  const windows = [...byWindow.entries()].sort((a, b) => a[0] - b[0]).map(([ts, list]) => ({ ts, state: "COVERED" as const, columns: list }));
  return { available: true, generation: "g", levelMs: STREAM_LEVEL_MS, rowFactor: 1, rowWidth: ROW, span: { oldest: null, newest: null }, next: null, windows };
}

function stateFor(settings: LiquidityVoidsSettings, ownerId: string): LiquidityVoidsState {
  return withDrawOwnerScope(ownerId, () => withStreamCreationWindow(() => liquidityVoidsIndicator.createState(settings)));
}

function createState(settings: LiquidityVoidsSettings, ownerId: string): LiquidityVoidsState {
  resetDrawRegistryForTests();
  resetHistorySlotsForTests();
  resetPastSlotsForTests();
  return withDrawOwnerScope(ownerId, () => withStreamCreationWindow(() => liquidityVoidsIndicator.createState(settings)));
}

function bookCells(ownerId: string): { position: string; label: string; text: string; color: string } {
  const record = handlesForOwners([ownerId]).find((candidate) => candidate.kind === "table");
  if (record === undefined) throw new Error("no table");
  const data = record.data as TableData;
  return { position: data.position, label: data.pendingGrid["0,0"]?.text ?? "", text: data.pendingGrid["0,1"]?.text ?? "", color: data.pendingGrid["0,1"]?.textColor ?? "" };
}

function drawnBoxes(ownerId: string): BoxData[] {
  return handlesForOwners([ownerId]).filter((record) => record.kind === "box").map((record) => record.data as BoxData).filter((box) => box.time1 !== 0);
}

const SWEEP_END = T0 + 270 * S;

describe("liquidityVoidsIndicator", () => {
  it("offers Sensitivity in place of Zone Width, no maximum traded toggle, and the maximum's size only as a slider under Learned", () => {
    const schema = liquidityVoidsIndicator.settingsSchema ?? [];
    const keys = schema.map((field) => ("key" in field ? field.key : undefined));
    expect(keys[0]).toBe("sensitivity");
    const sensitivity = liquidityVoidsIndicator.settingsSchema?.[0];
    expect(sensitivity && sensitivity.kind === "radioGroup" ? sensitivity.options.map((option) => [option.value, option.label]) : null).toEqual([["low", "Low"], ["normal", "Normal"], ["high", "High"]]);
    expect(keys).not.toContain("tradedFilter");
    expect(keys).not.toContain("zoneWidthByInstrument");
    const size = schema.find((field) => "key" in field && field.key === "maxTradedByInstrument");
    expect(size?.visibleIf?.(SETTINGS)).toBe(false);
  });

  it("is an L2 overlay and refuses a historical chart without qualified depth", () => {
    expect(liquidityVoidsIndicator).toMatchObject({ kind: "runtime", id: "liquidityVoids", label: "Flowprint Blocks", category: "l2", lines: [], placement: { kind: "overlay" } });
    const ids = INDICATOR_REGISTRY.map((def) => def.id);
    expect(ids.indexOf("liquidityVoids")).toBeGreaterThan(ids.indexOf("passiveLiquidity"));
    expect(historicalIndicatorAvailability("liquidityVoids", new Set(["ohlcv", "buy_volume", "trade_families"]), "BINANCE")).toEqual({
      available: false,
      reason: "Needs published, verified historical L2 states for this instrument. Zoom to an available August 2026 hour.",
    });
  });

  it("draws a move as a box over the swept rows, from the move's start, with the side, the move in dollars, the aggressive volume and the age in its corner", () => {
    const state = createState(SETTINGS, "sweep");
    const feed = feedOf(columnsOf(T0, 8, 1));
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2Of(feed)));
    const boxes = drawnBoxes("sweep");
    expect(boxes).toHaveLength(1);
    expect(state.sweep.boxes[0].volume).toBeGreaterThan(0);
    expect(boxes[0]).toMatchObject({
      price1: 1009 * ROW,
      price2: 1001 * ROW,
      time1: SWEEP_END,
      time2: SWEEP_END,
      borderColor: withAlpha(SETTINGS.askColor, VOID_BORDER_ALPHA),
      backgroundColor: withAlpha(SETTINGS.askColor, VOID_FILL_ALPHA),
      text: "FPB Ask · 0m",
      textFallbacks: ["FPB Ask"],
      textColor: ZONE_TEXT,
      textBackground: NO_CARD,
      textAccent: "",
      textAlign: "right",
      textVAlign: "bottom",
      keepTextClear: true,
    });
    expect(state.shownStatus).toBeNull();
  });

  it("re-applies the closes it saw when it re-steps the columns after the event history lands, so a mitigated box stays mitigated", async () => {
    const state = createState(SETTINGS, "restep");
    const printed = columnsOf(T0, 8, 1, 120);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    const live = eventsOf(printed.slice(60));
    const trades = [{ ts: T0, columnMs: S, row: 1000, aggressor: "buy" as const, mode: "swept" as const, size: 1, count: 1 }];
    const l2 = l2With(feed, live, SWEEP_END + 120 * S, async () => ({ rowWidth: ROW, trades, wallTrades: [], next: null, heldFrom: 0 }));
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END - STEP), SETTINGS, liquidityOf(feed), l2, false));
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END, 998 * ROW), SETTINGS, liquidityOf(feed), l2));
    expect(drawnBoxes("restep")).toHaveLength(0);
    expect(state.sweep.boxes[0].endedBy).toBe("mitigated");
    await new Promise((resolve) => setTimeout(resolve, 0));
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + STEP, 1012 * ROW, false), SETTINGS, liquidityOf(feed), l2));
    expect(state.coveredFrom).toBe(T0);
    expect(state.sweep.boxes[0].endedBy).toBe("mitigated");
    expect(drawnBoxes("restep")).toHaveLength(0);
  });

  it("puts the box edges on bar times, since the chart drops any other time: the left edge on the bar holding the sweep's start, the right on the live bar", () => {
    const state = createState(SETTINGS, "bar-times");
    const feed = feedOf(columnsOf(T0, 8, 1));
    for (let i = 5; i >= 1; i -= 1) liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END - i * STEP), SETTINGS, liquidityOf(feed), l2Of(feed), false));
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2Of(feed)));
    const box = state.sweep.boxes.find((candidate) => candidate.endedAt === null);
    expect(box?.startTs).toBeGreaterThan(SWEEP_END - STEP);
    expect(box?.startTs).toBeLessThan(SWEEP_END);
    const drawn = drawnBoxes("bar-times");
    expect(drawn).toHaveLength(1);
    expect(drawn[0].time1).toBe(SWEEP_END - STEP);
    expect(drawn[0].time2).toBe(SWEEP_END);
    expect(drawn[0].extendRight).toBe(true);
  });

  it("at load, reads every column the chart holds, so a sweep five hours old that no close has mitigated is drawn", () => {
    const later: LiquidityColumn[] = [];
    for (let i = 1; i <= 5 * 3_600; i += 1) later.push(column(SWEEP_END + i * S, 1012));
    const feed = feedOf([...columnsOf(T0, 8, 1), ...later]);
    const lastTs = SWEEP_END + 5 * 3_600 * S;
    const state = createState(SETTINGS, "whole");
    liquidityVoidsIndicator.onBar(context(state, makeBar(lastTs - 30 * S, 1012 * ROW), SETTINGS, liquidityOf(feed), l2Of(feed)));
    const boxes = drawnBoxes("whole");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].price2).toBe(1001 * ROW);
  });

  it("always hides a box traded above the instrument's maximum for the timeframe and a box whose volume is not known yet", () => {
    const heavy = feedOf(columnsOf(T0, 8, 10));
    const state = createState(SETTINGS, "heavy");
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(heavy), l2Of(heavy)));
    expect(state.sweep.boxes.some((box) => box.volume !== null && box.volume > 30)).toBe(true);
    expect(drawnBoxes("heavy")).toHaveLength(0);
    const light = feedOf(columnsOf(T0, 8, 6));
    const shown = createState(SETTINGS, "light");
    liquidityVoidsIndicator.onBar(context(shown, makeBar(SWEEP_END), SETTINGS, liquidityOf(light), l2Of(light)));
    expect(shown.sweep.boxes.every((box) => box.volume !== null && box.volume <= 30)).toBe(true);
    expect(drawnBoxes("light")).toHaveLength(1);
    const unknown = createState(SETTINGS, "unknown");
    liquidityVoidsIndicator.onBar(context(unknown, makeBar(SWEEP_END), SETTINGS, liquidityOf(light), l2With(light, [], SWEEP_END)));
    expect(unknown.sweep.boxes.every((box) => box.volume === null)).toBe(true);
    expect(drawnBoxes("unknown")).toHaveLength(0);
  });

  it("keeps showing a box whose columns the chart has dropped: its volume is unknown and can never be known", () => {
    const filtered = SETTINGS;
    const state = createState(filtered, "settled");
    const sweep = columnsOf(T0, 8, 1, 120);
    const feed = feedOf(sweep);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 60 * S), filtered, liquidityOf(feed), l2With(feed, [], SWEEP_END + 60 * S)));
    expect(state.sweep.boxes.map((box) => box.volume)).toEqual([null]);
    expect(drawnBoxes("settled")).toHaveLength(0);
    const trimmed = feedOf(sweep.slice(300), 2);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 120 * S), filtered, liquidityOf(trimmed), l2With(trimmed, [], SWEEP_END + 120 * S)));
    expect(state.sweep.boxes.map((box) => box.volume)).toEqual([null]);
    const texts = drawnBoxes("settled").map((box) => box.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("FPB Ask · 2m");
  });

  it("draws overlapping boxes with the smallest traded volume in the last slot, so it paints in front", () => {
    const first = columnsOf(T0, 8, 6, 40);
    const second = columnsOf(T0 + 330 * S, 8, 1, 40, 1, 1004);
    const feed = feedOf([...first, ...second]);
    const impulse = { ...SETTINGS };
    const state = createState(impulse, "front");
    liquidityVoidsIndicator.onBar(context(state, makeBar(T0 + 640 * S, 1016 * ROW), impulse, liquidityOf(feed), l2Of(feed)));
    const drawn = handlesForOwners(["front"]).filter((record) => record.kind === "box").map((record) => record.data as BoxData).filter((box) => box.time1 !== 0);
    expect(drawn.length).toBeGreaterThan(1);
    const byRows = new Map(liveSweeps(state.sweep).map((box) => [`${box.rowLo}:${box.rowHi}`, box.volume ?? Number.NaN]));
    const volumes = drawn.map((box) => byRows.get(`${Math.round(box.price2 / ROW)}:${Math.round(box.price1 / ROW) - 1}`) ?? Number.NaN);
    expect(volumes.every((volume) => Number.isFinite(volume))).toBe(true);
    for (let i = 1; i < volumes.length; i += 1) expect(volumes[i]).toBeLessThanOrEqual(volumes[i - 1]);
  });

  it("says it is waiting without the engine, unavailable in Historical Mode and untrusted on a bad feed, and draws no box then", () => {
    const feed = feedOf(columnsOf(T0, 8, 1));
    for (const [owner, l2, status] of [["no-l2", undefined, "waiting"], ["historical", historicalL2(), "historical"], ["untrusted", l2Blind(feed, false), "untrusted"]] as const) {
      const state = createState(SETTINGS, owner);
      liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2));
      expect(state.shownStatus).toBe(status);
      const boxes = drawnBoxes(owner);
      expect(boxes).toHaveLength(1);
      expect(boxes[0]).toMatchObject({ text: VOID_STATUS_TEXT[status], time1: SWEEP_END, price1: 4_004 });
    }
  });

  it("keeps the box across bars without re-reading old columns, and hides it once the feed goes stale", () => {
    const state = createState(SETTINGS, "stale");
    let reads = 0;
    const columns = columnsOf(T0, 8, 1).map((column) => new Proxy(column, { get: (target, key, receiver) => { if (key === "bid") reads += 1; return Reflect.get(target, key, receiver); } }));
    const feed = feedOf(columns);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2Of(feed)));
    const last = state.lastColumnTs;
    reads = 0;
    const steps = vi.mocked(stepSweeps).mock.calls.length;
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + STEP), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(state.lastColumnTs).toBe(last);
    expect(reads).toBeLessThan(20);
    expect(vi.mocked(stepSweeps).mock.calls.length).toBe(steps);
    expect(drawnBoxes("stale")).toHaveLength(1);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 12 * STEP), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(state.shownStatus).toBe("stale");
    expect(drawnBoxes("stale").map((box) => box.text)).toEqual([VOID_STATUS_TEXT.stale]);
  });

  it("shows the spread in the lower-right table as the price it takes to fill one bubble against the last hour, a wide spread a thin book and a tight one a thick book, with no ratio, and a dash before the engine", () => {
    // A book of twenty rows a side at 1000, each row holding perRow BTC; the bubble on BTC perp is 10 BTC, so it fills after ceil(10 / perRow) rows.
    const book = (ts: number, perRow: number): LiquidityColumn => {
      const c = column(ts, 1000);
      for (let i = 0; i < 20; i += 1) {
        c.bid[1000 - i - c.lo] = perRow;
        c.ask[1001 + i - c.lo] = perRow;
      }
      return c;
    };
    const state = createState(SETTINGS, "book");
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS));
    expect(bookCells("book")).toEqual({ position: "bottom-right", label: BOOK_LABEL, text: BOOK_UNKNOWN, color: BOOK_COLOR["normal book"] });
    const steady: LiquidityColumn[] = [];
    for (let i = 0; i < 120; i += 1) steady.push(book(T0 + i * S, 2));
    const wide = book(T0 + 120 * S, 1);
    const feed = feedOf([...steady, wide]);
    liquidityVoidsIndicator.onBar(context(state, makeBar(T0 + 120 * S), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(state.depth.samples.length).toBe(steady.length + 1);
    expect(bookCells("book")).toEqual({ position: "bottom-right", label: BOOK_LABEL, text: "$40 · thin book", color: BOOK_COLOR["thin book"] });
    const tight = book(T0 + 121 * S, 10);
    const tighter = feedOf([...steady, wide, tight]);
    liquidityVoidsIndicator.onBar(context(state, makeBar(T0 + 120 * S), SETTINGS, liquidityOf(tighter), l2Of(tighter)));
    expect(bookCells("book")).toEqual({ position: "bottom-right", label: BOOK_LABEL, text: "$4 · thick book", color: BOOK_COLOR["thick book"] });
    expect(bookCells("book").text.includes("×")).toBe(false);
  });

  it("draws a push from the host's stored columns, older than anything the chart holds, with its volume; a Zone Width change re-judges it without asking the host for that hour again; History 0 asks nothing and draws nothing from the past", () => {
    const { stream, sent } = hostLane();
    const past = columnsOf(T0, 8, 1, 120);
    const liveFrom = T0 + 600 * S;
    const live: LiquidityColumn[] = [];
    for (let i = 0; i < 120; i += 1) live.push(column(liveFrom + i * S, 1008));
    const feed = feedOf(live);
    const liquidity = { ...liquidityOf(feed), history: stream };
    const bar = makeBar(liveFrom + 60 * S, 1008 * ROW);
    const state = createState(SETTINGS, "past");
    const want = vi.spyOn(stream, "want");
    liquidityVoidsIndicator.onBar(context(state, bar, SETTINGS, liquidity, l2Of(feed)));
    expect(drawnBoxes("past")).toHaveLength(0);
    const seam = liveFrom + 120 * S;
    expect(want).toHaveBeenLastCalledWith(liveFrom - 48 * 3_600_000, seam, 0, 0);
    expect(sent).toHaveLength(2);
    expect(sent[0].toTs).toBe(seam);
    expect(sent[0].fromTs).toBeLessThan(T0);
    stream.accept(sent[0].requestId, hostPage(sent[0], past));
    liquidityVoidsIndicator.onBar(context(state, bar, SETTINGS, liquidity, l2Of(feed)));
    const boxes = drawnBoxes("past");
    expect(boxes).toHaveLength(1);
    expect([boxes[0].price1, boxes[0].price2]).toEqual([1009 * ROW, 1001 * ROW]);
    const found = liveSweeps(state.past as NonNullable<typeof state.past>);
    expect(found[0].volume).toBeGreaterThan(0);
    expect(boxes[0].text).toBe("FPB Ask · 7m");
    liquidityVoidsIndicator.onBar(context(state, makeBar(liveFrom + 120 * S, 998 * ROW), SETTINGS, liquidity, l2Of(feed)));
    expect(drawnBoxes("past")).toHaveLength(0);
    const wide = { ...SETTINGS, sensitivity: "low" as const };
    liquidityVoidsIndicator.onBar(context(stateFor(wide, "past wide"), bar, wide, liquidity, l2Of(feed)));
    expect(drawnBoxes("past wide")).toHaveLength(0);
    liquidityVoidsIndicator.onBar(context(stateFor(SETTINGS, "past again"), bar, SETTINGS, liquidity, l2Of(feed)));
    expect(drawnBoxes("past again")).toHaveLength(1);
    expect(sent.filter((request) => request.fromTs === sent[0].fromTs)).toHaveLength(1);
    const asked = sent.length;
    const off = { ...SETTINGS, historyHours: 0 };
    liquidityVoidsIndicator.onBar(context(stateFor(off, "past off"), bar, off, liquidity, l2Of(feed)));
    expect(drawnBoxes("past off")).toHaveLength(0);
    expect(sent).toHaveLength(asked);
  });

  it("lets the host's columns run up to where the engine's live events start, not only to the chart's oldest column: a push inside the chart's columns from before the events is drawn from the host's columns with its volume, and stays theirs when the event history later reaches back over it (PR #40 review)", async () => {
    const { stream, sent } = hostLane();
    const printed = columnsOf(T0, 8, 1, 120);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    const liquidity = { ...liquidityOf(feed), history: stream };
    const eventsFrom = T0 + 300 * S;
    const first: L2Event = { kind: "trade", ts: eventsFrom, side: "ask", aggressor: "buy", mode: "swept", price: 1008 * ROW + ROW / 2, size: 0.01, late: false };
    const trades = printed.slice(0, 300).flatMap((c) => (c.buy ?? []).map(([row, size]) => ({ ts: c.ts, columnMs: S, row, aggressor: "buy" as const, mode: "swept" as const, size, count: 1 })));
    let holds = false;
    const l2 = l2With(feed, [first], T0 + 390 * S, async (range) => (holds ? { rowWidth: ROW, trades, wallTrades: [], next: null, heldFrom: 0 } : { rowWidth: ROW, trades: [], wallTrades: [], next: null, heldFrom: range.toTs }));
    const bar = makeBar(T0 + 330 * S, 1008 * ROW);
    const state = createState(SETTINGS, "seam-events");
    const want = vi.spyOn(stream, "want");
    vi.useFakeTimers();
    try {
      const step = () => liquidityVoidsIndicator.onBar(context(state, bar, SETTINGS, liquidity, l2));
      step();
      expect(state.engine.coveredFrom).toBe(eventsFrom);
      expect(want).toHaveBeenLastCalledWith(T0 - 48 * 3_600_000, eventsFrom, 0, 0);
      expect(drawnBoxes("seam-events")).toHaveLength(0);
      stream.accept(sent[0].requestId, hostPage(sent[0], printed));
      await vi.advanceTimersByTimeAsync(0);
      step();
      const boxes = drawnBoxes("seam-events");
      expect(boxes).toHaveLength(1);
      const found = liveSweeps(state.past as NonNullable<typeof state.past>);
      expect(found).toHaveLength(1);
      expect(found[0].volume).toBeGreaterThan(0);
      expect(boxes[0].text).toBe("FPB Ask · 2m");
      holds = true;
      await vi.advanceTimersByTimeAsync(HISTORY_HELD_RETRY_MS);
      step();
      await vi.advanceTimersByTimeAsync(1_000);
      step();
      expect(state.engine.coveredFrom).toBe(T0);
      expect(state.engine.liveFrom).toBe(eventsFrom);
      expect(want).toHaveBeenLastCalledWith(T0 - 48 * 3_600_000, eventsFrom, 0, 0);
      expect(liveSweeps(state.sweep)[0].volume).toBeGreaterThan(0);
      expect(liveSweeps(state.past as NonNullable<typeof state.past>)).toHaveLength(1);
      expect(drawnBoxes("seam-events").map((box) => box.text)).toEqual(boxes.map((box) => box.text));
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides a live box once the history covers its time, so one push is one box", () => {
    const { stream, sent } = hostLane();
    const sweep = columnsOf(T0, 8, 1, 1_020);
    const feed = feedOf([...sweep]);
    const liquidity = { ...liquidityOf(feed), history: stream };
    const state = createState(SETTINGS, "seam");
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 60 * S, 1008 * ROW), SETTINGS, liquidity, l2Of(feed)));
    expect(drawnBoxes("seam")).toHaveLength(1);
    stream.accept(sent[0].requestId, hostPage(sent[0], sweep));
    const seam = T0 + 1_200 * S;
    (feed.fine as { columns: readonly LiquidityColumn[] }).columns = sweep.slice(1_200);
    const later = makeBar(T0 + 1_260 * S, 1008 * ROW);
    liquidityVoidsIndicator.onBar(context(state, later, SETTINGS, liquidity, l2Of(feed)));
    expect(drawnBoxes("seam")).toHaveLength(1);
    const again = sent.filter((request) => request.toTs === seam);
    expect(again).toHaveLength(1);
    stream.accept(again[0].requestId, hostPage(again[0], sweep));
    liquidityVoidsIndicator.onBar(context(state, later, SETTINGS, liquidity, l2Of(feed)));
    expect(liveSweeps(state.sweep)).toHaveLength(1);
    expect(liveSweeps(state.past as NonNullable<typeof state.past>)).toHaveLength(1);
    expect(drawnBoxes("seam")).toHaveLength(1);
  });

  it("keeps a box whose columns the chart has since dropped when it re-steps, so last night's sweep stays until a close mitigates it", () => {
    const state = createState(SETTINGS, "outlive");
    const sweep = columnsOf(T0, 8, 1, 120);
    const feed = feedOf(sweep);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 60 * S), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("outlive")).toHaveLength(1);
    const trimmed = feedOf(sweep.slice(300), 2);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 120 * S), SETTINGS, liquidityOf(trimmed), l2Of(trimmed)));
    expect(state.epoch).toBe(2);
    expect(state.sweep.boxes.map((box) => [box.startTs < SWEEP_END, box.open])).toEqual([[true, false]]);
    expect(drawnBoxes("outlive")).toHaveLength(1);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 180 * S, 998 * ROW), SETTINGS, liquidityOf(trimmed), l2Of(trimmed)));
    expect(state.sweep.boxes[0].endedBy).toBe("mitigated");
    expect(drawnBoxes("outlive")).toHaveLength(0);
  });

  it("starts over on a pair switch or a new row width, and keeps the pair's fetched history when the grid resets", () => {
    const state = createState(SETTINGS, "switch");
    const feed = feedOf(columnsOf(T0, 8, 1));
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("switch")).toHaveLength(1);
    const quiet = feedOf(columnsOf(T0, 1, 1), 2);
    const eth = { ...makeBar(SWEEP_END), symbol: "ETH-USDT" };
    liquidityVoidsIndicator.onBar(context(state, eth, SETTINGS, liquidityOf(quiet), l2Of(quiet)));
    expect(drawnBoxes("switch")).toHaveLength(0);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("switch")).toHaveLength(1);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed, 8), l2Of(feed)));
    expect(state.rowWidth).toBe(8);
    expect(state.sweep.rowWidth).toBe(8);
  });

  it("keeps the fetched history of the pairs used last and lets go of the one unused longest, so the slots do not pile up over a session (PR #39 review)", () => {
    resetHistorySlotsForTests();
    const pair = (i: number) => ({ ...makeBar(SWEEP_END), symbol: `P${i}-USDT` });
    expect(MAX_HISTORY_SLOTS).toBeGreaterThanOrEqual(3);
    const slots = Array.from({ length: MAX_HISTORY_SLOTS }, (_, i) => historySlotFor(pair(i), ROW));
    expect(historySlotFor(pair(0), ROW)).toBe(slots[0]);
    expect(historySlotFor(pair(0), 2 * ROW)).not.toBe(slots[0]);
    for (let i = 2; i < MAX_HISTORY_SLOTS; i += 1) expect(historySlotFor(pair(i), ROW)).toBe(slots[i]);
    expect(historySlotFor(pair(0), ROW)).toBe(slots[0]);
    expect(historySlotFor(pair(1), ROW)).not.toBe(slots[1]);
  });

  it("does not let the bar the sweep happened in mitigate it, even closing below it; the next bar closing below does", () => {
    const state = createState(SETTINGS, "origin-bar");
    const feed = feedOf(columnsOf(T0, 8, 1, 120));
    liquidityVoidsIndicator.onBar(context(state, makeBar(T0 + 240 * S, 999 * ROW), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("origin-bar")).toHaveLength(1);
    liquidityVoidsIndicator.onBar(context(state, makeBar(T0 + 300 * S, 999 * ROW), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("origin-bar")).toHaveLength(0);
  });

  it("keeps the box on a bar that closes inside it, and ends it on a bar that closes below it: mitigated", () => {
    const state = createState(SETTINGS, "close");
    const feed = feedOf(columnsOf(T0, 8, 1, 120));
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("close")).toHaveLength(1);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + STEP, 1004 * ROW), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("close")).toHaveLength(1);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 2 * STEP, 999 * ROW), SETTINGS, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("close")).toHaveLength(0);
  });

  it("re-judges the past columns when the minimum move changes, through the runtime's settings path, so a box under the new minimum disappears", () => {
    resetHistorySlotsForTests();
    const feed = feedOf(columnsOf(T0, 8, 1));
    const runtime = createIndicatorRuntime([liquidityVoidsIndicator as unknown as RuntimeIndicatorDef<unknown, unknown>]);
    runtime.setLiquidity(liquidityOf(feed));
    runtime.setL2(l2Of(feed));
    const bars = [makeBar(SWEEP_END - STEP), makeBar(SWEEP_END)];
    runtime.setActiveAndReplay(new Set(["liquidityVoids"]), { liquidityVoids: SETTINGS }, bars);
    const owner = runtime.getDrawOwnerId("liquidityVoids") ?? "";
    expect(drawnBoxes(owner)).toHaveLength(1);
    runtime.updateSettings("liquidityVoids", { ...SETTINGS, sensitivity: "normal" }, bars);
    expect(drawnBoxes(owner)).toHaveLength(0);
    runtime.updateSettings("liquidityVoids", SETTINGS, bars);
    expect(drawnBoxes(owner)).toHaveLength(1);
  });

  it("draws at most the configured boxes per side, nearest to price, and skips drawing when told not to", () => {
    const capped = { ...SETTINGS, boxesPerSide: 1 };
    const state = createState(capped, "cap");
    const first = columnsOf(T0, 8, 1, 40);
    const second = columnsOf(T0 + 330 * S, 8, 1, 40, 1, 1008);
    const feed = feedOf([...first, ...second]);
    const last = T0 + 640 * S;
    liquidityVoidsIndicator.onBar(context(state, makeBar(last, 1016 * ROW), capped, liquidityOf(feed), l2Of(feed), false));
    expect(drawnBoxes("cap")).toHaveLength(0);
    liquidityVoidsIndicator.onBar(context(state, makeBar(last, 1016 * ROW), capped, liquidityOf(feed), l2Of(feed)));
    expect(state.sweep.boxes.filter((box) => box.endedAt === null)).toHaveLength(2);
    const boxes = drawnBoxes("cap");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].price2).toBe(1009 * ROW);
  });

  it("with Furthest from Price, draws the outer box of a side instead of the one price is trading into", () => {
    const first = columnsOf(T0, 8, 1, 40);
    const second = columnsOf(T0 + 330 * S, 8, 1, 40, 1, 1008);
    const feed = feedOf([...first, ...second]);
    const last = T0 + 640 * S;
    const near = { ...SETTINGS, boxesPerSide: 1 };
    const nearState = createState(near, "near");
    liquidityVoidsIndicator.onBar(context(nearState, makeBar(last, 1016 * ROW), near, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("near").map((box) => box.price2)).toEqual([1009 * ROW]);
    const far = { ...near, levelsBy: "furthest" as const };
    const farState = createState(far, "far");
    liquidityVoidsIndicator.onBar(context(farState, makeBar(last, 1016 * ROW), far, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("far").map((box) => box.price2)).toEqual([1001 * ROW]);
  });

  it("takes the volume from the engine's trade events: nothing is judged before the engine's first frame, the events then draw the box with its volume", () => {
    const printed = columnsOf(T0, 8, 1);
    const state = createState(SETTINGS, "events");
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    const end = printed[printed.length - 1].ts + S;
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2Blind(feed)));
    expect(drawnBoxes("events")).toHaveLength(0);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2With(feed, eventsOf(printed), end)));
    const boxes = drawnBoxes("events");
    expect(boxes).toHaveLength(1);
    const box = state.sweep.boxes[0];
    expect(box.volume).toBeGreaterThan(0);
    expect(box.volume).toBe(printedInto(printed, "buy", box));
    expect(boxes[0].text).toBe("FPB Ask · 0m");
  });

  it("ignores the prints of columns the engine does not cover, and every print before the engine's first frame", () => {
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed);
    const uncovered = createState(SETTINGS, "uncovered");
    liquidityVoidsIndicator.onBar(context(uncovered, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2With(feed, [], SWEEP_END)));
    expect(uncovered.sweep.boxes.map((box) => box.volume)).toEqual([null]);
    expect(drawnBoxes("uncovered")).toHaveLength(0);
    const blind = createState(SETTINGS, "blind");
    liquidityVoidsIndicator.onBar(context(blind, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2Blind(feed)));
    expect(drawnBoxes("blind")).toHaveLength(0);
    expect(blind.shownStatus).toBeNull();
  });

  it("finds a move from before the engine's first frame on the price path alone and holds it back until its volume is known", () => {
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed);
    const state = createState(SETTINGS, "history-impulse");
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2With(feed, [], SWEEP_END)));
    expect(state.sweep.boxes.map((box) => [box.rowLo, box.rowHi, box.volume])).toEqual([[1001, 1008, null]]);
    expect(drawnBoxes("history-impulse")).toHaveLength(0);
  });

  it("asks the event history newest first, in chunks reaching back from the engine's first event, and re-judges the columns with it, so a box's volume fills in", async () => {
    const impulse = { ...SETTINGS };
    const state = createState(impulse, "history");
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    const live = eventsOf(printed.slice(255));
    const trades = printed.slice(0, 255).flatMap((c) => (c.buy ?? []).map(([row, size]) => ({ ts: c.ts, columnMs: S, row, aggressor: "buy" as const, mode: "swept" as const, size, count: 1 })));
    const asked: L2HistoryRange[] = [];
    const l2 = l2With(feed, live, SWEEP_END, async (range) => {
      asked.push(range);
      return { rowWidth: ROW, trades, wallTrades: [], next: null, heldFrom: 0 };
    });
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), impulse, liquidityOf(feed), l2));
    expect(drawnBoxes("history")).toHaveLength(0);
    expect(state.sweep.boxes[0].volume).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), impulse, liquidityOf(feed), l2));
    expect(asked[0]).toMatchObject({ toTs: live[0].ts, fromTs: Math.max(T0, live[0].ts - HISTORY_CHUNK_MS) });
    for (let i = 1; i < asked.length; i += 1) expect(asked[i].toTs).toBe(asked[i - 1].fromTs);
    expect(asked[asked.length - 1].fromTs).toBe(T0);
    const volume = state.sweep.boxes[0].volume;
    expect(volume).toBeGreaterThan(0);
    expect(drawnBoxes("history").map((box) => box.text)).toEqual(["FPB Ask · 0m"]);
  });

  it("asks again for older history once the chart's columns reach further back and the running fill is done, like the browser's grid filling up after the first bars", async () => {
    const whole = { ...SETTINGS };
    const state = createState(whole, "history-grows");
    const printed = columnsOf(T0, 8, 1, 240);
    const stripped = printed.map((c) => ({ ...c, buy: [], sell: [] }));
    const short = feedOf(stripped.slice(200));
    const full = feedOf(stripped);
    const asked: L2HistoryRange[] = [];
    const l2For = (feed: ColumnFeed): IndicatorL2 => l2With(feed, eventsOf(printed.slice(500)), printed[printed.length - 1].ts + S, async (range) => {
      asked.push(range);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { rowWidth: ROW, trades: [], wallTrades: [], next: null, heldFrom: 0 };
    });
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 240 * S), whole, liquidityOf(short), l2For(short)));
    expect(asked).toHaveLength(1);
    expect(state.history?.running).toBe(true);
    liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 240 * S), whole, liquidityOf(full), l2For(full)));
    expect(asked).toHaveLength(1);
    for (let i = 0; i < 80; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END + 240 * S), whole, liquidityOf(full), l2For(full)));
    }
    expect(state.history?.running).toBe(false);
    expect(Math.min(...asked.map((range) => range.fromTs))).toBe(full.fine.columns[0].ts);
    expect(new Set(asked.map((range) => range.toTs)).size).toBe(asked.length);
  });

  it("when a fill ends short because the runtime keeps refusing, asks again after the cooldown, not on every bar", async () => {
    const state = createState(SETTINGS, "history-retry");
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    let starts = 0;
    const l2 = l2With(feed, eventsOf(printed.slice(255)), SWEEP_END, async (_range, cursor) => {
      if (cursor === undefined) starts += 1;
      return null;
    });
    vi.useFakeTimers();
    try {
      const bar = () => liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2));
      bar();
      await vi.advanceTimersByTimeAsync(20_000);
      const afterFirstFill = starts;
      expect(afterFirstFill).toBe(MAX_CHUNK_ATTEMPTS);
      bar();
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toBe(afterFirstFill);
      await vi.advanceTimersByTimeAsync(HISTORY_RETRY_MS);
      bar();
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toBe(afterFirstFill + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds back a push from before the runtime's event memory: an empty answer from past what the runtime holds leaves the volume unknown, never zero (PR #39 review)", async () => {
    const state = createState(SETTINGS, "history-horizon");
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    const live = eventsOf(printed.slice(255));
    const asked: L2HistoryRange[] = [];
    const l2 = l2With(feed, live, SWEEP_END, async (range) => {
      asked.push(range);
      return { rowWidth: ROW, trades: [], wallTrades: [], next: null, heldFrom: range.toTs };
    });
    const bar = () => liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2));
    bar();
    await new Promise((resolve) => setTimeout(resolve, 0));
    bar();
    expect(asked).toHaveLength(1);
    expect(state.history?.running).toBe(false);
    expect(state.history?.engine.coveredFrom).toBe(live[0].ts);
    expect(state.sweep.boxes.map((box) => box.volume)).toEqual([null]);
    expect(drawnBoxes("history-horizon")).toHaveLength(0);
  });

  it("when the runtime holds no more, asks again only after the longer pause, in case the runtime's own fill has reached further back since (PR #39 review)", async () => {
    const state = createState(SETTINGS, "history-held");
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    let asked = 0;
    const l2 = l2With(feed, eventsOf(printed.slice(255)), SWEEP_END, async (range) => {
      asked += 1;
      return { rowWidth: ROW, trades: [], wallTrades: [], next: null, heldFrom: range.toTs };
    });
    vi.useFakeTimers();
    try {
      const bar = () => liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2));
      bar();
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toBe(1);
      expect(state.history?.running).toBe(false);
      await vi.advanceTimersByTimeAsync(HISTORY_RETRY_MS);
      bar();
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toBe(1);
      await vi.advanceTimersByTimeAsync(HISTORY_HELD_RETRY_MS - HISTORY_RETRY_MS);
      bar();
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again after the cooldown when a fill throws, instead of never asking that range again (PR #39 review)", async () => {
    const state = createState(SETTINGS, "history-throws");
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    let asked = 0;
    const l2 = l2With(feed, eventsOf(printed.slice(255)), SWEEP_END, async () => {
      asked += 1;
      return { rowWidth: ROW, get trades(): never { throw new Error("boom"); }, wallTrades: [], next: null, heldFrom: 0 };
    });
    vi.useFakeTimers();
    try {
      const bar = () => liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2));
      bar();
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toBe(1);
      expect(state.history?.running).toBe(false);
      bar();
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toBe(1);
      await vi.advanceTimersByTimeAsync(HISTORY_RETRY_MS);
      bar();
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the fetched history across a settings change: the rebuilt state asks the runtime for nothing and the volume stays on the chip", async () => {
    resetHistorySlotsForTests();
    resetDrawRegistryForTests();
    const impulse = { ...SETTINGS };
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    const trades = printed.slice(0, 255).flatMap((c) => (c.buy ?? []).map(([row, size]) => ({ ts: c.ts, columnMs: S, row, aggressor: "buy" as const, mode: "swept" as const, size, count: 1 })));
    let asked = 0;
    const l2 = l2With(feed, eventsOf(printed.slice(255)), SWEEP_END, async () => {
      asked += 1;
      return { rowWidth: ROW, trades, wallTrades: [], next: null, heldFrom: 0 };
    });
    const runtime = createIndicatorRuntime([liquidityVoidsIndicator as unknown as RuntimeIndicatorDef<unknown, unknown>]);
    runtime.setLiquidity(liquidityOf(feed));
    runtime.setL2(l2);
    const bars = [makeBar(SWEEP_END - STEP), makeBar(SWEEP_END)];
    vi.useFakeTimers();
    try {
      runtime.setActiveAndReplay(new Set(["liquidityVoids"]), { liquidityVoids: impulse }, bars);
      const owner = runtime.getDrawOwnerId("liquidityVoids") ?? "";
      await vi.advanceTimersByTimeAsync(60_000);
      runtime.onLiquidityAdvanced(bars);
      const askedBefore = asked;
      expect(askedBefore).toBeGreaterThan(0);
      const withVolume = drawnBoxes(owner).map((box) => box.text);
      expect(withVolume).toHaveLength(1);
      expect(withVolume[0]).toBe("FPB Ask · 0m");
      runtime.updateSettings("liquidityVoids", { ...impulse, boxesPerSide: 2 }, bars);
      expect(drawnBoxes(owner).map((box) => box.text)).toEqual(withVolume);
      await vi.advanceTimersByTimeAsync(60_000);
      runtime.onLiquidityAdvanced(bars);
      expect(asked).toBe(askedBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts one history fill per engine: bars arriving while it is still running ask for no chunk twice", async () => {
    const state = createState(SETTINGS, "history-once");
    const printed = columnsOf(T0, 8, 1);
    const feed = feedOf(printed.map((c) => ({ ...c, buy: [], sell: [] })));
    const asked: L2HistoryRange[] = [];
    const l2 = l2With(feed, eventsOf(printed.slice(255)), SWEEP_END, async (range) => {
      asked.push(range);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { rowWidth: ROW, trades: [], wallTrades: [], next: null, heldFrom: 0 };
    });
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i += 1) liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2));
      for (let i = 0; i < 40; i += 1) {
        await vi.advanceTimersByTimeAsync(300);
        liquidityVoidsIndicator.onBar(context(state, makeBar(SWEEP_END), SETTINGS, liquidityOf(feed), l2));
      }
      expect(asked.length).toBeGreaterThanOrEqual(1);
      expect(new Set(asked.map((range) => range.toTs)).size).toBe(asked.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
