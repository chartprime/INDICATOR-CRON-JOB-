import type { BarFrame } from "../../../types/frames";
import type { AggressivePrint } from "../aggressive-orders/aggressiveTape";
import { firstPrintAtOrAfter, type IndicatorTicks, type TickCoverage } from "../../chart/indicatorTicks";
import { nyLocalMinuteOfDay } from "../killzones/killzones";

/**
 * Size-Split Delta: the pure, incremental machinery
 * (`pm/cycle2/brief-size-split-delta.md`, rules 1 to 13 and the round-3
 * amendments).
 *
 * Every bar is a window `[ts_open, ts_open + interval_ms)` over the terminal's
 * print store. A print at or above the bar's tier threshold is "large", the
 * rest "small"; the signed sizes of each tier are the bar's two contributions,
 * and the two lines are their cumulative sums since the anchor. The threshold
 * is read once, at the bar's first dispatch, from a ring of the last 4,096
 * sizes of committed, completely covered windows (nearest-rank p98, 200 sizes
 * minimum), or is a fixed size.
 *
 * Commits are keyed to the bar close and tail-only. An explicit closed
 * dispatch rescans the window from the store; a supersession (the next bar
 * arrives first) commits the tail's last revision values without a rescan,
 * because the runtime cannot republish the previous bar. After commit nothing
 * about the bar changes until a rebuild replays everything from the store.
 *
 * Coverage from the store is the only gate on tick-derived values; a window
 * that is not `"all"` has no value. The tape share (print volume over candle
 * volume) must be known and inside `[minTapeShare, MAX_TAPE_SHARE]`, else the
 * bar is ineligible; eligibility is frozen with the flow at commit.
 */

export const SIZE_RING_CAPACITY = 4_096;
export const TIER_MIN_SIZES = 200;
export const TIER_QUANTILE = 0.98;
export const MAX_TAPE_SHARE = 1.25;
export const RECORD_RING_CAPACITY = 10_080;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const SIZE_SPLIT_DEFAULT_K = 20;
export const SIZE_SPLIT_DEFAULT_M = 2;
export const SIZE_SPLIT_DEFAULT_Q = 2;
export const SIZE_SPLIT_DEFAULT_MIN_TAPE_SHARE = 0.5;
export const SIZE_SPLIT_DEFAULT_TIER_SIZE = 0.5;

export type TierMode = "auto" | "fixed";
export type SizeSplitAnchor = "day" | "week" | "tape";

export interface SizeSplitMathSettings {
  tierMode: TierMode;
  tierSize: number;
  anchor: SizeSplitAnchor;
  K: number;
  m: number;
  q: number;
  minTapeShare: number;
}

/** `"noStore"` is a ctx without a print store (the REST transport, a replay with no extras). */
export type SizeSplitCoverage = TickCoverage | "noStore";

export type SizeSplitStatus = "noFeed" | "tapeStarting" | "thinned" | "learning" | "shareUnknown" | "shareMismatch" | "shareLow" | "gap" | "forming" | "ready";

export type ConfirmationState = "confirms" | "lags" | "noExtreme";

export type DivergenceDirection = "bearish" | "bullish";

export interface SizeSplitCondition {
  kind: "divergence" | "conflict";
  direction: DivergenceDirection | null;
  tsOpen: number;
  /** `large_t - large_h` for a divergence; the two sums for a conflict. */
  values: readonly number[];
}

/** The tail bar's record; `sizes` is the last revision's valid sizes (newest 4,096), dropped at commit. */
export interface SizeSplitRecord {
  tsOpen: number;
  windowEnd: number;
  close: number;
  volume: number;
  tierAtOpen: number | null;
  coverage: SizeSplitCoverage;
  /** Coverage `"none"` only because the live recording began inside this window: the next bar is covered (UX finding 2). */
  tapeStarting: boolean;
  largeBar: number | null;
  smallBar: number | null;
  tapeVolume: number;
  printCount: number;
  share: number | null;
  eligible: boolean;
  /** Coverage `"all"`, a threshold and an eligible share: the bar has a value. */
  valid: boolean;
  sizes: number[] | null;
  committed: boolean;
  /** Committed by an explicit close (final styling); false while forming or when superseded. */
  confirmed: boolean;
  /** Frozen at commit so a later dispatch of the same bar reads the same thing. */
  reading: SizeSplitReading | null;
}

/** What the engine keeps per committed bar: one small struct, bounded to `RECORD_RING_CAPACITY`. */
export interface CommittedBar {
  tsOpen: number;
  tierAtOpen: number | null;
  largeBar: number | null;
  smallBar: number | null;
  share: number | null;
  valid: boolean;
  confirmed: boolean;
}

export interface SizeSplitReading {
  tsOpen: number;
  large: number | null;
  small: number | null;
  largeBar: number | null;
  smallBar: number | null;
  share: number | null;
  tier: number | null;
  sizesLearned: number;
  status: SizeSplitStatus;
  gapBars: number;
  /** Committed by a close or a supersession; provisional styling ends here (UX finding 5). */
  committed: boolean;
  confirmed: boolean;
  valid: boolean;
  /** Valid committed bars in the marker ring (at most `K`). */
  ringLength: number;
  state: ConfirmationState | null;
  divergence: DivergenceDirection | null;
  depth: number | null;
  /** The divergence condition at this bar, drawn or not. */
  divergenceHeld: DivergenceDirection | null;
  conflictHeld: boolean;
  conflictOnset: boolean;
  conflictSums: readonly [number, number] | null;
  /** The newest divergence in this anchor window, this bar's own included; the def shows it only while its toggle is on. */
  lastDivergence: SizeSplitCondition | null;
  /** The newest conflict onset in this anchor window, this bar's own included. */
  lastConflict: SizeSplitCondition | null;
}

export interface MarkerRingEntry {
  close: number;
  largeBar: number;
  smallBar: number;
  large: number;
}

export interface WindowScan {
  coverage: SizeSplitCoverage;
  largeBar: number | null;
  smallBar: number | null;
  tapeVolume: number;
  printCount: number;
  sizes: number[];
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** The tape share of a bar, null when the candle volume is missing or not positive (fail closed). */
export function tapeShareOf(tapeVolume: number, volume: number): number | null {
  if (!Number.isFinite(volume) || volume <= 0 || !Number.isFinite(tapeVolume) || tapeVolume < 0) return null;
  return tapeVolume / volume;
}

export function shareEligible(share: number | null, minTapeShare: number): boolean {
  return share !== null && Number.isFinite(share) && share >= minTapeShare && share <= MAX_TAPE_SHARE;
}

/**
 * The window `[fromTs, toTs)` scanned once from the store: valid prints only,
 * `size >= tier` large with the boundary print included, buys positive. With
 * no threshold nothing is classified, but the valid sizes are still collected
 * so they can train the ring (amendment 3). The size list is bounded to the
 * newest `SIZE_RING_CAPACITY` (amendment 1).
 */
export function scanWindow(ticks: IndicatorTicks | undefined, fromTs: number, toTs: number, tier: number | null): WindowScan {
  if (ticks === undefined) return { coverage: "noStore", largeBar: null, smallBar: null, tapeVolume: 0, printCount: 0, sizes: [] };
  const coverage = ticks.coverageOf(fromTs, toTs);
  const prints: readonly AggressivePrint[] = ticks.prints;
  let largeBar = 0;
  let smallBar = 0;
  let tapeVolume = 0;
  let printCount = 0;
  const sizes: number[] = [];
  for (let index = firstPrintAtOrAfter(prints, fromTs); index < prints.length; index += 1) {
    const print = prints[index];
    if (print.ts >= toTs) break;
    if (!isFinitePositive(print.size) || !isFinitePositive(print.price)) continue;
    printCount += 1;
    tapeVolume += print.size;
    sizes.push(print.size);
    if (tier === null) continue;
    const signed = print.side === "buy" ? print.size : -print.size;
    if (print.size >= tier) largeBar += signed;
    else smallBar += signed;
  }
  if (sizes.length > SIZE_RING_CAPACITY) sizes.splice(0, sizes.length - SIZE_RING_CAPACITY);
  return { coverage, largeBar: tier === null ? null : largeBar, smallBar: tier === null ? null : smallBar, tapeVolume, printCount, sizes };
}

/**
 * The size ring: the last `SIZE_RING_CAPACITY` sizes in arrival order, plus the
 * same values kept sorted so the nearest-rank quantile is one index read. Both
 * are typed arrays; an insert or an eviction moves at most 4,096 doubles with
 * `copyWithin`, so a commit of a hundred prints costs well under a millisecond
 * and nothing is ever re-sorted.
 */
export interface SizeRing {
  readonly count: number;
  push(sizes: readonly number[]): void;
  /** Nearest-rank p98 of the held sizes, null under `TIER_MIN_SIZES`. */
  threshold(): number | null;
  /** The held sizes in arrival order (oldest first); for tests. */
  values(): number[];
}

export function createSizeRing(capacity = SIZE_RING_CAPACITY, minSizes = TIER_MIN_SIZES, quantile = TIER_QUANTILE): SizeRing {
  const arrival = new Float64Array(capacity);
  const sorted = new Float64Array(capacity);
  let head = 0;
  let count = 0;

  function lowerBound(value: number): number {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sorted[middle] < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function removeSorted(value: number): void {
    const index = lowerBound(value);
    sorted.copyWithin(index, index + 1, count);
    count -= 1;
  }

  function insertSorted(value: number): void {
    const index = lowerBound(value);
    sorted.copyWithin(index + 1, index, count);
    sorted[index] = value;
    count += 1;
  }

  return {
    get count() {
      return count;
    },
    push(sizes) {
      for (const size of sizes) {
        if (!isFinitePositive(size)) continue;
        if (count === capacity) removeSorted(arrival[head]);
        arrival[head] = size;
        head = (head + 1) % capacity;
        insertSorted(size);
      }
    },
    threshold() {
      if (count < minSizes) return null;
      const index = Math.min(count - 1, Math.max(0, Math.ceil(quantile * count) - 1));
      return sorted[index];
    },
    values() {
      const out: number[] = [];
      const start = count === capacity ? head : 0;
      for (let offset = 0; offset < count; offset += 1) out.push(arrival[(start + offset) % capacity]);
      return out;
    },
  };
}

/** The anchor window a bar belongs to: UTC-aligned day or week (epoch-aligned, as the session kernel), or null for `tape`. */
export function anchorStartFor(tsOpen: number, anchor: SizeSplitAnchor): number | null {
  if (anchor === "tape") return null;
  const period = anchor === "day" ? DAY_MS : WEEK_MS;
  if (!Number.isFinite(tsOpen)) return null;
  return Math.floor(tsOpen / period) * period;
}

export interface MarkerEvaluation {
  state: ConfirmationState | null;
  /** The divergence condition at this bar. */
  divergenceHeld: DivergenceDirection | null;
  /** The drawn arrow: the condition's onset, held at this bar and not held in the same direction at the previous valid bar (PM amendment to rule 11). */
  divergence: DivergenceDirection | null;
  depth: number | null;
  conflictHeld: boolean;
  conflictOnset: boolean;
  conflictSums: readonly [number, number] | null;
}

const NO_EVALUATION: MarkerEvaluation = Object.freeze({ state: null, divergenceHeld: null, divergence: null, depth: null, conflictHeld: false, conflictOnset: false, conflictSums: null });

/**
 * Rule 11 and amendment 2 for bar `t` against a full ring of `K` valid committed
 * bars immediately before it: `h` the ring bar with the highest close (latest
 * if tied), `l` the lowest; a strict new high confirms when `large_t >
 * large_h`, lags otherwise, and draws the bearish arrow when `large_t <=
 * large_h - m · mabsL`; the mirror for a strict new low. The conflict holds
 * when the ring-plus-`t` sums of the two tiers oppose each other and each
 * clears `q · sqrt(K + 1)` times its tier's mean absolute contribution. Both
 * markers fire on the onset only: the condition holds at `t` and did not hold
 * (in that direction) at the previous valid bar, so a trend where every bar is
 * a new extreme with a lagging large tier marks once and again only after the
 * condition has cleared (PM amendment to rule 11).
 */
export function evaluateMarkers(
  ring: readonly MarkerRingEntry[],
  bar: { close: number; largeBar: number; smallBar: number; large: number },
  previous: { conflict: boolean; divergence: DivergenceDirection | null },
  settings: Pick<SizeSplitMathSettings, "K" | "m" | "q">,
): MarkerEvaluation {
  const K = settings.K;
  if (ring.length < K) return NO_EVALUATION;
  let h = 0;
  let l = 0;
  let sumAbsLarge = 0;
  let sumAbsSmall = 0;
  let sumLarge = bar.largeBar;
  let sumSmall = bar.smallBar;
  for (let index = 0; index < ring.length; index += 1) {
    const entry = ring[index];
    if (entry.close >= ring[h].close) h = index;
    if (entry.close <= ring[l].close) l = index;
    sumAbsLarge += Math.abs(entry.largeBar);
    sumAbsSmall += Math.abs(entry.smallBar);
    sumLarge += entry.largeBar;
    sumSmall += entry.smallBar;
  }
  const mabsL = sumAbsLarge / ring.length;
  const mabsS = sumAbsSmall / ring.length;
  let state: ConfirmationState = "noExtreme";
  let divergenceHeld: DivergenceDirection | null = null;
  let depth: number | null = null;
  if (bar.close > ring[h].close) {
    state = bar.large > ring[h].large ? "confirms" : "lags";
    if (bar.large <= ring[h].large - settings.m * mabsL) {
      divergenceHeld = "bearish";
      depth = bar.large - ring[h].large;
    }
  } else if (bar.close < ring[l].close) {
    state = bar.large < ring[l].large ? "confirms" : "lags";
    if (bar.large >= ring[l].large + settings.m * mabsL) {
      divergenceHeld = "bullish";
      depth = bar.large - ring[l].large;
    }
  }
  const divergence = divergenceHeld !== null && divergenceHeld !== previous.divergence ? divergenceHeld : null;
  const strength = settings.q * Math.sqrt(K + 1);
  const conflictHeld = Math.sign(sumLarge) * Math.sign(sumSmall) < 0 && Math.abs(sumLarge) >= strength * mabsL && Math.abs(sumSmall) >= strength * mabsS;
  return { state, divergenceHeld, divergence, depth: divergence === null ? null : depth, conflictHeld, conflictOnset: conflictHeld && !previous.conflict, conflictSums: [sumLarge, sumSmall] };
}

/** Status precedence, first match wins (rule 12, amendment 5). */
export function statusOf(record: Pick<SizeSplitRecord, "coverage" | "tapeStarting" | "tierAtOpen" | "share" | "eligible" | "committed">, gapBars: number, validSinceGap: number, K: number): SizeSplitStatus {
  if (record.coverage === "none" && record.tapeStarting) return "tapeStarting";
  if (record.coverage === "noStore" || record.coverage === "none") return "noFeed";
  if (record.coverage === "thin") return "thinned";
  if (record.tierAtOpen === null) return "learning";
  if (record.share === null) return "shareUnknown";
  if (record.share > MAX_TAPE_SHARE) return "shareMismatch";
  if (!record.eligible) return "shareLow";
  if (gapBars > 0 && validSinceGap < K) return "gap";
  if (!record.committed) return "forming";
  return "ready";
}

export interface SizeSplitEngine {
  /** Feed one dispatch (forming revision, close, or the next bar) and read the current bar. */
  onBar(bar: BarFrame, ticks: IndicatorTicks | undefined): SizeSplitReading;
  readonly tail: SizeSplitRecord | null;
  readonly sizeRing: SizeRing;
  readonly markerRing: readonly MarkerRingEntry[];
  readonly base: { readonly large: number; readonly small: number };
  readonly anchorStart: number | null;
  /** Committed bars, oldest first, at most `RECORD_RING_CAPACITY`. */
  readonly committed: readonly CommittedBar[];
  readonly lastDivergence: SizeSplitCondition | null;
  readonly lastConflict: SizeSplitCondition | null;
}

export function createSizeSplitEngine(settings: SizeSplitMathSettings): SizeSplitEngine {
  const sizeRing = createSizeRing();
  const committed: CommittedBar[] = [];
  const markerRing: MarkerRingEntry[] = [];
  const base = { large: 0, small: 0 };
  let tail: SizeSplitRecord | null = null;
  let anchorStart: number | null = null;
  let anchorSeen = false;
  let previousConflict = false;
  let previousDivergence: DivergenceDirection | null = null;
  let lastDivergence: SizeSplitCondition | null = null;
  let lastConflict: SizeSplitCondition | null = null;
  /** Whether a valid bar has committed in this anchor window (a gap needs a valid bar before it). */
  let validEver = false;
  /** Invalid committed bars in the most recent gap, and valid bars committed since it closed. */
  let gapBars = 0;
  let validSinceGap = 0;
  let lastReading: SizeSplitReading | null = null;

  function tierFor(): number | null {
    if (settings.tierMode === "fixed") return isFinitePositive(settings.tierSize) ? settings.tierSize : null;
    return sizeRing.threshold();
  }

  function divergenceOf(tsOpen: number, evaluation: MarkerEvaluation): SizeSplitCondition | null {
    return evaluation.divergence === null ? null : { kind: "divergence", direction: evaluation.divergence, tsOpen, values: [evaluation.depth ?? 0] };
  }

  function conflictOf(tsOpen: number, evaluation: MarkerEvaluation): SizeSplitCondition | null {
    return evaluation.conflictOnset && evaluation.conflictSums !== null ? { kind: "conflict", direction: null, tsOpen, values: evaluation.conflictSums } : null;
  }

  function readingOf(record: SizeSplitRecord): SizeSplitReading {
    const large = record.valid ? base.large + (record.largeBar as number) : null;
    const small = record.valid ? base.small + (record.smallBar as number) : null;
    const evaluation = record.valid
      ? evaluateMarkers(markerRing, { close: record.close, largeBar: record.largeBar as number, smallBar: record.smallBar as number, large: large as number }, { conflict: previousConflict, divergence: previousDivergence }, settings)
      : NO_EVALUATION;
    const ownDivergence = record.valid ? divergenceOf(record.tsOpen, evaluation) : null;
    const ownConflict = record.valid ? conflictOf(record.tsOpen, evaluation) : null;
    return {
      tsOpen: record.tsOpen,
      large,
      small,
      largeBar: record.valid ? record.largeBar : null,
      smallBar: record.valid ? record.smallBar : null,
      share: record.share,
      tier: record.tierAtOpen,
      sizesLearned: sizeRing.count,
      status: statusOf(record, gapBars, validSinceGap, settings.K),
      gapBars,
      committed: record.committed,
      confirmed: record.confirmed,
      valid: record.valid,
      ringLength: markerRing.length,
      state: evaluation.state,
      divergence: evaluation.divergence,
      divergenceHeld: evaluation.divergenceHeld,
      depth: evaluation.depth,
      conflictHeld: evaluation.conflictHeld,
      conflictOnset: evaluation.conflictOnset,
      conflictSums: evaluation.conflictSums,
      lastDivergence: ownDivergence ?? lastDivergence,
      lastConflict: ownConflict ?? lastConflict,
    };
  }

  function fill(record: SizeSplitRecord, bar: BarFrame, ticks: IndicatorTicks | undefined): void {
    const scan = scanWindow(ticks, record.tsOpen, record.windowEnd, record.tierAtOpen);
    record.close = bar.close;
    record.volume = bar.volume;
    record.coverage = scan.coverage;
    record.tapeStarting = scan.coverage === "none" && ticks !== undefined && ticks.prints.length > 0 && ticks.liveSince !== null && ticks.liveSince < record.windowEnd;
    record.largeBar = scan.largeBar;
    record.smallBar = scan.smallBar;
    record.tapeVolume = scan.tapeVolume;
    record.printCount = scan.printCount;
    record.sizes = scan.sizes;
    record.share = scan.coverage === "all" ? tapeShareOf(scan.tapeVolume, bar.volume) : null;
    record.eligible = shareEligible(record.share, settings.minTapeShare);
    record.valid = scan.coverage === "all" && record.tierAtOpen !== null && scan.largeBar !== null && scan.smallBar !== null && record.eligible;
  }

  /** Steps 2 to 4 of rule 6: freeze flow and eligibility, train the ring, advance the cumulatives (or record the gap). */
  function commit(record: SizeSplitRecord, confirmed: boolean): void {
    record.confirmed = confirmed;
    record.committed = true;
    const reading = readingOf(record);
    record.reading = reading;
    if (record.coverage === "all" && record.sizes !== null) sizeRing.push(record.sizes);
    if (record.valid) {
      base.large += record.largeBar as number;
      base.small += record.smallBar as number;
      markerRing.push({ close: record.close, largeBar: record.largeBar as number, smallBar: record.smallBar as number, large: base.large });
      if (markerRing.length > settings.K) markerRing.splice(0, markerRing.length - settings.K);
      previousConflict = reading.conflictHeld;
      previousDivergence = reading.divergenceHeld;
      const ownDivergence = divergenceOf(record.tsOpen, reading);
      const ownConflict = conflictOf(record.tsOpen, reading);
      if (ownDivergence !== null) lastDivergence = ownDivergence;
      if (ownConflict !== null) lastConflict = ownConflict;
      validEver = true;
      validSinceGap += 1;
    } else {
      markerRing.length = 0;
      previousConflict = false;
      previousDivergence = null;
      if (validEver) {
        gapBars = validSinceGap > 0 ? 1 : gapBars + 1;
        validSinceGap = 0;
      }
    }
    record.sizes = null;
    committed.push({ tsOpen: record.tsOpen, tierAtOpen: record.tierAtOpen, largeBar: record.largeBar, smallBar: record.smallBar, share: record.share, valid: record.valid, confirmed });
    if (committed.length > RECORD_RING_CAPACITY) committed.splice(0, committed.length - RECORD_RING_CAPACITY);
  }

  /** Step 5 of rule 6: the new record, with the anchor reset applied first when the bar opens a new window (rule 8). */
  function open(bar: BarFrame): SizeSplitRecord {
    const start = anchorStartFor(bar.ts_open, settings.anchor);
    if (!anchorSeen || start !== anchorStart) {
      if (anchorSeen) {
        base.large = 0;
        base.small = 0;
        markerRing.length = 0;
        previousConflict = false;
        previousDivergence = null;
        lastDivergence = null;
        lastConflict = null;
        validEver = false;
        gapBars = 0;
        validSinceGap = 0;
      }
      anchorStart = start;
      anchorSeen = true;
    }
    return {
      tsOpen: bar.ts_open,
      windowEnd: bar.ts_open + bar.interval_ms,
      close: bar.close,
      volume: bar.volume,
      tierAtOpen: tierFor(),
      coverage: "noStore",
      tapeStarting: false,
      largeBar: null,
      smallBar: null,
      tapeVolume: 0,
      printCount: 0,
      share: null,
      eligible: false,
      valid: false,
      sizes: null,
      committed: false,
      confirmed: false,
      reading: null,
    };
  }

  return {
    onBar(bar, ticks) {
      if (tail !== null && bar.ts_open < tail.tsOpen) return lastReading ?? readingOf(tail);
      if (tail !== null && bar.ts_open > tail.tsOpen) {
        if (!tail.committed) commit(tail, false);
        tail = null;
      }
      if (tail === null) tail = open(bar);
      if (tail.committed) {
        lastReading = tail.reading ?? readingOf(tail);
        return lastReading;
      }
      fill(tail, bar, ticks);
      if (bar.closed) {
        commit(tail, true);
        lastReading = tail.reading as SizeSplitReading;
        return lastReading;
      }
      lastReading = readingOf(tail);
      return lastReading;
    },
    get tail() {
      return tail;
    },
    sizeRing,
    markerRing,
    base,
    get anchorStart() {
      return anchorStart;
    },
    committed,
    get lastDivergence() {
      return lastDivergence;
    },
    get lastConflict() {
      return lastConflict;
    },
  };
}

/* Formatting shared by the table and the doc examples (amendment 7). */

const MINUS = "−";

/** Three significant digits with `k`/`M` suffixes and an explicit sign; zero prints as `0`. */
export function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const sign = value < 0 ? MINUS : "+";
  return `${sign}${formatMagnitude(Math.abs(value))}`;
}

export function formatMagnitude(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value >= 1e6) return `${trimDigits(value / 1e6)}M`;
  if (value >= 1e3) return `${trimDigits(value / 1e3)}k`;
  return trimDigits(value);
}

function trimDigits(value: number): string {
  if (value === 0) return "0";
  const text = value.toPrecision(3);
  if (text.includes("e")) return Number(text).toString();
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** `HH:MM` in the instrument's clock: New York for dxFeed and Databento, UTC for Binance. */
export function formatClock(tsOpen: number, provider: BarFrame["provider"]): string {
  if (!Number.isFinite(tsOpen)) return "—";
  const minuteOfDay = provider === "DXFEED" || provider === "DATABENTO" ? nyLocalMinuteOfDay(tsOpen) : Math.floor((tsOpen % DAY_MS) / 60_000);
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
