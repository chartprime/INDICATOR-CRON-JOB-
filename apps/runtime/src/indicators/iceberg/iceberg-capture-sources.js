const Database = require("better-sqlite3");
const { createDxFeedOrderBookAssembler } = require("../../providers/dxfeed/dxfeed-book-assembler");
const { orderSourceFor } = require("../../providers/dxfeed/dxfeed-instrument-catalog");
const { createArrivalIndex, arrivalScanHint, SNAPSHOT_BEGIN_BIT, DEFAULT_ANCHOR_LOOKBACK_MS } = require("../l2-memory/dxfeed-replay-source");

const DEFAULT_TIMEOUT_MS = 2_000;
const ASSET_CLASSES = new Set(["FUTURE", "EQUITY"]);
const MARKET_KINDS = new Set(["SPOT", "PERPETUAL"]);

function assertTs(value, field, prefix) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${prefix}: ${field} must be a non-negative safe integer`);
}

function openConnection(prefix, { db, dbPath, timeoutMs }) {
  if ((db === undefined) === (dbPath === undefined)) throw new Error(`${prefix}: pass exactly one of db or dbPath`);
  return { conn: db ?? new Database(dbPath, { readonly: true, fileMustExist: true, timeout: timeoutMs }), owned: db === undefined };
}

function createDxFeedIcebergSource({
  db, dbPath, symbol, assetClass, source = orderSourceFor(assetClass, symbol), fromTs,
  lookbackMs = DEFAULT_ANCHOR_LOOKBACK_MS, timeoutMs = DEFAULT_TIMEOUT_MS, onEvents, onStatus = () => {}, onBookDropped = () => {},
} = {}) {
  const prefix = "iceberg-capture-sources";
  if (typeof symbol !== "string" || symbol.length === 0) throw new Error(`${prefix}: symbol required`);
  if (!ASSET_CLASSES.has(assetClass)) throw new Error(`${prefix}: assetClass must be FUTURE or EQUITY`);
  if (typeof source !== "string" || source.length === 0) throw new Error(`${prefix}: source required for this symbol and asset class`);
  assertTs(fromTs, "fromTs", prefix);
  assertTs(lookbackMs, "lookbackMs", prefix);
  if (typeof onEvents !== "function" || typeof onStatus !== "function" || typeof onBookDropped !== "function") throw new Error(`${prefix}: onEvents, onStatus and onBookDropped must be functions`);
  const { conn, owned } = openConnection(prefix, { db, dbPath, timeoutMs });
  const scan = arrivalScanHint(conn);
  const stats = { rows: 0, applied: 0, snapshots: 0, lastReceivedAt: null, unavailable: 0 };
  let clock = 0;
  let ready = false;
  const assembler = createDxFeedOrderBookAssembler({
    expectedSymbol: symbol,
    expectedAssetClass: assetClass,
    expectedSource: source,
    now: () => clock,
    onApplied: (events, meta) => {
      stats.applied += events.length;
      if (meta.snapshot) stats.snapshots += 1;
      onEvents(events, { snapshot: meta.snapshot, receivedAt: clock });
    },
  });
  let snapshotBefore;

  function startIn(arrival) {
    const windowFromId = arrival.firstIdReceivedAtOrAfter(fromTs);
    const lookbackFromId = arrival.firstIdReceivedAtOrAfter(Math.max(0, fromTs - lookbackMs));
    snapshotBefore = windowFromId === null ? undefined : conn.prepare(
      `SELECT id FROM dxfeed_order_book_capture ${scan} WHERE id >= ? AND id < ? AND symbol = ? AND asset_class = ? AND source = ? AND (event_flags & ${SNAPSHOT_BEGIN_BIT}) != 0 ORDER BY id DESC LIMIT 1`,
    ).get(lookbackFromId, windowFromId, symbol, assetClass, source);
    return snapshotBefore ? snapshotBefore.id : windowFromId;
  }

  let nextId = startIn(createArrivalIndex(conn));
  const selectOrders = conn.prepare(
    `SELECT id, event_time, received_at, order_index, event_flags, action, price, size, side, scope, source FROM dxfeed_order_book_capture ${scan} WHERE id >= ? AND id < ? AND symbol = ? AND asset_class = ? AND source = ? ORDER BY id`,
  );

  function envelopeOf(row) {
    return {
      provider: "DXFEED",
      eventType: "ORDER",
      providerSymbol: symbol,
      assetClass,
      state: "READY",
      eventTime: new Date(row.event_time).toISOString(),
      payload: { index: row.order_index, eventFlags: row.event_flags, action: row.action, price: row.price, size: row.size, side: row.side, scope: row.scope, source: row.source },
    };
  }

  function advanceTo(toTs) {
    assertTs(toTs, "toTs", prefix);
    const arrival = createArrivalIndex(conn);
    if (nextId === null) nextId = startIn(arrival);
    if (nextId === null) return stats;
    const upperId = arrival.firstIdReceivedAtOrAfter(toTs);
    if (upperId === null || upperId <= nextId) return stats;
    for (const row of selectOrders.iterate(nextId, upperId, symbol, assetClass, source)) {
      clock = row.received_at;
      stats.rows += 1;
      stats.lastReceivedAt = clock;
      const hadBook = !assembler.needsSnapshot();
      const status = assembler.applyEventStatus(envelopeOf(row));
      if (hadBook && assembler.needsSnapshot()) onBookDropped(clock);
      const nowReady = status.status === "READY";
      if (nowReady !== ready) {
        if (!nowReady) stats.unavailable += 1;
        onStatus(nowReady ? "READY" : "UNAVAILABLE", clock);
        ready = nowReady;
      }
    }
    nextId = upperId;
    return stats;
  }

  function close() {
    if (owned) conn.close();
  }

  return Object.freeze({ advanceTo, close, stats, get ready() { return ready; }, get startedFromSnapshot() { return snapshotBefore !== undefined; } });
}

function levelsOf(json, side) {
  const out = [];
  for (const [price, size] of JSON.parse(json)) out.push([side, Number(price), Number(size)]);
  return out;
}

function createBinanceIcebergSource({ db, dbPath, symbol, marketKind, fromTs, timeoutMs = DEFAULT_TIMEOUT_MS, onDepth, onTrade } = {}) {
  const prefix = "iceberg-capture-sources";
  if (typeof symbol !== "string" || symbol.length === 0) throw new Error(`${prefix}: symbol required`);
  if (!MARKET_KINDS.has(marketKind)) throw new Error(`${prefix}: marketKind must be SPOT or PERPETUAL`);
  assertTs(fromTs, "fromTs", prefix);
  if (typeof onDepth !== "function" || typeof onTrade !== "function") throw new Error(`${prefix}: onDepth and onTrade must be functions`);
  const { conn, owned } = openConnection(prefix, { db, dbPath, timeoutMs });
  const selectDiffs = conn.prepare("SELECT ts, bids, asks FROM l2_depth_events WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts < ? ORDER BY ts, id");
  const selectSnapshots = conn.prepare("SELECT captured_at AS ts, bids, asks FROM l2_depth_snapshots WHERE symbol = ? AND market_kind = ? AND captured_at >= ? AND captured_at < ? ORDER BY captured_at, id");
  const selectTrades = conn.prepare("SELECT ts, price, size, side FROM trades WHERE symbol = ? AND market_kind = ? AND ts >= ? AND ts < ? ORDER BY ts, id");
  const stats = { diffs: 0, snapshots: 0, trades: 0, lastTs: null };
  let cursor = fromTs;

  function advanceTo(toTs) {
    assertTs(toTs, "toTs", prefix);
    if (toTs <= cursor) return stats;
    const streams = [
      { kind: "trade", rows: selectTrades.iterate(symbol, marketKind, cursor, toTs), head: null },
      { kind: "snapshot", rows: selectSnapshots.iterate(symbol, marketKind, cursor, toTs), head: null },
      { kind: "diff", rows: selectDiffs.iterate(symbol, marketKind, cursor, toTs), head: null },
    ];
    for (const stream of streams) stream.head = stream.rows.next();
    for (;;) {
      let pick = null;
      for (const stream of streams) {
        if (stream.head.done) continue;
        if (pick === null || stream.head.value.ts < pick.head.value.ts) pick = stream;
      }
      if (pick === null) break;
      const row = pick.head.value;
      pick.head = pick.rows.next();
      stats.lastTs = row.ts;
      if (pick.kind === "trade") {
        stats.trades += 1;
        onTrade({ price: Number(row.price), size: Number(row.size), aggressor: row.side, ts: row.ts });
        continue;
      }
      if (pick.kind === "snapshot") stats.snapshots += 1;
      else stats.diffs += 1;
      const entries = [...levelsOf(row.bids, "bid"), ...levelsOf(row.asks, "ask")];
      if (entries.length > 0) onDepth(entries, row.ts);
    }
    cursor = toTs;
    return stats;
  }

  function close() {
    if (owned) conn.close();
  }

  return Object.freeze({ advanceTo, close, stats });
}

module.exports = { createDxFeedIcebergSource, createBinanceIcebergSource };
