const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { createStorageReader } = require("../../../src/storage/storage-reader");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { safeRm } = require("../../helpers/temp-files");
const {
  main,
  parseArgs,
  retentionCutoffMs,
  expiredRowsDeleteSql,
  nextBatchRows,
  TARGETS,
  DAY_MS,
} = require("../../../scripts/maintain/prune-capture-retention");
const { SYMBOL_MARKET_PAIRS } = require("../../../scripts/maintain/maintain-daily-notional-rollup");
const { createDxFeedReplaySource } = require("../../../src/indicators/l2-memory/dxfeed-replay-source");

const NOW_MS = Date.UTC(2026, 9, 25, 3, 30, 0);
const CUTOFF_MS = Date.UTC(2026, 9, 4);
const OLD_MS = CUTOFF_MS - 3 * DAY_MS;
const NEW_MS = CUTOFF_MS + DAY_MS;

function tempDbPath(label) {
  return path.join(os.tmpdir(), `terminal-l1-l2-retention-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function fakeLogger() {
  return { info: jest.fn(), ok: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function fakeClock(startMs = NOW_MS) {
  let current = startMs;
  return {
    now: () => current,
    sleep: jest.fn(async (ms) => { current += ms; }),
    advance: (ms) => { current += ms; },
  };
}

function seedTrade(raw, { id, ts }) {
  raw.prepare("INSERT INTO trades (id, ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, 'BTCUSDT', 'SPOT', '100', '1', 'buy', ?)")
    .run(id, ts, `t${id}`);
}

function seedDepthEvent(raw, { id, ts }) {
  raw.prepare("INSERT INTO l2_depth_events (id, ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, 'BTCUSDT', 'SPOT', ?, ?, NULL, '[]', '[]')")
    .run(id, ts, ts, id, id);
}

function seedSnapshot(raw, { id, ts }) {
  raw.prepare("INSERT INTO l2_depth_snapshots (id, captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, 'BTCUSDT', 'SPOT', ?, '[]', '[]')")
    .run(id, ts, id);
}

function setWatermarks(raw, lastTradeId, pairs = SYMBOL_MARKET_PAIRS) {
  const upsert = raw.prepare("INSERT INTO daily_notional_rollup_watermark (symbol, market_kind, last_trade_id, updated_at) VALUES (?, ?, ?, 1) ON CONFLICT(symbol, market_kind) DO UPDATE SET last_trade_id = excluded.last_trade_id");
  for (const [symbol, marketKind] of pairs) upsert.run(symbol, marketKind, lastTradeId);
}

const DX_COMMON = "event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state";
const DX_COMMON_VALUES = "?, ?, 'DXFEED', NULL, 'FUTURE', '/ESZ26', 0, 'READY'";

function seedDxFeed(raw, table, { id, ts, receivedAt = ts }) {
  if (table === "dxfeed_order_book_capture") {
    raw.prepare(`INSERT INTO dxfeed_order_book_capture (id, ${DX_COMMON}, order_index, event_flags, time, action, price, size, side, scope, source) VALUES (?, ${DX_COMMON_VALUES}, '1', 0, ?, 'NEW', 5000, 1, 'BUY', 'ORDER', 'NTV')`)
      .run(id, ts, receivedAt, ts);
  } else if (table === "dxfeed_time_and_sales") {
    raw.prepare(`INSERT INTO dxfeed_time_and_sales (id, ${DX_COMMON}, price, size, time, time_nano_part, sequence, exchange_code, extended_trading_hours, aggressor_side, spread_leg, valid_tick, event_kind) VALUES (?, ${DX_COMMON_VALUES}, 5000, 1, ?, 0, ?, 'X', 0, 'BUY', 0, 1, 'NEW')`)
      .run(id, ts, ts, ts, id);
  } else if (table === "dxfeed_quotes") {
    raw.prepare(`INSERT INTO dxfeed_quotes (id, ${DX_COMMON}, bid_price, bid_size, bid_time, bid_exchange_code, ask_price, ask_size, ask_time, ask_exchange_code) VALUES (?, ${DX_COMMON_VALUES}, 5000, 1, ?, 'X', 5001, 1, ?, 'X')`)
      .run(id, ts, ts, ts, ts);
  } else {
    raw.prepare(`INSERT INTO dxfeed_trades (id, ${DX_COMMON}, price, size, time, exchange_code, change, day_volume, day_turnover, tick_direction, extended_trading_hours) VALUES (?, ${DX_COMMON_VALUES}, 5000, 1, ?, 'X', 0, 1, 1, 'UP', 0)`)
      .run(id, ts, ts, ts);
  }
}

function ids(raw, table) {
  return raw.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((row) => row.id);
}

function removeDb(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
}

const sourceIdentities = {};

function exportedThrough(throughId, tables = Object.entries(TARGETS)) {
  const targets = {};
  for (const [name, target] of tables) {
    targets[name] = Object.fromEntries(target.tables.map((spec) => [spec.table, { exportedThroughId: throughId, chunkRows: 10 }]));
  }
  return { version: 2, targets, sources: sourceIdentities, destination: { bucket: "chartprime-historical-data", prefix: "raw/live-capture/" } };
}

const EVERYTHING_EXPORTED = exportedThrough(Number.MAX_SAFE_INTEGER - 1);

function run(options) {
  return main({ readWatermark: () => EVERYTHING_EXPORTED, ...options });
}

describe("prune-capture-retention", () => {
  const created = [];
  afterEach(() => {
    while (created.length > 0) removeDb(created.pop());
  });

  function binanceDb(seed) {
    const dbPath = tempDbPath("binance");
    created.push(dbPath);
    const storageDb = createStorageDb({ dbPath });
    sourceIdentities.binance = { path: fs.realpathSync(dbPath).replaceAll("\\", "/"), fileId: String(fs.statSync(dbPath, { bigint: true }).ino), firstSessionId: null };
    seed(storageDb.raw);
    sourceIdentities.binance.firstSessionId = storageDb.raw.prepare("SELECT session_id FROM capture_sessions ORDER BY rowid LIMIT 1").get()?.session_id ?? null;
    storageDb.close();
    return dbPath;
  }

  function dxfeedDb(seed) {
    const dbPath = tempDbPath("dxfeed");
    created.push(dbPath);
    const storageDb = createDxFeedStorageDb({ dbPath });
    sourceIdentities.dxfeed = { path: fs.realpathSync(dbPath).replaceAll("\\", "/"), fileId: String(fs.statSync(dbPath, { bigint: true }).ino), firstSessionId: null };
    seed(storageDb.raw);
    sourceIdentities.dxfeed.firstSessionId = storageDb.raw.prepare("SELECT session_id FROM dxfeed_capture_sessions ORDER BY rowid LIMIT 1").get()?.session_id ?? null;
    storageDb.close();
    return dbPath;
  }

  function open(dbPath) {
    return new Database(dbPath, { fileMustExist: true });
  }

  test("the cutoff is the start of the UTC day the retention reaches back to", () => {
    expect(retentionCutoffMs(NOW_MS, 21)).toBe(CUTOFF_MS);
    expect(retentionCutoffMs(Date.UTC(2026, 9, 25), 21)).toBe(CUTOFF_MS);
    expect(retentionCutoffMs(Date.UTC(2026, 9, 25) - 1, 21)).toBe(CUTOFF_MS - DAY_MS);
  });

  test("Binance: rows before the cutoff are deleted, rows from the cutoff kept, other tables untouched", async () => {
    const dbPath = binanceDb((raw) => {
      for (const [id, ts] of [[1, OLD_MS], [2, OLD_MS + 1], [3, CUTOFF_MS - 1], [4, CUTOFF_MS], [5, NEW_MS]]) {
        seedTrade(raw, { id, ts });
        seedDepthEvent(raw, { id, ts });
        seedSnapshot(raw, { id, ts });
      }
      setWatermarks(raw, 5);
      raw.prepare("INSERT INTO daily_notional_rollup (symbol, market_kind, day_bucket, notional) VALUES ('BTCUSDT', 'SPOT', 0, 1)").run();
    });
    const clock = fakeClock();
    const logger = fakeLogger();
    const exit = jest.fn();

    const code = await run({ argv: ["--target", "binance", "--days", "21", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit });

    expect(code).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
    const raw = open(dbPath);
    for (const table of ["trades", "l2_depth_events", "l2_depth_snapshots"]) expect(ids(raw, table)).toEqual([4, 5]);
    expect(raw.prepare("SELECT count(*) AS n FROM daily_notional_rollup").get().n).toBe(1);
    expect(raw.prepare("SELECT count(*) AS n FROM daily_notional_rollup_watermark").get().n).toBe(4);
    raw.close();
    const [, summary] = logger.ok.mock.calls.find(([message]) => message === "capture retention pass finished");
    expect(summary).toMatchObject({ target: "binance", done: true, cutoff: new Date(CUTOFF_MS).toISOString(), retentionDays: 21 });
    expect(summary.tables.map((table) => [table.table, table.endId, table.deleted])).toEqual([["trades", 5, 3], ["l2_depth_events", 6, 3], ["l2_depth_snapshots", 6, 3]]);
    // The watermark names trade 5, the newest: it is kept and nothing is held back.
    expect(summary.tables[0].heldBy).toBeNull();
  });

  test("Binance trades not yet rolled up are kept even when older than the cutoff", async () => {
    const dbPath = binanceDb((raw) => {
      for (const [id, ts] of [[1, OLD_MS], [2, OLD_MS], [3, OLD_MS], [4, NEW_MS]]) seedTrade(raw, { id, ts });
      setWatermarks(raw, 2);
    });
    const clock = fakeClock();
    const logger = fakeLogger();
    await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    const raw = open(dbPath);
    expect(ids(raw, "trades")).toEqual([2, 3, 4]);
    raw.close();
    const [, summary] = logger.ok.mock.calls[0];
    expect(summary.tables[0]).toMatchObject({ table: "trades", endId: 2, heldBy: "rollup watermark", deleted: 1 });
  });

  test("the trade a rollup watermark names is kept, so the daily notional still reads its materialized days after the pass", async () => {
    const dayBefore = OLD_MS - DAY_MS;
    const dbPath = binanceDb((raw) => {
      for (const [id, ts] of [[1, dayBefore + 1_000], [2, dayBefore + 2_000], [3, OLD_MS + 1_000]]) seedTrade(raw, { id, ts });
      setWatermarks(raw, 3);
      raw.prepare("INSERT INTO daily_notional_rollup (symbol, market_kind, day_bucket, notional) VALUES ('BTCUSDT', 'SPOT', ?, 200)").run(dayBefore);
    });
    const clock = fakeClock();
    await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger: fakeLogger(), now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    const raw = open(dbPath);
    expect(ids(raw, "trades")).toEqual([3]);
    raw.close();
    const reader = createStorageReader({ dbPath });
    try {
      const { rows, available } = reader.readDailyNotional("BTCUSDT", "SPOT", { fromTs: dayBefore, toTs: OLD_MS + DAY_MS });
      expect(available).toBe(true);
      expect(rows).toContainEqual({ dayTs: dayBefore, notional: 200 });
    } finally {
      await reader.close();
    }
  });

  test("each time-ordered delete walks its table's time index, even under a large table's statistics", () => {
    const seeds = {
      trades: seedTrade, l2_depth_events: seedDepthEvent, l2_depth_snapshots: seedSnapshot,
    };
    for (const [name, create] of [["binance", createStorageDb], ["dxfeed", createDxFeedStorageDb]]) {
      const dbPath = tempDbPath(`plan-${name}`);
      created.push(dbPath);
      const storageDb = create({ dbPath });
      const raw = storageDb.raw;
      try {
        for (const spec of TARGETS[name].tables.filter((table) => !table.arrivalPrefix)) {
          for (let id = 1; id <= 50; id += 1) {
            if (name === "binance") seeds[spec.table](raw, { id, ts: OLD_MS + id });
            else seedDxFeed(raw, spec.table, { id, ts: OLD_MS + id });
          }
        }
        // Statistics as a production database carries them: tens of millions of
        // rows, one row per timestamp. Under these SQLite would otherwise scan
        // the whole id range and sort it.
        raw.exec("ANALYZE");
        raw.exec("UPDATE sqlite_stat1 SET stat = '50000000' || substr(stat, instr(stat, ' '))");
        for (const spec of TARGETS[name].tables) if (spec.timeIndex) raw.prepare("UPDATE sqlite_stat1 SET stat = '50000000 1' WHERE idx = ?").run(spec.timeIndex);
        raw.exec("ANALYZE sqlite_schema");
        for (const spec of TARGETS[name].tables.filter((table) => !table.arrivalPrefix)) {
          const plan = raw.prepare(`EXPLAIN QUERY PLAN ${expiredRowsDeleteSql(spec)}`).all(1, 1e12, NOW_MS, 20_000).map((row) => row.detail).join(" | ");
          expect([spec.table, plan]).toEqual([spec.table, expect.stringContaining(`USING COVERING INDEX ${spec.timeIndex} (${spec.timeColumn}<?)`)]);
          expect([spec.table, plan]).toEqual([spec.table, expect.not.stringContaining("TEMP B-TREE")]);
        }
      } finally {
        storageDb.close();
      }
    }
  });

  test("a database whose time index is gone fails the pass instead of being scanned by id", async () => {
    const dbPath = binanceDb((raw) => {
      for (const [id, ts] of [[1, OLD_MS], [2, NEW_MS]]) seedTrade(raw, { id, ts });
      setWatermarks(raw, 2);
      raw.exec("DROP INDEX idx_trades_ts");
    });
    const clock = fakeClock();
    const logger = fakeLogger();
    const code = await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    expect(code).toBe(1);
    expect(logger.error).toHaveBeenCalledWith("capture retention pass failed", expect.objectContaining({ target: "binance", reason: expect.stringMatching(/idx_trades_ts/) }));
    const raw = open(dbPath);
    expect(ids(raw, "trades")).toEqual([1, 2]);
    raw.close();
  });

  test("Binance trades are not deleted at all while any pair has no rollup watermark", async () => {
    const dbPath = binanceDb((raw) => {
      for (const [id, ts] of [[1, OLD_MS], [2, OLD_MS], [3, NEW_MS]]) {
        seedTrade(raw, { id, ts });
        seedDepthEvent(raw, { id, ts });
      }
      setWatermarks(raw, 3, SYMBOL_MARKET_PAIRS.slice(1));
    });
    const clock = fakeClock();
    const logger = fakeLogger();
    await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    const raw = open(dbPath);
    expect(ids(raw, "trades")).toEqual([1, 2, 3]);
    expect(ids(raw, "l2_depth_events")).toEqual([3]);
    raw.close();
    expect(logger.ok.mock.calls[0][1].tables[0]).toMatchObject({ heldBy: "rollup watermark missing", deleted: 0 });
  });

  test("dxFeed: the four large tables are pruned and candles and sessions are left alone", async () => {
    const tables = TARGETS.dxfeed.tables.map((spec) => spec.table);
    const dbPath = dxfeedDb((raw) => {
      for (const table of tables) for (const [id, ts] of [[1, OLD_MS], [2, CUTOFF_MS - 1], [3, CUTOFF_MS], [4, NEW_MS]]) seedDxFeed(raw, table, { id, ts });
      raw.prepare("INSERT INTO dxfeed_capture_sessions (session_id, started_at, quality, clean_shutdown) VALUES ('s1', ?, 'HEALTHY', 1)").run(OLD_MS);
    });
    const clock = fakeClock();
    const logger = fakeLogger();
    const code = await run({ argv: ["--target", "dxfeed", "--dxfeed-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    expect(code).toBe(0);
    const raw = open(dbPath);
    for (const table of tables) expect(ids(raw, table)).toEqual([3, 4]);
    expect(raw.prepare("SELECT count(*) AS n FROM dxfeed_capture_sessions").get().n).toBe(1);
    raw.close();
  });

  test("a row at or after the cutoff is never deleted, even when it sits among older rows by id", async () => {
    const dbPath = dxfeedDb((raw) => {
      for (const [id, ts] of [[1, OLD_MS], [2, NEW_MS], [3, OLD_MS], [4, OLD_MS], [5, NEW_MS], [6, OLD_MS], [7, NEW_MS]]) {
        seedDxFeed(raw, "dxfeed_quotes", { id, ts });
      }
    });
    const clock = fakeClock();
    await run({ argv: ["--target", "dxfeed", "--dxfeed-db", dbPath], logger: fakeLogger(), now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    const after = open(dbPath);
    const kept = after.prepare("SELECT id, event_time FROM dxfeed_quotes ORDER BY id").all();
    after.close();
    expect(kept.filter((row) => row.event_time >= CUTOFF_MS).map((row) => row.id)).toEqual([2, 5, 7]);
    expect(kept.filter((row) => row.event_time < CUTOFF_MS)).toEqual([]);
  });

  test("unordered expired events are removed while dxFeed books keep the complete arrival suffix", async () => {
    const entries = [[1, OLD_MS], [2, NEW_MS], [3, NEW_MS], [4, OLD_MS], [5, CUTOFF_MS]];
    const binancePath = binanceDb((raw) => {
      for (const [id, ts] of entries) {
        seedTrade(raw, { id, ts });
        seedDepthEvent(raw, { id, ts });
        seedSnapshot(raw, { id, ts });
      }
      setWatermarks(raw, 5);
    });
    const dxfeedPath = dxfeedDb((raw) => {
      for (const spec of TARGETS.dxfeed.tables) for (const [id, ts] of entries) seedDxFeed(raw, spec.table, { id, ts });
    });
    const clock = fakeClock();
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await run({ argv: ["--binance-db", binancePath, "--dxfeed-db", dxfeedPath], logger: fakeLogger(), now: clock.now, sleep: clock.sleep, exit: jest.fn() })).toBe(0);
      for (const [name, dbPath] of [["binance", binancePath], ["dxfeed", dxfeedPath]]) {
        const raw = open(dbPath);
        for (const spec of TARGETS[name].tables) expect(ids(raw, spec.table)).toEqual(spec.arrivalPrefix ? [2, 3, 4, 5] : [2, 3, 5]);
        raw.close();
      }
    }
  });

  test("dxFeed retention preserves fresh snapshots containing old native order times and their replay", async () => {
    const dbPath = dxfeedDb((raw) => {
      for (const [id, ts, receivedAt] of [[1, OLD_MS, OLD_MS], [2, NEW_MS, NEW_MS], [3, OLD_MS, NEW_MS + 1], [4, NEW_MS, NEW_MS + 2]]) {
        seedDxFeed(raw, "dxfeed_order_book_capture", { id, ts, receivedAt });
      }
      raw.prepare("UPDATE dxfeed_order_book_capture SET symbol = '/NQZ26:XCME', source = 'GLBX', order_index = CAST(id AS TEXT), price = 100 - id").run();
      raw.prepare("UPDATE dxfeed_order_book_capture SET event_flags = 4 WHERE id = 2").run();
      raw.prepare("UPDATE dxfeed_order_book_capture SET event_flags = 8, side = 'SELL', price = 101 WHERE id = 4").run();
    });
    const replay = () => {
      const source = createDxFeedReplaySource({ dbPath, symbol: "/NQZ26:XCME", assetClass: "FUTURE", fromTs: NEW_MS, toTs: NEW_MS + 10_000, coalesceMs: 0 });
      try { return [...source.frames()]; } finally { source.close(); }
    };
    const before = replay();
    expect(before.filter((frame) => frame.kind === "book")[0].book).toMatchObject({ bids: [[98, 1], [97, 1]], asks: [[101, 1]] });
    const clock = fakeClock();
    expect(await run({ argv: ["--target", "dxfeed", "--dxfeed-db", dbPath], logger: fakeLogger(), now: clock.now, sleep: clock.sleep, exit: jest.fn() })).toBe(0);
    expect(replay()).toEqual(before);
    const raw = open(dbPath);
    expect(ids(raw, "dxfeed_order_book_capture")).toEqual([2, 3, 4]);
    raw.close();
  });

  test("a dxFeed snapshot cut by retention is unavailable until the next complete snapshot", async () => {
    const dbPath = dxfeedDb((raw) => {
      for (const [id, ts, receivedAt] of [[1, CUTOFF_MS, CUTOFF_MS - 1], [2, OLD_MS, CUTOFF_MS], [3, NEW_MS, CUTOFF_MS + 1]]) {
        seedDxFeed(raw, "dxfeed_order_book_capture", { id, ts, receivedAt });
      }
      raw.prepare("UPDATE dxfeed_order_book_capture SET symbol = '/NQZ26:XCME', source = 'GLBX', order_index = CAST(id AS TEXT)").run();
      raw.prepare("UPDATE dxfeed_order_book_capture SET event_flags = 4 WHERE id = 1").run();
      raw.prepare("UPDATE dxfeed_order_book_capture SET event_flags = 8, side = 'SELL', price = 5001 WHERE id = 3").run();
    });
    const clock = fakeClock();
    expect(await run({ argv: ["--target", "dxfeed", "--dxfeed-db", dbPath], logger: fakeLogger(), now: clock.now, sleep: clock.sleep, exit: jest.fn() })).toBe(0);
    const source = createDxFeedReplaySource({ dbPath, symbol: "/NQZ26:XCME", assetClass: "FUTURE", fromTs: CUTOFF_MS, toTs: NEW_MS + 10_000 });
    try { expect([...source.frames()]).toEqual([]); } finally { source.close(); }
  });

  test("a WAL blocked until the deadline causes no deletion", async () => {
    const dbPath = binanceDb((raw) => {
      seedDepthEvent(raw, { id: 1, ts: OLD_MS });
      setWatermarks(raw, 0);
    });
    const statSync = (target) => target.endsWith("-wal") ? { size: 10 } : fs.statSync(target);
    const clock = fakeClock();
    const logger = fakeLogger();
    expect(await run({ argv: ["--target", "binance", "--max-seconds", "1", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, statSync, maxWalBytes: 5, exit: jest.fn() })).toBe(0);
    const raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual([1]);
    raw.close();
    expect(logger.ok.mock.calls[0][1].done).toBe(false);
  });

  test("a WAL stat failure fails closed instead of treating unreadable pressure as zero", async () => {
    const dbPath = binanceDb((raw) => {
      seedDepthEvent(raw, { id: 1, ts: OLD_MS });
      setWatermarks(raw, 0);
    });
    const statSync = (target) => {
      if (target.endsWith("-wal")) throw Object.assign(new Error("WAL access denied"), { code: "EACCES" });
      return fs.statSync(target);
    };
    const logger = fakeLogger();
    expect(await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger, statSync, exit: jest.fn() })).toBe(1);
    const raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual([1]);
    raw.close();
    expect(logger.error).toHaveBeenCalledWith("capture retention pass failed", expect.objectContaining({ code: "EACCES" }));
  });

  test("a blocked first database cannot starve the other database", async () => {
    const binancePath = binanceDb((raw) => {
      seedTrade(raw, { id: 1, ts: OLD_MS });
      seedDepthEvent(raw, { id: 1, ts: OLD_MS });
      seedSnapshot(raw, { id: 1, ts: OLD_MS });
      setWatermarks(raw, 1);
    });
    const dxfeedPath = dxfeedDb((raw) => seedDxFeed(raw, "dxfeed_quotes", { id: 1, ts: OLD_MS }));
    const statSync = (target) => target.endsWith("-wal") ? { size: target === `${binancePath}-wal` ? 10 : 0 } : fs.statSync(target);
    const clock = fakeClock();
    const logger = fakeLogger();
    expect(await run({ argv: ["--max-seconds", "20", "--binance-db", binancePath, "--dxfeed-db", dxfeedPath], logger, now: clock.now, sleep: clock.sleep, statSync, maxWalBytes: 5, exit: jest.fn() })).toBe(0);
    expect(logger.ok.mock.calls.map(([, summary]) => summary.target)).toEqual(["binance", "dxfeed"]);
    const raw = open(dxfeedPath);
    expect(ids(raw, "dxfeed_quotes")).toEqual([]);
    raw.close();
  });

  test("dry run opens each database read only", async () => {
    const dbPath = binanceDb((raw) => setWatermarks(raw, 0));
    const createDb = jest.fn(TARGETS.binance.createDb);
    const clock = fakeClock();
    expect(await run({ argv: ["--target", "binance", "--dry-run", "--binance-db", dbPath], logger: fakeLogger(), now: clock.now, sleep: clock.sleep, targets: { binance: { ...TARGETS.binance, createDb } }, exit: jest.fn() })).toBe(0);
    expect(createDb).toHaveBeenCalledWith(expect.objectContaining({ readonly: true, bootstrap: false }));
  });

  test("a blocked earlier table leaves time for the later tables in that database", async () => {
    const dbPath = binanceDb((raw) => {
      seedDepthEvent(raw, { id: 1, ts: OLD_MS });
      seedSnapshot(raw, { id: 1, ts: OLD_MS });
      setWatermarks(raw, 0);
    });
    const clock = fakeClock();
    const statSync = (target) => target.endsWith("-wal") ? { size: clock.now() < NOW_MS + 10_000 ? 10 : 0 } : fs.statSync(target);
    const logger = fakeLogger();
    expect(await run({ argv: ["--target", "binance", "--max-seconds", "20", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, statSync, maxWalBytes: 5, exit: jest.fn() })).toBe(0);
    const raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual([1]);
    expect(ids(raw, "l2_depth_snapshots")).toEqual([]);
    raw.close();
    expect(logger.ok.mock.calls[0][1].done).toBe(false);
  });

  test("the run stops at its deadline and the next run finishes the work", async () => {
    const dbPath = binanceDb((raw) => {
      raw.transaction(() => {
        for (let id = 1; id <= 20_001; id += 1) seedDepthEvent(raw, { id, ts: OLD_MS });
      })();
      seedDepthEvent(raw, { id: 400_000, ts: NEW_MS });
      setWatermarks(raw, 0);
    });
    const clock = fakeClock();
    clock.sleep.mockImplementation(async (ms) => { clock.advance(ms + 600); });
    const logger = fakeLogger();
    const code = await run({ argv: ["--target", "binance", "--max-seconds", "1", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    expect(code).toBe(0);
    const first = logger.ok.mock.calls[0][1];
    expect(first.done).toBe(false);
    let raw = open(dbPath);
    expect(ids(raw, "l2_depth_events").length).toBeGreaterThan(1);
    raw.close();

    const second = fakeClock();
    const secondLogger = fakeLogger();
    await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger: secondLogger, now: second.now, sleep: second.sleep, exit: jest.fn() });
    expect(secondLogger.ok.mock.calls[0][1].tables.find((table) => table.table === "l2_depth_events").done).toBe(true);
    raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual([400_000]);
    raw.close();
  });

  test("a dry run deletes nothing and reports each table's planned end id", async () => {
    const dbPath = dxfeedDb((raw) => {
      for (const [id, ts] of [[1, OLD_MS], [2, OLD_MS], [3, NEW_MS]]) seedDxFeed(raw, "dxfeed_quotes", { id, ts });
    });
    const clock = fakeClock();
    const logger = fakeLogger();
    await run({ argv: ["--target", "dxfeed", "--dry-run", "--dxfeed-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    const raw = open(dbPath);
    expect(ids(raw, "dxfeed_quotes")).toEqual([1, 2, 3]);
    raw.close();
    const summary = logger.ok.mock.calls[0][1];
    expect(summary).toMatchObject({ dryRun: true, done: false });
    expect(summary.tables.find((table) => table.table === "dxfeed_quotes")).toMatchObject({ startId: 1, endId: 4, deleted: 0 });
  });

  test("a live writer can insert between batches without waiting on the job", async () => {
    const dbPath = binanceDb((raw) => {
      raw.transaction(() => {
        for (let id = 1; id <= 20_001; id += 1) seedDepthEvent(raw, { id, ts: OLD_MS });
      })();
      seedDepthEvent(raw, { id: 200_000, ts: NEW_MS });
      setWatermarks(raw, 0);
    });
    const writer = new Database(dbPath, { fileMustExist: true, timeout: 100 });
    let nextId = 300_000;
    const clock = fakeClock();
    clock.sleep.mockImplementation(async (ms) => {
      clock.advance(ms);
      seedDepthEvent(writer, { id: nextId, ts: nextId === 300_000 ? OLD_MS : NEW_MS });
      nextId += 1;
    });
    const code = await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger: fakeLogger(), now: clock.now, sleep: clock.sleep, exit: jest.fn() });
    writer.close();
    expect(code).toBe(0);
    expect(nextId).toBeGreaterThan(300_000);
    const raw = open(dbPath);
    const kept = ids(raw, "l2_depth_events");
    raw.close();
    expect(kept[0]).toBe(200_000);
    expect(kept.length).toBe(1 + nextId - 300_000);
    expect(kept).toContain(300_000);
    const nextClock = fakeClock();
    expect(await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger: fakeLogger(), now: nextClock.now, sleep: nextClock.sleep, exit: jest.fn() })).toBe(0);
    const nextRaw = open(dbPath);
    expect(ids(nextRaw, "l2_depth_events")).toEqual(kept.filter((id) => id !== 300_000));
    nextRaw.close();
  });

  test("the job waits while the WAL is above its ceiling", async () => {
    const dbPath = binanceDb((raw) => {
      seedDepthEvent(raw, { id: 1, ts: OLD_MS });
      seedDepthEvent(raw, { id: 2, ts: NEW_MS });
      setWatermarks(raw, 0);
    });
    let walChecks = 0;
    const statSync = (target) => {
      if (target.endsWith("-wal")) {
        walChecks += 1;
        return { size: walChecks === 1 ? 10 : 0 };
      }
      return fs.statSync(target);
    };
    const clock = fakeClock();
    await run({ argv: ["--target", "binance", "--binance-db", dbPath], logger: fakeLogger(), now: clock.now, sleep: clock.sleep, statSync, maxWalBytes: 5, exit: jest.fn() });
    expect(clock.sleep).toHaveBeenCalledWith(5_000);
    const raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual([2]);
    raw.close();
  });

  test("a missing database fails the pass without creating a file", async () => {
    const binancePath = tempDbPath("missing-binance");
    const dxfeedPath = tempDbPath("missing-dxfeed");
    created.push(binancePath, dxfeedPath);
    const logger = fakeLogger();
    const exit = jest.fn();
    const code = await run({ argv: ["--binance-db", binancePath, "--dxfeed-db", dxfeedPath], logger, exit });
    expect(code).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.existsSync(binancePath)).toBe(false);
    expect(fs.existsSync(dxfeedPath)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith("capture retention pass failed", expect.objectContaining({ target: "binance" }));
    expect(logger.error).toHaveBeenCalledWith("capture retention pass failed", expect.objectContaining({ target: "dxfeed" }));
  });

  test("options are validated and a bad option exits as a configuration error", async () => {
    expect(parseArgs([])).toMatchObject({ target: "all", days: 21, maxSeconds: 3_600, dryRun: false });
    expect(() => parseArgs(["--target", "kraken"])).toThrow("unknown target kraken");
    expect(() => parseArgs(["--days", "0"])).toThrow("--days must be a positive integer");
    expect(() => parseArgs(["--max-seconds", "1.5"])).toThrow("--max-seconds must be a positive integer");
    expect(() => parseArgs(["--days"])).toThrow("unknown or incomplete option --days");
    const exit = jest.fn();
    expect(await run({ argv: ["--bogus"], logger: fakeLogger(), exit })).toBe(2);
    expect(exit).toHaveBeenCalledWith(2);
  });

  test("batch size adapts toward the target batch time within its bounds", () => {
    expect(nextBatchRows(20_000, 1_000)).toBe(10_000);
    expect(nextBatchRows(1_500, 1_000)).toBe(1_000);
    expect(nextBatchRows(20_000, 10)).toBe(40_000);
    expect(nextBatchRows(150_000, 10)).toBe(200_000);
    expect(nextBatchRows(20_000, 250)).toBe(20_000);
  });

  test("expired rows above the capture export watermark are kept until they are exported", async () => {
    const dbPath = binanceDb((raw) => {
      for (let id = 1; id <= 30; id += 1) seedDepthEvent(raw, { id, ts: OLD_MS + id });
      setWatermarks(raw, 0);
    });
    const clock = fakeClock();
    const logger = fakeLogger();
    const code = await main({
      argv: ["--target", "binance", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit: jest.fn(),
      readWatermark: () => exportedThrough(20),
    });
    expect(code).toBe(0);
    const raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual(Array.from({ length: 10 }, (_, index) => 21 + index));
    raw.close();
    expect(logger.ok.mock.calls[0][1].tables.find((table) => table.table === "l2_depth_events"))
      .toMatchObject({ endId: 21, heldBy: "export watermark", deleted: 20 });
  });

  test("a table the export watermark does not name is not pruned at all", async () => {
    const dbPath = binanceDb((raw) => {
      for (let id = 1; id <= 5; id += 1) {
        seedDepthEvent(raw, { id, ts: OLD_MS });
        seedSnapshot(raw, { id, ts: OLD_MS });
      }
      setWatermarks(raw, 0);
    });
    const watermark = exportedThrough(100, [["binance", TARGETS.binance]]);
    delete watermark.targets.binance.l2_depth_snapshots;
    const clock = fakeClock();
    const logger = fakeLogger();
    await main({
      argv: ["--target", "binance", "--binance-db", dbPath], logger, now: clock.now, sleep: clock.sleep, exit: jest.fn(),
      readWatermark: () => watermark,
    });
    const raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual([]);
    expect(ids(raw, "l2_depth_snapshots")).toEqual([1, 2, 3, 4, 5]);
    raw.close();
    expect(logger.ok.mock.calls[0][1].tables.find((table) => table.table === "l2_depth_snapshots"))
      .toMatchObject({ heldBy: "export watermark missing", deleted: 0 });
  });

  test("a missing or malformed export watermark file holds every database and fails the run", async () => {
    const dbPath = binanceDb((raw) => {
      seedDepthEvent(raw, { id: 1, ts: OLD_MS });
      setWatermarks(raw, 0);
    });
    const malformed = tempDbPath("watermark-v2");
    created.push(malformed);
    fs.writeFileSync(malformed, JSON.stringify({ ...exportedThrough(0), version: 3 }));
    for (const watermarkPath of [tempDbPath("watermark-missing"), malformed]) {
      const logger = fakeLogger();
      const exit = jest.fn();
      const code = await main({
        argv: ["--target", "binance", "--binance-db", dbPath, "--export-watermark", watermarkPath], logger, exit,
      });
      expect(code).toBe(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(logger.error).toHaveBeenCalledWith("capture retention held: the export watermark is missing or unreadable",
        expect.objectContaining({ watermarkPath }));
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.ok).not.toHaveBeenCalled();
    }
    const raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual([1]);
    raw.close();
  });

  test("a watermark from a replaced database cannot authorize deleting its new rows", async () => {
    const dbPath = binanceDb((raw) => {
      seedDepthEvent(raw, { id: 1, ts: OLD_MS });
      setWatermarks(raw, 0);
    });
    const watermarkPath = tempDbPath("foreign-watermark");
    created.push(watermarkPath);
    const watermark = exportedThrough(1);
    watermark.sources = { binance: { path: fs.realpathSync(dbPath).replaceAll("\\", "/"), fileId: "0", firstSessionId: null } };
    fs.writeFileSync(watermarkPath, JSON.stringify(watermark));
    expect(await main({ argv: ["--target", "binance", "--binance-db", dbPath, "--export-watermark", watermarkPath], logger: fakeLogger(), exit: jest.fn() })).toBe(1);
    const raw = open(dbPath);
    try { expect(ids(raw, "l2_depth_events")).toEqual([1]); } finally { raw.close(); }
  });

  test("a new capture generation cannot reuse a checkpoint even if the file id matches", async () => {
    const dbPath = binanceDb((raw) => {
      seedDepthEvent(raw, { id: 1, ts: OLD_MS });
      setWatermarks(raw, 0);
    });
    const watermark = exportedThrough(1);
    watermark.sources = { ...sourceIdentities, binance: { ...sourceIdentities.binance, firstSessionId: "previous-generation" } };
    const logger = fakeLogger();
    expect(await main({ argv: ["--target", "binance", "--binance-db", dbPath], logger, readWatermark: () => watermark, exit: jest.fn() })).toBe(1);
    const raw = open(dbPath);
    try { expect(ids(raw, "l2_depth_events")).toEqual([1]); } finally { raw.close(); }
  });

  test("the export watermark is read from the file the option names", async () => {
    const dbPath = binanceDb((raw) => {
      for (let id = 1; id <= 4; id += 1) seedDepthEvent(raw, { id, ts: OLD_MS });
      setWatermarks(raw, 0);
    });
    const watermarkPath = tempDbPath("watermark");
    created.push(watermarkPath);
    fs.writeFileSync(watermarkPath, JSON.stringify(exportedThrough(2)));
    const clock = fakeClock();
    await main({
      argv: ["--target", "binance", "--binance-db", dbPath, "--export-watermark", watermarkPath],
      logger: fakeLogger(), now: clock.now, sleep: clock.sleep, exit: jest.fn(),
    });
    const raw = open(dbPath);
    expect(ids(raw, "l2_depth_events")).toEqual([3, 4]);
    raw.close();
    expect(parseArgs([]).exportWatermarkPath).toBe("/var/lib/terminal-l1-l2/capture-export/watermark.json");
  });
});
