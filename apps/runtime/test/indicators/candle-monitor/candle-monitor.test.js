"use strict";

const { createCandleCounter, createCandleMonitor, lengthsFor, ENTRY_KEYS, OPEN_SLACK_MS, EQUITY_MAX_MS } = require("../../../src/indicators/candle-monitor/candle-monitor");
const { candleMonitorFrame } = require("../../../src/server/candle-monitor-frames");
const { CANDLE_MS, GAP_MS, RAW_CAP } = require("../../../src/indicators/exhaustion/exhaustion-engine");
const { MINUTE, BASE, column } = require("../../fixtures/exhaustion/columns");

const FIVE = 5 * MINUTE;
const NQ = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" };
const ES = { symbol: "/ESZ26:XCME", marketKind: "FUTURE" };
const AAPL = { symbol: "AAPL", marketKind: "EQUITY" };
const START = Math.ceil(BASE / FIVE) * FIVE;

function printed(ts, { mid, buy = 0, sell = 0, prints = [] }) {
  const base = column(ts, { mid, buy, sell });
  return Object.freeze({ ...base, prints: prints.map(([side, size, price = mid]) => ({ ts, price, size, side, id: null })) });
}

describe("indicators/candle-monitor/candle-counter", () => {
  test("sums each candle's buys and sells and keeps its biggest buy and sell print, closing it on the first column of the next candle, for every length at once", () => {
    const counter = createCandleCounter({ candleLengths: [MINUTE, FIVE] });
    expect(counter.push(printed(START, { mid: 100, buy: 1.5, sell: 0.25, prints: [["buy", 0.8, 100.5], ["buy", 1.2, 101], ["sell", 0.3]] }))).toEqual([]);
    expect(counter.push(printed(START + 30_000, { mid: 101, buy: 0.5, sell: 2, prints: [["sell", 1.9, 100.5]] }))).toEqual([]);
    const closed = counter.push(printed(START + MINUTE, { mid: 102, buy: 7, prints: [["buy", 6]] }));
    expect(closed).toEqual([{ candleMs: MINUTE, candleTs: START, buy: 2, sell: 2.25, biggestBuy: { size: 1.2, price: 101 }, biggestSell: { size: 1.9, price: 100.5 } }]);
    expect(Object.isFrozen(closed[0]) && Object.isFrozen(closed[0].biggestBuy)).toBe(true);
    expect(Object.keys(closed[0])).toEqual([...ENTRY_KEYS]);
    expect(counter.lastColumnTs).toBe(START + MINUTE);
    for (let k = 2; k < 5; k += 1) expect(counter.push(printed(START + k * MINUTE, { mid: 103 })).map((entry) => entry.candleTs)).toEqual([START + (k - 1) * MINUTE]);
    const atFive = counter.push(printed(START + FIVE, { mid: 103 }));
    expect(atFive).toEqual([
      { candleMs: MINUTE, candleTs: START + 4 * MINUTE, buy: 0, sell: 0, biggestBuy: null, biggestSell: null },
      { candleMs: FIVE, candleTs: START, buy: 9, sell: 2.25, biggestBuy: { size: 6, price: 102 }, biggestSell: { size: 1.9, price: 100.5 } },
    ]);
    expect(() => candleMonitorFrame({ provider: "DXFEED", symbol: NQ.symbol, assetClass: "FUTURE" }, { ts: START + FIVE, entries: atFive })).not.toThrow();
  });

  test("a late or repeated column and a column with an empty side are ignored; sums and print sizes round to three decimals and a print that rounds to nothing is no print; a print without a size or price is skipped; sums are capped at the raw ceiling", () => {
    const counter = createCandleCounter({ candleLengths: [MINUTE] });
    counter.push(printed(START, { mid: 100, buy: 0.0004, prints: [["buy", 0.0004], ["sell", 0, 100], ["sell", 1, 0]] }));
    expect(counter.push(printed(START, { mid: 100, buy: 5 }))).toEqual([]);
    expect(counter.push(printed(START - 1000, { mid: 100, buy: 5 }))).toEqual([]);
    const empty = printed(START + 10_000, { mid: 100, buy: 5, prints: [["buy", 9]] });
    expect(counter.push({ ...empty, ask: new Float64Array(empty.ask.length) })).toEqual([]);
    const closed = counter.push(printed(START + MINUTE, { mid: 100, buy: RAW_CAP, prints: [["buy", RAW_CAP * 2, 100]] }));
    expect(closed).toEqual([{ candleMs: MINUTE, candleTs: START, buy: 0, sell: 0, biggestBuy: null, biggestSell: null }]);
    expect(() => candleMonitorFrame({ provider: "DXFEED", symbol: NQ.symbol, assetClass: "FUTURE" }, { ts: START + MINUTE, entries: closed })).not.toThrow();
    counter.push(printed(START + MINUTE + 30_000, { mid: 100, buy: RAW_CAP }));
    const capped = counter.push(printed(START + 2 * MINUTE, { mid: 100 }));
    expect(capped).toEqual([{ candleMs: MINUTE, candleTs: START + MINUTE, buy: RAW_CAP, sell: 0, biggestBuy: { size: RAW_CAP, price: 100 }, biggestSell: null }]);
    expect(() => candleMonitorFrame({ provider: "DXFEED", symbol: NQ.symbol, assetClass: "FUTURE" }, { ts: START + 2 * MINUTE, entries: capped })).not.toThrow();
  });

  test("the first candle a counter sees is counted only when its first column sits at the candle's open; a candle joined part-way is dropped at its close, the next one counts", () => {
    const counter = createCandleCounter({ candleLengths: [MINUTE, FIVE] });
    counter.push(printed(START + OPEN_SLACK_MS + 1, { mid: 100, buy: 9 }));
    expect(counter.push(printed(START + MINUTE, { mid: 100, buy: 1 }))).toEqual([]);
    expect(counter.push(printed(START + 2 * MINUTE, { mid: 100 }))).toEqual([{ candleMs: MINUTE, candleTs: START + MINUTE, buy: 1, sell: 0, biggestBuy: null, biggestSell: null }]);
    for (let k = 3; k < 5; k += 1) counter.push(printed(START + k * MINUTE, { mid: 100 }));
    expect(counter.push(printed(START + FIVE, { mid: 100 })).map((entry) => entry.candleMs)).toEqual([MINUTE]);
    for (let k = 1; k < 5; k += 1) counter.push(printed(START + FIVE + k * MINUTE, { mid: 100 }));
    expect(counter.push(printed(START + 2 * FIVE, { mid: 100 })).map((entry) => [entry.candleMs, entry.candleTs])).toEqual([[MINUTE, START + FIVE + 4 * MINUTE], [FIVE, START + FIVE]]);
    const atOpen = createCandleCounter({ candleLengths: [MINUTE] });
    atOpen.push(printed(START + OPEN_SLACK_MS, { mid: 100, buy: 2 }));
    expect(atOpen.push(printed(START + MINUTE, { mid: 100 }))).toEqual([{ candleMs: MINUTE, candleTs: START, buy: 2, sell: 0, biggestBuy: null, biggestSell: null }]);
    expect(OPEN_SLACK_MS).toBe(15_000);
  });

  test("a hole in the feed wider than the gap bound voids the candles it falls in, and a candle begun after a hole counts only from its open", () => {
    const counter = createCandleCounter({ candleLengths: [MINUTE, FIVE] });
    counter.push(printed(START, { mid: 100, buy: 1 }));
    counter.push(printed(START + GAP_MS, { mid: 100, buy: 1 }));
    expect(counter.push(printed(START + 3 * MINUTE, { mid: 100, buy: 1 })).map((entry) => entry.candleMs)).toEqual([MINUTE]);
    expect(counter.push(printed(START + 3 * MINUTE + GAP_MS + 1, { mid: 100, buy: 1 }))).toEqual([]);
    expect(counter.push(printed(START + FIVE + 1000, { mid: 100, buy: 1 }))).toEqual([]);
    for (let k = 1; k < 5; k += 1) expect(counter.push(printed(START + FIVE + k * MINUTE, { mid: 100 })).map((entry) => entry.candleTs)).toEqual([START + FIVE + (k - 1) * MINUTE]);
    expect(counter.push(printed(START + 2 * FIVE, { mid: 100 })).map((entry) => [entry.candleMs, entry.candleTs])).toEqual([[MINUTE, START + FIVE + 4 * MINUTE], [FIVE, START + FIVE]]);
    const late = createCandleCounter({ candleLengths: [MINUTE] });
    late.push(printed(START, { mid: 100 }));
    late.push(printed(START + FIVE + OPEN_SLACK_MS + 1, { mid: 100, buy: 1 }));
    expect(late.push(printed(START + FIVE + MINUTE, { mid: 100 }))).toEqual([]);
    expect(late.push(printed(START + FIVE + 2 * MINUTE, { mid: 100 })).map((entry) => entry.candleTs)).toEqual([START + FIVE + MINUTE]);
    expect(GAP_MS).toBe(120_000);
  });

  test("refuses a candle length the chart has not got and a column without integer ts or typed sides", () => {
    expect(() => createCandleCounter({ candleLengths: [240_000] })).toThrow(/candleLengths/);
    expect(() => createCandleCounter({ candleLengths: [] })).toThrow(/candleLengths/);
    const counter = createCandleCounter();
    expect(() => counter.push({ ts: 1.5, bid: new Float64Array(1), ask: new Float64Array(1) })).toThrow(/integer ts/);
    expect(() => counter.push({ ts: 1, bid: [1], ask: new Float64Array(1) })).toThrow(/Float64Array/);
    expect(createCandleCounter().push(printed(START, { mid: 100 }))).toEqual([]);
  });
});

describe("indicators/candle-monitor/candle-monitor", () => {
  function harness({ columns, overrides = {} } = {}) {
    const published = [];
    const feed = { columns, geometry: { rowWidth: 1 } };
    const monitor = createCandleMonitor({
      provider: "DXFEED",
      now: () => START + 10 * MINUTE,
      log: { warn: () => {} },
      candleLengths: [MINUTE, FIVE],
      columnsAfter: (pair, afterTs, limit) => (pair.symbol === NQ.symbol ? feed.columns.filter((c) => afterTs === null || c.ts > afterTs).slice(0, limit) : []),
      geometryOf: (pair) => (pair.symbol === NQ.symbol ? feed.geometry : null),
      activePair: () => NQ,
      publish: (entries, pair, at) => published.push({ entries, pair, at }),
      ...overrides,
    });
    return { monitor, published, feed };
  }

  const columns = [
    printed(START, { mid: 100, buy: 1, sell: 2, prints: [["buy", 0.9]] }),
    printed(START + MINUTE, { mid: 101, buy: 3, prints: [["buy", 2.5, 101.5]] }),
    printed(START + 2 * MINUTE, { mid: 102, sell: 4, prints: [["sell", 1.1], ["sell", 3.3, 102.5]] }),
  ];
  const first = { candleMs: MINUTE, candleTs: START, buy: 1, sell: 2, biggestBuy: { size: 0.9, price: 100 }, biggestSell: null };
  const second = { candleMs: MINUTE, candleTs: START + MINUTE, buy: 3, sell: 0, biggestBuy: { size: 2.5, price: 101.5 }, biggestSell: null };

  test("a tick feeds each pair's new columns and publishes the chart's pair's last closed candle per length, rising, every tick", () => {
    const { monitor, published } = harness({ columns });
    monitor.tick([NQ, ES], START + 2 * MINUTE + 500);
    expect(published).toEqual([{ pair: NQ, at: START + 2 * MINUTE + 500, entries: [second] }]);
    expect(monitor.snapshot(NQ)).toEqual([second]);
    expect(monitor.snapshot(ES)).toEqual([]);
    expect(monitor.stats()).toEqual({ "FUTURE:/NQZ26:XCME": { candles: 1, lastTs: START + 2 * MINUTE, rowWidth: 1 } });
    monitor.tick([NQ, ES], START + 2 * MINUTE + 1500);
    expect(published).toHaveLength(2);
    expect(published[1].entries).toEqual([second]);
  });

  test("nothing is published before a close, for another pair, with no pair on, or without geometry", () => {
    const none = harness({ columns: columns.slice(0, 1) });
    none.monitor.tick([NQ], START + 500);
    expect(none.published).toEqual([]);
    const other = harness({ columns, overrides: { activePair: () => ES } });
    other.monitor.tick([NQ, ES], START + 2 * MINUTE + 500);
    expect(other.published).toEqual([]);
    expect(other.monitor.snapshot(NQ)).toEqual([second]);
    const idle = harness({ columns, overrides: { activePair: () => null } });
    idle.monitor.tick([NQ], START + 2 * MINUTE + 500);
    expect(idle.published).toEqual([]);
    const blind = harness({ columns, overrides: { geometryOf: () => null } });
    blind.monitor.tick([NQ], START + 2 * MINUTE + 500);
    expect(blind.published).toEqual([]);
    expect(blind.monitor.stats()).toEqual({});
  });

  test("columns are read in bounded batches from the last column seen; a new row width starts the pair's count afresh; a bad column is logged and skipped", () => {
    const warned = [];
    const { monitor, published, feed } = harness({ columns, overrides: { columnsPerTick: 2, log: { warn: (message, detail) => warned.push([message, detail]) } } });
    monitor.tick([NQ], START + 2 * MINUTE + 500);
    expect(published).toHaveLength(1);
    expect(published[0].entries).toEqual([first]);
    monitor.tick([NQ], START + 2 * MINUTE + 1500);
    expect(published).toHaveLength(2);
    expect(published[1].entries).toEqual([second]);
    feed.geometry = { rowWidth: 2 };
    feed.columns = [printed(START + 3 * MINUTE + 20_000, { mid: 50, buy: 1 }), printed(START + 4 * MINUTE, { mid: 50 })];
    monitor.tick([NQ], START + 4 * MINUTE + 500);
    expect(published).toHaveLength(2);
    feed.columns = [...feed.columns, printed(START + 5 * MINUTE, { mid: 50 })];
    monitor.tick([NQ], START + 5 * MINUTE + 500);
    expect(published).toHaveLength(3);
    expect(published[2].entries).toEqual([{ candleMs: MINUTE, candleTs: START + 4 * MINUTE, buy: 0, sell: 0, biggestBuy: null, biggestSell: null }]);
    feed.columns = [...feed.columns, { ts: START + 6 * MINUTE, bid: [1], ask: new Float64Array(1) }];
    monitor.tick([NQ], START + 6 * MINUTE + 500);
    expect(warned).toEqual([["candle monitor: FUTURE:/NQZ26:XCME rejected a column", { reason: expect.stringMatching(/Float64Array/) }]]);
    expect(published).toHaveLength(4);
  });

  test("stop() forgets every pair's candles, so a restart counts afresh and never sends a candle that spans the stop", () => {
    const { monitor, published, feed } = harness({ columns });
    monitor.tick([NQ], START + 2 * MINUTE + 500);
    expect(published).toHaveLength(1);
    monitor.stop();
    expect(monitor.stats()).toEqual({});
    expect(monitor.snapshot(NQ)).toEqual([]);
    feed.columns = [...columns, printed(START + 3 * MINUTE + 30_000, { mid: 100, buy: 5 }), printed(START + 4 * MINUTE, { mid: 100 })];
    monitor.tick([NQ], START + 4 * MINUTE + 500);
    expect(published).toHaveLength(2);
    expect(published[1].entries).toEqual([{ candleMs: MINUTE, candleTs: START + 3 * MINUTE, buy: 5, sell: 0, biggestBuy: null, biggestSell: null }]);
    expect(monitor.stats()["FUTURE:/NQZ26:XCME"].lastTs).toBe(START + 4 * MINUTE);
  });

  test("an equity counts the candle lengths up to 30 minutes only; a pair with no length left is skipped", () => {
    expect(lengthsFor(AAPL, CANDLE_MS)).toEqual(CANDLE_MS.filter((ms) => ms <= EQUITY_MAX_MS));
    expect(lengthsFor(NQ, CANDLE_MS)).toEqual(CANDLE_MS);
    expect(EQUITY_MAX_MS).toBe(1_800_000);
    const published = [];
    const monitor = createCandleMonitor({ provider: "DXFEED", candleLengths: [MINUTE, 3_600_000], columnsAfter: () => columns, geometryOf: () => ({ rowWidth: 1 }), activePair: () => AAPL, publish: (entries) => published.push(entries) });
    monitor.tick([AAPL], START + 2 * MINUTE + 500);
    expect(published).toEqual([[second]]);
    const none = createCandleMonitor({ provider: "DXFEED", candleLengths: [3_600_000], columnsAfter: () => columns, geometryOf: () => ({ rowWidth: 1 }), activePair: () => AAPL, publish: (entries) => published.push(entries) });
    none.tick([AAPL], START + 2 * MINUTE + 500);
    expect(none.stats()).toEqual({});
  });

  test("the factory refuses a bad provider, missing collaborators and a bad batch size; the default lengths are the chart's", () => {
    const ok = { provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null };
    expect(() => createCandleMonitor({ ...ok, provider: "X" })).toThrow(/provider/);
    for (const name of ["columnsAfter", "geometryOf"]) expect(() => createCandleMonitor({ ...ok, [name]: undefined })).toThrow(new RegExp(name));
    expect(() => createCandleMonitor({ ...ok, activePair: 1 })).toThrow(/activePair/);
    expect(() => createCandleMonitor({ ...ok, publish: 1 })).toThrow(/publish/);
    expect(() => createCandleMonitor({ ...ok, columnsPerTick: 0 })).toThrow(/columnsPerTick/);
    expect(() => createCandleMonitor({ ...ok, candleLengths: [1] })).not.toThrow();
    const day = Math.ceil(START / 86_400_000) * 86_400_000;
    const steps = 86_400_000 / GAP_MS;
    const stream = Array.from({ length: steps + 1 }, (_, i) => printed(day + i * GAP_MS, { mid: 100 }));
    const monitor = createCandleMonitor({ ...ok, columnsAfter: () => stream, geometryOf: () => ({ rowWidth: 1 }) });
    monitor.tick([NQ], day + 2 * 86_400_000);
    expect(monitor.snapshot(NQ).map((entry) => entry.candleMs)).toEqual([...CANDLE_MS]);
  });
});
