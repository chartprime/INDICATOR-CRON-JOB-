import type { LiquidityColumn, LiquidityGrid, LiquiditySide } from "../passive-liquidity/liquidityGrid";

export const RESTING_MULTIPLE = 3;
export const RESTING_STAND_MS = 30_000;
export const RESTING_END_SHARE = 0.5;
export const RESTING_END_HOLD_MS = 2_000;
export const RESTING_REPLAY_MS = 125_000;

export interface RestingOrder {
  key: string;
  side: LiquiditySide;
  row: number;
  size: number;
  peak: number;
  since: number;
  ending: boolean;
}

interface Tracked extends Omit<RestingOrder, "ending"> {
  under: number | null;
}

export interface RestingState {
  epoch: number;
  at: number;
  orders: Map<string, Tracked>;
}

const SIDES: readonly LiquiditySide[] = ["bid", "ask"];

// Past a live column's edge the window was only cut there: read empty, so an order that drifts out ends as
// usual. Past a historical column's edge the source saw no depth: unknown, so the order is let go at once.
function sizeAt(column: LiquidityColumn, side: LiquiditySide, row: number, edgeUnknown: boolean): number {
  if (row < column.lo || row > column.hi) return edgeUnknown ? NaN : 0;
  return column[side][row - column.lo];
}

export function createRestingState(): RestingState {
  return { epoch: -1, at: -Infinity, orders: new Map() };
}

export function restingFloor(minSize: number, reference: number): number {
  return minSize > 0 ? minSize : RESTING_MULTIPLE * reference;
}

export function stepRestingOrders(state: RestingState, column: LiquidityColumn, floor: number, epoch: number, edgeUnknown = false): void {
  if (epoch !== state.epoch) {
    state.epoch = epoch;
    state.orders.clear();
  }
  state.at = column.ts;
  for (const [key, order] of state.orders) {
    const size = sizeAt(column, order.side, order.row, edgeUnknown);
    if (!Number.isFinite(size)) { state.orders.delete(key); continue; }
    order.peak = Math.max(order.peak, size);
    if (size < order.peak * RESTING_END_SHARE) order.under ??= column.ts;
    else order.under = null;
    if (order.under !== null && column.ts - order.under >= RESTING_END_HOLD_MS) state.orders.delete(key);
    else order.size = size;
  }
  if (floor <= 0) return;
  for (const side of SIDES) {
    const sizes = column[side];
    for (let row = column.lo; row <= column.hi; row += 1) {
      const size = sizes[row - column.lo];
      const key = `${side}:${row}`;
      if (!Number.isFinite(size) || size < floor || state.orders.has(key)) continue;
      state.orders.set(key, { key, side, row, size, peak: size, since: column.ts, under: null });
    }
  }
}

export function restingShown(state: RestingState, standMs: number = RESTING_STAND_MS): RestingOrder[] {
  const shown: RestingOrder[] = [];
  for (const order of state.orders.values()) {
    if (state.at - order.since >= standMs) shown.push({ key: order.key, side: order.side, row: order.row, size: order.size, peak: order.peak, since: order.since, ending: order.under !== null });
  }
  return shown;
}

export class RestingOrderTracker {
  private readonly _state = createRestingState();
  private _seenTs = -Infinity;
  private _minSize = NaN;
  private _standMs = RESTING_STAND_MS;

  get shown(): RestingOrder[] {
    return restingShown(this._state, this._standMs);
  }

  update(grid: LiquidityGrid, minSize: number, standMs: number = RESTING_STAND_MS): RestingOrder[] {
    this._standMs = standMs;
    const columns = grid.columns;
    let from = grid.indexAtOrAfter(this._seenTs + 1);
    if (grid.epoch !== this._state.epoch || this._seenTs === -Infinity || minSize !== this._minSize) {
      this._state.epoch = grid.epoch;
      this._state.orders.clear();
      this._seenTs = -Infinity;
      this._minSize = minSize;
      const newest = columns.at(-1);
      from = newest === undefined ? 0 : grid.indexAtOrAfter(newest.ts - RESTING_REPLAY_MS);
    }
    for (let index = from; index < columns.length; index += 1) {
      const column = columns[index];
      if (grid.provider === "DATABENTO" && column.ts - this._seenTs > grid.columnMs) this._state.orders.clear();
      stepRestingOrders(this._state, column, restingFloor(minSize, column.reference ?? 0), grid.epoch, grid.provider === "DATABENTO");
      this._seenTs = column.ts;
    }
    return restingShown(this._state, standMs);
  }
}
