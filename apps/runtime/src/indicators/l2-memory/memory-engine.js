"use strict";

const { createLevelLedger } = require("./level-ledger");
const { createSizeHistory } = require("./size-history");
const { createFlowWindow } = require("./flow-window");

const DEFAULT_CLUSTER_TICKS = 1; // 1 = per-price records; e.g. 50 with tick 0.1 = 5-dollar bands
const DEFAULT_SIZE_HISTORY_MS = 30_000;
const DEFAULT_FLOW_WINDOW_MS = 60_000;

function toEpochMs(value, field) {
  const ts = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isSafeInteger(ts) || ts < 0) {
    throw new Error(`memory-engine: ${field} must be an epoch-ms integer or ISO timestamp`);
  }
  return ts;
}

function bestPrices(book) {
  if (book.bestBid !== undefined || book.bestAsk !== undefined) {
    return { bestBid: book.bestBid ?? null, bestAsk: book.bestAsk ?? null };
  }
  return {
    bestBid: book.bids.length > 0 ? book.bids[0][0] : null,
    bestAsk: book.asks.length > 0 ? book.asks[0][0] : null,
  };
}

/**
 * @param {object} options
 * @param {number} options.tickSize          Instrument tick, e.g. 0.1 for BTCUSDT perpetual.
 * @param {number} [options.clusterTicks=1]  Ticks per cluster; 1 keeps one record per price.
 * @param {number} [options.snapshotDepth]   How many price levels per side the source's REST
 *                                           snapshot covers (Binance: 5000 spot, 1000 perpetual).
 *                                           Levels deeper than that are only ever learned from
 *                                           diffs, so they are treated as pre-existing. Default:
 *                                           the whole seeded book counts as covered.
 * @param {object} [options.ledgerOptions]   Passed through to createLevelLedger (prune settings).
 */
function createMemoryEngine({
  tickSize,
  clusterTicks = DEFAULT_CLUSTER_TICKS,
  snapshotDepth = Infinity,
  fullDepth = false,
  ledgerOptions = {},
  sizeHistoryMs = DEFAULT_SIZE_HISTORY_MS,
  flowWindowMs = DEFAULT_FLOW_WINDOW_MS,
} = {}) {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error("memory-engine: tickSize must be a positive finite number");
  }
  if (!Number.isSafeInteger(clusterTicks) || clusterTicks <= 0) {
    throw new Error("memory-engine: clusterTicks must be a positive safe integer");
  }
  if (snapshotDepth !== Infinity && (!Number.isSafeInteger(snapshotDepth) || snapshotDepth <= 0)) {
    throw new Error("memory-engine: snapshotDepth must be a positive safe integer or Infinity");
  }
  if (typeof fullDepth !== "boolean") {
    throw new Error("memory-engine: fullDepth must be a boolean");
  }

  const clusterWidth = tickSize * clusterTicks;
  // Key = cluster index. Rounding first absorbs float noise (77225.1 / 0.1
  // is 772250.9999...), so a price never lands one bucket low.
  const keyFor = (price) => Math.floor(Math.round(price / tickSize) / clusterTicks);
  const priceFor = (key) => key * clusterWidth;

  let ledger = createLevelLedger({ keyFor, ...ledgerOptions });
  let sizeHistory = createSizeHistory({ windowMs: sizeHistoryMs });
  let flow = createFlowWindow({ windowMs: flowWindowMs });
  let seeded = false; // the ledger has content
  let live = false; // the diff stream is trusted: no gap since the last full book
  let clockTs = 0;
  let segment = null;
  let pendingPrints = [];
  // The REST snapshot only covers the nearest N prices (5,000 on spot, 1,000
  // on perpetual). Levels further out first show up through a diff, which
  // would make a wall that has sat there for hours look newborn. Anything
  // outside the seeded range is therefore treated as pre-existing.
  let seededRange = { lowestBidKey: null, highestAskKey: null };
  const stats = { seeds: 0, resyncs: 0, deltas: 0, trades: 0, lateEvents: 0, unavailable: 0, outsideRangeSeeds: 0 };

  // Trades are queued upstream and can be delivered after a diff that
  // already reflects them. The ledger insists on time order, so a late event
  // is stamped with the current clock instead of its own time; it then gets
  // netted against the *next* diff. Slightly late attribution beats a crash.
  function clock(ts) {
    if (ts < clockTs) {
      stats.lateEvents += 1;
      return clockTs;
    }
    clockTs = ts;
    return ts;
  }

  function recordSizes(ts, side, tuples) {
    for (const [price] of tuples) {
      const key = keyFor(Number(price));
      sizeHistory.record({ ts, side, key, size: ledger.get(side, key)?.size ?? 0 });
    }
  }

  // The assembled book is sorted best-first, so the snapshot's coverage
  // ends at index snapshotDepth - 1; anything the diffs added beyond that
  // (already present in this book, or arriving later) is outside it.
  function coverageOf(book) {
    if (fullDepth) return { lowestBidKey: null, highestAskKey: null }; // the book vouches for every price
    const edge = (levels) => {
      if (levels.length === 0) return null;
      const index = Math.min(levels.length, snapshotDepth) - 1;
      return keyFor(Number(levels[index][0]));
    };
    return { lowestBidKey: edge(book.bids), highestAskKey: edge(book.asks) };
  }

  function observeBook(ts, book) {
    const best = bestPrices(book);
    ledger.observeQuote({ ts, ...best });
    recordSizes(ts, "bid", book.bids);
    recordSizes(ts, "ask", book.asks);
    flow.addQuote({ ts, ...best });
  }

  function requireFullBook(book, purpose) {
    if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
      throw new Error(`memory-engine: a full book is required to ${purpose}, but this frame carries only its best prices`);
    }
  }

  /** First full book: everything in it is seeded (age unknown), whether from the REST snapshot or the diffs that bridged it. */
  function seed(ts, book) {
    requireFullBook(book, "seed");
    const at = clock(ts);
    ledger.seed({ ts: at, bids: book.bids, asks: book.asks });
    observeBook(at, book);
    seededRange = coverageOf(book);
    seeded = true;
    live = true;
    stats.seeds += 1;
    noteSegment(at, "LIVE", "SEED");
  }

  /** A full book after a gap: reconcile it against the ledger we kept. */
  function resync(ts, book) {
    requireFullBook(book, "resync after a gap");
    const at = clock(ts);
    const range = coverageOf(book);
    const covers = (side, key) =>
      side === "bid"
        ? range.lowestBidKey === null || key >= range.lowestBidKey
        : range.highestAskKey === null || key <= range.highestAskKey;
    ledger.resync({ ts: at, bids: book.bids, asks: book.asks, covers });
    observeBook(at, book);
    seededRange = range;
    live = true;
    stats.resyncs += 1;
    noteSegment(at, "LIVE", "RESYNC");
  }

  function noteSegment(ts, state, cause) {
    segment = Object.freeze({ startTs: ts, state, cause });
    ledger.noteSegment({ ts, state, cause });
  }

  function isOutsideSeededRange(side, price) {
    const key = keyFor(Number(price));
    if (side === "bid") return seededRange.lowestBidKey !== null && key < seededRange.lowestBidKey;
    return seededRange.highestAskKey !== null && key > seededRange.highestAskKey;
  }

  // Split one diff into levels the ledger should account for normally and
  // levels that are new to us only because they were beyond the snapshot.
  function partitionDelta(side, tuples) {
    const known = [];
    const preexisting = [];
    for (const tuple of tuples) {
      const [price] = tuple;
      if (isOutsideSeededRange(side, price) && ledger.get(side, keyFor(Number(price))) === null) {
        preexisting.push(tuple);
      } else {
        known.push(tuple);
      }
    }
    return { known, preexisting };
  }

  function markUnavailable(cause = "UNAVAILABLE") {
    if (live) {
      stats.unavailable += 1;
      noteSegment(clockTs, "GAP", cause);
    }
    live = false;
  }

  /**
   * Feed one assembled book state (from `connection.getOrderBook` or a replay
   * `book` frame) together with the diff that produced it. Seeds on the first
   * READY book, reconciles the first READY book after any UNAVAILABLE stretch
   * against the ledger, otherwise applies the diff and the new top of book.
   */
  function applyBook({ ts, status, book, delta, coverage }) {
    const at = toEpochMs(ts, "ts");
    if (coverage && (clusterTicks !== 1 || !delta)) {
      throw new Error("memory-engine: bounded coverage requires per-price records and a delta");
    }
    if (status !== "READY") {
      markUnavailable();
      return;
    }
    if (!seeded) {
      seed(at, book);
      return;
    }
    if (!live) {
      resync(at, book);
      return;
    }
    const now = clock(at);
    if (delta) {
      if (coverage) {
        const forgotten = {
          bids: [...coverage.unobserved.bids, ...coverage.preexisting.bids.map(([price]) => price)],
          asks: [...coverage.unobserved.asks, ...coverage.preexisting.asks.map(([price]) => price)],
        };
        ledger.forgetPrices({ ts: now, ...forgotten });
        for (const [side, prices] of [["bid", forgotten.bids], ["ask", forgotten.asks]]) {
          for (const price of prices) sizeHistory.forget({ ts: now, side, key: keyFor(Number(price)) });
        }
        ledger.seed({ ts: now, ...coverage.preexisting });
        stats.outsideRangeSeeds += coverage.preexisting.bids.length + coverage.preexisting.asks.length;
        ledger.applyDelta({ ts: now, ...delta });
        recordSizes(now, "bid", coverage.preexisting.bids);
        recordSizes(now, "ask", coverage.preexisting.asks);
      } else {
        const bids = partitionDelta("bid", delta.bids);
        const asks = partitionDelta("ask", delta.asks);
        if (bids.preexisting.length > 0 || asks.preexisting.length > 0) {
          ledger.seed({ ts: now, bids: bids.preexisting, asks: asks.preexisting });
          stats.outsideRangeSeeds += bids.preexisting.length + asks.preexisting.length;
        }
        ledger.applyDelta({ ts: now, bids: bids.known, asks: asks.known });
      }
      recordSizes(now, "bid", delta.bids);
      recordSizes(now, "ask", delta.asks);
      stats.deltas += 1;
    }
    const best = bestPrices(book);
    ledger.observeQuote({ ts: now, ...best });
    flow.addQuote({ ts: now, ...best });
  }

  function applyTrade({ ts, price, size, side, tradeId }) {
    // No book yet: nothing to attribute the trade to. During a gap the ledger
    // is kept, so trades still land on their levels and are netted against
    // the reconciled book when it arrives.
    if (!seeded) return;
    const at = toEpochMs(ts, "ts");
    // Delivered after a diff with a later time: the ledger may let it reclaim
    // a shrink that diff already booked as a cancel.
    const late = at < clockTs;
    const now = clock(at);
    ledger.applyTrade({ ts: now, price, size, side, late });
    flow.addTrade({ ts: now, side, size, price });
    pendingPrints.push({ ts: at, price: Number(price), size: Number(size), side, id: tradeId === undefined || tradeId === null ? null : String(tradeId) });
    stats.trades += 1;
  }

  /** The prints applied since the last drain, oldest first, for the column that closes on them. */
  function drainPrints() {
    const drained = pendingPrints;
    pendingPrints = [];
    return drained;
  }

  function apply(frame) {
    switch (frame.kind) {
      case "book":
        applyBook(frame);
        return;
      case "trade":
        applyTrade(frame);
        return;
      case "gap":
        markUnavailable(frame.cause);
        return;
      case "anchor":
        markUnavailable("ANCHOR");
        return;
      default:
        throw new Error(`memory-engine: unknown input frame kind "${String(frame.kind)}"`);
    }
  }

  function prune(ts = clockTs) {
    ledger.prune(ts);
    sizeHistory.prune(ts);
    flow.prune(ts);
  }

  function snapshot(ts = clockTs) {
    const snap = ledger.snapshot(ts);
    return Object.freeze({ ...snap, seeded, live, clusterWidth, priceFor });
  }

  function events(fromSeq = 0) {
    return ledger.eventsSince(fromSeq);
  }

  function eventHead() {
    return ledger.eventHead();
  }

  function level(side, key) {
    return ledger.get(side, key, clockTs);
  }

  function range({ side, fromKey, toKey }) {
    return ledger.range({ side, fromKey, toKey, ts: clockTs });
  }

  function ladder({ side, depth }) {
    return ledger.ladder({ side, depth });
  }

  /** Key/size/traded/cancelled per level with the engine geometry; the cheap read for samplers. */
  function liteSnapshot() {
    return { ...ledger.liteSnapshot(), seeded, live, clusterWidth, priceFor };
  }

  /**
   * Debug helper: the N largest live levels per side, closest to the top of
   * book first on ties, with the fields a human wants to eyeball.
   * `withinKeys` restricts the search to levels at most that many clusters
   * from the best price on their side, so the action near the top of book
   * is not drowned out by distant walls.
   */
  function topLevels({ limit = 5, withinKeys = Infinity } = {}) {
    const snap = ledger.snapshot(clockTs);
    const pick = (levels, bestKey) =>
      [...levels]
        .filter((l) => l.size > 0 && Math.abs(l.key - bestKey) <= withinKeys)
        .sort((a, b) => b.size - a.size || Math.abs(a.key - bestKey) - Math.abs(b.key - bestKey))
        .slice(0, limit)
        .map((l) => ({
          price: priceFor(l.key),
          size: l.size,
          ageSec: Math.round(l.ageMs / 1000),
          seeded: l.seeded,
          cancelled: l.cancelled,
          traded: l.traded,
          hidden: l.hiddenTraded,
          refills: l.refills,
          tests: l.tests,
        }));
    return Object.freeze({
      ts: clockTs,
      bids: pick(snap.bids, snap.bestBidKey ?? 0),
      asks: pick(snap.asks, snap.bestAskKey ?? 0),
    });
  }

  return Object.freeze({
    apply,
    drainPrints,
    prune,
    snapshot,
    liteSnapshot,
    events,
    eventHead,
    level,
    range,
    ladder,
    topLevels,
    keyFor,
    priceFor,
    // Geometry, so a second engine (a replay for backfill) can be built to
    // produce the same keys as this one.
    get tickSize() {
      return tickSize;
    },
    get clusterTicks() {
      return clusterTicks;
    },
    get snapshotDepth() {
      return snapshotDepth;
    },
    get seeded() {
      return seeded;
    },
    get segment() {
      return segment;
    },
    get live() {
      return live;
    },
    get sizeHistory() {
      return sizeHistory;
    },
    get flow() {
      return flow;
    },
    get stats() {
      return Object.freeze({ ...stats, ...ledger.stats(), pendingPrints: pendingPrints.length });
    },
  });
}

module.exports = { createMemoryEngine, DEFAULT_CLUSTER_TICKS, DEFAULT_SIZE_HISTORY_MS, DEFAULT_FLOW_WINDOW_MS };
