const { createIcebergChannel } = require("../../src/server/iceberg-channel");
const { MAX_ICEBERG_ORDERS } = require("../../src/server/iceberg-frames");

const WS_OPEN = 1;

function iceberg(i, overrides = {}) {
  return { id: `i${i}`, kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 2, executed: 10 + i, startedAt: 1000, markedAt: 1500 + i, updatedAt: 2000 + i, status: "active", ...overrides };
}

function harness({ pair = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, snapshot = { ts: 5000, liveSince: 1000, icebergs: [] } } = {}) {
  const state = { active: pair, snapshot, log: [] };
  const sent = new Map();
  const client = () => ({ readyState: WS_OPEN, bufferedAmount: 0 });
  const channel = createIcebergChannel({
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

describe("server/iceberg-channel", () => {
  test("a client that declares iceberg_orders gets the snapshot page on subscribe, one that does not gets nothing", () => {
    const { channel, client, framesOf, state } = harness({ snapshot: { ts: 5000, liveSince: 1000, icebergs: [iceberg(1, { status: "filled" })] } });
    const yes = client();
    const no = client();
    channel.subscribe(yes, new Set(["iceberg_orders", "l2_view"]));
    channel.subscribe(no, new Set(["l2_view"]));
    expect(framesOf(yes)).toEqual([expect.objectContaining({ type: "iceberg_orders", reset: true, seq: 0, ts: 5000, provider: "DXFEED", assetClass: "FUTURE", icebergs: [iceberg(1, { status: "filled" })] })]);
    expect(framesOf(no)).toEqual([]);
    expect(channel.subscribed(yes)).toBe(true);
    expect(channel.size).toBe(1);
    expect(state.log).toEqual([]);
  });

  test("the page carries the spans the runtime watched, and so does every increment, with what it was given", () => {
    const { channel, client, framesOf } = harness({ snapshot: { ts: 5000, liveSince: 1000, icebergs: [], watched: [[1000, 4000]] } });
    const c = client();
    channel.subscribe(c, new Set(["iceberg_orders"]));
    channel.publish([iceberg(1, { status: "filled" })], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 6000, [[1000, 5500]], 1000, [], 1000);
    channel.publish([iceberg(2, { status: "filled" })], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 7000, [], 1000);
    expect(framesOf(c).map((frame) => [frame.reset, frame.watched])).toEqual([[true, [[1000, 4000]]], [false, [[1000, 5500]]], [false, []]]);
  });

  test("the page and every increment say when the runtime started (liveSince): the page from the snapshot, the increment from the publisher", () => {
    const { channel, client, framesOf } = harness({ snapshot: { ts: 5000, liveSince: 1000, icebergs: [iceberg(1)] } });
    const c = client();
    channel.subscribe(c, new Set(["iceberg_orders"]));
    channel.publish([iceberg(2, { status: "filled" })], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 6000, [[1000, 5500]], 2000);
    expect(framesOf(c).map((frame) => [frame.reset, frame.liveSince])).toEqual([[true, 1000], [false, 2000]]);
  });

  test("an empty snapshot is still one reset page, so the client clears what it held", () => {
    const { channel, client, framesOf } = harness();
    const c = client();
    channel.subscribe(c, new Set(["iceberg_orders"]));
    expect(framesOf(c)).toEqual([expect.objectContaining({ reset: true, icebergs: [] })]);
  });

  test("declaring the flag again does not resend, dropping it leaves the channel", () => {
    const { channel, client, framesOf } = harness();
    const c = client();
    channel.subscribe(c, new Set(["iceberg_orders"]));
    channel.subscribe(c, new Set(["iceberg_orders"]));
    expect(framesOf(c)).toHaveLength(1);
    channel.subscribe(c, new Set());
    expect(channel.subscribed(c)).toBe(false);
    expect(channel.publish([iceberg(1)], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 6000, [], 1000)).toBe(0);
  });

  test("publish sends increments only to subscribers, only for the active pair, with a rising seq, chunked at the frame bound", () => {
    const { channel, client, framesOf, state } = harness();
    const c = client();
    channel.subscribe(c, new Set(["iceberg_orders"]));
    const pair = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" };
    expect(channel.publish([iceberg(1)], pair, 6000, [], 1000)).toBe(1);
    expect(channel.publish([iceberg(2)], pair, 6001, [], 1000)).toBe(1);
    expect(channel.publish([iceberg(3)], { symbol: "/ESZ26:XCME", marketKind: "FUTURE" }, 6002, [], 1000)).toBe(0);
    expect(channel.publish([], pair, 6003, [], 1000)).toBe(0);
    const many = Array.from({ length: MAX_ICEBERG_ORDERS + 1 }, (_, i) => iceberg(100 + i));
    expect(channel.publish(many, pair, 6004, [], 1000)).toBe(2);
    const increments = framesOf(c).filter((frame) => !frame.reset);
    expect(increments.map((frame) => [frame.seq, frame.icebergs.length, frame.ts])).toEqual([[1, 1, 6000], [2, 1, 6001], [3, MAX_ICEBERG_ORDERS, 6004], [4, 1, 6004]]);
    expect(state.log).toEqual([]);
  });

  test("a malformed increment is logged and answered with a fresh snapshot rather than dropped silently", () => {
    const { channel, client, framesOf, state } = harness();
    const c = client();
    channel.subscribe(c, new Set(["iceberg_orders"]));
    expect(channel.publish([iceberg(1, { side: "buy" })], { symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, 6000, [], 1000)).toBe(0);
    expect(state.log).toHaveLength(1);
    expect(framesOf(c).filter((frame) => frame.reset)).toHaveLength(2);
  });

  test("reselect restarts the snapshot for every subscriber, and a failing snapshot source is logged and yields nothing", () => {
    const { channel, client, framesOf, state } = harness();
    const a = client();
    const b = client();
    channel.subscribe(a, new Set(["iceberg_orders"]));
    channel.subscribe(b, new Set(["iceberg_orders"]));
    state.snapshot = { ts: 7000, liveSince: 1000, icebergs: [iceberg(9, { status: "ended", kind: "probable", confidence: "strong" })] };
    channel.reselect();
    expect(framesOf(a).at(-1)).toMatchObject({ reset: true, ts: 7000 });
    expect(framesOf(b).at(-1)).toMatchObject({ reset: true, ts: 7000 });
    state.snapshot = () => { throw new Error("boom"); };
    channel.reselect();
    expect(state.log.at(-1)).toContain("boom");
  });

  test("forget and stopAll release clients", () => {
    const { channel, client } = harness();
    const c = client();
    channel.subscribe(c, new Set(["iceberg_orders"]));
    channel.forget(c);
    expect(channel.size).toBe(0);
    channel.subscribe(c, new Set(["iceberg_orders"]));
    channel.stopAll();
    expect(channel.size).toBe(0);
  });

  test("the channel refuses to start without its collaborators", () => {
    expect(() => createIcebergChannel({ logPrefix: "" })).toThrow(/logPrefix/);
    expect(() => createIcebergChannel({ logPrefix: "x", safelySend: () => true, safelySendSerialized: () => true, activePair: () => null, identityOf: () => null })).toThrow(/snapshotOf/);
  });
});
