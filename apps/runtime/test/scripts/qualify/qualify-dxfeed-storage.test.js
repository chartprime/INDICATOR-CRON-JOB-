const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDxFeedStorageDb, SCHEMA_VERSION } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { safeRm } = require("../../helpers/temp-files");
const {
  parseArgs, inspectExistingDatabase, runSyntheticQualification, MAX_BATCH_SEQUENCES,
} = require("../../../scripts/qualify/qualify-dxfeed-storage");

describe("qualify-dxfeed-storage", () => {
  test("parses bounded qualification options and rejects unsafe/unknown arguments", () => {
    expect(parseArgs([
      "--events-per-instrument", "25", "--batch-sequences", "5",
      "--nominal-events-per-second", "10", "--keep-synthetic-db",
    ])).toMatchObject({
      eventsPerInstrument: 25, batchSequences: 5, nominalEventsPerSecond: 10, keepSyntheticDb: true,
    });
    expect(() => parseArgs(["--batch-sequences", String(MAX_BATCH_SEQUENCES + 1)])).toThrow(/no greater/);
    expect(() => parseArgs(["--unknown"])).toThrow(/unsupported/);
  });

  test("inspects an existing database strictly read-only", () => {
    const dbPath = path.join(os.tmpdir(), `dxfeed-qualification-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const storageDb = createDxFeedStorageDb({ dbPath, bootstrap: true });
    storageDb.beginCaptureSession({ sessionId: "inspection", startedAt: 1_800_000_000_000 });
    storageDb.finishCaptureSession({
      sessionId: "inspection", endedAt: 1_800_000_000_001,
      quality: "HEALTHY", cleanShutdown: true, terminationReason: "test",
    });
    storageDb.close();
    const before = fs.statSync(dbPath).size;
    expect(inspectExistingDatabase(dbPath)).toMatchObject({
      schemaVersion: SCHEMA_VERSION, journalMode: "wal", latestSession: { quality: "HEALTHY", clean_shutdown: 1 },
    });
    expect(fs.statSync(dbPath).size).toBe(before);
    for (const suffix of ["", "-wal", "-shm"]) safeRm(`${dbPath}${suffix}`, { force: true });
  });

  test("small real-path qualification preserves every row and passes all gates", async () => {
    const report = await runSyntheticQualification({
      eventsPerInstrument: 25, batchSequences: 5, nominalEventsPerSecond: 1, keepSyntheticDb: false,
    });
    expect(report).toMatchObject({
      pass: true,
      expectedTotal: 500,
      expectedPerTable: 125,
      counts: { quotes: 125, trades: 125, timeAndSales: 125, orderBookCapture: 125 },
      quickCheck: "ok",
      counters: { rejected: 0, skipped: 0, tradeIdGaps: 0, tradeIdNonMonotonic: 0 },
    });
  });
});
