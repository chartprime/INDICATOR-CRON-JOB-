import { describe, expect, it } from "vitest";
import type { L2Wall } from "../../../l2/types";
import { WhaleWallStore, heatOf, visibleRange, wallKey, wallUsd, type SelectionOptions, type WhaleBands } from "../wallStore";

const T = 1_790_000_000_000;
const BANDS: WhaleBands = { p50: 8_000_000, p75: 12_000_000, p90: 18_000_000, p95: 24_000_000, p99: 40_000_000 };

function wall(over: Partial<L2Wall> = {}): L2Wall {
  return { id: 1, lane: 0, side: "bid", row: 100, span: 1, startTs: T, endTs: T + 60_000, size: 0, peak: 5, endedBy: "pulled", ratio: 2, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: null, ...over };
}

function options(over: Partial<SelectionOptions> = {}): SelectionOptions {
  return { cutUsd: 0, fills: true, outcomes: [true, true, true, true, true], side: "both", fromTs: 0, bands: BANDS, ...over };
}

describe("whale wall store: what is kept, from where, and in what order", () => {
  it("keys a wall by side, row, span and start, and reads its price extent and dollar size from the row width", () => {
    const w = wall({ row: 100, span: 2, peak: 5 });
    expect(wallKey(w)).toBe(`bid|100|2|${T}`);
    expect(wallUsd(w, 4)).toBe(5 * 101 * 4);
    const store = new WhaleWallStore();
    store.addHost([w], 4);
    const [only] = store.select(options()).walls;
    expect([only.lo, only.hi, only.usd, only.side, only.outcome, only.source]).toEqual([400, 408, 2020, 0, 3, "host"]);
  });

  it("lets a host wall replace a live copy of itself, keeps the longer-lived of two from one source, and ignores what is still standing or cannot be read", () => {
    const store = new WhaleWallStore();
    const long = wall({ endTs: T + 90_000 });
    const short = wall({ endTs: T + 30_000 });
    expect(store.addLive([short], 4)).toBe(1);
    expect(store.addHost([short], 4)).toBe(1);
    expect(store.select(options()).walls[0].source).toBe("host");
    expect(store.addLive([long], 4)).toBe(0);
    expect(store.select(options()).walls[0].end).toBe(T + 30_000);
    expect(store.addHost([long], 4)).toBe(1);
    expect(store.select(options()).walls[0].end).toBe(T + 90_000);
    expect(store.addHost([short], 4)).toBe(0);
    expect(store.select(options()).walls[0].end).toBe(T + 90_000);
    expect(store.addLive([wall({ row: 7, endTs: T + 5_000 })], 4)).toBe(1);
    expect(store.addLive([wall({ row: 7, endTs: T + 80_000 })], 4)).toBe(1);
    expect(store.addLive([wall({ row: 7, endTs: T + 10_000 })], 4)).toBe(0);
    expect(store.addHost([wall({ row: 8, endTs: null, endedBy: null })], 4)).toBe(0);
    expect(store.addHost([wall({ row: 9, endedBy: null })], 4)).toBe(0);
    expect(store.addHost([wall({ row: 11, endTs: null, endedBy: "filled" })], 4)).toBe(0);
    expect(store.addHost([wall({ row: 10 })], 0)).toBe(0);
    expect(store.size).toBe(2);
  });

  it("lets a host wall stand in for the live copy of the same wall when their start times differ, whichever arrives first, and keeps walls that only share a price or a time", () => {
    const hostWall = wall({ startTs: T, endTs: T + 60_000 });
    const liveCopy = wall({ startTs: T + 2_000, endTs: T + 59_000 });
    const hostFirst = new WhaleWallStore();
    expect(hostFirst.addHost([hostWall], 4)).toBe(1);
    expect(hostFirst.addLive([liveCopy], 4)).toBe(0);
    expect(hostFirst.size).toBe(1);
    const liveFirst = new WhaleWallStore();
    expect(liveFirst.addLive([liveCopy], 4)).toBe(1);
    expect(liveFirst.addHost([hostWall], 4)).toBe(1);
    expect([liveFirst.size, liveFirst.select(options()).walls[0].source, liveFirst.select(options()).walls[0].start]).toEqual([1, "host", T]);
    const apart = new WhaleWallStore();
    apart.addHost([hostWall], 4);
    expect(apart.addLive([wall({ startTs: T + 60_000, endTs: T + 90_000 })], 4)).toBe(1);
    expect(apart.addLive([wall({ row: 101, startTs: T + 2_000, endTs: T + 59_000 })], 4)).toBe(1);
    expect(apart.addLive([wall({ span: 2, startTs: T + 2_000, endTs: T + 59_000 })], 4)).toBe(1);
    expect(apart.addLive([wall({ side: "ask", startTs: T + 2_000, endTs: T + 59_000 })], 4)).toBe(1);
    expect(apart.addLive([wall({ startTs: T - 100_000, endTs: T - 40_000 })], 4)).toBe(1);
    expect(apart.size).toBe(6);
    const hosts = new WhaleWallStore();
    expect(hosts.addHost([hostWall, liveCopy], 4)).toBe(2);
    const lives = new WhaleWallStore();
    expect(lives.addLive([hostWall, liveCopy], 4)).toBe(2);
  });

  it("forgets a pruned or cleared host wall for the overlap rule, so a live wall in its place is taken", () => {
    const hostWall = wall({ startTs: T, endTs: T + 60_000 });
    const liveCopy = wall({ startTs: T + 2_000, endTs: T + 59_000 });
    const pruned = new WhaleWallStore();
    pruned.addHost([hostWall], 4);
    expect(pruned.levelCount).toBe(1);
    pruned.prune(T + 120_000);
    expect(pruned.levelCount).toBe(0);
    expect(pruned.addLive([liveCopy], 4)).toBe(1);
    const cleared = new WhaleWallStore();
    cleared.addHost([hostWall], 4);
    cleared.clear();
    expect(cleared.levelCount).toBe(0);
    expect(cleared.addLive([liveCopy], 4)).toBe(1);
    const dropped = new WhaleWallStore();
    dropped.addLive([liveCopy], 4);
    dropped.addHost([hostWall], 4);
    dropped.prune(T + 120_000);
    expect(dropped.size).toBe(0);
    expect(dropped.addLive([liveCopy], 4)).toBe(1);
  });

  it("keeps standing walls apart from ended ones and swaps them whole on every live update", () => {
    const store = new WhaleWallStore();
    const first = wall({ row: 50, endTs: null, endedBy: null, peak: 30 });
    store.addLive([first, wall({ row: 51 })], 4);
    expect([store.standingCount, store.size]).toEqual([1, 1]);
    const second = wall({ row: 60, endTs: null, endedBy: null, peak: 10 });
    store.addLive([second], 4);
    expect([store.standingCount, store.size]).toEqual([1, 1]);
    expect(store.select(options()).standing.map((item) => item.key)).toEqual([wallKey(second)]);
    store.addLive([], 4);
    expect(store.standingCount).toBe(0);
  });

  it("drops only the standing walls on clearStanding, moving its version only when there were any", () => {
    const store = new WhaleWallStore();
    store.addLive([wall({ row: 50, endTs: null, endedBy: null }), wall({ row: 51 })], 4);
    const before = store.version;
    store.clearStanding();
    expect([store.standingCount, store.size]).toEqual([0, 1]);
    expect(store.version).toBeGreaterThan(before);
    const after = store.version;
    store.clearStanding();
    expect(store.version).toBe(after);
  });

  it("moves its version only when something changed", () => {
    const store = new WhaleWallStore();
    const v0 = store.version;
    store.addHost([wall()], 4);
    const v1 = store.version;
    expect(v1).toBeGreaterThan(v0);
    store.addHost([wall()], 4);
    expect(store.version).toBe(v1);
    const standing = wall({ row: 70, endTs: null, endedBy: null });
    store.addLive([standing], 4);
    const v2 = store.version;
    expect(v2).toBeGreaterThan(v1);
    store.addLive([standing], 4);
    expect(store.version).toBe(v2);
    store.addLive([{ ...standing, peak: 9 }], 4);
    expect(store.version).toBeGreaterThan(v2);
    const v3 = store.version;
    expect(store.prune(0)).toBe(0);
    expect(store.version).toBe(v3);
    store.clear();
    expect([store.size, store.standingCount]).toEqual([0, 0]);
    expect(store.version).toBeGreaterThan(v3);
  });

  it("selects by dollar size with every filled and partial wall exempt, by outcome, side and age, in start order", () => {
    const store = new WhaleWallStore();
    const big = (row: number, extra: Partial<L2Wall>) => wall({ row, peak: 10, ...extra });
    store.addHost([
      big(1_000, { startTs: T + 30_000, endTs: T + 40_000, endedBy: "pulled" }),
      big(2_000, { startTs: T + 10_000, endTs: T + 50_000, endedBy: "hit" }),
      wall({ row: 1, peak: 1, startTs: T + 20_000, endTs: T + 60_000, endedBy: "filled" }),
      wall({ row: 1, peak: 1, startTs: T + 25_000, endTs: T + 61_000, endedBy: "partial" }),
      wall({ row: 1, peak: 1, startTs: T + 5_000, endTs: T + 62_000, endedBy: "pulled" }),
      big(3_000, { side: "ask", startTs: T + 1_000, endTs: T + 70_000, endedBy: "moved" }),
      big(4_000, { startTs: T - 500_000, endTs: T - 400_000, endedBy: "filled" }),
    ], 4);
    const cut = 40_000;
    const all = store.select(options({ cutUsd: cut }));
    expect(all.walls.map((item) => [item.wall.row, item.wall.endedBy])).toEqual([[4_000, "filled"], [3_000, "moved"], [2_000, "hit"], [1, "filled"], [1, "partial"], [1_000, "pulled"]]);
    expect([...all.start]).toEqual(all.walls.map((item) => item.start));
    expect(store.select(options({ cutUsd: cut, fills: false })).walls.map((item) => item.wall.endedBy)).toEqual(["filled", "moved", "hit", "pulled"]);
    expect(store.select(options({ cutUsd: cut, outcomes: [true, false, true, true, false] })).walls.map((item) => item.wall.endedBy)).toEqual(["filled", "hit", "filled", "pulled"]);
    expect(store.select(options({ cutUsd: cut, side: 1 })).walls.map((item) => item.wall.row)).toEqual([3_000]);
    expect(store.select(options({ cutUsd: cut, fromTs: T + 45_000 })).walls.map((item) => item.wall.row)).toEqual([3_000, 2_000, 1, 1]);
    expect(store.select(options({ cutUsd: cut, side: 0 })).walls.every((item) => item.side === 0)).toBe(true);
    const edge = all.walls.find((item) => item.wall.row === 2_000)!.usd;
    expect(store.select(options({ cutUsd: edge, fills: false })).walls.map((item) => item.wall.row)).toContain(2_000);
    expect(store.select(options({ cutUsd: edge + 1, fills: false })).walls.map((item) => item.wall.row)).not.toContain(2_000);
    const touched = new WhaleWallStore();
    touched.addHost([wall({ row: 1, peak: 1, endedBy: "hit" })], 4);
    expect(touched.select(options({ cutUsd: cut })).count).toBe(0);
  });

  it("can cut by importance instead of dollars, for ended and standing walls alike, with fills still exempt", () => {
    const store = new WhaleWallStore();
    store.addHost([
      wall({ row: 1, ratio: 6, peak: 1, startTs: T + 1, endTs: T + 100, endedBy: "pulled" }),
      wall({ row: 2, ratio: 3, peak: 1_000_000, startTs: T + 2, endTs: T + 101, endedBy: "pulled" }),
      wall({ row: 3, ratio: 1, peak: 1, startTs: T + 3, endTs: T + 102, endedBy: "filled" }),
    ], 4);
    store.addLive([wall({ row: 4, ratio: 5, peak: 1, endTs: null, endedBy: null }), wall({ row: 5, ratio: 4.9, peak: 9_000_000, endTs: null, endedBy: null })], 4);
    const byRatio = store.select(options({ cutUsd: 1, ratioMin: 5 }));
    expect(byRatio.walls.map((item) => item.wall.row)).toEqual([1, 3]);
    expect(byRatio.standing.map((item) => item.wall.row)).toEqual([4]);
    expect(store.select(options({ cutUsd: 1, ratioMin: 5, fills: false })).walls.map((item) => item.wall.row)).toEqual([1]);
    const byUsd = store.select(options({ cutUsd: 1_000_000, ratioMin: null }));
    expect(byUsd.walls.map((item) => item.wall.row)).toEqual([2, 3]);
    expect(byUsd.standing.map((item) => item.wall.row)).toEqual([5]);
    expect(store.select(options({ cutUsd: 1_000_000 })).walls.map((item) => item.wall.row)).toEqual([2, 3]);
  });

  it("builds culling arrays with the furthest end so far, and finds the visible range even for a wall that began long before it", () => {
    const store = new WhaleWallStore();
    store.addHost([
      wall({ row: 1, startTs: T, endTs: T + 1_000_000 }),
      wall({ row: 2, startTs: T + 100_000, endTs: T + 150_000 }),
      wall({ row: 3, startTs: T + 200_000, endTs: T + 250_000 }),
      wall({ row: 4, startTs: T + 2_000_000, endTs: T + 2_100_000 }),
    ], 4);
    const selection = store.select(options());
    expect([...selection.prefixEnd]).toEqual([T + 1_000_000, T + 1_000_000, T + 1_000_000, T + 2_100_000]);
    expect(visibleRange(selection, T + 500_000, T + 600_000)).toEqual([0, 3]);
    expect(visibleRange(selection, T + 1_500_000, T + 1_600_000)).toEqual([3, 3]);
    expect(visibleRange(selection, T + 2_050_000, T + 2_060_000)).toEqual([3, 4]);
    expect(visibleRange(selection, T - 10_000, T - 5_000)).toEqual([0, 0]);
    expect(visibleRange(selection, T + 3_000_000, T + 4_000_000)).toEqual([4, 4]);
    expect(visibleRange(selection, T + 100_000, T + 200_000)).toEqual([0, 3]);
  });

  it("scales heat from the median to the 99th percentile on a log scale, inside 0 and 1, and gives 0 on a broken scale", () => {
    expect(heatOf(BANDS.p50, BANDS)).toBe(0);
    expect(heatOf(1, BANDS)).toBe(0);
    expect(heatOf(BANDS.p99, BANDS)).toBeCloseTo(1, 12);
    expect(heatOf(BANDS.p99 * 10, BANDS)).toBe(1);
    expect(heatOf(Math.sqrt(BANDS.p50 * BANDS.p99), BANDS)).toBeCloseTo(0.5, 12);
    expect(heatOf(BANDS.p90, BANDS)).toBeGreaterThan(heatOf(BANDS.p75, BANDS));
    expect(heatOf(10, { ...BANDS, p99: BANDS.p50 })).toBe(0);
    expect(heatOf(10, { ...BANDS, p50: 0 })).toBe(0);
    const store = new WhaleWallStore();
    store.addHost([wall({ peak: 1_000 })], 4);
    const selection = store.select(options());
    expect(selection.heat[0]).toBeCloseTo(heatOf(1_000 * 100.5 * 4, BANDS), 6);
  });

  it("prunes walls that ended before a cut-off, and orders standing walls by size with their heat after the cut and side", () => {
    const store = new WhaleWallStore();
    store.addHost([wall({ row: 1, endTs: T + 10_000 }), wall({ row: 2, startTs: T + 5_000, endTs: T + 90_000 }), wall({ row: 3, startTs: T + 6_000, endTs: T + 50_000 })], 4);
    expect(store.prune(T + 50_000)).toBe(1);
    expect(store.size).toBe(2);
    expect(store.select(options()).walls.map((item) => item.wall.row)).toEqual([2, 3]);
    const small = wall({ row: 100, peak: 1, endTs: null, endedBy: null });
    const big = wall({ row: 100, peak: 100_000, endTs: null, endedBy: null, side: "ask", startTs: T + 1 });
    const mid = wall({ row: 100, peak: 50_000, endTs: null, endedBy: null, startTs: T + 2 });
    store.addLive([small, mid, big], 4);
    const selection = store.select(options({ cutUsd: 10_000_000 }));
    expect(selection.standing.map((item) => item.wall.peak)).toEqual([100_000, 50_000]);
    expect(selection.standingHeat[0]).toBeGreaterThan(selection.standingHeat[1]);
    expect(store.select(options({ cutUsd: 10_000_000, side: 0 })).standing.map((item) => item.wall.peak)).toEqual([50_000]);
  });
});
