const { createAggressiveOrdersTracker, ringPercentile, DEFAULT_MAX_EVENTS } = require("../../../src/indicators/passive_liquidity/aggressive-orders-tracker");
const { MAX_AGGRESSIVE_EVENTS, MAX_WIRE_MAGNITUDE } = require("../../../src/server/frames");

const T = 1_700_000_000_000;
const S = 1_000;

// A ledger record: only `traded` matters to this tracker.
const rec = (key, traded, size = 1) => ({ key, size, traded, cancelled: 0, absorbed: 0 });
// A fixed floor of 10 keeps the scenarios readable; calibration has its own tests.
const fixed = (options = {}) => createAggressiveOrdersTracker({ floor: 10, gapMs: 3 * S, gapBands: 0, ...options });

/** Drive one tracker through ticks one second apart: each step is [asks records, bids records]. */
function drive(tracker, steps, start = T) {
  let changed = null;
  steps.forEach(([asks, bids], i) => {
    changed = tracker.update({ ts: start + i * S, column: { ts: start + i * S, lo: 0, hi: 0, bid: [], ask: [] }, snapshot: { bids, asks }, rowClusters: 1 });
  });
  return changed;
}

describe("aggressive-orders-tracker", () => {
  test("validates its options", () => {
    expect(() => createAggressiveOrdersTracker({ floor: -1 })).toThrow(/floor/);
    expect(() => createAggressiveOrdersTracker({ floorPercentile: 0 })).toThrow(/floorPercentile/);
    expect(() => createAggressiveOrdersTracker({ gapMs: 0 })).toThrow(/gapMs/);
    expect(() => createAggressiveOrdersTracker({ gapBands: -1 })).toThrow(/gapBands/);
    expect(() => createAggressiveOrdersTracker({ rowClusters: 0 })).toThrow(/rowClusters/);
    expect(() => createAggressiveOrdersTracker({ keepEndedMs: 0 })).toThrow(/keepEndedMs/);
    expect(() => createAggressiveOrdersTracker({ maxEvents: 0 })).toThrow(/maxEvents/);
  });

  test("ringPercentile reads the filled part of the ring", () => {
    const ring = Float64Array.from([5, 1, 9, 3, 0, 0]);
    expect(ringPercentile(ring, 4, 0)).toBe(1);
    expect(ringPercentile(ring, 4, 1)).toBe(9);
    expect(ringPercentile(ring, 4, 0.5)).toBe(5);
    expect(ringPercentile(ring, 0, 0.5)).toBe(0);
  });

  test("the first sight of a record is a baseline, not volume", () => {
    const tracker = fixed();
    drive(tracker, [[[rec(107, 50)], []], [[rec(107, 50)], []], [[rec(107, 50)], []]]);
    expect(tracker.events()).toEqual([]);
    expect(tracker.liveCount).toBe(0);
  });

  test("buyers print against asks: a cluster appears when its volume reaches the floor and grows while it keeps printing", () => {
    const tracker = fixed();
    // 4 a second lifting the ask at 107 from the second tick: 4, 8 (nothing yet), 12 (reported), 16.
    drive(tracker, [[[rec(107, 0)], []], [[rec(107, 4)], []], [[rec(107, 8)], []]]);
    expect(tracker.events()).toEqual([]);
    expect(tracker.liveCount).toBe(1);
    expect(drive(tracker, [[[rec(107, 12)], []]], T + 3 * S)).toBe(true);
    expect(tracker.events()).toEqual([
      expect.objectContaining({ side: "buy", row: 107, span: 1, startTs: T + S, endTs: null, volume: 12, peak: 4, floor: 10 }),
    ]);
    expect(drive(tracker, [[[rec(107, 22)], []]], T + 4 * S)).toBe(true);
    expect(tracker.events()[0]).toMatchObject({ volume: 22, peak: 10, endTs: null });
  });

  test("sellers print against bids, and are the other side", () => {
    const tracker = fixed();
    drive(tracker, [[[], [rec(103, 0)]], [[], [rec(103, 15)]]]);
    expect(tracker.events()).toEqual([expect.objectContaining({ side: "sell", row: 103, volume: 15, peak: 15, startTs: T + S })]);
  });

  test("a cluster ends when it has not printed for gapMs, at its last print, and stays on the list", () => {
    const tracker = fixed();
    drive(tracker, [[[rec(107, 0)], []], [[rec(107, 12)], []]]);
    // Quiet ticks: gapMs is 3 s, so the tick at T + 4 s (3 s after the last print) closes it.
    drive(tracker, [[[rec(107, 12)], []], [[rec(107, 12)], []]], T + 2 * S);
    expect(tracker.events()[0]).toMatchObject({ endTs: null });
    expect(drive(tracker, [[[rec(107, 12)], []]], T + 4 * S)).toBe(true);
    expect(tracker.events()).toEqual([expect.objectContaining({ side: "buy", startTs: T + S, endTs: T + S, volume: 12 })]);
    expect(tracker.liveCount).toBe(0);
  });

  test("a cluster under the floor when it ends is never shown, but it is learned from", () => {
    const tracker = createAggressiveOrdersTracker({ gapMs: 2 * S, gapBands: 0, warmupSamples: 1, recalibrateMs: 1 });
    // Nothing is reported while the floor is 0 (warming up); the cluster of 6 ends and becomes the first sample.
    drive(tracker, [[[rec(107, 0)], []], [[rec(107, 6)], []], [[rec(107, 6)], []], [[rec(107, 6)], []]]);
    expect(tracker.events()).toEqual([]);
    expect(tracker.samplesSeen).toBe(1);
    expect(tracker.floor).toBe(6);
  });

  test("prints within gapMs on the same level are one cluster; a print after the gap opens a new one", () => {
    const tracker = fixed();
    drive(tracker, [[[rec(107, 0)], []], [[rec(107, 12)], []], [[rec(107, 12)], []], [[rec(107, 24)], []]]);
    expect(tracker.events()).toEqual([expect.objectContaining({ volume: 24, peak: 12, startTs: T + S, endTs: null })]);
    // 3 s quiet, then a fresh 12: the first settles, a second opens.
    drive(tracker, [[[rec(107, 24)], []], [[rec(107, 24)], []], [[rec(107, 24)], []], [[rec(107, 36)], []]], T + 4 * S);
    expect(tracker.events()).toEqual([
      expect.objectContaining({ startTs: T + S, endTs: T + 3 * S, volume: 24 }),
      expect.objectContaining({ startTs: T + 7 * S, endTs: null, volume: 12 }),
    ]);
  });

  test("a sweep across neighbouring levels in one tick is one bubble spanning them", () => {
    const tracker = fixed({ gapBands: 1 });
    drive(tracker, [[[rec(107, 0), rec(108, 0), rec(109, 0)], []], [[rec(107, 5), rec(108, 5), rec(109, 5)], []]]);
    expect(tracker.events()).toEqual([expect.objectContaining({ side: "buy", row: 107, span: 3, volume: 15, peak: 15 })]);
  });

  test("two levels apart beyond gapBands are two bubbles, and each reports on its own", () => {
    const tracker = fixed({ gapBands: 0 });
    drive(tracker, [[[rec(107, 0), rec(109, 0)], []], [[rec(107, 12), rec(109, 3)], []]]);
    expect(tracker.events()).toEqual([expect.objectContaining({ row: 107, span: 1, volume: 12 })]);
    expect(tracker.liveCount).toBe(2);
  });

  test("a cluster is anchored to its level: a later print on the next level is a new cluster, not a wider one", () => {
    const tracker = fixed({ gapBands: 1 });
    drive(tracker, [[[rec(107, 0), rec(108, 0)], []], [[rec(107, 12), rec(108, 0)], []], [[rec(107, 15), rec(108, 11)], []]]);
    expect(tracker.events()).toEqual([
      expect.objectContaining({ row: 107, span: 1, volume: 15, startTs: T + S }),
      expect.objectContaining({ row: 108, span: 1, volume: 11, startTs: T + 2 * S }),
    ]);
    // Price walking one tick a second therefore leaves a trail of clusters that end, rather than one that never does.
    const walk = fixed({ gapBands: 1 });
    walk.update({ ts: T, snapshot: { bids: [], asks: [rec(100, 0), rec(101, 0), rec(102, 0), rec(103, 0)] }, rowClusters: 1 });
    walk.update({ ts: T + S, snapshot: { bids: [], asks: [rec(100, 1), rec(101, 0), rec(102, 0), rec(103, 0)] }, rowClusters: 1 });
    walk.update({ ts: T + 2 * S, snapshot: { bids: [], asks: [rec(100, 1), rec(101, 1), rec(102, 0), rec(103, 0)] }, rowClusters: 1 });
    walk.update({ ts: T + 3 * S, snapshot: { bids: [], asks: [rec(100, 1), rec(101, 1), rec(102, 1), rec(103, 0)] }, rowClusters: 1 });
    walk.update({ ts: T + 4 * S, snapshot: { bids: [], asks: [rec(100, 1), rec(101, 1), rec(102, 1), rec(103, 1)] }, rowClusters: 1 });
    expect(walk.liveCount).toBe(3); // the one at 100 went quiet for gapMs (3 s) and ended
  });

  test("buyers and sellers on the same level are two bubbles", () => {
    const tracker = fixed();
    drive(tracker, [[[rec(107, 0)], [rec(107, 0)]], [[rec(107, 12)], [rec(107, 20)]]]);
    expect(tracker.events()).toEqual([
      expect.objectContaining({ side: "buy", row: 107, volume: 12 }),
      expect.objectContaining({ side: "sell", row: 107, volume: 20 }),
    ]);
  });

  test("a record the ledger forgets is not a burst: deltas are measured per record", () => {
    const tracker = fixed();
    drive(tracker, [[[rec(107, 0), rec(108, 0)], []], [[rec(107, 30), rec(108, 30)], []]]);
    expect(tracker.events()).toEqual([expect.objectContaining({ volume: 60 })]);
    // The ledger drops 108; the level's total falls from 60 to 30, which is no new volume.
    expect(drive(tracker, [[[rec(107, 30)], []]], T + 2 * S)).toBe(false);
    expect(tracker.events()[0].volume).toBe(60);
  });

  test("a record forgotten and recreated counts what the new record holds, not a negative delta", () => {
    const tracker = fixed();
    drive(tracker, [[[rec(107, 0)], []], [[rec(107, 40)], []], [[rec(107, 15)], []]]);
    expect(tracker.events()[0].volume).toBe(55);
  });

  test("without a fixed floor nothing is reported until enough clusters have ended, then the floor is their percentile", () => {
    const tracker = createAggressiveOrdersTracker({ gapMs: 2 * S, gapBands: 0, warmupSamples: 10, recalibrateMs: 1, floorPercentile: 0.9 });
    // Ten clusters of 1..10, each printing once at its own level and then going quiet.
    let ts = T;
    for (let v = 1; v <= 10; v += 1) {
      tracker.update({ ts, snapshot: { bids: [], asks: [rec(100 + v, 0)] }, rowClusters: 1 });
      tracker.update({ ts: ts + S, snapshot: { bids: [], asks: [rec(100 + v, v)] }, rowClusters: 1 });
      ts += 4 * S;
    }
    tracker.update({ ts, snapshot: { bids: [], asks: [] }, rowClusters: 1 });
    expect(tracker.events()).toEqual([]);
    expect(tracker.samplesSeen).toBe(10);
    expect(tracker.floor).toBe(9);
    // A cluster of 9 now shows; one of 8 does not.
    tracker.update({ ts: ts + S, snapshot: { bids: [], asks: [rec(150, 0), rec(160, 0)] }, rowClusters: 1 });
    tracker.update({ ts: ts + 2 * S, snapshot: { bids: [], asks: [rec(150, 9), rec(160, 8)] }, rowClusters: 1 });
    expect(tracker.events()).toEqual([expect.objectContaining({ row: 150, volume: 9, floor: 9 })]);
  });

  test("minFloor floors the calibrated floor, and adopted events seed it after a restart until the ring is full", () => {
    const floored = createAggressiveOrdersTracker({ minFloor: 5, warmupSamples: 0, recalibrateMs: 1 });
    expect(floored.floor).toBe(5);
    const seeded = createAggressiveOrdersTracker({ warmupSamples: 3, gapMs: 2 * S, recalibrateMs: 1 });
    expect(seeded.floor).toBe(0);
    seeded.adopt([{ side: "buy", row: 107, span: 1, startTs: T - 60_000, endTs: T - 59_000, volume: 20, peak: 20, floor: 7 }]);
    expect(seeded.floor).toBe(7);
    // One cluster ends: the ring has one sample, fewer than the warm-up, so the seed still stands.
    drive(seeded, [[[rec(120, 0)], []], [[rec(120, 2)], []], [[rec(120, 2)], []], [[rec(120, 2)], []]]);
    expect(seeded.samplesSeen).toBe(4);
    expect(seeded.floor).toBe(7);
  });

  test("ended bubbles stay for keepEndedMs and the list is capped at maxEvents", () => {
    const tracker = fixed({ keepEndedMs: 5 * S, maxEvents: 2 });
    drive(tracker, [[[rec(101, 0), rec(111, 0), rec(121, 0)], []], [[rec(101, 12), rec(111, 12), rec(121, 12)], []]]);
    // The cap binds the whole list, open ones included: the two newest open clusters show, the oldest is cut.
    expect(tracker.events().map((e) => e.row)).toEqual([111, 121]);
    // All three end at T + 4 s; only the two most recently ended are kept.
    drive(tracker, [[[rec(101, 12), rec(111, 12), rec(121, 12)], []]], T + 4 * S);
    expect(tracker.events()).toHaveLength(2);
    // 5 s after they ended they are gone.
    drive(tracker, [[[], []]], T + S + 5 * S + S);
    expect(tracker.events()).toEqual([]);
  });

  test("works in ledger bands and reports in rows: three bands in one row are one bubble on that row", () => {
    const tracker = fixed({ rowClusters: 4, gapBands: 1 });
    const snap = (v) => ({ bids: [], asks: [rec(412, v), rec(413, v), rec(414, v)] });
    tracker.update({ ts: T, snapshot: snap(0), rowClusters: 4 });
    tracker.update({ ts: T + S, snapshot: snap(4), rowClusters: 4 });
    expect(tracker.events()).toEqual([expect.objectContaining({ side: "buy", row: 103, span: 1, volume: 12 })]);
    // Adopting the wire shape maps the row back to its bands: a new print on band 415 (row 103) is the same area, but a new cluster in time.
    const other = fixed({ rowClusters: 4 });
    other.adopt([{ side: "buy", row: 103, span: 1, startTs: T, endTs: T, volume: 12, peak: 12, floor: 10 }]);
    expect(other.events()).toEqual([expect.objectContaining({ row: 103, span: 1, volume: 12, endTs: T })]);
  });

  test("adopted events come back as history, an open one closed where it was", () => {
    const tracker = fixed();
    tracker.adopt([
      { side: "sell", row: 103, span: 2, startTs: T - 20_000, endTs: null, volume: 25, peak: 11, floor: 10 },
      { side: "buy", row: 107, span: 1, startTs: T - 40_000, endTs: T - 39_000, volume: 12, peak: 12, floor: 10 },
    ]);
    expect(tracker.events()).toEqual([
      expect.objectContaining({ side: "buy", row: 107, startTs: T - 40_000, endTs: T - 39_000, volume: 12 }),
      expect.objectContaining({ side: "sell", row: 103, span: 2, startTs: T - 20_000, endTs: T - 20_000, volume: 25, peak: 11 }),
    ]);
    expect(() => tracker.adopt([{ side: "bid", row: 1, span: 1, startTs: T }])).toThrow(/side/);
    expect(() => tracker.adopt("nope")).toThrow(/array/);
  });

  test("clear forgets the clusters and the baselines", () => {
    const tracker = fixed();
    drive(tracker, [[[rec(107, 0)], []], [[rec(107, 12)], []]]);
    tracker.clear();
    expect(tracker.events()).toEqual([]);
    // After clear the next tick is a baseline again: the 12 is history, not a print.
    drive(tracker, [[[rec(107, 12)], []], [[rec(107, 12)], []]], T + 2 * S);
    expect(tracker.events()).toEqual([]);
  });

  test("caps the combined open and ended list at maxEvents: newest open first, then newest ended, sorted for rendering", () => {
    const tracker = fixed({ maxEvents: 4 });
    tracker.adopt([
      { side: "sell", row: 1, span: 1, startTs: T - 30_000, endTs: T - 29_000, volume: 12, peak: 12, floor: 10 },
      { side: "sell", row: 2, span: 1, startTs: T - 20_000, endTs: T - 19_000, volume: 12, peak: 12, floor: 10 },
      { side: "sell", row: 3, span: 1, startTs: T - 10_000, endTs: T - 9_000, volume: 12, peak: 12, floor: 10 },
    ]);
    drive(tracker, [[[rec(100, 0), rec(200, 0), rec(300, 0)], []], [[rec(100, 12), rec(200, 12), rec(300, 12)], []]]);
    expect(tracker.liveCount).toBe(3);
    const events = tracker.events();
    expect(events).toHaveLength(4);
    expect(events.map((event) => [event.row, event.endTs])).toEqual([[3, T - 9_000], [100, null], [200, null], [300, null]]);

    const many = createAggressiveOrdersTracker({ floor: 1, gapMs: 3 * S, gapBands: 0 });
    const asks = (traded) => Array.from({ length: 201 }, (_, i) => rec(1_000 + i * 2, traded));
    drive(many, [[asks(0), []], [asks(5), []]]);
    expect(many.liveCount).toBe(201);
    expect(DEFAULT_MAX_EVENTS).toBe(MAX_AGGRESSIVE_EVENTS);
    const capped = many.events();
    expect(capped).toHaveLength(MAX_AGGRESSIVE_EVENTS);
    expect(capped[0].row).toBe(1_002);
    expect(capped.at(-1).row).toBe(1_400);
  });

  test("every reported field fits the wire: a configured floor above the wire magnitude is refused, a calibrated or adopted one is clamped", () => {
    expect(() => createAggressiveOrdersTracker({ floor: MAX_WIRE_MAGNITUDE })).not.toThrow();
    expect(() => createAggressiveOrdersTracker({ floor: MAX_WIRE_MAGNITUDE + 1 })).toThrow(/floor/);
    expect(() => createAggressiveOrdersTracker({ minFloor: MAX_WIRE_MAGNITUDE + 1 })).toThrow(/minFloor/);
    const tracker = createAggressiveOrdersTracker({ warmupSamples: 1, floorPercentile: 1, recalibrateMs: 1, gapMs: 3 * S, gapBands: 0 });
    drive(tracker, [[[rec(100, 0)], []], [[rec(100, 20_000_000)], []], [[rec(100, 20_000_000)], []], [[rec(100, 20_000_000)], []], [[rec(100, 20_000_000)], []]]);
    expect(tracker.samplesSeen).toBe(1);
    expect(tracker.floor).toBe(MAX_WIRE_MAGNITUDE);
    drive(tracker, [[[rec(100, 20_000_000), rec(200, 15_000_000)], []]], T + 5 * S);
    expect(tracker.events()).toEqual([expect.objectContaining({ row: 200, volume: MAX_WIRE_MAGNITUDE, peak: MAX_WIRE_MAGNITUDE, floor: MAX_WIRE_MAGNITUDE })]);
    const adopted = fixed();
    adopted.adopt([{ side: "buy", row: 7, span: 1, startTs: T, endTs: T, volume: 5, peak: 5, floor: MAX_WIRE_MAGNITUDE * 3 }]);
    expect(adopted.events()[0].floor).toBe(MAX_WIRE_MAGNITUDE);
  });
});
