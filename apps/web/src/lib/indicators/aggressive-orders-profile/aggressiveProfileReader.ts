import { PRINT_WINDOW_COLUMNS, type FrameIdentity } from "../../../types/frames";
import { suggestedMinVolumeFor } from "../aggressive-orders/aggressiveOrdersSettings";
import type { LiquidityColumn, LiquidityGrid } from "../passive-liquidity/liquidityGrid";
import { addCandlePrint, candleAt, type CandleSlot, type RangePrintCandlesRead, type RangePrintTally } from "./rangePrintStore";

export const MAX_PRINT_COLUMNS = 40_000;
export const START_FLOOR_WAIT_MS = 5_000;

export interface CandleDelta extends RangePrintTally {
  tsOpen: number;
  delta: number;
}

export interface PrintTier {
  columns: readonly LiquidityColumn[];
  columnMs: number;
  fromTs: number;
  toTs: number;
}

export interface AggressiveProfileInput {
  printTiers: readonly PrintTier[];
  fromTs: number;
  toTs: number;
  floor: number;
  candles: readonly CandleSlot[];
  recorded?: RangePrintCandlesRead | null;
}

export function readColumnCandles(tiers: readonly PrintTier[], fromTs: number, toTs: number, floor: number, slots: readonly CandleSlot[], into: Map<number, RangePrintTally>): void {
  let budget = MAX_PRINT_COLUMNS;
  for (let t = tiers.length - 1; t >= 0 && budget > 0; t -= 1) {
    const { columns, columnMs } = tiers[t];
    const from = Math.max(fromTs, tiers[t].fromTs);
    const to = Math.min(toTs, tiers[t].toTs);
    if (!(to > from)) continue;
    for (let i = columns.length - 1; i >= 0 && budget > 0; i -= 1) {
      const column = columns[i];
      if (column.ts >= to + PRINT_WINDOW_COLUMNS * columnMs) continue;
      if (column.ts < from - columnMs) break;
      budget -= 1;
      const own = floor > 0 ? floor : column.printsFloor ?? 0;
      for (const print of column.prints ?? []) {
        if (!(print.size >= own) || !(print.size > 0)) continue;
        if (print.ts < from || print.ts >= to) continue;
        const tsOpen = candleAt(slots, print.ts);
        if (tsOpen !== null) addCandlePrint(into, tsOpen, print.side === "buy", print.size);
      }
    }
  }
}

export function candlesOf(tallies: ReadonlyMap<number, RangePrintTally>): CandleDelta[] {
  return [...tallies.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tsOpen, tally]) => ({ tsOpen, delta: tally.buyVolume - tally.sellVolume, ...tally }));
}

export function niceFloor(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  let best = power;
  for (const unit of [2, 5, 10]) {
    const step = unit * power;
    if (Math.abs(Math.log(step / value)) < Math.abs(Math.log(best / value))) best = step;
  }
  return Number(best.toPrecision(12));
}

export function autoPrintFloorOf(columns: readonly Pick<LiquidityColumn, "printsFloor">[]): number {
  const floors: number[] = [];
  for (const column of columns) if (column.printsFloor !== undefined && column.printsFloor > 0) floors.push(column.printsFloor);
  if (floors.length === 0) return 0;
  floors.sort((a, b) => a - b);
  return niceFloor(floors[Math.floor(floors.length / 2)]);
}

export function printFloorFor(floor: number, columns: readonly Pick<LiquidityColumn, "printsFloor">[]): number {
  return floor > 0 ? floor : autoPrintFloorOf(columns);
}

export function startingPrintFloorFor(grid: Pick<LiquidityGrid, "columns" | "deepColumns"> | null, instrument: ({ symbol: string } & FrameIdentity) | null): number {
  const fine = autoPrintFloorOf(grid?.columns ?? []);
  if (fine > 0) return fine;
  const deep = autoPrintFloorOf(grid?.deepColumns ?? []);
  if (deep > 0) return deep;
  return instrument === null ? 0 : niceFloor(suggestedMinVolumeFor(instrument));
}

export function readAggressiveProfile(input: AggressiveProfileInput): CandleDelta[] {
  if (!(input.toTs > input.fromTs)) throw new Error("aggressive profile: the range must run forward");
  const recorded = input.recorded ?? null;
  const tallies = new Map<number, RangePrintTally>();
  if (recorded === null) {
    readColumnCandles(input.printTiers, input.fromTs, input.toTs, input.floor, input.candles, tallies);
    return candlesOf(tallies);
  }
  for (const [tsOpen, tally] of recorded.candles) tallies.set(tsOpen, { ...tally });
  for (const gap of recorded.gaps) readColumnCandles(input.printTiers, gap.from, gap.to, input.floor, input.candles, tallies);
  return candlesOf(tallies);
}
