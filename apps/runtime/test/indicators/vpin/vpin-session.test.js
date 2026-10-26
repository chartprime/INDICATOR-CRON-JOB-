const {
  deriveDailyVolumesUsd,
  createVpinSession,
  pollLive,
  runBackfill,
  seedSessionFromBackfill,
  currentReading,
  applyLivePollResult,
} = require("../../../src/indicators/vpin/vpin-session");

function slicedRowsFromTrades(trades, fromTs, toTs, sliceMs) {
  const bySlice = new Map();
  for (const trade of trades) {
    if (trade.ts < fromTs || trade.ts >= toTs) continue;
    const bucket = Math.floor(trade.ts / sliceMs);
    const entry = bySlice.get(bucket) ?? { buyNotional: 0, sellNotional: 0, sliceTs: trade.ts };
    const value = trade.price * trade.size;
    if (trade.side === "buy") entry.buyNotional += value;
    else if (trade.side === "sell") entry.sellNotional += value;
    entry.sliceTs = Math.max(entry.sliceTs, trade.ts);
    bySlice.set(bucket, entry);
  }
  return [...bySlice.keys()].sort((a, b) => a - b).map((bucket) => bySlice.get(bucket));
}

function fakeSlicedAdapter(trades) {
  return {
    readSlicedNotional(fromTs, toTs, sliceMs) {
      return { rows: slicedRowsFromTrades(trades, fromTs, toTs, sliceMs), available: true };
    },
    readTradesSince() {
      throw new Error("readTradesSince should never be called when readSlicedNotional is available");
    },
  };
}

function rawTrade(ts, price, size, side) {
  return { ts, price, size, side };
}

function fakeTradeAdapter(trades) {
  return {
    readTradesSince(fromTs, toTs, cursor, limit) {
      const sorted = [...trades].sort((a, b) => a.ts - b.ts);
      const startIndex = cursor ?? sorted.findIndex((t) => t.ts >= fromTs);
      const from = startIndex === -1 ? sorted.length : startIndex;
      const window = sorted.slice(from).filter((t) => t.ts <= toTs);
      const page = window.slice(0, limit);
      const nextIndex = from + page.length;
      return {
        rows: page.map((t) => ({ ts: t.ts, tradeId: String(t.ts), price: t.price, size: t.size, side: t.side })),
        nextCursor: page.length > 0 ? nextIndex : null,
        available: true,
      };
    },
  };
}

function unavailableTradeAdapter() {
  return { readTradesSince: () => ({ rows: [], nextCursor: null, available: false }) };
}

function fakeRollupAdapter(rows) {
  return { readMinuteRollup: () => ({ rows, available: true }) };
}

function fullPageNullCursorAdapter(trades) {
  return {
    readTradesSince(_fromTs, _toTs, _cursor, limit) {
      const page = trades.slice(0, limit);
      return {
        rows: page.map((t) => ({ ts: t.ts, tradeId: String(t.ts), price: t.price, size: t.size, side: t.side })),
        nextCursor: null,
        available: true,
      };
    },
  };
}

// Answers the exact same fixed page every call, unconditionally -- used to
// prove a permanently malformed row (same shape a real provider's tape
// could carry forever at a fixed position) doesn't get any worse on retry.
function fixedPageAdapter(trades) {
  return {
    readTradesSince: () => ({
      rows: trades.map((t) => ({ ts: t.ts, tradeId: String(t.ts), price: t.price, size: t.size, side: t.side })),
      nextCursor: null,
      available: true,
    }),
  };
}

describe("server/vpin-session", () => {
  describe("deriveDailyVolumesUsd", () => {
    test("sums volume * (priceBucket * tickSize) per calendar day across multiple price buckets and minutes", async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const adapter = fakeRollupAdapter([
        { minuteTs: 0, priceBucket: 100, volume: 2 },
        { minuteTs: 60_000, priceBucket: 101, volume: 3 },
        { minuteTs: dayMs, priceBucket: 100, volume: 5 },
      ]);
      const result = await deriveDailyVolumesUsd({ adapter, tickSize: 1, fromTs: 0, toTs: dayMs * 2 });
      expect(result).toHaveLength(2);
      expect(result).toContain(2 * 100 + 3 * 101);
      expect(result).toContain(5 * 100);
    });

    test("returns null when the adapter reports unavailable", async () => {
      const adapter = { readMinuteRollup: () => ({ rows: [], available: false }) };
      expect(await deriveDailyVolumesUsd({ adapter, tickSize: 1, fromTs: 0, toTs: 1_000 })).toBeNull();
    });

    test("uses the database-native daily-notional aggregate when available, avoiding a minute-by-price materialization", async () => {
      const readDailyNotional = jest.fn(() => ({
        available: true,
        rows: [{ dayTs: 0, notional: 123 }, { dayTs: 86_400_000, notional: 456 }],
      }));
      const readMinuteRollup = jest.fn();
      const result = await deriveDailyVolumesUsd({ adapter: { readDailyNotional, readMinuteRollup }, tickSize: 1, fromTs: 0, toTs: 172_800_000 });
      expect(result).toEqual([123, 456]);
      expect(readMinuteRollup).not.toHaveBeenCalled();
    });

    test("skips a row with a non-positive derived price or a non-finite volume, without throwing", async () => {
      const adapter = fakeRollupAdapter([
        { minuteTs: 0, priceBucket: 0, volume: 5 },
        { minuteTs: 0, priceBucket: -1, volume: 5 },
        { minuteTs: 0, priceBucket: 10, volume: NaN },
        { minuteTs: 0, priceBucket: 10, volume: 2 },
      ]);
      const result = await deriveDailyVolumesUsd({ adapter, tickSize: 1, fromTs: 0, toTs: 1_000 });
      expect(result).toEqual([20]);
    });

    test("rejects invalid inputs", async () => {
      const adapter = fakeRollupAdapter([]);
      await expect(deriveDailyVolumesUsd({ adapter: {}, tickSize: 1, fromTs: 0, toTs: 1 })).rejects.toThrow(/readMinuteRollup/);
      await expect(deriveDailyVolumesUsd({ adapter, tickSize: 0, fromTs: 0, toTs: 1 })).rejects.toThrow(/tickSize/);
      await expect(deriveDailyVolumesUsd({ adapter, tickSize: 1, fromTs: -1, toTs: 1 })).rejects.toThrow(/fromTs/);
      await expect(deriveDailyVolumesUsd({ adapter, tickSize: 1, fromTs: 10, toTs: 5 })).rejects.toThrow(/toTs/);
    });
  });

  describe("createVpinSession", () => {
    test("initializes pollFromTs to nowMs and pollCursor to null", async () => {
      const adapter = fakeTradeAdapter([]);
      const session = createVpinSession({ adapter, vBucket: 10, nowMs: 5_000 });
      expect(session.pollFromTs).toBe(5_000);
      expect(session.pollCursor).toBeNull();
      expect(session.vpinState.zVpin).toBeNull();
    });

    test("rejects an adapter missing readTradesSince, and an invalid nowMs", async () => {
      expect(() => createVpinSession({ adapter: {}, vBucket: 10, nowMs: 0 })).toThrow(/readTradesSince/);
      expect(() => createVpinSession({ adapter: fakeTradeAdapter([]), vBucket: 10, nowMs: -1 })).toThrow(/nowMs/);
    });

    test("starts with an empty history", async () => {
      const session = createVpinSession({ adapter: fakeTradeAdapter([]), vBucket: 10, nowMs: 0 });
      expect(session.history).toEqual([]);
    });
  });

  describe("pollLive", () => {
    test("applies newly available trades and reports how many buckets sealed", async () => {
      const adapter = fakeTradeAdapter([
        rawTrade(1_000, 1, 10, "buy"),
        rawTrade(2_000, 1, 10, "sell"),
      ]);
      const session = createVpinSession({ adapter, vBucket: 10, nowMs: 0 });
      const result = await pollLive(session, 5_000);
      expect(result.tradesApplied).toBe(2);
      expect(result.sealedCount).toBe(2);
      expect(session.pollCursor).toBe(2);
    });

    test("a second poll with no new trades applies nothing -- no double-counting via the cursor", async () => {
      const adapter = fakeTradeAdapter([rawTrade(1_000, 1, 10, "buy")]);
      const session = createVpinSession({ adapter, vBucket: 100, nowMs: 0 });
      await pollLive(session, 5_000);
      const totalAccAfterFirst = session.vpinState.sealer.buyAcc;
      const second = await pollLive(session, 5_000);
      expect(second.tradesApplied).toBe(0);
      expect(session.vpinState.sealer.buyAcc).toBe(totalAccAfterFirst);
    });

    test("a later poll only applies trades that arrived since the cursor, not the whole history again", async () => {
      const trades = [rawTrade(1_000, 1, 10, "buy")];
      const adapter = fakeTradeAdapter(trades);
      const session = createVpinSession({ adapter, vBucket: 1_000, nowMs: 0 });
      await pollLive(session, 2_000);
      trades.push(rawTrade(3_000, 1, 10, "sell"));
      const second = await pollLive(session, 4_000);
      expect(second.tradesApplied).toBe(1);
    });

    test("paginates across multiple pages up to maxPagesPerTick, resuming later from where it stopped", async () => {
      const trades = Array.from({ length: 25 }, (_, i) => rawTrade(1_000 + i, 1, 1, "buy"));
      const adapter = fakeTradeAdapter(trades);
      const session = createVpinSession({ adapter, vBucket: 1_000_000, nowMs: 0 });
      const first = await pollLive(session, 10_000, { pageLimit: 10, maxPagesPerTick: 2 });
      expect(first.tradesApplied).toBe(20);
      expect(first.pagesFetched).toBe(2);
      const second = await pollLive(session, 10_000, { pageLimit: 10, maxPagesPerTick: 2 });
      expect(second.tradesApplied).toBe(5);
    });

    test("rejects nowMs before the session's own pollFromTs", async () => {
      const session = createVpinSession({ adapter: fakeTradeAdapter([]), vBucket: 10, nowMs: 5_000 });
      await expect(pollLive(session, 1_000)).rejects.toThrow(/nowMs/);
    });

    test("reports unavailable input without advancing the session", async () => {
      const session = createVpinSession({ adapter: unavailableTradeAdapter(), vBucket: 10, nowMs: 0 });
      const before = structuredClone(session.vpinState);
      await expect(pollLive(session, 1_000)).rejects.toThrow(/source unavailable/);
      expect(session.vpinState).toEqual(before);
      expect(session.pollFromTs).toBe(0);
      expect(session.pollCursor).toBeNull();
    });

    test("stops after one page when the adapter returns a null cursor even though the page exactly filled the limit -- never re-fetches or double-counts", async () => {
      const trades = Array.from({ length: 5 }, (_, i) => rawTrade(1_000 + i, 1, 10, "buy"));
      const adapter = fullPageNullCursorAdapter(trades);
      const session = createVpinSession({ adapter, vBucket: 1_000_000, nowMs: 0 });
      const result = await pollLive(session, 10_000, { pageLimit: 5, maxPagesPerTick: 10 });
      expect(result.pagesFetched).toBe(1);
      expect(result.tradesApplied).toBe(5);
    });

    // vBucket is deliberately far above any single trade's own value (2_000)
    // in both tests below so a valid trade can never seal on its own -- if
    // it were wrongly ingested before the throw, buyAcc would read 2_000
    // instead of 0. A smaller vBucket would let it seal and reset buyAcc
    // back to 0 by itself, masking exactly the corruption these tests exist
    // to catch.
    test("a malformed trade anywhere in a page leaves vpinState completely untouched -- no partial ingestion of the valid trades before it", async () => {
      const adapter = fixedPageAdapter([
        rawTrade(1_000, 100, 20, "buy"),
        rawTrade(1_001, NaN, 20, "buy"),
        rawTrade(1_002, 100, 20, "buy"),
      ]);
      const session = createVpinSession({ adapter, vBucket: 10_000, nowMs: 0 });
      await expect(pollLive(session, 5_000)).rejects.toThrow(/price/);
      expect(session.vpinState.sealer.buyAcc).toBe(0);
      expect(session.vpinState.lastSealTs).toBeNull();
      expect(session.history).toEqual([]);
    });

    test("retrying after a malformed trade does not re-apply the valid trades that came before it in the same page", async () => {
      const adapter = fixedPageAdapter([
        rawTrade(1_000, 100, 20, "buy"),
        rawTrade(1_001, NaN, 20, "buy"),
      ]);
      const session = createVpinSession({ adapter, vBucket: 10_000, nowMs: 0 });
      await expect(pollLive(session, 5_000)).rejects.toThrow();
      await expect(pollLive(session, 5_000)).rejects.toThrow();
      await expect(pollLive(session, 5_000)).rejects.toThrow();
      expect(session.vpinState.sealer.buyAcc).toBe(0);
      expect(session.vpinState.lastSealTs).toBeNull();
      expect(session.history).toEqual([]);
    });

    test("appends each newly sealed bucket to session.history, in order, across separate poll ticks", async () => {
      const trades = [rawTrade(1_000, 1, 10, "buy")];
      const adapter = fakeTradeAdapter(trades);
      const session = createVpinSession({ adapter, vBucket: 10, nowMs: 0 });
      await pollLive(session, 2_000);
      expect(session.history).toHaveLength(1);
      expect(session.history[0].sealTs).toBe(1_000);

      trades.push(rawTrade(3_000, 1, 10, "sell"));
      await pollLive(session, 4_000);
      expect(session.history).toHaveLength(2);
      expect(session.history.map((reading) => reading.sealTs)).toEqual([1_000, 3_000]);
    });

    test("bounds session.history to maxHistory, dropping the oldest reading first", async () => {
      const trades = Array.from({ length: 5 }, (_, i) => rawTrade(1_000 + i, 1, 10, "buy"));
      const adapter = fakeTradeAdapter(trades);
      const session = createVpinSession({ adapter, vBucket: 10, nowMs: 0 });
      await pollLive(session, 10_000, { maxHistory: 3 });
      expect(session.history).toHaveLength(3);
      expect(session.history.map((reading) => reading.sealTs)).toEqual([1_002, 1_003, 1_004]);
    });
  });

  describe("currentReading", () => {
    test("carries the session's lastSealTs alongside a snapshot of its engine state", async () => {
      const adapter = fakeTradeAdapter([rawTrade(1_000, 1, 10, "buy")]);
      const session = createVpinSession({ adapter, vBucket: 5, nowMs: 0 });
      await pollLive(session, 2_000);
      const reading = currentReading(session);
      expect(reading.sealTs).toBe(1_000);
      expect(reading.active).toBe(false);
      expect(reading.direction).toBeNull();
    });

    test("sealTs is null before any bucket has ever sealed", async () => {
      const session = createVpinSession({ adapter: fakeTradeAdapter([]), vBucket: 5, nowMs: 0 });
      expect(currentReading(session).sealTs).toBeNull();
    });
  });

  describe("applyLivePollResult", () => {
    test("atomically installs a worker result and bounds its returned readings", async () => {
      const session = createVpinSession({ adapter: fakeTradeAdapter([]), vBucket: 10, nowMs: 100 });
      const workerState = createVpinSession({ adapter: fakeTradeAdapter([]), vBucket: 10, nowMs: 100 }).vpinState;
      const readings = [
        { sealTs: 101, active: false, direction: null, strength: 0, zVpin: null, zVelocity: null, zAcceleration: null, activatedAtTs: null },
        { sealTs: 102, active: false, direction: null, strength: 0, zVpin: null, zVelocity: null, zAcceleration: null, activatedAtTs: null },
      ];
      expect(applyLivePollResult(session, { vpinState: workerState, pollFromTs: 100, pollCursor: { ts: 102, id: 2 }, readings }, 1))
        .toEqual(readings);
      expect(session.vpinState).toBe(workerState);
      expect(session.pollCursor).toEqual({ ts: 102, id: 2 });
      expect(session.history).toEqual([readings[1]]);
    });

    test("rejects a malformed worker result without changing the live session", async () => {
      const session = createVpinSession({ adapter: fakeTradeAdapter([]), vBucket: 10, nowMs: 100 });
      const originalState = session.vpinState;
      expect(() => applyLivePollResult(session, { vpinState: {}, pollFromTs: 100, pollCursor: null, readings: [{ sealTs: -1 }] }))
        .toThrow(/invalid reading/);
      expect(session.vpinState).toBe(originalState);
      expect(session.pollCursor).toBeNull();
      expect(session.history).toEqual([]);
    });
  });

  describe("seedSessionFromBackfill", () => {
    test("replays trades into the session's own vpinState in place, not a fresh throwaway state", async () => {
      const adapter = fakeTradeAdapter([
        rawTrade(1_000, 1, 10, "buy"),
        rawTrade(2_000, 1, 10, "sell"),
      ]);
      const session = createVpinSession({ adapter, vBucket: 10, nowMs: 0 });
      const result = await seedSessionFromBackfill(session, 0, 10_000);
      expect(result.tradesApplied).toBe(2);
      expect(result.readings).toHaveLength(2);
      expect(session.vpinState.lastSealTs).toBe(2_000);
    });

    test("advances pollFromTs to toTs and resets pollCursor, so live polling continues from where backfill stopped", async () => {
      const trades = [rawTrade(1_000, 1, 10, "buy")];
      const adapter = fakeTradeAdapter(trades);
      const session = createVpinSession({ adapter, vBucket: 1_000, nowMs: 0 });
      await seedSessionFromBackfill(session, 0, 5_000);
      expect(session.pollFromTs).toBe(5_000);
      expect(session.pollCursor).toBeNull();

      trades.push(rawTrade(6_000, 1, 10, "sell"));
      const pollResult = await pollLive(session, 7_000);
      expect(pollResult.tradesApplied).toBe(1);
    });

    test("a trade already consumed by backfill is never re-applied once live polling begins", async () => {
      const adapter = fakeTradeAdapter([rawTrade(1_000, 1, 10, "buy")]);
      const session = createVpinSession({ adapter, vBucket: 1_000_000, nowMs: 0 });
      await seedSessionFromBackfill(session, 0, 5_000);
      const totalAccAfterBackfill = session.vpinState.sealer.buyAcc;
      const pollResult = await pollLive(session, 6_000);
      expect(pollResult.tradesApplied).toBe(0);
      expect(session.vpinState.sealer.buyAcc).toBe(totalAccAfterBackfill);
    });

    test("rejects an inverted or invalid range", async () => {
      const session = createVpinSession({ adapter: fakeTradeAdapter([]), vBucket: 10, nowMs: 0 });
      await expect(seedSessionFromBackfill(session, 10, 5)).rejects.toThrow(/toTs/);
      await expect(seedSessionFromBackfill(session, -1, 5)).rejects.toThrow(/fromTs/);
    });

    test("a malformed trade anywhere in the backfill window leaves the session's vpinState completely untouched", async () => {
      // vBucket is deliberately far above the first trade's own value (2_000)
      // so it can't seal on its own -- if it were wrongly ingested before the
      // throw, buyAcc would read 2_000 instead of 0. A smaller vBucket would
      // let the first trade seal and reset buyAcc back to 0 by itself,
      // masking exactly the corruption this test exists to catch.
      const adapter = fixedPageAdapter([
        rawTrade(1_000, 100, 20, "buy"),
        rawTrade(1_001, NaN, 20, "buy"),
      ]);
      const session = createVpinSession({ adapter, vBucket: 10_000, nowMs: 0 });
      await expect(seedSessionFromBackfill(session, 0, 5_000)).rejects.toThrow(/price/);
      expect(session.vpinState.sealer.buyAcc).toBe(0);
      expect(session.vpinState.lastSealTs).toBeNull();
      expect(session.history).toEqual([]);
      expect(session.pollCursor).toBeNull();
    });

    test("seeds session.history from the backfilled readings, so a client connecting after warm-up still sees them", async () => {
      const adapter = fakeTradeAdapter([
        rawTrade(1_000, 1, 10, "buy"),
        rawTrade(2_000, 1, 10, "sell"),
      ]);
      const session = createVpinSession({ adapter, vBucket: 10, nowMs: 0 });
      const result = await seedSessionFromBackfill(session, 0, 10_000);
      expect(session.history).toEqual(result.readings);
      expect(session.history.map((reading) => reading.sealTs)).toEqual([1_000, 2_000]);
    });

    test("caps the seeded history to maxHistory, keeping the most recent readings", async () => {
      const trades = Array.from({ length: 5 }, (_, i) => rawTrade(1_000 + i, 1, 10, "buy"));
      const adapter = fakeTradeAdapter(trades);
      const session = createVpinSession({ adapter, vBucket: 10, nowMs: 0 });
      const result = await seedSessionFromBackfill(session, 0, 10_000, { maxHistory: 3 });
      expect(session.history).toHaveLength(3);
      expect(result.readings).toBe(session.history);
      expect(session.history.map((reading) => reading.sealTs)).toEqual([1_002, 1_003, 1_004]);
    });
  });

  describe("runBackfill", () => {
    test("builds a fresh engine state, independent of any live session, and processes the full window", async () => {
      const adapter = fakeTradeAdapter([
        rawTrade(1_000, 1, 10, "buy"),
        rawTrade(2_000, 1, 10, "sell"),
        rawTrade(3_000, 1, 20, "buy"),
      ]);
      const result = await runBackfill({ adapter, vBucket: 10, fromTs: 0, toTs: 10_000 });
      expect(result.tradesApplied).toBe(3);
      expect(result.readings).toHaveLength(4);
      expect(result.readings.map((r) => r.sealTs)).toEqual([1_000, 2_000, 3_000, 3_000]);
    });

    test("readings are in chronological order and each carries a snapshot-shaped reading", async () => {
      const adapter = fakeTradeAdapter([
        rawTrade(1_000, 1, 10, "buy"),
        rawTrade(2_000, 1, 10, "sell"),
      ]);
      const { readings } = await runBackfill({ adapter, vBucket: 10, fromTs: 0, toTs: 10_000 });
      expect(readings[0]).toMatchObject({ sealTs: 1_000, active: expect.any(Boolean), direction: null });
      expect(readings[1].sealTs).toBeGreaterThan(readings[0].sealTs);
    });

    test("respects the toTs bound -- trades after it are never applied", async () => {
      const adapter = fakeTradeAdapter([
        rawTrade(1_000, 1, 10, "buy"),
        rawTrade(50_000, 1, 10, "sell"),
      ]);
      const { tradesApplied } = await runBackfill({ adapter, vBucket: 10, fromTs: 0, toTs: 10_000 });
      expect(tradesApplied).toBe(1);
    });

    test("stops within the maxPages budget instead of looping unboundedly", async () => {
      const trades = Array.from({ length: 100 }, (_, i) => rawTrade(1_000 + i, 1, 1, "buy"));
      const adapter = fakeTradeAdapter(trades);
      const result = await runBackfill({ adapter, vBucket: 1_000_000, fromTs: 0, toTs: 100_000, pageLimit: 10, maxPages: 3 });
      expect(result.pagesFetched).toBe(3);
      expect(result.tradesApplied).toBe(30);
      expect(result.complete).toBe(false);
    });

    test("does not advance a session past a partial backfill, preserving a truthful warming state", async () => {
      const trades = Array.from({ length: 25 }, (_, i) => rawTrade(1_000 + i, 1, 1, "buy"));
      const session = createVpinSession({ adapter: fakeTradeAdapter(trades), vBucket: 10, nowMs: 500 });
      const result = await seedSessionFromBackfill(session, 0, 10_000, { pageLimit: 10, maxPages: 1 });
      expect(result.complete).toBe(false);
      expect(session.pollFromTs).toBe(500);
      expect(session.pollCursor).toBeNull();
      expect(session.history).toEqual([]);
      expect(session.vpinState.sealer.totalAcc).toBe(0);
    });

    test("rejects an inverted or invalid range", async () => {
      const adapter = fakeTradeAdapter([]);
      await expect(runBackfill({ adapter, vBucket: 10, fromTs: 10, toTs: 5 })).rejects.toThrow(/toTs/);
      await expect(runBackfill({ adapter, vBucket: 10, fromTs: -1, toTs: 5 })).rejects.toThrow(/fromTs/);
    });

    test("stops after one page when the adapter returns a null cursor even though the page exactly filled the limit -- never re-fetches or double-counts", async () => {
      const trades = Array.from({ length: 5 }, (_, i) => rawTrade(1_000 + i, 1, 10, "buy"));
      const adapter = fullPageNullCursorAdapter(trades);
      const result = await runBackfill({ adapter, vBucket: 1_000_000, fromTs: 0, toTs: 100_000, pageLimit: 5, maxPages: 10 });
      expect(result.pagesFetched).toBe(1);
      expect(result.tradesApplied).toBe(5);
    });
  });

  describe("sliced approximate backfill opt-in", () => {
    test("an adapter without readSlicedNotional still uses the per-trade path unchanged", async () => {
      const readTradesSince = jest.fn(fakeTradeAdapter([rawTrade(1_000, 1, 10, "buy")]).readTradesSince);
      const result = await runBackfill({ adapter: { readTradesSince }, vBucket: 10, fromTs: 0, toTs: 10_000 });
      expect(readTradesSince).toHaveBeenCalled();
      expect(result.tradesApplied).toBe(1);
    });

    test("the exact default uses the per-trade path even when a sliced aggregate is available", async () => {
      const trades = [rawTrade(1_000, 1, 10, "buy")];
      const readTradesSince = jest.fn(fakeTradeAdapter(trades).readTradesSince);
      const readSlicedNotional = jest.fn();
      const adapter = { readTradesSince, readSlicedNotional };
      const result = await runBackfill({ adapter, vBucket: 10, fromTs: 0, toTs: 10_000 });
      expect(readTradesSince).toHaveBeenCalled();
      expect(readSlicedNotional).not.toHaveBeenCalled();
      expect(result.tradesApplied).toBe(1);
    });

    test("readings match the per-trade path exactly when each trade lands in its own slice", async () => {
      const sliceMs = 250;
      const trades = [];
      for (let i = 0; i < 20; i += 1) {
        const side = i % 4 === 0 ? "sell" : "buy";
        trades.push(rawTrade(1_000 + i * sliceMs, 1, 15, side));
      }
      const fromTs = 0;
      const toTs = 10_000;
      const vBucket = 40;
      const engineOptions = { w: 3, nBaseline: 5 };
      const legacy = await runBackfill({ adapter: fakeTradeAdapter(trades), vBucket, fromTs, toTs, engineOptions });
      const sliced = await runBackfill({ adapter: fakeSlicedAdapter(trades), vBucket, fromTs, toTs, engineOptions, sliceMs, backfillMode: "SLICED_APPROXIMATE" });
      expect(sliced.readings).toHaveLength(legacy.readings.length);
      expect(sliced.readings.length).toBeGreaterThan(0);
      sliced.readings.forEach((reading, index) => {
        const expected = legacy.readings[index];
        expect(reading.sealTs).toBe(expected.sealTs);
        expect(reading.active).toBe(expected.active);
        expect(reading.direction).toBe(expected.direction);
        if (expected.zVpin === null) expect(reading.zVpin).toBeNull();
        else expect(reading.zVpin).toBeCloseTo(expected.zVpin, 9);
      });
    });

    // Property: reading the sliced aggregate in chunks is invisible to VPIN —
    // chunk edges land on slice edges, so no slice is split across two reads
    // and the readings equal a single read of the whole window. Oracle: the
    // one-shot sliced run, plus the adapter call log.
    test("a chunked sliced backfill equals the one-shot sliced backfill exactly, with chunk edges on slice edges", async () => {
      const sliceMs = 250;
      const trades = [];
      for (let i = 0; i < 400; i += 1) trades.push(rawTrade(137 + i * 190, 1, 15 + (i % 7), i % 3 === 0 ? "sell" : "buy"));
      const fromTs = 137;
      const toTs = 137 + 400 * 190;
      const vBucket = 500;
      const engineOptions = { w: 3, nBaseline: 5 };
      const calls = [];
      const chunkedAdapter = {
        ...fakeSlicedAdapter(trades),
        readSlicedNotional(from, to, slice) { calls.push([from, to]); return fakeSlicedAdapter(trades).readSlicedNotional(from, to, slice); },
      };
      const oneShot = await runBackfill({ adapter: fakeSlicedAdapter(trades), vBucket, fromTs, toTs, engineOptions, sliceMs, backfillMode: "SLICED_APPROXIMATE" });
      const chunked = await runBackfill({ adapter: chunkedAdapter, vBucket, fromTs, toTs, engineOptions, sliceMs, chunkMs: 10_000, backfillMode: "SLICED_APPROXIMATE" });
      expect(chunked.complete).toBe(true);
      expect(chunked.readings).toEqual(oneShot.readings);
      expect(chunked.vpinState).toEqual(oneShot.vpinState);
      expect(chunked.slicesRead).toBe(oneShot.slicesRead);
      expect(chunked.chunksRead).toBe(calls.length);
      expect(calls.length).toBeGreaterThan(5);
      expect(calls[0][0]).toBe(fromTs);
      expect(calls.at(-1)[1]).toBe(toTs);
      for (const [from, to] of calls.slice(0, -1)) {
        expect(to % sliceMs).toBe(0);
        expect(to - from).toBeLessThanOrEqual(10_000);
      }
      for (let i = 1; i < calls.length; i += 1) expect(calls[i][0]).toBe(calls[i - 1][1]);
    });

    test("an unavailable chunk stops the sliced backfill with its own reason and never falls back to per-trade reads", async () => {
      const trades = Array.from({ length: 50 }, (_, i) => rawTrade(1_000 + i * 200, 1, 20, i % 2 ? "buy" : "sell"));
      const readTradesSince = jest.fn(() => { throw new Error("per-trade reads must not run in sliced mode"); });
      let reads = 0;
      const adapter = {
        readTradesSince,
        readSlicedNotional(from, to, slice) {
          reads += 1;
          return reads === 1 ? fakeSlicedAdapter(trades).readSlicedNotional(from, to, slice) : { rows: [], available: false };
        },
      };
      const result = await runBackfill({ adapter, vBucket: 100, fromTs: 0, toTs: 30_000, sliceMs: 250, chunkMs: 5_000, backfillMode: "SLICED_APPROXIMATE" });
      expect(result).toMatchObject({ complete: false, reason: "SLICED_UNAVAILABLE", chunksRead: 1, pagesFetched: 0 });
      expect(readTradesSince).not.toHaveBeenCalled();
      await expect(runBackfill({ adapter: { readTradesSince }, vBucket: 100, fromTs: 0, toTs: 1, backfillMode: "SLICED_APPROXIMATE" }))
        .rejects.toThrow(/readSlicedNotional/);
      await expect(runBackfill({ adapter, vBucket: 100, fromTs: 0, toTs: 1, sliceMs: 250, chunkMs: 100, backfillMode: "SLICED_APPROXIMATE" }))
        .rejects.toThrow(/chunkMs/);
    });

    test("same-slice trades retain every equal-notional bucket even though their exact within-slice seal times are unavailable", async () => {
      const sliceMs = 250;
      const trades = Array.from({ length: 6 }, (_, i) => rawTrade(1_000 + i * 10, 1, 40, "buy"));
      const vBucket = 100;
      const legacy = await runBackfill({ adapter: fakeTradeAdapter(trades), vBucket, fromTs: 0, toTs: 10_000 });
      const sliced = await runBackfill({
        adapter: fakeSlicedAdapter(trades), vBucket, fromTs: 0, toTs: 10_000, engineOptions: {}, sliceMs, backfillMode: "SLICED_APPROXIMATE",
      });
      expect(legacy.readings).toHaveLength(2);
      expect(sliced.readings).toHaveLength(2);
      expect(sliced.readings.map((reading) => reading.sealTs)).toEqual([1_050, 1_050]);
    });
  });
});
