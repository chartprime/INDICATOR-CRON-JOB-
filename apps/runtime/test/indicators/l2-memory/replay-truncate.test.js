"use strict";

const crypto = require("node:crypto");
const {
  rowClustersFor,
  windowRowsFor,
  MAX_WINDOW_ROWS,
} = require("../../../src/indicators/passive_liquidity/liquidity-geometry");
const {
  rowClustersFor: publisherRowClustersFor,
  windowRowsFor: publisherWindowRowsFor,
  MAX_WINDOW_ROWS: publisherMaxWindowRows,
} = require("../../../src/indicators/passive_liquidity/liquidity-publisher");
const {
  truncateReplayFrame,
  truncateReplayFrames,
  createReplayTruncator,
  windowForMid,
  boundedDelta,
} = require("../../../src/indicators/l2-memory/replay-truncate");

const OPTIONS = Object.freeze({
  tickSize: 1,
  clusterTicks: 1,
  rowBp: 10,
  windowBp: 20,
});

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bookFrame(overrides = {}) {
  return {
    kind: "book",
    ts: 1_000,
    status: "READY",
    book: {
      lastUpdateId: 50,
      bids: [["10000", "3"], ["9990", "2"], ["9900", "9"], ["9800", "1"]],
      asks: [["10010", "3"], ["10020", "2"], ["10100", "9"], ["10200", "1"]],
    },
    delta: {
      bids: [["10000", "3"], ["9900", "0"], ["9800", "1"]],
      asks: [["10010", "3"], ["10100", "0"], ["10200", "1"]],
    },
    ...overrides,
  };
}

describe("liquidity-geometry", () => {
  test("matches the live publisher's row and window formulas", () => {
    expect(rowClustersFor(80_000, 0.1, 0.5)).toBe(publisherRowClustersFor(80_000, 0.1, 0.5));
    expect(windowRowsFor(80_000, 4, 600)).toBe(publisherWindowRowsFor(80_000, 4, 600));
    expect(MAX_WINDOW_ROWS).toBe(publisherMaxWindowRows);
  });
});

describe("truncateReplayFrame", () => {
  test("orders string-form prices numerically when an entering level crosses a digit boundary", () => {
    expect(boundedDelta(
      { bids: [["1000", "1"]], asks: [["999", "1"]] },
      { bids: [["999", "2"]], asks: [["1000", "2"]] },
    )).toEqual({
      bids: [["1000", 0], ["999", "2"]],
      asks: [["999", 0], ["1000", "2"]],
    });
  });

  test("passes trade and anchor frames through", () => {
    const trade = { kind: "trade", ts: 1, price: "100", size: "1", side: "buy" };
    const anchor = { kind: "anchor", ts: 1, lastUpdateId: 9 };
    expect(truncateReplayFrame(trade, OPTIONS)).toBe(trade);
    expect(truncateReplayFrame(anchor, OPTIONS)).toBe(anchor);
  });

  test("clips book and delta to the same live window around mid", () => {
    const truncated = truncateReplayFrame(bookFrame(), OPTIONS);
    const geometry = windowForMid(10_005, OPTIONS);
    expect(geometry.windowRows).toBe(2);
    expect(truncated.book.bids.map((tuple) => tuple[0])).toEqual(["10000", "9990"]);
    expect(truncated.book.asks.map((tuple) => tuple[0])).toEqual(["10010", "10020"]);
    expect(truncated.delta.bids.map((tuple) => tuple[0])).toEqual(["10000"]);
    expect(truncated.delta.asks.map((tuple) => tuple[0])).toEqual(["10010"]);
  });

  test("uses explicit live geometry when an instrument fixes its row width", () => {
    const truncated = truncateReplayFrame(bookFrame(), {
      ...OPTIONS,
      rowBp: 0.1,
      rowClusters: 10,
      windowRows: 2,
    });
    expect(windowForMid(10_005, { ...OPTIONS, rowBp: 0.1, rowClusters: 10, windowRows: 2 }))
      .toMatchObject({ rowClusters: 10, windowRows: 2 });
    expect(truncated.book.bids.map((tuple) => tuple[0])).toEqual(["10000", "9990"]);
    expect(truncated.book.asks.map((tuple) => tuple[0])).toEqual(["10010", "10020"]);
  });

  test("keeps in-window deletes on the delta so the truncated book can still update", () => {
    const truncated = truncateReplayFrame(bookFrame({
      delta: { bids: [["9990", "0"], ["9800", "0"]], asks: [["10020", "0"], ["10200", "0"]] },
    }), OPTIONS);
    expect(truncated.delta.bids).toEqual([["9990", "0"]]);
    expect(truncated.delta.asks).toEqual([["10020", "0"]]);
  });

  test("compare fixture: identical truncation hashes, a broken remote is caught", () => {
    const local = bookFrame();
    const remote = structuredClone(local);
    const localClipped = truncateReplayFrames([local], OPTIONS);
    const remoteClipped = truncateReplayFrames([remote], OPTIONS);
    expect(digest(localClipped)).toBe(digest(remoteClipped));
    expect(digest(localClipped)).toBe(
      "148a2b82bcf23dc94ca2a58d925f0ecef0f841a33b447af5b6f13ae40de66391",
    );

    remoteClipped[0].book.bids = remoteClipped[0].book.bids.slice(1);
    expect(digest(remoteClipped)).not.toBe(digest(localClipped));
  });

  test("a lone non-READY frame with no fallback mid passes through unchanged", () => {
    const buffering = {
      kind: "book",
      ts: 2_000,
      status: "BUFFERING",
      delta: { bids: [["9990", "2"], ["9800", "1"]], asks: [["10020", "2"], ["10200", "1"]] },
    };
    expect(truncateReplayFrame(buffering, OPTIONS)).toBe(buffering);
  });

  test("a sequence carries the last READY mid forward, so a following non-READY frame's delta is still clipped", () => {
    const ready = bookFrame();
    const buffering = {
      kind: "book",
      ts: 2_000,
      status: "BUFFERING",
      delta: { bids: [["9990", "2"], ["9800", "1"]], asks: [["10020", "2"], ["10200", "1"]] },
    };
    const [truncatedReady, truncatedBuffering] = truncateReplayFrames([ready, buffering], OPTIONS);
    expect(truncatedReady.book.bids.map((tuple) => tuple[0])).toEqual(["10000", "9990"]);
    // Out-of-window levels (9800 bid, 10200 ask) dropped, using the mid the
    // prior READY frame established — not left full the way a lone call
    // (above) would leave it.
    expect(truncatedBuffering.delta.bids.map((tuple) => tuple[0])).toEqual(["9990"]);
    expect(truncatedBuffering.delta.asks.map((tuple) => tuple[0])).toEqual(["10020"]);
    expect(truncatedBuffering).not.toBe(buffering);
  });

  test("createReplayTruncator updates its carried mid from each READY frame, not just the first", () => {
    const truncator = createReplayTruncator(OPTIONS);
    truncator.truncate(bookFrame());
    const movedMarket = bookFrame({
      book: {
        lastUpdateId: 60,
        bids: [["20000", "3"], ["19980", "2"]],
        asks: [["20020", "3"], ["20040", "2"]],
      },
    });
    truncator.truncate(movedMarket);
    const buffering = {
      kind: "book",
      ts: 3_000,
      status: "UNAVAILABLE",
      delta: { bids: [["19980", "1"], ["9800", "1"]], asks: [["20040", "1"], ["10200", "1"]] },
    };
    const truncated = truncator.truncate(buffering);
    // Clipped around the SECOND (moved) mid, not the stale first one —
    // 9800/10200 (near the old ~10000 mid) are gone, 19980/20040 (near the
    // new ~20000 mid) survive.
    expect(truncated.delta.bids.map((tuple) => tuple[0])).toEqual(["19980"]);
    expect(truncated.delta.asks.map((tuple) => tuple[0])).toEqual(["20040"]);
  });

  test("a level that enters the moving window is sent even when the raw delta did not touch it", () => {
    const truncator = createReplayTruncator(OPTIONS);
    truncator.truncate(bookFrame());
    const moved = truncator.truncate(bookFrame({
      book: {
        lastUpdateId: 60,
        bids: [["9900", "2"], ["9800", "1"]],
        asks: [["9910", "3"], ["10000", "2"]],
      },
      // The underlying event touched only a level outside the new window. A
      // raw-delta filter would therefore omit the newly visible 9900/9910.
      delta: { bids: [["9800", "0"]], asks: [["10000", "2"]] },
    }));
    expect(moved.book.bids).toEqual([["9900", "2"]]);
    expect(moved.book.asks).toEqual([["9910", "3"]]);
    expect(moved.delta.bids).toContainEqual(["9900", "2"]);
    expect(moved.delta.asks).toContainEqual(["9910", "3"]);
  });
});

// Property: in sparse mode a READY frame carries the whole book exactly when
// the consumer must seed or resync from it (the first READY after an anchor
// or after a non-READY frame); every other READY frame carries only the best
// prices, and its delta is unchanged from full mode. Oracle: the same frames
// run through a full-mode truncator, and the memory engine's own contract
// for when it reads `book.bids` (seed/resync) versus `bestPrices(book)`.
describe("createReplayTruncator in sparse book mode", () => {
  const second = bookFrame({
    ts: 2_000,
    book: {
      lastUpdateId: 51,
      bids: [["10000", "4"], ["9990", "2"], ["9900", "9"]],
      asks: [["10010", "3"], ["10020", "1"], ["10100", "9"]],
    },
    delta: { bids: [["10000", "4"], ["9800", "0"]], asks: [["10020", "1"], ["10200", "0"]] },
  });
  const anchor = { kind: "anchor", ts: 2_500, lastUpdateId: 60 };
  const third = bookFrame({ ts: 3_000, book: { ...bookFrame().book, lastUpdateId: 61 } });
  const fourth = bookFrame({ ts: 4_000, book: { ...second.book, lastUpdateId: 62 }, delta: second.delta });

  function run(bookMode) {
    const truncator = createReplayTruncator({ ...OPTIONS, bookMode });
    return [bookFrame(), second, anchor, third, fourth].map((frame) => truncator.truncate(frame));
  }

  test("rejects an unknown book mode", () => {
    expect(() => createReplayTruncator({ ...OPTIONS, bookMode: "tiny" })).toThrow(/bookMode must be one of full, sparse/);
  });

  test("the default is full mode and is byte-identical to before the mode existed", () => {
    expect(digest(run("full"))).toBe(digest(run(undefined)));
    for (const frame of run("full")) if (frame.kind === "book") expect(Array.isArray(frame.book.bids)).toBe(true);
  });

  test("the first READY after each anchor keeps the whole book; the ones after it keep only the best prices", () => {
    const [first, then, , afterAnchor, later] = run("sparse");
    expect(Array.isArray(first.book.bids)).toBe(true);
    expect(then.book).toEqual({ lastUpdateId: 51, bestBid: "10000", bestAsk: "10010" });
    expect(then.book.bids).toBeUndefined();
    expect(Array.isArray(afterAnchor.book.bids)).toBe(true);
    expect(later.book).toEqual({ lastUpdateId: 62, bestBid: "10000", bestAsk: "10010" });
  });

  test("sparse mode changes nothing but the book field: ts, status, kind and every delta match full mode", () => {
    const full = run("full");
    const sparse = run("sparse");
    const withoutBook = (frame) => Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "book"));
    expect(sparse.map(withoutBook)).toEqual(full.map(withoutBook));
    expect(sparse.map((frame) => frame.delta)).toEqual(full.map((frame) => frame.delta));
  });

  test("a non-READY frame in between forces the whole book on the next READY frame", () => {
    const truncator = createReplayTruncator({ ...OPTIONS, bookMode: "sparse" });
    truncator.truncate(bookFrame());
    expect(truncator.truncate(second).book.bids).toBeUndefined();
    truncator.truncate({ kind: "book", ts: 2_200, status: "UNAVAILABLE", delta: { bids: [], asks: [] } });
    expect(Array.isArray(truncator.truncate(third).book.bids)).toBe(true);
    expect(truncator.truncate(fourth).book.bids).toBeUndefined();
  });

  test("an empty side yields a null best price rather than a crash", () => {
    const truncator = createReplayTruncator({ ...OPTIONS, bookMode: "sparse" });
    truncator.truncate(bookFrame());
    const oneSided = truncator.truncate(bookFrame({ ts: 2_000, book: { lastUpdateId: 51, bids: [["10000", "1"]], asks: [] } }));
    expect(oneSided.book).toEqual({ lastUpdateId: 51, bestBid: "10000", bestAsk: null });
  });

  test("the sparse frames are a small fraction of the full ones", () => {
    const fullBytes = JSON.stringify(run("full")).length;
    const sparseBytes = JSON.stringify(run("sparse")).length;
    expect(sparseBytes).toBeLessThan(fullBytes);
  });
});
