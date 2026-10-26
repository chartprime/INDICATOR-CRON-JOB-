"use strict";

// Replay source: turns the raw rows Terminal 0 already stores
// (`l2_depth_snapshots`, `l2_depth_events`, `trades`) back into the exact
// sequence of order-book states and trades the live server would have seen,
// in the order it would have seen them.
//
// It does not rebuild the book itself. It feeds the stored REST snapshot and
// the stored diff events through the same `binance-book-assembler` the live
// path uses, so a replayed book is bit-for-bit what the live book was —
// including every UNAVAILABLE reason (SEQUENCE_GAP, CROSSED_BOOK, ...).
// When the assembler loses the book, the source re-anchors on the next stored
// snapshot and keeps going, so one replay can span collector restarts.
//
// Everything downstream (level ledger, scorers) consumes the frames this
// yields and never touches SQLite, so it can be driven identically by a
// live feed later.

const Database = require("better-sqlite3");
const { createBinanceBookAssembler } = require("../../providers/binance/binance-book-assembler");
const { MARKET_KINDS, isAllowedSymbol } = require("../../providers/binance/binance-config");
const { BOOK_MODES, windowForMid } = require("./replay-truncate");

const DEFAULT_TIMEOUT_MS = 5_000;
const ANCHOR_SLACK_MS = 60_000;
const DEPTH_EVENTS_SQL = `
    SELECT id, ts, first_update_id, last_update_id, previous_update_id, bids, asks
    FROM l2_depth_events
    WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts <= ? AND last_update_id > ?
    ORDER BY id ASC
  `;

function assertSafeTs(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`replay-source: ${field} must be a non-negative safe integer`);
  }
}

function parseTuples(json, field) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`replay-source: ${field} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`replay-source: ${field} must decode to an array`);
  }
  return parsed;
}

function snapshotBodyFromRow(row) {
  return {
    lastUpdateId: row.last_update_id,
    bids: parseTuples(row.bids, "l2_depth_snapshots.bids"),
    asks: parseTuples(row.asks, "l2_depth_snapshots.asks"),
  };
}

function deltaEnvelopeFromRow(row) {
  return {
    payload: {
      firstUpdateId: row.first_update_id,
      lastUpdateId: row.last_update_id,
      previousUpdateId: row.previous_update_id,
      bids: parseTuples(row.bids, "l2_depth_events.bids"),
      asks: parseTuples(row.asks, "l2_depth_events.asks"),
    },
  };
}

function tradeFrameFromRow(row) {
  return Object.freeze({
    kind: "trade",
    ts: row.ts,
    price: row.price,
    size: row.size,
    side: row.side,
    tradeId: row.trade_id,
  });
}

/**
 * @param {object} options
 * @param {string} [options.dbPath]        Path to the collector's SQLite file (opened read-only).
 * @param {import("better-sqlite3").Database} [options.db]  An already-open database (tests).
 * @param {string} options.symbol          Provider symbol, e.g. "BTCUSDT".
 * @param {"SPOT"|"PERPETUAL"} options.marketKind
 * @param {number} options.fromTs          Replay window start, ms epoch (inclusive).
 * @param {number} options.toTs            Replay window end, ms epoch (inclusive).
 * @param {boolean} [options.includeBuffering=false]
 *        Emit `book` frames while the assembler is still BUFFERING/UNAVAILABLE.
 *        Off by default: downstream only wants coherent books.
 */
function createReplaySource({
  dbPath,
  db,
  symbol,
  marketKind,
  fromTs,
  toTs,
  includeBuffering = false,
  bookMode = "full",
  replayGeometry = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!isAllowedSymbol(symbol)) {
    throw new Error(`replay-source: unsupported symbol "${symbol}"`);
  }
  if (!BOOK_MODES.includes(bookMode)) {
    throw new Error(`replay-source: bookMode must be one of ${BOOK_MODES.join(", ")}`);
  }
  if (marketKind !== MARKET_KINDS.SPOT && marketKind !== MARKET_KINDS.PERPETUAL) {
    throw new Error("replay-source: marketKind must be SPOT or PERPETUAL");
  }
  assertSafeTs(fromTs, "fromTs");
  assertSafeTs(toTs, "toTs");
  if (toTs < fromTs) {
    throw new Error("replay-source: toTs must not be before fromTs");
  }
  if ((db === undefined) === (dbPath === undefined)) {
    throw new Error("replay-source: pass exactly one of db or dbPath");
  }

  const ownsDb = db === undefined;
  const database = ownsDb
    ? new Database(dbPath, { readonly: true, fileMustExist: true, timeout: timeoutMs })
    : db;

  // Anchor: the newest REST snapshot captured at or before the window start.
  // If the collector only started inside the window, fall back to the first
  // snapshot after it — the replay then begins a little late rather than
  // never.
  const selectAnchorBefore = database.prepare(`
    SELECT id, captured_at, last_update_id, bids, asks
    FROM l2_depth_snapshots
    WHERE symbol = ? AND market_kind = ? AND captured_at <= ?
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `);
  const selectAnchorAfter = database.prepare(`
    SELECT id, captured_at, last_update_id, bids, asks
    FROM l2_depth_snapshots
    WHERE symbol = ? AND market_kind = ? AND captured_at > ? AND captured_at <= ?
    ORDER BY captured_at ASC, id ASC
    LIMIT 1
  `);
  // Re-anchor after a gap: the first snapshot newer than the update id we
  // broke on.
  const selectNextSnapshot = database.prepare(`
    SELECT id, captured_at, last_update_id, bids, asks
    FROM l2_depth_snapshots
    WHERE symbol = ? AND market_kind = ? AND last_update_id > ? AND captured_at <= ?
    ORDER BY last_update_id ASC, id ASC
    LIMIT 1
  `);
  // Depth diffs strictly after the anchor's update id. `id` is the
  // collector's monotonic insertion key, which is the wire order.
  const selectEvents = database.prepare(DEPTH_EVENTS_SQL);
  const selectAnyEventInWindow = database.prepare(`
    SELECT 1
    FROM l2_depth_events
    WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts <= ?
    LIMIT 1
  `);
  const selectTrades = database.prepare(`
    SELECT id, ts, price, size, side, trade_id
    FROM trades
    WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC, id ASC
  `);

  const stats = {
    snapshotsUsed: 0,
    eventsRead: 0,
    tradesRead: 0,
    booksEmitted: 0,
    gaps: 0,
  };

  function findAnchor() {
    return (
      selectAnchorBefore.get(symbol, marketKind, fromTs) ??
      selectAnchorAfter.get(symbol, marketKind, fromTs, toTs) ??
      null
    );
  }

  /**
   * Yields frames in wire order:
   *   { kind: "trade", ts, price, size, side, tradeId }
   *   { kind: "book",  ts, status: "READY", book: { bids, asks, lastUpdateId }, delta: { bids, asks } }
   *   { kind: "book",  ts, status: "BUFFERING" | "UNAVAILABLE", reason?, delta }   (only if includeBuffering)
   *   { kind: "anchor", ts, lastUpdateId }                                          (a snapshot was applied)
   *
   * A trade with ts <= a depth event's ts is emitted before that event, so a
   * consumer always sees the fills that explain a size drop before it sees
   * the drop.
   */
  function* frames() {
    if (selectAnyEventInWindow.get(symbol, marketKind, fromTs, toTs) === undefined) {
      return;
    }
    let anchor = findAnchor();
    if (!anchor) {
      return;
    }

    const assembler = createBinanceBookAssembler({ marketKind });
    const tradeIterator = selectTrades.iterate(symbol, marketKind, fromTs, toTs);
    let pendingTrade = tradeIterator.next();

    function* drainTradesUpTo(ts) {
      while (!pendingTrade.done && pendingTrade.value.ts <= ts) {
        stats.tradesRead += 1;
        yield tradeFrameFromRow(pendingTrade.value);
        pendingTrade = tradeIterator.next();
      }
    }

    let events = null;
    let done = false;
    while (!done) {
      assembler.applySnapshot(snapshotBodyFromRow(anchor));
      stats.snapshotsUsed += 1;
      yield Object.freeze({ kind: "anchor", ts: anchor.captured_at, lastUpdateId: anchor.last_update_id });

      events = selectEvents.iterate(symbol, marketKind, anchor.captured_at - ANCHOR_SLACK_MS, toTs, anchor.last_update_id);
      let reanchorAfterUpdateId = null;
      let seeding = true;
      let sparseWindowKey = null;

      for (const row of events) {
        stats.eventsRead += 1;
        yield* drainTradesUpTo(row.ts);

        const envelope = deltaEnvelopeFromRow(row);
        const status = assembler.applyDeltaEventStatus(envelope);
        const delta = Object.freeze({ bids: envelope.payload.bids, asks: envelope.payload.asks });

        if (status.status === "READY") {
          if (row.ts >= fromTs) {
            stats.booksEmitted += 1;
            let windowChanged = false;
            if (bookMode === "sparse" && replayGeometry !== null) {
              const bid = Number(status.bestBid);
              const ask = Number(status.bestAsk);
              const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
              if (mid > 0) {
                const geometry = windowForMid(mid, replayGeometry);
                const nextWindowKey = `${geometry.rowClusters}:${geometry.lo}:${geometry.hi}`;
                windowChanged = sparseWindowKey !== null && sparseWindowKey !== nextWindowKey;
                sparseWindowKey = nextWindowKey;
              }
            }
            // The truncator derives boundary add/remove deltas by comparing
            // bounded full books. Give it a fresh full state whenever a moving
            // price window crosses a row; raw exchange deltas alone cannot
            // describe dormant levels entering or leaving that window.
            const book = bookMode === "sparse" && !seeding && !windowChanged
              ? Object.freeze({ bestBid: status.bestBid ?? null, bestAsk: status.bestAsk ?? null, lastUpdateId: row.last_update_id })
              : assembler.getState().book;
            seeding = false;
            yield Object.freeze({ kind: "book", ts: row.ts, status: "READY", book, delta });
          }
          continue;
        }

        if (includeBuffering && row.ts >= fromTs) {
          seeding = true;
          yield Object.freeze({
            kind: "book",
            ts: row.ts,
            status: status.status,
            ...(status.reason !== undefined ? { reason: status.reason } : {}),
            delta,
          });
        }

        if (status.status === "UNAVAILABLE") {
          // The stored stream has a hole (collector reconnect, dropped
          // message). Re-anchor on the next stored REST snapshot, if any.
          stats.gaps += 1;
          reanchorAfterUpdateId = row.last_update_id;
          break;
        }
      }

      if (reanchorAfterUpdateId === null) {
        done = true;
      } else {
        events.return?.();
        anchor = selectNextSnapshot.get(symbol, marketKind, reanchorAfterUpdateId, toTs);
        if (!anchor) {
          done = true;
        }
      }
    }

    yield* drainTradesUpTo(toTs);
    tradeIterator.return?.();
  }

  function close() {
    if (ownsDb) {
      database.close();
    }
  }

  return Object.freeze({ frames, stats, close });
}

module.exports = { createReplaySource, DEPTH_EVENTS_SQL, ANCHOR_SLACK_MS };
