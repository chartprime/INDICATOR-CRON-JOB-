const { createLearnedCuts, DEFAULT_LEARNED_CUTS } = require("../../../src/indicators/iceberg/learned-cuts");

function ramp(n, scale = 1) {
  return Array.from({ length: n }, (_, i) => ((i + 1) / n) * scale);
}

describe("indicators/iceberg/learned-cuts", () => {
  test("defaults are percentiles and multiples, never sizes", () => {
    expect(DEFAULT_LEARNED_CUTS).toEqual({ visiblePercentile: 0.9, durationPercentile: 0.99, ratioPercentile: 0.99, strongMultiple: 1.5, minRatio: 1, minSamples: 200, minRatioSamples: 50, capacity: 4096 });
    expect(Object.isFrozen(DEFAULT_LEARNED_CUTS)).toBe(true);
  });

  test("not ready until every distribution has minSamples observations and the ratio cut its own samples", () => {
    const cuts = createLearnedCuts({ minSamples: 3, minRatioSamples: 1 });
    expect(cuts.current().ready).toBe(false);
    cuts.observeTouch(1); cuts.observeTouch(2); cuts.observeTouch(3);
    cuts.observeEpisode({ ratio: 0.5, durationMs: 100 });
    cuts.observeEpisode({ ratio: 0.5, durationMs: 100 });
    expect(cuts.current().ready).toBe(false);
    cuts.observeEpisode({ ratio: 0.5, durationMs: 100 });
    expect(cuts.current().ready).toBe(false);
    cuts.observeEpisode({ ratio: 0.5, durationMs: 100, solid: true });
    expect(cuts.current().ready).toBe(true);
  });

  test("the floor is the visible percentile of what the touch showed", () => {
    const cuts = createLearnedCuts({ minSamples: 10, visiblePercentile: 0.9 });
    for (const v of ramp(100, 10)) cuts.observeTouch(v);
    for (let i = 0; i < 10; i += 1) cuts.observeEpisode({ ratio: 1, durationMs: 1000 });
    expect(cuts.current().visibleFloor).toBeCloseTo(9, 1);
  });

  test("the duration cut is the duration percentile over every episode", () => {
    const cuts = createLearnedCuts({ minSamples: 10, durationPercentile: 0.5 });
    for (let i = 0; i < 10; i += 1) cuts.observeTouch(1);
    for (const d of ramp(100, 10_000)) cuts.observeEpisode({ ratio: 0.1, durationMs: d });
    expect(cuts.current().minDurationMs).toBeCloseTo(5000, -2);
  });

  test("the ratio cut is learned only from episodes that passed the floor and the duration, and strong is a multiple of it", () => {
    const cuts = createLearnedCuts({ minSamples: 10, durationPercentile: 0.5, ratioPercentile: 0.9, strongMultiple: 2 });
    for (let i = 0; i < 10; i += 1) cuts.observeTouch(1);
    for (const d of ramp(100, 10_000)) cuts.observeEpisode({ ratio: 100, durationMs: d, solid: false });
    for (const r of ramp(100, 10)) cuts.observeEpisode({ ratio: r, durationMs: 9000, solid: true });
    const current = cuts.current();
    expect(current.ratioCut).toBeCloseTo(9, 1);
    expect(current.strongRatio).toBeCloseTo(18, 1);
  });

  test("the ratio cut never goes under the floor, one by default: the learned cut alone decides what is an iceberg and the chart's refills slider is the trader's floor; a raised floor holds, however loose the book's own ratios are", () => {
    expect(DEFAULT_LEARNED_CUTS.minRatio).toBe(1);
    const feed = (cuts, top) => {
      for (let i = 0; i < 10; i += 1) cuts.observeTouch(1);
      for (const d of ramp(100, 10_000)) cuts.observeEpisode({ ratio: 100, durationMs: d, solid: false });
      for (const r of ramp(100, top)) cuts.observeEpisode({ ratio: r, durationMs: 9000, solid: true });
      return cuts.current();
    };
    const options = { minSamples: 10, durationPercentile: 0.5, ratioPercentile: 0.9, strongMultiple: 2 };
    const loose = feed(createLearnedCuts(options), 1.2);
    expect(loose.ratioCut).toBeGreaterThan(1);
    expect(loose.ratioCut).toBeLessThanOrEqual(1.2);
    expect(loose.minRatio).toBe(1);
    expect(feed(createLearnedCuts(options), 0.5)).toMatchObject({ ratioCut: 1, strongRatio: 2, minRatio: 1 });
    expect(feed(createLearnedCuts(options), 10).ratioCut).toBeCloseTo(9, 1);
    expect(feed(createLearnedCuts({ ...options, minRatio: 3 }), 1.2)).toMatchObject({ ratioCut: 3, strongRatio: 6, minRatio: 3 });
    expect(createLearnedCuts(options).current().ratioCut).toBeNull();
    expect(() => createLearnedCuts({ minRatio: 0.5 })).toThrow(/minRatio/);
  });

  test("short or thin episodes do not shape the ratio cut even when flagged solid", () => {
    const cuts = createLearnedCuts({ minSamples: 10, durationPercentile: 0.5, ratioPercentile: 0.9 });
    for (let i = 0; i < 10; i += 1) cuts.observeTouch(1);
    for (const d of ramp(100, 10_000)) cuts.observeEpisode({ ratio: 1, durationMs: d, solid: true });
    for (let i = 0; i < 50; i += 1) cuts.observeEpisode({ ratio: 50, durationMs: 10, solid: true });
    expect(cuts.current().ratioCut).toBe(DEFAULT_LEARNED_CUTS.minRatio);
  });

  test("single-print episodes do not shape the duration cut, they are most of the tape and last no time", () => {
    const cuts = createLearnedCuts({ minSamples: 10, durationPercentile: 0.5 });
    for (let i = 0; i < 10; i += 1) cuts.observeTouch(1);
    for (let i = 0; i < 500; i += 1) cuts.observeEpisode({ ratio: 1, durationMs: 0, hits: 1 });
    for (const d of ramp(100, 10_000)) cuts.observeEpisode({ ratio: 1, durationMs: d, hits: 3 });
    expect(cuts.current().minDurationMs).toBeCloseTo(5000, -2);
    expect(cuts.current().samples.episodes).toBe(100);
    expect(() => cuts.observeEpisode({ ratio: 1, durationMs: 1, hits: 0 })).toThrow(/hits/);
  });

  test("memory is a ring: only the last capacity observations count", () => {
    const cuts = createLearnedCuts({ minSamples: 5, capacity: 100, visiblePercentile: 0.5 });
    for (let i = 0; i < 100; i += 1) cuts.observeTouch(1000);
    for (let i = 0; i < 100; i += 1) cuts.observeTouch(1);
    for (let i = 0; i < 5; i += 1) cuts.observeEpisode({ ratio: 1, durationMs: 1 });
    expect(cuts.current().visibleFloor).toBe(1);
  });

  test("current() is frozen and carries the resolved numbers with the parameters that produced them", () => {
    const cuts = createLearnedCuts({ minSamples: 1, minRatioSamples: 1 });
    cuts.observeTouch(2); cuts.observeEpisode({ ratio: 3, durationMs: 4000, solid: true });
    const current = cuts.current();
    expect(Object.isFrozen(current)).toBe(true);
    expect(current).toMatchObject({ ready: true, visibleFloor: 2, minDurationMs: 4000, ratioCut: 3, strongRatio: 4.5, visiblePercentile: 0.9, durationPercentile: 0.99, ratioPercentile: 0.99, strongMultiple: 1.5 });
  });

  test("the cuts round-trip through toJSON and load in ring order, so a restart learns nothing twice; load refuses a foreign shape and leaves the cuts as they were", () => {
    const options = { minSamples: 10, minRatioSamples: 5, durationPercentile: 0.5, ratioPercentile: 0.9 };
    const cuts = createLearnedCuts(options);
    for (const v of ramp(20, 4)) cuts.observeTouch(v);
    for (const d of ramp(30, 10_000)) cuts.observeEpisode({ ratio: 3 + d / 10_000, durationMs: d, solid: true });
    const saved = JSON.parse(JSON.stringify(cuts.toJSON()));
    expect(saved).toMatchObject({ version: 1 });
    expect(saved.touch).toEqual(ramp(20, 4));
    expect(saved.durations).toHaveLength(30);
    const restored = createLearnedCuts(options);
    expect(restored.current().ready).toBe(false);
    expect(restored.load(saved)).toBe(true);
    expect(restored.current()).toEqual(cuts.current());
    expect(restored.current().ready).toBe(true);
    expect(restored.version).toBeGreaterThan(0);
    for (const bad of [null, { ...saved, ratios: ["x"] }, { ...saved, version: 2 }, { ...saved, touch: [-1] }]) expect(restored.load(bad)).toBe(false);
    expect(restored.current()).toEqual(cuts.current());
    expect(createLearnedCuts({ ...options, capacity: 10 }).load(saved)).toBe(false);
    const wrapped = createLearnedCuts({ ...options, capacity: 20 });
    for (const v of ramp(25, 25)) wrapped.observeTouch(v);
    expect(wrapped.toJSON().touch).toEqual(ramp(25, 25).slice(5));
  });

  test("not ready until the ratio cut has minRatioSamples behind it, so a cold start never marks on a handful of ratios", () => {
    const cuts = createLearnedCuts({ minSamples: 10, minRatioSamples: 5, durationPercentile: 0.5 });
    for (let i = 0; i < 10; i += 1) cuts.observeTouch(1);
    for (const d of ramp(10, 10_000)) cuts.observeEpisode({ ratio: 3, durationMs: d, solid: false });
    for (let i = 0; i < 4; i += 1) cuts.observeEpisode({ ratio: 3, durationMs: 9000, solid: true });
    expect(cuts.current()).toMatchObject({ ready: false, samples: { ratios: 4 } });
    cuts.observeEpisode({ ratio: 3, durationMs: 9000, solid: true });
    expect(cuts.current()).toMatchObject({ ready: true, samples: { ratios: 5 }, minRatioSamples: 5 });
    expect(() => createLearnedCuts({ minRatioSamples: 0 })).toThrow(/minRatioSamples/);
  });

  test("observations must be finite non-negative numbers and options sane", () => {
    const cuts = createLearnedCuts();
    expect(() => cuts.observeTouch(-1)).toThrow(/touch/);
    expect(() => cuts.observeTouch(Number.NaN)).toThrow(/touch/);
    expect(() => cuts.observeEpisode({ ratio: -1, durationMs: 1 })).toThrow(/ratio/);
    expect(() => cuts.observeEpisode({ ratio: 1, durationMs: Number.POSITIVE_INFINITY })).toThrow(/duration/);
    expect(() => createLearnedCuts({ visiblePercentile: 1.5 })).toThrow(/visiblePercentile/);
    expect(() => createLearnedCuts({ strongMultiple: 0.5 })).toThrow(/strongMultiple/);
    expect(() => createLearnedCuts({ capacity: 10 })).toThrow(/capacity/);
    expect(() => createLearnedCuts({ minSamples: 0 })).toThrow(/minSamples/);
  });
});
