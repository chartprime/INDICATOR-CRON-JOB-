const {
  initiativeBandsFrame,
  initiativeBandsFrames,
  byPivot,
  MAX_INITIATIVE_BANDS,
  MAX_INITIATIVE_ID_LENGTH,
  MAX_INITIATIVE_SCORE,
  MAX_INITIATIVE_VALUE,
  MAX_INITIATIVE_WINDOW,
  INITIATIVE_CANDLE_MS,
  INITIATIVE_SIDES,
  INITIATIVE_DOMINANTS,
  INITIATIVE_FACTS,
  INITIATIVE_FACT_KEYS,
  INITIATIVE_ORIGINS,
} = require("../../src/server/initiative-frames");

const binance = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const dxfeed = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };
const PIVOT = 1_700_000_040_000;
const FROZEN = 1_700_000_220_000;

function facts(overrides = {}) {
  return {
    efficiency: { yes: true, value: 0.714 },
    closes: { yes: true, value: 2 },
    burst: { yes: false, value: 0.8 },
    delta: { yes: true, rank: 1, share: 0.75 },
    prints: { yes: true, rank: 0.833, perCandle: 1 },
    ...overrides,
  };
}

function band(overrides = {}) {
  return {
    id: `60000|down|${PIVOT}`, candleMs: 60_000, side: "down", dominant: "sellers", dominantShare: 0.75, score: 4, facts: facts(),
    pivotTs: PIVOT, pivotPrice: 108, frozenTs: FROZEN, frozenPrice: 105.5, windowCandles: 3, atr: 1.035,
    legExtremePrice: 105, legExtremeTs: FROZEN, legEndTs: null, updatedAt: 1_700_000_280_000, origin: "runtime", ...overrides,
  };
}

function frame(bands, rest = {}) {
  return initiativeBandsFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, bands, ...rest });
}

describe("server/initiative-frames", () => {
  test("a frame carries the identity, a timestamp, a seq, the reset flag, the bands, liveSince and loading (null unless the runtime is reading the host), frozen", () => {
    const built = initiativeBandsFrame(dxfeed, { ts: 10_000, seq: 3, reset: false, liveSince: 1000, bands: [band()] });
    expect(built).toEqual({ type: "initiative_bands", provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", ts: 10_000, seq: 3, reset: false, bands: [band()], liveSince: 1000, loading: null });
    expect(frame([], { loading: 500 }).loading).toBe(500);
    for (const bad of ["500", -1, 1.5, true]) expect(() => frame([], { loading: bad })).toThrow(/loading/);
    expect(Object.isFrozen(built) && Object.isFrozen(built.bands) && Object.isFrozen(built.bands[0]) && Object.isFrozen(built.bands[0].facts) && Object.isFrozen(built.bands[0].facts.delta)).toBe(true);
    const crypto = initiativeBandsFrame(binance, { ts: 10_000, seq: 0, reset: true, liveSince: 1000, bands: [] });
    expect(crypto).toMatchObject({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL", reset: true, bands: [] });
  });

  test("a band is exactly the eighteen wire fields in the closed vocabularies, the five facts with their exact keys, extra fields dropped", () => {
    expect(INITIATIVE_CANDLE_MS).toEqual([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000]);
    expect(INITIATIVE_SIDES).toEqual(["up", "down"]);
    expect(INITIATIVE_DOMINANTS).toEqual(["buyers", "sellers"]);
    expect(INITIATIVE_ORIGINS).toEqual(["runtime", "host", "stored"]);
    expect(INITIATIVE_FACTS).toEqual(["efficiency", "closes", "burst", "delta", "prints"]);
    expect(INITIATIVE_FACT_KEYS).toEqual({ efficiency: ["yes", "value"], closes: ["yes", "value"], burst: ["yes", "value"], delta: ["yes", "rank", "share"], prints: ["yes", "rank", "perCandle"] });
    expect([MAX_INITIATIVE_SCORE, MAX_INITIATIVE_VALUE, MAX_INITIATIVE_WINDOW, MAX_INITIATIVE_BANDS, MAX_INITIATIVE_ID_LENGTH]).toEqual([5, 1_000_000, 1_000, 500, 96]);
    const built = frame([{ ...band(), extra: 1 }]);
    expect(Object.keys(built.bands[0]).sort()).toEqual(["atr", "candleMs", "dominant", "dominantShare", "facts", "frozenPrice", "frozenTs", "id", "legEndTs", "legExtremePrice", "legExtremeTs", "origin", "pivotPrice", "pivotTs", "score", "side", "updatedAt", "windowCandles"]);
    expect(Object.keys(built.bands[0].facts)).toEqual(["efficiency", "closes", "burst", "delta", "prints"]);
    expect(built.bands[0].facts).toEqual(facts());
    expect(Object.keys(built.bands[0].facts.delta)).toEqual(["yes", "rank", "share"]);
  });

  test.each([
    ["an empty id", { id: "" }, /id/],
    ["an id over the cap", { id: "x".repeat(MAX_INITIATIVE_ID_LENGTH + 1) }, /id/],
    ["a candle length off the chart", { candleMs: 240_000 }, /candleMs/],
    ["a side outside the vocabulary", { side: "buyers" }, /side/],
    ["a dominant outside the vocabulary", { dominant: "up" }, /dominant/],
    ["a dominant share over one", { dominantShare: 1.5 }, /dominantShare/],
    ["a dominant share that is null", { dominantShare: null }, /dominantShare/],
    ["a dominant share that is not a number", { dominantShare: "0.5" }, /dominantShare/],
    ["a score below zero", { score: -1 }, /score/],
    ["a score over the cap", { score: MAX_INITIATIVE_SCORE + 1 }, /score/],
    ["a score that is not an integer", { score: 2.5 }, /score/],
    ["no facts", { facts: null }, /facts/],
    ["facts as an array", { facts: [] }, /facts/],
    ["a fact missing", { facts: { efficiency: { yes: true, value: 0.7 }, closes: { yes: true, value: 2 }, burst: { yes: false, value: 0.8 }, delta: { yes: true, rank: 1, share: 0.75 } } }, /facts/],
    ["a sixth fact", { facts: { ...facts(), volume: { yes: true, value: 1 } } }, /facts/],
    ["a fact that is not an object", { facts: facts({ burst: true }) }, /facts\.burst/],
    ["a fact key missing", { facts: facts({ delta: { yes: true, rank: 1 } }) }, /facts\.delta/],
    ["a fact with an extra key", { facts: facts({ delta: { yes: true, rank: 1, share: 0.75, extra: 2 } }) }, /facts\.delta/],
    ["a yes that is not a boolean", { facts: facts({ closes: { yes: 1, value: 2 } }) }, /facts\.closes\.yes/],
    ["an efficiency over one", { facts: facts({ efficiency: { yes: true, value: 1.5 } }) }, /facts\.efficiency\.value/],
    ["an efficiency below zero", { facts: facts({ efficiency: { yes: false, value: -0.1 } }) }, /facts\.efficiency\.value/],
    ["an efficiency that is not a number", { facts: facts({ efficiency: { yes: true, value: "0.7" } }) }, /facts\.efficiency\.value/],
    ["a closes count that is not an integer", { facts: facts({ closes: { yes: true, value: 1.5 } }) }, /facts\.closes\.value/],
    ["a closes count below zero", { facts: facts({ closes: { yes: false, value: -1 } }) }, /facts\.closes\.value/],
    ["a closes count that is null", { facts: facts({ closes: { yes: false, value: null } }) }, /facts\.closes\.value/],
    ["more strong closes than window candles", { facts: facts({ closes: { yes: true, value: 4 } }) }, /facts\.closes\.value/],
    ["a burst below zero", { facts: facts({ burst: { yes: false, value: -1 } }) }, /facts\.burst\.value/],
    ["a burst over the cap", { facts: facts({ burst: { yes: true, value: MAX_INITIATIVE_VALUE + 1 } }) }, /facts\.burst\.value/],
    ["a burst that is not finite", { facts: facts({ burst: { yes: true, value: NaN } }) }, /facts\.burst\.value/],
    ["a burst that is infinite", { facts: facts({ burst: { yes: true, value: Infinity } }) }, /facts\.burst\.value/],
    ["a delta rank over one", { facts: facts({ delta: { yes: true, rank: 1.5, share: 0.75 } }) }, /facts\.delta\.rank/],
    ["a delta share below zero", { facts: facts({ delta: { yes: true, rank: 1, share: -1 } }) }, /facts\.delta\.share/],
    ["a prints rank that is not a number", { facts: facts({ prints: { yes: true, rank: "1", perCandle: 1 } }) }, /facts\.prints\.rank/],
    ["prints per candle over the cap", { facts: facts({ prints: { yes: true, rank: 1, perCandle: MAX_INITIATIVE_VALUE + 1 } }) }, /facts\.prints\.perCandle/],
    ["prints per candle below zero", { facts: facts({ prints: { yes: true, rank: 1, perCandle: -1 } }) }, /facts\.prints\.perCandle/],
    ["a frozen time at the pivot", { frozenTs: PIVOT }, /frozenTs/],
    ["a frozen time before the pivot", { frozenTs: PIVOT - 1 }, /frozenTs/],
    ["an extreme time before the frozen time", { legExtremeTs: FROZEN - 1 }, /legExtremeTs/],
    ["a leg end before the frozen time", { legEndTs: FROZEN - 1 }, /legEndTs/],
    ["a leg end that is not an integer", { legEndTs: 1.5 }, /legEndTs/],
    ["an update before the frozen time", { updatedAt: FROZEN - 1 }, /updatedAt/],
    ["a pivot price of zero", { pivotPrice: 0 }, /pivotPrice/],
    ["a frozen price of zero", { frozenPrice: 0 }, /frozenPrice/],
    ["an extreme price of zero", { legExtremePrice: 0 }, /legExtremePrice/],
    ["an ATR of zero", { atr: 0 }, /atr/],
    ["no window candles", { windowCandles: 0, facts: facts({ closes: { yes: false, value: 0 } }) }, /windowCandles/],
    ["window candles over the cap", { windowCandles: MAX_INITIATIVE_WINDOW + 1 }, /windowCandles/],
    ["an origin outside the vocabulary", { origin: "laptop" }, /origin/],
    ["a pivot time that is not an integer", { pivotTs: 1.5 }, /pivotTs/],
  ])("the builder refuses %s", (_label, overrides, pattern) => {
    expect(() => frame([band(overrides)])).toThrow(pattern);
  });

  test("the fact values the engine could not read are null, a leg still running has legEndTs null, and the caps themselves are admitted", () => {
    const unread = facts({ efficiency: { yes: false, value: null }, burst: { yes: false, value: null }, delta: { yes: false, rank: null, share: null }, prints: { yes: false, rank: null, perCandle: null } });
    expect(frame([band({ facts: unread })]).bands[0].facts).toEqual(unread);
    const edge = facts({ efficiency: { yes: true, value: 1 }, closes: { yes: true, value: 3 }, burst: { yes: true, value: MAX_INITIATIVE_VALUE }, delta: { yes: true, rank: 1, share: 1 }, prints: { yes: true, rank: 0, perCandle: 0 } });
    expect(frame([band({ facts: edge, dominantShare: 1, score: MAX_INITIATIVE_SCORE, windowCandles: MAX_INITIATIVE_WINDOW })]).bands[0]).toMatchObject({ facts: edge, dominantShare: 1, score: MAX_INITIATIVE_SCORE });
    expect(frame([band({ legEndTs: FROZEN })]).bands[0].legEndTs).toBe(FROZEN);
    expect(frame([band({ legEndTs: null })]).bands[0].legEndTs).toBeNull();
    expect(frame([band({ score: 0, dominantShare: 0 })]).bands[0]).toMatchObject({ score: 0, dominantShare: 0 });
  });

  test("the frame refuses an empty increment, a page over the cap, duplicate ids, bands out of pivot order, and a bad liveSince", () => {
    expect(() => frame([], { reset: false })).toThrow(/at least one band/);
    expect(() => frame(Array.from({ length: MAX_INITIATIVE_BANDS + 1 }, () => band()))).toThrow(/at most/);
    expect(() => frame([band(), band()])).toThrow(/unique/);
    const later = band({ id: "later", pivotTs: PIVOT + 60_000 });
    expect(() => frame([later, band()])).toThrow(/pivot order/);
    expect(frame([band(), later]).bands.map((b) => b.id)).toEqual([band().id, "later"]);
    expect(byPivot(band(), later)).toBeLessThan(0);
    expect(byPivot(band({ id: "b" }), band({ id: "a" }))).toBeGreaterThan(0);
    expect(byPivot(band(), band())).toBe(0);
    for (const bad of [undefined, -1, 1.5, "1000"]) expect(() => frame([], { liveSince: bad })).toThrow(/liveSince/);
    expect(() => initiativeBandsFrame({ provider: "X" }, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, bands: [] })).toThrow(/provider/);
    expect(() => frame([], { reset: "yes" })).toThrow(/reset/);
    expect(() => frame([], { ts: -1 })).toThrow(/ts/);
    expect(() => frame([], { seq: -1 })).toThrow(/seq/);
    expect(() => frame([null])).toThrow(/must be a band/);
  });

  test("a snapshot is paged: the first page resets, later pages append, an empty snapshot is one reset page", () => {
    const many = Array.from({ length: MAX_INITIATIVE_BANDS + 2 }, (_, i) => band({ id: `b${String(i).padStart(4, "0")}`, pivotTs: PIVOT + i * 60_000, frozenTs: FROZEN + i * 60_000, legExtremeTs: FROZEN + i * 60_000, updatedAt: FROZEN + i * 60_000 }));
    const pages = initiativeBandsFrames(binance, 20_000, many, { liveSince: 1000 });
    expect(pages.map((page) => [page.seq, page.reset, page.bands.length])).toEqual([[0, true, MAX_INITIATIVE_BANDS], [1, false, 2]]);
    expect(initiativeBandsFrames(binance, 20_000, [], { liveSince: 1000 })).toEqual([expect.objectContaining({ seq: 0, reset: true, bands: [] })]);
    expect(() => initiativeBandsFrames(binance, 20_000, [], { chunk: 0, liveSince: 1000 })).toThrow(/chunk/);
    expect(() => initiativeBandsFrames(binance, 20_000, null, { liveSince: 1000 })).toThrow(/bands/);
  });
});
