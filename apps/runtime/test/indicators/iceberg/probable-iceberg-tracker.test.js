const fixture = require("../../fixtures/iceberg/probable-episodes.json");
const { createProbableIcebergTracker, PROBABLE_STATUS, PROBABLE_CONFIDENCE } = require("../../../src/indicators/iceberg/probable-iceberg-tracker");

const FIXED = Object.freeze({ ready: true, visibleFloor: 0.35, minDurationMs: 5000, ratioCut: 2, strongRatio: 3 });
const fixedCuts = (current = FIXED) => ({ current: () => current, observeTouch() {}, observeEpisode() {} });

function play(tracker, events) {
  const updates = [];
  for (const e of events) {
    const update = e.type === "trade"
      ? tracker.applyTrade({ price: e.price, size: e.size, aggressor: e.aggressor, ts: e.ts })
      : tracker.applyDepth({ side: e.side, price: e.price, size: e.size, ts: e.ts });
    if (update) updates.push(update);
  }
  const closed = tracker.sweep(events[events.length - 1].ts + 10_000);
  return updates.concat(closed);
}

describe("indicators/iceberg/probable-iceberg-tracker", () => {
  describe("captured Binance episodes", () => {
    const expected = Object.freeze({
      "perp-ask-80924.2-refill-8x": { minExecuted: 11, confidence: "strong" },
      "perp-ask-81249.9-refill-2x": { minExecuted: 9, confidence: "probable" },
      "perp-bid-82300.6-defended": { minExecuted: 20, confidence: "probable" },
      "perp-ask-85465-10-06-3x-23s": { minExecuted: 33, confidence: "strong" },
    });

    for (const c of fixture.cases.filter((x) => x.expect === "probable")) {
      test(`${c.name} is marked, grows while hit, and ends when the price goes quiet`, () => {
        const tracker = createProbableIcebergTracker({ symbol: c.symbol, marketKind: c.marketKind, cuts: fixedCuts() });
        const events = c.events.map((e) => ({ ...e, price: c.price, side: c.side }));
        const updates = play(tracker, events);
        expect(updates.length).toBeGreaterThan(0);
        const last = updates[updates.length - 1];
        expect(last).toMatchObject({ kind: "probable", symbol: c.symbol, marketKind: c.marketKind, side: c.side, price: c.price, status: "ended" });
        expect(last.executed).toBeGreaterThanOrEqual(expected[c.name].minExecuted);
        expect(last.ratio).toBeGreaterThanOrEqual(FIXED.ratioCut);
        expect(last.durationMs).toBeGreaterThanOrEqual(FIXED.minDurationMs);
        expect(last.display).toBeGreaterThanOrEqual(FIXED.visibleFloor);
        expect(last.confidence).toBe(expected[c.name].confidence);
        expect(updates[0].status).toBe("active");
        for (let i = 1; i < updates.length; i += 1) {
          expect(updates[i].executed).toBeGreaterThanOrEqual(updates[i - 1].executed);
          expect(updates[i].id).toBe(updates[0].id);
        }
        expect(Object.isFrozen(last)).toBe(true);
      });
    }

    test("a sub-second sweep through a stale level is rejected however large its ratio", () => {
      const c = fixture.cases.find((x) => x.expect === "reject");
      const tracker = createProbableIcebergTracker({ symbol: c.symbol, marketKind: c.marketKind, cuts: fixedCuts() });
      expect(play(tracker, c.events.map((e) => ({ ...e, price: c.price, side: c.side })))).toHaveLength(0);
    });
  });

  describe("the episode rule", () => {
    const base = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };
    const depth = (tracker, size, ts, side = "bid", price = 81000) => tracker.applyDepth({ side, price, size, ts });
    const hit = (tracker, size, ts, price = 81000, aggressor = "sell") => tracker.applyTrade({ price, size, aggressor, ts });

    function defended(tracker, { price = 81000, side = "bid", aggressor = "sell", shown = 1, perHit = 0.6, hits = 8, stepMs = 1000, start = 10_000 } = {}) {
      depth(tracker, shown, start - 100, side, price);
      let update = null;
      for (let i = 0; i < hits; i += 1) {
        const ts = start + i * stepMs;
        update = hit(tracker, perHit, ts, price, aggressor) || update;
        update = depth(tracker, shown, ts + 50, side, price) || update;
      }
      return update;
    }

    test("a level that keeps taking more than it shows, for long enough, becomes a probable iceberg while still active", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      const update = defended(tracker, { perHit: 0.3 });
      expect(update).toMatchObject({ kind: "probable", confidence: "probable", side: "bid", price: 81000, display: 1, status: "active", tranches: 1, refills: 0, hits: 8 });
      expect(update.executed).toBeCloseTo(2.4, 6);
      expect(update.ratio).toBeCloseTo(2.4, 6);
      expect(update.markedAt).toBe(16_000);
      expect(tracker.active()).toHaveLength(1);
    });

    test("aggressive buys belong to the ask level and aggressive sells to the bid level", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      expect(defended(tracker, { side: "ask", aggressor: "buy" })).toMatchObject({ side: "ask" });
      const wrongSide = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      expect(defended(wrongSide, { side: "ask", aggressor: "sell" })).toBeNull();
    });

    test("the level must have shown at least the learned floor", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      expect(defended(tracker, { shown: 0.3, perHit: 0.6 })).toBeNull();
    });

    test("the episode must last at least the learned duration", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      expect(defended(tracker, { hits: 8, stepMs: 500 })).toBeNull();
    });

    test("the ratio must reach the learned cut, and strong is the higher cut", () => {
      const weak = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      expect(defended(weak, { perHit: 0.2 })).toBeNull();
      const strong = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      expect(defended(strong, { perHit: 0.4, hits: 8 })).toMatchObject({ confidence: "strong" });
    });

    test("a marked level that later shows far more than it did keeps its mark but drops to weak", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      const marked = defended(tracker, { perHit: 0.3 });
      expect(marked.confidence).toBe("probable");
      const grown = depth(tracker, 5, marked.updatedAt + 100);
      expect(grown).toMatchObject({ id: marked.id, confidence: "weak", display: 5, status: "active" });
      expect(grown.ratio).toBeLessThan(FIXED.ratioCut);
      const ended = tracker.sweep(marked.updatedAt + 5000);
      expect(ended[0]).toMatchObject({ id: marked.id, confidence: "weak", status: "ended" });
      expect(PROBABLE_CONFIDENCE).toEqual(["strong", "probable", "weak"]);
    });

    test("the end snapshot's confidence follows its final ratio, so a level that grew just before going quiet ends weak, not strong", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      const marked = defended(tracker, { perHit: 0.4 });
      expect(marked.confidence).toBe("strong");
      depth(tracker, 5, marked.updatedAt + 1900);
      const ended = tracker.sweep(marked.updatedAt + 2001);
      expect(ended[0]).toMatchObject({ status: "ended", confidence: "weak", display: 5 });
      expect(ended[0].ratio).toBeLessThan(FIXED.ratioCut);
    });

    test("a gap longer than gapMs closes the episode; the next hit opens a new one", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(), gapMs: 2000 });
      const first = defended(tracker);
      const closed = tracker.sweep(first.updatedAt + 2001);
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({ id: first.id, status: "ended", durationMs: 7000 });
      expect(tracker.active()).toHaveLength(0);
      const second = defended(tracker, { start: first.updatedAt + 20_000 });
      expect(second.id).not.toBe(first.id);
      const late = hit(tracker, 0.3, second.updatedAt + 2001);
      expect(late).toMatchObject({ id: second.id, status: "ended" });
      expect(tracker.active()).toHaveLength(0);
      expect(tracker.openEpisodes()).toBe(1);
    });

    test("display is the largest size shown during the episode, tranches count the hits and refills are counted for the hover", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      depth(tracker, 1, 9900);
      hit(tracker, 0.9, 10_000); depth(tracker, 0.1, 10_050); depth(tracker, 2, 10_100);
      hit(tracker, 1.5, 11_500); depth(tracker, 0.5, 11_550); depth(tracker, 2, 11_600);
      hit(tracker, 1.5, 13_000); depth(tracker, 0.5, 13_050); depth(tracker, 2, 13_100);
      hit(tracker, 1.5, 14_500); depth(tracker, 0.5, 14_550); depth(tracker, 2, 14_600);
      hit(tracker, 1.5, 16_000); depth(tracker, 0.5, 16_050);
      const update = depth(tracker, 2, 17_100);
      expect(update).toMatchObject({ display: 2, tranches: 6, refills: 5, hits: 5, durationMs: 6000 });
      expect(update.executed).toBeCloseTo(6.9, 6);
    });

    test("while the cuts are not ready nothing is marked, but the cuts are still fed", () => {
      const observed = { touch: 0, episodes: [] };
      const learning = { current: () => Object.freeze({ ready: false }), observeTouch: () => { observed.touch += 1; }, observeEpisode: (e) => observed.episodes.push(e) };
      const tracker = createProbableIcebergTracker({ ...base, cuts: learning });
      expect(defended(tracker)).toBeNull();
      expect(observed.touch).toBe(1);
      tracker.sweep(100_000);
      expect(observed.episodes).toHaveLength(1);
      expect(observed.episodes[0]).toMatchObject({ durationMs: 7000, solid: true, hits: 8 });
      expect(observed.episodes[0].ratio).toBeCloseTo(4.8, 6);
    });

    test("solid is judged against the floor at the time the episode opened", () => {
      const observed = [];
      const cuts = { current: () => FIXED, observeTouch() {}, observeEpisode: (e) => observed.push(e) };
      const tracker = createProbableIcebergTracker({ ...base, cuts });
      defended(tracker, { shown: 0.3 });
      tracker.sweep(100_000);
      expect(observed[0].solid).toBe(false);
    });

    test("an episode on a level never seen in the book has no visible size and is only fed as a non-solid observation", () => {
      const observed = [];
      const cuts = { current: () => FIXED, observeTouch() {}, observeEpisode: (e) => observed.push(e) };
      const tracker = createProbableIcebergTracker({ ...base, cuts });
      for (let i = 0; i < 8; i += 1) expect(hit(tracker, 1, 10_000 + i * 1000)).toBeNull();
      tracker.sweep(100_000);
      expect(observed).toHaveLength(1);
      expect(observed[0].solid).toBe(false);
    });

    test("open episodes are bounded by maxOpenEpisodes, dropping the quietest first", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxOpenEpisodes: 2 });
      hit(tracker, 1, 10_000, 81000); hit(tracker, 1, 10_100, 81001); hit(tracker, 1, 10_200, 81002);
      expect(tracker.openEpisodes()).toBe(2);
    });

    test("an emptied level with no episode on it is forgotten, so many distinct empty levels leave nothing behind", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      for (let i = 0; i < 100_000; i += 1) depth(tracker, 0, 10_000 + i, i % 2 === 0 ? "bid" : "ask", 50_000 + i);
      expect(tracker.trackedLevels()).toBe(0);
      depth(tracker, 2, 200_000, "bid", 81_000);
      depth(tracker, 3, 200_000, "ask", 81_001);
      expect(tracker.trackedLevels()).toBe(2);
      depth(tracker, 0, 200_001, "bid", 81_000);
      expect(tracker.trackedLevels()).toBe(1);
      expect(tracker.openEpisodes()).toBe(0);
    });

    test("a level emptied while its episode is open stays watched, and is forgotten once that episode ends empty", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      depth(tracker, 1, 9900);
      let update = null;
      for (let i = 0; i < 8; i += 1) {
        update = hit(tracker, 0.6, 10_000 + i * 1000) || update;
        update = depth(tracker, 0, 10_050 + i * 1000) || update;
        update = depth(tracker, 1, 10_100 + i * 1000) || update;
      }
      expect(update).toMatchObject({ startedAt: 10_000, display: 1, refills: 8, hits: 8, status: "active" });
      depth(tracker, 0, 17_200);
      expect(tracker.trackedLevels()).toBe(1);
      expect(tracker.sweep(20_000)).toEqual([expect.objectContaining({ id: update.id, status: "ended" })]);
      expect(tracker.trackedLevels()).toBe(0);
    });

    test("a late hit that ends one episode and opens the next on an emptied level keeps that level watching the book", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      depth(tracker, 1, 9900);
      hit(tracker, 0.6, 10_000);
      depth(tracker, 0, 10_050);
      expect(hit(tracker, 0.6, 13_000)).toBeNull();
      let update = null;
      for (let i = 0; i < 8; i += 1) {
        update = depth(tracker, 1, 13_050 + i * 1000) || update;
        update = hit(tracker, 0.6, 14_000 + i * 1000) || update;
      }
      expect(update).toMatchObject({ startedAt: 13_000, display: 1, status: "active" });
      expect(tracker.openEpisodes()).toBe(1);
      expect(tracker.trackedLevels()).toBe(1);
    });

    test("an episode dropped at the cap leaves no empty level behind", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxOpenEpisodes: 2 });
      for (let i = 0; i < 1000; i += 1) hit(tracker, 1, 10_000 + i, 81_000 + i);
      expect(tracker.openEpisodes()).toBe(2);
      expect(tracker.trackedLevels()).toBe(2);
    });

    test("a hit refused because every open episode is marked leaves no level behind", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxOpenEpisodes: 1 });
      expect(defended(tracker)).toMatchObject({ status: "active" });
      for (let i = 0; i < 100; i += 1) expect(hit(tracker, 1, 17_100 + i, 82_000 + i)).toBeNull();
      expect(tracker.openEpisodes()).toBe(1);
      expect(tracker.trackedLevels()).toBe(1);
    });

    function hitsOnly(tracker, price, start) {
      let update = null;
      for (let i = 0; i < 8; i += 1) update = hit(tracker, 0.6, start + i * 1000, price) || update;
      return update;
    }

    test("levels that still show a size are capped at maxLevels, the ones farthest from the last trade forgotten first", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxLevels: 8 });
      hit(tracker, 0.1, 1_000, 81_000, "buy");
      tracker.sweep(5_000);
      for (let k = 0; k < 20; k += 1) depth(tracker, 1, 6_000 + k, "bid", 81_000 - k);
      expect(tracker.trackedLevels()).toBeLessThanOrEqual(8);
      expect(tracker.trackedLevels()).toBeGreaterThanOrEqual(7);
      expect(hitsOnly(tracker, 80_990, 10_000)).toBeNull();
      expect(hitsOnly(tracker, 81_000, 30_000)).toMatchObject({ price: 81_000, display: 1, startedAt: 30_000 });
    });

    test("without a trade yet the cap measures from the latest depth update", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxLevels: 10 });
      for (let k = 0; k < 100; k += 1) depth(tracker, 1, 6_000 + k, "bid", 80_000 + k);
      expect(tracker.trackedLevels()).toBeLessThanOrEqual(10);
      expect(hitsOnly(tracker, 80_000, 10_000)).toBeNull();
      expect(hitsOnly(tracker, 80_098, 30_000)).toMatchObject({ price: 80_098, display: 1 });
    });

    test("a level with an open episode is never forgotten at the cap, however far from the last trade", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxLevels: 4 });
      depth(tracker, 1, 9_900, "bid", 70_000);
      expect(hit(tracker, 0.6, 10_000, 70_000)).toBeNull();
      hit(tracker, 0.1, 10_050, 81_000, "buy");
      for (let k = 0; k < 20; k += 1) depth(tracker, 1, 10_100 + k, "bid", 81_000 - k);
      expect(tracker.trackedLevels()).toBeLessThanOrEqual(4 + 2);
      let update = null;
      for (let i = 1; i < 8; i += 1) update = hit(tracker, 0.6, 10_000 + i * 1000, 70_000) || update;
      expect(update).toMatchObject({ price: 70_000, startedAt: 10_000, display: 1 });
    });

    test("a level forgotten at the cap and hit again takes its first depth update as the baseline, not as a refill", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxLevels: 4 });
      depth(tracker, 1, 9_900, "bid", 70_000);
      hit(tracker, 0.1, 10_000, 81_000, "buy");
      for (let k = 0; k < 20; k += 1) depth(tracker, 1, 10_100 + k, "bid", 81_000 - k);
      expect(tracker.trackedLevels()).toBeLessThanOrEqual(4);
      expect(hit(tracker, 0.6, 11_000, 70_000)).toBeNull();
      expect(depth(tracker, 0.8, 11_050, "bid", 70_000)).toBeNull();
      expect(depth(tracker, 0.8, 11_100, "bid", 70_000)).toBeNull();
      let update = null;
      for (let i = 1; i < 8; i += 1) update = hit(tracker, 0.6, 11_000 + i * 1000, 70_000) || update;
      expect(update).toMatchObject({ price: 70_000, startedAt: 11_000, display: 0.8, refills: 0, tranches: 1, status: "active" });
      depth(tracker, 0.3, 18_100, "bid", 70_000);
      expect(depth(tracker, 0.8, 18_200, "bid", 70_000)).toMatchObject({ id: update.id, display: 0.8, refills: 1, tranches: 2 });
    });

    test("a seen level that shows 1.0, is hit, drops to 0.4 and comes back to 1.0 has refilled once", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      depth(tracker, 1, 9_900);
      hit(tracker, 0.6, 10_000);
      depth(tracker, 0.4, 10_050);
      expect(depth(tracker, 1, 10_100)).toBeNull();
      let update = null;
      for (let i = 1; i < 8; i += 1) update = hit(tracker, 0.6, 10_000 + i * 1000) || update;
      expect(update).toMatchObject({ startedAt: 10_000, display: 1, refills: 1, tranches: 2, hits: 8, status: "active" });
    });

    test("statuses, option checks and malformed input", () => {
      expect(PROBABLE_STATUS).toEqual(["active", "ended"]);
      expect(() => createProbableIcebergTracker({ ...base })).toThrow(/cuts/);
      expect(() => createProbableIcebergTracker({ symbol: "BTCUSDT", cuts: fixedCuts() })).toThrow(/marketKind/);
      expect(() => createProbableIcebergTracker({ ...base, cuts: fixedCuts(), gapMs: 0 })).toThrow(/gapMs/);
      expect(() => createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxLevels: 0 })).toThrow(/maxLevels/);
      expect(() => createProbableIcebergTracker({ ...base, cuts: fixedCuts(), maxLevels: 2.5 })).toThrow(/maxLevels/);
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      expect(() => tracker.applyTrade({ price: 1, size: -1, aggressor: "buy", ts: 1 })).toThrow(/size/);
      expect(() => tracker.applyTrade({ price: 1, size: 1, aggressor: "maker", ts: 1 })).toThrow(/aggressor/);
      expect(() => tracker.applyDepth({ side: "bid", price: 1, size: 1, ts: -1 })).toThrow(/ts/);
      expect(() => tracker.applyDepth({ side: "mid", price: 1, size: 1, ts: 1 })).toThrow(/side/);
    });
  });

  describe("out-of-order delivery", () => {
    const base = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };
    const loose = Object.freeze({ ready: true, visibleFloor: 2, minDurationMs: 0, ratioCut: 1, strongRatio: 1.5 });
    const ordered = (updates) => updates.every((update) => update.markedAt >= update.startedAt && update.updatedAt >= update.markedAt);

    test("a level marked on a depth update stays dated at or after its mark while active, and a trade dated before the mark that arrives after it moves nothing back", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(loose) });
      tracker.applyDepth({ side: "ask", price: 100, size: 1, ts: 900 });
      tracker.applyTrade({ price: 100, size: 1.5, aggressor: "buy", ts: 1000 });
      tracker.applyTrade({ price: 100, size: 1.5, aggressor: "buy", ts: 2000 });
      const marked = tracker.applyDepth({ side: "ask", price: 100, size: 2.5, ts: 2200 });
      expect(marked).toMatchObject({ status: "active", markedAt: 2200, updatedAt: 2200 });
      expect(tracker.active()).toEqual([expect.objectContaining({ markedAt: 2200, updatedAt: 2200 })]);
      const late = tracker.applyTrade({ price: 100, size: 0.5, aggressor: "buy", ts: 2100 });
      expect(late).toMatchObject({ executed: 3.5, markedAt: 2200, updatedAt: 2200 });
      expect(ordered([marked, late, ...tracker.active()])).toBe(true);
    });

    test("a depth change dated before a trade mark that arrives after it moves nothing back", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(loose) });
      tracker.applyDepth({ side: "ask", price: 100, size: 2.5, ts: 900 });
      tracker.applyTrade({ price: 100, size: 1.5, aggressor: "buy", ts: 1000 });
      const marked = tracker.applyTrade({ price: 100, size: 1.5, aggressor: "buy", ts: 2000 });
      expect(marked).toMatchObject({ markedAt: 2000, updatedAt: 2000 });
      const late = tracker.applyDepth({ side: "ask", price: 100, size: 3, ts: 1990 });
      expect(late).toMatchObject({ display: 3, markedAt: 2000, updatedAt: 2000 });
    });

    test("updates of one iceberg never go back in time, its mark never precedes its start, and its duration never shrinks", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts(loose) });
      tracker.applyDepth({ side: "ask", price: 100, size: 1, ts: 900 });
      tracker.applyTrade({ price: 100, size: 1.5, aggressor: "buy", ts: 1000 });
      tracker.applyTrade({ price: 100, size: 1.5, aggressor: "buy", ts: 2000 });
      const marked = tracker.applyDepth({ side: "ask", price: 100, size: 2.5, ts: 950 });
      expect(marked).toMatchObject({ startedAt: 1000, markedAt: 1000, updatedAt: 1000, durationMs: 1000 });
      const later = tracker.applyTrade({ price: 100, size: 1, aggressor: "buy", ts: 2300 });
      const earlier = tracker.applyTrade({ price: 100, size: 1, aggressor: "buy", ts: 1500 });
      expect(later).toMatchObject({ updatedAt: 2300, durationMs: 1300 });
      expect(earlier).toMatchObject({ executed: 5, updatedAt: 2300, durationMs: 1300 });
      const again = tracker.applyTrade({ price: 100, size: 1, aggressor: "buy", ts: 1600 });
      expect(again).toMatchObject({ executed: 6, updatedAt: 2300 });
      expect(tracker.sweep(10_000)).toEqual([expect.objectContaining({ status: "ended", updatedAt: 10_000 })]);
    });
  });

  describe("a lost book", () => {
    const base = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };
    const depth = (tracker, size, ts, side = "bid", price = 81000) => tracker.applyDepth({ side, price, size, ts });
    const hit = (tracker, size, ts, price = 81000, aggressor = "sell") => tracker.applyTrade({ price, size, aggressor, ts });
    const learning = () => {
      const seen = [];
      return { seen, current: () => FIXED, observeTouch() {}, observeEpisode(episode) { seen.push(episode); } };
    };
    function defended(tracker, { price = 81000, perHit = 0.3, hits = 8, start = 10_000 } = {}) {
      depth(tracker, 1, start - 100, "bid", price);
      for (let i = 0; i < hits; i += 1) {
        hit(tracker, perHit, start + i * 1000, price);
        depth(tracker, 1, start + i * 1000 + 50, "bid", price);
      }
    }

    test("a reset ends every marked episode at the reset time, drops the open ones and every level, and teaches the cuts nothing", () => {
      const cuts = learning();
      const tracker = createProbableIcebergTracker({ ...base, cuts });
      defended(tracker);
      depth(tracker, 1, 16_500, "bid", 80990);
      hit(tracker, 0.2, 16_600, 80990);
      expect(tracker.active()).toHaveLength(1);
      expect(tracker.openEpisodes()).toBe(2);
      expect(tracker.trackedLevels()).toBe(2);
      const ended = tracker.reset(18_000);
      expect(ended).toEqual([expect.objectContaining({ status: "ended", side: "bid", price: 81000, updatedAt: 18_000, hits: 8 })]);
      expect(cuts.seen).toEqual([]);
      expect(tracker.active()).toEqual([]);
      expect(tracker.openEpisodes()).toBe(0);
      expect(tracker.trackedLevels()).toBe(0);
      expect(tracker.sweep(60_000)).toEqual([]);
      expect(tracker.reset(18_500)).toEqual([]);
      expect(() => tracker.reset(-1)).toThrow();
    });

    test("after a reset the level starts over from the next depth, and a defended level is marked again", () => {
      const tracker = createProbableIcebergTracker({ ...base, cuts: fixedCuts() });
      defended(tracker);
      tracker.reset(18_000);
      expect(tracker.active()).toEqual([]);
      defended(tracker, { start: 30_000 });
      expect(tracker.active()).toEqual([expect.objectContaining({ status: "active", price: 81000, hits: 8 })]);
    });
  });
});
