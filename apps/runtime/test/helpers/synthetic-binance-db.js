"use strict";

const { createStorageDb } = require("../../src/storage/storage-db");

const BID_SIDE = "bids";
const ASK_SIDE = "asks";
const PRICE_DECIMALS = 2;
const SIZE_DECIMALS = 6;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function levelsOf(book, side, descending) {
  return [...book[side].entries()]
    .sort((left, right) => descending ? right[0] - left[0] : left[0] - right[0])
    .map(([price, size]) => [price.toFixed(PRICE_DECIMALS), size.toFixed(SIZE_DECIMALS)]);
}

function buildSyntheticBinanceDb({
  dbPath,
  symbol = "BTCUSDT",
  marketKind = "SPOT",
  startTs = 1_700_000_000_000,
  durationMs = 300_000,
  seed = 1,
  eventsPerSecond = 10,
  tradesPerSecond = 12,
  levelsPerSide = 30,
  meanChangedLevels = 6,
  snapshotEveryMs = 120_000,
  tick = 0.5,
  midPrice = 60_000,
}) {
  if (!Number.isSafeInteger(eventsPerSecond) || eventsPerSecond <= 0 || !Number.isSafeInteger(tradesPerSecond) || tradesPerSecond < 0) {
    throw new Error("synthetic-binance-db: rates must be non-negative integers and eventsPerSecond positive");
  }
  const random = seededRandom(seed);
  const perpetual = marketKind === "PERPETUAL";
  const book = { [BID_SIDE]: new Map(), [ASK_SIDE]: new Map() };
  const priceOf = (side, depth) => side === BID_SIDE ? midPrice - tick * (depth + 1) : midPrice + tick * (depth + 1);
  for (let depth = 0; depth < levelsPerSide; depth += 1) {
    book[BID_SIDE].set(priceOf(BID_SIDE, depth), 0.05 + random() * 2);
    book[ASK_SIDE].set(priceOf(ASK_SIDE, depth), 0.05 + random() * 2);
  }

  const storage = createStorageDb({ dbPath });
  const db = storage.raw;
  const insertSnapshot = db.prepare("INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)");
  const insertEvent = db.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertTrade = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const counts = { events: 0, trades: 0, snapshots: 0 };
  let lastUpdateId = 1_000;
  let nextTradeId = 1;
  let nextSnapshotAt = startTs;

  const writeSnapshot = (capturedAt, snapshotUpdateId) => {
    insertSnapshot.run(
      capturedAt, symbol, marketKind, snapshotUpdateId,
      JSON.stringify(levelsOf(book, BID_SIDE, true)), JSON.stringify(levelsOf(book, ASK_SIDE, false)),
    );
    counts.snapshots += 1;
  };

  const changeLevels = () => {
    const changes = { [BID_SIDE]: [], [ASK_SIDE]: [] };
    const changed = 1 + Math.floor(random() * meanChangedLevels * 2);
    for (let index = 0; index < changed; index += 1) {
      const side = random() < 0.5 ? BID_SIDE : ASK_SIDE;
      const depth = Math.floor(random() * random() * levelsPerSide * 1.2);
      const price = priceOf(side, depth);
      const removal = random() < 0.25 && book[side].size > levelsPerSide / 2;
      if (removal) book[side].delete(price);
      else book[side].set(price, 0.01 + random() * 3);
      changes[side].push([price.toFixed(PRICE_DECIMALS), removal ? "0.000000" : book[side].get(price).toFixed(SIZE_DECIMALS)]);
    }
    return changes;
  };

  const eventStepMs = 1_000 / eventsPerSecond;
  const tradeStepMs = tradesPerSecond === 0 ? Infinity : 1_000 / tradesPerSecond;
  let nextTradeAt = startTs + tradeStepMs / 2;

  db.exec("BEGIN");
  try {
    for (let step = 1; startTs + step * eventStepMs <= startTs + durationMs; step += 1) {
      const ts = Math.round(startTs + step * eventStepMs);
      while (nextTradeAt <= ts) {
        const price = midPrice + (random() - 0.5) * tick * 6;
        const size = (0.001 + -Math.log(1 - random()) * 0.05) * (random() < 0.01 ? 20 : 1);
        insertTrade.run(Math.round(nextTradeAt), symbol, marketKind, price.toFixed(PRICE_DECIMALS), size.toFixed(SIZE_DECIMALS), random() < 0.5 ? "buy" : "sell", String(nextTradeId));
        nextTradeId += 1;
        counts.trades += 1;
        nextTradeAt += tradeStepMs;
      }
      const firstUpdateId = lastUpdateId + 1;
      const snapshotDue = nextSnapshotAt <= ts;
      if (snapshotDue) {
        writeSnapshot(nextSnapshotAt, firstUpdateId);
        while (nextSnapshotAt <= ts) nextSnapshotAt += snapshotEveryMs;
      }
      const changes = changeLevels();
      const spansSnapshot = snapshotDue || random() < 0.15;
      const eventLast = firstUpdateId + (spansSnapshot ? 1 + Math.floor(random() * 2) : 0);
      insertEvent.run(
        ts, ts + 1, symbol, marketKind, firstUpdateId, eventLast, perpetual ? lastUpdateId : null,
        JSON.stringify(changes[BID_SIDE]), JSON.stringify(changes[ASK_SIDE]),
      );
      lastUpdateId = eventLast;
      counts.events += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  storage.close();
  return Object.freeze({
    dbPath, symbol, marketKind, startTs, endTs: startTs + durationMs, counts: Object.freeze(counts),
  });
}

module.exports = { buildSyntheticBinanceDb, seededRandom };
