// Binds the run model to one frame of the chart: the grid's columns and
// tracked walls, the market's style, the trader's settings and the layout's
// candles. The heat renderer and the hover both go through it, so they always
// agree on where a level begins, how it ends, and whether it is shown.
//
// The scan of the columns is kept between frames. Everything before the open
// of the live candle is settled: the columns there do not change, and the
// closed candles say once and for all where price printed. That part is
// scanned once per band side and kept as a scanner standing at the live
// candle's open. A frame then forks that scanner and feeds it only the
// columns of the live candle, so a new second costs the live candle's
// columns, not the whole retained span. When the candle closes, the kept
// scanners advance over the columns of the candle that just settled. A
// change in anything the settled part depends on (the rows, the settings,
// the clocks, a reset, a closed candle revised, a column arriving in the
// past) throws the kept scan away and starts again.

import { bandSizeCache, type BandSizeReader } from "./liquidityBandSizes";
import { liquidityIndexAtOrAfter, type HeatGrid, type LiquidityColumn } from "./liquidityGrid";
import type { HeatmapLayout } from "./liquidityHeatmapLayout";
import {
  createRunScanner,
  inQuietZone,
  LINK_SHARE,
  settleWithLedger,
  touchingBars,
  type BarSpans,
  type FloorsAt,
  type OhlcBar,
  type RunFate,
  type RunScanner,
  type RunSegment,
} from "./liquidityRuns";
import { minBandSizeFor, QUIET_FLOOR_MULTIPLE, type LiquiditySettings } from "./liquiditySettings";
import {
  liquidityStyleFor,
  type LiquidityStyle,
  type SaturationContext,
} from "./liquidityStyle";

/** Whether a run of this fate is drawn (and hoverable) under the settings. */
export function showsFate(settings: LiquiditySettings, fate: RunFate): boolean {
  if (fate === "resting") return settings.levelFilter !== "consumed";
  if (fate === "consumed") return settings.levelFilter !== "resting";
  // Pulled levels have their own switch, independent of the Show filter.
  return settings.showPulled;
}

export interface RunFinder {
  /** The market's style: how a band is sized, floored, coloured and worded. */
  style: LiquidityStyle;
  clusterRows: number;
  /** What the style needs to know about this frame when it works out floors and saturation. */
  saturation: SaturationContext;
  /** The floors a band is judged by in one column; `standing` for a run already there. */
  floorsAt: FloorsAt;
  /** Both sides' sizes of a band in one column, as the style reads them. */
  sizesAt(
    column: LiquidityColumn,
    bandIndex: number,
  ): { bid: number; ask: number };
  /** The runs one side of a band makes over the retained span, settled by the server's ledger. */
  runsFor(bandIndex: number, side: "bid" | "ask"): RunSegment[];
}

/** One tier of the kept scan: its columns, and the time from which they belong to the next tier. */
interface PrefixTier {
  columns: readonly LiquidityColumn[];
  columnMs: number;
  cutTs: number;
}

/** The scan of the settled columns, kept between frames. */
interface Prefix {
  key: string;
  tiers: PrefixTier[];
  /** The open of the live candle: columns before it are in the kept scan. */
  endTs: number;
  /** The closed candles the kept scan was judged by, as `settledValues` lays them out. */
  settled: Float64Array;
  settledBars: OhlcBar[];
  /** Whether a settled column was floored by the live colour reference rather than its own; the kept scan then depends on it. */
  fallbackUsed: boolean;
  reference: number;
  /** Bumped when the kept scan advances, so a frame's answers are not reused across it. */
  generation: number;
  builtAt: number;
  style: LiquidityStyle;
  clusterRows: number;
  rowWidth: number;
  intervalMs: number;
  saturation: SaturationContext;
  floorsAt: FloorsAt;
  sizes: BandSizeReader;
  scanners: Map<string, RunScanner>;
  touches: Map<number, BarSpans>;
}

interface FinderMemo {
  prefix: Prefix;
  tailKey: string;
  finder: RunFinder;
}

/**
 * While host history is landing, page after page, the oldest tier is a new
 * list every few hundred milliseconds. The kept scan is thrown away for it
 * at most this often; in between, the frame answers from the scan it has,
 * which lacks only the columns that just arrived.
 */
export const HISTORY_RESCAN_MS = 400;

const finderMemos = new WeakMap<HeatGrid, FinderMemo>();

function bandLoPrice(band: number, clusterRows: number, rowWidth: number): number {
  return band * clusterRows * rowWidth;
}

function bandHiPrice(band: number, clusterRows: number, rowWidth: number): number {
  return (band + 1) * clusterRows * rowWidth;
}

const MAX_BAND_STEPS = 4;

function firstBandAbove(low: number, clusterRows: number, rowWidth: number): number | null {
  let band = Math.floor(low / (clusterRows * rowWidth));
  if (!Number.isFinite(band)) return null;
  for (let step = 0; bandHiPrice(band, clusterRows, rowWidth) <= low; step += 1) {
    if (step === MAX_BAND_STEPS) return null;
    band += 1;
  }
  for (let step = 0; bandHiPrice(band - 1, clusterRows, rowWidth) > low; step += 1) {
    if (step === MAX_BAND_STEPS) return null;
    band -= 1;
  }
  return band;
}

function lastBandUnder(high: number, clusterRows: number, rowWidth: number): number | null {
  let band = Math.floor(high / (clusterRows * rowWidth));
  if (!Number.isFinite(band)) return null;
  for (let step = 0; bandLoPrice(band + 1, clusterRows, rowWidth) <= high; step += 1) {
    if (step === MAX_BAND_STEPS) return null;
    band += 1;
  }
  for (let step = 0; bandLoPrice(band, clusterRows, rowWidth) > high; step += 1) {
    if (step === MAX_BAND_STEPS) return null;
    band -= 1;
  }
  return band;
}

/** The live candle as the kept scan sees it: its open and the bands it reaches, or its raw edges when they cannot be banded. */
interface LiveBar {
  time: number;
  first: number;
  last: number;
  banded: boolean;
}

function liveBarOf(layout: HeatmapLayout): LiveBar | null {
  const bar = layout.bars[layout.bars.length - 1];
  if (bar === undefined) return null;
  const live = Number.isFinite(bar.low) && Number.isFinite(bar.high);
  const first = live ? firstBandAbove(bar.low, layout.clusterRows, layout.rowWidth) : null;
  const last = live ? lastBandUnder(bar.high, layout.clusterRows, layout.rowWidth) : null;
  const banded = first !== null && last !== null;
  return { time: bar.time, first: banded ? first : bar.low, last: banded ? last : bar.high, banded };
}

function liveTouches(live: LiveBar | null, band: number, clusterRows: number, rowWidth: number): boolean {
  if (live === null) return false;
  if (live.banded) return band >= live.first && band <= live.last;
  return live.first < bandHiPrice(band, clusterRows, rowWidth) && live.last >= bandLoPrice(band, clusterRows, rowWidth);
}

/** The closed candles as numbers: time, low, high, close each. */
function settledValues(bars: readonly OhlcBar[]): Float64Array {
  const values = new Float64Array(bars.length * 4);
  bars.forEach((bar, i) => {
    values[i * 4] = bar.time;
    values[i * 4 + 1] = bar.low;
    values[i * 4 + 2] = bar.high;
    values[i * 4 + 3] = bar.close;
  });
  return values;
}

/**
 * How the closed candles changed since the kept scan: not at all, candles
 * added at the end (older ones may have dropped off the front), or anything
 * else, which means a candle the scan was judged by is no longer what it was.
 */
function settledRelation(old: Float64Array, next: Float64Array): { kind: "same" | "advance" | "rebuild"; kept: number } {
  let dropped = 0;
  while (dropped * 4 < old.length && next.length > 0 && old[dropped * 4] < next[0]) dropped += 1;
  const kept = old.length / 4 - dropped;
  if (next.length / 4 < kept) return { kind: "rebuild", kept: 0 };
  for (let i = 0; i < kept * 4; i += 1) if (!Object.is(old[dropped * 4 + i], next[i])) return { kind: "rebuild", kept: 0 };
  return { kind: next.length / 4 === kept ? "same" : "advance", kept };
}

function cutOf(tier: HeatmapLayout["tiers"][number]): number {
  return tier.scanTo < tier.columns.length ? tier.columns[tier.scanTo].ts : Infinity;
}

/** Whether the layout's tiers from `first` on are the ones the kept scan was built over, their cuts no earlier than before. */
function tiersMatch(prefix: Prefix, layout: HeatmapLayout, first = 0): boolean {
  if (prefix.tiers.length !== layout.tiers.length) return false;
  for (let i = first; i < prefix.tiers.length; i += 1) {
    const kept = prefix.tiers[i];
    const tier = layout.tiers[i];
    if (kept.columns !== tier.columns || kept.columnMs !== tier.columnMs || cutOf(tier) < kept.cutTs) return false;
  }
  return true;
}

/** Only the oldest tier is another list: history landed or the view crossed a window. */
function onlyHistoryChanged(prefix: Prefix, layout: HeatmapLayout): boolean {
  return layout.tiers.length > 1 && prefix.tiers[0].columns !== layout.tiers[0].columns && prefix.tiers[0].columnMs === layout.tiers[0].columnMs && tiersMatch(prefix, layout, 1);
}

function prefixKeyOf(grid: HeatGrid, layout: HeatmapLayout, settings: LiquiditySettings): string {
  return JSON.stringify([layout.rowWidth, layout.clusterRows, layout.intervalMs, layout.clocks, settings, grid.epoch]);
}

function buildPrefix(grid: HeatGrid, layout: HeatmapLayout, settings: LiquiditySettings, key: string): Prefix {
  const clusterRows = layout.clusterRows;
  const style = liquidityStyleFor(grid.provider, grid.symbol, grid.marketKind);
  const saturation: SaturationContext = { settings, clusterRows, ladderMax: layout.ladderMax, reference: layout.reference };
  // An absolute floor the trader sets: liquidity under it is simply not there.
  const minSize = minBandSizeFor(settings, style.market, layout.intervalMs);
  const prefix: Prefix = {
    key,
    tiers: layout.tiers.map((tier) => ({ columns: tier.columns, columnMs: tier.columnMs, cutTs: cutOf(tier) })),
    endTs: -Infinity,
    settled: new Float64Array(0),
    settledBars: [],
    fallbackUsed: false,
    reference: layout.reference,
    generation: 0,
    builtAt: 0,
    style,
    clusterRows,
    rowWidth: layout.rowWidth,
    intervalMs: layout.intervalMs,
    saturation,
    floorsAt: (column, bandIndex, standing) => {
      // Inside the quiet zone around a column's mid the floor a level needs to
      // APPEAR is raised: the churn at the top of the book is not drawn, only walls
      // are, and a wall is what clears that floor, whoever else is tracking it. A
      // level already standing keeps its ordinary floor when price comes to it, or
      // it would vanish on approach and whatever price did to it would never show.
      // Every floor is judged by the yardstick that was live when the column
      // printed (carried on the column), never by today's book, so history stays put.
      if (probing && settings.scaleMode !== "fixed" && !(column.reference !== undefined && column.reference > 0)) {
        prefix.fallbackUsed = true;
        prefix.reference = saturation.reference;
      }
      const quiet = !standing && inQuietZone(column, bandIndex, clusterRows, settings.quietBands) ? QUIET_FLOOR_MULTIPLE : 1;
      const paint = Math.max(minSize, style.paintFloor(column, saturation) * quiet, Number.EPSILON);
      return { paint, link: Math.max(minSize, paint * LINK_SHARE, Number.EPSILON) };
    },
    sizes: bandSizeCache.reader(style.bandSizes, clusterRows),
    scanners: new Map(),
    touches: new Map(),
  };
  let probing = false;
  const sizeAt = (column: LiquidityColumn, bandIndex: number, side: "bid" | "ask") => prefix.sizes.side(column, bandIndex, side);
  const touchesFor = (bandIndex: number): BarSpans => {
    let spans = prefix.touches.get(bandIndex);
    if (spans === undefined) {
      spans = touchingBars(prefix.settledBars, prefix.intervalMs, bandLoPrice(bandIndex, clusterRows, prefix.rowWidth), bandHiPrice(bandIndex, clusterRows, prefix.rowWidth));
      prefix.touches.set(bandIndex, spans);
    }
    return spans;
  };
  // The tiers interleave in time once the host's columns fill holes between the runtime's: fed oldest column first, whichever tier holds it.
  const feedBetween = (scanner: RunScanner, fromTs: number, toTs: number) => {
    const cursors = prefix.tiers.map((tier) => ({ tier, at: liquidityIndexAtOrAfter(tier.columns, fromTs), stop: Math.min(tier.cutTs, toTs) }));
    for (;;) {
      let next: (typeof cursors)[number] | null = null;
      for (const cursor of cursors) {
        if (cursor.at >= cursor.tier.columns.length || cursor.tier.columns[cursor.at].ts >= cursor.stop) continue;
        if (next === null || cursor.tier.columns[cursor.at].ts < next.tier.columns[next.at].ts) next = cursor;
      }
      if (next === null) break;
      scanner.feed(next.tier.columns[next.at], next.tier.columnMs);
      next.at += 1;
    }
  };
  const probe = (work: () => void) => {
    probing = true;
    try {
      work();
    } finally {
      probing = false;
    }
  };
  const scannerFor = (bandIndex: number, side: "bid" | "ask"): RunScanner => {
    const key = `${bandIndex}:${side}`;
    let scanner = prefix.scanners.get(key);
    if (scanner === undefined) {
      const fresh = createRunScanner(bandIndex, clusterRows, side, prefix.floorsAt, touchesFor(bandIndex), sizeAt, layout.clocks);
      probe(() => feedBetween(fresh, -Infinity, prefix.endTs));
      prefix.scanners.set(key, fresh);
      scanner = fresh;
    }
    return scanner;
  };
  const advance = (bars: readonly OhlcBar[], endTs: number) => {
    for (const bar of bars) {
      prefix.settledBars.push(bar);
      for (const [bandIndex, spans] of prefix.touches) {
        if (!(bar.low < bandHiPrice(bandIndex, clusterRows, prefix.rowWidth) && bar.high >= bandLoPrice(bandIndex, clusterRows, prefix.rowWidth))) continue;
        spans.opens.push(bar.time);
        spans.ends.push(bar.time + prefix.intervalMs);
      }
    }
    if (endTs > prefix.endTs) {
      probe(() => {
        for (const scanner of prefix.scanners.values()) feedBetween(scanner, prefix.endTs, endTs);
      });
      prefix.endTs = endTs;
    }
    prefix.generation += 1;
  };
  return Object.assign(prefix, { scannerFor, feedBetween, advance, sizeAt, touchesFor });
}

type BuiltPrefix = Prefix & {
  scannerFor(bandIndex: number, side: "bid" | "ask"): RunScanner;
  feedBetween(scanner: RunScanner, fromTs: number, toTs: number): void;
  advance(bars: readonly OhlcBar[], endTs: number): void;
  sizeAt(column: LiquidityColumn, bandIndex: number, side: "bid" | "ask"): number;
  touchesFor(bandIndex: number): BarSpans;
};

/** The kept scan for this frame: the memo's, advanced if the candles allow, or a new one. */
function prefixFor(grid: HeatGrid, layout: HeatmapLayout, settings: LiquiditySettings, memo: FinderMemo | undefined, at: number): BuiltPrefix {
  const key = prefixKeyOf(grid, layout, settings);
  const settledBars = layout.bars.slice(0, Math.max(0, layout.bars.length - 1));
  const settled = settledValues(settledBars);
  const live = layout.bars[layout.bars.length - 1];
  const endTs = live === undefined ? -Infinity : live.time;
  const kept = memo?.prefix as BuiltPrefix | undefined;
  const sameTiers = kept !== undefined && (tiersMatch(kept, layout) || (onlyHistoryChanged(kept, layout) && at - kept.builtAt < HISTORY_RESCAN_MS));
  if (kept !== undefined && sameTiers && kept.key === key && (!kept.fallbackUsed || kept.reference === layout.reference) && endTs >= kept.endTs) {
    const relation = settledRelation(kept.settled, settled);
    if (relation.kind === "same" && endTs === kept.endTs) return kept;
    if (relation.kind !== "rebuild") {
      kept.advance(settledBars.slice(relation.kept), endTs);
      kept.settled = settled;
      return kept;
    }
  }
  const fresh = buildPrefix(grid, layout, settings, key) as BuiltPrefix;
  fresh.settled = settled;
  fresh.settledBars = settledBars.slice();
  fresh.endTs = endTs;
  fresh.builtAt = at;
  return fresh;
}

export function createRunFinder(
  grid: HeatGrid,
  layout: HeatmapLayout,
  settings: LiquiditySettings,
  at: number = performance.now(),
): RunFinder {
  const memo = finderMemos.get(grid);
  const prefix = prefixFor(grid, layout, settings, memo, at);
  const live = liveBarOf(layout);
  const tailKey = JSON.stringify([grid.version, prefix.generation, live, layout.reference, layout.ladderMax]);
  if (memo !== undefined && memo.prefix === prefix && memo.tailKey === tailKey) return memo.finder;
  prefix.saturation.reference = layout.reference;
  prefix.saturation.ladderMax = layout.ladderMax;
  const { clusterRows, rowWidth } = prefix;
  const tailTouches = new Map<number, BarSpans>();
  const tailTouchesFor = (bandIndex: number): BarSpans => {
    let spans = tailTouches.get(bandIndex);
    if (spans === undefined) {
      const settled = prefix.touchesFor(bandIndex);
      spans = live !== null && liveTouches(live, bandIndex, clusterRows, rowWidth)
        ? { opens: [...settled.opens, live.time], ends: [...settled.ends, live.time + prefix.intervalMs] }
        : settled;
      tailTouches.set(bandIndex, spans);
    }
    return spans;
  };
  // The candles and the column's mid say whether price reached the band; the
  // server's ledger says what happened to the size that left, and settles the
  // fate when it can.
  const found = new Map<string, RunSegment[]>();
  const runsFor = (bandIndex: number, side: "bid" | "ask"): RunSegment[] => {
    const key = `${bandIndex}:${side}`;
    let runs = found.get(key);
    if (runs === undefined) {
      const scanner = prefix.scannerFor(bandIndex, side).fork(tailTouchesFor(bandIndex));
      prefix.feedBetween(scanner, prefix.endTs, Infinity);
      runs = settleWithLedger(scanner.result(), grid.levels, bandIndex, clusterRows, side, layout.clocks.matchMs);
      found.set(key, runs);
    }
    return runs;
  };
  const finder: RunFinder = {
    style: prefix.style,
    clusterRows,
    saturation: prefix.saturation,
    floorsAt: prefix.floorsAt,
    sizesAt: (column, bandIndex) => prefix.sizes.both(column, bandIndex),
    runsFor,
  };
  finderMemos.set(grid, { prefix, tailKey, finder });
  return finder;
}
