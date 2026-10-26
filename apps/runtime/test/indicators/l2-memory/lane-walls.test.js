"use strict";

const { createLaneWallTrackers, packRecords, unpackRecords, laneWallId, LANE_ID_BASE } = require("../../../src/indicators/l2-memory/compact/lane-walls");
const { createLaneWallsWorker } = require("../../../src/indicators/l2-memory/compact/lane-walls-worker");
const { createLaneWallsClient } = require("../../../src/indicators/l2-memory/compact/lane-walls-client");

const T = 1_780_000_000_000;
const OPTIONS = { minSize: 10, multiplier: 0, gapRows: 0, settleMs: 0 };

function column(ts, lo, bid, ask) {
  return { ts, lo, hi: lo + bid.length - 1, bid: Float64Array.from(bid), ask: Float64Array.from(ask) };
}

describe("lane walls (P4e2 change 5): bare trackers per wider lane, ids in their own range", () => {
  test("validates its lanes and runs one tracker per lane on that lane's rows, with ids offset by the lane", () => {
    expect(() => createLaneWallTrackers({ lanes: "x", trackerOptions: OPTIONS })).toThrow(/lanes/);
    expect(() => createLaneWallTrackers({ lanes: [{ k: 0, rowClusters: 2 }], trackerOptions: OPTIONS })).toThrow(/lane k/);
    expect(() => createLaneWallTrackers({ lanes: [{ k: 7, rowClusters: 2 }], trackerOptions: OPTIONS })).toThrow(/lane k/);
    expect(() => createLaneWallTrackers({ lanes: [{ k: 1, rowClusters: 0 }], trackerOptions: OPTIONS })).toThrow(/rowClusters/);
    expect(() => createLaneWallTrackers({ lanes: [] })).toThrow(/trackerOptions/);
    const trackers = createLaneWallTrackers({ lanes: [{ k: 1, rowClusters: 2 }, { k: 2, rowClusters: 4 }], trackerOptions: OPTIONS });
    expect(trackers.lanes()).toEqual([1, 2]);
    expect(trackers.update({ lane: 1, ts: T, column: column(T, 100, [12, 0, 0], [0, 0, 0]), bids: [], asks: [] })).toBe(true);
    expect(trackers.update({ lane: 2, ts: T, column: column(T, 50, [0, 0, 30], [0, 0, 0]), bids: [], asks: [] })).toBe(true);
    expect(trackers.walls(1)).toEqual([expect.objectContaining({ id: LANE_ID_BASE + 1, lane: 1, side: "bid", row: 100, startTs: T, detail: null })]);
    expect(trackers.walls(2)).toEqual([expect.objectContaining({ id: 2 * LANE_ID_BASE + 1, lane: 2, row: 52 })]);
    // The ledger records are keyed by cluster: on lane 2 (four clusters a row) key 210 is row 52, the wall's own row, so what traded there is the wall's.
    trackers.update({ lane: 2, ts: T + 1_000, column: column(T + 1_000, 50, [0, 0, 0], [0, 0, 0]), bids: [{ key: 210, size: 0, traded: 30, cancelled: 0 }], asks: [] });
    expect(trackers.walls(2)).toEqual([expect.objectContaining({ id: 2 * LANE_ID_BASE + 1, lane: 2, row: 52, endedBy: "hit", ratio: 1 })]);
    expect(laneWallId(3, 5)).toBe(3 * LANE_ID_BASE + 5);
    expect(() => trackers.update({ lane: 3, ts: T, column: column(T, 0, [0], [0]), bids: [], asks: [] })).toThrow(/no tracker/);
    expect(() => trackers.walls(3)).toThrow(/no tracker/);
    trackers.clear();
    expect(trackers.walls(1)).toEqual([]);
    const packed = packRecords([{ key: 200, size: 3, traded: 1, cancelled: 2 }, { key: 201, size: 4 }]);
    expect([...packed]).toEqual([200, 3, 1, 2, 201, 4, 0, 0]);
    expect(unpackRecords(packed)).toEqual([{ key: 200, size: 3, traded: 1, cancelled: 2 }, { key: 201, size: 4, traded: 0, cancelled: 0 }]);
  });

  test("the worker keeps trackers per pair, answers a column with that lane's walls when they changed, null when nothing moved or the pair is unknown, and forgets a pair", () => {
    const posted = [];
    const worker = createLaneWallsWorker((message) => posted.push(message));
    const col = column(T, 100, [12, 0, 0], [0, 0, 0]);
    worker.handle({ type: "column", pair: "P", lane: 1, ts: T, lo: col.lo, hi: col.hi, bid: col.bid, ask: col.ask, bids: packRecords([]), asks: packRecords([]), referenceRows: 5 });
    expect(posted).toEqual([{ type: "walls", pair: "P", lane: 1, ts: T, levels: null }]);
    worker.handle({ type: "configure", pair: "P", lanes: [{ k: 1, rowClusters: 2 }], trackerOptions: OPTIONS });
    worker.handle({ type: "column", pair: "P", lane: 1, ts: T, lo: col.lo, hi: col.hi, bid: col.bid, ask: col.ask, bids: packRecords([]), asks: packRecords([]), referenceRows: 5 });
    expect(posted[1]).toMatchObject({ type: "walls", pair: "P", lane: 1, ts: T });
    expect(posted[1].levels).toEqual([expect.objectContaining({ id: LANE_ID_BASE + 1, lane: 1, row: 100 })]);
    worker.handle({ type: "column", pair: "P", lane: 1, ts: T + 1_000, lo: col.lo, hi: col.hi, bid: col.bid, ask: col.ask, bids: packRecords([]), asks: packRecords([]), referenceRows: 5 });
    expect(posted[2]).toEqual({ type: "walls", pair: "P", lane: 1, ts: T + 1_000, levels: null });
    worker.handle({ type: "forget", pair: "P" });
    worker.handle({ type: "column", pair: "P", lane: 1, ts: T + 2_000, lo: col.lo, hi: col.hi, bid: col.bid, ask: col.ask, bids: packRecords([]), asks: packRecords([]), referenceRows: 5 });
    expect(posted[3].levels).toBeNull();
    worker.handle({ type: "noise" });
    expect(posted).toHaveLength(4);
  });

  test("the client posts a lane's column with the book packed, holds one column in flight per lane and drops the next until the reply, and hands back the latest walls per pair", () => {
    const sent = [];
    let receive = null;
    const lines = [];
    const client = createLaneWallsClient({ spawn: (onMessage) => { receive = onMessage; return { postMessage: (message, transfer) => sent.push([message, transfer.length]) }; }, log: (line) => lines.push(line) });
    const snapshot = { bids: [{ key: 200, size: 3, traded: 1, cancelled: 0 }], asks: [{ key: 202, size: 2 }] };
    const col = column(T, 100, [12, 0, 0], [0, 0, 0]);
    expect(client.post({ pair: "P", lane: 1, ts: T, column: col, snapshot, referenceRows: 5 })).toBe(false);
    client.configure("P", [{ k: 1, rowClusters: 2, factor: 2, extra: "ignored" }], OPTIONS);
    client.configure("P", [{ k: 1, rowClusters: 2 }], OPTIONS);
    expect(sent).toEqual([[{ type: "configure", pair: "P", lanes: [{ k: 1, rowClusters: 2 }], trackerOptions: OPTIONS }, 0]]);
    expect(client.post({ pair: "P", lane: 1, ts: T, column: col, snapshot, referenceRows: 5 })).toBe(true);
    expect(sent[1][0]).toMatchObject({ type: "column", pair: "P", lane: 1, ts: T, lo: 100, hi: 102, referenceRows: 5 });
    expect([...sent[1][0].bids]).toEqual([200, 3, 1, 0]);
    expect([...sent[1][0].asks]).toEqual([202, 2, 0, 0]);
    expect(sent[1][1]).toBe(4);
    expect(client.post({ pair: "P", lane: 1, ts: T + 1_000, column: col, snapshot, referenceRows: 5 })).toBe(false);
    expect(client.stats()).toMatchObject({ posted: 1, dropped: 1, inFlight: 1 });
    expect(client.wallsOf("P")).toEqual([]);
    receive({ type: "walls", pair: "P", lane: 1, ts: T, levels: [{ id: LANE_ID_BASE + 1, lane: 1, side: "bid", row: 100, span: 1, startTs: T, endTs: null, size: 12, peak: 12, endedBy: null, ratio: 0, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null }] });
    expect(client.wallsOf("P").map((wall) => [wall.id, wall.lane])).toEqual([[LANE_ID_BASE + 1, 1]]);
    expect(client.post({ pair: "P", lane: 1, ts: T + 2_000, column: col, snapshot, referenceRows: 5 })).toBe(true);
    receive({ type: "walls", pair: "P", lane: 1, ts: T + 2_000, levels: null });
    expect(client.wallsOf("P")).toHaveLength(1);
    receive({ type: "error", pair: "P", lane: 1, message: "boom" });
    expect(lines.some((line) => /lane walls failed for P lane 1: boom/.test(line))).toBe(true);
    expect(client.stats()).toMatchObject({ replies: 2, errors: 1, inFlight: 0 });
    client.forget("P");
    expect(sent[sent.length - 1][0]).toEqual({ type: "forget", pair: "P" });
    expect(client.wallsOf("P")).toEqual([]);
    expect(client.post({ pair: "P", lane: 1, ts: T + 3_000, column: col, snapshot, referenceRows: 5 })).toBe(false);
    const off = createLaneWallsClient({ enabled: false });
    off.configure("P", [{ k: 1, rowClusters: 2 }], OPTIONS);
    expect(off.post({ pair: "P", lane: 1, ts: T, column: col, snapshot, referenceRows: 5 })).toBe(false);
    expect(off.enabled).toBe(false);
    const broken = createLaneWallsClient({ spawn: () => { throw new Error("no threads"); }, log: (line) => lines.push(line) });
    broken.configure("P", [{ k: 1, rowClusters: 2 }], OPTIONS);
    expect(broken.enabled).toBe(false);
    expect(lines.some((line) => /could not start/.test(line))).toBe(true);
  });

  test("a worker that errors or exits drops its walls and what was in flight, stops taking columns and says so; a deliberate stop says nothing (PR #31 review)", () => {
    const col = column(T, 100, [12, 0, 0], [0, 0, 0]);
    const snapshot = { bids: [], asks: [] };
    const walled = [{ id: LANE_ID_BASE + 1, lane: 1, side: "bid", row: 100, span: 1, startTs: T, endTs: null, size: 12, peak: 12, endedBy: null, ratio: 0, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null }];
    for (const [event, payload, said] of [["exit", 1, /lane walls worker exited \(code 1\)/], ["error", new Error("boom"), /lane walls worker died: boom/]]) {
      const handlers = {};
      let receive = null;
      const lines = [];
      const client = createLaneWallsClient({ spawn: (onMessage) => { receive = onMessage; return { postMessage: () => {}, on: (name, fn) => { handlers[name] = fn; } }; }, log: (line) => lines.push(line) });
      client.configure("P", [{ k: 1, rowClusters: 2 }], OPTIONS);
      expect(client.post({ pair: "P", lane: 1, ts: T, column: col, snapshot, referenceRows: 5 })).toBe(true);
      receive({ type: "walls", pair: "P", lane: 1, ts: T, levels: walled });
      expect(client.post({ pair: "P", lane: 1, ts: T + 1_000, column: col, snapshot, referenceRows: 5 })).toBe(true);
      handlers[event](payload);
      expect(client.wallsOf("P")).toEqual([]);
      expect(client.stats()).toMatchObject({ inFlight: 0, pairs: 0, enabled: false });
      expect(client.post({ pair: "P", lane: 1, ts: T + 2_000, column: col, snapshot, referenceRows: 5 })).toBe(false);
      expect(lines.some((line) => said.test(line))).toBe(true);
    }
    const handlers = {};
    const lines = [];
    const stopped = createLaneWallsClient({ spawn: () => ({ postMessage: () => {}, on: (name, fn) => { handlers[name] = fn; } }), log: (line) => lines.push(line) });
    stopped.configure("P", [{ k: 1, rowClusters: 2 }], OPTIONS);
    stopped.stop();
    handlers.exit?.(0);
    expect(lines).toEqual([]);
  });

  test("the real worker thread answers a column", async () => {
    const client = createLaneWallsClient();
    client.configure("P", [{ k: 1, rowClusters: 2 }], OPTIONS);
    const col = column(T, 100, [12, 0, 0], [0, 0, 0]);
    expect(client.post({ pair: "P", lane: 1, ts: T, column: col, snapshot: { bids: [], asks: [] }, referenceRows: 5 })).toBe(true);
    for (let i = 0; i < 200 && client.wallsOf("P").length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.wallsOf("P")).toEqual([expect.objectContaining({ id: LANE_ID_BASE + 1, lane: 1, row: 100 })]);
    client.stop();
  });
});
