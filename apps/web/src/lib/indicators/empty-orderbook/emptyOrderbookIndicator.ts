import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../../chart/indicatorTypes";
import type { BoxHandle } from "../../chart/draw/box";
import { draw } from "../../chart/draw";
import { instrumentKey } from "../../chart/drawingStore";
import { CARD_FILL, CARD_TEXT } from "../institutional-order-blocks/institutionalRender";
import { MAX_BARS } from "../institutional-order-blocks-v2/institutionalOrderBlocksV2";
import { sizeUnitFor } from "../institutional-order-blocks-v2/institutionalV2Rules";
import { eachColumn } from "../absorption-detector/absorptionColumns";
import type { Identity, Sensitivity } from "../liquidity-voids/liquidityVoidsRules";
import { liquidityIndexAtOrAfter } from "../passive-liquidity/liquidityGrid";
import { clusterRowsFor } from "../passive-liquidity/liquiditySettings";
import { liquidityStyleFor } from "../passive-liquidity/liquidityStyle";
import { CHIP_PADDING, CHIP_RADIUS, LEVEL_FONT_FAMILY, LEVEL_FONT_SIZE } from "../session-levels/sessionLevelsRules";
import { createEmptyBookState, emptiestWindow, emptyBookFlashes, emptyBookZones, stepEmptyBook, type EmptyBookFlash, type EmptyBookState, type EmptyBookZone } from "./emptyBookModel";
import { emptyBookRulesFor, minRowsOf } from "./emptyBookRules";
import { createFlashSlots, createZoneSlots, keptZones, renderFlashes, renderZones, restingIn, sizeText, zonePrices, type DrawnFlash, type ZoneFrame, type ZoneGeometry } from "./emptyOrderbookRender";
import { DEFAULT_EMPTY_ORDERBOOK_SETTINGS, EMPTY_ORDERBOOK_SETTINGS_SCHEMA, MAX_ZONE_LENGTH_MIN, MAX_ZONES_PER_SIDE, clearRowsOf, heightRowsOf, marketFieldsFor, refillMultipleOf, thinShareOf, zoneLengthMsOf, zonesPerSideOf, type EmptyOrderbookSettings } from "./emptyOrderbookSettings";

export type EmptyBookStatus = "waiting" | "historical" | "stale";
export const EMPTY_BOOK_STATUS_TEXT: Readonly<Record<EmptyBookStatus, string>> = Object.freeze({
  waiting: "Empty Orderbook · waiting for the book",
  historical: "Empty Orderbook · unavailable in Historical Mode",
  stale: "Empty Orderbook · book stale",
});
export const STALE_MS = 30_000;
export const MIN_ROWS_PER_SIDE = 30;
export const ROW_CAP_SLACK = 2;
export const SENSITIVITY: Sensitivity = "high";
export const REPLAY_MS = MAX_ZONE_LENGTH_MIN * 60_000 + 300_000;
export const STATUS_HEIGHT_PX = 18;
export const MAX_MODEL_SLOTS = 4;
export const ZONE_SLOTS = 4 * MAX_ZONES_PER_SIDE;
export const FLASH_SLOTS = 16;

const models = new Map<string, EmptyBookState>();

export function modelFor(key: string, clusterRows: number): EmptyBookState {
  const model = models.get(key) ?? createEmptyBookState(clusterRows);
  models.delete(key);
  models.set(key, model);
  if (models.size > MAX_MODEL_SLOTS) models.delete(models.keys().next().value as string);
  return model;
}

export function resetModelsForTests(): void {
  models.clear();
}

export interface EmptyOrderbookState {
  model: EmptyBookState | null;
  clusterRows: number;
  rowWidth: number;
  bars: KeptBar[];
  drawnRows: Map<string, number>;
  flashLeft: Map<string, number | null>;
  zones: BoxHandle[];
  flashes: BoxHandle[];
  status: BoxHandle;
  shownStatus: EmptyBookStatus | null;
}

export interface KeptBar {
  open: number;
  high: number;
  low: number;
}

function keepBar(bars: KeptBar[], open: number, high: number, low: number): void {
  const last = bars[bars.length - 1];
  if (last !== undefined && open === last.open) {
    last.high = high;
    last.low = low;
    return;
  }
  if (last !== undefined && open < last.open) return;
  bars.push({ open, high, low });
  if (bars.length > MAX_BARS) bars.shift();
}

export function clearedSince(bars: readonly KeptBar[], since: number, bottom: number, top: number, intervalMs: number): number {
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index];
    if (bar.open + intervalMs <= since) break;
    if (bar.low < top && bar.high >= bottom) return Math.max(since, bar.open + intervalMs);
  }
  return since;
}

function clearedOf<T extends { lo: number; hi: number; since: number }>(item: T, bars: readonly KeptBar[], geometry: ZoneGeometry, intervalMs: number): T {
  const { bottom, top } = zonePrices(item.lo, item.hi, geometry);
  return { ...item, since: clearedSince(bars, item.since, bottom, top, intervalMs) };
}

function statusSlot(): BoxHandle {
  return draw.box({
    time1: 0, price1: 0, time2: 0, price2: 0, borderColor: "transparent", backgroundColor: "transparent", borderWidth: 0,
    text: "", textColor: "transparent", fontSize: LEVEL_FONT_SIZE, fontFamily: LEVEL_FONT_FAMILY, textAlign: "right", textPadding: CHIP_PADDING, cornerRadius: CHIP_RADIUS,
  });
}

function showStatus(state: EmptyOrderbookState, status: EmptyBookStatus | null, barTs: number, price: number): void {
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
  slot.setText(EMPTY_BOOK_STATUS_TEXT[status]);
  slot.setTextFallbacks([]);
  slot.setTextColor(CARD_TEXT);
  slot.setTextBackground(CARD_FILL);
}

const NO_FRAME: ZoneFrame = { geometry: { rowWidth: 1, clusterRows: 1 }, nowTs: 0, leftOf: () => 0, liveOpen: 0, flashMs: 0, sizeOf: () => null };

export function leftEdgeOf(bars: readonly { open: number }[], since: number, nowTs: number, lengthMs: number, liveOpen: number, intervalMs: number): number {
  const ts = Math.max(since, nowTs - lengthMs);
  if (ts >= liveOpen || bars.length === 0) return liveOpen;
  if (ts < bars[0].open) return bars[0].open;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].open <= ts) lo = mid;
    else hi = mid - 1;
  }
  if (bars[lo].open + intervalMs > ts) return bars[lo].open;
  return bars[lo + 1]?.open ?? liveOpen;
}

function hideZones(state: EmptyOrderbookState, settings: EmptyOrderbookSettings): void {
  renderZones(state.zones, [], settings, NO_FRAME);
  renderFlashes(state.flashes, [], settings, NO_FRAME);
  state.drawnRows = new Map();
  state.flashLeft.clear();
}

export function windowOf(model: EmptyBookState, zone: EmptyBookZone, rows: number): EmptyBookZone {
  const lo = emptiestWindow(model, zone, rows);
  return { ...zone, lo, hi: lo + Math.max(1, Math.min(Math.floor(rows), zone.hi - zone.lo + 1)) - 1 };
}

export function drawnFlashes(state: Pick<EmptyOrderbookState, "drawnRows" | "flashLeft">, flashes: readonly EmptyBookFlash[]): DrawnFlash[] {
  const shown: DrawnFlash[] = [];
  const current = new Set<string>();
  for (const flash of flashes) {
    const key = `${flash.side}:${flash.row}:${flash.ts}`;
    current.add(key);
    if (!state.flashLeft.has(key)) state.flashLeft.set(key, state.drawnRows.get(`${flash.side}:${flash.row}`) ?? null);
    const left = state.flashLeft.get(key);
    if (typeof left === "number") shown.push({ side: flash.side, row: flash.row, ts: flash.ts, left });
  }
  for (const key of [...state.flashLeft.keys()]) if (!current.has(key)) state.flashLeft.delete(key);
  return shown;
}

export function rowsDrawn(zones: readonly Pick<EmptyBookZone, "side" | "lo" | "hi" | "since">[], leftOf: (since: number) => number): Map<string, number> {
  const rows = new Map<string, number>();
  for (const zone of zones) {
    const left = leftOf(zone.since);
    for (let row = zone.lo; row <= zone.hi; row += 1) rows.set(`${zone.side}:${row}`, left);
  }
  return rows;
}

export function heatmapRowsOf(ctx: Pick<IndicatorBarCtx<EmptyOrderbookState, EmptyOrderbookSettings>, "bar" | "liquidity">, previous: number = Number.NaN): number {
  const { bar, liquidity } = ctx;
  const chosen = liquidity?.heatmapClusterRows;
  const base = typeof chosen === "number" && chosen >= 1 ? chosen : liquidityStyleFor(bar.provider, bar.symbol, bar.marketKind).defaultSettings.clusterRows;
  const rows = clusterRowsFor({ clusterRows: base }, bar.interval_ms);
  const columns = liquidity?.feed.fine.columns ?? [];
  const newest = columns[columns.length - 1];
  if (newest === undefined) return rows;
  const side = Math.floor((newest.hi - newest.lo + 1) / 2);
  const capped = Math.max(1, Math.min(rows, Math.floor(side / MIN_ROWS_PER_SIDE)));
  const loosest = Math.min(rows, Math.floor(side / (MIN_ROWS_PER_SIDE - ROW_CAP_SLACK)));
  return previous >= capped && previous <= loosest ? previous : capped;
}

export function statusOf(ctx: Pick<IndicatorBarCtx<EmptyOrderbookState, EmptyOrderbookSettings>, "l2" | "liquidity">): EmptyBookStatus | null {
  const { l2, liquidity } = ctx;
  if (l2?.availability === "HISTORICAL_UNAVAILABLE") return "historical";
  if (l2?.availability === "HISTORICAL" && !l2.trusted()) return "waiting";
  if (!liquidity || !(liquidity.rowWidth > 0) || liquidity.feed.fine.columns.length === 0) return "waiting";
  return null;
}

export const emptyOrderbookIndicator: RuntimeIndicatorDef<EmptyOrderbookState, EmptyOrderbookSettings> = {
  kind: "runtime",
  id: "emptyOrderbook",
  label: "Empty Orderbook",
  category: "l2",
  defaultSettings: DEFAULT_EMPTY_ORDERBOOK_SETTINGS,
  settingsSchema: EMPTY_ORDERBOOK_SETTINGS_SCHEMA,
  settingsFieldsFor: marketFieldsFor,
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  createState(): EmptyOrderbookState {
    return { model: null, clusterRows: NaN, rowWidth: NaN, bars: [], drawnRows: new Map(), flashLeft: new Map(), zones: createZoneSlots(ZONE_SLOTS), flashes: createFlashSlots(FLASH_SLOTS), status: statusSlot(), shownStatus: null };
  },
  onBar(ctx: IndicatorBarCtx<EmptyOrderbookState, EmptyOrderbookSettings>): void {
    const { bar, state, settings, liquidity } = ctx;
    keepBar(state.bars, bar.ts_open, bar.high, bar.low);
    const status = statusOf(ctx);
    if (status !== null || !liquidity) {
      if (ctx.drawNow !== false) {
        hideZones(state, settings);
        showStatus(state, status ?? "waiting", bar.ts_open, bar.close);
      }
      return;
    }
    if (ctx.drawNow === false) return;
    const identity: Identity = bar;
    const feed = liquidity.feed;
    const rowWidth = liquidity.rowWidth;
    const clusterRows = heatmapRowsOf(ctx, state.clusterRows);
    const clearRows = clearRowsOf(settings);
    const thinShare = thinShareOf(settings, bar);
    const refillMultiple = refillMultipleOf(settings, bar);
    const fixedRows = heightRowsOf(settings);
    const key = `${instrumentKey(bar)}:${rowWidth}:${clusterRows}:${bar.interval_ms}:${thinShare}:${refillMultiple}:${clearRows}:${fixedRows ?? "auto"}:${feed.epoch}`;
    const model = modelFor(key, clusterRows);
    state.model = model;
    state.clusterRows = clusterRows;
    state.rowWidth = rowWidth;
    const rules = emptyBookRulesFor(clusterRows, fixedRows ?? minRowsOf({ sensitivity: SENSITIVITY }, identity, bar.close, bar.interval_ms, rowWidth, clusterRows), liquidityStyleFor(bar.provider, bar.symbol, bar.marketKind).bandSizes, clearRows, thinShare, refillMultiple);
    const { columns } = feed.fine;
    const newest = columns[columns.length - 1];
    const from = model.lastTs === null ? newest.ts - REPLAY_MS : model.lastTs + 1;
    eachColumn(feed, from, Infinity, (column, spacing) => stepEmptyBook(model, column, rules, spacing));
    const nowTs = model.lastTs ?? bar.ts_open;
    const now = ctx.l2?.availability === "HISTORICAL" ? bar.ts_open + bar.interval_ms : Date.now();
    if (now - newest.ts > STALE_MS) {
      hideZones(state, settings);
      showStatus(state, "stale", bar.ts_open, bar.close);
      return;
    }
    const book = columns[Math.min(columns.length - 1, liquidityIndexAtOrAfter(columns, nowTs))];
    const unit = sizeUnitFor(bar);
    const lengthMs = zoneLengthMsOf(settings);
    const geometry: ZoneGeometry = { rowWidth, clusterRows };
    const frame: ZoneFrame = {
      geometry,
      nowTs,
      leftOf: (since) => leftEdgeOf(state.bars, since, nowTs, lengthMs, bar.ts_open, bar.interval_ms),
      liveOpen: bar.ts_open,
      flashMs: rules.flashMs,
      sizeOf: (zone) => sizeText(restingIn(book, zone, clusterRows, rules.bandSizes), unit),
    };
    const priceBand = Math.floor(bar.close / rowWidth / clusterRows);
    const candidates = emptyBookZones(model).map((zone) => (fixedRows === null ? zone : windowOf(model, zone, fixedRows)));
    const zones = keptZones(candidates.map((zone) => clearedOf(zone, state.bars, geometry, bar.interval_ms)), zonesPerSideOf(settings), priceBand, settings.levelsBy).slice(0, state.zones.length);
    renderZones(state.zones, zones, settings, frame);
    const flashes = drawnFlashes(state, settings.showFlash ? emptyBookFlashes(model) : []);
    renderFlashes(state.flashes, flashes, settings, frame);
    state.drawnRows = rowsDrawn(zones, frame.leftOf);
    showStatus(state, null, bar.ts_open, bar.close);
  },
};
