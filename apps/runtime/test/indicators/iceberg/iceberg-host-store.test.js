const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openIcebergHostStore, pairFilePath, ICEBERG_RULES_VERSION, DEFAULT_PAGE, MAX_PAGE } = require("../../../src/indicators/iceberg/iceberg-host-store");

function settled(id, markedAt, overrides = {}) {
  return {
    id, kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32,
    startedAt: markedAt - 500, markedAt, updatedAt: markedAt + 1000, status: "filled", ...overrides,
  };
}

describe("indicators/iceberg/iceberg-host-store", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-host-store-"));
  });

  test("one file per pair with unsafe characters replaced, a fresh generation, the rules version, and nothing held; a read-only open of a missing pair is null", () => {
    expect(pairFilePath(dir, "dxfeed:FUTURE:/NQZ26:XCME")).toBe(path.join(dir, "dxfeed_FUTURE__NQZ26_XCME.sqlite"));
    expect(openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT", readonly: true })).toBeNull();
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    expect(fs.existsSync(pairFilePath(dir, "binance:PERPETUAL:BTCUSDT"))).toBe(true);
    expect(typeof store.generation()).toBe("string");
    expect(store.generation()).toHaveLength(16);
    expect(store.rulesVersion()).toBe(ICEBERG_RULES_VERSION);
    expect(store.checkpoint()).toEqual({ cursor: null, start: null, settledThrough: null, cuts: null, coverage: [], gaps: [] });
    expect(store.stats()).toEqual({ icebergs: 0, gaps: 0, cursor: null, settledThrough: null });
    store.close();
    expect(() => openIcebergHostStore({ dir, pairKey: "bad key with spaces" })).toThrow(/pairKey/);
  });

  test("settled icebergs upsert by id with the newest updatedAt winning; active or malformed ones are refused loudly", () => {
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    expect(store.putSettled([settled("a", 1000), settled("b", 2000)])).toEqual({ added: 2, updated: 0, ignored: 0 });
    expect(store.putSettled([settled("a", 1000, { executed: 40, updatedAt: 5000 }), settled("b", 2000, { executed: 1, updatedAt: 2500 })])).toEqual({ added: 0, updated: 1, ignored: 1 });
    expect(store.readPage({ fromTs: 0, toTs: 10_000 }).icebergs.map((entry) => [entry.id, entry.executed])).toEqual([["a", 40], ["b", 32]]);
    expect(() => store.putSettled([settled("c", 3000, { status: "active" })])).toThrow(/settled/);
    expect(() => store.putSettled([{ ...settled("d", 4000), kind: "synthetic" }])).toThrow(/wire/);
    expect(store.stats().icebergs).toBe(2);
    store.close();
  });

  test("a page is the icebergs marked inside the window in mark order, bounded, with a cursor to the rest", () => {
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/NQZ26:XCME" });
    store.putSettled([settled("c", 3000), settled("a", 1000), settled("b", 1000), settled("d", 4000)]);
    expect(DEFAULT_PAGE).toBe(500);
    expect(MAX_PAGE).toBe(2000);
    const first = store.readPage({ fromTs: 1000, toTs: 4000, limit: 2 });
    expect(first.icebergs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(first.next).toEqual({ markedAt: 1000, id: "b" });
    const second = store.readPage({ fromTs: 1000, toTs: 4000, limit: 2, after: first.next });
    expect(second).toEqual({ icebergs: [expect.objectContaining({ id: "c" })], next: null });
    expect(store.readPage({ fromTs: 0, toTs: 1000 })).toEqual({ icebergs: [], next: null });
    expect(() => store.readPage({ fromTs: 0, toTs: 1000, limit: MAX_PAGE + 1 })).toThrow(/limit/);
    expect(() => store.readPage({ fromTs: 5, toTs: 1 })).toThrow(/window/);
    store.close();
  });

  test("a checkpoint stores the cursor, the cuts, the coverage and the gaps atomically with the icebergs, and comes back after a reopen", () => {
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.checkpoint({ cursor: 9000, start: 1000, settledThrough: 8000, cuts: { version: 1, touch: [1], durations: [2], ratios: [3] }, coverage: [[1000, 8000]], gaps: [[4000, 4500, "NO_CAPTURE"]] }, [settled("a", 2000)]);
    store.close();
    const again = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT", readonly: true });
    expect(again.checkpoint()).toEqual({ cursor: 9000, start: 1000, settledThrough: 8000, cuts: { version: 1, touch: [1], durations: [2], ratios: [3] }, coverage: [[1000, 8000]], gaps: [[4000, 4500, "NO_CAPTURE"]] });
    expect(again.readPage({ fromTs: 0, toTs: 10_000 }).icebergs.map((entry) => entry.id)).toEqual(["a"]);
    expect(again.watched()).toEqual([[1000, 4000], [4500, 8000]]);
    expect(() => again.putSettled([settled("b", 3000)])).toThrow(/read-only/);
    again.close();
  });

  test("a read snapshot holds the builder's commit off until it ends, so every read inside it sees one state of the store", () => {
    const writer = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT", busyTimeoutMs: 0 });
    writer.checkpoint({ cursor: 9000, start: 1000, settledThrough: 8000, cuts: null, coverage: [[1000, 8000]], gaps: [] }, [settled("a", 2000)]);
    const reader = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT", readonly: true });
    const next = { cursor: 12_000, start: 1000, settledThrough: 11_000, cuts: null, coverage: [[1000, 11_000]], gaps: [] };
    const seen = reader.readTransaction(() => {
      const first = reader.checkpoint();
      expect(() => writer.checkpoint(next, [settled("b", 9500)])).toThrow(/locked|busy/i);
      return { first, page: reader.readPage({ fromTs: 0, toTs: 20_000 }).icebergs.map((entry) => entry.id), last: reader.checkpoint() };
    });
    expect(seen).toEqual({ first: expect.objectContaining({ settledThrough: 8000 }), page: ["a"], last: expect.objectContaining({ settledThrough: 8000 }) });
    writer.checkpoint(next, [settled("b", 9500)]);
    expect(reader.checkpoint().settledThrough).toBe(11_000);
    expect(reader.readTransaction(() => reader.readPage({ fromTs: 0, toTs: 20_000 }).icebergs.map((entry) => entry.id))).toEqual(["a", "b"]);
    reader.close();
    writer.close();
  });

  test("prune drops icebergs marked before the cut and clips the coverage and the gaps, keeping the cursor", () => {
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.checkpoint({ cursor: 9000, start: 0, settledThrough: 8000, cuts: null, coverage: [[0, 8000]], gaps: [[100, 200, "NO_CAPTURE"], [4000, 4500, "BOOK_UNAVAILABLE"]] }, [settled("a", 1000), settled("b", 5000)]);
    expect(store.prune(3000)).toBe(1);
    expect(store.readPage({ fromTs: 0, toTs: 10_000 }).icebergs.map((entry) => entry.id)).toEqual(["b"]);
    expect(store.checkpoint()).toMatchObject({ cursor: 9000, start: 3000, coverage: [[3000, 8000]], gaps: [[4000, 4500, "BOOK_UNAVAILABLE"]] });
    expect(store.stats()).toEqual({ icebergs: 1, gaps: 1, cursor: 9000, settledThrough: 8000 });
    store.close();
  });

  test("a store written under other rules is emptied on open and starts a new generation", () => {
    const store = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT" });
    store.checkpoint({ cursor: 9000, start: 0, settledThrough: 8000, cuts: null, coverage: [[0, 8000]], gaps: [] }, [settled("a", 1000)]);
    const generation = store.generation();
    store.close();
    const other = openIcebergHostStore({ dir, pairKey: "binance:PERPETUAL:BTCUSDT", rulesVersion: ICEBERG_RULES_VERSION + 1 });
    expect(other.rulesVersion()).toBe(ICEBERG_RULES_VERSION + 1);
    expect(other.generation()).not.toBe(generation);
    expect(other.checkpoint()).toEqual({ cursor: null, start: null, settledThrough: null, cuts: null, coverage: [], gaps: [] });
    expect(other.stats().icebergs).toBe(0);
    other.close();
  });
});
