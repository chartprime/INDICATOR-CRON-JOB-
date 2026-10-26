const {
  buildHistoricalProfiles,
  buildDirectHistoricalProfiles,
  ensureCoverage,
  MAX_MATERIALIZE_MINUTES_PER_CALL,
  MAX_DIRECT_PROFILE_CONCURRENCY,
} = require("../../../src/indicators/volume-profile/volume-profile-history");
const {
  snapTicksPerRowToGrain,
} = require("../../../src/indicators/volume-profile/volume-profile-engine");
const {
  MINUTE_MS,
  ROLLUP_GRAIN_TICKS,
} = require("../../../src/indicators/volume-profile/volume-profile-cache");

const TICK = 0.01;
const GRAIN = TICK * ROLLUP_GRAIN_TICKS;

// `gaps: "all"` echoes back whatever window it is asked about, so a test can
// tell whether the caller narrowed that window. A fixed gap list cannot: it
// reports the same range no matter what, which silently hides bugs in how
// the requested window is computed.
function fakeCache({ gaps = [], spans = [], byPeriod = new Map() } = {}) {
  const materialized = [];
  return {
    materialized,
    coverageGaps: (instrument, fromMinuteTs, toMinuteTs) =>
      gaps === "all" ? [{ fromMinuteTs, toMinuteTs }] : gaps,
    materialize: (instrument, args) => {
      materialized.push(args);
      return true;
    },
    readPeriodBucketSpans: () => spans,
    readPeriodBuckets: () => byPeriod,
    readBucketRange: () => ({ minBucket: 0, maxBucket: 100, rowCount: 1 }),
  };
}

function fakeAdapter() {
  const calls = [];
  const profileCalls = [];
  return {
    calls,
    profileCalls,
    readMinuteRollup: (fromTs, toTs, tickSize) => {
      calls.push({ fromTs, toTs, tickSize });
      return { rows: [], available: true };
    },
    readVolumeProfile: (fromTs, toTs, originPrice, rowWidth) => {
      profileCalls.push({ fromTs, toTs, originPrice, rowWidth });
      return { buckets: [], available: true };
    },
  };
}

function rangesOf(periodMs, count, endExclusive) {
  const out = [];
  for (let i = count; i > 0; i -= 1) {
    const start = endExclusive - i * periodMs;
    out.push({ rangeStartTs: start, rangeEndTs: start + periodMs });
  }
  return out;
}

// Why a display row must be a whole number of grains: a cache row is exactly
// ROLLUP_GRAIN_TICKS wide, so a display row has to tile whole rollup buckets or
// a cached zone cannot be rebuilt from what is stored.
describe("snapTicksPerRowToGrain -- display rows must tile whole rollup buckets", () => {
  test("snaps to the nearest whole multiple of the grain", () => {
    expect(snapTicksPerRowToGrain(452) % ROLLUP_GRAIN_TICKS).toBe(0);
    expect(snapTicksPerRowToGrain(ROLLUP_GRAIN_TICKS * 3)).toBe(
      ROLLUP_GRAIN_TICKS * 3,
    );
  });

  test("never returns zero -- a sub-grain request is floored at exactly one grain", () => {
    expect(snapTicksPerRowToGrain(1)).toBe(ROLLUP_GRAIN_TICKS);
  });

  test("rejects non-positive inputs", () => {
    expect(() => snapTicksPerRowToGrain(0)).toThrow(/ticksPerRow/);
    expect(() => snapTicksPerRowToGrain(1.5)).toThrow(/ticksPerRow/);
    expect(() => snapTicksPerRowToGrain(32, 0)).toThrow(/grainTicks/);
  });
});

describe("ensureCoverage -- materialise only what is missing", () => {
  test("materialises each reported gap at the rollup grain, not the raw tick size", async () => {
    const cache = fakeCache({
      gaps: [{ fromMinuteTs: 0, toMinuteTs: 3 * MINUTE_MS }],
    });
    const adapter = fakeAdapter();
    expect(
      await ensureCoverage({
        cache,
        adapter,
        instrument: "I",
        tickSize: TICK,
        fromMinuteTs: 0,
        toMinuteTs: 3 * MINUTE_MS,
      }),
    ).toBe(true);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].tickSize).toBeCloseTo(GRAIN, 12);
    expect(cache.materialized[0].tickSize).toBeCloseTo(GRAIN, 12);
  });

  test("does no work at all when the window is already covered", async () => {
    const cache = fakeCache({ gaps: [] });
    const adapter = fakeAdapter();
    await ensureCoverage({
      cache,
      adapter,
      instrument: "I",
      tickSize: TICK,
      fromMinuteTs: 0,
      toMinuteTs: 60 * MINUTE_MS,
    });
    expect(adapter.calls).toHaveLength(0);
  });

  // A single unbounded read of a months-wide gap would block the event loop
  // for the whole scan; chunking bounds each individual query.
  test("splits an oversized gap into bounded chunks", async () => {
    const total = (MAX_MATERIALIZE_MINUTES_PER_CALL * 2 + 10) * MINUTE_MS;
    const cache = fakeCache({ gaps: [{ fromMinuteTs: 0, toMinuteTs: total }] });
    const adapter = fakeAdapter();
    await ensureCoverage({
      cache,
      adapter,
      instrument: "I",
      tickSize: TICK,
      fromMinuteTs: 0,
      toMinuteTs: total,
    });
    expect(adapter.calls).toHaveLength(3);
    for (const call of adapter.calls) {
      expect(call.toTs - call.fromTs).toBeLessThanOrEqual(
        MAX_MATERIALIZE_MINUTES_PER_CALL * MINUTE_MS,
      );
    }
    expect(adapter.calls[0].fromTs).toBe(0);
    expect(adapter.calls[adapter.calls.length - 1].toTs).toBe(total);
  });

  test("reports failure rather than marking an unreadable range as covered", async () => {
    const cache = fakeCache({
      gaps: [{ fromMinuteTs: 0, toMinuteTs: MINUTE_MS }],
    });
    const adapter = {
      readMinuteRollup: () => ({ rows: [], available: false }),
    };
    expect(
      await ensureCoverage({
        cache,
        adapter,
        instrument: "I",
        tickSize: TICK,
        fromMinuteTs: 0,
        toMinuteTs: MINUTE_MS,
      }),
    ).toBe(false);
    expect(cache.materialized).toHaveLength(0);
  });
});

describe("buildHistoricalProfiles", () => {
  const nowMs = 100 * MINUTE_MS + 12_345;

  function bucketsFor(entries) {
    return new Map(
      entries.map(([index, volume]) => [
        index,
        { volume, buyVolume: volume, sellVolume: 0, tradeCount: 1 },
      ]),
    );
  }

  test("returns one session per requested range, carrying that range's own end timestamp", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const byPeriod = new Map([
      [
        ranges[0].rangeStartTs,
        bucketsFor([
          [10, 5],
          [11, 9],
          [12, 2],
        ]),
      ],
      [
        ranges[1].rangeStartTs,
        bucketsFor([
          [10, 1],
          [11, 4],
        ]),
      ],
    ]);
    const cache = fakeCache({
      spans: ranges.map((r) => ({
        periodStartTs: r.rangeStartTs,
        minBucket: 10,
        maxBucket: 12,
      })),
      byPeriod,
    });
    const out = await buildHistoricalProfiles({
      cache,
      adapter: fakeAdapter(),
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: 5 * MINUTE_MS,
      nowMs,
    });
    expect(out).toHaveLength(2);
    expect(out[0].session.periodStartTs).toBe(ranges[0].rangeStartTs);
    expect(out[0].session.periodEndTs).toBe(ranges[0].rangeEndTs);
    expect(out[0].session.originPrice).toBe(0);
    expect(out[0].profile.pocIndex).toBe(11);
  });

  test("every session shares one row width so buckets line up across zones", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 3, 100 * MINUTE_MS);
    const byPeriod = new Map(
      ranges.map((r, i) => [
        r.rangeStartTs,
        bucketsFor([
          [10 + i, 3],
          [11 + i, 6],
        ]),
      ]),
    );
    const cache = fakeCache({
      spans: ranges.map((r) => ({
        periodStartTs: r.rangeStartTs,
        minBucket: 0,
        maxBucket: 80,
      })),
      byPeriod,
    });
    const out = await buildHistoricalProfiles({
      cache,
      adapter: fakeAdapter(),
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: 5 * MINUTE_MS,
      nowMs,
    });
    const widths = new Set(out.map((entry) => entry.session.rowWidth));
    expect(widths.size).toBe(1);
  });

  test("a larger multiplier widens every zone in the batch, and they still share one width", async () => {
    // The old absolute override had a bypass that read each zone uncached so a
    // non-grain-aligned width was honoured literally. That path is gone: a
    // multiplier scales an already grain-aligned, cached width, so there is
    // nothing left to honour exactly.
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const widthFor = async (binSizeMultiplier) => {
      const byPeriod = new Map(
        ranges.map((r) => [
          r.rangeStartTs,
          bucketsFor([
            [10, 3],
            [11, 6],
          ]),
        ]),
      );
      const cache = fakeCache({
        spans: ranges.map((r) => ({
          periodStartTs: r.rangeStartTs,
          minBucket: 0,
          maxBucket: 80,
        })),
        byPeriod,
      });
      const out = await buildHistoricalProfiles({
        cache,
        adapter: fakeAdapter(),
        instrument: "I",
        tickSize: TICK,
        ranges,
        periodMs: 5 * MINUTE_MS,
        binSizeMultiplier,
        nowMs,
      });
      return new Set(out.map((entry) => entry.session.rowWidth));
    };

    const base = await widthFor(1);
    const coarse = await widthFor(4);
    expect(base.size).toBe(1);
    expect(coarse.size).toBe(1);
    expect([...coarse][0]).toBeGreaterThan([...base][0]);
  });

  test("remote history uses compact per-period profiles and never downloads minute rollups", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const adapter = fakeAdapter();
    adapter.prefersDirectHistoricalProfiles = true;
    adapter.readPriceRange = jest
      .fn()
      .mockResolvedValueOnce({
        minPrice: 10,
        maxPrice: 20,
        tradeCount: 3,
        available: true,
      })
      .mockResolvedValueOnce({
        minPrice: 12,
        maxPrice: 18,
        tradeCount: 2,
        available: true,
      });
    adapter.readVolumeProfile = (fromTs, toTs, originPrice, rowWidth) => {
      adapter.profileCalls.push({ fromTs, toTs, originPrice, rowWidth });
      return {
        buckets: [
          { bucket: 2, volume: 9, buyVolume: 5, sellVolume: 4, tradeCount: 1 },
        ],
        available: true,
      };
    };
    const cache = {
      coverageGaps: () => {
        throw new Error("remote history must not materialize minute rows");
      },
    };
    const out = await buildHistoricalProfiles({
      cache,
      adapter,
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: 5 * MINUTE_MS,
      nowMs,
    });
    expect(out).toHaveLength(2);
    expect(adapter.calls).toHaveLength(0);
    expect(adapter.readPriceRange).toHaveBeenCalledTimes(2);
    expect(adapter.profileCalls).toHaveLength(2);
    expect(
      new Set(adapter.profileCalls.map((call) => call.rowWidth)).size,
    ).toBe(1);
    expect(adapter.profileCalls[0].rowWidth / GRAIN).toBeCloseTo(
      Math.round(adapter.profileCalls[0].rowWidth / GRAIN),
      12,
    );
  });

  test("remote history skips per-period price probes when the ATR reading carries a reference range", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const adapter = fakeAdapter();
    adapter.prefersDirectHistoricalProfiles = true;
    adapter.readPriceRange = jest.fn(() => {
      throw new Error("the ATR reference range must replace per-period probes");
    });
    adapter.readVolumeProfile = (fromTs) => ({
      buckets: [
        { bucket: fromTs, volume: 1, buyVolume: 1, sellVolume: 0 },
      ],
      available: true,
    });
    const out = await buildHistoricalProfiles({
      cache: fakeCache(),
      adapter,
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: 5 * MINUTE_MS,
      atrReading: {
        atr: 2,
        barIntervalMs: MINUTE_MS,
        referenceRange: 100,
      },
      nowMs,
    });
    expect(out).toHaveLength(2);
    expect(adapter.readPriceRange).not.toHaveBeenCalled();
  });

  test("remote history keeps readable periods when another period is unavailable", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const adapter = fakeAdapter();
    adapter.prefersDirectHistoricalProfiles = true;
    adapter.readVolumeProfile = (fromTs) =>
      fromTs === ranges[0].rangeStartTs
        ? {
            buckets: [
              { bucket: 1, volume: 3, buyVolume: 2, sellVolume: 1 },
            ],
            available: true,
          }
        : { buckets: [], available: false };
    const out = await buildHistoricalProfiles({
      cache: fakeCache(),
      adapter,
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: 5 * MINUTE_MS,
      atrReading: {
        atr: 2,
        barIntervalMs: MINUTE_MS,
        referenceRange: 100,
      },
      nowMs,
    });
    expect(out).toHaveLength(1);
    expect(out[0].range.rangeStartTs).toBe(ranges[0].rangeStartTs);
  });

  test("remote history reports null only when every readable period failed", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const adapter = fakeAdapter();
    adapter.prefersDirectHistoricalProfiles = true;
    adapter.readVolumeProfile = () => ({ buckets: [], available: false });
    await expect(
      buildHistoricalProfiles({
        cache: fakeCache(),
        adapter,
        instrument: "I",
        tickSize: TICK,
        ranges,
        periodMs: 5 * MINUTE_MS,
        atrReading: {
          atr: 2,
          barIntervalMs: MINUTE_MS,
          referenceRange: 100,
        },
        nowMs,
      }),
    ).resolves.toBeNull();
  });

  test("direct remote profiles are semantically equivalent to cached rollups at the same aligned row width", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 1, 100 * MINUTE_MS);
    const displayBuckets = bucketsFor([[10, 9]]);
    const cache = fakeCache({
      spans: [
        { periodStartTs: ranges[0].rangeStartTs, minBucket: 20, maxBucket: 21 },
      ],
      byPeriod: new Map([[ranges[0].rangeStartTs, displayBuckets]]),
    });
    // Both paths must agree on a width. That used to be forced with an absolute
    // tick override; with the override gone, the shared input is a volatility
    // reading, which is what the two paths really do have in common in
    // production. `referenceRange` is pinned so the clamp cannot differ between
    // them (the cache path derives it from a median span, the direct path from
    // its own price probe).
    const atrReading = {
      atr: 2,
      barIntervalMs: MINUTE_MS,
      referenceRange: 100,
    };
    const local = await buildHistoricalProfiles({
      cache,
      adapter: fakeAdapter(),
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: 5 * MINUTE_MS,
      atrReading,
      nowMs,
    });
    const remoteAdapter = fakeAdapter();
    remoteAdapter.prefersDirectHistoricalProfiles = true;
    remoteAdapter.readVolumeProfile = async () => ({
      buckets: [
        { bucket: 10, volume: 9, buyVolume: 9, sellVolume: 0, tradeCount: 2 },
      ],
      available: true,
    });
    const remote = await buildHistoricalProfiles({
      cache: {
        coverageGaps: () => {
          throw new Error("remote path must not use cache");
        },
      },
      adapter: remoteAdapter,
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: 5 * MINUTE_MS,
      atrReading,
      nowMs,
    });
    const normalize = (entry) => ({
      range: entry.range,
      session: { ...entry.session, buckets: [...entry.session.buckets] },
      profile: entry.profile,
    });
    expect(remote.map(normalize)).toEqual(local.map(normalize));
  });

  test("direct history distinguishes an empty covered window from unavailable storage", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 1, 100 * MINUTE_MS);
    const emptyAdapter = {
      readPriceRange: async () => ({
        minPrice: null,
        maxPrice: null,
        tradeCount: 0,
        available: true,
      }),
      readVolumeProfile: () => {
        throw new Error("empty history needs no profile query");
      },
    };
    await expect(
      buildDirectHistoricalProfiles({
        adapter: emptyAdapter,
        ranges,
        tickSize: TICK,
      }),
    ).resolves.toEqual([]);
    const unavailableAdapter = {
      ...emptyAdapter,
      readPriceRange: async () => ({ tradeCount: 0, available: false }),
    };
    await expect(
      buildDirectHistoricalProfiles({
        adapter: unavailableAdapter,
        ranges,
        tickSize: TICK,
      }),
    ).resolves.toBeNull();
  });

  test("direct profile reads use bounded concurrency and preserve range order", async () => {
    const ranges = rangesOf(MINUTE_MS, 10, 100 * MINUTE_MS);
    let active = 0;
    let maxActive = 0;
    const adapter = {
      async readVolumeProfile(fromTs) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return {
          buckets: [
            {
              bucket: fromTs / MINUTE_MS,
              volume: 1,
              buyVolume: 1,
              sellVolume: 0,
            },
          ],
          available: true,
        };
      },
    };
    const out = await buildDirectHistoricalProfiles({
      adapter,
      ranges,
      tickSize: TICK,
      atrReading: { atr: 2, barIntervalMs: MINUTE_MS },
      periodMs: 5 * MINUTE_MS,
    });
    expect(maxActive).toBe(MAX_DIRECT_PROFILE_CONCURRENCY);
    expect(out.map((entry) => entry.range.rangeStartTs)).toEqual(
      ranges.map((range) => range.rangeStartTs),
    );
  });

  test("row width is always a whole number of rollup grains -- the exactness invariant", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const byPeriod = new Map(
      ranges.map((r) => [
        r.rangeStartTs,
        bucketsFor([
          [5, 1],
          [6, 2],
        ]),
      ]),
    );
    for (const maxBucket of [1, 17, 400, 9_000]) {
      const cache = fakeCache({
        spans: ranges.map((r) => ({
          periodStartTs: r.rangeStartTs,
          minBucket: 0,
          maxBucket,
        })),
        byPeriod,
      });
      const out = await buildHistoricalProfiles({
        cache,
        adapter: fakeAdapter(),
        instrument: "I",
        tickSize: TICK,
        ranges,
        periodMs: 5 * MINUTE_MS,
        nowMs,
      });
      const grains = out[0].session.rowWidth / GRAIN;
      expect(Math.abs(grains - Math.round(grains))).toBeLessThan(1e-9);
      expect(Math.round(grains)).toBeGreaterThanOrEqual(1);
    }
  });

  // The current minute is still accumulating trades. Caching it would freeze
  // a partial minute into the rollup permanently.
  test("never materialises past the last completed minute", async () => {
    // The requested range deliberately runs an hour past `nowMs`; only the
    // minutes that have actually finished may be cached.
    const ranges = [
      { rangeStartTs: 99 * MINUTE_MS, rangeEndTs: 160 * MINUTE_MS },
    ];
    const cache = fakeCache({ gaps: "all", spans: [], byPeriod: new Map() });
    const adapter = fakeAdapter();
    await buildHistoricalProfiles({
      cache,
      adapter,
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: MINUTE_MS,
      nowMs,
    });
    expect(adapter.calls).toEqual([]);
    expect(adapter.profileCalls).toEqual([]);
  });

  test.each([null, 1])(
    "never labels a partially elapsed period as closed historical output (ticksPerRow=%s)",
    async (ticksPerRow) => {
      const ranges = [
        { rangeStartTs: 99 * MINUTE_MS, rangeEndTs: 101 * MINUTE_MS },
      ];
      const byPeriod = new Map([[99 * MINUTE_MS, bucketsFor([[1, 5]])]]);
      const cache = fakeCache({
        spans: [{ periodStartTs: 99 * MINUTE_MS, minBucket: 1, maxBucket: 1 }],
        byPeriod,
      });
      const adapter = fakeAdapter();
      adapter.readVolumeProfile = () => ({
        available: true,
        buckets: [{ bucket: 1, volume: 5, buyVolume: 5, sellVolume: 0 }],
      });
      expect(
        await buildHistoricalProfiles({
          cache,
          adapter,
          instrument: "I",
          tickSize: TICK,
          ranges,
          periodMs: MINUTE_MS,
          ticksPerRow,
          nowMs,
        }),
      ).toEqual([]);
    },
  );

  test("returns an empty list, not null, when the covered window genuinely holds no trades", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const cache = fakeCache({ spans: [], byPeriod: new Map() });
    expect(
      await buildHistoricalProfiles({
        cache,
        adapter: fakeAdapter(),
        instrument: "I",
        tickSize: TICK,
        ranges,
        periodMs: 5 * MINUTE_MS,
        nowMs,
      }),
    ).toEqual([]);
  });

  test("returns null -- a signal to fall back, not an empty result -- when the cache cannot answer", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 2, 100 * MINUTE_MS);
    const unavailable = { ...fakeCache(), coverageGaps: () => null };
    expect(
      await buildHistoricalProfiles({
        cache: unavailable,
        adapter: fakeAdapter(),
        instrument: "I",
        tickSize: TICK,
        ranges,
        periodMs: 5 * MINUTE_MS,
        nowMs,
      }),
    ).toBeNull();
  });

  test("refuses a period that is not a whole number of minutes, rather than silently misgrouping", async () => {
    const ranges = [{ rangeStartTs: 0, rangeEndTs: 30_000 }];
    expect(
      await buildHistoricalProfiles({
        cache: fakeCache(),
        adapter: fakeAdapter(),
        instrument: "I",
        tickSize: TICK,
        ranges,
        periodMs: 30_000,
        nowMs,
      }),
    ).toBeNull();
  });

  test("drops a returned period that no requested range asked for", async () => {
    const ranges = rangesOf(5 * MINUTE_MS, 1, 100 * MINUTE_MS);
    const byPeriod = new Map([
      [ranges[0].rangeStartTs, bucketsFor([[1, 1]])],
      [12_345_000, bucketsFor([[1, 1]])],
    ]);
    const cache = fakeCache({
      spans: [
        { periodStartTs: ranges[0].rangeStartTs, minBucket: 0, maxBucket: 40 },
      ],
      byPeriod,
    });
    const out = await buildHistoricalProfiles({
      cache,
      adapter: fakeAdapter(),
      instrument: "I",
      tickSize: TICK,
      ranges,
      periodMs: 5 * MINUTE_MS,
      nowMs,
    });
    expect(out).toHaveLength(1);
    expect(out[0].session.periodStartTs).toBe(ranges[0].rangeStartTs);
  });

  test("an empty range list is answered without touching storage", async () => {
    const adapter = fakeAdapter();
    expect(
      await buildHistoricalProfiles({
        cache: fakeCache(),
        adapter,
        instrument: "I",
        tickSize: TICK,
        ranges: [],
        periodMs: MINUTE_MS,
        nowMs,
      }),
    ).toEqual([]);
    expect(adapter.calls).toHaveLength(0);
  });
});
