const { createInitiativeChannel, parseInitiativeHistory, INITIATIVE_CAPABILITY } = require("../../src/server/initiative-channel");
const { MAX_INITIATIVE_BANDS } = require("../../src/server/initiative-frames");
const { MAX_VALID_EPOCH_MS } = require("../../src/server/wire-fields");

const WS_OPEN = 1;
const PIVOT = 1_700_000_040_000;

function band(i, overrides = {}) {
  return {
    id: `b${i}`, candleMs: 60_000, side: "down", dominant: "sellers", dominantShare: 0.75, score: 4,
    facts: { efficiency: { yes: true, value: 0.714 }, closes: { yes: true, value: 2 }, burst: { yes: false, value: 0.8 }, delta: { yes: true, rank: 1, share: 0.75 }, prints: { yes: true, rank: 0.833, perCandle: 1 } },
    pivotTs: PIVOT + i * 60_000, pivotPrice: 108, frozenTs: PIVOT + (i + 3) * 60_000, frozenPrice: 105.5, windowCandles: 3, atr: 1.035,
    legExtremePrice: 105, legExtremeTs: PIVOT + (i + 3) * 60_000, legEndTs: null, updatedAt: PIVOT + (i + 4) * 60_000, origin: "runtime", ...overrides,
  };
}

function harness({ pair = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, snapshot = { ts: 5000, liveSince: 1000, bands: [] } } = {}) {
  const state = { active: pair, snapshot, log: [] };
  const sent = new Map();
  const client = () => ({ readyState: WS_OPEN, bufferedAmount: 0 });
  const channel = createInitiativeChannel({
    logPrefix: "test",
    wsOpen: WS_OPEN,
    safelySend: (c, frame) => { (sent.get(c) ?? sent.set(c, []).get(c)).push(frame); return true; },
    safelySendSerialized: (c, serialized) => { (sent.get(c) ?? sent.set(c, []).get(c)).push(JSON.parse(serialized)); return true; },
    softBytes: 1_000_000,
    activePair: () => state.active,
    identityOf: (p) => (p.marketKind === "FUTURE" ? { provider: "DXFEED", symbol: p.symbol, assetClass: "FUTURE" } : { provider: "BINANCE", symbol: p.symbol, marketKind: p.marketKind }),
    snapshotOf: () => (typeof state.snapshot === "function" ? state.snapshot() : state.snapshot),
    now: () => 10_000,
    log: { error: (...args) => state.log.push(args.join(" ")), warn: () => {} },
  });
  return { channel, state, sent, client, framesOf: (c) => sent.get(c) ?? [] };
}

describe("server/initiative-channel", () => {
  test("the capability is initiative_bands; a client that declares it gets the snapshot page on subscribe, one that does not gets nothing", () => {
    expect(INITIATIVE_CAPABILITY).toBe("initiative_bands");
    const { channel, state, client, framesOf } = harness({ snapshot: { ts: 5000, liveSince: 1000, loading: 700, bands: [band(1, { legEndTs: PIVOT + 600_000 })] } });
    const yes = client();
    const no = client();
    channel.subscribe(yes, new Set(["initiative_bands", "l2_view"]));
    channel.subscribe(no, new Set(["l2_view"]));
    expect(framesOf(yes)).toEqual([expect.objectContaining({ type: "initiative_bands", reset: true, seq: 0, ts: 5000, liveSince: 1000, loading: 700, provider: "DXFEED", assetClass: "FUTURE", bands: [expect.objectContaining({ id: "b1", legEndTs: PIVOT + 600_000 })] })]);
    expect(framesOf(no)).toEqual([]);
    channel.publish([band(2)], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 6000, 1000, 800);
    expect(framesOf(yes).at(-1)).toMatchObject({ reset: false, ts: 6000, liveSince: 1000, loading: 800, bands: [expect.objectContaining({ id: "b2" })] });
    channel.publish([band(3)], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 7000, 1000);
    expect(framesOf(yes).at(-1)).toMatchObject({ ts: 7000, loading: null });
    expect(channel.subscribed(yes)).toBe(true);
    expect(channel.size).toBe(1);
    expect(state.log).toEqual([]);
  });

  test("an increment reaches subscribers for the active pair only, with a rising seq per pair", () => {
    const { channel, state, client, framesOf } = harness();
    const c = client();
    channel.subscribe(c, new Set(["initiative_bands"]));
    expect(channel.publish([band(1)], state.active, 6000, 1000)).toBe(1);
    expect(channel.publish([band(2)], { symbol: "/ESZ26:XCME", marketKind: "FUTURE" }, 6000, 1000)).toBe(0);
    expect(channel.publish([band(3)], state.active, 7000, 1000)).toBe(1);
    expect(framesOf(c).slice(1).map((f) => [f.seq, f.reset, f.bands[0].id, f.liveSince])).toEqual([[1, false, "b1", 1000], [2, false, "b3", 1000]]);
    expect(channel.publish([], state.active, 8000, 1000)).toBe(0);
    state.active = null;
    expect(channel.publish([band(4)], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 9000, 1000)).toBe(0);
  });

  test("a long increment is chunked at the frame cap", () => {
    const { channel, state, client, framesOf } = harness();
    const c = client();
    channel.subscribe(c, new Set(["initiative_bands"]));
    const many = Array.from({ length: MAX_INITIATIVE_BANDS + 1 }, (_, i) => band(i));
    expect(channel.publish(many, state.active, 6000, 1000)).toBe(2);
    expect(framesOf(c).slice(1).map((f) => f.bands.length)).toEqual([MAX_INITIATIVE_BANDS, 1]);
  });

  test("an invalid increment is logged and the snapshot resent instead of a broken frame", () => {
    const { channel, state, client, framesOf } = harness();
    const c = client();
    channel.subscribe(c, new Set(["initiative_bands"]));
    expect(channel.publish([band(1, { side: "buyers" })], state.active, 6000, 1000)).toBe(0);
    expect(state.log).toEqual([expect.stringMatching(/increment failed; resending the snapshot/)]);
    expect(framesOf(c).map((f) => f.reset)).toEqual([true, true]);
  });

  test("reselect resends the snapshot to every subscriber; forget and stopAll drop them; without an active pair the snapshot is empty", () => {
    const { channel, state, client, framesOf } = harness();
    const a = client();
    const b = client();
    channel.subscribe(a, new Set(["initiative_bands"]));
    channel.subscribe(b, new Set(["initiative_bands"]));
    channel.subscribe(b, new Set(["initiative_bands"]));
    state.snapshot = { ts: 9000, liveSince: 1000, bands: [band(5)] };
    channel.reselect();
    expect(framesOf(a).map((f) => f.ts)).toEqual([5000, 9000]);
    expect(framesOf(b).map((f) => f.ts)).toEqual([5000, 9000]);
    channel.forget(a);
    expect(channel.subscribed(a)).toBe(false);
    channel.subscribe(b, new Set(["l2_view"]));
    expect(channel.size).toBe(0);
    channel.reselect();
    channel.subscribe(b, new Set(["initiative_bands"]));
    channel.stopAll();
    expect(channel.size).toBe(0);
    expect(channel.publish([band(1)], state.active, 6000, 1000)).toBe(0);
    state.active = null;
    const c = client();
    channel.subscribe(c, new Set(["initiative_bands"]));
    expect(framesOf(c)).toEqual([]);
    state.active = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" };
    state.snapshot = null;
    channel.reselect();
    expect(framesOf(c)).toEqual([]);
    expect(state.log).toEqual([]);
  });

  test("a snapshot that throws is logged and the client gets nothing rather than a broken page", () => {
    const { channel, state, client, framesOf } = harness({ snapshot: () => { throw new Error("boom"); } });
    const c = client();
    channel.subscribe(c, new Set(["initiative_bands"]));
    expect(framesOf(c)).toEqual([]);
    expect(state.log).toEqual([expect.stringMatching(/snapshot failed boom/)]);
  });

  test("the factory refuses missing collaborators", () => {
    expect(() => createInitiativeChannel({ logPrefix: "" })).toThrow(/logPrefix/);
    expect(() => createInitiativeChannel({ logPrefix: "x", safelySend: () => {}, safelySendSerialized: () => {}, activePair: () => null, identityOf: () => null })).toThrow(/snapshotOf/);
  });

  test("an initiative_history ask is exactly type and a non-negative epoch-ms from_ts; anything else is null", () => {
    expect(parseInitiativeHistory({ type: "initiative_history", from_ts: 0 })).toBe(0);
    expect(parseInitiativeHistory({ type: "initiative_history", from_ts: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    for (const bad of [null, "x", { type: "exhaustion_history", from_ts: 1 }, { type: "initiative_history" }, { type: "initiative_history", from_ts: "1" }, { type: "initiative_history", from_ts: -1 }, { type: "initiative_history", from_ts: 1.5 }, { type: "initiative_history", from_ts: MAX_VALID_EPOCH_MS + 1 }, { type: "initiative_history", from_ts: 1, extra: 1 }, { type: "initiative_history", from_ts: 1, zzz: 1 }]) {
      expect(parseInitiativeHistory(bad)).toBeNull();
    }
  });
});
