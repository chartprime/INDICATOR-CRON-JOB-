const fs = require("fs");
const os = require("os");
const path = require("path");
const { createIcebergIndicator, icebergOptionsFromEnv, DEFAULT_LIVE_REACH_MS, WATCH_GAP_MS, DEFAULT_HOST_FILL_DELAY_MS, DEFAULT_HOST_FILL_EVERY_MS } = require("../../../src/indicators/iceberg/iceberg-indicator");
const { icebergHistoryPath, saveIcebergHistory, saveIcebergHistoryAsync, loadIcebergHistory } = require("../../../src/indicators/iceberg/iceberg-store");
const { createLearnedCuts } = require("../../../src/indicators/iceberg/learned-cuts");
const { ICEBERG_HISTORY_VERSION } = require("../../../src/indicators/iceberg/iceberg-history");
const { icebergOrdersFrame, icebergOrdersFrames } = require("../../../src/server/iceberg-frames");
const { MAX_RETAINED_DEPTH_LEVELS } = require("../../../src/providers/binance/binance-book-assembler");

const NQ = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" };
const BTC = { symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const AAPL = { symbol: "AAPL", marketKind: "EQUITY" };
const NQ_WIRE = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };
const BTC_WIRE = { provider: "BINANCE", symbol: "BTCUSDT", marketKind: "PERPETUAL" };
const AAPL_WIRE = { provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" };
const FIXED = Object.freeze({ ready: true, visibleFloor: 0.35, minDurationMs: 5000, ratioCut: 2, strongRatio: 3 });
const fixedCuts = () => ({ current: () => FIXED, observeTouch() {}, observeEpisode() {} });
const ev = (action, size, extra = {}) => Object.freeze({ index: "5137554220647450000", eventFlags: 0, action, price: 31000, size, side: "BUY", source: "GLBX", ...extra });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function dxfeed(overrides = {}) {
  const published = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
  const indicator = createIcebergIndicator({ provider: "DXFEED", storeDir: dir, now: () => 50_000, log: { warn: () => {}, error: () => {} }, publish: (wire, pair, at, watched, liveSince) => published.push({ wire, pair, at, watched, liveSince }), ...overrides });
  return { indicator, published, dir };
}

function binance(overrides = {}) {
  const published = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
  const indicator = createIcebergIndicator({ provider: "BINANCE", storeDir: dir, histories: false, cutsFactory: fixedCuts, now: () => 50_000, log: { warn: () => {}, error: () => {} }, publish: (wire, pair, at, watched, liveSince) => published.push({ wire, pair, at, watched, liveSince }), ...overrides });
  return { indicator, published, dir };
}

function defend(indicator, { price = 81000, shown = 1, perHit = 0.3, hits = 8, start = 10_000 } = {}) {
  indicator.onDepth(BTC, [["bid", price, shown]], start - 100);
  for (let i = 0; i < hits; i += 1) {
    indicator.onTrade(BTC, { price, size: perHit, aggressor: "sell", ts: start + i * 1000 });
    indicator.onDepth(BTC, [["bid", price, shown]], start + i * 1000 + 50);
  }
}

describe("indicators/iceberg/iceberg-indicator", () => {
  describe("futures (native)", () => {
    test("a refilled order is published while active and settles into the history when filled", () => {
      const { indicator, published } = dxfeed({ histories: false });
      expect(indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3)], { receivedAt: 1000 })).toEqual([]);
      const active = indicator.onNativeEvents(NQ, [ev("PARTIAL", 10)], { receivedAt: 1001 });
      expect(active).toEqual([expect.objectContaining({ kind: "native", status: "active", tranches: 2, executed: 7, markedAt: 1001 })]);
      expect(published).toEqual([{ wire: active, pair: NQ, at: 1001, watched: [], liveSince: 0 }]);
      const filled = indicator.onNativeEvents(NQ, [ev("EXECUTE", null)], { receivedAt: 1002 });
      expect(filled[0]).toMatchObject({ status: "filled", executed: 17 });
      expect(indicator.snapshot(NQ, 2000)).toEqual({ ts: 2000, icebergs: [filled[0]], watched: [], liveSince: 0 });
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ active: 0, settled: 1, dirty: true });
    });

    test("the snapshot carries settled history and live icebergs together, in mark order", () => {
      const { indicator } = dxfeed({ histories: false });
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("PARTIAL", 10), ev("EXECUTE", null)], { receivedAt: 1000 });
      indicator.onNativeEvents(NQ, [ev("NEW", 5, { index: "2" }), ev("PARTIAL", 1, { index: "2" }), ev("PARTIAL", 5, { index: "2" })], { receivedAt: 3000 });
      const snap = indicator.snapshot(NQ, 4000);
      expect(snap.icebergs.map((entry) => [entry.status, entry.markedAt])).toEqual([["filled", 1000], ["active", 3000]]);
      expect(Object.isFrozen(snap.icebergs)).toBe(true);
    });

    test("a snapshot replace resets the tracker: open icebergs end as interrupted, then the new book starts clean", () => {
      const { indicator, published } = dxfeed({ histories: false });
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("PARTIAL", 10)], { receivedAt: 1000 });
      const out = indicator.onNativeEvents(NQ, [ev("NEW", 10)], { snapshot: true, receivedAt: 2000 });
      expect(out).toEqual([expect.objectContaining({ status: "interrupted", updatedAt: 2000 })]);
      expect(published.at(-1).wire[0].status).toBe("interrupted");
      expect(indicator.onNativeEvents(NQ, [ev("PARTIAL", 10)], { receivedAt: 2001 })).toEqual([]);
      expect(indicator.onNativeUnavailable(NQ, 2002)).toEqual([]);
    });

    test("an update dated before its own mark, as after a clock step, is refused and counted, never breaking the history, an increment or the page", () => {
      const { indicator, published } = dxfeed({ histories: false });
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3)], { receivedAt: 1000 });
      indicator.onNativeEvents(NQ, [ev("PARTIAL", 10)], { receivedAt: 1001 });
      expect(indicator.onNativeEvents(NQ, [ev("PARTIAL", 4)], { receivedAt: 999 })).toEqual([]);
      const snap = indicator.snapshot(NQ, 2000);
      expect(snap.icebergs).toEqual([]);
      expect(() => icebergOrdersFrame(NQ_WIRE, { ts: snap.ts, seq: 0, reset: true, liveSince: 50_000, icebergs: snap.icebergs })).not.toThrow();
      expect(indicator.onNativeEvents(NQ, [ev("EXECUTE", null)], { receivedAt: 998 })).toEqual([]);
      expect(published).toHaveLength(1);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ settled: 0, refused: 2 });
    });

    test("one batch with two updates dated before their marks refuses both, counts both and says so once, and the page says what it left out", () => {
      const warnings = [];
      const { indicator } = dxfeed({ histories: false, log: { warn: (message) => warnings.push(message), error: () => {} } });
      const other = { index: "2", price: 31001 };
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("NEW", 10, other), ev("PARTIAL", 3, other)], { receivedAt: 1000 });
      expect(indicator.onNativeEvents(NQ, [ev("PARTIAL", 10), ev("PARTIAL", 10, other)], { receivedAt: 1001 })).toHaveLength(2);
      expect(indicator.onNativeEvents(NQ, [ev("PARTIAL", 4), ev("PARTIAL", 4, other)], { receivedAt: 999 })).toEqual([]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ refused: 2 });
      expect(warnings).toEqual(["iceberg indicator: FUTURE:/NQZ26:XCME refused 2 invalid iceberg update(s)"]);
      expect(indicator.snapshot(NQ, 2000).icebergs).toEqual([]);
      expect(warnings.slice(1)).toEqual(["iceberg indicator: FUTURE:/NQZ26:XCME snapshot left out 2 invalid iceberg(s)"]);
    });

    test("two changes of one iceberg in one batch go out once, as its latest state, so the increment is accepted", () => {
      const { indicator, published } = dxfeed({ histories: false });
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3)], { receivedAt: 1000 });
      indicator.onNativeEvents(NQ, [ev("PARTIAL", 10)], { receivedAt: 1001 });
      const batch = indicator.onNativeEvents(NQ, [ev("PARTIAL", 3), ev("EXECUTE", null)], { receivedAt: 1002 });
      expect(batch).toEqual([expect.objectContaining({ status: "filled", executed: 17 })]);
      expect(() => icebergOrdersFrame(NQ_WIRE, { ts: 1002, seq: 2, reset: false, liveSince: 50_000, icebergs: batch })).not.toThrow();
      expect(published.map(({ wire }) => wire.length)).toEqual([1, 1]);
      expect(indicator.snapshot(NQ, 2000).icebergs).toEqual(batch);
    });

    test("the Binance methods refuse a dxFeed indicator and the other way round", () => {
      const { indicator } = dxfeed({ histories: false });
      expect(() => indicator.onTrade(NQ, { price: 1, size: 1, aggressor: "buy", ts: 1 })).toThrow(/BINANCE/);
      expect(() => indicator.onDepth(NQ, [], 1)).toThrow(/BINANCE/);
      const crypto = binance().indicator;
      expect(() => crypto.onNativeEvents(BTC, [], {})).toThrow(/DXFEED/);
      expect(() => crypto.onNativeUnavailable(BTC, 1)).toThrow(/DXFEED/);
      expect(() => indicator.onDepthUnavailable(NQ, 1)).toThrow(/BINANCE/);
    });
  });

  describe("crypto (probable)", () => {
    test("a defended level is published once it passes the cuts, grows, and ends on the tick that sweeps it", () => {
      const { indicator, published } = binance();
      defend(indicator);
      expect(published.length).toBeGreaterThan(0);
      expect(published[0].wire[0]).toMatchObject({ kind: "probable", confidence: "probable", origin: "runtime", status: "active", side: "bid", price: 81000 });
      expect(published[0].pair).toEqual(BTC);
      const ended = indicator.tick(60_000);
      expect(ended).toEqual([expect.objectContaining({ status: "ended" })]);
      expect(indicator.snapshot(BTC, 31_000).icebergs).toEqual([expect.objectContaining({ status: "ended" })]);
      expect(indicator.stats()["PERPETUAL:BTCUSDT"]).toMatchObject({ active: 0, settled: 1, openEpisodes: 0, trackedLevels: 1 });
    });

    test("a pair's tracker holds no more price levels than the runtime's own book keeps for that market, both sides together", () => {
      const { indicator } = binance();
      const perp = 2 * MAX_RETAINED_DEPTH_LEVELS.PERPETUAL;
      const entries = [];
      for (let k = 0; k < perp + 500; k += 1) entries.push([k % 2 === 0 ? "bid" : "ask", 50_000 + k, 1]);
      indicator.onDepth(BTC, entries, 1_000);
      expect(indicator.stats()["PERPETUAL:BTCUSDT"].trackedLevels).toBeLessThanOrEqual(perp);
      expect(indicator.stats()["PERPETUAL:BTCUSDT"].trackedLevels).toBeGreaterThan(MAX_RETAINED_DEPTH_LEVELS.PERPETUAL);
      indicator.onDepth({ symbol: "BTCUSDT", marketKind: "SPOT" }, entries, 1_000);
      expect(indicator.stats()["SPOT:BTCUSDT"].trackedLevels).toBe(perp + 500);
      expect(2 * MAX_RETAINED_DEPTH_LEVELS.SPOT).toBeGreaterThan(perp + 500);
    });

    test("trades and depth that arrive out of exchange-time order still give increments and a page the wire accepts", () => {
      const loose = Object.freeze({ ready: true, visibleFloor: 2, minDurationMs: 0, ratioCut: 1, strongRatio: 1.5 });
      const { indicator, published } = binance({ cutsFactory: () => ({ current: () => loose, observeTouch() {}, observeEpisode() {} }) });
      indicator.onDepth(BTC, [["ask", 100, 1]], 900);
      indicator.onTrade(BTC, { price: 100, size: 1.5, aggressor: "buy", ts: 1000 });
      indicator.onTrade(BTC, { price: 100, size: 1.5, aggressor: "buy", ts: 2000 });
      indicator.onDepth(BTC, [["ask", 100, 2.5]], 2200);
      indicator.onTrade(BTC, { price: 100, size: 0.5, aggressor: "buy", ts: 2100 });
      expect(published.map(({ wire }) => wire.map((entry) => [entry.markedAt, entry.updatedAt]))).toEqual([[[2200, 2200]], [[2200, 2200]]]);
      published.forEach(({ wire, at }, seq) => expect(() => icebergOrdersFrame(BTC_WIRE, { ts: at, seq, reset: false, liveSince: 50_000, icebergs: wire })).not.toThrow());
      const snap = indicator.snapshot(BTC, 3000);
      expect(snap.icebergs).toEqual([expect.objectContaining({ status: "active", markedAt: 2200, updatedAt: 2200 })]);
      expect(() => icebergOrdersFrame(BTC_WIRE, { ts: snap.ts, seq: 0, reset: true, liveSince: 50_000, icebergs: snap.icebergs })).not.toThrow();
      expect(indicator.stats()["PERPETUAL:BTCUSDT"]).toMatchObject({ refused: 0 });
    });

    test("depth entries and trades that do not qualify publish nothing", () => {
      const { indicator, published } = binance();
      defend(indicator, { perHit: 0.1 });
      indicator.tick(60_000);
      expect(published).toEqual([]);
    });

    test("episodes end on the pair's own exchange clock: a laptop clock 1.5 s ahead of Binance never cuts a level hit every second, and the quiet level ends two seconds after its last hit in exchange time", () => {
      const clock = { at: 0 };
      const skew = 1500;
      const { indicator, published } = binance({ now: () => clock.at });
      clock.at = 9_900 + skew;
      indicator.onDepth(BTC, [["bid", 81000, 1]], 9_900);
      for (let i = 0; i < 10; i += 1) {
        const ts = 10_000 + i * 1000;
        clock.at = ts + skew;
        indicator.onTrade(BTC, { price: 81000, size: 0.3, aggressor: "sell", ts });
        indicator.onDepth(BTC, [["bid", 81000, 1]], ts + 50);
        clock.at += 900;
        expect(indicator.tick()).toEqual([]);
      }
      clock.at = 19_000 + skew + 2_100;
      const ended = indicator.tick();
      expect(ended).toEqual([expect.objectContaining({ status: "ended", markedAt: 16_000, updatedAt: 21_150 })]);
      expect(ended[0].executed).toBeCloseTo(3, 6);
      expect(published.flatMap(({ wire }) => wire).filter((entry) => entry.status === "ended")).toHaveLength(1);
    });

    test("a wall clock that steps back never sweeps before the pair's latest exchange event", () => {
      const loose = Object.freeze({ ready: true, visibleFloor: 0, minDurationMs: 0, ratioCut: 1, strongRatio: 1.5 });
      const clock = { at: 50_000 };
      const { indicator } = binance({ now: () => clock.at, cutsFactory: () => ({ current: () => loose, observeTouch() {}, observeEpisode() {} }) });
      indicator.onDepth(BTC, [["bid", 100, 1]], 9_900);
      expect(indicator.onTrade(BTC, { price: 100, size: 2, aggressor: "sell", ts: 10_000 })).toEqual([expect.objectContaining({ status: "active" })]);
      indicator.onDepth(BTC, [["ask", 200, 1]], 13_000);
      clock.at = 49_000;
      expect(indicator.tick()).toEqual([expect.objectContaining({ status: "ended", side: "bid", price: 100, updatedAt: 13_000 })]);
    });
  });

  describe("watched spans", () => {
    test("a Binance book that loses sync ends the pair's marked icebergs, closes the watched run at the last event before it so the host can answer the gap, takes no trade until depth is back, and acts once per outage", () => {
      const clock = { at: 50_000 };
      const { indicator, published } = binance({ now: () => clock.at });
      defend(indicator);
      clock.at = 51_000; indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[9_900, 17_050]]);
      const before = published.length;
      const lost = indicator.onDepthUnavailable(BTC, 18_000);
      expect(lost).toEqual([expect.objectContaining({ kind: "probable", status: "ended", side: "bid", price: 81000, updatedAt: 18_000 })]);
      expect(published.slice(before)).toEqual([expect.objectContaining({ wire: lost, pair: BTC, at: 18_000 })]);
      expect(indicator.onDepthUnavailable(BTC, 18_500)).toEqual([]);
      expect(indicator.onTrade(BTC, { price: 81000, size: 0.3, aggressor: "sell", ts: 19_000 })).toEqual([]);
      clock.at = 52_000; indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[9_900, 17_050]]);
      expect(indicator.stats()["PERPETUAL:BTCUSDT"]).toMatchObject({ active: 0, settled: 1, openEpisodes: 0, trackedLevels: 0 });
      indicator.onDepth(BTC, [["bid", 81000, 1]], 25_000);
      indicator.onTrade(BTC, { price: 81000, size: 0.3, aggressor: "sell", ts: 26_000 });
      clock.at = 53_000; indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[9_900, 17_050], [25_000, 26_000]]);
      expect(indicator.onDepthUnavailable(BTC)).toEqual([]);
      clock.at = 54_000; indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[9_900, 17_050], [25_000, 26_000]]);
    });

    test("a pair is watched while its feed delivers: the span grows on every tick in the events' own clock, closes after the watch gap, and a new run starts at the next event", () => {
      expect(WATCH_GAP_MS).toBe(30_000);
      const clock = { at: 50_000 };
      const { indicator, published } = binance({ now: () => clock.at });
      const hit = (ts) => indicator.onTrade(BTC, { price: 100, size: 1, aggressor: "buy", ts });
      hit(40_000);
      expect(indicator.snapshot(BTC).watched).toEqual([]);
      clock.at = 51_000; hit(41_000); indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[40_000, 41_000]]);
      clock.at = 52_000; indicator.onDepth(BTC, [["bid", 100, 1]], 42_500); indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[40_000, 42_500]]);
      clock.at = 52_000 + WATCH_GAP_MS; indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[40_000, 42_500]]);
      clock.at += 1; indicator.tick();
      clock.at += 1000; hit(80_000); indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[40_000, 42_500]]);
      clock.at += 1000; hit(81_000); indicator.tick();
      expect(indicator.snapshot(BTC).watched).toEqual([[40_000, 42_500], [80_000, 81_000]]);
      expect(published).toEqual([]);
    });

    test("a dxFeed pair is watched on the receive clock; the saved span ends at the earliest open iceberg's mark, comes back on restart, and a malformed saved list is refused with a warning", () => {
      const clock = { at: 1000 };
      const { indicator, dir, published } = dxfeed({ now: () => clock.at });
      indicator.onNativeEvents(NQ, [ev("NEW", 10)], { receivedAt: 1000 });
      clock.at = 2000; indicator.onNativeEvents(NQ, [ev("PARTIAL", 3)], { receivedAt: 2000 }); indicator.tick();
      clock.at = 3000; indicator.onNativeEvents(NQ, [ev("PARTIAL", 10)], { receivedAt: 3000 }); indicator.tick();
      clock.at = 4000; indicator.onNativeEvents(NQ, [ev("NEW", 5, { index: "2" })], { receivedAt: 4000 }); indicator.tick();
      expect(indicator.snapshot(NQ).watched).toEqual([[1000, 4000]]);
      expect(published.map((entry) => entry.watched)).toEqual([[[1000, 2000]]]);
      indicator.stop();
      expect(loadIcebergHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME" }).coverage).toEqual([[1000, 3000]]);
      const again = createIcebergIndicator({ provider: "DXFEED", storeDir: dir, now: () => 9000, log: { warn: () => {} } });
      expect(again.snapshot(NQ).watched).toEqual([[1000, 3000]]);
      again.stop();
      const warnings = [];
      saveIcebergHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", savedAt: 9500, history: { version: ICEBERG_HISTORY_VERSION, icebergs: [] }, coverage: [[2, 1]] });
      const odd = createIcebergIndicator({ provider: "DXFEED", storeDir: dir, now: () => 9900, log: { warn: (message) => warnings.push(message) } });
      expect(odd.snapshot(NQ).watched).toEqual([]);
      expect(warnings).toEqual(["iceberg indicator: FUTURE:/NQZ26:XCME saved coverage rejected; starting unwatched"]);
    });
  });

  describe("host fill", () => {
    const brought = { id: "h", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31000, display: 10, tranches: 2, executed: 20, startedAt: 30_000, markedAt: 31_000, updatedAt: 32_000, status: "filled" };

    test("after the start delay, and then every period, the host is asked for the spans the runtime did not watch; what it brings is published as an increment with the grown coverage; nothing is asked while histories are off", async () => {
      const calls = [];
      const hostFill = { fill: async (target) => { calls.push([target.provider, target.symbol, target.marketKind]); target.history.record(brought); target.history.watch(30_000, 40_000); return { gaps: 1, records: 1, watched: [[30_000, 40_000]], reasons: [], icebergs: [brought] }; }, stats: () => ({}) };
      const clock = { at: 50_000 };
      const { indicator, published } = dxfeed({ now: () => clock.at, hostFill, hostFillDelayMs: 10_000, hostFillEveryMs: 60_000 });
      indicator.onNativeEvents(NQ, [ev("NEW", 10)], { receivedAt: 50_000 });
      indicator.tick();
      await flush();
      expect(calls).toEqual([]);
      clock.at = 60_000;
      indicator.tick();
      await flush();
      expect(calls).toEqual([["dxfeed", "/NQZ26:XCME", "FUTURE"]]);
      expect(published).toEqual([{ wire: [brought], pair: NQ, at: 60_000, watched: [[30_000, 40_000]], liveSince: 0 }]);
      expect(indicator.snapshot(NQ, 61_000).icebergs).toEqual([brought]);
      clock.at = 100_000;
      indicator.tick();
      await flush();
      expect(calls).toHaveLength(1);
      clock.at = 121_000;
      indicator.tick();
      await flush();
      expect(calls).toHaveLength(2);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ hostFills: 2 });
      const off = dxfeed({ histories: false, now: () => clock.at, hostFill, hostFillDelayMs: 0 });
      off.indicator.onNativeEvents(NQ, [ev("NEW", 10)], { receivedAt: clock.at });
      off.indicator.tick();
      await flush();
      expect(calls).toHaveLength(2);
    });

    test("a fill that fails is reported and tried again at the next period, and a fill that brings nothing publishes nothing", async () => {
      const warnings = [];
      let calls = 0;
      const hostFill = { fill: async () => { calls += 1; if (calls === 1) throw new Error("gateway down"); return { gaps: 1, records: 0, watched: [], reasons: ["NOT_BUILT"], icebergs: [] }; } };
      const clock = { at: 50_000 };
      const { indicator, published } = dxfeed({ now: () => clock.at, hostFill, hostFillDelayMs: 0, hostFillEveryMs: 1000, log: { warn: (message) => warnings.push(message), error: () => {} } });
      indicator.onNativeEvents(NQ, [ev("NEW", 10)], { receivedAt: 50_000 });
      indicator.tick();
      await flush();
      expect(warnings).toEqual(["iceberg indicator: FUTURE:/NQZ26:XCME host fill failed"]);
      clock.at = 51_000;
      indicator.tick();
      await flush();
      expect(calls).toBe(2);
      expect(published).toEqual([]);
    });

    test("the fill says why it left gaps: once per pair when the set of reasons changes, with the counts, once more when every gap is answered, and the fill's counters show in stats", async () => {
      const warnings = [];
      const infos = [];
      const outcomes = [
        { gaps: 3, records: 0, watched: [], reasons: ["NO_HISTORY", "NOT_BUILT", "NOT_BUILT"], icebergs: [] },
        { gaps: 2, records: 0, watched: [], reasons: ["NOT_BUILT", "NO_HISTORY"], icebergs: [] },
        { gaps: 2, records: 0, watched: [], reasons: ["NOT_BUILT"], icebergs: [] },
        { gaps: 1, records: 0, watched: [], reasons: [], icebergs: [] },
        { gaps: 1, records: 0, watched: [], reasons: [], icebergs: [] },
      ];
      const counters = { fills: 5, gaps: 9, unavailable: 6, failed: 0 };
      const hostFill = { fill: async () => outcomes.shift(), stats: () => counters };
      const clock = { at: 50_000 };
      const { indicator } = dxfeed({ now: () => clock.at, hostFill, hostFillDelayMs: 0, hostFillEveryMs: 1000, log: { warn: (message) => warnings.push(message), info: (message) => infos.push(message), error: () => {} } });
      indicator.onNativeEvents(NQ, [ev("NEW", 10)], { receivedAt: 50_000 });
      indicator.tick();
      await flush();
      expect(warnings).toEqual(["iceberg indicator: FUTURE:/NQZ26:XCME host fill left 3 of 3 gap(s) unfilled: NOT_BUILT 2, NO_HISTORY 1"]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"].hostReasons).toEqual({ NOT_BUILT: 2, NO_HISTORY: 1 });
      for (let i = 1; i < 5; i += 1) {
        clock.at += 1000;
        indicator.tick();
        await flush();
      }
      expect(outcomes).toEqual([]);
      expect(warnings).toEqual([
        "iceberg indicator: FUTURE:/NQZ26:XCME host fill left 3 of 3 gap(s) unfilled: NOT_BUILT 2, NO_HISTORY 1",
        "iceberg indicator: FUTURE:/NQZ26:XCME host fill left 1 of 2 gap(s) unfilled: NOT_BUILT 1",
      ]);
      expect(infos).toEqual(["iceberg indicator: FUTURE:/NQZ26:XCME host fill answered every gap"]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ hostFills: 5, hostReasons: {} });
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"].hostReasons).toEqual({});
      expect(indicator.stats().hostFill).toEqual(counters);
    });

    test("with a host in the options the fill reads the gateway's iceberg-history route through the remote reader, which is closed with the indicator", async () => {
      const reads = [];
      const createRemoteReader = (options) => { reads.push(options.baseUrl, options.token); return { readIcebergHistory: async (symbol, marketKind, read, context) => { reads.push([context.provider, symbol, marketKind, read.fromTs, read.toTs]); return { available: false, reason: "NOT_BUILT" }; }, close: () => reads.push("closed") }; };
      const clock = { at: 10_000_000 };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
      const { indicator } = binance({ histories: true, storeDir: dir, now: () => clock.at, host: { baseUrl: "http://gateway/live-storage", token: "tok" }, hostFillDelayMs: 0, createRemoteReader });
      indicator.onDepth(BTC, [["bid", 100, 1]], 10_000_000);
      indicator.tick();
      await flush();
      expect(reads).toEqual(["http://gateway/live-storage", "tok", ["binance", "BTCUSDT", "PERPETUAL", 0, 9_400_000]]);
      indicator.stop();
      expect(reads[3]).toBe("closed");
    });
  });

  describe("store", () => {
    test("stop closes the watched run, writes the dirty history and a new indicator restores it into its snapshot with the span", () => {
      const { indicator, dir } = dxfeed();
      indicator.onNativeEvents(NQ, [ev("NEW", 10)], { receivedAt: 1000 });
      indicator.onNativeEvents(NQ, [ev("PARTIAL", 3), ev("PARTIAL", 10), ev("EXECUTE", null)], { receivedAt: 2000 });
      indicator.stop();
      expect(fs.existsSync(icebergHistoryPath(dir, "FUTURE:/NQZ26:XCME"))).toBe(true);
      const again = createIcebergIndicator({ provider: "DXFEED", storeDir: dir, now: () => 60_000, log: { warn: () => {} } });
      expect(again.snapshot(NQ, 60_000).icebergs).toEqual([expect.objectContaining({ status: "filled", executed: 17, markedAt: 2000 })]);
      expect(again.snapshot(NQ, 60_000).watched).toEqual([[1000, 2000]]);
      expect(again.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ settled: 1, dirty: false });
      again.stop();
    });

    test("a restored history applies the cuts' own ratio floor: nothing is dropped at the default of one, a raised floor drops what took less than it and says how many", () => {
      const warnings = [];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
      const thin = { id: "thin", kind: "probable", confidence: "probable", origin: "runtime", side: "bid", price: 81000, display: 5, tranches: 1, executed: 9.9, startedAt: 1000, markedAt: 2000, updatedAt: 3000, status: "ended" };
      const fat = { ...thin, id: "fat", executed: 10, markedAt: 2500 };
      saveIcebergHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", savedAt: 4000, history: { version: ICEBERG_HISTORY_VERSION, icebergs: [thin, fat] }, coverage: [[1000, 4000]] });
      const { indicator } = binance({ histories: true, storeDir: dir, log: { warn: (message) => warnings.push(message), error: () => {} } });
      expect(indicator.snapshot(BTC, 5000).icebergs.map((entry) => entry.id)).toEqual(["thin", "fat"]);
      expect(warnings).toEqual([]);
      const raisedWarnings = [];
      const raised = binance({ histories: true, storeDir: dir, cuts: { minRatio: 2 }, log: { warn: (message) => raisedWarnings.push(message), error: () => {} } });
      expect(raised.indicator.snapshot(BTC, 5000).icebergs.map((entry) => entry.id)).toEqual(["fat"]);
      expect(raisedWarnings).toEqual(["iceberg indicator: PERPETUAL:BTCUSDT dropped 1 saved probable iceberg(s) under the ratio floor"]);
      expect(binance({ histories: true, storeDir: dir, cuts: { minRatio: 3 } }).indicator.snapshot(BTC, 5000).icebergs).toEqual([]);
    });

    test("a restart brings the learned cuts back: the restored crypto indicator is ready at once with the cut it had learned, and keeps saving what it learns", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
      const learned = createLearnedCuts({ minSamples: 1, minRatioSamples: 1 });
      learned.observeTouch(1);
      learned.observeEpisode({ ratio: 5, durationMs: 100, solid: true });
      saveIcebergHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", savedAt: 4000, history: { version: ICEBERG_HISTORY_VERSION, icebergs: [] }, cuts: learned.toJSON() });
      const seen = [];
      const { indicator } = binance({ histories: true, storeDir: dir, cuts: { minSamples: 1, minRatioSamples: 1 }, cutsFactory: (options) => { const c = createLearnedCuts(options); seen.push(c); return c; } });
      indicator.snapshot(BTC, 5000);
      expect(seen).toHaveLength(1);
      expect(seen[0].current()).toMatchObject({ ready: true, ratioCut: 5 });
      seen[0].observeEpisode({ ratio: 7, durationMs: 100, solid: true });
      indicator.stop();
      expect(loadIcebergHistory({ dir, pairKey: "PERPETUAL:BTCUSDT" }).cuts.ratios).toEqual([5, 7]);
      const warnings = [];
      saveIcebergHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", savedAt: 6000, history: { version: ICEBERG_HISTORY_VERSION, icebergs: [] }, cuts: { version: 9 } });
      const odd = binance({ histories: true, storeDir: dir, cuts: { minSamples: 1, minRatioSamples: 1 }, cutsFactory: (options) => { const c = createLearnedCuts(options); seen.push(c); return c; }, log: { warn: (message) => warnings.push(message), error: () => {} } });
      odd.indicator.snapshot(BTC, 7000);
      expect(seen[1].current().ready).toBe(false);
      expect(warnings).toEqual(["iceberg indicator: PERPETUAL:BTCUSDT saved cuts rejected; learning afresh"]);
    });

    test("a rejected file is reported and the pair starts empty", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
      fs.writeFileSync(icebergHistoryPath(dir, "FUTURE:/NQZ26:XCME"), "{ not json");
      const warnings = [];
      const indicator = createIcebergIndicator({ provider: "DXFEED", storeDir: dir, log: { warn: (message) => warnings.push(message) } });
      expect(indicator.snapshot(NQ, 1).icebergs).toEqual([]);
      expect(warnings[0]).toContain("MALFORMED");
    });

    test("a saved history that does not load brings back neither its icebergs nor its spans, so the host is asked for the whole lookback, and its learned cuts still come back", async () => {
      const DAY = 86_400_000;
      const NOW = 10 * DAY;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
      const learned = createLearnedCuts({ minSamples: 1, minRatioSamples: 1 });
      learned.observeTouch(1);
      learned.observeEpisode({ ratio: 5, durationMs: 100, solid: true });
      const twice = { id: "twice", kind: "probable", confidence: "probable", origin: "runtime", side: "bid", price: 81000, display: 1, tranches: 1, executed: 3, startedAt: NOW - 2 * DAY, markedAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY + 1000, status: "ended" };
      saveIcebergHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", savedAt: NOW - DAY, history: { version: ICEBERG_HISTORY_VERSION, icebergs: [twice, twice] }, cuts: learned.toJSON(), coverage: [[NOW - 3 * DAY, NOW - DAY]] });
      const warnings = [];
      const asked = [];
      const seen = [];
      const hostFill = { fill: async (target) => { asked.push(target.history.uncovered(NOW - 5 * DAY, NOW - 600_000)); return { gaps: 0, records: 0, watched: [], reasons: [], icebergs: [] }; }, stats: () => ({}) };
      const { indicator } = binance({ histories: true, storeDir: dir, now: () => NOW, hostFill, hostFillDelayMs: 0, cuts: { minSamples: 1, minRatioSamples: 1 }, cutsFactory: (options) => { const c = createLearnedCuts(options); seen.push(c); return c; }, log: { warn: (message) => warnings.push(message), error: () => {} } });
      const page = indicator.snapshot(BTC);
      expect(page.icebergs).toEqual([]);
      expect(page.watched).toEqual([]);
      expect(warnings).toEqual(["iceberg indicator: PERPETUAL:BTCUSDT history did not load; starting empty"]);
      expect(seen[0].current()).toMatchObject({ ready: true, ratioCut: 5 });
      indicator.tick();
      await flush();
      expect(asked).toEqual([[[NOW - 5 * DAY, NOW - 600_000]]]);
    });

    test("a weak mark survives a restart: a defended level marked, then outgrown by a join, ends weak and comes back weak from the store at the default floor", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
      const { indicator } = binance({ histories: true, storeDir: dir });
      defend(indicator);
      indicator.onDepth(BTC, [["bid", 81000, 5]], 17_100);
      const ended = indicator.tick(60_000);
      expect(ended).toEqual([expect.objectContaining({ status: "ended", confidence: "weak", display: 5 })]);
      expect(ended[0].executed).toBeLessThan(ended[0].display);
      indicator.stop();
      const again = binance({ histories: true, storeDir: dir, now: () => 70_000 });
      expect(again.indicator.snapshot(BTC).icebergs).toEqual(ended);
    });

    test("a background save still writing when stop saves never lands over stop's save, so the file keeps what settled after the background save began", async () => {
      const writers = [];
      const warnings = [];
      const { indicator, dir } = dxfeed({ storeS: 10, log: { warn: (message) => warnings.push(message), error: () => {} }, saveHistory: (request) => { const writer = saveIcebergHistoryAsync(request); writers.push(writer); return writer; } });
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("PARTIAL", 10), ev("EXECUTE", null)], { receivedAt: 1000 });
      indicator.tick(60_000);
      expect(writers).toHaveLength(1);
      const second = { index: "2" };
      indicator.onNativeEvents(NQ, [ev("NEW", 10, second), ev("PARTIAL", 3, second), ev("PARTIAL", 10, second), ev("EXECUTE", null, second)], { receivedAt: 5000 });
      indicator.stop();
      const outcome = await writers[0];
      expect(loadIcebergHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME" }).history.icebergs.map((entry) => entry.updatedAt)).toEqual([1000, 5000]);
      expect(outcome).toEqual({ ok: false, reason: "SUPERSEDED" });
      expect(fs.readdirSync(dir)).toEqual(["FUTURE_NQZ26_XCME.icebergs.json"]);
      expect(warnings).toEqual([]);
    });

    test("a background save that settles after more changed leaves the history dirty, so stop still writes what that save never carried", async () => {
      const settles = [];
      const finals = [];
      const { indicator } = dxfeed({ storeS: 10, saveHistory: () => new Promise((resolve) => settles.push(resolve)), saveHistorySync: (request) => { finals.push(request); return { ok: true }; } });
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("PARTIAL", 10), ev("EXECUTE", null)], { receivedAt: 1000 });
      indicator.tick(60_000);
      expect(settles).toHaveLength(1);
      const second = { index: "2" };
      indicator.onNativeEvents(NQ, [ev("NEW", 10, second), ev("PARTIAL", 3, second), ev("PARTIAL", 10, second), ev("EXECUTE", null, second)], { receivedAt: 5000 });
      settles[0]({ ok: true, bytes: 1 });
      await flush();
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"].dirty).toBe(true);
      indicator.stop();
      expect(finals.map((request) => request.history.icebergs.map((entry) => entry.updatedAt))).toEqual([[1000, 5000]]);
    });

    test("the tick saves in the background once the store interval has passed, then marks the history saved", async () => {
      const saves = [];
      const { indicator } = dxfeed({ storeS: 10, saveHistory: async (request) => { saves.push(request); return { ok: true, bytes: 1 }; } });
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("PARTIAL", 10), ev("EXECUTE", null)], { receivedAt: 1000 });
      indicator.tick(55_000);
      expect(saves).toEqual([]);
      indicator.tick(60_000);
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({ pairKey: "FUTURE:/NQZ26:XCME", savedAt: 60_000 });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"].dirty).toBe(false);
      indicator.tick(70_000);
      expect(saves).toHaveLength(1);
    });

    test("an over-budget save trims the oldest and reports it", async () => {
      const warnings = [];
      const { indicator } = dxfeed({ storeS: 10, maxBytes: 4096, log: { warn: (message) => warnings.push(message) }, saveHistory: async () => ({ ok: false, reason: "OVER_BUDGET", bytes: 9999 }) });
      for (let i = 0; i < 20; i += 1) {
        const index = String(100 + i);
        indicator.onNativeEvents(NQ, [ev("NEW", 10, { index }), ev("PARTIAL", 3, { index }), ev("PARTIAL", 10, { index }), ev("EXECUTE", null, { index })], { receivedAt: 1000 + i });
      }
      indicator.tick(60_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(warnings.some((message) => message.includes("over budget"))).toBe(true);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"].settled).toBeLessThan(20);
    });

    test("the tick prunes settled icebergs older than the age window", () => {
      const { indicator } = dxfeed({ histories: false, maxAgeS: 10 });
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("PARTIAL", 10), ev("EXECUTE", null)], { receivedAt: 1000 });
      expect(indicator.snapshot(NQ, 5000).icebergs).toHaveLength(1);
      indicator.tick(120_000);
      expect(indicator.snapshot(NQ, 120_000).icebergs).toHaveLength(0);
    });
  });

  describe("wire bounds", () => {
    test("each pair's icebergs are held to its own wire size ceiling, the one icebergOrdersFrame applies: an oversize live update is refused and counted and left off the page, a saved history holding one never reaches a page, and equities keep their larger ceiling", () => {
      const huge = [ev("NEW", 20_000_000), ev("PARTIAL", 10_000_000), ev("PARTIAL", 20_000_000)];
      const { indicator, published } = dxfeed({ histories: false });
      expect(indicator.onNativeEvents(NQ, huge, { receivedAt: 1000 })).toEqual([]);
      expect(published).toEqual([]);
      expect(indicator.stats()["FUTURE:/NQZ26:XCME"]).toMatchObject({ refused: 1 });
      const page = indicator.snapshot(NQ, 2000);
      expect(page.icebergs).toEqual([]);
      expect(() => icebergOrdersFrame(NQ_WIRE, { ts: page.ts, seq: 0, reset: true, liveSince: page.liveSince, icebergs: page.icebergs })).not.toThrow();
      const equity = dxfeed({ histories: false });
      const kept = equity.indicator.onNativeEvents(AAPL, huge, { receivedAt: 1000 });
      expect(kept).toEqual([expect.objectContaining({ status: "active", display: 20_000_000, executed: 10_000_000 })]);
      expect(() => icebergOrdersFrame(AAPL_WIRE, { ts: 1000, seq: 1, reset: false, liveSince: 0, icebergs: kept })).not.toThrow();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
      const oversize = { id: "big", kind: "probable", confidence: "probable", origin: "runtime", side: "bid", price: 81000, display: 1, tranches: 1, executed: 20_000_000, startedAt: 1000, markedAt: 2000, updatedAt: 3000, status: "ended" };
      saveIcebergHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", savedAt: 4000, history: { version: ICEBERG_HISTORY_VERSION, icebergs: [oversize] }, coverage: [[1000, 4000]] });
      const restored = binance({ histories: true, storeDir: dir }).indicator.snapshot(BTC, 5000);
      expect(restored.icebergs).toEqual([]);
      expect(() => icebergOrdersFrames(BTC_WIRE, restored.ts, restored.icebergs, { watched: restored.watched, liveSince: restored.liveSince })).not.toThrow();
    });
  });

  describe("options", () => {
    test("env flags map to options and nothing else leaks in", () => {
      expect(icebergOptionsFromEnv({})).toEqual({});
      expect(icebergOptionsFromEnv({ L2_ICEBERG: "0", L2_ICEBERG_HISTORY: "0", L2_ICEBERG_STORE_DIR: "/tmp/x", L2_ICEBERG_STORE_S: "30", L2_ICEBERG_MAX_AGE_S: "3600" }))
        .toEqual({ enabled: false, histories: false, storeDir: "/tmp/x", storeS: 30, maxAgeS: 3600 });
      expect(icebergOptionsFromEnv({ L2_ICEBERG: "1", L2_ICEBERG_STORE_S: "-1", L2_ICEBERG_MAX_AGE_S: "abc" })).toEqual({ enabled: true });
      expect(icebergOptionsFromEnv({ TT_LIVE_STORAGE_SERVICE_URL: "http://g/live-storage", TT_LIVE_STORAGE_CLIENT_TOKEN: "t", L2_ICEBERG_FILL_DELAY_S: "5", L2_ICEBERG_FILL_EVERY_S: "600" }))
        .toEqual({ host: { baseUrl: "http://g/live-storage", token: "t" }, hostFillDelayMs: 5000, hostFillEveryMs: 600_000 });
      expect(icebergOptionsFromEnv({ TT_LIVE_STORAGE_SERVICE_URL: "http://g/live-storage", TT_LIVE_STORAGE_CLIENT_TOKEN: "t", L2_ICEBERG_HOST_FILL: "0" })).toEqual({});
      expect(icebergOptionsFromEnv({ TT_LIVE_STORAGE_SERVICE_URL: "http://g/live-storage" })).toEqual({});
      expect([DEFAULT_HOST_FILL_DELAY_MS, DEFAULT_HOST_FILL_EVERY_MS]).toEqual([120_000, 1_800_000]);
      expect(icebergOptionsFromEnv({ L2_HEATMAP_DEEP_S: "7200" })).toEqual({});
      expect(icebergOptionsFromEnv({ L2_HEATMAP_DEEP_S: "0" })).toEqual({});
      expect(icebergOptionsFromEnv({ L2_HEATMAP_DEEP_S: "abc" })).toEqual({});
    });

    test("with the detector off (L2_ICEBERG=0) the channel still answers, with empty pages that carry liveSince, and nothing is restored, fed, saved or asked of the host", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iceberg-indicator-"));
      const stored = { id: "s", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31000, display: 10, tranches: 2, executed: 20, startedAt: 1000, markedAt: 2000, updatedAt: 3000, status: "filled" };
      saveIcebergHistory({ dir, pairKey: "FUTURE:/NQZ26:XCME", savedAt: 4000, history: { version: ICEBERG_HISTORY_VERSION, icebergs: [stored] }, coverage: [[1000, 4000]] });
      const calls = [];
      const options = icebergOptionsFromEnv({ L2_ICEBERG: "0", TT_LIVE_STORAGE_SERVICE_URL: "http://g/live-storage", TT_LIVE_STORAGE_CLIENT_TOKEN: "t", L2_ICEBERG_FILL_DELAY_S: "0", L2_ICEBERG_STORE_S: "1" });
      const createRemoteReader = () => {
        calls.push("reader");
        return { readIcebergHistory: async () => { calls.push("read"); return { available: false, reason: "NOT_BUILT" }; }, close: () => calls.push("close") };
      };
      const off = createIcebergIndicator({ provider: "DXFEED", now: () => 60_000, ...options, storeDir: dir, liveReachMs: 10_000, createRemoteReader, publish: () => calls.push("publish"), saveHistory: async () => { calls.push("save"); return { ok: true }; }, saveHistorySync: () => { calls.push("final save"); return { ok: true }; }, log: { warn: () => {} } });
      expect(off.snapshot(NQ)).toEqual({ ts: 60_000, icebergs: [], watched: [], liveSince: 50_000 });
      expect(off.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("PARTIAL", 10)], { receivedAt: 59_000 })).toEqual([]);
      expect(off.onNativeUnavailable(NQ, 59_500)).toEqual([]);
      expect(off.tick(400_000)).toEqual([]);
      await flush();
      expect(off.stats()).toEqual({});
      off.stop();
      expect(calls).toEqual([]);
      const crypto = createIcebergIndicator({ provider: "BINANCE", enabled: false, storeDir: dir, cutsFactory: fixedCuts, publish: () => calls.push("publish"), log: { warn: () => {} } });
      defend(crypto);
      expect(crypto.tick(60_000)).toEqual([]);
      expect(crypto.stats()).toEqual({});
      expect(calls).toEqual([]);
      expect(() => createIcebergIndicator({ provider: "BINANCE", enabled: "0" })).toThrow(/enabled/);
    });

    test("the live window is the heatmap's live horizon, like absorption with history off: liveSince on a page and on an increment is the frame's time less the reach the servers hand in as liveReachMs, never before the epoch, four hours by default", () => {
      expect(DEFAULT_LIVE_REACH_MS).toBe(14_400_000);
      const { indicator, published } = dxfeed({ liveReachMs: 10_000 });
      expect(indicator.snapshot(NQ, 60_000).liveSince).toBe(50_000);
      expect(indicator.snapshot(NQ, 5_000).liveSince).toBe(0);
      indicator.onNativeEvents(NQ, [ev("NEW", 10), ev("PARTIAL", 3), ev("PARTIAL", 10)], { receivedAt: 70_000 });
      expect(published.map((entry) => entry.liveSince)).toEqual([60_000]);
      expect(() => dxfeed({ liveReachMs: 0 })).toThrow(/liveReachMs/);
      expect(() => dxfeed({ liveReachMs: 1.5 })).toThrow(/liveReachMs/);
    });

    test("bad options are refused", () => {
      expect(() => createIcebergIndicator({ provider: "KRAKEN" })).toThrow(/provider/);
      expect(() => createIcebergIndicator({ provider: "BINANCE", publish: 1 })).toThrow(/publish/);
      expect(() => createIcebergIndicator({ provider: "BINANCE", storeDir: "" })).toThrow(/storeDir/);
      expect(() => createIcebergIndicator({ provider: "BINANCE", storeS: 0 })).toThrow(/storeS/);
      expect(() => createIcebergIndicator({ provider: "BINANCE", maxAgeS: -5 })).toThrow(/maxAgeS/);
      const indicator = createIcebergIndicator({ provider: "BINANCE", histories: false, cutsFactory: fixedCuts });
      expect(() => indicator.onTrade({ symbol: "BTCUSDT" }, { price: 1, size: 1, aggressor: "buy", ts: 1 })).toThrow(/marketKind/);
    });

    test("after stop every input is ignored until start, which begins again from an empty state", () => {
      const { indicator, published } = binance();
      indicator.stop();
      defend(indicator);
      expect(published).toEqual([]);
      expect(indicator.tick(1)).toEqual([]);
      indicator.start();
      defend(indicator);
      expect(published.length).toBeGreaterThan(0);
      expect(indicator.stats()["PERPETUAL:BTCUSDT"].active).toBe(1);
    });
  });
});
