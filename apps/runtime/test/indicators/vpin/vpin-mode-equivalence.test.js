"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDxFeedStorageDb } = require("../../../src/storage/dxfeed/dxfeed-storage-db");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { createDxFeedVolumeProfileAdapter } = require("../../../src/indicators/volume-profile/volume-profile-adapters");
const { createVpinSession, runBackfill, seedSessionFromBackfill, pollLive } = require("../../../src/indicators/vpin/vpin-session");
const { seededRandom } = require("../../helpers/synthetic-binance-db");
const { safeRm } = require("../../helpers/temp-files");

const T0 = Date.parse("2026-09-23T14:00:00Z"); // 10:00 EDT: equity VPIN reads are regular-session only (GE-14)
const T1 = T0 + 300_000;
const T2 = T0 + 600_000;
const V_BUCKET = 60_000;
const BIG_HISTORY = 100_000;
const TAPE_COLUMNS = "event_time, received_at, provider, venue, asset_class, symbol, stale, recovery_state, price, size, time, time_nano_part, sequence, exchange_code, extended_trading_hours, aggressor_side, spread_leg, valid_tick, event_kind, provider_index, provider_trade_id, bid_price, ask_price";

function buildTape(dbPath) {
  const random = seededRandom(5);
  const storage = createDxFeedStorageDb({ dbPath });
  const insert = storage.raw.prepare(`INSERT INTO dxfeed_time_and_sales (${TAPE_COLUMNS}) VALUES (?, ?, 'DXFEED', NULL, 'EQUITY', 'AAPL', 0, 'READY', ?, ?, ?, 0, ?, 'Q', 0, ?, 0, 1, ?, ?, ?, 179.9, 180.1)`);
  const counts = { new: 0, undefined: 0, ignored: 0, whales: 0, ties: 0, atT1: 0, atT2: 0 };
  let sequence = 0;
  const add = (eventTime, { size, aggressor, kind = "NEW", price = 180 }) => {
    sequence += 1;
    insert.run(eventTime, eventTime + 1, price, size, eventTime, sequence, aggressor, kind, sequence, sequence);
    if (kind !== "NEW") counts.ignored += 1;
    else {
      counts.new += 1;
      if (aggressor === "UNDEFINED") counts.undefined += 1;
      if (size >= 2_000) counts.whales += 1;
      if (eventTime === T1) counts.atT1 += 1;
    }
    if (eventTime === T2) counts.atT2 += 1;
  };
  storage.raw.exec("BEGIN");
  for (let eventTime = T0; eventTime < T2; eventTime += 100 + Math.floor(random() * 300)) {
    const tradesHere = random() < 0.2 ? 2 + Math.floor(random() * 3) : 1;
    if (tradesHere > 1) counts.ties += 1;
    for (let index = 0; index < tradesHere; index += 1) {
      const roll = random();
      const size = roll < 0.01 ? 2_000 + Math.floor(random() * 4_000) : 1 + Math.floor(-Math.log(1 - random()) * 90);
      const aggressor = random() < 0.08 ? "UNDEFINED" : random() < 0.5 ? "BUY" : "SELL";
      add(eventTime, { size, aggressor });
      if (random() < 0.03) add(eventTime, { size: 50, aggressor: "BUY", kind: random() < 0.5 ? "CORRECTION" : "CANCEL" });
    }
  }
  for (const eventTime of [T0, T1 - 1, T1, T1, T1, T1 + 1, T2 - 1, T2, T2]) add(eventTime, { size: 300, aggressor: eventTime % 2 === 0 ? "BUY" : "SELL" });
  storage.raw.exec("COMMIT");
  storage.raw.pragma("wal_checkpoint(TRUNCATE)");
  storage.close();
  return counts;
}

async function drainPolls(session, ticks, options) {
  const readings = [];
  for (const nowMs of ticks) {
    for (let guard = 0; guard < 100_000; guard += 1) {
      const result = await pollLive(session, nowMs, { maxHistory: BIG_HISTORY, ...options });
      readings.push(...result.readings);
      if (result.pagesFetched < options.maxPagesPerTick || result.tradesApplied === 0) break;
    }
  }
  return readings;
}

describe("VPIN gives the same result however the trades reach it", () => {
  let dir;
  let dbPath;
  let counts;
  let reader;
  let adapter;
  let oneShot;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpin-equivalence-"));
    dbPath = path.join(dir, "dxfeed.sqlite");
    counts = buildTape(dbPath);
    reader = createDxFeedStorageReader({ dbPath });
    adapter = createDxFeedVolumeProfileAdapter(reader, "AAPL", "EQUITY");
    oneShot = await runBackfill({ adapter, vBucket: V_BUCKET, fromTs: T0, toTs: T2, pageLimit: 1_000 });
  });

  afterAll(async () => {
    await reader.close();
    safeRm(dir, { recursive: true, force: true });
  });

  test("the fixture exercises what the property is about: ties, whales, unknown sides, ignored corrections and boundary trades", () => {
    expect(counts.ties).toBeGreaterThan(50);
    expect(counts.whales).toBeGreaterThan(5);
    expect(counts.undefined).toBeGreaterThan(20);
    expect(counts.ignored).toBeGreaterThan(5);
    expect(counts.atT1).toBeGreaterThanOrEqual(3);
    expect(counts.atT2).toBe(2);
    expect(oneShot.complete).toBe(true);
    expect(oneShot.readings.length).toBeGreaterThan(50);
    expect(oneShot.tradesApplied).toBe(counts.new - counts.atT2);
  });

  test.each([1, 7, 1_000])("a one-shot backfill is unaffected by the page size (%i)", async (pageLimit) => {
    const paged = await runBackfill({ adapter, vBucket: V_BUCKET, fromTs: T0, toTs: T2, pageLimit, maxPages: 1_000_000 });
    expect(paged.complete).toBe(true);
    expect(paged.vpinState).toEqual(oneShot.vpinState);
    expect(paged.readings).toEqual(oneShot.readings);
    expect(paged.tradesApplied).toBe(oneShot.tradesApplied);
  });

  describe.each([1, 7, 1_000])("backfill to the split, then live polling to the end, with page size %i", (pageLimit) => {
    const seeded = async () => {
      const session = createVpinSession({ adapter, vBucket: V_BUCKET, nowMs: T1 });
      const seed = await seedSessionFromBackfill(session, T0, T1, { pageLimit, maxPages: 1_000_000, maxHistory: BIG_HISTORY });
      expect(seed.complete).toBe(true);
      return { session, seedReadings: [...seed.readings] };
    };

    test("one poll to the end", async () => {
      const { session, seedReadings } = await seeded();
      const polled = await pollLive(session, T2, { pageLimit, maxPagesPerTick: 1_000_000, maxHistory: BIG_HISTORY });
      expect(session.vpinState).toEqual(oneShot.vpinState);
      expect([...seedReadings, ...polled.readings]).toEqual(oneShot.readings);
      expect(polled.tradesApplied).toBeGreaterThan(1_000);
    });

    test("many small polls at moving times, a few pages each", async () => {
      const { session, seedReadings } = await seeded();
      const ticks = [T1 + 40_000, T1 + 41_000, T1 + 120_000, T1 + 200_000, T2];
      const polled = await drainPolls(session, ticks, { pageLimit, maxPagesPerTick: 3 });
      expect(session.vpinState).toEqual(oneShot.vpinState);
      expect([...seedReadings, ...polled]).toEqual(oneShot.readings);
      expect(session.history).toEqual(oneShot.readings);
    });
  });

  test("the trades at the split are counted exactly once: one-shot equals two adjacent backfills chained through the state", async () => {
    const first = await runBackfill({ adapter, vBucket: V_BUCKET, fromTs: T0, toTs: T1, pageLimit: 5 });
    const session = createVpinSession({ adapter, vBucket: V_BUCKET, nowMs: T1 });
    session.vpinState = first.vpinState;
    await pollLive(session, T2, { pageLimit: 5, maxPagesPerTick: 1_000_000, maxHistory: BIG_HISTORY });
    expect(session.vpinState).toEqual(oneShot.vpinState);
    const tradesAtSplit = reader.readTradesSince("AAPL", "EQUITY", { fromTs: T1, toTs: T1 + 1, cursor: null, limit: 100 }).rows;
    expect(tradesAtSplit.length).toBe(counts.atT1);
  });

  test("a trade exactly at the end of the window belongs to the next window, not this one", async () => {
    const throughEnd = await runBackfill({ adapter, vBucket: V_BUCKET, fromTs: T0, toTs: T2 + 1, pageLimit: 50 });
    expect(throughEnd.tradesApplied).toBe(oneShot.tradesApplied + counts.atT2);
  });

  // The remote warm-up cannot page 7 days of trades over a ~200 KB/s link
  // (12,170 pages, 4.25 GB, measured 2026-09-20), so it reads the storage
  // service's sliced notional aggregate instead. Property: with slices two
  // orders of magnitude finer than a bucket -- production is 2 s slices
  // against ~4 min buckets -- the sliced backfill seals the same buckets,
  // agrees on direction, and its z-scores stay within a small tolerance of
  // the exact run. Oracle: the exact backfill through the same real reader.
  // The mechanism bound is on the sealed bucket's imbalance: at most twice
  // one slice's notional over vBucket. z divides that by the tape's own
  // spread, so it is tape-dependent: measured max |dz| at ratio ~1/100 is
  // 0.092 on one seed and 0.272 on this fixture, 0.195 at 1/200, and 1.53 at
  // 1/5 (2 s slices on 10 s buckets), which the last test pins so a coarser
  // geometry can never be mistaken for the same guarantee.
  describe("the sliced backfill approximates the exact one within its slice budget", () => {
    const SLICE_MS = 100;
    const FINE_BUCKET = 450_000;
    const baseline = { nBaseline: 20 };

    function compare(exact, sliced) {
      expect(sliced.complete).toBe(true);
      expect(sliced.readings.length).toBe(exact.readings.length);
      let maxDeltaZ = 0;
      let activeAgreements = 0;
      let directed = 0;
      for (let i = 0; i < exact.readings.length; i += 1) {
        const a = exact.readings[i];
        const b = sliced.readings[i];
        expect(Math.abs(a.sealTs - b.sealTs)).toBeLessThanOrEqual(SLICE_MS);
        if (a.direction !== null && b.direction !== null) {
          directed += 1;
          expect(b.direction).toBe(a.direction);
        }
        if (a.zVpin !== null && b.zVpin !== null) maxDeltaZ = Math.max(maxDeltaZ, Math.abs(a.zVpin - b.zVpin));
        if (a.active === b.active) activeAgreements += 1;
      }
      expect(directed).toBeGreaterThan(20);
      return { maxDeltaZ, activeAgreement: activeAgreements / exact.readings.length };
    }

    test("at the production slice-to-bucket ratio the buckets, directions and z-scores match within tolerance", async () => {
      const exact = await runBackfill({ adapter, vBucket: FINE_BUCKET, fromTs: T0, toTs: T2, pageLimit: 1_000, engineOptions: baseline });
      const sliced = await runBackfill({
        adapter, vBucket: FINE_BUCKET, fromTs: T0, toTs: T2, sliceMs: SLICE_MS, chunkMs: 60_000, backfillMode: "SLICED_APPROXIMATE", engineOptions: baseline,
      });
      expect(exact.readings.length).toBeGreaterThan(100);
      expect(sliced.chunksRead).toBe(10);
      expect(sliced.slicesRead).toBeGreaterThan(2_000);
      expect(sliced.tradesApplied).toBeLessThan(exact.tradesApplied);
      const { maxDeltaZ, activeAgreement } = compare(exact, sliced);
      expect(maxDeltaZ).toBeLessThanOrEqual(0.5);
      expect(activeAgreement).toBeGreaterThanOrEqual(0.98);
    });

    test("reading the aggregate in chunks from an unaligned start equals one read of the whole window", async () => {
      const fromTs = T0 + 37;
      const sliceMs = 250;
      const whole = await runBackfill({
        adapter, vBucket: FINE_BUCKET, fromTs, toTs: T2, sliceMs, chunkMs: 600_000, backfillMode: "SLICED_APPROXIMATE", engineOptions: baseline,
      });
      const chunked = await runBackfill({
        adapter, vBucket: FINE_BUCKET, fromTs, toTs: T2, sliceMs, chunkMs: 5_037, backfillMode: "SLICED_APPROXIMATE", engineOptions: baseline,
      });
      expect(whole.chunksRead).toBe(1);
      expect(chunked.chunksRead).toBeGreaterThan(100);
      expect(chunked.slicesRead).toBe(whole.slicesRead);
      expect(chunked.readings).toEqual(whole.readings);
      expect(chunked.vpinState).toEqual(whole.vpinState);
    });

    test("a slice a fifth of a bucket wide is visibly worse, which is why the remote plan keeps slices two orders finer", async () => {
      const exact = await runBackfill({ adapter, vBucket: FINE_BUCKET, fromTs: T0, toTs: T2, pageLimit: 1_000, engineOptions: baseline });
      const coarse = await runBackfill({
        adapter, vBucket: FINE_BUCKET, fromTs: T0, toTs: T2, sliceMs: 2_000, chunkMs: 60_000, backfillMode: "SLICED_APPROXIMATE", engineOptions: baseline,
      });
      expect(coarse.readings.length).toBe(exact.readings.length);
      let maxDeltaZ = 0;
      for (let i = 0; i < exact.readings.length; i += 1) {
        const a = exact.readings[i];
        const b = coarse.readings[i];
        if (a.zVpin !== null && b.zVpin !== null) maxDeltaZ = Math.max(maxDeltaZ, Math.abs(a.zVpin - b.zVpin));
      }
      expect(maxDeltaZ).toBeGreaterThan(0.75);
    });
  });
});
