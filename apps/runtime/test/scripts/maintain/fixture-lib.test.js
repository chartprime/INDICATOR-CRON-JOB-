"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const {
  validateInventoryEntry, digestTable, describeTables, nearestRank, summarizeNumbers, perSecond, readInventory, writeInventory,
  upsertInventoryEntry, sha256File, buildBinanceAcceptance, evaluateAcceptance,
} = require("../../../scripts/maintain/fixture-lib");
const { safeRm } = require("../../helpers/temp-files");

const hex = (character) => character.repeat(64);
const validEntry = (overrides = {}) => ({
  id: "binance-btcusdt-spot-4h",
  provider: "binance",
  symbol: "BTCUSDT",
  marketKind: "SPOT",
  window: { fromTs: 1_000, toTs: 2_000 },
  source: { basename: "market-data.sqlite", schemaVersion: 15 },
  exporter: { version: 1 },
  file: { name: "binance-btcusdt-spot-4h.sqlite", sizeBytes: 4096, sha256: hex("a") },
  tables: { trades: { rows: 3, sha256: hex("b") } },
  integrity: { quickCheck: "ok", foreignKeyViolations: 0 },
  stats: { events: { perSecond: 10 } },
  governance: { dataClass: "public-exchange-market-data", retention: "local-only-git-ignored", basis: "public exchange feed captured by the project's own collector" },
  ...overrides,
});

describe("scripts/maintain/fixture-lib", () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-lib-")); });
  afterEach(() => safeRm(dir, { recursive: true, force: true }));

  describe("inventory entry validation", () => {
    test("accepts a complete entry", () => {
      expect(validateInventoryEntry(validEntry())).toEqual([]);
    });

    test.each([
      ["a bad id", { id: "Bad Id" }, /id must be a lowercase slug/],
      ["an unknown provider", { provider: "kraken" }, /provider must be one of/],
      ["an inverted window", { window: { fromTs: 5, toTs: 5 } }, /window must have/],
      ["a source given as a path", { source: { basename: "srv/data/market-data.sqlite", schemaVersion: 15 } }, /bare file name/],
      ["a Windows source path", { source: { basename: "C:\\data\\market-data.sqlite", schemaVersion: 15 } }, /bare file name/],
      ["a file name that is not the id", { file: { name: "other.sqlite", sizeBytes: 1, sha256: hex("a") } }, /file.name must be/],
      ["a short digest", { file: { name: "binance-btcusdt-spot-4h.sqlite", sizeBytes: 1, sha256: "abc" } }, /file.sha256/],
      ["an empty table list", { tables: {} }, /at least one table/],
      ["a table without a digest", { tables: { trades: { rows: 3 } } }, /tables.trades.sha256/],
      ["a failed integrity check", { integrity: { quickCheck: "ok", foreignKeyViolations: 2 } }, /integrity must be ok/],
      ["a missing governance block", { governance: undefined }, /governance.dataClass/],
      ["retention that is not local-only", { governance: { dataClass: "public-exchange-market-data", retention: "public", basis: "x" } }, /local-only-git-ignored/],
      ["governance without a basis", { governance: { dataClass: "public-exchange-market-data", retention: "local-only-git-ignored", basis: "" } }, /governance.basis/],
    ])("rejects %s", (_label, overrides, pattern) => {
      expect(validateInventoryEntry(validEntry(overrides)).join("\n")).toMatch(pattern);
    });

    test.each([
      ["a POSIX host path", "loaded from /srv/terminal-data/capture/live/market-data.sqlite"],
      ["a Windows host path", "exported from C:\\Users\\someone\\data\\market-data.sqlite"],
      ["a Windows path with forward slashes", "see D:/backups/market-data.sqlite"],
      ["a UNC path", "copied from \\\\fileserver\\share\\market-data.sqlite"],
      ["a home directory", "found in /home/ttcollect/market-data.sqlite"],
    ])("rejects an entry that mentions %s", (_label, note) => {
      expect(validateInventoryEntry(validEntry({ notes: note })).join("\n")).toMatch(/notes looks like a host path/);
    });

    test.each(["apiToken", "secret", "password", "credential", "authorization", "bearerValue"])("rejects a %s field anywhere in the entry", (key) => {
      expect(validateInventoryEntry(validEntry({ extra: { nested: { [key]: "x" } } })).join("\n")).toMatch(/looks like a credential field/);
    });

    test("does not mistake ordinary words or short relative strings for paths", () => {
      expect(validateInventoryEntry(validEntry({ notes: "SPOT market data, a 4 h window, 10 events/s" }))).toEqual([]);
    });
  });

  describe("acceptance criteria", () => {
    const reference = {
      window: { fromTs: 0, toTs: 3_600_000 }, events: 36_000, levelsPerEventMean: 14, trades: 43_200, snapshots: 3,
    };

    test("are derived from the production reference: rate bands for events and trades, a band for book depth and a ceiling on the snapshot gap", () => {
      expect(buildBinanceAcceptance({ referenceKey: "ref-hour", reference })).toEqual({
        referenceKey: "ref-hour",
        criteria: [
          { metric: "events.perSecond", min: 8, max: 12.5 },
          { metric: "events.levelsPerEvent.mean", min: 7, max: 28 },
          { metric: "trades.perSecond", min: 6, max: 24 },
          { metric: "snapshots.gapMs.p50", max: 1_200_000 },
        ],
      });
    });

    test("carry no snapshot ceiling when the reference hour had no snapshots", () => {
      const { criteria } = buildBinanceAcceptance({ referenceKey: "ref-hour", reference: { ...reference, snapshots: 0 } });
      expect(criteria.map((criterion) => criterion.metric)).not.toContain("snapshots.gapMs.p50");
    });

    test("are inclusive at both ends and fail just outside them", () => {
      const criteria = [{ metric: "events.perSecond", min: 8, max: 12.5 }];
      for (const [observed, pass] of [[8, true], [12.5, true], [10, true], [7.99, false], [12.51, false]]) {
        expect(evaluateAcceptance({ events: { perSecond: observed } }, criteria)).toEqual({
          results: [{ metric: "events.perSecond", min: 8, max: 12.5, observed, pass }], pass,
        });
      }
    });

    test("treat a missing or non-numeric observation as a failure, never as a pass", () => {
      const criteria = [{ metric: "events.perSecond", min: 1 }, { metric: "snapshots.gapMs.p50", max: 100 }];
      const evaluated = evaluateAcceptance({ events: { perSecond: "fast" }, snapshots: { gapMs: { p50: null } } }, criteria);
      expect(evaluated.pass).toBe(false);
      expect(evaluated.results.map((result) => [result.observed, result.pass])).toEqual([[null, false], [null, false]]);
    });

    test("pass overall only when every criterion passes, and a ceiling-only criterion has no floor", () => {
      const criteria = [{ metric: "snapshots.gapMs.p50", max: 100 }, { metric: "trades.perSecond", min: 5, max: 10 }];
      expect(evaluateAcceptance({ snapshots: { gapMs: { p50: 0 } }, trades: { perSecond: 7 } }, criteria).pass).toBe(true);
      expect(evaluateAcceptance({ snapshots: { gapMs: { p50: 101 } }, trades: { perSecond: 7 } }, criteria).pass).toBe(false);
    });
  });

  describe("statistics helpers", () => {
    test("nearest-rank percentiles, means and rates", () => {
      expect(nearestRank([], 0.5)).toBeNull();
      expect(nearestRank([1, 2, 3, 4], 0.5)).toBe(2);
      expect(nearestRank([1, 2, 3, 4], 0.95)).toBe(4);
      expect(summarizeNumbers([])).toEqual({ mean: null, p50: null, p95: null, max: null });
      expect(summarizeNumbers([3, 1, 2, 10])).toEqual({ mean: 4, p50: 2, p95: 10, max: 10 });
      expect(summarizeNumbers([1, 2, 2])).toEqual({ mean: 1.67, p50: 2, p95: 2, max: 2 });
      expect(perSecond(25, 10_000)).toBe(2.5);
      expect(perSecond(1, 3_000)).toBe(0.33);
      expect(perSecond(5, 0)).toBeNull();
    });
  });

  describe("table digests", () => {
    const makeDb = (rows) => {
      const dbPath = path.join(dir, `${Math.random().toString(36).slice(2)}.sqlite`);
      const db = new Database(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b REAL)");
      const insert = db.prepare("INSERT INTO t (id, a, b) VALUES (?, ?, ?)");
      for (const row of rows) insert.run(...row);
      return db;
    };

    test("count rows and change with any cell, any row order-by key and any added row", () => {
      const base = makeDb([[1, "x", 1.5], [2, "y", 2.5]]);
      const same = makeDb([[2, "y", 2.5], [1, "x", 1.5]]);
      const cell = makeDb([[1, "x", 1.5], [2, "y", 2.6]]);
      const extra = makeDb([[1, "x", 1.5], [2, "y", 2.5], [3, "z", 3]]);
      const original = digestTable(base, "t", "id");
      expect(original.rows).toBe(2);
      expect(digestTable(same, "t", "id")).toEqual(original);
      expect(digestTable(cell, "t", "id").sha256).not.toBe(original.sha256);
      expect(digestTable(extra, "t", "id")).toMatchObject({ rows: 3 });
      expect(digestTable(extra, "t", "id").sha256).not.toBe(original.sha256);
      expect(describeTables(base, [{ table: "t", orderBy: "id" }])).toEqual({ t: original });
      [base, same, cell, extra].forEach((db) => db.close());
    });
  });

  describe("inventory files", () => {
    const inventoryPath = () => path.join(dir, "nested", "inventory.json");

    test("start empty, sort by id on write, and replace an entry with the same id", () => {
      expect(readInventory(inventoryPath())).toEqual({ version: 1, fixtures: [] });
      upsertInventoryEntry(inventoryPath(), { id: "zulu", marker: 1 });
      upsertInventoryEntry(inventoryPath(), { id: "alpha", marker: 2 });
      upsertInventoryEntry(inventoryPath(), { id: "zulu", marker: 3 });
      expect(readInventory(inventoryPath()).fixtures).toEqual([{ id: "alpha", marker: 2 }, { id: "zulu", marker: 3 }]);
      expect(fs.readdirSync(path.dirname(inventoryPath())).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    test("refuse a file that is not an inventory", () => {
      fs.mkdirSync(path.dirname(inventoryPath()), { recursive: true });
      fs.writeFileSync(inventoryPath(), JSON.stringify({ version: 2, fixtures: [] }));
      expect(() => readInventory(inventoryPath())).toThrow(/unsupported inventory format/);
      fs.writeFileSync(inventoryPath(), JSON.stringify({ version: 1 }));
      expect(() => readInventory(inventoryPath())).toThrow(/unsupported inventory format/);
    });

    test("writing is atomic and leaves a trailing newline", () => {
      writeInventory(inventoryPath(), { version: 1, fixtures: [] });
      expect(fs.readFileSync(inventoryPath(), "utf8").endsWith("\n")).toBe(true);
    });
  });

  test("file digests equal the digest of the bytes, including files larger than the read buffer", () => {
    const small = path.join(dir, "small.bin");
    fs.writeFileSync(small, "abc");
    expect(sha256File(small)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const large = path.join(dir, "large.bin");
    const bytes = Buffer.alloc((1 << 20) * 2 + 17, 7);
    fs.writeFileSync(large, bytes);
    expect(sha256File(large)).toBe(require("node:crypto").createHash("sha256").update(bytes).digest("hex"));
  });
});
