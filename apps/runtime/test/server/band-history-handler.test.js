"use strict";

const { createBandHistoryHandler, parseBandHistoryRequest, DEFAULT_MAX_CONCURRENT_READS, DEFAULT_MAX_QUEUED } = require("../../src/server/band-history-handler");
const { MAX_BAND_WINDOW_MS, MAX_BAND_ROWS } = require("../../src/server/band-history");
const { MAX_BAND_HISTORY_COLUMNS, MAX_BAND_HISTORY_ROWS } = require("../../src/server/frames");

const NOW = 1_789_050_000_000;
const request = (over = {}) => ({ type: "band_history", request_id: 1, from_ts: NOW - 3_600_000, to_ts: NOW, price_lo: 80_000, price_hi: 80_040, column_ms: 10_000, ...over });
const GEOMETRY = Object.freeze({ tickSize: 0.01, clusterTicks: 100, rowClusters: 4, rowWidth: 4 });
const instrument = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const column = (ts, rows = 11) => ({ ts, bid: new Array(rows).fill(1), ask: new Array(rows).fill(0), buy: new Array(rows).fill(0), sell: new Array(rows).fill(2) });
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe("parseBandHistoryRequest", () => {
  test("accepts the seven fields with a sane window, band and column", () => {
    expect(parseBandHistoryRequest(request(), NOW)).toEqual({ requestId: 1, fromMs: NOW - 3_600_000, toMs: NOW, priceLo: 80_000, priceHi: 80_040, columnMs: 10_000 });
  });

  test("refuses extra or missing fields, bad numbers, a future or over-long window, a bad band, a bad column", () => {
    expect(parseBandHistoryRequest({ ...request(), symbol: "x" }, NOW)).toBe("unexpected fields");
    expect(parseBandHistoryRequest(request({ request_id: -1 }), NOW)).toMatch(/request_id/);
    expect(parseBandHistoryRequest(request({ from_ts: 1.5 }), NOW)).toMatch(/from_ts/);
    expect(parseBandHistoryRequest(request({ to_ts: NOW - 3_600_000 }), NOW)).toMatch(/to_ts/);
    expect(parseBandHistoryRequest(request({ to_ts: NOW + 120_000 }), NOW)).toMatch(/future/);
    expect(parseBandHistoryRequest(request({ from_ts: NOW - MAX_BAND_WINDOW_MS - 1 }), NOW)).toMatch(/two hours/);
    expect(parseBandHistoryRequest(request({ price_lo: 0 }), NOW)).toMatch(/price_lo/);
    expect(parseBandHistoryRequest(request({ price_hi: 79_000 }), NOW)).toMatch(/price_hi/);
    expect(parseBandHistoryRequest(request({ column_ms: 500 }), NOW)).toMatch(/column_ms/);
    expect(parseBandHistoryRequest(request({ column_ms: 61_000 }), NOW)).toMatch(/column_ms/);
    expect(parseBandHistoryRequest(request({ column_ms: 1_500 }), NOW)).toMatch(/column_ms/);
  });

  test("the frame's row cap and the route's agree", () => {
    expect(MAX_BAND_HISTORY_ROWS).toBe(MAX_BAND_ROWS);
  });
});

describe("createBandHistoryHandler", () => {
  function pendingReader() {
    const pending = [];
    const readBandHistory = jest.fn((symbol, kind, options, context) => new Promise((resolve, reject) => {
      const entry = { symbol, kind, options, context, resolve, reject };
      context?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      pending.push(entry);
    }));
    return { reader: { readBandHistory }, pending, readBandHistory };
  }

  function harness(overrides = {}) {
    const sent = [];
    const { reader, pending, readBandHistory } = pendingReader();
    let clock = NOW;
    const handler = createBandHistoryHandler({
      provider: "BINANCE", storageReader: overrides.storageReader === undefined ? reader : overrides.storageReader,
      geometryFor: overrides.geometryFor ?? (() => GEOMETRY),
      safelySend: (client, frame) => sent.push({ client, frame }), now: () => clock, log: () => {}, ...overrides.options,
    });
    return { handler, sent, pending, readBandHistory, advance: (ms) => { clock += ms; } };
  }

  test("answers a request with the host's columns, echoing the request and the band's rows at the chart's geometry", async () => {
    const { handler, sent, pending, readBandHistory } = harness();
    const client = {};
    handler.handle(request(), client, instrument);
    expect(readBandHistory).toHaveBeenCalledWith("BTCUSDT", "PERPETUAL", {
      fromTs: NOW - 3_600_000, toTs: NOW, tickSize: 0.01, clusterTicks: 100, rowClusters: 4, priceLo: 80_000, priceHi: 80_040, columnMs: 10_000,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    pending[0].resolve({ available: true, columns: [column(NOW - 20_000), column(NOW - 10_000)], reason: null });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].frame).toMatchObject({
      type: "band_history", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", request_id: 1,
      from_ts: NOW - 3_600_000, to_ts: NOW, price_lo: 80_000, price_hi: 80_040, column_ms: 10_000,
      row_width: 4, row_lo: 20_000, row_hi: 20_010, complete: true, reason: null,
    });
    expect(sent[0].frame.columns).toHaveLength(2);
    expect(sent[0].frame.columns[1]).toEqual({ ts: NOW - 10_000, bid: new Array(11).fill(1), ask: new Array(11).fill(0), buy: new Array(11).fill(0), sell: new Array(11).fill(2) });
  });

  test("no host reader, an unavailable host and a failed read are told apart on the wire, each with no columns", async () => {
    const local = harness({ storageReader: {} });
    local.handler.handle(request(), {}, instrument);
    await flush();
    expect(local.sent[0].frame).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", columns: [] });

    const unavailable = harness();
    unavailable.handler.handle(request(), {}, instrument);
    unavailable.pending[0].resolve({ available: false, columns: [], reason: "STORAGE_UNAVAILABLE" });
    await flush();
    expect(unavailable.sent[0].frame).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", columns: [] });

    const failed = harness();
    failed.handler.handle(request(), {}, instrument);
    failed.pending[0].reject(new Error("boom"));
    await flush();
    expect(failed.sent[0].frame).toMatchObject({ complete: false, reason: "READ_FAILED", columns: [] });
  });

  test("with no geometry for the instrument yet the request is answered GEOMETRY_UNAVAILABLE without touching the host", async () => {
    const { handler, sent, readBandHistory } = harness({ geometryFor: () => null });
    handler.handle(request(), {}, instrument);
    await flush();
    expect(readBandHistory).not.toHaveBeenCalled();
    expect(sent[0].frame).toMatchObject({ complete: false, reason: "GEOMETRY_UNAVAILABLE", row_width: null, row_lo: null, row_hi: null, columns: [] });
  });

  test("a reader deadline stays distinct from missing storage and quota overload", async () => {
    const local = harness();
    local.handler.handle(request(), {}, instrument);
    local.pending[0].resolve({ available: false, columns: [], reason: "READ_TIMEOUT" });
    await flush();
    expect(local.sent[0].frame).toMatchObject({ complete: false, reason: "READ_TIMEOUT", columns: [] });
  });

  test("a request that cannot be served is still answered, with why: a bad request, a band wider than the cap; only one with no usable fields is dropped", async () => {
    const { handler, sent, readBandHistory } = harness();
    const client = {};
    handler.handle(request({ request_id: 7, column_ms: 7 }), client, instrument);
    handler.handle(request({ request_id: 8, to_ts: NOW + 120_000, from_ts: NOW }), client, instrument);
    handler.handle(request({ request_id: 9, price_hi: 80_000 + 4 * (MAX_BAND_ROWS + 1) }), client, instrument);
    handler.handle(request({ request_id: "x" }), client, instrument);
    handler.handle(request({ request_id: 10, price_lo: 0 }), client, instrument);
    await flush();
    expect(readBandHistory).not.toHaveBeenCalled();
    expect(sent.map(({ frame }) => [frame.request_id, frame.reason, frame.complete, frame.row_width, frame.row_lo, frame.row_hi, frame.columns])).toEqual([
      [7, "BAD_REQUEST", false, null, null, null, []],
      [8, "BAD_REQUEST", false, null, null, null, []],
      [9, "BAND_TOO_WIDE", false, null, null, null, []],
    ]);
    expect(sent[1].frame).toMatchObject({ from_ts: NOW, to_ts: NOW + 120_000, price_lo: 80_000, price_hi: 80_040, column_ms: 10_000 });
    expect(handler.stats()).toMatchObject({ refused: 3, dropped: 2 });
    handler.handle(request({ request_id: 11 }), client, instrument);
    await flush();
    expect(readBandHistory).toHaveBeenCalledTimes(1);
  });

  test("a client's newer request replaces its waiting one, only the newest is answered, and the same request from two clients shares one read", async () => {
    const { handler, sent, pending, readBandHistory } = harness();
    const a = {};
    const b = {};
    handler.handle(request({ request_id: 1 }), a, instrument);
    handler.handle(request({ request_id: 2, price_lo: 79_000, price_hi: 79_040 }), a, instrument);
    handler.handle(request({ request_id: 3, price_lo: 79_000, price_hi: 79_040 }), a, instrument);
    handler.handle(request({ request_id: 9 }), b, instrument);
    await flush();
    expect(readBandHistory).toHaveBeenCalledTimes(1);
    pending[0].resolve({ available: true, columns: [], reason: null });
    await flush();
    expect(sent.map(({ client, frame }) => [client === a ? "a" : "b", frame.request_id])).toEqual([["b", 9]]);
    expect(readBandHistory).toHaveBeenCalledTimes(2);
    pending[1].resolve({ available: true, columns: [], reason: null });
    await flush();
    expect(sent.map(({ client, frame }) => [client === a ? "a" : "b", frame.request_id])).toEqual([["b", 9], ["a", 3]]);
  });

  test("reads are bounded server-wide: past the concurrency limit requests queue, past the queue they are refused OVERLOADED", async () => {
    const { handler, sent, readBandHistory } = harness();
    const clients = Array.from({ length: DEFAULT_MAX_CONCURRENT_READS + DEFAULT_MAX_QUEUED + 1 }, () => ({}));
    clients.forEach((client, index) => handler.handle(request({ request_id: index, price_lo: 80_000 + index * 100, price_hi: 80_040 + index * 100 }), client, instrument));
    await flush();
    expect(readBandHistory).toHaveBeenCalledTimes(DEFAULT_MAX_CONCURRENT_READS);
    expect(handler.stats()).toMatchObject({ reading: DEFAULT_MAX_CONCURRENT_READS, waiting: DEFAULT_MAX_QUEUED, rejected: 1 });
    expect(sent.map(({ frame }) => [frame.request_id, frame.reason])).toEqual([[clients.length - 1, "OVERLOADED"]]);
  });

  test("a client over its rate budget is refused with a retry hint, and forgotten on disconnect with its read aborted", async () => {
    const { handler, sent, pending, readBandHistory, advance } = harness({ options: { rateLimit: { max: 2, windowMs: 60_000 } } });
    const client = {};
    handler.handle(request({ request_id: 1 }), client, instrument);
    handler.handle(request({ request_id: 2, price_lo: 79_000, price_hi: 79_040 }), client, instrument);
    advance(1_000);
    handler.handle(request({ request_id: 3, price_lo: 78_000, price_hi: 78_040 }), client, instrument);
    await flush();
    expect(sent.map(({ frame }) => [frame.request_id, frame.reason, frame.retry_after_ms])).toEqual([[3, "OVERLOADED", 59_000]]);
    expect(readBandHistory).toHaveBeenCalledTimes(1);
    handler.forget(client);
    expect(pending[0].context.signal.aborted).toBe(true);
    expect(handler.stats()).toMatchObject({ reading: 1, waiting: 0 });
  });

  test("dispose aborts in-flight reads and drops what waits; nothing is sent afterwards", async () => {
    const { handler, sent, pending } = harness();
    handler.handle(request({ request_id: 1 }), {}, instrument);
    handler.handle(request({ request_id: 2 }), {}, instrument);
    handler.handle(request({ request_id: 3, price_lo: 70_000, price_hi: 70_040 }), {}, instrument);
    await flush();
    handler.dispose();
    expect(pending.every((entry) => entry.context.signal.aborted)).toBe(true);
    pending[0].resolve({ available: true, columns: [], reason: null });
    await flush();
    expect(sent).toHaveLength(0);
  });

  test("more columns than the wire allows is a failed read, never a silently cut answer", async () => {
    const { handler, sent, pending } = harness();
    handler.handle(request(), {}, instrument);
    pending[0].resolve({ available: true, columns: Array.from({ length: MAX_BAND_HISTORY_COLUMNS + 1 }, (_unused, i) => column(NOW - 8_000_000 + i * 1_000)), reason: null });
    await flush();
    expect(sent[0].frame).toMatchObject({ complete: false, reason: "READ_FAILED", columns: [] });
  });
});
