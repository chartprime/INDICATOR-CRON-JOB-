"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { exportDxFeedSlice, main, DXFEED_TABLES } = require("../../../scripts/maintain/export-fixture-slice");
const { readInventory, validateInventoryEntry, sha256File, upsertInventoryEntry } = require("../../../scripts/maintain/fixture-lib");
const { computeReplayPin } = require("../../../scripts/maintain/fixture-replay-pin");
const { verifyFixtures } = require("../../../scripts/verify/verify-fixtures");
const { createDxFeedReplaySource } = require("../../../src/indicators/l2-memory/dxfeed-replay-source");
const { buildSyntheticDxFeedDb } = require("../../helpers/synthetic-dxfeed-db");
const { safeRm } = require("../../helpers/temp-files");

const T0 = 1_700_000_000_000;
const GEOMETRY = { tickSize: 0.01, clusterTicks: 1, rowClusters: 1, windowRows: 200 };
const WINDOW = { fromTs: T0 + 120_000, toTs: T0 + 280_000 };

function replayFrames(dbPath, { symbol = "AAPL", assetClass = "EQUITY", source = "NTV", fromTs, toTs }) {
  const replay = createDxFeedReplaySource({ dbPath, symbol, assetClass, source, fromTs, toTs });
  try {
    return { frames: [...replay.frames()], stats: { ...replay.stats } };
  } finally {
    replay.close();
  }
}

describe("scripts/maintain/export-fixture-slice (dxFeed)", () => {
  let dir;
  let sourcePath;
  let outputDir;
  let inventoryPath;

  const buildSource = (overrides = {}) => buildSyntheticDxFeedDb({
    dbPath: sourcePath, startTs: T0, durationMs: 300_000, sessionMs: 100_000, ...overrides,
  });
  const exportSlice = (overrides = {}) => exportDxFeedSlice({
    id: "dx-slice", sourcePath, symbol: "AAPL", assetClass: "EQUITY", orderSource: "NTV", ...WINDOW, outputDir, ...overrides,
  });
  const scalar = (dbPath, sql, ...params) => {
    const db = new Database(dbPath, { readonly: true });
    try { return db.prepare(sql).pluck().get(...params); } finally { db.close(); }
  };
  const withWriter = (work) => {
    const writer = new Database(sourcePath);
    try { return work(writer); } finally { writer.pragma("wal_checkpoint(TRUNCATE)"); writer.close(); }
  };
  const insertOrder = (writer, { symbol = "AAPL", source = "NTV", eventTime, flags = 0, index, side = "BUY", price = 179.5, size = 5 }) => writer.prepare(
    "INSERT INTO dxfeed_order_book_capture (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, order_index, event_flags, time, action, action_time, order_id, price, size, side, scope, source, market_maker) VALUES (?, ?, 'DXFEED', NULL, 'EQUITY', ?, 0, 'READY', ?, ?, ?, 'NEW', ?, ?, ?, ?, ?, 'ORDER', ?, NULL)",
  ).run(eventTime, eventTime + 1, symbol, String(index), flags, eventTime, eventTime, index, price, size, side, source);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-export-"));
    sourcePath = path.join(dir, "source", "dxfeed-market-data.sqlite");
    outputDir = path.join(dir, "out");
    inventoryPath = path.join(dir, "inventory", "inventory.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  });
  afterEach(() => safeRm(dir, { recursive: true, force: true }));

  describe("what the slice contains", () => {
    test("replaying the slice equals replaying the full source, across a re-anchor inside the window", () => {
      buildSource();
      const result = exportSlice();
      const original = replayFrames(sourcePath, WINDOW);
      const sliced = replayFrames(result.path, WINDOW);
      expect(original.stats.anchors).toBeGreaterThanOrEqual(1);
      expect(original.frames.length).toBeGreaterThan(1_500);
      expect(sliced.stats).toEqual(original.stats);
      expect(sliced.frames).toEqual(original.frames);
    });

    test("the replay pin of the slice equals the replay pin of the full source, page for page", async () => {
      buildSource();
      const result = exportSlice();
      const request = { provider: "dxfeed", symbol: "AAPL", marketKind: "EQUITY", ...WINDOW, geometry: GEOMETRY };
      const fromSource = await computeReplayPin({ ...request, dbPath: sourcePath });
      const fromSlice = await computeReplayPin({ ...request, dbPath: result.path });
      expect(fromSlice).toEqual(fromSource);
      expect(fromSlice.provider).toBe("dxfeed");
      expect(fromSlice.frames).toBeGreaterThan(1_000);
    }, 60_000);

    test("starts at the newest snapshot-begin row at or before the window and keeps only the requested symbol and order source", () => {
      buildSource();
      withWriter((writer) => {
        insertOrder(writer, { symbol: "TSLA", eventTime: T0 + 150_000, index: 9_000_001 });
        insertOrder(writer, { source: "OTHER", eventTime: T0 + 150_001, index: 9_000_002 });
        insertOrder(writer, { eventTime: T0 + 99_000, index: 9_000_003 });
      });
      const { entry, path: slicePath } = exportSlice();
      expect(entry.window).toMatchObject({ fromTs: WINDOW.fromTs, toTs: WINDOW.toTs, anchorEventTime: T0 + 100_000, orderFromTs: T0 + 100_000 });
      expect(scalar(slicePath, "SELECT MIN(event_time) FROM dxfeed_order_book_capture")).toBe(T0 + 100_000);
      expect(scalar(slicePath, "SELECT COUNT(*) FROM dxfeed_order_book_capture WHERE symbol <> 'AAPL' OR source <> 'NTV'")).toBe(0);
      expect(scalar(slicePath, "SELECT COUNT(*) FROM dxfeed_order_book_capture WHERE order_id = 9000003")).toBe(0);
      const expected = scalar(sourcePath, "SELECT COUNT(*) FROM dxfeed_order_book_capture WHERE symbol = 'AAPL' AND source = 'NTV' AND event_time BETWEEN ? AND ?", T0 + 100_000, WINDOW.toTs);
      expect(entry.tables.dxfeed_order_book_capture.rows).toBe(expected);
    });

    test("keeps the tape, quotes, trades and candles that fall inside the window and the overlapping capture sessions", () => {
      buildSource();
      withWriter((writer) => {
        const quote = writer.prepare("INSERT INTO dxfeed_quotes (event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, bid_price, bid_size, bid_time, bid_exchange_code, ask_price, ask_size, ask_time, ask_exchange_code) VALUES (?, ?, 'DXFEED', NULL, 'EQUITY', 'AAPL', 0, 'READY', 179.9, 1, ?, 'Q', 180.1, 1, ?, 'Q')");
        for (const time of [T0 + 50_000, T0 + 150_000, T0 + 350_000]) quote.run(time, time + 1, time, time);
        writer.prepare("INSERT INTO dxfeed_candles (ts_open, provider, venue, asset_class, symbol, open, high, low, close, volume, buy_volume, trade_count) VALUES (?, 'DXFEED', NULL, 'EQUITY', 'AAPL', 180, 181, 179, 180.5, 100, 40, 12)").run(Math.floor((T0 + 150_000) / 60_000) * 60_000);
      });
      const { path: slicePath } = exportSlice();
      expect(scalar(slicePath, "SELECT COUNT(*) FROM dxfeed_quotes")).toBe(1);
      expect(scalar(slicePath, "SELECT COUNT(*) FROM dxfeed_candles")).toBe(1);
      expect(scalar(slicePath, "SELECT MIN(event_time) FROM dxfeed_time_and_sales")).toBeGreaterThanOrEqual(WINDOW.fromTs);
      expect(scalar(slicePath, "SELECT MAX(event_time) FROM dxfeed_time_and_sales")).toBeLessThanOrEqual(WINDOW.toTs);
      expect(scalar(slicePath, "SELECT COUNT(*) FROM dxfeed_time_and_sales")).toBe(scalar(sourcePath, "SELECT COUNT(*) FROM dxfeed_time_and_sales WHERE event_time BETWEEN ? AND ?", WINDOW.fromTs, WINDOW.toTs));
      expect(scalar(slicePath, "SELECT COUNT(*) FROM dxfeed_capture_sessions")).toBeGreaterThanOrEqual(2);
    });

    test("falls back to the first snapshot inside the window when none exists before it, exactly as replay does", () => {
      buildSource();
      const window = { fromTs: T0 - 5_000, toTs: T0 + 60_000 };
      const result = exportSlice({ id: "dx-anchor-after", ...window });
      expect(result.entry.window.anchorEventTime).toBe(T0);
      expect(replayFrames(result.path, window).frames).toEqual(replayFrames(sourcePath, window).frames);
    });

    test("refuses a window with no snapshot to anchor on and leaves nothing behind", () => {
      buildSource();
      expect(() => exportSlice({ id: "dx-no-anchor", fromTs: T0 - 20_000, toTs: T0 - 1_000 })).toThrow(/NO_ANCHOR.*snapshot-begin/);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });
  });

  describe("safety and identity", () => {
    test("reads every table from one snapshot: rows a live writer commits mid-export never reach the slice", () => {
      buildSource();
      const before = scalar(sourcePath, "SELECT COUNT(*) FROM dxfeed_order_book_capture WHERE symbol = 'AAPL' AND source = 'NTV' AND event_time BETWEEN ? AND ?", T0 + 100_000, WINDOW.toTs);
      const result = exportSlice({
        hooks: {
          afterTable(table) {
            if (table !== "dxfeed_order_book_capture") return;
            withWriter((writer) => { for (let index = 0; index < 6; index += 1) insertOrder(writer, { eventTime: T0 + 200_000 + index, index: 9_100_000 + index }); });
          },
        },
      });
      expect(result.entry.tables.dxfeed_order_book_capture.rows).toBe(before);
      expect(scalar(result.path, "SELECT COUNT(*) FROM dxfeed_order_book_capture WHERE order_id >= 9100000")).toBe(0);
      expect(result.entry.source.advancedDuringExport).toBe(true);
    });

    test("never modifies the source, and rejects a schema version it does not know", () => {
      buildSource();
      const before = sha256File(sourcePath);
      exportSlice();
      expect(sha256File(sourcePath)).toBe(before);
      withWriter((writer) => writer.exec("UPDATE dxfeed_storage_schema SET version = 20"));
      expect(() => exportSlice({ id: "dx-old-schema" })).toThrow(/UNSUPPORTED_SOURCE_SCHEMA.*20/);
    });

    test("exporting twice gives a byte-identical file, and no sidecar files are left", () => {
      buildSource();
      const first = exportSlice();
      const second = exportSlice({ overwrite: true });
      expect(second.entry.file.sha256).toBe(first.entry.file.sha256);
      expect(fs.readdirSync(outputDir)).toEqual(["dx-slice.sqlite"]);
      expect(first.entry.file.journalMode).toBe("delete");
    });

    test("records licensed-vendor governance, the order source and asset class, and passes inventory validation without host paths", () => {
      buildSource();
      const { entry } = exportSlice({ inventoryPath });
      expect(validateInventoryEntry(entry)).toEqual([]);
      expect(entry).toMatchObject({ provider: "dxfeed", symbol: "AAPL", assetClass: "EQUITY", orderSource: "NTV" });
      expect(entry.governance).toMatchObject({ dataClass: "licensed-vendor-market-data", retention: "local-only-git-ignored" });
      expect(entry.governance.basis).toMatch(/without opening any dxFeed connection/);
      const serialized = JSON.stringify(readInventory(inventoryPath));
      expect(serialized).not.toContain(dir);
      expect(entry.source.basename).toBe("dxfeed-market-data.sqlite");
    });

    test.each([
      ["an unknown asset class", { assetClass: "OPTION" }, /INVALID_ASSET_CLASS/],
      ["a missing order source", { orderSource: "" }, /INVALID_ORDER_SOURCE/],
      ["an inverted window", { fromTs: WINDOW.toTs, toTs: WINDOW.fromTs }, /INVALID_WINDOW/],
    ])("rejects %s before opening anything", (_label, overrides, pattern) => {
      buildSource();
      expect(() => exportSlice(overrides)).toThrow(pattern);
    });
  });

  describe("statistics and acceptance", () => {
    test("records order-row and tape rates, the snapshot cadence and the counts since the anchor", () => {
      buildSource({ ordersPerSecond: 40, tapePerSecond: 8, sessionMs: 100_000 });
      const { stats } = exportSlice().entry;
      expect(stats.windowMs).toBe(160_000);
      expect(stats.orders.perSecond).toBeGreaterThan(38);
      expect(stats.orders.perSecond).toBeLessThan(42);
      expect(stats.orders.sinceAnchor).toBeGreaterThan(stats.orders.inWindow);
      expect(stats.tape.perSecond).toBeGreaterThan(7);
      expect(stats.tape.perSecond).toBeLessThan(9);
      expect(stats.snapshotBegin.gapMs.p50).toBe(100_000);
      expect(stats.snapshotBegin.fromAnchorToEnd).toBe(2);
    });

    const reference = (overrides = {}) => ({
      referenceKey: "dx-hour",
      reference: { window: { fromTs: 0, toTs: 3_600_000 }, orderBookRows: 144_000, timeAndSales: 28_800, ...overrides },
    });

    test("a band reference accepts a matching window and records the criteria and observed values", () => {
      buildSource({ ordersPerSecond: 40, tapePerSecond: 8 });
      const { entry } = exportSlice({ reference: reference() });
      expect(entry.acceptance).toMatchObject({ referenceKey: "dx-hour", mode: "band", pass: true });
      expect(entry.acceptance.criteria).toEqual([
        { metric: "orders.perSecond", min: 20, max: 80 },
        { metric: "tape.perSecond", min: 4, max: 16 },
      ]);
    });

    test("an at-least reference has no ceiling, so a denser fixture passes and a thinner one is refused", () => {
      buildSource({ ordersPerSecond: 40, tapePerSecond: 8 });
      const dense = exportSlice({ id: "dx-dense", reference: reference({ acceptance: "at-least", orderBookRows: 36_000, timeAndSales: 3_600 }) }).entry;
      expect(dense.acceptance).toMatchObject({ mode: "at-least", pass: true });
      expect(dense.acceptance.criteria.every((criterion) => criterion.max === undefined)).toBe(true);
      expect(() => exportSlice({ id: "dx-thin", reference: reference({ acceptance: "at-least", orderBookRows: 720_000 }) })).toThrow(/ACCEPTANCE_FAILED.*orders\.perSecond/);
      expect(fs.readdirSync(outputDir)).toEqual(["dx-dense.sqlite"]);
    });

    test("a band reference refuses a window that is too dense", () => {
      buildSource({ ordersPerSecond: 40, tapePerSecond: 8 });
      expect(() => exportSlice({ id: "dx-band", reference: reference({ orderBookRows: 7_200 }) })).toThrow(/ACCEPTANCE_FAILED.*orders\.perSecond/);
    });
  });

  describe("verification", () => {
    test("a dxFeed fixture verifies, including its replay pin and acceptance, and a changed row is caught", async () => {
      buildSource();
      const result = exportSlice({
        reference: { referenceKey: "dx-hour", reference: { window: { fromTs: 0, toTs: 3_600_000 }, orderBookRows: 144_000, timeAndSales: 28_800 } },
      });
      result.entry.replayPin = await computeReplayPin({ provider: "dxfeed", dbPath: result.path, symbol: "AAPL", marketKind: "EQUITY", ...WINDOW, geometry: GEOMETRY });
      upsertInventoryEntry(inventoryPath, result.entry);
      expect((await verifyFixtures({ inventoryPath, fixtureDir: outputDir, replay: true })).ok).toBe(true);
      const tamper = new Database(result.path);
      tamper.prepare("UPDATE dxfeed_time_and_sales SET size = size + 1 WHERE id = (SELECT MIN(id) FROM dxfeed_time_and_sales)").run();
      tamper.close();
      const report = await verifyFixtures({ inventoryPath, fixtureDir: outputDir });
      expect(report.ok).toBe(false);
      expect(report.results[0].drift.map((item) => item.what)).toEqual(expect.arrayContaining(["file.sha256", "tables"]));
    }, 90_000);
  });

  describe("command line", () => {
    const runCli = async (extra = []) => {
      const written = [];
      const write = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => { written.push(String(chunk)); return true; });
      try {
        await main([
          "--provider", "dxfeed", "--source", sourcePath, "--id", "dx-cli", "--symbol", "AAPL", "--asset-class", "EQUITY",
          "--from", String(WINDOW.fromTs), "--duration", "160s", "--output-dir", outputDir, "--inventory", inventoryPath,
          "--tick-size", "0.01", "--cluster-ticks", "1", "--row-clusters", "1", "--window-rows", "200", ...extra,
        ]);
      } finally {
        write.mockRestore();
      }
      return JSON.parse(written.join(""));
    };

    test("takes the order source from the instrument catalog when it is not given, and records a dxFeed replay pin", async () => {
      buildSource();
      const printed = await runCli();
      const [entry] = readInventory(inventoryPath).fixtures;
      expect(entry).toMatchObject({ provider: "dxfeed", orderSource: "NTV", assetClass: "EQUITY" });
      expect(entry.replayPin).toMatchObject({ provider: "dxfeed", geometry: { tickSize: 0.01, clusterTicks: 1 } });
      expect(printed.fileSha256).toBe(entry.file.sha256);
    }, 60_000);

    test("an explicit --order-source wins, and a symbol the catalog does not know needs one", async () => {
      buildSource({ symbol: "ZZZZ", source: "XYZ" });
      const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
      await expect(main([
        "--provider", "dxfeed", "--source", sourcePath, "--id", "dx-unknown", "--symbol", "ZZZZ", "--asset-class", "EQUITY",
        "--from", String(WINDOW.fromTs), "--duration", "160s", "--output-dir", outputDir, "--inventory", inventoryPath, "--no-pin",
      ])).rejects.toThrow(/INVALID_ORDER_SOURCE/);
      await main([
        "--provider", "dxfeed", "--source", sourcePath, "--id", "dx-unknown", "--symbol", "ZZZZ", "--asset-class", "EQUITY", "--order-source", "XYZ",
        "--from", String(WINDOW.fromTs), "--duration", "160s", "--output-dir", outputDir, "--inventory", inventoryPath, "--no-pin",
      ]);
      write.mockRestore();
      expect(readInventory(inventoryPath).fixtures.map((fixture) => fixture.orderSource)).toEqual(["XYZ"]);
    });

    test("rejects an unknown provider and names the identity flag each provider needs", async () => {
      await expect(main(["--provider", "kraken"])).rejects.toThrow(/UNSUPPORTED_PROVIDER/);
      await expect(main(["--provider", "dxfeed", "--source", sourcePath])).rejects.toThrow(/--id is required/);
      await expect(main(["--provider", "dxfeed", "--source", sourcePath, "--id", "x-y-z", "--symbol", "AAPL", "--from", "1", "--duration", "1h"])).rejects.toThrow(/--asset-class is required/);
    });
  });

  test("the digest table list covers every table the replay reads from", () => {
    expect(DXFEED_TABLES.map(({ table }) => table)).toEqual(expect.arrayContaining(["dxfeed_order_book_capture", "dxfeed_time_and_sales"]));
  });
});
