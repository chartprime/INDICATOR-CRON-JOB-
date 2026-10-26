import type { ColumnFeed } from "../indicators/absorption-detector/absorptionColumns";
import type { LiquidityGrid } from "../indicators/passive-liquidity/liquidityGrid";
import type { L2EventSlice } from "../l2/eventRing";
import type { L2Store } from "../l2/l2Store";
import type { L2Channel, L2ChannelStatus, L2Ladder, L2LaneInfo, L2Segment, L2Wall } from "../l2/types";
import { eventHistoryOf, historyRequestOf, wallHistoryOf, type L2EventHistory, type L2HistoryRange, type L2HistoryRequester, type L2WallHistory } from "../l2/history";
import type { WallHistoryStream } from "../l2/wallHistoryStream";

export type L2Availability = "LIVE" | "HISTORICAL" | "HISTORICAL_UNAVAILABLE";

export interface L2ColumnView {
  readonly ts: number;
  readonly lo: number;
  readonly hi: number;
  readonly bid: ArrayLike<number>;
  readonly ask: ArrayLike<number>;
}

export interface L2TierView {
  readonly columns: readonly L2ColumnView[];
  readonly columnMs: number;
}

export interface L2LaneView {
  readonly epoch: number;
  readonly deep: L2TierView | null;
  readonly fine: L2TierView;
}

export interface IndicatorL2 {
  readonly availability: L2Availability;
  readonly version: number;
  status(channel: L2Channel): L2ChannelStatus;
  segment(): L2Segment | null;
  trusted(ts?: number): boolean;
  lanes(): readonly L2LaneInfo[];
  view(lane: number): L2LaneView | null;
  laneFor(priceLo: number, priceHi: number): number;
  walls(lane?: number): readonly L2Wall[];
  wall(id: number): L2Wall | null;
  events(sinceSeq?: number): L2EventSlice;
  ladder(): L2Ladder | null;
  wallHistory(range: L2HistoryRange, cursor?: unknown): Promise<L2WallHistory | null>;
  eventHistory(range: L2HistoryRange, cursor?: unknown): Promise<L2EventHistory | null>;
  readonly hostWalls: WallHistoryStream | null;
  readonly wallProfile?: Readonly<{ id: string; minimumSize: number; sampleMs: number }>;
  historicalWalls?(): readonly L2Wall[];
  readonly notionalMultiplier?: number;
  /** Historical inputs are cut at this bar's close before entering onBar. */
  atTime?(timeMs: number): IndicatorL2;
}

const UNSYNCED: L2ChannelStatus = Object.freeze({ synced: false, seq: null, lastTs: null, lastFrameAt: null });
const NO_EVENTS: L2EventSlice = Object.freeze({ seq: 0, events: Object.freeze([]), missed: 0, complete: false });
const NO_LANES: readonly L2LaneInfo[] = Object.freeze([]);
const NO_WALLS: readonly L2Wall[] = Object.freeze([]);

export function segmentStartTs(segment: L2Segment): number | null {
  const parts = segment.id.split(":");
  const start = Number(parts[parts.length - 2]);
  return Number.isSafeInteger(start) ? start : null;
}

function lane0Info(grid: LiquidityGrid | null): L2LaneInfo | null {
  if (grid === null) return null;
  const last = grid.columns[grid.columns.length - 1];
  if (last === undefined) return null;
  return Object.freeze({
    lane: 0,
    rowWidth: grid.rowWidth,
    columnMs: grid.columnMs,
    deepColumnMs: grid.deepColumnMs,
    priceLo: last.lo * grid.rowWidth,
    priceHi: (last.hi + 1) * grid.rowWidth,
  });
}

function lane0Feed(grid: LiquidityGrid | null): ColumnFeed | null {
  if (grid === null || grid.columns.length === 0) return null;
  return {
    epoch: grid.epoch,
    deep: grid.deepColumns.length > 0 ? { columns: grid.deepColumns, columnMs: grid.deepColumnMs } : null,
    fine: { columns: grid.columns, columnMs: grid.columnMs },
  };
}

export function historicalL2(): IndicatorL2 {
  return Object.freeze({
    availability: "HISTORICAL_UNAVAILABLE" as const,
    version: 0,
    status: () => UNSYNCED,
    segment: () => null,
    trusted: () => false,
    lanes: () => NO_LANES,
    view: () => null,
    laneFor: () => 0,
    walls: () => NO_WALLS,
    wall: () => null,
    events: () => NO_EVENTS,
    ladder: () => null,
    wallHistory: () => Promise.resolve(null),
    eventHistory: () => Promise.resolve(null),
    hostWalls: null,
  });
}

export function indicatorL2Of(store: L2Store | null, lane0: () => LiquidityGrid | null, history: L2HistoryRequester | null = null, hostWalls: WallHistoryStream | null = null): IndicatorL2 | null {
  if (store === null) return null;
  const lanes = (): readonly L2LaneInfo[] => {
    const zero = lane0Info(lane0());
    const rest = store.lanes.lanes();
    return zero === null ? rest : Object.freeze([zero, ...rest]);
  };
  return {
    availability: "LIVE",
    get version(): number {
      return store.version;
    },
    status: (channel) => store.status(channel),
    segment: () => store.segment,
    trusted: (ts) => {
      if (!store.trusted()) return false;
      if (ts === undefined) return true;
      const segment = store.segment;
      const start = segment === null ? null : segmentStartTs(segment);
      return start !== null && ts >= start;
    },
    lanes,
    view: (lane) => (lane === 0 ? lane0Feed(lane0()) : store.lanes.view(lane)),
    laneFor: (priceLo, priceHi) => {
      const lo = Math.min(priceLo, priceHi);
      const hi = Math.max(priceLo, priceHi);
      const known = lanes();
      for (const info of known) if (info.priceLo <= lo && info.priceHi >= hi) return info.lane;
      return known.length === 0 ? 0 : known[known.length - 1].lane;
    },
    walls: (lane = 0) => store.walls.list().filter((wall) => wall.lane === lane),
    wall: (id) => store.walls.get(id),
    events: (sinceSeq) => store.events.since(sinceSeq),
    ladder: () => store.ladder.ladder,
    wallHistory: async (range, cursor) => {
      if (history === null) return null;
      const frame = await history("wall_history", historyRequestOf(range, cursor));
      return frame === null || frame.type !== "wall_history" ? null : wallHistoryOf(frame);
    },
    eventHistory: async (range, cursor) => {
      if (history === null) return null;
      const frame = await history("l2_event_history", historyRequestOf(range, cursor));
      return frame === null || frame.type !== "l2_event_history" ? null : eventHistoryOf(frame);
    },
    hostWalls,
  };
}
