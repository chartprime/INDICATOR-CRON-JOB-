const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  saveLiquidityHistory, loadLiquidityHistory, loadLiquidityHistoryAsync, dropLiquidityHistory, liquidityStorePath, pruneExpiredFutureStores, VERSION,
} = require("../../../src/indicators/l2-memory/liquidity-store");

describe("pruneExpiredFutureStores (report 57 O-22)", () => {
  test("removes an expired contract's store and its backup, and leaves every current contract, equity and crypto store alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liquidity-prune-"));
    try {
      for (const name of [
        "FUTURE_ESU26_XCME.json", "FUTURE_ESU26_XCME.json.prev", "FUTURE_NQU26_XCME.json",
        "FUTURE_ESZ26_XCME.json", "FUTURE_ESZ26_XCME.json.prev", "FUTURE_NQZ26_XCME.json",
        "EQUITY_AAPL.json", "SPOT_BTCUSDT.json", "PERPETUAL_ETHUSDT.json.prev", "FUTURE_notes.txt",
      ]) fs.writeFileSync(path.join(dir, name), "{}");

      const removed = pruneExpiredFutureStores({ dir, keepPairKeys: ["FUTURE:/ESZ26:XCME", "FUTURE:/NQZ26:XCME"] });

      expect(removed.sort()).toEqual(["FUTURE_ESU26_XCME.json", "FUTURE_ESU26_XCME.json.prev", "FUTURE_NQU26_XCME.json"]);
      expect(fs.readdirSync(dir).sort()).toEqual([
        "EQUITY_AAPL.json", "FUTURE_ESZ26_XCME.json", "FUTURE_ESZ26_XCME.json.prev", "FUTURE_NQZ26_XCME.json",
        "FUTURE_notes.txt", "PERPETUAL_ETHUSDT.json.prev", "SPOT_BTCUSDT.json",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a current contract keeps its wall and event history; an expired contract's history goes with its store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liquidity-prune-sidecars-"));
    try {
      for (const name of [
        "FUTURE_ESZ26_XCME.json", "FUTURE_ESZ26_XCME.walls.json", "FUTURE_ESZ26_XCME.events.json",
        "FUTURE_ESZ26_XCME.walls.json.prev", "FUTURE_NQZ26_XCME.events.json",
        "FUTURE_ESU26_XCME.json", "FUTURE_ESU26_XCME.walls.json", "FUTURE_ESU26_XCME.events.json.prev",
        "FUTURE_ESZ26_XCMEX.json", "FUTURE_ESZ26_XCMEX.walls.json",
      ]) fs.writeFileSync(path.join(dir, name), "{}");

      const removed = pruneExpiredFutureStores({ dir, keepPairKeys: ["FUTURE:/ESZ26:XCME", "FUTURE:/NQZ26:XCME"] });

      expect(removed.sort()).toEqual([
        "FUTURE_ESU26_XCME.events.json.prev", "FUTURE_ESU26_XCME.json", "FUTURE_ESU26_XCME.walls.json",
        "FUTURE_ESZ26_XCMEX.json", "FUTURE_ESZ26_XCMEX.walls.json",
      ]);
      expect(fs.readdirSync(dir).sort()).toEqual([
        "FUTURE_ESZ26_XCME.events.json", "FUTURE_ESZ26_XCME.json", "FUTURE_ESZ26_XCME.walls.json",
        "FUTURE_ESZ26_XCME.walls.json.prev", "FUTURE_NQZ26_XCME.events.json",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing store directory is not an error", () => {
    expect(pruneExpiredFutureStores({ dir: path.join(os.tmpdir(), "no-such-liquidity-dir"), keepPairKeys: [] })).toEqual([]);
  });
});

const T = 1_700_000_000_000;
const PAIR = "SPOT:BTCUSDT";
const GEOMETRY = { rowWidth: 4, rowClusters: 8, windowRows: 1023, columnMs: 1_000, deepColumnMs: 10_000 };
const RECENT = [
  { ts: T, lo: 100, hi: 104, bid: [[0, 5], [2, 3]], ask: [[4, 7]] },
  { ts: T + 1_000, lo: 100, hi: 104, bid: [[2, 0]], ask: [] },
];
const DEEP = [{ ts: T - 60_000, lo: 100, hi: 104, bid: [[1, 9]], ask: [] }];
const LEVELS = [{ side: "bid", row: 100, span: 1, startTs: T - 5_000, endTs: null, size: 5, peak: 9, endedBy: null, ratio: 2, chain: 0 }];

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "liquidity-store-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const save = (overrides = {}) => saveLiquidityHistory({ dir, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT, deep: DEEP, levels: LEVELS, savedAt: T, ...overrides });
const load = (overrides = {}) => loadLiquidityHistory({ dir, pairKey: PAIR, geometry: GEOMETRY, now: T, ...overrides });

describe("liquidity-store", () => {
  test("writes one file per pair and reads it back whole", () => {
    const written = save();
    expect(written).toMatchObject({ ok: true, columns: 3 });
    expect(written.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(liquidityStorePath(dir, PAIR))).toBe(true);
    expect(load()).toEqual({ savedAt: T, geometry: GEOMETRY, recent: RECENT, deep: DEEP, levels: LEVELS, aggressive: [], coarse: null });
    // The pair key names the file, with the colon made safe.
    expect(path.basename(liquidityStorePath(dir, PAIR))).toBe("SPOT_BTCUSDT.json");
    expect(() => liquidityStorePath(dir, "")).toThrow(/pairKey/);
  });

  test("the non-blocking loader reads back exactly what the one-piece loader does, and refuses the same files (Block 8 #8)", async () => {
    const coarse = { columnMs: 300_000, rows: 40, columns: [{ ts: T - 600_000, lo: 2, hi: 3, bid: [[0, 9]], ask: [] }] };
    save({ coarse });
    const loadAsync = (overrides = {}) => loadLiquidityHistoryAsync({ dir, pairKey: PAIR, geometry: GEOMETRY, now: T, ...overrides });
    await expect(loadAsync()).resolves.toEqual(load());
    const reasons = [];
    await expect(loadAsync({ geometry: { ...GEOMETRY, rowWidth: 8 }, onReject: (reason) => reasons.push(reason) })).resolves.toBeNull();
    await expect(loadAsync({ maxFileBytes: 10, onReject: (reason) => reasons.push(reason) })).resolves.toBeNull();
    fs.writeFileSync(liquidityStorePath(dir, PAIR), "{not json");
    await expect(loadAsync({ onReject: (reason) => reasons.push(reason) })).resolves.toBeNull();
    expect(reasons).toEqual(["GEOMETRY_MISMATCH", "TOO_LARGE", "MALFORMED"]);
    await expect(loadLiquidityHistoryAsync({ dir, pairKey: "SPOT:ETHUSDT", now: T })).resolves.toBeNull();
  });

  test("aggressive-order clusters ride with the walls; a file without them loads with none", () => {
    const fight = { side: "sell", row: 40_000, span: 2, startTs: T - 60_000, endTs: T - 30_000, volume: 30, peak: 20, floor: 10 };
    save({ aggressive: [fight] });
    expect(load().aggressive).toEqual([fight]);
    const write = (aggressive) => fs.writeFileSync(liquidityStorePath(dir, PAIR), JSON.stringify({ version: VERSION, pairKey: PAIR, savedAt: T, geometry: GEOMETRY, recent: RECENT, deep: [], levels: [], ...(aggressive === undefined ? {} : { aggressive }) }));
    write(undefined);
    expect(load().aggressive).toEqual([]);
    write("nope");
    expect(load()).toBeNull();
    write([{ ...fight, side: "bid" }]);
    expect(load()).toBeNull();
    write([{ ...fight, span: 0 }]);
    expect(load()).toBeNull();
  });

  test("the coarse tier rides on its own geometry: a file without it loads with none, a malformed one is refused", () => {
    const coarse = { columnMs: 300_000, rows: 40, columns: [{ ts: T - 600_000, lo: 2, hi: 3, bid: [[0, 9]], ask: [] }] };
    save({ coarse });
    expect(load().coarse).toEqual(coarse);
    expect(load()).toMatchObject({ recent: RECENT, deep: DEEP });
    const write = (value) => fs.writeFileSync(liquidityStorePath(dir, PAIR), JSON.stringify({ version: VERSION, pairKey: PAIR, savedAt: T, geometry: GEOMETRY, recent: RECENT, deep: [], levels: [], ...(value === undefined ? {} : { coarse: value }) }));
    write(undefined);
    expect(load().coarse).toBeNull();
    write(null);
    expect(load().coarse).toBeNull();
    write({ ...coarse, rows: 0 });
    expect(load()).toBeNull();
    write({ ...coarse, columns: [{ ...coarse.columns[0], hi: 1 }] });
    expect(load()).toBeNull();
    write("nope");
    expect(load()).toBeNull();
  });

  test("leaves nothing behind and creates the directory it needs", () => {
    const nested = path.join(dir, "deeper", "still");
    expect(saveLiquidityHistory({ dir: nested, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT, savedAt: T }).ok).toBe(true);
    expect(fs.readdirSync(nested)).toEqual(["SPOT_BTCUSDT.json"]); // no leftover .tmp
    expect(loadLiquidityHistory({ dir: nested, pairKey: PAIR, geometry: GEOMETRY, now: T })).toMatchObject({ deep: [], levels: [] });
  });

  test("keeps the previous file beside the new one, so one bad write never costs the history", () => {
    // 2026-09-15: a runtime started with a history floor saved a twenty-minute file over an eleven-hour one a minute later.
    const previous = `${liquidityStorePath(dir, PAIR)}.prev`;
    save();
    expect(fs.existsSync(previous)).toBe(false);
    save({ savedAt: T + 60_000, recent: [RECENT[0]] });
    expect(JSON.parse(fs.readFileSync(previous, "utf8"))).toMatchObject({ savedAt: T, recent: RECENT });
    expect(load({ now: T + 60_000 })).toMatchObject({ savedAt: T + 60_000, recent: [RECENT[0]] });
    save({ savedAt: T + 120_000 });
    expect(JSON.parse(fs.readFileSync(previous, "utf8")).savedAt).toBe(T + 60_000);
    // Forgetting a pair forgets both.
    expect(dropLiquidityHistory({ dir, pairKey: PAIR })).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("nothing to read is not an error", () => {
    expect(load()).toBeNull();
    expect(loadLiquidityHistory({ dir: path.join(dir, "absent"), pairKey: PAIR, now: T })).toBeNull();
    save();
    expect(load({ pairKey: "SPOT:ETHUSDT" })).toBeNull();
  });

  test("refuses anything it cannot trust: another version, pair, geometry, or a file from the future", () => {
    const write = (payload) => fs.writeFileSync(liquidityStorePath(dir, PAIR), JSON.stringify(payload));
    const base = { version: VERSION, pairKey: PAIR, savedAt: T, geometry: GEOMETRY, recent: RECENT, deep: DEEP, levels: LEVELS };
    write({ ...base, version: VERSION + 1 });
    expect(load()).toBeNull();
    write({ ...base, pairKey: "SPOT:ETHUSDT" });
    expect(load()).toBeNull();
    write(base);
    expect(load({ geometry: { ...GEOMETRY, rowWidth: 2 } })).toBeNull(); // price moved enough to change the row height
    expect(load({ geometry: { ...GEOMETRY, deepColumnMs: 0 } })).toBeNull();
    expect(load({ geometry: undefined })).not.toBeNull(); // no expectation, no check
    write({ ...base, savedAt: T + 5 * 60_000 });
    expect(load()).toBeNull();
    fs.writeFileSync(liquidityStorePath(dir, PAIR), "{ not json");
    expect(load()).toBeNull();
  });

  test("refuses a file older than the caller is willing to replay", () => {
    save({ savedAt: T - 90_000 });
    expect(load({ maxAgeMs: 60_000 })).toBeNull();
    expect(load({ maxAgeMs: 120_000 })).toMatchObject({ savedAt: T - 90_000 });
    expect(load()).not.toBeNull(); // no limit given
  });

  test("refuses malformed columns rather than handing back half a picture", () => {
    const write = (recent) => fs.writeFileSync(liquidityStorePath(dir, PAIR), JSON.stringify({ version: VERSION, pairKey: PAIR, savedAt: T, geometry: GEOMETRY, recent, deep: [], levels: [] }));
    write([]);
    expect(load()).toBeNull(); // nothing worth restoring
    write([{ ...RECENT[0] }, { ...RECENT[0] }]); // ts must move forward
    expect(load()).toBeNull();
    write([{ ...RECENT[0], lo: 105 }]); // lo > hi
    expect(load()).toBeNull();
    write([{ ...RECENT[0], bid: [[5, 1]] }]); // offset outside the window
    expect(load()).toBeNull();
    write([{ ...RECENT[0], bid: [[2, 1], [0, 1]] }]); // offsets must increase
    expect(load()).toBeNull();
    write([{ ...RECENT[0], bid: [[0, -1]] }]);
    expect(load()).toBeNull();
    write([{ ...RECENT[0], ask: "none" }]);
    expect(load()).toBeNull();
    write([{ ...RECENT[0], lo: 0, hi: 2_048 }]); // would exceed the browser's typed-array frame bound
    expect(load()).toBeNull();
    write([{ ...RECENT[0] }]);
    expect(load()).not.toBeNull();
    write([{ ...RECENT[0], buy: [[5, 1]] }]); // traded volume outside the window
    expect(load()).toBeNull();
    write([{ ...RECENT[0], prints: [{ ts: T, price: 0, size: 1, side: "buy", id: "x" }] }]);
    expect(load()).toBeNull();
    write([{ ...RECENT[0], prints: [{ ts: T, price: 1, size: 1, side: "both", id: "x" }] }]);
    expect(load()).toBeNull();
    write([{ ...RECENT[0], printsFloor: -1 }]);
    expect(load()).toBeNull();
    // A print from the second before the column's own arrived late and was credited here (2026-09-20): it loads. Two back does not.
    write([{ ...RECENT[0], prints: [{ ts: T - 1_001, price: 1, size: 1, side: "buy", id: "x" }] }]);
    expect(load()).not.toBeNull();
    write([{ ...RECENT[0], prints: [{ ts: T - 2_000, price: 1, size: 1, side: "buy", id: "x" }] }]);
    expect(load()).not.toBeNull();
    write([{ ...RECENT[0], prints: [{ ts: T - 2_001, price: 1, size: 1, side: "buy", id: "x" }] }]);
    expect(load()).toBeNull();
    write([{ ...RECENT[0], prints: [{ ts: T + 1_001, price: 1, size: 1, side: "buy", id: "x" }] }]);
    expect(load()).toBeNull();
    write([{ ...RECENT[0], buy: [[0, 2.5]], sell: [], prints: [{ ts: T, price: 1, size: 2.5, side: "buy", id: "x" }], printsFloor: 2 }]);
    expect(load().recent[0]).toMatchObject({ buy: [[0, 2.5]], printsFloor: 2 });
  });

  test("a version 1 file, written before columns carried their flow, still loads", () => {
    fs.writeFileSync(liquidityStorePath(dir, PAIR), JSON.stringify({ version: 1, pairKey: PAIR, savedAt: T, geometry: GEOMETRY, recent: RECENT, deep: [], levels: [] }));
    expect(load()).not.toBeNull();
    expect(VERSION).toBe(2);
  });

  test("refuses a wall list the tracker could not adopt", () => {
    const write = (levels) => fs.writeFileSync(liquidityStorePath(dir, PAIR), JSON.stringify({ version: VERSION, pairKey: PAIR, savedAt: T, geometry: GEOMETRY, recent: RECENT, deep: [], levels }));
    write([{ ...LEVELS[0], side: "buy" }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], span: 0 }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], startTs: 1.5 }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], endTs: T, size: "big" }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], endTs: LEVELS[0].startTs - 1 }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], size: -1 }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], peak: LEVELS[0].size - 1 }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], endTs: T, endedBy: null }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], endedBy: "pulled" }]);
    expect(load()).toBeNull();
    write([{ ...LEVELS[0], endTs: T, endedBy: "pulled" }]);
    expect(load()).not.toBeNull();
  });

  test("refuses aggressive events that cannot satisfy the wire contract", () => {
    const fight = { side: "sell", row: 40_000, span: 2, startTs: T - 60_000, endTs: T - 30_000, volume: 30, peak: 20, floor: 10 };
    const write = (aggressive) => fs.writeFileSync(liquidityStorePath(dir, PAIR), JSON.stringify({ version: VERSION, pairKey: PAIR, savedAt: T, geometry: GEOMETRY, recent: RECENT, deep: [], levels: [], aggressive }));
    write([{ ...fight, endTs: fight.startTs - 1 }]);
    expect(load()).toBeNull();
    write([{ ...fight, peak: fight.volume + 1 }]);
    expect(load()).toBeNull();
    write([{ ...fight, floor: -1 }]);
    expect(load()).toBeNull();
    write([fight]);
    expect(load()).not.toBeNull();
  });

  test("a write that cannot happen is reported, not thrown", () => {
    const onAFile = path.join(dir, "file-not-a-dir");
    fs.writeFileSync(onAFile, "x");
    expect(saveLiquidityHistory({ dir: onAFile, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT })).toMatchObject({ ok: false });
    expect(typeof saveLiquidityHistory({ dir: onAFile, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT }).reason).toBe("string");
  });

  test("a pair's file can be forgotten", () => {
    save();
    expect(dropLiquidityHistory({ dir, pairKey: PAIR })).toBe(true);
    expect(load()).toBeNull();
    expect(dropLiquidityHistory({ dir, pairKey: PAIR })).toBe(true); // already gone
  });
});

// Report 57 W2, GE-17 and L-AY2: the store has a byte budget (owner decision:
// about 48 MB, oldest history trimmed first, by the publisher) and a restore
// that cannot use the file says why instead of silently returning nothing.
describe("liquidity-store budget and rejection reasons (GE-17, L-AY2)", () => {
  test("a payload over the byte budget is refused and the previous file is kept", () => {
    expect(save()).toMatchObject({ ok: true });
    const before = fs.readFileSync(liquidityStorePath(dir, PAIR), "utf8");
    const refused = save({ savedAt: T + 1_000, maxBytes: 100 });
    expect(refused).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect(refused.bytes).toBeGreaterThan(100);
    expect(fs.readFileSync(liquidityStorePath(dir, PAIR), "utf8")).toBe(before);
  });

  test("the trimmed-before time rides with the file and comes back on load", () => {
    save({ trimmedBefore: T - 120_000 });
    expect(load().trimmedBefore).toBe(T - 120_000);
    save();
    expect(load().trimmedBefore).toBeUndefined();
  });

  test("every refusal to restore names its reason; a missing file is not a refusal", () => {
    const reasons = [];
    const onReject = (reason) => reasons.push(reason);
    expect(load({ onReject })).toBeNull();
    save();
    expect(load({ onReject, maxFileBytes: 10 })).toBeNull();
    expect(load({ onReject, geometry: { ...GEOMETRY, rowWidth: 8 } })).toBeNull();
    expect(load({ onReject, maxAgeMs: 1, now: T + 60_000 })).toBeNull();
    fs.writeFileSync(liquidityStorePath(dir, PAIR), "{not json");
    expect(load({ onReject })).toBeNull();
    expect(reasons).toEqual(["TOO_LARGE", "GEOMETRY_MISMATCH", "TOO_OLD", "MALFORMED"]);
  });
});

// Report 57 W2, FA-6: writing the whole store in one JSON.stringify blocked
// the event loop for about half a second at the 48 MB budget (measured 495 to
// 503 ms), once a minute per pair. The background writer streams the same
// file in batches, yielding between them, and commits only if still wanted.
describe("liquidity-store background writer (FA-6)", () => {
  const { saveLiquidityHistoryAsync } = require("../../../src/indicators/l2-memory/liquidity-store");
  const deepColumns = (count) => Array.from({ length: count }, (_, i) => ({ ts: T - (count - i) * 10_000, lo: 100, hi: 104, bid: [[1, i % 9 + 1]], ask: [] }));

  test("writes a file that loads exactly like the one-shot writer's, yielding between batches", async () => {
    const deep = deepColumns(2_500);
    let yields = 0;
    const result = await saveLiquidityHistoryAsync({
      dir, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT, deep, levels: LEVELS, savedAt: T, trimmedBefore: deep[0].ts,
    }, { batchColumns: 500, yieldToLoop: async () => { yields += 1; } });
    expect(result).toMatchObject({ ok: true, columns: RECENT.length + deep.length });
    expect(yields).toBeGreaterThanOrEqual(5);
    expect(load()).toEqual({ savedAt: T, geometry: GEOMETRY, recent: RECENT, deep, coarse: null, levels: LEVELS, aggressive: [], trimmedBefore: deep[0].ts });
    expect(result.bytes).toBe(fs.statSync(liquidityStorePath(dir, PAIR)).size);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("the background writer preserves the optional coarse tier under the same byte budget", async () => {
    const coarse = { columnMs: 300_000, rows: 40, columns: [
      { ts: T - 600_000, lo: 20, hi: 21, bid: [[0, 5]], ask: [] },
      { ts: T - 300_000, lo: 20, hi: 21, bid: [], ask: [[1, 2]] },
    ] };
    const result = await saveLiquidityHistoryAsync({ dir, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT, coarse, levels: LEVELS, savedAt: T }, { batchColumns: 1 });
    expect(result).toMatchObject({ ok: true, columns: RECENT.length + coarse.columns.length });
    expect(load().coarse).toEqual(coarse);
    expect(result.bytes).toBe(fs.statSync(liquidityStorePath(dir, PAIR)).size);
  });

  test("over the budget it reports the full size, keeps the previous file and leaves no temporary behind", async () => {
    save();
    const before = fs.readFileSync(liquidityStorePath(dir, PAIR), "utf8");
    const deep = deepColumns(3_000);
    const full = JSON.stringify(deep).length;
    const result = await saveLiquidityHistoryAsync({ dir, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT, deep, levels: LEVELS, savedAt: T + 1, maxBytes: 10_000 }, { batchColumns: 500 });
    expect(result).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect(result.bytes).toBeGreaterThan(full);
    expect(fs.readFileSync(liquidityStorePath(dir, PAIR), "utf8")).toBe(before);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a write that is no longer wanted when it finishes is discarded, so a newer save always wins", async () => {
    save();
    const before = fs.readFileSync(liquidityStorePath(dir, PAIR), "utf8");
    const result = await saveLiquidityHistoryAsync({ dir, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT, deep: deepColumns(10), levels: LEVELS, savedAt: T + 2 }, { shouldCommit: () => false });
    expect(result).toMatchObject({ ok: false, reason: "SUPERSEDED" });
    expect(fs.readFileSync(liquidityStorePath(dir, PAIR), "utf8")).toBe(before);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("completes every chunk when the underlying file write is short", async () => {
    const open = fs.promises.open;
    const openSpy = jest.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      return {
        write: (buffer, offset, length) => handle.write(buffer, offset, Math.min(length, 17)),
        close: () => handle.close(),
      };
    });
    try {
      const result = await saveLiquidityHistoryAsync({ dir, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT, levels: LEVELS, savedAt: T });
      expect(result).toMatchObject({ ok: true });
      expect(load()).toMatchObject({ savedAt: T, recent: RECENT, levels: LEVELS });
    } finally {
      openSpy.mockRestore();
    }
  });

  test("a shutdown save during the backup copy cannot be replaced by the older background save", async () => {
    save();
    let committable = true;
    const copyFile = fs.promises.copyFile;
    const copy = jest.spyOn(fs.promises, "copyFile").mockImplementation(async (from, to) => {
      await copyFile(from, to);
      committable = false;
      expect(save({ savedAt: T + 2_000 })).toMatchObject({ ok: true });
    });
    try {
      const result = await saveLiquidityHistoryAsync(
        { dir, pairKey: PAIR, geometry: GEOMETRY, recent: RECENT, deep: deepColumns(10), levels: LEVELS, savedAt: T + 1_000 },
        { shouldCommit: () => committable },
      );
      expect(result).toMatchObject({ ok: false, reason: "SUPERSEDED" });
      expect(load({ now: T + 2_000 }).savedAt).toBe(T + 2_000);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      copy.mockRestore();
    }
  });
});

describe("liquidity-store temporary files", () => {
  const { sweepStoreTemporaries } = require("../../../src/indicators/l2-memory/liquidity-store");

  test("sweepStoreTemporaries removes the temporary files an earlier process left behind, and nothing else", () => {
    const stale = path.join(dir, "SPOT_BTCUSDT.json.123.4.tmp");
    const fresh = path.join(dir, "SPOT_ETHUSDT.json.123.5.tmp");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(fresh, "x");
    fs.utimesSync(stale, new Date(T - 3_600_000), new Date(T - 3_600_000));
    fs.utimesSync(fresh, new Date(T - 60_000), new Date(T - 60_000));
    save();
    const store = liquidityStorePath(dir, PAIR);
    fs.utimesSync(store, new Date(T - 7_200_000), new Date(T - 7_200_000));
    expect(sweepStoreTemporaries({ dir, now: T, maxAgeMs: 600_000 })).toEqual(["SPOT_BTCUSDT.json.123.4.tmp"]);
    expect(fs.readdirSync(dir).sort()).toEqual(["SPOT_BTCUSDT.json", "SPOT_ETHUSDT.json.123.5.tmp"]);
    expect(sweepStoreTemporaries({ dir: path.join(dir, "missing"), now: T })).toEqual([]);
    expect(() => sweepStoreTemporaries({ dir, now: T, maxAgeMs: 0 })).toThrow(/maxAgeMs/);
  });
});
