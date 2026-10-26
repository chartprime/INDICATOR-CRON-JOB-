const { createLargeLevelTracker, columnPercentile, clustersOf } = require("../../../src/indicators/passive_liquidity/large-level-tracker");

const T = 1_700_000_000_000;

function column(ts, lo, bid, ask) {
  return { ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask) };
}
// rowClusters 1: key == row.
function snapshot({ bids = [], asks = [] } = {}) {
  return { bids, asks };
}
const rec = (key, traded, cancelled) => ({ key, size: 1, traded, cancelled });
// multiplier 0: the notional floor alone decides; gapRows 0: no bridging. Keeps the basic tests readable.
// settleMs 0: a vanished wall is judged in the same column, which keeps these scenarios short; the settle has its own tests.
const fixed = (options = {}) => createLargeLevelTracker({ minSize: 10, multiplier: 0, gapRows: 0, settleMs: 0, ...options });
const zeros = (n) => new Array(n).fill(0);

describe("large-level-tracker", () => {
  test("validates its options", () => {
    expect(() => createLargeLevelTracker({})).toThrow(/minSize/);
    expect(() => createLargeLevelTracker({ minSize: 5, multiplier: -1 })).toThrow(/multiplier/);
    expect(() => createLargeLevelTracker({ minSize: 5, keepEndedMs: 0 })).toThrow(/keepEndedMs/);
    expect(() => createLargeLevelTracker({ minSize: 5, maxLevels: 0 })).toThrow(/maxLevels/);
  });

  test("columnPercentile reads the non-zero cells of both sides, optionally only near the mid", () => {
    const c = column(T, 0, [1, 0, 4], [2, 3, 0]);
    expect(columnPercentile(c, 0)).toBe(1);
    expect(columnPercentile(c, 1)).toBe(4);
    expect(columnPercentile(column(T, 0, [0], [0]), 0.95)).toBe(0);
    // Rows 0..6, mid 3: within 1 row of the mid only rows 2..4 count.
    const wide = column(T, 0, [50, 50, 1, 2, 3, 50, 50], zeros(7));
    expect(columnPercentile(wide, 1, 1)).toBe(3);
    expect(columnPercentile(wide, 1)).toBe(50);
  });

  test("the reference is judged near the mid, so a thick far book does not hide walls at price", () => {
    const tracker = createLargeLevelTracker({ minSize: 1, multiplier: 3, settleMs: 0 });
    // 40 near rows of 10 with one of 40 at the mid; 20 far rows of 100 on each edge.
    const bids = [...new Array(20).fill(100), ...new Array(40).fill(10), ...new Array(20).fill(100)];
    bids[40] = 40;
    const col = column(T, 0, bids, zeros(bids.length));
    tracker.update({ ts: T, column: col, snapshot: snapshot(), rowClusters: 1, referenceRows: 15 });
    expect(tracker.reference).toBe(10);
    expect(tracker.levels().some((l) => l.row === 40 && l.peak === 40)).toBe(true);
  });

  test("clustersOf merges adjacent rows above half the threshold into one wall when their total reaches it", () => {
    // threshold 10, half 5: [8, 9, 8] is one cluster of 25; the lone 6 is under 10; the 12 stands alone.
    expect(clustersOf(Float64Array.from([8, 9, 8, 0, 6, 0, 12, 4]), 100, 5, 10)).toEqual([
      { row: 100, span: 3, total: 25 },
      { row: 106, span: 1, total: 12 },
    ]);
    expect(clustersOf(Float64Array.from([0, 0]), 0, 5, 10)).toEqual([]);
  });

  test("clustersOf bridges up to gapRows thinner rows between strong rows, counting their size", () => {
    const values = Float64Array.from([9, 1, 8, 0, 0, 0, 7, 2, 2, 6]);
    // No bridging: four separate runs, only the lone 9 is under 10 alone... none reach 10 except none.
    expect(clustersOf(values, 100, 5, 10, 0)).toEqual([]);
    // One gap row: 9+1+8 = 18 spans rows 100..102; 7..6 are three rows apart, not bridged.
    expect(clustersOf(values, 100, 5, 10, 1)).toEqual([{ row: 100, span: 3, total: 18 }]);
    // Two gap rows: 7+2+2+6 = 17 spans rows 106..109 as well.
    expect(clustersOf(values, 100, 5, 10, 2)).toEqual([
      { row: 100, span: 3, total: 18 },
      { row: 106, span: 4, total: 17 },
    ]);
    // Trailing thin rows never extend a cluster.
    expect(clustersOf(Float64Array.from([12, 1, 0]), 0, 5, 10, 2)).toEqual([{ row: 0, span: 1, total: 12 }]);
    expect(() => createLargeLevelTracker({ minSize: 5, gapRows: -1 })).toThrow(/gapRows/);
  });

  test("a wall price reached and traded into is eaten even if the rest was cancelled; one price never reached is pulled", () => {
    const tracker = fixed();
    // Window rows 100..110, mid 105. Bid wall at row 103 (below mid), ask wall at row 108 (above mid).
    const bid0 = zeros(11);
    const ask0 = zeros(11);
    bid0[3] = 20;
    ask0[8] = 20;
    tracker.update({ ts: T, column: column(T, 100, bid0, ask0), snapshot: snapshot({ bids: [rec(103, 0, 0)], asks: [rec(108, 0, 0)] }), rowClusters: 1 });
    expect(tracker.activeCount).toBe(2);
    // Price falls onto the bid wall (mid now 103): 12 of the 20 traded, the other 8 were cancelled.
    // The ask wall vanished with price still below it and nothing traded: pulled.
    const bid = zeros(7);
    const ask = zeros(7);
    tracker.update({
      ts: T + 1000,
      column: column(T + 1000, 100, bid, ask), // rows 100..106, mid 103
      snapshot: snapshot({ bids: [rec(103, 12, 8)], asks: [rec(108, 0, 20)] }),
      rowClusters: 1,
    });
    expect(tracker.levels()).toEqual([
      expect.objectContaining({ side: "bid", row: 103, endedBy: "filled" }),
      expect.objectContaining({ side: "ask", row: 108, endedBy: "pulled" }),
    ]);
  });

  test("a row at or above the floor becomes an active level, tracked with its peak", () => {
    const tracker = fixed();
    expect(tracker.update({ ts: T, column: column(T, 100, [12, 3], [0, 0]), snapshot: snapshot(), rowClusters: 1 })).toBe(true);
    expect(tracker.levels()).toEqual([{ side: "bid", row: 100, span: 1, startTs: T, endTs: null, size: 12, peak: 12, endedBy: null, ratio: expect.any(Number), chain: 0, fill: 0, eaten: 0, absorbing: false }]);
    // Same size again: nothing changed.
    expect(tracker.update({ ts: T + 1000, column: column(T + 1000, 100, [12, 3], [0, 0]), snapshot: snapshot(), rowClusters: 1 })).toBe(false);
    // Grows, then shrinks but stays above half the threshold: still the same level.
    tracker.update({ ts: T + 2000, column: column(T + 2000, 100, [20, 3], [0, 0]), snapshot: snapshot(), rowClusters: 1 });
    tracker.update({ ts: T + 3000, column: column(T + 3000, 100, [6, 3], [0, 0]), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.levels()[0]).toMatchObject({ size: 6, peak: 20, endedBy: null, endTs: null });
    expect(tracker.activeCount).toBe(1);
  });

  test("stacked rows form one wall that follows its cluster as it grows and shifts", () => {
    const tracker = fixed();
    tracker.update({ ts: T, column: column(T, 100, [0, 7, 8, 0, 0], zeros(5)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 101, span: 2, size: 15, peak: 15 })]);
    // A third row joins on top: same wall, wider.
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, [0, 7, 8, 6, 0], zeros(5)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.activeCount).toBe(1);
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 101, span: 3, size: 21, peak: 21, startTs: T })]);
    // The bottom row leaves: still the same wall, narrower.
    tracker.update({ ts: T + 2000, column: column(T + 2000, 100, [0, 0, 8, 6, 0], zeros(5)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 102, span: 2, size: 14, peak: 21, startTs: T })]);
  });

  test("a wall holding on without a qualifying cluster keeps peak >= size", () => {
    const tracker = fixed();
    tracker.update({ ts: T, column: column(T, 100, [0, 12, 0], zeros(3)), snapshot: snapshot(), rowClusters: 1 });
    // The row drops under half the threshold... no: it drops to 6 (above half of 10) so no cluster forms
    // (6 < 10), yet the wall holds; then the row grows to 9, still no cluster, and peak must follow.
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, [0, 6, 0], zeros(3)), snapshot: snapshot(), rowClusters: 1 });
    tracker.update({ ts: T + 2000, column: column(T + 2000, 100, [0, 9, 0], zeros(3)), snapshot: snapshot(), rowClusters: 1 });
    const [level] = tracker.levels();
    expect(level).toMatchObject({ size: 9, peak: 12, endedBy: null });
    // A wall entered at threshold 10 whose rows later hold 14 without forming a cluster of 10?
    // They would, so exercise the branch with a raised threshold instead: a second tracker with a high floor.
    const tight = createLargeLevelTracker({ minSize: 10, multiplier: 0, gapRows: 0, keepEndedMs: 60_000 });
    tight.update({ ts: T, column: column(T, 100, [10, 0, 10], zeros(3)), snapshot: snapshot(), rowClusters: 1 });
    expect(tight.levels().every((l) => l.peak >= l.size)).toBe(true);
  });

  test("an older wall holding on with thin rows and a fresh wall right beside it merge into one", () => {
    const tracker = fixed({ gapRows: 2 });
    // Wall A over rows 101..103 (each 8 >= half 5, total 24 >= 10).
    tracker.update({ ts: T, column: column(T, 100, [0, 8, 8, 8, 0, 0], zeros(6)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 101, span: 3, size: 24 })]);
    // A thins to 3 per row: under half, so no cluster, but 9 >= 5 keeps it holding. A fresh 12 lands on row 105, one empty row above A.
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, [0, 3, 3, 3, 0, 12], zeros(6)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.activeCount).toBe(1);
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 101, span: 5, size: 21, peak: 24, startTs: T, endedBy: null })]);
    // Touching walls merge even with no bridging (gapRows 0); a one-row gap does not.
    const strict = fixed({ gapRows: 0 });
    strict.update({ ts: T, column: column(T, 100, [12, 0, 12, 12, 0], zeros(5)), snapshot: snapshot(), rowClusters: 1 });
    expect(strict.levels().map((l) => [l.row, l.span]).sort((a, b) => a[0] - b[0])).toEqual([[100, 1], [102, 2]]);
  });

  test("a younger wall swallowed by an older wall's cluster is absorbed, not reported as ended", () => {
    const tracker = fixed();
    tracker.update({ ts: T, column: column(T, 100, [12, 0, 12], zeros(3)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.activeCount).toBe(2);
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, [12, 9, 12], zeros(3)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.activeCount).toBe(1);
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 100, span: 3, size: 33, endedBy: null })]);
  });

  test("the threshold follows the book: a multiple of the smoothed 95th percentile row", () => {
    const tracker = createLargeLevelTracker({ minSize: 1, multiplier: 3, settleMs: 0 });
    // Forty typical rows of 10 and one of 25: p95 stays 10, and 25 < 3 x 10 is not a wall.
    const typical = new Array(40).fill(10);
    typical.push(25);
    const none = zeros(typical.length);
    tracker.update({ ts: T, column: column(T, 0, typical, none), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.reference).toBe(10); // first sample seeds the reference
    expect(tracker.threshold()).toBe(30);
    expect(tracker.levels()).toEqual([]);
    // A row of 90 clears 3 x reference (its neighbours of 10 are under half, so it stands alone).
    const withWall = [...typical];
    withWall[3] = 90;
    tracker.update({ ts: T + 1000, column: column(T + 1000, 0, withWall, none), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 3, span: 1, peak: 90, endedBy: null })]);
    // The wall ends against the threshold it entered at (30), not today's.
    const nibbled = [...typical];
    nibbled[3] = 16; // above half of 30: still resting
    tracker.update({ ts: T + 2000, column: column(T + 2000, 0, nibbled, none), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.activeCount).toBe(1);
    nibbled[3] = 14; // under half: gone
    tracker.update({ ts: T + 3000, column: column(T + 3000, 0, nibbled, none), snapshot: snapshot({ bids: [rec(3, 0, 76)] }), rowClusters: 1 });
    expect(tracker.activeCount).toBe(0);
  });

  test("a level eaten by trades ends as filled, one withdrawn ends as pulled", () => {
    const tracker = fixed();
    tracker.update({
      ts: T,
      column: column(T, 100, [12, 0], [0, 15]),
      snapshot: snapshot({ bids: [rec(100, 5, 1)], asks: [rec(101, 0, 0)] }),
      rowClusters: 1,
    });
    expect(tracker.activeCount).toBe(2);
    // Bid row traded 11 more since the wall appeared; ask row cancelled 15.
    tracker.update({
      ts: T + 5000,
      column: column(T + 5000, 100, [0, 0], [0, 0]),
      snapshot: snapshot({ bids: [rec(100, 16, 1)], asks: [rec(101, 0, 15)] }),
      rowClusters: 1,
    });
    expect(tracker.activeCount).toBe(0);
    expect(tracker.levels()).toEqual([
      // 11 of its 12 coins printed on its row: eaten as well as filled.
      { side: "bid", row: 100, span: 1, startTs: T, endTs: T + 5000, size: 0, peak: 12, endedBy: "filled", ratio: expect.any(Number), chain: 0, fill: 1, eaten: 0.92, absorbing: false },
      { side: "ask", row: 101, span: 1, startTs: T, endTs: T + 5000, size: 0, peak: 15, endedBy: "pulled", ratio: expect.any(Number), chain: 0, fill: 0, eaten: 0, absorbing: false },
    ]);
  });

  test("a wall is judged only after the settle: the trades that emptied it can arrive after the depth update that showed it empty", () => {
    const { DEFAULT_SETTLE_MS } = require("../../../src/indicators/passive_liquidity/large-level-tracker");
    expect(() => fixed({ settleMs: -1 })).toThrow(/settleMs/);
    const tracker = fixed({ settleMs: DEFAULT_SETTLE_MS });
    // Rows 100..110, mid 105. A 60 BTC bid wall at 103.
    const bid0 = zeros(11);
    bid0[3] = 60;
    tracker.update({ ts: T, column: column(T, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
    // A big candle: the depth update shows the row empty, and so far the ledger has it all as cancelled.
    const swept = column(T + 1_000, 100, zeros(7), zeros(7)); // rows 100..106, mid 103
    tracker.update({ ts: T + 1_000, column: swept, snapshot: snapshot({ bids: [rec(103, 0, 60)] }), rowClusters: 1 });
    // Still on the wire as resting: no verdict yet.
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 103, endTs: null, endedBy: null, size: 0 })]);
    // Two seconds later the trades land and the ledger reclaims most of that size as traded.
    tracker.update({ ts: T + 3_000, column: { ...swept, ts: T + 3_000 }, snapshot: snapshot({ bids: [rec(103, 55, 5)] }), rowClusters: 1 });
    expect(tracker.levels()[0].endedBy).toBeNull();
    // After the settle it is judged on what arrived, and it ended when it left, not when it was judged.
    tracker.update({ ts: T + 1_000 + DEFAULT_SETTLE_MS, column: { ...swept, ts: T + 1_000 + DEFAULT_SETTLE_MS }, snapshot: snapshot({ bids: [rec(103, 55, 5)] }), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 103, endTs: T + 1_000, endedBy: "filled", fill: 0.92, absorbing: false })]);
    // A wall that comes back during the settle was never gone.
    const again = fixed({ settleMs: DEFAULT_SETTLE_MS });
    again.update({ ts: T, column: column(T, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
    again.update({ ts: T + 1_000, column: column(T + 1_000, 100, zeros(11), zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 60)] }), rowClusters: 1 });
    again.update({ ts: T + 2_000, column: column(T + 2_000, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 60)] }), rowClusters: 1 });
    again.update({ ts: T + 9_000, column: column(T + 9_000, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 60)] }), rowClusters: 1 });
    expect(again.levels()).toEqual([expect.objectContaining({ row: 103, endTs: null, size: 60 })]);
  });

  test("the verdicts: filled, partial, hit, pulled, by the share of what left that traded", () => {
    const { FILLED_SHARE, EATEN_SHARE } = require("../../../src/indicators/passive_liquidity/large-level-tracker");
    expect(FILLED_SHARE).toBeGreaterThan(EATEN_SHARE);
    const run = (traded, cancelled, reached = true) => {
      const tracker = fixed();
      const bid0 = zeros(11);
      bid0[3] = 60;
      tracker.update({ ts: T, column: column(T, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
      // reached: price comes down onto it (mid 103); not reached: it goes with price still above (mid 105).
      const gone = reached ? column(T + 1_000, 100, zeros(7), zeros(7)) : column(T + 1_000, 100, zeros(11), zeros(11));
      tracker.update({ ts: T + 1_000, column: gone, snapshot: snapshot({ bids: [rec(103, traded, cancelled)] }), rowClusters: 1 });
      const level = tracker.levels()[0];
      return [level.endedBy, level.fill];
    };
    expect(run(55, 5)).toEqual(["filled", 0.92]);
    expect(run(20, 40)).toEqual(["partial", 0.33]);
    expect(run(1, 59)).toEqual(["hit", 0.02]);
    expect(run(0, 60)).toEqual(["hit", 0]);
    expect(run(0, 60, false)).toEqual(["pulled", 0]);
    // Trades at its price are proof enough on their own that price got there.
    expect(run(50, 10, false)).toEqual(["filled", 0.83]);
  });

  test("a resting wall being traded into while it holds is absorbing, until the trades stop or it gives way", () => {
    const { ABSORB_WINDOW_MS } = require("../../../src/indicators/passive_liquidity/large-level-tracker");
    const tracker = fixed();
    const wall = (size) => { const bid = zeros(11); bid[3] = size; return bid; };
    tracker.update({ ts: T, column: column(T, 100, wall(60), zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
    expect(tracker.levels()[0]).toMatchObject({ absorbing: false, fill: 0 });
    // Trades land on it and it is refilled to nearly full: absorbing.
    tracker.update({ ts: T + 1_000, column: column(T + 1_000, 100, wall(58), zeros(11)), snapshot: snapshot({ bids: [rec(103, 10, 0)] }), rowClusters: 1 });
    expect(tracker.levels()[0]).toMatchObject({ absorbing: true, endedBy: null, fill: 1 });
    // Quiet for longer than the window: no longer absorbing, still resting.
    tracker.update({ ts: T + 1_000 + ABSORB_WINDOW_MS + 1_000, column: column(T + 1_000 + ABSORB_WINDOW_MS + 1_000, 100, wall(58), zeros(11)), snapshot: snapshot({ bids: [rec(103, 10, 0)] }), rowClusters: 1 });
    expect(tracker.levels()[0]).toMatchObject({ absorbing: false, endedBy: null });
    // Trades again, but it has been eaten down to a third of its peak: giving way, not absorbing.
    tracker.update({ ts: T + 10_000, column: column(T + 10_000, 100, wall(20), zeros(11)), snapshot: snapshot({ bids: [rec(103, 50, 0)] }), rowClusters: 1 });
    expect(tracker.levels()[0]).toMatchObject({ absorbing: false, endedBy: null, size: 20 });
  });

  test("a wall hit at the touch and re-placed nearby is moved, like a pulled one", () => {
    const tracker = fixed();
    // Rows 100..120, mid 110. Ask wall of 30 at 115.
    const ask0 = zeros(21);
    ask0[15] = 30;
    tracker.update({ ts: T, column: column(T, 100, zeros(21), ask0), snapshot: snapshot({ asks: [rec(115, 0, 0)] }), rowClusters: 1 });
    // Price rises onto it (mid 115), it is cancelled at the touch, and 29 appears two rows up the same second.
    const ask1 = zeros(11);
    ask1[7] = 29; // rows 110..120: row 117
    tracker.update({ ts: T + 1_000, column: column(T + 1_000, 110, zeros(11), ask1), snapshot: snapshot({ asks: [rec(115, 0, 30), rec(117, 0, 0)] }), rowClusters: 1 });
    expect(tracker.levels().map((l) => [l.row, l.endedBy, l.chain])).toEqual([[115, "moved", 1], [117, null, 1]]);
  });

  test("what makes a wall eaten is the share of the size that left it, not the size of the wall", () => {
    // The book cancels far more than it trades, so a fifth of a wall's peak
    // will essentially never trade. The question that can be answered is what
    // happened to the size that left: was it bought, or was it withdrawn.
    const run = (traded, cancelled) => {
      const tracker = fixed();
      // Rows 100..110, mid 105. A 60 BTC bid wall at row 103, below price.
      const bid0 = zeros(11);
      bid0[3] = 60;
      tracker.update({ ts: T, column: column(T, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
      // Price comes down onto it (rows 100..106, mid 103) and it goes.
      tracker.update({
        ts: T + 1_000,
        column: column(T + 1_000, 100, zeros(7), zeros(7)),
        snapshot: snapshot({ bids: [rec(103, traded, cancelled)] }),
        rowClusters: 1,
      });
      return tracker.levels()[0].endedBy;
    };
    // 6 of the 27 that left was bought: 22%, real absorption. Under the old
    // rule this needed 12 of the wall's 60 and was reported as merely touched.
    expect(run(6, 21)).toBe("partial");
    expect(run(20, 7)).toBe("filled");
    // 1 of 201: the wall was withdrawn and a trade happened to clip it.
    expect(run(1, 200)).toBe("hit");
    // Nothing traded at all: price arrived and it vanished.
    expect(run(0, 60)).toBe("hit");
  });

  test("a wall eaten on rows that had traded before is still filled: each row is measured from when it joined", () => {
    // The bug this guards against: one traded/cancelled figure was taken for
    // the whole wall when it qualified and subtracted from the figure at the
    // end. A wall narrows as it is eaten, so the closing sum covered fewer
    // rows than the opening one, went negative against any prior trading
    // history on those prices, clamped to zero, and the fill vanished. On a
    // real book, where every price has traded before, almost nothing was ever
    // called filled.
    const eat = (historyPerRow) => {
      const tracker = fixed();
      // Rows 100..110, mid 105. A three-row bid wall of 60 below price.
      const bid0 = zeros(11);
      bid0[0] = 20;
      bid0[1] = 20;
      bid0[2] = 20;
      const history = (traded) => [rec(100, traded, 0), rec(101, traded, 0), rec(102, traded, 0)];
      tracker.update({ ts: T, column: column(T, 100, bid0, zeros(11)), snapshot: snapshot({ bids: history(historyPerRow) }), rowClusters: 1 });
      expect(tracker.levels()[0]).toMatchObject({ row: 100, span: 3, peak: 60 });
      // Price arrives and takes the top two rows: 40 traded, and the cluster narrows.
      const bid1 = zeros(7);
      bid1[2] = 20;
      tracker.update({
        ts: T + 1_000,
        column: column(T + 1_000, 98, bid1, zeros(7)), // rows 98..104, mid 101
        snapshot: snapshot({ bids: [rec(100, historyPerRow + 20, 0), rec(101, historyPerRow + 20, 0), rec(102, historyPerRow, 0)] }),
        rowClusters: 1,
      });
      // The last row goes too: the whole 60 traded, nothing was cancelled.
      tracker.update({
        ts: T + 2_000,
        column: column(T + 2_000, 96, zeros(7), zeros(7)), // rows 96..102, mid 99
        snapshot: snapshot({ bids: [rec(100, historyPerRow + 40, 0), rec(101, historyPerRow + 20, 0), rec(102, historyPerRow, 0)] }),
        rowClusters: 1,
      });
      return tracker.levels().find((level) => level.endedBy !== null).endedBy;
    };
    expect(eat(0)).toBe("filled"); // rows the market had never traded
    expect(eat(500)).toBe("filled"); // the same wall, the same trades, on rows with a past
  });

  test("a row that joins a wall late is measured from when it joined, not from its whole history", () => {
    const tracker = fixed();
    // A one-row wall at 100. Row 101 has traded heavily today but is empty now.
    const bid0 = zeros(11);
    bid0[0] = 20;
    tracker.update({ ts: T, column: column(T, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(100, 0, 0), rec(101, 900, 0)] }), rowClusters: 1 });
    // Size lands on 101 and the wall grows onto it. That history is not ours.
    const bid1 = zeros(11);
    bid1[0] = 20;
    bid1[1] = 20;
    tracker.update({ ts: T + 1_000, column: column(T + 1_000, 100, bid1, zeros(11)), snapshot: snapshot({ bids: [rec(100, 0, 0), rec(101, 900, 0)] }), rowClusters: 1 });
    expect(tracker.levels()[0]).toMatchObject({ row: 100, span: 2 });
    // Both rows are then withdrawn with nothing traded since the wall reached them.
    tracker.update({ ts: T + 2_000, column: column(T + 2_000, 100, zeros(11), zeros(11)), snapshot: snapshot({ bids: [rec(100, 0, 40), rec(101, 900, 20)] }), rowClusters: 1 });
    expect(tracker.levels()[0]).toMatchObject({ endedBy: "pulled" });
  });

  test("hit means pulled at the touch: a wall price visited long before it was withdrawn is pulled", () => {
    const { HIT_WINDOW_MS } = require("../../../src/indicators/passive_liquidity/large-level-tracker");
    const tracker = fixed();
    const bid0 = zeros(11);
    bid0[3] = 20;
    tracker.update({ ts: T, column: column(T, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
    // Price comes down onto it (mid 103)...
    const bid1 = zeros(7);
    bid1[3] = 20;
    tracker.update({ ts: T + 1_000, column: column(T + 1_000, 100, bid1, zeros(7)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
    // ...goes back up (mid 105) and stays there, and the wall is withdrawn much later.
    const pulledAt = T + 1_000 + HIT_WINDOW_MS + 60_000;
    tracker.update({ ts: T + 2_000, column: column(T + 2_000, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
    tracker.update({ ts: pulledAt, column: column(pulledAt, 100, zeros(11), zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 20)] }), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 103, endedBy: "pulled" })]);
  });

  test("when the list is over the cap, moved segments give way to real verdicts", () => {
    const tracker = fixed({ maxLevels: 3 });
    tracker.adopt([
      { side: "bid", row: 100, span: 1, startTs: T - 50_000, endTs: T - 40_000, size: 0, peak: 20, endedBy: "moved", chain: 1 },
      { side: "bid", row: 101, span: 1, startTs: T - 40_000, endTs: T - 30_000, size: 0, peak: 20, endedBy: "moved", chain: 1 },
      { side: "bid", row: 102, span: 1, startTs: T - 30_000, endTs: T - 20_000, size: 0, peak: 20, endedBy: "pulled", chain: 1 },
      { side: "ask", row: 110, span: 1, startTs: T - 25_000, endTs: T - 10_000, size: 0, peak: 30, endedBy: "filled" },
    ]);
    expect(tracker.levels().map((l) => [l.row, l.endedBy])).toEqual([[101, "moved"], [102, "pulled"], [110, "filled"]]);
  });

  test("a wall price reached that left without trading moments later ends as hit", () => {
    const tracker = fixed();
    // Rows 100..110, mid 105: a bid wall at 103.
    const bid0 = zeros(11);
    bid0[3] = 20;
    tracker.update({ ts: T, column: column(T, 100, bid0, zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
    // Price falls onto it (mid 103) and it is still there.
    const bid1 = zeros(7);
    bid1[3] = 20;
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, bid1, zeros(7)), snapshot: snapshot({ bids: [rec(103, 0, 0)] }), rowClusters: 1 });
    // Price bounces back up (mid 105) and the wall is cancelled whole.
    tracker.update({ ts: T + 2000, column: column(T + 2000, 100, zeros(11), zeros(11)), snapshot: snapshot({ bids: [rec(103, 0, 20)] }), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ side: "bid", row: 103, endedBy: "hit", chain: 0 })]);
  });

  test("a pulled wall re-placed within seconds nearby at about the same size becomes moved, and its successor carries the chain", () => {
    const tracker = fixed();
    // Rows 100..120, mid 110. Ask wall of 30 at row 115.
    const ask0 = zeros(21);
    ask0[15] = 30;
    tracker.update({ ts: T, column: column(T, 100, zeros(21), ask0), snapshot: snapshot({ asks: [rec(115, 0, 0)] }), rowClusters: 1 });
    // Gone from 115, a 28 appears at 113 the same second: the same order moved.
    const ask1 = zeros(21);
    ask1[13] = 28;
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, zeros(21), ask1), snapshot: snapshot({ asks: [rec(115, 0, 30), rec(113, 0, 0)] }), rowClusters: 1 });
    let levels = tracker.levels();
    expect(levels).toEqual([
      expect.objectContaining({ row: 115, endedBy: "moved", chain: 1 }),
      expect.objectContaining({ row: 113, endedBy: null, chain: 1 }),
    ]);
    // It moves again 10 s later: same chain, three segments.
    const ask2 = zeros(21);
    ask2[11] = 31;
    tracker.update({ ts: T + 11_000, column: column(T + 11_000, 100, zeros(21), ask2), snapshot: snapshot({ asks: [rec(113, 0, 28), rec(111, 0, 0)] }), rowClusters: 1 });
    levels = tracker.levels();
    expect(levels.map((l) => [l.row, l.endedBy, l.chain])).toEqual([[115, "moved", 1], [113, "moved", 1], [111, null, 1]]);
    // A wall of a very different size, or one arriving after the relink window, is not the same order.
    const ask3 = zeros(21);
    ask3[9] = 90;
    tracker.update({ ts: T + 12_000, column: column(T + 12_000, 100, zeros(21), ask3), snapshot: snapshot({ asks: [rec(111, 0, 31), rec(109, 0, 0)] }), rowClusters: 1 });
    expect(tracker.levels().map((l) => [l.row, l.endedBy, l.chain])).toEqual([[115, "moved", 1], [113, "moved", 1], [111, "pulled", 1], [109, null, 0]]);
    const ask4 = zeros(21);
    ask4[9] = 90;
    ask4[17] = 32;
    tracker.update({ ts: T + 40_000, column: column(T + 40_000, 100, zeros(21), ask4), snapshot: snapshot({ asks: [rec(109, 0, 0), rec(117, 0, 0)] }), rowClusters: 1 });
    expect(tracker.levels().find((l) => l.row === 117)).toMatchObject({ chain: 0 });
  });

  test("a pulled wall whose successor appeared a moment before it left is linked too", () => {
    const tracker = fixed();
    const ask0 = zeros(21);
    ask0[15] = 30;
    tracker.update({ ts: T, column: column(T, 100, zeros(21), ask0), snapshot: snapshot({ asks: [rec(115, 0, 0)] }), rowClusters: 1 });
    // The bot places the new one first...
    const ask1 = zeros(21);
    ask1[15] = 30;
    ask1[113 - 100] = 29;
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, zeros(21), ask1), snapshot: snapshot({ asks: [rec(115, 0, 0), rec(113, 0, 0)] }), rowClusters: 1 });
    // ...then cancels the old one.
    const ask2 = zeros(21);
    ask2[13] = 29;
    tracker.update({ ts: T + 2000, column: column(T + 2000, 100, zeros(21), ask2), snapshot: snapshot({ asks: [rec(115, 0, 30), rec(113, 0, 0)] }), rowClusters: 1 });
    expect(tracker.levels().map((l) => [l.row, l.endedBy, l.chain])).toEqual([[115, "moved", 1], [113, null, 1]]);
  });

  test("beyond keepEndedMs only ended walls that meant something stay, up to deepKeepEndedMs", () => {
    const { DEEP_MIN_LIFE_MS } = require("../../../src/indicators/passive_liquidity/large-level-tracker");
    expect(() => fixed({ keepEndedMs: 10_000, deepKeepEndedMs: 5_000 })).toThrow(/deepKeepEndedMs/);
    const tracker = fixed({ keepEndedMs: 10_000, deepKeepEndedMs: 100_000 });
    // Rows 100..120, mid 110. Two ask walls above price: one flickers for a second, one rests over a minute.
    const ask0 = zeros(21);
    ask0[15] = 30;
    ask0[18] = 90;
    tracker.update({ ts: T, column: column(T, 100, zeros(21), ask0), snapshot: snapshot({ asks: [rec(115, 0, 0), rec(118, 0, 0)] }), rowClusters: 1 });
    const ask1 = zeros(21);
    ask1[18] = 90;
    tracker.update({ ts: T + 1_000, column: column(T + 1_000, 100, zeros(21), ask1), snapshot: snapshot({ asks: [rec(115, 0, 30), rec(118, 0, 0)] }), rowClusters: 1 });
    tracker.update({ ts: T + DEEP_MIN_LIFE_MS, column: column(T + DEEP_MIN_LIFE_MS, 100, zeros(21), zeros(21)), snapshot: snapshot({ asks: [rec(115, 0, 30), rec(118, 0, 90)] }), rowClusters: 1 });
    // The flicker ended 59 s ago, past keepEndedMs, and lived a second: gone. The minute-long wall just ended.
    expect(tracker.levels().map((l) => [l.row, l.endedBy])).toEqual([[118, "pulled"]]);
    // 20 s after the flicker ended it is past keepEndedMs and gone; the minute-long wall stays.
    tracker.update({ ts: T + DEEP_MIN_LIFE_MS + 20_000, column: column(T + DEEP_MIN_LIFE_MS + 20_000, 100, zeros(21), zeros(21)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.levels().map((l) => [l.row, l.endedBy])).toEqual([[118, "pulled"]]);
    // And it too leaves after deepKeepEndedMs.
    tracker.update({ ts: T + DEEP_MIN_LIFE_MS + 100_001, column: column(T + DEEP_MIN_LIFE_MS + 100_001, 100, zeros(21), zeros(21)), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.levels()).toEqual([]);
  });

  test("adopted traces keep their chains, shifted past the live ids", () => {
    const tracker = fixed();
    tracker.adopt([
      { side: "ask", row: 115, span: 1, startTs: T - 60_000, endTs: T - 50_000, size: 0, peak: 30, endedBy: "moved", chain: 1 },
      { side: "ask", row: 113, span: 1, startTs: T - 50_000, endTs: null, size: 29, peak: 29, endedBy: null, chain: 1 },
      { side: "bid", row: 100, span: 1, startTs: T - 40_000, endTs: null, size: 20, peak: 20, endedBy: null },
    ]);
    const adopted = tracker.levels();
    expect(adopted.map((l) => [l.row, l.endedBy, l.chain])).toEqual([[115, "moved", 2], [113, null, 2], [100, null, 0]]);
    // A live wall pulled and re-placed starts a chain of its own, never colliding with the adopted one.
    const ask0 = zeros(21);
    ask0[13] = 29;
    ask0[18] = 40;
    tracker.update({ ts: T, column: column(T, 100, zeros(21), ask0), snapshot: snapshot({ asks: [rec(113, 0, 0), rec(118, 0, 0)] }), rowClusters: 1 });
    const ask1 = zeros(21);
    ask1[13] = 29;
    ask1[19] = 41;
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, zeros(21), ask1), snapshot: snapshot({ asks: [rec(113, 0, 0), rec(118, 0, 40), rec(119, 0, 0)] }), rowClusters: 1 });
    const chains = new Set(tracker.levels().filter((l) => l.chain > 0).map((l) => l.chain));
    expect(chains.size).toBe(2);
    expect(tracker.levels().filter((l) => l.row === 118 || l.row === 119).map((l) => l.endedBy)).toEqual(["moved", null]);
  });

  test("sums the bands of a row when rows are wider than one band", () => {
    const tracker = fixed();
    // rowClusters 4: keys 400..403 are row 100.
    tracker.update({ ts: T, column: column(T, 100, [12], [0]), snapshot: snapshot({ bids: [rec(400, 1, 0), rec(403, 2, 0)] }), rowClusters: 4 });
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, [0], [0]), snapshot: snapshot({ bids: [rec(400, 7, 0), rec(403, 8, 1)] }), rowClusters: 4 });
    expect(tracker.levels()[0]).toMatchObject({ endedBy: "filled" });
  });

  test("a level whose row leaves the window ends (as pulled when nothing traded)", () => {
    const tracker = fixed();
    tracker.update({ ts: T, column: column(T, 100, [12, 0, 0], [0, 0, 0]) /* rows 100..102, mid 101: the wall is below price, not at it */, snapshot: snapshot(), rowClusters: 1 });
    // The ledger still knows the row (a record with size 0): that is a real ending, not an unknown.
    tracker.update({ ts: T + 1000, column: column(T + 1000, 200, [0], [0]), snapshot: snapshot({ bids: [rec(100, 0, 12)] }), rowClusters: 1 });
    expect(tracker.levels()[0]).toMatchObject({ endTs: T + 1000, endedBy: "pulled" });
  });

  test("ended levels are forgotten after keepEndedMs and capped at maxLevels; clear empties everything", () => {
    const tracker = fixed({ keepEndedMs: 5000, maxLevels: 2 });
    for (let i = 0; i < 3; i += 1) {
      tracker.update({ ts: T + i * 2000, column: column(T + i * 2000, 100 + i, [12], [0]), snapshot: snapshot(), rowClusters: 1 });
      tracker.update({ ts: T + i * 2000 + 1000, column: column(T + i * 2000 + 1000, 100 + i, [0], [0]), snapshot: snapshot({ bids: [rec(100 + i, 0, 12)] }), rowClusters: 1 });
    }
    expect(tracker.levels().map((l) => l.row)).toEqual([101, 102]);
    tracker.update({ ts: T + 20_000, column: column(T + 20_000, 100, [0], [0]), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.levels()).toEqual([]);
    tracker.update({ ts: T + 21_000, column: column(T + 21_000, 100, [12], [0]), snapshot: snapshot(), rowClusters: 1 });
    tracker.clear();
    expect(tracker.levels()).toEqual([]);
    expect(tracker.activeCount).toBe(0);
    expect(tracker.reference).toBe(0);
  });

  test("adopts walls measured elsewhere, keeping their ages, and baselines them on the next live column", () => {
    const tracker = fixed();
    tracker.adopt([
      { side: "bid", row: 100, span: 2, startTs: T - 300_000, endTs: null, size: 20, peak: 25, endedBy: null },
      { side: "ask", row: 108, span: 1, startTs: T - 400_000, endTs: T - 100_000, size: 0, peak: 30, endedBy: "filled" },
    ]);
    expect(tracker.activeCount).toBe(1);
    expect(tracker.levels()).toEqual([
      expect.objectContaining({ side: "ask", row: 108, endedBy: "filled", startTs: T - 400_000 }),
      expect.objectContaining({ side: "bid", row: 100, span: 2, startTs: T - 300_000, peak: 25, endedBy: null }),
    ]);
    expect(() => tracker.adopt("nope")).toThrow(/array/);
    // Its verdict counts trades from the first live column on, not the ones already in the recording.
    const bid = zeros(11);
    bid[0] = 12;
    bid[1] = 12;
    tracker.update({ ts: T, column: column(T, 100, bid, zeros(11)), snapshot: snapshot({ bids: [rec(100, 500, 40)] }), rowClusters: 1 });
    tracker.update({
      ts: T + 1_000,
      column: column(T + 1_000, 100, zeros(11), zeros(11)),
      snapshot: snapshot({ bids: [rec(100, 512, 40)] }), // 12 traded since adoption, nothing cancelled
      rowClusters: 1,
    });
    expect(tracker.levels().find((l) => l.row === 100)).toMatchObject({ endedBy: "filled", startTs: T - 300_000 });
  });

  test("a wall on rows the ledger has no record for is held as unknown, not ended; a known zero ends it; unknown too long ends it", () => {
    const { UNKNOWN_HOLD_MS } = require("../../../src/indicators/passive_liquidity/large-level-tracker");
    const tracker = fixed();
    tracker.adopt([{ side: "ask", row: 108, span: 1, startTs: T - 600_000, endTs: null, size: 120, peak: 120, endedBy: null }]);
    // The live ledger, freshly seeded near price, has no record at row 108: the column reads 0 there.
    const empty = column(T, 100, zeros(11), zeros(11));
    tracker.update({ ts: T, column: empty, snapshot: snapshot({ asks: [rec(101, 0, 0)] }), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 108, endedBy: null, startTs: T - 600_000 })]);
    // Still unknown a minute later: still held.
    tracker.update({ ts: T + 60_000, column: { ...empty, ts: T + 60_000 }, snapshot: snapshot({ asks: [rec(101, 0, 0)] }), rowClusters: 1 });
    expect(tracker.activeCount).toBe(1);
    // A diff mentions the row with size 0: now it is known to be gone.
    tracker.update({ ts: T + 61_000, column: { ...empty, ts: T + 61_000 }, snapshot: snapshot({ asks: [rec(108, 0, 120)] }), rowClusters: 1 });
    expect(tracker.levels()).toEqual([expect.objectContaining({ row: 108, endedBy: "pulled", endTs: T + 61_000 })]);

    // Never mentioned again: written off after the hold.
    const patient = fixed();
    patient.adopt([{ side: "bid", row: 103, span: 1, startTs: T - 600_000, endTs: null, size: 50, peak: 50, endedBy: null }]);
    patient.update({ ts: T, column: empty, snapshot: snapshot(), rowClusters: 1 });
    patient.update({ ts: T + UNKNOWN_HOLD_MS - 1, column: { ...empty, ts: T + UNKNOWN_HOLD_MS - 1 }, snapshot: snapshot(), rowClusters: 1 });
    expect(patient.activeCount).toBe(1);
    patient.update({ ts: T + UNKNOWN_HOLD_MS, column: { ...empty, ts: T + UNKNOWN_HOLD_MS }, snapshot: snapshot(), rowClusters: 1 });
    expect(patient.levels()).toEqual([expect.objectContaining({ row: 103, endedBy: "pulled" })]);
  });

  test("resting walls are never pushed out by ended ones; the largest resting ones win when too many", () => {
    const tracker = fixed({ maxLevels: 3 });
    // Two separate walls end early.
    tracker.update({ ts: T, column: column(T, 100, [12, 0, 12, 0, 0, 0, 0], zeros(7)), snapshot: snapshot(), rowClusters: 1 });
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, zeros(7), zeros(7)), snapshot: snapshot(), rowClusters: 1 });
    // Then four separate walls rest at once.
    tracker.update({ ts: T + 2000, column: column(T + 2000, 100, zeros(7), [11, 0, 40, 0, 12, 0, 30]), snapshot: snapshot(), rowClusters: 1 });
    const reported = tracker.levels();
    expect(reported).toHaveLength(3);
    expect(reported.every((l) => l.endedBy === null)).toBe(true);
    expect(reported.map((l) => l.peak).sort((a, b) => a - b)).toEqual([12, 30, 40]);
  });

  test("extend: a wall standing at the end of a replayed window hands its birth to the wall born there, live or ended, same side and rows only", () => {
    const tracker = fixed();
    tracker.update({ ts: T, column: column(T, 100, [12, 12, 0, 0, 0, 0, 0, 0, 12], zeros(9)), snapshot: snapshot(), rowClusters: 1 });
    tracker.update({ ts: T + 1000, column: column(T + 1000, 100, [12, 12, 0, 0, 0, 0, 0, 0, 0], zeros(9)), snapshot: snapshot({ bids: [rec(108, 0, 12)] }), rowClusters: 1 });
    expect(tracker.levels().map((l) => [l.row, l.startTs, l.endedBy])).toEqual([[100, T, null], [108, T, "hit"]]);
    const standing = [
      { side: "bid", row: 101, span: 1, startTs: T - 600_000, endTs: null, size: 15, peak: 40, endedBy: null, eaten: 0.25 },
      { side: "bid", row: 100, span: 2, startTs: T - 700_000, endTs: null, size: 15, peak: 15, endedBy: null },
      { side: "bid", row: 108, span: 1, startTs: T - 300_000, endTs: null, size: 12, peak: 12, endedBy: null },
      { side: "ask", row: 100, span: 2, startTs: T - 100_000, endTs: null, size: 12, peak: 12, endedBy: null },
      { side: "bid", row: 104, span: 1, startTs: T - 100_000, endTs: null, size: 12, peak: 12, endedBy: null },
      { side: "bid", row: 108, span: 1, startTs: T + 500, endTs: null, size: 12, peak: 12, endedBy: null },
    ];
    expect(tracker.extend(standing, { until: T, toleranceMs: 1_000 })).toEqual([{ id: 1, from: T, startTs: T - 600_000 }, { id: 2, from: T, startTs: T - 300_000 }]);
    expect(tracker.levels()).toEqual([
      expect.objectContaining({ row: 100, span: 2, startTs: T - 600_000, peak: 40, size: 24, eaten: 0.25, endedBy: null }),
      expect.objectContaining({ row: 108, startTs: T - 300_000, endedBy: "hit" }),
    ]);
    // A wall born outside the tolerance of the window's end is not the continuation.
    expect(tracker.extend([{ side: "bid", row: 100, span: 1, startTs: T - 900_000, endTs: null, size: 12, peak: 12, endedBy: null }], { until: T - 5_000, toleranceMs: 1_000 })).toEqual([]);
    // The next column reports the change even though the book did not move.
    expect(tracker.update({ ts: T + 2000, column: column(T + 2000, 100, [12, 12, 0, 0, 0, 0, 0, 0, 0], zeros(9)), snapshot: snapshot(), rowClusters: 1 })).toBe(true);
    expect(tracker.update({ ts: T + 3000, column: column(T + 3000, 100, [12, 12, 0, 0, 0, 0, 0, 0, 0], zeros(9)), snapshot: snapshot(), rowClusters: 1 })).toBe(false);
    // On its own: the other side never continues a wall, and a wall born before the window ended is not born at its end.
    const lone = fixed();
    lone.update({ ts: T, column: column(T, 100, [12, 0], [0, 0]), snapshot: snapshot(), rowClusters: 1 });
    expect(lone.extend([{ side: "ask", row: 100, span: 1, startTs: T - 100_000, endTs: null, size: 12, peak: 12, endedBy: null }], { until: T, toleranceMs: 1_000 })).toEqual([]);
    expect(lone.extend([{ side: "bid", row: 100, span: 1, startTs: T + 500, endTs: null, size: 12, peak: 12, endedBy: null }], { until: T, toleranceMs: 1_000 })).toEqual([]);
    expect(lone.levels()[0]).toMatchObject({ startTs: T });
    expect(() => tracker.extend("x", { until: T, toleranceMs: 1 })).toThrow(/array/);
    expect(() => tracker.extend([], { until: -1, toleranceMs: 1 })).toThrow(/until/);
    expect(() => tracker.extend([], { until: T, toleranceMs: -1 })).toThrow(/toleranceMs/);
    expect(() => tracker.extend([{ row: 1, span: 1, startTs: T }], { until: T, toleranceMs: 1 })).toThrow(/side/);
  });

  test("extend chains: the wall born at a window's end can itself have been extended, so an older window reaches further back", () => {
    const tracker = fixed();
    tracker.update({ ts: T, column: column(T, 100, [12, 0], [0, 0]), snapshot: snapshot(), rowClusters: 1 });
    expect(tracker.extend([{ side: "bid", row: 100, span: 1, startTs: T - 20_000, endTs: null, size: 12, peak: 12, endedBy: null }], { until: T, toleranceMs: 1_000 })).toHaveLength(1);
    expect(tracker.extend([{ side: "bid", row: 100, span: 1, startTs: T - 40_000, endTs: null, size: 12, peak: 12, endedBy: null }], { until: T - 20_000, toleranceMs: 1_000 })).toHaveLength(1);
    expect(tracker.levels()[0]).toMatchObject({ startTs: T - 40_000 });
  });

  test("over the cap, ended walls go by meaning: moved first, then pulls that never rested a minute, then pulls, then hits; walls price ate stay longest", () => {
    const { DEEP_MIN_LIFE_MS } = require("../../../src/indicators/passive_liquidity/large-level-tracker");
    const gone = (row, startTs, endTs, endedBy) => ({ side: "bid", row, span: 1, startTs, endTs, size: 0, peak: 30, endedBy });
    const tracker = fixed({ maxLevels: 4, keepEndedMs: 86_400_000 });
    // Oldest first: the walls that meant most ended longest ago.
    tracker.adopt([
      gone(100, T - 900_000, T - 800_000, "filled"),
      gone(101, T - 850_000, T - 700_000, "partial"),
      gone(102, T - 700_000, T - 600_000, "hit"),
      gone(103, T - 600_000, T - 400_000, "pulled"),
      gone(104, T - 300_000, T - 300_000 + DEEP_MIN_LIFE_MS - 1, "pulled"),
      gone(105, T - 200_000, T - 100_000, "moved"),
    ]);
    expect(tracker.levels().map((l) => [l.row, l.endedBy])).toEqual([[100, "filled"], [101, "partial"], [102, "hit"], [103, "pulled"]]);
    // Live: a flicker ends now, over the cap again; it goes, not the eaten walls from long ago.
    tracker.update({ ts: T, column: column(T, 100, zeros(10).map((_, i) => (i === 0 ? 12 : 0)), zeros(10)), snapshot: snapshot(), rowClusters: 1 });
    tracker.update({ ts: T + 1_000, column: column(T + 1_000, 100, zeros(10), zeros(10)), snapshot: snapshot({ bids: [rec(100, 0, 12)] }), rowClusters: 1 });
    expect(tracker.levels().map((l) => [l.row, l.endedBy])).toEqual([[100, "filled"], [101, "partial"], [102, "hit"], [103, "pulled"]]);
    // Between walls of one class the older goes first.
    const tie = fixed({ maxLevels: 2, keepEndedMs: 86_400_000 });
    tie.adopt([gone(100, T - 900_000, T - 800_000, "hit"), gone(101, T - 700_000, T - 600_000, "hit"), gone(102, T - 500_000, T - 400_000, "hit")]);
    expect(tie.levels().map((l) => l.row)).toEqual([101, 102]);
  });
});
