"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { exportBinanceSlice, FixtureExportError, parseDuration, parseInstant, main } = require("../../../scripts/maintain/export-fixture-slice");
const { sha256File, readInventory, validateInventoryEntry } = require("../../../scripts/maintain/fixture-lib");
const { createReplaySource } = require("../../../src/indicators/l2-memory/replay-source");
const { verifyStorageIntegrity } = require("../../../src/storage/storage-db");
const { buildSyntheticBinanceDb } = require("../../helpers/synthetic-binance-db");
const { safeRm } = require("../../helpers/temp-files");

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

function replayFrames(dbPath, marketKind, fromTs, toTs) {
  const source = createReplaySource({ dbPath, symbol: "BTCUSDT", marketKind, fromTs, toTs });
  try {
    return { frames: [...source.frames()], stats: { ...source.stats } };
  } finally {
    source.close();
  }
}

describe("scripts/maintain/export-fixture-slice", () => {
  let dir;
  let sourcePath;
  let outputDir;
  let inventoryPath;

  const buildSource = (overrides = {}) => buildSyntheticBinanceDb({
    dbPath: sourcePath, startTs: T0, durationMs: 10 * MINUTE, snapshotEveryMs: 2 * MINUTE, ...overrides,
  });
  const exportSlice = (overrides = {}) => exportBinanceSlice({
    id: "test-slice", sourcePath, symbol: "BTCUSDT", marketKind: "SPOT", fromTs: T0 + 250_000, toTs: T0 + 500_000, outputDir, ...overrides,
  });
  const scalar = (dbPath, sql, ...params) => {
    const db = new Database(dbPath, { readonly: true });
    try { return db.prepare(sql).pluck().get(...params); } finally { db.close(); }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-export-"));
    sourcePath = path.join(dir, "source", "market-data.sqlite");
    outputDir = path.join(dir, "out");
    inventoryPath = path.join(dir, "inventory", "inventory.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  });

  afterEach(() => safeRm(dir, { recursive: true, force: true }));

  describe("what the slice contains", () => {
    test("replaying the slice produces exactly the frames replaying the full source produces, for both market kinds", () => {
      for (const marketKind of ["SPOT", "PERPETUAL"]) {
        fs.rmSync(sourcePath, { force: true });
        buildSource({ marketKind });
        const result = exportSlice({ id: `equivalence-${marketKind.toLowerCase()}`, marketKind });
        const original = replayFrames(sourcePath, marketKind, T0 + 250_000, T0 + 500_000);
        const sliced = replayFrames(result.path, marketKind, T0 + 250_000, T0 + 500_000);
        expect(original.frames.length).toBeGreaterThan(4_000);
        expect(sliced.stats).toEqual(original.stats);
        expect(sliced.frames).toEqual(original.frames);
        expect(original.stats.gaps).toBe(0);
      }
    });

    test("includes the newest snapshot at or before the window start, every snapshot inside it, and events from the anchor minus the slack", () => {
      buildSource();
      const { entry } = exportSlice();
      expect(entry.window).toMatchObject({
        fromTs: T0 + 250_000, toTs: T0 + 500_000, anchorCapturedAt: T0 + 240_000, eventFromTs: T0 + 240_000 - 60_000, tradeFromTs: T0 + 240_000,
      });
      const slicePath = path.join(outputDir, "test-slice.sqlite");
      expect(scalar(slicePath, "SELECT MIN(captured_at) FROM l2_depth_snapshots")).toBe(T0 + 240_000);
      expect(scalar(slicePath, "SELECT COUNT(*) FROM l2_depth_snapshots")).toBe(3);
      expect(scalar(slicePath, "SELECT MIN(ts) FROM l2_depth_events")).toBeGreaterThanOrEqual(T0 + 180_000);
      expect(scalar(slicePath, "SELECT MAX(ts) FROM l2_depth_events")).toBeLessThanOrEqual(T0 + 500_000);
      const expectedEvents = scalar(sourcePath, "SELECT COUNT(*) FROM l2_depth_events WHERE ts BETWEEN ? AND ?", T0 + 180_000, T0 + 500_000);
      expect(entry.tables.l2_depth_events.rows).toBe(expectedEvents);
      const expectedTrades = scalar(sourcePath, "SELECT COUNT(*) FROM trades WHERE ts BETWEEN ? AND ?", T0 + 240_000, T0 + 500_000);
      expect(entry.tables.trades.rows).toBe(expectedTrades);
    });

    test("preserves the original row ids so replay ordering is untouched", () => {
      buildSource();
      const { path: slicePath } = exportSlice();
      const sourceIds = new Database(sourcePath, { readonly: true }).prepare("SELECT id FROM l2_depth_events WHERE ts BETWEEN ? AND ? ORDER BY id").pluck().all(T0 + 180_000, T0 + 500_000);
      const sliceIds = new Database(slicePath, { readonly: true }).prepare("SELECT id FROM l2_depth_events ORDER BY id").pluck().all();
      expect(sliceIds).toEqual(sourceIds);
    });

    test("falls back to the first snapshot inside the window when none exists before it, exactly as replay does", () => {
      buildSource();
      const result = exportSlice({ id: "anchor-after", fromTs: T0 - 5_000, toTs: T0 + 60_000 });
      expect(result.entry.window.anchorCapturedAt).toBe(T0);
      const original = replayFrames(sourcePath, "SPOT", T0 - 5_000, T0 + 60_000);
      expect(replayFrames(result.path, "SPOT", T0 - 5_000, T0 + 60_000).frames).toEqual(original.frames);
    });

    test("refuses a window that cannot be replayed and leaves nothing behind", () => {
      buildSource();
      expect(() => exportSlice({ id: "no-anchor", fromTs: T0 - 20_000, toTs: T0 - 1_000 })).toThrow(/NO_ANCHOR/);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    test("copies the capture sessions that overlap the window and their incidents, and excludes the rest", () => {
      buildSource();
      const writer = new Database(sourcePath);
      const session = writer.prepare("INSERT INTO capture_sessions (session_id, started_at, ended_at, quality, clean_shutdown, termination_reason) VALUES (?, ?, ?, ?, ?, ?)");
      session.run("overlapping", T0 + 200_000, T0 + 400_000, "HEALTHY", 1, "planned");
      session.run("before", T0, T0 + 100_000, "HEALTHY", 1, "planned");
      const incident = writer.prepare("INSERT INTO capture_incidents (session_id, ts, severity, event, affected_count, details) VALUES (?, ?, 'DEGRADED', ?, 1, '{}')");
      incident.run("overlapping", T0 + 300_000, "inside");
      incident.run("overlapping", T0 + 450_000, "also-inside");
      incident.run("before", T0 + 50_000, "excluded");
      writer.pragma("wal_checkpoint(TRUNCATE)");
      writer.close();
      const { path: slicePath, entry } = exportSlice();
      expect(scalar(slicePath, "SELECT group_concat(session_id) FROM capture_sessions")).toBe("overlapping");
      expect(scalar(slicePath, "SELECT group_concat(event) FROM (SELECT event FROM capture_incidents ORDER BY id)")).toBe("inside,also-inside");
      expect(entry.integrity).toEqual({ quickCheck: "ok", foreignKeyViolations: 0 });
    });
  });

  describe("consistency and safety of the read", () => {
    test("reads every table from one snapshot: rows committed by a live writer mid-export never reach the slice", () => {
      buildSource();
      const beforeEvents = scalar(sourcePath, "SELECT COUNT(*) FROM l2_depth_events WHERE ts BETWEEN ? AND ?", T0 + 180_000, T0 + 500_000);
      const maxIdBefore = scalar(sourcePath, "SELECT MAX(id) FROM l2_depth_events");
      const result = exportSlice({
        hooks: {
          afterTable(table) {
            if (table !== "trades") return;
            const writer = new Database(sourcePath);
            const insert = writer.prepare("INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, 'BTCUSDT', 'SPOT', ?, ?, NULL, '[]', '[]')");
            for (let index = 0; index < 5; index += 1) insert.run(T0 + 490_000 + index, T0 + 490_001 + index, 9_000_000 + index, 9_000_000 + index);
            writer.close();
          },
        },
      });
      expect(scalar(sourcePath, "SELECT COUNT(*) FROM l2_depth_events WHERE ts BETWEEN ? AND ?", T0 + 180_000, T0 + 500_000)).toBe(beforeEvents + 5);
      expect(result.entry.tables.l2_depth_events.rows).toBe(beforeEvents);
      expect(scalar(result.path, "SELECT COUNT(*) FROM l2_depth_events WHERE first_update_id >= 9000000")).toBe(0);
      expect(result.entry.source.maxIds.l2_depth_events).toBe(maxIdBefore);
      expect(result.entry.source.advancedDuringExport).toBe(true);
    });

    test("an idle source is reported as not having advanced", () => {
      buildSource();
      expect(exportSlice().entry.source.advancedDuringExport).toBe(false);
    });

    test("a source file replaced while it is being read discards the slice", () => {
      buildSource();
      let calls = 0;
      expect(() => exportSlice({ hooks: { identityOf: () => { calls += 1; return { dev: 1, ino: calls === 1 ? 10 : 11, sizeBytes: 500 }; } } }))
        .toThrow(/SOURCE_REPLACED_DURING_EXPORT/);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    test("a source file that shrinks while it is being read discards the slice, but one that merely grows is exported and flagged", () => {
      buildSource();
      let calls = 0;
      expect(() => exportSlice({ hooks: { identityOf: () => { calls += 1; return { dev: 1, ino: 10, sizeBytes: calls === 1 ? 500 : 100 }; } } }))
        .toThrow(/SOURCE_REPLACED_DURING_EXPORT/);
      calls = 0;
      const grown = exportSlice({ hooks: { identityOf: () => { calls += 1; return { dev: 1, ino: 10, sizeBytes: calls === 1 ? 500 : 900 }; } } });
      expect(grown.entry.source.advancedDuringExport).toBe(true);
    });

    test("never modifies the source: the file digest is identical and the source cannot be written through the export connection", () => {
      buildSource();
      const before = sha256File(sourcePath);
      exportSlice();
      expect(sha256File(sourcePath)).toBe(before);
    });

    test("accepts a schema v15 source without touching it, and writes a current-schema fixture", () => {
      buildSource();
      const legacy = new Database(sourcePath);
      legacy.exec("DROP TABLE daily_notional_rollup; DROP TABLE daily_notional_rollup_watermark; UPDATE storage_schema SET version = 15;");
      legacy.pragma("wal_checkpoint(TRUNCATE)");
      legacy.close();
      const before = sha256File(sourcePath);
      const result = exportSlice();
      expect(result.entry.source.schemaVersion).toBe(15);
      expect(verifyStorageIntegrity({ dbPath: result.path })).toMatchObject({ schemaVersion: 16, integrity: "ok" });
      expect(scalar(sourcePath, "SELECT version FROM storage_schema")).toBe(15);
      expect(sha256File(sourcePath)).toBe(before);
    });

    test("rejects a source schema it does not know how to map", () => {
      buildSource();
      const old = new Database(sourcePath);
      old.exec("UPDATE storage_schema SET version = 14");
      old.pragma("wal_checkpoint(TRUNCATE)");
      old.close();
      expect(() => exportSlice()).toThrow(/UNSUPPORTED_SOURCE_SCHEMA.*14/);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    test("leaves no temp or sidecar files on success", () => {
      buildSource();
      exportSlice();
      expect(fs.readdirSync(outputDir)).toEqual(["test-slice.sqlite"]);
    });
  });

  describe("reproducibility and the inventory", () => {
    test("exporting the same window twice produces a byte-identical file and identical table digests", () => {
      buildSource();
      const first = exportSlice();
      const second = exportSlice({ overwrite: true });
      expect(second.entry.file.sha256).toBe(first.entry.file.sha256);
      expect(second.entry.file.sizeBytes).toBe(first.entry.file.sizeBytes);
      expect(second.entry.tables).toEqual(first.entry.tables);
      expect(sha256File(first.path)).toBe(first.entry.file.sha256);
    });

    test("a window with different contents produces different digests, and two windows sharing an anchor and an end produce the same slice", () => {
      buildSource();
      const first = exportSlice();
      const second = exportSlice({ id: "other-window", toTs: T0 + 400_000 });
      expect(second.entry.file.sha256).not.toBe(first.entry.file.sha256);
      expect(second.entry.tables.trades.sha256).not.toBe(first.entry.tables.trades.sha256);
      const sameAnchor = exportSlice({ id: "same-anchor", fromTs: T0 + 300_000 });
      expect(sameAnchor.entry.file.sha256).toBe(first.entry.file.sha256);
    });

    test("every exported entry passes inventory validation and carries the governance basis for keeping the data", () => {
      buildSource();
      const { entry } = exportSlice();
      expect(validateInventoryEntry(entry)).toEqual([]);
      expect(entry.governance).toMatchObject({ dataClass: "public-exchange-market-data", retention: "local-only-git-ignored" });
      expect(entry.file.journalMode).toBe("delete");
    });

    describe("acceptance against a production reference", () => {
      const reference = (overrides = {}) => ({
        referenceKey: "reference-hour",
        reference: { window: { fromTs: 0, toTs: 3_600_000 }, events: 36_000, levelsPerEventMean: 6.5, trades: 43_200, snapshots: 30, ...overrides },
      });

      test("a window that matches the reference records its criteria, observed values and a pass", () => {
        buildSource({ eventsPerSecond: 10, tradesPerSecond: 12, snapshotEveryMs: 2 * MINUTE });
        const { entry } = exportSlice({ reference: reference() });
        expect(entry.acceptance).toMatchObject({ referenceKey: "reference-hour", pass: true });
        expect(entry.acceptance.results.map((result) => [result.metric, result.pass])).toEqual([
          ["events.perSecond", true], ["events.levelsPerEvent.mean", true], ["trades.perSecond", true], ["snapshots.gapMs.p50", true],
        ]);
        expect(entry.acceptance.results.every((result) => Number.isFinite(result.observed))).toBe(true);
        expect(validateInventoryEntry(entry)).toEqual([]);
      });

      test("a window that does not match is refused with the metrics that failed, and leaves nothing behind", () => {
        buildSource({ eventsPerSecond: 10, tradesPerSecond: 12 });
        expect(() => exportSlice({ id: "too-dense", reference: reference({ events: 3_600, trades: 4_320 }) }))
          .toThrow(/ACCEPTANCE_FAILED.*events\.perSecond=.*outside \[0\.8, 1\.25\]/);
        expect(fs.readdirSync(outputDir)).toEqual([]);
      });

      test("the override exports a failing window but records the failure, so it cannot pass as conforming", () => {
        buildSource({ eventsPerSecond: 10, tradesPerSecond: 12 });
        const { entry } = exportSlice({ id: "override", reference: reference({ events: 3_600, trades: 4_320 }), allowFailingAcceptance: true });
        expect(entry.acceptance.pass).toBe(false);
        expect(entry.acceptance.results.filter((result) => !result.pass).map((result) => result.metric)).toContain("events.perSecond");
      });

      test("a sparser snapshot cadence than production fails the snapshot ceiling", () => {
        buildSource({ eventsPerSecond: 10, tradesPerSecond: 12, snapshotEveryMs: 4 * MINUTE });
        expect(() => exportSlice({ id: "sparse", reference: reference({ snapshots: 60 }) })).toThrow(/snapshots\.gapMs\.p50=240000 outside \[-, 60000\]/);
      });
    });

    test("refuses to overwrite an existing fixture unless asked, leaving the original intact", () => {
      buildSource();
      const first = exportSlice();
      expect(() => exportSlice()).toThrow(/OUTPUT_EXISTS/);
      expect(sha256File(first.path)).toBe(first.entry.file.sha256);
    });

    test("records density statistics computed from the exported rows", () => {
      buildSource({ eventsPerSecond: 10, tradesPerSecond: 12, snapshotEveryMs: 2 * MINUTE });
      const { stats } = exportSlice().entry;
      expect(stats.windowMs).toBe(250_000);
      expect(stats.events.perSecond).toBeGreaterThan(9.5);
      expect(stats.events.perSecond).toBeLessThan(10.5);
      expect(stats.trades.perSecond).toBeGreaterThan(11);
      expect(stats.trades.perSecond).toBeLessThan(13);
      expect(stats.snapshots.gapMs.p50).toBe(2 * MINUTE);
      expect(stats.snapshots.gapMs.max).toBe(2 * MINUTE);
      expect(stats.events.levelsPerEvent.mean).toBeGreaterThan(2);
      expect(stats.events.levelsPerEvent.p95).toBeGreaterThanOrEqual(stats.events.levelsPerEvent.mean);
    });

    test("writes a sorted inventory entry, replaces an entry with the same id, and carries no host paths", () => {
      buildSource();
      exportSlice({ id: "zulu-slice", inventoryPath });
      exportSlice({ id: "alpha-slice", inventoryPath });
      exportSlice({ id: "zulu-slice", inventoryPath, overwrite: true });
      const inventory = readInventory(inventoryPath);
      expect(inventory.fixtures.map((fixture) => fixture.id)).toEqual(["alpha-slice", "zulu-slice"]);
      const serialized = JSON.stringify(inventory);
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain(os.tmpdir());
      expect(inventory.fixtures[0].source.basename).toBe("market-data.sqlite");
      expect(inventory.fixtures[0].file.name).toBe("alpha-slice.sqlite");
      expect(inventory.fixtures[0].exporter).toMatchObject({ version: 1, appSchemaVersion: 16, anchorSlackMs: 60_000 });
    });
  });

  describe("request validation", () => {
    test.each([
      ["a bad id", { id: "Bad Id" }, /INVALID_ID/],
      ["a missing source", { sourcePath: "no/such/file.sqlite" }, /SOURCE_MISSING/],
      ["an unknown market kind", { marketKind: "MARGIN" }, /INVALID_MARKET_KIND/],
      ["an empty symbol", { symbol: "" }, /INVALID_SYMBOL/],
      ["an inverted window", { fromTs: T0 + 500_000, toTs: T0 + 250_000 }, /INVALID_WINDOW/],
      ["a fractional bound", { fromTs: T0 + 0.5 }, /INVALID_WINDOW/],
      ["a window longer than eight days", { toTs: T0 + 9 * 24 * 60 * MINUTE }, /INVALID_WINDOW/],
    ])("rejects %s before opening anything", (_label, overrides, pattern) => {
      buildSource();
      expect(() => exportSlice(overrides)).toThrow(pattern);
      expect(fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []).toEqual([]);
    });

    test("failures are typed so callers can tell them apart", () => {
      buildSource();
      try {
        exportSlice({ id: "x" });
      } catch (error) {
        expect(error).toBeInstanceOf(FixtureExportError);
        expect(error.code).toBe("INVALID_ID");
      }
    });
  });

  describe("command line", () => {
    test("parses durations and instants", () => {
      expect(parseDuration("90s")).toBe(90_000);
      expect(parseDuration("4h")).toBe(14_400_000);
      expect(parseDuration("30m")).toBe(1_800_000);
      expect(parseDuration("500ms")).toBe(500);
      expect(() => parseDuration("4 hours")).toThrow(/INVALID_DURATION/);
      expect(parseInstant("1700000000000")).toBe(1_700_000_000_000);
      expect(parseInstant("2023-11-14T22:13:20.000Z")).toBe(1_700_000_000_000);
      expect(() => parseInstant("yesterday")).toThrow(/INVALID_INSTANT/);
    });

    const runCli = async (extra = []) => {
      const written = [];
      const write = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => { written.push(String(chunk)); return true; });
      try {
        await main([
          "--source", sourcePath, "--id", "cli-slice", "--symbol", "BTCUSDT", "--market-kind", "SPOT",
          "--from", String(T0 + 250_000), "--duration", "250s", "--output-dir", outputDir, "--inventory", inventoryPath,
          "--tick-size", "0.5", "--cluster-ticks", "2", "--row-clusters", "4", "--window-rows", "200", ...extra,
        ]);
      } finally {
        write.mockRestore();
      }
      return JSON.parse(written.join(""));
    };

    test("exports end to end, pins the replay, and records both in the inventory", async () => {
      buildSource();
      const printed = await runCli();
      expect(printed.fileSha256).toBe(sha256File(path.join(outputDir, "cli-slice.sqlite")));
      const [entry] = readInventory(inventoryPath).fixtures;
      expect(entry.file.sha256).toBe(printed.fileSha256);
      expect(entry.replayPin).toMatchObject({
        geometry: { tickSize: 0.5, clusterTicks: 2, rowClusters: 4, windowRows: 200 }, pages: expect.any(Number), frames: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(printed.replayPin).toEqual(entry.replayPin);
    }, 60_000);

    test("--pin-duration and --pin-pages record a bounded semantic prefix without shrinking the fixture", async () => {
      buildSource();
      const printed = await runCli(["--pin-duration", "200s", "--pin-pages", "1"]);
      const [entry] = readInventory(inventoryPath).fixtures;
      expect(entry.window).toMatchObject({ fromTs: T0 + 250_000, toTs: T0 + 500_000 });
      expect(entry.replayPin.window).toEqual({ fromTs: T0 + 250_000, toTs: T0 + 450_000 });
      expect(entry.replayPin).toMatchObject({ pageLimit: 1, pages: 1, complete: false });
      expect(printed.replayPin).toEqual(entry.replayPin);
    }, 60_000);

    test("--reference attaches acceptance from a reference file, and an unknown reference or failing window is refused", async () => {
      buildSource({ eventsPerSecond: 10, tradesPerSecond: 12, snapshotEveryMs: 2 * MINUTE });
      const referenceFile = path.join(dir, "reference.json");
      fs.writeFileSync(referenceFile, JSON.stringify({
        binance: { hourlyReferences: {
          "spot-hour": { window: { fromTs: 0, toTs: 3_600_000 }, events: 36_000, levelsPerEventMean: 6.5, trades: 43_200, snapshots: 30 },
          "quiet-hour": { window: { fromTs: 0, toTs: 3_600_000 }, events: 3_600, levelsPerEventMean: 6.5, trades: 4_320, snapshots: 30 },
        } },
      }));
      await expect(runCli(["--no-pin", "--reference", "nope", "--reference-file", referenceFile])).rejects.toThrow(/UNKNOWN_REFERENCE/);
      await expect(runCli(["--no-pin", "--reference", "quiet-hour", "--reference-file", referenceFile])).rejects.toThrow(/ACCEPTANCE_FAILED/);
      await runCli(["--no-pin", "--reference", "spot-hour", "--reference-file", referenceFile]);
      expect(readInventory(inventoryPath).fixtures[0].acceptance).toMatchObject({ referenceKey: "spot-hour", pass: true });
      await runCli(["--no-pin", "--overwrite", "--reference", "quiet-hour", "--reference-file", referenceFile, "--allow-failing-acceptance"]);
      expect(readInventory(inventoryPath).fixtures[0].acceptance.pass).toBe(false);
    });

    test("--no-pin records the export without a replay pin", async () => {
      buildSource();
      await runCli(["--no-pin"]);
      expect(readInventory(inventoryPath).fixtures[0].replayPin).toBeUndefined();
    });

    test("names the missing argument and rejects unknown ones", async () => {
      await expect(main(["--source", sourcePath])).rejects.toThrow(/--id is required/);
      await expect(main(["surprise"])).rejects.toThrow(/USAGE/);
      buildSource();
      await expect(runCli(["--tick-size", "-1"])).rejects.toThrow(/--tick-size must be a positive number/);
      await expect(runCli(["--pin-pages", "1.5"])).rejects.toThrow(/--pin-pages must be a positive integer/);
    });
  });
});
