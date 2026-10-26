"use strict";

// Block 7 W1 (report 57, FA-2): on real captured dxFeed slices, bars built
// live from TimeAndSale prints must equal dxFeed's own native candles for
// every complete minute. dxFeed's candles count every valid NEW print,
// including prints that arrive behind a later-stamped one, so this is an
// oracle independent of our aggregator. Real slices are git-ignored; run with
// TT_TEST_REAL_FIXTURES=1 on a machine that holds them. O-2: every minute is
// also closed exactly once, so no consumer sees two different closed bars
// for one bar time.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createDxFeedBarAggregator } = require("../../../src/providers/dxfeed/dxfeed-bar-aggregator");

const inventoryPath = path.resolve(__dirname, "../../../../../benchmarks/fixtures/inventory.json");
const fixtureDir = path.resolve(__dirname, "../../../data/fixtures");
const enabled = process.env.TT_TEST_REAL_FIXTURES === "1";
const MINUTE = 60_000;

const fixtures = JSON.parse(fs.readFileSync(inventoryPath, "utf8")).fixtures.filter((fixture) => fixture.provider === "dxfeed");
const realSlice = enabled ? test : test.skip;

function liveBars(db, symbol, assetClass) {
  const aggregator = createDxFeedBarAggregator();
  const bars = new Map();
  const drops = {};
  const closedCounts = new Map();
  const rows = db.prepare(
    "SELECT id, time, time_nano_part, sequence, price, size, aggressor_side, valid_tick, event_kind, provider_index FROM dxfeed_time_and_sales WHERE symbol = ? ORDER BY id",
  ).all(symbol);
  for (const row of rows) {
    if (row.event_kind !== "NEW" || row.valid_tick !== 1) continue;
    const result = aggregator.ingest({
      symbol,
      assetClass,
      tsExchange: row.time,
      price: Number(row.price),
      size: Number(row.size),
      side: row.aggressor_side === "BUY" ? "buy" : row.aggressor_side === "SELL" ? "sell" : null,
      timeNanoPart: row.time_nano_part,
      sequence: row.sequence,
      tradeId: String(row.provider_index ?? row.id),
    });
    if (result.dropped) drops[result.dropReason] = (drops[result.dropReason] ?? 0) + 1;
    if (result.closedBar) closedCounts.set(result.closedBar.ts_open, (closedCounts.get(result.closedBar.ts_open) ?? 0) + 1);
    for (const bar of [result.closedBar, result.liveBar]) if (bar) bars.set(bar.ts_open, bar);
  }
  for (const finalized of aggregator.finalizeThrough(Number.MAX_SAFE_INTEGER)) closedCounts.set(finalized.bar.ts_open, (closedCounts.get(finalized.bar.ts_open) ?? 0) + 1);
  return { bars, drops, closedCounts };
}

describe("live dxFeed bars equal native candles on real slices", () => {
  (fixtures.length === 0 ? test.skip.each([["none", null]]) : realSlice.each(fixtures.map((fixture) => [fixture.id, fixture])))(
    "%s: every complete minute matches open, high, low, close and volume",
    (_id, fixture) => {
      const db = new Database(path.join(fixtureDir, fixture.file.name), { readonly: true, fileMustExist: true });
      try {
        const { bars, drops, closedCounts } = liveBars(db, fixture.symbol, fixture.assetClass);
        const native = db.prepare("SELECT ts_open, open, high, low, close, volume FROM dxfeed_candles WHERE symbol = ? AND ts_open + ? <= ? ORDER BY ts_open")
          .all(fixture.symbol, MINUTE, fixture.window.toTs);
        expect(native.length).toBeGreaterThan(0);
        for (const candle of native) {
          const bar = bars.get(candle.ts_open);
          expect([candle.ts_open, bar === undefined]).toEqual([candle.ts_open, false]);
          for (const key of ["open", "high", "low", "close"]) expect([candle.ts_open, key, Number(bar[key])]).toEqual([candle.ts_open, key, Number(candle[key])]);
          expect(Math.abs(Number(bar.volume) - Number(candle.volume))).toBeLessThan(1e-6);
        }
        expect(drops.OUT_OF_ORDER_TRADE ?? 0).toBe(0);
        expect([...closedCounts.values()].every((count) => count === 1)).toBe(true);
      } finally {
        db.close();
      }
    },
  );
});
