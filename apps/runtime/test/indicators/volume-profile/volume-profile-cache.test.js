const os = require("node:os");
const path = require("node:path");
const { createStorageDb } = require("../../../src/storage/storage-db");
const { createStorageReader } = require("../../../src/storage/storage-reader");
const { createVolumeProfileCache, MINUTE_MS, floorToMinute } = require("../../../src/indicators/volume-profile/volume-profile-cache");
const { computeProfile } = require("../../../src/indicators/volume-profile/volume-profile-engine");
const { safeRm } = require("../../helpers/temp-files");

const INSTRUMENT = "BINANCE:BTCUSDT:SPOT";
const TICK_SIZE = 0.01;

function tempPath(tag) {
  return path.join(os.tmpdir(), `terminal-l1-l2-vp-cache-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function removeQuietly(target) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      safeRm(`${target}${suffix}`, { force: true });
    } catch {
      void 0;
    }
  }
}

// A deterministic but non-trivial tape: prices wander across many tick
// buckets and both sides trade, so POC/value-area placement is a real
// computation rather than a single-bucket degenerate case.
function seedTape(writer, baseTs, count) {
  for (let i = 0; i < count; i += 1) {
    const price = 100 + ((i * 7) % 53) * 0.03 + (i % 3) * 0.01;
    writer.insert("trades", {
      ts: baseTs + i * 137,
      symbol: "BTCUSDT",
      marketKind: "SPOT",
      price: price.toFixed(8),
      size: (0.1 + (i % 11) * 0.017).toFixed(8),
      side: i % 4 === 0 ? "sell" : "buy",
      tradeId: `t-${baseTs}-${i}`,
    });
  }
}

function profileFromBuckets(buckets) {
  const engineBuckets = new Map();
  for (const [index, bucket] of buckets) {
    engineBuckets.set(index, { volume: bucket.volume, buyVolume: bucket.buyVolume, sellVolume: bucket.sellVolume });
  }
  return { buckets: engineBuckets, profile: computeProfile(engineBuckets) };
}

describe("volume-profile-cache -- the accuracy gate: rollup must equal a raw scan exactly", () => {
  let rawPath;
  let cachePath;
  let reader;
  let cache;

  beforeEach(() => {
    rawPath = tempPath("raw");
    cachePath = tempPath("cache");
    const writer = createStorageDb({ dbPath: rawPath });
    seedTape(writer, 5 * MINUTE_MS, 900);
    writer.close();
    reader = createStorageReader({ dbPath: rawPath });
    cache = createVolumeProfileCache({ dbPath: cachePath });
  });

  afterEach(() => {
    reader.close();
    cache.close();
    removeQuietly(rawPath);
    removeQuietly(cachePath);
  });

  // The whole design rests on this identity: display buckets are exact sums
  // of whole tick-grain rollup buckets, so nothing is approximated.
  test.each([1, 4, 25, 137])(
    "rollup-derived buckets, POC, VAH, VAL and volumes are identical to a raw scan at ticksPerRow=%i",
    (ticksPerRow) => {
      const fromMinuteTs = 0;
      const toMinuteTs = 10 * MINUTE_MS;
      const rowWidth = TICK_SIZE * ticksPerRow;

      const rawRead = reader.readVolumeProfile("BTCUSDT", "SPOT", {
        fromTs: fromMinuteTs, toTs: toMinuteTs, originPrice: 0, rowWidth,
      });
      expect(rawRead.available).toBe(true);
      expect(rawRead.buckets.length).toBeGreaterThan(0);
      const rawBuckets = new Map(rawRead.buckets.map((row) => [row.bucket, row]));

      const source = reader.readMinuteRollup("BTCUSDT", "SPOT", {
        fromTs: fromMinuteTs, toTs: toMinuteTs, tickSize: TICK_SIZE,
      });
      expect(source.available).toBe(true);
      expect(cache.materialize(INSTRUMENT, { tickSize: TICK_SIZE, fromMinuteTs, toMinuteTs, rows: source.rows })).toBe(true);

      const byPeriod = cache.readPeriodBuckets(INSTRUMENT, {
        fromMinuteTs, toMinuteTs, periodMs: toMinuteTs - fromMinuteTs, ticksPerRow,
      });
      expect(byPeriod.size).toBe(1);
      const cachedBuckets = byPeriod.get(fromMinuteTs);

      expect([...cachedBuckets.keys()].sort((a, b) => a - b)).toEqual([...rawBuckets.keys()].sort((a, b) => a - b));
      for (const [index, cached] of cachedBuckets) {
        const raw = rawBuckets.get(index);
        expect(cached.volume).toBeCloseTo(raw.volume, 9);
        expect(cached.buyVolume).toBeCloseTo(raw.buyVolume, 9);
        expect(cached.sellVolume).toBeCloseTo(raw.sellVolume, 9);
        expect(cached.tradeCount).toBe(raw.tradeCount);
      }

      const fromRaw = profileFromBuckets(rawBuckets);
      const fromCache = profileFromBuckets(cachedBuckets);
      expect(fromCache.profile.pocIndex).toBe(fromRaw.profile.pocIndex);
      expect(fromCache.profile.vaHigh).toBe(fromRaw.profile.vaHigh);
      expect(fromCache.profile.vaLow).toBe(fromRaw.profile.vaLow);
      expect(fromCache.profile.singlePrintBuckets).toEqual(fromRaw.profile.singlePrintBuckets);
      expect(fromCache.profile.totalVolume).toBeCloseTo(fromRaw.profile.totalVolume, 9);
    },
  );

  test("splits one materialised range into many periods in a single read -- the batched path", () => {
    const fromMinuteTs = 0;
    const toMinuteTs = 10 * MINUTE_MS;
    const source = reader.readMinuteRollup("BTCUSDT", "SPOT", { fromTs: fromMinuteTs, toTs: toMinuteTs, tickSize: TICK_SIZE });
    cache.materialize(INSTRUMENT, { tickSize: TICK_SIZE, fromMinuteTs, toMinuteTs, rows: source.rows });

    const byPeriod = cache.readPeriodBuckets(INSTRUMENT, {
      fromMinuteTs, toMinuteTs, periodMs: 2 * MINUTE_MS, ticksPerRow: 4,
    });

    // Every returned key is a real 2-minute epoch boundary, not a float --
    // binding a JS number makes SQLite's `/` float division, which would
    // silently group per row instead of per period.
    for (const periodStart of byPeriod.keys()) {
      expect(Number.isSafeInteger(periodStart)).toBe(true);
      expect(periodStart % (2 * MINUTE_MS)).toBe(0);
    }
    expect(byPeriod.size).toBeGreaterThan(1);
    expect(byPeriod.size).toBeLessThanOrEqual(5);
  });

  test("summing every period of a split read reproduces the single-period totals exactly", () => {
    const fromMinuteTs = 0;
    const toMinuteTs = 10 * MINUTE_MS;
    const source = reader.readMinuteRollup("BTCUSDT", "SPOT", { fromTs: fromMinuteTs, toTs: toMinuteTs, tickSize: TICK_SIZE });
    cache.materialize(INSTRUMENT, { tickSize: TICK_SIZE, fromMinuteTs, toMinuteTs, rows: source.rows });

    const whole = cache.readPeriodBuckets(INSTRUMENT, { fromMinuteTs, toMinuteTs, periodMs: toMinuteTs, ticksPerRow: 8 });
    const split = cache.readPeriodBuckets(INSTRUMENT, { fromMinuteTs, toMinuteTs, periodMs: MINUTE_MS, ticksPerRow: 8 });

    let wholeVolume = 0;
    for (const bucket of whole.get(0).values()) wholeVolume += bucket.volume;
    let splitVolume = 0;
    for (const buckets of split.values()) {
      for (const bucket of buckets.values()) splitVolume += bucket.volume;
    }
    expect(splitVolume).toBeCloseTo(wholeVolume, 9);
  });
});

describe("volume-profile-cache -- coverage tracking", () => {
  let cachePath;
  let cache;

  beforeEach(() => {
    cachePath = tempPath("coverage");
    cache = createVolumeProfileCache({ dbPath: cachePath });
  });

  afterEach(() => {
    cache.close();
    removeQuietly(cachePath);
  });

  test("reports the whole window as a gap before anything is materialised", () => {
    expect(cache.coverageGaps(INSTRUMENT, 0, 5 * MINUTE_MS)).toEqual([{ fromMinuteTs: 0, toMinuteTs: 5 * MINUTE_MS }]);
  });

  // A minute with no trades is still a materialised minute. Without this,
  // a quiet minute would be re-queried against the 20GB table forever.
  test("a materialised but empty minute counts as covered, not as a gap", () => {
    cache.materialize(INSTRUMENT, { tickSize: TICK_SIZE, fromMinuteTs: 0, toMinuteTs: 3 * MINUTE_MS, rows: [] });
    expect(cache.coverageGaps(INSTRUMENT, 0, 3 * MINUTE_MS)).toEqual([]);
  });

  test("reports only the uncovered minutes, coalesced into contiguous runs", () => {
    cache.materialize(INSTRUMENT, { tickSize: TICK_SIZE, fromMinuteTs: 2 * MINUTE_MS, toMinuteTs: 4 * MINUTE_MS, rows: [] });
    expect(cache.coverageGaps(INSTRUMENT, 0, 6 * MINUTE_MS)).toEqual([
      { fromMinuteTs: 0, toMinuteTs: 2 * MINUTE_MS },
      { fromMinuteTs: 4 * MINUTE_MS, toMinuteTs: 6 * MINUTE_MS },
    ]);
  });

  test("a changed tick size discards that instrument's rollup instead of mixing two grains", () => {
    cache.materialize(INSTRUMENT, {
      tickSize: TICK_SIZE, fromMinuteTs: 0, toMinuteTs: MINUTE_MS,
      rows: [{ minuteTs: 0, priceBucket: 10, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 }],
    });
    expect(cache.coverageGaps(INSTRUMENT, 0, MINUTE_MS)).toEqual([]);

    cache.materialize(INSTRUMENT, {
      tickSize: 0.5, fromMinuteTs: MINUTE_MS, toMinuteTs: 2 * MINUTE_MS,
      rows: [{ minuteTs: MINUTE_MS, priceBucket: 3, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 }],
    });
    expect(cache.coverageGaps(INSTRUMENT, 0, MINUTE_MS)).toEqual([{ fromMinuteTs: 0, toMinuteTs: MINUTE_MS }]);
  });

  test("rejects rows that fall outside the window they claim to cover", () => {
    expect(() => cache.materialize(INSTRUMENT, {
      tickSize: TICK_SIZE, fromMinuteTs: 0, toMinuteTs: MINUTE_MS,
      rows: [{ minuteTs: 5 * MINUTE_MS, priceBucket: 1, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 }],
    })).toThrow(/minute window/);
  });

  test("rejects a negative price bucket -- the grouping SQL assumes non-negative prices", () => {
    expect(() => cache.materialize(INSTRUMENT, {
      tickSize: TICK_SIZE, fromMinuteTs: 0, toMinuteTs: MINUTE_MS,
      rows: [{ minuteTs: 0, priceBucket: -1, volume: 1, buyVolume: 1, sellVolume: 0, tradeCount: 1 }],
    })).toThrow(/non-negative/);
  });

  test("rejects windows that are not minute boundaries", () => {
    expect(() => cache.coverageGaps(INSTRUMENT, 1, MINUTE_MS)).toThrow(/minute boundary/);
    expect(() => cache.coverageGaps(INSTRUMENT, 0, MINUTE_MS + 1)).toThrow(/minute boundary/);
  });

  // A stale-version cache must be rebuilt structurally, not just emptied:
  // a future version that changes column shape would otherwise keep the old
  // table and fail on every insert.
  test("a cache written by a different schema version is rebuilt from scratch", () => {
    cache.materialize(INSTRUMENT, {
      tickSize: TICK_SIZE, fromMinuteTs: 0, toMinuteTs: MINUTE_MS,
      rows: [{ minuteTs: 0, priceBucket: 7, volume: 2, buyVolume: 2, sellVolume: 0, tradeCount: 1 }],
    });
    expect(cache.coverageGaps(INSTRUMENT, 0, MINUTE_MS)).toEqual([]);
    cache.close();

    const Database = require("better-sqlite3");
    const raw = new Database(cachePath);
    raw.prepare("UPDATE vp_meta SET value = '999' WHERE key = 'schema_version'").run();
    raw.close();

    cache = createVolumeProfileCache({ dbPath: cachePath });
    expect(cache.coverageGaps(INSTRUMENT, 0, MINUTE_MS)).toEqual([{ fromMinuteTs: 0, toMinuteTs: MINUTE_MS }]);
  });

  test("version 2 rollups are discarded when the tick grain changes", () => {
    cache.materialize(INSTRUMENT, {
      tickSize: TICK_SIZE, fromMinuteTs: 0, toMinuteTs: MINUTE_MS,
      rows: [{ minuteTs: 0, priceBucket: 7, volume: 2, buyVolume: 2, sellVolume: 0, tradeCount: 1 }],
    });
    cache.close();
    const Database = require("better-sqlite3");
    const raw = new Database(cachePath);
    raw.prepare("UPDATE vp_meta SET value = '2' WHERE key = 'schema_version'").run();
    raw.close();

    cache = createVolumeProfileCache({ dbPath: cachePath });
    expect(cache.coverageGaps(INSTRUMENT, 0, MINUTE_MS)).toEqual([{ fromMinuteTs: 0, toMinuteTs: MINUTE_MS }]);
  });

  test("floorToMinute snaps to the containing minute", () => {
    expect(floorToMinute(3 * MINUTE_MS + 59_999)).toBe(3 * MINUTE_MS);
    expect(floorToMinute(3 * MINUTE_MS)).toBe(3 * MINUTE_MS);
  });
});
