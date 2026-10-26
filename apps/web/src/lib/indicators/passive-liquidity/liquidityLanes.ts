import type { LiquidityLevel } from "../../../types/frames";
import type { HeatGrid, LiquidityGrid } from "./liquidityGrid";
import { laneFoldFor } from "./liquidityStyle";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export const MAX_LANE = 6;

export type LiquidityLaneChoice = "auto" | "0" | "1" | "2" | "3" | "4" | "5" | "6";

export const LIQUIDITY_LANE_CHOICES: readonly LiquidityLaneChoice[] = Object.freeze(["auto", "0", "1", "2", "3", "4", "5", "6"]);

export const LIQUIDITY_LANE_PRESET_FIELD: SettingsFieldSchema<{ lane: LiquidityLaneChoice }> = {
  kind: "select",
  key: "lane",
  label: "Price zoom",
  options: LIQUIDITY_LANE_CHOICES.map((value) => ({ value, label: value })),
  affects: "cosmetic",
};

export interface HeatLanes {
  grid(lane: number): LiquidityGrid | null;
}

export interface LaneCandidate {
  lane: number;
  rowWidth: number;
  priceLo: number;
  priceHi: number;
}

export function isLaneChoice(value: unknown): value is LiquidityLaneChoice {
  return typeof value === "string" && (LIQUIDITY_LANE_CHOICES as readonly string[]).includes(value);
}

export function laneCandidates(base: HeatGrid, lanes: HeatLanes | null): LaneCandidate[] {
  const out: LaneCandidate[] = [];
  const add = (lane: number, grid: HeatGrid | null) => {
    const latest = grid?.latest ?? null;
    if (grid === null || latest === null || !(grid.rowWidth > 0)) return;
    out.push({ lane, rowWidth: grid.rowWidth, priceLo: latest.lo * grid.rowWidth, priceHi: (latest.hi + 1) * grid.rowWidth });
  };
  add(0, base);
  if (lanes !== null) for (let lane = 1; lane <= MAX_LANE; lane += 1) add(lane, lanes.grid(lane));
  return out;
}

export function chooseLane(candidates: readonly LaneCandidate[], priceLo: number, priceHi: number, maxRows: number, choice: LiquidityLaneChoice = "auto"): number {
  if (candidates.length === 0) return 0;
  const lo = Math.min(priceLo, priceHi);
  const hi = Math.max(priceLo, priceHi);
  const fits = (candidate: LaneCandidate) => (hi - lo) / candidate.rowWidth <= maxRows;
  if (choice !== "auto") {
    // A pinned lane holds while it can be drawn; past the row cap it gives way to the lane auto would pick.
    const pinned = candidates.find((candidate) => candidate.lane === Number(choice));
    if (pinned !== undefined && fits(pinned)) return pinned.lane;
  }
  const covering = candidates.find((candidate) => fits(candidate) && candidate.priceLo <= lo && candidate.priceHi >= hi);
  if (covering !== undefined) return covering.lane;
  const fitting = candidates.filter(fits);
  if (fitting.length > 0) return fitting[fitting.length - 1].lane;
  return candidates[candidates.length - 1].lane;
}

function levelsOnLane(levels: readonly LiquidityLevel[], factor: number): readonly LiquidityLevel[] {
  return Object.freeze(levels.map((level) => {
    const row = Math.floor(level.row / factor);
    const last = Math.floor((level.row + level.span - 1) / factor);
    return { ...level, row, span: last - row + 1 };
  }));
}

const adapters = new WeakMap<LiquidityGrid, Map<number, { base: HeatGrid; view: HeatGrid }>>();

export function laneHeatGrid(lane: LiquidityGrid, base: HeatGrid, k: number): HeatGrid {
  let byLane = adapters.get(lane);
  if (byLane === undefined) {
    byLane = new Map();
    adapters.set(lane, byLane);
  }
  const cached = byLane.get(k);
  if (cached !== undefined && cached.base === base) return cached.view;
  const factor = 2 ** k;
  // A lane read by the biggest tick is judged by lane 0's yardstick, not one measured on its wider rows.
  const biggestTick = laneFoldFor(base.provider, base.symbol, base.marketKind) === "max";
  let mappedFrom: readonly LiquidityLevel[] | null = null;
  let mapped: readonly LiquidityLevel[] = Object.freeze([]);
  const view: HeatGrid = {
    get columns() { return lane.columns; },
    get deepColumns() { return lane.deepColumns; },
    get coarseColumns() { return lane.coarseColumns; },
    get rowWidth() { return lane.rowWidth; },
    get coarseRowWidth() { return lane.coarseRowWidth; },
    get columnMs() { return lane.columnMs; },
    get deepColumnMs() { return lane.deepColumnMs; },
    get coarseColumnMs() { return lane.coarseColumnMs; },
    get latest() { return lane.latest; },
    get epoch() { return lane.epoch; },
    get version() { return lane.version + base.version; },
    get levels() {
      if (base.levels !== mappedFrom) {
        mappedFrom = base.levels;
        mapped = levelsOnLane(base.levels, factor);
      }
      return mapped;
    },
    get aggressive() { return base.aggressive; },
    get provider() { return base.provider; },
    get symbol() { return base.symbol; },
    get marketKind() { return base.marketKind; },
    get baseAsset() { return base.baseAsset; },
    get referenceSize() { return biggestTick ? base.referenceSize : lane.referenceSize; },
    get synced() { return lane.synced; },
    get spanMs() { return lane.spanMs; },
    indexAtOrAfter: (ts) => lane.indexAtOrAfter(ts),
    deepIndexAtOrAfter: (ts) => lane.deepIndexAtOrAfter(ts),
    coarseIndexAtOrAfter: (ts) => lane.coarseIndexAtOrAfter(ts),
  };
  byLane.set(k, { base, view });
  return view;
}
