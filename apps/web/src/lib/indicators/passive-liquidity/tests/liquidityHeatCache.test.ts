import { describe, expect, it } from "vitest";
import type { IChartApiBase, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { LiquidityFrame } from "../../../../types/frames";
import { LiquidityGrid, type LiquidityColumn } from "../liquidityGrid";
import { computeHeatmapLayout } from "../liquidityHeatmapLayout";
import { LiquidityHeatRenderer, SETTLE_MS } from "../liquidityHeatRenderer";
import { createRunFinder } from "../liquidityRunFinder";
import { DEFAULT_LIQUIDITY_SETTINGS, type LiquiditySettings } from "../liquiditySettings";
import { HeatRendererBeforeRaster } from "./fixtures/heatRendererBeforeRaster";
import { diffPixels, drawPane, FakeHost, paintedPixels, type PaneShot } from "./heatRasterHarness";

// The settled heat is kept in a raster between frames: what each kind of
// frame may paint again, and that the kept picture is always the one a fresh
// paint of the whole view makes.

const T = 1_699_999_980_000;
const PANE = { width: 600, height: 400, hpr: 1, vpr: 1 };
const LO = 80;
const HI = 120;

type Walls = Record<number, number>;

const BASE_WALLS: Walls = { 84: 25, 90: 40, 110: 60, 116: 30 };

/** A book of `background` on every row with walls on top: bids below row 100, asks above it. */
function book(walls: Walls, near: number, background: number) {
  const bid: [number, number][] = [];
  const ask: [number, number][] = [];
  for (let row = LO; row <= HI; row += 1) {
    if (row === 100) continue;
    const size = walls[row] ?? (row === 99 || row === 101 ? near : background);
    (row < 100 ? bid : ask).push([row - LO, size]);
  }
  return { bid, ask };
}

function frameAt(seq: number, second: number, walls: Walls, provider: "BINANCE" | "DXFEED", near: number, background: number): LiquidityFrame {
  const { bid, ask } = book(walls, near, background);
  return {
    type: "liquidity", provider, marketKind: provider === "BINANCE" ? "SPOT" : undefined, assetClass: provider === "DXFEED" ? "FUTURE" : undefined,
    symbol: provider === "BINANCE" ? "XRP-USDT" : "/NQZ26:XCME", ts: T + second * 1000, seq, reset: seq === 1,
    row_width: 2, column_ms: 1000,
    columns: [{ ts: T + second * 1000, lo: LO, hi: HI, bid, ask }],
  } as LiquidityFrame;
}

interface BookOptions {
  provider?: "BINANCE" | "DXFEED";
  /** The size of the rows either side of the mid, which set the colour reference. */
  nearAt?: (second: number) => number;
  /** The fine tier's capacity in columns. */
  capacity?: number;
  wallsAt?: (second: number) => Walls;
  background?: number;
}

function scene({ provider = "BINANCE", nearAt = () => 2, capacity, wallsAt = () => BASE_WALLS, background = 2 }: BookOptions = {}) {
  const grid = new LiquidityGrid(capacity);
  let seq = 0;
  let second = -600;
  for (; second <= 2; second += 1) grid.apply(frameAt((seq += 1), second, wallsAt(second), provider, nearAt(second), background));
  const view = { xCenter: 500.37, barSpacing: 120, pricePerPx: 0.2, priceTop: 240 };
  const bars = () => {
    const last = Math.floor((T + (second - 1) * 1000) / 60_000) * 60;
    const out = [];
    for (let time = (T - 600_000) / 1000; time <= last; time += 60) out.push({ time, high: 202, low: 198, close: 200 });
    return out;
  };
  const settings: LiquiditySettings = { ...DEFAULT_LIQUIDITY_SETTINGS, quietBands: 0 };
  const layout = () => {
    const data = bars();
    const chart = {
      timeScale: () => ({ timeToIndex: () => data.length - 1, logicalToCoordinate: () => view.xCenter, options: () => ({ barSpacing: view.barSpacing }), width: () => PANE.width }),
      paneSize: () => ({ height: PANE.height, width: PANE.width }),
    } as unknown as IChartApiBase<Time>;
    const series = {
      data: () => data,
      coordinateToPrice: (y: number) => view.priceTop - y * view.pricePerPx,
      priceToCoordinate: (price: number) => (view.priceTop - price) / view.pricePerPx,
    } as unknown as ISeriesApi<SeriesType, Time>;
    const result = computeHeatmapLayout(chart, series, grid, settings);
    if (result === null) throw new Error("no layout");
    return result;
  };
  const addColumn = (walls: Walls = wallsAt(second)) => {
    grid.apply(frameAt((seq += 1), second, walls, provider, nearAt(second), background));
    second += 1;
  };
  return { grid, view, settings, layout, addColumn };
}

function rig(options: BookOptions = {}, pane = PANE) {
  const world = scene(options);
  const host = new FakeHost({ grid: world.grid, layout: world.layout(), settings: world.settings });
  let now = 10_000;
  const renderer = new LiquidityHeatRenderer(host, () => now);
  const draw = (): PaneShot => {
    host.layout = world.layout();
    return drawPane(renderer, pane);
  };
  const fresh = (): PaneShot => drawPane(new LiquidityHeatRenderer(new FakeHost({ grid: world.grid, layout: world.layout(), settings: host.settings, bidRgb: host.bidRgb, askRgb: host.askRgb }), () => now), pane);
  const rasterPixels = () => host.rasters[0].counts.putPixels + host.rasters[1].counts.putPixels;
  return { world, host, renderer, draw, fresh, rasterPixels, advance: (ms: number) => { now += ms; } };
}

function expectSame(shot: PaneShot, fresh: PaneShot): void {
  expect(shot.overlaps).toBe(0);
  expect(diffPixels(shot, fresh)).toEqual({ count: 0, first: null });
}

describe("the settled heat kept between frames", () => {
  it("draws, on the first frame, a picture with both sides of the book in it", () => {
    const { draw } = rig();
    const shot = draw();
    expect(shot.overlaps).toBe(0);
    expect(paintedPixels(shot)).toBeGreaterThan(10_000);
  });

  it("moves the raster on a pan by whole pixels and paints only the strip the pan uncovered", () => {
    const { world, host, draw, fresh, rasterPixels, advance } = rig();
    draw();
    advance(SETTLE_MS);
    host.resetCounts();
    world.view.xCenter += 7;
    const shot = draw();
    expectSame(shot, fresh());
    expect(rasterPixels()).toBeGreaterThan(0);
    expect(rasterPixels()).toBeLessThanOrEqual(7 * PANE.height);
  });

  it("paints no raster pixel for a live column that changes no settled run", () => {
    const { world, host, draw, fresh, rasterPixels } = rig();
    draw();
    host.resetCounts();
    world.addColumn();
    const shot = draw();
    expectSame(shot, fresh());
    expect(rasterPixels()).toBe(0);
  });

  it("paints again only the rows of a band whose standing wall grew", () => {
    const { world, host, draw, fresh, rasterPixels } = rig();
    draw();
    host.resetCounts();
    world.addColumn({ ...BASE_WALLS, 90: 50 });
    const shot = draw();
    expectSame(shot, fresh());
    expect(rasterPixels()).toBeGreaterThan(0);
    expect(rasterPixels()).toBeLessThanOrEqual(PANE.width * (20 + 2 * 2));
  });

  it("paints the view again when a new largest level changes the crypto colour scale", () => {
    const { world, host, draw, fresh, rasterPixels, advance } = rig();
    draw();
    advance(SETTLE_MS);
    host.resetCounts();
    world.addColumn({ ...BASE_WALLS, 110: 90 });
    const shot = draw();
    expectSame(shot, fresh());
    expect(rasterPixels()).toBeGreaterThan(PANE.width * 100);
  });

  it("paints nothing again on an index book whose live reference moves every second while its columns carry their own", () => {
    const { world, host, draw, fresh, rasterPixels } = rig({ provider: "DXFEED", nearAt: (second) => (second % 2 === 0 ? 2 : 3) });
    draw();
    const reference = world.layout().reference;
    host.resetCounts();
    world.addColumn();
    const shot = draw();
    expect(world.layout().reference).not.toBe(reference);
    expectSame(shot, fresh());
    expect(rasterPixels()).toBe(0);
  });

  it("draws a pan off the whole pixel at the nearest one, asks for a frame, and paints it exactly once the view stood still", () => {
    const { world, host, draw, fresh, rasterPixels, advance } = rig();
    draw();
    advance(SETTLE_MS);
    host.resetCounts();
    world.view.xCenter += 3.6;
    const moving = draw();
    expect(moving.overlaps).toBe(0);
    expect(host.scheduled.length).toBe(1);
    expect(rasterPixels()).toBeLessThanOrEqual(4 * PANE.height);
    advance(SETTLE_MS - 1);
    draw();
    expect(rasterPixels()).toBeLessThanOrEqual(4 * PANE.height);
    advance(1);
    const still = draw();
    expect(rasterPixels()).toBeGreaterThan(PANE.width * 100);
    expectSame(still, fresh());
  });

  it("paints the view again on a zoom step, a colour change and a candle close", () => {
    const { world, host, draw, fresh, rasterPixels } = rig();
    draw();
    host.resetCounts();
    world.view.barSpacing = 121;
    expectSame(draw(), fresh());
    expect(rasterPixels()).toBeGreaterThan(PANE.width * 100);
    host.resetCounts();
    host.bidRgb = { r: 200, g: 10, b: 10 };
    expectSame(draw(), fresh());
    expect(rasterPixels()).toBeGreaterThan(PANE.width * 100);
    host.resetCounts();
    for (let n = 0; n < 60; n += 1) world.addColumn();
    expectSame(draw(), fresh());
    expect(rasterPixels()).toBeGreaterThan(PANE.width * 100);
  });

  it("carries what it painted onto the other canvas when a pan outruns the spare, and paints only what is new", () => {
    const { world, host, draw, fresh, rasterPixels, advance } = rig();
    draw();
    advance(SETTLE_MS);
    host.resetCounts();
    for (let step = 0; step < 8; step += 1) {
      world.view.xCenter += 50;
      expectSame(draw(), fresh());
    }
    expect(host.rasters[0].counts.draws + host.rasters[1].counts.draws).toBeGreaterThan(0);
    expect(rasterPixels()).toBeLessThanOrEqual(400 * PANE.height);
  });
});

/** mulberry32: the same walk for the same seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("a random walk of pans, zooms, price moves and book changes", () => {
  for (const ratio of [1, 2]) {
    for (const seed of [1, 2, 3]) {
      it(`keeps the very picture a fresh paint makes, step after step (seed ${seed}, pixel ratio ${ratio})`, () => {
        const pane = { width: PANE.width * ratio, height: PANE.height * ratio, hpr: ratio, vpr: ratio };
        const { world, host, draw, fresh, advance } = rig({}, pane);
        const next = random(seed);
        const pick = (n: number) => Math.floor(next() * n);
        let walls: Walls = { ...BASE_WALLS };
        const wallRows = [84, 86, 90, 94, 106, 110, 112, 116];
        draw();
        for (let step = 0; step < 60; step += 1) {
          const kind = pick(9);
          let whole = true;
          if (kind === 0) world.view.xCenter += (pick(121) - 60) / ratio;
          else if (kind === 1) {
            world.view.xCenter += next() * 40 - 20;
            whole = false;
          } else if (kind === 2) world.view.barSpacing = [60, 90, 120, 150][pick(4)];
          else if (kind === 3) world.view.priceTop += pick(2) === 0 ? 2 : -2;
          else if (kind === 4) host.bidRgb = pick(2) === 0 ? { r: 14, g: 154, b: 102 } : { r: 200, g: 40, b: 40 };
          else if (kind === 5) {
            const row = wallRows[pick(wallRows.length)];
            walls = { ...walls, [row]: 10 + pick(80) };
            world.addColumn(walls);
          } else if (kind === 6) {
            const row = wallRows[pick(wallRows.length)];
            const partner = row % 2 === 0 ? row + 1 : row - 1;
            walls = { ...walls, [row]: 0, [partner]: 0 };
            world.addColumn(walls);
          } else if (kind === 7) for (let n = 0; n < 1 + pick(70); n += 1) world.addColumn(walls);
          else advance(SETTLE_MS);
          const shot = draw();
          expect(shot.overlaps, `step ${step}`).toBe(0);
          if (whole) expect(diffPixels(shot, fresh()), `step ${step} (kind ${kind})`).toEqual({ count: 0, first: null });
          advance(SETTLE_MS);
          const settled = draw();
          expect(diffPixels(settled, fresh()), `step ${step} (kind ${kind}) settled`).toEqual({ count: 0, first: null });
        }
        expect(host.scheduled.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("columns that come, go or change under the raster", () => {
  it("paints only a narrow strip where the oldest second drops off a full tier, not the view", () => {
    const { world, host, draw, fresh, rasterPixels } = rig({ capacity: 300 });
    world.view.barSpacing = 60;
    draw();
    host.resetCounts();
    world.addColumn();
    const shot = draw();
    expectSame(shot, fresh());
    expect(rasterPixels()).toBeLessThanOrEqual(12 * PANE.height);
  });

  it("paints nothing when a tier's list is rebuilt holding the very same columns", () => {
    const { world, host, renderer, draw, fresh, rasterPixels } = rig();
    draw();
    host.resetCounts();
    const layout = world.layout();
    host.layout = { ...layout, tiers: layout.tiers.map((tier) => ({ ...tier, columns: [...tier.columns] })) };
    const shot = drawPane(renderer, PANE);
    expectSame(shot, fresh());
    expect(rasterPixels()).toBe(0);
  });

  it("paints again the strip of a column replaced in place with the same time, as a folded cell is", () => {
    const { world, host, draw, fresh, rasterPixels } = rig();
    draw();
    host.resetCounts();
    const columns = world.grid.columns as LiquidityColumn[];
    const index = columns.length - 120;
    const old = columns[index];
    const bid = Float64Array.from(old.bid);
    bid[90 - old.lo] = 90;
    columns[index] = { ...old, bid };
    const shot = draw();
    expectSame(shot, fresh());
    expect(rasterPixels()).toBeGreaterThan(0);
    expect(rasterPixels()).toBeLessThanOrEqual(12 * PANE.height);
  });

  it("lets the spare canvas go once the view is painted afresh", () => {
    const { world, host, draw, fresh, advance } = rig();
    draw();
    advance(SETTLE_MS);
    for (let step = 0; step < 8; step += 1) {
      world.view.xCenter += 50;
      draw();
    }
    expect(host.rasters[0].width * host.rasters[1].width).toBeGreaterThan(0);
    world.view.barSpacing = 121;
    expectSame(draw(), fresh());
    expect(Math.min(host.rasters[0].width, host.rasters[1].width)).toBe(0);
  });
});

it("paints nothing when a tier is folded again into new objects of the very same columns", () => {
  const { world, host, renderer, draw, fresh, rasterPixels } = rig();
  draw();
  host.resetCounts();
  const layout = world.layout();
  const copy = (column: LiquidityColumn): LiquidityColumn => ({ ...column, bid: Float64Array.from(column.bid), ask: Float64Array.from(column.ask) });
  host.layout = { ...layout, tiers: layout.tiers.map((tier) => ({ ...tier, columns: tier.columns.map(copy) })) };
  const shot = drawPane(renderer, PANE);
  expectSame(shot, fresh());
  expect(rasterPixels()).toBe(0);
});

it("lets a colour scale that moves during a drag wait until the view stands still, then paints it exactly", () => {
  const { world, host, draw, fresh, rasterPixels, advance } = rig();
  draw();
  advance(SETTLE_MS);
  host.resetCounts();
  world.view.xCenter += 5;
  world.addColumn({ ...BASE_WALLS, 110: 90 });
  const moving = draw();
  expect(moving.overlaps).toBe(0);
  expect(rasterPixels()).toBeLessThanOrEqual(5 * PANE.height);
  expect(host.scheduled.length).toBeGreaterThan(0);
  advance(SETTLE_MS);
  const still = draw();
  expectSame(still, fresh());
  expect(rasterPixels()).toBeGreaterThan(PANE.width * 100);
});

describe("edges only the renderer before the raster can vouch for", () => {
  // No background, and columns a tenth of a pixel wide: a level under the
  // paint floor before it appears (row 86), a level eaten in the very first
  // column (row 101) and one eaten in the live candle's first column (rows
  // 98 and 99), whose cap reaches the last pixel left of the live candle.
  const wallsAt = (second: number): Walls => ({
    110: 60,
    116: 30,
    86: second < -500 ? 1 : 40,
    101: second === -600 ? 30 : 0,
    98: second <= 0 ? 30 : 0,
    99: second <= 0 ? 2 : 0,
  });

  it("the scene holds those three edges", () => {
    const world = scene({ wallsAt, background: 0 });
    world.view.barSpacing = 6;
    const runs = createRunFinder(world.grid, world.layout(), world.settings);
    expect(runs.runsFor(43, "bid")[0]).toMatchObject({ startTs: T - 500_000 });
    expect(runs.runsFor(50, "ask")[0]).toMatchObject({ startTs: T - 600_000, endTs: T - 599_000, fate: "consumed" });
    expect(runs.runsFor(49, "bid").find((run) => run.fate === "consumed")).toMatchObject({ endTs: T + 1_000 });
  });

  for (const ratio of [1, 2]) {
    it(`draws them as before, pixel for pixel (pixel ratio ${ratio})`, () => {
      const pane = { width: PANE.width * ratio, height: PANE.height * ratio, hpr: ratio, vpr: ratio };
      const world = scene({ wallsAt, background: 0 });
      world.view.barSpacing = 6;
      const layout = world.layout();
      const now = drawPane(new LiquidityHeatRenderer(new FakeHost({ grid: world.grid, layout, settings: world.settings })), pane);
      const before = drawPane(new HeatRendererBeforeRaster(new FakeHost({ grid: world.grid, layout, settings: world.settings })), pane);
      expect(paintedPixels(now)).toBeGreaterThan(0);
      expect(diffPixels(now, before)).toEqual({ count: 0, first: null });
    });
  }
});
