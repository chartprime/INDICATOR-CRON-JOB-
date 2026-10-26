const {
  exhaustionShadesFrame,
  exhaustionShadesFrames,
  MAX_EXHAUSTION_SHADES,
  MAX_EXHAUSTION_ID_LENGTH,
  MAX_EXHAUSTION_INTENSITY,
  EXHAUSTION_CANDLE_MS,
  EXHAUSTION_SIDES,
  EXHAUSTION_STATUSES,
  EXHAUSTION_ORIGINS,
  EXHAUSTION_READINGS,
  MAX_EXHAUSTION_SCORE,
  MAX_EXHAUSTION_VALUE,
} = require("../../src/server/exhaustion-frames");
const { frameKindOf, FRAME_KIND_INCREMENTAL } = require("../../src/server/frames");

const binance = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const dxfeed = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };

function shade(overrides = {}) {
  return {
    id: "60000|buyers|1700000040000", candleMs: 60_000, side: "buyers", status: "held", intensity: 2, score: 4, readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.3, progress: 0.2, delta: -0.25, divergence: 0.1, prints: 0.2, book: 0.95 },
    raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
    startTs: 1_700_000_040_000, endTs: 1_700_000_100_000, extremeTs: 1_699_999_980_000, extremePrice: 104, legStartTs: 1_699_999_800_000, legStartPrice: 101,
    legSize: 3, efficiency: 0.8, atr: 1, judgedAt: 1_700_000_280_000, updatedAt: 1_700_000_280_000, origin: "runtime", ...overrides,
  };
}

describe("server/exhaustion-frames", () => {
  test("a frame carries the identity, a timestamp, a seq, the reset flag, the shades, liveSince and loading (null unless the runtime is reading the host), frozen", () => {
    const frame = exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 3, reset: false, liveSince: 1000, shades: [shade()] });
    expect(frame).toEqual({ type: "exhaustion_shades", provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", ts: 10_000, seq: 3, reset: false, shades: [shade()], liveSince: 1000, loading: null });
    expect(exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 3, reset: true, liveSince: 1000, loading: 500, shades: [] }).loading).toBe(500);
    for (const bad of ["500", -1, 1.5, true]) expect(() => exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 3, reset: true, liveSince: 1000, loading: bad, shades: [] })).toThrow(/loading/);
    expect(Object.isFrozen(frame) && Object.isFrozen(frame.shades) && Object.isFrozen(frame.shades[0]) && Object.isFrozen(frame.shades[0].readings) && Object.isFrozen(frame.shades[0].values)).toBe(true);
    const crypto = exhaustionShadesFrame(binance, { ts: 10_000, seq: 0, reset: true, liveSince: 1000, shades: [] });
    expect(crypto).toMatchObject({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL", reset: true, shades: [] });
    expect(frameKindOf(frame)).toBe(FRAME_KIND_INCREMENTAL);
  });

  test("a shade is exactly the twenty-one wire fields in the closed vocabularies, extra fields dropped", () => {
    expect(EXHAUSTION_CANDLE_MS).toEqual([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000]);
    expect(EXHAUSTION_SIDES).toEqual(["buyers", "sellers"]);
    expect(EXHAUSTION_STATUSES).toEqual(["open", "pending", "held", "broke", "interrupted"]);
    expect(EXHAUSTION_ORIGINS).toEqual(["runtime", "host", "stored"]);
    expect(EXHAUSTION_READINGS).toEqual(["rate", "progress", "delta", "divergence", "prints", "book"]);
    expect(MAX_EXHAUSTION_SCORE).toBe(6);
    expect(MAX_EXHAUSTION_VALUE).toBe(1_000_000);
    const built = exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [{ ...shade(), extra: 1 }] });
    expect(Object.keys(built.shades[0]).sort()).toEqual(["atr", "candleMs", "efficiency", "endTs", "extremePrice", "extremeTs", "id", "intensity", "judgedAt", "legSize", "legStartPrice", "legStartTs", "origin", "raw", "readings", "score", "side", "startTs", "status", "updatedAt", "values"]);
    expect(Object.keys(built.shades[0].readings)).toEqual(["rate", "progress", "delta", "divergence", "prints", "book"]);
    expect(built.shades[0].values).toEqual({ rate: 0.3, progress: 0.2, delta: -0.25, divergence: 0.1, prints: 0.2, book: 0.95 });
    expect(Object.keys(built.shades[0].values)).toEqual(["rate", "progress", "delta", "divergence", "prints", "book"]);
  });

  test.each([
    ["an empty id", { id: "" }, /id/],
    ["an id over the cap", { id: "x".repeat(MAX_EXHAUSTION_ID_LENGTH + 1) }, /id/],
    ["a candle length off the chart", { candleMs: 240_000 }, /candleMs/],
    ["a side outside the vocabulary", { side: "bulls" }, /side/],
    ["a status outside the vocabulary", { status: "won" }, /status/],
    ["an intensity of zero", { intensity: 0 }, /intensity/],
    ["an intensity over the cap", { intensity: MAX_EXHAUSTION_INTENSITY + 1 }, /intensity/],
    ["a score below zero", { score: -1 }, /score/],
    ["a score over the cap", { score: MAX_EXHAUSTION_SCORE + 1 }, /score/],
    ["a reading missing", { readings: { rate: true, progress: true, delta: true, divergence: false, prints: true } }, /readings/],
    ["a seventh reading", { readings: { rate: true, progress: true, delta: true, divergence: false, prints: true, book: false, wall: true } }, /readings/],
    ["a reading that is not a boolean", { readings: { rate: 1, progress: true, delta: true, divergence: false, prints: true, book: false } }, /readings\.rate/],
    ["a raw sum that is not a number", { raw: { ...shade().raw, own: "x" } }, /raw.own/],
    ["a raw key missing", { raw: { own: 1 } }, /raw/],
    ["a thirteenth raw key", { raw: { ...shade().raw, extra: 1 } }, /raw/],
    ["a book band off the three", { raw: { ...shade().raw, bookBand: 3 } }, /bookBand/],
    ["raw sums that are not an object", { raw: null }, /raw/],
    ["no values", { values: undefined }, /values/],
    ["a value missing", { values: { rate: 0.2, progress: 0, delta: -0.4, divergence: -1.4, prints: null } }, /values/],
    ["a seventh value", { values: { rate: 0.2, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5, wall: 1 } }, /values/],
    ["a value that is not a number", { values: { rate: "0.2", progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 } }, /values\.rate/],
    ["a value that is not finite", { values: { rate: 0.2, progress: NaN, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 } }, /values\.progress/],
    ["a value that is infinite", { values: { rate: 0.2, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: -Infinity } }, /values\.book/],
    ["a value over the cap", { values: { rate: 0.2, progress: 0, delta: -0.4, divergence: -1.4, prints: MAX_EXHAUSTION_VALUE + 1, book: 0.5 } }, /values\.prints/],
    ["a value under the cap", { values: { rate: 0.2, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: -MAX_EXHAUSTION_VALUE - 1 } }, /values\.book/],
    ["an end before the start", { endTs: 1_700_000_040_000 }, /endTs/],
    ["a leg start after the extreme", { legStartTs: 1_700_000_000_000 }, /legStartTs/],
    ["an extreme at or after the end", { extremeTs: 1_700_000_100_000 }, /extremeTs/],
    ["an update before the start", { updatedAt: 1 }, /updatedAt/],
    ["a judged shade without a judgedAt", { judgedAt: null }, /judgedAt/],
    ["a judgedAt before the end", { judgedAt: 1_700_000_050_000 }, /judgedAt/],
    ["an open shade with a judgedAt", { status: "open", judgedAt: 1_700_000_280_000 }, /judgedAt/],
    ["a pending shade with a judgedAt", { status: "pending", judgedAt: 1_700_000_280_000 }, /judgedAt/],
    ["a price of zero", { extremePrice: 0 }, /extremePrice/],
    ["a leg size of zero", { legSize: 0 }, /legSize/],
    ["an ATR of zero", { atr: 0 }, /atr/],
    ["a straightness of zero", { efficiency: 0 }, /efficiency/],
    ["a straightness over one", { efficiency: 1.5 }, /efficiency/],
    ["an origin outside the vocabulary", { origin: "laptop" }, /origin/],
  ])("the builder refuses %s", (_label, overrides, pattern) => {
    expect(() => exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [shade(overrides)] })).toThrow(pattern);
  });

  test("open and pending shades carry judgedAt null; every value may be null when the engine could not read it, and the cap itself is admitted", () => {
    for (const status of ["open", "pending"]) {
      const built = exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [shade({ status, judgedAt: null })] });
      expect(built.shades[0].judgedAt).toBeNull();
    }
    const empty = { rate: null, progress: null, delta: null, divergence: null, prints: null, book: null };
    expect(exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [shade({ values: empty })] }).shades[0].values).toEqual(empty);
    const edge = { rate: MAX_EXHAUSTION_VALUE, progress: -MAX_EXHAUSTION_VALUE, delta: 0, divergence: 0, prints: 0, book: 0 };
    expect(exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [shade({ values: edge })] }).shades[0].values).toEqual(edge);
  });

  test("the frame refuses an empty increment, a page over the cap, duplicate ids, shades out of start order, and a bad liveSince", () => {
    expect(() => exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: false, liveSince: 1000, shades: [] })).toThrow(/at least one shade/);
    expect(() => exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: Array.from({ length: MAX_EXHAUSTION_SHADES + 1 }, () => shade()) })).toThrow(/at most/);
    expect(() => exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [shade(), shade()] })).toThrow(/unique/);
    const later = shade({ id: "later", startTs: 1_700_000_100_000, endTs: 1_700_000_160_000 });
    expect(() => exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [later, shade()] })).toThrow(/start order/);
    expect(exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [shade(), later] }).shades.map((s) => s.id)).toEqual([shade().id, "later"]);
    for (const bad of [undefined, -1, 1.5, "1000"]) expect(() => exhaustionShadesFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: bad, shades: [] })).toThrow(/liveSince/);
    expect(() => exhaustionShadesFrame({ provider: "X" }, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, shades: [] })).toThrow(/provider/);
  });

  test("a snapshot is paged: the first page resets, later pages append, an empty snapshot is one reset page", () => {
    const many = Array.from({ length: MAX_EXHAUSTION_SHADES + 2 }, (_, i) => shade({ id: `s${String(i).padStart(4, "0")}`, startTs: 1_700_000_040_000 + i * 60_000, endTs: 1_700_000_100_000 + i * 60_000, extremeTs: 1_699_999_980_000 + i * 60_000, legStartTs: 1_699_999_800_000 + i * 60_000, judgedAt: 1_700_000_160_000 + i * 60_000, updatedAt: 1_700_000_160_000 + i * 60_000 }));
    const pages = exhaustionShadesFrames(binance, 20_000, many, { liveSince: 1000 });
    expect(pages.map((page) => [page.seq, page.reset, page.shades.length])).toEqual([[0, true, MAX_EXHAUSTION_SHADES], [1, false, 2]]);
    expect(exhaustionShadesFrames(binance, 20_000, [], { liveSince: 1000 })).toEqual([expect.objectContaining({ seq: 0, reset: true, shades: [] })]);
    expect(() => exhaustionShadesFrames(binance, 20_000, [], { chunk: 0, liveSince: 1000 })).toThrow(/chunk/);
  });
});
