"use strict";

const { createDxFeedStorageDb } = require("../../src/storage/dxfeed/dxfeed-storage-db");
const { seededRandom } = require("./synthetic-binance-db");

const SNAPSHOT_BEGIN = 0x04;
const SNAPSHOT_END = 0x08;
const TX_PENDING = 0x01;

const ORDER_COLUMNS = "event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, order_index, event_flags, time, action, action_time, order_id, price, size, side, scope, source, market_maker";
const TAPE_COLUMNS = "event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, price, size, time, time_nano_part, sequence, exchange_code, extended_trading_hours, aggressor_side, spread_leg, valid_tick, event_kind, provider_index, provider_trade_id, bid_price, ask_price";

function buildSyntheticDxFeedDb({
  dbPath,
  symbol = "AAPL",
  assetClass = "EQUITY",
  source = "NTV",
  startTs = 1_700_000_000_000,
  durationMs = 300_000,
  seed = 1,
  ordersPerSecond = 40,
  tapePerSecond = 8,
  sessionMs = 100_000,
  ordersPerSide = 25,
  tick = 0.01,
  midPrice = 180,
}) {
  const random = seededRandom(seed);
  const orders = new Map();
  let nextIndex = 1_000_000;
  const priceFor = (side, depth) => Number((side === "BUY" ? midPrice - tick * (depth + 1) : midPrice + tick * (depth + 1)).toFixed(4));

  const storage = createDxFeedStorageDb({ dbPath });
  const db = storage.raw;
  const insertOrder = db.prepare(`INSERT INTO dxfeed_order_book_capture (${ORDER_COLUMNS}) VALUES (?, ?, 'DXFEED', NULL, ?, ?, 0, 'READY', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ORDER', ?, NULL)`);
  const insertTape = db.prepare(`INSERT INTO dxfeed_time_and_sales (${TAPE_COLUMNS}) VALUES (?, ?, 'DXFEED', NULL, ?, ?, 0, 'READY', ?, ?, ?, 0, ?, 'XCME', 0, ?, 0, 1, 'NEW', ?, ?, ?, ?)`);
  const insertSession = db.prepare("INSERT INTO dxfeed_capture_sessions (session_id, started_at, ended_at, quality, clean_shutdown, termination_reason) VALUES (?, ?, ?, 'HEALTHY', 1, 'planned token rotation window reached')");
  const counts = { orderRows: 0, tapeRows: 0, snapshots: 0, sessions: 0 };

  const writeOrder = (eventTime, index, flags, action, side, price, size) => {
    insertOrder.run(eventTime, eventTime + 1, assetClass, symbol, index, flags, eventTime, action, eventTime, Number(index), price, size, side, source);
    counts.orderRows += 1;
  };

  const writeSnapshot = (eventTime) => {
    orders.clear();
    const rows = [];
    for (let depth = 0; depth < ordersPerSide; depth += 1) {
      for (const side of ["BUY", "SELL"]) {
        nextIndex += 1;
        const entry = { index: String(nextIndex), side, price: priceFor(side, depth), size: 1 + Math.floor(random() * 200) };
        orders.set(entry.index, entry);
        rows.push(entry);
      }
    }
    rows.forEach((entry, position) => {
      const first = position === 0;
      const last = position === rows.length - 1;
      const flags = (first ? SNAPSHOT_BEGIN : 0) | (last ? SNAPSHOT_END : TX_PENDING);
      writeOrder(eventTime, entry.index, flags, "NEW", entry.side, entry.price, entry.size);
    });
    counts.snapshots += 1;
  };

  const writeSessionStart = (startedAt, endedAt) => {
    insertSession.run(`synthetic-session-${counts.sessions}`, startedAt, endedAt);
    counts.sessions += 1;
  };

  const mutate = (eventTime) => {
    const all = [...orders.values()];
    const roll = random();
    if (roll < 0.3 && all.length > ordersPerSide) {
      const victim = all[Math.floor(random() * all.length)];
      orders.delete(victim.index);
      writeOrder(eventTime, victim.index, 0, "DELETE", victim.side, victim.price, 0);
    } else if (roll < 0.65 && all.length > 0) {
      const target = all[Math.floor(random() * all.length)];
      target.size = 1 + Math.floor(random() * 250);
      writeOrder(eventTime, target.index, 0, "REPLACE", target.side, target.price, target.size);
    } else {
      const side = random() < 0.5 ? "BUY" : "SELL";
      nextIndex += 1;
      const entry = { index: String(nextIndex), side, price: priceFor(side, Math.floor(random() * random() * ordersPerSide * 1.2)), size: 1 + Math.floor(random() * 200) };
      orders.set(entry.index, entry);
      writeOrder(eventTime, entry.index, 0, "NEW", entry.side, entry.price, entry.size);
    }
  };

  const orderStepMs = 1_000 / ordersPerSecond;
  const tapeStepMs = tapePerSecond === 0 ? Infinity : 1_000 / tapePerSecond;
  let nextTapeAt = startTs + tapeStepMs / 2;
  let nextSessionAt = startTs;
  let sequence = 0;

  db.exec("BEGIN");
  try {
    for (let step = 0; startTs + step * orderStepMs <= startTs + durationMs; step += 1) {
      const eventTime = Math.round(startTs + step * orderStepMs);
      while (nextTapeAt <= eventTime) {
        sequence += 1;
        const buy = random() < 0.5;
        const price = Number((midPrice + (buy ? tick : -tick)).toFixed(4));
        const size = 1 + Math.floor(-Math.log(1 - random()) * 60);
        const tapeTime = Math.round(nextTapeAt);
        insertTape.run(tapeTime, tapeTime + 1, assetClass, symbol, price, size, tapeTime, sequence, buy ? "BUY" : "SELL", sequence, sequence, Number((midPrice - tick).toFixed(4)), Number((midPrice + tick).toFixed(4)));
        counts.tapeRows += 1;
        nextTapeAt += tapeStepMs;
      }
      if (nextSessionAt <= eventTime) {
        writeSessionStart(nextSessionAt, nextSessionAt + sessionMs);
        writeSnapshot(eventTime);
        nextSessionAt += sessionMs;
      } else {
        mutate(eventTime);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  storage.close();
  return Object.freeze({
    dbPath, symbol, assetClass, source, startTs, endTs: startTs + durationMs, sessionMs, counts: Object.freeze(counts),
  });
}

module.exports = { buildSyntheticDxFeedDb };
