"use strict";

const { readHours, probeBack: readProbe, groupOf, isShort, warmHours, afterHours, GROUPS, HOUR_MS, SHORT_MAX_MS, DEFAULT_CONCURRENCY } = require("../../../src/indicators/exhaustion/exhaustion-history");
const { CANDLE_MS } = require("../../../src/indicators/exhaustion/exhaustion-engine");
const { MINUTE, column, frozen, at } = require("../../fixtures/exhaustion/columns");

const NQ = { symbol: "/NQZ26:XCME", marketKind: "FUTURE" };
const HOUR = HOUR_MS;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function host(hours) {
  return hours.flatMap((start) => [column(start, { mid: 100 }), column(start + MINUTE, { mid: 101 })]);
}

function reader(columns, calls = []) {
  return async (pair, fromTs, toTs) => {
    calls.push([fromTs, toTs]);
    await Promise.resolve();
    return { columns: columns.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null };
  };
}

describe("indicators/exhaustion/exhaustion-history", () => {
  test("the short candle lengths are 1m to 30m, each with the hours it needs before and after a span; the long ones have no group", () => {
    expect(SHORT_MAX_MS).toBe(1_800_000);
    expect(CANDLE_MS.filter(isShort)).toEqual([60_000, 120_000, 180_000, 300_000, 900_000, 1_800_000]);
    expect([60_000, 120_000, 180_000].map((ms) => groupOf(ms))).toEqual([GROUPS[0], GROUPS[0], GROUPS[0]]);
    expect(groupOf(300_000)).toEqual({ maxMs: 300_000, warm: 2, after: 2 });
    expect(groupOf(900_000)).toEqual({ maxMs: 900_000, warm: 5, after: 5 });
    expect(groupOf(1_800_000)).toEqual({ maxMs: 1_800_000, warm: 8, after: 8 });
    expect([3_600_000, 86_400_000, 240_000].map((ms) => groupOf(ms))).toEqual([null, null, null]);
    expect([warmHours([MINUTE, 300_000]), afterHours([MINUTE, 1_800_000]), warmHours([]), warmHours([3_600_000])]).toEqual([2, 8, 0, 0]);
    expect([DEFAULT_CONCURRENCY, HOUR_MS]).toEqual([3, 3_600_000]);
  });

  test("reads the span one hour at a time, oldest first, a few reads in flight, and hands each hour over in order with its bounds", async () => {
    const start = at(0);
    const columns = host([start, start + HOUR, start + 2 * HOUR, start + 3 * HOUR]);
    const calls = [];
    const handed = [];
    const result = await readHours({ pair: NQ, fromTs: start, toTs: start + 4 * HOUR, hostColumns: reader(columns, calls), onHour: (hour, bounds) => handed.push([bounds.start, bounds.end, hour.map((c) => c.ts)]) });
    expect(calls).toEqual([[start, start + HOUR], [start + HOUR, start + 2 * HOUR], [start + 2 * HOUR, start + 3 * HOUR], [start + 3 * HOUR, start + 4 * HOUR]]);
    expect(handed).toEqual([[start, start + HOUR, [start, start + MINUTE]], [start + HOUR, start + 2 * HOUR, [start + HOUR, start + HOUR + MINUTE]], [start + 2 * HOUR, start + 3 * HOUR, [start + 2 * HOUR, start + 2 * HOUR + MINUTE]], [start + 3 * HOUR, start + 4 * HOUR, [start + 3 * HOUR, start + 3 * HOUR + MINUTE]]]);
    expect(result).toEqual({ coveredTo: start + 4 * HOUR, read: 4, columns: 8, hours: 4, failed: null, reason: null, stopped: false });
    const later = [];
    const partial = await readHours({ pair: NQ, fromTs: start + 30 * MINUTE, toTs: start + 2 * HOUR, hostColumns: reader(columns, later), onHour: () => {} });
    expect(later).toEqual([[start + 30 * MINUTE, start + 90 * MINUTE], [start + 90 * MINUTE, start + 2 * HOUR]]);
    expect(partial).toMatchObject({ coveredTo: start + 2 * HOUR, hours: 2, columns: 2 });
  });

  test("an hour that lands before its older neighbour waits for it: hours are handed over in order, never more than the concurrency in flight", async () => {
    const start = at(0);
    const columns = host([start, start + HOUR, start + 2 * HOUR, start + 3 * HOUR]);
    const gates = new Map();
    const handed = [];
    const hostColumns = (pair, fromTs, toTs) => new Promise((resolve) => { gates.set(fromTs, () => resolve({ columns: columns.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null })); });
    const read = readHours({ pair: NQ, fromTs: start, toTs: start + 4 * HOUR, concurrency: 2, hostColumns, onHour: (hour, bounds) => handed.push(bounds.start) });
    expect([...gates.keys()]).toEqual([start, start + HOUR]);
    gates.get(start + HOUR)();
    await flush();
    expect(handed).toEqual([]);
    expect([...gates.keys()]).toEqual([start, start + HOUR, start + 2 * HOUR]);
    gates.get(start)();
    await flush();
    expect(handed).toEqual([start, start + HOUR]);
    expect([...gates.keys()]).toEqual([start, start + HOUR, start + 2 * HOUR, start + 3 * HOUR]);
    gates.get(start + 3 * HOUR)();
    await flush();
    expect(handed).toEqual([start, start + HOUR]);
    gates.get(start + 2 * HOUR)();
    const result = await read;
    expect(handed).toEqual([start, start + HOUR, start + 2 * HOUR, start + 3 * HOUR]);
    expect(result).toMatchObject({ coveredTo: start + 4 * HOUR, hours: 4 });
  });

  test("the first failed hour ends the read: the hours before it are handed over, the ones after it never, the coverage stops at it; a read that throws, a malformed answer and a hand-over that throws count as failures", async () => {
    const start = at(0);
    const columns = host([start, start + HOUR, start + 2 * HOUR, start + 3 * HOUR, start + 4 * HOUR]);
    const handed = [];
    const calls = [];
    const failing = async (pair, fromTs, toTs) => {
      calls.push(fromTs);
      await Promise.resolve();
      if (fromTs === start + 2 * HOUR) return { columns: [], reason: "STORAGE_UNAVAILABLE" };
      return { columns: columns.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null };
    };
    const result = await readHours({ pair: NQ, fromTs: start, toTs: start + 5 * HOUR, concurrency: 3, hostColumns: failing, onHour: (hour, bounds) => handed.push(bounds.start) });
    expect(handed).toEqual([start, start + HOUR]);
    expect(calls).toEqual([start, start + HOUR, start + 2 * HOUR, start + 3 * HOUR, start + 4 * HOUR]);
    expect(result).toEqual({ coveredTo: start + 2 * HOUR, read: 5, columns: 4, hours: 2, failed: 2, reason: "STORAGE_UNAVAILABLE", stopped: false });
    const thrown = await readHours({ pair: NQ, fromTs: start, toTs: start + 2 * HOUR, concurrency: 1, hostColumns: async (pair, fromTs) => { if (fromTs === start) throw new Error("socket hang up"); return { columns: [], reason: null }; }, onHour: () => {} });
    expect(thrown).toMatchObject({ coveredTo: start, read: 1, failed: 0, reason: "READ_FAILED: socket hang up" });
    const malformed = await readHours({ pair: NQ, fromTs: start, toTs: start + HOUR, hostColumns: async () => ({ columns: null, reason: null }), onHour: () => {} });
    expect(malformed).toMatchObject({ coveredTo: start, failed: 0, reason: "MALFORMED" });
    const feeding = await readHours({ pair: NQ, fromTs: start, toTs: start + 3 * HOUR, concurrency: 1, hostColumns: reader(columns), onHour: (hour, bounds) => { if (bounds.start === start + HOUR) throw new Error("bad column"); } });
    expect(feeding).toMatchObject({ coveredTo: start + HOUR, hours: 1, failed: 1, reason: "FEED_FAILED: bad column", read: 2 });
  });

  test("a stop ends the read after the reads in flight, whose results are dropped; an empty span reads nothing", async () => {
    const start = at(0);
    const columns = host([start, start + HOUR, start + 2 * HOUR]);
    let reads = 0;
    const handed = [];
    const result = await readHours({ pair: NQ, fromTs: start, toTs: start + 6 * HOUR, concurrency: 1, hostColumns: async (pair, fromTs, toTs) => { reads += 1; return { columns: columns.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null }; }, onHour: (hour, bounds) => handed.push(bounds.start), stopped: () => reads >= 2 });
    expect(reads).toBe(2);
    expect(handed).toEqual([start]);
    expect(result).toMatchObject({ stopped: true, coveredTo: start + HOUR, hours: 1, read: 2 });
    const empty = await readHours({ pair: NQ, fromTs: start, toTs: start, hostColumns: async () => { throw new Error("never"); }, onHour: () => {} });
    expect(empty).toEqual({ coveredTo: start, read: 0, columns: 0, hours: 0, failed: null, reason: null, stopped: false });
  });

  test("the probe counts hours newest first until it has the hours with trades it needs, and names the start of the last one; empty hours and hours of frozen book below the live start are walked past; the floor stops it", async () => {
    const start = at(0);
    const columns = host([start - 30 * HOUR, start - 29 * HOUR, start - 28 * HOUR, start - 2 * HOUR, start - HOUR]);
    const calls = [];
    const probe = await readProbe({ pair: NQ, toTs: start, floorTs: start - 40 * HOUR, needed: 4, hostColumns: reader(columns, calls), concurrency: 2 });
    expect(probe).toEqual({ fromTs: start - 29 * HOUR, read: 30, traded: 4, failed: null, reason: null, stopped: false });
    expect(calls[0]).toEqual([start - HOUR, start]);
    expect(calls[1]).toEqual([start - 2 * HOUR, start - HOUR]);
    expect(calls.at(-1)).toEqual([start - 30 * HOUR, start - 29 * HOUR]);
    const floored = await readProbe({ pair: NQ, toTs: start, floorTs: start - 3 * HOUR + 1000, needed: 4, hostColumns: reader(columns) });
    expect(floored).toMatchObject({ fromTs: start - 3 * HOUR + 1000, read: 3, traded: 2, failed: null });
    const enough = await readProbe({ pair: NQ, toTs: start, floorTs: start - 40 * HOUR, needed: 2, hostColumns: reader(columns), concurrency: 1 });
    expect(enough).toMatchObject({ fromTs: start - 2 * HOUR, read: 2, traded: 2 });
    const closed = [...host([start - 3 * HOUR]), ...Array.from({ length: 12 }, (_, i) => frozen(start - 2 * HOUR + i * 5 * MINUTE, 100)), ...Array.from({ length: 12 }, (_, i) => frozen(start - HOUR + i * 5 * MINUTE, 100))];
    const pastFrozen = await readProbe({ pair: NQ, toTs: start, floorTs: start - 10 * HOUR, needed: 1, hostColumns: reader(closed), concurrency: 1 });
    expect(pastFrozen).toMatchObject({ fromTs: start - 3 * HOUR, read: 3, traded: 1 });
    const empty = await readProbe({ pair: NQ, toTs: start, floorTs: start, needed: 1, hostColumns: async () => { throw new Error("never"); } });
    expect(empty).toEqual({ fromTs: start, read: 0, traded: 0, failed: null, reason: null, stopped: false });
  });

  test("a failed hour ends the probe at the hour above it; a stop ends it with nothing; it refuses bad bounds and numbers", async () => {
    const start = at(0);
    const columns = host([start - 4 * HOUR, start - 3 * HOUR, start - 2 * HOUR, start - HOUR]);
    const failing = async (pair, fromTs, toTs) => {
      await Promise.resolve();
      if (fromTs === start - 3 * HOUR) return { columns: [], reason: "STORAGE_UNAVAILABLE" };
      return { columns: columns.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null };
    };
    const probe = await readProbe({ pair: NQ, toTs: start, floorTs: start - 10 * HOUR, needed: 8, hostColumns: failing, concurrency: 1 });
    expect(probe).toMatchObject({ fromTs: start - 2 * HOUR, read: 3, traded: 2, failed: 2, reason: "STORAGE_UNAVAILABLE" });
    const atOnce = await readProbe({ pair: NQ, toTs: start, floorTs: start - 10 * HOUR, needed: 8, hostColumns: async () => ({ columns: [], reason: "NO_HOST" }), concurrency: 1 });
    expect(atOnce).toMatchObject({ fromTs: start, read: 1, traded: 0, failed: 0, reason: "NO_HOST" });
    let reads = 0;
    const stopping = await readProbe({ pair: NQ, toTs: start, floorTs: start - 10 * HOUR, needed: 8, hostColumns: async (pair, fromTs, toTs) => { reads += 1; return { columns: columns.filter((c) => c.ts >= fromTs && c.ts < toTs), reason: null }; }, concurrency: 1, stopped: () => reads >= 2 });
    expect(stopping).toMatchObject({ fromTs: start, read: 2, stopped: true });
    const ok = { pair: NQ, toTs: start, floorTs: start - HOUR, needed: 1, hostColumns: async () => ({ columns: [], reason: null }) };
    expect(() => readProbe({ ...ok, toTs: 1.5 })).toThrow(/toTs/);
    expect(() => readProbe({ ...ok, needed: 0 })).toThrow(/needed/);
    expect(() => readProbe({ ...ok, hostColumns: null })).toThrow(/hostColumns/);
    expect(() => readProbe({ ...ok, chunkMs: 0 })).toThrow(/chunkMs/);
    expect(() => readProbe({ ...ok, concurrency: 0 })).toThrow(/concurrency/);
  });

  test("refuses non-integer bounds, a missing reader or hand-over and bad numbers", () => {
    const ok = { pair: NQ, fromTs: 0, toTs: HOUR, hostColumns: async () => ({ columns: [], reason: null }), onHour: () => {} };
    expect(() => readHours({ ...ok, fromTs: 1.5 })).toThrow(/fromTs/);
    expect(() => readHours({ ...ok, hostColumns: null })).toThrow(/hostColumns/);
    expect(() => readHours({ ...ok, onHour: 1 })).toThrow(/onHour/);
    expect(() => readHours({ ...ok, chunkMs: 0 })).toThrow(/chunkMs/);
    expect(() => readHours({ ...ok, concurrency: 0 })).toThrow(/concurrency/);
  });
});
