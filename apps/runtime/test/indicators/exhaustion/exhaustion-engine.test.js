const { createExhaustionTracker, intensityOf, wireValue, rawValue, hasTrades, GAP_MS, RAW_CAP, CANDLE_MS, READINGS, STATUSES, ATR_PERIOD, REVERSE_ATR, ZONE_SHARE, FIRE_SCORE, BEYOND_ATR, BEYOND_SHARE, MAX_SCORE, VALUE_CAP, LONG_CANDLE_MS, WEEKEND_MS } = require("../../../src/indicators/exhaustion/exhaustion-engine");
const { MINUTE, BASE, W, PIVOT_INDEX, PULLED_ASKS, column, frozen, at, warmColumns, riseColumns, quietColumns, buyersScenario, warmAtr } = require("../../fixtures/exhaustion/columns");

const ALL_TRUE = Object.freeze({ rate: true, progress: true, delta: true, divergence: true, prints: true, book: true });
const FIRE_VALUES = Object.freeze({ rate: 0.211, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 });
const FIRE_RAW = Object.freeze({ own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 });
const FIRST = `60000|buyers|${at(7)}`;

function tracker() {
  return createExhaustionTracker({ candleMs: MINUTE, rowWidth: 1 });
}

function feed(t, columns) {
  const updates = [];
  for (const c of columns) updates.push(...t.push(c));
  return updates;
}

function fired(t) {
  const updates = feed(t, buyersScenario());
  expect(updates).toEqual([]);
  return t.push(column(at(8), { mid: 108, buy: 1, sell: 1, asks: PULLED_ASKS }));
}

function statuses(updates) {
  return updates.map((s) => [s.id, s.status]);
}

function spike(k, peak, flat = 106) {
  return [column(at(k), { mid: flat }), column(at(k) + 20_000, { mid: peak }), column(at(k) + 40_000, { mid: flat })];
}

function wide(k) {
  return [column(at(k), { mid: 108 }), column(at(k) + 30_000, { mid: 106 })];
}

function sellersFired(t) {
  feed(t, warmColumns());
  feed(t, [98, 97, 96, 95, 94, 93].map((mid, k) => column(at(k), { mid, sell: 10 })));
  t.push(column(at(6), { mid: 93, buy: 4, sell: 2 }));
  t.push(column(at(7), { mid: 93, buy: 3, sell: 1, bids: { 92: 0.4 } }));
  return t.push(column(at(8), { mid: 93, buy: 1, sell: 1 }));
}

describe("indicators/exhaustion/exhaustion-engine", () => {
  test("only the chart's candle lengths and a positive row width are accepted; the vocabularies are the six readings and five statuses", () => {
    expect(() => createExhaustionTracker({ candleMs: 240_000, rowWidth: 1 })).toThrow(/candleMs/);
    expect(CANDLE_MS).toEqual([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000]);
    expect(() => createExhaustionTracker({ candleMs: MINUTE, rowWidth: 0 })).toThrow(/rowWidth/);
    for (const candleMs of CANDLE_MS) expect(createExhaustionTracker({ candleMs, rowWidth: 0.25 }).candleMs).toBe(candleMs);
    expect(READINGS).toEqual(["rate", "progress", "delta", "divergence", "prints", "book"]);
    expect(STATUSES).toEqual(["open", "pending", "held", "broke", "interrupted"]);
    expect([ATR_PERIOD, REVERSE_ATR, ZONE_SHARE, FIRE_SCORE, BEYOND_ATR, BEYOND_SHARE, MAX_SCORE, VALUE_CAP]).toEqual([14, 3, 0.2, 3, 1.5, 0.1, 6, 1_000_000]);
    expect([0, 3, 4, 5, 6].map(intensityOf)).toEqual([1, 1, 2, 2, 3]);
  });

  test("a reading's value goes on the wire rounded to three decimals, inside the cap, null when it cannot be read", () => {
    expect([0.12345, -0.4, 2, 0].map(wireValue)).toEqual([0.123, -0.4, 2, 0]);
    expect(Object.is(wireValue(-0.0001), 0)).toBe(true);
    expect([RAW_CAP + 1, -RAW_CAP - 1, 0.12345, NaN, Infinity].map(rawValue)).toEqual([RAW_CAP, -RAW_CAP, 0.123, null, null]);
    expect(Object.is(rawValue(-0.0001), 0)).toBe(true);
    expect(RAW_CAP).toBe(1_000_000_000);
    expect([5e6, -5e6].map(wireValue)).toEqual([VALUE_CAP, -VALUE_CAP]);
    expect([NaN, Infinity, -Infinity].map(wireValue)).toEqual([null, null, null]);
  });

  test("the ATR is Wilder's over the mid candles and nothing is read before fourteen of them", () => {
    const t = tracker();
    feed(t, warmColumns(14));
    expect(t.stats()).toMatchObject({ ready: false, candles: 13, atr: null, leg: null });
    t.push(column(BASE + 14 * MINUTE, { mid: 100 }));
    expect(t.stats()).toMatchObject({ ready: true, candles: 14 });
    expect(t.stats().atr).toBeCloseTo(13 / 14, 10);
    t.push(column(BASE + 15 * MINUTE, { mid: 101 }));
    expect(t.stats().atr).toBeCloseTo(((13 / 14) * 13 + 1) / 14, 10);
    const early = tracker();
    expect(feed(early, [...warmColumns(10), ...[103, 104, 105, 106, 107, 108].map((mid, k) => column(BASE + (10 + k) * MINUTE, { mid, buy: 10 }))])).toEqual([]);
    expect(early.stats().leg).toBeNull();
  });

  test("a move of three ATR from the last low starts a leg there; its size in ATR and its straightness are read at every close", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...riseColumns().slice(0, 2)]);
    expect(t.stats().leg).toMatchObject({ side: "buyers", candles: 2, efficiency: 1 });
    expect(t.stats().leg.sizeAtr).toBeCloseTo(3 / warmAtr(), 10);
    feed(t, riseColumns().slice(2));
    expect(t.stats().leg).toMatchObject({ side: "buyers", candles: 6 });
    t.push(column(at(6), { mid: 108 }));
    expect(t.stats().leg).toMatchObject({ candles: 7, efficiency: 1 });
    expect(t.stats().leg.sizeAtr).toBeCloseTo(8 / warmAtr(), 10);
  });

  test("straightness is the leg's size over the path of its closes from the pivot to the extreme", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...[103, 104, 105, 104, 106, 107, 108].map((mid, k) => column(at(k), { mid, buy: 10 }))]);
    t.push(column(at(7), { mid: 108 }));
    expect(t.stats().leg).toMatchObject({ side: "buyers", candles: 8 });
    expect(t.stats().leg.efficiency).toBeCloseTo(0.8, 10);
    expect(t.stats().leg.sizeAtr).toBeCloseTo(8 / warmAtr(), 10);
  });

  test("the shade fires at the close inside the last fifth where the readings score at least three, with the six readings, their values, the score, the leg and the ATR", () => {
    const t = tracker();
    const [shade, ...rest] = fired(t);
    expect(rest).toEqual([]);
    expect(shade).toEqual({
      id: FIRST,
      candleMs: MINUTE,
      side: "buyers",
      status: "open",
      intensity: 3,
      score: 6,
      readings: ALL_TRUE,
      values: FIRE_VALUES,
      raw: FIRE_RAW,
      startTs: at(7),
      endTs: at(8),
      extremeTs: at(5),
      extremePrice: 108,
      legStartTs: BASE + PIVOT_INDEX * MINUTE,
      legStartPrice: 100,
      legSize: 8,
      efficiency: 1,
      atr: expect.closeTo(warmAtr(), 10),
      judgedAt: null,
      updatedAt: at(8),
    });
    expect(Object.isFrozen(shade) && Object.isFrozen(shade.readings) && Object.isFrozen(shade.values) && Object.isFrozen(shade.raw)).toBe(true);
    expect(t.list()).toEqual([shade]);
    expect(t.stats()).toMatchObject({ open: true, unsettled: 1, shades: 1 });
  });

  test("a shade on a leg that pulled back on the way carries the leg's straightness, not a straight line", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...[103, 104, 103, 105, 106, 107, 108].map((mid, k) => column(at(k), { mid, buy: 10 })), column(at(7), { mid: 108, buy: 2, sell: 4 }), column(at(8), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS })]);
    const [shade] = t.push(column(at(9), { mid: 108, buy: 1, sell: 1, asks: PULLED_ASKS }));
    expect(shade).toMatchObject({ id: `60000|buyers|${at(8)}`, status: "open", score: 6, legSize: 8 });
    expect(shade.efficiency).toBeCloseTo(0.8, 10);
  });

  test("the first quiet candle scores two and stays silent: only divergence and the absent prints read", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...riseColumns(), quietColumns()[0]]);
    expect(t.push(column(at(7), { mid: 108 }))).toEqual([]);
    expect(t.stats()).toMatchObject({ open: false, unsettled: 0, shades: 0 });
  });

  test("the close must sit in the last fifth of the leg: the same fade two ATR below the extreme is not read", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...riseColumns(), column(at(6), { mid: 106, buy: 2, sell: 4 }), column(at(7), { mid: 106, buy: 1, sell: 3, asks: PULLED_ASKS })]);
    expect(t.push(column(at(8), { mid: 106, buy: 1, sell: 1 }))).toEqual([]);
    const u = tracker();
    feed(u, [...warmColumns(), ...riseColumns(), column(at(6), { mid: 107, buy: 2, sell: 4 }), column(at(7), { mid: 107, buy: 1, sell: 3, asks: PULLED_ASKS })]);
    expect(u.push(column(at(8), { mid: 107, buy: 1, sell: 1 })).map((s) => [s.status, s.score])).toEqual([["open", 6]]);
    const v = tracker();
    feed(v, [...warmColumns(), ...riseColumns(), column(at(6), { mid: 107, buy: 2, sell: 4 })]);
    expect(v.push(column(at(7), { mid: 107 })).map((s) => [s.status, s.score, s.readings])).toEqual([["open", 4, { rate: false, progress: true, delta: false, divergence: true, prints: true, book: true }]]);
  });

  test("big prints at or above the leg's rate veto the shade; fewer leave the prints reading off and the score at five", () => {
    const vetoed = tracker();
    feed(vetoed, buyersScenario({ prints: ["buy"] }).slice(0, -1));
    vetoed.push(column(at(7), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS, prints: ["buy", "buy"] }));
    expect(vetoed.push(column(at(8), { mid: 108, buy: 1, sell: 1 }))).toEqual([]);
    const faded = tracker();
    feed(faded, buyersScenario({ prints: ["buy"] }).slice(0, -1));
    faded.push(column(at(7), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS, prints: ["buy"] }));
    const [shade] = faded.push(column(at(8), { mid: 108, buy: 1, sell: 1 }));
    expect(shade).toMatchObject({ status: "open", score: 5, intensity: 2, readings: { ...ALL_TRUE, prints: false } });
    expect(shade.values.prints).toBe(0.643);
    const other = tracker();
    feed(other, buyersScenario({ prints: ["sell"] }).slice(0, -1));
    other.push(column(at(7), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS, prints: ["sell", "sell", "sell"] }));
    expect(other.push(column(at(8), { mid: 108, buy: 1, sell: 1 }))[0]).toMatchObject({ score: 6 });
  });

  test("the readings are independent: buying still near the leg's rate leaves rate off and the score at five", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...riseColumns(), quietColumns()[0]]);
    t.push(column(at(7), { mid: 108, buy: 6, sell: 7, asks: PULLED_ASKS }));
    const [shade] = t.push(column(at(8), { mid: 108, buy: 1, sell: 1 }));
    expect(shade).toMatchObject({ status: "open", score: 5, intensity: 2, readings: { ...ALL_TRUE, rate: false }, values: { rate: 0.522, delta: -0.158, divergence: -1.158, book: 0.5 } });
  });

  test("the strip extends over consecutive firing closes; the readings and values stay those of the close that first reached the score", () => {
    const t = tracker();
    fired(t);
    const [longer] = t.push(column(at(9), { mid: 108, buy: 3, asks: PULLED_ASKS }));
    expect(longer).toMatchObject({ id: FIRST, status: "open", endTs: at(9), score: 6, intensity: 3, readings: ALL_TRUE, values: FIRE_VALUES, updatedAt: at(9) });
    const [weaker] = t.push(column(at(10), { mid: 108, buy: 1, sell: 1, asks: PULLED_ASKS }));
    expect(weaker).toMatchObject({ id: FIRST, status: "open", endTs: at(10), score: 6, intensity: 3, readings: ALL_TRUE, values: FIRE_VALUES, updatedAt: at(10) });
    expect(t.list()).toHaveLength(1);
  });

  test("a later close that scores higher replaces the score, the readings and the values", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...riseColumns(), quietColumns()[0], column(at(7), { mid: 108, buy: 6, sell: 7, asks: PULLED_ASKS })]);
    expect(t.push(column(at(8), { mid: 108, sell: 3, asks: PULLED_ASKS })).map((s) => [s.score, s.readings.rate])).toEqual([[5, false]]);
    const [higher] = t.push(column(at(9), { mid: 108, buy: 1, sell: 1 }));
    expect(higher).toMatchObject({ id: FIRST, status: "open", score: 6, intensity: 3, readings: ALL_TRUE, values: { rate: 0.435, progress: 0, delta: -0.25, divergence: -1.25, prints: null, book: 0.5 }, endTs: at(9) });
  });

  test("the strip ends at the first close that does not fire; the shade then waits for its verdict, pending", () => {
    const t = tracker();
    fired(t);
    expect(statuses(t.push(column(at(9), { mid: 106 })))).toEqual([[FIRST, "open"]]);
    const [waiting] = t.push(column(at(10), { mid: 106 }));
    expect(waiting).toMatchObject({ id: FIRST, status: "pending", endTs: at(9), judgedAt: null, updatedAt: at(10) });
    expect(t.stats()).toMatchObject({ open: false, unsettled: 1 });
  });


  test("held: the leg coming back three ATR from its running extreme settles the shade on the candle that does it, and the same close ends the leg", () => {
    const t = tracker();
    fired(t);
    expect(feed(t, [9, 10, 11, 12, 13].map((k) => column(at(k), { mid: 106 }))).map((s) => s.status)).toEqual(["open", "pending"]);
    expect(t.push(column(at(14), { mid: 105 }))).toEqual([]);
    const updates = t.push(column(at(15), { mid: 105 }));
    expect(updates.map((s) => s.status)).toEqual(["held"]);
    expect(updates[0]).toMatchObject({ id: FIRST, endTs: at(9), judgedAt: at(15), updatedAt: at(15), extremePrice: 108, score: 6, values: FIRE_VALUES });
    expect(t.stats()).toMatchObject({ open: false, unsettled: 0, leg: { side: "sellers" } });
    expect(t.list().map((s) => s.status)).toEqual(["held"]);
  });


  test("no window: a shade waits as long as its leg neither breaks nor comes back three ATR", () => {
    const t = tracker();
    fired(t);
    expect(feed(t, Array.from({ length: 30 }, (_, i) => column(at(9 + i), { mid: 106 }))).map((s) => s.status)).toEqual(["open", "pending"]);
    expect(t.stats()).toMatchObject({ open: false, unsettled: 1 });
    expect(feed(t, [column(at(39), { mid: 105 }), column(at(40), { mid: 105 })]).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "held", at(40)]]);
  });


  test("broke: a wick more than one and a half ATR past the extreme judges the shade at once, while its strip runs or while it waits", () => {
    const t = tracker();
    fired(t);
    expect(t.push(column(at(9), { mid: 110, buy: 10 })).map((s) => s.status)).toEqual(["open"]);
    const updates = t.push(column(at(10), { mid: 110, buy: 1, sell: 1 }));
    expect(updates.map((s) => [s.status, s.judgedAt])).toEqual([["broke", at(10)]]);
    expect(updates[0]).toMatchObject({ endTs: at(9), extremePrice: 108 });
    const u = tracker();
    fired(u);
    expect(feed(u, [column(at(9), { mid: 106 }), column(at(10), { mid: 106 }), column(at(11), { mid: 110, buy: 10 })]).map((s) => s.status)).toEqual(["open", "pending"]);
    expect(u.push(column(at(12), { mid: 110 })).map((s) => [s.status, s.judgedAt, s.endTs])).toEqual([["broke", at(12), at(9)]]);
  });


  test("a wick within the tolerance does not break the shade; it moves the extreme the comeback is measured from", () => {
    const t = tracker();
    fired(t);
    expect(feed(t, [column(at(9), { mid: 108.9, buy: 1, sell: 1 }), column(at(10), { mid: 106 }), column(at(11), { mid: 105.5 })]).map((s) => s.status)).toEqual(["open", "pending"]);
    expect(t.push(column(at(12), { mid: 105.5 })).map((s) => [s.id, s.status, s.judgedAt, s.extremePrice])).toEqual([[FIRST, "held", at(12), 108]]);
    const u = tracker();
    fired(u);
    expect(feed(u, [column(at(9), { mid: 106 }), column(at(10), { mid: 106 }), column(at(11), { mid: 105.5 }), column(at(12), { mid: 105.5 })]).map((s) => s.status)).toEqual(["open", "pending"]);
    expect(u.stats()).toMatchObject({ unsettled: 1 });
  });


  test("the leg's reversal is the held verdict: the close that ends the leg settles its shade", () => {
    const t = tracker();
    fired(t);
    expect(statuses(t.push(column(at(9), { mid: 105, sell: 10 })))).toEqual([[FIRST, "open"]]);
    expect(t.push(column(at(10), { mid: 106.5 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "held", at(10)]]);
    expect(t.stats()).toMatchObject({ leg: { side: "sellers" }, unsettled: 0, open: false });
  });


  test("one shade per extreme: the same extreme fires no second shade; a new extreme fires one beside the first, and the comeback settles both held on one close", () => {
    const t = tracker();
    fired(t);
    const second = `60000|buyers|${at(12)}`;
    expect(statuses(feed(t, [column(at(9), { mid: 106 }), column(at(10), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS })]))).toEqual([[FIRST, "open"], [FIRST, "pending"]]);
    expect(feed(t, [column(at(11), { mid: 108.5, buy: 10 }), column(at(12), { mid: 108.5, buy: 1, sell: 3, asks: { 109: 0.5, 110: 0.5 } })])).toEqual([]);
    const [born] = t.push(column(at(13), { mid: 108.5, buy: 1, sell: 1, asks: { 109: 0.5, 110: 0.5 } }));
    expect(born).toMatchObject({ id: second, status: "open", score: 3, extremePrice: 108.5, extremeTs: at(11) });
    expect(born.readings).toEqual({ rate: false, progress: true, delta: false, divergence: false, prints: true, book: true });
    expect(born.values).toEqual({ rate: 1, progress: 0.412, delta: 0.571, divergence: 0, prints: null, book: 0.5 });
    expect(t.stats()).toMatchObject({ open: true, unsettled: 2 });
    expect(statuses(t.push(column(at(14), { mid: 105.5 })))).toEqual([[second, "open"]]);
    expect(t.push(column(at(15), { mid: 105.5 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "held", at(15)], [second, "held", at(15)]]);
    expect(t.stats()).toMatchObject({ leg: { side: "sellers" }, unsettled: 0, open: false });
  });

  test("a session gap interrupts every shade still waiting, the pending one and the open one alike", () => {
    const t = tracker();
    fired(t);
    const second = `60000|buyers|${at(12)}`;
    feed(t, [column(at(9), { mid: 106 }), column(at(10), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS }), column(at(11), { mid: 108.5, buy: 10 }), column(at(12), { mid: 108.5, buy: 1, sell: 3, asks: { 109: 0.5, 110: 0.5 } }), column(at(13), { mid: 108.5, buy: 1, sell: 1, asks: { 109: 0.5, 110: 0.5 } })]);
    expect(t.stats()).toMatchObject({ open: true, unsettled: 2 });
    expect(statuses(t.push(column(at(13) + 10 * MINUTE, { mid: 108.5 })))).toEqual([[second, "open"]]);
    const cut = t.push(column(at(13) + 11 * MINUTE, { mid: 108.5 }));
    expect(cut.map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "interrupted", at(13) + 11 * MINUTE], [second, "interrupted", at(13) + 11 * MINUTE]]);
    expect(t.stats()).toMatchObject({ unsettled: 0, open: false, leg: null });
  });

  test("interrupted: a session gap ends an open shade unjudged and starts the structure afresh", () => {
    const t = tracker();
    fired(t);
    expect(t.push(column(at(8) + 10 * MINUTE, { mid: 108, buy: 1, sell: 1 })).map((s) => s.status)).toEqual(["open"]);
    const updates = t.push(column(at(8) + 11 * MINUTE, { mid: 108, buy: 1, sell: 1 }));
    expect(updates.map((s) => [s.status, s.judgedAt])).toEqual([["interrupted", at(8) + 11 * MINUTE]]);
    expect(t.stats().leg).toBeNull();
  });

  test("sellers' exhaustion is the mirror: a fall of eight ATR, the bids at the low pulled while selling fades", () => {
    const t = tracker();
    feed(t, warmColumns());
    feed(t, [98, 97, 96, 95, 94, 93].map((mid, k) => column(at(k), { mid, sell: 10 })));
    t.push(column(at(6), { mid: 93, buy: 4, sell: 2 }));
    t.push(column(at(7), { mid: 93, buy: 3, sell: 1, bids: { 92: 0.4 } }));
    const [shade] = t.push(column(at(8), { mid: 93, buy: 1, sell: 1 }));
    expect(shade).toMatchObject({ id: `60000|sellers|${at(7)}`, side: "sellers", status: "open", score: 6, intensity: 3, readings: ALL_TRUE, values: { rate: 0.19, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.4 }, extremePrice: 93, legStartPrice: 101, legStartTs: BASE + (PIVOT_INDEX + 1) * MINUTE, legSize: 8 });
    expect(t.push(column(at(9), { mid: 91, sell: 10 })).map((s) => s.status)).toEqual(["open"]);
    expect(t.push(column(at(10), { mid: 91, sell: 1 })).map((s) => s.status)).toEqual(["broke"]);
  });


  test("the verdict reads the wick: a spike more than one and a half ATR past the extreme inside a candle breaks the shade though the candle closes back; a spike within the tolerance does not", () => {
    const t = tracker();
    fired(t);
    expect(statuses(feed(t, [column(at(9), { mid: 106 }), ...spike(10, 110)]))).toEqual([[FIRST, "open"], [FIRST, "pending"]]);
    expect(t.push(column(at(11), { mid: 106 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "broke", at(11)]]);
    const u = tracker();
    fired(u);
    feed(u, [column(at(9), { mid: 106 }), ...spike(10, 108.9), column(at(11), { mid: 106 }), column(at(12), { mid: 105.9 })]);
    expect(u.push(column(at(13), { mid: 105.9 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "held", at(13)]]);
  });

  test("a sellers' shade breaks on a low wick more than one and a half ATR under its extreme, though the candle closes back", () => {
    const t = tracker();
    sellersFired(t);
    feed(t, [column(at(9), { mid: 95 }), ...spike(10, 91, 95)]);
    expect(t.push(column(at(11), { mid: 95 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[`60000|sellers|${at(7)}`, "broke", at(11)]]);
  });


  test("a candle that passes the tolerance and comes back three ATR inside itself is broke, not held", () => {
    const t = tracker();
    fired(t);
    feed(t, [...[9, 10, 11, 12, 13].map((k) => column(at(k), { mid: 106 })), ...spike(14, 110, 105)]);
    expect(t.push(column(at(15), { mid: 105 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "broke", at(15)]]);
  });


  test("a candle that sets a new extreme cannot settle held, even if it comes back three ATR inside itself; the next candle can", () => {
    const t = tracker();
    fired(t);
    expect(statuses(feed(t, [column(at(9), { mid: 106 }), column(at(10), { mid: 108.5 }), column(at(10) + 30_000, { mid: 105.5 })]))).toEqual([[FIRST, "open"], [FIRST, "pending"]]);
    expect(t.push(column(at(11), { mid: 105.5 }))).toEqual([]);
    expect(t.stats()).toMatchObject({ unsettled: 1 });
    expect(t.push(column(at(12), { mid: 105.5 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "held", at(12)]]);
  });

  test("the tolerance grows with the leg: a tenth of a twenty-ATR leg is two ATR, so a wick one and a half ATR past the extreme does not break the shade and one past two ATR does", () => {
    const first = `60000|buyers|${at(19)}`;
    const big = () => {
      const t = tracker();
      feed(t, [...warmColumns(), ...Array.from({ length: 18 }, (_, k) => column(at(k), { mid: 103 + k, buy: 10 })), column(at(18), { mid: 120, buy: 2, sell: 4 }), column(at(19), { mid: 120, buy: 1, sell: 3, asks: { 120: 0.5, 121: 0.5 } })]);
      const [shade] = t.push(column(at(20), { mid: 120, buy: 1, sell: 1, asks: { 120: 0.5, 121: 0.5 } }));
      expect(shade).toMatchObject({ id: first, status: "open", score: 6, legSize: 20, extremePrice: 120, atr: expect.closeTo(warmAtr(), 10) });
      return t;
    };
    const inside = big();
    const ofFirst = (updates) => updates.filter((s) => s.id === first).map((s) => [s.status, s.judgedAt]);
    expect(ofFirst(feed(inside, [column(at(21), { mid: 121.5, buy: 1, sell: 1 }), column(at(22), { mid: 120 }), column(at(23), { mid: 120 })]))).toEqual([["open", null], ["pending", null]]);
    expect(ofFirst(feed(inside, [column(at(24), { mid: 118.5 }), column(at(25), { mid: 118.5 })]))).toEqual([["held", at(25)]]);
    const past = big();
    expect(ofFirst(feed(past, [column(at(21), { mid: 122.1, buy: 1, sell: 1 }), column(at(22), { mid: 120 })]))).toEqual([["open", null], ["broke", at(22)]]);
  });

  test("a sellers' shade holds when price comes back three ATR up from its low, read on the candle's high", () => {
    const t = tracker();
    expect(statuses(sellersFired(t))).toEqual([[`60000|sellers|${at(7)}`, "open"]]);
    expect(statuses(feed(t, [column(at(9), { mid: 93 }), column(at(9) + 30_000, { mid: 96 })]))).toEqual([[`60000|sellers|${at(7)}`, "open"]]);
    expect(t.push(column(at(10), { mid: 96 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[`60000|sellers|${at(7)}`, "held", at(10)]]);
    expect(t.stats()).toMatchObject({ leg: { side: "buyers" }, unsettled: 0 });
    const u = tracker();
    sellersFired(u);
    expect(feed(u, [column(at(9), { mid: 95.9 }), column(at(10), { mid: 95.9 })]).map((s) => s.status)).toEqual(["open", "pending"]);
    expect(u.stats()).toMatchObject({ unsettled: 1 });
  });

  test("one candle breaks every shade of the leg it runs past, on the same close", () => {
    const t = tracker();
    fired(t);
    const second = `60000|buyers|${at(12)}`;
    feed(t, [column(at(9), { mid: 106 }), column(at(10), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS }), column(at(11), { mid: 108.5, buy: 10 }), column(at(12), { mid: 108.5, buy: 1, sell: 3, asks: { 109: 0.5, 110: 0.5 } }), column(at(13), { mid: 108.5, buy: 1, sell: 1, asks: { 109: 0.5, 110: 0.5 } }), column(at(14), { mid: 110.5 })]);
    expect(t.stats()).toMatchObject({ unsettled: 2 });
    expect(t.push(column(at(15), { mid: 110.5 })).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "broke", at(15)], [second, "broke", at(15)]]);
    expect(t.stats()).toMatchObject({ unsettled: 0 });
  });


  test("the break is measured in the leg's ATR at its start, not in the wider ATR of the candles since", () => {
    const t = tracker();
    fired(t);
    expect(feed(t, [...wide(9), ...wide(10), ...wide(11), ...wide(12)]).map((s) => s.status)).toEqual(["open", "pending"]);
    const updates = feed(t, [column(at(13), { mid: 109.5 }), column(at(14), { mid: 106 })]);
    expect(updates.filter((s) => s.id === FIRST).map((s) => [s.status, s.judgedAt, s.atr])).toEqual([["broke", at(14), expect.closeTo(warmAtr(), 10)]]);
    expect(1.5 * warmAtr()).toBeLessThan(1.5);
    expect(1.5 * t.stats().atr).toBeGreaterThan(1.5);
    expect(t.stats().atr).toBeGreaterThan(1.2);
  });

  test("the strip ends at an in-zone close that scores under three, and at a vetoed close", () => {
    const t = tracker();
    fired(t);
    t.push(column(at(9), { mid: 108.5, buy: 10 }));
    expect(statuses(t.push(column(at(10), { mid: 106 })))).toEqual([[FIRST, "pending"]]);
    const u = tracker();
    feed(u, [...warmColumns(), ...riseColumns({ prints: ["buy"] }), column(at(6), { mid: 108, buy: 2, sell: 4 }), column(at(7), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS, prints: ["buy"] })]);
    expect(u.push(column(at(8), { mid: 108, buy: 1, sell: 1, asks: PULLED_ASKS, prints: ["buy", "buy", "buy"] })).map((s) => [s.status, s.score])).toEqual([["open", 5]]);
    expect(statuses(u.push(column(at(9), { mid: 108, buy: 1, sell: 1, asks: PULLED_ASKS })))).toEqual([[FIRST, "pending"]]);
  });

  test("the candle that reverses the leg is never read: a buyers' strip does not run on into the new sellers' leg, the shade settles held on that close", () => {
    const t = tracker();
    fired(t);
    feed(t, [column(at(9), { mid: 105, buy: 3, sell: 1 }), column(at(9) + 30_000, { mid: 105.5 })]);
    expect(statuses(t.push(column(at(10), { mid: 105.5 })))).toEqual([[FIRST, "held"]]);
    expect(t.stats().leg).toMatchObject({ side: "sellers" });
  });

  test("values the engine cannot read are null: divergence and book at the extreme's own candle; big prints read zero when the leg had some and the window none; book is the band furthest under its own line", () => {
    const t = tracker();
    fired(t);
    feed(t, [column(at(9), { mid: 106 }), column(at(10), { mid: 108.5, buy: 1, sell: 3 })]);
    const [own] = t.push(column(at(11), { mid: 108.5 })).filter((s) => s.id !== FIRST);
    expect(own).toMatchObject({ id: `60000|buyers|${at(10)}`, status: "open", score: 3, extremeTs: at(10), readings: { rate: true, progress: false, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.091, progress: 3.882, delta: -0.5, divergence: null, prints: null, book: null }, raw: { extremeOwn: null, extremeOther: null, bookNow: null, bookAt: null, bookBand: null } });
    const u = tracker();
    feed(u, [...warmColumns(), ...riseColumns({ prints: ["buy"] }), column(at(6), { mid: 108, buy: 2, sell: 4 }), column(at(7), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS })]);
    expect(u.push(column(at(8), { mid: 108, buy: 1, sell: 1 }))[0]).toMatchObject({ score: 6, readings: { prints: true }, values: { prints: 0 } });
    const v = tracker();
    feed(v, [...warmColumns(), ...riseColumns(), column(at(6), { mid: 108, buy: 2, sell: 4 }), column(at(7), { mid: 108, buy: 1, sell: 3, bids: { 106: 0.2, 107: 0.2 } })]);
    expect(v.push(column(at(8), { mid: 108, buy: 1, sell: 1 }))[0]).toMatchObject({ score: 6, readings: { book: true }, values: { book: 0.2 }, raw: { bookNow: 0.4, bookAt: 2, bookBand: 2 } });
  });

  test("the book reading is reported by the band that decides it, the one furthest under its own line: a band at the extreme at 0.85 (line 0.9) beats a deeper band at 0.80 (line 0.75), though the deeper band pulled more", () => {
    const t = tracker();
    const deep = { 108: 0.85, 109: 0.85, 112: 2.4, 113: 2.4 };
    feed(t, [...warmColumns(), ...[103, 104, 105, 106, 107].map((mid, k) => column(at(k), { mid, buy: 10 })), column(at(5), { mid: 108, buy: 10, asks: { 112: 3, 113: 3 } }), column(at(6), { mid: 108, buy: 2, sell: 4, asks: deep }), column(at(7), { mid: 108, buy: 1, sell: 3, asks: deep })]);
    const [shade] = t.push(column(at(8), { mid: 108, buy: 1, sell: 1, asks: deep }));
    expect(shade).toMatchObject({ status: "open", score: 6, readings: { book: true }, values: { book: 0.85 }, raw: { bookNow: 1.7, bookAt: 2, bookBand: 0 } });
  });

  test("a hole shorter than one candle does not cut a longer candle's session: a 3-minute hole leaves a 5m leg and its shade alone and resets a 1m tracker", () => {
    const columns = [];
    for (let m = 0; m < 150; m += 1) columns.push(column(BASE + m * MINUTE, { mid: m % 2 === 0 ? 100 : 101, buy: 1, sell: 1 }));
    for (let m = 150; m < 175; m += 1) columns.push(column(BASE + m * MINUTE, { mid: 102 + Math.floor((m - 150) / 5), buy: 10 }));
    for (let m = 178; m < 188; m += 1) columns.push(column(BASE + m * MINUTE, { mid: 106, buy: 1, sell: 1 }));
    const five = createExhaustionTracker({ candleMs: 300_000, rowWidth: 1 });
    const updates = feed(five, columns);
    expect(updates.map((s) => s.status)).not.toContain("interrupted");
    expect(five.stats()).toMatchObject({ leg: { side: "buyers" }, unsettled: 1, open: true });
    const one = tracker();
    feed(one, columns);
    expect(one.stats()).toMatchObject({ leg: null, unsettled: 0 });
  });

  test("columns fold into the candle, late columns are ignored, and a column without both touches is skipped", () => {
    const t = tracker();
    const first = column(BASE, { mid: 100 });
    expect(t.push(first)).toEqual([]);
    expect(t.push(column(BASE - 1, { mid: 100 }))).toEqual([]);
    expect(t.lastColumnTs).toBe(BASE);
    const empty = { ...column(BASE + 10_000, { mid: 100 }), ask: new Float64Array(25) };
    expect(t.push(empty)).toEqual([]);
    expect(t.lastColumnTs).toBe(BASE);
    expect(() => t.push({ ts: BASE + 20_000 })).toThrow(/Float64Array/);
    expect(() => t.push(null)).toThrow(/column/);
    t.push(column(BASE + 20_000, { mid: 103 }));
    t.push(column(BASE + 40_000, { mid: 99 }));
    t.push(column(BASE + MINUTE, { mid: 100 }));
    expect(t.stats().candles).toBe(1);
  });

  test("the engine's state round-trips through toJSON and restore: the restored tracker gives back its waiting shades, ignores the columns it already saw, and judges the rest as the original would", () => {
    const t = tracker();
    fired(t);
    feed(t, [column(at(9), { mid: 106 }), column(at(10), { mid: 106 })]);
    const saved = JSON.parse(JSON.stringify(t.toJSON()));
    expect(saved).toMatchObject({ candleMs: MINUTE, rowWidth: 1, index: 39, lastColumnTs: at(10), building: null, zigzag: { dir: 1, pivot: 100, ext: 108 } });
    expect(saved.candles).toHaveLength(40);
    expect(saved.candles.every((c) => c.last === undefined)).toBe(true);
    expect(t.stats()).toMatchObject({ candles: 40, columns: 0 });
    expect(saved.unsettled.map((s) => [s.id, s.status, s.running])).toEqual([[FIRST, "pending", 108]]);
    const u = tracker();
    const back = u.restore(saved);
    expect(back.map((s) => [s.id, s.status, s.score, s.updatedAt])).toEqual([[FIRST, "pending", 6, at(10)]]);
    expect(u.list()).toEqual(back);
    expect(u.stats()).toMatchObject({ candles: 40, unsettled: 1, open: false, leg: { side: "buyers" } });
    expect(feed(u, [column(at(9), { mid: 106 }), column(at(10), { mid: 106 })])).toEqual([]);
    expect(u.stats()).toMatchObject({ candles: 40, unsettled: 1 });
    const rest = [column(at(11), { mid: 106 }), column(at(12), { mid: 106 }), column(at(13), { mid: 106 }), column(at(14), { mid: 105 }), column(at(15), { mid: 105 })];
    expect(feed(u, rest).map((s) => [s.id, s.status, s.judgedAt])).toEqual(feed(t, rest).map((s) => [s.id, s.status, s.judgedAt]));
    expect(u.list().map((s) => [s.status, s.judgedAt])).toEqual([["held", at(15)]]);
    expect(tracker().restore({ candleMs: MINUTE, rowWidth: 1 })).toEqual([]);
    expect(tracker().restore({ candleMs: 300_000, rowWidth: 1 })).toBeNull();
    expect(tracker().restore({ candleMs: MINUTE, rowWidth: 0.5 })).toBeNull();
    expect(tracker().restore({ ...saved, candles: "x" })).toBeNull();
    expect(tracker().restore(null)).toBeNull();
    expect(W).toBe(30);
  });

  test("a restored shade keeps the extreme its comeback is measured from, not the frozen one", () => {
    const t = tracker();
    fired(t);
    feed(t, [column(at(9), { mid: 108.9, buy: 1, sell: 1 }), column(at(10), { mid: 106 }), column(at(11), { mid: 106 })]);
    const u = tracker();
    expect(u.restore(JSON.parse(JSON.stringify(t.toJSON()))).map((s) => [s.id, s.status])).toEqual([[FIRST, "pending"]]);
    expect(feed(u, [column(at(12), { mid: 105.5 }), column(at(13), { mid: 105.5 })]).map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "held", at(13)]]);
  });

  test("a restored candle that was still open keeps its flows and reads no book until the next column", () => {
    const t = tracker();
    feed(t, [...warmColumns(), ...riseColumns(), quietColumns()[0], column(at(7), { mid: 108, buy: 1, sell: 3, asks: PULLED_ASKS })]);
    const u = tracker();
    u.restore(JSON.parse(JSON.stringify(t.toJSON())));
    expect(u.stats()).toMatchObject({ candles: 37, open: false });
    const [shade] = u.push(column(at(8), { mid: 108, buy: 1, sell: 1 }));
    expect(shade).toMatchObject({ id: FIRST, status: "open", score: 5, readings: { ...ALL_TRUE, book: false }, values: { book: null } });
  });

  test("a closed market feeds no candles: hours of frozen book without a trade neither open a candle nor wear the ATR down, and the first trade after them starts a session gap that interrupts the shade still waiting", () => {
    const t = tracker();
    fired(t);
    feed(t, [column(at(9), { mid: 106 }), column(at(10), { mid: 106 })]);
    expect(t.stats()).toMatchObject({ unsettled: 1 });
    expect(t.push(frozen(at(11), 106))).toEqual([]);
    const before = t.stats();
    const closure = [];
    for (let ts = at(11) + 10_000; ts < at(11) + 3 * 3_600_000; ts += 10_000) closure.push(frozen(ts, ts % 60_000 === 0 ? 104 : 106));
    expect(feed(t, closure)).toEqual([]);
    expect(t.stats()).toEqual(before);
    expect(t.toJSON().current).toBeNull();
    const reopen = at(11) + 3 * 3_600_000;
    expect(t.push(column(reopen, { mid: 106 }))).toEqual([]);
    expect(t.toJSON().current).toMatchObject({ ts: reopen, gap: true });
    expect(t.stats().atr).toBe(before.atr);
    const cut = t.push(column(reopen + MINUTE, { mid: 106 }));
    expect(cut.map((s) => [s.id, s.status, s.judgedAt])).toEqual([[FIRST, "interrupted", reopen + MINUTE]]);
    expect(t.stats()).toMatchObject({ unsettled: 0, leg: null });
    expect([hasTrades(column(BASE, { mid: 100 })), hasTrades(frozen(BASE, 100)), hasTrades(column(BASE, { mid: 100, sell: 2 }))]).toEqual([true, false, true]);
  });

  test("a column without a trade never opens a candle; it closes the candle in progress, and within two minutes of the last trade it still moves it", () => {
    const t = tracker();
    feed(t, warmColumns());
    t.push(column(BASE + W * MINUTE, { mid: 100, buy: 1, sell: 1 }));
    t.push(frozen(BASE + W * MINUTE + 20_000, 102));
    expect(t.toJSON().current).toMatchObject({ ts: BASE + W * MINUTE, hi: 102, close: 102 });
    const candles = t.stats().candles;
    t.push(frozen(BASE + (W + 1) * MINUTE, 102));
    expect(t.toJSON().current).toBeNull();
    expect(t.stats().candles).toBe(candles + 1);
    t.push(frozen(BASE + (W + 1) * MINUTE + 30_000, 103));
    expect(t.toJSON().current).toBeNull();
    t.push(column(BASE + (W + 2) * MINUTE, { mid: 101, buy: 1, sell: 1 }));
    expect(t.toJSON().current).toMatchObject({ ts: BASE + (W + 2) * MINUTE, gap: false, open: 101 });
    const quiet = tracker();
    feed(quiet, warmColumns());
    quiet.push(column(BASE + W * MINUTE, { mid: 100, buy: 1, sell: 1 }));
    quiet.push(frozen(BASE + W * MINUTE + GAP_MS + 10_000, 100));
    quiet.push(frozen(BASE + (W + 3) * MINUTE, 100));
    quiet.push(column(BASE + (W + 4) * MINUTE, { mid: 100, buy: 1, sell: 1 }));
    expect(quiet.toJSON().current).toMatchObject({ ts: BASE + (W + 4) * MINUTE, gap: true });
    const late = tracker();
    late.push(frozen(BASE, 100));
    late.push(frozen(BASE + MINUTE, 100));
    expect(late.stats().candles).toBe(0);
    expect(late.toJSON().current).toBeNull();
  });

  test("the daily one-hour break: the 1h candle carries straight on across it, 30 minutes and under start afresh, and an hour with no columns at all is still an outage for the 1h candle; a frozen weekend is a session gap under four hours and bridged from four hours up, the 4h candle untouched by the pre-open book", () => {
    const H = 3_600_000;
    const day = Math.ceil(BASE / (24 * H)) * 24 * H;
    const session = (from, to, mid = 100) => {
      const out = [];
      for (let ts = from; ts < to; ts += 10 * MINUTE) out.push(column(ts, { mid: mid + ((ts / (10 * MINUTE)) % 2), buy: 1, sell: 1 }));
      return out;
    };
    const closed = (from, to, mid) => {
      const out = [];
      for (let ts = from; ts < to; ts += 10 * MINUTE) out.push(frozen(ts, mid));
      return out;
    };
    const hour = createExhaustionTracker({ candleMs: H, rowWidth: 1 });
    const half = createExhaustionTracker({ candleMs: 1_800_000, rowWidth: 1 });
    const daily = [...session(day + 15 * H, day + 21 * H), ...closed(day + 21 * H, day + 22 * H, 105), column(day + 22 * H, { mid: 100, buy: 1, sell: 1 })];
    feed(hour, daily);
    feed(half, daily);
    expect(hour.toJSON().current).toMatchObject({ ts: day + 22 * H, gap: false });
    expect(half.toJSON().current).toMatchObject({ ts: day + 22 * H, gap: true });
    const dropped = createExhaustionTracker({ candleMs: H, rowWidth: 1 });
    feed(dropped, [...session(day + 15 * H, day + 21 * H), column(day + 22 * H, { mid: 100, buy: 1, sell: 1 })]);
    expect(dropped.toJSON().current).toMatchObject({ ts: day + 22 * H, gap: true });
    const four = createExhaustionTracker({ candleMs: 4 * H, rowWidth: 1 });
    const one = createExhaustionTracker({ candleMs: H, rowWidth: 1 });
    const weekend = [...session(day + 13 * H, day + 21 * H), ...closed(day + 21 * H, day + 21 * H + 49 * H, 105), column(day + 70 * H, { mid: 100, buy: 1, sell: 1 })];
    feed(four, weekend);
    feed(one, weekend);
    expect(four.toJSON().current).toMatchObject({ ts: day + 68 * H, gap: false });
    expect(one.toJSON().current).toMatchObject({ ts: day + 70 * H, gap: true });
    const pre = createExhaustionTracker({ candleMs: 4 * H, rowWidth: 1 });
    feed(pre, [...session(day + 20 * H, day + 21 * H), ...closed(day + 21 * H, day + 22 * H, 108)]);
    expect(pre.toJSON().current).toMatchObject({ ts: day + 20 * H, hi: 101, lo: 100 });
  });

  test("the last trade and the last column seen round-trip through toJSON and restore, so a tracker restored in a closure still ignores the frozen book and still sees the gap", () => {
    const t = tracker();
    fired(t);
    feed(t, [column(at(9), { mid: 106 }), column(at(10), { mid: 106 }), frozen(at(11), 106), frozen(at(11) + 3_600_000, 106)]);
    const saved = JSON.parse(JSON.stringify(t.toJSON()));
    expect(saved).toMatchObject({ lastColumnTs: at(10), lastSeenTs: at(11) + 3_600_000, lastTradeTs: at(10) });
    const u = tracker();
    u.restore(saved);
    expect(u.toJSON()).toMatchObject({ lastColumnTs: at(10), lastSeenTs: at(11) + 3_600_000, lastTradeTs: at(10) });
    expect(u.push(frozen(at(11) + 3_600_000, 106))).toEqual([]);
    const rest = [];
    for (let ts = at(11) + 3_600_000 + 10_000; ts < at(11) + 2 * 3_600_000; ts += 10_000) rest.push(frozen(ts, 106));
    expect(feed(u, rest)).toEqual([]);
    expect(u.toJSON().current).toBeNull();
    u.push(column(at(11) + 2 * 3_600_000, { mid: 106 }));
    expect(u.toJSON().current).toMatchObject({ gap: true });
    const old = tracker();
    old.restore({ ...saved, lastSeenTs: undefined, lastTradeTs: undefined });
    expect(old.toJSON()).toMatchObject({ lastSeenTs: at(10), lastTradeTs: at(10) });
  });

  test("a weekend is not a session gap for candles of four hours and up; shorter candles still break on a hole longer than themselves", () => {
    expect([LONG_CANDLE_MS, WEEKEND_MS]).toEqual([14_400_000, 3 * 86_400_000]);
    const H = 3_600_000;
    const week = [];
    for (let h = 0; h < 120; h += 1) week.push(column(BASE + h * H, { mid: h % 2 === 0 ? 100 : 101, buy: 1, sell: 1 }));
    for (let h = 120; h < 144; h += 1) week.push(column(BASE + h * H, { mid: 103 + Math.floor((h - 120) / 4), buy: 10 }));
    const after = week[week.length - 1].ts + 49 * H;
    for (let h = 0; h < 8; h += 1) week.push(column(after + h * H, { mid: 108, buy: 1, sell: 1 }));
    const four = createExhaustionTracker({ candleMs: 14_400_000, rowWidth: 1 });
    feed(four, week);
    expect(four.stats()).toMatchObject({ leg: { side: "buyers" } });
    const one = createExhaustionTracker({ candleMs: 3_600_000, rowWidth: 1 });
    feed(one, week);
    expect(one.stats().leg).toBeNull();
    const wide = createExhaustionTracker({ candleMs: 14_400_000, rowWidth: 1 });
    feed(wide, [...week.slice(0, 144), column(after + 30 * H, { mid: 108 }), column(after + 38 * H, { mid: 108 })]);
    expect(wide.stats().leg).toBeNull();
  });

  test("the engine reports its legs to a listener: a reset at the first candle and after a gap, a start from the warm-up's low, each new extreme, the flip that a three-ATR comeback makes; its candles are readable by index", () => {
    const events = [];
    const t = createExhaustionTracker({ candleMs: MINUTE, rowWidth: 1, onLeg: (event) => events.push(event) });
    expect(() => createExhaustionTracker({ candleMs: MINUTE, rowWidth: 1, onLeg: 1 })).toThrow(/onLeg/);
    feed(t, [...warmColumns(), ...riseColumns()]);
    expect(events).toEqual([
      { type: "reset", index: 0 },
      { type: "start", index: 30, up: true, pivotIdx: PIVOT_INDEX, pivot: 100, atrRef: expect.closeTo(warmAtr(), 10), ext: 103, extIdx: 30 },
      ...[104, 105, 106, 107].map((ext, k) => ({ type: "extreme", index: 31 + k, ext, extIdx: 31 + k })),
    ]);
    expect(events.every((event) => Object.isFrozen(event))).toBe(true);
    events.length = 0;
    feed(t, [column(at(6), { mid: 108, buy: 2, sell: 6 }), column(at(7), { mid: 106, buy: 1, sell: 5 }), column(at(8), { mid: 105, buy: 3, sell: 7 })]);
    const [extreme, ...none] = events;
    expect(none).toEqual([]);
    expect(extreme).toEqual({ type: "extreme", index: 35, ext: 108, extIdx: 35 });
    const atPivot = t.candleAt(35).atr;
    expect(t.push(column(at(9), { mid: 105 }))).toEqual([]);
    expect(events[1]).toEqual({ type: "flip", index: 38, up: false, pivotIdx: 35, pivot: 108, atrRef: atPivot, ext: 105, extIdx: 38 });
    expect(t.candleAt(35)).toMatchObject({ ts: at(5), close: 108, hi: 108, buy: 10, sell: 0, index: 35 });
    expect([t.candleAt(-1), t.candleAt(39), t.candleAt(40)]).toEqual([null, null, null]);
    t.push(column(at(9) + 3 * 3_600_000, { mid: 105 }));
    events.length = 0;
    t.push(column(at(9) + 3 * 3_600_000 + MINUTE, { mid: 105 }));
    expect(events).toEqual([{ type: "reset", index: 40 }]);
    expect(t.stats()).toMatchObject({ leg: null });
  });
});
