"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { verifyFixtures, main, STATUS_OK, STATUS_SKIPPED, STATUS_DRIFT } = require("../../../scripts/verify/verify-fixtures");
const { exportBinanceSlice } = require("../../../scripts/maintain/export-fixture-slice");
const { computeReplayPin } = require("../../../scripts/maintain/fixture-replay-pin");
const { readInventory, writeInventory, upsertInventoryEntry } = require("../../../scripts/maintain/fixture-lib");
const { buildSyntheticBinanceDb } = require("../../helpers/synthetic-binance-db");
const { safeRm } = require("../../helpers/temp-files");

const T0 = 1_700_000_000_000;
const GEOMETRY = { tickSize: 0.5, clusterTicks: 2, rowClusters: 4, windowRows: 200 };

describe("scripts/verify/verify-fixtures", () => {
  let dir;
  let fixtureDir;
  let inventoryPath;

  const exportFixture = async (id, { pin = false, marketKind = "SPOT", seed = 3 } = {}) => {
    const sourcePath = path.join(dir, `${id}-source.sqlite`);
    buildSyntheticBinanceDb({ dbPath: sourcePath, marketKind, seed, startTs: T0, durationMs: 300_000, snapshotEveryMs: 100_000 });
    const result = exportBinanceSlice({
      id, sourcePath, symbol: "BTCUSDT", marketKind, fromTs: T0 + 120_000, toTs: T0 + 240_000, outputDir: fixtureDir,
    });
    if (pin) {
      result.entry.replayPin = await computeReplayPin({
        dbPath: result.path, symbol: "BTCUSDT", marketKind, fromTs: T0 + 120_000, toTs: T0 + 240_000, geometry: GEOMETRY,
      });
    }
    upsertInventoryEntry(inventoryPath, result.entry);
    return result;
  };
  const verify = (overrides = {}) => verifyFixtures({ inventoryPath, fixtureDir, ...overrides });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-fixtures-"));
    fixtureDir = path.join(dir, "fixtures");
    inventoryPath = path.join(dir, "inventory.json");
  });
  afterEach(() => safeRm(dir, { recursive: true, force: true }));

  test("an untouched fixture verifies with no drift", async () => {
    await exportFixture("alpha-fixture", { pin: true });
    const report = await verify({ replay: true });
    expect(report).toMatchObject({ ok: true, checked: 1, skipped: 0 });
    expect(report.results).toEqual([{ id: "alpha-fixture", status: STATUS_OK, drift: [] }]);
  }, 60_000);

  test("a fixture that is not on this machine is skipped with a reason, and is a failure only when presence is required", async () => {
    await exportFixture("alpha-fixture");
    fs.rmSync(path.join(fixtureDir, "alpha-fixture.sqlite"));
    const relaxed = await verify();
    expect(relaxed).toMatchObject({ ok: true, checked: 0, skipped: 1 });
    expect(relaxed.results[0]).toMatchObject({ status: STATUS_SKIPPED, reason: expect.stringMatching(/not present/) });
    expect((await verify({ requirePresent: true })).ok).toBe(false);
  });

  test("a flipped byte in the file is caught by the file digest", async () => {
    const { path: filePath } = await exportFixture("alpha-fixture");
    const bytes = fs.readFileSync(filePath);
    bytes[bytes.length - 100] ^= 0xff;
    fs.writeFileSync(filePath, bytes);
    const report = await verify();
    expect(report.ok).toBe(false);
    expect(report.results[0].status).toBe(STATUS_DRIFT);
    expect(report.results[0].drift.map((item) => item.what)).toContain("file.sha256");
  });

  test("a file that is not a database at all is reported as unreadable drift rather than crashing the run", async () => {
    const { path: filePath } = await exportFixture("alpha-fixture");
    fs.writeFileSync(filePath, "this is not a sqlite database");
    const report = await verify({ replay: true });
    expect(report.ok).toBe(false);
    expect(report.results[0].drift.map((item) => item.what)).toEqual(expect.arrayContaining(["file.sha256", "readable"]));
  });

  test("a changed row is caught by the table digests even when the file is rewritten cleanly", async () => {
    const { path: filePath, entry } = await exportFixture("alpha-fixture");
    const db = new Database(filePath);
    db.prepare("UPDATE trades SET size = '9.999999' WHERE id = (SELECT MIN(id) FROM trades)").run();
    db.close();
    const report = await verify();
    expect(report.ok).toBe(false);
    const changed = report.results[0].drift.find((item) => item.what === "tables");
    expect(changed.expected.trades.sha256).toBe(entry.tables.trades.sha256);
    expect(changed.actual.trades.sha256).not.toBe(entry.tables.trades.sha256);
    expect(changed.actual.trades.rows).toBe(entry.tables.trades.rows);
    expect(report.results[0].drift.map((item) => item.what)).toContain("file.sha256");
  });

  test("density statistics are recomputed, so an inventory that misstates them is caught", async () => {
    await exportFixture("alpha-fixture");
    const inventory = readInventory(inventoryPath);
    inventory.fixtures[0].stats.events.perSecond = 999;
    writeInventory(inventoryPath, inventory);
    const report = await verify();
    expect(report.ok).toBe(false);
    expect(report.results[0].drift.map((item) => item.what)).toEqual(["stats"]);
  });

  describe("acceptance", () => {
    const withReference = async (overrides = {}) => {
      const sourcePath = path.join(dir, "acceptance-source.sqlite");
      buildSyntheticBinanceDb({ dbPath: sourcePath, seed: 3, startTs: T0, durationMs: 300_000, snapshotEveryMs: 100_000 });
      const result = exportBinanceSlice({
        id: "accepted-fixture", sourcePath, symbol: "BTCUSDT", marketKind: "SPOT", fromTs: T0 + 120_000, toTs: T0 + 240_000, outputDir: fixtureDir,
        reference: { referenceKey: "reference-hour", reference: { window: { fromTs: 0, toTs: 3_600_000 }, events: 36_000, levelsPerEventMean: 6.5, trades: 43_200, snapshots: 36, ...overrides } },
        allowFailingAcceptance: overrides.events !== undefined,
      });
      upsertInventoryEntry(inventoryPath, result.entry);
      return result;
    };

    test("a fixture that meets its criteria verifies", async () => {
      await withReference();
      expect((await verify()).ok).toBe(true);
    });

    test("a recorded failing acceptance is reported as drift even though the file itself is intact", async () => {
      await withReference({ events: 3_600 });
      const report = await verify();
      expect(report.ok).toBe(false);
      expect(report.results[0].drift.map((item) => item.what)).toEqual(["acceptance.pass"]);
    });

    test("a tampered acceptance record is caught because the criteria are re-evaluated from recomputed statistics", async () => {
      await withReference();
      const inventory = readInventory(inventoryPath);
      inventory.fixtures[0].acceptance.results[0].observed = 10;
      inventory.fixtures[0].acceptance.results[0].pass = true;
      writeInventory(inventoryPath, inventory);
      const report = await verify();
      expect(report.ok).toBe(false);
      expect(report.results[0].drift.map((item) => item.what)).toContain("acceptance");
    });
  });

  test("the replay pin is only recomputed when asked, and a stale pin is reported as drift", async () => {
    await exportFixture("alpha-fixture", { pin: true });
    const inventory = readInventory(inventoryPath);
    inventory.fixtures[0].replayPin.sha256 = "0".repeat(64);
    writeInventory(inventoryPath, inventory);
    expect((await verify()).ok).toBe(true);
    const report = await verify({ replay: true });
    expect(report.ok).toBe(false);
    expect(report.results[0]).toMatchObject({ status: STATUS_DRIFT });
    expect(report.results[0].drift.map((item) => item.what)).toEqual(["replayPin"]);
  }, 60_000);

  test("recomputes a declared bounded replay-pin window instead of the fixture's full window", async () => {
    const result = await exportFixture("alpha-fixture");
    const pinWindow = { fromTs: T0 + 120_000, toTs: T0 + 180_000 };
    result.entry.replayPin = await computeReplayPin({
      dbPath: result.path, symbol: "BTCUSDT", marketKind: "SPOT", ...pinWindow,
      pinWindow, pageLimit: 1, geometry: GEOMETRY,
    });
    upsertInventoryEntry(inventoryPath, result.entry);
    expect((await verify({ replay: true })).ok).toBe(true);
  }, 60_000);

  test("verifies several fixtures independently and can be limited to named ones", async () => {
    await exportFixture("alpha-fixture");
    await exportFixture("bravo-fixture", { marketKind: "PERPETUAL", seed: 9 });
    const bravo = path.join(fixtureDir, "bravo-fixture.sqlite");
    const db = new Database(bravo);
    db.prepare("UPDATE trades SET side = 'sell' WHERE id = (SELECT MIN(id) FROM trades WHERE side = 'buy')").run();
    db.close();
    const all = await verify();
    expect(all.results.map((result) => [result.id, result.status])).toEqual([["alpha-fixture", STATUS_OK], ["bravo-fixture", STATUS_DRIFT]]);
    expect((await verify({ ids: ["alpha-fixture"] })).ok).toBe(true);
    await expect(verify({ ids: ["missing-fixture"] })).rejects.toThrow(/unknown fixture ids missing-fixture/);
  });

  test("an empty inventory verifies trivially", async () => {
    expect(await verify()).toEqual({ results: [], ok: true, checked: 0, skipped: 0 });
  });

  describe("command line", () => {
    const capture = async (argv) => {
      const written = [];
      const write = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => { written.push(String(chunk)); return true; });
      const previous = process.exitCode;
      process.exitCode = undefined;
      try {
        await main(argv);
        return { output: written.join(""), exitCode: process.exitCode };
      } finally {
        write.mockRestore();
        process.exitCode = previous;
      }
    };

    test("prints one line per fixture, a summary, and exits zero when nothing drifted", async () => {
      await exportFixture("alpha-fixture");
      const { output, exitCode } = await capture(["--inventory", inventoryPath, "--fixture-dir", fixtureDir]);
      expect(output).toContain("OK       alpha-fixture");
      expect(output).toContain("1 verified, 0 skipped, no drift");
      expect(exitCode).toBeUndefined();
    });

    test("exits non-zero and shows what drifted", async () => {
      const { path: filePath } = await exportFixture("alpha-fixture");
      const db = new Database(filePath);
      db.prepare("DELETE FROM trades WHERE id = (SELECT MIN(id) FROM trades)").run();
      db.close();
      const { output, exitCode } = await capture(["--inventory", inventoryPath, "--fixture-dir", fixtureDir]);
      expect(output).toContain("DRIFT    alpha-fixture");
      expect(output).toMatch(/drift in tables: expected .* but found/);
      expect(exitCode).toBe(1);
    });

    test("reports skipped fixtures and rejects unknown arguments", async () => {
      await exportFixture("alpha-fixture");
      fs.rmSync(path.join(fixtureDir, "alpha-fixture.sqlite"));
      const relaxed = await capture(["--inventory", inventoryPath, "--fixture-dir", fixtureDir]);
      expect(relaxed.output).toContain("SKIPPED  alpha-fixture (fixture file is not present on this machine)");
      expect(relaxed.exitCode).toBeUndefined();
      const strict = await capture(["--inventory", inventoryPath, "--fixture-dir", fixtureDir, "--require"]);
      expect(strict.exitCode).toBe(1);
      await expect(main(["--surprise"])).rejects.toThrow(/usage: verify-fixtures/);
    });
  });
});
