const { createPyramidWarmup, providerOf } = require("../../../src/indicators/l2-memory/pyramid/pyramid-warmup");
const { WINDOW_MS, encodeWindow } = require("../../../src/indicators/l2-memory/pyramid/pyramid-levels");

const W0 = Math.floor(1_757_340_000_000 / WINDOW_MS) * WINDOW_MS;
const GEOMETRY = { tickSize: 0.1, clusterTicks: 5, rowClusters: 8, rowWidth: 4, windowRows: 1023 };

function column(ts, size = 1) {
  return { ts, lo: 100, hi: 101, bid: Float64Array.from([size, 0]), ask: Float64Array.from([0, 2]) };
}

function pageOf(fromTs, toTs, { next = null, geometry = GEOMETRY } = {}) {
  const windows = [];
  for (let ts = fromTs; ts < Math.min(toTs, next ?? toTs); ts += WINDOW_MS) {
    windows.push({ ts, state: "COVERED", columns: JSON.parse(JSON.stringify(encodeWindow(Array.from({ length: 30 }, (_, i) => column(ts + i * 10_000, i))))) });
  }
  return { available: true, geometry, levelMs: 10_000, rowFactor: 1, span: { oldest: W0, newest: W0 + 10 * WINDOW_MS }, windows, next };
}

describe("pyramid warm-up source (P4c.5)", () => {
  test("names the provider by market kind", () => {
    expect(providerOf("PERPETUAL")).toBe("binance");
    expect(providerOf("SPOT")).toBe("binance");
    expect(providerOf("FUTURE")).toBe("dxfeed");
    expect(providerOf("EQUITY")).toBe("dxfeed");
  });

  test("reads a pair's pinned rows once, answers from memory, refreshes when stale, and survives a failed read", async () => {
    let at = W0 + 30 * 60_000;
    const read = jest.fn(async () => ({ available: true, geometry: GEOMETRY, windows: [], next: null, levelMs: 300_000, rowFactor: 1, span: {} }));
    const warmup = createPyramidWarmup({ read, now: () => at, pinRefreshMs: 60_000 });
    expect(warmup.pinned("PERPETUAL", "BTCUSDT")).toBeNull();
    await warmup.refreshPin("PERPETUAL", "BTCUSDT");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0].slice(0, 3)).toEqual(["binance", "BTCUSDT", "PERPETUAL"]);
    expect(read.mock.calls[0][3].levelMs).toBe(300_000);
    expect(warmup.pinned("PERPETUAL", "BTCUSDT")).toMatchObject({ rowClusters: 8, tickSize: 0.1, clusterTicks: 5 });
    expect(read).toHaveBeenCalledTimes(1);
    at += 60_000;
    warmup.pinned("PERPETUAL", "BTCUSDT");
    await new Promise((resolve) => setImmediate(resolve));
    expect(read).toHaveBeenCalledTimes(2);
    const failing = createPyramidWarmup({ read: async () => { throw new Error("host down"); }, now: () => at });
    await expect(failing.refreshPin("FUTURE", "/NQZ26:XCME")).resolves.toBeNull();
    expect(failing.stats()).toMatchObject({ failed: 1, pinned: 0 });
  });

  test("hands back decoded 10 s columns over a span, following next, only in the asked rows", async () => {
    const read = jest.fn(async (provider, symbol, kind, options) => (options.fromTs < W0 + 2 * WINDOW_MS ? pageOf(W0, W0 + 3 * WINDOW_MS, { next: W0 + 2 * WINDOW_MS }) : pageOf(options.fromTs, options.toTs)));
    const warmup = createPyramidWarmup({ read });
    const got = await warmup.deepColumns({ marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: W0 + 20_000, toTs: W0 + 3 * WINDOW_MS - 30_000, geometry: { rowWidth: 4, tickSize: 0.1, clusterTicks: 5 } });
    expect(got.reason).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.every((call) => call[3].levelMs === 10_000 && call[3].rowFactor === undefined)).toBe(true);
    expect(got.columns[0].ts).toBe(W0 + 20_000);
    expect(got.columns.at(-1).ts).toBe(W0 + 3 * WINDOW_MS - 40_000);
    expect(got.columns).toHaveLength(90 - 2 - 3);
    expect(Array.from(got.columns[1].bid)).toEqual([3, 0]);
  });

  test("refuses pages in other rows, and reports an unavailable or failed host instead of throwing", async () => {
    const warmup = (read) => createPyramidWarmup({ read, wait: async () => {} });
    const ask = { marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: W0, toTs: W0 + WINDOW_MS, geometry: { rowWidth: 2, tickSize: 0.1, clusterTicks: 5 } };
    await expect(warmup(async () => pageOf(W0, W0 + WINDOW_MS)).deepColumns(ask)).resolves.toEqual({ columns: [], reason: "GEOMETRY" });
    await expect(warmup(async () => pageOf(W0, W0 + WINDOW_MS, { geometry: { ...GEOMETRY, rowWidth: 2, tickSize: 0.01 } })).deepColumns(ask)).resolves.toEqual({ columns: [], reason: "GEOMETRY" });
    await expect(warmup(async () => ({ available: false, reason: "NO_PYRAMID" })).deepColumns(ask)).resolves.toEqual({ columns: [], reason: "NO_PYRAMID after 3 tries" });
    const failed = await warmup(async () => { throw new Error("socket hang up"); }).deepColumns(ask);
    expect(failed).toEqual({ columns: [], reason: "READ_FAILED: socket hang up after 3 tries" });
  });

  test("a page cap or stalled cursor never returns an apparently complete deep warm-up", async () => {
    const ask = { marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: W0, toTs: W0 + 65 * WINDOW_MS, geometry: GEOMETRY };
    const stalled = createPyramidWarmup({ read: async () => ({ ...pageOf(W0, W0, { next: W0 }), windows: [] }) });
    await expect(stalled.deepColumns(ask)).resolves.toEqual({ columns: [], reason: "PAGE_CURSOR" });
    const capped = createPyramidWarmup({ read: async (_provider, _symbol, _kind, options) => ({ ...pageOf(W0, W0, { next: options.fromTs + WINDOW_MS }), windows: [] }) });
    await expect(capped.deepColumns(ask)).resolves.toEqual({ columns: [], reason: "PAGE_LIMIT" });
    expect(capped.stats().pages).toBe(64);
  });

  test("a refused or failed page is asked again after a short wait, three tries in all, and the reason names the last refusal", async () => {
    const ask = { marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: W0, toTs: W0 + WINDOW_MS, geometry: GEOMETRY };
    const waits = [];
    const wait = jest.fn(async (ms) => { waits.push(ms); });
    let calls = 0;
    const flaky = createPyramidWarmup({ wait, read: async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      if (calls === 2) return { available: false, reason: "STORAGE_UNAVAILABLE" };
      return pageOf(W0, W0 + WINDOW_MS);
    } });
    const result = await flaky.deepColumns(ask);
    expect(result.reason).toBeNull();
    expect(result.columns).toHaveLength(30);
    expect(calls).toBe(3);
    expect(waits).toEqual([2_000, 5_000]);
    expect(flaky.stats().retries).toBe(2);

    const stubborn = createPyramidWarmup({ wait, read: async () => ({ available: false, reason: "STORAGE_UNAVAILABLE" }) });
    await expect(stubborn.deepColumns(ask)).resolves.toEqual({ columns: [], reason: "STORAGE_UNAVAILABLE after 3 tries" });
    expect(waits).toEqual([2_000, 5_000, 2_000, 5_000]);

    const geometry = createPyramidWarmup({ wait, read: async () => pageOf(W0, W0 + WINDOW_MS, { geometry: { ...GEOMETRY, rowWidth: 2 } }) });
    await expect(geometry.deepColumns(ask)).resolves.toEqual({ columns: [], reason: "GEOMETRY" });
    expect(waits).toHaveLength(4);
  });

  test("at most two pairs read the host at once; the rest wait their turn", async () => {
    const release = [];
    const read = jest.fn(() => new Promise((resolve) => release.push(() => resolve(pageOf(W0, W0 + WINDOW_MS)))));
    const warmup = createPyramidWarmup({ read });
    const asks = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((symbol) => warmup.deepColumns({ marketKind: "PERPETUAL", symbol, fromTs: W0, toTs: W0 + WINDOW_MS, geometry: GEOMETRY }));
    await Promise.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    release.shift()();
    await asks[0];
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(3);
    release.shift()();
    release.shift()();
    const results = await Promise.all(asks);
    expect(results.every((result) => result.reason === null && result.columns.length === 30)).toBe(true);
  });

  describe("windows kept in memory (PR #58 review)", () => {
    const { windowStart, WINDOW_MS: W } = require("../../../src/indicators/l2-memory/pyramid/pyramid-levels");
    const HOUR = 12 * W;
    const ask = (fromTs, toTs, geometry = GEOMETRY) => ({ marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs, toTs, geometry });
    const hostOf = (read) => jest.fn(async (_provider, _symbol, _kind, options) => read(options));
    const aligned = (options) => pageOf(windowStart(options.fromTs), options.toTs);

    test("an hour read once answers the next asks from memory: the same hour, or the hour shifted by less than a window, costs no host read; a shift past a window boundary reads only the new window", async () => {
      const read = hostOf(aligned);
      const warmup = createPyramidWarmup({ read });
      const first = await warmup.deepColumns(ask(W0, W0 + HOUR));
      expect(read).toHaveBeenCalledTimes(1);
      expect(first.columns).toHaveLength(360);
      const again = await warmup.deepColumns(ask(W0, W0 + HOUR));
      expect(read).toHaveBeenCalledTimes(1);
      expect(again.columns.map((c) => c.ts)).toEqual(first.columns.map((c) => c.ts));
      const shifted = await warmup.deepColumns(ask(W0 + 10_000, W0 + HOUR));
      expect(read).toHaveBeenCalledTimes(1);
      expect(shifted.columns).toHaveLength(359);
      expect(shifted.columns[0].ts).toBe(W0 + 10_000);
      expect(warmup.stats()).toMatchObject({ cachedWindows: 24, keptWindows: 12 });
      const past = await warmup.deepColumns(ask(W0 + 10_000, W0 + HOUR + 10_000));
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[1][3]).toMatchObject({ fromTs: W0 + HOUR, toTs: W0 + HOUR + 10_000 });
      expect(past.columns).toHaveLength(360);
      expect(past.columns.at(-1).ts).toBe(W0 + HOUR);
      expect(warmup.stats()).toMatchObject({ cachedWindows: 36, keptWindows: 13, columns: 360 + 360 + 359 + 360 });
    });

    test("asks for the same windows while a read is in flight share that read; one that only overlaps waits for the shared window and reads the rest", async () => {
      const release = [];
      const read = jest.fn((_provider, _symbol, _kind, options) => new Promise((resolve) => release.push(() => resolve(aligned(options)))));
      const warmup = createPyramidWarmup({ read });
      const leader = warmup.deepColumns(ask(W0, W0 + HOUR));
      const follower = warmup.deepColumns(ask(W0 + 10_000, W0 + HOUR));
      const overlapping = warmup.deepColumns(ask(W0 + HOUR - W, W0 + HOUR + W));
      await Promise.resolve();
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[1][3]).toMatchObject({ fromTs: W0 + HOUR, toTs: W0 + HOUR + W });
      release.shift()();
      const [a, b] = await Promise.all([leader, follower]);
      expect(a.columns).toHaveLength(360);
      expect(b.columns).toHaveLength(359);
      expect(b.columns[0]).toBe(a.columns[1]);
      release.shift()();
      const c = await overlapping;
      expect(c.columns).toHaveLength(60);
      expect(c.columns[0]).toBe(a.columns[330]);
      expect(warmup.stats()).toMatchObject({ sharedWindows: 13, cachedWindows: 0 });
    });

    test("a kept window expires after the time limit, and the memory holds at most the byte budget, the oldest windows out first", async () => {
      let at = W0 + 2 * HOUR;
      const read = hostOf(aligned);
      const windowBytes = JSON.stringify(pageOf(W0, W0 + W).windows[0].columns).length;
      const warmup = createPyramidWarmup({ read, now: () => at, cacheBytes: 2 * windowBytes, cacheTtlMs: 60_000 });
      await warmup.deepColumns(ask(W0, W0 + HOUR));
      expect(warmup.stats()).toMatchObject({ keptWindows: 2, keptBytes: 2 * windowBytes });
      await warmup.deepColumns(ask(W0 + HOUR - 2 * W, W0 + HOUR));
      expect(read).toHaveBeenCalledTimes(1);
      await warmup.deepColumns(ask(W0, W0 + W));
      expect(read).toHaveBeenCalledTimes(2);
      expect(warmup.stats().keptBytes).toBeLessThanOrEqual(2 * windowBytes);
      at += 60_000;
      await warmup.deepColumns(ask(W0, W0 + W));
      expect(read).toHaveBeenCalledTimes(3);
      const none = createPyramidWarmup({ read: hostOf(aligned), cacheBytes: 0 });
      await none.deepColumns(ask(W0, W0 + W));
      expect(none.stats()).toMatchObject({ keptWindows: 0, keptBytes: 0 });
      expect(() => createPyramidWarmup({ read, cacheBytes: -1 })).toThrow(/cacheBytes/);
      expect(() => createPyramidWarmup({ read, cacheTtlMs: 0 })).toThrow(/cacheTtlMs/);
    });

    test("a read that fails answers every ask waiting on it with the reason and keeps nothing, so the next ask tries the host again", async () => {
      let calls = 0;
      const read = jest.fn(async (_provider, _symbol, _kind, options) => {
        calls += 1;
        if (calls <= 3) return { available: false, reason: "STORAGE_UNAVAILABLE" };
        return aligned(options);
      });
      const warmup = createPyramidWarmup({ read, wait: async () => {} });
      const [leader, follower] = await Promise.all([warmup.deepColumns(ask(W0, W0 + W)), warmup.deepColumns(ask(W0 + 10_000, W0 + W))]);
      expect(leader).toEqual({ columns: [], reason: "STORAGE_UNAVAILABLE after 3 tries" });
      expect(follower).toEqual(leader);
      expect(warmup.stats()).toMatchObject({ keptWindows: 0, keptBytes: 0 });
      const later = await warmup.deepColumns(ask(W0, W0 + W));
      expect(later.columns).toHaveLength(30);
      expect(calls).toBe(4);
    });

    test("only a COVERED window is kept: a PARTIAL one, which the host rebuilds once its capture lands, is read again, and the rebuilt window is kept", async () => {
      let state = "PARTIAL";
      const read = hostOf((options) => {
        const page = aligned(options);
        return { ...page, windows: page.windows.map((window) => ({ ...window, state, columns: state === "PARTIAL" ? JSON.parse(JSON.stringify(encodeWindow(Array.from({ length: 10 }, (_, i) => column(window.ts + i * 10_000, i))))) : window.columns })) };
      });
      const warmup = createPyramidWarmup({ read });
      expect((await warmup.deepColumns(ask(W0, W0 + W))).columns).toHaveLength(10);
      expect(warmup.stats()).toMatchObject({ keptWindows: 0, keptBytes: 0 });
      state = "COVERED";
      expect((await warmup.deepColumns(ask(W0, W0 + W))).columns).toHaveLength(30);
      expect(read).toHaveBeenCalledTimes(2);
      expect(warmup.stats()).toMatchObject({ keptWindows: 1 });
      expect((await warmup.deepColumns(ask(W0, W0 + W))).columns).toHaveLength(30);
      expect(read).toHaveBeenCalledTimes(2);
    });

    test("the rows are part of the key: a window kept in one geometry never answers an ask in another", async () => {
      let rows = 4;
      const read = jest.fn(async (_provider, _symbol, _kind, options) => pageOf(windowStart(options.fromTs), options.toTs, { geometry: { ...GEOMETRY, rowWidth: rows } }));
      const warmup = createPyramidWarmup({ read });
      await warmup.deepColumns(ask(W0, W0 + W));
      rows = 2;
      const other = await warmup.deepColumns(ask(W0, W0 + W, { ...GEOMETRY, rowWidth: 2 }));
      expect(other.reason).toBeNull();
      expect(read).toHaveBeenCalledTimes(2);
      rows = 4;
      await warmup.deepColumns(ask(W0, W0 + W));
      expect(read).toHaveBeenCalledTimes(2);
    });

    test("an ask answered from memory does not wait for the two host slots", async () => {
      const release = [];
      const read = jest.fn((_provider, _symbol, _kind, options) => new Promise((resolve) => release.push(() => resolve(aligned(options)))));
      const warmup = createPyramidWarmup({ read });
      const first = warmup.deepColumns(ask(W0, W0 + W));
      await Promise.resolve();
      release.shift()();
      await first;
      const slow = [warmup.deepColumns(ask(W0 + W, W0 + 2 * W)), warmup.deepColumns(ask(W0 + 2 * W, W0 + 3 * W))];
      await Promise.resolve();
      await Promise.resolve();
      expect(warmup.stats()).toMatchObject({ inFlight: 2, waiting: 0 });
      const fromMemory = await warmup.deepColumns(ask(W0, W0 + W));
      expect(fromMemory.columns).toHaveLength(30);
      expect(warmup.stats()).toMatchObject({ inFlight: 2, waiting: 0, cachedWindows: 1 });
      release.shift()();
      release.shift()();
      await Promise.all(slow);
    });
  });

  test("the reader's last line explains a refusal, and a line from an earlier read never does", async () => {
    const { withDetail, noteOf } = require("../../../src/indicators/l2-memory/pyramid/pyramid-warmup");
    const note = { last: null };
    const say = noteOf(note);
    const answers = [];
    const read = withDetail(async () => answers.shift()(), note);
    const ask = { marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: W0, toTs: W0 + WINDOW_MS, geometry: GEOMETRY };
    const warmup = createPyramidWarmup({ read, wait: async () => {} });
    answers.push(() => { say("remote-storage-reader: non-success response, falling back to unavailable", "heatmap-columns", 503, { detail: "OVERLOADED" }); return { available: false, reason: "STORAGE_UNAVAILABLE" }; });
    answers.push(() => ({ available: false, reason: "STORAGE_UNAVAILABLE" }));
    answers.push(() => ({ available: false, reason: "STORAGE_UNAVAILABLE" }));
    await expect(warmup.deepColumns(ask)).resolves.toEqual({ columns: [], reason: "STORAGE_UNAVAILABLE after 3 tries" });
    answers.push(() => ({ available: false, reason: "STORAGE_UNAVAILABLE" }));
    answers.push(() => ({ available: false, reason: "STORAGE_UNAVAILABLE" }));
    answers.push(() => { say("remote-storage-reader: non-success response, falling back to unavailable", "heatmap-columns", 503, { detail: "OVERLOADED" }); return { available: false, reason: "STORAGE_UNAVAILABLE" }; });
    await expect(warmup.deepColumns(ask)).resolves.toEqual({ columns: [], reason: 'STORAGE_UNAVAILABLE (non-success response, falling back to unavailable heatmap-columns 503 {"detail":"OVERLOADED"}) after 3 tries' });
    answers.push(() => { say("remote-storage-reader: stale line"); return pageOf(W0, W0 + WINDOW_MS); });
    const fine = await read("binance", "BTCUSDT", "PERPETUAL", { fromTs: W0 });
    expect(fine.detail).toBeUndefined();
    expect(fine.available).toBe(true);
  });
});

describe("pyramid warm-up histories (P4e3 step 4)", () => {
  const ask = { marketKind: "PERPETUAL", symbol: "BTCUSDT", fromTs: W0, toTs: W0 + 3 * WINDOW_MS, geometry: { rowWidth: 4, tickSize: 0.1, clusterTicks: 5 } };
  const wall = (endTs, id) => ({ id, side: "bid", row: 10, span: 1, startTs: endTs - 5_000, endTs, size: 0, peak: 5, endedBy: "hit", ratio: 2, chain: 0, fill: 0, eaten: 0, absorbing: false });
  const eventsOf = (ts) => ({ version: 1, columnMs: 1_000, deepColumnMs: 10_000, fill: { from: ts, until: ts + WINDOW_MS }, trades: [[ts, 10_000, 10, "buy", "absorbed", 2, 1]], wallTrades: [] });
  const page = (extra) => ({ available: true, generation: "g", geometry: GEOMETRY, span: { oldest: W0, newest: W0 + 10 * WINDOW_MS }, ...extra });

  test("pages a pair's walls by cursor and its event windows by next, in the asked rows, through the same two-at-a-time gate; without the readers it says so", async () => {
    const readWalls = jest.fn(async (provider, symbol, kind, options) => (options.after === undefined
      ? page({ walls: [wall(W0 + 20_000, 1), wall(W0 + 40_000, 2)], next: { endTs: W0 + 40_000, id: 2 } })
      : page({ walls: [wall(W0 + WINDOW_MS, 3)], next: null })));
    const readEvents = jest.fn(async (provider, symbol, kind, options) => (options.fromTs < W0 + 2 * WINDOW_MS
      ? page({ windows: [{ ts: W0 - WINDOW_MS, events: eventsOf(W0 - WINDOW_MS) }, { ts: W0, events: eventsOf(W0) }, { ts: W0 + WINDOW_MS, events: eventsOf(W0 + WINDOW_MS) }], next: W0 + 2 * WINDOW_MS })
      : page({ windows: [{ ts: W0 + 2 * WINDOW_MS, events: eventsOf(W0 + 2 * WINDOW_MS) }, { ts: W0 + 3 * WINDOW_MS, events: eventsOf(W0 + 3 * WINDOW_MS) }], next: null })));
    const warmup = createPyramidWarmup({ read: async () => ({ available: false, reason: "NO_PYRAMID" }), readWalls, readEvents });
    const walls = await warmup.wallHistory(ask);
    expect(walls.reason).toBeNull();
    expect(walls.walls.map((w) => w.endTs - W0)).toEqual([20_000, 40_000, WINDOW_MS]);
    expect(readWalls).toHaveBeenCalledTimes(2);
    expect(readWalls.mock.calls[0].slice(0, 3)).toEqual(["binance", "BTCUSDT", "PERPETUAL"]);
    expect(readWalls.mock.calls[0][3]).toEqual({ fromTs: W0, toTs: W0 + 3 * WINDOW_MS });
    expect(readWalls.mock.calls[1][3]).toEqual({ fromTs: W0, toTs: W0 + 3 * WINDOW_MS, after: { endTs: W0 + 40_000, id: 2 } });
    const events = await warmup.eventHistory(ask);
    expect(events.reason).toBeNull();
    expect(events.windows.map((w) => w.ts - W0)).toEqual([0, WINDOW_MS, 2 * WINDOW_MS]);
    expect(readEvents.mock.calls.map((call) => call[3])).toEqual([{ fromTs: W0, toTs: W0 + 3 * WINDOW_MS }, { fromTs: W0 + 2 * WINDOW_MS, toTs: W0 + 3 * WINDOW_MS }]);
    expect(warmup.stats()).toMatchObject({ walls: 3, eventWindows: 3, inFlight: 0 });
    const bare = createPyramidWarmup({ read: async () => ({ available: false, reason: "NO_PYRAMID" }) });
    expect(await bare.wallHistory(ask)).toEqual({ walls: [], reason: "NO_READER" });
    expect(await bare.eventHistory(ask)).toEqual({ windows: [], reason: "NO_READER" });
  });

  test("refuses pages in other rows; a cursor that does not move, a page cap or a page lost after its retries keep what was read and say why (PR #32 review)", async () => {
    const quiet = { read: async () => ({ available: false, reason: "NO_PYRAMID" }), wait: async () => {} };
    const otherRows = createPyramidWarmup({ ...quiet, readWalls: async () => page({ walls: [], next: null, geometry: { ...GEOMETRY, rowWidth: 2 } }), readEvents: async () => page({ windows: [], next: null, geometry: { ...GEOMETRY, clusterTicks: 1 } }) });
    expect(await otherRows.wallHistory(ask)).toEqual({ walls: [], reason: "GEOMETRY" });
    expect(await otherRows.eventHistory(ask)).toEqual({ windows: [], reason: "GEOMETRY" });
    const stuck = createPyramidWarmup({ ...quiet, readWalls: async () => page({ walls: [wall(W0 + 1_000, 1)], next: { endTs: W0 + 1_000, id: 1 } }), readEvents: async () => page({ windows: [], next: W0 }) });
    expect(await stuck.wallHistory(ask)).toEqual({ walls: [wall(W0 + 1_000, 1)], reason: "PAGE_CURSOR" });
    expect(await stuck.eventHistory(ask)).toEqual({ windows: [], reason: "PAGE_CURSOR" });
    let id = 0;
    const endless = createPyramidWarmup({ ...quiet, readWalls: async () => { id += 1; return page({ walls: [wall(W0 + id, id)], next: { endTs: W0 + id, id } }); } });
    const capped = await endless.wallHistory(ask);
    expect([capped.walls.length, capped.reason]).toEqual([64, "PAGE_LIMIT"]);
    let eventPage = 0;
    const cut = createPyramidWarmup({ ...quiet, readWalls: async (provider, symbol, kind, options) => (options.after === undefined ? page({ walls: [wall(W0 + 2_000, 1)], next: { endTs: W0 + 2_000, id: 1 } }) : { available: false, reason: "STORAGE_UNAVAILABLE" }), readEvents: async () => { eventPage += 1; return eventPage === 1 ? page({ windows: [{ ts: W0, events: eventsOf(W0) }], next: W0 + WINDOW_MS }) : { available: false, reason: "STORAGE_UNAVAILABLE" }; } });
    expect(await cut.wallHistory(ask)).toEqual({ walls: [wall(W0 + 2_000, 1)], reason: "STORAGE_UNAVAILABLE after 3 tries" });
    expect(await cut.eventHistory(ask)).toEqual({ windows: [{ ts: W0, events: eventsOf(W0) }], reason: "STORAGE_UNAVAILABLE after 3 tries" });
    const down = createPyramidWarmup({ ...quiet, readWalls: async () => ({ available: false, reason: "STORAGE_UNAVAILABLE", detail: "relay 503" }), readEvents: async () => { throw new Error("socket hang up"); } });
    expect(await down.wallHistory(ask)).toEqual({ walls: [], reason: "STORAGE_UNAVAILABLE (relay 503) after 3 tries" });
    expect((await down.eventHistory(ask)).reason).toMatch(/^READ_FAILED: socket hang up after 3 tries$/);
    expect(down.stats()).toMatchObject({ failed: 3, retries: 4 });
  });
});
