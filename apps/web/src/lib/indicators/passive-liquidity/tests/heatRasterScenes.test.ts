import { describe, expect, it } from "vitest";
import type { LiquidityLevel } from "../../../../types/frames";
import { liquiditySizeAt, type LiquidityColumn } from "../liquidityGrid";
import type { HeatmapLayout } from "../liquidityHeatmapLayout";
import { createRunFinder, type RunFinder } from "../liquidityRunFinder";
import type { RunSegment } from "../liquidityRuns";
import { buildScene, type Scene, type SceneFlavour } from "./heatRasterScenes";

// The scenes the heat renderer's tests stand on: deterministic from the seed,
// laid out like a chart at rest, and holding every case the renderer draws.

const FLAVOURS: readonly SceneFlavour[] = ["crypto", "index"];
const SEEDS = [1, 2, 3];
const MINUTE = 60_000;
const SIDES = ["bid", "ask"] as const;

/** Columns that differ between two lists (ts, window, reference, median or any size); -1 when the lengths differ. */
function differingColumns(a: readonly LiquidityColumn[], b: readonly LiquidityColumn[]): number {
  if (a.length !== b.length) return -1;
  let differing = 0;
  a.forEach((x, i) => {
    const y = b[i];
    const same = x.ts === y.ts && x.lo === y.lo && x.hi === y.hi && x.reference === y.reference && x.median === y.median
      && x.bid.every((size, row) => size === y.bid[row]) && x.ask.every((size, row) => size === y.ask[row]);
    if (!same) differing += 1;
  });
  return differing;
}

function layoutShape(layout: HeatmapLayout) {
  return {
    originX: layout.originX,
    originMs: layout.originMs,
    pxPerMs: layout.pxPerMs,
    rowWidth: layout.rowWidth,
    clusterRows: layout.clusterRows,
    reference: layout.reference,
    ladderMax: layout.ladderMax,
    freeRight: layout.freeRight,
    bands: layout.bands,
    ladder: layout.ladder,
    bars: layout.bars,
    tiers: layout.tiers.map((tier) => ({ columnMs: tier.columnMs, from: tier.from, to: tier.to, scanTo: tier.scanTo, length: tier.columns.length, first: tier.columns[0]?.ts })),
  };
}

/** Every column the runs are scanned over, oldest first. */
function scannedColumns(layout: HeatmapLayout): LiquidityColumn[] {
  return layout.tiers.flatMap((tier) => tier.columns.slice(0, tier.scanTo));
}

function dipsUnderPaint(finder: RunFinder, columns: readonly LiquidityColumn[], band: number, side: "bid" | "ask", run: RunSegment): boolean {
  return columns.some((column) => {
    if (column.ts < run.startTs || column.ts >= run.endTs) return false;
    const size = finder.sizesAt(column, band)[side];
    const { link, paint } = finder.floorsAt(column, band, true);
    return size >= link && size < paint;
  });
}

interface Census {
  resting: number;
  consumed: number;
  pulled: number;
  connectors: number;
  pulledConnectors: number;
  twoSided: number;
  runBands: number[];
}

/** The runs over the bands in view at the scene's current view, counted by what the renderer draws for them. */
function census(scene: Scene): Census {
  const layout = scene.layout();
  const finder = createRunFinder(scene.grid, layout, scene.settings);
  const columns = scannedColumns(layout);
  const latest = scene.grid.latest;
  if (latest === null) throw new Error("expected columns");
  const liveEdge = latest.ts + scene.grid.columnMs;
  const out: Census = { resting: 0, consumed: 0, pulled: 0, connectors: 0, pulledConnectors: 0, twoSided: 0, runBands: [] };
  for (const band of layout.bands) {
    const runs = { bid: finder.runsFor(band.row, "bid"), ask: finder.runsFor(band.row, "ask") };
    if (runs.bid.length + runs.ask.length > 0) out.runBands.push(band.row);
    for (const side of SIDES) {
      for (const run of runs[side]) {
        if (run.fate === "resting" && run.endTs === liveEdge) out.resting += 1;
        if (run.fate === "consumed" && run.reach === "touch") out.consumed += 1;
        if (run.fate === "pulled") out.pulled += 1;
        if (!dipsUnderPaint(finder, columns, band.row, side, run)) continue;
        out.connectors += 1;
        if (run.fate === "pulled") out.pulledConnectors += 1;
      }
    }
    const inRun = (side: "bid" | "ask", ts: number) => runs[side].some((run) => ts >= run.startTs && ts < run.endTs);
    const shared = columns.some((column) => {
      const sizes = finder.sizesAt(column, band.row);
      const { link } = finder.floorsAt(column, band.row, true);
      return sizes.bid >= link && sizes.ask >= link && (inRun("bid", column.ts) || inRun("ask", column.ts));
    });
    if (shared) out.twoSided += 1;
  }
  return out;
}

function firstRun(scene: Scene, layout: HeatmapLayout, accept: (run: RunSegment) => boolean): { band: number; side: "bid" | "ask"; run: RunSegment } | null {
  const finder = createRunFinder(scene.grid, layout, scene.settings);
  for (const band of layout.bands) {
    for (const side of SIDES) {
      const run = finder.runsFor(band.row, side).find(accept);
      if (run !== undefined) return { band: band.row, side, run };
    }
  }
  return null;
}

describe.each(FLAVOURS)("buildScene (%s)", (flavour) => {
  it("builds the same scene from the same seed, column for column, and another from another seed", () => {
    const a = buildScene({ seed: 7, flavour });
    const b = buildScene({ seed: 7, flavour });
    expect(differingColumns(a.grid.columns, b.grid.columns)).toBe(0);
    expect(differingColumns(a.grid.deepColumns, b.grid.deepColumns)).toBe(0);
    expect(b.bars()).toEqual(a.bars());
    expect(b.walls()).toEqual(a.walls());
    expect(layoutShape(b.layout())).toEqual(layoutShape(a.layout()));
    expect([b.rng(), b.rng(), b.rng()]).toEqual([a.rng(), a.rng(), a.rng()]);
    for (let i = 0; i < 75; i += 1) {
      a.addLiveColumn();
      b.addLiveColumn();
    }
    expect(differingColumns(a.grid.columns, b.grid.columns)).toBe(0);
    expect(differingColumns(a.grid.deepColumns, b.grid.deepColumns)).toBe(0);
    expect(layoutShape(b.layout())).toEqual(layoutShape(a.layout()));
    const other = buildScene({ seed: 8, flavour });
    expect(differingColumns(a.grid.columns.slice(0, 720), other.grid.columns)).toBeGreaterThan(600);
  });

  it("lays out the deep tier then the fine tier, every column on the pane, the live edge inside the last candle and bands a few pixels tall", () => {
    for (const seed of SEEDS) {
      const scene = buildScene({ seed, flavour });
      const { grid, view } = scene;
      const layout = scene.layout();
      const latest = grid.latest;
      if (latest === null) throw new Error("expected columns");
      const [deep, fine] = layout.tiers;
      expect(layout.tiers.map((tier) => tier.columnMs)).toEqual([10_000, 1_000]);
      expect(deep.columns).toBe(grid.deepColumns);
      expect(fine.columns).toBe(grid.columns);
      expect(fine.columns).toHaveLength(12 * 60);
      expect(deep.scanTo).toBeGreaterThanOrEqual(30 * 6);
      expect(deep.columns[deep.scanTo - 1].ts).toBeLessThan(fine.columns[0].ts);
      expect([deep.from, deep.to, fine.from, fine.to]).toEqual([0, deep.scanTo, 0, fine.columns.length]);

      expect(layout.intervalMs).toBe(MINUTE);
      expect(latest.ts).toBeGreaterThan(layout.originMs);
      expect(latest.ts).toBeLessThan(layout.originMs + MINUTE);
      expect(layout.bars[layout.bars.length - 1].time).toBe(layout.originMs);
      expect(layout.originX + view.barSpacing / 2).toBe(view.paneWidth * 0.8);
      const xOf = (ts: number) => layout.originX + (ts - layout.originMs) * layout.pxPerMs;
      expect(xOf(deep.columns[0].ts)).toBeGreaterThan(0);
      expect(xOf(latest.ts + grid.columnMs)).toBeLessThan(view.paneWidth);

      const yOf = (price: number) => (view.priceTop - price) / view.pricePerPx;
      const columns = scannedColumns(layout);
      expect(yOf((Math.max(...columns.map((column) => column.hi)) + 1) * grid.rowWidth)).toBeGreaterThan(0);
      expect(yOf(Math.min(...columns.map((column) => column.lo)) * grid.rowWidth)).toBeLessThan(view.paneHeight);
      expect(yOf((scene.mid() + 0.5) * grid.rowWidth)).toBeCloseTo(view.paneHeight / 2, 9);
      const inner = layout.bands.slice(1, -1);
      expect(inner.length).toBeGreaterThan(60);
      for (const band of inner) {
        expect(band.yBottom - band.yTop).toBeGreaterThanOrEqual(2);
        expect(band.yBottom - band.yTop).toBeLessThanOrEqual(6);
      }
      expect(layout.reference).toBeGreaterThan(0);
      expect(layout.ladder.length).toBeGreaterThan(0);
    }
  });

  it("puts runs of every fate in view: resting at the live edge, consumed at a touch, pulled, a hairline connector, and a band holding both sides at once", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const scene = buildScene({ seed, flavour });
      const counted = census(scene);
      const found = {
        resting: counted.resting > 0,
        consumed: counted.consumed > 0,
        pulled: counted.pulled > 0,
        connector: counted.connectors > 0,
        pulledConnector: counted.pulledConnectors > 0,
        twoSided: counted.twoSided > 0,
      };
      expect([seed, found]).toEqual([seed, { resting: true, consumed: true, pulled: true, connector: true, pulledConnector: true, twoSided: true }]);
      // Background dust never makes a level: every band with a run holds a wall the scene put there.
      const clusterRows = scene.layout().clusterRows;
      const wallBands = new Set(scene.walls().flatMap((wall) => wall.rows.map((row) => Math.floor(row / clusterRows))));
      expect([seed, counted.runBands.filter((band) => !wallBands.has(band))]).toEqual([seed, []]);
    }
  });

  it("keeps background on nearly every row, under the link floor, and the walls it names on their own side of the mid", () => {
    const scene = buildScene({ seed: 3, flavour });
    const layout = scene.layout();
    const finder = createRunFinder(scene.grid, layout, scene.settings);
    const latest = scene.grid.latest;
    if (latest === null) throw new Error("expected columns");
    const mid = scene.mid();
    const filled = (side: "bid" | "ask") => {
      let rows = 0;
      let held = 0;
      for (let row = latest.lo; row <= latest.hi; row += 1) {
        if (side === "bid" ? row >= mid : row <= mid) continue;
        rows += 1;
        if (liquiditySizeAt(latest, side, row) > 0) held += 1;
      }
      return held / rows;
    };
    expect(filled("bid")).toBeGreaterThan(0.8);
    expect(filled("ask")).toBeGreaterThan(0.8);
    expect(new Set(scene.walls().map((wall) => wall.role))).toEqual(new Set(["wall", "anchor", "connector", "grower", "range"]));
    const walls = scene.wallRows();
    expect(walls.length).toBeGreaterThan(3);
    expect(walls).toEqual(scene.walls().filter((wall) => wall.endTs === null).map((wall) => ({ side: wall.side, row: wall.core })));
    const wallBands = new Set(walls.map(({ row }) => Math.floor(row / layout.clusterRows)));
    for (const { side, row } of walls) {
      expect(side === "bid" ? row < mid : row > mid).toBe(true);
      expect(row >= latest.lo && row <= latest.hi).toBe(true);
    }
    const quiet = layout.bands.filter((band) => !wallBands.has(band.row) && band.row * layout.clusterRows >= latest.lo && (band.row + 1) * layout.clusterRows <= latest.hi);
    expect(quiet.length).toBeGreaterThan(10);
    for (const band of quiet) {
      const sizes = finder.sizesAt(latest, band.row);
      const { link } = finder.floorsAt(latest, band.row, true);
      expect(Math.max(sizes.bid, sizes.ask)).toBeLessThan(link);
    }
  });

  it("adds one fine column a second and a deep column every ten, keeps the live candle on the book's mid, and grows a wall at the live edge", () => {
    const scene = buildScene({ seed: 4, flavour });
    const { grid } = scene;
    const first = grid.latest;
    if (first === null) throw new Error("expected columns");
    const fine = grid.columns.length;
    const deep = grid.deepColumns.length;
    const peaks = new Map(scene.walls().map((wall) => [wall.id, wall.peak]));
    const closes = new Set<number>();
    let deepAdded = 0;
    for (let i = 1; i <= 40; i += 1) {
      scene.addLiveColumn();
      const latest = grid.latest;
      if (latest === null) throw new Error("expected columns");
      expect(latest.ts).toBe(first.ts + i * 1000);
      expect(grid.columns).toHaveLength(fine + i);
      if (latest.ts % 10_000 === 0) {
        deepAdded += 1;
        expect(grid.deepColumns[grid.deepColumns.length - 1].ts).toBe(latest.ts);
      }
      expect(grid.deepColumns).toHaveLength(deep + deepAdded);
      const mid = (latest.lo + latest.hi) / 2;
      expect(mid).toBe(scene.mid());
      const layout = scene.layout();
      const live = layout.bars[layout.bars.length - 1];
      expect(live.time).toBe(Math.floor(latest.ts / MINUTE) * MINUTE);
      expect(live.close).toBe((mid + 0.5) * grid.rowWidth);
      expect(live.low).toBeLessThanOrEqual((mid - 0.5) * grid.rowWidth);
      expect(live.high).toBeGreaterThanOrEqual((mid + 1.5) * grid.rowWidth);
      closes.add(live.close);
    }
    expect(deepAdded).toBe(4);
    expect(closes.size).toBeGreaterThan(1);
    const grown = scene.walls().filter((wall) => wall.endTs === null && wall.peak > (peaks.get(wall.id) ?? Infinity));
    expect(grown.length).toBeGreaterThan(0);
  });

  it("steps the grower up every ten seconds at the live edge, and its resting run's peak with it", () => {
    const scene = buildScene({ seed: 4, flavour });
    const clusterRows = scene.layout().clusterRows;
    const grower = scene.walls().find((wall) => wall.role === "grower" && wall.endTs === null);
    const first = scene.grid.latest;
    if (grower === undefined || first === null) throw new Error("expected the grower");
    const steps = grower.growSteps.filter((ts) => ts > first.ts);
    expect(steps.length).toBeGreaterThanOrEqual(9);
    const band = Math.floor(grower.core / clusterRows);
    const peak = () => {
      const runs = createRunFinder(scene.grid, scene.layout(), scene.settings).runsFor(band, grower.side);
      const run = runs[runs.length - 1];
      expect(run.fate).toBe("resting");
      return run.peak;
    };
    const stepFloor = flavour === "crypto" ? 100 : 25;
    const creep = flavour === "crypto" ? 40 : 1;
    let before = peak();
    let stepped = 0;
    for (let i = 0; i < 35; i += 1) {
      scene.addLiveColumn();
      const now = scene.grid.latest?.ts ?? NaN;
      const after = peak();
      if (steps.includes(now)) {
        stepped += 1;
        expect(after - before).toBeGreaterThan(stepFloor);
      } else expect(after - before).toBeLessThan(creep);
      before = after;
    }
    expect(stepped).toBe(3);
  });

  it("closes the live candle and opens the next at the first second of the new minute", () => {
    const scene = buildScene({ seed: 5, flavour });
    const before = scene.layout();
    const count = scene.bars().length;
    const open = before.originMs;
    scene.closeCandle();
    const after = scene.layout();
    const columns = scene.grid.columns;
    expect(scene.bars()).toHaveLength(count + 1);
    expect(after.originMs).toBe(open + MINUTE);
    expect(after.originX).toBe(before.originX);
    expect(columns[columns.length - 1].ts).toBe(open + MINUTE);
    expect(columns[columns.length - 2].ts).toBe(open + MINUTE - 1000);
    expect(after.bars[after.bars.length - 2].time).toBe(open);
    const live = after.bars[after.bars.length - 1];
    expect(live.time).toBe(open + MINUTE);
    expect(live.close).toBe((scene.mid() + 0.5) * scene.grid.rowWidth);
  });

  it("moves the layout with a pan, a zoom, a price shift and a price scale", () => {
    const scene = buildScene({ seed: 6, flavour });
    const base = scene.layout();
    const { paneHeight } = scene.view;

    scene.pan(37.25);
    const panned = scene.layout();
    expect(panned.originX).toBeCloseTo(base.originX + 37.25, 9);
    expect([panned.originMs, panned.pxPerMs]).toEqual([base.originMs, base.pxPerMs]);
    expect(panned.bands).toEqual(base.bands);
    scene.pan(150);
    const older = scene.layout().tiers[1];
    expect(older.from).toBe(0);
    expect(older.to).toBeGreaterThan(0);
    expect(older.to).toBeLessThan(scene.grid.columns.length);
    scene.pan(-187.25);
    expect(scene.layout().originX).toBeCloseTo(base.originX, 9);

    scene.zoom(9);
    const zoomed = scene.layout();
    expect(zoomed.pxPerMs).toBeCloseTo(9 / MINUTE, 15);
    expect(zoomed.originX).toBeCloseTo(scene.view.xCenter - 4.5, 9);
    expect(zoomed.bands).toEqual(base.bands);
    scene.zoom(6);

    scene.shiftPrice(13.5);
    const shifted = scene.layout();
    const byRow = new Map(base.bands.slice(1, -1).map((band) => [band.row, band]));
    const common = shifted.bands.slice(1, -1).filter((band) => byRow.has(band.row));
    expect(common.length).toBeGreaterThan(60);
    for (const band of common) expect(band.yTop - (byRow.get(band.row)?.yTop ?? NaN)).toBeCloseTo(13.5, 6);
    expect(shifted.originX).toBe(base.originX);
    scene.shiftPrice(-13.5);

    scene.scalePrice(2);
    const scaled = scene.layout();
    const middleOf = (layout: HeatmapLayout) => layout.bands.find((band) => band.yTop <= paneHeight / 2 && band.yBottom > paneHeight / 2);
    const middle = middleOf(base);
    const scaledMiddle = middleOf(scaled);
    expect(scaledMiddle?.row).toBe(middle?.row);
    const height = (band: { yTop: number; yBottom: number } | undefined) => (band === undefined ? NaN : band.yBottom - band.yTop);
    expect(height(scaledMiddle) * 2).toBeCloseTo(height(middle), 9);
    expect(scaled.bands.length).toBeGreaterThan(base.bands.length * 1.8);
  });

  it("delivers a ledger update in a frame of its own, and the run finder settles a fate by it", () => {
    const scene = buildScene({ seed: 1, flavour });
    const layout = scene.layout();
    const fineStart = scene.grid.columns[0].ts;
    const found = firstRun(scene, layout, (run) => run.fate === "pulled" && run.fill === null && run.startTs >= fineStart);
    if (found === null) throw new Error("expected a pulled run in the fine tier");
    const { band, side, run } = found;
    const level: LiquidityLevel = {
      side, row: band * layout.clusterRows, span: layout.clusterRows, start_ts: run.startTs, end_ts: run.endTs,
      size: 0, peak: run.peak, ended_by: "filled", ratio: 3, chain: 0, fill: 0.8, eaten: 0.8, absorbing: false,
    };
    const version = scene.grid.version;
    const columns = scene.grid.columns.length;
    scene.setLevels([level]);
    expect(scene.grid.levels).toEqual([level]);
    expect(scene.grid.version).toBe(version + 1);
    expect(scene.grid.columns).toHaveLength(columns);
    const settled = createRunFinder(scene.grid, scene.layout(), scene.settings).runsFor(band, side).find((entry) => entry.startTs === run.startTs);
    expect(settled).toMatchObject({ fate: "consumed", fill: 0.8, endTs: run.endTs });
    scene.addLiveColumn();
    expect(scene.grid.columns).toHaveLength(columns + 1);
    expect(scene.grid.levels).toEqual([level]);
  });

  it("puts the host's one-minute history first when asked, the day before the deep tier, and leaves the live columns as they were", () => {
    const scene = buildScene({ seed: 2, flavour, history: true });
    const plain = buildScene({ seed: 2, flavour });
    expect(differingColumns(scene.grid.columns, plain.grid.columns)).toBe(0);
    expect(differingColumns(scene.grid.deepColumns, plain.grid.deepColumns)).toBe(0);
    const layout = scene.layout();
    expect(layout.tiers.map((tier) => tier.columnMs)).toEqual([60_000, 10_000, 1_000]);
    expect(layout.history).toMatchObject({ levelMs: 60_000, rowFactor: 1, days: 1, loading: false, drawn: true, refused: null, unavailable: null });
    const want = layout.historyWant;
    if (want === null) throw new Error("expected a history want");
    const deepStart = scene.grid.deepColumns[0].ts;
    const liveEdge = scene.grid.columns[scene.grid.columns.length - 1].ts + scene.grid.columnMs;
    expect(want).toMatchObject({ levelMs: 60_000, rowFactor: 1, fromTs: deepStart - 86_400_000, toTs: Math.floor((liveEdge - 1) / 300_000) * 300_000 + 300_000 });
    const past = layout.tiers[0];
    expect(past.columns).toHaveLength(1_440);
    expect(past.columns[0].ts).toBe(want.fromTs);
    // The live tiers are whole here, so the host's columns stop where the deep tier begins.
    expect(past.columns[past.columns.length - 1].ts).toBe(deepStart - MINUTE);
    expect(past.columns.every((column) => (column.reference ?? 0) > 0 && (column.median ?? 0) > 0)).toBe(true);
    expect(past.to).toBe(past.columns.length);
    expect(past.from).toBeLessThan(past.to);
    expect(past.columns).toEqual(scene.history?.reach(want).columns.filter((column) => column.ts < deepStart));
    expect(layout.bars[0].time).toBe(want.fromTs);
    const lastPast = past.columns[past.columns.length - 1];
    expect(Math.abs((lastPast.lo + lastPast.hi) / 2 - (scene.grid.deepColumns[0].lo + scene.grid.deepColumns[0].hi) / 2)).toBeLessThanOrEqual(9);
    expect(firstRun(scene, layout, (run) => run.startTs < want.toTs)).not.toBeNull();
    expect(layoutShape(buildScene({ seed: 2, flavour, history: true }).layout())).toEqual(layoutShape(layout));
  });

  it("takes the spans and the pane it is given", () => {
    const scene = buildScene({ seed: 3, flavour, minutes: 4, deepMinutes: 6, paneWidth: 900, paneHeight: 300 });
    const layout = scene.layout();
    expect(scene.view).toMatchObject({ xCenter: 720, paneWidth: 900, paneHeight: 300, barSpacing: 6 });
    expect(scene.grid.columns).toHaveLength(4 * 60);
    expect(layout.tiers[0].scanTo).toBeGreaterThanOrEqual(6 * 6);
    expect(layout.tiers[0].scanTo).toBeLessThan(7 * 6);
    expect(layout.originX + 3).toBe(720);
  });
});
