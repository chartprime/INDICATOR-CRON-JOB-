const { createIcebergHostFill, DUPLICATE_WINDOW_MS, DEFAULT_LOOKBACK_MS, DEFAULT_PAGE_LIMIT, DEFAULT_TRIES, DEFAULT_MAX_IN_FLIGHT, DEFAULT_TAIL_MS, RETRY_WAITS_MS, WATCH_GAP_MS, BACKOFF_FIRST_MS, BACKOFF_MAX_MS, BACKED_OFF } = require("../../../src/indicators/iceberg/iceberg-host-fill");
const { createIcebergHistory, DEFAULT_MAX_SPANS } = require("../../../src/indicators/iceberg/iceberg-history");
const { WATCH_GAP_MS: RUNTIME_WATCH_GAP_MS } = require("../../../src/indicators/iceberg/iceberg-indicator");
const { icebergOrdersFrames } = require("../../../src/server/iceberg-frames");

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = 10 * DAY;

function settled(id, markedAt, overrides = {}) {
  return {
    id, kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32,
    startedAt: markedAt - 500, markedAt, updatedAt: markedAt + 1000, status: "filled", ...overrides,
  };
}

function page(icebergs, watched, next = null) {
  return { available: true, generation: "g", rulesVersion: 1, span: { from: 0, to: NOW }, watched, icebergs, next };
}

function pagedHost(all, watched, asked) {
  return async (provider, symbol, marketKind, options) => {
    asked.push(options);
    const rows = all.filter((entry) => entry.markedAt >= options.fromTs && entry.markedAt < options.toTs && (options.after === undefined || entry.markedAt > options.after.markedAt));
    const taken = rows.slice(0, options.limit);
    const last = taken[taken.length - 1];
    return page(taken, watched, rows.length > options.limit ? { markedAt: last.markedAt, id: last.id } : null);
  };
}

describe("indicators/iceberg/iceberg-host-fill", () => {
  test("asks the host only for the spans the runtime did not watch, records the settled icebergs the host vouches for, and marks exactly those spans as watched", async () => {
    expect([DEFAULT_LOOKBACK_MS, DEFAULT_PAGE_LIMIT, DEFAULT_TRIES, DEFAULT_MAX_IN_FLIGHT, DEFAULT_TAIL_MS]).toEqual([5 * DAY, 2000, 3, 2, 600_000]);
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
    history.watch(NOW - DAY, NOW);
    const asked = [];
    const read = async (provider, symbol, marketKind, options) => {
      asked.push([provider, symbol, marketKind, options]);
      return page(
        [settled("inside", NOW - 2 * DAY), settled("outside-host", NOW - 3 * DAY), settled("already", NOW - DAY + 1000), settled("open", NOW - 2 * DAY + 5, { status: "active" })],
        [[NOW - 2.5 * DAY, NOW - 1.5 * DAY]],
      );
    };
    const fill = createIcebergHostFill({ read, now: () => NOW });
    const outcome = await fill.fill({ provider: "dxfeed", symbol: "/NQZ26:XCME", marketKind: "FUTURE", history });
    expect(asked).toEqual([["dxfeed", "/NQZ26:XCME", "FUTURE", { fromTs: NOW - 5 * DAY, toTs: NOW - DAY, limit: 2000 }]]);
    expect(outcome).toEqual({ gaps: 1, records: 1, watched: [[NOW - 2.5 * DAY, NOW - 1.5 * DAY]], reasons: [], icebergs: [{ ...settled("inside", NOW - 2 * DAY), origin: "host" }] });
    expect(history.list().map((entry) => entry.id)).toEqual(["inside"]);
    expect(history.coverage()).toEqual([[NOW - 2.5 * DAY, NOW - 1.5 * DAY], [NOW - DAY, NOW]]);
    expect(fill.stats()).toMatchObject({ fills: 1, gaps: 1, pages: 1, records: 1, refused: 1, unavailable: 0 });
  });

  test("follows the host's cursor through a gap, keeps at most two reads in flight across gaps, and an unavailable answer leaves the gap unwatched with its reason", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
    history.watch(NOW - 3 * DAY, NOW - 2 * DAY);
    let inFlight = 0;
    let peak = 0;
    const read = async (provider, symbol, marketKind, options) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (options.fromTs === NOW - 5 * DAY) {
        if (options.after === undefined) return page([settled("a", NOW - 4 * DAY)], [[NOW - 5 * DAY, NOW - 3 * DAY]], { markedAt: NOW - 4 * DAY, id: "a" });
        return page([settled("b", NOW - 3.5 * DAY)], [[NOW - 5 * DAY, NOW - 3 * DAY]]);
      }
      return { available: false, reason: "NOT_BUILT" };
    };
    const fill = createIcebergHostFill({ read, now: () => NOW });
    const outcome = await fill.fill({ provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL", history });
    expect(outcome).toEqual({ gaps: 2, records: 2, watched: [[NOW - 5 * DAY, NOW - 3 * DAY]], reasons: ["NOT_BUILT"], icebergs: [{ ...settled("a", NOW - 4 * DAY), origin: "host" }, { ...settled("b", NOW - 3.5 * DAY), origin: "host" }] });
    expect(history.coverage()).toEqual([[NOW - 5 * DAY, NOW - 2 * DAY]]);
    expect(peak).toBeLessThanOrEqual(2);
    const tail = createIcebergHostFill({ read, now: () => NOW });
    const fresh = createIcebergHistory({ maxAgeMs: 7 * DAY });
    fresh.watch(NOW - 5 * DAY, NOW - 700_000);
    await expect(tail.fill({ provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL", history: fresh })).resolves.toMatchObject({ gaps: 1 });
    fresh.watch(NOW - 700_000, NOW - 600_000);
    await expect(tail.fill({ provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL", history: fresh })).resolves.toMatchObject({ gaps: 0 });
    expect(fill.stats()).toMatchObject({ pages: 2, unavailable: 1, records: 2 });
  });

  test("a read that throws or answers the storage-unavailable fallback is tried three times with growing waits, then the gap is given up", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
    const waits = [];
    let calls = 0;
    const read = async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket closed");
      return { available: false, reason: "STORAGE_UNAVAILABLE", icebergs: [], next: null };
    };
    const fill = createIcebergHostFill({ read, now: () => NOW, wait: async (ms) => { waits.push(ms); }, log: () => {} });
    const outcome = await fill.fill({ provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL", history });
    expect(calls).toBe(3);
    expect(waits).toEqual([RETRY_WAITS_MS[0], RETRY_WAITS_MS[1]]);
    expect(outcome).toEqual({ gaps: 1, records: 0, watched: [], reasons: ["STORAGE_UNAVAILABLE"], icebergs: [] });
    expect(history.coverage()).toEqual([]);
    expect(fill.stats()).toMatchObject({ failed: 1, retries: 2, unavailable: 1 });
    expect(() => createIcebergHostFill({})).toThrow(/read/);
    expect(() => createIcebergHostFill({ read, tries: 0 })).toThrow(/tries/);
  });

  test("a host that answers no gap at all is left alone for a minute, then two, doubling to half an hour, and a page that lands ends the pause; a host that answers with a reason of its own is asked again as before; one silent gap ends the fill, the other gaps are not asked", async () => {
    let at = NOW;
    const asked = [];
    let answer = () => ({ available: false, reason: "STORAGE_UNAVAILABLE", icebergs: [], next: null });
    const read = async (provider, symbol, marketKind, options) => { asked.push(options.fromTs); return answer(); };
    const logged = [];
    const fill = createIcebergHostFill({ read, now: () => at, wait: async () => {}, log: (message) => logged.push(message) });
    const target = { provider: "dxfeed", symbol: "/NQZ26:XCME", marketKind: "FUTURE", history: createIcebergHistory({ maxAgeMs: 7 * DAY }) };
    expect([BACKOFF_FIRST_MS, BACKOFF_MAX_MS, BACKED_OFF]).toEqual([60_000, 1_800_000, "HOST_BACKED_OFF"]);
    expect((await fill.fill(target)).reasons).toEqual(["STORAGE_UNAVAILABLE"]);
    expect(asked).toHaveLength(DEFAULT_TRIES);
    expect(logged.some((line) => line.includes("not asking again for 60 s"))).toBe(true);
    at += 59_000;
    expect(await fill.fill(target)).toEqual({ gaps: 1, records: 0, watched: [], reasons: [BACKED_OFF], icebergs: [] });
    expect(asked).toHaveLength(DEFAULT_TRIES);
    at += 1_000;
    expect((await fill.fill(target)).reasons).toEqual(["STORAGE_UNAVAILABLE"]);
    expect(asked).toHaveLength(2 * DEFAULT_TRIES);
    at += 119_000;
    expect((await fill.fill(target)).reasons).toEqual([BACKED_OFF]);
    at += 1_000;
    expect((await fill.fill(target)).reasons).toEqual(["STORAGE_UNAVAILABLE"]);
    expect(asked).toHaveLength(3 * DEFAULT_TRIES);
    for (let step = 0; step < 6; step += 1) {
      at += BACKOFF_MAX_MS;
      expect((await fill.fill(target)).reasons).toEqual(["STORAGE_UNAVAILABLE"]);
    }
    const askedBefore = asked.length;
    at += BACKOFF_MAX_MS - 1_000;
    expect((await fill.fill(target)).reasons).toEqual([BACKED_OFF]);
    expect(asked).toHaveLength(askedBefore);
    at += 1_000;
    answer = () => page([], [[at - 2 * DAY, at - DAY]]);
    expect((await fill.fill(target)).reasons).toEqual([]);
    answer = () => ({ available: false, reason: "STORAGE_UNAVAILABLE", icebergs: [], next: null });
    at += 1_000;
    const again = asked.length;
    const twoGaps = await fill.fill(target);
    expect([twoGaps.gaps, twoGaps.reasons]).toEqual([2, ["STORAGE_UNAVAILABLE"]]);
    expect(asked.length - again).toBe(DEFAULT_TRIES);
    expect(logged.filter((line) => line.includes("not asking again for 60 s"))).toHaveLength(2);
    expect(fill.stats()).toMatchObject({ backedOff: 3 });
    const own = createIcebergHostFill({ read: async () => ({ available: false, reason: "GENERATION_MISSING", icebergs: [], next: null }), now: () => at, wait: async () => {} });
    const spoken = { ...target, history: createIcebergHistory({ maxAgeMs: 7 * DAY }) };
    expect((await own.fill(spoken)).reasons).toEqual(["GENERATION_MISSING"]);
    expect((await own.fill(spoken)).reasons).toEqual(["GENERATION_MISSING"]);
  });

  test("each pair keeps its own pause: a pair whose host is silent never pauses another pair, another pair's page landing meanwhile never ends it, and the pair is its provider, market kind and symbol", async () => {
    let at = NOW;
    const asked = [];
    const read = async (provider, symbol, marketKind, options) => {
      asked.push(`${provider}:${marketKind}:${symbol}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (provider === "binance" && marketKind === "PERPETUAL" && symbol === "ETHUSDT") return { available: false, reason: "STORAGE_UNAVAILABLE", icebergs: [], next: null };
      return page([], [[options.fromTs, options.toTs]]);
    };
    const pair = (provider, marketKind, symbol) => ({ provider, symbol, marketKind, history: createIcebergHistory({ maxAgeMs: 7 * DAY }) });
    const fill = createIcebergHostFill({ read, now: () => at, wait: async () => {}, log: () => {} });
    const silent = pair("binance", "PERPETUAL", "ETHUSDT");
    expect((await fill.fill(silent)).reasons).toEqual(["STORAGE_UNAVAILABLE"]);
    at += 30_000;
    for (const [provider, marketKind, symbol] of [["binance", "PERPETUAL", "BTCUSDT"], ["binance", "SPOT", "ETHUSDT"], ["bybit", "PERPETUAL", "ETHUSDT"]]) {
      const before = asked.length;
      expect((await fill.fill(pair(provider, marketKind, symbol))).reasons).toEqual([]);
      expect(asked.slice(before)).toEqual([`${provider}:${marketKind}:${symbol}`]);
    }
    const before = asked.length;
    expect((await fill.fill(silent)).reasons).toEqual([BACKED_OFF]);
    expect(asked).toHaveLength(before);

    const both = createIcebergHostFill({ read, now: () => at, wait: async () => {}, log: () => {} });
    const [a, b] = await Promise.all([both.fill(pair("binance", "PERPETUAL", "ETHUSDT")), both.fill(pair("binance", "PERPETUAL", "BTCUSDT"))]);
    expect([a.reasons, b.reasons]).toEqual([["STORAGE_UNAVAILABLE"], []]);
    at += 1_000;
    const askedBefore = asked.length;
    expect((await both.fill(pair("binance", "PERPETUAL", "ETHUSDT"))).reasons).toEqual([BACKED_OFF]);
    expect(asked).toHaveLength(askedBefore);
    expect(both.stats()).toMatchObject({ backedOff: 1 });
  });

  test("what the host brings is recorded as the host's; one the runtime already holds nearby (same kind, side and price, mark within 30 s) is left out and counted, while a different price or a farther mark is taken", async () => {
    expect(DUPLICATE_WINDOW_MS).toBe(30_000);
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
    history.record(settled("own", NOW - 2 * DAY));
    const read = async () => page([
      settled("twin", NOW - 2 * DAY + 30_000),
      settled("later", NOW - 2 * DAY + 30_001),
      settled("elsewhere", NOW - 2 * DAY, { price: 31189 }),
    ], [[NOW - 3 * DAY, NOW - DAY]]);
    const fill = createIcebergHostFill({ read, now: () => NOW });
    const outcome = await fill.fill({ provider: "dxfeed", symbol: "/NQZ26:XCME", marketKind: "FUTURE", history });
    expect(outcome.icebergs.map((entry) => [entry.id, entry.origin])).toEqual([["later", "host"], ["elsewhere", "host"]]);
    expect(history.list().map((entry) => [entry.id, entry.origin])).toEqual([["elsewhere", "host"], ["own", "runtime"], ["later", "host"]]);
    expect(fill.stats()).toMatchObject({ records: 2, duplicates: 1, refused: 0 });
  });

  test("a page that fails after the first leaves the gap watched only up to the last mark fully read, says why, and the next fill asks for the rest", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
    const asked = [];
    const read = async (provider, symbol, marketKind, options) => {
      asked.push(options);
      if (options.fromTs === NOW - 3 * DAY) return page([settled("b", NOW - 3 * DAY), settled("c", NOW - 2 * DAY)], [[NOW - 6 * DAY, NOW]]);
      if (options.after === undefined) return page([settled("a", NOW - 4 * DAY), settled("b", NOW - 3 * DAY)], [[NOW - 6 * DAY, NOW]], { markedAt: NOW - 3 * DAY, id: "b" });
      return { available: false, reason: "STORAGE_UNAVAILABLE", icebergs: [], next: null };
    };
    const logged = [];
    const fill = createIcebergHostFill({ read, now: () => NOW, wait: async () => {}, log: (message) => logged.push(message) });
    const target = { provider: "dxfeed", symbol: "/NQZ26:XCME", marketKind: "FUTURE", history };
    const first = await fill.fill(target);
    expect(asked).toHaveLength(4);
    expect(first).toEqual({ gaps: 1, records: 1, watched: [[NOW - 5 * DAY, NOW - 3 * DAY]], reasons: ["STORAGE_UNAVAILABLE"], icebergs: [{ ...settled("a", NOW - 4 * DAY), origin: "host" }] });
    expect(history.coverage()).toEqual([[NOW - 5 * DAY, NOW - 3 * DAY]]);
    expect(fill.stats()).toMatchObject({ pages: 1, unavailable: 1, failed: 1, incomplete: 1 });
    expect(logged).toEqual([expect.stringContaining("STORAGE_UNAVAILABLE")]);
    const second = await fill.fill(target);
    expect(asked.slice(4)).toEqual([{ fromTs: NOW - 3 * DAY, toTs: NOW - DEFAULT_TAIL_MS, limit: DEFAULT_PAGE_LIMIT }]);
    expect(second).toMatchObject({ gaps: 1, records: 2, reasons: [] });
    expect(history.list().map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(history.coverage()).toEqual([[NOW - 5 * DAY, NOW - DEFAULT_TAIL_MS]]);
  });

  test("a gap that needs more pages than the cap is watched only up to the last mark read and says MAX_PAGES", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
    let reads = 0;
    const read = async (provider, symbol, marketKind, options) => {
      reads += 1;
      const index = options.after === undefined ? 0 : Number(options.after.id.slice(1)) + 1;
      const entry = settled(`p${index}`, NOW - 4 * DAY + index * HOUR);
      return page([entry], [[NOW - 6 * DAY, NOW]], { markedAt: entry.markedAt, id: entry.id });
    };
    const fill = createIcebergHostFill({ read, now: () => NOW, maxPages: 3, log: () => {} });
    const outcome = await fill.fill({ provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL", history });
    expect(reads).toBe(3);
    expect(outcome).toEqual({ gaps: 1, records: 2, watched: [[NOW - 5 * DAY, NOW - 4 * DAY + 2 * HOUR]], reasons: ["MAX_PAGES"], icebergs: [{ ...settled("p0", NOW - 4 * DAY), origin: "host" }, { ...settled("p1", NOW - 4 * DAY + HOUR), origin: "host" }] });
    expect(history.coverage()).toEqual([[NOW - 5 * DAY, NOW - 4 * DAY + 2 * HOUR]]);
    expect(fill.stats()).toMatchObject({ pages: 3, incomplete: 1 });
  });

  test("a later page under another host generation or rules version stops the gap at the last cursor's mark with GENERATION_CHANGED, takes nothing from the new generation, and the next fill asks from there", async () => {
    for (const change of [{ generation: "g2" }, { rulesVersion: 2 }]) {
      const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
      const all = [1, 2, 3, 4].map((n) => settled(`m${n}`, NOW - 5 * DAY + n * HOUR));
      const asked = [];
      const paged = pagedHost(all, [[NOW - 6 * DAY, NOW]], asked);
      const read = async (provider, symbol, marketKind, options) => {
        const answer = await paged(provider, symbol, marketKind, options);
        return options.after === undefined ? answer : { ...answer, ...change, watched: [[NOW - 5 * DAY + 3 * HOUR, NOW]], next: null };
      };
      const logged = [];
      const fill = createIcebergHostFill({ read, now: () => NOW, pageLimit: 2, log: (message) => logged.push(message) });
      const target = { provider: "dxfeed", symbol: "/ESZ26:XCME", marketKind: "FUTURE", history };
      const first = await fill.fill(target);
      expect(asked).toHaveLength(2);
      expect({ change, first }).toEqual({ change, first: { gaps: 1, records: 1, watched: [[NOW - 5 * DAY, NOW - 5 * DAY + 2 * HOUR]], reasons: ["GENERATION_CHANGED"], icebergs: [{ ...settled("m1", NOW - 5 * DAY + HOUR), origin: "host" }] } });
      expect(history.list().map((entry) => entry.id)).toEqual(["m1"]);
      expect(history.coverage()).toEqual([[NOW - 5 * DAY, NOW - 5 * DAY + 2 * HOUR]]);
      expect(fill.stats()).toMatchObject({ pages: 2, unavailable: 0, incomplete: 1 });
      expect(logged).toEqual([expect.stringContaining("GENERATION_CHANGED")]);
      await fill.fill(target);
      expect(asked[2]).toEqual({ fromTs: NOW - 5 * DAY + 2 * HOUR, toTs: NOW - DEFAULT_TAIL_MS, limit: 2 });
    }
  });

  test("the host's spans are joined across holes up to the runtime's own watch gap, so a second fill after an answer of more than 64 spans asks nothing", async () => {
    expect(WATCH_GAP_MS).toBe(RUNTIME_WATCH_GAP_MS);
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
    const start = NOW - 5 * DAY - HOUR;
    const step = 72 * 60_000;
    const watched = Array.from({ length: 101 }, (_, i) => [start + i * step, start + (i + 1) * step - 500]);
    expect(watched.length).toBeGreaterThan(DEFAULT_MAX_SPANS);
    const asked = [];
    const read = async (provider, symbol, marketKind, options) => {
      asked.push(options);
      return page([settled("first", NOW - 5 * DAY + HOUR), settled("last", NOW - DAY)], watched);
    };
    const fill = createIcebergHostFill({ read, now: () => NOW });
    const target = { provider: "dxfeed", symbol: "/NQZ26:XCME", marketKind: "FUTURE", history };
    const first = await fill.fill(target);
    expect(first).toMatchObject({ gaps: 1, records: 2, watched: [[NOW - 5 * DAY, NOW - DEFAULT_TAIL_MS]], reasons: [] });
    expect(history.coverage()).toEqual([[NOW - 5 * DAY, NOW - DEFAULT_TAIL_MS]]);
    const second = await fill.fill(target);
    expect(second).toMatchObject({ gaps: 0, records: 0 });
    expect(asked).toHaveLength(1);
  });

  test("a host hole as long as the watch gap is bridged, a longer one stays a hole and the next fill asks for it, in whatever order the host lists its spans", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
    const bridgedAt = NOW - 4 * DAY;
    const holeAt = NOW - 3 * DAY;
    const watched = [[holeAt + RUNTIME_WATCH_GAP_MS + 1, NOW], [bridgedAt + RUNTIME_WATCH_GAP_MS, holeAt], [NOW - 6 * DAY, bridgedAt]];
    const asked = [];
    const read = async (provider, symbol, marketKind, options) => {
      asked.push([options.fromTs, options.toTs]);
      return page([], watched);
    };
    const fill = createIcebergHostFill({ read, now: () => NOW });
    const target = { provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL", history };
    const first = await fill.fill(target);
    expect(first.watched).toEqual([[NOW - 5 * DAY, holeAt], [holeAt + RUNTIME_WATCH_GAP_MS + 1, NOW - DEFAULT_TAIL_MS]]);
    expect(history.uncovered(NOW - 5 * DAY, NOW - DEFAULT_TAIL_MS)).toEqual([[holeAt, holeAt + RUNTIME_WATCH_GAP_MS + 1]]);
    await fill.fill(target);
    expect(asked).toEqual([[NOW - 5 * DAY, NOW - DEFAULT_TAIL_MS], [holeAt, holeAt + RUNTIME_WATCH_GAP_MS + 1]]);
  });

  test("host icebergs are held to the size ceiling of the pair's wire identity, so whatever the fill records fits the pair's page, and what is refused is counted and logged once", async () => {
    const over = 20_000_000;
    const cases = [
      { target: { provider: "dxfeed", symbol: "/NQZ26:XCME", marketKind: "FUTURE" }, identity: { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" }, taken: ["at-ceiling"] },
      { target: { provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL" }, identity: { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" }, taken: ["at-ceiling"] },
      { target: { provider: "dxfeed", symbol: "AAPL", marketKind: "EQUITY" }, identity: { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }, taken: ["over-display", "at-ceiling", "over-executed"] },
    ];
    for (const { target, identity, taken } of cases) {
      const history = createIcebergHistory({ maxAgeMs: 7 * DAY });
      const read = async () => page([
        settled("over-display", NOW - 3 * DAY, { display: over }),
        settled("at-ceiling", NOW - 2.5 * DAY, { price: 31190, display: 10_000_000, executed: 10_000_000 }),
        settled("over-executed", NOW - 2 * DAY, { price: 31191, executed: over }),
      ], [[NOW - 6 * DAY, NOW]]);
      const logged = [];
      const fill = createIcebergHostFill({ read, now: () => NOW, log: (message) => logged.push(message) });
      const outcome = await fill.fill({ ...target, history });
      expect({ pair: target.marketKind, taken: outcome.icebergs.map((entry) => entry.id) }).toEqual({ pair: target.marketKind, taken });
      expect(fill.stats().refused).toBe(3 - taken.length);
      expect(logged).toEqual(taken.length === 3 ? [] : [expect.stringContaining("refused 2 host iceberg(s)")]);
      expect(() => icebergOrdersFrames(identity, NOW, history.list(), { watched: history.coverage(), liveSince: NOW })).not.toThrow();
    }
  });

  test("a gap that brings more than the history can keep claims no span whose icebergs it dropped: the newest stay, the coverage starts past the newest mark dropped, and the next fill asks nothing again", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY, maxIcebergs: 3 });
    const all = [1, 2, 3, 4, 5].map((n) => settled(`m${n}`, NOW - 5 * DAY + n * HOUR));
    const asked = [];
    const fill = createIcebergHostFill({ read: pagedHost(all, [[NOW - 6 * DAY, NOW]], asked), now: () => NOW, pageLimit: 2 });
    const target = { provider: "dxfeed", symbol: "/ESZ26:XCME", marketKind: "FUTURE", history };
    const first = await fill.fill(target);
    expect(asked).toHaveLength(3);
    expect(first).toMatchObject({ gaps: 1, records: 5, reasons: [] });
    expect(history.list().map((entry) => entry.id)).toEqual(["m3", "m4", "m5"]);
    expect(history.coverage()).toEqual([[NOW - 5 * DAY + 2 * HOUR + 1, NOW - DEFAULT_TAIL_MS]]);
    const second = await fill.fill(target);
    expect(second).toMatchObject({ gaps: 0, records: 0 });
    expect(asked).toHaveLength(3);
  });

  test("a fill hands on only the icebergs the history kept, so no client is sent one the history dropped at once", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY, maxIcebergs: 3 });
    const all = [1, 2, 3, 4, 5].map((n) => settled(`m${n}`, NOW - 5 * DAY + n * HOUR));
    const fill = createIcebergHostFill({ read: pagedHost(all, [[NOW - 6 * DAY, NOW]], []), now: () => NOW, pageLimit: 2 });
    const outcome = await fill.fill({ provider: "dxfeed", symbol: "/ESZ26:XCME", marketKind: "FUTURE", history });
    expect(outcome.records).toBe(5);
    expect(outcome.icebergs.map((entry) => entry.id)).toEqual(["m3", "m4", "m5"]);
  });

  test("with more than one gap the newest is filled first, and an older gap that the newer icebergs pushed out of the history's reach is never asked", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY, maxIcebergs: 3 });
    history.watch(NOW - 3 * DAY, NOW - 2 * DAY);
    const older = [settled("o1", NOW - 4 * DAY), settled("o2", NOW - 3.5 * DAY)];
    const newer = [1, 2, 3, 4].map((n) => settled(`n${n}`, NOW - 2 * DAY + n * HOUR));
    const asked = [];
    const fill = createIcebergHostFill({ read: pagedHost([...older, ...newer], [[NOW - 6 * DAY, NOW]], asked), now: () => NOW });
    const target = { provider: "binance", symbol: "BTCUSDT", marketKind: "PERPETUAL", history };
    const outcome = await fill.fill(target);
    expect(asked.map((options) => [options.fromTs, options.toTs])).toEqual([[NOW - 2 * DAY, NOW - DEFAULT_TAIL_MS]]);
    expect(outcome).toMatchObject({ gaps: 2, records: 4, reasons: [] });
    expect(history.list().map((entry) => entry.id)).toEqual(["n2", "n3", "n4"]);
    expect(history.coverage()).toEqual([[NOW - 2 * DAY + HOUR + 1, NOW - DEFAULT_TAIL_MS]]);
    expect(await fill.fill(target)).toMatchObject({ gaps: 0 });
    expect(asked).toHaveLength(1);
  });

  test("once the history is at its cap the fill asks for nothing that ended before its oldest iceberg did: a gap wholly before that is not even counted, and one that reaches past it is asked from there", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * DAY, maxIcebergs: 2 });
    history.record(settled("own-old", NOW - 4 * DAY));
    history.record(settled("own-new", NOW - DAY));
    history.watch(NOW - 5 * DAY + 4 * HOUR, NOW - 5 * DAY + 8 * HOUR);
    const asked = [];
    const fill = createIcebergHostFill({ read: pagedHost([settled("older", NOW - 4.5 * DAY)], [[NOW - 6 * DAY, NOW]], asked), now: () => NOW });
    const outcome = await fill.fill({ provider: "dxfeed", symbol: "/ESZ26:XCME", marketKind: "FUTURE", history });
    expect(asked.map((options) => [options.fromTs, options.toTs])).toEqual([[NOW - 4 * DAY + 1001, NOW - DEFAULT_TAIL_MS]]);
    expect(outcome).toEqual({ gaps: 1, records: 0, watched: [[NOW - 4 * DAY + 1001, NOW - DEFAULT_TAIL_MS]], reasons: [], icebergs: [] });
    expect(history.list().map((entry) => entry.id)).toEqual(["own-old", "own-new"]);
  });

  test("a history saved and restored at its cap keeps the rule: what it dropped stays unclaimed, and the fill after the restart asks only for the time since, nothing older than what it can keep", async () => {
    const all = [1, 2, 3, 4, 5].map((n) => settled(`m${n}`, NOW - 5 * DAY + n * HOUR));
    const asked = [];
    const read = pagedHost(all, [[NOW - 6 * DAY, NOW + DAY]], asked);
    const target = { provider: "dxfeed", symbol: "/ESZ26:XCME", marketKind: "FUTURE" };
    const before = createIcebergHistory({ maxAgeMs: 7 * DAY, maxIcebergs: 3 });
    await createIcebergHostFill({ read, now: () => NOW }).fill({ ...target, history: before });
    const saved = JSON.parse(JSON.stringify({ history: before.toJSON(), coverage: before.coverageUntil(NOW) }));
    const later = NOW + HOUR;
    const after = createIcebergHistory({ maxAgeMs: 7 * DAY, maxIcebergs: 3 });
    expect(after.loadCoverage(saved.coverage)).toBe(true);
    expect(after.load(saved.history)).toBe(true);
    after.prune(later);
    expect(after.list().map((entry) => entry.id)).toEqual(["m3", "m4", "m5"]);
    expect(after.coverage()).toEqual([[NOW - 5 * DAY + 2 * HOUR + 1, NOW - DEFAULT_TAIL_MS]]);
    asked.length = 0;
    const outcome = await createIcebergHostFill({ read, now: () => later }).fill({ ...target, history: after });
    expect(asked.map((options) => [options.fromTs, options.toTs])).toEqual([[NOW - DEFAULT_TAIL_MS, later - DEFAULT_TAIL_MS]]);
    expect(outcome).toMatchObject({ gaps: 1, records: 0 });
  });
});
