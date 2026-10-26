"use strict";

const { bookFrame, gapFrame } = require("./input-frames");

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MICROSECONDS = /^(?:0|[1-9]\d{0,18})$/;

function decimal(value, field, allowZero = false) {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`historical-tardis-frames: invalid ${field}`);
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new Error(`historical-tardis-frames: invalid ${field}`);
  }
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function micros(value, field) {
  if (typeof value !== "string" || !MICROSECONDS.test(value)) throw new Error(`historical-tardis-frames: invalid ${field}`);
  return BigInt(value);
}

function normalize(row, exchange, symbol) {
  if (!row || row.exchange !== exchange || row.symbol !== symbol) {
    throw new Error("historical-tardis-frames: source identity mismatch");
  }
  if (row.is_snapshot !== "true" && row.is_snapshot !== "false") {
    throw new Error("historical-tardis-frames: invalid is_snapshot");
  }
  if (row.side !== "bid" && row.side !== "ask") throw new Error("historical-tardis-frames: invalid side");
  const eventUs = micros(row.timestamp, "timestamp");
  const receiveUs = micros(row.local_timestamp, "local_timestamp");
  const ts = Number(eventUs / 1000n);
  if (!Number.isSafeInteger(ts)) throw new Error("historical-tardis-frames: timestamp exceeds engine range");
  return { eventUs, receiveUs, ts, snapshot: row.is_snapshot === "true", side: row.side,
    price: decimal(row.price, "price"), amount: decimal(row.amount, "amount", true) };
}

function ordered(book, side) {
  const levels = [...book[side]].map(([price, size]) => [price, size]);
  levels.sort((a, b) => side === "bid" ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0]));
  return levels;
}

function createHistoricalTardisFrames({ exchange, symbol, maxGroupRows = 100_000, maxBookLevelsPerSide = 20_000 } = {}) {
  if (!["binance", "binance-futures"].includes(exchange) || !["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    throw new Error("historical-tardis-frames: unsupported exchange or symbol");
  }
  if (!Number.isSafeInteger(maxGroupRows) || maxGroupRows <= 0) {
    throw new Error("historical-tardis-frames: maxGroupRows must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxBookLevelsPerSide) || maxBookLevelsPerSide <= 0) {
    throw new Error("historical-tardis-frames: maxBookLevelsPerSide must be a positive safe integer");
  }
  let pending = null;
  let lastReceiveUs = null;
  let book = { bid: new Map(), ask: new Map() };
  let best = { bid: null, ask: null };
  let trusted = false;

  function process(group) {
    if (group.snapshot) {
      const fresh = { bid: new Map(), ask: new Map() };
      for (const row of group.rows) {
        if (row.amount === "0") continue;
        if (fresh[row.side].has(row.price)) {
          throw new Error("historical-tardis-frames: invalid snapshot level");
        }
        fresh[row.side].set(row.price, row.amount);
      }
      if (fresh.bid.size === 0 || fresh.ask.size === 0) throw new Error("historical-tardis-frames: incomplete snapshot");
      if (fresh.bid.size > maxBookLevelsPerSide || fresh.ask.size > maxBookLevelsPerSide) {
        trusted = false;
        book = { bid: new Map(), ask: new Map() };
        return { restartEngine: true, reason: "BOOK_LEVEL_LIMIT", eventUs: String(group.eventUs), receiveUs: String(group.receiveUs),
          frames: [gapFrame("BOOK_LEVEL_LIMIT", group.ts)] };
      }
      const bids = ordered(fresh, "bid");
      const asks = ordered(fresh, "ask");
      if (Number(bids[0][0]) >= Number(asks[0][0])) throw new Error("historical-tardis-frames: crossed snapshot");
      book = fresh;
      best = { bid: bids[0][0], ask: asks[0][0] };
      trusted = true;
      return { restartEngine: true, reason: "SOURCE_SNAPSHOT", eventUs: String(group.eventUs), receiveUs: String(group.receiveUs),
        frames: [gapFrame("SOURCE_SNAPSHOT", group.ts), bookFrame(group.ts, "READY", { bids, asks }, null)] };
    }
    if (!trusted) return { restartEngine: false, reason: "AWAITING_SOURCE_SNAPSHOT", eventUs: String(group.eventUs), receiveUs: String(group.receiveUs), frames: [] };
    const changes = { bid: new Map(), ask: new Map() };
    for (const row of group.rows) changes[row.side].set(row.price, row.amount);
    const next = book;
    const nextBest = { ...best };
    for (const side of ["bid", "ask"]) {
      let removedBest = false;
      for (const [price, amount] of changes[side]) {
        if (amount === "0") {
          next[side].delete(price);
          if (price === nextBest[side]) removedBest = true;
        } else {
          next[side].set(price, amount);
          if (!removedBest && (nextBest[side] === null || (side === "bid" ? Number(price) > Number(nextBest[side]) : Number(price) < Number(nextBest[side])))) {
            nextBest[side] = price;
          }
        }
      }
      if (removedBest || nextBest[side] === null) nextBest[side] = next[side].size ? ordered(next, side)[0][0] : null;
    }
    const tooManyLevels = next.bid.size > maxBookLevelsPerSide || next.ask.size > maxBookLevelsPerSide;
    if (tooManyLevels || nextBest.bid === null || nextBest.ask === null || Number(nextBest.bid) >= Number(nextBest.ask)) {
      const reason = tooManyLevels ? "BOOK_LEVEL_LIMIT" : "INVALID_BOOK";
      trusted = false;
      book = { bid: new Map(), ask: new Map() };
      best = { bid: null, ask: null };
      return { restartEngine: true, reason, eventUs: String(group.eventUs), receiveUs: String(group.receiveUs),
        frames: [gapFrame(reason, group.ts)] };
    }
    best = nextBest;
    return { restartEngine: false, reason: null, eventUs: String(group.eventUs), receiveUs: String(group.receiveUs),
      frames: [bookFrame(group.ts, "READY", { bestBid: best.bid, bestAsk: best.ask }, {
        bids: [...changes.bid], asks: [...changes.ask],
      })] };
  }

  function push(row) {
    const item = normalize(row, exchange, symbol);
    if (lastReceiveUs !== null && item.receiveUs < lastReceiveUs) {
      throw new Error("historical-tardis-frames: receive order regressed");
    }
    lastReceiveUs = item.receiveUs;
    if (!pending) {
      pending = { ...item, rows: [item] };
      return [];
    }
    if (pending.eventUs === item.eventUs && pending.receiveUs === item.receiveUs && pending.snapshot === item.snapshot) {
      if (pending.rows.length >= maxGroupRows) throw new Error("historical-tardis-frames: timestamp group exceeds bound");
      pending.rows.push(item);
      return [];
    }
    const done = process(pending);
    pending = { ...item, rows: [item] };
    return [done];
  }

  function flush() {
    if (!pending) return [];
    const done = process(pending);
    pending = null;
    return [done];
  }

  return Object.freeze({ push, flush });
}

module.exports = { createHistoricalTardisFrames };
