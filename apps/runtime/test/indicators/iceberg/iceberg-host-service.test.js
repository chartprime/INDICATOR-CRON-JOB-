const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createIcebergHostService, icebergHostOptionsFromEnv, icebergHostPairs, pairKeyOf, STATUS_FILE, DEFAULT_CYCLE_MS, DEFAULT_CHUNKS_PER_CYCLE } = require("../../../src/indicators/iceberg/iceberg-host-service");
const { openIcebergHostStore } = require("../../../src/indicators/iceberg/iceberg-host-store");
const { createIcebergHostReader } = require("../../../src/indicators/iceberg/iceberg-host-reader");
const { DEFAULT_RETENTION_MS, DEFAULT_WARMUP_MS } = require("../../../src/indicators/iceberg/iceberg-host-builder");
const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const catalog = require("../../../../../config/market-instruments.json");

const T0 = 1_700_000_100_000;

function settled(id, markedAt, overrides = {}) {
  return {
    id, kind: "probable", confidence: "probable", origin: "runtime", side: "bid", price: 81000, display: 1, tranches: 1, executed: 2.4,
    startedAt: markedAt - 6_000, markedAt, updatedAt: markedAt + 4_000, status: "ended", ...overrides,
  };
}

describe("indicators/iceberg/iceberg-host-service", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-host-service-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the pairs come from the catalog, Binance symbols in capture form and dxFeed asset classes as market kinds, narrowed by the pair filter", () => {
    const pairs = icebergHostPairs({ catalog });
    expect(pairs.map(pairKeyOf)).toEqual([
      "binance:SPOT:BTCUSDT", "binance:PERPETUAL:BTCUSDT", "binance:SPOT:ETHUSDT", "binance:PERPETUAL:ETHUSDT",
      "dxfeed:FUTURE:/NQZ26:XCME", "dxfeed:FUTURE:/ESZ26:XCME", "dxfeed:EQUITY:AAPL", "dxfeed:EQUITY:TSLA", "dxfeed:EQUITY:NVDA",
    ]);
    expect(icebergHostPairs({ catalog, pairFilter: new Set(["dxfeed:FUTURE:/NQZ26:XCME"]) }).map(pairKeyOf)).toEqual(["dxfeed:FUTURE:/NQZ26:XCME"]);
  });

  test("the options come from the environment with the plan's defaults: seven days, a day of Binance warm-up, a minute between cycles, twelve chunks a cycle, and a kill switch", () => {
    const defaults = icebergHostOptionsFromEnv({});
    expect(defaults).toMatchObject({ enabled: true, retentionMs: DEFAULT_RETENTION_MS, warmupMs: DEFAULT_WARMUP_MS, cycleMs: DEFAULT_CYCLE_MS, chunksPerCycle: DEFAULT_CHUNKS_PER_CYCLE, pairFilter: null });
    expect(defaults.dir).toMatch(/[\\/]iceberg-history$/);
    expect(typeof defaults.dbPaths.binance).toBe("string");
    const custom = icebergHostOptionsFromEnv({ TT_ICEBERG_HISTORY: "0", TT_ICEBERG_DIR: "/srv/terminal-data/iceberg-history", TT_ICEBERG_RETENTION_DAYS: "3", TT_ICEBERG_WARMUP_HOURS: "2", TT_ICEBERG_CYCLE_MS: "5000", TT_ICEBERG_CHUNKS_PER_CYCLE: "4", TT_ICEBERG_PAIRS: "binance:PERPETUAL:BTCUSDT, dxfeed:FUTURE:/NQZ26:XCME", TT_ICEBERG_BINANCE_DB_PATH: "/b.sqlite", TT_ICEBERG_DXFEED_DB_PATH: "/d.sqlite" });
    expect(custom).toEqual({
      enabled: false, dir: "/srv/terminal-data/iceberg-history", dbPaths: { binance: "/b.sqlite", dxfeed: "/d.sqlite" },
      retentionMs: 3 * 86_400_000, warmupMs: { binance: 2 * 3_600_000, dxfeed: 0 }, cycleMs: 5000, chunksPerCycle: 4,
      pairFilter: new Set(["binance:PERPETUAL:BTCUSDT", "dxfeed:FUTURE:/NQZ26:XCME"]),
    });
  });

  test("a cycle runs each pair's builder up to the chunk budget, prunes its store once a minute, writes the status file, and reports a pair that fails without stopping the others", () => {
    const calls = [];
    const options = { dir, dbPaths: { binance: "b", dxfeed: "d" }, retentionMs: 86_400_000, warmupMs: { binance: 0, dxfeed: 0 }, cycleMs: 1000, chunksPerCycle: 2, pairFilter: new Set(["binance:PERPETUAL:BTCUSDT", "dxfeed:FUTURE:/NQZ26:XCME"]) };
    let chunk = 0;
    const service = createIcebergHostService({
      catalog, options, now: () => T0,
      captureBoundsFor: () => ({ of: () => ({ earliest: 0, latest: T0 }), close: () => calls.push("bounds-closed") }),
      createBuilder: ({ store, pair, dbPath, retentionMs, warmupMs }) => {
        calls.push(["builder", pairKeyOf(pair), dbPath, retentionMs, warmupMs]);
        if (pair.provider === "dxfeed") return { runChunk: () => { throw new Error("capture missing"); }, close: () => calls.push("closed-dxfeed") };
        return {
          runChunk: () => {
            chunk += 1;
            if (chunk > 3) return { built: false, reason: "AWAITING_CAPTURE", from: T0 };
            store.checkpoint({ cursor: T0 - 100_000 + chunk * 10_000, start: T0 - 100_000, settledThrough: T0 - 100_000 + chunk * 10_000, cuts: null, coverage: [[T0 - 100_000, T0 - 100_000 + chunk * 10_000]], gaps: [] }, [settled(`i${chunk}`, T0 - 100_000 + chunk * 10_000 - 5_000)]);
            return { built: true, from: 0, to: 0, settled: 1, open: 0 };
          },
          close: () => calls.push("closed-binance"),
        };
      },
    });
    expect(service.pairs.map(pairKeyOf)).toEqual(["binance:PERPETUAL:BTCUSDT", "dxfeed:FUTURE:/NQZ26:XCME"]);
    const stale = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    stale.checkpoint({ cursor: T0 - 100_000, start: T0 - 3 * 86_400_000, settledThrough: T0 - 100_000, cuts: null, coverage: [[T0 - 3 * 86_400_000, T0 - 100_000]], gaps: [] }, [settled("old", T0 - 2 * 86_400_000)]);
    stale.close();
    expect(service.runOnce()).toBe(2);
    expect(calls).toEqual([["builder", "binance:PERPETUAL:BTCUSDT", "b", 86_400_000, 0], ["builder", "dxfeed:FUTURE:/NQZ26:XCME", "d", 86_400_000, 0]]);
    const status = JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), "utf8"));
    expect(status.pairs["binance:PERPETUAL:BTCUSDT"]).toMatchObject({ state: "RUNNING", reason: null, cursor: T0 - 80_000, icebergs: 2, chunks: 2, settled: 2 });
    expect(status.pairs["dxfeed:FUTURE:/NQZ26:XCME"]).toMatchObject({ state: "ERROR", reason: "capture missing" });
    expect(service.runOnce()).toBe(1);
    expect(service.status().pairs["binance:PERPETUAL:BTCUSDT"]).toMatchObject({ state: "RUNNING", reason: "AWAITING_CAPTURE", cursor: T0 - 70_000, icebergs: 3, chunks: 1 });
    const reader = createIcebergHostReader({ dir });
    expect(reader.readIcebergHistory("binance", "BTCUSDT", "PERPETUAL", { fromTs: 0, toTs: T0 }).icebergs.map((entry) => entry.id)).toEqual(["i1", "i2", "i3"]);
    reader.close();
    service.close();
    expect(calls.slice(2)).toEqual(["closed-binance", "closed-dxfeed", "bounds-closed"]);
  });

  test("run loops until stopped, pausing when nothing was built, and the service refuses options without a directory or capture paths", async () => {
    const options = { dir, dbPaths: { binance: "b", dxfeed: "d" }, retentionMs: 1000, warmupMs: { binance: 0, dxfeed: 0 }, cycleMs: 5, chunksPerCycle: 1, pairFilter: new Set(["binance:SPOT:BTCUSDT"]) };
    let runs = 0;
    const service = createIcebergHostService({
      catalog, options, now: () => T0,
      captureBoundsFor: () => ({ of: () => ({ earliest: null, latest: null }), close: () => {} }),
      createBuilder: () => ({ runChunk: () => { runs += 1; if (runs === 3) service.stop(); return { built: false, reason: "NO_CAPTURE", from: null }; }, close: () => {} }),
    });
    await service.run();
    expect(runs).toBe(3);
    expect(service.status().pairs["binance:SPOT:BTCUSDT"]).toMatchObject({ state: "WAITING", reason: "NO_CAPTURE" });
    service.close();
    expect(() => createIcebergHostService({ catalog, options: { ...options, dir: "" } })).toThrow(/dir/);
    expect(() => createIcebergHostService({ catalog, options: { ...options, dbPaths: {} } })).toThrow(/dbPaths/);
    expect(() => createIcebergHostService({ catalog, options: { ...options, chunksPerCycle: 0 } })).toThrow(/chunksPerCycle/);
  });

  test("run turns the event loop after every chunk, so a stop from a timer or a signal takes effect within one chunk while a backlog remains", async () => {
    const options = { dir, dbPaths: { binance: "b", dxfeed: "d" }, retentionMs: 86_400_000, warmupMs: { binance: 0, dxfeed: 0 }, cycleMs: 5, chunksPerCycle: 50, pairFilter: new Set(["binance:SPOT:BTCUSDT"]) };
    let chunks = 0;
    const service = createIcebergHostService({
      catalog, options, now: () => T0,
      captureBoundsFor: () => ({ of: () => ({ earliest: null, latest: null }), close: () => {} }),
      createBuilder: () => ({
        runChunk: () => {
          chunks += 1;
          return chunks > 40 ? { built: false, reason: "AWAITING_CAPTURE", from: T0 } : { built: true, from: T0, to: T0, settled: 0, open: 0 };
        },
        close: () => {},
      }),
    });
    let stoppedAt = null;
    setImmediate(() => {
      stoppedAt = chunks;
      service.stop();
    });
    await service.run();
    expect(stoppedAt).toBe(1);
    expect(chunks).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), "utf8")).pairs["binance:SPOT:BTCUSDT"]).toMatchObject({ state: "RUNNING", reason: null, chunks: 1 });
    service.close();
  });

  test("the capture bounds share the service log: an unreadable capture is logged once, reads WAITING with CAPTURE_UNREADABLE in the status, and is read once it appears", () => {
    const lines = [];
    const capture = path.join(dir, "capture");
    const options = { dir, dbPaths: { binance: path.join(capture, "binance.sqlite"), dxfeed: path.join(capture, "dxfeed.sqlite") }, retentionMs: 86_400_000, warmupMs: { binance: 0, dxfeed: 0 }, cycleMs: 5, chunksPerCycle: 1, pairFilter: new Set(["dxfeed:FUTURE:/NQZ26:XCME"]) };
    const service = createIcebergHostService({ catalog, options, now: () => T0, log: (line) => lines.push(line) });
    expect(service.runOnce()).toBe(0);
    expect(service.runOnce()).toBe(0);
    expect(service.status().pairs["dxfeed:FUTURE:/NQZ26:XCME"]).toMatchObject({ state: "WAITING", reason: "CAPTURE_UNREADABLE" });
    expect(lines.filter((line) => line.includes("cannot read the dxfeed capture"))).toHaveLength(1);
    fs.mkdirSync(capture);
    createDxFeedStorageDb({ dbPath: options.dbPaths.dxfeed }).close();
    expect(service.runOnce()).toBe(0);
    expect(service.status().pairs["dxfeed:FUTURE:/NQZ26:XCME"]).toMatchObject({ state: "WAITING", reason: "NO_CAPTURE" });
    expect(lines).toContain("iceberg-host-builder: the dxfeed capture opened after 2 failed attempts");
    service.close();
  });

  test("a pair with a checkpoint whose capture cannot be opened waits with CAPTURE_UNREADABLE instead of failing, and builds again once the file appears", () => {
    const lines = [];
    const key = "dxfeed:FUTURE:/NQZ26:XCME";
    const capture = path.join(dir, "capture");
    const options = { dir, dbPaths: { binance: path.join(capture, "binance.sqlite"), dxfeed: path.join(capture, "dxfeed.sqlite") }, retentionMs: 86_400_000, warmupMs: { binance: 0, dxfeed: 0 }, cycleMs: 5, chunksPerCycle: 1, pairFilter: new Set([key]) };
    const seeded = openIcebergHostStore({ dir, pairKey: key });
    seeded.checkpoint({ cursor: T0 - 100_000, start: T0 - 200_000, settledThrough: T0 - 100_000, cuts: null, coverage: [[T0 - 200_000, T0 - 100_000]], gaps: [] }, []);
    seeded.close();
    const service = createIcebergHostService({ catalog, options, now: () => T0, log: (line) => lines.push(line) });
    expect(service.runOnce()).toBe(0);
    expect(service.runOnce()).toBe(0);
    expect(service.status().pairs[key]).toMatchObject({ state: "WAITING", reason: "CAPTURE_UNREADABLE", cursor: T0 - 100_000 });
    expect(lines.filter((line) => line.includes("failed:"))).toEqual([]);
    fs.mkdirSync(capture);
    createDxFeedStorageDb({ dbPath: options.dbPaths.dxfeed }).close();
    expect(service.runOnce()).toBe(0);
    expect(service.status().pairs[key]).toMatchObject({ state: "RUNNING", reason: "AWAITING_CAPTURE", cursor: T0 - 100_000 });
    expect(lines.filter((line) => line.includes("failed:"))).toEqual([]);
    expect(lines).toContain("iceberg-host-builder: the dxfeed capture opened after 2 failed attempts");
    service.close();
  });

  test("each builder's questions reach the shared capture bounds as asked, for its own pair", () => {
    const asked = [];
    const options = { dir, dbPaths: { binance: "b", dxfeed: "d" }, retentionMs: 86_400_000, warmupMs: { binance: 0, dxfeed: 0 }, cycleMs: 5, chunksPerCycle: 1, pairFilter: new Set(["dxfeed:FUTURE:/NQZ26:XCME"]) };
    const service = createIcebergHostService({
      catalog, options, now: () => T0,
      captureBoundsFor: () => ({
        of: (pair, wanted) => {
          asked.push([pairKeyOf(pair), wanted]);
          return { earliest: null, latest: null };
        },
        close: () => {},
      }),
      createBuilder: ({ captureBounds }) => ({
        runChunk: () => {
          captureBounds({ earliest: false });
          return { built: false, reason: "AWAITING_CAPTURE", from: T0 };
        },
        close: () => {},
      }),
    });
    service.runOnce();
    expect(asked).toEqual([["dxfeed:FUTURE:/NQZ26:XCME", { earliest: false }]]);
    service.close();
  });

  test("the status carries the count of gaps each pair's builder had to drop", () => {
    const options = { dir, dbPaths: { binance: "b", dxfeed: "d" }, retentionMs: 86_400_000, warmupMs: { binance: 0, dxfeed: 0 }, cycleMs: 5, chunksPerCycle: 1, pairFilter: new Set(["binance:SPOT:BTCUSDT"]) };
    const service = createIcebergHostService({
      catalog, options, now: () => T0,
      captureBoundsFor: () => ({ of: () => ({ earliest: null, latest: null }), close: () => {} }),
      createBuilder: () => ({ runChunk: () => ({ built: false, reason: "AWAITING_CAPTURE", from: T0 }), close: () => {}, droppedGaps: 2 }),
    });
    service.runOnce();
    expect(JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), "utf8")).pairs["binance:SPOT:BTCUSDT"]).toMatchObject({ state: "RUNNING", reason: "AWAITING_CAPTURE", droppedGaps: 2 });
    service.close();
  });

  test("the reader answers no history for an unknown pair, not built for an empty store, and a page with the watched spans clipped at the settled line", () => {
    const reader = createIcebergHostReader({ dir });
    expect(reader.readIcebergHistory("binance", "BTCUSDT", "PERPETUAL", { fromTs: 0, toTs: 10 })).toEqual({ available: false, reason: "NO_HISTORY" });
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    expect(reader.readIcebergHistory("binance", "BTCUSDT", "PERPETUAL", { fromTs: 0, toTs: 10 })).toEqual({ available: false, reason: "NOT_BUILT" });
    store.checkpoint({ cursor: 19_000, start: 11_000, settledThrough: 17_000, cuts: null, coverage: [[11_000, 19_000]], gaps: [[14_000, 14_500, "NO_CAPTURE"]] }, [settled("a", 12_000), settled("b", 16_000), settled("c", 18_000)]);
    const page = reader.readIcebergHistory("BINANCE", "BTCUSDT", "PERPETUAL", { fromTs: 0, toTs: 20_000, limit: 2 });
    expect(page).toMatchObject({ available: true, generation: store.generation(), rulesVersion: store.rulesVersion(), span: { from: 11_000, to: 17_000 }, watched: [[11_000, 14_000], [14_500, 17_000]], next: { markedAt: 16_000, id: "b" } });
    expect(page.icebergs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(reader.stats()).toEqual({ pages: 1, icebergs: 2, missing: 1, open: 1 });
    store.close();
    reader.close();
  });
});
