const { createL2Channel, parseL2Resync } = require("../../src/server/l2-channel");
const { L2_CHANNELS } = require("../../src/server/l2-frames");

const PAIR = { marketKind: "PERPETUAL", symbol: "BTCUSDT" };
const SEGMENT = Object.freeze({ id: "PERPETUAL:BTCUSDT:1000:LIVE", state: "LIVE" });

function column(ts) {
  return { ts, lo: 100, hi: 101, bid: [[0, 1]], ask: [[1, 1]] };
}

function wall(id, size = 12) {
  return {
    id, side: "bid", row: 200, span: 1, startTs: 1_000, endTs: null, size, peak: 12, endedBy: null, ratio: 4, chain: 0,
    fill: 0, eaten: 0, absorbing: false, detail: null,
  };
}

function snapshot({ viewChunks = 1, wallSeq = 3, eventSeq = 10, ts = 10_000 } = {}) {
  return {
    ts,
    rowWidth: 0.5,
    segment: SEGMENT,
    view: Array.from({ length: viewChunks }, (_, index) => ({
      lane: 1, tier: "recent", seq: index + 1, reset: index === 0, rowWidth: 1, columnMs: 2_000, columns: [column(2_000 * (index + 1))],
    })),
    walls: { seq: wallSeq, reset: true, walls: [wall(1)], removed: [] },
    lanedWalls: { seq: wallSeq + 40, reset: true, walls: [wall(1), { ...wall(10_000_001), lane: 1 }], removed: [] },
    events: { seq: eventSeq, reset: true, events: [{ event: "hidden", ts: 9_000, side: "bid", price: 100, volume: 1 }], missed: 0 },
    ladder: { depth: 50, bids: [[100, 1]], asks: [[101, 1]] },
  };
}

function increment(overrides = {}) {
  return {
    ts: 11_000,
    rowWidth: 0.5,
    fresh: false,
    segment: SEGMENT,
    view: [{ lane: 1, tier: "recent", seq: 2, reset: false, rowWidth: 1, columnMs: 2_000, columns: [column(10_000)] }],
    viewReset: false,
    walls: { seq: 4, reset: false, walls: [wall(1, 10)], removed: [] },
    lanedWalls: { seq: 44, reset: false, walls: [wall(1, 10), { ...wall(10_000_001, 11), lane: 1 }], removed: [] },
    events: { seq: 11, events: [{ event: "hidden", ts: 10_500, side: "bid", price: 100, volume: 1 }], missed: 0 },
    ladder: { depth: 50, bids: [[100, 2]], asks: [[101, 1]] },
    ...overrides,
  };
}

function fakeClient() {
  const frames = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    frames,
    of: (type) => frames.filter((frame) => frame.type === type),
  };
}

function setup({ snap = snapshot(), replayerOptions = { batch: Number.MAX_SAFE_INTEGER }, clock = { now: 0 } } = {}) {
  const errors = [];
  const source = { snap, active: PAIR, builds: 0 };
  const send = (client, serialized) => {
    client.frames.push(JSON.parse(serialized));
    return true;
  };
  const channel = createL2Channel({
    logPrefix: "test l2",
    wsOpen: 1,
    safelySend: (client, frame) => send(client, JSON.stringify(frame)),
    safelySendSerialized: send,
    softBytes: 1_000_000,
    activePair: () => source.active,
    identityOf: (pair) => ({ provider: "BINANCE", symbol: pair.symbol, marketKind: pair.marketKind }),
    snapshotOf: () => {
      source.builds += 1;
      return source.snap;
    },
    now: () => clock.now,
    log: { error: (...args) => errors.push(args.join(" ")) },
    replayerOptions,
  });
  return { channel, source, errors, clock };
}

describe("l2-channel: load bounds", () => {
  afterEach(() => jest.useRealTimers());

  test("one subscribe, publish or pair switch builds the engine snapshot once, however many channels need it", () => {
    const { channel, source } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(L2_CHANNELS));
    expect(source.builds).toBe(1);
    source.builds = 0;
    channel.publish(increment({ fresh: true }), PAIR);
    expect(source.builds).toBe(1);
    source.builds = 0;
    channel.reselect();
    expect(source.builds).toBe(1);
    expect(client.of("l2_walls").filter((frame) => frame.reset)).toHaveLength(3);
  });

  test("the server's pair objects need not be the same object for the snapshot to be shared", () => {
    const { channel, source } = setup();
    let calls = 0;
    source.active = null;
    const client = fakeClient();
    Object.defineProperty(source, "active", { get: () => { calls += 1; return { ...PAIR }; } });
    channel.subscribe(client, new Set(["l2_view", "l2_walls", "l2_events"]));
    expect(calls).toBeGreaterThan(1);
    expect(source.builds).toBe(1);
  });

  test("flipping a capability off and on is served at most once per interval, with no increment before its snapshot", () => {
    jest.useFakeTimers();
    const { channel, clock, source } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_walls"]));
    for (let flip = 0; flip < 20; flip += 1) {
      channel.subscribe(client, new Set());
      channel.subscribe(client, new Set(["l2_walls"]));
    }
    channel.publish(increment(), PAIR);
    expect(client.of("l2_walls").map((frame) => frame.reset)).toEqual([true]);
    expect(source.builds).toBe(1);
    clock.now += 2_000;
    jest.advanceTimersByTime(2_000);
    expect(client.of("l2_walls").map((frame) => frame.reset)).toEqual([true, true]);
    expect(source.builds).toBe(2);
    channel.publish(increment({ walls: { seq: 5, reset: false, walls: [wall(1, 9)], removed: [] } }), PAIR);
    expect(client.of("l2_walls").map((frame) => frame.reset)).toEqual([true, true, false]);
  });

  test("a client that opts out during the wait is not joined when the wait ends, and forgetting it cancels the wait", () => {
    jest.useFakeTimers();
    const { channel, clock } = setup();
    const quitter = fakeClient();
    const leaver = fakeClient();
    for (const client of [quitter, leaver]) {
      channel.subscribe(client, new Set(["l2_events"]));
      channel.subscribe(client, new Set());
      channel.subscribe(client, new Set(["l2_events"]));
    }
    channel.subscribe(quitter, new Set());
    channel.forget(leaver);
    clock.now += 2_000;
    jest.advanceTimersByTime(2_000);
    expect(quitter.of("l2_events")).toHaveLength(1);
    expect(leaver.of("l2_events")).toHaveLength(1);
    expect(channel.subscribers("l2_events")).toBe(0);
  });

  test("the ladder, being latest state, is never delayed", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.publish(increment(), PAIR);
    for (let flip = 0; flip < 3; flip += 1) {
      channel.subscribe(client, new Set(["l2_ladder"]));
      channel.subscribe(client, new Set());
    }
    expect(client.of("l2_ladder")).toHaveLength(3);
  });
});

describe("l2-channel: capability opt-in", () => {
  test("a client that declared nothing receives no L2 frame (an old client)", () => {
    const { channel } = setup();
    const old = fakeClient();
    channel.publish(increment(), PAIR);
    expect(old.frames).toEqual([]);
    expect(L2_CHANNELS.map((name) => channel.subscribers(name))).toEqual([0, 0, 0, 0]);
  });

  test("subscribing replays a reset snapshot per chosen channel and nothing else", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_walls", "marker_history"]));
    expect(client.frames.map((frame) => [frame.type, frame.reset])).toEqual([["l2_walls", true]]);
    expect(client.frames[0].seq).toBe(3);
  });

  test("increments reach only the channels a client chose", () => {
    const { channel } = setup();
    const walls = fakeClient();
    const everything = fakeClient();
    channel.subscribe(walls, new Set(["l2_walls"]));
    channel.subscribe(everything, new Set(L2_CHANNELS));
    walls.frames.length = 0;
    everything.frames.length = 0;
    channel.publish(increment(), PAIR);
    expect(walls.frames.map((frame) => frame.type)).toEqual(["l2_walls"]);
    expect(everything.frames.map((frame) => frame.type).sort()).toEqual(["l2_events", "l2_ladder", "l2_view", "l2_walls"]);
    expect(everything.of("l2_walls")[0]).toMatchObject({ seq: 4, reset: false });
    expect(everything.of("l2_events")[0]).toMatchObject({ seq: 11, reset: false });
  });

  test("a later declaration replaces the set: a dropped channel stops, a kept one is not replayed again", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_walls", "l2_events"]));
    client.frames.length = 0;
    channel.subscribe(client, new Set(["l2_walls"]));
    expect(client.frames).toEqual([]);
    channel.publish(increment(), PAIR);
    expect(client.frames.map((frame) => frame.type)).toEqual(["l2_walls"]);
    channel.subscribe(client, new Set());
    channel.publish(increment({ walls: { seq: 5, reset: false, walls: [wall(1, 9)], removed: [] } }), PAIR);
    expect(client.frames.map((frame) => frame.type)).toEqual(["l2_walls"]);
  });

  test("a forgotten client receives nothing more", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(L2_CHANNELS));
    channel.forget(client);
    client.frames.length = 0;
    channel.publish(increment(), PAIR);
    expect(client.frames).toEqual([]);
  });
});

describe("l2-channel: walls on the wider lanes only for a client that declares them (PR #31 review)", () => {
    test("a client on today's bundle gets the lane-0 frame with no lane field and its own seq; one that declares l2_walls_lanes gets every lane's walls, each with its lane", () => {
      const { channel } = setup();
      const old = fakeClient();
      const laned = fakeClient();
      channel.subscribe(old, new Set(["l2_walls"]));
      channel.subscribe(laned, new Set(["l2_walls", "l2_walls_lanes"]));
      const [oldSnap] = old.of("l2_walls");
      const [lanedSnap] = laned.of("l2_walls");
      expect(oldSnap).toMatchObject({ seq: 3, reset: true });
      expect(oldSnap.walls.map((entry) => [entry.id, "lane" in entry])).toEqual([[1, false]]);
      expect(lanedSnap).toMatchObject({ seq: 43, reset: true });
      expect(lanedSnap.walls.map((entry) => [entry.id, entry.lane])).toEqual([[1, 0], [10_000_001, 1]]);
      channel.publish(increment(), PAIR);
      expect(old.of("l2_walls")[1]).toMatchObject({ seq: 4, reset: false });
      expect(old.of("l2_walls")[1].walls.map((entry) => [entry.id, "lane" in entry])).toEqual([[1, false]]);
      expect(laned.of("l2_walls")[1]).toMatchObject({ seq: 44, reset: false });
      expect(laned.of("l2_walls")[1].walls.map((entry) => [entry.id, entry.lane])).toEqual([[1, 0], [10_000_001, 1]]);
      expect(channel.flagsOf(laned)).toEqual(new Set(["l2_walls", "l2_walls_lanes"]));
      expect(channel.flagsOf(old)).toEqual(new Set(["l2_walls"]));
    });

    test("a resync of l2_walls re-sends the variant the client declared, and switching the declaration moves it between them", () => {
      const clock = { now: 0 };
      const { channel } = setup({ clock });
      const laned = fakeClient();
      channel.subscribe(laned, new Set(["l2_walls", "l2_walls_lanes"]));
      clock.now += 60_000;
      expect(channel.resync(laned, "l2_walls")).toBe(true);
      expect(laned.of("l2_walls").map((frame) => frame.seq)).toEqual([43, 43]);
      channel.subscribe(laned, new Set(["l2_walls"]));
      clock.now += 60_000;
      channel.publish(increment(), PAIR);
      const after = laned.of("l2_walls").slice(2);
      expect(after.map((frame) => [frame.seq, frame.walls.every((entry) => !("lane" in entry))])).toEqual(expect.arrayContaining([[3, true]]));
      expect(after.some((frame) => frame.seq === 44)).toBe(false);
    });
  });

describe("l2-channel: sequencing and recovery", () => {
  test("a ladder subscriber gets the existing engine snapshot before the first broadcast", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_ladder"]));
    expect(client.of("l2_ladder")).toEqual([expect.objectContaining({ bids: [[100, 1]], asks: [[101, 1]] })]);
  });

  test("the ladder is latest-state: a late subscriber gets the last ladder at once", () => {
    const { channel } = setup();
    channel.publish(increment(), PAIR);
    const late = fakeClient();
    channel.subscribe(late, new Set(["l2_ladder"]));
    expect(late.frames).toHaveLength(1);
    expect(late.frames[0]).toMatchObject({ type: "l2_ladder", bids: [[100, 2]] });
  });

  test("a fresh engine state re-sends every chain as a snapshot instead of an increment", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(L2_CHANNELS));
    client.frames.length = 0;
    channel.publish(increment({ fresh: true }), PAIR);
    for (const type of ["l2_view", "l2_walls", "l2_events"]) {
      expect(client.of(type).every((frame) => frame.reset === true)).toBe(true);
      expect(client.of(type).length).toBeGreaterThan(0);
    }
    expect(client.of("l2_ladder")).toHaveLength(1);
  });

  test("a broken lane chain re-sends the view snapshot while the other channels stay incremental", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(L2_CHANNELS));
    client.frames.length = 0;
    channel.publish(increment({ viewReset: true }), PAIR);
    expect(client.of("l2_view")[0].reset).toBe(true);
    expect(client.of("l2_walls")[0].reset).toBe(false);
  });

  test("output for a pair that is no longer active is dropped", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(L2_CHANNELS));
    client.frames.length = 0;
    channel.publish(increment(), { marketKind: "SPOT", symbol: "ETHUSDT" });
    expect(client.frames).toEqual([]);
  });

  test("a resync names one channel, re-sends only it, and is rate limited", () => {
    const { channel, clock } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(L2_CHANNELS));
    client.frames.length = 0;
    expect(channel.resync(client, "l2_walls")).toBe(true);
    expect(client.frames.map((frame) => [frame.type, frame.reset])).toEqual([["l2_walls", true]]);
    expect(channel.resync(client, "l2_walls")).toBe(false);
    clock.now += 2_000;
    expect(channel.resync(client, "l2_walls")).toBe(true);
  });

  test("a resync of a channel the client did not choose does nothing", () => {
    const { channel } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_ladder"]));
    expect(channel.resync(client, "l2_walls")).toBe(false);
  });

  test("an increment that cannot be built is replaced by a snapshot and logged", () => {
    const { channel, errors } = setup();
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_walls"]));
    client.frames.length = 0;
    channel.publish(increment({ walls: { seq: 4, reset: false, walls: [wall(0)], removed: [] } }), PAIR);
    expect(client.frames.map((frame) => [frame.type, frame.reset])).toEqual([["l2_walls", true]]);
    expect(errors.join("\n")).toMatch(/l2_walls increment failed/);
  });

  test("a pair switch replays each chain and immediately sends the new pair's ladder", () => {
    const { channel, source } = setup();
    const client = fakeClient();
    channel.publish(increment(), PAIR);
    channel.subscribe(client, new Set(L2_CHANNELS));
    client.frames.length = 0;
    source.active = { marketKind: "SPOT", symbol: "ETHUSDT" };
    source.snap = { ...snapshot(), segment: { id: "SPOT:ETHUSDT:1000:LIVE", state: "LIVE" } };
    channel.reselect();
    expect(client.of("l2_walls")[0].reset).toBe(true);
    expect(client.of("l2_ladder")).toEqual([expect.objectContaining({ symbol: "ETH-USDT", bids: [[100, 1]] })]);
    const late = fakeClient();
    channel.subscribe(late, new Set(["l2_ladder"]));
    expect(late.of("l2_ladder")).toEqual([expect.objectContaining({ symbol: "ETH-USDT", bids: [[100, 1]] })]);
  });

  test("a pair switch without a new snapshot never sends the previous pair's ladder", () => {
    const { channel, source } = setup();
    const client = fakeClient();
    channel.publish(increment(), PAIR);
    channel.subscribe(client, new Set(["l2_ladder"]));
    client.frames.length = 0;
    source.active = { marketKind: "SPOT", symbol: "ETHUSDT" };
    source.snap = null;
    channel.reselect();
    expect(client.frames).toEqual([]);
    const late = fakeClient();
    channel.subscribe(late, new Set(["l2_ladder"]));
    expect(late.frames).toEqual([]);
  });

  test("before any engine state exists a subscriber gets nothing, then the first fresh output snapshots it", () => {
    const { channel, source } = setup();
    source.snap = null;
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_walls"]));
    expect(client.frames).toEqual([]);
    source.snap = snapshot();
    channel.publish(increment({ fresh: true }), PAIR);
    expect(client.frames.map((frame) => [frame.type, frame.reset])).toEqual([["l2_walls", true]]);
  });
});

describe("l2-channel: replay pacing", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("increments published during a paced replay are queued behind it: no duplicate, no gap", () => {
    const { channel } = setup({ snap: snapshot({ viewChunks: 9 }), replayerOptions: { batch: 4 } });
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_view"]));
    expect(client.of("l2_view")).toHaveLength(4);
    channel.publish(increment({ view: [{ lane: 1, tier: "recent", seq: 10, reset: false, rowWidth: 1, columnMs: 2_000, columns: [column(20_000)] }] }), PAIR);
    jest.runAllTimers();
    const seqs = client.of("l2_view").map((frame) => frame.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("a replay whose queue overflows ends in a fresh snapshot, not a gap", () => {
    const { channel, source } = setup({ snap: snapshot({ viewChunks: 6 }), replayerOptions: { batch: 4, queueCap: 1 } });
    const client = fakeClient();
    channel.subscribe(client, new Set(["l2_view"]));
    channel.publish(increment({ view: [{ lane: 1, tier: "recent", seq: 7, reset: false, rowWidth: 1, columnMs: 2_000, columns: [column(20_000)] }] }), PAIR);
    channel.publish(increment({ view: [{ lane: 1, tier: "recent", seq: 8, reset: false, rowWidth: 1, columnMs: 2_000, columns: [column(22_000)] }] }), PAIR);
    source.snap = snapshot({ viewChunks: 8 });
    jest.runAllTimers();
    const frames = client.of("l2_view");
    const lastReset = frames.map((frame) => frame.reset).lastIndexOf(true);
    expect(lastReset).toBeGreaterThan(0);
    expect(frames.slice(lastReset).map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("parseL2Resync", () => {
  test("names exactly one known channel", () => {
    expect(parseL2Resync({ type: "l2_resync", channel: "l2_events" })).toBe("l2_events");
  });

  test.each([
    [{ type: "l2_resync" }],
    [{ type: "l2_resync", channel: "liquidity" }],
    [{ type: "l2_resync", channel: "l2_walls", extra: 1 }],
    [{ type: "liquidity_resync", channel: "l2_walls" }],
    [null],
  ])("refuses %j", (message) => {
    expect(parseL2Resync(message)).toBeNull();
  });
});
