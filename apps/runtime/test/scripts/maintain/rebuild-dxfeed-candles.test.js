"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedStorageService } = require("../../../src/storage/dxfeed/dxfeed-storage-service");
const {
  parseArgs, selectInstruments, planRebuild, applyPlan, main,
} = require("../../../scripts/maintain/rebuild-dxfeed-candles");

const MINUTE = 60_000;
const T = Date.UTC(2026, 8, 18, 22, 40);
const SPIKE = T;
const ONLY_INVALID = T + MINUTE;
const NO_SOURCE = T + 2 * MINUTE;
const ALREADY_RIGHT = T + 3 * MINUTE;
const SPREAD = T + 4 * MINUTE;
const NATIVE = T + 5 * MINUTE;
const OUTSIDE = T + 30 * MINUTE;
const WINDOW = Object.freeze({ from: T, to: T + 10 * MINUTE });
const AAPL = Object.freeze({ symbol: "AAPL", assetClass: "EQUITY" });

const TAPE_COLUMNS = "event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, price, size, time, time_nano_part, sequence, exchange_code, extended_trading_hours, aggressor_side, spread_leg, valid_tick, event_kind, provider_index, provider_trade_id, bid_price, ask_price";
const CANDLE_COLUMNS = "ts_open, provider, venue, asset_class, symbol, open, high, low, close, volume, buy_volume, sell_volume, trade_count, derivation";

let dir;
let dbPath;

function seed() {
  const storage = createDxFeedStorageDb({ dbPath });
  const db = storage.raw;
  const tape = db.prepare(`INSERT INTO dxfeed_time_and_sales (${TAPE_COLUMNS}) VALUES (?, ?, 'DXFEED', NULL, 'EQUITY', 'AAPL', 0, 'READY', ?, ?, ?, 0, ?, 'Q', 1, ?, ?, ?, 'NEW', NULL, NULL, NULL, NULL)`);
  const candle = db.prepare(`INSERT INTO dxfeed_candles (${CANDLE_COLUMNS}) VALUES (?, 'DXFEED', NULL, 'EQUITY', 'AAPL', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let sequence = 0;
  const print = (minute, offsetMs, price, size, side, { valid = 1, spread = 0 } = {}) => {
    sequence += 1;
    tape.run(minute + offsetMs, minute + offsetMs, price, size, minute + offsetMs, sequence, side, spread, valid);
  };

  print(SPIKE, 1_000, 363.70, 3, "BUY");
  print(SPIKE, 2_000, 382.48, 1, "BUY", { valid: 0 });
  print(SPIKE, 3_000, 363.74, 2, "SELL");
  candle.run(SPIKE, 363.70, 382.48, 363.70, 363.74, 6, null, null, 3, "TIME_AND_SALE");

  print(ONLY_INVALID, 1_000, 327.05, 5, "SELL", { valid: 0 });
  candle.run(ONLY_INVALID, 327.05, 327.05, 327.05, 327.05, 5, null, null, 1, "TIME_AND_SALE");

  candle.run(NO_SOURCE, 334.00, 334.10, 333.90, 334.05, 10, null, null, 2, "TIME_AND_SALE");

  print(ALREADY_RIGHT, 1_000, 334.50, 4, "BUY");
  print(ALREADY_RIGHT, 2_000, 334.60, 1, "SELL");
  candle.run(ALREADY_RIGHT, 334.50, 334.60, 334.50, 334.60, 5, 4, 1, 2, "TIME_AND_SALE");

  print(SPREAD, 1_000, 335.00, 2, "BUY");
  print(SPREAD, 2_000, 350.00, 9, "SELL", { spread: 1 });
  candle.run(SPREAD, 335.00, 350.00, 335.00, 350.00, 11, 2, 9, 2, "TIME_AND_SALE");

  print(NATIVE, 1_000, 390.00, 1, "BUY", { valid: 0 });
  candle.run(NATIVE, 336.00, 336.20, 335.90, 336.10, 50, 20, 25, 30, "NATIVE");

  print(OUTSIDE, 1_000, 399.00, 1, "BUY", { valid: 0 });
  candle.run(OUTSIDE, 336.00, 399.00, 336.00, 336.00, 1, null, null, 1, "TIME_AND_SALE");
  storage.close();
}

function candleAt(ts) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT open, high, low, close, volume, buy_volume, sell_volume, trade_count, derivation FROM dxfeed_candles WHERE symbol = 'AAPL' AND ts_open = ?").get(ts) ?? null;
  } finally {
    db.close();
  }
}

function plan() {
  const db = new Database(dbPath, { readonly: true });
  try {
    return planRebuild(db, [AAPL], WINDOW);
  } finally {
    db.close();
  }
}

function silentLogger() {
  const entries = [];
  return {
    entries,
    ok: (message, detail) => entries.push({ level: "ok", message, detail }),
    info: (message, detail) => entries.push({ level: "info", message, detail }),
    error: (message, detail) => entries.push({ level: "error", message, detail }),
    flush: () => Promise.resolve(),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-dxfeed-candles-"));
  dbPath = path.join(dir, "dxfeed.sqlite");
  seed();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("rebuild-dxfeed-candles: planning under the live candle rules", () => {
  test("an invalid print no longer sets the high, and the sides come back", () => {
    const minute = plan().minutes.find((entry) => entry.tsOpen === SPIKE);
    expect(minute.action).toBe("replace");
    expect(minute.before.high).toBe(382.48);
    expect(minute.after).toMatchObject({ open: 363.70, high: 363.74, low: 363.70, close: 363.74, volume: 5, buy_volume: 3, sell_volume: 2, trade_count: 2 });
  });

  test("a minute made only of invalid prints is removed, not kept as a bar", () => {
    expect(plan().minutes.find((entry) => entry.tsOpen === ONLY_INVALID)).toMatchObject({ action: "remove", after: null });
  });

  test("a minute whose prints are no longer stored is left alone and reported", () => {
    const result = plan();
    expect(result.minutes.find((entry) => entry.tsOpen === NO_SOURCE)).toMatchObject({ action: "no_source" });
    expect(result.bySymbol.AAPL.noSource).toBe(1);
  });

  test("a minute that already obeys the rules is unchanged", () => {
    expect(plan().minutes.find((entry) => entry.tsOpen === ALREADY_RIGHT).action).toBe("unchanged");
  });

  test("a spread-leg print is excluded from the bar", () => {
    const minute = plan().minutes.find((entry) => entry.tsOpen === SPREAD);
    expect(minute.action).toBe("replace");
    expect(minute.after).toMatchObject({ high: 335.00, close: 335.00, volume: 2, sell_volume: 0 });
  });

  test("native minutes and minutes outside the window are never planned", () => {
    const planned = plan().minutes.map((entry) => entry.tsOpen);
    expect(planned).not.toContain(NATIVE);
    expect(planned).not.toContain(OUTSIDE);
    expect(plan().bySymbol.AAPL).toMatchObject({ reconstructed: 5, replace: 2, remove: 1, unchanged: 1, noSource: 1 });
  });

  test("rejections are counted by stable reason", () => {
    expect(plan().bySymbol.AAPL.rejected).toEqual({ INVALID_TICK: 2, SPREAD_LEG: 1 });
  });
});

describe("rebuild-dxfeed-candles: writing", () => {
  test("write replaces and removes exactly what was planned and touches nothing else", () => {
    const service = createDxFeedStorageService({ dbPath, bootstrap: false });
    const planned = planRebuild(service.getStorageDb().raw, [AAPL], WINDOW);
    expect(applyPlan(service, planned)).toEqual({ replaced: 2, removed: 1 });
    service.close();
    expect(candleAt(SPIKE)).toMatchObject({ high: 363.74, volume: 5, buy_volume: 3, sell_volume: 2, derivation: "TIME_AND_SALE" });
    expect(candleAt(ONLY_INVALID)).toBeNull();
    expect(candleAt(NO_SOURCE)).toMatchObject({ high: 334.10, volume: 10 });
    expect(candleAt(ALREADY_RIGHT)).toMatchObject({ volume: 5, buy_volume: 4, sell_volume: 1 });
    expect(candleAt(NATIVE)).toMatchObject({ high: 336.20, volume: 50, derivation: "NATIVE" });
    expect(candleAt(OUTSIDE)).toMatchObject({ high: 399.00 });
  });

  test("a dry run writes nothing", async () => {
    const before = [SPIKE, ONLY_INVALID, NO_SOURCE, SPREAD, NATIVE, OUTSIDE].map(candleAt);
    const logger = silentLogger();
    const code = await main({ argv: ["--db", dbPath, "--from", String(WINDOW.from), "--to", String(WINDOW.to)], logger, exit: () => {} });
    expect(code).toBe(0);
    expect([SPIKE, ONLY_INVALID, NO_SOURCE, SPREAD, NATIVE, OUTSIDE].map(candleAt)).toEqual(before);
    expect(logger.entries.at(-1).detail).toMatchObject({ mode: "dry-run", bySymbol: { AAPL: { replace: 2, remove: 1 } } });
  });

  test("write refuses while another writer holds the store", async () => {
    const holder = createDxFeedStorageService({ dbPath, bootstrap: false });
    const logger = silentLogger();
    try {
      const code = await main({ argv: ["--db", dbPath, "--from", String(WINDOW.from), "--to", String(WINDOW.to), "--write"], logger, exit: () => {} });
      expect(code).toBe(1);
    } finally {
      holder.close();
    }
    expect(candleAt(SPIKE)).toMatchObject({ high: 382.48 });
  });

  test("the report file lists every planned minute without the internal bar", async () => {
    const report = path.join(dir, "report.json");
    await main({ argv: ["--db", dbPath, "--from", String(WINDOW.from), "--to", String(WINDOW.to), "--report", report], logger: silentLogger(), exit: () => {} });
    const written = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(written.minutes).toHaveLength(5);
    expect(written.minutes.every((minute) => !("bar" in minute))).toBe(true);
    expect(written.widestChanges[0]).toMatchObject({ action: "replace", symbol: "AAPL" });
  });
});

describe("rebuild-dxfeed-candles: arguments", () => {
  test("a window is required and must be minute-aligned and ordered", () => {
    expect(() => parseArgs([])).toThrow(/--from and --to are required/);
    expect(() => parseArgs(["--from", String(T + 1), "--to", String(T + MINUTE)])).toThrow(/whole minute/);
    expect(() => parseArgs(["--from", String(T), "--to", String(T)])).toThrow(/after --from/);
    expect(parseArgs(["--from", "2026-09-18T22:40:00Z", "--to", "2026-09-18T22:50:00Z"])).toMatchObject({ from: T, to: T + 10 * MINUTE, write: false });
  });

  test("a symbol outside the governed catalog is refused rather than guessed", () => {
    expect(() => selectInstruments(["/ESU26:XCME"])).toThrow(/not in the governed dxFeed catalog/);
    expect(selectInstruments(["AAPL"]).map((instrument) => instrument.symbol)).toEqual(["AAPL"]);
  });
});
