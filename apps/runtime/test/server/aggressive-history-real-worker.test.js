const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createStorageDb } = require("../../src/storage/storage-db");
const { createStorageReader } = require("../../src/storage/storage-reader");
const { createAggressiveHistoryHandler } = require("../../src/server/aggressive-history");
const { MAX_AGGRESSIVE_HISTORY_TRADES } = require("../../src/server/frames");
const { safeRm } = require("../helpers/temp-files");

const T0 = 1_789_000_000_000;
const ROWS = MAX_AGGRESSIVE_HISTORY_TRADES + 500;
const instrument = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };

function seededDbPath() {
  const dbPath = path.join(os.tmpdir(), `terminal-l1-l2-aggressive-history-real-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  createStorageDb({ dbPath }).close();
  const db = new Database(dbPath);
  const insert = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, 'BTCUSDT', 'PERPETUAL', '78000', '1', 'buy', ?)");
  db.transaction(() => {
    for (let i = 0; i < ROWS; i += 1) insert.run(T0 + i, `t-${i}`);
  })();
  db.close();
  return dbPath;
}

function seededTiedDbPath() {
  const dbPath = path.join(os.tmpdir(), `terminal-l1-l2-aggressive-history-tied-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  createStorageDb({ dbPath }).close();
  const db = new Database(dbPath);
  const insert = db.prepare("INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, 'BTCUSDT', 'PERPETUAL', '78000', '1', 'buy', ?)");
  db.transaction(() => {
    for (let i = 0; i < MAX_AGGRESSIVE_HISTORY_TRADES + 1; i += 1) insert.run(T0, `tied-${i}`);
  })();
  db.close();
  return dbPath;
}

async function until(predicate, label, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const request = (requestId, over = {}) => ({ type: "aggressive_history", request_id: requestId, from_ts: T0, to_ts: T0 + ROWS, min_size: 0, ...over });

describe("aggressive_history through the real storage reader and its worker threads", () => {
  let dbPath;
  let reader;

  beforeAll(() => {
    dbPath = seededDbPath();
  });

  afterEach(() => {
    reader?.close();
    reader = null;
  });

  afterAll(() => {
    try {
      if (dbPath && fs.existsSync(dbPath)) safeRm(dbPath, { force: true });
    } catch {
      void 0;
    }
  });

  function handlerWith(options = {}) {
    reader = createStorageReader({ dbPath });
    const sent = [];
    const handler = createAggressiveHistoryHandler({
      provider: "BINANCE", storageReader: reader, safelySend: (client, frame) => sent.push({ client, frame }), now: () => T0 + ROWS, log: jest.fn(), ...options,
    });
    return { handler, sent };
  }

  test("a window bigger than the cap is paged by the opaque cursor until the terminal page completes it", async () => {
    const { handler, sent } = handlerWith();
    const client = {};
    handler.handle(request(1), client, instrument);
    await until(() => sent.length === 1, "the first reply");
    const first = sent[0].frame;
    expect(first).toMatchObject({ request_id: 1, complete: false, reason: "CAP_REACHED" });
    expect(first.trades).toHaveLength(MAX_AGGRESSIVE_HISTORY_TRADES);
    expect(first.trades.at(-1).ts_exchange).toBe(T0 + ROWS - 1);
    expect(first.next_cursor).toEqual(expect.any(String));
    handler.handle(request(2, { cursor: first.next_cursor }), client, instrument);
    await until(() => sent.length === 2, "the follow-up");
    const second = sent[1].frame;
    expect(second).toMatchObject({ request_id: 2, complete: true, reason: null });
    expect(second.trades.map((trade) => trade.ts_exchange)).toEqual(Array.from({ length: 500 }, (_, i) => T0 + i));
    const ids = new Set([...first.trades, ...second.trades].map((trade) => trade.trade_id));
    expect(ids.size).toBe(ROWS);
    expect(handler.stats()).toMatchObject({ admitted: 2, completed: 2, capped: 1, reading: 0, waiting: 0 });
  });

  test("a capped page with 20,001 records at one millisecond returns every record exactly once", async () => {
    const tiedPath = seededTiedDbPath();
    const tiedReader = createStorageReader({ dbPath: tiedPath });
    const sent = [];
    const handler = createAggressiveHistoryHandler({
      provider: "BINANCE", storageReader: tiedReader, safelySend: (client, frame) => sent.push({ client, frame }), now: () => T0 + ROWS, log: jest.fn(),
    });
    const client = {};
    try {
      handler.handle({ type: "aggressive_history", request_id: 1, from_ts: T0, to_ts: T0 + 1, min_size: 0 }, client, instrument);
      await until(() => sent.length === 1, "the tied first page");
      const first = sent[0].frame;
      expect(first).toMatchObject({ complete: false, reason: "CAP_REACHED", next_cursor: expect.any(String) });
      expect(first.trades).toHaveLength(MAX_AGGRESSIVE_HISTORY_TRADES);
      handler.handle({ type: "aggressive_history", request_id: 2, from_ts: T0, to_ts: T0 + 1, min_size: 0, cursor: first.next_cursor }, client, instrument);
      await until(() => sent.length === 2, "the tied terminal page");
      const second = sent[1].frame;
      expect(second).toMatchObject({ complete: true, reason: null, next_cursor: null });
      expect(second.trades).toHaveLength(1);
      const ids = new Set([...first.trades, ...second.trades].map((trade) => trade.trade_id));
      expect(ids.size).toBe(MAX_AGGRESSIVE_HISTORY_TRADES + 1);
    } finally {
      handler.dispose();
      tiedReader.close();
      try {
        if (fs.existsSync(tiedPath)) safeRm(tiedPath, { force: true });
      } catch {
        void 0;
      }
    }
  });

  test("two clients share the read slots: with one slot the second waits for the first's worker and both are answered in order", async () => {
    const { handler, sent } = handlerWith({ maxConcurrentReads: 1 });
    const a = {};
    const b = {};
    handler.handle(request(1, { to_ts: T0 + 10 }), a, instrument);
    handler.handle(request(2, { to_ts: T0 + 20 }), b, instrument);
    expect(handler.stats()).toMatchObject({ reading: 1, waiting: 1, admitted: 1 });
    await until(() => sent.length === 2, "both replies");
    expect(sent.map(({ client, frame }) => [client === a ? "a" : "b", frame.request_id, frame.trades.length])).toEqual([["a", 1, 10], ["b", 2, 20]]);
    expect(handler.stats()).toMatchObject({ admitted: 2, completed: 2, reading: 0, waiting: 0 });
  });

  test("a client that disconnects while its worker reads gets nothing, and its waiting request never starts", async () => {
    const { handler, sent } = handlerWith();
    const client = {};
    handler.handle(request(1), client, instrument);
    handler.handle(request(2, { to_ts: T0 + 10 }), client, instrument);
    expect(handler.stats()).toMatchObject({ reading: 1, waiting: 1 });
    handler.forget(client);
    await until(() => handler.stats().reading === 0, "the abandoned read to settle");
    expect(sent).toEqual([]);
    expect(handler.stats()).toMatchObject({ admitted: 1, completed: 1, cancelled: 1, waiting: 0 });
  });

  test("dispose and reader close leave no reply and no work behind", async () => {
    const { handler, sent } = handlerWith();
    handler.handle(request(1, { min_size: 1 }), {}, instrument);
    handler.handle(request(2, { min_size: 2 }), {}, instrument);
    handler.handle(request(3, { min_size: 3 }), {}, instrument);
    expect(handler.stats()).toMatchObject({ reading: 2, waiting: 1 });
    handler.dispose();
    reader.close();
    await until(() => handler.stats().reading === 0, "the in-flight reads to settle");
    expect(sent).toEqual([]);
    expect(handler.stats()).toMatchObject({ waiting: 0 });
    const afterClose = await reader.readAggressivePrintsAsync("BTCUSDT", "PERPETUAL", { fromMs: T0, toMs: T0 + 10, minSize: 0, limit: 10 });
    expect(afterClose).toEqual({ rows: [], available: false, hasMore: false, nextCursor: null });
  });
});
