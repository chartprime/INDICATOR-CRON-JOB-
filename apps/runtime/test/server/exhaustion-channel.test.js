const { createExhaustionChannel, EXHAUSTION_CAPABILITY } = require("../../src/server/exhaustion-channel");
const { MAX_EXHAUSTION_SHADES } = require("../../src/server/exhaustion-frames");

const WS_OPEN = 1;

function shade(i, overrides = {}) {
  return {
    id: `s${i}`, candleMs: 60_000, side: "buyers", status: "open", intensity: 1, score: 3, readings: { rate: true, progress: false, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.211, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 },
    raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
    startTs: 1_700_000_040_000 + i * 60_000, endTs: 1_700_000_100_000 + i * 60_000, extremeTs: 1_699_999_980_000, extremePrice: 104, legStartTs: 1_699_999_800_000, legStartPrice: 101,
    legSize: 3, efficiency: 1, atr: 1, judgedAt: null, updatedAt: 1_700_000_100_000 + i * 60_000, origin: "runtime", ...overrides,
  };
}

function harness({ pair = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, snapshot = { ts: 5000, liveSince: 1000, shades: [] } } = {}) {
  const state = { active: pair, snapshot, log: [] };
  const sent = new Map();
  const client = () => ({ readyState: WS_OPEN, bufferedAmount: 0 });
  const channel = createExhaustionChannel({
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

describe("server/exhaustion-channel", () => {
  test("the capability is exhaustion_shades; a client that declares it gets the snapshot page on subscribe, one that does not gets nothing", () => {
    expect(EXHAUSTION_CAPABILITY).toBe("exhaustion_shades");
    const { channel, state, client, framesOf } = harness({ snapshot: { ts: 5000, liveSince: 1000, loading: 700, shades: [shade(1, { status: "held", judgedAt: 1_700_000_200_000 })] } });
    const yes = client();
    const no = client();
    channel.subscribe(yes, new Set(["exhaustion_shades", "l2_view"]));
    channel.subscribe(no, new Set(["l2_view"]));
    expect(framesOf(yes)).toEqual([expect.objectContaining({ type: "exhaustion_shades", reset: true, seq: 0, ts: 5000, liveSince: 1000, loading: 700, provider: "DXFEED", assetClass: "FUTURE", shades: [expect.objectContaining({ id: "s1", status: "held" })] })]);
    expect(framesOf(no)).toEqual([]);
    channel.publish([shade(2)], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 6000, 1000, 800);
    expect(framesOf(yes).at(-1)).toMatchObject({ reset: false, ts: 6000, liveSince: 1000, loading: 800, shades: [expect.objectContaining({ id: "s2" })] });
    channel.publish([shade(3)], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 7000, 1000);
    expect(framesOf(yes).at(-1)).toMatchObject({ ts: 7000, loading: null });
    expect(channel.subscribed(yes)).toBe(true);
    expect(channel.size).toBe(1);
    expect(state.log).toEqual([]);
  });

  test("an increment reaches subscribers for the active pair only, with a rising seq per pair", () => {
    const { channel, state, client, framesOf } = harness();
    const c = client();
    channel.subscribe(c, new Set(["exhaustion_shades"]));
    expect(channel.publish([shade(1)], state.active, 6000, 1000)).toBe(1);
    expect(channel.publish([shade(2)], { symbol: "/ESZ26:XCME", marketKind: "FUTURE" }, 6000, 1000)).toBe(0);
    expect(channel.publish([shade(3)], state.active, 7000, 1000)).toBe(1);
    expect(framesOf(c).slice(1).map((f) => [f.seq, f.reset, f.shades[0].id, f.liveSince])).toEqual([[1, false, "s1", 1000], [2, false, "s3", 1000]]);
    expect(channel.publish([], state.active, 8000, 1000)).toBe(0);
  });

  test("a long increment is chunked at the frame cap", () => {
    const { channel, state, client, framesOf } = harness();
    const c = client();
    channel.subscribe(c, new Set(["exhaustion_shades"]));
    const many = Array.from({ length: MAX_EXHAUSTION_SHADES + 1 }, (_, i) => shade(i));
    expect(channel.publish(many, state.active, 6000, 1000)).toBe(2);
    expect(framesOf(c).slice(1).map((f) => f.shades.length)).toEqual([MAX_EXHAUSTION_SHADES, 1]);
  });

  test("an invalid increment is logged and the snapshot resent instead of a broken frame", () => {
    const { channel, state, client, framesOf } = harness();
    const c = client();
    channel.subscribe(c, new Set(["exhaustion_shades"]));
    expect(channel.publish([shade(1, { side: "bulls" })], state.active, 6000, 1000)).toBe(0);
    expect(state.log).toEqual([expect.stringMatching(/increment failed; resending the snapshot/)]);
    expect(framesOf(c).map((f) => f.reset)).toEqual([true, true]);
  });

  test("publishMonitor sends one candle_monitor frame to every open subscriber of the active pair, nothing for another pair, nothing when the frame is refused", () => {
    const { channel, client, framesOf } = harness();
    const yes = client();
    const gone = { ...client(), readyState: 3 };
    channel.subscribe(yes, new Set(["exhaustion_shades"]));
    channel.subscribe(gone, new Set(["exhaustion_shades"]));
    const entry = { candleMs: 60_000, candleTs: 1_700_000_220_000, buy: 2.97, sell: 0.56, biggestBuy: { price: 31_190, size: 1.21 }, biggestSell: null };
    expect(channel.publishMonitor([entry], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 7000)).toBe(1);
    expect(framesOf(gone).filter((f) => f.type === "candle_monitor")).toEqual([]);
    expect(framesOf(yes).at(-1)).toEqual({ type: "candle_monitor", ts: 7000, provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", entries: [entry] });
    expect(channel.publishMonitor([entry], { symbol: "/ESZ26:XCME", marketKind: "FUTURE" }, 7001)).toBe(0);
    expect(channel.publishMonitor([], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 7002)).toBe(0);
    expect(channel.publishMonitor([{ ...entry, buy: -1 }], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 7003)).toBe(0);
    expect(framesOf(yes).filter((f) => f.type === "candle_monitor")).toHaveLength(1);
  });

  test("reselect resends the snapshot to every subscriber; forget and stopAll drop them", () => {
    const { channel, state, client, framesOf } = harness();
    const a = client();
    const b = client();
    channel.subscribe(a, new Set(["exhaustion_shades"]));
    channel.subscribe(b, new Set(["exhaustion_shades"]));
    state.snapshot = { ts: 9000, liveSince: 1000, shades: [shade(5)] };
    channel.reselect();
    expect(framesOf(a).map((f) => f.ts)).toEqual([5000, 9000]);
    expect(framesOf(b).map((f) => f.ts)).toEqual([5000, 9000]);
    channel.forget(a);
    expect(channel.subscribed(a)).toBe(false);
    channel.subscribe(b, new Set(["l2_view"]));
    expect(channel.size).toBe(0);
    channel.subscribe(b, new Set(["exhaustion_shades"]));
    channel.stopAll();
    expect(channel.size).toBe(0);
    expect(channel.publish([shade(1)], state.active, 6000, 1000)).toBe(0);
  });

  test("a snapshot that throws is logged and the client gets nothing rather than a broken page", () => {
    const { channel, state, client, framesOf } = harness({ snapshot: () => { throw new Error("boom"); } });
    const c = client();
    channel.subscribe(c, new Set(["exhaustion_shades"]));
    expect(framesOf(c)).toEqual([]);
    expect(state.log).toEqual([expect.stringMatching(/snapshot failed boom/)]);
  });

  test("the factory refuses missing collaborators", () => {
    expect(() => createExhaustionChannel({ logPrefix: "" })).toThrow(/logPrefix/);
    expect(() => createExhaustionChannel({ logPrefix: "x", safelySend: () => {}, safelySendSerialized: () => {}, activePair: () => null, identityOf: () => null })).toThrow(/snapshotOf/);
  });
});
