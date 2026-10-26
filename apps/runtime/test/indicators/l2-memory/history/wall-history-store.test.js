"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveWallHistoryAsync, loadWallHistory, dropWallHistory, wallHistoryPath } = require("../../../../src/indicators/l2-memory/history/wall-history-store");
const { createWallHistory } = require("../../../../src/indicators/l2-memory/history/wall-history");

const T = 1_780_000_000_000;
const GEOMETRY = { rowWidth: 2, rowClusters: 4, tickSize: 0.1, clusterTicks: 5 };

function fresh() {
  const history = createWallHistory({ maxAgeMs: 86_400_000 });
  history.record([{ side: "bid", row: 100, span: 1, startTs: T - 60_000, endTs: T, size: 0, peak: 30, endedBy: "pulled" }]);
  return history;
}

describe("wall history store (P4e2 step 3): one file per pair, a cache never a source of truth", () => {
  test("writes a pair's history whole and reads it back for the same rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wall-history-"));
    const history = fresh();
    const result = await saveWallHistoryAsync({ dir, pairKey: "PERPETUAL:BTCUSDT", geometry: GEOMETRY, savedAt: T, history: history.toJSON() });
    expect(result).toMatchObject({ ok: true, file: wallHistoryPath(dir, "PERPETUAL:BTCUSDT") });
    expect(await saveWallHistoryAsync({ dir, pairKey: "PERPETUAL:BTCUSDT", geometry: GEOMETRY, savedAt: T, history: { version: 1, trades: [], wallTrades: [] }, suffix: "events" })).toMatchObject({ ok: true, file: wallHistoryPath(dir, "PERPETUAL:BTCUSDT", "events") });
    expect(() => wallHistoryPath(dir, "x", "other")).toThrow(/suffix/);
    expect(fs.readdirSync(dir).sort()).toEqual(["PERPETUAL_BTCUSDT.events.json", "PERPETUAL_BTCUSDT.walls.json"]);
    expect(loadWallHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", geometry: GEOMETRY, suffix: "events" })).toMatchObject({ history: { version: 1 } });
    expect(dropWallHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", suffix: "events" })).toBe(true);
    const loaded = loadWallHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", geometry: GEOMETRY });
    expect(loaded).toMatchObject({ savedAt: T, geometry: GEOMETRY });
    const back = createWallHistory({ maxAgeMs: 86_400_000 });
    expect(back.load(loaded.history)).toBe(true);
    expect(back.size).toBe(1);
    expect(dropWallHistory({ dir, pairKey: "PERPETUAL:BTCUSDT" })).toBe(true);
    expect(loadWallHistory({ dir, pairKey: "PERPETUAL:BTCUSDT", geometry: GEOMETRY })).toBeNull();
  });

  test("refuses a file for other rows, another pair, a malformed one or one over the size cap, naming why; never throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wall-history-"));
    const reasons = [];
    const onReject = (reason) => reasons.push(reason);
    await saveWallHistoryAsync({ dir, pairKey: "SPOT:ETHUSDT", geometry: GEOMETRY, savedAt: T, history: fresh().toJSON() });
    expect(loadWallHistory({ dir, pairKey: "SPOT:ETHUSDT", geometry: { ...GEOMETRY, rowWidth: 4 }, onReject })).toBeNull();
    fs.writeFileSync(wallHistoryPath(dir, "SPOT:BTCUSDT"), JSON.stringify({ version: 1, pairKey: "SPOT:ETHUSDT", savedAt: T, geometry: GEOMETRY, history: {} }));
    expect(loadWallHistory({ dir, pairKey: "SPOT:BTCUSDT", geometry: GEOMETRY, onReject })).toBeNull();
    fs.writeFileSync(wallHistoryPath(dir, "SPOT:SOLUSDT"), "{not json");
    expect(loadWallHistory({ dir, pairKey: "SPOT:SOLUSDT", geometry: GEOMETRY, onReject })).toBeNull();
    expect(loadWallHistory({ dir, pairKey: "SPOT:ETHUSDT", geometry: GEOMETRY, maxFileBytes: 10, onReject })).toBeNull();
    expect(reasons).toEqual(["GEOMETRY_MISMATCH", "FOREIGN", "MALFORMED", "TOO_LARGE"]);
    expect(await saveWallHistoryAsync({ dir, pairKey: "SPOT:ETHUSDT", geometry: GEOMETRY, history: fresh().toJSON(), maxBytes: 10 })).toMatchObject({ ok: false, reason: "OVER_BUDGET" });
    expect(await saveWallHistoryAsync({ dir: path.join(dir, "new-folder"), pairKey: "x", geometry: GEOMETRY, history: fresh().toJSON() })).toMatchObject({ ok: true });
    fs.writeFileSync(path.join(dir, "blocked"), "");
    expect(await saveWallHistoryAsync({ dir: path.join(dir, "blocked"), pairKey: "x", geometry: GEOMETRY, history: fresh().toJSON() })).toMatchObject({ ok: false });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
