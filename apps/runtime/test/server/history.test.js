const {
  createHistoryBuffer,
  DEFAULT_MAX_BARS,
  DEFAULT_MAX_TRADES,
  DEFAULT_MAX_SEEN_TRADE_IDS,
  DEFAULT_MAX_MARKERS,
} = require("../../src/server/history");

function bar(tsOpen, closed = true) {
  return { type: "bar", symbol: "BTC-USDT", interval_ms: 60_000, ts_open: tsOpen, open: 1, high: 1, low: 1, close: 1, volume: 1, trade_count: 1, closed };
}

function trade(id) {
  return { type: "trade", symbol: "BTC-USDT", ts_exchange: id, price: 1, size: 1, side: "buy", trade_id: String(id) };
}

function marker(ts, tradeId = `m-${ts}`, size = 1) {
  return { type: "marker", symbol: "BTC-USDT", ts_exchange: ts, price: 1, size, side: "buy", trade_id: tradeId };
}

describe("server/history", () => {
  test("a fresh buffer is empty -- the honest no-storage-yet starting state", () => {
    const history = createHistoryBuffer();
    expect(history.snapshotBars()).toEqual([]);
    expect(history.snapshotTrades()).toEqual([]);
  });

  test("closed bars snapshot in ts_open order, regardless of arrival order", () => {
    const history = createHistoryBuffer();
    history.recordBar(bar(3));
    history.recordBar(bar(1));
    history.recordBar(bar(2));
    expect(history.snapshotBars().map((b) => b.ts_open)).toEqual([1, 2, 3]);
  });

  test("a still-forming bar (closed: false) is never recorded into history", () => {
    const history = createHistoryBuffer();
    history.recordBar(bar(1, false));
    expect(history.snapshotBars()).toEqual([]);
  });

  test("re-delivering the same ts_open replaces the entry and moves it to the chronological end, not a duplicate", () => {
    const history = createHistoryBuffer();
    history.recordBar(bar(1));
    history.recordBar(bar(2));
    const updated = { ...bar(1), close: 999 };
    history.recordBar(updated);
    const snapshot = history.snapshotBars();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((b) => b.ts_open)).toEqual([1, 2]);
    expect(snapshot[0]).toEqual(updated);
  });

  test("bars beyond maxBars evict the oldest first, not the newest", () => {
    const history = createHistoryBuffer({ maxBars: 3 });
    history.recordBar(bar(1));
    history.recordBar(bar(2));
    history.recordBar(bar(3));
    history.recordBar(bar(4));
    expect(history.snapshotBars().map((b) => b.ts_open)).toEqual([2, 3, 4]);
  });

  test("trades accumulate in arrival order and cap via FIFO drop of the oldest", () => {
    const history = createHistoryBuffer({ maxTrades: 3 });
    history.recordTrade(trade(1));
    history.recordTrade(trade(2));
    history.recordTrade(trade(3));
    history.recordTrade(trade(4));
    expect(history.snapshotTrades().map((t) => t.trade_id)).toEqual(["2", "3", "4"]);
  });

  test("a reconnect replay of an already-recorded trade id is ignored without consuming FIFO capacity", () => {
    const history = createHistoryBuffer({ maxTrades: 2, maxSeenTradeIds: 3 });
    expect(history.recordTrade(trade(1))).toBe(true);
    expect(history.recordTrade({ ...trade(1), price: 999 })).toBe(false);
    history.recordTrade(trade(2));
    history.recordTrade(trade(3));

    expect(history.snapshotTrades()).toEqual([trade(2), trade(3)]);
  });

  test("deduplicates replayed trades beyond the visible snapshot window", () => {
    const history = createHistoryBuffer({ maxTrades: 2, maxSeenTradeIds: 4 });
    history.recordTrade(trade(1));
    history.recordTrade(trade(2));
    history.recordTrade(trade(3));

    expect(history.snapshotTrades().map((entry) => entry.trade_id)).toEqual(["2", "3"]);
    expect(history.recordTrade(trade(1))).toBe(false);
    expect(history.snapshotTrades().map((entry) => entry.trade_id)).toEqual(["2", "3"]);
  });

  test("bounds the replay-deduplication index independently from visible history", () => {
    const history = createHistoryBuffer({ maxTrades: 1, maxSeenTradeIds: 2 });
    history.recordTrade(trade(1));
    history.recordTrade(trade(2));
    history.recordTrade(trade(3));

    expect(history.recordTrade(trade(1))).toBe(true);
    expect(history.snapshotTrades()).toEqual([trade(1)]);
  });

  test("rejects a trade missing its canonical trade_id instead of poisoning the replay-deduplication index", () => {
    const history = createHistoryBuffer();
    expect(() => history.recordTrade({ type: "trade" })).toThrow(/trade_id/);
  });

  test("snapshotBars/snapshotTrades return independent copies -- mutating one never corrupts the buffer's own state", () => {
    const history = createHistoryBuffer();
    history.recordBar(bar(1));
    const snapshot = history.snapshotBars();
    snapshot.push(bar(2));
    expect(history.snapshotBars()).toHaveLength(1);
  });

  test("defaults match the Python reference server's own caps", () => {
    expect(DEFAULT_MAX_BARS).toBe(10_080);
    expect(DEFAULT_MAX_TRADES).toBe(100);
    expect(DEFAULT_MAX_SEEN_TRADE_IDS).toBe(5_000);
  });

  test("rejects a non-positive-integer maxBars/maxTrades rather than silently accepting an unbounded buffer", () => {
    expect(() => createHistoryBuffer({ maxBars: 0 })).toThrow(/maxBars/);
    expect(() => createHistoryBuffer({ maxTrades: -1 })).toThrow(/maxTrades/);
    expect(() => createHistoryBuffer({ maxBars: 1.5 })).toThrow(/maxBars/);
    expect(() => createHistoryBuffer({ maxTrades: 2, maxSeenTradeIds: 1 })).toThrow(/maxSeenTradeIds/);
  });

  test("a fresh buffer has no markers", () => {
    const history = createHistoryBuffer();
    expect(history.snapshotMarkers()).toEqual([]);
  });

  test("markers snapshot chronologically and cap by dropping the smallest event (ties broken by oldest), regardless of arrival order", () => {
    const history = createHistoryBuffer({ maxMarkers: 3 });
    history.recordMarker(marker(3));
    history.recordMarker(marker(2));
    history.recordMarker(marker(4));
    history.recordMarker(marker(1));
    expect(history.snapshotMarkers().map((m) => m.ts_exchange)).toEqual([2, 3, 4]);
  });

  test("a marker never disappears purely because it aged, however far the clock advances -- only running out of capacity evicts anything", () => {
    const oneHourMs = 60 * 60 * 1000;
    const history = createHistoryBuffer({ maxMarkers: 100 });
    history.recordMarker(marker(0, "ancient"));

    for (let i = 0; i < 10; i += 1) {
      history.recordMarker(marker(1000 * oneHourMs + i, `much-later-${i}`, 1_000));
    }

    expect(history.snapshotMarkers().map((m) => m.trade_id)).toContain("ancient");
  });

  test("recordMarker returns false when the just-inserted marker is itself the one evicted -- it must not be broadcast as retained", () => {
    const history = createHistoryBuffer({ maxMarkers: 2 });
    history.recordMarker(marker(1, "big-a", 100));
    history.recordMarker(marker(2, "big-b", 100));

    expect(history.recordMarker(marker(3, "tiny", 1))).toBe(false);
    expect(history.snapshotMarkers().map((m) => m.trade_id)).toEqual(["big-a", "big-b"]);
  });

  test("equal-score retention has a stable trade-id tie-break regardless of arrival order", () => {
    const first = createHistoryBuffer({ maxMarkers: 1 });
    first.recordMarker(marker(1, "a", 100));
    first.recordMarker(marker(1, "b", 100));
    const second = createHistoryBuffer({ maxMarkers: 1 });
    second.recordMarker(marker(1, "b", 100));
    second.recordMarker(marker(1, "a", 100));

    expect(first.snapshotMarkers().map((m) => m.trade_id)).toEqual(["b"]);
    expect(second.snapshotMarkers().map((m) => m.trade_id)).toEqual(["b"]);
  });

  test("dxFeed futures retain by contracts, not price times contracts", () => {
    const history = createHistoryBuffer({ maxMarkers: 1 });
    history.recordMarker({ type: "marker", symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", ts_exchange: 1, price: 30_000, size: 5, side: "buy", trade_id: "five-contracts" });
    history.recordMarker({ type: "marker", symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", ts_exchange: 2, price: 20_000, size: 6, side: "buy", trade_id: "six-contracts" });

    expect(history.snapshotMarkers().map((m) => m.trade_id)).toEqual(["six-contracts"]);
  });

  test("bucketed retention keeps the largest trade in a bucket, not the one with the most favourable baseline", () => {
    // The old score returned a real z-score when a baseline was present and a sentinel 2 when it
    // wasn't, then compared the two. A tiny trade carrying a baseline therefore outranked a far
    // larger one that carried none, and evicted it from the bucket.
    const history = createHistoryBuffer({ maxMarkers: 10, markerBucketMs: 60_000, maxMarkersPerBucketSide: 1 });
    history.recordMarker({ ...marker(1_000, "large-no-baseline", 1_000) });
    history.recordMarker({
      ...marker(2_000, "small-with-baseline", 10),
      baseline_log_median: 0,
      baseline_log_mad: 0.05,
    });

    expect(history.snapshotMarkers().map((m) => m.trade_id)).toEqual(["large-no-baseline"]);
  });

  test("bucketed retention keeps one marker per bucket per side, so coverage spans time instead of clustering", () => {
    const history = createHistoryBuffer({ maxMarkers: 10, markerBucketMs: 60_000, maxMarkersPerBucketSide: 1 });
    history.recordMarker(marker(1_000, "bucket0-small", 1));
    history.recordMarker(marker(2_000, "bucket0-large", 500));
    history.recordMarker(marker(61_000, "bucket1-only", 1));

    expect(history.snapshotMarkers().map((m) => m.trade_id)).toEqual(["bucket0-large", "bucket1-only"]);
  });

  test("bucketed retention separates sides, so a large buy never crowds out the bucket's only sell", () => {
    const history = createHistoryBuffer({ maxMarkers: 10, markerBucketMs: 60_000, maxMarkersPerBucketSide: 1 });
    history.recordMarker({ ...marker(1_000, "big-buy", 1_000), side: "buy" });
    history.recordMarker({ ...marker(2_000, "small-sell", 1), side: "sell" });

    expect(history.snapshotMarkers().map((m) => m.trade_id).sort()).toEqual(["big-buy", "small-sell"]);
  });

  test("markers with the same exchange timestamp have deterministic trade-id ordering", () => {
    const history = createHistoryBuffer();
    history.recordMarker(marker(1, "b"));
    history.recordMarker(marker(1, "a"));
    expect(history.snapshotMarkers().map((m) => m.trade_id)).toEqual(["a", "b"]);
  });

  test("a duplicate trade_id is ignored, not double-recorded", () => {
    const history = createHistoryBuffer();
    expect(history.recordMarker(marker(1, "dup"))).toBe(true);
    expect(history.recordMarker(marker(2, "dup"))).toBe(false);
    expect(history.snapshotMarkers()).toHaveLength(1);
  });

  test("evicting a marker frees its trade_id -- a later re-occurrence (unlikely but not corrupting) is accepted, not silently blocked forever", () => {
    const history = createHistoryBuffer({ maxMarkers: 1 });
    history.recordMarker(marker(1, "a"));
    history.recordMarker(marker(2, "b"));
    expect(history.recordMarker(marker(3, "a"))).toBe(true);
    expect(history.snapshotMarkers().map((m) => m.trade_id)).toEqual(["a"]);
  });

  test("rejects a marker missing its trade_id", () => {
    const history = createHistoryBuffer();
    expect(() => history.recordMarker({ ts_exchange: 1 })).toThrow(/trade_id/);
  });

  test("rejects a marker with unusable retention fields without mutating history", () => {
    const history = createHistoryBuffer({ maxMarkers: 2 });
    history.recordMarker(marker(1, "kept", 10));
    const before = history.snapshotMarkers();
    expect(() => history.recordMarker(marker(-1, "bad-time", 10))).toThrow(/timestamp/);
    expect(() => history.recordMarker(marker(2, "bad-size", NaN))).toThrow(/significance/);
    expect(history.snapshotMarkers()).toEqual(before);
  });

  test("rejects a non-positive-integer marker option", () => {
    expect(() => createHistoryBuffer({ maxMarkers: 0 })).toThrow(/maxMarkers/);
    expect(() => createHistoryBuffer({ maxMarkers: 1.5 })).toThrow(/maxMarkers/);
  });

  test("time-covered marker retention keeps the strongest event per minute and side instead of starving later minutes", () => {
    const history = createHistoryBuffer({
      maxMarkers: 10,
      markerBucketMs: 60_000,
      maxMarkersPerBucketSide: 1,
    });
    history.recordMarker({ ...marker(1_000, "minute-0-weak", 10), side: "buy" });
    history.recordMarker({ ...marker(2_000, "minute-0-strong", 100), side: "buy" });
    history.recordMarker({ ...marker(3_000, "minute-0-sell", 50), side: "sell" });
    history.recordMarker({ ...marker(61_000, "minute-1", 20), side: "buy" });

    expect(history.snapshotMarkers().map((item) => item.trade_id)).toEqual([
      "minute-0-strong", "minute-0-sell", "minute-1",
    ]);
  });

  test("time-covered global capacity evicts the oldest covered minute, never a newer weak minute merely because an old event was larger", () => {
    const history = createHistoryBuffer({
      maxMarkers: 2,
      markerBucketMs: 60_000,
      maxMarkersPerBucketSide: 1,
    });
    history.recordMarker(marker(1_000, "old-huge", 1_000_000));
    history.recordMarker(marker(61_000, "middle", 10));
    history.recordMarker(marker(121_000, "new", 1));
    expect(history.snapshotMarkers().map((item) => item.trade_id)).toEqual(["middle", "new"]);
  });

  test("time-covered marker options must be supplied together and validated", () => {
    expect(() => createHistoryBuffer({ markerBucketMs: 60_000 })).toThrow(/maxMarkersPerBucketSide/);
    expect(() => createHistoryBuffer({ maxMarkersPerBucketSide: 1 })).toThrow(/markerBucketMs/);
  });

  test("time-covered marker selection keeps the stronger cold-start print even when the weaker one is newer", () => {
    const history = createHistoryBuffer({ maxMarkers: 10, markerBucketMs: 60_000, maxMarkersPerBucketSide: 1 });
    history.recordMarker(marker(1_000, "older-strong", 100));
    history.recordMarker(marker(2_000, "newer-weak", 10));

    expect(history.snapshotMarkers().map((item) => item.trade_id)).toEqual(["older-strong"]);
  });

  test("a bucket-side eviction followed by a global-cap eviction still finds the true oldest survivor, not a stale bucket loser", () => {
    const history = createHistoryBuffer({ maxMarkers: 2, markerBucketMs: 60_000, maxMarkersPerBucketSide: 1 });
    history.recordMarker(marker(1_000, "minute-0-weak", 10));
    history.recordMarker(marker(2_000, "minute-0-strong", 100));
    history.recordMarker(marker(61_000, "minute-1", 5));

    expect(history.snapshotMarkers().map((item) => item.trade_id)).toEqual(["minute-0-strong", "minute-1"]);
  });

  test("time-covered retention stays correct across enough churn to force the time-heap's own compaction", () => {
    const history = createHistoryBuffer({ maxMarkers: 50, markerBucketMs: 60_000, maxMarkersPerBucketSide: 1 });
    for (let minute = 0; minute < 1_000; minute += 1) {
      history.recordMarker(marker(minute * 60_000, `weak-${minute}`, 1));
      history.recordMarker(marker(minute * 60_000 + 1, `strong-${minute}`, 1_000));
    }
    const snapshot = history.snapshotMarkers();
    expect(snapshot).toHaveLength(50);
    expect(snapshot.every((item) => item.trade_id.startsWith("strong-"))).toBe(true);
    expect([...snapshot].sort((a, b) => a.ts_exchange - b.ts_exchange)).toEqual(snapshot);
  });

  test("time-covered global-cap eviction stays fast at scale -- an O(n) scan per insert would not clear this bar", () => {
    const history = createHistoryBuffer({ maxMarkers: 45_000, markerBucketMs: 60_000, maxMarkersPerBucketSide: 2 });
    const startedAt = Date.now();
    for (let i = 0; i < 200_000; i += 1) {
      // Each marker lands in its own minute/side bucket, so the bucket cap
      // never binds -- this exercises the global-cap eviction path itself.
      history.recordMarker(marker(i * 61_000, `m-${i}`, 1 + (i % 7)));
    }
    // 10s leaves ample room for full-suite parallel-worker contention; the
    // O(n)-scan regression this guards against takes 40-50s at this scale.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const snapshot = history.snapshotMarkers();
    expect(snapshot).toHaveLength(45_000);
    expect(snapshot.map((item) => item.trade_id)[0]).toBe("m-155000");
    expect(snapshot.map((item) => item.trade_id).at(-1)).toBe("m-199999");
  });

  test("markerMaxAgeMs evicts a marker older than the retention window on the next insertion, regardless of maxMarkers headroom", () => {
    const now = Date.now();
    const maxAgeMs = 60_000;
    const history = createHistoryBuffer({
      maxMarkers: 100,
      markerBucketMs: 1_000,
      maxMarkersPerBucketSide: 1,
      markerMaxAgeMs: maxAgeMs,
    });
    history.recordMarker(marker(now - maxAgeMs - 5_000, "expired"));
    history.recordMarker(marker(now, "fresh"));

    expect(history.snapshotMarkers().map((m) => m.trade_id)).toEqual(["fresh"]);
  });

  test("maxMarkers still caps the count once age governs retention too -- frames.js shares this same number as its wire hard-cap and has no notion of markerMaxAgeMs", () => {
    const now = Date.now();
    const maxAgeMs = 60_000;
    const history = createHistoryBuffer({
      maxMarkers: 3,
      markerBucketMs: 1_000,
      maxMarkersPerBucketSide: 1,
      markerMaxAgeMs: maxAgeMs,
    });
    history.recordMarker(marker(now - 50_000, "still-fresh"));
    for (let i = 0; i < 10; i += 1) {
      history.recordMarker(marker(now - 40_000 + i * 2_000, `filler-${i}`));
    }

    const ids = history.snapshotMarkers().map((m) => m.trade_id);
    expect(ids).toEqual(["filler-7", "filler-8", "filler-9"]);
  });

  test("production-scale config genuinely respects the 45,000 wire cap even with a 7-day age window configured", () => {
    const history = createHistoryBuffer({
      maxMarkers: 45_000,
      markerBucketMs: 60_000,
      maxMarkersPerBucketSide: 4,
      markerMaxAgeMs: 7 * 24 * 60 * 60_000,
    });
    const sideMarker = (ts, tradeId, side) => (
      { type: "marker", symbol: "BTC-USDT", ts_exchange: ts, price: 1, size: 1, side, trade_id: tradeId }
    );
    // 10,080 one-minute buckets span 7 days; filling each to its
    // maxMarkersPerBucketSide=4 on both sides offers 80,640 markers -- well
    // past 45,000 -- while staying inside the age window and never tripping
    // per-bucket-side eviction, so only the global count cap can be what
    // holds the final total at 45,000.
    const buckets = 10_080;
    const start = Date.now() - (buckets - 1) * 60_000 - 30_000;
    const startedAt = Date.now();
    for (let bucketIndex = 0; bucketIndex < buckets; bucketIndex += 1) {
      const ts = start + bucketIndex * 60_000;
      for (let slot = 0; slot < 4; slot += 1) {
        history.recordMarker(sideMarker(ts, `buy-${bucketIndex}-${slot}`, "buy"));
        history.recordMarker(sideMarker(ts, `sell-${bucketIndex}-${slot}`, "sell"));
      }
    }
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(history.snapshotMarkers()).toHaveLength(45_000);
  });

  test("defaults match the documented marker cap: a full seven-day window at the per-minute density, with headroom", () => {
    const sevenDaysAtFullDensity = 7 * 24 * 60 * 4 * 2;
    expect(DEFAULT_MAX_MARKERS).toBe(100_000);
    expect(DEFAULT_MAX_MARKERS).toBeGreaterThan(sevenDaysAtFullDensity);
  });

  test("evicts the chronologically oldest bar even after an old candle is corrected", () => {
    const history = createHistoryBuffer({ maxBars: 3 });
    history.recordBar(bar(2));
    history.recordBar(bar(3));
    history.recordBar(bar(4));
    history.recordBar({ ...bar(2), close: 99 });
    history.recordBar(bar(5));

    expect(history.snapshotBars().map((entry) => entry.ts_open)).toEqual([3, 4, 5]);
  });
});
