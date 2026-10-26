"use strict";

const { createPrintFloor } = require("../indicators/passive_liquidity/print-floor");
const { floorAbove } = require("../indicators/passive_liquidity/bounded-prints");

const DEFAULT_WINDOW_MS = 4 * 60 * 60 * 1000;
const DEFAULT_MAX_PRINTS = 20_000;
const DEFAULT_FLOOR_SHARE = 0.02;
const DEFAULT_FLOOR_WINDOW = 4_096;
const DEFAULT_FLOOR_MIN_SAMPLES = 200;
const DEFAULT_CALIBRATION_MS = 15 * 60 * 1000;
const DEFAULT_CHUNK_MS = 60 * 60 * 1000;
const DEFAULT_READ_LIMIT = 10_000;
const DEFAULT_MAX_PAGES_PER_SLICE = 50;

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`aggressive-pool: ${field} must be a positive safe integer`);
}

function createAggressivePool({
  windowMs = DEFAULT_WINDOW_MS,
  maxPrints = DEFAULT_MAX_PRINTS,
  floorShare = DEFAULT_FLOOR_SHARE,
  floorWindow = DEFAULT_FLOOR_WINDOW,
  floorMinSamples = DEFAULT_FLOOR_MIN_SAMPLES,
  now = () => Date.now(),
} = {}) {
  assertPositiveInteger(windowMs, "windowMs");
  assertPositiveInteger(maxPrints, "maxPrints");
  assertPositiveInteger(floorWindow, "floorWindow");
  assertPositiveInteger(floorMinSamples, "floorMinSamples");
  if (!(floorShare > 0 && floorShare < 1)) throw new Error("aggressive-pool: floorShare must be in (0, 1)");

  const printFloor = createPrintFloor({ window: floorWindow, share: floorShare, minSamples: floorMinSamples });
  let prints = [];
  const ids = new Set();
  let coverageFloor = 0;
  let from = null;

  function gate() {
    return printFloor.value();
  }

  function insert(trade) {
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

  function trimWindow(at) {
    const cutoff = at - windowMs;
    let drop = 0;
    while (drop < prints.length && prints[drop].ts_exchange < cutoff) drop += 1;
    if (drop > 0) for (const gone of prints.splice(0, drop)) ids.delete(gone.trade_id);
    if (from === null || from < cutoff) from = cutoff;
  }

  function trimCount() {
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
    const kept = [];
    for (const print of prints) {
      if (print.size < threshold) ids.delete(print.trade_id);
      else kept.push(print);
    }
    prints = kept;
    if (threshold > coverageFloor) coverageFloor = threshold;
  }

  function record(trade) {
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

  function mergeInsertAll(candidates) {
    if (candidates.length === 0) return 0;
    const ordered = candidates.length === 1 ? candidates : [...candidates].sort((a, b) => a.ts_exchange - b.ts_exchange);
    const merged = [];
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

  function seed(trades, { fromMs, calibrate = false } = {}) {
    const admit = calibrate ? 0 : Math.max(coverageFloor, gate());
    const candidates = [];
    const seenInBatch = new Set();
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
    if (Number.isFinite(fromMs) && (from === null || fromMs < from)) from = fromMs;
    trimWindow(now());
    trimCount();
    return taken;
  }

  function boundedForWire() {
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

  function snapshot() {
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

/**
 * Fill a pool from storage the way the large-trade warm-up does: the newest
 * stretch first, at no floor, to calibrate the gate; then one chunk at a
 * time back to the window's start, asking storage only for prints at or
 * above that gate. `read(fromMs, toMs, minSize, cursor)` resolves one bounded
 * page as trade frames, plus `hasMore`/`nextCursor` when the slice's rows
 * exceeded the reader's own row cap, and `available: false` when storage
 * cannot answer. Every page within a slice is read -- via `cursor` -- before
 * the slice is considered done, up to `maxPagesPerSlice`; a slice that still
 * has more after that, or that storage/cancellation cuts short, ends the
 * warm-up with `complete: false` rather than advertising coverage for prints
 * that were never actually retrieved. `onProgress` fires after the first
 * chunk and after the last, so the snapshot can go out early.
 */
async function warmAggressivePool({
  pool,
  read,
  nowMs,
  windowMs = DEFAULT_WINDOW_MS,
  calibrationMs = DEFAULT_CALIBRATION_MS,
  chunkMs = DEFAULT_CHUNK_MS,
  maxPagesPerSlice = DEFAULT_MAX_PAGES_PER_SLICE,
  shouldContinue = () => true,
  onProgress = () => {},
}) {
  if (!pool || typeof pool.seed !== "function") throw new Error("aggressive-pool: pool must be a pool");
  if (typeof read !== "function") throw new Error("aggressive-pool: read must be a function");
  assertPositiveInteger(windowMs, "windowMs");
  assertPositiveInteger(calibrationMs, "calibrationMs");
  assertPositiveInteger(chunkMs, "chunkMs");
  assertPositiveInteger(maxPagesPerSlice, "maxPagesPerSlice");
  const floorMs = Math.max(0, nowMs - windowMs);
  let chunks = 0;
  let prints = 0;
  let cursorMs = nowMs;
  while (cursorMs > floorMs) {
    const spanMs = chunks === 0 ? calibrationMs : chunkMs;
    const fromMs = Math.max(floorMs, cursorMs - spanMs);
    const minSize = chunks === 0 ? 0 : pool.floor;
    let sliceCursor = null;
    let pages = 0;
    for (;;) {
      const { frames, available = true, hasMore = false, nextCursor = null } = await read(fromMs, cursorMs, minSize, sliceCursor);
      if (!available) return { chunks, prints, complete: false };
      if (!shouldContinue()) return { chunks, prints, complete: false };
      prints += pool.seed(frames, { fromMs, calibrate: chunks === 0 });
      pages += 1;
      if (!hasMore) break;
      if (pages >= maxPagesPerSlice) return { chunks, prints, complete: false };
      sliceCursor = nextCursor;
    }
    chunks += 1;
    cursorMs = fromMs;
    if (chunks === 1 || cursorMs <= floorMs) onProgress({ chunks, prints, complete: cursorMs <= floorMs });
  }
  return { chunks, prints, complete: true };
}

module.exports = {
  createAggressivePool,
  warmAggressivePool,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_PRINTS,
  DEFAULT_FLOOR_SHARE,
  DEFAULT_CALIBRATION_MS,
  DEFAULT_CHUNK_MS,
  DEFAULT_READ_LIMIT,
  DEFAULT_MAX_PAGES_PER_SLICE,
};
