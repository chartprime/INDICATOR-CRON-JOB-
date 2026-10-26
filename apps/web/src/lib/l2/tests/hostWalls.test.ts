import { describe, expect, it } from "vitest";
import { HOST_WALL_ID_BASE, decodeHostWallPage, hostWallId, isWallFilter } from "../hostWalls";

const T = 1_790_000_000_000;
const record = (over: Record<string, unknown> = {}) => ({ id: 7, side: "bid", row: 21_150, span: 1, startTs: T, endTs: T + 60_000, size: 0, peak: 416.4, endedBy: "partial", ratio: 11.2, chain: 183_899, fill: 0.24, eaten: 0.34, absorbing: false, detail: { lifeMs: 60_000, traded: 100.8, absorbed: 0.4, swept: 100.4, hidden: 0.3, repeats: 2 }, ...over });
const page = (over: Record<string, unknown> = {}) => ({ available: true, generation: "8a33", geometry: { rowWidth: 4 }, span: { oldest: T - 86_400_000, newest: T }, walls: [record()], next: null, ...over });

describe("host wall pages: the pyramid's wall records read as L2 history walls", () => {
  it("turns a page into history walls with ids below the runtime's history ids, lane 0, the verdict and the detail it carries", () => {
    const decoded = decodeHostWallPage(page({ next: { endTs: T + 60_000, id: 7 } }));
    expect(decoded).not.toBeNull();
    if (decoded === null || !decoded.available) throw new Error("expected a page");
    expect(decoded.rowWidth).toBe(4);
    expect(decoded.generation).toBe("8a33");
    expect(decoded.next).toEqual({ endTs: T + 60_000, id: 7 });
    expect(decoded.walls).toHaveLength(1);
    const wall = decoded.walls[0];
    expect(wall.id).toBe(-(HOST_WALL_ID_BASE + 7));
    expect(hostWallId(7)).toBe(wall.id);
    expect(wall.id < 0 && Number.isSafeInteger(wall.id)).toBe(true);
    expect(wall).toMatchObject({ lane: 0, side: "bid", row: 21_150, span: 1, startTs: T, endTs: T + 60_000, size: 0, peak: 416.4, endedBy: "partial", ratio: 11.2, chain: 183_899, fill: 0.24, eaten: 0.34, absorbing: false });
    expect(wall.detail).toMatchObject({ lifeMs: 60_000, traded: 100.8, absorbed: 0.4, swept: 100.4, hidden: 0.3, repeats: 2, firstShrinkTs: null, clearedByTrades: false });
  });

  it("reads how long after the previous wall this one appeared from the stored continuity, falls back to a flat field, and gives null for anything else", () => {
    const gapOf = (detail: Record<string, unknown> | undefined) => {
      const decoded = decodeHostWallPage(page({ walls: [record({ detail })] }));
      if (decoded === null || !decoded.available) throw new Error("expected a page");
      return decoded.walls[0].detail?.continuityGapMs;
    };
    expect(gapOf({ continuity: { prevId: 9, gapMs: 1_200 } })).toBe(1_200);
    expect(gapOf({ continuity: { prevId: null, gapMs: 0 } })).toBe(0);
    expect(gapOf({ continuityGapMs: 800 })).toBe(800);
    expect(gapOf({ continuity: { gapMs: 300 }, continuityGapMs: 800 })).toBe(300);
    expect(gapOf({ continuity: null, continuityGapMs: 800 })).toBe(800);
    expect(gapOf({ continuity: null })).toBeNull();
    expect(gapOf({ continuity: { gapMs: 1.5 } })).toBeNull();
    expect(gapOf({ continuity: { gapMs: "5" }, continuityGapMs: "7" })).toBeNull();
    expect(gapOf({ lifeMs: 1 })).toBeNull();
    expect(gapOf({ continuity: "x" })).toBeNull();
  });

  it("reads the filter a filtering host echoes back, and leaves it out when the echo is missing or malformed", () => {
    const echoed = decodeHostWallPage(page({ filter: { minUsd: 5_000_000, alwaysOutcomes: ["filled", "partial"] } }));
    if (echoed === null || !echoed.available) throw new Error("expected a page");
    expect(echoed.filter).toEqual({ minUsd: 5_000_000, alwaysOutcomes: ["filled", "partial"] });
    for (const bad of [undefined, null, "x", { minUsd: -1, alwaysOutcomes: [] }, { minUsd: 1e13, alwaysOutcomes: [] }, { minUsd: 1, alwaysOutcomes: ["lost"] }, { minUsd: 1, alwaysOutcomes: ["hit", "hit"] }, { minUsd: 1, alwaysOutcomes: "hit" }, { alwaysOutcomes: [] }]) {
      const decoded = decodeHostWallPage(page({ filter: bad }));
      if (decoded === null || !decoded.available) throw new Error("expected a page");
      expect(Object.hasOwn(decoded, "filter")).toBe(false);
    }
    expect(isWallFilter({ minUsd: 0, alwaysOutcomes: [] })).toBe(true);
    expect(isWallFilter({ minUsd: Number.NaN, alwaysOutcomes: [] })).toBe(false);
  });

  it("reads the size percentiles a Binance page carries, in rising order, and leaves them out when missing, broken or out of order", () => {
    const good = { n: 120, p50: 8e6, p75: 12e6, p90: 18e6, p95: 24e6, p99: 40e6 };
    const read = decodeHostWallPage(page({ sizeBands: good }));
    if (read === null || !read.available) throw new Error("expected a page");
    expect(read.sizeBands).toEqual(good);
    for (const bad of [undefined, null, "x", { ...good, n: 0 }, { ...good, n: 1.5 }, { ...good, p50: 0 }, { ...good, p99: Number.NaN }, { ...good, p75: "12" }, { ...good, p90: 1e6 }, { n: 5 }]) {
      const decoded = decodeHostWallPage(page({ sizeBands: bad }));
      if (decoded === null || !decoded.available) throw new Error("expected a page");
      expect(Object.hasOwn(decoded, "sizeBands")).toBe(false);
    }
    const flat = decodeHostWallPage(page({ sizeBands: { n: 3, p50: 5, p75: 5, p90: 5, p95: 5, p99: 5 } }));
    if (flat === null || !flat.available) throw new Error("expected a page");
    expect(flat.sizeBands?.p99).toBe(5);
  });

  it("refuses a page with a wall it cannot read, keeps a refusal's reason, and takes a record without detail", () => {
    expect(decodeHostWallPage({ available: false, reason: "STORAGE_UNAVAILABLE" })).toEqual({ available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(decodeHostWallPage({ available: false })).toBeNull();
    expect(decodeHostWallPage(page({ walls: [record({ endTs: null })] }))).toBeNull();
    expect(decodeHostWallPage(page({ walls: [record({ endedBy: "gone" })] }))).toBeNull();
    expect(decodeHostWallPage(page({ walls: [record({ side: "mid" })] }))).toBeNull();
    expect(decodeHostWallPage(page({ walls: [record({ id: -1 })] }))).toBeNull();
    expect(decodeHostWallPage(page({ geometry: { rowWidth: 0 } }))).toBeNull();
    expect(decodeHostWallPage(page({ next: { endTs: T } }))).toBeNull();
    expect(decodeHostWallPage("page")).toBeNull();
    const bare = decodeHostWallPage(page({ walls: [record({ detail: undefined, ratio: undefined })] }));
    if (bare === null || !bare.available) throw new Error("expected a page");
    expect(bare.walls[0].detail).toBeNull();
    expect(bare.walls[0].ratio).toBe(0);
  });

  it("reads a wall exactly as the host's store wrote it on 2026-10-05, nested continuity and row id included, and refuses the same wall without its id", () => {
    const real = {
      id: 4821, side: "bid", row: 21544, span: 1, startTs: 1791201362000, endTs: 1791201727000, size: 1.4, peak: 61.49000000000001, endedBy: "hit", ratio: 9.24583664758133, chain: 354, fill: 0, eaten: 0.06, absorbing: false,
      detail: { lifeMs: 365000, firstShrinkTs: 1791201362114, firstShrinkExact: true, reachedAtFirstShrink: true, traded: 2.8499699999999977, absorbed: 2.0007299999999995, swept: 0.8492399999999972, hidden: 0.514610000000029, cleared: 23.236710000000002, fillRatio: 0.04742835746380425, crossSide: 25.440760000000694, crossSideShare: 0.41373816880794745, endDistanceRows: 2, endDistancePct: 0.0092824654228163, clearedByTrades: false, continuity: { prevId: 354, gapMs: 9000 }, repeats: 5, repeatsComplete: false, evidenceGap: false },
    };
    const geometry = { tickSize: 0.01, clusterTicks: 50, clusterWidth: 0.5, rowClusters: 8, rowWidth: 4, windowRows: 1023, sizeDigits: 2, snapshotDepth: 5000, columnMs: 1000, windowMs: 300000, levelsMs: [10000, 30000, 60000, 300000], rowBp: 0.5, windowBp: 600, referenceBp: 50, fixedRows: null, pinnedPrice: 83042, replayWarmupMs: 1800000 };
    const decoded = decodeHostWallPage({ available: true, generation: "8a33", geometry, span: { oldest: 1790631900000, newest: 1791236100000 }, walls: [real], next: null, filter: { minUsd: 4445549, alwaysOutcomes: ["filled", "partial"] }, sizeBands: { n: 14000, p50: 1629693, p75: 2500000, p90: 4445549, p95: 6500000, p99: 10300000 } });
    if (decoded === null || !decoded.available) throw new Error("expected a page");
    expect(decoded.rowWidth).toBe(4);
    expect(decoded.walls[0]).toMatchObject({ id: hostWallId(4821), side: "bid", row: 21544, endedBy: "hit", detail: { continuityGapMs: 9000, repeats: 5 } });
    expect(decoded.filter).toEqual({ minUsd: 4445549, alwaysOutcomes: ["filled", "partial"] });
    expect(decoded.sizeBands?.p90).toBe(4445549);
    const { id: _id, ...withoutId } = real;
    expect(decodeHostWallPage({ available: true, generation: "8a33", geometry, walls: [withoutId], next: null })).toBeNull();
  });
});
