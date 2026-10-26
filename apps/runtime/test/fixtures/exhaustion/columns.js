"use strict";

const MINUTE = 60_000;
const BASE = 28_333_334 * MINUTE;
const WINDOW = 12;
const W = 30;
const PIVOT_INDEX = 28;
const PULLED_ASKS = Object.freeze({ 108: 0.5, 109: 0.5 });
const TOKEN_TRADE = 0.000001;

function column(ts, { mid, asks = {}, bids = {}, buy: buyAsked, sell: sellAsked, prints = [] } = {}) {
  const open = buyAsked === undefined && sellAsked === undefined;
  const buy = open ? TOKEN_TRADE : buyAsked ?? 0;
  const sell = open ? TOKEN_TRADE : sellAsked ?? 0;
  const lo = Math.floor(mid) - WINDOW;
  const hi = Math.ceil(mid) + WINDOW;
  const askFrom = Math.ceil(mid);
  const bidTo = Number.isInteger(mid) ? mid - 1 : Math.floor(mid) - 1;
  const span = hi - lo + 1;
  const bid = new Float64Array(span);
  const ask = new Float64Array(span);
  for (let row = lo; row <= hi; row += 1) {
    if (row <= bidTo) bid[row - lo] = bids[row] ?? 1;
    if (row >= askFrom) ask[row - lo] = asks[row] ?? 1;
  }
  return Object.freeze({
    ts,
    lo,
    hi,
    bid,
    ask,
    buy: buy > 0 ? [[mid - lo, buy]] : [],
    sell: sell > 0 ? [[mid - 1 - lo, sell]] : [],
    prints: prints.map((side) => ({ ts, price: mid, size: 5, side, id: null })),
    printsFloor: 5,
  });
}

function frozen(ts, mid) {
  return column(ts, { mid, buy: 0, sell: 0 });
}

function at(k) {
  return BASE + (W + k) * MINUTE;
}

function warmColumns(count = W) {
  return Array.from({ length: count }, (_, i) => column(BASE + i * MINUTE, { mid: i % 2 === 0 ? 100 : 101, buy: 1, sell: 1 }));
}

function riseColumns({ prints = [] } = {}) {
  return [103, 104, 105, 106, 107, 108].map((mid, k) => column(at(k), { mid, buy: 10, prints }));
}

function quietColumns({ asks = PULLED_ASKS, prints = [] } = {}) {
  return [column(at(6), { mid: 108, buy: 2, sell: 4 }), column(at(7), { mid: 108, buy: 1, sell: 3, asks, prints })];
}

function buyersScenario(options = {}) {
  return [...warmColumns(), ...riseColumns(options), ...quietColumns(options)];
}

function warmAtr() {
  let atr = 13 / 14;
  for (let i = 14; i <= PIVOT_INDEX; i += 1) atr = (atr * 13 + 1) / 14;
  return atr;
}

module.exports = { MINUTE, BASE, W, PIVOT_INDEX, PULLED_ASKS, TOKEN_TRADE, column, frozen, at, warmColumns, riseColumns, quietColumns, buyersScenario, warmAtr };
