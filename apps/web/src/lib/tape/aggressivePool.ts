// Browser mirror of apps/runtime/src/server/aggressive-pool.js (createAggressivePool),
// with its two helpers from apps/runtime/src/indicators/passive_liquidity/
// print-floor.js (createPrintFloor) and bounded-prints.js (floorAbove), each
// line for line. The pool is the server's bounded store of big prints: a size
// floor from the 98th percentile of the last 4,096 sizes once 200 are seen,
// never falling; four hours deep; 20,000 prints at most, trimmed by size with
// the floor raised to what survived, so what it reports is complete from its
// floor over [from, now]. The browser-direct transport runs it in the worker;
// workers/tests/tapeParity.test.ts requires the runtime file and asserts the
// two agree print for print. Change both or neither.

export interface PoolPrint {
  readonly ts_exchange: number;
  readonly size: number;
  readonly trade_id: string;
}

export interface PrintFloor {
  push(size: number): void;
  value(): number;
}

export interface PoolSnapshot<T extends PoolPrint> {
  readonly prints: readonly T[];
  readonly floor: number;
  readonly from: number;
}

export interface AggressivePool<T extends PoolPrint> {
  record(trade: T): boolean;
  seed(trades: readonly T[], options?: { fromMs?: number; calibrate?: boolean }): number;
  snapshot(): PoolSnapshot<T>;
  gate(): number;
  readonly size: number;
  readonly floor: number;
}

export const DEFAULT_WINDOW_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_MAX_PRINTS = 20_000;
export const DEFAULT_FLOOR_SHARE = 0.02;
export const DEFAULT_FLOOR_WINDOW = 4_096;
export const DEFAULT_FLOOR_MIN_SAMPLES = 200;
export const DEFAULT_CALIBRATION_MS = 15 * 60 * 1000;

export function floorAbove(size: number): number {
  return size + Number.EPSILON * Math.max(1, size);
}

export function createPrintFloor({ window, share, minSamples }: { window: number; share: number; minSamples: number }): PrintFloor {
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error("print-floor: window must be a positive safe integer");
  if (!(share > 0 && share < 1)) throw new Error("print-floor: share must be in (0, 1)");
  if (!Number.isSafeInteger(minSamples) || minSamples <= 0) throw new Error("print-floor: minSamples must be a positive safe integer");

  const arrivals = new Float64Array(window);
  const sorted = new Float64Array(window);
  let next = 0;
  let filled = 0;

  function firstAbove(size: number): number {
    let lo = 0;
    let hi = filled;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= size) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function remove(size: number): void {
    const at = firstAbove(size) - 1;
    sorted.copyWithin(at, at + 1, filled);
    filled -= 1;
  }

  function insert(size: number): void {
    const at = firstAbove(size);
    sorted.copyWithin(at + 1, at, filled);
    sorted[at] = size;
    filled += 1;
  }

  function push(size: number): void {
    if (filled === window) remove(arrivals[next]);
    arrivals[next] = size;
    next = (next + 1) % window;
    insert(size);
  }

  function value(): number {
    if (filled < minSamples) return 0;
    const index = Math.min(filled - 1, Math.max(0, Math.ceil(filled * (1 - share)) - 1));
    return sorted[index];
  }

  return Object.freeze({ push, value });
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`aggressive-pool: ${field} must be a positive safe integer`);
}

export function createAggressivePool<T extends PoolPrint>({
  windowMs = DEFAULT_WINDOW_MS,
  maxPrints = DEFAULT_MAX_PRINTS,
  floorShare = DEFAULT_FLOOR_SHARE,
  floorWindow = DEFAULT_FLOOR_WINDOW,
  floorMinSamples = DEFAULT_FLOOR_MIN_SAMPLES,
  now = () => Date.now(),
}: {
  windowMs?: number;
  maxPrints?: number;
  floorShare?: number;
  floorWindow?: number;
  floorMinSamples?: number;
  now?: () => number;
} = {}): AggressivePool<T> {
  assertPositiveInteger(windowMs, "windowMs");
  assertPositiveInteger(maxPrints, "maxPrints");
  assertPositiveInteger(floorWindow, "floorWindow");
  assertPositiveInteger(floorMinSamples, "floorMinSamples");
  if (!(floorShare > 0 && floorShare < 1)) throw new Error("aggressive-pool: floorShare must be in (0, 1)");

  const printFloor = createPrintFloor({ window: floorWindow, share: floorShare, minSamples: floorMinSamples });
  let prints: T[] = [];
  const ids = new Set<string>();
  let coverageFloor = 0;
  let from: number | null = null;

  function gate(): number {
    return printFloor.value();
  }

  function insert(trade: T): boolean {
    if (ids.has(trade.trade_id)) return false;
    ids.add(trade.trade_id);
    const last = prints[prints.length - 1];
    if (!last || last.ts_exchange <= trade.ts_exchange) {
      prints.push(trade);
      return true;
    }
    let lo = 0;
    let hi = prints.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (prints[mid].ts_exchange <= trade.ts_exchange) lo = mid + 1;
      else hi = mid;
    }
    prints.splice(lo, 0, trade);
    return true;
  }

  function trimWindow(at: number): void {
    const cutoff = at - windowMs;
    let drop = 0;
    while (drop < prints.length && prints[drop].ts_exchange < cutoff) drop += 1;
    if (drop > 0) for (const gone of prints.splice(0, drop)) ids.delete(gone.trade_id);
    if (from === null || from < cutoff) from = cutoff;
  }

  function trimCount(): void {
    if (prints.length <= maxPrints) return;
    const bySize = prints.map((print) => print.size).sort((a, b) => a - b);
    let threshold = bySize[prints.length - maxPrints];
    let atOrAbove = 0;
    for (const size of bySize) if (size >= threshold) atOrAbove += 1;
    if (atOrAbove > maxPrints) {
      const above = bySize.find((size) => size > threshold);
      if (above === undefined) {
        for (const gone of prints) ids.delete(gone.trade_id);
        prints = [];
        coverageFloor = Math.max(coverageFloor, floorAbove(threshold));
        return;
      }
      threshold = above;
    }
    const kept: T[] = [];
    for (const print of prints) {
      if (print.size < threshold) ids.delete(print.trade_id);
      else kept.push(print);
    }
    prints = kept;
    if (threshold > coverageFloor) coverageFloor = threshold;
  }

  function record(trade: T): boolean {
    if (!(trade.size > 0)) return false;
    printFloor.push(trade.size);
    const floor = gate();
    if (floor > coverageFloor) coverageFloor = floor;
    if (trade.size < Math.max(floor, coverageFloor)) return false;
    if (!insert(trade)) return false;
    trimWindow(now());
    trimCount();
    return true;
  }

  function mergeInsertAll(candidates: T[]): number {
    if (candidates.length === 0) return 0;
    const ordered = candidates.length === 1 ? candidates : [...candidates].sort((a, b) => a.ts_exchange - b.ts_exchange);
    const merged: T[] = [];
    let i = 0;
    let j = 0;
    while (i < prints.length && j < ordered.length) {
      if (prints[i].ts_exchange <= ordered[j].ts_exchange) merged.push(prints[i++]);
      else merged.push(ordered[j++]);
    }
    while (i < prints.length) merged.push(prints[i++]);
    while (j < ordered.length) merged.push(ordered[j++]);
    for (const trade of ordered) ids.add(trade.trade_id);
    prints = merged;
    return ordered.length;
  }

  function seed(trades: readonly T[], { fromMs, calibrate = false }: { fromMs?: number; calibrate?: boolean } = {}): number {
    const admit = calibrate ? 0 : Math.max(coverageFloor, gate());
    const candidates: T[] = [];
    const seenInBatch = new Set<string>();
    for (const trade of trades) {
      if (!(trade.size > 0) || trade.size < admit) continue;
      if (calibrate) printFloor.push(trade.size);
      if (ids.has(trade.trade_id) || seenInBatch.has(trade.trade_id)) continue;
      seenInBatch.add(trade.trade_id);
      candidates.push(trade);
    }
    const taken = mergeInsertAll(candidates);
    if (calibrate) {
      const floor = gate();
      if (floor > coverageFloor) coverageFloor = floor;
      if (floor > 0) {
        const survivors = prints.filter((print) => print.size >= floor);
        if (survivors.length !== prints.length) {
          for (const print of prints) if (print.size < floor) ids.delete(print.trade_id);
          prints = survivors;
        }
      }
    }
    if (fromMs !== undefined && Number.isFinite(fromMs) && (from === null || fromMs < from)) from = fromMs;
    trimWindow(now());
    trimCount();
    return taken;
  }

  function boundedForWire(): { prints: T[]; floor: number } {
    const floor = Math.max(coverageFloor, gate());
    if (prints.length <= maxPrints) return { prints: prints.slice(), floor };
    const bySize = prints.slice().sort((a, b) => b.size - a.size);
    let kept = 0;
    while (kept < bySize.length) {
      let end = kept;
      while (end < bySize.length && bySize[end].size === bySize[kept].size) end += 1;
      if (end > maxPrints) break;
      kept = end;
    }
    if (kept === 0) {
      return { prints: [], floor: Math.max(floor, floorAbove(bySize[0].size)) };
    }
    const keptIds = new Set(bySize.slice(0, kept).map((print) => print.trade_id));
    return { prints: prints.filter((print) => keptIds.has(print.trade_id)), floor: Math.max(floor, bySize[kept - 1].size) };
  }

  function snapshot(): PoolSnapshot<T> {
    trimWindow(now());
    const bounded = boundedForWire();
    return Object.freeze({ prints: Object.freeze(bounded.prints), floor: bounded.floor, from: from ?? now() });
  }

  return Object.freeze({
    record,
    seed,
    snapshot,
    gate,
    get size() {
      return prints.length;
    },
    get floor() {
      return Math.max(coverageFloor, gate());
    },
  });
}
