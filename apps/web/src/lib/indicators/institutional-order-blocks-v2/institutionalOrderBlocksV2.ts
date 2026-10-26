import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../../chart/indicatorTypes";
import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import { BOX_CORNER_RADIUS, BOX_FONT_FAMILY, BOX_FONT_SIZE } from "../institutional-order-blocks/institutionalOrderBlocks";
import { CARD_FILL, CARD_TEXT } from "../institutional-order-blocks/institutionalRender";
import { HOLE_MS, createBandTracker, mitigatedWalls, readBands, standingWalls, type BandTrackerState, type BarClose, type TrackerRules } from "./bandTracker";
import { adoptHistory, createEngineWalls, readEngine, type EngineReason, type EngineWallsState } from "./engineWalls";
import type { L2Wall } from "../../l2/types";
import { ENGINE_MARK, PLAIN_MARK, WALL_TEXT_PADDING, renderWalls } from "./institutionalV2Render";
import { minSizeField } from "./minSizeSchema";
import { bandRowsFor, DEFAULT_INSTITUTIONAL_V2_SETTINGS, RUNTIME_HISTORY_MS, historyHoursOf, minSizeOf, strongSizeFor, wallSizeFor, type InstitutionalV2Settings } from "./institutionalV2Rules";
import { INSTITUTIONAL_V2_SETTINGS_SCHEMA } from "./institutionalV2Schema";

export const MAX_WALLS = 64;
export const HALF_WALLS = MAX_WALLS / 2;

export const MAX_BARS = 11_000;

export type EngineStatus = Exclude<EngineReason, null> | "stale";

export const ENGINE_STATUS_TEXT: Readonly<Record<EngineStatus, string>> = Object.freeze({
  "no-l2": "IOB v2 · waiting for the L2 engine",
  historical: "IOB v2 · unavailable in Historical Mode",
  untrusted: "IOB v2 · L2 feed untrusted, walls hidden",
  stale: "IOB v2 · L2 feed stale, walls hidden",
});

export interface InstitutionalV2State {
  tracker: BandTrackerState;
  engine: EngineWallsState;
  rowWidth: number;
  bars: { open: number; ts: number; close: number; low: number; high: number }[];
  closes: BarClose[];
  slots: BoxHandle[];
  status: BoxHandle;
  historyAsked: boolean;
  hostAsked: boolean;
  hostUnsubscribe: (() => void) | null;
  pastWalls: readonly L2Wall[] | null;
}

export function snapToBar(bars: readonly { open: number }[], ts: number, liveOpen: number): number {
  if (ts >= liveOpen || bars.length === 0) return liveOpen;
  if (ts <= bars[0].open) return bars[0].open;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].open <= ts) lo = mid;
    else hi = mid - 1;
  }
  return bars[lo].open;
}

export function lastClosedBefore(bars: readonly { open: number; low: number; high: number }[], ts: number): { low: number; high: number } | null {
  for (let i = bars.length - 1; i >= 0; i -= 1) if (bars[i].open < ts) return bars[i];
  return null;
}

function rememberClose(state: InstitutionalV2State, open: number, ts: number, close: number, low: number, high: number, rowWidth: number): void {
  const row = Math.floor(close / rowWidth);
  const last = state.bars[state.bars.length - 1];
  if (last !== undefined && ts <= last.ts) {
    if (ts === last.ts) {
      state.bars[state.bars.length - 1] = { open, ts, close, low, high };
      state.closes[state.closes.length - 1] = { ts, row };
    }
    return;
  }
  state.bars.push({ open, ts, close, low, high });
  state.closes.push({ ts, row });
  if (state.bars.length > MAX_BARS) {
    state.bars.shift();
    state.closes.shift();
  }
}

function askWallHistory(state: InstitutionalV2State, l2: NonNullable<IndicatorBarCtx<InstitutionalV2State, InstitutionalV2Settings>["l2"]>, nowTs: number): void {
  const lane0 = l2.lanes().find((lane) => lane.lane === 0);
  if (lane0 === undefined) return;
  state.historyAsked = true;
  const engine = state.engine;
  void l2.wallHistory({ fromTs: Math.max(0, nowTs - RUNTIME_HISTORY_MS), toTs: nowTs, priceLo: lane0.priceLo, priceHi: lane0.priceHi }).then((history) => {
    if (history === null || state.engine !== engine) return;
    state.pastWalls = [...(state.pastWalls ?? []), ...history.walls];
  });
}

function askHostWalls(state: InstitutionalV2State, l2: NonNullable<IndicatorBarCtx<InstitutionalV2State, InstitutionalV2Settings>["l2"]>, nowTs: number, hours: number): void {
  const host = l2.hostWalls;
  if (host === null) return;
  state.hostAsked = true;
  const engine = state.engine;
  state.hostUnsubscribe?.();
  state.hostUnsubscribe = host.subscribe({
    onWalls: (walls) => {
      if (state.engine !== engine) return;
      state.pastWalls = [...(state.pastWalls ?? []), ...walls];
    },
    onChunk: () => undefined,
  });
  host.want(Math.max(0, nowTs - hours * 3_600_000), nowTs - RUNTIME_HISTORY_MS);
}

function box(): BoxHandle {
  return draw.box({ time1: 0, price1: 0, time2: 0, price2: 0, borderColor: "transparent", backgroundColor: "transparent", text: "", fontSize: BOX_FONT_SIZE, textAlign: "right", fontFamily: BOX_FONT_FAMILY, cornerRadius: BOX_CORNER_RADIUS, textPadding: WALL_TEXT_PADDING });
}

function showStatus(slot: BoxHandle, status: EngineStatus | null, barTs: number, intervalMs: number, price: number, thicknessPx: number): void {
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
  slot.setRightBottom(barTs + intervalMs, price);
  slot.setBorderColor("transparent");
  slot.setBackgroundColor("transparent");
  slot.setMinHeightPx(thicknessPx);
  slot.setExtendRight(true);
  slot.setText(ENGINE_STATUS_TEXT[status]);
  slot.setTextFallbacks([]);
  slot.setTextColor(CARD_TEXT);
  slot.setTextBackground(CARD_FILL);
  slot.setTailFade(false);
}

export const institutionalOrderBlocksV2Indicator: RuntimeIndicatorDef<InstitutionalV2State, InstitutionalV2Settings> = {
  kind: "runtime",
  id: "institutionalOrderBlocksV2",
  label: "Institutional Order Blocks v2",
  category: "l2",
  defaultSettings: DEFAULT_INSTITUTIONAL_V2_SETTINGS,
  settingsSchema: INSTITUTIONAL_V2_SETTINGS_SCHEMA,
  settingsFieldsFor: (identity) => ({ minSizeByInstrument: minSizeField(identity) }),
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  createState(): InstitutionalV2State {
    return {
      tracker: createBandTracker(),
      engine: createEngineWalls(),
      rowWidth: NaN,
      bars: [],
      closes: [],
      slots: Array.from({ length: MAX_WALLS }, box),
      status: box(),
      historyAsked: false,
      hostAsked: false,
      hostUnsubscribe: null,
      pastWalls: null,
    };
  },
  onBar(ctx: IndicatorBarCtx<InstitutionalV2State, InstitutionalV2Settings>): void {
    const { bar, state, settings, liquidity } = ctx;
    if (bar.closed) rememberClose(state, bar.ts_open, bar.ts_open + bar.interval_ms, bar.close, bar.low, bar.high, state.rowWidth);
    const strongSize = strongSizeFor(bar);
    if (!liquidity || !(liquidity.rowWidth > 0)) {
      if (ctx.drawNow !== false) {
        renderWalls(state.slots, [], [], settings, bar.ts_open, bar.ts_open, (ts) => ts, 1, "", 0, bar.close, strongSize);
        showStatus(state.status, null, bar.ts_open, bar.interval_ms, bar.close, settings.bandThicknessPx);
      }
      return;
    }
    if (liquidity.rowWidth !== state.rowWidth) {
      state.tracker = createBandTracker();
      state.engine = createEngineWalls(historyHoursOf(settings) * 3_600_000);
      state.historyAsked = false;
      state.hostAsked = false;
      state.hostUnsubscribe?.();
      state.hostUnsubscribe = null;
      state.pastWalls = null;
      state.rowWidth = liquidity.rowWidth;
      state.closes = state.bars.map((closed) => ({ ts: closed.ts, row: Math.floor(closed.close / liquidity.rowWidth) }));
    }
    const edge = bar.ts_open + bar.interval_ms;
    const rules: TrackerRules = { bandRows: bandRowsFor(bar), wallSize: wallSizeFor(bar), strongSize };
    const trackerOn = settings.source !== "engine";
    const engineOn = settings.source !== "tracker";
    if (trackerOn) readBands(state.tracker, liquidity.feed, edge, rules, ctx.l2?.availability === "HISTORICAL" ? edge : undefined, state.closes);
    if (engineOn && state.pastWalls !== null) {
      adoptHistory(state.engine, state.pastWalls, rules, state.closes);
      state.pastWalls = null;
    }
    state.engine.memoryMs = historyHoursOf(settings) * 3_600_000;
    let status: EngineStatus | null = engineOn ? readEngine(state.engine, ctx.l2, rules, edge, state.closes) : null;
    if (engineOn && status === null && ctx.l2?.availability === "HISTORICAL" && ctx.l2.historicalWalls !== undefined) {
      adoptHistory(state.engine, ctx.l2.historicalWalls().filter((wall) => wall.endTs !== null).map((wall) => ({ ...wall, id: -wall.id })), rules, state.closes);
    }
    if (engineOn && status === null && !state.historyAsked && ctx.l2?.availability !== "HISTORICAL" && ctx.l2 !== undefined) askWallHistory(state, ctx.l2, edge);
    if (engineOn && status === null && !state.hostAsked && ctx.l2?.availability !== "HISTORICAL" && ctx.l2 !== undefined) askHostWalls(state, ctx.l2, edge, historyHoursOf(settings));
    if (engineOn && status === null && state.engine.lastTs !== null && bar.ts_open - state.engine.lastTs > HOLE_MS) status = "stale";
    if (ctx.drawNow === false) return;
    const snap = (ts: number) => snapToBar(state.bars, ts, bar.ts_open);
    const previous = lastClosedBefore(state.bars, bar.ts_open);
    const ranges: (readonly [number, number])[] = previous === null ? [[bar.low, bar.high]] : [[bar.low, bar.high], [previous.low, previous.high]];
    const minSize = minSizeOf(settings, bar);
    const [trackerSlots, engineSlots] = settings.source === "both" ? [state.slots.slice(0, HALF_WALLS), state.slots.slice(HALF_WALLS)] : settings.source === "tracker" ? [state.slots, []] : [[], state.slots];
    if (trackerOn) {
      const nowTs = state.tracker.lastTs ?? bar.ts_open;
      const walls = bar.ts_open - nowTs > HOLE_MS ? [] : standingWalls(state.tracker, nowTs);
      const mitigated = bar.ts_open - nowTs > HOLE_MS ? [] : mitigatedWalls(state.tracker);
      renderWalls(trackerSlots, walls, mitigated, settings, nowTs, bar.ts_open, snap, liquidity.rowWidth, liquidity.baseAsset, minSize, bar.close, strongSize, ranges);
    }
    if (engineOn) {
      const nowTs = Math.max(state.engine.lastTs ?? bar.ts_open, bar.ts_open);
      const walls = status === null ? standingWalls(state.engine, nowTs) : [];
      const mitigated = status === null ? mitigatedWalls(state.engine) : [];
      renderWalls(engineSlots, walls, mitigated, settings, nowTs, bar.ts_open, snap, liquidity.rowWidth, liquidity.baseAsset, minSize, bar.close, strongSize, ranges, settings.source === "both" ? ENGINE_MARK : PLAIN_MARK);
    }
    showStatus(state.status, status, bar.ts_open, bar.interval_ms, bar.close, settings.bandThicknessPx);
  },
};
