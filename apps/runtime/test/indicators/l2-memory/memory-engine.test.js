const { createMemoryEngine } = require("../../../src/indicators/l2-memory/memory-engine");
const { binanceDepthFrame, binanceTradeFrame } = require("../../../src/indicators/l2-memory/live-binding");

const T0 = 1_700_000_000_000;

function feedDepth(engine, envelope, state) {
  engine.apply(binanceDepthFrame(envelope, state));
}

function feedTrade(engine, envelope) {
  const frame = binanceTradeFrame(envelope);
  if (frame) engine.apply(frame);
}
const iso = (ms) => new Date(ms).toISOString();

function readyState(bids, asks, lastUpdateId = 1) {
  return { status: "READY", book: { bids, asks, lastUpdateId } };
}

function depthEnvelope({ ts, bids = [], asks = [], state } = {}) {
  return {
    eventType: "DEPTH",
    eventTime: iso(ts),
    ...(state ? { state } : {}),
    payload: { firstUpdateId: 1, lastUpdateId: 2, previousUpdateId: 0, bids, asks },
  };
}

function tradeEnvelope({ ts, price, quantity, isBuyerMaker, state } = {}) {
  return {
    eventType: "TRADE",
    eventTime: iso(ts),
    ...(state ? { state } : {}),
    payload: { tradeId: 1, price, quantity, isBuyerMaker },
  };
}

describe("memory-engine liteSnapshot", () => {
  test("exposes geometry and the cheap per-level read", () => {
    const engine = createMemoryEngine({ tickSize: 0.1, clusterTicks: 5, snapshotDepth: 1000 });
    expect(engine.tickSize).toBe(0.1);
    expect(engine.clusterTicks).toBe(5);
    expect(engine.snapshotDepth).toBe(1000);
    engine.apply({ kind: "book", ts: 1_700_000_000_000, status: "READY", book: { bids: [[100, 2]], asks: [[100.5, 3]], lastUpdateId: 1 }, delta: { bids: [], asks: [] } });
    const lite = engine.liteSnapshot();
    expect(lite.seeded).toBe(true);
    expect(lite.clusterWidth).toBeCloseTo(0.5);
    expect(lite.bids).toEqual([{ key: 200, size: 2, traded: 0, cancelled: 0, absorbed: 0 }]);
    expect(lite.asks).toEqual([{ key: 201, size: 3, traded: 0, cancelled: 0, absorbed: 0 }]);
    expect(lite.bestBidKey).toBe(200);
    expect(lite.priceFor(200)).toBeCloseTo(100);
  });
});

describe("memory-engine", () => {
  test("validates construction", () => {
    expect(() => createMemoryEngine({})).toThrow(/tickSize/);
    expect(() => createMemoryEngine({ tickSize: 0.1, clusterTicks: 0 })).toThrow(/clusterTicks/);
  });

  test("keyFor is exact on float-noisy prices and priceFor inverts it", () => {
    const perPrice = createMemoryEngine({ tickSize: 0.1 });
    expect(perPrice.keyFor(77225.1)).toBe(772251);
    expect(perPrice.keyFor(77225.0)).toBe(772250);
    expect(perPrice.priceFor(772251)).toBeCloseTo(77225.1, 6);

    const bands = createMemoryEngine({ tickSize: 0.1, clusterTicks: 50 }); // 5-dollar bands
    expect(bands.keyFor(77225.0)).toBe(15445);
    expect(bands.keyFor(77229.9)).toBe(15445);
    expect(bands.keyFor(77230.0)).toBe(15446);
    expect(bands.priceFor(15445)).toBeCloseTo(77225, 6);
  });

  test("ignores trades until a READY book has seeded the ledger", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    feedTrade(engine, tradeEnvelope({ ts: T0, price: "99.0", quantity: "1", isBuyerMaker: true }));
    expect(engine.seeded).toBe(false);
    expect(engine.stats).toMatchObject({ trades: 0, seeds: 0 });
  });

  test("seeds on the first READY book, then applies deltas and quotes", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    const book = readyState([["99.0", "5.0"]], [["101.0", "2.0"]]);
    feedDepth(engine, depthEnvelope({ ts: T0 }), book);
    expect(engine.seeded).toBe(true);
    expect(engine.stats).toMatchObject({ seeds: 1, deltas: 0 });

    // A sell hits the bid, then the diff shows it: attributed as a fill.
    feedTrade(engine, tradeEnvelope({ ts: T0 + 50, price: "99.0", quantity: "1.0", isBuyerMaker: true }));
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 100, bids: [["99.0", "4.0"]] }),
      readyState([["99.0", "4.0"]], [["101.0", "2.0"]], 3),
    );
    const snap = engine.snapshot();
    const bid = snap.bids.find((l) => l.key === 990);
    expect(bid).toMatchObject({ size: 4, seeded: true, traded: 1, tradedVisible: 1, cancelled: 0, tests: 1 });
    expect(snap).toMatchObject({ bestBidKey: 990, bestAskKey: 1010, seeded: true });
    expect(engine.stats).toMatchObject({ seeds: 1, deltas: 1, trades: 1, lateEvents: 0 });
  });

  test("buyer-maker flag maps to aggressor side correctly", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    feedDepth(engine, depthEnvelope({ ts: T0 }), readyState([["99.0", "5.0"]], [["101.0", "5.0"]]));
    feedTrade(engine, tradeEnvelope({ ts: T0 + 10, price: "99.0", quantity: "1", isBuyerMaker: true })); // seller aggressed
    feedTrade(engine, tradeEnvelope({ ts: T0 + 20, price: "101.0", quantity: "2", isBuyerMaker: false })); // buyer aggressed
    const snap = engine.snapshot();
    expect(snap.bids.find((l) => l.key === 990).traded).toBe(1);
    expect(snap.asks.find((l) => l.key === 1010).traded).toBe(2);
  });

  test("a late-delivered trade is clamped to the clock and counted, never thrown", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    feedDepth(engine, depthEnvelope({ ts: T0 }), readyState([["99.0", "5.0"]], [["101.0", "2.0"]]));
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 200, bids: [["99.0", "4.0"]] }),
      readyState([["99.0", "4.0"]], [["101.0", "2.0"]]),
    );
    // Trade whose exchange time predates the diff above arrives now.
    feedTrade(engine, tradeEnvelope({ ts: T0 + 150, price: "99.0", quantity: "1", isBuyerMaker: true }));
    expect(engine.stats.lateEvents).toBe(1);
    // It nets against the next diff instead.
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 300, bids: [["99.0", "3.0"]] }),
      readyState([["99.0", "3.0"]], [["101.0", "2.0"]]),
    );
    const bid = engine.snapshot().bids.find((l) => l.key === 990);
    expect(bid).toMatchObject({ cancelled: 1, tradedVisible: 1, traded: 1 });
  });

  test("an UNAVAILABLE stretch keeps the ledger; the next READY book is reconciled against it", () => {
    // The snapshot covers 3 levels per side.
    const engine = createMemoryEngine({ tickSize: 0.1, snapshotDepth: 3 });
    feedDepth(engine, depthEnvelope({ ts: T0 }), readyState([["99.0", "5.0"], ["97.0", "1.0"]], [["101.0", "2.0"]]));
    // A genuinely new level inside coverage, and a far wall beyond it (pre-existing).
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 100, bids: [["98.0", "1.0"], ["50.0", "10.0"]] }),
      readyState([["99.0", "5.0"], ["98.0", "1.0"], ["97.0", "1.0"], ["50.0", "10.0"]], [["101.0", "2.0"]]),
    );
    expect(engine.snapshot().bids.find((l) => l.key === 980)).toMatchObject({ seeded: false, added: 1 });
    // Absorption at 99.0 before the gap, still pending against the next diff.
    feedTrade(engine, tradeEnvelope({ ts: T0 + 150, price: "99.0", quantity: "0.5", isBuyerMaker: true }));

    feedDepth(engine, depthEnvelope({ ts: T0 + 200 }), { status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    expect(engine.seeded).toBe(true);
    expect(engine.live).toBe(false);
    expect(engine.snapshot().live).toBe(false);
    expect(engine.stats.unavailable).toBe(1);
    // Trades during the gap still land on their levels.
    feedTrade(engine, tradeEnvelope({ ts: T0 + 1_000, price: "99.0", quantity: "1.5", isBuyerMaker: true }));
    expect(engine.stats.trades).toBe(2);

    // The fresh book: 99.0 shrank by exactly what traded, 98.0 is gone with nothing
    // traded, 97.0 is unchanged, 98.5 is new inside coverage, 60.0 is an unknown wall
    // beyond coverage, and the known wall at 50.0 is beyond coverage too (not shown).
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 5_000 }),
      readyState([["99.0", "3.0"], ["98.5", "4.0"], ["97.0", "1.0"], ["60.0", "100.0"]], [["101.0", "2.0"]]),
    );
    expect(engine.live).toBe(true);
    expect(engine.stats).toMatchObject({ seeds: 1, resyncs: 1, unavailable: 1, deltas: 1 });
    const byKey = (key) => engine.snapshot().bids.find((l) => l.key === key);
    expect(byKey(990)).toMatchObject({ size: 3, seeded: true, traded: 2, tradedVisible: 2, cancelled: 0, hiddenTraded: 0 });
    expect(byKey(980)).toMatchObject({ size: 0, added: 1, endedBy: null }); // verdict pending through the grace
    expect(byKey(970)).toMatchObject({ size: 1, seeded: true, cancelled: 0, added: 0 });
    expect(byKey(985)).toMatchObject({ size: 4, seeded: false, added: 4 });
    expect(byKey(600)).toMatchObject({ size: 100, seeded: true, added: 0 });
    expect(byKey(500)).toMatchObject({ size: 10, seeded: true, cancelled: 0 });
    engine.prune(T0 + 10_000);
    expect(byKey(980)).toMatchObject({ endedBy: "pulled" });
  });

  test("a full-depth book's resync zeroes every level it no longer shows; a top-N book leaves what lies beyond its edge", () => {
    const run = (fullDepth) => {
      const engine = createMemoryEngine({ tickSize: 0.1, fullDepth });
      feedDepth(engine, depthEnvelope({ ts: T0 }), readyState([["99.0", "1.0"], ["97.0", "2.0"]], [["101.0", "1.0"]]));
      feedDepth(engine, depthEnvelope({ ts: T0 + 100 }), { status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
      // The fresh book shows one bid at 98 and nothing at 99 or 97.
      feedDepth(engine, depthEnvelope({ ts: T0 + 200 }), readyState([["98.0", "3.0"]], [["101.0", "1.0"]]));
      const size = (key) => engine.snapshot().bids.find((level) => level.key === key)?.size ?? null;
      return { at99: size(990), at98: size(980), at97: size(970) };
    };
    // Full depth: 99 (inside the range) and 97 (below the new edge) are both gone.
    expect(run(true)).toEqual({ at99: 0, at98: 3, at97: 0 });
    // Top-N: 99 is inside the shown range and zeroed; 97 lies beyond the edge and is left as it was.
    expect(run(false)).toEqual({ at99: 0, at98: 3, at97: 2 });
    expect(() => createMemoryEngine({ tickSize: 0.1, fullDepth: "yes" })).toThrow(/fullDepth/);
  });

  test("hidden volume and refills survive a gap", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    feedDepth(engine, depthEnvelope({ ts: T0 }), readyState([["99.0", "1.0"]], [["101.0", "1.0"]]));
    // 3.0 trades at 99.0 while the level only shrinks by 0.5: 2.5 hidden.
    feedTrade(engine, tradeEnvelope({ ts: T0 + 50, price: "99.0", quantity: "3.0", isBuyerMaker: true }));
    feedDepth(engine, depthEnvelope({ ts: T0 + 100, bids: [["99.0", "0.5"]] }), readyState([["99.0", "0.5"]], [["101.0", "1.0"]]));
    expect(engine.snapshot().bids[0]).toMatchObject({ hiddenTraded: 2.5, hiddenWindows: 1 });

    feedDepth(engine, depthEnvelope({ ts: T0 + 200 }), { status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    feedDepth(engine, depthEnvelope({ ts: T0 + 3_000 }), readyState([["99.0", "0.5"]], [["101.0", "1.0"]]));
    expect(engine.snapshot().bids[0]).toMatchObject({ size: 0.5, hiddenTraded: 2.5, hiddenWindows: 1, refills: 0 });

    // Gone in one gap, back in the next: that is a refill, and the emptying is decided on the evidence.
    feedDepth(engine, depthEnvelope({ ts: T0 + 3_100 }), { status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    feedDepth(engine, depthEnvelope({ ts: T0 + 6_000 }), readyState([], [["101.0", "1.0"]]));
    expect(engine.snapshot().bids[0]).toMatchObject({ size: 0, endedBy: null });
    feedDepth(engine, depthEnvelope({ ts: T0 + 6_100 }), { status: "UNAVAILABLE", reason: "SEQUENCE_GAP" });
    feedDepth(engine, depthEnvelope({ ts: T0 + 9_000 }), readyState([["99.0", "2.0"]], [["101.0", "1.0"]]));
    expect(engine.snapshot().bids[0]).toMatchObject({ size: 2, refills: 1, endedBy: "pulled", hiddenTraded: 2.5 });
    expect(engine.stats).toMatchObject({ seeds: 1, resyncs: 3, unavailable: 3 });
  });

  test("a degraded envelope or missing state marks the book unavailable", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    feedDepth(engine, depthEnvelope({ ts: T0 }), readyState([["99.0", "5.0"]], [["101.0", "2.0"]]));
    feedDepth(engine, depthEnvelope({ ts: T0 + 100, state: "UNAVAILABLE" }), readyState([], []));
    expect(engine.live).toBe(false);
    feedDepth(engine, depthEnvelope({ ts: T0 + 200 }), readyState([["99.0", "5.0"]], [["101.0", "2.0"]]));
    expect(engine.live).toBe(true);
    feedDepth(engine, depthEnvelope({ ts: T0 + 300 }), undefined);
    expect(engine.live).toBe(false);
    feedTrade(engine, tradeEnvelope({ ts: T0 + 400, price: "99.0", quantity: "1", isBuyerMaker: true, state: "UNAVAILABLE" }));
    expect(engine.stats.trades).toBe(0);
  });

  test("consumes replay-source frames: anchor resets, book seeds and updates, trades attribute", () => {
    const engine = createMemoryEngine({ tickSize: 0.1, clusterTicks: 10 }); // 1-dollar bands
    const frames = [
      { kind: "anchor", ts: T0, lastUpdateId: 100 },
      { kind: "book", ts: T0 + 100, status: "READY", book: { bids: [["99.0", "5.0"]], asks: [["101.0", "2.0"]], lastUpdateId: 101 }, delta: { bids: [], asks: [] } },
      { kind: "trade", ts: T0 + 150, price: "101.0", size: "0.5", side: "buy", tradeId: "t1" },
      { kind: "book", ts: T0 + 200, status: "READY", book: { bids: [["99.0", "5.0"]], asks: [["101.0", "1.5"]], lastUpdateId: 102 }, delta: { bids: [], asks: [["101.0", "1.5"]] } },
      { kind: "anchor", ts: T0 + 300, lastUpdateId: 200 },
      { kind: "book", ts: T0 + 400, status: "READY", book: { bids: [["97.0", "1.0"]], asks: [["103.0", "1.0"]], lastUpdateId: 201 }, delta: { bids: [], asks: [] } },
    ];
    for (const frame of frames) engine.apply(frame);

    expect(engine.stats).toMatchObject({ seeds: 1, resyncs: 1, deltas: 1, trades: 1, unavailable: 1 });
    const snap = engine.snapshot();
    // The old levels are kept as emptied records; the new book's levels are live.
    const liveKeys = (levels) => levels.filter((l) => l.size > 0).map((l) => l.key);
    expect(liveKeys(snap.bids)).toEqual([97]);
    expect(liveKeys(snap.asks)).toEqual([103]);
    expect(snap.bids.find((l) => l.key === 99)).toMatchObject({ size: 0 });
    expect(() => engine.apply({ kind: "weird" })).toThrow(/unknown input frame kind/);
  });

  test("replay frames with a non-READY book mark the engine unavailable", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    engine.apply({ kind: "book", ts: T0, status: "READY", book: { bids: [["99.0", "1.0"]], asks: [], lastUpdateId: 1 } });
    engine.apply({ kind: "book", ts: T0 + 100, status: "UNAVAILABLE", reason: "SEQUENCE_GAP", delta: { bids: [], asks: [] } });
    expect(engine.seeded).toBe(true);
    expect(engine.live).toBe(false);
  });

  // Property: a sparse replay stream (whole book only where the engine must
  // seed or resync, best prices elsewhere) leaves the engine in exactly the
  // state the full stream does. Oracle: the same frames with every book left
  // whole, compared snapshot for snapshot and stat for stat.
  test("a sparse replay stream ends in the same state as the full one", () => {
    const full = [
      { kind: "anchor", ts: T0, lastUpdateId: 100 },
      { kind: "book", ts: T0 + 100, status: "READY", book: { bids: [["99.0", "5.0"]], asks: [["101.0", "2.0"]], lastUpdateId: 101 }, delta: { bids: [], asks: [] } },
      { kind: "trade", ts: T0 + 150, price: "101.0", size: "0.5", side: "buy", tradeId: "t1" },
      { kind: "book", ts: T0 + 200, status: "READY", book: { bids: [["99.0", "5.0"]], asks: [["101.0", "1.5"]], lastUpdateId: 102 }, delta: { bids: [], asks: [["101.0", "1.5"]] } },
      { kind: "book", ts: T0 + 250, status: "READY", book: { bids: [["99.0", "5.0"], ["98.0", "1.0"]], asks: [["101.0", "1.5"]], lastUpdateId: 103 }, delta: { bids: [["98.0", "1.0"]], asks: [] } },
      { kind: "anchor", ts: T0 + 300, lastUpdateId: 200 },
      { kind: "book", ts: T0 + 400, status: "READY", book: { bids: [["97.0", "1.0"]], asks: [["103.0", "1.0"]], lastUpdateId: 201 }, delta: { bids: [], asks: [] } },
      { kind: "book", ts: T0 + 500, status: "READY", book: { bids: [["97.0", "2.0"]], asks: [["103.0", "1.0"]], lastUpdateId: 202 }, delta: { bids: [["97.0", "2.0"]], asks: [] } },
    ];
    const sparse = full.map((frame, index) => {
      const seedsOrResyncs = index === 1 || index === 6;
      if (frame.kind !== "book" || seedsOrResyncs) return frame;
      return { ...frame, book: { lastUpdateId: frame.book.lastUpdateId, bestBid: frame.book.bids[0][0], bestAsk: frame.book.asks[0][0] } };
    });
    const run = (frames) => {
      const engine = createMemoryEngine({ tickSize: 0.1, clusterTicks: 10 });
      for (const frame of frames) engine.apply(frame);
      return { stats: { ...engine.stats }, snapshot: engine.snapshot(T0 + 500), lite: engine.liteSnapshot() };
    };
    const fullRun = run(full);
    const sparseRun = run(sparse);
    expect(sparseRun.stats).toEqual(fullRun.stats);
    expect(fullRun.stats).toMatchObject({ seeds: 1, resyncs: 1, deltas: 3, trades: 1 });
    expect(JSON.stringify(sparseRun.lite)).toBe(JSON.stringify(fullRun.lite));
    expect(JSON.stringify(sparseRun.snapshot)).toBe(JSON.stringify(fullRun.snapshot));
  });

  test("a frame that carries only best prices cannot seed, and cannot resync after an anchor", () => {
    const sparse = { kind: "book", ts: T0, status: "READY", book: { bestBid: "99.0", bestAsk: "101.0", lastUpdateId: 1 }, delta: { bids: [], asks: [] } };
    const engine = createMemoryEngine({ tickSize: 0.1 });
    expect(() => engine.apply(sparse)).toThrow(/a full book is required to seed, but this frame carries only its best prices/);
    engine.apply({ kind: "book", ts: T0, status: "READY", book: { bids: [["99.0", "1.0"]], asks: [["101.0", "1.0"]], lastUpdateId: 1 }, delta: { bids: [], asks: [] } });
    engine.apply({ ...sparse, ts: T0 + 100 });
    expect(engine.stats.deltas).toBe(1);
    engine.apply({ kind: "anchor", ts: T0 + 200, lastUpdateId: 2 });
    expect(() => engine.apply({ ...sparse, ts: T0 + 300 })).toThrow(/a full book is required to resync after a gap/);
  });

  test("topLevels lists the largest live levels per side in price terms", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    feedDepth(engine,
      depthEnvelope({ ts: T0 }),
      readyState([["99.0", "1.0"], ["98.0", "9.0"], ["97.0", "3.0"]], [["101.0", "4.0"], ["102.0", "0.5"]]),
    );
    feedTrade(engine, tradeEnvelope({ ts: T0 + 10, price: "101.0", quantity: "2", isBuyerMaker: false }));
    const top = engine.topLevels({ limit: 2 });
    expect(top.bids.map((l) => [l.price, l.size])).toEqual([[98, 9], [97, 3]]);
    expect(top.asks[0]).toMatchObject({ price: 101, size: 4, traded: 2, hidden: 2, seeded: true, ageSec: 0 });
    expect(top.ts).toBe(T0 + 10);
  });

  test("levels beyond the snapshot's range are treated as pre-existing, not newborn", () => {
    const engine = createMemoryEngine({ tickSize: 0.1 });
    // Snapshot covers bids down to 98.0 and asks up to 102.0 only.
    feedDepth(engine,
      depthEnvelope({ ts: T0 }),
      readyState([["99.0", "1.0"], ["98.0", "1.0"]], [["101.0", "1.0"], ["102.0", "1.0"]]),
    );
    // A far wall shows up through a diff (it was always there, just outside the snapshot),
    // alongside a genuinely new level inside the covered range.
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 100, bids: [["60.0", "150.0"], ["98.5", "2.0"]], asks: [["150.0", "80.0"]] }),
      readyState([["99.0", "1.0"], ["98.5", "2.0"], ["98.0", "1.0"], ["60.0", "150.0"]], [["101.0", "1.0"], ["102.0", "1.0"], ["150.0", "80.0"]]),
    );
    const snap = engine.snapshot();
    expect(snap.bids.find((l) => l.key === 600)).toMatchObject({ seeded: true, added: 0, size: 150 });
    expect(snap.asks.find((l) => l.key === 1500)).toMatchObject({ seeded: true, added: 0, size: 80 });
    expect(snap.bids.find((l) => l.key === 985)).toMatchObject({ seeded: false, added: 2 });
    expect(engine.stats.outsideRangeSeeds).toBe(2);

    // Once known, a far wall is accounted for normally: a shrink with no trade is a cancel.
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 200, bids: [["60.0", "100.0"]] }),
      readyState([["99.0", "1.0"], ["98.5", "2.0"], ["98.0", "1.0"], ["60.0", "100.0"]], [["101.0", "1.0"], ["102.0", "1.0"], ["150.0", "80.0"]]),
    );
    expect(engine.snapshot().bids.find((l) => l.key === 600)).toMatchObject({ size: 100, cancelled: 50 });
    expect(engine.stats.outsideRangeSeeds).toBe(2);
  });

  test("snapshotDepth bounds the covered range even when bridging diffs already added far levels", () => {
    expect(() => createMemoryEngine({ tickSize: 0.1, snapshotDepth: 0 })).toThrow(/snapshotDepth/);
    // The snapshot covers 2 levels per side; a far wall at 60.0 is already in the
    // first READY book because a bridging diff added it.
    const engine = createMemoryEngine({ tickSize: 0.1, snapshotDepth: 2 });
    feedDepth(engine,
      depthEnvelope({ ts: T0 }),
      readyState([["99.0", "1.0"], ["98.0", "1.0"], ["60.0", "100.0"]], [["101.0", "1.0"], ["102.0", "1.0"]]),
    );
    expect(engine.snapshot().bids.find((l) => l.key === 600)).toMatchObject({ seeded: true });

    // Another far wall shows up later: still outside the 2-level snapshot, so pre-existing.
    // A level between the covered edge and the far wall is also outside coverage.
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 100, bids: [["70.0", "50.0"], ["97.0", "3.0"]] }),
      readyState([["99.0", "1.0"], ["98.0", "1.0"], ["97.0", "3.0"], ["70.0", "50.0"], ["60.0", "100.0"]], [["101.0", "1.0"], ["102.0", "1.0"]]),
    );
    const snap = engine.snapshot();
    expect(snap.bids.find((l) => l.key === 700)).toMatchObject({ seeded: true, added: 0 });
    expect(snap.bids.find((l) => l.key === 970)).toMatchObject({ seeded: true, added: 0 });
    // Inside coverage is still genuinely new.
    feedDepth(engine,
      depthEnvelope({ ts: T0 + 200, bids: [["98.5", "2.0"]] }),
      readyState([["99.0", "1.0"], ["98.5", "2.0"], ["98.0", "1.0"], ["97.0", "3.0"], ["70.0", "50.0"], ["60.0", "100.0"]], [["101.0", "1.0"], ["102.0", "1.0"]]),
    );
    expect(engine.snapshot().bids.find((l) => l.key === 985)).toMatchObject({ seeded: false, added: 2 });
    expect(engine.stats.outsideRangeSeeds).toBe(2);
  });

  test("topLevels can be restricted to levels near the top of book", () => {
    const engine = createMemoryEngine({ tickSize: 0.1, clusterTicks: 10 }); // 1-dollar bands
    feedDepth(engine,
      depthEnvelope({ ts: T0 }),
      readyState([["99.0", "1.0"], ["97.0", "2.0"], ["60.0", "500.0"]], [["101.0", "1.0"], ["150.0", "300.0"]]),
    );
    const far = engine.topLevels({ limit: 1 });
    expect(far.bids[0].price).toBe(60);
    expect(far.asks[0].price).toBe(150);
    const near = engine.topLevels({ limit: 5, withinKeys: 3 });
    expect(near.bids.map((l) => l.price)).toEqual([97, 99]);
    expect(near.asks.map((l) => l.price)).toEqual([101]);
  });

  test("prune forwards to the ledger", () => {
    const engine = createMemoryEngine({ tickSize: 0.1, ledgerOptions: { forgetEmptyAfterMs: 100 } });
    feedDepth(engine, depthEnvelope({ ts: T0 }), readyState([["99.0", "1.0"]], [["101.0", "1.0"]]));
    feedDepth(engine, depthEnvelope({ ts: T0 + 10, bids: [["99.0", "0"]] }), readyState([], [["101.0", "1.0"]]));
    expect(engine.stats.bidRecords).toBe(1);
    engine.prune(T0 + 500);
    expect(engine.stats.bidRecords).toBe(0);
  });
});

describe("memory engine: the segment in force (report 61 P4a)", () => {
  test("is null before the first book, then follows seed, gap and resync with their own start times", () => {
    const engine = createMemoryEngine({ tickSize: 1 });
    expect(engine.segment).toBeNull();
    engine.apply({ kind: "book", ts: T0, status: "READY", book: { bids: [["99", "1"]], asks: [["101", "1"]] } });
    expect(engine.segment).toEqual({ startTs: T0, state: "LIVE", cause: "SEED" });
    engine.apply({ kind: "trade", ts: T0 + 500, price: "101", size: "1", side: "buy" });
    engine.apply({ kind: "book", ts: T0 + 900, status: "UNAVAILABLE" });
    expect(engine.segment).toMatchObject({ state: "GAP", cause: "UNAVAILABLE" });
    expect(engine.segment.startTs).toBeGreaterThanOrEqual(T0);
    expect(engine.segment.startTs).toBeLessThan(T0 + 900);
    engine.apply({ kind: "book", ts: T0 + 2_000, status: "UNAVAILABLE" });
    expect(engine.segment.cause).toBe("UNAVAILABLE");
    engine.apply({ kind: "book", ts: T0 + 3_000, status: "READY", book: { bids: [["99", "1"]], asks: [["101", "1"]] } });
    expect(engine.segment).toEqual({ startTs: T0 + 3_000, state: "LIVE", cause: "RESYNC" });
  });

  test("agrees with the segment events in the outbox", () => {
    const engine = createMemoryEngine({ tickSize: 1 });
    engine.apply({ kind: "book", ts: T0, status: "READY", book: { bids: [["99", "1"]], asks: [["101", "1"]] } });
    engine.apply({ kind: "book", ts: T0 + 900, status: "UNAVAILABLE" });
    const last = engine.events(0).events.filter((event) => event.type === "segment").pop();
    expect({ startTs: last.ts, state: last.state, cause: last.cause }).toEqual(engine.segment);
  });
});
