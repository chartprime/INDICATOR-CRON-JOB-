const {
  createDeltaProfileHandler,
  parseDeltaProfileRequest,
  piecesOf,
  rowsFromBuckets,
  PIECE_MS,
  MIN_PIECE_MS,
  CLOSED_GRACE_MS,
  RECENT_PIECE_TTL_MS,
  MAX_DELTA_PROFILE_WINDOW_MS,
} = require("../../src/server/delta-profile");
const { MAX_DELTA_PROFILE_ROWS } = require("../../src/server/frames");

const HOUR = 3_600_000;
const BOUNDARY = 248_612 * PIECE_MS;
const NOW = BOUNDARY + 10 * 60_000;
const instrument = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const request = (over = {}) => ({ type: "delta_profile", request_id: 1, from_ts: BOUNDARY, to_ts: NOW, row_width: 1, ...over });
const bucket = (index, buy, sell) => ({ bucket: index, volume: buy + sell, buyVolume: buy, sellVolume: sell, tradeCount: 1 });
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe("parseDeltaProfileRequest", () => {
  test("accepts exactly the five fields with a sane window and a positive row width, and an optional piece size that divides the piece length", () => {
    expect(parseDeltaProfileRequest(request(), NOW)).toEqual({ requestId: 1, fromMs: BOUNDARY, toMs: NOW, rowWidth: 1, pieceMs: PIECE_MS });
    expect(parseDeltaProfileRequest(request({ row_width: 0.25 }), NOW)).toMatchObject({ rowWidth: 0.25 });
    expect(parseDeltaProfileRequest(request({ piece_ms: MIN_PIECE_MS }), NOW)).toMatchObject({ pieceMs: MIN_PIECE_MS });
    expect(parseDeltaProfileRequest(request({ piece_ms: HOUR }), NOW)).toMatchObject({ pieceMs: HOUR });
    expect(parseDeltaProfileRequest(request({ piece_ms: PIECE_MS }), NOW)).toMatchObject({ pieceMs: PIECE_MS });
    for (const bad of [0, MIN_PIECE_MS - 1, 15 * 60_000, 50 * 60_000, PIECE_MS + 1, 2 * PIECE_MS, "1800000", 1.5]) {
      expect(parseDeltaProfileRequest(request({ piece_ms: bad }), NOW)).toMatch(/piece_ms/);
    }
    expect(parseDeltaProfileRequest(request({ piece_ms: PIECE_MS }), NOW, 2 * PIECE_MS)).toMatchObject({ pieceMs: PIECE_MS });
  });

  test("refuses extra or missing fields, bad numbers, a future window, a window over eight days, a non-positive width", () => {
    expect(parseDeltaProfileRequest({ ...request(), cursor: "x" }, NOW)).toBe("unexpected fields");
    expect(parseDeltaProfileRequest(request({ request_id: -1 }), NOW)).toMatch(/request_id/);
    expect(parseDeltaProfileRequest(request({ from_ts: 1.5 }), NOW)).toMatch(/from_ts/);
    expect(parseDeltaProfileRequest(request({ to_ts: BOUNDARY }), NOW)).toMatch(/to_ts/);
    expect(parseDeltaProfileRequest(request({ to_ts: NOW + 120_000 }), NOW)).toMatch(/future/);
    expect(parseDeltaProfileRequest(request({ from_ts: NOW - MAX_DELTA_PROFILE_WINDOW_MS - 1 }), NOW)).toMatch(/eight days/);
    expect(parseDeltaProfileRequest(request({ row_width: 0 }), NOW)).toMatch(/row_width/);
    expect(parseDeltaProfileRequest(request({ row_width: "1" }), NOW)).toMatch(/row_width/);
    expect(parseDeltaProfileRequest(request({ row_width: Infinity }), NOW)).toMatch(/row_width/);
  });
});

describe("piecesOf", () => {
  test("cuts the window on piece boundaries, newest first, clipping the edges to the window", () => {
    expect(piecesOf(NOW - 5 * HOUR, NOW, PIECE_MS)).toEqual([
      { from: BOUNDARY, to: NOW },
      { from: BOUNDARY - PIECE_MS, to: BOUNDARY },
      { from: BOUNDARY - 2 * PIECE_MS, to: BOUNDARY - PIECE_MS },
      { from: NOW - 5 * HOUR, to: BOUNDARY - 2 * PIECE_MS },
    ]);
    expect(piecesOf(BOUNDARY - PIECE_MS, BOUNDARY, PIECE_MS)).toEqual([{ from: BOUNDARY - PIECE_MS, to: BOUNDARY }]);
    expect(piecesOf(NOW - 60_000, NOW, PIECE_MS)).toEqual([{ from: NOW - 60_000, to: NOW }]);
  });
});

describe("rowsFromBuckets", () => {
  test("puts each bucket on the absolute price grid, in ascending order, dropping what would not ascend", () => {
    expect(rowsFromBuckets([bucket(846_101, 2.5, 1), bucket(846_102, 0, 3)], 0.1)).toEqual([[84_610.1, 2.5, 1], [84_610.2, 0, 3]]);
    expect(rowsFromBuckets([bucket(1_000, 1, 1), bucket(999, 1, 1), bucket(1_001, 1, 1)], 1)).toEqual([[1_000, 1, 1], [1_001, 1, 1]]);
    expect(rowsFromBuckets([bucket(0, 1, 1), bucket(-3, 1, 1)], 1)).toEqual([]);
  });
});

describe("createDeltaProfileHandler", () => {
  function pendingReader() {
    const pending = [];
    const readVolumeProfileAsync = jest.fn((symbol, kind, options, context) => new Promise((resolve) => {
      const entry = { symbol, kind, options, signal: context?.signal, resolve };
      context?.signal?.addEventListener("abort", () => resolve({ buckets: [], available: false }), { once: true });
      pending.push(entry);
    }));
    return { storageReader: { readVolumeProfileAsync }, pending, readVolumeProfileAsync };
  }

  function handlerWith(storageReader, options = {}) {
    const sent = [];
    const log = jest.fn();
    let clock = NOW;
    const handler = createDeltaProfileHandler({
      provider: "BINANCE", storageReader, safelySend: (client, frame) => sent.push({ client, frame }), now: () => clock, log, ...options,
    });
    const frames = (client) => sent.filter((entry) => entry.client === client).map((entry) => entry.frame);
    return { handler, sent, log, frames, tick: (ms) => { clock += ms; } };
  }

  test("validates its options", () => {
    const safelySend = () => {};
    expect(() => createDeltaProfileHandler({ provider: "X", safelySend })).toThrow(/provider/);
    expect(() => createDeltaProfileHandler({ provider: "BINANCE" })).toThrow(/safelySend/);
    for (const key of ["pieceMs", "closedGraceMs", "recentPieceTtlMs", "maxConcurrentReads", "maxQueued", "maxQueueWaitMs", "maxCachedPieces"]) {
      expect(() => createDeltaProfileHandler({ provider: "BINANCE", safelySend, [key]: 0 })).toThrow(new RegExp(key));
    }
    expect(() => createDeltaProfileHandler({ provider: "BINANCE", safelySend, rateLimit: { max: 0, windowMs: 1 } })).toThrow(/rateLimit.max/);
    expect(() => createDeltaProfileHandler({ provider: "DXFEED", safelySend })).not.toThrow();
  });

  test("answers a one-piece request with the rows on the absolute grid, complete, pending 0, reading with origin 0 and the row width", async () => {
    const reader = pendingReader();
    const { handler, frames } = handlerWith(reader.storageReader);
    const client = {};
    handler.handle(request(), client, instrument);
    expect(reader.readVolumeProfileAsync).toHaveBeenCalledWith("BTCUSDT", "PERPETUAL", { fromTs: BOUNDARY, toTs: NOW, originPrice: 0, rowWidth: 1 }, { signal: expect.any(AbortSignal) });
    reader.pending[0].resolve({ buckets: [bucket(84_610, 12.4, 3.1), bucket(84_611, 0, 7.75)], available: true });
    await flush();
    expect(frames(client)).toEqual([expect.objectContaining({
      type: "delta_profile", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL",
      request_id: 1, from_ts: BOUNDARY, to_ts: NOW, row_width: 1, complete: true, reason: null, retry_after_ms: null, pending: 0,
      rows: [[84_610, 12.4, 3.1], [84_611, 0, 7.75]],
    })]);
    expect(handler.stats()).toMatchObject({ admitted: 1, completed: 1, pieces: 1, rows: 2, reading: 0, waiting: 0, cached: 0 });
  });

  test("a wider window goes out piece by piece, newest first, with pending counting down; a dxFeed instrument reads by asset class", async () => {
    const reader = pendingReader();
    const { handler, frames } = handlerWith(reader.storageReader, { provider: "DXFEED" });
    const client = {};
    const nq = { symbol: "/NQZ26:XCME", assetClass: "FUTURE" };
    handler.handle(request({ from_ts: NOW - 5 * HOUR, row_width: 0.25 }), client, nq);
    for (let i = 0; i < 4; i += 1) {
      expect(reader.pending).toHaveLength(i + 1);
      expect(reader.pending[i].kind).toBe("FUTURE");
      reader.pending[i].resolve({ buckets: [bucket(100_000 + i, 1, 0)], available: true });
      await flush();
    }
    expect(frames(client).map((frame) => [frame.from_ts, frame.to_ts, frame.pending, frame.rows])).toEqual([
      [BOUNDARY, NOW, 3, [[25_000, 1, 0]]],
      [BOUNDARY - PIECE_MS, BOUNDARY, 2, [[25_000.25, 1, 0]]],
      [BOUNDARY - 2 * PIECE_MS, BOUNDARY - PIECE_MS, 1, [[25_000.5, 1, 0]]],
      [NOW - 5 * HOUR, BOUNDARY - 2 * PIECE_MS, 0, [[25_000.75, 1, 0]]],
    ]);
    expect(frames(client).every((frame) => frame.symbol === "/NQZ26:XCME" && frame.assetClass === "FUTURE" && frame.row_width === 0.25)).toBe(true);
  });

  test("closed pieces are cached: a later request gets them without a read, and only the open piece and the partial edge are read again", async () => {
    const reader = pendingReader();
    const { handler, frames } = handlerWith(reader.storageReader);
    const first = {};
    handler.handle(request({ from_ts: NOW - 5 * HOUR }), first, instrument);
    for (let i = 0; i < 4; i += 1) {
      reader.pending[i].resolve({ buckets: [bucket(84_600 + i, 1, 1)], available: true });
      await flush();
    }
    expect(handler.stats()).toMatchObject({ cached: 2, cacheHits: 0 });
    const second = {};
    handler.handle(request({ request_id: 2, from_ts: NOW - 5 * HOUR }), second, instrument);
    expect(reader.pending).toHaveLength(5);
    expect(reader.pending[4].options).toMatchObject({ fromTs: BOUNDARY, toTs: NOW });
    reader.pending[4].resolve({ buckets: [bucket(84_700, 2, 0)], available: true });
    await flush();
    expect(reader.pending).toHaveLength(6);
    expect(reader.pending[5].options).toMatchObject({ fromTs: NOW - 5 * HOUR, toTs: BOUNDARY - 2 * PIECE_MS });
    reader.pending[5].resolve({ buckets: [bucket(84_701, 0, 2)], available: true });
    await flush();
    expect(frames(second).map((frame) => [frame.from_ts, frame.pending, frame.rows])).toEqual([
      [BOUNDARY, 3, [[84_700, 2, 0]]],
      [BOUNDARY - PIECE_MS, 2, [[84_601, 1, 1]]],
      [BOUNDARY - 2 * PIECE_MS, 1, [[84_602, 1, 1]]],
      [NOW - 5 * HOUR, 0, [[84_701, 0, 2]]],
    ]);
    expect(handler.stats()).toMatchObject({ cached: 2, cacheHits: 2, pieces: 6 });
  });

  test("a piece that just closed is not cached until the grace has passed, and a piece read at another width is another entry", async () => {
    const reader = pendingReader();
    const { handler, tick } = handlerWith(reader.storageReader, { closedGraceMs: CLOSED_GRACE_MS });
    const client = {};
    tick(60_000 - (NOW - BOUNDARY));
    handler.handle(request({ from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY }), client, instrument);
    reader.pending[0].resolve({ buckets: [bucket(1, 1, 1)], available: true });
    await flush();
    expect(handler.stats().cached).toBe(0);
    tick(CLOSED_GRACE_MS);
    handler.handle(request({ request_id: 2, from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY }), client, instrument);
    reader.pending[1].resolve({ buckets: [bucket(1, 1, 1)], available: true });
    await flush();
    expect(handler.stats().cached).toBe(1);
    handler.handle(request({ request_id: 3, from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY, row_width: 10 }), client, instrument);
    expect(reader.pending).toHaveLength(3);
    reader.pending[2].resolve({ buckets: [bucket(1, 1, 1)], available: true });
    await flush();
    expect(handler.stats().cached).toBe(2);
  });

  test("a piece read soon after it closed is served from the cache for RECENT_PIECE_TTL_MS only, then read again; one read later than that stays cached", async () => {
    const reader = pendingReader();
    const { handler, frames, tick } = handlerWith(reader.storageReader);
    const client = {};
    const piece = { from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY };
    handler.handle(request({ ...piece }), client, instrument);
    reader.pending[0].resolve({ buckets: [bucket(1, 1, 1)], available: true });
    await flush();
    tick(RECENT_PIECE_TTL_MS - 1);
    handler.handle(request({ request_id: 2, ...piece }), client, instrument);
    expect(reader.pending).toHaveLength(1);
    tick(1);
    handler.handle(request({ request_id: 3, ...piece }), client, instrument);
    expect(reader.pending).toHaveLength(2);
    reader.pending[1].resolve({ buckets: [bucket(2, 1, 1)], available: true });
    await flush();
    tick(24 * HOUR);
    handler.handle(request({ request_id: 4, ...piece }), client, instrument);
    expect(reader.pending).toHaveLength(2);
    expect(frames(client).map((frame) => [frame.request_id, frame.rows])).toEqual([[1, [[1, 1, 1]]], [2, [[1, 1, 1]]], [3, [[2, 1, 1]]], [4, [[2, 1, 1]]]]);
    expect(handler.stats()).toMatchObject({ cached: 1, cacheHits: 2 });
  });

  test("a request with its own piece size is cut and cached at that size, apart from the two-hour pieces of the same hours", async () => {
    const reader = pendingReader();
    const { handler, frames } = handlerWith(reader.storageReader);
    const client = {};
    handler.handle(request({ from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY, piece_ms: MIN_PIECE_MS }), client, instrument);
    for (let i = 0; i < 4; i += 1) {
      expect(reader.pending[i].options).toMatchObject({ fromTs: BOUNDARY - (i + 1) * MIN_PIECE_MS, toTs: BOUNDARY - i * MIN_PIECE_MS });
      reader.pending[i].resolve({ buckets: [bucket(84_600 + i, 1, 0)], available: true });
      await flush();
    }
    expect(frames(client).map((frame) => [frame.from_ts, frame.to_ts, frame.pending])).toEqual([
      [BOUNDARY - MIN_PIECE_MS, BOUNDARY, 3],
      [BOUNDARY - 2 * MIN_PIECE_MS, BOUNDARY - MIN_PIECE_MS, 2],
      [BOUNDARY - 3 * MIN_PIECE_MS, BOUNDARY - 2 * MIN_PIECE_MS, 1],
      [BOUNDARY - 4 * MIN_PIECE_MS, BOUNDARY - 3 * MIN_PIECE_MS, 0],
    ]);
    expect(handler.stats()).toMatchObject({ cached: 4, pieces: 4 });
    handler.handle(request({ request_id: 2, from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY, piece_ms: MIN_PIECE_MS }), client, instrument);
    expect(reader.pending).toHaveLength(4);
    expect(frames(client)).toHaveLength(8);
    handler.handle(request({ request_id: 3, from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY }), client, instrument);
    expect(reader.pending).toHaveLength(5);
    expect(reader.pending[4].options).toMatchObject({ fromTs: BOUNDARY - PIECE_MS, toTs: BOUNDARY });
  });

  test("the cache is bounded: the oldest piece leaves when a newer one comes in", async () => {
    const reader = pendingReader();
    const { handler } = handlerWith(reader.storageReader, { maxCachedPieces: 1 });
    const client = {};
    handler.handle(request({ from_ts: BOUNDARY - 2 * PIECE_MS, to_ts: BOUNDARY }), client, instrument);
    reader.pending[0].resolve({ buckets: [bucket(1, 1, 1)], available: true });
    await flush();
    reader.pending[1].resolve({ buckets: [bucket(2, 1, 1)], available: true });
    await flush();
    expect(handler.stats().cached).toBe(1);
    handler.handle(request({ request_id: 2, from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY }), client, instrument);
    expect(reader.pending).toHaveLength(3);
    handler.handle(request({ request_id: 3, from_ts: BOUNDARY - 2 * PIECE_MS, to_ts: BOUNDARY - PIECE_MS }), client, instrument);
    expect(reader.pending).toHaveLength(3);
    expect(handler.stats().cacheHits).toBe(1);
  });

  test("says why a piece is incomplete, carries no rows, ends the request, and never caches it", async () => {
    const reader = pendingReader();
    const { handler, frames, log } = handlerWith(reader.storageReader);
    const client = {};
    handler.handle(request({ from_ts: NOW - 5 * HOUR }), client, instrument);
    reader.pending[0].resolve({ buckets: [bucket(1, 1, 1)], available: false });
    await flush();
    expect(frames(client)).toEqual([expect.objectContaining({ complete: false, reason: "STORAGE_UNAVAILABLE", rows: [], pending: 0, from_ts: BOUNDARY })]);
    expect(reader.pending).toHaveLength(1);

    handler.handle(request({ request_id: 2, from_ts: NOW - 5 * HOUR }), client, instrument);
    reader.pending[1].resolve(Promise.reject(new Error("boom")));
    await flush();
    expect(frames(client).at(-1)).toMatchObject({ request_id: 2, complete: false, reason: "READ_FAILED", rows: [], pending: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/read failed/), "boom");
    expect(reader.pending).toHaveLength(2);

    handler.handle(request({ request_id: 3, from_ts: BOUNDARY - PIECE_MS, to_ts: BOUNDARY }), client, instrument);
    reader.pending[2].resolve({ buckets: Array.from({ length: MAX_DELTA_PROFILE_ROWS + 1 }, (_unused, i) => bucket(i + 1, 1, 0)), available: true });
    await flush();
    expect(frames(client).at(-1)).toMatchObject({ request_id: 3, complete: false, reason: "ROWS_CAPPED", rows: [], pending: 0 });
    expect(handler.stats()).toMatchObject({ failed: 1, capped: 1, cached: 0, rows: 0 });
  });

  test("a busy archive, or a read that ran out of time, answers OVERLOADED, not STORAGE_UNAVAILABLE", async () => {
    for (const [upstream, expected] of [["QUEUE_FULL", "OVERLOADED"], ["QUEUE_TIMEOUT", "OVERLOADED"], ["RATE_LIMITED", "OVERLOADED"], ["READ_TIMEOUT", "OVERLOADED"], [undefined, "STORAGE_UNAVAILABLE"]]) {
      const reader = pendingReader();
      const { handler, frames } = handlerWith(reader.storageReader);
      const client = {};
      handler.handle(request({ from_ts: NOW - 5 * HOUR }), client, instrument);
      reader.pending[0].resolve({ buckets: [], available: false, ...(upstream === undefined ? {} : { reason: upstream }) });
      await flush();
      expect(frames(client)).toEqual([expect.objectContaining({ complete: false, reason: expected, retry_after_ms: null, rows: [], pending: 0 })]);
      handler.dispose();
    }
  });

  test("a reader with no async profile read answers STORAGE_UNAVAILABLE; a reader that throws synchronously answers READ_FAILED", async () => {
    const bare = handlerWith({});
    const client = {};
    bare.handler.handle(request(), client, instrument);
    await flush();
    expect(bare.frames(client)).toEqual([expect.objectContaining({ complete: false, reason: "STORAGE_UNAVAILABLE" })]);
    const throwing = handlerWith({ readVolumeProfileAsync: () => { throw new Error("sync"); } });
    throwing.handler.handle(request(), client, instrument);
    await flush();
    expect(throwing.frames(client)).toEqual([expect.objectContaining({ complete: false, reason: "READ_FAILED" })]);
    const generic = pendingReader();
    const viaReadAsync = handlerWith({ readAsync: jest.fn((method, symbol, kind, options, context) => generic.storageReader.readVolumeProfileAsync(symbol, kind, options, context)) });
    viaReadAsync.handler.handle(request(), client, instrument);
    expect(generic.readVolumeProfileAsync).toHaveBeenCalledTimes(1);
  });

  test("only the newest request per client is served: the older one's read is abandoned and its late result dropped; a malformed request is dropped with a log line", async () => {
    const reader = pendingReader();
    const { handler, frames, log } = handlerWith(reader.storageReader);
    const client = {};
    handler.handle(request({ request_id: 1 }), client, instrument);
    handler.handle(request({ request_id: 2 }), client, instrument);
    expect(reader.pending[0].signal.aborted).toBe(true);
    expect(reader.pending).toHaveLength(2);
    reader.pending[1].resolve({ buckets: [bucket(5, 1, 0)], available: true });
    await flush();
    expect(frames(client).map((frame) => frame.request_id)).toEqual([2]);
    handler.handle({ ...request(), row_width: -1 }, client, instrument);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/dropped delta_profile request: row_width/));
    expect(handler.stats().cancelled).toBe(1);
  });

  test("a malformed request whose fields still make a frame is answered BAD_REQUEST with nothing read; one whose fields cannot is dropped with a log line", async () => {
    const reader = pendingReader();
    const { handler, frames, log } = handlerWith(reader.storageReader);
    const client = {};
    handler.handle(request({ to_ts: NOW + 120_000 }), client, instrument);
    handler.handle({ ...request({ request_id: 2 }), cursor: "x" }, client, instrument);
    handler.handle(request({ request_id: 3, from_ts: NOW - MAX_DELTA_PROFILE_WINDOW_MS - 1 }), client, instrument);
    handler.handle(request({ request_id: 4, piece_ms: 1 }), client, instrument);
    expect(frames(client).map((frame) => [frame.request_id, frame.complete, frame.reason, frame.pending, frame.rows])).toEqual([
      [1, false, "BAD_REQUEST", 0, []],
      [2, false, "BAD_REQUEST", 0, []],
      [3, false, "BAD_REQUEST", 0, []],
      [4, false, "BAD_REQUEST", 0, []],
    ]);
    expect(frames(client)[0]).toMatchObject({ from_ts: BOUNDARY, to_ts: NOW + 120_000, row_width: 1, retry_after_ms: null });
    expect(reader.pending).toHaveLength(0);
    expect(handler.stats().refused).toBe(4);
    expect(log).not.toHaveBeenCalled();
    handler.handle(request({ request_id: "x" }), client, instrument);
    expect(frames(client)).toHaveLength(4);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/dropped delta_profile request: request_id/));
  });

  test("two clients asking for the same piece share one read; one of them leaving keeps the read for the other", async () => {
    const reader = pendingReader();
    const { handler, frames } = handlerWith(reader.storageReader);
    const a = {};
    const b = {};
    handler.handle(request(), a, instrument);
    handler.handle(request({ request_id: 7 }), b, instrument);
    expect(reader.pending).toHaveLength(1);
    handler.forget(a);
    expect(reader.pending[0].signal.aborted).toBe(false);
    reader.pending[0].resolve({ buckets: [bucket(5, 1, 0)], available: true });
    await flush();
    expect(frames(a)).toEqual([]);
    expect(frames(b)).toEqual([expect.objectContaining({ request_id: 7, rows: [[5, 1, 0]] })]);
  });

  test("reads are bounded and fair: with one read slot, a one-piece request gets its turn between another client's pieces", async () => {
    const reader = pendingReader();
    const { handler, frames } = handlerWith(reader.storageReader, { maxConcurrentReads: 1 });
    const a = {};
    const b = {};
    handler.handle(request({ from_ts: NOW - 5 * HOUR }), a, instrument);
    handler.handle(request({ request_id: 2 }), b, instrument);
    expect(reader.pending).toHaveLength(1);
    expect(handler.stats()).toMatchObject({ reading: 1, waiting: 1 });
    reader.pending[0].resolve({ buckets: [], available: true });
    await flush();
    expect(reader.pending).toHaveLength(2);
    expect(reader.pending[1].options).toMatchObject({ fromTs: BOUNDARY, toTs: NOW });
    reader.pending[1].resolve({ buckets: [], available: true });
    await flush();
    expect(frames(b)).toHaveLength(1);
    expect(reader.pending[2].options).toMatchObject({ fromTs: BOUNDARY - PIECE_MS, toTs: BOUNDARY });
    reader.pending[2].resolve({ buckets: [], available: true });
    await flush();
    reader.pending[3].resolve({ buckets: [], available: true });
    await flush();
    reader.pending[4].resolve({ buckets: [], available: true });
    await flush();
    expect(reader.pending).toHaveLength(5);
    expect(frames(a).map((frame) => frame.pending)).toEqual([3, 2, 1, 0]);
  });

  test("the queue is finite: past it a request is refused at once with OVERLOADED, and a request that waited too long is refused when its turn comes", async () => {
    const reader = pendingReader();
    const { handler, frames, tick, log } = handlerWith(reader.storageReader, { maxConcurrentReads: 1, maxQueued: 1, maxQueueWaitMs: 1_000 });
    const a = {};
    const b = {};
    const c = {};
    handler.handle(request(), a, instrument);
    handler.handle(request(), b, instrument);
    handler.handle(request(), c, instrument);
    expect(frames(c)).toEqual([expect.objectContaining({ complete: false, reason: "OVERLOADED", retry_after_ms: null, rows: [], pending: 0 })]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/refused \(queue full\)/));
    tick(1_001);
    reader.pending[0].resolve({ buckets: [], available: true });
    await flush();
    expect(frames(b)).toEqual([expect.objectContaining({ complete: false, reason: "OVERLOADED" })]);
    expect(reader.pending).toHaveLength(1);
    expect(handler.stats()).toMatchObject({ rejected: 2, waiting: 0 });
  });

  test("a client over its rate budget is refused with the wait to observe", async () => {
    const reader = pendingReader();
    const { handler, frames, tick } = handlerWith(reader.storageReader, { rateLimit: { max: 2, windowMs: 60_000 } });
    const client = {};
    handler.handle(request(), client, instrument);
    tick(1_000);
    handler.handle(request({ request_id: 2 }), client, instrument);
    tick(1_000);
    handler.handle(request({ request_id: 3 }), client, instrument);
    expect(frames(client)).toEqual([expect.objectContaining({ request_id: 3, complete: false, reason: "OVERLOADED", retry_after_ms: 58_000 })]);
    expect(reader.pending).toHaveLength(2);
    expect(reader.pending[1].signal.aborted).toBe(true);
  });

  test("a client that disconnects with a read in flight gets nothing and its orphaned read is abandoned", async () => {
    const reader = pendingReader();
    const { handler, frames } = handlerWith(reader.storageReader);
    const client = {};
    handler.handle(request({ from_ts: NOW - 5 * HOUR }), client, instrument);
    handler.forget(client);
    expect(reader.pending[0].signal.aborted).toBe(true);
    reader.pending[0].resolve({ buckets: [bucket(5, 1, 0)], available: true });
    await flush();
    expect(frames(client)).toEqual([]);
    expect(reader.pending).toHaveLength(1);
    expect(handler.stats()).toMatchObject({ reading: 0, waiting: 0, completed: 0, cancelled: 1 });
  });

  test("dispose abandons what is in flight, empties the cache, and ignores what comes after", async () => {
    const reader = pendingReader();
    const { handler, frames } = handlerWith(reader.storageReader);
    const client = {};
    handler.handle(request({ from_ts: BOUNDARY - PIECE_MS, to_ts: NOW }), client, instrument);
    reader.pending[0].resolve({ buckets: [], available: true });
    await flush();
    handler.dispose();
    expect(reader.pending[1].signal.aborted).toBe(true);
    reader.pending[1].resolve({ buckets: [bucket(5, 1, 0)], available: true });
    await flush();
    expect(frames(client)).toHaveLength(1);
    handler.handle(request({ request_id: 2 }), client, instrument);
    expect(reader.pending).toHaveLength(2);
    expect(handler.stats()).toMatchObject({ cached: 0, reading: 0, waiting: 0 });
  });
});
