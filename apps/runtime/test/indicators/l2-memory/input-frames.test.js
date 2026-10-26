"use strict";

const { bookFrame, tradeFrame, gapFrame, frameProblem, FRAME_KINDS, DEFAULT_GAP_CAUSE } = require("../../../src/indicators/l2-memory/input-frames");

const T = 1_780_000_000_000;

describe("input frames", () => {
  test("the three constructors build the frames the engine reads", () => {
    expect(bookFrame(T, "READY", { bids: [[99, 1]], asks: [[101, 2]] }, { bids: [[99, 1]], asks: [] })).toEqual({
      kind: "book", ts: T, status: "READY", book: { bids: [[99, 1]], asks: [[101, 2]] }, delta: { bids: [[99, 1]], asks: [] },
    });
    expect(tradeFrame(T, 100, 2, "buy", 7)).toEqual({ kind: "trade", ts: T, price: 100, size: 2, side: "buy", tradeId: 7 });
    expect(gapFrame()).toEqual({ kind: "gap", ts: null, cause: DEFAULT_GAP_CAUSE });
    expect(gapFrame("ANCHOR", T)).toEqual({ kind: "gap", ts: T, cause: "ANCHOR" });
    expect(FRAME_KINDS).toEqual(["book", "trade", "gap", "anchor"]);
  });

  test("well-formed frames of every kind pass, including ISO times, light books and the replay anchor", () => {
    const valid = [
      bookFrame(T, "READY", { bids: [["99.5", "3"]], asks: [["100.5", "1"]] }, null),
      bookFrame(new Date(T).toISOString(), "READY", { bestBid: "99.5", bestAsk: null }, { bids: [["99.5", "0"]], asks: [] }),
      bookFrame(T, "BUFFERING", undefined, { bids: [], asks: [] }),
      tradeFrame(T, "100.1", "0.5", "sell", "abc"),
      gapFrame("SEQUENCE_GAP"),
      { kind: "anchor", ts: T, lastUpdateId: 9 },
    ];
    for (const frame of valid) expect(frameProblem(frame)).toBeNull();
  });

  test("bounded book coverage validates the prices released and seeded", () => {
    const book = { bids: [[99, 1]], asks: [[101, 2]] };
    const delta = { bids: [], asks: [] };
    const coverage = { unobserved: { bids: [98], asks: [] }, preexisting: { bids: [], asks: [[102, 3]] } };
    expect(frameProblem(bookFrame(T, "READY", book, delta, coverage))).toBeNull();
    expect(frameProblem(bookFrame(T, "READY", book, null, coverage))).toMatch(/full book and delta/);
    expect(frameProblem(bookFrame(T, "BUFFERING", null, null, coverage))).toMatch(/READY book/);
    expect(frameProblem(bookFrame(T, "READY", book, delta, { ...coverage,
      unobserved: { bids: [0], asks: [] },
    }))).toMatch(/coverage/);
    expect(frameProblem(bookFrame(T, "READY", book, delta, { ...coverage,
      preexisting: { bids: [], asks: [[102, -1]] },
    }))).toMatch(/coverage/);
  });

  test("every malformed frame is named", () => {
    const cases = [
      [null, /object/],
      [{ kind: "depth", ts: T }, /unknown frame kind/],
      [{ kind: "gap", cause: "" }, /cause/],
      [{ kind: "gap", cause: "X", ts: "soon" }, /timestamp/],
      [{ kind: "anchor" }, /timestamp/],
      [tradeFrame(-1, 100, 1, "buy"), /timestamp/],
      [tradeFrame(T, 0, 1, "buy"), /price/],
      [tradeFrame(T, 100, 0, "buy"), /size/],
      [tradeFrame(T, 100, 1, "bid"), /aggressor/],
      [bookFrame(T, "", null, null), /status/],
      [bookFrame(T, "READY", null, null), /needs a book/],
      [bookFrame(T, "READY", { bids: [[99, 1]] }, null), /bids and asks/],
      [bookFrame(T, "READY", {}, null), /best prices/],
      [bookFrame(T, "READY", { bestBid: 99 }, { bids: [[99]], asks: [] }), /delta/],
      [tradeFrame(T, Infinity, 1, "buy"), /price/],
      [tradeFrame(T, 100, Infinity, "buy"), /size/],
      [bookFrame(T, "READY", { bids: [[99, -1]], asks: [] }, null), /bids and asks/],
      [bookFrame(T, "READY", { bestBid: Infinity, bestAsk: null }, null), /best prices/],
      [bookFrame(T, "READY", { bids: [[99, 1]], asks: [[101, 1]], bestBid: Infinity }, null), /best prices/],
      [bookFrame(T, "READY", { bestBid: 99, bestAsk: 101 }, { bids: [], asks: [[101, Infinity]] }), /delta/],
    ];
    for (const [frame, problem] of cases) expect(frameProblem(frame)).toMatch(problem);
  });
});
