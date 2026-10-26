import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../../chart/indicatorTypes";
import type { BoxHandle } from "../../chart/draw/box";
import type { TableHandle } from "../../chart/draw/table";
import { draw } from "../../chart/draw";
import { eachColumn, newestColumnTs, type ColumnFeed } from "../absorption-detector/absorptionColumns";
import { EngineAbsorptionTracker, backfillEventHistory } from "../absorption-detector/engineAbsorption";
import type { IndicatorL2 } from "../../chart/indicatorL2";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import { STREAM_LEVEL_MS, type ColumnHistoryStream } from "../passive-liquidity/columnHistoryStream";
import { CARD_FILL, CARD_TEXT } from "../institutional-order-blocks/institutionalRender";
import { MAX_BARS, snapToBar } from "../institutional-order-blocks-v2/institutionalOrderBlocksV2";
import { sizeUnitFor } from "../institutional-order-blocks-v2/institutionalV2Rules";
import { CHIP_PADDING, CHIP_RADIUS, LEVEL_FONT_FAMILY, LEVEL_FONT_SIZE } from "../session-levels/sessionLevelsRules";
import { DEFAULT_LIQUIDITY_VOIDS_SETTINGS, MAX_VOID_SLOTS, bubbleSizeFor, historyHoursOf, learnedKOf, minMoveOf, maxTradedOf, priceUnitFor, sweepRulesFor, learnedMaxTradedOf, thresholdRuleFor, tickSizeFor, warmupMsFor, type Identity, type LiquidityVoidsSettings } from "./liquidityVoidsRules";
import { instrumentKey } from "../../chart/drawingStore";
import { LIQUIDITY_VOIDS_SETTINGS_SCHEMA, marketFieldsFor } from "./liquidityVoidsSchema";
import { createVoidSlots, priceText, renderVoids, type VoidFormat } from "./liquidityVoidsRender";
import { createSweepState, liveSweeps, noteSweepClose, resetSweeps, stepSweeps, type SweepState } from "./sweepModel";
import { createBookDepth, fillDistance, judgeBook, noteDepth, resetBookDepth, type BookDepthState, type BookLabel, type BookVerdict } from "./bookDepth";
import { RANK_PUSHES, createLearned, learnedHasEnough, settleSpanMs, stepLearned, windowMsFor, type LearnedState } from "./learnedThresholds";
import { askPast, heldFrom, pastColumns, pastLoaded, pastSlotFor, replayLearned, replayPast, type PastSlot, type ReplayColumn } from "./voidsPast";

export type VoidStatus = "waiting" | "untrusted" | "historical" | "stale" | "loading" | "moreData";
export const VOID_STATUS_TEXT: Readonly<Record<VoidStatus, string>> = Object.freeze({
  waiting: "Flowprint Blocks · waiting for the L2 engine",
  untrusted: "Flowprint Blocks · L2 feed untrusted",
  historical: "Flowprint Blocks · unavailable in Historical Mode",
  stale: "Flowprint Blocks · L2 feed stale",
  loading: "Flowprint Blocks · Loading history",
  moreData: "Flowprint Blocks · More data needed",
});
export const STALE_MS = 600_000;
export const STATUS_HEIGHT_PX = 18;
export const HISTORY_RETRY_MS = 10_000;
export const HISTORY_HELD_RETRY_MS = 60_000;
export const MAX_HISTORY_SLOTS = 4;
export const BOOK_LABEL = "Spread";
export const BOOK_UNKNOWN = "—";
export const BOOK_COLOR: Readonly<Record<BookLabel, string>> = Object.freeze({ "thin book": "#ef5350", "normal book": "#d1d4dc", "thick book": "#26a69a" });

export interface HistorySlot {
  engine: EngineAbsorptionTracker;
  from: number | null;
  running: boolean;
  notBefore: number;
}

const historySlots = new Map<string, HistorySlot>();

export function historySlotFor(identity: Identity, rowWidth: number): HistorySlot {
  const key = `${instrumentKey(identity)}:${rowWidth}`;
  const slot = historySlots.get(key) ?? { engine: new EngineAbsorptionTracker(true), from: null, running: false, notBefore: 0 };
  historySlots.delete(key);
  historySlots.set(key, slot);
  if (historySlots.size > MAX_HISTORY_SLOTS) historySlots.delete(historySlots.keys().next().value as string);
  return slot;
}

export function resetHistorySlotsForTests(): void {
  historySlots.clear();
}

export interface LiquidityVoidsState {
  sweep: SweepState;
  engine: EngineAbsorptionTracker;
  history: HistorySlot | null;
  coveredFrom: number | null;
  rowWidth: number;
  epoch: number | null;
  lastColumnTs: number | null;
  bars: { open: number; close: number | null }[];
  slots: BoxHandle[];
  status: BoxHandle;
  shownStatus: VoidStatus | null;
  depth: BookDepthState;
  book: TableHandle;
  pastSlot: PastSlot | null;
  past: SweepState | null;
  pastVersion: number;
  pastEnd: number;
  learned: LearnedState | null;
  learnedVersion: number;
  learnedEngineFrom: number;
  learnedFrom: number;
  learnedLoaded: boolean;
}

interface BarScope {
  rowWidth: number;
  engineFeed: ColumnFeed;
  lookback: number;
  seam: number;
  barEnd: number;
  format: VoidFormat;
  reachMs: number;
  lane: ColumnHistoryStream | null;
}

function keepBar(bars: { open: number; close: number | null }[], open: number, close: number | null): void {
  const last = bars[bars.length - 1];
  if (last !== undefined && open === last.open) {
    last.close = close;
    return;
  }
  if (last !== undefined && open < last.open) return;
  bars.push({ open, close });
  if (bars.length > MAX_BARS) bars.shift();
}

function statusSlot(): BoxHandle {
  return draw.box({
    time1: 0, price1: 0, time2: 0, price2: 0, borderColor: "transparent", backgroundColor: "transparent", borderWidth: 0,
    text: "", textColor: "transparent", fontSize: LEVEL_FONT_SIZE, fontFamily: LEVEL_FONT_FAMILY, textAlign: "right", textPadding: CHIP_PADDING, cornerRadius: CHIP_RADIUS,
  });
}

function showStatus(state: LiquidityVoidsState, status: VoidStatus | null, barTs: number, price: number): void {
  const slot = state.status;
  state.shownStatus = status;
  if (status === null) {
    slot.setLeftTop(0, 0);
    slot.setRightBottom(0, 0);
    slot.setText("");
    slot.setTextBackground("");
    slot.setMinHeightPx(0);
    slot.setExtendRight(false);
    return;
  }
  slot.setLeftTop(barTs, price);
  slot.setRightBottom(barTs, price);
  slot.setMinHeightPx(STATUS_HEIGHT_PX);
  slot.setExtendRight(true);
  slot.setText(VOID_STATUS_TEXT[status]);
  slot.setTextFallbacks([]);
  slot.setTextColor(CARD_TEXT);
  slot.setTextBackground(CARD_FILL);
}

export function bookText(verdict: BookVerdict | null, priceUnit: "$" | "pts"): string {
  if (verdict === null) return BOOK_UNKNOWN;
  const spread = priceUnit === "$" ? `$${priceText(verdict.value)}` : `${priceText(verdict.value)} pts`;
  return `${spread} · ${verdict.label}`;
}

function showBook(table: TableHandle, verdict: BookVerdict | null, priceUnit: "$" | "pts"): void {
  table.cell(0, 0, { text: BOOK_LABEL });
  table.cell(0, 1, { text: bookText(verdict, priceUnit), textColor: verdict === null ? BOOK_COLOR["normal book"] : BOOK_COLOR[verdict.label] });
}

function hideVoids(state: LiquidityVoidsState, settings: LiquidityVoidsSettings, rowWidth: number, nowTs: number): void {
  renderVoids(state.slots, [], settings, { rowWidth, tickSize: null, priceUnit: "$", sizeUnit: "" }, nowTs, (ts) => ts, nowTs, 0, null, -Infinity);
}

export function feedStatus(ctx: Pick<IndicatorBarCtx<LiquidityVoidsState, LiquidityVoidsSettings>, "l2" | "liquidity">): { status: VoidStatus | null; feed: ColumnFeed | null } {
  const { l2, liquidity } = ctx;
  if (l2 === undefined || !liquidity || !(liquidity.rowWidth > 0)) return { status: "waiting", feed: null };
  if (l2.availability === "HISTORICAL_UNAVAILABLE") return { status: "historical", feed: null };
  if (!l2.trusted()) return { status: "untrusted", feed: null };
  const feed = liquidity.feed;
  if (feed.fine.columns.length === 0) return { status: "waiting", feed: null };
  return { status: null, feed };
}

function askEventHistory(slot: HistorySlot, l2: IndicatorL2, feed: ColumnFeed, rowWidth: number, fromTs: number, now: number): void {
  const coveredFrom = slot.engine.coveredFrom;
  if (slot.running || now < slot.notBefore || coveredFrom === null || fromTs >= coveredFrom) return;
  if (slot.from !== null && fromTs >= slot.from) return;
  const last = feed.fine.columns[feed.fine.columns.length - 1];
  if (last === undefined) return;
  slot.from = fromTs;
  slot.running = true;
  const engine = slot.engine;
  void backfillEventHistory(l2, engine, fromTs, last.lo * rowWidth, (last.hi + 1) * rowWidth, () => undefined, () => slot.engine === engine).then(
    (fill) => {
      slot.running = false;
      if (fill === "filled") return;
      slot.from = null;
      slot.notBefore = Date.now() + (fill === "held" ? HISTORY_HELD_RETRY_MS : HISTORY_RETRY_MS);
    },
    () => {
      slot.running = false;
      slot.from = null;
      slot.notBefore = Date.now() + HISTORY_RETRY_MS;
    },
  );
}

function fixedBar(ctx: IndicatorBarCtx<LiquidityVoidsState, LiquidityVoidsSettings>, scope: BarScope): void {
  const { bar, state, settings } = ctx;
  const { rowWidth, engineFeed, lookback, seam, barEnd, format, reachMs, lane } = scope;
  const rules = sweepRulesFor(settings, minMoveOf(settings, bar, bar.close, bar.interval_ms), rowWidth);
  const last = state.lastColumnTs;
  const restep = last === null;
  if (restep) {
    resetSweeps(state.sweep, rowWidth, rowWidth === state.sweep.rowWidth ? lookback : -Infinity);
    resetBookDepth(state.depth);
  }
  const from = last === null ? lookback : last + 1;
  const fillSize = bubbleSizeFor(bar);
  eachColumn(engineFeed, from, barEnd, (column, columnMs) => {
    stepSweeps(state.sweep, column, rules, columnMs);
    const spread = fillDistance(column, fillSize, rowWidth);
    if (spread !== null) noteDepth(state.depth, column.ts, spread);
    state.lastColumnTs = column.ts;
  });
  if (restep) for (const kept of state.bars) if (kept.close !== null && kept.open < bar.ts_open) noteSweepClose(state.sweep, kept.open, kept.open + bar.interval_ms, Math.floor(kept.close / rowWidth));
  if (bar.closed) noteSweepClose(state.sweep, bar.ts_open, barEnd, Math.floor(bar.close / rowWidth));
  if (bar.closed && state.past !== null) noteSweepClose(state.past, bar.ts_open, barEnd, Math.floor(bar.close / rowWidth));
  const stale = state.lastColumnTs !== null && bar.ts_open - state.lastColumnTs > STALE_MS;
  if (ctx.drawNow === false) return;
  const nowTs = Math.max(state.lastColumnTs ?? bar.ts_open, bar.ts_open);
  if (state.pastSlot !== null && lane !== null && reachMs > 0) {
    askPast(state.pastSlot, lane, lookback - reachMs, seam);
    if (state.past === null || state.pastVersion !== state.pastSlot.version) {
      const held = pastColumns(state.pastSlot, lookback - reachMs, seam);
      state.past = replayPast(held.columns, state.bars, bar.interval_ms, rules, rowWidth);
      state.pastVersion = state.pastSlot.version;
      state.pastEnd = held.end;
    }
  } else {
    state.past = null;
    state.pastEnd = -Infinity;
  }
  const shown = state.past === null ? liveSweeps(state.sweep) : [...liveSweeps(state.past), ...liveSweeps(state.sweep).filter((box) => box.startTs >= state.pastEnd)];
  renderVoids(state.slots, stale ? [] : shown, settings, format, nowTs, (ts) => snapToBar(state.bars, ts, bar.ts_open), bar.ts_open, bar.close / rowWidth, maxTradedOf(bar, bar.interval_ms), lookback);
  showStatus(state, stale ? "stale" : null, bar.ts_open, bar.close);
  showBook(state.book, stale ? null : judgeBook(state.depth), format.priceUnit);
}

function sampleSpread(depth: BookDepthState, column: LiquidityColumn, bubble: number, rowWidth: number): void {
  const spread = fillDistance(column, bubble, rowWidth);
  if (spread !== null) noteDepth(depth, column.ts, spread);
}

function learnedBar(ctx: IndicatorBarCtx<LiquidityVoidsState, LiquidityVoidsSettings>, scope: BarScope): void {
  const { bar, state, settings } = ctx;
  const { rowWidth, engineFeed, lookback, seam, barEnd, reachMs, lane } = scope;
  const k = learnedKOf(settings);
  const windowMs = windowMsFor(bar.interval_ms);
  const slot = state.pastSlot;
  const usePast = slot !== null && lane !== null && reachMs > 0;
  const askFrom = lookback - reachMs - warmupMsFor(bar, windowMs);
  if (usePast) askPast(slot, lane, askFrom, seam);
  const loaded = !usePast || pastLoaded(slot, askFrom, seam);
  const from = usePast && !loaded ? heldFrom(slot, askFrom, seam) : askFrom;
  const ran = loaded || (from < seam && Math.max(seam, newestColumnTs(engineFeed)) - from >= settleSpanMs(windowMs) + RANK_PUSHES * windowMs);
  if (ran) {
    const bubble = bubbleSizeFor(bar);
    const version = usePast ? slot.version : 0;
    const grown = seam - from >= 2 * (seam - state.learnedFrom);
    if (state.lastColumnTs === null || state.learned === null || state.learnedLoaded !== loaded || (loaded ? state.learnedVersion !== version : grown)) {
      const held: readonly LiquidityColumn[] = usePast ? pastColumns(slot, from, seam).columns : [];
      const hostEnd = held.length > 0 ? held[held.length - 1].ts + STREAM_LEVEL_MS : -Infinity;
      const engineFrom = Math.max(lookback, hostEnd);
      const sweep = createSweepState(rowWidth);
      const learned = createLearned(windowMs);
      resetBookDepth(state.depth);
      eachColumn(engineFeed, lookback, barEnd, (column) => sampleSpread(state.depth, column, bubble, rowWidth));
      const columns: ReplayColumn[] = [];
      for (const column of held) if (column.ts < engineFrom) columns.push({ column, columnMs: STREAM_LEVEL_MS });
      eachColumn(engineFeed, engineFrom, barEnd, (column, columnMs) => {
        columns.push({ column, columnMs });
      });
      replayLearned(sweep, learned, k, columns, state.bars, bar.interval_ms);
      state.sweep = sweep;
      state.learned = learned;
      state.lastColumnTs = Math.max(engineFrom - 1, columns.length > 0 ? columns[columns.length - 1].column.ts : -Infinity);
      state.learnedVersion = version;
      state.learnedEngineFrom = engineFrom;
      state.learnedFrom = from;
      state.learnedLoaded = loaded;
    } else {
      const learned = state.learned;
      eachColumn(engineFeed, state.lastColumnTs + 1, barEnd, (column, columnMs) => {
        stepLearned(learned, state.sweep, column, columnMs, k);
        sampleSpread(state.depth, column, bubble, rowWidth);
        state.lastColumnTs = column.ts;
      });
    }
    if (bar.closed) noteSweepClose(state.sweep, bar.ts_open, barEnd, Math.floor(bar.close / rowWidth));
  } else state.lastColumnTs = null;
  drawLearned(ctx, scope, loaded, ran);
}

function drawLearned(ctx: IndicatorBarCtx<LiquidityVoidsState, LiquidityVoidsSettings>, scope: BarScope, loaded: boolean, ran: boolean): void {
  const { bar, state, settings } = ctx;
  const { rowWidth, lookback, format, reachMs } = scope;
  const stale = ran && state.lastColumnTs !== null && bar.ts_open - state.lastColumnTs > STALE_MS;
  const nowTs = Math.max(state.lastColumnTs ?? bar.ts_open, bar.ts_open);
  const enough = state.learned !== null && learnedHasEnough(state.learned);
  const status: VoidStatus | null = !loaded ? "loading" : stale ? "stale" : !enough ? "moreData" : null;
  const cut = reachMs > 0 ? lookback - reachMs : -Infinity;
  const settledId = loaded || state.learned === null ? -Infinity : state.learned.settledId;
  const drawable = loaded ? status === null : ran && !stale && enough;
  const shown = drawable ? liveSweeps(state.sweep).filter((box) => box.verdict === "light" && box.endTs >= cut && box.id >= settledId) : [];
  renderVoids(state.slots, shown, settings, format, nowTs, (ts) => snapToBar(state.bars, ts, bar.ts_open), bar.ts_open, bar.close / rowWidth, learnedMaxTradedOf(settings, bar, bar.interval_ms), -Infinity);
  showStatus(state, status, bar.ts_open, bar.close);
  showBook(state.book, ran && !stale ? judgeBook(state.depth) : null, format.priceUnit);
}

export const liquidityVoidsIndicator: RuntimeIndicatorDef<LiquidityVoidsState, LiquidityVoidsSettings> = {
  kind: "runtime",
  id: "liquidityVoids",
  label: "Flowprint Blocks",
  category: "l2",
  defaultSettings: DEFAULT_LIQUIDITY_VOIDS_SETTINGS,
  settingsSchema: LIQUIDITY_VOIDS_SETTINGS_SCHEMA,
  settingsFieldsFor: marketFieldsFor,
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  createState(): LiquidityVoidsState {
    return { sweep: createSweepState(NaN), engine: new EngineAbsorptionTracker(true), history: null, coveredFrom: null, rowWidth: NaN, epoch: null, lastColumnTs: null, bars: [], slots: createVoidSlots(MAX_VOID_SLOTS), status: statusSlot(), shownStatus: null, depth: createBookDepth(), book: draw.table({ position: "bottom-right" }), pastSlot: null, past: null, pastVersion: -1, pastEnd: -Infinity, learned: null, learnedVersion: -1, learnedEngineFrom: Infinity, learnedFrom: Infinity, learnedLoaded: false };
  },
  onBar(ctx: IndicatorBarCtx<LiquidityVoidsState, LiquidityVoidsSettings>): void {
    const { bar, state, settings, liquidity } = ctx;
    keepBar(state.bars, bar.ts_open, bar.closed ? bar.close : null);
    const { status, feed } = feedStatus(ctx);
    if (status !== null || feed === null || !liquidity) {
      if (ctx.drawNow !== false) {
        hideVoids(state, settings, Number.isFinite(state.rowWidth) ? state.rowWidth : 1, bar.ts_open);
        showStatus(state, status ?? "waiting", bar.ts_open, bar.close);
        showBook(state.book, null, "$");
      }
      return;
    }
    const rowWidth = liquidity.rowWidth;
    if (rowWidth !== state.rowWidth || feed.epoch !== state.epoch) {
      state.history = historySlotFor(bar, rowWidth);
      state.engine = state.history.engine;
      state.coveredFrom = null;
      state.rowWidth = rowWidth;
      state.epoch = feed.epoch;
      state.lastColumnTs = null;
      state.pastSlot = pastSlotFor(bar, rowWidth);
      state.past = null;
      state.pastEnd = -Infinity;
    }
    const learnedOn = thresholdRuleFor(settings, bar) === "learned";
    const engineFeed = state.engine.columns(ctx.l2, feed, rowWidth).feed;
    if (state.engine.coveredFrom !== state.coveredFrom) {
      const previous = state.coveredFrom;
      state.coveredFrom = state.engine.coveredFrom;
      if (!learnedOn || previous === null || previous > state.learnedEngineFrom) state.lastColumnTs = null;
    }
    const newest = newestColumnTs(engineFeed);
    const lookback = engineFeed.deep?.columns[0]?.ts ?? engineFeed.fine.columns[0]?.ts ?? newest;
    if (ctx.l2?.availability === "LIVE" && state.history !== null) askEventHistory(state.history, ctx.l2, feed, rowWidth, lookback, Date.now());
    const scope: BarScope = {
      rowWidth,
      engineFeed,
      lookback,
      seam: Math.max(lookback, state.engine.liveFrom ?? lookback),
      barEnd: bar.ts_open + bar.interval_ms,
      format: { rowWidth, tickSize: tickSizeFor(bar), priceUnit: priceUnitFor(bar), sizeUnit: sizeUnitFor(bar) },
      reachMs: historyHoursOf(settings) * 3_600_000,
      lane: liquidity.history ?? null,
    };
    if (!learnedOn) fixedBar(ctx, scope);
    else if (ctx.drawNow !== false) learnedBar(ctx, scope);
  },
};
