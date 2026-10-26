const { createInitiativeTracker, INITIATIVE_RULES_VERSION, CANDLE_MS, FACTS, SIDES, DOMINANTS, EFFICIENCY_AT, STRONG_THIRD, STRONG_SHARE, BURST_AT, QUIET_MIN, RANK_AT, TYPICAL_MS, TYPICAL_MIN, MAX_SCORE, MAX_BANDS, typicalCount } = require("../../../src/indicators/initiative/initiative-engine");
const { createExhaustionTracker, EXHAUSTION_RULES_VERSION } = require("../../../src/indicators/exhaustion/exhaustion-engine");
const { MINUTE, column, at, warmColumns, riseColumns, warmAtr } = require("../../fixtures/exhaustion/columns");
const { HOLE, bar, warmSkewed, quietRise, heavyQuietRise, fallBars, fallBars4, choppyFall, sellersFlip, closer, riseBack } = require("../../fixtures/initiative/candles");

const DOWN = `60000|down|${at(5)}`;
const UP = `60000|up|${at(9)}`;

function tracker() {
  return createInitiativeTracker({ candleMs: MINUTE, rowWidth: 1 });
}

function feed(t, columns) {
  const updates = [];
  for (const c of columns) updates.push(...t.push(c));
  return updates;
}

function atrAfterCandle(columns, closingTs) {
  const e = createExhaustionTracker({ candleMs: MINUTE, rowWidth: 1 });
  for (const c of columns) if (c.ts < closingTs) e.push(c);
  e.push(column(closingTs, { mid: 105 }));
  return e.stats().atr;
}

function born(t) {
  expect(feed(t, sellersFlip())).toEqual([]);
  const updates = t.push(closer(9));
  expect(updates).toHaveLength(1);
  return updates[0];
}

function downBand(overrides = {}) {
  return {
    id: DOWN,
    candleMs: MINUTE,
    side: "down",
    dominant: "sellers",
    dominantShare: 0.75,
    score: 4,
    facts: {
      efficiency: { yes: true, value: 0.714 },
      closes: { yes: true, value: 2 },
      burst: { yes: false, value: 0.8 },
      delta: { yes: true, rank: 1, share: 0.75 },
      prints: { yes: true, rank: 0.833, perCandle: 1 },
    },
    pivotTs: at(5),
    pivotPrice: 108,
    frozenTs: at(8),
    frozenPrice: 105.5,
    windowCandles: 3,
    atr: expect.closeTo(atrAfterCandle(sellersFlip(), at(6)), 10),
    legExtremePrice: 105,
    legExtremeTs: at(8),
    legEndTs: null,
    updatedAt: at(9),
    ...overrides,
  };
}

describe("indicators/initiative/initiative-engine", () => {
  test("only the chart's candle lengths and a positive row width are accepted; the vocabularies are the five facts, two sides and two dominants; the thresholds are the measured ones", () => {
    expect(() => createInitiativeTracker({ candleMs: 240_000, rowWidth: 1 })).toThrow(/candleMs/);
    expect(() => createInitiativeTracker({ candleMs: MINUTE, rowWidth: 0 })).toThrow(/rowWidth/);
    for (const candleMs of CANDLE_MS) expect(createInitiativeTracker({ candleMs, rowWidth: 0.25 }).candleMs).toBe(candleMs);
    expect(FACTS).toEqual(["efficiency", "closes", "burst", "delta", "prints"]);
    expect(SIDES).toEqual(["up", "down"]);
    expect(DOMINANTS).toEqual(["buyers", "sellers"]);
    expect([EFFICIENCY_AT, STRONG_SHARE, BURST_AT, QUIET_MIN, RANK_AT, TYPICAL_MS, TYPICAL_MIN, MAX_SCORE, MAX_BANDS, INITIATIVE_RULES_VERSION]).toEqual([0.7, 0.5, 2, 3, 0.8, 14_400_000, 12, 5, 2_000, 1]);
    expect(STRONG_THIRD).toBeCloseTo(2 / 3, 12);
    expect([60_000, 300_000, 900_000, 1_800_000, 3_600_000, 86_400_000].map(typicalCount)).toEqual([240, 48, 16, 12, 12, 12]);
  });

  test("the band is born at the close that flips the leg, not a candle earlier: the five facts read over the window from the pivot to the flip, the dominant side and its share, the score", () => {
    const t = tracker();
    const band = born(t);
    expect(band).toEqual(downBand());
    expect(Object.isFrozen(band) && Object.isFrozen(band.facts) && FACTS.every((key) => Object.isFrozen(band.facts[key]))).toBe(true);
    expect(t.list()).toEqual([band]);
    expect(t.stats()).toMatchObject({ candles: 39, ready: true, bands: 1, open: true, leg: { side: "sellers", candles: 3 } });
  });

  test("the first leg after the warm-up is not a band: the engine must flip a leg, and the leg before the flip gives nothing", () => {
    const t = tracker();
    expect(feed(t, [...warmColumns(), ...riseColumns(), ...fallBars().slice(0, 8)])).toEqual([]);
    expect(t.stats()).toMatchObject({ bands: 0, open: false, leg: { side: "buyers" } });
    const down = tracker();
    expect(feed(down, [...warmColumns(), ...[97, 96, 95].map((mid, k) => column(at(k), { mid, sell: 10 })), closer(3, 95)])).toEqual([]);
    expect(down.stats()).toMatchObject({ bands: 0, open: false, leg: { side: "sellers" } });
  });

  test("the window never reads past the flip: later candles move the leg's extreme and nothing else; a candle inside the leg's range is silent", () => {
    const t = tracker();
    const band = born(t);
    feed(t, bar(at(9), { open: 105.5, high: 105.5, low: 104, close: 104.5, buy: 50, sell: 1, prints: ["buy", "buy"] }));
    const [moved, ...rest] = t.push(column(at(10), { mid: 104.5 }));
    expect(rest).toEqual([]);
    expect(moved).toEqual(downBand({ legExtremePrice: 104, legExtremeTs: at(9), updatedAt: at(10) }));
    expect(moved.facts).toEqual(band.facts);
    feed(t, bar(at(10), { open: 104.5, high: 105, low: 104.5, close: 105 }));
    expect(t.push(column(at(11), { mid: 105 }))).toEqual([]);
    expect(t.list()).toEqual([moved]);
  });

  test("the band carries the ATR at the pivot candle, the old leg's extreme: not the old leg's reference and not the ATR at the flip", () => {
    const band = born(tracker());
    const atPivot = atrAfterCandle(sellersFlip(), at(6));
    expect(band.atr).toBeCloseTo(atPivot, 10);
    expect(Math.abs(band.atr - warmAtr())).toBeGreaterThan(0.01);
    expect(Math.abs(band.atr - atrAfterCandle(sellersFlip(), at(9)))).toBeGreaterThan(0.01);
  });

  test("the leg ends at the next flip: the old band gets its legEndTs, the new band is born on the same close with the mirrored facts, top-third closes and buyers as the pushing side", () => {
    const t = tracker();
    born(t);
    feed(t, riseBack());
    const updates = t.push(closer(11, 107));
    expect(updates.map((b) => [b.id, b.legEndTs])).toEqual([[DOWN, at(10)], [UP, null]]);
    expect(updates[0]).toEqual(downBand({ legExtremePrice: 104, legExtremeTs: at(9), legEndTs: at(10), updatedAt: at(11) }));
    expect(updates[1]).toEqual({
      id: UP,
      candleMs: MINUTE,
      side: "up",
      dominant: "buyers",
      dominantShare: 0.9,
      score: 4,
      facts: {
        efficiency: { yes: true, value: 1 },
        closes: { yes: true, value: 1 },
        burst: { yes: false, value: 1.667 },
        delta: { yes: true, rank: 0.85, share: 0.9 },
        prints: { yes: true, rank: 1, perCandle: 1 },
      },
      pivotTs: at(9),
      pivotPrice: 104,
      frozenTs: at(10),
      frozenPrice: 107,
      windowCandles: 1,
      atr: expect.closeTo(atrAfterCandle([...sellersFlip(), ...riseBack()], at(10)), 10),
      legExtremePrice: 107.5,
      legExtremeTs: at(10),
      legEndTs: null,
      updatedAt: at(11),
    });
    expect(t.list().map((b) => b.id)).toEqual([DOWN, UP]);
    expect(t.stats()).toMatchObject({ bands: 2, open: true, leg: { side: "buyers" } });
  });

  test("a choppy window fails efficiency and strong closes; a window without big prints ranks at the bottom; a candle with no range is never a strong close", () => {
    const t = tracker();
    expect(feed(t, [...warmColumns(), ...riseColumns({ prints: ["sell"] }), ...choppyFall()])).toEqual([]);
    const [band] = t.push(closer(9, 106));
    expect(band).toMatchObject({ id: DOWN, score: 1, frozenPrice: 106, windowCandles: 3, facts: { efficiency: { yes: false, value: 0.667 }, closes: { yes: false, value: 1 }, burst: { yes: false, value: 0.8 }, delta: { yes: true, rank: 1, share: 0.75 }, prints: { yes: false, rank: 0, perCandle: 0 } } });
  });

  test("the dominant side is the side with more aggressive volume in the window, even against the leg: an up leg on sellers' flow is theirs, and its delta fact is read for the pushing side", () => {
    const t = tracker();
    born(t);
    feed(t, riseBack({ buy: 2, sell: 8 }));
    const [, band] = t.push(closer(11, 107));
    expect(band).toMatchObject({ id: UP, side: "up", dominant: "sellers", dominantShare: 0.8, score: 3, facts: { delta: { yes: false, rank: 0.025, share: 0.2 }, prints: { yes: true, rank: 1, perCandle: 1 }, closes: { yes: true, value: 1 } } });
  });

  test("burst out of quiet: the window's per-candle volume at twice the candles before the pivot, as many as the window has and at least three", () => {
    const t = tracker();
    expect(feed(t, [...warmColumns(), ...quietRise(), ...fallBars()])).toEqual([]);
    const [band] = t.push(closer(9));
    expect(band).toMatchObject({ id: DOWN, score: 5, facts: { burst: { yes: true, value: 4 }, delta: { yes: true, rank: 1 } } });
    const four = tracker();
    expect(feed(four, [...warmColumns(), ...heavyQuietRise(), ...fallBars4()])).toEqual([]);
    const [wide] = four.push(closer(10));
    expect(wide).toMatchObject({ id: DOWN, frozenTs: at(9), windowCandles: 4, score: 2, facts: { burst: { yes: false, value: 1.6 }, efficiency: { yes: true, value: 1 }, closes: { yes: false, value: 1 }, delta: { yes: true, rank: 1, share: 0.75 }, prints: { yes: false, rank: 0, perCandle: 0 } } });
  });

  test("delta and big prints rank strictly above the typical's per-candle values: a tie with the typical does not count", () => {
    const t = tracker();
    expect(feed(t, [...warmSkewed(3), ...riseColumns({ prints: ["sell"] }), ...fallBars()])).toEqual([]);
    const [band] = t.push(closer(9));
    expect(band).toMatchObject({ id: DOWN, score: 3, dominantShare: 0.75, facts: { delta: { yes: false, rank: 0.167, share: 0.75 }, prints: { yes: true, rank: 0.833, perCandle: 1 } } });
  });

  test("no band when fewer than twelve candles precede the pivot; the next flip with enough behind it is read", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...riseColumns({ prints: ["sell"] }), column(at(6), { mid: 108, buy: 2, sell: 6 })]);
    const saved = JSON.parse(JSON.stringify(t.toJSON()));
    saved.engine.candles = saved.engine.candles.slice(-10);
    const u = tracker();
    expect(u.restore(saved)).toEqual([]);
    expect(feed(u, [...fallBars().slice(1), closer(9)])).toEqual([]);
    expect(u.stats()).toMatchObject({ bands: 0, open: false, leg: { side: "sellers" } });
    feed(u, riseBack());
    expect(u.push(closer(11, 107)).map((b) => b.id)).toEqual([UP]);
  });

  test("a session gap ends the open band at the first candle after the hole; the leg the gap starts is not a band, the flip after it is", () => {
    const t = tracker();
    born(t);
    expect(t.push(column(at(9) + HOLE, { mid: 105.5 }))).toEqual([]);
    const [ended, ...rest] = t.push(column(at(9) + HOLE + MINUTE, { mid: 105.5 }));
    expect(rest).toEqual([]);
    expect(ended).toEqual(downBand({ legEndTs: at(9) + HOLE, updatedAt: at(9) + HOLE + MINUTE }));
    const after = (k) => at(9) + HOLE + k * MINUTE;
    expect(feed(t, [102, 103, 104, 105, 106, 107, 108, 109].map((mid, k) => column(after(k + 1), { mid, buy: 4 })))).toEqual([]);
    expect(t.stats()).toMatchObject({ open: false, leg: { side: "buyers" } });
    feed(t, [...bar(after(9), { open: 109, high: 109, low: 107, close: 107, buy: 1, sell: 5 }), ...bar(after(10), { open: 107, high: 107, low: 105, close: 106, buy: 1, sell: 5 })]);
    const [band] = t.push(column(after(11), { mid: 106 }));
    expect(band).toMatchObject({ id: `60000|down|${after(8)}`, side: "down", pivotPrice: 109, frozenTs: after(10), windowCandles: 2, legEndTs: null });
  });

  test("the engine's state round-trips through toJSON and restore: the restored tracker gives back its open band, ignores the columns it already saw, and continues as the original would; the state keeps the open band only, the ended ones being the store's", () => {
    const t = tracker();
    const band = born(t);
    const saved = JSON.parse(JSON.stringify(t.toJSON()));
    expect(saved).toMatchObject({ candleMs: MINUTE, rowWidth: 1, engineRules: EXHAUSTION_RULES_VERSION, open: DOWN, bands: [band], engine: { candleMs: MINUTE, index: 38 } });
    const u = tracker();
    expect(u.restore(saved)).toEqual([band]);
    expect(u.list()).toEqual([band]);
    expect(u.stats()).toEqual(t.stats());
    expect(u.push(closer(9))).toEqual([]);
    const rest = [...riseBack(), closer(11, 107)];
    expect(feed(u, rest)).toEqual(feed(t, rest));
    expect(u.list().map((b) => [b.id, b.legEndTs])).toEqual([[DOWN, at(10)], [UP, null]]);
    const later = JSON.parse(JSON.stringify(t.toJSON()));
    expect([later.open, later.bands.map((b) => b.id)]).toEqual([UP, [UP]]);
    expect(tracker().restore({ candleMs: MINUTE, rowWidth: 1 })).toEqual([]);
    expect(tracker().restore({ ...saved, candleMs: 300_000 })).toBeNull();
    expect(tracker().restore({ ...saved, rowWidth: 0.5 })).toBeNull();
    expect(tracker().restore({ ...saved, engineRules: EXHAUSTION_RULES_VERSION + 1 })).toBeNull();
    expect(tracker().restore({ ...saved, bands: "x" })).toBeNull();
    expect(tracker().restore({ ...saved, engine: { ...saved.engine, candles: "x" } })).toBeNull();
    expect(tracker().restore(null)).toBeNull();
    const closed = tracker();
    closed.restore({ ...saved, open: null });
    expect(closed.stats()).toMatchObject({ open: false, bands: 1 });
    expect(feed(closed, [...riseBack(), closer(11, 107)]).map((b) => b.id)).toEqual([UP]);
  });

  test("a restored open band keeps moving with the leg's extreme", () => {
    const t = tracker();
    born(t);
    const u = tracker();
    u.restore(JSON.parse(JSON.stringify(t.toJSON())));
    feed(u, bar(at(9), { open: 105.5, high: 105.5, low: 104, close: 104.5 }));
    expect(u.push(column(at(10), { mid: 104.5 }))).toEqual([downBand({ legExtremePrice: 104, legExtremeTs: at(9), updatedAt: at(10) })]);
  });

  test("a saved state holding a band that is not a band is refused whole, and the tracker it was handed to stays as it was", () => {
    const t = tracker();
    born(t);
    const saved = JSON.parse(JSON.stringify(t.toJSON()));
    const [band] = saved.bands;
    for (const bad of [[null], ["x"], [{ ...band, id: 5 }], [{ ...band, facts: null }], [{ ...band, facts: { ...band.facts, delta: null } }], [{ ...band, facts: { ...band.facts, prints: undefined } }]]) {
      const u = tracker();
      expect(u.restore({ ...saved, bands: bad })).toBeNull();
      expect(u.stats()).toMatchObject({ candles: 0, bands: 0, open: false });
    }
    expect(tracker().restore({ ...saved, bands: [band, { ...band, id: "other" }] })).toEqual([band]);
  });

  test("the bands kept are bounded: the oldest leaves when the two-thousand-and-first is born", () => {
    const t = tracker();
    born(t);
    const saved = JSON.parse(JSON.stringify(t.toJSON()));
    saved.bands = Array.from({ length: MAX_BANDS }, (_, i) => ({ ...saved.bands[0], id: `60000|down|${i}`, pivotTs: i, legEndTs: 1 }));
    saved.open = null;
    const u = tracker();
    expect(u.restore(saved)).toEqual([]);
    expect(u.stats().bands).toBe(MAX_BANDS);
    feed(u, riseBack());
    expect(u.push(closer(11, 107)).map((b) => b.id)).toEqual([UP]);
    expect(u.stats().bands).toBe(MAX_BANDS);
    expect(u.list()[0].id).toBe("60000|down|1");
    expect(u.list()[MAX_BANDS - 1].id).toBe(UP);
  });

  test("columns are the engine's: a column without both touches or out of order is ignored, and the last column seen is reported", () => {
    const t = tracker();
    born(t);
    expect(t.lastColumnTs).toBe(at(9));
    expect(t.push(column(at(8), { mid: 105 }))).toEqual([]);
    expect(t.lastColumnTs).toBe(at(9));
    expect(() => t.push({ ts: at(10) })).toThrow(/column/);
    expect(t.rowWidth).toBe(1);
  });
});
