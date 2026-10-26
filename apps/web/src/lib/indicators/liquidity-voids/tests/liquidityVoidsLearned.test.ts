import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorL2 } from "../../../chart/indicatorL2";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { withStreamCreationWindow } from "../../../chart/ta/creationGuard";
import { withDrawOwnerScope } from "../../../chart/draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import type { BoxData } from "../../../chart/draw/box";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import type { L2Event } from "../../../l2/types";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { ColumnHistoryStream, STREAM_CHUNK_MS, STREAM_LEVEL_MS } from "../../passive-liquidity/columnHistoryStream";
import type { HistoryRequest } from "../../passive-liquidity/heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage } from "../../passive-liquidity/heatmapHistoryDecode";
import { BOOK_UNKNOWN, VOID_STATUS_TEXT, liquidityVoidsIndicator, resetHistorySlotsForTests, type LiquidityVoidsState } from "../liquidityVoidsIndicator";
import { DEFAULT_LIQUIDITY_VOIDS_SETTINGS, maxTradedOf, type Identity, type LiquidityVoidsSettings } from "../liquidityVoidsRules";
import { settingsSchemaFor } from "../../../chart/settingsSchemaFor";
import { instrumentKey } from "../../../chart/drawingStore";
import { SLOT_MS, createLearned, learnedHasEnough, stepLearned } from "../learnedThresholds";
import { createSweepState, liveSweeps, type SweepBox } from "../sweepModel";
import { pastColumns, replayLearned, resetPastSlotsForTests, type PastBar } from "../voidsPast";
import type { TableData } from "../../../chart/draw/table";

vi.mock("../learnedThresholds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../learnedThresholds")>();
  return { ...actual, stepLearned: vi.fn(actual.stepLearned) };
});

vi.mock("../voidsPast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voidsPast")>();
  return { ...actual, pastColumns: vi.fn(actual.pastColumns) };
});

const H = STREAM_CHUNK_MS;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % H);
const S = 1_000;
const MINUTE = 60_000;
const ROW = 4;
const BASE_ROW = 1_000;
const LEARNED: LiquidityVoidsSettings = { ...DEFAULT_LIQUIDITY_VOIDS_SETTINGS, thresholdsOther: "learned", sensitivity: "high", historyHours: 0 };
const FIXED: LiquidityVoidsSettings = { ...DEFAULT_LIQUIDITY_VOIDS_SETTINGS, sensitivity: "high", historyHours: 0 };

function makeBar(ts_open: number, close = 4_004, closed = true, interval_ms = MINUTE): BarFrame {
  return { type: "bar", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", interval_ms, ts_open, open: close, high: close + ROW, low: close - ROW, close, volume: 100, trade_count: 10, closed };
}

/** A 10-s column with the book at `row`, printing 5 bought and 5 sold twenty rows below it: one unit a second, in no push's rows. */
function col(ts: number, row: number): LiquidityColumn {
  const lo = row - 40;
  const hi = row + 41;
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  bid[row - lo] = 5;
  ask[row + 1 - lo] = 5;
  return { ts, lo, hi, bid, ask, buy: [[row - 20, 5]], sell: [[row - 20, 5]] };
}

/** Columns in time order; a jump's trades print on the column before it, in the rows it crosses. */
class Tape {
  columns: LiquidityColumn[] = [];
  ts: number;
  row = BASE_ROW;
  blind = false;

  constructor(from: number) {
    this.ts = from;
  }

  hold(slots: number): this {
    for (let i = 0; i < slots; i += 1) this.push(col(this.ts, this.row));
    return this;
  }

  holdUntil(ts: number): this {
    while (this.ts < ts) this.hold(1);
    return this;
  }

  jump(rows: number, volume: number): this {
    const previous = this.columns[this.columns.length - 1];
    if (previous !== undefined && !this.blind) {
      const crossed: [number, number][] = [];
      const count = Math.abs(rows);
      for (let i = 1; i <= count; i += 1) crossed.push([rows > 0 ? this.row + i : this.row - i + 1, volume / count]);
      if (rows > 0) previous.buy = [...(previous.buy ?? []), ...crossed];
      else previous.sell = [...(previous.sell ?? []), ...crossed];
    }
    this.row += rows;
    this.push(col(this.ts, this.row));
    return this;
  }

  /** One window of background per count: a one-row jump, up or down in turn, then two holds. */
  background(windows: number): this {
    for (let i = 0; i < windows; i += 1) this.jump(i % 2 === 0 ? 1 : -1, 10).hold(2);
    return this;
  }

  /** A five-row push, up or down in turn, printing `volume` into the rows it crosses, then five slots of calm. */
  pushes(volumes: readonly number[]): this {
    for (let i = 0; i < volumes.length; i += 1) this.jump(i % 2 === 0 ? 5 : -5, volumes[i]).hold(5);
    return this;
  }

  private push(column: LiquidityColumn): void {
    if (this.blind) {
      delete column.buy;
      delete column.sell;
    }
    this.columns.push(column);
    this.ts += SLOT_MS;
  }
}

/** The columns of a 10-s tape as 1-s columns: the book held through the ten seconds, the prints on the first. */
function fine(columns: readonly LiquidityColumn[]): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  for (const column of columns) {
    for (let i = 0; i < 10; i += 1) {
      const copy: LiquidityColumn = { ts: column.ts + i * S, lo: column.lo, hi: column.hi, bid: column.bid, ask: column.ask };
      if (column.buy !== undefined) copy.buy = i === 0 ? column.buy : [];
      if (column.sell !== undefined) copy.sell = i === 0 ? column.sell : [];
      out.push(copy);
    }
  }
  return out;
}

function feedOf(columns: LiquidityColumn[], epoch = 1): ColumnFeed {
  return { epoch, deep: null, fine: { columns, columnMs: S } };
}

function liquidityOf(feed: ColumnFeed, rowWidth = ROW): IndicatorLiquidity {
  return { get feed() { return feed; }, rowWidth, baseAsset: "BTC", version: 1 };
}

function eventsOf(columns: readonly LiquidityColumn[]): L2Event[] {
  return columns.flatMap((c) => [
    ...(c.buy ?? []).map(([row, size]) => ({ kind: "trade" as const, ts: c.ts, side: "ask" as const, aggressor: "buy" as const, mode: "swept" as const, price: row * ROW + ROW / 2, size, late: false })),
    ...(c.sell ?? []).map(([row, size]) => ({ kind: "trade" as const, ts: c.ts, side: "bid" as const, aggressor: "sell" as const, mode: "swept" as const, price: row * ROW + ROW / 2, size, late: false })),
  ]);
}

function l2With(feed: ColumnFeed, events: L2Event[], lastTs: number, eventHistory: IndicatorL2["eventHistory"] = async () => null): IndicatorL2 {
  return {
    availability: "LIVE", version: 1, status: () => ({ synced: true, seq: 1, lastTs, lastFrameAt: lastTs }), segment: () => null, trusted: () => true,
    lanes: () => [], view: (lane) => (lane === 0 ? feed : null), laneFor: () => 0, walls: () => [], wall: () => null,
    events: (since) => ({ seq: events.length + 1, events: since === events.length + 1 ? [] : events, missed: 0, complete: true }), ladder: () => null, wallHistory: async () => null, eventHistory, hostWalls: null,
  };
}

/** An engine whose trade events are the feed's own prints, covering every column. */
function l2Of(feed: ColumnFeed): IndicatorL2 {
  const last = feed.fine.columns[feed.fine.columns.length - 1];
  return l2With(feed, eventsOf(feed.fine.columns), last === undefined ? 0 : last.ts + S);
}

function context(state: LiquidityVoidsState, bar: BarFrame, settings: LiquidityVoidsSettings, liquidity?: IndicatorLiquidity, l2?: IndicatorL2, drawNow = true): IndicatorBarCtx<LiquidityVoidsState, LiquidityVoidsSettings> {
  return { bar, trades: [], tradeAvailability: "LIVE_COMPLETE", liquidity, l2, state, settings, replace: false, replaying: false, drawNow, ta: {}, draw: { fill: vi.fn() }, markers: { plotshape: vi.fn(), plotchar: vi.fn() }, pane: { paneIndex: 0 } };
}

function hostLane() {
  const sent: HistoryRequest[] = [];
  const stream = new ColumnHistoryStream({ request: (request) => sent.push(request) });
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

function createState(settings: LiquidityVoidsSettings, ownerId: string): LiquidityVoidsState {
  resetDrawRegistryForTests();
  resetHistorySlotsForTests();
  resetPastSlotsForTests();
  return withDrawOwnerScope(ownerId, () => withStreamCreationWindow(() => liquidityVoidsIndicator.createState(settings)));
}

function drawnBoxes(ownerId: string): BoxData[] {
  return handlesForOwners([ownerId]).filter((record) => record.kind === "box").map((record) => record.data as BoxData).filter((box) => box.time1 !== 0 && box.text !== "" && !box.text.startsWith("Flowprint Blocks ·"));
}

function bookText(ownerId: string): string {
  const record = handlesForOwners([ownerId]).find((candidate) => candidate.kind === "table");
  return record === undefined ? "" : ((record.data as TableData).pendingGrid["0,1"]?.text ?? "");
}

/** The volume behind each drawn box, from the sweeps over its rows: each sweep answers for one box, the nearest in time first. */
function volumesOf(state: LiquidityVoidsState, boxes: readonly BoxData[]): number[] {
  const free = new Set(liveSweeps(state.sweep));
  return boxes.map((box) => {
    const over = [...free].filter((sweep) => sweep.rowLo * ROW === box.price2 && (sweep.rowHi + 1) * ROW === box.price1);
    const nearest = over.sort((a, b) => Math.abs(a.startTs - box.time1) - Math.abs(b.startTs - box.time1))[0];
    if (nearest === undefined) return Number.NaN;
    free.delete(nearest);
    return nearest.volume ?? Number.NaN;
  });
}

/** Forty windows of calm, eight pushes to learn from (volumes 30 to 240 on one unit a second), then a light push of 90 and a heavy one of 120. */
function learningTape(from = T0): { tape: Tape; learningEnd: number } {
  const tape = new Tape(from).background(40).pushes([30, 60, 90, 120]);
  const learningEnd = tape.ts;
  tape.pushes([150, 180, 210, 240]).pushes([30, 60]);
  return { tape, learningEnd };
}

describe("Order Flow Gaps with learned thresholds", () => {
  it("offers Thresholds right after Sensitivity, one choice per market with its own default (Learned on the index futures, Fixed elsewhere), a Maximum Traded slider only under Learned with the market's own number, and the Window field only under Fixed", () => {
    const schema = liquidityVoidsIndicator.settingsSchema ?? [];
    const keys = schema.map((field) => ("key" in field ? field.key : undefined));
    expect(keys.slice(0, 4)).toEqual(["sensitivity", "thresholdsIndex", "thresholdsOther", "maxTradedByInstrument"]);
    expect(keys).toContain("windowS");
    const radio = schema[1];
    expect(radio && radio.kind === "radioGroup" ? radio.options.map((option) => [option.value, option.label]) : null).toEqual([["fixed", "Fixed"], ["learned", "Learned"]]);
    expect(schema[3]?.visibleIf?.(DEFAULT_LIQUIDITY_VOIDS_SETTINGS)).toBe(false);
    const nqIdentity = { provider: "DXFEED" as const, assetClass: "FUTURE" as const, symbol: "/NQZ26:XCME" };
    const btcIdentity = { provider: "BINANCE" as const, marketKind: "PERPETUAL" as const, symbol: "BTC-USDT" };
    const shown = (identity: Identity, settings: LiquidityVoidsSettings) => settingsSchemaFor(liquidityVoidsIndicator, identity).filter((field) => "key" in field && (field.visibleIf?.(settings) ?? true)).map((field) => ("key" in field ? field.key : undefined));
    expect(shown(nqIdentity, DEFAULT_LIQUIDITY_VOIDS_SETTINGS)).toEqual(["sensitivity", "thresholdsIndex", "maxTradedByInstrument", "levelsBy", "boxesPerSide", "historyHours", "askColor", "bidColor"]);
    expect(shown(btcIdentity, DEFAULT_LIQUIDITY_VOIDS_SETTINGS)).toEqual(["sensitivity", "thresholdsOther", "windowS", "levelsBy", "boxesPerSide", "historyHours", "askColor", "bidColor"]);
    expect(shown(btcIdentity, LEARNED)).toEqual(["sensitivity", "thresholdsOther", "maxTradedByInstrument", "levelsBy", "boxesPerSide", "historyHours", "askColor", "bidColor"]);
    expect(shown(nqIdentity, { ...DEFAULT_LIQUIDITY_VOIDS_SETTINGS, thresholdsIndex: "fixed" })).toEqual(["sensitivity", "thresholdsIndex", "windowS", "levelsBy", "boxesPerSide", "historyHours", "askColor", "bidColor"]);
    const { tape } = learningTape();
    const feed = feedOf(fine(tape.columns));
    const defaults = { ...DEFAULT_LIQUIDITY_VOIDS_SETTINGS, sensitivity: "high" as const, historyHours: 0 };
    const nq = createState(defaults, "default-nq");
    liquidityVoidsIndicator.onBar(context(nq, { ...makeBar(tape.ts), ...nqIdentity } as BarFrame, defaults, liquidityOf(feed), l2Of(feed)));
    expect(nq.learned).not.toBeNull();
    const btc = createState(defaults, "default-btc");
    liquidityVoidsIndicator.onBar(context(btc, makeBar(tape.ts), defaults, liquidityOf(feed), l2Of(feed)));
    expect(btc.learned).toBeNull();
  });

  it("the Maximum Traded slider raises the cap for its own market only: a light push above the market's number is drawn once the slider allows it", () => {
    const { tape } = learningTape();
    const feed = feedOf(fine(tape.columns));
    const bar = makeBar(tape.ts);
    const raised = { ...LEARNED, maxTradedByInstrument: { [instrumentKey(bar)]: 60 } };
    const state = createState(raised, "raised");
    liquidityVoidsIndicator.onBar(context(state, bar, raised, liquidityOf(feed), l2Of(feed)));
    // The two light pushes sit on the same rows in the same bar, so the chip tells them apart by nothing: both are drawn once the cap allows the 60.
    expect(volumesOf(state, drawnBoxes("raised")).sort((a, b) => a - b)).toEqual([30, 60]);
    const other = { ...LEARNED, maxTradedByInstrument: { "DXFEED:FUTURE:/NQZ26:XCME": 60 } };
    const unchanged = createState(other, "other");
    liquidityVoidsIndicator.onBar(context(unchanged, bar, other, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("other")).toHaveLength(1);
    expect(volumesOf(unchanged, drawnBoxes("other")).every((volume) => [30, 60].includes(volume))).toBe(true);
  });
  it("with no host history, learns from the chart's own columns: says More data needed until eight pushes are judged, then draws a light push when it ends, with its volume, never a heavy one and never one traded above the market's maximum", () => {
    const { tape, learningEnd } = learningTape();
    const learning = createState(LEARNED, "learning");
    const short = feedOf(fine(tape.columns.filter((column) => column.ts < learningEnd)));
    liquidityVoidsIndicator.onBar(context(learning, makeBar(learningEnd), LEARNED, liquidityOf(short), l2Of(short)));
    expect(learning.shownStatus).toBe("moreData");
    expect(drawnBoxes("learning")).toHaveLength(0);
    expect(handlesForOwners(["learning"]).some((record) => record.kind === "box" && (record.data as BoxData).text === VOID_STATUS_TEXT.moreData)).toBe(true);
    const state = createState(LEARNED, "learned");
    const feed = feedOf(fine(tape.columns));
    const bar = makeBar(tape.ts);
    liquidityVoidsIndicator.onBar(context(state, bar, LEARNED, liquidityOf(feed), l2Of(feed)));
    expect(state.shownStatus).toBeNull();
    const boxes = drawnBoxes("learned");
    expect(boxes.map((box) => box.text)).toEqual(["FPB Ask · 2m"]);
    expect(maxTradedOf(bar, bar.interval_ms)).toBe(30);
    expect(liveSweeps(state.sweep).map((box) => [box.verdict, box.volume])).toEqual([["light", 30], ["light", 60]]);
    expect(bookText("learned")).toBe("$164 · normal book");
    liquidityVoidsIndicator.onBar(context(state, makeBar(tape.ts + 12 * MINUTE), LEARNED, liquidityOf(feed), l2Of(feed)));
    expect(state.shownStatus).toBe("stale");
    expect(liveSweeps(state.sweep)).toHaveLength(2);
    expect(drawnBoxes("learned")).toHaveLength(0);
    expect(bookText("learned")).toBe(BOOK_UNKNOWN);
    const fixed = createState(FIXED, "fixed");
    liquidityVoidsIndicator.onBar(context(fixed, bar, FIXED, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("fixed")).toHaveLength(0);
  });

  it("ends a light push when a later bar closes through it, under Learned as under Fixed", () => {
    const { tape } = learningTape();
    const feed = feedOf(fine(tape.columns));
    const state = createState(LEARNED, "mitigated");
    liquidityVoidsIndicator.onBar(context(state, makeBar(tape.ts), LEARNED, liquidityOf(feed), l2Of(feed)));
    expect(drawnBoxes("mitigated")).toHaveLength(1);
    liquidityVoidsIndicator.onBar(context(state, makeBar(tape.ts + MINUTE, (BASE_ROW - 60) * ROW), LEARNED, liquidityOf(feed), l2Of(feed)));
    expect(state.sweep.boxes.map((box) => [box.side, box.endedBy])).toEqual([["ask", "mitigated"], ["bid", null]]);
    expect(drawnBoxes("mitigated")).toHaveLength(0);
  });

  it("draws a push only once it has ended: while it is still being measured it is not on the chart", () => {
    const tape = new Tape(T0).background(40).pushes([30, 60, 90, 120, 150, 180, 210, 240]).jump(5, 90);
    const feed = feedOf(fine(tape.columns));
    const uncapped = { ...LEARNED, maxTradedByInstrument: { [instrumentKey(makeBar(T0))]: 1_000 } };
    const state = createState(uncapped, "open");
    liquidityVoidsIndicator.onBar(context(state, makeBar(tape.ts), uncapped, liquidityOf(feed), l2Of(feed)));
    expect(state.shownStatus).toBeNull();
    expect(liveSweeps(state.sweep).map((box) => [box.open, box.verdict])).toEqual([[true, null]]);
    expect(drawnBoxes("open")).toHaveLength(0);
  });

  it("replays columns and candle closes in time order: a close through a light push after it ends it, one before it does not", () => {
    const tape = new Tape(T0).background(40).pushes([30, 60, 90, 120, 150, 180, 210, 240]);
    const before = tape.ts;
    tape.pushes([90]);
    const columns = tape.columns.map((column) => ({ column, columnMs: SLOT_MS }));
    const judged = (bars: PastBar[]) => {
      const sweep = createSweepState(ROW);
      replayLearned(sweep, createLearned(30_000), 1, columns, bars, MINUTE);
      return liveSweeps(sweep).map((box) => box.verdict);
    };
    expect(judged([])).toEqual(["light"]);
    expect(judged([{ open: before - MINUTE, close: (BASE_ROW - 50) * ROW }])).toEqual(["light"]);
    expect(judged([{ open: tape.ts - MINUTE, close: (BASE_ROW - 50) * ROW }])).toEqual([]);
  });

  it("measures pushes over the window of the chart's timeframe, whatever Window the dialog saved", () => {
    const narrow = { ...LEARNED, windowS: 5 };
    const { tape } = learningTape();
    const feed = feedOf(fine(tape.columns));
    const state = createState(narrow, "timeframe");
    liquidityVoidsIndicator.onBar(context(state, makeBar(tape.ts), narrow, liquidityOf(feed), l2Of(feed)));
    expect(state.learned?.windowMs).toBe(30_000);
    expect(drawnBoxes("timeframe")).toHaveLength(1);
    const fiveMinutes = createState(narrow, "timeframe-5m");
    liquidityVoidsIndicator.onBar(context(fiveMinutes, makeBar(tape.ts, 4_004, true, 5 * MINUTE), narrow, liquidityOf(feed), l2Of(feed)));
    expect(fiveMinutes.learned?.windowMs).toBe(90_000);
  });

  it("samples the spread readout from the live columns as they come, not only at a rebuild", () => {
    const tape = new Tape(T0).hold(7);
    const columns = fine(tape.columns);
    const short = feedOf(columns.slice(0, 30));
    const state = createState(LEARNED, "book");
    liquidityVoidsIndicator.onBar(context(state, makeBar(T0 + 30 * S, 4_004, false), LEARNED, liquidityOf(short), l2Of(short)));
    expect(bookText("book")).toBe(BOOK_UNKNOWN);
    const longer = feedOf(columns);
    liquidityVoidsIndicator.onBar(context(state, makeBar(T0 + 60 * S, 4_004, false), LEARNED, liquidityOf(longer), l2Of(longer)));
    expect(state.depth.samples.length).toBe(columns.length);
    expect(bookText("book")).not.toBe(BOOK_UNKNOWN);
  });

  it("asks the host for the warm-up before the History reach, draws nothing it cannot settle yet while an asked hour is still to come, then judges the past and the live columns as one run: a light push from the host's columns, one from the live columns judged against the host's memory, and nothing for a heavy push, an unknown-volume push or a push inside the warm-up; an event-history fill over columns the host covers rebuilds nothing", async () => {
    const { stream, sent } = hostLane();
    const host = new Tape(T0).background(40).pushes([30, 60, 90, 120, 150, 180, 210, 240]).pushes([90]).holdUntil(T0 + H);
    const warmupLight = host.columns[host.columns.length - 1].ts;
    host.background(10).pushes([60]).background(20).pushes([30, 300]).background(10).pushes([30]).background(10);
    host.blind = true;
    host.hold(2).jump(-5, 0).hold(5);
    host.blind = false;
    host.holdUntil(T0 + 2 * H);
    const liveFrom = T0 + 2 * H;
    const lookback = liveFrom - 10 * MINUTE;
    const live = new Tape(lookback).holdUntil(liveFrom).background(10).pushes([45]).background(5);
    const columns = fine(live.columns);
    const feed = feedOf(columns);
    const liquidity = { ...liquidityOf(feed), history: stream };
    const settings = { ...LEARNED, historyHours: 1, boxesPerSide: 8, maxTradedByInstrument: { [instrumentKey(makeBar(T0))]: 1_000 } };
    const bar = makeBar(liveFrom + 10 * MINUTE, 4_004, false);
    const state = createState(settings, "host");
    const want = vi.spyOn(stream, "want");
    const l2 = l2With(feed, eventsOf(columns.filter((column) => column.ts >= liveFrom)), columns[columns.length - 1].ts + S, async () => ({ rowWidth: ROW, trades: [], wallTrades: [], next: null, heldFrom: 0 }));
    const step = () => liquidityVoidsIndicator.onBar(context(state, bar, settings, liquidity, l2));
    step();
    expect(want).toHaveBeenLastCalledWith(lookback - 2 * H, liveFrom, 0, 0);
    expect(state.shownStatus).toBe("loading");
    expect(drawnBoxes("host")).toHaveLength(0);
    expect(sent.map((request) => request.fromTs)).toEqual([T0 + H, T0, T0 - H]);
    stream.accept(sent[0].requestId, hostPage(sent[0], host.columns));
    step();
    expect(state.shownStatus).toBe("loading");
    expect(drawnBoxes("host")).toHaveLength(0);
    stream.accept(sent[1].requestId, hostPage(sent[1], host.columns));
    step();
    expect(state.shownStatus).toBe("loading");
    expect(sent.map((request) => request.fromTs)).toEqual([T0 + H, T0, T0 - H]);
    stream.accept(sent[2].requestId, hostPage(sent[2], host.columns));
    step();
    expect(state.shownStatus).toBeNull();
    const stepped = vi.mocked(stepLearned).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    step();
    expect(state.engine.coveredFrom).toBe(lookback);
    expect(vi.mocked(stepLearned).mock.calls.length).toBe(stepped);
    const light = liveSweeps(state.sweep).filter((box) => box.verdict === "light");
    expect(light.map((box) => [box.side, box.volume])).toEqual([["ask", 90], ["ask", 60], ["ask", 30], ["ask", 30], ["ask", 45]]);
    expect(light[0].endTs).toBeLessThanOrEqual(warmupLight);
    expect(light[4].startTs).toBeGreaterThanOrEqual(liveFrom);
    const drawn = drawnBoxes("host");
    expect(volumesOf(state, drawn).sort((a, b) => a - b)).toEqual([30, 30, 45, 60]);
    expect(state.sweep.boxes.every((box) => box.verdict === "light")).toBe(true);
  });

  it("while the host's hours arrive newest first, draws under Loading history the light pushes the newest unbroken stretch can already settle, each the same box once every hour is in, and holds back the pushes it cannot settle yet (#46 review)", () => {
    const { stream, sent } = hostLane();
    const liveFrom = T0 + 3 * H;
    const lookback = liveFrom - 10 * MINUTE;
    const host = new Tape(T0 - 20 * MINUTE).background(40).pushes(Array.from({ length: 50 }, (_, i) => 5 + ((i * 7) % 15))).holdUntil(T0 + H);
    host.background(10).pushes(Array.from({ length: 110 }, (_, i) => 15 + ((i * 53) % 170))).holdUntil(liveFrom);
    const live = new Tape(lookback);
    live.row = host.row;
    live.holdUntil(liveFrom).background(5).pushes([45]).background(5);
    const columns = fine(live.columns);
    const feed = feedOf(columns);
    const settings = { ...LEARNED, historyHours: 2, boxesPerSide: 8, maxTradedByInstrument: { [instrumentKey(makeBar(T0))]: 1_000 } };
    const state = createState(settings, "settling");
    const l2 = l2With(feed, eventsOf(columns.filter((column) => column.ts >= liveFrom)), columns[columns.length - 1].ts + S);
    const step = () => liquidityVoidsIndicator.onBar(context(state, makeBar(liveFrom + 10 * MINUTE, 4_004, false), settings, { ...liquidityOf(feed), history: stream }, l2));
    const keyOf = (box: SweepBox) => [box.side, box.rowLo, box.rowHi, box.startTs, box.endTs, box.volume].join(":");
    step();
    expect(sent.map((request) => request.fromTs)).toEqual([T0 + 2 * H, T0 + H, T0, T0 - H]);
    stream.accept(sent[0].requestId, hostPage(sent[0], host.columns));
    step();
    expect(state.shownStatus).toBe("loading");
    expect(drawnBoxes("settling")).toHaveLength(0);
    stream.accept(sent[1].requestId, hostPage(sent[1], host.columns));
    step();
    expect(state.shownStatus).toBe("loading");
    const settledId = (state.learned as NonNullable<typeof state.learned>).settledId;
    const light = liveSweeps(state.sweep).filter((box) => box.verdict === "light");
    const settled = light.filter((box) => box.id >= settledId);
    const unsettled = light.filter((box) => box.id < settledId);
    expect(settled.length).toBeGreaterThan(2);
    const drawn = volumesOf(state, drawnBoxes("settling"));
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((volume) => settled.some((box) => box.volume === volume))).toBe(true);
    expect(drawn.some((volume) => unsettled.some((box) => box.volume === volume))).toBe(false);
    expect(bookText("settling")).not.toBe(BOOK_UNKNOWN);
    liquidityVoidsIndicator.onBar(context(state, makeBar(liveFrom + 30 * MINUTE, 4_004, false), settings, { ...liquidityOf(feed), history: stream }, l2));
    expect(state.shownStatus).toBe("loading");
    expect(drawnBoxes("settling")).toHaveLength(0);
    expect(bookText("settling")).toBe(BOOK_UNKNOWN);
    stream.accept(sent[2].requestId, hostPage(sent[2], host.columns));
    step();
    expect(sent.map((request) => request.fromTs)).toEqual([T0 + 2 * H, T0 + H, T0, T0 - H]);
    expect(state.shownStatus).toBe("loading");
    expect(volumesOf(state, drawnBoxes("settling"))).toEqual(drawn);
    stream.accept(sent[3].requestId, hostPage(sent[3], host.columns));
    step();
    expect(state.shownStatus).toBeNull();
    const full = new Set(liveSweeps(state.sweep).filter((box) => box.verdict === "light").map(keyOf));
    expect(settled.every((box) => full.has(keyOf(box)))).toBe(true);
    expect(unsettled.some((box) => !full.has(keyOf(box)))).toBe(true);
    expect(drawnBoxes("settling").length).toBeGreaterThan(0);
    (state.pastSlot as NonNullable<typeof state.pastSlot>).hours.delete(T0 + 2 * H);
    step();
    expect(state.shownStatus).toBe("loading");
    expect(drawnBoxes("settling")).toHaveLength(0);
    expect(bookText("settling")).toBe(BOOK_UNKNOWN);
  });

  it("judges only the newest unbroken stretch when an older hour lands before a newer one, never pushes across the missing hour; once loaded, an hour that failed inside the asked span leaves a hole, not a shorter run (#46 review)", () => {
    const liveFrom = T0 + 3 * H;
    const lookback = liveFrom - 10 * MINUTE;
    const fast = (tape: Tape, count: number, volume: (i: number) => number): Tape => {
      for (let i = 0; i < count; i += 1) tape.jump(i % 2 === 0 ? 5 : -5, volume(i)).hold(2);
      return tape;
    };
    const host = new Tape(T0 - 20 * MINUTE).background(60);
    fast(host, 90, (i) => 200 + ((i * 37) % 100)).holdUntil(T0 + H);
    fast(host, 110, (i) => 5 + ((i * 7) % 15)).holdUntil(T0 + 2 * H);
    fast(host, 110, (i) => 30 + ((i * 13) % 50)).holdUntil(liveFrom);
    const live = new Tape(lookback);
    live.row = host.row;
    live.holdUntil(liveFrom).background(5);
    const columns = fine(live.columns);
    const feed = feedOf(columns);
    const l2 = l2With(feed, eventsOf(columns.filter((column) => column.ts >= liveFrom)), columns[columns.length - 1].ts + S);
    const settings = { ...LEARNED, historyHours: 2, boxesPerSide: 8, maxTradedByInstrument: { [instrumentKey(makeBar(T0))]: 1_000 } };
    const load = (owner: string): { state: LiquidityVoidsState; stream: ColumnHistoryStream; sent: HistoryRequest[]; step: () => void } => {
      const { stream, sent } = hostLane();
      const state = createState(settings, owner);
      const step = () => liquidityVoidsIndicator.onBar(context(state, makeBar(liveFrom + 5 * MINUTE, 4_004, false), settings, { ...liquidityOf(feed), history: stream }, l2));
      step();
      stream.accept(sent[0].requestId, hostPage(sent[0], host.columns));
      stream.accept(sent[2].requestId, hostPage(sent[2], host.columns));
      step();
      expect(sent.map((request) => request.fromTs)).toEqual([T0 + 2 * H, T0 + H, T0, T0 - H]);
      expect([state.shownStatus, state.learnedFrom]).toEqual(["loading", T0 + 2 * H]);
      expect(drawnBoxes(owner)).toHaveLength(0);
      return { state, stream, sent, step };
    };
    const arrived = load("out-of-order");
    arrived.stream.accept(arrived.sent[1].requestId, hostPage(arrived.sent[1], host.columns));
    arrived.stream.accept(arrived.sent[3].requestId, hostPage(arrived.sent[3], host.columns));
    arrived.step();
    expect([arrived.state.shownStatus, arrived.state.learnedFrom]).toEqual([null, lookback - 3 * H]);
    const failed = load("middle-failed");
    failed.stream.fail(failed.sent[1].requestId);
    failed.stream.accept(failed.sent[3].requestId, hostPage(failed.sent[3], host.columns));
    failed.step();
    expect([failed.state.shownStatus, failed.state.learnedFrom]).toEqual([null, lookback - 3 * H]);
  });

  it("draws nothing while loading when the run already ends on More data needed, so no box shows only until the hours are in: a market that has not traded for thirty minutes (#46 review)", () => {
    const { stream, sent } = hostLane();
    const liveFrom = T0 + 3 * H;
    const lookback = liveFrom - 10 * MINUTE;
    const host = new Tape(T0 - 20 * MINUTE).background(40).pushes(Array.from({ length: 50 }, (_, i) => 5 + ((i * 7) % 15))).holdUntil(T0 + H);
    host.background(10).pushes(Array.from({ length: 110 }, (_, i) => 15 + ((i * 53) % 170))).holdUntil(liveFrom);
    const live = new Tape(lookback);
    live.row = host.row;
    live.holdUntil(liveFrom).hold(200);
    const columns = fine(live.columns);
    const feed = feedOf(columns);
    const anchor: L2Event = { kind: "trade", ts: liveFrom, side: "ask", aggressor: "buy", mode: "swept", price: (host.row - 30) * ROW + ROW / 2, size: 1, late: false };
    const l2 = l2With(feed, [anchor], columns[columns.length - 1].ts + S);
    const settings = { ...LEARNED, historyHours: 2, boxesPerSide: 8, maxTradedByInstrument: { [instrumentKey(makeBar(T0))]: 1_000 } };
    const state = createState(settings, "quiet");
    const step = () => liquidityVoidsIndicator.onBar(context(state, makeBar(liveFrom + 35 * MINUTE, 4_004, false), settings, { ...liquidityOf(feed), history: stream }, l2));
    step();
    stream.accept(sent[0].requestId, hostPage(sent[0], host.columns));
    stream.accept(sent[1].requestId, hostPage(sent[1], host.columns));
    step();
    const learned = state.learned as NonNullable<typeof state.learned>;
    expect(state.shownStatus).toBe("loading");
    expect(liveSweeps(state.sweep).some((box) => box.verdict === "light" && box.id >= learned.settledId)).toBe(true);
    expect([learned.perSecond, learnedHasEnough(learned)]).toEqual([0, false]);
    expect(drawnBoxes("quiet")).toHaveLength(0);
    stream.accept(sent[2].requestId, hostPage(sent[2], host.columns));
    stream.accept(sent[3].requestId, hostPage(sent[3], host.columns));
    step();
    expect(state.shownStatus).toBe("moreData");
    expect(drawnBoxes("quiet")).toHaveLength(0);
  });

  it("re-judges the whole stretch after a bar it could not judge, so the candle close on that bar still ends the push it crosses (#46 review)", () => {
    const { stream } = hostLane();
    const { tape: host } = learningTape(T0 - H);
    host.holdUntil(T0);
    const engine = new Tape(T0);
    engine.row = host.row;
    engine.hold(240);
    const feed = feedOf(fine(engine.columns));
    const settings = { ...LEARNED, historyHours: 1 };
    const state = createState(settings, "lost-close");
    const step = (bar: BarFrame) => liquidityVoidsIndicator.onBar(context(state, bar, settings, { ...liquidityOf(feed), history: stream }, l2Of(feed)));
    step(makeBar(engine.ts - 2 * MINUTE, 4_004, false));
    const slot = state.pastSlot as NonNullable<typeof state.pastSlot>;
    const hour = { columns: host.columns, coveredTo: T0 };
    slot.hours.set(T0 - H, hour);
    slot.version += 1;
    step(makeBar(engine.ts - 2 * MINUTE, 4_004, false));
    expect(state.shownStatus).toBe("loading");
    expect(liveSweeps(state.sweep).filter((box) => box.side === "ask").map((box) => [box.verdict, box.volume])).toEqual([["light", 30]]);
    slot.hours.delete(T0 - H);
    step(makeBar(engine.ts - 2 * MINUTE, (BASE_ROW - 60) * ROW, true));
    slot.hours.set(T0 - H, hour);
    step(makeBar(engine.ts - MINUTE, 4_004, false));
    expect(state.shownStatus).toBe("loading");
    expect(liveSweeps(state.sweep).filter((box) => box.side === "ask")).toHaveLength(0);
  });

  it("does no learned work on a bar it does not draw, so a replay builds the run once, on the bar it draws, with every candle close known (#46 review)", () => {
    const { tape } = learningTape();
    const columns = fine(tape.columns);
    const feed = feedOf(columns);
    const state = createState(LEARNED, "drawn-only");
    vi.mocked(stepLearned).mockClear();
    for (let i = 0; i < 10; i += 1) liquidityVoidsIndicator.onBar(context(state, makeBar(T0 + i * MINUTE), LEARNED, liquidityOf(feed), l2Of(feed), false));
    expect([vi.mocked(stepLearned).mock.calls.length, state.learned]).toEqual([0, null]);
    liquidityVoidsIndicator.onBar(context(state, makeBar(tape.ts, 4_004, false), LEARNED, liquidityOf(feed), l2Of(feed)));
    expect(vi.mocked(stepLearned).mock.calls.length).toBe(columns.length);
    expect(state.bars).toHaveLength(11);
    expect(drawnBoxes("drawn-only").length).toBeGreaterThan(0);
  });

  it("re-judges the stretch while it loads only once it spans the memories plus sixty windows, counting the chart's own columns up to the newest it holds, and each time it has at least doubled, then the whole history once every hour is in (#46 review)", () => {
    const rebuilds = (engineSlots: number): number[] => {
      const engine = new Tape(T0).hold(engineSlots);
      const feed = feedOf(fine(engine.columns));
      const { stream } = hostLane();
      const settings = { ...LEARNED, historyHours: 3 };
      const state = createState(settings, `doubling-${engineSlots}`);
      const step = () => liquidityVoidsIndicator.onBar(context(state, makeBar(engine.ts, 4_004, false, 5 * MINUTE), settings, { ...liquidityOf(feed), history: stream }, l2Of(feed)));
      step();
      const slot = state.pastSlot as NonNullable<typeof state.pastSlot>;
      vi.mocked(pastColumns).mockClear();
      const counts: number[] = [];
      for (let back = 1; back <= 6; back += 1) {
        const start = T0 - back * H;
        slot.hours.set(start, { columns: new Tape(start).holdUntil(start + H).columns, coveredTo: start + H });
        slot.version += 1;
        step();
        counts.push(vi.mocked(pastColumns).mock.calls.length);
      }
      expect(state.shownStatus).not.toBe("loading");
      return counts;
    };
    expect(rebuilds(30)).toEqual([0, 0, 1, 1, 1, 2]);
    expect(rebuilds(348)).toEqual([0, 0, 1, 1, 1, 2]);
    expect(rebuilds(420)).toEqual([0, 1, 1, 2, 2, 3]);
  });

  it("re-judges the whole history once every hour is in or failed, even when the last hour failed and nothing new came with it (#46 review)", () => {
    const engine = new Tape(T0).hold(240);
    const feed = feedOf(fine(engine.columns));
    const { stream } = hostLane();
    const settings = { ...LEARNED, historyHours: 1 };
    const state = createState(settings, "last-failed");
    const step = () => liquidityVoidsIndicator.onBar(context(state, makeBar(engine.ts, 4_004, false), settings, { ...liquidityOf(feed), history: stream }, l2Of(feed)));
    step();
    const slot = state.pastSlot as NonNullable<typeof state.pastSlot>;
    vi.mocked(pastColumns).mockClear();
    slot.hours.set(T0 - H, { columns: new Tape(T0 - H).holdUntil(T0).columns, coveredTo: T0 });
    slot.version += 1;
    step();
    expect([state.shownStatus, vi.mocked(pastColumns).mock.calls.length, state.learnedLoaded]).toEqual(["loading", 1, false]);
    slot.failed.add(T0 - 2 * H);
    step();
    expect([state.shownStatus, vi.mocked(pastColumns).mock.calls.length, state.learnedLoaded]).toEqual(["moreData", 2, true]);
  });

  it("judges nothing while no host hour has come, however long the chart's own columns run, since it cannot tell yet where the host's columns end (#46 review)", () => {
    const engine = new Tape(T0).hold(420);
    const feed = feedOf(fine(engine.columns));
    const { stream } = hostLane();
    const settings = { ...LEARNED, historyHours: 1 };
    const state = createState(settings, "no-hours");
    vi.mocked(stepLearned).mockClear();
    liquidityVoidsIndicator.onBar(context(state, makeBar(engine.ts, 4_004, false), settings, { ...liquidityOf(feed), history: stream }, l2Of(feed)));
    expect(state.shownStatus).toBe("loading");
    expect(vi.mocked(stepLearned).mock.calls.length).toBe(0);
    expect(state.learned).toBeNull();
  });

  it("steps the chart's own columns from where the host's columns end, not from the live start, and samples the spread from every column the chart holds", () => {
    const { stream, sent } = hostLane();
    const liveFrom = T0 + 2 * H;
    const hostEnd = liveFrom - 30 * S;
    const host = new Tape(T0).holdUntil(hostEnd);
    const lookback = liveFrom - 30 * MINUTE;
    const columns = fine(new Tape(lookback).holdUntil(liveFrom + 20 * S).columns);
    const feed = feedOf(columns);
    const liquidity = { ...liquidityOf(feed), history: stream };
    const settings = { ...LEARNED, historyHours: 1 };
    const l2 = l2With(feed, eventsOf(columns.filter((column) => column.ts >= liveFrom)), liveFrom + 20 * S);
    const state = createState(settings, "lag");
    const bar = makeBar(liveFrom, 4_004, false);
    const step = () => liquidityVoidsIndicator.onBar(context(state, bar, settings, liquidity, l2));
    step();
    const accepted = new Set<number>();
    while (sent.some((request) => !accepted.has(request.requestId))) {
      const pending = sent.find((request) => !accepted.has(request.requestId)) as HistoryRequest;
      accepted.add(pending.requestId);
      stream.accept(pending.requestId, hostPage(pending, host.columns));
    }
    expect(accepted.size).toBe(3);
    const before = vi.mocked(stepLearned).mock.calls.length;
    step();
    expect(state.shownStatus).toBe("moreData");
    expect(vi.mocked(stepLearned).mock.calls.length - before).toBe(host.columns.length + 50);
    expect(state.learnedEngineFrom).toBe(hostEnd);
    expect(bookText("lag")).not.toBe(BOOK_UNKNOWN);
    step();
    expect(vi.mocked(stepLearned).mock.calls.length - before).toBe(host.columns.length + 50);
  });

  it("treats an hour the host could not give as answered, so a failed chunk never leaves the chart loading for ever", () => {
    const { stream, sent } = hostLane();
    const host = new Tape(T0).background(40).pushes([30, 60, 90, 120, 150, 180, 210, 240]).holdUntil(T0 + H).background(10).pushes([60, 300, 30]).holdUntil(T0 + 2 * H);
    const liveFrom = T0 + 2 * H;
    const live = new Tape(liveFrom).background(10).pushes([45]).background(5);
    const feed = feedOf(fine(live.columns));
    const liquidity = { ...liquidityOf(feed), history: stream };
    const settings = { ...LEARNED, historyHours: 1 };
    const bar = makeBar(liveFrom + 10 * MINUTE, 4_004, false);
    const state = createState(settings, "failed");
    const step = () => liquidityVoidsIndicator.onBar(context(state, bar, settings, liquidity, l2Of(feed)));
    step();
    stream.accept(sent[0].requestId, hostPage(sent[0], host.columns));
    stream.fail(sent[1].requestId);
    step();
    expect(state.shownStatus).toBe("moreData");
    expect(drawnBoxes("failed")).toHaveLength(0);
    expect(liveSweeps(state.sweep).filter((box) => box.verdict === "light")).toHaveLength(0);
  });

  it("copies the host's held columns only when it rebuilds, never on a bar that only steps the live columns, and asks the host only on a bar it draws, so a long replay stays cheap (#46 review)", () => {
    const { tape } = learningTape();
    const feed = feedOf(fine(tape.columns));
    const { stream } = hostLane();
    const withHost = { ...LEARNED, historyHours: 1 };
    const state = createState(withHost, "held-once");
    const step = (drawNow: boolean) => liquidityVoidsIndicator.onBar(context(state, makeBar(tape.ts, 4_004, false), withHost, { ...liquidityOf(feed), history: stream }, l2Of(feed), drawNow));
    step(false);
    const slot = state.pastSlot as NonNullable<typeof state.pastSlot>;
    for (let start = Math.floor((T0 - 2 * H) / H) * H; start < T0 + H; start += H) slot.hours.set(start, { columns: [], coveredTo: Math.min(start + H, T0) });
    slot.version += 1;
    vi.mocked(pastColumns).mockClear();
    const want = vi.spyOn(stream, "want");
    for (let i = 0; i < 50; i += 1) step(i === 49);
    expect(state.shownStatus).not.toBe("loading");
    expect(vi.mocked(pastColumns).mock.calls.length).toBe(1);
    expect(want).toHaveBeenCalledTimes(1);
  });

  it("steps the live columns once each and rebuilds only when the host's columns change", () => {
    const { tape } = learningTape();
    const columns = fine(tape.columns);
    const feed = feedOf(columns);
    const state = createState(LEARNED, "steps");
    const bar = makeBar(tape.ts, 4_004, false);
    vi.mocked(stepLearned).mockClear();
    liquidityVoidsIndicator.onBar(context(state, bar, LEARNED, liquidityOf(feed), l2Of(feed)));
    const stepped = vi.mocked(stepLearned).mock.calls.length;
    expect(stepped).toBe(columns.length);
    liquidityVoidsIndicator.onBar(context(state, bar, LEARNED, liquidityOf(feed), l2Of(feed)));
    expect(vi.mocked(stepLearned).mock.calls.length).toBe(stepped);
    const later = feedOf([...columns, ...fine(new Tape(tape.ts).hold(3).columns)]);
    liquidityVoidsIndicator.onBar(context(state, makeBar(tape.ts + 30 * S, 4_004, false), LEARNED, liquidityOf(later), l2Of(later)));
    expect(vi.mocked(stepLearned).mock.calls.length).toBe(stepped + 30);
    expect(drawnBoxes("steps")).toHaveLength(1);
    const { stream } = hostLane();
    const withHost = { ...LEARNED, historyHours: 1 };
    const hosted = createState(withHost, "hosted");
    const hostedBar = makeBar(tape.ts, 4_004, false);
    const hostedStep = () => liquidityVoidsIndicator.onBar(context(hosted, hostedBar, withHost, { ...liquidityOf(feed), history: stream }, l2Of(feed)));
    hostedStep();
    expect(hosted.shownStatus).toBe("loading");
    const slot = hosted.pastSlot as NonNullable<typeof hosted.pastSlot>;
    for (let start = Math.floor((T0 - 2 * H) / H) * H; start < T0 + H; start += H) slot.hours.set(start, { columns: [], coveredTo: Math.min(start + H, T0) });
    slot.version += 1;
    const before = vi.mocked(stepLearned).mock.calls.length;
    hostedStep();
    expect(vi.mocked(stepLearned).mock.calls.length).toBe(before + columns.length);
    hostedStep();
    expect(vi.mocked(stepLearned).mock.calls.length).toBe(before + columns.length);
    slot.version += 1;
    hostedStep();
    expect(vi.mocked(stepLearned).mock.calls.length).toBe(before + 2 * columns.length);
  });
});
