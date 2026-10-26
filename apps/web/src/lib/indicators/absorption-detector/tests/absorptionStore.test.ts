// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AbsorptionRecord, AbsorptionTrailEntry } from "../absorptionEngine";
import { ABSORPTION_STORAGE_KEY, AbsorptionStore, MAX_RECORDS_PER_WALLS, PRINT_KEEP_MS, RETIRED_STORAGE_KEYS, STORE_MAX_BYTES, STORE_SAVE_INTERVAL_MS, STORE_WRITE_ATTEMPTS, mergeRecords } from "../absorptionStore";

const T = 1_700_000_000_000;
const record = (ts: number, over: Partial<AbsorptionRecord> = {}): AbsorptionRecord => {
  const base = { side: "bid" as const, band: 5, rows: 4, ts, attackTs: ts - 10_000, shown: 200, resting: 200, absorbed: 240, yardstick: 10, refills: 0, price: 88, trail: [{ ts, absorbed: 240, current: 40, refills: 0 }], endTs: null, endReason: null, ...over };
  return { ...base, latest: base.latest ?? base.trail[base.trail.length - 1], key: `${base.side}:${base.band}:${base.rows}:${base.attackTs}` };
};
// A record whose trail holds `n` columns: the budget is counted in characters, and a trail is most of them.
const heavy = (ts: number, n: number, over: Partial<AbsorptionRecord> = {}): AbsorptionRecord =>
  record(ts, { trail: Array.from({ length: n }, (_, i): AbsorptionTrailEntry => ({ ts: ts + i * 1_000, absorbed: 240 + i, current: 40, refills: 0 })), ...over });

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  items = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.items.set(key, value);
  }
}

// The browser's storage once the origin's quota is nearly used: a value longer than the room left is refused.
class FullStorage extends MemoryStorage {
  room: number;
  refused = 0;
  constructor(room: number) {
    super();
    this.room = room;
  }
  override setItem(key: string, value: string): void {
    if (value.length > this.room) {
      this.refused += 1;
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }
    super.setItem(key, value);
  }
}

describe("mergeRecords", () => {
  it("only ever adds: an attack recorded once stays when a later read no longer finds it", () => {
    // The store's one rule, the trader's of 2026-09-20: printed is kept. A rebuild on a book that landed late, a page that
    // lost its columns, a wall the tracker no longer sees -- none of it takes a sphere away.
    const kept = mergeRecords([record(T), record(T + 60_000)], [], T + 120_000);
    expect(kept.map((r) => r.ts)).toEqual([T, T + 60_000]);
    expect(mergeRecords(kept, [record(T + 60_000)], T + 120_000).map((r) => r.ts)).toEqual([T, T + 60_000]);
  });

  it("takes each attack once by key, and keeps them in time order", () => {
    const merged = mergeRecords([record(T + 60_000)], [record(T + 60_000), record(T + 30_000), record(T + 30_000, { band: 6 })], T + 120_000);
    expect(merged.map((r) => [r.ts - T, r.band])).toEqual([[30_000, 5], [30_000, 6], [60_000, 5]]);
  });

  it("lets a record of the same attack grow: more absorbed, a longer trail, a refill or the wall's end replace what was kept; the same record again changes nothing", () => {
    // The record is one an attack and the engine keeps feeding it: what the store holds must follow, or a reload would
    // show the first reading of the attack for ever.
    const first = record(T);
    const kept = mergeRecords([], [first], T + 1);
    expect(mergeRecords(kept, [record(T)], T + 2)).toBe(kept);
    expect(mergeRecords(kept, [record(T, { absorbed: 900 })], T + 2).map((r) => r.absorbed)).toEqual([900]);
    const longer = record(T, { trail: [{ ts: T, absorbed: 240, current: 40, refills: 0 }, { ts: T + 10_000, absorbed: 240, current: 30, refills: 0 }] });
    expect(mergeRecords(kept, [longer], T + 2).map((r) => r.trail.length)).toEqual([2]);
    expect(mergeRecords(kept, [record(T, { refills: 2 })], T + 2).map((r) => r.refills)).toEqual([2]);
    expect(mergeRecords(kept, [record(T, { endTs: T + 30_000, endReason: "closed" })], T + 2).map((r) => r.endReason)).toEqual(["closed"]);
    // The newest reading moving on with the flow already counted (the hit came while the price was through the band, the
    // reading on the next column back on the wall's side): the strong ring reads it (PR #48 review).
    const ahead = mergeRecords([], [record(T, { absorbed: 260 })], T + 1);
    const caughtUp = record(T, { absorbed: 260, latest: { ts: T + 10_000, absorbed: 260, current: 35, refills: 0 } });
    expect(mergeRecords(ahead, [caughtUp], T + 2).map((r) => r.latest)).toEqual([caughtUp.latest]);
    // Never backwards: a thinner reading of the same attack (a live tracker started late) leaves the fuller one.
    const full = mergeRecords([], [record(T, { absorbed: 900, refills: 2, trail: longer.trail, endTs: T + 30_000, endReason: "closed" })], T + 1);
    expect(mergeRecords(full, [record(T)], T + 2)).toBe(full);
  });

  it("keeps a week and at most five hundred an instrument, the newest", () => {
    const old = record(T - PRINT_KEEP_MS - 1);
    const edge = record(T - PRINT_KEEP_MS);
    expect(mergeRecords([old, edge], [], T).map((r) => r.ts)).toEqual([edge.ts]);
    const many = Array.from({ length: MAX_RECORDS_PER_WALLS + 20 }, (_, i) => record(T + i * 1000));
    const capped = mergeRecords([], many, T + 1_000_000);
    expect(capped).toHaveLength(MAX_RECORDS_PER_WALLS);
    expect(capped[0].ts).toBe(T + 20_000);
    expect(capped[capped.length - 1].ts).toBe(T + (MAX_RECORDS_PER_WALLS + 19) * 1000);
  });

  it("returns the same array when nothing changes, so a caller can tell a quiet read from a new record", () => {
    const existing = [record(T)];
    expect(mergeRecords(existing, [record(T)], T + 1)).toBe(existing);
    expect(mergeRecords(existing, [record(T + 1)], T + 1)).not.toBe(existing);
  });

  it("takes back no record the cap let go: the tracker's whole list again returns the same array, and a newer or a grown record still changes it (PR #48 review)", () => {
    // The tracker keeps every record since its last reset and hands them all over on every recompute: once it holds more
    // than the cap, the oldest it hands over are the ones the cap let go, and taking them back rewrote the store each time.
    const many = Array.from({ length: MAX_RECORDS_PER_WALLS + 20 }, (_, i) => record(T + i * 1000));
    const capped = mergeRecords([], many, T + 1_000_000);
    expect(mergeRecords(capped, many, T + 1_000_001)).toBe(capped);
    const newer = record(T + (MAX_RECORDS_PER_WALLS + 20) * 1000);
    expect(mergeRecords(capped, [...many, newer], T + 1_000_001).at(-1)).toBe(newer);
    const grown = record(T + 100_000, { absorbed: 900 });
    expect(mergeRecords(capped, [...many, grown], T + 1_000_001).find((r) => r.key === grown.key)).toBe(grown);
  });
});

describe("AbsorptionStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps each set of walls' records apart under one key, and writes only when something was added", () => {
    const storage = new MemoryStorage();
    const store = new AbsorptionStore(storage);
    expect(store.load("BINANCE:PERPETUAL:BTC-USDT")).toEqual([]);
    expect(store.add("BINANCE:PERPETUAL:BTC-USDT", [record(T)], T + 1).map((r) => r.ts)).toEqual([T]);
    expect(storage.writes).toBe(1);
    store.add("BINANCE:PERPETUAL:BTC-USDT", [record(T)], T + 1 + STORE_SAVE_INTERVAL_MS);
    expect(storage.writes).toBe(1);
    store.add("BINANCE:PERPETUAL:ETH-USDT", [record(T + 5)], T + 1 + 2 * STORE_SAVE_INTERVAL_MS);
    expect(storage.writes).toBe(2);
    expect(store.load("BINANCE:PERPETUAL:BTC-USDT").map((r) => r.ts)).toEqual([T]);
    expect(store.load("BINANCE:PERPETUAL:ETH-USDT").map((r) => r.ts)).toEqual([T + 5]);
    // What is written reads back through a fresh store, under the one key, the trail and the wall's end with it.
    const ended = record(T + 9, { trail: [{ ts: T + 9, absorbed: 240, current: 40, refills: 0 }, { ts: T + 19, absorbed: 300, current: 30, refills: 1 }], endTs: T + 29, endReason: "closed" });
    store.add("BINANCE:PERPETUAL:BTC-USDT", [ended], T + 1 + 3 * STORE_SAVE_INTERVAL_MS);
    const again = new AbsorptionStore(storage);
    expect(again.load("BINANCE:PERPETUAL:BTC-USDT")).toEqual([record(T), ended]);
    expect(storage.items.has(ABSORPTION_STORAGE_KEY)).toBe(true);
    expect(storage.items.size).toBe(1);
  });

  it("survives a storage that is missing, throws or holds rubbish, and reads back only whole records of this engine", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(new AbsorptionStore(null).add("x", [record(T)], T).map((r) => r.ts)).toEqual([T]);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const store = new AbsorptionStore(broken);
    expect(store.load("x")).toEqual([]);
    expect(store.add("x", [record(T)], T).map((r) => r.ts)).toEqual([T]);
    const rubbish = new MemoryStorage();
    rubbish.items.set(ABSORPTION_STORAGE_KEY, "{not json");
    expect(new AbsorptionStore(rubbish).load("x")).toEqual([]);
    // A sphere of the engine before records (no trail, no end), a trail without its columns, an empty trail, an end without
    // a time, an unknown end, a record of the trail before the ladder (no newest reading), a newest reading without its
    // columns: none read back.
    const { trail: _trail, endTs: _endTs, endReason: _endReason, ...sphere } = record(T + 1);
    const reading = { ts: T + 2, absorbed: 240, current: 40, refills: 0 };
    const bareTrail = record(T + 2, { trail: [{ ts: T + 2 } as never], latest: reading });
    const emptyTrail = record(T + 3, { trail: [], latest: reading });
    const halfEnded = record(T + 4, { endTs: null, endReason: "closed" });
    const oddEnd = record(T + 5, { endTs: T + 6, endReason: "hole" as never });
    const { latest: _latest, ...noLatest } = record(T + 6);
    const bareLatest = record(T + 7, { latest: { ts: T + 7 } as never });
    rubbish.items.set(ABSORPTION_STORAGE_KEY, JSON.stringify({ x: { at: T, from: 0, records: [{ key: "k", side: "bid" }, 7, sphere, bareTrail, emptyTrail, halfEnded, oddEnd, noLatest, bareLatest, record(T)] } }));
    expect(new AbsorptionStore(rubbish).load("x")).toEqual([record(T)]);
    // An instrument without the time it was used, or without its list, reads as nothing; a mangled floor reads as none.
    rubbish.items.set(ABSORPTION_STORAGE_KEY, JSON.stringify({ x: { at: "then", from: 0, records: [record(T)] }, y: { at: T, from: 0, records: "none" }, z: { at: T, from: "late", records: [record(T)] } }));
    const mangled = new AbsorptionStore(rubbish);
    expect(mangled.load("x")).toEqual([]);
    expect(mangled.load("y")).toEqual([]);
    expect(mangled.add("z", [record(T + 1)], T + 2)).toEqual([record(T), record(T + 1)]);
  });

  // 2026-10-07: the spheres saved by the per-asset rule (v2) and by the modular rule before records (v3) are dropped with
  // the v1 ones: a record carries its trail, and nothing without one can be read at the rule's numbers.
  // 2026-10-10: v7 keeps each entry with the time it was last added to, so the budget can let the one used longest ago
  // go first; the v6 lists, a bare list per instrument and no budget, go with the older keys (PR #48 review).
  // 2026-10-13: v8 files records under the walls they were read with (the engine's own key); v7 filed them under the
  // instrument alone, so every change of the heatmap's band or scale added a full set beside the one before.
  it("saves under v8 and clears the records saved under v1 to v7, reads a bare v6 list found under the new key as nothing, and works on a storage that cannot remove", () => {
    expect(ABSORPTION_STORAGE_KEY).toBe("terminal.absorption.v8");
    expect(RETIRED_STORAGE_KEYS).toEqual(["terminal.absorption.v1", "terminal.absorption.v2", "terminal.absorption.v3", "terminal.absorption.v4", "terminal.absorption.v5", "terminal.absorption.v6", "terminal.absorption.v7"]);
    const items = new Map<string, string>([["terminal.absorption.v1", "[]"], ["terminal.absorption.v2", "[]"], ["terminal.absorption.v3", JSON.stringify({ x: [record(T)] })], ["terminal.absorption.v4", JSON.stringify({ x: [record(T)] })], ["terminal.absorption.v5", JSON.stringify({ x: [record(T)] })], ["terminal.absorption.v6", JSON.stringify({ x: [record(T)] })], ["terminal.absorption.v7", JSON.stringify({ x: { at: T, from: 0, records: [record(T)] } })], ["other", "kept"]]);
    const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
    const store = new AbsorptionStore(storage);
    expect([...items.keys()]).toEqual(["other"]);
    expect(store.load("x")).toEqual([]);
    const bare = new AbsorptionStore({ getItem: () => null, setItem: () => undefined });
    expect(bare.load("x")).toEqual([]);
    const stale = new MemoryStorage();
    stale.items.set(ABSORPTION_STORAGE_KEY, JSON.stringify({ x: [record(T)] }));
    const read = new AbsorptionStore(stale);
    expect(read.load("x")).toEqual([]);
    read.add("x", [record(T + 1)], T + 2);
    expect(new AbsorptionStore(stale).load("x")).toEqual([record(T + 1)]);
  });

  it("writes the first record at once, then at most once every five seconds: load sees each record at once, and the first add past the interval writes what was held, even one that adds nothing (PR #48 review)", () => {
    expect(STORE_SAVE_INTERVAL_MS).toBe(5_000);
    const storage = new MemoryStorage();
    const store = new AbsorptionStore(storage);
    store.add("x", [record(T)], T);
    expect(storage.writes).toBe(1);
    store.add("x", [record(T + 1_000)], T + 1_000);
    store.add("y", [record(T + 2_000)], T + STORE_SAVE_INTERVAL_MS - 1);
    expect(storage.writes).toBe(1);
    expect(store.load("x").map((r) => r.ts)).toEqual([T, T + 1_000]);
    expect(store.load("y").map((r) => r.ts)).toEqual([T + 2_000]);
    expect(new AbsorptionStore(storage).load("x").map((r) => r.ts)).toEqual([T]);
    // The tracker hands the same list again once the interval is up: what was held goes out with it.
    store.add("x", [record(T + 1_000)], T + STORE_SAVE_INTERVAL_MS);
    expect(storage.writes).toBe(2);
    const again = new AbsorptionStore(storage);
    expect(again.load("x").map((r) => r.ts)).toEqual([T, T + 1_000]);
    expect(again.load("y").map((r) => r.ts)).toEqual([T + 2_000]);
    // Nothing held: a quiet spell writes nothing, and does not hold back the next record.
    store.add("x", [record(T + 1_000)], T + 3 * STORE_SAVE_INTERVAL_MS);
    expect(storage.writes).toBe(2);
    store.add("x", [record(T + 3 * STORE_SAVE_INTERVAL_MS)], T + 3 * STORE_SAVE_INTERVAL_MS + 1);
    expect(storage.writes).toBe(3);
  });

  it("flush writes a store holding unsaved records at once, and nothing when everything is saved (PR #48 review)", () => {
    const storage = new MemoryStorage();
    const store = new AbsorptionStore(storage);
    store.flush();
    expect(storage.writes).toBe(0);
    store.add("x", [record(T)], T);
    store.add("x", [record(T + 1_000)], T + 1_000);
    expect(storage.writes).toBe(1);
    store.flush();
    expect(storage.writes).toBe(2);
    expect(new AbsorptionStore(storage).load("x").map((r) => r.ts)).toEqual([T, T + 1_000]);
    store.flush();
    store.add("x", [record(T + 1_000)], T + 2_000);
    store.flush();
    expect(storage.writes).toBe(2);
  });

  it("writes what the tracker grows in place: the same record handed over again, its newest reading, its flow, a new trail entry and its wall's end, each saved (PR #48 review)", () => {
    // The tracker hands over the same record on every recompute and grows it in place. Were the store to keep that very
    // record, each reading would be compared with itself, found no fuller, and never written.
    const storage = new MemoryStorage();
    const store = new AbsorptionStore(storage);
    const live = record(T, { absorbed: 260 });
    let now = T + 1;
    store.add("x", [live], now);
    const saved = () => new AbsorptionStore(storage).load("x")[0];
    const grow = (change: () => void) => {
      change();
      now += STORE_SAVE_INTERVAL_MS;
      store.add("x", [live], now);
      return saved();
    };
    expect(grow(() => { live.latest = { ts: T + 10_000, absorbed: 260, current: 35, refills: 0 }; }).latest.ts).toBe(T + 10_000);
    expect(grow(() => { live.absorbed = 320; live.latest = { ts: T + 20_000, absorbed: 320, current: 30, refills: 0 }; }).absorbed).toBe(320);
    const entry = { ts: T + 30_000, absorbed: 400, current: 25, refills: 0 };
    expect(grow(() => { live.absorbed = 400; live.latest = entry; live.trail.push(entry); }).trail).toEqual([{ ts: T, absorbed: 240, current: 40, refills: 0 }, entry]);
    expect(grow(() => { live.endTs = T + 40_000; live.endReason = "closed"; }).endReason).toBe("closed");
    expect(storage.writes).toBe(5);
    expect(store.load("x")).toEqual([live]);
    expect(saved()).toEqual(live);
  });

  it("holds the record as it merged it: the tracker growing its own after an add changes nothing the store holds until the next add, its trail and newest reading from the same moment (PR #48 review)", () => {
    const store = new AbsorptionStore(new MemoryStorage());
    const live = record(T);
    store.add("x", [live], T + 1);
    const entry = { ts: T + 10_000, absorbed: 300, current: 30, refills: 0 };
    live.absorbed = 300;
    live.latest = entry;
    live.trail.push(entry);
    const [held] = store.load("x");
    expect([held.trail.length, held.latest.ts, held.absorbed]).toEqual([1, T, 240]);
    store.add("x", [live], T + 2);
    const [grown] = store.load("x");
    expect([grown.trail.length, grown.latest.ts, grown.absorbed]).toEqual([2, T + 10_000, 300]);
  });

  it("keeps the store within its budget: over it, the instruments used longest ago go first and whole, and never the one being saved (PR #48 review)", () => {
    // The store at the cap, as measured in review: up to 16.8 M characters over eight instruments, past the origin's ~5 M.
    expect(STORE_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024);
    const size = JSON.stringify(heavy(T, 40)).length + 1;
    const count = Math.ceil((0.36 * STORE_MAX_BYTES) / size);
    const list = (n = count) => Array.from({ length: n }, (_, i) => heavy(T + i * 1_000, 40));
    expect(JSON.stringify(list()).length).toBeLessThan(0.4 * STORE_MAX_BYTES);
    const storage = new MemoryStorage();
    const store = new AbsorptionStore(storage);
    store.add("a", list(), T + count * 1_000);
    store.add("b", list(), T + count * 1_000 + STORE_SAVE_INTERVAL_MS);
    // "a" is used again after "b": the one used longest ago is now "b", whatever the order they came in.
    store.add("a", list(count + 1), T + count * 1_000 + 2 * STORE_SAVE_INTERVAL_MS);
    expect(storage.items.get(ABSORPTION_STORAGE_KEY)!.length).toBeGreaterThan(0.7 * STORE_MAX_BYTES);
    store.add("c", list(), T + count * 1_000 + 3 * STORE_SAVE_INTERVAL_MS);
    expect(storage.writes).toBe(4);
    expect(storage.items.get(ABSORPTION_STORAGE_KEY)!.length).toBeLessThanOrEqual(STORE_MAX_BYTES);
    for (const kept of [store, new AbsorptionStore(storage)]) {
      expect(kept.load("b")).toEqual([]);
      expect(kept.load("a")).toEqual(list(count + 1));
      expect(kept.load("c")).toEqual(list());
    }
  });

  it("cuts an instrument over the budget on its own to its newest records, a whole column at a time, and never takes back a record it let go, after a reload too (PR #48 review)", () => {
    // The oldest column holds the attacks of 120 bands, then five bands a column, a second apart: about a third over the
    // budget, reached inside that first column. The tracker hands the whole list over.
    const size = JSON.stringify(heavy(T, 60)).length + 1;
    const wide = Array.from({ length: 120 }, (_, i) => heavy(T, 60, { band: 5 + i }));
    const columns = Math.ceil((1.3 * STORE_MAX_BYTES - wide.length * size) / (5 * size));
    const records = [...wide, ...Array.from({ length: 5 * columns }, (_, i) => heavy(T + (1 + Math.floor(i / 5)) * 1_000, 60, { band: 5 + (i % 5) }))];
    expect(records.length).toBeLessThanOrEqual(MAX_RECORDS_PER_WALLS);
    expect(JSON.stringify(records).length - STORE_MAX_BYTES).toBeLessThan(0.8 * JSON.stringify(wide).length);
    const now = T + (columns + 1) * 1_000;
    const storage = new MemoryStorage();
    const store = new AbsorptionStore(storage);
    store.add("x", records, now);
    expect(storage.items.get(ABSORPTION_STORAGE_KEY)!.length).toBeLessThanOrEqual(STORE_MAX_BYTES);
    const kept = store.load("x");
    expect(kept).toEqual(records.slice(wide.length));
    expect(new AbsorptionStore(storage).load("x")).toEqual(kept);
    // The same list on the next recompute, and on the first after a reload: what was let go stays out, nothing is written.
    expect(store.add("x", records, now + STORE_SAVE_INTERVAL_MS)).toBe(kept);
    const reloaded = new AbsorptionStore(storage);
    const read = reloaded.load("x");
    expect(reloaded.add("x", records, now + STORE_SAVE_INTERVAL_MS)).toBe(read);
    store.flush();
    reloaded.flush();
    expect(storage.writes).toBe(1);
    // A kept record grows: it is written, and what was let go still stays out.
    const grown = { ...kept[kept.length - 1], refills: 1 };
    store.add("x", [grown], now + 2 * STORE_SAVE_INTERVAL_MS);
    expect(storage.writes).toBe(2);
    const held = store.load("x");
    expect(store.add("x", records, now + 3 * STORE_SAVE_INTERVAL_MS)).toBe(held);
    // A new column is taken as ever, and the oldest kept make room for it.
    const next = heavy(now, 60);
    store.add("x", [...records, next], now + 4 * STORE_SAVE_INTERVAL_MS);
    expect(storage.writes).toBe(3);
    expect(store.load("x").at(-1)).toEqual(next);
    expect(storage.items.get(ABSORPTION_STORAGE_KEY)!.length).toBeLessThanOrEqual(STORE_MAX_BYTES);
  });

  it("on a full storage, lets the instruments used longest ago go first and then its own oldest records, retries at half the size, and keeps to the size that fit for the rest of the session (PR #48 review)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const size = JSON.stringify(heavy(T, 60)).length + 1;
    const list = (share: number) => Array.from({ length: Math.ceil((share * STORE_MAX_BYTES) / size) }, (_, i) => heavy(T + i * 1_000, 60));
    const storage = new FullStorage(Math.floor(0.4 * STORE_MAX_BYTES));
    const store = new AbsorptionStore(storage);
    store.add("old", list(0.35), T + 600_000);
    expect(storage.writes).toBe(1);
    // 0.6 of the budget is refused; at half of it "old" goes, and "own" fits whole.
    store.add("own", list(0.25), T + 600_000 + STORE_SAVE_INTERVAL_MS);
    expect(storage.refused).toBe(1);
    expect(storage.writes).toBe(2);
    expect(store.load("old")).toEqual([]);
    expect(store.load("own")).toEqual(list(0.25));
    expect(new AbsorptionStore(storage).load("own")).toEqual(list(0.25));
    const fitted = storage.items.get(ABSORPTION_STORAGE_KEY)!.length;
    // "own" grows past the room left: the store cuts its oldest to the size that fit rather than meet the full storage again.
    store.add("own", list(0.5), T + 600_000 + 2 * STORE_SAVE_INTERVAL_MS);
    expect(storage.refused).toBe(1);
    expect(storage.writes).toBe(3);
    expect(storage.items.get(ABSORPTION_STORAGE_KEY)!.length).toBeLessThanOrEqual(fitted);
    expect(store.load("own").at(-1)).toEqual(list(0.5).at(-1));
    expect(warn).not.toHaveBeenCalled();
  });

  it("on a storage that refuses every write, warns once with what failed, writes no more this session, and still serves every record from memory (PR #48 review)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tried: string[] = [];
    const storage = { getItem: () => null, setItem: (_key: string, value: string) => { tried.push(value); throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); } };
    const store = new AbsorptionStore(storage);
    const records = Array.from({ length: 16 }, (_, i) => record(T + i * 1_000));
    store.add("x", records, T + 16_000);
    expect(tried.length).toBeGreaterThan(1);
    expect(tried.length).toBeLessThanOrEqual(STORE_WRITE_ATTEMPTS);
    for (let i = 1; i < tried.length; i += 1) expect(tried[i].length).toBeLessThanOrEqual(tried[i - 1].length / 2);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    const left = (JSON.parse(tried[tried.length - 1]) as { x: { records: unknown[] } }).x.records.length;
    expect(message).toContain("QuotaExceededError");
    expect(message).toContain(`${tried[0].length} characters`);
    expect(message).toContain(`${records.length - left} records`);
    const attempts = tried.length;
    store.add("y", [record(T)], T + 16_000 + STORE_SAVE_INTERVAL_MS);
    store.add("x", [record(T + 20_000)], T + 16_000 + 2 * STORE_SAVE_INTERVAL_MS);
    store.flush();
    expect(tried).toHaveLength(attempts);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(store.load("x")).toEqual([...records, record(T + 20_000)]);
    expect(store.load("y")).toEqual([record(T)]);
  });
});
