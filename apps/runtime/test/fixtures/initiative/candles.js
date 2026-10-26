"use strict";

const { MINUTE, BASE, column, frozen, at, warmColumns, riseColumns } = require("../exhaustion/columns");

const STEP = 15_000;
const HOLE = 3 * 3_600_000;

function bar(ts, { open, high, low, close, buy = 1, sell = 1, prints = [] }) {
  return [column(ts, { mid: open, buy, sell, prints }), frozen(ts + STEP, high), frozen(ts + 2 * STEP, low), frozen(ts + 3 * STEP, close)];
}

function warmSkewed(sell) {
  return Array.from({ length: 30 }, (_, i) => column(BASE + i * MINUTE, { mid: i % 2 === 0 ? 100 : 101, buy: 1, sell }));
}

function quietRise() {
  return [103, 104, 105, 106, 107, 108].map((mid, k) => column(at(k), { mid, buy: 2, prints: ["sell"] }));
}

function fallBars() {
  return [
    ...bar(at(6), { open: 108, high: 108, low: 107, close: 107, buy: 2, sell: 6, prints: ["sell"] }),
    ...bar(at(7), { open: 107, high: 107.5, low: 106, close: 107.5, buy: 1, sell: 5 }),
    ...bar(at(8), { open: 107.5, high: 107.5, low: 105, close: 105.5, buy: 3, sell: 7, prints: ["sell", "sell"] }),
  ];
}

function heavyQuietRise() {
  return [103, 104, 105, 106, 107, 108].map((mid, k) => column(at(k), { mid, buy: k === 2 ? 14 : 2, prints: ["sell"] }));
}

function fallBars4() {
  return [
    ...bar(at(6), { open: 108, high: 108, low: 107, close: 107.5, buy: 2, sell: 6 }),
    ...bar(at(7), { open: 107.5, high: 107.5, low: 106.5, close: 107, buy: 1, sell: 5 }),
    ...bar(at(8), { open: 107, high: 107, low: 106, close: 106.5, buy: 3, sell: 7 }),
    ...bar(at(9), { open: 106.5, high: 106.5, low: 105, close: 105.5, buy: 2, sell: 6 }),
  ];
}

function choppyFall() {
  return [
    ...bar(at(6), { open: 108, high: 108, low: 107, close: 107.5, buy: 2, sell: 6 }),
    column(at(7), { mid: 108, buy: 1, sell: 5 }),
    ...bar(at(8), { open: 108, high: 108, low: 105, close: 106, buy: 3, sell: 7 }),
  ];
}

function sellersFlip() {
  return [...warmColumns(), ...riseColumns({ prints: ["sell"] }), ...fallBars()];
}

function closer(k, mid = 105.5) {
  return column(at(k), { mid, buy: 1, sell: 1 });
}

function riseBack({ buy = 9, sell = 1 } = {}) {
  return [
    ...bar(at(9), { open: 105.5, high: 105.5, low: 104, close: 104.5, buy: 1, sell: 1 }),
    ...bar(at(10), { open: 104.5, high: 107.5, low: 104.5, close: 107, buy, sell, prints: ["buy"] }),
  ];
}

module.exports = { STEP, HOLE, bar, warmSkewed, quietRise, heavyQuietRise, fallBars, fallBars4, choppyFall, sellersFlip, closer, riseBack };
