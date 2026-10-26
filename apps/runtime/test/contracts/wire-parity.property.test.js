"use strict";

// Block 7 W1 (report 57): the browser must accept every frame the runtime's
// real builders can emit, and keep its identity, time, price, volume and
// side values. GE-5 was one input shape (a sell side without a buy side) the
// runtime accepted and the browser rejected; this generates the input space
// instead of pinning samples.
const fc = require("fast-check");
const frames = require("../../src/server/frames");
const { loadBrowserFrames } = require("../helpers/browser-frame-parser");

const { parseServerFrame } = loadBrowserFrames();
const RUNS = 500;

const minuteTs = fc.integer({ min: 1_600_000_000, max: 1_890_000_000 }).map((s) => Math.floor((s * 1000) / 60_000) * 60_000);
const tradeTs = fc.integer({ min: 1_600_000_000_000, max: 1_890_000_000_000 });
const price = fc.integer({ min: 1, max: 100_000_000_000 }).map((n) => n / 100_000);
const size = fc.integer({ min: 1, max: 10_000_000_000 }).map((n) => n / 1_000_000);
const side = fc.constantFrom("buy", "sell");
const tradeId = fc.bigInt({ min: 1n, max: 2n ** 53n - 1n }).map(String);

const ohlc = fc.tuple(price, price, price, price).map((p) => {
  const sorted = [...p].sort((a, b) => a - b);
  return { low: sorted[0], high: sorted[3], open: p[0] >= sorted[0] && p[0] <= sorted[3] ? p[0] : sorted[1], close: sorted[2] };
});

const sidedVolume = fc
  .tuple(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), fc.constantFrom("both", "buyOnly", "none", "sellWhole", "buyWhole"))
  .map(([v, a, b, shape]) => {
    const volume = v / 1000;
    const buy = Math.floor((volume * a) / 100 * 1000) / 1000;
    const rest = Math.max(0, volume - buy);
    const sell = Math.floor((rest * b) / 100 * 1000) / 1000;
    if (shape === "none") return { volume };
    if (shape === "sellWhole") return { volume, sellVolume: volume };
    if (shape === "buyWhole") return { volume, buyVolume: volume };
    if (shape === "buyOnly") return { volume, buyVolume: buy };
    return { volume, buyVolume: buy, sellVolume: sell };
  });

const DXFEED = [
  { symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
  { symbol: "AAPL", assetClass: "EQUITY" },
];
const BINANCE = [
  { symbol: "BTCUSDT", marketKind: "PERPETUAL" },
  { symbol: "ETHUSDT", marketKind: "SPOT" },
];

function admitted(frame) {
  const frameTs = frame.ts_exchange ?? (frame.ts_open === undefined ? undefined : frame.ts_open + frame.interval_ms);
  const parsed = parseServerFrame(frame, frameTs === undefined ? {} : { nowMs: frameTs + 1_000 });
  if (parsed === null) throw new Error(`browser rejected ${JSON.stringify(frame).slice(0, 400)}`);
  return parsed;
}

describe("wire parity: runtime builders vs the browser parser", () => {
  test("dxFeed bars: every buildable bar is admitted with the same values and sides", () => {
    fc.assert(fc.property(fc.constantFrom(...DXFEED), minuteTs, ohlc, sidedVolume, fc.integer({ min: 0, max: 1_000_000 }), fc.boolean(),
      (id, tsOpen, bar, vol, tradeCount, closed) => {
        let frame;
        try {
          frame = frames.dxfeedBarFrame({ ...id, tsOpen, ...bar, ...vol, tradeCount, closed });
        } catch {
          return true;
        }
        const parsed = admitted(frame);
        expect(parsed).toMatchObject({ type: "bar", provider: "DXFEED", ts_open: tsOpen, open: frame.open, high: frame.high, low: frame.low, close: frame.close, volume: frame.volume });
        expect(parsed.buy_volume).toBe(frame.buy_volume);
        expect(parsed.sell_volume).toBe(frame.sell_volume);
        return true;
      }), { numRuns: RUNS });
  });

  test("Binance stored candles: every buildable bar is admitted with the same values", () => {
    fc.assert(fc.property(fc.constantFrom(...BINANCE), minuteTs, ohlc, sidedVolume, fc.integer({ min: 0, max: 1_000_000 }),
      (id, tsOpen, bar, vol, tradeCount) => {
        const row = { ts_open: tsOpen, ...bar, volume: vol.volume, taker_buy_base_volume: vol.buyVolume ?? null, trade_count: tradeCount };
        let frame;
        try {
          frame = frames.storageCandleRowToBarFrame(row, id.symbol, id.marketKind, "1m");
        } catch {
          return true;
        }
        const parsed = admitted(frame);
        expect(parsed).toMatchObject({ type: "bar", provider: "BINANCE", ts_open: tsOpen, volume: frame.volume, close: frame.close });
        expect(parsed.buy_volume).toBe(frame.buy_volume);
        return true;
      }), { numRuns: RUNS });
  });

  test("trades from both providers are admitted with identity, time, price, size, side and id intact", () => {
    fc.assert(fc.property(fc.constantFrom(...DXFEED), tradeTs, price, size, side, tradeId, fc.boolean(), (id, ts, p, s, sd, tid, auction) => {
      let frame;
      try {
        frame = frames.dxfeedTradeFrame({ ...id, tsExchange: ts, price: p, size: s, side: sd, tradeId: tid, auction });
      } catch {
        return true;
      }
      const parsed = admitted(frame);
      expect(parsed).toMatchObject({ type: "trade", provider: "DXFEED", ts_exchange: ts, price: frame.price, size: frame.size, side: frame.side, trade_id: frame.trade_id });
      expect(parsed.auction).toBe(auction ? true : undefined);
      return true;
    }), { numRuns: RUNS });
    fc.assert(fc.property(fc.constantFrom(...BINANCE), tradeTs, price, size, side, tradeId, (id, ts, p, s, sd, tid) => {
      let frame;
      try {
        frame = frames.storageTradeRowToTradeFrame({ ts, price: p, size: s, side: sd, trade_id: tid }, id.symbol, id.marketKind);
      } catch {
        return true;
      }
      const parsed = admitted(frame);
      expect(parsed).toMatchObject({ type: "trade", provider: "BINANCE", ts_exchange: ts, price: frame.price, size: frame.size, side: sd, trade_id: frame.trade_id });
      return true;
    }), { numRuns: RUNS });
  });

  test("dxFeed markers are admitted with the same values", () => {
    fc.assert(fc.property(fc.constantFrom(...DXFEED), tradeTs, price, size, side, tradeId, (id, ts, p, s, sd, tid) => {
      let frame;
      try {
        frame = frames.dxfeedMarkerFrame({ ...id, tsExchange: ts, price: p, size: s, side: sd, tradeId: tid });
      } catch {
        return true;
      }
      const parsed = admitted(frame);
      expect(parsed).toMatchObject({ type: "marker", provider: "DXFEED", price: frame.price, size: frame.size });
      return true;
    }), { numRuns: RUNS });
  });

  test("every health and selection frame the runtime can build, for both providers, is admitted", () => {
    const states = ["READY", "RECOVERING", "UNAVAILABLE"];
    const buildable = (build) => {
      try {
        return build();
      } catch {
        return null;
      }
    };
    let built = 0;
    for (const id of DXFEED) {
      expect(admitted(frames.dxfeedSelectionFrame(id.symbol, id.assetClass))).toMatchObject({ type: "selection", provider: "DXFEED" });
      for (const recoveryState of states) for (const stale of [true, false]) for (const printsQuiet of [true, false]) {
        const frame = buildable(() => frames.dxfeedHealthFrame(id.symbol, id.assetClass, { stale, recoveryState, printsQuiet }, recoveryState === "READY" ? undefined : "TEST"));
        if (frame === null) continue;
        built += 1;
        expect(admitted(frame)).toMatchObject({ type: "health", provider: "DXFEED", recoveryState, stale });
      }
    }
    for (const id of BINANCE) {
      expect(admitted(frames.selectionFrame(id.symbol, id.marketKind))).toMatchObject({ type: "selection", provider: "BINANCE" });
      for (const recoveryState of states) for (const stale of [true, false]) for (const recordingStale of [true, false]) {
        const frame = buildable(() => frames.healthFrame(id.symbol, id.marketKind, { stale, recoveryState, recordingStale, recordingLatestTs: 1_789_000_000_000 }, recoveryState === "READY" ? undefined : "TEST"));
        if (frame === null) continue;
        built += 1;
        expect(admitted(frame)).toMatchObject({ type: "health", provider: "BINANCE", recoveryState, stale });
      }
    }
    expect(built).toBeGreaterThanOrEqual(12);
  });
});

describe("wire parity: the L2 channel builders vs the browser parser (report 61 P4b)", () => {
  const l2 = require("../../src/server/l2-frames");
  const L2_RUNS = 300;
  const identity = fc.constantFrom(
    { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" },
    { provider: "BINANCE", symbol: "ETHUSDT", marketKind: "SPOT" },
    { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" },
    { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" },
  );
  const frameTs = fc.integer({ min: 1_700_000_000_000, max: 1_890_000_000_000 });
  const amount = fc.integer({ min: 0, max: 500_000_000 }).map((n) => n / 100);
  const positive = fc.integer({ min: 1, max: 1_000_000_000 }).map((n) => n / 100);
  const share = fc.integer({ min: 0, max: 1_000 }).map((n) => n / 1_000);
  const segment = fc.option(fc.record({ id: fc.string({ minLength: 1, maxLength: 160 }), state: fc.constantFrom("LIVE", "GAP") }), { nil: null });
  const verdict = fc.constantFrom("filled", "partial", "hit", "pulled", "moved");

  const detail = (ended) => fc.option(fc.record({
    lifeMs: fc.integer({ min: 0, max: 10_000_000 }),
    firstShrinkTs: fc.option(fc.integer({ min: 0, max: 1_890_000_000_000 }), { nil: null }),
    firstShrinkExact: fc.boolean(),
    reachedAtFirstShrink: fc.option(fc.boolean(), { nil: null }),
    traded: amount, absorbed: amount, swept: amount, hidden: amount, cleared: amount,
    fillRatio: share, crossSide: amount, crossSideShare: amount,
    endDistanceRows: fc.option(amount, { nil: null }), endDistancePct: fc.option(amount, { nil: null }),
    clearedByTrades: fc.boolean(),
    continuity: fc.option(fc.record({ gapMs: fc.integer({ min: 0, max: 60_000 }) }), { nil: null }),
    repeats: fc.integer({ min: 1, max: 50 }), repeatsComplete: fc.boolean(), evidenceGap: fc.boolean(),
  }).map((value) => ({ ...value, lifeMs: ended ? value.lifeMs : 0 })), { nil: null });

  const wall = (ts) => fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 5_000_000 })).chain(([ended, back]) => fc.record({
    side: fc.constantFrom("bid", "ask"),
    row: fc.integer({ min: 0, max: 2_000_000 }),
    span: fc.integer({ min: 1, max: 8 }),
    startTs: fc.constant(ts - back),
    endTs: ended ? fc.integer({ min: ts - back, max: ts }) : fc.constant(null),
    size: amount,
    extra: amount,
    endedBy: ended ? verdict : fc.constant(null),
    ratio: amount,
    chain: fc.integer({ min: 0, max: 1_000_000 }),
    fill: share,
    eaten: share,
    absorbing: ended ? fc.constant(false) : fc.boolean(),
    detail: detail(ended),
  }).map(({ extra, ...value }) => ({ ...value, peak: value.size + extra })));

  const event = (ts) => fc.tuple(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 1, max: 1_000_000 })).chain(([back, id]) => {
    const at = ts - back;
    return fc.oneof(
      fc.record({ event: fc.constant("wall_born"), ts: fc.constant(at), wall: fc.constant(id), side: fc.constantFrom("bid", "ask"), row: fc.integer({ min: 0, max: 2_000_000 }), span: fc.integer({ min: 1, max: 8 }), size: amount }),
      fc.record({ event: fc.constant("wall_shrink"), ts: fc.constant(at), wall: fc.constant(id), exact: fc.boolean(), reached: fc.option(fc.boolean(), { nil: null }) }),
      fc.record({ event: fc.constant("wall_trade"), ts: fc.constant(at), wall: fc.constant(id), mode: fc.constantFrom("absorbed", "swept"), price: positive, size: amount }),
      fc.record({ event: fc.constant("wall_hidden"), ts: fc.constant(at), wall: fc.constant(id), volume: amount }),
      fc.record({ event: fc.constant("wall_end"), ts: fc.constant(at), wall: fc.constant(id), endedBy: verdict, distanceRows: fc.option(amount, { nil: null }) }),
      fc.record({ event: fc.constant("trade"), ts: fc.constant(at), side: fc.constantFrom("bid", "ask"), aggressor: side, mode: fc.constantFrom("absorbed", "swept"), price: positive, size: amount, late: fc.boolean() }),
      fc.record({ event: fc.constant("hidden"), ts: fc.constant(at), side: fc.constantFrom("bid", "ask"), price: positive, volume: amount }),
      fc.record({ event: fc.constant("segment"), ts: fc.constant(at), segment: fc.string({ minLength: 1, maxLength: 160 }), state: fc.constantFrom("LIVE", "GAP"), cause: fc.option(fc.string({ maxLength: 160 }), { nil: null }) }),
    );
  });

  const roundTrip = (frame) => JSON.parse(JSON.stringify(frame));
  const admittedUnchanged = (frame) => {
    const wire = roundTrip(frame);
    const parsed = parseServerFrame(wire, { nowMs: frame.ts + 1_000 });
    if (parsed === null) throw new Error(`browser rejected ${JSON.stringify(wire).slice(0, 400)}`);
    expect(parsed).toEqual(wire);
  };

  test("every wall set the builder accepts is admitted with every field, detail included", () => {
    fc.assert(fc.property(identity, frameTs, fc.boolean(), segment, fc.integer({ min: 1, max: 1_000 }).map((n) => n / 100), (id, ts, reset, seg, rowWidth) =>
      fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 10_000_000 }), { minLength: reset ? 0 : 1, maxLength: 30 }), fc.array(wall(ts), { minLength: 30, maxLength: 30 }), fc.uniqueArray(fc.integer({ min: 10_000_001, max: 20_000_000 }), { maxLength: reset ? 0 : 10 }), (ids, walls, removed) => {
        admittedUnchanged(l2.l2WallsFrame(id, { ts, seq: 7, reset, rowWidth, walls: ids.map((wallId, index) => ({ ...walls[index], id: wallId })), removed, segment: seg }));
      }), { numRuns: 3 })), { numRuns: L2_RUNS / 3 });
  });

  test("every laned wall set the builder accepts for a client that declared l2_walls_lanes is admitted with every field, lane included (PR #31 review)", () => {
    fc.assert(fc.property(identity, frameTs, fc.boolean(), segment, fc.integer({ min: 1, max: 1_000 }).map((n) => n / 100), (id, ts, reset, seg, rowWidth) =>
      fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 60_000_000 }), { minLength: reset ? 0 : 1, maxLength: 30 }), fc.array(wall(ts), { minLength: 30, maxLength: 30 }), fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 30, maxLength: 30 }), fc.uniqueArray(fc.integer({ min: 60_000_001, max: 70_000_000 }), { maxLength: reset ? 0 : 10 }), (ids, walls, lanes, removed) => {
        admittedUnchanged(l2.l2WallsFrame(id, { ts, seq: 7, reset, rowWidth, walls: ids.map((wallId, index) => ({ ...walls[index], id: wallId, lane: lanes[index] })), removed, segment: seg, lanes: true }));
      }), { numRuns: 3 })), { numRuns: L2_RUNS / 3 });
  });

  test("every event batch the builder accepts, all eight kinds, is admitted in order with every field", () => {
    fc.assert(fc.property(identity, frameTs, fc.boolean(), fc.integer({ min: 0, max: 100 }), (id, ts, reset, missed) =>
      fc.assert(fc.property(fc.array(event(ts), { minLength: reset || missed > 0 ? 0 : 1, maxLength: 60 }), (events) => {
        const ordered = [...events].sort((a, b) => a.ts - b.ts);
        admittedUnchanged(l2.l2EventsFrame(id, { ts, seq: ordered.length + 5, reset, events: ordered, missed }));
      }), { numRuns: 3 })), { numRuns: L2_RUNS / 3 });
  });

  test("every ladder the builder accepts is admitted level for level", () => {
    fc.assert(fc.property(identity, frameTs, segment, fc.uniqueArray(fc.integer({ min: 1, max: 100_000_000 }), { maxLength: 100 }), fc.array(positive, { minLength: 100, maxLength: 100 }), (id, ts, seg, prices, sizes) => {
      const sorted = [...prices].sort((a, b) => a - b).map((n) => n / 100);
      const cut = Math.floor(sorted.length / 2);
      const bids = sorted.slice(0, cut).reverse().slice(0, 50).map((price, index) => [price, sizes[index]]);
      const asks = sorted.slice(cut).slice(0, 50).map((price, index) => [price, sizes[50 + index]]);
      admittedUnchanged(l2.l2LadderFrame(id, { ts, depth: 50, bids, asks, segment: seg }));
    }), { numRuns: L2_RUNS });
  });

  test("every lane frame the builder accepts is admitted column for column", () => {
    const column = fc.tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 1, max: 64 })).chain(([lo, span]) => fc.record({
      lo: fc.constant(lo),
      hi: fc.constant(lo + span - 1),
      bid: fc.uniqueArray(fc.integer({ min: 0, max: span - 1 }), { maxLength: span }).chain((offsets) => fc.tuple(...[...offsets].sort((a, b) => a - b).map((offset) => fc.tuple(fc.constant(offset), amount)))),
      ask: fc.uniqueArray(fc.integer({ min: 0, max: span - 1 }), { maxLength: span }).chain((offsets) => fc.tuple(...[...offsets].sort((a, b) => a - b).map((offset) => fc.tuple(fc.constant(offset), amount)))),
    }));
    fc.assert(fc.property(identity, frameTs, fc.integer({ min: 1, max: 6 }), fc.constantFrom("recent", "deep"), segment, fc.array(column, { minLength: 1, maxLength: 20 }), (id, ts, lane, tier, seg, columns) => {
      const columnMs = 2 ** lane * 1_000;
      const timed = columns.map((entry, index) => ({ ...entry, ts: ts - (columns.length - 1 - index) * columnMs }));
      admittedUnchanged(l2.l2ViewFrame(id, { lane, tier, ts, seq: 100 + timed.length, reset: false, rowWidth: 2 ** lane / 2, columnMs, columns: timed, segment: seg }));
    }), { numRuns: L2_RUNS });
  });
});
