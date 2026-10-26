const {
  icebergOrdersFrame,
  icebergOrdersFrames,
  MAX_ICEBERG_ORDERS,
  MAX_ICEBERG_ID_LENGTH,
  MAX_WATCHED_SPANS,
  ICEBERG_KINDS,
  ICEBERG_CONFIDENCES,
  ICEBERG_STATUSES, ICEBERG_ORIGINS,
} = require("../../src/server/iceberg-frames");
const { frameKindOf, FRAME_KIND_INCREMENTAL } = require("../../src/server/frames");
const { DEFAULT_MAX_SPANS } = require("../../src/indicators/iceberg/iceberg-history");

const binance = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const dxfeed = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };
const equity = { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" };

function iceberg(overrides = {}) {
  return {
    id: "/NQZ26:XCME|5137554220647449213|1000", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32,
    startedAt: 1000, markedAt: 1500, updatedAt: 9000, status: "filled", ...overrides,
  };
}

describe("server/iceberg-frames", () => {
  test("a frame carries the identity, a timestamp, a seq, the reset flag and the icebergs, frozen", () => {
    const frame = icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 3, reset: false, liveSince: 1000, icebergs: [iceberg()] });
    expect(frame).toEqual({ type: "iceberg_orders", provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", ts: 10_000, seq: 3, reset: false, icebergs: [iceberg()], watched: [], liveSince: 1000 });
    expect(Object.isFrozen(frame) && Object.isFrozen(frame.icebergs) && Object.isFrozen(frame.icebergs[0])).toBe(true);
    const crypto = icebergOrdersFrame(binance, { ts: 10_000, seq: 0, reset: true, liveSince: 1000, icebergs: [] });
    expect(crypto).toMatchObject({ provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL", reset: true, icebergs: [] });
  });

  test("an iceberg is exactly the thirteen wire fields in the closed vocabularies", () => {
    expect(ICEBERG_KINDS).toEqual(["native", "probable"]);
    expect(ICEBERG_CONFIDENCES).toEqual(["certain", "strong", "probable", "weak"]);
    expect(ICEBERG_STATUSES).toEqual(["active", "filled", "pulled", "replaced", "interrupted", "ended"]);
    expect(ICEBERG_ORIGINS).toEqual(["runtime", "host"]);
    const built = icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, icebergs: [{ ...iceberg(), extra: 1 }] });
    expect(Object.keys(built.icebergs[0]).sort()).toEqual(["confidence", "display", "executed", "id", "kind", "markedAt", "origin", "price", "side", "startedAt", "status", "tranches", "updatedAt"]);
  });

  test.each([
    ["kind", { kind: "synthetic" }],
    ["confidence", { confidence: "sure" }],
    ["side", { side: "buy" }],
    ["status", { status: "open" }],
    ["id", { id: "" }],
    ["id", { id: "x".repeat(MAX_ICEBERG_ID_LENGTH + 1) }],
    ["price", { price: 0 }],
    ["price", { price: 10_000_001 }],
    ["display", { display: -1 }],
    ["executed", { executed: Number.NaN }],
    ["tranches", { tranches: 0 }],
    ["tranches", { tranches: 1.5 }],
    ["startedAt", { startedAt: -1 }],
    ["markedAt", { markedAt: 999 }],
    ["updatedAt", { updatedAt: 1499 }],
  ])("refuses a bad %s", (field, bad) => {
    expect(() => icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, liveSince: 1000, icebergs: [iceberg(bad)] })).toThrow(new RegExp(`icebergs\\[0\\]\\.${field}`));
  });

  test("sizes obey the identity's ceiling: futures and crypto stop at the wire magnitude, equities go higher", () => {
    expect(() => icebergOrdersFrame(dxfeed, { ts: 1, seq: 1, reset: true, liveSince: 1000, icebergs: [iceberg({ executed: 10_000_001 })] })).toThrow(/executed/);
    expect(icebergOrdersFrame(equity, { ts: 1, seq: 1, reset: true, liveSince: 1000, icebergs: [iceberg({ executed: 10_000_001, display: 10_000_001 })] }).icebergs[0].executed).toBe(10_000_001);
  });

  test("frame-level rules: ts and seq are counters, reset is a flag, ids are unique, order is by mark, an increment is never empty", () => {
    expect(() => icebergOrdersFrame(dxfeed, { ts: -1, seq: 0, reset: true, liveSince: 1000, icebergs: [] })).toThrow(/ts/);
    expect(() => icebergOrdersFrame(dxfeed, { ts: 1, seq: -1, reset: true, liveSince: 1000, icebergs: [] })).toThrow(/seq/);
    expect(() => icebergOrdersFrame(dxfeed, { ts: 1, seq: 0, reset: "yes", icebergs: [], liveSince: 1000 })).toThrow(/reset/);
    expect(() => icebergOrdersFrame(dxfeed, { ts: 1, seq: 0, reset: false, liveSince: 1000, icebergs: [] })).toThrow(/increment/);
    expect(() => icebergOrdersFrame(dxfeed, { ts: 1, seq: 0, reset: true, liveSince: 1000, icebergs: [iceberg(), iceberg()] })).toThrow(/unique/);
    expect(() => icebergOrdersFrame(dxfeed, { ts: 1, seq: 0, reset: true, liveSince: 1000, icebergs: [iceberg({ markedAt: 2000, startedAt: 1000 }), iceberg({ id: "b", markedAt: 1500 })] })).toThrow(/mark order/);
    expect(() => icebergOrdersFrame({ provider: "KRAKEN" }, { ts: 1, seq: 0, reset: true, liveSince: 1000, icebergs: [] })).toThrow(/provider/);
    expect(() => icebergOrdersFrame(dxfeed, { ts: 1, seq: 0, reset: true, liveSince: 1000, icebergs: Array.from({ length: MAX_ICEBERG_ORDERS + 1 }, (_, i) => iceberg({ id: `i${i}` })) })).toThrow(/at most/);
    expect(MAX_ICEBERG_ORDERS).toBe(500);
    expect(MAX_ICEBERG_ID_LENGTH).toBe(96);
  });

  test("every frame carries the spans the runtime watched: epoch pairs, ascending and disjoint, at most the bound shared with the history, frozen; a page set carries them on each page", () => {
    const spans = [[1000, 2000], [2000, 2500], [3000, 4000]];
    const frame = icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 0, reset: true, liveSince: 1000, icebergs: [], watched: spans });
    expect(frame.watched).toEqual(spans);
    expect(Object.isFrozen(frame.watched) && Object.isFrozen(frame.watched[0])).toBe(true);
    expect(icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 0, reset: true, liveSince: 1000, icebergs: [] }).watched).toEqual([]);
    expect(MAX_WATCHED_SPANS).toBe(DEFAULT_MAX_SPANS);
    const many = Array.from({ length: MAX_WATCHED_SPANS + 1 }, (_, i) => [i * 10, i * 10 + 5]);
    for (const bad of [[[2000, 1000]], [[1000, 2000], [1500, 3000]], [[1000, 2000], [500, 600]], [[1, 2, 3]], [[1, "2"]], [[-1, 2]], "x", null, many]) {
      expect(() => icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 0, reset: true, liveSince: 1000, icebergs: [], watched: bad })).toThrow(/watched/);
    }
    expect(icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 0, reset: true, liveSince: 1000, icebergs: [], watched: many.slice(1) }).watched).toHaveLength(MAX_WATCHED_SPANS);
    const pages = icebergOrdersFrames(dxfeed, 10_000, [iceberg(), iceberg({ id: "b", markedAt: 1600 })], { chunk: 1, liveSince: 1000, watched: spans });
    expect(pages.map((page) => page.watched)).toEqual([spans, spans]);
  });

  test("every frame says when this runtime started watching the pair (liveSince): an epoch, required, carried through the pages", () => {
    const built = icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, icebergs: [iceberg()], watched: [], liveSince: 9_000 });
    expect(built.liveSince).toBe(9_000);
    for (const bad of [undefined, null, -1, 1.5, "9000"]) expect(() => icebergOrdersFrame(dxfeed, { ts: 10_000, seq: 1, reset: true, icebergs: [iceberg()], watched: [], liveSince: bad })).toThrow(/liveSince/);
    const pages = icebergOrdersFrames(dxfeed, 10_000, [iceberg(), iceberg({ id: "b", markedAt: 1600 })], { chunk: 1, liveSince: 9_000 });
    expect(pages.map((page) => page.liveSince)).toEqual([9_000, 9_000]);
  });

  test("a snapshot is chunked into pages: the first resets, the rest append, seq counts the pages", () => {
    const list = Array.from({ length: 1201 }, (_, i) => iceberg({ id: `i${i}`, markedAt: 1500 + i, updatedAt: 9000 + i }));
    const pages = icebergOrdersFrames(dxfeed, 20_000, list, { liveSince: 1000 });
    expect(pages.map((page) => [page.reset, page.seq, page.icebergs.length])).toEqual([[true, 0, 500], [false, 1, 500], [false, 2, 201]]);
    expect(pages.every((page) => page.ts === 20_000)).toBe(true);
    expect(icebergOrdersFrames(dxfeed, 20_000, [], { liveSince: 1000 })).toEqual([icebergOrdersFrame(dxfeed, { ts: 20_000, seq: 0, reset: true, liveSince: 1000, icebergs: [] })]);
    expect(() => icebergOrdersFrames(dxfeed, 20_000, list, { chunk: 0, liveSince: 1000 })).toThrow(/chunk/);
  });

  test("the frame is incremental for slow-client handling, like the L2 chains", () => {
    expect(frameKindOf(icebergOrdersFrame(dxfeed, { ts: 1, seq: 0, reset: true, liveSince: 1000, icebergs: [] }))).toBe(FRAME_KIND_INCREMENTAL);
  });
});
