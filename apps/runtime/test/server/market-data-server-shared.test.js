// The heatmap's every-pair sampling keeps feeds open across a switch; these tests assert the single-pair lifecycle.
process.env.L2_HEATMAP_TRACK_ALL = "0";
const {
  parseHistoryRanges,
  createSelectionRateLimiter,
  createFrameDispatch,
  createLiquidityReplayer,
  MAX_HISTORY_RANGES,
  SELECTION_RATE_WINDOW_MS,
  MAX_SELECTIONS_PER_WINDOW,
  vpinBackfillPlan,
  createVpinWarmupRetryPolicy,
  VPIN_WARMUP_RETRY_STEPS_MS,
  VPIN_REMOTE_BACKFILL_SLICE_MS,
  VPIN_REMOTE_BACKFILL_CHUNK_MS,
} = require("../../src/server/market-data-server-shared");

// A2.21 / L1L2-V2-046(a). Three market-data servers, ~4.5k lines, with 18
// function names still appearing in all three after this extraction. Most
// differ substantively -- session architecture, provider semantics -- and
// merging those would be a redesign, not a deduplication. Four did not, and
// those four are what lives here: parseHistoryRanges was identical in all
// three, and allowSelectionRequest / broadcast / safelySend differed ONLY in a
// log prefix and, on Binance, a hardcoded Date.now() where the dxFeed pair took
// an injectable clock.
//
// That last asymmetry is the finding in miniature: the Binance copy was not
// merely duplicated, it had quietly drifted to be untestable against a frozen
// clock. L1L2-V2-044 is what this duplication costs -- one defect, three
// copies, three suites each written against its own copy, all green.

describe("parseHistoryRanges", () => {
  const PERIOD = 60_000;
  const valid = (startTs) => ({ range_start_ts: startTs, range_end_ts: startTs + PERIOD });

  test("accepts aligned, exactly-one-period ranges", () => {
    expect(parseHistoryRanges([valid(0), valid(PERIOD)], PERIOD)).toEqual([
      { rangeStartTs: 0, rangeEndTs: PERIOD },
      { rangeStartTs: PERIOD, rangeEndTs: 2 * PERIOD },
    ]);
  });

  test.each([
    ["not an array", "nope"],
    ["empty", []],
    ["over the cap", Array.from({ length: MAX_HISTORY_RANGES + 1 }, (_, i) => ({ range_start_ts: i * 60_000, range_end_ts: i * 60_000 + 60_000 }))],
  ])("rejects %s", (_label, input) => {
    expect(parseHistoryRanges(input, PERIOD)).toBeNull();
  });

  test.each([
    ["a null entry", [null]],
    ["an extra key", [{ ...valid(0), extra: 1 }]],
    ["a missing key", [{ range_start_ts: 0 }]],
    ["a negative start", [{ range_start_ts: -60_000, range_end_ts: 0 }]],
    ["an end at or before start", [{ range_start_ts: 0, range_end_ts: 0 }]],
    ["a span that is not exactly one period", [{ range_start_ts: 0, range_end_ts: 30_000 }]],
    ["a start not aligned to the period", [{ range_start_ts: 30_000, range_end_ts: 90_000 }]],
    ["a duplicate start", [valid(0), valid(0)]],
  ])("rejects %s", (_label, input) => {
    expect(parseHistoryRanges(input, PERIOD)).toBeNull();
  });
});

describe("createSelectionRateLimiter", () => {
  test("allows up to the cap inside one window, then refuses", () => {
    let nowMs = 1_000;
    const limiter = createSelectionRateLimiter({ now: () => nowMs });
    const client = {};

    for (let i = 0; i < MAX_SELECTIONS_PER_WINDOW; i += 1) {
      expect(limiter.allowSelectionRequest(client)).toBe(true);
    }
    expect(limiter.allowSelectionRequest(client)).toBe(false);
  });

  test("starts a fresh window once the old one has elapsed", () => {
    let nowMs = 1_000;
    const limiter = createSelectionRateLimiter({ now: () => nowMs });
    const client = {};
    for (let i = 0; i < MAX_SELECTIONS_PER_WINDOW + 1; i += 1) limiter.allowSelectionRequest(client);

    nowMs += SELECTION_RATE_WINDOW_MS;

    expect(limiter.allowSelectionRequest(client)).toBe(true);
  });

  // A clock that jumps backwards (NTP correction) must not lock a client out
  // until wall-clock catches up again.
  test("a backwards clock jump restarts the window rather than stranding the client", () => {
    let nowMs = 10_000;
    const limiter = createSelectionRateLimiter({ now: () => nowMs });
    const client = {};
    for (let i = 0; i < MAX_SELECTIONS_PER_WINDOW + 1; i += 1) limiter.allowSelectionRequest(client);

    nowMs = 5_000;

    expect(limiter.allowSelectionRequest(client)).toBe(true);
  });

  test("rate-limits each client independently", () => {
    const limiter = createSelectionRateLimiter({ now: () => 1_000 });
    const a = {};
    const b = {};
    for (let i = 0; i < MAX_SELECTIONS_PER_WINDOW + 1; i += 1) limiter.allowSelectionRequest(a);

    expect(limiter.allowSelectionRequest(a)).toBe(false);
    expect(limiter.allowSelectionRequest(b)).toBe(true);
  });

  test("a null client is never rate-limited", () => {
    const limiter = createSelectionRateLimiter({ now: () => 1_000 });
    for (let i = 0; i < MAX_SELECTIONS_PER_WINDOW * 3; i += 1) {
      expect(limiter.allowSelectionRequest(null)).toBe(true);
    }
  });

  test.each([
    ["a non-function clock", { now: 5 }],
    ["a zero window", { windowMs: 0 }],
    ["a zero cap", { maxPerWindow: 0 }],
  ])("rejects %s at construction rather than misbehaving later", (_label, options) => {
    expect(() => createSelectionRateLimiter(options)).toThrow(/market-data-server-shared/);
  });
});

describe("createFrameDispatch", () => {
  const WS_OPEN = 1;

  function harness({ logPrefix = "test server", clients = [] } = {}) {
    const sent = [];
    const errors = [];
    const dispatch = createFrameDispatch({
      logPrefix,
      clients,
      wsOpen: WS_OPEN,
      safelySendSerialized: (client, payload) => {
        sent.push({ client, payload });
        return true;
      },
      log: { error: (...args) => errors.push(args) },
    });
    return { dispatch, sent, errors };
  }

  test("broadcast serializes once and sends to every open client", () => {
    const clients = [{ readyState: WS_OPEN }, { readyState: WS_OPEN }];
    const { dispatch, sent } = harness({ clients });

    dispatch.broadcast({ type: "trade", price: 1 });

    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.payload)).size).toBe(1);
  });

  test("broadcast skips clients that are not open", () => {
    const clients = [{ readyState: WS_OPEN }, { readyState: 3 }];
    const { dispatch, sent } = harness({ clients });

    dispatch.broadcast({ type: "trade" });

    expect(sent).toHaveLength(1);
  });

  // A frame that cannot serialize must not take the whole broadcast loop down.
  test("an unserializable frame is reported and dropped, not thrown", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const { dispatch, sent, errors } = harness({ clients: [{ readyState: WS_OPEN }] });

    expect(() => dispatch.broadcast(cyclic)).not.toThrow();
    expect(sent).toHaveLength(0);
    expect(errors[0][0]).toBe("test server: broadcast frame serialization failed");
  });

  test("safelySend reports an unserializable frame as false rather than throwing", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const { dispatch, errors } = harness();

    expect(dispatch.safelySend({}, cyclic)).toBe(false);
    expect(errors[0][0]).toBe("test server: frame serialization failed");
  });

  // The log prefix is the only thing that differed between the three servers'
  // copies, so it is the one thing worth pinning as caller-supplied.
  test("each server's own prefix appears in its diagnostics", () => {
    for (const prefix of ["market data server", "dxfeed market data server", "dxfeed eager market data server"]) {
      const cyclic = {};
      cyclic.self = cyclic;
      const { dispatch, errors } = harness({ logPrefix: prefix });

      dispatch.safelySend({}, cyclic);

      expect(errors[0][0]).toBe(`${prefix}: frame serialization failed`);
    }
  });

  test.each([
    ["an empty prefix", { logPrefix: "" }],
    ["a missing send function", { logPrefix: "x", safelySendSerialized: undefined }],
  ])("rejects %s at construction", (_label, overrides) => {
    expect(() => createFrameDispatch({
      logPrefix: "x", clients: [], wsOpen: 1, safelySendSerialized: () => true, ...overrides,
    })).toThrow(/market-data-server-shared/);
  });
});

describe("createLiquidityReplayer.announce", () => {
  // A backfill pass used to broadcast its whole snapshot to every socket at
  // once, every 15 s: about 7 MB for BTC, which filled a slow client's buffer
  // until it was evicted (1013). An announce must be paced like any snapshot.
  function harness({ bufferedAmount = 0, maxMs = 60_000 } = {}) {
    const clients = new Set();
    const sent = new Map();
    const fresh = [{ type: "liquidity", seq: 99, reset: true }];
    const client = () => {
      const c = { readyState: 1, bufferedAmount, close: jest.fn() };
      clients.add(c);
      sent.set(c, []);
      return c;
    };
    const replayer = createLiquidityReplayer({
      logPrefix: "test",
      clients,
      wsOpen: 1,
      safelySend: (c, frame) => {
        sent.get(c).push(frame);
        return true;
      },
      safelySendSerialized: () => true,
      snapshotFrames: () => fresh,
      softBytes: 1_000,
      batch: 2,
      maxMs,
    });
    return { replayer, client, sent, fresh };
  }
  const frames = (n) => Array.from({ length: n }, (_, i) => ({ type: "liquidity", seq: i + 1, reset: i === 0 }));

  test("paces an announce per client instead of pushing the whole snapshot at once", () => {
    jest.useFakeTimers();
    try {
      const { replayer, client, sent } = harness();
      const a = client();
      const b = client();
      replayer.announce(frames(6));
      expect(sent.get(a)).toHaveLength(2);
      expect(sent.get(b)).toHaveLength(2);
      jest.runAllTimers();
      expect(sent.get(a).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(sent.get(b).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("waits while a client's buffer is over a quarter of the soft limit", () => {
    jest.useFakeTimers();
    try {
      const { replayer, client, sent } = harness({ bufferedAmount: 300 });
      const slow = client();
      replayer.announce(frames(4));
      jest.advanceTimersByTime(200);
      expect(sent.get(slow)).toHaveLength(0);
      slow.bufferedAmount = 0;
      jest.runAllTimers();
      expect(sent.get(slow)).toHaveLength(4);
    } finally {
      jest.useRealTimers();
    }
  });

  test("closes a client whose paced snapshot cannot drain before the replay deadline", () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { replayer, client, sent } = harness({ bufferedAmount: 300, maxMs: 100 });
      const slow = client();
      replayer.announce(frames(4));
      jest.advanceTimersByTime(140);
      expect(sent.get(slow)).toHaveLength(0);
      expect(slow.close).toHaveBeenCalledWith(1013, expect.any(String));
      expect(replayer.size).toBe(0);
      expect(warn).toHaveBeenCalledWith("test: closing a client whose snapshot replay could not keep up (1013)", { sentFrames: 0, totalFrames: 4, bufferedAmount: 300 });
      expect(slow.closeCause).toBe("snapshot-replay-timeout");
      expect(slow.closeBufferedAmount).toBe(300);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  test("an announce during a replay does not restart it: that client gets one fresh snapshot when the current one finishes", () => {
    jest.useFakeTimers();
    try {
      const { replayer, client, sent, fresh } = harness();
      const a = client();
      replayer.announce(frames(6));
      replayer.announce(frames(6));
      replayer.announce(frames(6));
      jest.runAllTimers();
      expect(sent.get(a).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, fresh[0].seq]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("skips clients that are not open and ignores an empty announce", () => {
    const { replayer, client, sent } = harness();
    const closed = client();
    closed.readyState = 3;
    replayer.announce(frames(3));
    replayer.announce([]);
    expect(sent.get(closed)).toHaveLength(0);
    expect(replayer.size).toBe(0);
  });
});

describe("vpinBackfillPlan", () => {
  // Property: storage locality decides the VPIN backfill mode -- a remote
  // reader gets the sliced aggregate with the remote geometry, a local one
  // stays exact. Oracle: the plan object the worker input is spread from.
  test("a remote reader is backfilled from the sliced aggregate at the remote geometry; a local one exactly", () => {
    expect(vpinBackfillPlan({ remote: { baseUrl: "http://10.88.0.1:8001/live-storage", token: "t" } })).toEqual({
      backfillMode: "SLICED_APPROXIMATE", backfillSliceMs: VPIN_REMOTE_BACKFILL_SLICE_MS, backfillChunkMs: VPIN_REMOTE_BACKFILL_CHUNK_MS,
    });
    expect(vpinBackfillPlan({ dbPath: "C:/data/market-data.sqlite" })).toEqual({ backfillMode: "EXACT" });
    expect(vpinBackfillPlan({ remote: null })).toEqual({ backfillMode: "EXACT" });
    expect(vpinBackfillPlan(undefined)).toEqual({ backfillMode: "EXACT" });
  });

  test("the remote geometry keeps a six-hour chunk of two-second slices under the gateway's body cap", () => {
    expect(VPIN_REMOTE_BACKFILL_SLICE_MS).toBe(2_000);
    expect(VPIN_REMOTE_BACKFILL_CHUNK_MS).toBe(6 * 60 * 60 * 1_000);
    const rowsPerChunk = VPIN_REMOTE_BACKFILL_CHUNK_MS / VPIN_REMOTE_BACKFILL_SLICE_MS;
    expect(rowsPerChunk * 90).toBeLessThan(2_000_000);
  });
});

describe("createVpinWarmupRetryPolicy", () => {
  // Property: a warm-up that keeps failing backs off to a long retry instead
  // of relaunching every 15 s (the 7-day exact backfill over a 200 KB/s link
  // died at its 10-minute deadline and restarted forever), a transient first
  // failure still retries quickly, and the same reason is logged once per
  // pair. Oracle: the returned delays and the log call log.
  test("escalates 15 s -> 60 s -> 10 min and holds, resets on success, logs a reason once per pair", () => {
    const log = jest.fn();
    const policy = createVpinWarmupRetryPolicy({ log, label: "test server" });
    expect(VPIN_WARMUP_RETRY_STEPS_MS).toEqual([15_000, 60_000, 600_000]);
    expect(policy.failed("SPOT:BTCUSDT", "BACKFILL_INCOMPLETE", { pagesFetched: 1_000 })).toBe(15_000);
    expect(policy.failed("SPOT:BTCUSDT", "BACKFILL_INCOMPLETE", { pagesFetched: 1_000 })).toBe(60_000);
    expect(policy.failed("SPOT:BTCUSDT", "BACKFILL_INCOMPLETE", { pagesFetched: 1_000 })).toBe(600_000);
    expect(policy.failed("SPOT:BTCUSDT", "BACKFILL_INCOMPLETE", { pagesFetched: 1_000 })).toBe(600_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("SPOT:BTCUSDT");
    expect(log.mock.calls[0][0]).toContain("BACKFILL_INCOMPLETE");
    expect(policy.failed("SPOT:BTCUSDT", "WORKER_FAILED", "boom")).toBe(600_000);
    expect(log).toHaveBeenCalledTimes(2);
    expect(policy.failed("PERPETUAL:ETHUSDT", "WORKER_FAILED", "boom")).toBe(15_000);
    policy.succeeded("SPOT:BTCUSDT");
    expect(policy.failed("SPOT:BTCUSDT", "WORKER_FAILED", "boom")).toBe(15_000);
    expect(log).toHaveBeenCalledTimes(4);
    policy.forget("PERPETUAL:ETHUSDT");
    expect(policy.failed("PERPETUAL:ETHUSDT", "WORKER_FAILED", "boom")).toBe(15_000);
    policy.clear();
    expect(policy.failed("SPOT:BTCUSDT", "WORKER_FAILED", "boom")).toBe(15_000);
    expect(() => createVpinWarmupRetryPolicy({ log: null, label: "x" })).toThrow(/log/);
    expect(() => createVpinWarmupRetryPolicy({ log, label: "" })).toThrow(/label/);
  });
});
