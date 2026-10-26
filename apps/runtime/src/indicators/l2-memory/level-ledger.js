"use strict";

// Level ledger: the per-level memory every L2 indicator reads from.
//
// The live book only knows what each price level looks like *now*. The
// ledger remembers how it got there: when the level first appeared, how big
// it has been, how much of it left by cancellation versus by trading, how
// often it emptied and came back, and how close price has come to it.
//
// It is deliberately ignorant of Binance, dxFeed, SQLite, and the server.
// It is fed three kinds of events, in wire order:
//
//   applyTrade({ ts, price, size, side })      an executed trade; `side` is the
//                                              aggressor ("buy" lifted an ask,
//                                              "sell" hit a bid)
//   applyDelta({ ts, bids, asks })             the changed levels from one depth
//                                              diff, as [price, size] pairs;
//                                              size 0 means the level is gone
//   observeQuote({ ts, bestBid, bestAsk })     the top of book after a diff, so
//                                              the ledger can note how close
//                                              price came to each level
//
// Cancel-versus-fill is inferred, because market-by-price data does not say
// why a level shrank. Trades are attributed to the level they consumed, and
// when the next diff shows that level shrinking, the shrink is explained by
// the trade volume seen since the previous diff — up to the size of the
// shrink. Anything beyond that is a cancel. Trade volume that exceeds the
// visible shrink is the iceberg footprint: the level refilled inside the
// same diff window, so more traded than ever showed.
//
// Absorption versus sweep: a trade that prints at a level while that level
// is (within `sweepToleranceKeys` of) the best price on its side is the
// level holding — absorption. A trade at a level price has already moved
// past is the market running through it — a sweep. Both are attributed to
// the level, but only absorption feeds `hiddenTraded`; sweeps go to
// `sweptTraded` / `hiddenSwept` for the indicators that care about levels
// being eaten.
//
// A level that empties records how its last visible slice left:
// `endedBy` is "filled" when trades explain the final shrink, "pulled" when
// nothing traded behind it. The verdict is deliberately deferred: upstream
// delivers DEPTH synchronously but queues trades, so the diff that zeroes a
// level routinely arrives *before* the trades that consumed it. Classifying
// at that instant would label every fill a pull. Instead the level stays
// undecided (`endedBy: null`) until either enough trade volume has been
// attributed to it (-> "filled") or `endGraceMs` has passed (-> "pulled").
//
// Late trades: upstream queues trades, so one can be delivered after the diff
// that already showed the shrink it caused. By then that shrink has been
// booked as a cancel. A trade the caller flags as `late` may reclaim an
// unexplained shrink at its own price from the last `lateTradeWindowMs`,
// turning the cancel back into a visible fill; only the remainder stays
// pending as possible hidden volume. Without this, every late fill would
// count once as a cancel and once as hidden volume. The match is per price,
// not per band: a band is many ticks wide and market makers cancel inside it
// constantly, so a band-level match let a late fill at one tick swallow an
// unrelated cancel at another and leak real hidden volume away.
//
// `refills` counts every empty-then-reload cycle. `reloads` counts only the
// cycles whose emptying was called "filled": a level that is eaten and comes
// back is an iceberg reloading, a level that is pulled and reposted is a
// quote being refreshed. `lastSlice` is the size the level held when it last
// emptied, so a consumer can weigh the whole life against the final crumb.
//
// Dust floor: with `minSliceSize` set, only a slice at least that big counts
// as the level being there. A cycle starts when such a slice leaves (to
// nothing, or down to dust) and completes when such a slice is back. Dust
// appearing or vanishing in between changes nothing: no verdict, no refill,
// and the last verdict sticks. On a busy book every band near price is
// repopulated by dust each time price passes, and without the floor that
// would look like the participant coming and going.
//
// `lastHiddenTs` is the last time hidden absorption grew at the level: the
// only evidence that the hidden participant is still there and eating.
//
// Levels can be grouped into clusters by passing `keyFor`: every price maps
// to a cluster key, and one record then tracks the sum of the prices inside
// it. With the default identity `keyFor`, one record is one price.

const SIDES = Object.freeze(["bid", "ask"]);
const DEFAULT_FORGET_EMPTY_AFTER_MS = 60_000;
const DEFAULT_MAX_RECORDS_PER_SIDE = 20_000;
const DEFAULT_SWEEP_TOLERANCE_KEYS = 1; // a trade within this many bands of the best price is absorption
const DEFAULT_END_GRACE_MS = 1_500; // how long an emptied level waits for late trades before it is called "pulled"
const DEFAULT_LATE_TRADE_WINDOW_MS = 500; // a late trade may reclaim an unexplained shrink this recent
const DEFAULT_EVENT_CAPACITY = 50_000;
const DEFAULT_LADDER_DEPTH = 50;
const MAX_LADDER_DEPTH = 500;
const MAX_LADDER_WALK = 20_000;

function toFiniteNumber(value, field) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`level-ledger: ${field} must be a finite number, got ${String(value)}`);
  }
  return n;
}

function assertTs(ts) {
  if (!Number.isSafeInteger(ts) || ts < 0) {
    throw new Error("level-ledger: ts must be a non-negative safe integer");
  }
}

function assertSide(side) {
  if (side !== "bid" && side !== "ask") {
    throw new Error(`level-ledger: side must be "bid" or "ask", got ${String(side)}`);
  }
}

function sideHitByAggressor(aggressor) {
  if (aggressor === "buy") return "ask";
  if (aggressor === "sell") return "bid";
  throw new Error(`level-ledger: trade side must be "buy" or "sell", got ${String(aggressor)}`);
}

function createExtremeTrail(isBetter) {
  const seqs = [];
  const values = [];
  let seq = 0;
  function observe(value) {
    seq += 1;
    while (values.length > 0 && !isBetter(values[values.length - 1], value)) {
      values.pop();
      seqs.pop();
    }
    values.push(value);
    seqs.push(seq);
  }
  function extremeSince(fromSeq) {
    let lo = 0;
    let hi = seqs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seqs[mid] < fromSeq) lo = mid + 1;
      else hi = mid;
    }
    return lo < values.length ? values[lo] : null;
  }
  function forgetBefore(fromSeq) {
    let drop = 0;
    while (drop < seqs.length && seqs[drop] < fromSeq) drop += 1;
    if (drop > 0) {
      seqs.splice(0, drop);
      values.splice(0, drop);
    }
  }
  return Object.freeze({ observe, extremeSince, forgetBefore, get nextSeq() { return seq + 1; }, get size() { return seqs.length; } });
}

function createRecord(key, side, ts, seeded, firstQuoteSeq) {
  return {
    key,
    side,
    firstQuoteSeq,
    lifeStartTs: ts,
    lifePeak: 0,
    lifeFirstShrinkTs: null,
    firstSeenTs: ts,
    lastChangeTs: ts,
    seeded, // true when the level already existed at start: real age unknown
    prices: new Map(), // price string -> size, for cluster totals
    size: 0,
    peakSize: 0,
    added: 0, // total size that appeared (excluding the initial seed)
    cancelled: 0, // total size that left without a trade explaining it
    traded: 0, // total trade volume attributed to this level (absorption + sweep)
    tradedVisible: 0, // the part of `traded` that showed as a visible shrink
    absorbed: 0, // trade volume that printed while the level was holding at the top of book
    absorbedVisible: 0, // the part of `absorbed` that showed as a visible shrink
    swept: 0, // trade volume that printed after price had already moved past the level
    sweptVisible: 0, // the part of `swept` that showed as a visible shrink
    pendingAbsorbed: 0, // absorption trades seen since the last diff touched this level
    pendingSwept: 0, // sweep trades seen since the last diff touched this level
    hiddenWindows: 0, // diff windows in which hidden absorption grew
    refills: 0, // times the level emptied and came back
    reloads: 0, // the subset of refills whose emptying was called "filled"
    lastSlice: null, // size held when the level last emptied (the last real slice, with a dust floor)
    lastHiddenTs: null, // last time hidden absorption grew here
    unexplainedByPrice: new Map(), // price -> { size, ts }: recent shrink booked as a cancel that a late trade at that price may reclaim
    reclaimed: 0, // cancelled volume later reclaimed as a visible fill by a late trade
    emptiedAt: null,
    endedBy: null, // "filled" | "pulled" once an emptying has been classified
    endingSize: null, // size the level held when it emptied, while the verdict is pending
    endingExplained: 0, // trade volume credited to that emptying so far
    tests: 0, // times this level became the best price on its side
    isBest: false,
    sizeSamples: 0,
    sizeMean: 0,
    sizeM2: 0, // Welford running variance accumulator
  };
}

function recordSizeSample(record, size) {
  record.sizeSamples += 1;
  const delta = size - record.sizeMean;
  record.sizeMean += delta / record.sizeSamples;
  record.sizeM2 += delta * (size - record.sizeMean);
}

function sizeStdDev(record) {
  return record.sizeSamples > 1 ? Math.sqrt(record.sizeM2 / (record.sizeSamples - 1)) : 0;
}

function sumPrices(prices) {
  let total = 0;
  for (const size of prices.values()) total += size;
  return total;
}

/**
 * @param {object} [options]
 * @param {(price: number) => number} [options.keyFor]  Maps a price to a level key (identity = per price).
 * @param {number} [options.forgetEmptyAfterMs]        Drop an empty record after this long (prune).
 * @param {number} [options.maxRecordsPerSide]         Safety cap; oldest-emptied records are dropped first.
 * @param {number} [options.sweepToleranceKeys]        Trades within this many bands of the best price count as absorption.
 * @param {number} [options.lateTradeWindowMs]         A late trade may reclaim an unexplained shrink this recent.
 * @param {number} [options.minSliceSize]              Dust floor: a displayed size below this does not count as the level being there.
 */
function createLevelLedger({
  keyFor = (price) => price,
  forgetEmptyAfterMs = DEFAULT_FORGET_EMPTY_AFTER_MS,
  maxRecordsPerSide = DEFAULT_MAX_RECORDS_PER_SIDE,
  sweepToleranceKeys = DEFAULT_SWEEP_TOLERANCE_KEYS,
  endGraceMs = DEFAULT_END_GRACE_MS,
  lateTradeWindowMs = DEFAULT_LATE_TRADE_WINDOW_MS,
  minSliceSize = 0,
  eventCapacity = DEFAULT_EVENT_CAPACITY,
} = {}) {
  if (!Number.isSafeInteger(eventCapacity) || eventCapacity < 0) {
    throw new Error("level-ledger: eventCapacity must be a non-negative safe integer");
  }
  if (typeof keyFor !== "function") {
    throw new Error("level-ledger: keyFor must be a function");
  }
  if (!Number.isSafeInteger(forgetEmptyAfterMs) || forgetEmptyAfterMs < 0) {
    throw new Error("level-ledger: forgetEmptyAfterMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxRecordsPerSide) || maxRecordsPerSide <= 0) {
    throw new Error("level-ledger: maxRecordsPerSide must be a positive safe integer");
  }
  if (!Number.isFinite(sweepToleranceKeys) || sweepToleranceKeys < 0) {
    throw new Error("level-ledger: sweepToleranceKeys must be a non-negative number");
  }
  if (!Number.isSafeInteger(endGraceMs) || endGraceMs < 0) {
    throw new Error("level-ledger: endGraceMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(lateTradeWindowMs) || lateTradeWindowMs < 0) {
    throw new Error("level-ledger: lateTradeWindowMs must be a non-negative safe integer");
  }
  if (!Number.isFinite(minSliceSize) || minSliceSize < 0) {
    throw new Error("level-ledger: minSliceSize must be a non-negative number");
  }

  const records = { bid: new Map(), ask: new Map() };
  const best = { bid: null, ask: null };
  const bestRecord = { bid: null, ask: null };
  const trails = { bid: createExtremeTrail((top, value) => top < value), ask: createExtremeTrail((top, value) => top > value) };
  // Records holding trade volume not yet settled against a diff. A level that
  // absorbs and refills inside one diff window shows no net change, so Binance
  // omits it from the diff; its pending volume must still be settled (as
  // hidden) when the diff arrives.
  const pendingRecords = new Set();
  // Levels that have emptied and are still waiting for a filled/pulled verdict.
  const endingRecords = new Set();
  let lastTs = 0;
  const outbox = new Array(eventCapacity);
  let eventSeq = 0;

  function emit(event) {
    if (eventCapacity === 0) return;
    outbox[eventSeq % eventCapacity] = Object.freeze({ seq: eventSeq, ...event });
    eventSeq += 1;
  }

  function eventsSince(fromSeq = 0) {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new Error("level-ledger: fromSeq must be a non-negative safe integer");
    const oldest = Math.max(0, eventSeq - eventCapacity);
    const start = Math.max(fromSeq, oldest);
    const events = [];
    for (let seq = start; seq < eventSeq; seq += 1) events.push(outbox[seq % eventCapacity]);
    return Object.freeze({ events: Object.freeze(events), nextSeq: eventSeq, missed: Math.max(0, Math.min(oldest, eventSeq) - fromSeq) });
  }

  function eventHead() {
    return eventSeq;
  }

  function noteSegment({ ts, state, cause }) {
    emit({ type: "segment", ts, state, cause });
  }

  function distanceFromBest(side, key) {
    return best[side] === null ? null : Math.abs(key - best[side]);
  }

  /** Decide filled-vs-pulled once the evidence is in, or the grace has run out. */
  function settleEnding(record, ts, { force = false } = {}) {
    if (record.endingSize === null) return;
    const filled = record.endingExplained >= record.endingSize / 2;
    if (!filled && !force && ts - record.emptiedAt < endGraceMs) return;
    record.endedBy = filled ? "filled" : "pulled";
    emit({ type: "verdict", ts, side: record.side, key: record.key, endedBy: record.endedBy, endingSize: record.endingSize, explained: record.endingExplained });
    record.endingSize = null;
    record.endingExplained = 0;
    endingRecords.delete(record);
  }

  function keyOf(price) {
    const key = keyFor(price);
    if (!Number.isFinite(key)) {
      throw new Error(`level-ledger: keyFor(${price}) must return a finite number`);
    }
    return key;
  }

  function touch(ts) {
    assertTs(ts);
    if (ts < lastTs) {
      throw new Error(`level-ledger: events must arrive in time order (got ${ts} after ${lastTs})`);
    }
    lastTs = ts;
  }

  function applyLevel(side, priceRaw, sizeRaw, ts, { seeding = false } = {}) {
    const price = toFiniteNumber(priceRaw, "price");
    const size = toFiniteNumber(sizeRaw, "size");
    if (price <= 0) throw new Error("level-ledger: price must be positive");
    if (size < 0) throw new Error("level-ledger: size must not be negative");

    const key = keyOf(price);
    const priceKey = String(priceRaw);
    let record = records[side].get(key);

    if (!record) {
      if (size === 0) return; // deleting a level we never knew: nothing to record
      record = createRecord(key, side, ts, seeding, trails[side].nextSeq);
      records[side].set(key, record);
    }

    const previousSize = record.size;
    if (size === 0) record.prices.delete(priceKey);
    else record.prices.set(priceKey, size);
    const newSize = sumPrices(record.prices);
    const change = newSize - previousSize;

    if (!seeding) {
      let sweptExplained = 0;
      let absorbedExplained = 0;
      if (change > 0) {
        record.added += change;
      } else if (change < 0) {
        // A visible shrink is explained first by sweep trades (a swept level's
        // shrink is what the sweep did), then by absorption trades. Whatever
        // is left unexplained was cancelled.
        const shrink = -change;
        sweptExplained = Math.min(shrink, record.pendingSwept);
        absorbedExplained = Math.min(shrink - sweptExplained, record.pendingAbsorbed);
        record.sweptVisible += sweptExplained;
        record.absorbedVisible += absorbedExplained;
        record.tradedVisible += sweptExplained + absorbedExplained;
        const unexplained = shrink - sweptExplained - absorbedExplained;
        record.cancelled += unexplained;
        if (unexplained > 0) {
          // Kept briefly, at this price, so a late-delivered trade there can reclaim it (see applyTrade).
          const open = record.unexplainedByPrice.get(price);
          const stillOpen = open && ts - open.ts <= lateTradeWindowMs ? open.size : 0;
          record.unexplainedByPrice.set(price, { size: stillOpen + unexplained, ts });
        }
      }
      // Absorption volume beyond the visible shrink is hidden: the level
      // refilled underneath it inside this diff window. Count the windows in
      // which that happened, so a scorer can insist the pattern repeats.
      if (record.pendingAbsorbed - absorbedExplained > 0) {
        record.hiddenWindows += 1;
        record.lastHiddenTs = ts;
        emit({ type: "hidden", ts, side, key, volume: record.pendingAbsorbed - absorbedExplained });
      }
      const explainedByTrades = sweptExplained + absorbedExplained;
      record.pendingAbsorbed = 0;
      record.pendingSwept = 0;
      pendingRecords.delete(record);

      if (previousSize > 0 && newSize === 0) record.emptiedAt = ts;
      else if (previousSize === 0 && newSize > 0) record.emptiedAt = null;
      // "There" means a real slice, not dust (see the dust floor note above).
      const wasThere = previousSize > 0 && previousSize >= minSliceSize;
      const isThere = newSize > 0 && newSize >= minSliceSize;
      if (wasThere && change < 0 && record.lifeFirstShrinkTs === null) {
        record.lifeFirstShrinkTs = ts;
        emit({ type: "shrank", ts, side, key, from: previousSize, to: newSize });
      }
      if (wasThere && !isThere) {
        // The real slice left, to nothing or down to dust: this gets a verdict.
        emit({
          type: "emptied", ts, side, key, lastSlice: previousSize, lifeStartTs: record.lifeStartTs,
          lifePeak: Math.max(record.lifePeak, previousSize), firstShrinkTs: record.lifeFirstShrinkTs, distance: distanceFromBest(side, key),
        });
        record.lastSlice = previousSize;
        record.endingSize = previousSize - newSize;
        record.endingExplained = explainedByTrades;
        record.endedBy = null;
        endingRecords.add(record);
        settleEnding(record, ts);
      } else if (!wasThere && isThere) {
        const refill = record.lastSlice !== null;
        if (refill) {
          settleEnding(record, ts, { force: true });
          record.refills += 1;
          if (record.endedBy === "filled") record.reloads += 1;
        }
        record.lifeStartTs = ts;
        record.lifePeak = newSize;
        record.lifeFirstShrinkTs = null;
        emit({ type: "appeared", ts, side, key, size: newSize, refill });
      }
    }

    record.size = newSize;
    if (newSize > record.peakSize) record.peakSize = newSize;
    if (newSize > record.lifePeak) record.lifePeak = newSize;
    if (newSize > 0) recordSizeSample(record, newSize);
    record.lastChangeTs = ts;
  }

  /** Load the book as it stands when the ledger starts. Ages are unknown, so records are flagged `seeded`. */
  function seed({ ts, bids = [], asks = [] }) {
    touch(ts);
    for (const [price, size] of bids) applyLevel("bid", price, size, ts, { seeding: true });
    for (const [price, size] of asks) applyLevel("ask", price, size, ts, { seeding: true });
  }

  /** End observation of prices that crossed a bounded source's depth edge. */
  function forgetPrices({ ts, bids = [], asks = [] }) {
    touch(ts);
    for (const [side, prices] of [["bid", bids], ["ask", asks]]) {
      for (const priceRaw of prices) {
        const price = toFiniteNumber(priceRaw, "price");
        if (price <= 0) throw new Error("level-ledger: price must be positive");
        const key = keyOf(price);
        const record = records[side].get(key);
        if (!record) continue;
        if (record.prices.size > 1) {
          throw new Error("level-ledger: coverage loss requires one price per key");
        }
        records[side].delete(key);
        pendingRecords.delete(record);
        endingRecords.delete(record);
        if (bestRecord[side] === record) bestRecord[side] = null;
        emit({ type: "coverage_exit", ts, side, key });
      }
    }
  }

  /**
   * An executed trade. `side` is the aggressor: "buy" consumed an ask, "sell"
   * consumed a bid. Classified as absorption when the level is at (or within
   * the tolerance of) the best price on its side, otherwise as a sweep.
   * `late` marks a trade delivered after a diff with a later time (the caller
   * knows); such a trade may reclaim a recent unexplained shrink at its level.
   */
  function applyTrade({ ts, price, size, side, late = false }) {
    touch(ts);
    const hit = sideHitByAggressor(side);
    const volume = toFiniteNumber(size, "size");
    if (volume <= 0) throw new Error("level-ledger: trade size must be positive");
    const tradePrice = toFiniteNumber(price, "price");
    const key = keyOf(tradePrice);
    let record = records[hit].get(key);
    if (!record) {
      // A trade at a level we have no record of: the level was consumed and
      // refilled entirely between diffs, or appeared and vanished inside one
      // diff window. Track it anyway; it is exactly the hidden-size case.
      record = createRecord(key, hit, ts, false, trails[hit].nextSeq);
      record.emptiedAt = ts;
      records[hit].set(key, record);
    }
    const bestKey = best[hit];
    const isSweep = bestKey !== null && Math.abs(key - bestKey) > sweepToleranceKeys;
    // A late trade whose shrink was already booked as a cancel: claim it back
    // as a visible fill; only the remainder can be hidden volume.
    let claimed = 0;
    const open = late ? record.unexplainedByPrice.get(tradePrice) : undefined;
    if (open && open.size > 0 && ts - open.ts <= lateTradeWindowMs) {
      claimed = Math.min(volume, open.size);
      open.size -= claimed;
      if (open.size <= 0) record.unexplainedByPrice.delete(tradePrice);
      record.cancelled -= claimed;
      record.tradedVisible += claimed;
      record.reclaimed += claimed;
    }
    record.traded += volume;
    if (isSweep) {
      record.swept += volume;
      record.sweptVisible += claimed;
      record.pendingSwept += volume - claimed;
    } else {
      record.absorbed += volume;
      record.absorbedVisible += claimed;
      record.pendingAbsorbed += volume - claimed;
    }
    pendingRecords.add(record);
    emit({ type: "trade", ts, side: hit, aggressor: side, key, price: tradePrice, size: volume, kind: isSweep ? "swept" : "absorbed", late, reclaimed: claimed });
    // A trade arriving while this level sits empty is exactly the late evidence
    // that its last slice was filled rather than pulled.
    if (record.endingSize !== null) record.endingExplained += volume;
    record.lastChangeTs = ts;
  }

  /**
   * The changed levels from one depth diff. A size of 0 removes the price.
   * Levels with pending trade volume that this diff did not touch are settled
   * too: no visible change means everything that traded there was hidden.
   */
  function applyDelta({ ts, bids = [], asks = [] }) {
    touch(ts);
    for (const [price, size] of bids) applyLevel("bid", price, size, ts);
    for (const [price, size] of asks) applyLevel("ask", price, size, ts);
    settleWindow(ts);
  }

  /** Close one diff window: untouched pending trades were hidden; pending endings get their verdict if due. */
  function settleWindow(ts) {
    for (const record of pendingRecords) {
      if (record.pendingAbsorbed > 0) {
        record.hiddenWindows += 1;
        record.lastHiddenTs = ts;
        emit({ type: "hidden", ts, side: record.side, key: record.key, volume: record.pendingAbsorbed });
      }
      record.pendingAbsorbed = 0;
      record.pendingSwept = 0;
    }
    pendingRecords.clear();
    for (const record of [...endingRecords]) settleEnding(record, ts);
  }

  /**
   * Reconcile a fresh full book against what the ledger already holds, after
   * a stretch in which diffs were lost (a sequence gap, a snapshot refetch).
   * Nothing is forgotten: the book is applied as if it were one large diff.
   * A level that shrank is explained by the trades seen meanwhile and the
   * rest is a cancel; a level that vanished gets its filled-or-pulled
   * verdict; a level that came back counts a refill; hidden volume, refills
   * and ages all carry on.
   *
   * `covers(side, key)` says whether the book can vouch for that key at all.
   * Beyond the source's snapshot depth an absence means nothing, so levels
   * out there are left as they were, and unknown levels the book does show
   * out there are seeded as pre-existing rather than treated as newborn.
   */
  function resync({ ts, bids = [], asks = [], covers = () => true }) {
    touch(ts);
    for (const [side, levels] of [["bid", bids], ["ask", asks]]) {
      const shown = new Set();
      for (const [price] of levels) shown.add(toFiniteNumber(price, "price"));
      // Prices the ledger holds that the book no longer shows, where the book can vouch for the absence.
      for (const record of records[side].values()) {
        if (record.size === 0 || !covers(side, record.key)) continue;
        for (const priceKey of [...record.prices.keys()]) {
          if (!shown.has(Number(priceKey))) applyLevel(side, priceKey, 0, ts);
        }
      }
      for (const [price, size] of levels) {
        const key = keyOf(toFiniteNumber(price, "price"));
        const record = records[side].get(key);
        if (!record) {
          applyLevel(side, price, size, ts, { seeding: !covers(side, key) });
          continue;
        }
        if (record.prices.get(String(price)) === toFiniteNumber(size, "size")) continue; // unchanged
        applyLevel(side, price, size, ts);
      }
    }
    settleWindow(ts);
  }

  /** Top of book after a diff. Updates proximity and "tested" counts. */
  function observeQuote({ ts, bestBid, bestAsk }) {
    touch(ts);
    for (const [side, priceRaw] of [["bid", bestBid], ["ask", bestAsk]]) {
      if (priceRaw === null || priceRaw === undefined) {
        best[side] = null;
        continue;
      }
      const bestKey = keyOf(toFiniteNumber(priceRaw, `best${side === "bid" ? "Bid" : "Ask"}`));
      best[side] = bestKey;
      trails[side].observe(bestKey);
      const candidate = records[side].get(bestKey);
      const nowBest = candidate !== undefined && candidate.size > 0 ? candidate : null;
      const previous = bestRecord[side];
      if (previous !== null && previous !== nowBest) previous.isBest = false;
      if (nowBest !== null && !nowBest.isBest) {
        nowBest.tests += 1;
        nowBest.isBest = true;
      }
      bestRecord[side] = nowBest;
    }
  }

  function closestDistanceOf(record) {
    const extreme = trails[record.side].extremeSince(record.firstQuoteSeq);
    if (extreme === null) return null;
    return Math.max(0, record.side === "bid" ? extreme - record.key : record.key - extreme);
  }

  /** Forget records that have been empty for longer than `forgetEmptyAfterMs`, and enforce the size cap. */
  function prune(ts) {
    assertTs(ts);
    for (const record of [...endingRecords]) settleEnding(record, ts);
    for (const side of SIDES) {
      const map = records[side];
      for (const [key, record] of map) {
        if (record.size === 0 && record.emptiedAt !== null && ts - record.emptiedAt > forgetEmptyAfterMs) {
          endingRecords.delete(record);
          pendingRecords.delete(record);
          map.delete(key);
        }
      }
      if (map.size > maxRecordsPerSide) {
        const victims = [...map.values()]
          .filter((r) => r.size === 0)
          .sort((a, b) => (a.emptiedAt ?? 0) - (b.emptiedAt ?? 0));
        for (const victim of victims) {
          if (map.size <= maxRecordsPerSide) break;
          map.delete(victim.key);
        }
      }
      let oldestSeq = trails[side].nextSeq;
      for (const record of map.values()) if (record.firstQuoteSeq < oldestSeq) oldestSeq = record.firstQuoteSeq;
      trails[side].forgetBefore(oldestSeq);
    }
  }

  function view(record, ts) {
    const leftTotal = record.cancelled + record.tradedVisible;
    return Object.freeze({
      key: record.key,
      side: record.side,
      size: record.size,
      peakSize: record.peakSize,
      ageMs: ts - record.firstSeenTs,
      seeded: record.seeded,
      lastChangeTs: record.lastChangeTs,
      added: record.added,
      cancelled: record.cancelled,
      reclaimed: record.reclaimed,
      traded: record.traded,
      tradedVisible: record.tradedVisible,
      // Hidden volume is absorption only: trades at a holding level beyond its visible shrink.
      hiddenTraded: record.absorbed - record.absorbedVisible,
      absorbed: record.absorbed,
      swept: record.swept,
      hiddenSwept: record.swept - record.sweptVisible,
      hiddenWindows: record.hiddenWindows,
      cancelRatio: leftTotal > 0 ? record.cancelled / leftTotal : 0,
      refills: record.refills,
      reloads: record.reloads,
      lastSlice: record.lastSlice,
      lastHiddenTs: record.lastHiddenTs,
      emptiedAt: record.emptiedAt,
      endedBy: record.endedBy,
      tests: record.tests,
      isBest: record.isBest,
      closestDistance: closestDistanceOf(record),
      sizeStdDev: sizeStdDev(record),
      sizeMean: record.sizeMean,
    });
  }

  function get(side, key, ts = lastTs) {
    assertSide(side);
    const record = records[side].get(key);
    return record ? view(record, ts) : null;
  }

  function range({ side, fromKey, toKey, ts = lastTs }) {
    assertSide(side);
    assertTs(ts);
    if (!Number.isFinite(fromKey) || !Number.isFinite(toKey) || fromKey > toKey) {
      throw new Error("level-ledger: range needs finite fromKey <= toKey");
    }
    const map = records[side];
    const out = [];
    if (Number.isSafeInteger(fromKey) && Number.isSafeInteger(toKey) && toKey - fromKey < map.size) {
      for (let key = fromKey; key <= toKey; key += 1) {
        const record = map.get(key);
        if (record) out.push(view(record, ts));
      }
      return Object.freeze(out);
    }
    for (const record of map.values()) if (record.key >= fromKey && record.key <= toKey) out.push(view(record, ts));
    out.sort((a, b) => a.key - b.key);
    return Object.freeze(out);
  }

  function ladder({ side, depth = DEFAULT_LADDER_DEPTH }) {
    assertSide(side);
    if (!Number.isSafeInteger(depth) || depth <= 0 || depth > MAX_LADDER_DEPTH) {
      throw new Error(`level-ledger: ladder depth must be a whole number from 1 to ${MAX_LADDER_DEPTH}`);
    }
    const map = records[side];
    const better = side === "bid" ? (a, b) => b - a : (a, b) => a - b;
    const out = [];
    const take = (record) => {
      const levels = [];
      for (const [priceText, size] of record.prices) levels.push([Number(priceText), size]);
      levels.sort((a, b) => better(a[0], b[0]));
      for (const level of levels) {
        if (out.length >= depth) return;
        out.push(Object.freeze(level));
      }
    };
    const bestKey = best[side];
    if (bestKey !== null && Number.isSafeInteger(bestKey)) {
      const step = side === "bid" ? -1 : 1;
      let seen = 0;
      for (let key = bestKey, walked = 0; out.length < depth && seen < map.size && walked < MAX_LADDER_WALK; key += step, walked += 1) {
        const record = map.get(key);
        if (!record) continue;
        seen += 1;
        take(record);
      }
      if (out.length >= depth || seen >= map.size) return Object.freeze(out);
      out.length = 0;
    }
    const ordered = [...map.values()].filter((record) => record.size > 0 && (bestKey === null || better(bestKey, record.key) <= 0));
    ordered.sort((a, b) => better(a.key, b.key));
    for (const record of ordered) {
      take(record);
      if (out.length >= depth) break;
    }
    return Object.freeze(out);
  }

  function snapshot(ts = lastTs) {
    assertTs(ts);
    return Object.freeze({
      ts,
      bestBidKey: best.bid,
      bestAskKey: best.ask,
      bids: Object.freeze([...records.bid.values()].map((r) => view(r, ts))),
      asks: Object.freeze([...records.ask.values()].map((r) => view(r, ts))),
    });
  }

  /**
   * runs once a second over thousands of records, or once per column in a
   * replay.
   */
  function liteSnapshot() {
    const pick = (map) => {
      const out = new Array(map.size);
      let i = 0;
      for (const record of map.values()) {
        out[i] = { key: record.key, size: record.size, traded: record.traded, cancelled: record.cancelled, absorbed: record.absorbed };
        i += 1;
      }
      return out;
    };
    return { ts: lastTs, bestBidKey: best.bid, bestAskKey: best.ask, bids: pick(records.bid), asks: pick(records.ask) };
  }

  function stats() {
    return Object.freeze({
      bidRecords: records.bid.size,
      askRecords: records.ask.size,
      lastTs,
    });
  }

  return Object.freeze({ seed, forgetPrices, resync, applyTrade, applyDelta, observeQuote, prune, get, range, ladder, snapshot, liteSnapshot, stats, eventsSince, eventHead, noteSegment });
}

module.exports = {
  createLevelLedger,
  DEFAULT_FORGET_EMPTY_AFTER_MS,
  DEFAULT_MAX_RECORDS_PER_SIDE,
  DEFAULT_SWEEP_TOLERANCE_KEYS,
  DEFAULT_END_GRACE_MS,
  DEFAULT_LATE_TRADE_WINDOW_MS,
  DEFAULT_EVENT_CAPACITY,
  DEFAULT_LADDER_DEPTH,
  MAX_LADDER_DEPTH,
};
