"use strict";

const Database = require("better-sqlite3");
const { createDxFeedOrderBookAssembler } = require("../../providers/dxfeed/dxfeed-book-assembler");
const { isStoredDxFeedTimeAndSaleTapeRow, adaptStoredDxFeedTimeAndSaleRow } = require("../../providers/dxfeed/dxfeed-trade-adapter");
const { orderSourceFor } = require("../../providers/dxfeed/dxfeed-instrument-catalog");
const { ORDER_BOOK_ARRIVAL_INDEX } = require("../../storage/dxfeed/dxfeed-storage-db");
const { DXFEED_COALESCE_MS, DXFEED_BATCHING, DXFEED_BOOK_MODES, hasChanges, changeBook, seedDelta } = require("./dxfeed-book-frames");

const SNAPSHOT_BEGIN_BIT = 0x04;
const DEFAULT_COALESCE_MS = DXFEED_COALESCE_MS;
const BATCHING = DXFEED_BATCHING.REPLAY;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_ANCHOR_LOOKBACK_MS = 6 * 3_600_000;
const DEFAULT_ARRIVAL_MARGIN_MS = 10 * 60_000;
const ASSET_CLASSES = new Set(["FUTURE", "EQUITY"]);
const BOOK_MODES = DXFEED_BOOK_MODES;

function createArrivalIndex(conn) {
  const bounds = conn.prepare("SELECT (SELECT MIN(id) FROM dxfeed_order_book_capture) AS lo, (SELECT MAX(id) FROM dxfeed_order_book_capture) AS hi").get();
  const receivedAtFrom = conn.prepare("SELECT received_at FROM dxfeed_order_book_capture WHERE id >= ? ORDER BY id LIMIT 1");
  function firstIdReceivedAtOrAfter(ts) {
    if (bounds.lo === null) return null;
    let lo = bounds.lo;
    let hi = bounds.hi + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const row = receivedAtFrom.get(mid);
      if (row !== undefined && row.received_at < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  return Object.freeze({ firstIdReceivedAtOrAfter });
}

function arrivalScanHint(conn) {
  const present = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(ORDER_BOOK_ARRIVAL_INDEX) !== undefined;
  return present ? `INDEXED BY ${ORDER_BOOK_ARRIVAL_INDEX}` : "NOT INDEXED";
}

function assertSafeTs(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`dxfeed-replay-source: ${field} must be a non-negative safe integer`);
}

function configuredOrderSource(symbol, assetClass) {
  return orderSourceFor(assetClass, symbol);
}

function createDxFeedReplaySource({ dbPath, db, symbol, assetClass, source = configuredOrderSource(symbol, assetClass), fromTs, toTs, coalesceMs = DEFAULT_COALESCE_MS, timeoutMs = DEFAULT_TIMEOUT_MS, anchorLookbackMs = DEFAULT_ANCHOR_LOOKBACK_MS, arrivalMarginMs = DEFAULT_ARRIVAL_MARGIN_MS, bookMode = "full" } = {}) {
  if (typeof symbol !== "string" || symbol.length === 0) throw new Error("dxfeed-replay-source: symbol required");
  if (!ASSET_CLASSES.has(assetClass)) throw new Error("dxfeed-replay-source: assetClass must be FUTURE or EQUITY");
  if (typeof source !== "string" || source.length === 0) throw new Error("dxfeed-replay-source: source required for this symbol and asset class");
  assertSafeTs(fromTs, "fromTs");
  assertSafeTs(toTs, "toTs");
  if (toTs < fromTs) throw new Error("dxfeed-replay-source: toTs must not be before fromTs");
  if ((db === undefined) === (dbPath === undefined)) throw new Error("dxfeed-replay-source: pass exactly one of db or dbPath");
  if (!Number.isSafeInteger(coalesceMs) || coalesceMs < 0) throw new Error("dxfeed-replay-source: coalesceMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(anchorLookbackMs) || anchorLookbackMs < 0) throw new Error("dxfeed-replay-source: anchorLookbackMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(arrivalMarginMs) || arrivalMarginMs < 0) throw new Error("dxfeed-replay-source: arrivalMarginMs must be a non-negative safe integer");
  if (!BOOK_MODES.includes(bookMode)) throw new Error(`dxfeed-replay-source: bookMode must be one of ${BOOK_MODES.join(", ")}`);

  const owned = db === undefined;
  const conn = owned ? new Database(dbPath, { readonly: true, fileMustExist: true, timeout: timeoutMs }) : db;
  const stats = { orderRows: 0, tapeRows: 0, booksEmitted: 0, anchors: 0, unavailable: 0, firstUnavailable: null, lastBookTs: null };

  const arrival = createArrivalIndex(conn);
  const scan = arrivalScanHint(conn);
  const windowFromId = arrival.firstIdReceivedAtOrAfter(fromTs);
  const windowToId = arrival.firstIdReceivedAtOrAfter(toTs + arrivalMarginMs + 1);
  const lookbackFromId = arrival.firstIdReceivedAtOrAfter(Math.max(0, fromTs - anchorLookbackMs));
  const snapshotBefore = windowFromId === null ? undefined : conn.prepare(
    `SELECT id FROM dxfeed_order_book_capture ${scan} WHERE id >= ? AND id < ? AND symbol = ? AND asset_class = ? AND source = ? AND (event_flags & 4) != 0 ORDER BY id DESC LIMIT 1`,
  ).get(lookbackFromId, windowFromId, symbol, assetClass, source);
  const snapshotAfter = snapshotBefore || windowFromId === null ? undefined : conn.prepare(
    `SELECT id FROM dxfeed_order_book_capture ${scan} WHERE id >= ? AND id < ? AND symbol = ? AND asset_class = ? AND source = ? AND (event_flags & 4) != 0 ORDER BY id ASC LIMIT 1`,
  ).get(windowFromId, windowToId, symbol, assetClass, source);
  const orderFromId = snapshotBefore ? snapshotBefore.id : snapshotAfter ? snapshotAfter.id : null;

  const selectOrders = conn.prepare(
    `SELECT id, event_time, received_at, order_index, event_flags, action, price, size, side, scope, source FROM dxfeed_order_book_capture ${scan} WHERE id >= ? AND id < ? AND symbol = ? AND asset_class = ? AND source = ? ORDER BY id`,
  );
  const selectTape = conn.prepare(
    "SELECT * FROM dxfeed_time_and_sales WHERE symbol = ? AND asset_class = ? AND event_time >= ? AND event_time <= ? ORDER BY event_time, id",
  );

  function envelopeFromRow(row) {
    return {
      provider: "DXFEED",
      eventType: "ORDER",
      providerSymbol: symbol,
      assetClass,
      state: "READY",
      eventTime: new Date(row.event_time).toISOString(),
      payload: {
        index: row.order_index,
        eventFlags: row.event_flags,
        action: row.action,
        price: row.price,
        size: row.size,
        side: row.side,
        scope: row.scope,
        source: row.source,
      },
    };
  }

  function* frames() {
    if (orderFromId === null) return;
    let clock = -Infinity;
    const assembler = createDxFeedOrderBookAssembler({ expectedSymbol: symbol, expectedAssetClass: assetClass, expectedSource: source, now: () => Math.max(0, clock) });
    const orders = selectOrders.iterate(orderFromId, windowToId, symbol, assetClass, source);
    const tape = selectTape.iterate(symbol, assetClass, fromTs, toTs);
    let pendingTape = tape.next();
    const requireValidTick = assetClass === "FUTURE";

    function* drainTapeUpTo(eventTime) {
      while (!pendingTape.done && pendingTape.value.event_time <= eventTime) {
        const row = pendingTape.value;
        pendingTape = tape.next();
        if (!isStoredDxFeedTimeAndSaleTapeRow(row, { requireValidTick })) continue;
        const trade = adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick });
        stats.tapeRows += 1;
        yield Object.freeze({ kind: "trade", ts: trade.tsExchange, price: trade.price, size: trade.size, side: trade.side, tradeId: trade.tradeId });
      }
    }

    let emitted = false;
    let lastEmitEventTime = -Infinity;
    let wasReady = false;
    let anchored = false;

    for (const row of orders) {
      if (row.event_time > clock) clock = row.event_time;
      if (clock > toTs) break;
      stats.orderRows += 1;
      yield* drainTapeUpTo(clock);
      if ((row.event_flags & SNAPSHOT_BEGIN_BIT) !== 0) {
        // A replacement snapshot is an authoritative discontinuity however the
        // book it replaces ended, whole or lost: re-anchoring on it either way
        // is what lets one replay span a collector restart, as the Binance
        // replay already does. The one that seeds the window replaces nothing.
        if (anchored) {
          stats.anchors += 1;
          if (clock >= fromTs) yield Object.freeze({ kind: "anchor", ts: clock });
        }
        anchored = true;
        emitted = false;
        // Its first complete book must not be suppressed merely because the
        // prior book happened to be emitted less than one coalescing interval ago.
        lastEmitEventTime = -Infinity;
        wasReady = false;
      }
      const status = assembler.applyEventStatus(envelopeFromRow(row));
      if (status.status !== "READY") {
        if (wasReady) {
          stats.unavailable += 1;
          if (!stats.firstUnavailable) stats.firstUnavailable = { ts: clock, status: status.status, reason: status.reason ?? null };
          // The book is gone (crossed, or a gap). Say so, or everything
          // downstream carries the last good book forward as though it were
          // still resting: the backfill goes on sampling that frozen book for
          // as long as the tape keeps it company, writing invented liquidity.
          if (clock >= fromTs) yield Object.freeze({ kind: "anchor", ts: clock });
        }
        wasReady = false;
        emitted = false;
        continue;
      }
      wasReady = true;
      if (clock < fromTs) continue;
      if (clock - lastEmitEventTime < coalesceMs) continue;
      const changes = assembler.drainLevelChanges();
      let book;
      let delta;
      if (!emitted) {
        book = assembler.getState().book;
        delta = seedDelta(book);
      } else {
        if (!hasChanges(changes)) continue;
        delta = { bids: changes.bids, asks: changes.asks };
        book = changeBook(assembler, bookMode);
      }
      emitted = true;
      lastEmitEventTime = clock;
      stats.lastBookTs = clock;
      stats.booksEmitted += 1;
      yield Object.freeze({ kind: "book", ts: clock, status: "READY", book, delta: Object.freeze(delta) });
    }
    yield* drainTapeUpTo(toTs);
  }

  function close() {
    if (owned) conn.close();
  }

  return Object.freeze({ frames, stats, close });
}

module.exports = { createDxFeedReplaySource, createArrivalIndex, arrivalScanHint, DEFAULT_COALESCE_MS, BATCHING, DEFAULT_ANCHOR_LOOKBACK_MS, DEFAULT_ARRIVAL_MARGIN_MS, SNAPSHOT_BEGIN_BIT, BOOK_MODES };
