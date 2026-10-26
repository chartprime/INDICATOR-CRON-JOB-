// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { AbsorptionRecord } from "../absorptionEngine";
import { ABSORPTION_HISTORY_STORAGE_KEY, AbsorptionHistoryStore, HISTORY_STORE_KEEP_MS, HISTORY_STORE_MAX_BYTES, RETIRED_HISTORY_STORAGE_KEYS, type StoredHour } from "../absorptionHistoryStore";
import { ABSORPTION_ENGINE_VERSION } from "../absorptionEngine";

const H = 3_600_000;
const NOW = 1_791_300_000_000;

function fakeStorage() {
  const items = new Map<string, string>();
  return { items, getItem(key: string) { return items.get(key) ?? null; }, setItem(key: string, value: string) { items.set(key, value); }, removeItem(key: string) { items.delete(key); } };
}

function record(ts: number, n = 0): AbsorptionRecord {
  const trail = [{ ts, absorbed: 240, current: 170, refills: 0 }, ...Array.from({ length: n }, (_, i) => ({ ts: ts + (i + 1) * 10_000, absorbed: 250 + 10 * i, current: 160, refills: i + 1 }))];
  return { key: `bid:5:4:${ts - 10_000 - n}`, side: "bid", band: 5, rows: 4, ts, attackTs: ts - 10_000 - n, shown: 200, resting: 200, absorbed: 240 + 10 * n, yardstick: 10, refills: n, price: 2600, trail, latest: trail[trail.length - 1], endTs: n === 0 ? null : ts + 60_000, endReason: n === 0 ? null : "closed" };
}

function hours(from: number, count: number, recordsPerHour = 1, plain = false): StoredHour[] {
  const out: StoredHour[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = from + i * H;
    out.push({ start, end: start + H, records: Array.from({ length: recordsPerHour }, (_, n) => record(start + 600_000 + n * 1000, plain ? 0 : n)) });
  }
  return out;
}

describe("the absorption history store", () => {
  it("brings an instrument's judged hours and what was on screen back under the same key, trails and ends with them, and nothing under another", () => {
    const storage = fakeStorage();
    const store = new AbsorptionHistoryStore(storage);
    const saved = hours(NOW - 26 * H, 24, 2);
    store.save("btc@1m", saved, { first: NOW - 25 * H, to: NOW - 2 * H }, NOW);
    const again = new AbsorptionHistoryStore(storage);
    expect(again.load("btc@1m")).toEqual({ hours: saved, shown: { first: NOW - 25 * H, to: NOW - 2 * H } });
    expect(again.load("btc@15m")).toBeNull();
    expect(storage.items.has(ABSORPTION_HISTORY_STORAGE_KEY)).toBe(true);
  });

  it("keeps to a small share of the origin's storage, and names the engine's version in its key so hours judged by an older rule are never read back (PR #47 review)", () => {
    expect(HISTORY_STORE_MAX_BYTES).toBeLessThanOrEqual(512 * 1024);
    expect(ABSORPTION_HISTORY_STORAGE_KEY).toBe(`terminal.absorption-history.v${ABSORPTION_ENGINE_VERSION}`);
    // The records of 2026-10-10 are the sixth engine: hours judged with the old trail, by what a thin book showed, by the per-asset floors or by the numbers alone are never read back.
    expect(ABSORPTION_HISTORY_STORAGE_KEY).toBe("terminal.absorption-history.v6");
  });

  it("retires every history key from v1 up to the one before this engine's, v4 and the ones before it among them, and never this engine's own (PR #48 review)", () => {
    expect(RETIRED_HISTORY_STORAGE_KEYS).toEqual(Array.from({ length: ABSORPTION_ENGINE_VERSION - 1 }, (_, i) => `terminal.absorption-history.v${i + 1}`));
    expect(RETIRED_HISTORY_STORAGE_KEYS).toEqual(expect.arrayContaining(["terminal.absorption-history.v1", "terminal.absorption-history.v2", "terminal.absorption-history.v3", "terminal.absorption-history.v4"]));
    expect(RETIRED_HISTORY_STORAGE_KEYS).not.toContain(ABSORPTION_HISTORY_STORAGE_KEY);
  });

  it("clears the hours saved under every older engine's key as soon as it is made, and keeps this engine's hours and every other key (PR #48 review)", () => {
    const storage = fakeStorage();
    const saved = JSON.stringify({ "btc@1m": { at: NOW, shown: null, hours: hours(NOW - 2 * H, 2) } });
    const older = Array.from({ length: ABSORPTION_ENGINE_VERSION - 1 }, (_, i) => `terminal.absorption-history.v${i + 1}`);
    for (const key of older) storage.items.set(key, saved);
    storage.items.set(ABSORPTION_HISTORY_STORAGE_KEY, saved);
    storage.items.set("terminal.absorption.v6", "kept");
    const store = new AbsorptionHistoryStore(storage);
    expect([...storage.items.keys()].sort()).toEqual([ABSORPTION_HISTORY_STORAGE_KEY, "terminal.absorption.v6"].sort());
    expect(storage.items.get(ABSORPTION_HISTORY_STORAGE_KEY)).toBe(saved);
    expect(storage.items.get("terminal.absorption.v6")).toBe("kept");
    expect(store.load("btc@1m")).toEqual({ hours: hours(NOW - 2 * H, 2), shown: null });
  });

  it("brings this engine's hours back and saves new ones on a storage that cannot remove, and on one whose remove throws (PR #48 review)", () => {
    const saved = JSON.stringify({ "btc@1m": { at: NOW, shown: null, hours: hours(NOW - 2 * H, 2) } });
    for (const refuses of [false, true]) {
      const items = new Map<string, string>([["terminal.absorption-history.v1", saved], [ABSORPTION_HISTORY_STORAGE_KEY, saved]]);
      const getItem = (key: string) => items.get(key) ?? null;
      const setItem = (key: string, value: string) => { items.set(key, value); };
      const removeItem = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
      const store = new AbsorptionHistoryStore(refuses ? { getItem, setItem, removeItem } : { getItem, setItem });
      expect(store.load("btc@1m")).toEqual({ hours: hours(NOW - 2 * H, 2), shown: null });
      store.save("eth@1m", hours(NOW - H, 1), null, NOW);
      expect(new AbsorptionHistoryStore({ getItem, setItem }).load("eth@1m")).toEqual({ hours: hours(NOW - H, 1), shown: null });
    }
  });

  it("reads back only whole records of this engine: one saved without its trail, or with an end it cannot read, is dropped", () => {
    const storage = fakeStorage();
    const { trail: _trail, ...bare } = record(NOW - H);
    const oddEnd = { ...record(NOW - H + 2000, 1), endReason: "window" };
    storage.items.set(ABSORPTION_HISTORY_STORAGE_KEY, JSON.stringify({ x: { at: NOW, shown: null, hours: [{ start: NOW - H, end: NOW, records: [bare, record(NOW - H + 1000), oddEnd] }] } }));
    expect(new AbsorptionHistoryStore(storage).load("x")?.hours[0].records).toEqual([record(NOW - H + 1000)]);
  });

  it("cuts a key over the budget on its own to its newest hours, and what was on screen to the hours it kept (PR #47 review)", () => {
    const storage = fakeStorage();
    const store = new AbsorptionHistoryStore(storage);
    const perHour = Math.ceil(HISTORY_STORE_MAX_BYTES / (200 * 24)) + 1;
    store.save("big", hours(NOW - 48 * H, 48, perHour), { first: NOW - 48 * H, to: NOW }, NOW);
    expect(storage.items.get(ABSORPTION_HISTORY_STORAGE_KEY)!.length).toBeLessThanOrEqual(HISTORY_STORE_MAX_BYTES);
    const kept = store.load("big")!;
    expect(kept.hours.length).toBeGreaterThan(0);
    expect(kept.hours.length).toBeLessThan(48);
    expect(kept.hours[kept.hours.length - 1].start).toBe(NOW - H);
    expect(kept.hours.map((hour) => hour.start)).toEqual(Array.from({ length: kept.hours.length }, (_, i) => NOW - (kept.hours.length - i) * H));
    expect(kept.shown).toEqual({ first: kept.hours[0].start, to: NOW });
    expect(new AbsorptionHistoryStore(storage).load("big")).toEqual(kept);
    store.save("old", hours(NOW - 48 * H, 48, perHour), { first: NOW - 48 * H, to: NOW - 40 * H }, NOW);
    expect(store.load("old")?.shown).toBeNull();
    expect(store.load("big")).toBeNull();
  });

  it("drops hours older than eight days, mangled entries, and the least recently used keys once over its budget", () => {
    const storage = fakeStorage();
    const store = new AbsorptionHistoryStore(storage);
    store.save("old", hours(NOW - HISTORY_STORE_KEEP_MS - 3 * H, 2).concat(hours(NOW - 2 * H, 1)), null, NOW);
    expect(store.load("old")?.hours.map((hour) => hour.start)).toEqual([NOW - 2 * H]);
    // Four keys of a little over a quarter of the budget each (plain records, so the size grows evenly with the
    // count): the fourth puts the store over, the key used longest ago goes, and the three others stay whole.
    const bytesOf = (perHour: number) => JSON.stringify(hours(NOW - 24 * H, 24, perHour, true)).length;
    let perHour = 1;
    while (bytesOf(perHour) < 0.28 * HISTORY_STORE_MAX_BYTES) perHour += 1;
    expect(bytesOf(perHour)).toBeLessThan(0.3 * HISTORY_STORE_MAX_BYTES);
    store.save("a", hours(NOW - 24 * H, 24, perHour, true), null, NOW - 3 * H);
    store.save("b", hours(NOW - 24 * H, 24, perHour, true), null, NOW - 2 * H);
    store.save("c", hours(NOW - 24 * H, 24, perHour, true), null, NOW - H);
    expect(storage.items.get(ABSORPTION_HISTORY_STORAGE_KEY)!.length).toBeGreaterThan(0.8 * HISTORY_STORE_MAX_BYTES);
    store.save("d", hours(NOW - 24 * H, 24, perHour, true), null, NOW);
    expect(storage.items.get(ABSORPTION_HISTORY_STORAGE_KEY)!.length).toBeLessThanOrEqual(HISTORY_STORE_MAX_BYTES);
    expect(store.load("d")).not.toBeNull();
    expect(store.load("c")).not.toBeNull();
    expect(store.load("b")).not.toBeNull();
    expect(store.load("a")).toBeNull();
    storage.items.set(ABSORPTION_HISTORY_STORAGE_KEY, JSON.stringify({ x: { at: NOW, shown: null, hours: [{ start: 1, end: 2, records: [{ key: "k" }] }, { start: "no" }] } }));
    expect(new AbsorptionHistoryStore(storage).load("x")).toEqual({ hours: [{ start: 1, end: 2, records: [] }], shown: null });
    storage.items.set(ABSORPTION_HISTORY_STORAGE_KEY, "{not json");
    expect(new AbsorptionHistoryStore(storage).load("x")).toBeNull();
  });
});
