#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { WINDOW_MS, LEVELS_MS, foldLevels, encodeWindow, decodeWindow } = require("../../src/indicators/l2-memory/pyramid/pyramid-levels");
const { coarsenWindow, ROW_FACTORS } = require("../../src/indicators/l2-memory/pyramid/pyramid-reader");

const TARGET = path.resolve(__dirname, "../../../web/src/lib/indicators/passive-liquidity/tests/fixtures/pyramid-pages.json");
const W0 = Math.floor(1_757_340_000_000 / WINDOW_MS) * WINDOW_MS;

function base(windowTs, seed) {
  return Array.from({ length: 30 }, (_, i) => Object.freeze({
    ts: windowTs + i * 10_000,
    lo: 19_600 + ((i + seed) % 4),
    hi: 19_605 + ((i + seed) % 4),
    bid: Float64Array.from([1 + i, 2, (i * 3) % 7, 0, 4, seed]),
    ask: Float64Array.from([0, 3, 1, (i + seed) % 5, 6, 2]),
    buy: [[1, 0.5 + (i % 3)]],
    sell: i % 2 === 0 ? [[2, 1.25]] : [],
    prints: i % 5 === 0 ? [{ ts: windowTs + i * 10_000 - 400, price: 78_402.5, size: 1.5, side: "buy", id: 1000 + i }] : [],
    printsFloor: 0.75,
  }));
}

function build() {
  const windows = [0, 1, 3].map((w) => ({ ts: W0 + w * WINDOW_MS, seed: w }));
  const out = { constants: { windowMs: WINDOW_MS, levelsMs: [...LEVELS_MS], rowFactors: [...ROW_FACTORS] } };
  for (const rowFactor of [1, 2]) {
    for (const levelMs of [30_000, 300_000]) {
      const page = {
        available: true,
        geometry: { rowWidth: 4 * rowFactor, rowClusters: 8 * rowFactor },
        levelMs,
        rowFactor,
        span: { oldest: W0, newest: W0 + 3 * WINDOW_MS },
        windows: windows.map(({ ts, seed }) => ({ ts, state: "COVERED", columns: coarsenWindow(encodeWindow(foldLevels(base(ts, seed)).get(levelMs)), rowFactor) })),
        next: null,
      };
      const decodedByRuntime = page.windows.map((w) => decodeWindow(JSON.parse(JSON.stringify(w.columns))).map((c) => ({ ts: c.ts, lo: c.lo, hi: c.hi, bid: Array.from(c.bid), ask: Array.from(c.ask) })));
      out[`L${levelMs}_R${rowFactor}`] = { page: JSON.parse(JSON.stringify(page)), decodedByRuntime };
    }
  }
  return out;
}

function main() {
  const out = build();
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, JSON.stringify(out));
  console.log(`pyramid-page-fixture: wrote ${Object.keys(out).join(", ")} to ${TARGET}`);
}

if (require.main === module) main();

module.exports = { build, main, TARGET };
