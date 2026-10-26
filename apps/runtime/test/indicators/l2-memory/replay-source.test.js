const { createStorageDb } = require("../../../src/storage/storage-db");
const { createReplaySource, DEPTH_EVENTS_SQL, ANCHOR_SLACK_MS } = require("../../../src/indicators/l2-memory/replay-source");

const SYMBOL = "BTCUSDT";
const PERP = "PERPETUAL";
const SPOT = "SPOT";

function openFixtureDb() {
  const storageDb = createStorageDb({ dbPath: ":memory:" });
  const db = storageDb.raw;
  const insertSnapshot = db.prepare(
    "INSERT INTO l2_depth_snapshots (captured_at, symbol, market_kind, last_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT INTO l2_depth_events (ts, received_at, symbol, market_kind, first_update_id, last_update_id, previous_update_id, bids, asks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertTrade = db.prepare(
    "INSERT INTO trades (ts, symbol, market_kind, price, size, side, trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  return {
    db,
    snapshot: ({ capturedAt, marketKind = PERP, lastUpdateId, bids, asks }) =>
      insertSnapshot.run(capturedAt, SYMBOL, marketKind, lastUpdateId, JSON.stringify(bids), JSON.stringify(asks)),
    event: ({ ts, marketKind = PERP, U, u, pu = null, bids = [], asks = [] }) =>
      insertEvent.run(ts, ts + 5, SYMBOL, marketKind, U, u, pu, JSON.stringify(bids), JSON.stringify(asks)),
    trade: ({ ts, marketKind = PERP, price, size, side, id }) =>
      insertTrade.run(ts, SYMBOL, marketKind, price, size, side, id),
    close: () => storageDb.close(),
  };
}

function collect(source) {
  return [...source.frames()];
}

describe("replay-source", () => {
  test("rejects bad construction arguments", () => {
    const fixture = openFixtureDb();
    const base = { db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: 10 };
    expect(() => createReplaySource({ ...base, symbol: "DOGEUSDT" })).toThrow(/symbol/);
    expect(() => createReplaySource({ ...base, marketKind: "MARGIN" })).toThrow(/marketKind/);
    expect(() => createReplaySource({ ...base, toTs: -1 })).toThrow(/toTs/);
    expect(() => createReplaySource({ ...base, fromTs: 20 })).toThrow(/toTs must not be before/);
    expect(() => createReplaySource({ ...base, dbPath: "x.sqlite" })).toThrow(/exactly one/);
    expect(() => createReplaySource({ symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: 10 })).toThrow(/exactly one/);
    fixture.close();
  });

  test("yields nothing when the window has no snapshot to anchor on", () => {
    const fixture = openFixtureDb();
    fixture.event({ ts: 1_000, U: 1, u: 1, pu: 0, bids: [["100.0", "1.0"]] });
    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: 5_000 });
    expect(collect(source)).toEqual([]);
    expect(source.stats).toEqual({ snapshotsUsed: 0, eventsRead: 0, tradesRead: 0, booksEmitted: 0, gaps: 0 });
    fixture.close();
  });

  test("replays snapshot + diffs through the real assembler and interleaves trades in wire order (perpetual)", () => {
    const fixture = openFixtureDb();
    // Anchor snapshot at t=1000 with update id 100.
    fixture.snapshot({
      capturedAt: 1_000,
      lastUpdateId: 100,
      bids: [["99.0", "1.0"], ["98.0", "2.0"]],
      asks: [["101.0", "1.0"], ["102.0", "2.0"]],
    });
    // Perpetual bridging event: U <= 100 <= u.
    fixture.event({ ts: 1_100, U: 100, u: 101, pu: 99, bids: [["99.0", "1.5"]] });
    // Contiguous chain.
    fixture.event({ ts: 1_200, U: 102, u: 102, pu: 101, asks: [["101.0", "0.4"]] });
    fixture.event({ ts: 1_300, U: 103, u: 103, pu: 102, bids: [["98.0", "0"]] });
    // A trade at the ask between the two diffs, one exactly on a diff timestamp, one after the window.
    fixture.trade({ ts: 1_150, price: "101.0", size: "0.6", side: "buy", id: "t1" });
    fixture.trade({ ts: 1_300, price: "98.0", size: "2.0", side: "sell", id: "t2" });
    fixture.trade({ ts: 9_000, price: "98.0", size: "1.0", side: "sell", id: "t3" });

    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 1_000, toTs: 2_000 });
    const frames = collect(source);

    expect(frames.map((f) => [f.kind, f.ts])).toEqual([
      ["anchor", 1_000],
      ["book", 1_100],
      ["trade", 1_150],
      ["book", 1_200],
      ["trade", 1_300], // same ts as the next diff: the fill is seen before the size drop
      ["book", 1_300],
    ]);

    expect(frames[1]).toEqual({
      kind: "book",
      ts: 1_100,
      status: "READY",
      book: {
        bids: [["99.0", "1.5"], ["98.0", "2.0"]],
        asks: [["101.0", "1.0"], ["102.0", "2.0"]],
        lastUpdateId: 101,
      },
      delta: { bids: [["99.0", "1.5"]], asks: [] },
    });
    expect(frames[2]).toEqual({ kind: "trade", ts: 1_150, price: "101.0", size: "0.6", side: "buy", tradeId: "t1" });
    expect(frames[5].book).toEqual({
      bids: [["99.0", "1.5"]],
      asks: [["101.0", "0.4"], ["102.0", "2.0"]],
      lastUpdateId: 103,
    });
    expect(frames[5].delta).toEqual({ bids: [["98.0", "0"]], asks: [] });

    expect(source.stats).toEqual({ snapshotsUsed: 1, eventsRead: 3, tradesRead: 2, booksEmitted: 3, gaps: 0 });
    fixture.close();
  });

  test("uses an anchor captured before the window and only emits books from the window start (spot)", () => {
    const fixture = openFixtureDb();
    fixture.snapshot({ capturedAt: 500, marketKind: SPOT, lastUpdateId: 10, bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]] });
    fixture.event({ ts: 600, marketKind: SPOT, U: 11, u: 11, bids: [["99.0", "2.0"]] });
    fixture.event({ ts: 1_500, marketKind: SPOT, U: 12, u: 12, bids: [["99.0", "3.0"]] });
    fixture.trade({ ts: 700, marketKind: SPOT, price: "101.0", size: "0.1", side: "buy", id: "early" });

    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: SPOT, fromTs: 1_000, toTs: 2_000 });
    const frames = collect(source);

    // The pre-window diff was applied (book carries 2.0 then 3.0) but not
    // emitted. The pre-window trade is not read at all: nothing can attribute
    // it (the memory engine ignores trades until the first in-window book seeds
    // it, and the page worker drops trades before its page start), and reading
    // it from the anchor on every page made page cost grow with page number.
    expect(frames.map((f) => [f.kind, f.ts])).toEqual([
      ["anchor", 500],
      ["book", 1_500],
    ]);
    expect(frames[1].book.bids).toEqual([["99.0", "3.0"]]);
    expect(source.stats.eventsRead).toBe(2);
    expect(source.stats.tradesRead).toBe(0);
    expect(source.stats.booksEmitted).toBe(1);
    fixture.close();
  });

  // Property: the trade read starts at the window, not at the anchor, so a
  // page late in a long window does not re-read every trade since the
  // anchor. Oracle: tradesRead and the yielded trade timestamps, with the
  // anchor deliberately far before the window and many trades in between.
  test("trades are read from the window start, never from the anchor, however far back the anchor sits", () => {
    const fixture = openFixtureDb();
    fixture.snapshot({ capturedAt: 0, marketKind: SPOT, lastUpdateId: 10, bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]] });
    fixture.event({ ts: 100, marketKind: SPOT, U: 11, u: 11, bids: [["99.0", "2.0"]] });
    for (let ts = 10; ts < 100_000; ts += 10) fixture.trade({ ts, marketKind: SPOT, price: "100.0", size: "0.1", side: "buy", id: `pre-${ts}` });
    fixture.event({ ts: 100_500, marketKind: SPOT, U: 12, u: 12, bids: [["99.0", "3.0"]] });
    fixture.trade({ ts: 100_200, marketKind: SPOT, price: "100.0", size: "0.1", side: "sell", id: "in-window" });

    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: SPOT, fromTs: 100_000, toTs: 101_000 });
    const frames = collect(source);

    expect(frames.filter((f) => f.kind === "trade").map((f) => f.tradeId)).toEqual(["in-window"]);
    expect(source.stats.tradesRead).toBe(1);
    expect(frames.map((f) => [f.kind, f.ts])).toEqual([["anchor", 0], ["trade", 100_200], ["book", 100_500]]);
    fixture.close();
  });

  // Property: in sparse book mode the source itself carries the whole book only
  // on the first READY frame after each snapshot (initial anchor, re-anchor
  // after a gap, or after a non-READY frame it emitted) and just the best
  // prices after that, with every delta unchanged. Oracle: the same rows in
  // the default full mode, and the position of the anchors in the stream.
  test("sparse mode carries the whole book once per anchor and best prices after it, straight from the source", () => {
    const rows = (fixture) => {
      fixture.snapshot({ capturedAt: 1_000, lastUpdateId: 100, bids: [["99.0", "1.0"], ["98.0", "2.0"]], asks: [["101.0", "1.0"]] });
      fixture.event({ ts: 1_100, U: 100, u: 101, pu: 99, bids: [["99.0", "1.5"]] });
      fixture.event({ ts: 1_150, U: 102, u: 102, pu: 101, asks: [["101.0", "0.5"], ["102.0", "3.0"]] });
      fixture.event({ ts: 1_200, U: 110, u: 110, pu: 109, bids: [["99.0", "9.9"]] });
      fixture.snapshot({ capturedAt: 1_250, lastUpdateId: 120, bids: [["97.0", "4.0"]], asks: [["103.0", "4.0"]] });
      fixture.event({ ts: 1_300, U: 120, u: 121, pu: 119, asks: [["103.0", "3.0"]] });
      fixture.event({ ts: 1_350, U: 122, u: 122, pu: 121, bids: [["96.0", "1.0"]] });
    };
    const run = (bookMode) => {
      const fixture = openFixtureDb();
      rows(fixture);
      const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 1_000, toTs: 2_000, includeBuffering: true, bookMode });
      const frames = collect(source);
      fixture.close();
      return { frames, stats: { ...source.stats } };
    };
    const full = run("full");
    const sparse = run("sparse");
    expect(full.frames.map((f) => [f.kind, f.ts, f.status ?? f.lastUpdateId])).toEqual([
      ["anchor", 1_000, 100], ["book", 1_100, "READY"], ["book", 1_150, "READY"], ["book", 1_200, "UNAVAILABLE"],
      ["anchor", 1_250, 120], ["book", 1_300, "READY"], ["book", 1_350, "READY"],
    ]);
    expect(sparse.frames.map((f) => [f.kind, f.ts, f.status ?? f.lastUpdateId])).toEqual(full.frames.map((f) => [f.kind, f.ts, f.status ?? f.lastUpdateId]));
    expect(sparse.frames.map((f) => f.delta)).toEqual(full.frames.map((f) => f.delta));
    expect(sparse.stats).toEqual(full.stats);
    for (const f of full.frames) if (f.status === "READY") expect(Array.isArray(f.book.bids)).toBe(true);
    expect(sparse.frames[1].book).toEqual(full.frames[1].book);
    expect(sparse.frames[2].book).toEqual({ bestBid: "99", bestAsk: "101", lastUpdateId: 102 });
    expect(sparse.frames[5].book).toEqual(full.frames[5].book);
    expect(sparse.frames[6].book).toEqual({ bestBid: "97", bestAsk: "103", lastUpdateId: 122 });
    expect(() => createReplaySource({ db: openFixtureDb().db, symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: 1, bookMode: "tiny" })).toThrow(/bookMode must be one of full, sparse/);
  });

  test("sparse mode exposes a full internal book when the moving truncation window crosses a row boundary", () => {
    const fixture = openFixtureDb();
    fixture.snapshot({ capturedAt: 1_000, lastUpdateId: 100, bids: [["99", "1"], ["98", "2"]], asks: [["101", "1"], ["102", "2"]] });
    fixture.event({ ts: 1_100, U: 100, u: 101, pu: 99, bids: [["99", "1.5"]] });
    fixture.event({ ts: 1_200, U: 102, u: 102, pu: 101, bids: [["100", "1"]], asks: [["101", "0"]] });
    const source = createReplaySource({
      db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 1_000, toTs: 2_000,
      bookMode: "sparse", replayGeometry: { tickSize: 1, clusterTicks: 1, rowClusters: 1, windowRows: 1, windowBp: 1 },
    });
    const books = collect(source).filter((frame) => frame.kind === "book");
    expect(Array.isArray(books[0].book.bids)).toBe(true);
    // Mid moves from 100 to 101, shifting [99..101] to [100..102]. The full
    // state lets the downstream truncator introduce dormant ask 102 and evict 99.
    expect(Array.isArray(books[1].book.bids)).toBe(true);
    expect(books[1].book.asks).toEqual([["102", "2"]]);
    fixture.close();
  });

  test("falls back to the first snapshot inside the window when none precede it", () => {
    const fixture = openFixtureDb();
    fixture.snapshot({ capturedAt: 1_500, lastUpdateId: 50, bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]] });
    fixture.event({ ts: 1_600, U: 50, u: 51, pu: 49, asks: [["101.0", "0.5"]] });

    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 1_000, toTs: 2_000 });
    const frames = collect(source);
    expect(frames.map((f) => f.kind)).toEqual(["anchor", "book"]);
    expect(frames[0]).toEqual({ kind: "anchor", ts: 1_500, lastUpdateId: 50 });
    fixture.close();
  });

  test("re-anchors on the next stored snapshot after a sequence gap", () => {
    const fixture = openFixtureDb();
    fixture.snapshot({ capturedAt: 1_000, lastUpdateId: 100, bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]] });
    fixture.event({ ts: 1_100, U: 100, u: 101, pu: 99, bids: [["99.0", "1.5"]] });
    // Hole: pu should be 101.
    fixture.event({ ts: 1_200, U: 110, u: 110, pu: 109, bids: [["99.0", "9.9"]] });
    // Collector re-snapshotted after the gap.
    fixture.snapshot({ capturedAt: 1_250, lastUpdateId: 120, bids: [["97.0", "4.0"]], asks: [["103.0", "4.0"]] });
    fixture.event({ ts: 1_300, U: 120, u: 121, pu: 119, asks: [["103.0", "3.0"]] });

    const source = createReplaySource({
      db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 1_000, toTs: 2_000, includeBuffering: true,
    });
    const frames = collect(source);

    expect(frames.map((f) => [f.kind, f.ts, f.status ?? f.lastUpdateId])).toEqual([
      ["anchor", 1_000, 100],
      ["book", 1_100, "READY"],
      ["book", 1_200, "UNAVAILABLE"],
      ["anchor", 1_250, 120],
      ["book", 1_300, "READY"],
    ]);
    expect(frames[2].reason).toBe("SEQUENCE_GAP");
    expect(frames[4].book).toEqual({
      bids: [["97.0", "4.0"]],
      asks: [["103.0", "3.0"]],
      lastUpdateId: 121,
    });
    expect(source.stats).toMatchObject({ snapshotsUsed: 2, gaps: 1, booksEmitted: 2 });
    fixture.close();
  });

  test("stops at the window end even when the gap has no later snapshot", () => {
    const fixture = openFixtureDb();
    fixture.snapshot({ capturedAt: 1_000, lastUpdateId: 100, bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]] });
    fixture.event({ ts: 1_100, U: 100, u: 101, pu: 99, bids: [["99.0", "1.5"]] });
    fixture.event({ ts: 1_200, U: 110, u: 110, pu: 109, bids: [["99.0", "9.9"]] });
    fixture.trade({ ts: 1_900, price: "99.0", size: "0.2", side: "sell", id: "late" });

    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 1_000, toTs: 2_000 });
    const frames = collect(source);
    // Book frames stop at the gap; trailing trades up to toTs are still drained.
    expect(frames.map((f) => [f.kind, f.ts])).toEqual([
      ["anchor", 1_000],
      ["book", 1_100],
      ["trade", 1_900],
    ]);
    expect(source.stats).toMatchObject({ snapshotsUsed: 1, gaps: 1, tradesRead: 1 });
    fixture.close();
  });

  test("does not mix pairs: another market kind's rows are invisible", () => {
    const fixture = openFixtureDb();
    fixture.snapshot({ capturedAt: 1_000, marketKind: SPOT, lastUpdateId: 100, bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]] });
    fixture.event({ ts: 1_100, marketKind: SPOT, U: 101, u: 101, bids: [["99.0", "1.5"]] });
    fixture.trade({ ts: 1_100, marketKind: SPOT, price: "99.0", size: "0.1", side: "sell", id: "spot" });

    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 1_000, toTs: 2_000 });
    expect(collect(source)).toEqual([]);
    fixture.close();
  });

  test("reads depth events only from the anchor's capture time less the slack, in wire order", () => {
    const fixture = openFixtureDb();
    const capturedAt = 10 * 60_000;
    fixture.snapshot({ capturedAt, lastUpdateId: 10, bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]] });
    fixture.event({ ts: capturedAt - ANCHOR_SLACK_MS - 1, U: 12, u: 12, pu: 11, bids: [["99.0", "9.0"]] });
    fixture.event({ ts: capturedAt - ANCHOR_SLACK_MS, U: 10, u: 11, pu: 9, bids: [["99.0", "2.0"]] });

    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 0, toTs: capturedAt + 1_000 });
    const frames = collect(source);

    expect(frames.map((f) => f.kind)).toEqual(["anchor", "book"]);
    expect(frames[1].book.bids).toEqual([["99.0", "2.0"]]);
    expect(source.stats).toMatchObject({ eventsRead: 1, booksEmitted: 1, gaps: 0 });
    fixture.close();
  });

  test("a window with no recorded depth event yields nothing, without replaying the tape before it", () => {
    const fixture = openFixtureDb();
    fixture.snapshot({ capturedAt: 1_000, lastUpdateId: 10, bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]] });
    fixture.event({ ts: 1_100, U: 10, u: 11, pu: 9, bids: [["99.0", "2.0"]] });
    fixture.event({ ts: 1_200, U: 12, u: 12, pu: 11, bids: [["99.0", "3.0"]] });
    fixture.trade({ ts: 1_150, price: "101.0", size: "0.1", side: "buy", id: "old" });

    const source = createReplaySource({ db: fixture.db, symbol: SYMBOL, marketKind: PERP, fromTs: 5_000_000, toTs: 6_000_000 });
    expect(collect(source)).toEqual([]);
    expect(source.stats).toMatchObject({ snapshotsUsed: 0, eventsRead: 0, tradesRead: 0, booksEmitted: 0 });
    fixture.close();
  });

  test("the depth event read is bounded on both sides of the ts index", () => {
    const fixture = openFixtureDb();
    const plan = fixture.db.prepare(`EXPLAIN QUERY PLAN ${DEPTH_EVENTS_SQL}`).all(SYMBOL, PERP, 0, 1, 2).map((step) => step.detail);
    expect(plan).toContainEqual(expect.stringContaining("USING INDEX idx_l2_depth_events_symbol_market_ts (symbol=? AND market_kind=? AND ts>? AND ts<?)"));
    fixture.close();
  });
});
