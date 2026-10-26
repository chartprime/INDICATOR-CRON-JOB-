"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const crypto = require("node:crypto");
const { computeReplayPin, forEachPage, canonical } = require("../../scripts/maintain/fixture-replay-pin");
const { readInventory } = require("../../scripts/maintain/fixture-lib");
const { buildSyntheticBinanceDb } = require("../helpers/synthetic-binance-db");
const { safeRm } = require("../helpers/temp-files");

const GEOMETRY = Object.freeze({ tickSize: 0.5, clusterTicks: 2, rowClusters: 4, windowRows: 200 });
const WINDOW_OFFSET_MS = 30_000;
const SHAPE = Object.freeze({ durationMs: 360_000, snapshotEveryMs: 90_000 });

// `sha256` covers frames, completion and the source's counters; `framesSha256`
// covers frames and completion only. A change to `sha256` alone means the
// source did a different amount of work for the same output (re-pinned once,
// 2026-09-20, when the trade read stopped starting at the anchor: tradesRead
// fell, frames were proven byte-identical). A change to `framesSha256` means
// reconstruction itself changed and must be explained before it is re-pinned.
const PINNED = Object.freeze({
  SPOT: Object.freeze({
    seed: 7, pages: 4, frames: 7_265, booksEmitted: 3_303,
    sha256: "d244c654fcc5d7910fed0a5be4ce1016bc35fa31415a350c2285ae77ad70fda0",
    framesSha256: "169d23d307579745",
  }),
  PERPETUAL: Object.freeze({
    seed: 11, pages: 4, frames: 7_265, booksEmitted: 3_304,
    sha256: "1aa35d5c7c7284a818ae9d100bc9a8a510ddb859a6723f2396d3e463ef1eae99",
    framesSha256: "98af00f610406014",
  }),
});

async function framesOnlyDigest(request) {
  const hash = crypto.createHash("sha256");
  await forEachPage(request, (page) => hash.update(JSON.stringify(canonical({ frames: page.frames, complete: page.complete }))));
  return hash.digest("hex").slice(0, 16);
}

function replayFramesWith(replaySourceModule, dbPath, marketKind, fromTs, toTs) {
  const source = replaySourceModule.createReplaySource({ dbPath, symbol: "BTCUSDT", marketKind, fromTs, toTs });
  try {
    return { frames: [...source.frames()], stats: { ...source.stats } };
  } finally {
    source.close();
  }
}

function loadReplaySourceWithLegacyAssembler(counter = { fullStateCalls: 0 }) {
  let loaded;
  jest.isolateModules(() => {
    jest.doMock("../../src/providers/binance/binance-book-assembler", () => {
      const actual = jest.requireActual("../../src/providers/binance/binance-book-assembler");
      return {
        ...actual,
        createBinanceBookAssembler: (options) => {
          const inner = actual.createBinanceBookAssembler(options);
          return {
            ...inner,
            applyDeltaEventStatus: (input) => {
              counter.fullStateCalls += 1;
              const state = inner.applyDeltaEvent(input);
              return state.status === "READY" ? { status: "READY" } : state;
            },
          };
        },
      };
    });
    loaded = require("../../src/indicators/l2-memory/replay-source");
  });
  jest.dontMock("../../src/providers/binance/binance-book-assembler");
  return loaded;
}

describe("replay reconstruction is pinned on a deterministic fixture", () => {
  let dir;
  const build = (marketKind, overrides = {}) => {
    const dbPath = path.join(dir, `${marketKind.toLowerCase()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const built = buildSyntheticBinanceDb({ dbPath, marketKind, seed: PINNED[marketKind].seed, ...SHAPE, ...overrides });
    return { dbPath, built };
  };
  const pinOf = (dbPath, built, marketKind, extra = {}) => computeReplayPin({
    dbPath, symbol: "BTCUSDT", marketKind, fromTs: built.startTs + WINDOW_OFFSET_MS, toTs: built.endTs, geometry: GEOMETRY, ...extra,
  });

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-pin-")); });
  afterEach(() => safeRm(dir, { recursive: true, force: true }));

  describe.each(["SPOT", "PERPETUAL"])("%s", (marketKind) => {
    test("replay pages hash to the pinned digest, page count, frame count and book count", async () => {
      const { dbPath, built } = build(marketKind);
      const pin = await pinOf(dbPath, built, marketKind);
      expect(pin).toMatchObject({ pages: PINNED[marketKind].pages, frames: PINNED[marketKind].frames, sha256: PINNED[marketKind].sha256 });
      expect(pin.stats).toMatchObject({ booksEmitted: PINNED[marketKind].booksEmitted, gaps: 0 });
      const request = { dbPath, symbol: "BTCUSDT", marketKind, fromTs: built.startTs + WINDOW_OFFSET_MS, toTs: built.endTs, geometry: GEOMETRY };
      expect(await framesOnlyDigest(request)).toBe(PINNED[marketKind].framesSha256);
    }, 60_000);

    test("reading twice gives the same digest, so the pin is a property of the data and not of the run", async () => {
      const { dbPath, built } = build(marketKind);
      const first = await pinOf(dbPath, built, marketKind);
      const second = await pinOf(dbPath, built, marketKind);
      expect(second.sha256).toBe(first.sha256);
    }, 60_000);

    test("changing one trade or one depth update changes the digest", async () => {
      const { dbPath, built } = build(marketKind);
      const original = (await pinOf(dbPath, built, marketKind)).sha256;
      const db = new Database(dbPath);
      db.prepare("UPDATE trades SET size = '9.999999' WHERE id = (SELECT id FROM trades WHERE ts > ? ORDER BY id LIMIT 1 OFFSET 40)").run(built.startTs + 120_000);
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
      const afterTrade = (await pinOf(dbPath, built, marketKind)).sha256;
      expect(afterTrade).not.toBe(original);
      const again = new Database(dbPath);
      again.prepare("UPDATE l2_depth_events SET bids = '[[\"59990.00\",\"123.000000\"]]' WHERE id = (SELECT id FROM l2_depth_events WHERE ts > ? ORDER BY id LIMIT 1 OFFSET 40)").run(built.startTs + 120_000);
      again.pragma("wal_checkpoint(TRUNCATE)");
      again.close();
      expect((await pinOf(dbPath, built, marketKind)).sha256).not.toBe(afterTrade);
    }, 60_000);

    test("a different page size is a different pin, so the limits are part of what is pinned", async () => {
      const { dbPath, built } = build(marketKind);
      const original = await pinOf(dbPath, built, marketKind);
      const small = await pinOf(dbPath, built, marketKind, { limits: { maxFrames: 400 } });
      expect(small.pages).toBeGreaterThan(original.pages);
      expect(small.sha256).not.toBe(original.sha256);
      expect(small.limits).toEqual({ maxFrames: 400, maxBytes: null });
    }, 60_000);
  });

  describe("the cheap reconstruction path emits exactly what materialising the full book on every event emits", () => {
    const compare = (dbPath, marketKind, fromTs, toTs) => {
      const current = replayFramesWith(require("../../src/indicators/l2-memory/replay-source"), dbPath, marketKind, fromTs, toTs);
      const legacy = replayFramesWith(loadReplaySourceWithLegacyAssembler(), dbPath, marketKind, fromTs, toTs);
      return { current, legacy };
    };

    test.each(["SPOT", "PERPETUAL"])("%s stream with no gaps", (marketKind) => {
      const { dbPath, built } = build(marketKind);
      const { current, legacy } = compare(dbPath, marketKind, built.startTs + WINDOW_OFFSET_MS, built.endTs);
      expect(current.frames.length).toBeGreaterThan(5_000);
      expect(current.stats.gaps).toBe(0);
      expect(current.stats).toEqual(legacy.stats);
      expect(current.frames).toEqual(legacy.frames);
    });

    test.each(["SPOT", "PERPETUAL"])("%s stream with a hole in the middle that forces a re-anchor", (marketKind) => {
      const { dbPath, built } = build(marketKind);
      const db = new Database(dbPath);
      const removed = db.prepare("DELETE FROM l2_depth_events WHERE ts BETWEEN ? AND ?").run(built.startTs + 150_000, built.startTs + 150_400).changes;
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
      expect(removed).toBeGreaterThan(2);
      const { current, legacy } = compare(dbPath, marketKind, built.startTs + WINDOW_OFFSET_MS, built.endTs);
      expect(current.stats.gaps).toBeGreaterThanOrEqual(1);
      expect(current.stats.snapshotsUsed).toBeGreaterThan(1);
      expect(current.stats).toEqual(legacy.stats);
      expect(current.frames).toEqual(legacy.frames);
    });

    test("the legacy stand-in really does materialise the full state on every event it reads", () => {
      const { dbPath, built } = build("SPOT");
      const counter = { fullStateCalls: 0 };
      const legacy = replayFramesWith(loadReplaySourceWithLegacyAssembler(counter), dbPath, "SPOT", built.startTs + WINDOW_OFFSET_MS, built.endTs);
      expect(legacy.stats.eventsRead).toBeGreaterThan(3_000);
      expect(counter.fullStateCalls).toBe(legacy.stats.eventsRead);
    });
  });
});

describe("fixtures in the committed inventory", () => {
  const inventoryPath = path.resolve(__dirname, "../../../../benchmarks/fixtures/inventory.json");
  const fixtureDir = path.resolve(__dirname, "../../data/fixtures");
  const enabled = process.env.TT_TEST_REAL_FIXTURES === "1";

  test("the committed inventory can be read", () => {
    const inventory = readInventory(inventoryPath);
    expect(Array.isArray(inventory.fixtures)).toBe(true);
  });

  const pinned = readInventory(inventoryPath).fixtures.filter((fixture) => fixture.replayPin !== undefined && fixture.provider === "binance");
  const realSlice = enabled ? test : test.skip;
  (pinned.length === 0 ? test.skip.each([["none-yet", null]]) : realSlice.each(pinned.map((fixture) => [fixture.id, fixture])))("real slice %s replays to its pinned digest", async (_id, fixture) => {
    const dbPath = path.join(fixtureDir, fixture.file.name);
    if (!fs.existsSync(dbPath)) throw new Error(`fixture ${fixture.file.name} is not present; run the exporter or unset TT_TEST_REAL_FIXTURES`);
    const replayWindow = fixture.replayPin.window ?? fixture.window;
    const pin = await computeReplayPin({
      dbPath, symbol: fixture.symbol, marketKind: fixture.marketKind, fromTs: replayWindow.fromTs, toTs: replayWindow.toTs,
      ...(fixture.replayPin.window === undefined ? {} : { pinWindow: replayWindow }),
      ...(fixture.replayPin.pageLimit === undefined ? {} : { pageLimit: fixture.replayPin.pageLimit }),
      geometry: fixture.replayPin.geometry, limits: Object.fromEntries(Object.entries(fixture.replayPin.limits).filter(([, value]) => value !== null)),
    });
    expect(pin).toEqual(fixture.replayPin);
  }, 900_000);
});
