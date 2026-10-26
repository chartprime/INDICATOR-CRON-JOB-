const {
  createAggressiveHistoryHandler,
  parseAggressiveHistoryRequest,
  rowsToTradeFrames,
  MAX_AGGRESSIVE_HISTORY_WINDOW_MS,
  DEFAULT_MAX_CONCURRENT_READS,
  DEFAULT_MAX_QUEUED,
} = require("../../src/server/aggressive-history");
const { MAX_AGGRESSIVE_HISTORY_TRADES } = require("../../src/server/frames");

const NOW = 1_789_050_000_000;
const request = (over = {}) => ({ type: "aggressive_history", request_id: 1, from_ts: NOW - 3_600_000, to_ts: NOW, min_size: 5, ...over });
const binanceRow = (ts, over = {}) => ({ id: ts, ts, price: "78000.5", size: "1.25", side: "buy", trade_id: `${ts}`, ...over });
const nqRow = (eventTime, over = {}) => ({
  id: eventTime, symbol: "/NQZ26:XCME", asset_class: "FUTURE", event_time: eventTime, price: 29150.25, size: 7, aggressor_side: "SELL",
  time: eventTime, time_nano_part: 0, sequence: eventTime % 1000, event_kind: "NEW", valid_tick: 1, ...over,
});
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const instrument = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };

describe("parseAggressiveHistoryRequest", () => {
  test("accepts a first request and an opaque continuation request with a sane window", () => {
    expect(parseAggressiveHistoryRequest(request(), NOW)).toEqual({ requestId: 1, fromMs: NOW - 3_600_000, toMs: NOW, minSize: 5, cursor: null });
    expect(parseAggressiveHistoryRequest(request({ min_size: 0 }), NOW)).toMatchObject({ minSize: 0 });
    expect(parseAggressiveHistoryRequest(request({ cursor: "eyJ2IjoxfQ" }), NOW)).toMatchObject({ cursor: "eyJ2IjoxfQ" });
  });

  test("refuses extra or missing fields, bad numbers, a future or day-long window", () => {
    expect(parseAggressiveHistoryRequest({ ...request(), symbol: "x" }, NOW)).toBe("unexpected fields");
    expect(parseAggressiveHistoryRequest(request({ request_id: -1 }), NOW)).toMatch(/request_id/);
    expect(parseAggressiveHistoryRequest(request({ from_ts: 1.5 }), NOW)).toMatch(/from_ts/);
    expect(parseAggressiveHistoryRequest(request({ to_ts: NOW - 3_600_000 }), NOW)).toMatch(/to_ts/);
    expect(parseAggressiveHistoryRequest(request({ to_ts: NOW + 120_000 }), NOW)).toMatch(/future/);
    expect(parseAggressiveHistoryRequest(request({ from_ts: NOW - MAX_AGGRESSIVE_HISTORY_WINDOW_MS - 1 }), NOW)).toMatch(/day/);
    expect(parseAggressiveHistoryRequest(request({ min_size: -1 }), NOW)).toMatch(/min_size/);
    expect(parseAggressiveHistoryRequest(request({ min_size: "5" }), NOW)).toMatch(/min_size/);
    expect(parseAggressiveHistoryRequest(request({ cursor: "not/a-token" }), NOW)).toMatch(/cursor/);
  });
});

describe("rowsToTradeFrames", () => {
  test("turns stored rows (newest first) into trade frames oldest first, counting rows the converter rejects and not the ones filtered on purpose", () => {
    const { frames, dropped } = rowsToTradeFrames("BINANCE", { symbol: "BTCUSDT", marketKind: "PERPETUAL" }, [
      binanceRow(3000), binanceRow(2000, { side: "nope" }), binanceRow(1000),
    ]);
    expect(frames.map((frame) => [frame.type, frame.symbol, frame.marketKind, frame.ts_exchange, frame.price, frame.size, frame.trade_id])).toEqual([
      ["trade", "BTC-USDT", "PERPETUAL", 1000, 78000.5, 1.25, "1000"],
      ["trade", "BTC-USDT", "PERPETUAL", 3000, 78000.5, 1.25, "3000"],
    ]);
    expect(dropped).toBe(1);
    const dx = rowsToTradeFrames("DXFEED", { symbol: "/NQZ26:XCME", assetClass: "FUTURE" }, [
      nqRow(3000), nqRow(2500, { valid_tick: 0 }), nqRow(2000, { aggressor_side: "UNDEFINED" }), nqRow(1000),
    ]);
    expect(dx.frames.map((frame) => [frame.provider, frame.symbol, frame.ts_exchange, frame.side, frame.trade_id])).toEqual([
      ["DXFEED", "/NQZ26:XCME", 1000, "sell", "/NQZ26:XCME:1000:0:0"],
      ["DXFEED", "/NQZ26:XCME", 3000, "sell", "/NQZ26:XCME:3000:0:0"],
    ]);
    expect(dx.dropped).toBe(0);
    expect(rowsToTradeFrames("DXFEED", { symbol: "/NQZ26:XCME", assetClass: "FUTURE" }, [nqRow(1000, { price: "not a number" })]).dropped).toBe(1);
  });
});

describe("createAggressiveHistoryHandler", () => {
  function pendingReader() {
    const pending = [];
    const readAggressivePrintsAsync = jest.fn((symbol, kind, options, context) => new Promise((resolve, reject) => {
      const entry = { symbol, kind, options, context, resolve, reject };
      context?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      pending.push(entry);
    }));
    return { storageReader: { readAggressivePrintsAsync }, pending, readAggressivePrintsAsync };
  }

  function handlerWith(storageReader, options = {}) {
    const sent = [];
    const log = jest.fn();
    const handler = createAggressiveHistoryHandler({
      provider: "BINANCE", storageReader, safelySend: (client, frame) => sent.push({ client, frame }), now: () => NOW, log, ...options,
    });
    return { handler, sent, log };
  }

  function resolvedReader({ rows = [], available = true } = {}) {
    const calls = [];
    return {
      calls,
      storageReader: { readAggressivePrintsAsync: jest.fn((symbol, kind, options) => { calls.push({ symbol, kind, options }); return Promise.resolve({ rows, available }); }) },
    };
  }

  test("validates its options", () => {
    const base = { provider: "BINANCE", safelySend: () => {} };
    expect(() => createAggressiveHistoryHandler({ ...base, provider: "X" })).toThrow(/provider/);
    expect(() => createAggressiveHistoryHandler({ ...base, safelySend: null })).toThrow(/safelySend/);
    expect(() => createAggressiveHistoryHandler({ ...base, maxConcurrentReads: 0 })).toThrow(/maxConcurrentReads/);
    expect(() => createAggressiveHistoryHandler({ ...base, maxQueued: 1.5 })).toThrow(/maxQueued/);
    expect(() => createAggressiveHistoryHandler({ ...base, maxQueueWaitMs: -1 })).toThrow(/maxQueueWaitMs/);
    expect(() => createAggressiveHistoryHandler({ ...base, rateLimit: { max: 0, windowMs: 1000 } })).toThrow(/rateLimit.max/);
    expect(() => createAggressiveHistoryHandler({ ...base, rateLimit: { max: 1, windowMs: 0 } })).toThrow(/rateLimit.windowMs/);
    expect(DEFAULT_MAX_CONCURRENT_READS).toBe(2);
    expect(DEFAULT_MAX_QUEUED).toBe(32);
  });

  test("answers a request with the recorded prints as trade frames, oldest first, complete with no reason", async () => {
    const { storageReader, calls } = resolvedReader({ rows: [binanceRow(3000), binanceRow(1000)] });
    const { handler, sent } = handlerWith(storageReader);
    const client = {};
    handler.handle(request(), client, instrument);
    await flush();
    expect(calls).toEqual([{ symbol: "BTCUSDT", kind: "PERPETUAL", options: { fromMs: NOW - 3_600_000, toMs: NOW, minSize: 5, limit: MAX_AGGRESSIVE_HISTORY_TRADES + 1 } }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].client).toBe(client);
    expect(sent[0].frame).toMatchObject({
      type: "aggressive_history", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL",
      request_id: 1, from_ts: NOW - 3_600_000, to_ts: NOW, min_size: 5, complete: true, reason: null,
    });
    expect(sent[0].frame.trades.map((trade) => trade.ts_exchange)).toEqual([1000, 3000]);
    expect(handler.stats()).toMatchObject({ admitted: 1, completed: 1, rows: 2, reading: 0, waiting: 0 });
  });

  test("says why a reply is incomplete: storage unavailable or missing, the cap hit (keeping the newest), the read failed", async () => {
    const unavailable = handlerWith(resolvedReader({ available: false }).storageReader);
    unavailable.handler.handle(request(), {}, instrument);
    await flush();
    expect(unavailable.sent[0].frame).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });

    const none = handlerWith(null);
    none.handler.handle(request(), {}, instrument);
    await flush();
    expect(none.sent[0].frame).toMatchObject({ complete: false, reason: "STORAGE_UNAVAILABLE", trades: [] });

    const rows = Array.from({ length: MAX_AGGRESSIVE_HISTORY_TRADES + 1 }, (_, i) => binanceRow(NOW - i * 10));
    const capped = handlerWith(resolvedReader({ rows }).storageReader);
    capped.handler.handle(request(), {}, instrument);
    await flush();
    expect(capped.sent[0].frame).toMatchObject({ complete: false, reason: "CAP_REACHED", next_cursor: expect.any(String) });
    expect(capped.sent[0].frame.trades).toHaveLength(MAX_AGGRESSIVE_HISTORY_TRADES);
    expect(capped.sent[0].frame.trades.at(-1).ts_exchange).toBe(NOW);
    expect(capped.handler.stats()).toMatchObject({ capped: 1, rows: MAX_AGGRESSIVE_HISTORY_TRADES });

    const failing = handlerWith({ readAggressivePrintsAsync: jest.fn(() => Promise.reject(new Error("boom"))) });
    failing.handler.handle(request(), {}, instrument);
    await flush();
    expect(failing.sent[0].frame).toMatchObject({ complete: false, reason: "READ_FAILED", trades: [] });
    expect(failing.log).toHaveBeenCalledWith(expect.stringContaining("history read failed"), "boom");
    expect(failing.handler.stats()).toMatchObject({ failed: 1, reading: 0 });
  });

  test("binds a capped-page cursor to its exact selection and request window before a storage read begins", async () => {
    const rows = Array.from({ length: MAX_AGGRESSIVE_HISTORY_TRADES + 1 }, (_, i) => binanceRow(NOW - i * 10));
    const { storageReader, calls } = resolvedReader({ rows });
    const { handler, sent, log } = handlerWith(storageReader);
    const client = {};
    handler.handle(request(), client, instrument);
    await flush();
    const cursor = sent[0].frame.next_cursor;
    expect(cursor).toEqual(expect.any(String));

    handler.handle(request({ request_id: 2, cursor }), client, instrument);
    await flush();
    expect(calls[1].options.cursor).toEqual({ ts: NOW - (MAX_AGGRESSIVE_HISTORY_TRADES - 1) * 10, id: NOW - (MAX_AGGRESSIVE_HISTORY_TRADES - 1) * 10 });

    handler.handle(request({ request_id: 3, to_ts: NOW - 1, cursor }), client, instrument);
    await flush();
    expect(calls).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cursor does not match"));
  });

  test("a row the converter cannot turn into a print makes the reply CONVERSION_INCOMPLETE, logged once with the count; a clean reply stays complete and quiet", async () => {
    const dirty = handlerWith(resolvedReader({ rows: [binanceRow(3000), binanceRow(2000, { side: "nope" }), binanceRow(1000)] }).storageReader);
    dirty.handler.handle(request(), {}, instrument);
    await flush();
    expect(dirty.sent).toHaveLength(1);
    expect(dirty.sent[0].frame).toMatchObject({ complete: false, reason: "CONVERSION_INCOMPLETE" });
    expect(dirty.sent[0].frame.trades.map((trade) => trade.ts_exchange)).toEqual([1000, 3000]);
    expect(dirty.log).toHaveBeenCalledTimes(1);
    expect(dirty.log).toHaveBeenCalledWith(expect.stringContaining("1 of 3 recorded rows could not be converted"));
    expect(dirty.handler.stats()).toMatchObject({ dropped: 1, rows: 2 });

    const clean = handlerWith(resolvedReader({ rows: [binanceRow(3000), binanceRow(1000)] }).storageReader);
    clean.handler.handle(request(), {}, instrument);
    await flush();
    expect(clean.sent[0].frame).toMatchObject({ complete: true, reason: null });
    expect(clean.log).not.toHaveBeenCalled();

    const rows = Array.from({ length: MAX_AGGRESSIVE_HISTORY_TRADES + 1 }, (_, i) => binanceRow(NOW - i * 10, i === 5 ? { side: "nope" } : {}));
    const cappedAndDirty = handlerWith(resolvedReader({ rows }).storageReader);
    cappedAndDirty.handler.handle(request(), {}, instrument);
    await flush();
    expect(cappedAndDirty.sent[0].frame).toMatchObject({ complete: false, reason: "CONVERSION_INCOMPLETE" });
  });

  test("a reader that throws synchronously answers READ_FAILED and the client's next request is still answered", async () => {
    const storageReader = { readAggressivePrintsAsync: jest.fn(() => { throw new Error("sync boom"); }) };
    const { handler, sent, log } = handlerWith(storageReader);
    const client = {};
    expect(() => handler.handle(request({ request_id: 1 }), client, instrument)).not.toThrow();
    await flush();
    expect(sent.map(({ frame }) => [frame.request_id, frame.complete, frame.reason])).toEqual([[1, false, "READ_FAILED"]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("history read failed"), "sync boom");
    handler.handle(request({ request_id: 2 }), client, instrument);
    await flush();
    expect(sent.map(({ frame }) => frame.request_id)).toEqual([1, 2]);
    expect(handler.stats()).toMatchObject({ reading: 0, waiting: 0, failed: 2 });
  });

  test("only the newest request per client is answered, one read per client at a time; a malformed request is dropped with a log line", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent, log } = handlerWith(storageReader);
    const client = {};
    handler.handle(request({ request_id: 1 }), client, instrument);
    handler.handle(request({ request_id: 2 }), client, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    pending[0].resolve({ rows: [binanceRow(1000)], available: true });
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);
    pending[1].resolve({ rows: [binanceRow(2000)], available: true });
    await flush();
    expect(sent.map(({ frame }) => frame.request_id)).toEqual([2]);

    handler.handle({ type: "aggressive_history", request_id: 3 }, client, instrument);
    await flush();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dropped aggressive_history request"));
    expect(sent).toHaveLength(1);
  });

  test("the current request is the request itself, not the id the client chose: a reused id cannot swap the answers", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent } = handlerWith(storageReader);
    const client = {};
    handler.handle(request({ request_id: 7, from_ts: NOW - 100 }), client, instrument);
    handler.handle(request({ request_id: 7, from_ts: NOW - 200 }), client, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    pending[0].resolve({ rows: [binanceRow(NOW - 50)], available: true });
    await flush();
    expect(sent).toEqual([]);
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);
    expect(pending[1].options.fromMs).toBe(NOW - 200);
    pending[1].resolve({ rows: [], available: true });
    await flush();
    expect(sent.map(({ frame }) => [frame.request_id, frame.from_ts, frame.trades.length])).toEqual([[7, NOW - 200, 0]]);
  });

  test("reads are bounded across clients: at most maxConcurrentReads run, the rest wait in a finite queue, the overflow is refused at once", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent, log } = handlerWith(storageReader, { maxConcurrentReads: 2, maxQueued: 3 });
    const clients = Array.from({ length: 6 }, () => ({}));
    clients.forEach((client, i) => handler.handle(request({ request_id: i + 1, min_size: i }), client, instrument));
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);
    expect(handler.stats()).toMatchObject({ admitted: 2, reading: 2, waiting: 3, rejected: 1 });
    expect(sent.map(({ client, frame }) => [clients.indexOf(client), frame.complete, frame.reason])).toEqual([[5, false, "OVERLOADED"]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("refused (queue full)"));
    for (let i = 0; i < 5; i += 1) {
      pending[i].resolve({ rows: [], available: true });
      await flush();
      expect(handler.stats().reading).toBeLessThanOrEqual(2);
    }
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(5);
    expect(sent.map(({ client }) => clients.indexOf(client))).toEqual([5, 0, 1, 2, 3, 4]);
    expect(handler.stats()).toMatchObject({ admitted: 5, completed: 5, reading: 0, waiting: 0 });
  });

  test("a request that waited longer than maxQueueWaitMs is refused when its turn comes", async () => {
    let clock = NOW;
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent } = handlerWith(storageReader, { maxConcurrentReads: 1, maxQueueWaitMs: 1_000, now: () => clock });
    const a = {};
    const b = {};
    handler.handle(request({ request_id: 1 }), a, instrument);
    handler.handle(request({ request_id: 2 }), b, instrument);
    clock += 1_001;
    pending[0].resolve({ rows: [], available: true });
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(sent.map(({ client, frame }) => [client === a ? "a" : "b", frame.complete, frame.reason])).toEqual([["a", true, null], ["b", false, "OVERLOADED"]]);
  });

  test("a client that asks more than its rate budget allows is refused, and its waiting request is dropped", async () => {
    const { storageReader, pending } = pendingReader();
    const { handler, sent, log } = handlerWith(storageReader, { rateLimit: { max: 2, windowMs: 10_000 } });
    const client = {};
    handler.handle(request({ request_id: 1 }), client, instrument);
    handler.handle(request({ request_id: 2 }), client, instrument);
    handler.handle(request({ request_id: 3 }), client, instrument);
    await flush();
    expect(sent.map(({ frame }) => [frame.request_id, frame.reason, frame.retry_after_ms])).toEqual([[3, "OVERLOADED", 10_000]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("refused (rate budget)"));
    expect(handler.stats()).toMatchObject({ rejected: 1, cancelled: 1, waiting: 0, reading: 1 });
    pending[0].resolve({ rows: [], available: true });
    await flush();
    expect(sent).toHaveLength(1);
  });

  test("of several requests arriving during a client's read only the newest runs after it; other clients read in parallel", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent } = handlerWith(storageReader);
    const client = {};
    const other = {};
    handler.handle(request({ request_id: 1 }), client, instrument);
    handler.handle(request({ request_id: 2, to_ts: NOW - 2_000 }), client, instrument);
    handler.handle(request({ request_id: 3, to_ts: NOW - 3_000 }), client, instrument);
    handler.handle(request({ request_id: 4, to_ts: NOW - 4_000 }), client, instrument);
    handler.handle(request({ request_id: 7, min_size: 9 }), other, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);
    expect(handler.stats()).toMatchObject({ waiting: 1, cancelled: 2 });
    pending[1].resolve({ rows: [binanceRow(NOW - 1)], available: true });
    await flush();
    expect(sent.map(({ client: c, frame }) => [c === other ? "other" : "client", frame.request_id])).toEqual([["other", 7]]);
    pending[0].resolve({ rows: [binanceRow(1000)], available: true });
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(3);
    expect(pending[2].options).toMatchObject({ toMs: NOW - 4_000 });
    pending[2].resolve({ rows: [], available: true });
    await flush();
    expect(sent.map(({ frame }) => frame.request_id)).toEqual([7, 4]);
  });

  test("two clients requesting the identical window and min_size share one read instead of launching a duplicate", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent } = handlerWith(storageReader);
    const clientA = {};
    const clientB = {};
    handler.handle(request({ request_id: 1 }), clientA, instrument);
    handler.handle(request({ request_id: 2 }), clientB, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(handler.stats()).toMatchObject({ admitted: 1, reading: 1 });
    pending[0].resolve({ rows: [binanceRow(NOW - 1)], available: true });
    await flush();
    expect(sent.map(({ client, frame }) => [client === clientA ? "a" : "b", frame.request_id])).toEqual(
      expect.arrayContaining([["a", 1], ["b", 2]]),
    );
    expect(sent).toHaveLength(2);
  });

  test("one of two sharing clients disconnecting does not cancel the read the other still needs", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent } = handlerWith(storageReader);
    const clientA = {};
    const clientB = {};
    handler.handle(request({ request_id: 1 }), clientA, instrument);
    handler.handle(request({ request_id: 2 }), clientB, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);

    handler.forget(clientA);
    expect(pending[0].context.signal.aborted).toBe(false);
    pending[0].resolve({ rows: [binanceRow(NOW - 1)], available: true });
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(sent.map(({ client, frame }) => [client === clientB ? "b" : "a", frame.request_id])).toEqual([["b", 2]]);
  });

  test("the final subscriber aborts its orphaned read and a stale completion cannot delete its same-key replacement", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent } = handlerWith(storageReader, { maxConcurrentReads: 3 });
    const abandoned = {};
    const replacement = {};
    const follower = {};

    handler.handle(request({ request_id: 1 }), abandoned, instrument);
    await flush();
    handler.forget(abandoned);
    expect(pending[0].context.signal.aborted).toBe(true);

    handler.handle(request({ request_id: 2 }), replacement, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);

    // The abandoned read's rejection/finally runs after the replacement has
    // claimed the same key. Its stale cleanup must not remove that entry.
    await flush();
    handler.handle(request({ request_id: 3 }), follower, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);

    pending[1].resolve({ rows: [binanceRow(NOW - 1)], available: true });
    await flush();
    expect(sent.map(({ frame }) => frame.request_id).sort()).toEqual([2, 3]);
    expect(handler.stats()).toMatchObject({ admitted: 2, completed: 1, failed: 0, reading: 0 });
  });

  test("requests with different min_size are not merged into the same read", async () => {
    const { storageReader, readAggressivePrintsAsync } = pendingReader();
    const { handler } = handlerWith(storageReader);
    const clientA = {};
    const clientB = {};
    handler.handle(request({ request_id: 1, min_size: 5 }), clientA, instrument);
    handler.handle(request({ request_id: 2, min_size: 6 }), clientB, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);
  });

  test("a client that disconnects with a read in flight and one waiting gets nothing, and the waiting one never starts", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent } = handlerWith(storageReader);
    const client = {};
    handler.handle(request({ request_id: 1 }), client, instrument);
    handler.handle(request({ request_id: 2 }), client, instrument);
    handler.forget(client);
    expect(handler.stats()).toMatchObject({ waiting: 0, cancelled: 1, reading: 1 });
    pending[0].resolve({ rows: [binanceRow(1000)], available: true });
    await flush();
    expect(sent).toEqual([]);
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(1);
    expect(handler.stats()).toMatchObject({ reading: 0, waiting: 0 });
  });

  test("dispose drops what waits, silences what is in flight, and ignores what comes after", async () => {
    const { storageReader, pending, readAggressivePrintsAsync } = pendingReader();
    const { handler, sent } = handlerWith(storageReader, { maxConcurrentReads: 2 });
    handler.handle(request({ request_id: 1, min_size: 1 }), {}, instrument);
    handler.handle(request({ request_id: 2, min_size: 2 }), {}, instrument);
    handler.handle(request({ request_id: 3, min_size: 3 }), {}, instrument);
    await flush();
    expect(handler.stats()).toMatchObject({ reading: 2, waiting: 1 });
    handler.dispose();
    expect(handler.stats()).toMatchObject({ waiting: 0, cancelled: 1 });
    pending[0].resolve({ rows: [], available: true });
    pending[1].resolve({ rows: [], available: true });
    await flush();
    expect(sent).toEqual([]);
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);
    handler.handle(request({ request_id: 9, min_size: 9 }), {}, instrument);
    await flush();
    expect(readAggressivePrintsAsync).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([]);
  });
});
