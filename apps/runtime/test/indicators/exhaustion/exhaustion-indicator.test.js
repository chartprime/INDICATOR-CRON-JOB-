const fs = require("fs");
const os = require("os");
const path = require("path");
const { createExhaustionIndicator, exhaustionOptionsFromEnv, lengthsFor, runStart, DEFAULT_STORE_S, DEFAULT_MAX_AGE_S, DEFAULT_FILL_S, MIN_FILL_MS } = require("../../../src/indicators/exhaustion/exhaustion-indicator");
const { saveExhaustionHistory, loadExhaustionHistory, exhaustionHistoryPath } = require("../../../src/indicators/exhaustion/exhaustion-store");
const { EXHAUSTION_RULES_VERSION, createExhaustionTracker } = require("../../../src/indicators/exhaustion/exhaustion-engine");
const { MINUTE, BASE, W, PULLED_ASKS, column, frozen, at, buyersScenario } = require("../../fixtures/exhaustion/columns");

const NQ = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" };
const ES = { symbol: "/ESZ26:XCME", marketKind: "FUTURE" };
const SCENARIO_COLUMNS = W + 16;

function scenario() {
  return [...buyersScenario(), column(at(8), { mid: 108, buy: 1, sell: 1, asks: PULLED_ASKS }), ...[9, 10, 11, 12, 13].map((k) => column(at(k), { mid: 106 })), column(at(14), { mid: 105 }), column(at(15), { mid: 106.5 })];
}

function harness({ columns = scenario(), rowWidth = 1, overrides = {} } = {}) {
  const published = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-indicator-"));
  const feed = { columns, geometry: { rowWidth } };
  const indicator = createExhaustionIndicator({
    provider: "DXFEED",
    storeDir: dir,
    now: () => 50_000,
    log: { warn: () => {}, error: () => {} },
    candleLengths: [MINUTE],
    columnsAfter: (pair, afterTs, limit) => {
      if (pair.symbol !== NQ.symbol) return [];
      const after = feed.columns.filter((c) => afterTs === null || c.ts > afterTs);
      return after.slice(0, limit);
    },
    geometryOf: (pair) => (pair.symbol === NQ.symbol ? feed.geometry : null),
    publish: (wire, pair, at, liveSince) => published.push({ wire, pair, at, liveSince }),
    ...overrides,
  });
  return { indicator, published, dir, feed };
}

describe("indicators/exhaustion/exhaustion-indicator", () => {
  test("the factory refuses a bad provider, missing collaborators and wrong numbers", () => {
    expect(() => createExhaustionIndicator({ provider: "X", columnsAfter: () => [], geometryOf: () => null })).toThrow(/provider/);
    expect(() => createExhaustionIndicator({ provider: "DXFEED", geometryOf: () => null })).toThrow(/columnsAfter/);
    expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [] })).toThrow(/geometryOf/);
    expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null, storeS: 0 })).toThrow(/storeS/);
    expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null, candleLengths: [240_000] })).toThrow(/candleLengths/);
    expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null, columnsPerTick: 0 })).toThrow(/columnsPerTick/);
  });

  test("a tick feeds the pair's new deep columns to one tracker per candle length and publishes the shades, origin runtime, liveSince the first column fed", () => {
    const { indicator, published } = harness();
    const emitted = indicator.tick([NQ, ES], 50_000);
    expect(emitted.map((s) => [s.status, s.origin])).toEqual([["held", "runtime"]]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ pair: NQ, at: 50_000, liveSince: BASE });
    expect(published[0].wire).toEqual(emitted);
    expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ columns: SCENARIO_COLUMNS, live: 1, stored: 0, liveSince: BASE });
    expect(indicator.stats()["FUTURE:/ESZ26:XCME"]).toBeUndefined();
    expect(indicator.tick([NQ], 51_000)).toEqual([]);
    expect(published).toHaveLength(1);
  });

  test("columns are taken in bounded batches, each tick continuing after the last column fed", () => {
    const { indicator, published } = harness({ overrides: { columnsPerTick: 50 } });
    let total = 0;
    for (let i = 0; i < 10; i += 1) total += indicator.tick([NQ], 50_000 + i).length;
    expect(total).toBe(1);
    expect(indicator.stats()["FUTURE:/NQZ26:XCME"].columns).toBe(SCENARIO_COLUMNS);
    expect(published.map((p) => p.wire.map((s) => s.status))).toEqual([["held"]]);
  });

  test("the snapshot is the stored and live shades together, in start order, with liveSince and loading", () => {
    const { indicator } = harness();
    expect(indicator.snapshot(NQ, 40_000)).toEqual({ ts: 40_000, shades: [], liveSince: 40_000, loading: null });
    indicator.tick([NQ], 50_000);
    const snap = indicator.snapshot(NQ, 60_000);
    expect(snap).toEqual({ ts: 60_000, shades: [expect.objectContaining({ status: "held", origin: "runtime" })], liveSince: BASE, loading: null });
    expect(Object.isFrozen(snap.shades)).toBe(true);
  });

  test("a pair without geometry is left alone; a row width change restarts the trackers", () => {
    const { indicator, feed } = harness();
    feed.geometry = null;
    expect(indicator.tick([NQ], 50_000)).toEqual([]);
    feed.geometry = { rowWidth: 1 };
    expect(indicator.tick([NQ], 50_000)).toHaveLength(1);
    feed.columns = [];
    feed.geometry = { rowWidth: 0.5 };
    indicator.tick([NQ], 51_000);
    expect(indicator.stats()["FUTURE:/NQZ26:XCME"].trackers[MINUTE]).toMatchObject({ ready: false, candles: 0 });
    feed.columns = scenario();
    expect(indicator.tick([NQ], 52_000)).toHaveLength(1);
    expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ columns: 2 * SCENARIO_COLUMNS, live: 1 });
  });

  test("a column the tracker rejects is logged and the tick goes on", () => {
    const warnings = [];
    const { indicator } = harness({ columns: [{ ts: 1, lo: 0, hi: 1, bid: [1], ask: [1] }], overrides: { log: { warn: (message) => warnings.push(message) } } });
    expect(indicator.tick([NQ], 50_000)).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/rejected a column/)]);
  });

  test("stop saves the settled shades and the long engines' state; the short engines start afresh at the live start, so a restart re-judges the live tier itself and the stored copy of a shade gives way to the live one", () => {
    const { indicator, dir } = harness();
    indicator.tick([NQ], 50_000);
    indicator.stop();
    const saved = loadExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION });
    expect(saved.shades).toEqual([expect.objectContaining({ status: "held" })]);
    expect(saved.shades[0].origin).toBeUndefined();
    expect(saved.scales).toEqual([]);
    expect(saved.coveredUntil).toBe(at(15));
    const again = harness({ overrides: { storeDir: dir } });
    expect(again.indicator.snapshot(NQ, 1).shades).toEqual([]);
    again.indicator.tick([NQ], 50_000);
    const shades = again.indicator.snapshot(NQ, 60_000).shades;
    expect(shades.map((s) => [s.status, s.origin])).toEqual([["held", "runtime"]]);
    expect(again.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ live: 1, stored: 0 });
    expect(again.indicator.stats()["FUTURE:/NQZ26:XCME"].trackers[MINUTE]).toMatchObject({ candles: W + 15, unsettled: 0, shades: 1 });
    const file = exhaustionHistoryPath(dir, "FUTURE:/NQZ26:XCME");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), scales: [] }));
    const afresh = harness({ overrides: { storeDir: dir } });
    afresh.indicator.tick([NQ], 50_000);
    expect(afresh.indicator.snapshot(NQ, 60_000).shades.map((s) => s.origin)).toEqual(["runtime"]);
    expect(afresh.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ live: 1, stored: 0 });
    const tracker = createExhaustionTracker({ candleMs: MINUTE, rowWidth: 1 });
    for (const c of scenario()) tracker.push(c);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), scales: [tracker.toJSON()] }));
    const ignoring = harness({ overrides: { storeDir: dir } });
    ignoring.indicator.tick([NQ], 50_000);
    expect(ignoring.indicator.snapshot(NQ, 60_000).shades.map((s) => s.origin)).toEqual(["runtime"]);
    expect(ignoring.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ live: 1, stored: 0 });
  });

  test("a restored history shows up stored before any column is fed, open and pending shades and stale rules are left out", () => {
    const { dir } = harness();
    const held = { id: "60000|buyers|1", candleMs: MINUTE, side: "buyers", status: "held", intensity: 1, score: 3, readings: { rate: true, progress: false, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.211, progress: 0, delta: -0.5, divergence: null, prints: 0, book: null }, raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 }, startTs: 49_000, endTs: 49_500, extremeTs: 48_000, extremePrice: 104, legStartTs: 40_000, legStartPrice: 101, legSize: 3, efficiency: 0.8, atr: 1, judgedAt: 49_900, updatedAt: 49_900 };
    const open = { ...held, id: "60000|buyers|2", status: "open", judgedAt: null };
    const old = { ...held, id: "60000|buyers|3", startTs: 1, endTs: 2, extremeTs: 1, legStartTs: 0, judgedAt: 3, updatedAt: 3 };
    const pending = { ...held, id: "60000|buyers|4", status: "pending", judgedAt: null };
    saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, shades: [held, open, old, pending, { id: "bad" }], scales: [{ candleMs: MINUTE, rowWidth: 1 }, { candleMs: 300_000 }] });
    const warnings = [];
    const { indicator } = harness({ columns: [], overrides: { storeDir: dir, maxAgeS: 10, now: () => 50_000, log: { warn: (message) => warnings.push(message) } } });
    indicator.tick([NQ], 50_000);
    expect(indicator.snapshot(NQ, 50_000).shades).toEqual([{ ...held, origin: "stored" }]);
    expect(warnings).toEqual([expect.stringMatching(/left out 4 saved shade/)]);
    const stale = harness({ columns: [], overrides: { storeDir: dir } });
    fs.writeFileSync(exhaustionHistoryPath(dir, "FUTURE:/NQZ26:XCME"), JSON.stringify({ version: 1, pairKey: "FUTURE:/NQZ26:XCME", savedAt: 1, rulesVersion: EXHAUSTION_RULES_VERSION + 1, shades: [held], scales: [] }));
    stale.indicator.tick([NQ], 50_000);
    expect(stale.indicator.snapshot(NQ, 50_000).shades).toEqual([]);
  });

  test("the history is saved in the background once the store interval has passed and the state is dirty", async () => {
    const saves = [];
    const { indicator } = harness({ overrides: { storeS: 1, saveHistory: async (payload) => { saves.push(payload); return { ok: true }; } } });
    indicator.tick([NQ], 50_000);
    expect(saves).toEqual([]);
    indicator.tick([NQ], 51_000);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, shades: [expect.objectContaining({ status: "held" })] });
    await Promise.resolve();
    indicator.tick([NQ], 53_000);
    expect(saves).toHaveLength(1);
  });

  test("shades older than the age cap leave the live and stored sets at the prune", () => {
    const { indicator } = harness({ overrides: { maxAgeS: 1 } });
    indicator.tick([NQ], 50_000);
    expect(indicator.snapshot(NQ, 50_000).shades).toHaveLength(1);
    indicator.tick([NQ], at(20));
    expect(indicator.snapshot(NQ).shades).toHaveLength(0);
  });

  test("the frozen book the heatmap keeps sending while the market is closed makes no candles: the engine leaves a three-hour closure with the ATR it took in, and the shade waiting at the close is interrupted at the reopen", () => {
    const open = scenario().slice(0, W + 11);
    const { indicator, feed, published } = harness({ columns: [...open, frozen(at(11), 106)], overrides: { columnsPerTick: 2_000 } });
    indicator.tick([NQ], 50_000);
    expect(indicator.snapshot(NQ, 50_000).shades.map((s) => [s.id, s.status])).toEqual([[`60000|buyers|${at(7)}`, "pending"]]);
    const before = indicator.stats()["FUTURE:/NQZ26:XCME"].trackers[MINUTE];
    const reopen = at(11) + 3 * 3_600_000;
    const closure = [];
    for (let ts = at(11) + 10_000; ts < reopen; ts += 10_000) closure.push(frozen(ts, 106));
    feed.columns = [...feed.columns, ...closure, column(reopen, { mid: 106 })];
    indicator.tick([NQ], 51_000);
    expect(indicator.stats()["FUTURE:/NQZ26:XCME"].trackers[MINUTE]).toEqual(before);
    feed.columns = [...feed.columns, column(reopen + MINUTE, { mid: 106 })];
    indicator.tick([NQ], 52_000);
    expect(published.at(-1).wire.map((s) => [s.id, s.status, s.judgedAt, s.origin])).toEqual([[`60000|buyers|${at(7)}`, "interrupted", reopen + MINUTE, "runtime"]]);
    expect(indicator.stats()["FUTURE:/NQZ26:XCME"].trackers[MINUTE].atr).toBeGreaterThan(before.atr * 0.9);
  });

  describe("history from the host's columns", () => {
    const MAX_AGE_S = 4 * 3_600;
    const HOUR = 3_600_000;

    function hostHarness({ host, deep, now = at(16), hostColumns, overrides = {} }) {
      const calls = [];
      const reader = hostColumns ?? (async (pair, fromTs, toTs) => {
        calls.push([pair.symbol, fromTs, toTs]);
        return { columns: host.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null };
      });
      const made = harness({ columns: deep, overrides: { now: () => now, maxAgeS: MAX_AGE_S, histories: false, hostColumns: reader, log: { warn: () => {}, info: () => {} }, ...overrides } });
      return { ...made, calls };
    }

    test("the hours below the host's edge are probed newest first for a day with trades, then read oldest first from there, a warm-up hour below, without waiting for the heatmap; the engines then take the ring from the host's last column, liveSince the first ring column fed, the span covered", async () => {
      const all = scenario();
      const NOW = at(16);
      const { indicator, published, calls } = hostHarness({ host: all.slice(0, W), deep: all.slice(W) });
      expect(indicator.tick([NQ], NOW)).toEqual([]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "history", liveSince: null, columns: 0, fill: { state: "reading" } });
      expect(indicator.snapshot(NQ, NOW)).toMatchObject({ loading: NOW - MAX_AGE_S * 1000 });
      await indicator.idle();
      const fromTs = NOW - MAX_AGE_S * 1000;
      expect(calls.map((call) => call.slice(1))).toEqual([[NOW - HOUR, NOW], [NOW - 2 * HOUR, NOW - HOUR], [NOW - 3 * HOUR, NOW - 2 * HOUR], [fromTs, NOW - 3 * HOUR], [fromTs - HOUR, fromTs], [fromTs, fromTs + HOUR], [fromTs + HOUR, fromTs + 2 * HOUR], [fromTs + 2 * HOUR, fromTs + 3 * HOUR], [fromTs + 3 * HOUR, NOW]]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", liveSince: null, columns: W, coveredFrom: fromTs, loading: null, fill: { state: "done", columns: W, hours: 9, reason: null } });
      expect(published).toEqual([]);
      expect(indicator.tick([NQ], NOW + 1000).map((shade) => [shade.status, shade.origin])).toEqual([["held", "runtime"]]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ columns: W + 16, liveSince: at(0) });
      expect(indicator.snapshot(NQ, NOW).liveSince).toBe(at(0));
    });

    test("a shade judged inside the host's hours arrives with origin host; one that starts in the host's hours and settles on the live columns keeps origin host", async () => {
      const all = scenario();
      const quiet = [column(at(16), { mid: 106 }), column(at(17), { mid: 106 })];
      const { indicator, published } = hostHarness({ host: all, deep: quiet, now: at(18) });
      indicator.tick([NQ], at(18));
      await indicator.idle();
      expect(published.map((p) => p.wire.map((shade) => [shade.status, shade.origin]))).toEqual([[["held", "host"]]]);
      indicator.tick([NQ], at(18) + 1000);
      expect(indicator.snapshot(NQ, at(18)).shades.map((shade) => [shade.status, shade.origin])).toEqual([["held", "host"]]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ live: 1, stored: 0, liveSince: at(16) });

      const carried = hostHarness({ host: all.slice(0, W + 9), deep: all.slice(W + 9) });
      carried.indicator.tick([NQ], at(16));
      await carried.indicator.idle();
      expect(carried.published.map((p) => p.wire.map((shade) => [shade.status, shade.origin]))).toEqual([[["open", "host"]]]);
      carried.indicator.tick([NQ], at(16) + 1000);
      expect(carried.indicator.snapshot(NQ, at(16)).shades.map((shade) => [shade.status, shade.judgedAt, shade.origin])).toEqual([["held", at(15), "host"]]);
    });

    test("the first failed hour ends the fill: the engines start at the ring's newest run, which is all that is covered; nothing is read past the failure", async () => {
      const warnings = [];
      const reads = [];
      const all = scenario();
      const { indicator } = hostHarness({ host: [], deep: all, hostColumns: async (pair, fromTs) => { reads.push(fromTs); return { columns: [], reason: "STORAGE_UNAVAILABLE" }; }, overrides: { maxAgeS: 8 * 3_600, log: { warn: (message) => warnings.push(message), info: () => {} } } });
      expect(indicator.tick([NQ], at(16))).toEqual([]);
      await indicator.idle();
      expect(reads).toHaveLength(3);
      expect(warnings).toEqual([expect.stringMatching(/host history stopped at .* \(STORAGE_UNAVAILABLE\); the engines start at the live tier/)]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", liveSince: null, coveredFrom: BASE, fill: { state: "failed", reason: "STORAGE_UNAVAILABLE" } });
      expect(indicator.tick([NQ], at(16) + 1000).map((shade) => [shade.status, shade.origin])).toEqual([["held", "runtime"]]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: BASE });
      const feedWarnings = [];
      const feedFails = hostHarness({ host: all.slice(0, W), deep: all.slice(W), hostColumns: async (pair, fromTs, toTs) => { if (fromTs === at(16) - 8 * 3_600_000 - HOUR) return { columns: [], reason: "PAGE_LIMIT" }; return { columns: all.slice(0, W).filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null }; }, overrides: { maxAgeS: 8 * 3_600, log: { warn: (message) => feedWarnings.push(message), info: () => {} } } });
      feedFails.indicator.tick([NQ], at(16));
      await feedFails.indicator.idle();
      expect(feedWarnings).toEqual([expect.stringMatching(/host history stopped at .* \(PAGE_LIMIT\); the engines start at the live tier/)]);
      expect(feedFails.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", liveSince: null, coveredFrom: at(0), fill: { state: "failed", reason: "PAGE_LIMIT" } });
      feedFails.indicator.tick([NQ], at(16) + 1000);
      expect(feedFails.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: at(0) });
    });

    test("the fill starts where the saved run stopped and joins the saved coverage; the hour above a saved run that reaches the edge is probed and found empty; a downtime longer than the fill span starts the coverage at the fill floor", async () => {
      const all = scenario();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-indicator-"));
      saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: at(-30), coveredFrom: at(-200), shades: [], scales: [] });
      const resumed = hostHarness({ host: all.slice(0, W), deep: all.slice(W), overrides: { histories: true, storeDir: dir } });
      resumed.indicator.tick([NQ], at(16));
      await resumed.indicator.idle();
      expect(resumed.calls.map((call) => call.slice(1))).toEqual([[at(-30), at(16)], [at(-30) - HOUR, at(-30)], [at(-30), at(16)]]);
      expect(resumed.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: at(-200), liveSince: null, fill: { state: "done" } });
      resumed.indicator.tick([NQ], at(16) + 1000);
      expect(resumed.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: at(0) });
      saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: at(3), coveredFrom: at(-200), shades: [], scales: [] });
      const caught = hostHarness({ host: all.slice(0, W), deep: all.slice(W), overrides: { histories: true, storeDir: dir } });
      caught.indicator.tick([NQ], at(16));
      await caught.indicator.idle();
      expect(caught.calls.map((call) => call.slice(1))).toEqual([[at(3), at(16)]]);
      expect(caught.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", coveredFrom: at(-200), fill: { state: "done", columns: 0 } });
      saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: at(0) - 30_000, coveredFrom: at(-200), shades: [], scales: [] });
      const nearly = hostHarness({ host: all.slice(0, W), deep: all.slice(W), overrides: { histories: true, storeDir: dir } });
      nearly.indicator.tick([NQ], at(16));
      await nearly.indicator.idle();
      expect(nearly.calls.map((call) => call.slice(1))).toEqual([[at(0) - 30_000, at(16)]]);
      expect(nearly.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", coveredFrom: at(-200), fill: { state: "done" } });
      saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: at(-300), coveredFrom: at(-400), shades: [], scales: [] });
      const floor = at(16) - MAX_AGE_S * 1000;
      const away = hostHarness({ host: all.slice(0, W), deep: all.slice(W), overrides: { histories: true, storeDir: dir } });
      away.indicator.tick([NQ], at(16));
      await away.indicator.idle();
      expect(away.calls[0].slice(1)).toEqual([at(16) - HOUR, at(16)]);
      expect(away.calls[4].slice(1)).toEqual([floor - HOUR, floor]);
      expect(away.calls.at(-1).slice(1)).toEqual([at(16) - HOUR, at(16)]);
      expect(away.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: floor, fill: { state: "done" } });
    });

    test("after a restart the heatmap's restored tier sits before a hole: the host is read from the stop to its edge, the shade left waiting at the stop is re-judged on it with origin host, and the restored tier is never replayed", async () => {
      const all = scenario();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-indicator-"));
      const first = harness({ columns: all.slice(0, W + 11), overrides: { storeDir: dir, now: () => at(11), maxAgeS: MAX_AGE_S } });
      first.indicator.tick([NQ], at(11));
      expect(first.indicator.snapshot(NQ, at(11)).shades.map((s) => [s.id, s.status])).toEqual([[`60000|buyers|${at(7)}`, "pending"]]);
      first.indicator.stop();
      const saved = loadExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION });
      expect(saved).toMatchObject({ shades: [], coveredUntil: at(10), coveredFrom: BASE, scales: [] });
      const deep = [...all.slice(W + 3, W + 11), ...all.slice(W + 13)];
      const again = hostHarness({ host: all, deep, overrides: { histories: true, storeDir: dir } });
      again.indicator.tick([NQ], at(16));
      expect(again.indicator.snapshot(NQ, at(16)).shades).toEqual([]);
      await again.indicator.idle();
      expect(again.calls.map((call) => call.slice(1))).toEqual([[at(10), at(16)], [at(10) - HOUR, at(10)], [at(10), at(16)]]);
      expect(again.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: null, coveredFrom: BASE, fill: { state: "done", hours: 3 } });
      expect(again.indicator.snapshot(NQ, at(16)).shades.map((s) => [s.id, s.status, s.judgedAt, s.origin])).toEqual([[`60000|buyers|${at(7)}`, "held", at(15), "host"]]);
      expect(again.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ columns: 46 });
      again.indicator.tick([NQ], at(16) + 1000);
      expect(again.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: null, columns: 46 });
      expect(again.indicator.stats()["FUTURE:/NQZ26:XCME"].trackers[MINUTE].candles).toBeLessThan(W + 16);
    });

    test("a weekend below the live start is walked past: the fill reads the last day that has columns, so the engines open warm on data three days old", async () => {
      const all = scenario();
      const DAY = 86_400_000;
      const old = all.map((c) => Object.freeze({ ...c, ts: c.ts - 3 * DAY }));
      const { indicator, published, calls } = hostHarness({ host: old, deep: all.slice(W + 14), overrides: { maxAgeS: 7 * 86_400 } });
      indicator.tick([NQ], at(16));
      await indicator.idle();
      const floor = at(16) - 7 * DAY;
      expect(calls[0].slice(1)).toEqual([at(16) - HOUR, at(16)]);
      expect(Math.min(...calls.map((call) => call[1]))).toBe(floor - HOUR);
      expect(published.map((p) => p.wire.map((s) => [s.status, s.origin, s.startTs]))).toEqual([[["held", "host", at(7) - 3 * DAY]]]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", liveSince: null, coveredFrom: floor, fill: { state: "done" } });
      indicator.tick([NQ], at(16) + 1000);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: at(14) });
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"].trackers[MINUTE].ready).toBe(true);
    });

    test("the fill does not wait for the heatmap: on a stale ring the host is read to its edge at once, the engines take the ring's newest run from the host's last column, and an ask is accepted as soon as the fill is done", async () => {
      const all = scenario();
      const { indicator, calls } = hostHarness({ host: all.slice(0, W), deep: all.slice(W), now: at(40), overrides: { fillS: 3_600, maxAgeS: 8 * 3_600 } });
      expect(indicator.tick([NQ], at(40))).toEqual([]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "history", fill: { state: "reading" } });
      expect(indicator.requestHistory(NQ, at(-400))).toBe(false);
      await indicator.idle();
      expect(calls[0].slice(1)).toEqual([at(40) - HOUR, at(40)]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", liveSince: null, columns: W, coveredFrom: at(40) - HOUR, fill: { state: "done" } });
      expect(indicator.requestHistory(NQ, at(-400))).toBe(true);
      expect(indicator.tick([NQ], at(40) + 1000).map((shade) => [shade.status, shade.origin])).toEqual([["held", "runtime"]]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: at(0), columns: W + 16 });
      const held = hostHarness({ host: all, deep: all.slice(0, W), now: at(40), overrides: { fillS: 3_600, maxAgeS: 8 * 3_600 } });
      held.indicator.tick([NQ], at(40));
      await held.indicator.idle();
      expect(held.published.map((p) => p.wire.map((shade) => [shade.status, shade.origin]))).toEqual([[["held", "host"]]]);
      expect(held.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: null, coveredFrom: at(-20) });
      expect(held.indicator.requestHistory(NQ, at(-400))).toBe(true);
      held.indicator.tick([NQ], at(40) + 1000);
      await held.indicator.idle();
      expect(held.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: null, coveredFrom: at(-400), asked: null, loading: null });
    });

    test("one pair reads at a time, the chart's pair first; the others wait for their turn", async () => {
      const all = scenario();
      const order = [];
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const indicator = createExhaustionIndicator({
        provider: "DXFEED", histories: false, now: () => at(16), maxAgeS: 3_600, candleLengths: [MINUTE], log: { warn: () => {}, info: () => {} },
        columnsAfter: (pair, afterTs, limit) => all.slice(W).filter((c) => afterTs === null || c.ts > afterTs).slice(0, limit),
        geometryOf: () => ({ rowWidth: 1 }),
        hostColumns: async (pair) => { order.push(pair.symbol); await gate; return { columns: [], reason: null }; },
        activePair: () => ES,
        publish: () => {},
      });
      indicator.tick([NQ, ES], at(16));
      expect([...new Set(order)]).toEqual([ES.symbol]);
      indicator.tick([NQ, ES], at(16) + 1000);
      expect([...new Set(order)]).toEqual([ES.symbol]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "history", columns: 0 });
      release();
      await indicator.idle();
      indicator.tick([NQ, ES], at(16) + 2000);
      expect(order).toContain(NQ.symbol);
      await indicator.idle();
      indicator.tick([NQ, ES], at(16) + 3000);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", columns: 16 });
      expect(indicator.stats()["FUTURE:/ESZ26:XCME"]).toMatchObject({ phase: "live", columns: 16 });
    });

    test("the long candle lengths are fed the same stream, host hours then the ring; their engine state is what the store keeps, with a waiting shade of theirs restored as stored", async () => {
      const all = scenario();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-indicator-"));
      const { indicator } = hostHarness({ host: all.slice(0, W), deep: all.slice(W), overrides: { candleLengths: [MINUTE, 3_600_000], histories: true, storeDir: dir } });
      indicator.tick([NQ], at(16));
      await indicator.idle();
      indicator.tick([NQ], at(16) + 1000);
      expect(Object.keys(indicator.stats()["FUTURE:/NQZ26:XCME"].trackers)).toEqual(["60000", "3600000"]);
      indicator.stop();
      const saved = loadExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION });
      expect(saved.scales.map((scale) => scale.candleMs)).toEqual([3_600_000]);
      expect(saved.scales[0].lastColumnTs).toBe(at(15));
      expect(saved.coveredUntil).toBe(at(15));
      const waiting = { id: "3600000|buyers|1", candleMs: 3_600_000, side: "buyers", status: "pending", intensity: 1, score: 3, readings: { rate: true, progress: false, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.211, progress: 0, delta: -0.5, divergence: null, prints: 0, book: null }, raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 }, startTs: at(-120), endTs: at(-60), extremeTs: at(-120), extremePrice: 104, legStartTs: at(-600), legStartPrice: 101, legSize: 3, efficiency: 0.8, atr: 1, judgedAt: null, updatedAt: at(-60), running: 104 };
      const file = exhaustionHistoryPath(dir, "FUTURE:/NQZ26:XCME");
      const payload = JSON.parse(fs.readFileSync(file, "utf8"));
      payload.scales[0].unsettled = [waiting];
      fs.writeFileSync(file, JSON.stringify(payload));
      const again = hostHarness({ host: all.slice(0, W), deep: all.slice(W), overrides: { candleLengths: [MINUTE, 3_600_000], histories: true, storeDir: dir } });
      again.indicator.tick([NQ], at(16));
      expect(again.indicator.snapshot(NQ, at(16)).shades.filter((s) => s.candleMs === 3_600_000).map((s) => [s.id, s.status, s.origin])).toEqual([["3600000|buyers|1", "pending", "stored"]]);
      expect(again.indicator.stats()["FUTURE:/NQZ26:XCME"].trackers[3_600_000]).toMatchObject({ unsettled: 1 });
    });

    test("without a host reader or with the fill switched off the engines start at the ring's newest run; a host that answers NO_HOST switches the fill off without a warning; asks are refused on both", async () => {
      const all = scenario();
      const off = hostHarness({ host: all, deep: all, overrides: { hostFill: false } });
      expect(off.indicator.tick([NQ], at(16))).toHaveLength(1);
      expect(off.calls).toEqual([]);
      expect(off.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", liveSince: BASE, coveredFrom: BASE, fill: { state: "off" } });
      expect(off.indicator.requestHistory(NQ, at(-100))).toBe(false);
      const holed = hostHarness({ host: all, deep: [...all.slice(W, W + 5), ...all.slice(W + 9)], overrides: { hostFill: false } });
      holed.indicator.tick([NQ], at(16));
      expect(holed.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: at(9), coveredFrom: at(9), columns: 7 });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-indicator-"));
      saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: at(-300), coveredFrom: at(-400), shades: [], scales: [] });
      const apart = hostHarness({ host: all, deep: all, overrides: { hostFill: false, histories: true, storeDir: dir } });
      apart.indicator.tick([NQ], at(16));
      expect(apart.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: BASE, coveredFrom: BASE, fill: { state: "off" } });
      saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: BASE - 1000, coveredFrom: at(-400), shades: [], scales: [] });
      const joined = hostHarness({ host: all, deep: all, overrides: { hostFill: false, histories: true, storeDir: dir } });
      joined.indicator.tick([NQ], at(16));
      expect(joined.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: BASE, coveredFrom: at(-400), fill: { state: "off" } });
      const warnings = [];
      const none = hostHarness({ host: [], deep: all, hostColumns: async () => ({ columns: [], reason: "NO_HOST" }), overrides: { log: { warn: (message) => warnings.push(message), info: () => {} } } });
      none.indicator.tick([NQ], at(16));
      await none.indicator.idle();
      expect(warnings).toEqual([]);
      expect(none.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", coveredFrom: BASE, fill: { state: "off", reason: "NO_HOST" } });
      expect(none.indicator.requestHistory(NQ, at(-100))).toBe(false);
      expect(none.indicator.tick([NQ], at(16) + 1000)).toHaveLength(1);
      expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null, hostColumns: 5 })).toThrow(/hostColumns/);
      expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null, fillChunkMs: 0 })).toThrow(/fillChunkMs/);
      expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null, fillConcurrency: 0 })).toThrow(/fillConcurrency/);
    });

    test("an equity runs the short candle lengths only", () => {
      const AAPL = { symbol: "AAPL", marketKind: "EQUITY" };
      const all = scenario();
      const indicator = createExhaustionIndicator({ provider: "DXFEED", histories: false, now: () => at(16), candleLengths: [MINUTE, 1_800_000, 3_600_000, 86_400_000], columnsAfter: () => all, geometryOf: () => ({ rowWidth: 1 }), publish: () => {} });
      indicator.tick([AAPL, NQ], at(16));
      expect(Object.keys(indicator.stats()["EQUITY:AAPL"].trackers)).toEqual(["60000", "1800000"]);
      expect(Object.keys(indicator.stats()["FUTURE:/NQZ26:XCME"].trackers)).toEqual(["60000", "1800000", "3600000", "86400000"]);
      expect(lengthsFor(AAPL, [60_000, 3_600_000])).toEqual([60_000]);
    });

    test("the ring's newest run starts after the last hole wider than the gap bound", () => {
      const columns = (ts) => ({ ts });
      expect(runStart([columns(0), columns(60_000), columns(120_000)])).toBe(0);
      expect(runStart([columns(0), columns(60_000), columns(180_001), columns(240_000)])).toBe(180_001);
      expect(runStart([columns(5)])).toBe(5);
      expect(MIN_FILL_MS).toBe(60_000);
    });
  });

  describe("history on demand", () => {
    const NOW = at(33);
    const HOUR = 3_600_000;
    const DAY = 86_400_000;

    function passHarness({ host, deep, activePair = () => null, fillS = 60, maxAgeS = 4 * 3_600, hostColumns, overrides = {} }) {
      const calls = [];
      const loads = [];
      let reselects = 0;
      const reader = hostColumns ?? (async (pair, fromTs, toTs) => {
        calls.push([fromTs, toTs]);
        return { columns: host.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null };
      });
      const made = harness({ columns: deep, overrides: { now: () => NOW, maxAgeS, ...(fillS === null ? {} : { fillS }), histories: false, hostColumns: reader, activePair, reselect: () => { reselects += 1; }, log: { warn: () => {}, info: () => {} }, publish: (wire, pair, at, liveSince, loading) => loads.push({ wire: wire.map((s) => [s.id, s.status, s.origin]), loading }), ...overrides } });
      return { ...made, calls, loads, reselects: () => reselects };
    }

    const quiet = [column(at(31), { mid: 106 }), column(at(32), { mid: 106 })];
    const shifted = (days) => scenario().map((c) => Object.freeze({ ...c, ts: c.ts - days * DAY }));

    test("the start fills a day of columns by default, or L2_EXHAUSTION_FILL_S worth, never more than the age cap: the hours below the live start are probed newest first until that many hours with columns are found, then read oldest first; an empty host is probed to the cap and read no further; loading names the span while it is read and a reset follows each change for the chart's pair", async () => {
      const hourly = Array.from({ length: 48 }, (_, i) => column(NOW - (i + 1) * HOUR + 60_000, { mid: 100 + (i % 2) }));
      const day = passHarness({ host: hourly, deep: quiet, fillS: null, maxAgeS: 30 * 86_400 });
      day.indicator.tick([NQ], NOW);
      await day.indicator.idle();
      expect(day.calls[0]).toEqual([NOW - HOUR, NOW]);
      expect(day.calls[23]).toEqual([NOW - 24 * HOUR, NOW - 23 * HOUR]);
      expect(day.calls[25]).toEqual([NOW - 26 * HOUR, NOW - 25 * HOUR]);
      expect(day.calls[26]).toEqual([NOW - 25 * HOUR, NOW - 24 * HOUR]);
      expect(day.calls).toHaveLength(51);
      expect(Math.max(...day.calls.map((call) => call[1]))).toBe(NOW);
      expect(day.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: NOW - 24 * HOUR, loading: null, liveSince: null, fill: { state: "done", hours: 51 } });
      day.indicator.tick([NQ], NOW + 1000);
      expect(day.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: at(31) });
      const short = passHarness({ host: [], deep: quiet, fillS: 7_200, activePair: () => NQ });
      short.indicator.tick([NQ], NOW);
      expect(short.indicator.snapshot(NQ, NOW)).toMatchObject({ loading: NOW - 2 * HOUR, liveSince: NOW });
      expect(short.reselects()).toBe(1);
      await short.indicator.idle();
      expect(short.calls).toEqual([[NOW - HOUR, NOW], [NOW - 2 * HOUR, NOW - HOUR], [NOW - 3 * HOUR, NOW - 2 * HOUR], [NOW - 4 * HOUR, NOW - 3 * HOUR]]);
      short.indicator.tick([NQ], NOW + 1000);
      expect(short.indicator.snapshot(NQ, NOW)).toMatchObject({ loading: null, liveSince: at(31) });
      expect(short.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: NOW - 4 * HOUR, fill: { state: "done", columns: 0, hours: 4 } });
      expect(short.reselects()).toBe(2);
      const capped = passHarness({ host: [], deep: quiet, fillS: 10 * 86_400, maxAgeS: 3 * 3_600 });
      capped.indicator.tick([NQ], NOW);
      await capped.indicator.idle();
      expect(capped.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: NOW - 3 * HOUR });
      const other = passHarness({ host: [], deep: quiet, fillS: 7_200, activePair: () => ES });
      other.indicator.tick([NQ], NOW);
      await other.indicator.idle();
      expect(other.reselects()).toBe(0);
    });

    test("a client's ask for an older span is read a day at a time, the newest day first: each day is judged by fresh engines warmed on the hours below it and reaching into the hours above it, only its own settled shades are handed over, with origin host, kept as stored; the covered start moves down a day at a time; an ask inside the covered span or a malformed one is refused", async () => {
      const { indicator, calls, loads, reselects } = passHarness({ host: [...shifted(2), ...shifted(1), ...scenario()], deep: quiet, maxAgeS: 3 * 86_400, activePair: () => NQ });
      expect(indicator.requestHistory(NQ, at(-40))).toBe(false);
      indicator.tick([NQ], NOW);
      await indicator.idle();
      expect(calls).toEqual([[at(-27), at(33)], [at(-87), at(-27)], [at(-147), at(-87)], [at(-87), at(-27)], [at(-27), at(33)]]);
      expect(loads.map((entry) => entry.wire)).toEqual([[[`60000|buyers|${at(7)}`, "held", "host"]]]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", coveredFrom: at(-27), loading: null, asked: null, live: 1, stored: 0 });
      expect(indicator.requestHistory(NQ, "x")).toBe(false);
      expect(indicator.requestHistory(NQ, -1)).toBe(false);
      expect(indicator.requestHistory(NQ, at(-27))).toBe(false);
      expect(indicator.requestHistory(NQ, at(35))).toBe(false);
      expect(indicator.requestHistory(ES, at(-40))).toBe(false);
      const from = at(-27) - 2 * DAY;
      expect(indicator.requestHistory(NQ, from)).toBe(true);
      expect(indicator.requestHistory(NQ, from + 60_000)).toBe(false);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ asked: from, loading: null });
      calls.length = 0;
      loads.length = 0;
      const before = reselects();
      indicator.tick([NQ], NOW + 1000);
      expect(indicator.snapshot(NQ, NOW + 1000).loading).toBe(from);
      expect(reselects()).toBe(before + 1);
      await indicator.idle();
      const dayBelow = at(-27) - DAY;
      expect(calls[0]).toEqual([dayBelow - HOUR, dayBelow]);
      const second = calls.findIndex((call) => call[0] === from - HOUR);
      expect(second).toBeGreaterThan(0);
      expect(calls.slice(0, second).every((call) => call[0] >= dayBelow - HOUR)).toBe(true);
      expect(Math.max(...calls.slice(0, second).map((call) => call[1]))).toBe(at(31));
      expect(Math.max(...calls.slice(second).map((call) => call[1]))).toBe(dayBelow + HOUR);
      expect(loads.map((entry) => entry.wire)).toEqual([[[`60000|buyers|${at(7) - DAY}`, "held", "host"]], [[`60000|buyers|${at(7) - 2 * DAY}`, "held", "host"]]]);
      expect(loads.map((entry) => entry.loading)).toEqual([from, from]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: from, asked: null, live: 1, stored: 2, dirty: true, loading: null });
      expect(reselects()).toBe(before + 2);
      expect(indicator.requestHistory(NQ, from)).toBe(false);
      expect(indicator.requestHistory(NQ, from - 60_000)).toBe(true);
    });

    test("the pass reads the after-hours above the covered start, never past the live start, so a shade settling just above the asked span is judged; a shade the fill already settled is not handed over again", async () => {
      const all = scenario();
      const { indicator, calls, loads } = passHarness({ host: all, deep: quiet, fillS: 600 });
      indicator.tick([NQ], NOW);
      await indicator.idle();
      expect(calls).toEqual([[at(-27), at(33)], [at(-87), at(-27)], [at(-147), at(-87)], [at(-87), at(-27)], [at(-27), at(33)]]);
      expect(loads.map((entry) => entry.wire)).toEqual([[[`60000|buyers|${at(7)}`, "held", "host"]]]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: at(-27), liveSince: null, live: 1, stored: 0 });
      calls.length = 0;
      expect(indicator.requestHistory(NQ, at(-40))).toBe(true);
      indicator.tick([NQ], NOW + 1000);
      await indicator.idle();
      expect(calls).toEqual([[at(-40) - HOUR, at(-40)], [at(-40), at(20)], [at(20), at(31)]]);
      expect(loads).toHaveLength(1);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: at(-40), live: 1, stored: 0 });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-indicator-"));
      saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: at(20), coveredFrom: at(20), shades: [], scales: [] });
      const near = passHarness({ host: all, deep: quiet, overrides: { histories: true, storeDir: dir } });
      near.indicator.tick([NQ], NOW);
      await near.indicator.idle();
      expect(near.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: at(20), liveSince: null });
      near.indicator.tick([NQ], NOW + 500);
      expect(near.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ liveSince: at(31) });
      near.calls.length = 0;
      expect(near.indicator.requestHistory(NQ, at(-40))).toBe(true);
      near.indicator.tick([NQ], NOW + 1000);
      await near.indicator.idle();
      expect(near.calls).toEqual([[at(-40) - HOUR, at(-40)], [at(-40), at(20)], [at(20), at(31)]]);
    });

    test("a shade still waiting where the pass's columns end is not handed over, however many days the pass reads; an ask is clamped to the age cap", async () => {
      const all = scenario();
      const { indicator, calls, loads } = passHarness({ host: [...shifted(2).slice(0, W + 12), ...all], deep: quiet, maxAgeS: 3 * 86_400 });
      indicator.tick([NQ], NOW);
      await indicator.idle();
      expect(loads.map((entry) => entry.wire)).toEqual([[[`60000|buyers|${at(7)}`, "held", "host"]]]);
      expect(indicator.requestHistory(NQ, at(-500) - 10 * DAY)).toBe(true);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", coveredFrom: at(-27), asked: NOW - 3 * DAY });
      calls.length = 0;
      indicator.tick([NQ], NOW + 1000);
      await indicator.idle();
      expect(calls[0]).toEqual([at(-27) - DAY - HOUR, at(-27) - DAY]);
      expect(Math.min(...calls.map((call) => call[0]))).toBe(NOW - 3 * DAY - HOUR);
      expect(loads).toHaveLength(1);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: NOW - 3 * DAY, stored: 0, live: 1 });
    });

    test("the first failed hour stops a pass and claims nothing below the days it finished; a stop ends a running pass with no later read; the covered start survives a restart through the store", async () => {
      const warnings = [];
      let reads = 0;
      const all = scenario();
      const failing = passHarness({ host: all, deep: quiet, hostColumns: async (pair, fromTs, toTs) => {
        reads += 1;
        if (fromTs < at(-250)) return { columns: [], reason: "STORAGE_UNAVAILABLE" };
        return { columns: all.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null };
      }, overrides: { log: { warn: (message) => warnings.push(message), info: () => {} } } });
      failing.indicator.tick([NQ], NOW);
      await failing.indicator.idle();
      expect(failing.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: at(-27), fill: { state: "done" } });
      reads = 0;
      expect(failing.indicator.requestHistory(NQ, at(-200))).toBe(true);
      failing.indicator.tick([NQ], NOW + 1000);
      await failing.indicator.idle();
      expect(reads).toBe(3);
      expect(warnings).toEqual([expect.stringMatching(/history pass stopped at .* \(STORAGE_UNAVAILABLE\); covered back to/)]);
      expect(failing.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: at(-27), loading: null, asked: null });
      expect(failing.indicator.requestHistory(NQ, at(-200))).toBe(true);

      let launched = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const stopping = passHarness({ host: all, deep: quiet, hostColumns: async (pair, fromTs, toTs) => { launched += 1; if (fromTs < at(-250)) await gate; return { columns: all.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null }; } });
      stopping.indicator.tick([NQ], NOW);
      await stopping.indicator.idle();
      launched = 0;
      const seen = stopping.loads.length;
      expect(stopping.indicator.requestHistory(NQ, at(-300))).toBe(true);
      stopping.indicator.tick([NQ], NOW + 1000);
      expect(launched).toBe(3);
      stopping.indicator.stop();
      release();
      await stopping.indicator.idle();
      expect(launched).toBe(3);
      expect(stopping.loads).toHaveLength(seen);
      expect(stopping.indicator.requestHistory(NQ, at(-400))).toBe(false);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-indicator-"));
      const saved = passHarness({ host: all, deep: quiet, overrides: { histories: true, storeDir: dir } });
      saved.indicator.tick([NQ], NOW);
      await saved.indicator.idle();
      expect(saved.indicator.requestHistory(NQ, at(-100))).toBe(true);
      saved.indicator.tick([NQ], NOW + 1000);
      await saved.indicator.idle();
      saved.indicator.stop();
      expect(loadExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION })).toMatchObject({ coveredFrom: at(-100), coveredUntil: at(32) });
      const again = passHarness({ host: all, deep: quiet, overrides: { histories: true, storeDir: dir } });
      again.indicator.tick([NQ], NOW);
      await again.indicator.idle();
      expect(again.indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ coveredFrom: at(-100), fill: { state: "done", columns: 0 } });
      expect(again.indicator.requestHistory(NQ, at(-90))).toBe(false);
      expect(again.indicator.requestHistory(NQ, at(-110))).toBe(true);
      again.indicator.stop();
      expect(again.indicator.requestHistory(NQ, at(-120))).toBe(false);
    });

    test("while the fill still reads, the covered end stays the store's, so a save or a stop mid-fill loses nothing; the live edge follows once the engines are live", async () => {
      const all = scenario();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-indicator-"));
      saveExhaustionHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", rulesVersion: EXHAUSTION_RULES_VERSION, coveredUntil: at(-90), coveredFrom: at(-150), shades: [], scales: [] });
      const saves = [];
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const early = [column(at(-100), { mid: 100 }), column(at(-99), { mid: 101 })];
      const { indicator } = passHarness({ host: [], deep: all.slice(W + 10), fillS: 4 * 3_600, hostColumns: async (pair, fromTs, toTs) => { if (fromTs === at(-30)) await gate; return { columns: [...early, ...all].filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null }; }, overrides: { now: () => at(16), histories: true, storeDir: dir, storeS: 1, saveHistory: async (payload) => { saves.push(payload); return { ok: true }; } } });
      indicator.tick([NQ], at(16));
      await new Promise((resolve) => setTimeout(resolve, 20));
      indicator.tick([NQ], at(16) + 1000);
      expect(saves).toEqual([]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "history", coveredUntil: at(-90), coveredFrom: at(-150), columns: 2, dirty: false });
      release();
      await indicator.idle();
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ phase: "live", coveredUntil: at(15), coveredFrom: at(-150) });
      indicator.tick([NQ], at(16) + 2000);
      indicator.tick([NQ], at(16) + 3000);
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({ coveredUntil: at(15), coveredFrom: at(-150), shades: [expect.objectContaining({ status: "held" })] });
    });
  });

  describe("saving", () => {
    test("a failed background save keeps the state dirty, so the stop still writes it", async () => {
      const syncSaves = [];
      const { indicator } = harness({ overrides: { storeS: 1, saveHistory: async () => ({ ok: false, reason: "EPERM" }), saveHistorySync: (payload) => { syncSaves.push(payload); return { ok: true }; } } });
      indicator.tick([NQ], 50_000);
      indicator.tick([NQ], 51_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"].dirty).toBe(true);
      indicator.stop();
      expect(syncSaves).toHaveLength(1);
      expect(syncSaves[0].shades).toEqual([expect.objectContaining({ status: "held" })]);
    });

    test("a background save that stop() superseded is told so and never marks the state clean; one that lands after a later change leaves the state dirty", async () => {
      const taken = [];
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const { indicator, feed } = harness({ overrides: { storeS: 1, saveHistory: async (payload) => { taken.push(payload); await gate; return { ok: true }; }, saveHistorySync: () => ({ ok: true }) } });
      indicator.tick([NQ], 50_000);
      indicator.tick([NQ], 51_000);
      expect(taken).toHaveLength(1);
      expect(taken[0].superseded()).toBe(false);
      indicator.stop();
      expect(taken[0].superseded()).toBe(true);
      release();
      await gate;
      await Promise.resolve();

      const later = [];
      let open;
      const hold = new Promise((resolve) => { open = resolve; });
      const second = harness({ columns: scenario().slice(0, W + 9), overrides: { storeS: 1, saveHistory: async (payload) => { later.push(payload); await hold; return { ok: true }; } } });
      second.indicator.tick([NQ], 50_000);
      second.indicator.tick([NQ], 51_000);
      expect(later).toHaveLength(1);
      second.feed.columns = scenario();
      second.indicator.tick([NQ], 51_500);
      open();
      await hold;
      await Promise.resolve();
      await Promise.resolve();
      expect(second.indicator.stats()["FUTURE:/NQZ26:XCME"].dirty).toBe(true);
      second.indicator.tick([NQ], 53_000);
      expect(later).toHaveLength(2);
      expect(feed.columns.length).toBeGreaterThan(0);
    });
  });

  test("env options: on/off, histories, host fill, store dir, store seconds, age, fill span, reads in flight", () => {
    expect(exhaustionOptionsFromEnv({})).toEqual({});
    expect(exhaustionOptionsFromEnv({ L2_EXHAUSTION: "0", L2_EXHAUSTION_HISTORY: "0", L2_EXHAUSTION_HOST_FILL: "0", L2_EXHAUSTION_STORE_DIR: "/x", L2_EXHAUSTION_STORE_S: "10", L2_EXHAUSTION_MAX_AGE_S: "100", L2_EXHAUSTION_FILL_S: "50" })).toEqual({ enabled: false, histories: false, hostFill: false, storeDir: "/x", storeS: 10, maxAgeS: 100, fillS: 50 });
    expect(exhaustionOptionsFromEnv({ L2_EXHAUSTION: "1", L2_EXHAUSTION_HISTORY: "1", L2_EXHAUSTION_HOST_FILL: "1", L2_EXHAUSTION_STORE_S: "x" })).toEqual({ enabled: true, histories: true, hostFill: true });
    expect(exhaustionOptionsFromEnv({ L2_EXHAUSTION_FILL_S: "0" })).toEqual({});
    expect(exhaustionOptionsFromEnv({ L2_EXHAUSTION_FILL_CONCURRENCY: "4" })).toEqual({ fillConcurrency: 4 });
    expect(exhaustionOptionsFromEnv({ L2_EXHAUSTION_FILL_CONCURRENCY: "0" })).toEqual({});
    expect(exhaustionOptionsFromEnv({ L2_EXHAUSTION_FILL_CONCURRENCY: "1.5" })).toEqual({});
    expect(DEFAULT_STORE_S).toBe(300);
    expect(DEFAULT_MAX_AGE_S).toBe(7 * 86_400);
    expect(DEFAULT_FILL_S).toBe(86_400);
    expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null, fillS: 0 })).toThrow(/fillS/);
    expect(() => createExhaustionIndicator({ provider: "DXFEED", columnsAfter: () => [], geometryOf: () => null, reselect: 1 })).toThrow(/reselect/);
  });
});
