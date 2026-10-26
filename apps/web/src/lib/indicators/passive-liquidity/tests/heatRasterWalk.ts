import { expect } from "vitest";
import type { LiquidityLevel } from "../../../../types/frames";
import { LiquidityHeatRenderer, SETTLE_MS } from "../liquidityHeatRenderer";
import { createRunFinder } from "../liquidityRunFinder";
import type { LiquiditySettings } from "../liquiditySettings";
import { HeatRendererBeforeRaster } from "./fixtures/heatRendererBeforeRaster";
import { diffPixels, drawPane, FakeHost, paintedPixels, type PaneShot, type PaneSize } from "./heatRasterHarness";
import { buildScene, mulberry32, type Scene, type SceneFlavour } from "./heatRasterScenes";

// The raster is a cache, so whatever the renderer keeps between frames must
// be the picture a fresh paint of the view makes, pixel for pixel: after
// every pan by whole pixels, and after the view stands still once a pan off
// the whole pixel. And a fresh paint is the picture the renderer before the
// raster made, but for the first and last few pixel columns when the view
// cuts through the columns (it left out the ones just outside the view and
// put a consumed cap at the edge of its image).

export function paneOf(scene: Scene, ratio: number): PaneSize {
  return { width: Math.round(scene.view.paneWidth * ratio), height: Math.round(scene.view.paneHeight * ratio), hpr: ratio, vpr: ratio };
}

export function freshPane(scene: Scene, host: FakeHost, pane: PaneSize): PaneShot {
  const fresh = new FakeHost({ grid: scene.grid, layout: scene.layout(), settings: host.settings, bidRgb: host.bidRgb, askRgb: host.askRgb });
  return drawPane(new LiquidityHeatRenderer(fresh), pane);
}

export function beforePane(scene: Scene, pane: PaneSize): PaneShot {
  return drawPane(new HeatRendererBeforeRaster(new FakeHost({ grid: scene.grid, layout: scene.layout(), settings: scene.settings })), pane);
}

/** A pulled run in view settled as eaten by the ledger, as the server would report it. */
function ledgerFor(scene: Scene, pick: () => number): LiquidityLevel[] {
  const layout = scene.layout();
  const runs = createRunFinder(scene.grid, layout, scene.settings);
  const found: LiquidityLevel[] = [];
  for (const band of layout.bands) {
    for (const side of ["bid", "ask"] as const) {
      for (const run of runs.runsFor(band.row, side)) {
        if (run.fate !== "pulled" || run.fill !== null) continue;
        found.push({
          side, row: band.row * layout.clusterRows, span: layout.clusterRows, start_ts: run.startTs, end_ts: run.endTs,
          size: 0, peak: run.peak, ended_by: "filled", ratio: 3, chain: 0, fill: 0.8, eaten: 0.8, absorbing: false,
        });
      }
    }
  }
  return found.length === 0 ? [] : [found[Math.floor(pick() * found.length)]];
}

const FILTERS: LiquiditySettings["levelFilter"][] = ["all", "resting", "consumed"];

export function walk(flavour: SceneFlavour, history: boolean, ratio: number, seed: number, steps: number): void {
  const scene = buildScene({ seed, flavour, history });
  // The scene's round numbers put column edges on exact half pixels, where
  // the last bit of floating point decides the rounding; a chart's own
  // coordinates never do. A sliver of a pixel keeps every edge off them.
  scene.pan(0.0371);
  const pane = paneOf(scene, ratio);
  const host = new FakeHost({ grid: scene.grid, layout: scene.layout(), settings: scene.settings });
  let now = 50_000;
  const renderer = new LiquidityHeatRenderer(host, () => now);
  const draw = () => {
    host.layout = scene.layout();
    return drawPane(renderer, pane);
  };
  const pick = mulberry32(seed * 7919 + Math.round(ratio * 100));
  const choose = (n: number) => Math.floor(pick() * n);
  const first = draw();
  expect(paintedPixels(first)).toBeGreaterThan(0);
  expect(diffPixels(first, freshPane(scene, host, pane))).toEqual({ count: 0, first: null });
  now += SETTLE_MS;
  for (let step = 0; step < steps; step += 1) {
    const kind = choose(11);
    let whole = true;
    if (kind === 0) scene.pan(((choose(121) - 60) * 4) / Math.round(4 * ratio));
    else if (kind === 1) {
      scene.pan(pick() * 30 - 15);
      whole = false;
    } else if (kind === 2) scene.zoom([4, 6, 9, 12][choose(4)]);
    else if (kind === 3) scene.shiftPrice((choose(2) === 0 ? 1 : -1) * (1 + choose(20)));
    else if (kind === 4) scene.scalePrice(choose(2) === 0 ? 0.8 : 1.25);
    else if (kind === 5) for (let n = 0; n <= choose(5); n += 1) scene.addLiveColumn();
    else if (kind === 6) scene.closeCandle();
    else if (kind === 7) scene.setLevels(ledgerFor(scene, pick));
    else if (kind === 8) {
      host.settings = choose(2) === 0
        ? { ...host.settings, showPulled: !host.settings.showPulled }
        : { ...host.settings, levelFilter: FILTERS[(FILTERS.indexOf(host.settings.levelFilter) + 1) % FILTERS.length] };
    } else if (kind === 9) host.bidRgb = choose(2) === 0 ? { r: 14, g: 154, b: 102 } : { r: 190, g: 30, b: 60 };
    else now += SETTLE_MS;
    const shot = draw();
    const where = `${flavour} history ${history} ratio ${ratio} seed ${seed} step ${step} kind ${kind}`;
    expect(shot.overlaps, where).toBe(0);
    if (whole) expect(diffPixels(shot, freshPane(scene, host, pane)), where).toEqual({ count: 0, first: null });
    now += SETTLE_MS;
    const settled = draw();
    expect(settled.overlaps, `${where} settled`).toBe(0);
    expect(diffPixels(settled, freshPane(scene, host, pane)), `${where} settled`).toEqual({ count: 0, first: null });
  }
}
