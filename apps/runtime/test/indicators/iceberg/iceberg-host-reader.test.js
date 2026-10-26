const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../../helpers/temp-files");
const { openIcebergHostStore, MAX_PAGE } = require("../../../src/indicators/iceberg/iceberg-host-store");
const { createIcebergHostReader, MAX_PAGE_WATCHED_SPANS } = require("../../../src/indicators/iceberg/iceberg-host-reader");
const { MAX_ICEBERG_ID_LENGTH } = require("../../../src/server/iceberg-frames");
const { MAX_VALID_EPOCH_MS } = require("../../../src/server/wire-fields");
const { DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES_BY_ROUTE, validResponseShape } = require("../../../src/storage/remote-storage-reader");
const { MAX_UPSTREAM_RESPONSE_BYTES, MAX_UPSTREAM_RESPONSE_BYTES_BY_ROUTE } = require("../../../src/server/live-storage-relay");
const { createIcebergHistory } = require("../../../src/indicators/iceberg/iceberg-history");
const { createIcebergHostFill, DEFAULT_TAIL_MS } = require("../../../src/indicators/iceberg/iceberg-host-fill");

const T = 1_700_000_000_000;
const H = 3_600_000;
const NQ = ["dxfeed", "/NQZ26:XCME", "FUTURE"];

describe("indicators/iceberg/iceberg-host-reader", () => {
  let dir = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-host-reader-"));
  });

  afterEach(() => {
    safeRm(dir, { recursive: true, force: true });
  });

  function seed(gaps, settledThrough = T + 24 * H) {
    const store = openIcebergHostStore({ dir, pairKey: "dxfeed:FUTURE:/NQZ26:XCME" });
    store.checkpoint({ cursor: settledThrough + H, start: T, settledThrough, cuts: null, coverage: [[T, settledThrough + H]], gaps }, []);
    store.close();
  }

  test("every read behind a page happens inside one store snapshot: the checkpoint, the page, the generation, the rules version and the watched spans", () => {
    const calls = [];
    let inside = false;
    const fake = {
      readTransaction(fn) {
        inside = true;
        try {
          return fn();
        } finally {
          inside = false;
        }
      },
      checkpoint() { calls.push(["checkpoint", inside]); return { cursor: T + 2 * H, start: T, settledThrough: T + H }; },
      readPage() { calls.push(["readPage", inside]); return { icebergs: [], next: null }; },
      generation() { calls.push(["generation", inside]); return "g1"; },
      rulesVersion() { calls.push(["rulesVersion", inside]); return 1; },
      watched() { calls.push(["watched", inside]); return [[T, T + H]]; },
      close() {},
    };
    const reader = createIcebergHostReader({ dir, open: () => fake });
    expect(reader.readIcebergHistory(...NQ, { fromTs: T, toTs: T + H })).toMatchObject({ available: true, generation: "g1", watched: [[T, T + H]] });
    expect(calls).toEqual([["checkpoint", true], ["readPage", true], ["generation", true], ["rulesVersion", true], ["watched", true]]);
    reader.close();
  });

  test("a page carries only the watched spans inside the window it was asked for, up to the settled line", () => {
    seed([[T + H, T + H + 60_000, "NO_CAPTURE"], [T + 5 * H, T + 5 * H + 60_000, "BOOK_UNAVAILABLE"], [T + 9 * H, T + 9 * H + 60_000, "NO_CAPTURE"]], T + 10 * H);
    const reader = createIcebergHostReader({ dir });
    expect(reader.readIcebergHistory(...NQ, { fromTs: T + 4 * H, toTs: T + 6 * H }).watched).toEqual([[T + 4 * H, T + 5 * H], [T + 5 * H + 60_000, T + 6 * H]]);
    expect(reader.readIcebergHistory(...NQ, { fromTs: T + 8 * H, toTs: T + 12 * H }).watched).toEqual([[T + 8 * H, T + 9 * H], [T + 9 * H + 60_000, T + 10 * H]]);
    reader.close();
  });

  test("a page never carries more than MAX_PAGE_WATCHED_SPANS spans, the oldest first, so the fill asks for the rest again", () => {
    const gaps = [];
    for (let i = 0; i < MAX_PAGE_WATCHED_SPANS + 100; i += 1) gaps.push([T + i * 2_000 + 1_000, T + i * 2_000 + 1_500, "BOOK_UNAVAILABLE"]);
    seed(gaps);
    const reader = createIcebergHostReader({ dir });
    const { watched } = reader.readIcebergHistory(...NQ, { fromTs: T, toTs: T + 24 * H });
    expect(watched).toHaveLength(MAX_PAGE_WATCHED_SPANS);
    expect(watched[0]).toEqual([T, T + 1_000]);
    expect(watched[MAX_PAGE_WATCHED_SPANS - 1]).toEqual([T + (MAX_PAGE_WATCHED_SPANS - 2) * 2_000 + 1_500, T + (MAX_PAGE_WATCHED_SPANS - 1) * 2_000 + 1_000]);
    reader.close();
  });

  test("a window with more spans than one page carries is covered over the next fills, never claimed past what a page said", async () => {
    const gaps = [];
    for (let i = 0; i < MAX_PAGE_WATCHED_SPANS + 100; i += 1) gaps.push([T + i * 40_000 + 1_000, T + i * 40_000 + 1_500, "BOOK_UNAVAILABLE"]);
    const settledThrough = T + (MAX_PAGE_WATCHED_SPANS + 200) * 40_000;
    seed(gaps, settledThrough);
    const reader = createIcebergHostReader({ dir });
    const history = createIcebergHistory({ maxAgeMs: 30 * 24 * H });
    const now = settledThrough + DEFAULT_TAIL_MS + H;
    const fill = createIcebergHostFill({ read: async (...args) => reader.readIcebergHistory(...args), now: () => now, lookbackMs: 30 * 24 * H, log: () => {} });
    const target = { provider: "dxfeed", symbol: "/NQZ26:XCME", marketKind: "FUTURE", history };
    await fill.fill(target);
    const firstEnd = T + (MAX_PAGE_WATCHED_SPANS - 1) * 40_000 + 1_000;
    expect(history.coverage().at(-1)[1]).toBe(firstEnd);
    await fill.fill(target);
    expect(history.coverage().at(-1)[1]).toBe(settledThrough);
    expect(history.coverage().every(([from, to]) => to <= settledThrough && from >= T)).toBe(true);
    reader.close();
  });

  test("a page asked for at or after the settled line answers no watched spans, never a zero-length or inverted one, so the remote reader accepts it", () => {
    seed([], T + H);
    const reader = createIcebergHostReader({ dir });
    const later = reader.readIcebergHistory(...NQ, { fromTs: T + 90 * 60_000, toTs: T + 2 * H });
    expect(later).toMatchObject({ available: true, span: { from: T, to: T + H }, watched: [] });
    expect(validResponseShape("iceberg-history", later)).toBe(true);
    const atTheLine = reader.readIcebergHistory(...NQ, { fromTs: T + H, toTs: T + 2 * H });
    expect(atTheLine.watched).toEqual([]);
    expect(validResponseShape("iceberg-history", atTheLine)).toBe(true);
    expect(reader.readIcebergHistory(...NQ, { fromTs: T + 30 * 60_000, toTs: T + 2 * H }).watched).toEqual([[T + 30 * 60_000, T + H]]);
    reader.close();
  });

  test("the largest page the route can answer fits the remote reader's response cap for iceberg-history", () => {
    const cap = Math.min(MAX_RESPONSE_BYTES_BY_ROUTE["iceberg-history"] ?? DEFAULT_MAX_RESPONSE_BYTES, MAX_UPSTREAM_RESPONSE_BYTES_BY_ROUTE["iceberg-history"] ?? MAX_UPSTREAM_RESPONSE_BYTES);
    const id = "x".repeat(MAX_ICEBERG_ID_LENGTH);
    const iceberg = {
      id, kind: "probable", confidence: "probable", side: "bid", price: 9_999_999.999999998, display: 999_999_999_999.9999, tranches: Number.MAX_SAFE_INTEGER,
      executed: 999_999_999_999.9999, startedAt: MAX_VALID_EPOCH_MS, markedAt: MAX_VALID_EPOCH_MS, updatedAt: MAX_VALID_EPOCH_MS, status: "interrupted", origin: "runtime",
    };
    const page = {
      available: true,
      generation: "g".repeat(64),
      rulesVersion: Number.MAX_SAFE_INTEGER,
      span: { from: MAX_VALID_EPOCH_MS, to: MAX_VALID_EPOCH_MS },
      watched: Array.from({ length: MAX_PAGE_WATCHED_SPANS }, () => [MAX_VALID_EPOCH_MS, MAX_VALID_EPOCH_MS]),
      icebergs: Array.from({ length: MAX_PAGE }, () => iceberg),
      next: { markedAt: MAX_VALID_EPOCH_MS, id },
    };
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(cap);
  });
});
