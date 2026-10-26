"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDxFeedBarAggregator } = require("../../../src/providers/dxfeed/dxfeed-bar-aggregator");
const { createDxFeedStorageService } = require("../../../src/storage/dxfeed/dxfeed-storage-service");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { dxfeedBarFrame, storageDxFeedCandleRowToBarFrame } = require("../../../src/server/frames");
const { seededRandom } = require("../../helpers/synthetic-binance-db");
const { safeRm } = require("../../helpers/temp-files");

const MINUTE = 60_000;
const T0 = 1_700_000_040_000 - (1_700_000_040_000 % MINUTE);
const MINUTES = 30;

function cleanStream(random, symbol, assetClass) {
  const trades = [];
  let price = 180;
  let sequence = 0;
  for (let minute = 0; minute < MINUTES; minute += 1) {
    const count = 1 + Math.floor(random() * 6);
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      price = Math.max(1, Number((price + (random() - 0.5) * 0.4).toFixed(2)));
      const roll = random();
      trades.push({
        symbol, assetClass, tsExchange: T0 + minute * MINUTE + 1_000 + index * 4_000 + Math.floor(random() * 500),
        price, size: 1 + Math.floor(random() * 500), side: roll < 0.1 ? null : roll < 0.55 ? "buy" : "sell",
        timeNanoPart: Math.floor(random() * 900_000), sequence, tradeId: `t${sequence}`,
      });
    }
  }
  return trades;
}

function oracleBars(trades) {
  const byMinute = new Map();
  for (const trade of trades) {
    const open = Math.floor(trade.tsExchange / MINUTE) * MINUTE;
    if (!byMinute.has(open)) byMinute.set(open, []);
    byMinute.get(open).push(trade);
  }
  return [...byMinute.entries()].sort(([a], [b]) => a - b).map(([tsOpen, group]) => {
    const ordered = [...group].sort((a, b) => a.tsExchange - b.tsExchange || a.timeNanoPart - b.timeNanoPart || a.sequence - b.sequence);
    return {
      ts_open: tsOpen,
      open: ordered[0].price,
      high: Math.max(...ordered.map((trade) => trade.price)),
      low: Math.min(...ordered.map((trade) => trade.price)),
      close: ordered.at(-1).price,
      volume: ordered.reduce((total, trade) => total + trade.size, 0),
      buy_volume: ordered.some((trade) => trade.side === null) ? null : ordered.filter((trade) => trade.side === "buy").reduce((total, trade) => total + trade.size, 0),
      sell_volume: ordered.some((trade) => trade.side === null) ? null : ordered.filter((trade) => trade.side === "sell").reduce((total, trade) => total + trade.size, 0),
      trade_count: ordered.length,
      closed: true,
    };
  });
}

function deliver(aggregator, clean) {
  const closed = [];
  const dropped = { DUPLICATE_TRADE: 0, OUT_OF_ORDER_TRADE: 0, LATE_AFTER_FINALITY: 0 };
  const accepted = [];
  let acceptedLateOrder = 0;
  const send = (trade) => {
    const result = aggregator.ingest(trade);
    if (result.closedBar) closed.push({ bar: result.closedBar, symbol: trade.symbol, assetClass: trade.assetClass });
    if (result.dropped) dropped[result.dropReason] = (dropped[result.dropReason] ?? 0) + 1;
    else {
      accepted.push(trade);
      if (trade.tradeId.startsWith("late-order-")) acceptedLateOrder += 1;
    }
    return result;
  };
  let previousMinute = null;
  clean.forEach((trade, index) => {
    const minute = Math.floor(trade.tsExchange / MINUTE);
    send(trade);
    if (index % 7 === 3) send({ ...trade });
    if (index % 5 === 2 && index > 0) send({ ...trade, tradeId: `late-order-${index}`, tsExchange: trade.tsExchange - 500, timeNanoPart: 0 });
    if (previousMinute !== null && minute !== previousMinute && index % 3 === 0) {
      send({ ...trade, tradeId: `late-${index}`, tsExchange: (previousMinute) * MINUTE + 5_000, sequence: trade.sequence + 1_000_000 });
    }
    previousMinute = minute;
  });
  const last = clean.at(-1);
  for (const finalized of aggregator.finalizeThrough(last.tsExchange + 10 * MINUTE)) closed.push({ bar: finalized.bar, symbol: finalized.symbol, assetClass: finalized.assetClass });
  return { closed, dropped, accepted, acceptedLateOrder };
}

describe.each([
  ["AAPL", "EQUITY"],
  ["/NQZ26:XCME", "FUTURE"],
])("a closed dxFeed bar is the same bar live, in storage and on the wire (%s)", (symbol, assetClass) => {
  let dir;
  let clean;
  let live;
  let storedRows;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-bars-"));
    clean = cleanStream(seededRandom(assetClass === "EQUITY" ? 21 : 22), symbol, assetClass);
    live = deliver(createDxFeedBarAggregator(), clean);
    const dbPath = path.join(dir, "dxfeed.sqlite");
    const service = createDxFeedStorageService({ dbPath, bootstrap: true });
    for (const { bar } of live.closed) service.recordCandle(symbol, assetClass, bar);
    service.close();
    const reader = createDxFeedStorageReader({ dbPath });
    try {
      storedRows = reader.readRecentCandles(symbol, assetClass, { intervalMs: MINUTE, windowMs: (MINUTES + 5) * MINUTE, nowMs: T0 + (MINUTES + 3) * MINUTE }).rows;
    } finally {
      await reader.close();
    }
  });

  afterAll(() => safeRm(dir, { recursive: true, force: true }));

  test("duplicates and after-finality trades are dropped; out-of-order trades inside the open minute are counted (FA-2)", () => {
    expect(live.dropped.DUPLICATE_TRADE).toBeGreaterThan(3);
    expect(live.acceptedLateOrder).toBeGreaterThan(3);
    expect(live.dropped.LATE_AFTER_FINALITY).toBeGreaterThan(2);
    expect(clean.some((trade) => trade.side === null)).toBe(true);
  });

  test("the live aggregator equals an independent per-minute computation from the accepted trades", () => {
    expect(live.closed.map(({ bar }) => bar)).toEqual(oracleBars(live.accepted));
  });

  test("every closed bar is stored exactly once and read back unchanged", () => {
    expect(storedRows).toHaveLength(live.closed.length);
    expect(storedRows.map((row) => ({
      ts_open: row.ts_open, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
      buy_volume: row.buy_volume, sell_volume: row.sell_volume, trade_count: row.trade_count,
    }))).toEqual(live.closed.map(({ bar }) => ({
      ts_open: bar.ts_open, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
      buy_volume: bar.buy_volume, sell_volume: bar.sell_volume, trade_count: bar.trade_count,
    })));
  });

  test("the frame a client received when the bar closed equals the frame served from storage afterwards, key for key", () => {
    const liveFrames = live.closed.map(({ bar }) => dxfeedBarFrame({
      symbol, assetClass, tsOpen: bar.ts_open, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      volume: bar.volume, buyVolume: bar.buy_volume, sellVolume: bar.sell_volume, tradeCount: bar.trade_count, closed: true,
    }));
    const storedFrames = storedRows.map((row) => storageDxFeedCandleRowToBarFrame(row, symbol, assetClass));
    expect(storedFrames).toEqual(liveFrames);
    expect(liveFrames.filter((frame) => frame.buy_volume === undefined).length).toBeGreaterThan(0);
    expect(liveFrames.filter((frame) => frame.buy_volume !== undefined).length).toBeGreaterThan(0);
  });
});
