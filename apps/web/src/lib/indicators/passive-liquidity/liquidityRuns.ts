// A level over time, for the simple heatmap.
//
// A band's run is the stretch of columns where it keeps at least LINK_SHARE
// of the paint floor. Above the floor it is drawn in full; in a dip between
// the two it is drawn as a hairline, so a level that thins for a moment
// still reads as one level, while dust far below stays a break. A run
// lasts as long as its size does, whatever price does around it: a level
// that price wicks into and that holds is still a level (the rule that cut
// it at the candle close and kept the band dark while it still stood was
// dropped on 2026-09-07; it broke standing levels into pieces). It ends when
// the band empties, one of two ways. With price at it, inside a candle that
// printed in the band: consumed where it emptied, that second (a sweep eats
// a level in the middle of a candle; judged only at the close it would
// always read as pulled). With price elsewhere: pulled. So a consumed level
// is drawn whole, from where it started to where it was eaten.
//
// The floors a run is judged by belong to the column and the band, and once
// a run stands they no longer rise: the quiet zone around price raises the
// floor a level needs to APPEAR near price, never the floor a standing level
// needs to stay. Otherwise a level drawn at a distance vanished the moment
// price came within the zone of it, and whatever price then did to it was
// never seen.

import { bandSizes } from "./liquidityGrid";
import type { LiquidityColumn } from "./liquidityGrid";
import type { LiquidityLevel } from "../../../types/frames";

export interface OhlcBar {
  time: number; // bar open, epoch ms
  high: number;
  low: number;
  close: number;
}

/** Below the paint floor a band is still one level down to this share of it. */
export const LINK_SHARE = 0.5;
/**
 * How long a level may sit under the paint floor and still count as the same
 * level. The hairline is for a brief dip; without a limit a band that hovers
 * just under the floor draws one unbroken thread across the whole chart.
 */
export const MAX_DIP_MS = 45_000;
/**
 * A hole in the columns no longer than this is bridged: the publisher skips
 * a second or two under load many times an hour, and that is not losing
 * sight of the book. A longer hole is judged when the columns resume.
 */
export const HOLE_BRIDGE_MS = 5_000;
/**
 * Price is "at" a band when the column's mid is within this many rows of it
 * on the near side (or anywhere beyond it): the mid of a book whose best bid
 * is the band sits one row above it.
 */
export const AT_PRICE_ROWS = 1;

export const LEDGER_MATCH_MS = 60_000;

export interface RunClocks {
  dipMs: number;
  holeMs: number;
  matchMs: number;
  minRunMs: number;
}

export const DEFAULT_RUN_CLOCKS: RunClocks = { dipMs: MAX_DIP_MS, holeMs: HOLE_BRIDGE_MS, matchMs: LEDGER_MATCH_MS, minRunMs: 0 };

/** The hairline that keeps a thinned level in one piece. */
export const CONNECTOR_PX = 1.5;
export const CONNECTOR_ALPHA_SHARE = 0.6;

/** Index of the first value at or after `t` in a sorted list; `values.length` when none. */
export function firstAtOrAfter(values: readonly number[], t: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sorted, parallel lists of bar opens and ends. */
export interface BarSpans {
  opens: number[];
  ends: number[];
}

/**
 * Every candle whose range reaches into [priceLo, priceHi), closed inside or
 * not: the moments a trade printed at the band. The live candle counts with
 * the range it has so far.
 */
export function touchingBars(bars: readonly OhlcBar[], intervalMs: number, priceLo: number, priceHi: number): BarSpans {
  const opens: number[] = [];
  const ends: number[] = [];
  for (const bar of bars) {
    if (!(bar.low < priceHi && bar.high >= priceLo)) continue;
    opens.push(bar.time);
    ends.push(bar.time + intervalMs);
  }
  return { opens, ends };
}

/** Whether one of the spans covers `ts`. */
export function coversAt(spans: BarSpans, ts: number): boolean {
  const i = firstAtOrAfter(spans.opens, ts + 1) - 1;
  return i >= 0 && ts < spans.ends[i];
}

/** Whether one of the spans reaches into [fromTs, toTs): a candle printed in the band somewhere in that stretch. */
export function coversSpan(spans: BarSpans, fromTs: number, toTs: number): boolean {
  const i = firstAtOrAfter(spans.opens, toTs) - 1;
  return i >= 0 && spans.ends[i] > fromTs;
}

/**
 * Whether a level the server tracks as a wall covers this band at this moment.
 * The quiet zone is there to hide the churn at the top of the book, not the
 * walls standing in it: on a book whose typical row is 38 BTC the raised floor
 * came to 124 BTC, and 96 BTC walls a few dollars from price drew nothing.
 */
/**
 * Whether a band sits within `quietBands` bands of the column's mid: the
 * top of the book, where size flickers every second and only a wall means
 * anything. Judged per column, so history keeps the zone it had.
 */
export function inQuietZone(column: LiquidityColumn, bandIndex: number, clusterRows: number, quietBands: number): boolean {
  if (!(quietBands > 0)) return false;
  const rows = Math.max(1, Math.floor(clusterRows));
  const midBand = Math.floor((column.lo + column.hi) / 2 / rows);
  return Math.abs(bandIndex - midBand) <= quietBands;
}

/**
 * Whether price is at or through a band in this column: the column's mid sits
 * within AT_PRICE_ROWS of the band on its near side, or anywhere past it. A
 * bid band with the mid far above it is not reached; one with the mid below
 * it has been gone through.
 */
export function atPrice(column: LiquidityColumn, bandIndex: number, clusterRows: number, side: "bid" | "ask"): boolean {
  const rows = Math.max(1, Math.floor(clusterRows));
  const midRow = (column.lo + column.hi) / 2;
  return side === "bid" ? midRow <= (bandIndex + 1) * rows - 1 + AT_PRICE_ROWS : midRow >= bandIndex * rows - AT_PRICE_ROWS;
}

/** What became of a run: still on the book, price reached into it, or it left on its own. */
export type RunFate = "resting" | "consumed" | "pulled";
/**
 * How price met the run: not at all, or it emptied with price at it while a
 * candle printed there ("touch"). A touch is consumed unless the ledger saw
 * the size leave by cancel.
 */
export type RunReach = "none" | "touch";

/** One run of a band: the stretch the chart draws as one level. `endTs` is exclusive. */
export interface RunSegment {
  startTs: number;
  endTs: number;
  fate: RunFate;
  reach: RunReach;
  peak: number; // the most the band held over the run
  fill: number | null; // of the wall's peak, the share that traded, from the server's ledger; null when no tracked wall matched
}

/** A tier of columns to scan: the deep tier up to where the fine one begins, then the fine tier. */
export interface RunTier {
  columns: readonly LiquidityColumn[];
  columnMs: number;
  scanTo: number; // one past the last column that belongs to this tier
}

/**
 * The floors a band is judged by in one column. `standing` says a run is
 * already there: the floor a level needs to keep standing, not the one it
 * needs to appear (the quiet zone raises only the latter).
 */
export type FloorsAt = (column: LiquidityColumn, bandIndex: number, standing: boolean) => { link: number; paint: number };

/**
 * The runs one side of a band makes over the retained span, in time order.
 * A run begins on a column at or above its paint floor, continues while the
 * band keeps at least its link floor (both from `floorsAt(column)`, the
 * yardstick of that moment), survives a dip under the paint floor shorter
 * than MAX_DIP_MS, and ends one of three ways: it empties with price at it
 * inside a candle that printed there (consumed, where it emptied), it drops
 * under the link floor or dips too long with price elsewhere (pulled), or
 * the columns stop. A hole up to HOLE_BRIDGE_MS is bridged. A longer one is
 * judged when the columns resume: a band still standing keeps its run, the
 * hole named on it; a band gone by then ended where the columns stopped,
 * consumed if a candle printed in the band during the hole, pulled if not.
 * It never rests at a hole: only a run open at the live edge rests. Or
 * candle that printed in the band; `sizeAt` reads a band's size the way the
 * market's style does (the rows summed by default, the biggest row on indexes).
 */
export function bandRuns(
  tiers: readonly RunTier[],
  row: number,
  clusterRows: number,
  side: "bid" | "ask",
  floorsAt: FloorsAt,
  touches: BarSpans,
  sizeAt: SizeAt = (column, bandIndex, which) => bandSizes(column, bandIndex, clusterRows)[which],
  clocks: RunClocks = DEFAULT_RUN_CLOCKS,
): RunSegment[] {
  const scanner = createRunScanner(row, clusterRows, side, floorsAt, touches, sizeAt, clocks);
  const cursors = tiers.map((tier) => ({ tier, at: 0 }));
  for (;;) {
    let next: (typeof cursors)[number] | null = null;
    for (const cursor of cursors) {
      if (cursor.at >= cursor.tier.scanTo) continue;
      if (next === null || cursor.tier.columns[cursor.at].ts < next.tier.columns[next.at].ts) next = cursor;
    }
    if (next === null) break;
    scanner.feed(next.tier.columns[next.at], next.tier.columnMs);
    next.at += 1;
  }
  return scanner.result();
}

export type SizeAt = (column: LiquidityColumn, bandIndex: number, side: "bid" | "ask") => number;

/**
 * The run model fed one column at a time, so a chart can keep the scan of
 * the columns that are settled and feed only the ones that are new. `fork`
 * copies the scan where it stands, with the candles given (the settled ones
 * plus the live bar, for the tail); the copy and the original go on
 * independently. `result` is what `bandRuns` would return for the columns
 * fed so far, the open run counted as resting.
 */
export interface RunScanner {
  feed(column: LiquidityColumn, columnMs: number): void;
  fork(touches?: BarSpans): RunScanner;
  result(): RunSegment[];
}

interface ScanState {
  base: readonly RunSegment[];
  runs: RunSegment[];
  run: RunSegment | null;
  painted: boolean;
  dipStart: number;
}

const NO_RUNS: readonly RunSegment[] = Object.freeze([]);

export function createRunScanner(
  row: number,
  clusterRows: number,
  side: "bid" | "ask",
  floorsAt: FloorsAt,
  touches: BarSpans,
  sizeAt: SizeAt = (column, bandIndex, which) => bandSizes(column, bandIndex, clusterRows)[which],
  clocks: RunClocks = DEFAULT_RUN_CLOCKS,
  state: ScanState = { base: NO_RUNS, runs: [], run: null, painted: false, dipStart: -1 },
): RunScanner {
  const close = (endTs: number, fate: RunFate, reach: RunReach) => {
    const run = state.run;
    if (!run) return;
    run.endTs = endTs;
    run.fate = fate;
    run.reach = reach;
    state.runs.push(run);
    state.run = null;
  };
  // The band empties or thins away in this column: eaten if price is at it
  // and a candle printed there, otherwise withdrawn.
  const leave = (column: LiquidityColumn) => {
    const touched = atPrice(column, row, clusterRows, side) && coversAt(touches, column.ts);
    close(column.ts, touched ? "consumed" : "pulled", touched ? "touch" : "none");
  };
  const feed = (column: LiquidityColumn, columnMs: number) => {
    const open = state.run;
    if (open && column.ts - open.endTs > clocks.holeMs) {
      if (sizeAt(column, row, side) >= floorsAt(column, row, true).link) {
        state.dipStart = -1;
      } else {
        const printed = coversSpan(touches, open.endTs, column.ts);
        close(open.endTs, printed ? "consumed" : "pulled", printed ? "touch" : "none");
        state.painted = false;
        state.dipStart = -1;
      }
    }
    const size = sizeAt(column, row, side);
    // The floors belong to the column and the band: the yardstick that was live
    // when it printed, raised inside the quiet zone around that column's mid for
    // a level that is only now appearing.
    const { link: linkFloor, paint: paintFloor } = floorsAt(column, row, state.run !== null);
    if (!(size >= linkFloor)) {
      leave(column);
      state.painted = false;
      state.dipStart = -1;
      return;
    }
    if (size >= paintFloor) {
      state.painted = true;
      state.dipStart = -1;
    } else {
      if (state.dipStart < 0) state.dipStart = column.ts;
      // Under the floor too long, or never painted at all: not a level.
      if (!state.painted || column.ts - state.dipStart > clocks.dipMs) {
        leave(column);
        state.painted = false;
        return;
      }
    }
    let run = state.run;
    if (!run) {
      run = { startTs: column.ts, endTs: column.ts + columnMs, fate: "resting", reach: "none", peak: size, fill: null };
      state.run = run;
    }
    if (size > run.peak) run.peak = size;
    run.endTs = column.ts + columnMs;
  };
  const fork = (spans: BarSpans = touches): RunScanner => createRunScanner(row, clusterRows, side, floorsAt, spans, sizeAt, clocks, {
    base: state.runs.length === 0 ? state.base : [...state.base, ...state.runs],
    runs: [],
    run: state.run === null ? null : { ...state.run },
    painted: state.painted,
    dipStart: state.dipStart,
  });
  const result = (): RunSegment[] => {
    const runs = [...state.base, ...state.runs];
    if (state.run) runs.push({ ...state.run, fate: "resting" });
    return runs.filter((segment) => segment.fate === "resting" || segment.endTs - segment.startTs >= clocks.minRunMs);
  };
  return { feed, fork, result };
}

/**
 * A wall that gave this share of its peak to trades was consumed, whatever the
 * candles say: a level can be eaten by a wick the bar's body never shows.
 */
export const CONSUMED_EATEN_SHARE = 0.1;

/**
 * Let the server's ledger settle each ended run. The chart's own rule only
 * knows where price was; the ledger knows what actually happened to the size
 * that left: traded, or cancelled. When a tracked wall of the same side
 * share is carried on the run and decides the fate where the chart could
 * not: a run price never reached is consumed after all if the wall was
 * eaten, and a run that emptied at the touch is pulled after all if the
 * wall left by cancel (the quoting bot pulled as price arrived). Several
 * walls in one band: the largest decides. Runs no wall covered keep the
 */
export function settleWithLedger(
  runs: RunSegment[],
  levels: readonly LiquidityLevel[],
  bandIndex: number,
  clusterRows: number,
  side: "bid" | "ask",
  matchMs = LEDGER_MATCH_MS,
): RunSegment[] {
  if (runs.length === 0 || levels.length === 0) return runs;
  const rowLo = bandIndex * clusterRows;
  const rowHi = (bandIndex + 1) * clusterRows - 1;
  const walls = levels.filter((level) => level.side === side && level.end_ts !== null && level.row <= rowHi && level.row + level.span - 1 >= rowLo);
  if (walls.length === 0) return runs;
  return runs.map((run) => {
    if (run.fate === "resting") return run;
    let best: LiquidityLevel | null = null;
    for (const wall of walls) {
      const endTs = wall.end_ts as number;
      if (wall.start_ts > run.endTs || Math.abs(endTs - run.endTs) > matchMs) continue;
      if (!best || wall.peak > best.peak) best = wall;
    }
    if (!best) return run;
    const eaten = Math.min(1, Math.max(0, Number(best.eaten) || 0));
    const ate = eaten >= CONSUMED_EATEN_SHARE || best.ended_by === "filled" || best.ended_by === "partial";
    // Emptied as price arrived, and the ledger says by cancel: pulled at the touch.
    const fate: RunFate = ate ? "consumed" : run.reach === "touch" ? "pulled" : run.fate;
    return { ...run, fill: eaten, fate };
  });
}
