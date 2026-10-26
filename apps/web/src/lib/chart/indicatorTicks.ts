import type {
  AggressivePrint,
  AggressiveTape,
} from "../indicators/aggressive-orders/aggressiveTape";

/**
 * The terminal's own L1 print store, as an indicator sees it.
 *
 * `AggressiveTape` holds every print of the live pair -- fed the moment it lands
 * -- plus whatever history the server could serve for before this browser
 * connected (a bounded, **floor-filtered** pool, not the raw tape). It is the
 * same store the whale detector and Aggressive Order Flow read.
 *
 * Because history is served above a size floor and the live tape is complete,
 * a window is either covered by every print (`"all"`), covered only by prints
 * above that floor (`"thin"`), or not covered at all (`"none"`). An indicator
 * that prices volume has to say which one it is looking at rather than assume.
 */
export type TickCoverage = "all" | "thin" | "none";

export interface IndicatorTicks {
  /** Every print the store still holds, oldest first. */
  readonly prints: readonly AggressivePrint[];
  /** The instant complete live recording began, or null when nothing is live yet. */
  readonly liveSince: number | null;
  /** How the store covers `[fromTs, toTs)`. */
  coverageOf(fromTs: number, toTs: number): TickCoverage;
}

/** The index of the first print at or after `ts`, or `prints.length`. */
export function firstPrintAtOrAfter(
  prints: readonly AggressivePrint[],
  ts: number,
): number {
  let low = 0;
  let high = prints.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (prints[middle].ts < ts) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function sumPrintsIn(
  prints: readonly AggressivePrint[],
  fromTs: number,
  toTs: number,
): { volume: number; priceVolume: number; priceSquaredVolume: number } {
  let volume = 0;
  let priceVolume = 0;
  let priceSquaredVolume = 0;
  for (let index = firstPrintAtOrAfter(prints, fromTs); index < prints.length; index += 1) {
    const print = prints[index];
    if (print.ts >= toTs) break;
    const { price, size } = print;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) continue;
    volume += size;
    priceVolume += price * size;
    priceSquaredVolume += price * price * size;
  }
  return { volume, priceVolume, priceSquaredVolume };
}

function coversWindow(
  intervals: readonly { from: number; to: number }[],
  fromTs: number,
  toTs: number,
): boolean {
  return intervals.some(
    (interval) => interval.from <= fromTs && interval.to >= toTs,
  );
}

export function indicatorTicksOf(tape: AggressiveTape | null): IndicatorTicks | null {
  if (tape === null) return null;
  return {
    get prints(): readonly AggressivePrint[] {
      return tape.prints;
    },
    get liveSince(): number | null {
      return tape.liveSince;
    },
    coverageOf(fromTs: number, toTs: number): TickCoverage {
      // Every print from the moment live recording began; the window's end may
      // be in the future while the bar is still forming, which is still covered.
      // An earlier live stretch (before a reconnect) covers what lies inside it.
      // Either is complete only past the newest live print the store's size cap
      // dropped: a window it reached lost prints, so it reads as thin.
      const liveFrom = tape.liveSince;
      const live =
        (liveFrom !== null && fromTs >= liveFrom) ||
        tape.liveSpans.some((span) => span.from <= fromTs && span.to >= toTs);
      if (live) return fromTs > tape.liveDroppedThrough ? "all" : "thin";
      // A floor of zero is the server saying it served this stretch in full.
      if (coversWindow(tape.historyIntervalsAt(0), fromTs, toTs)) return "all";
      if (coversWindow(tape.historyIntervalsAt(Infinity), fromTs, toTs))
        return "thin";
      return "none";
    },
  };
}
