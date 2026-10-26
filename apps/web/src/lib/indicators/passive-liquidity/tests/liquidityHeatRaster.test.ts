import { describe, expect, it } from "vitest";
import { LiquidityHeatRenderer, SETTLE_MS } from "../liquidityHeatRenderer";
import { diffPixels, drawPane, FakeHost, paintedPixels } from "./heatRasterHarness";
import { buildScene } from "./heatRasterScenes";
import { beforePane, freshPane, paneOf } from "./heatRasterWalk";

describe("a fresh paint draws the picture the renderer before the raster drew", () => {
  for (const flavour of ["index", "crypto"] as const) {
    for (const ratio of [1, 1.25, 2]) {
      it(`exactly while every column is in view, and but for the edge columns when the view cuts through them (${flavour}, pixel ratio ${ratio})`, () => {
        for (const seed of [1, 2, 3]) {
          const scene = buildScene({ seed, flavour });
          const pane = paneOf(scene, ratio);
          const fresh = freshPane(scene, new FakeHost({ grid: scene.grid, settings: scene.settings }), pane);
          expect(paintedPixels(fresh)).toBeGreaterThan(1_000);
          expect(diffPixels(fresh, beforePane(scene, pane)), `seed ${seed}`).toEqual({ count: 0, first: null });
          const edge = Math.ceil(4 * ratio);
          for (const dx of [-150, 90, 260]) {
            scene.pan(dx);
            const panned = freshPane(scene, new FakeHost({ grid: scene.grid, settings: scene.settings }), pane);
            expect(diffPixels(panned, beforePane(scene, pane), { left: edge, right: edge }), `seed ${seed} pan ${dx}`).toEqual({ count: 0, first: null });
          }
        }
      });
    }
  }

  it("but for the edge columns with a day of history behind the live columns", () => {
    for (const flavour of ["index", "crypto"] as const) {
      const scene = buildScene({ seed: 4, flavour, history: true });
      const pane = paneOf(scene, 1);
      for (const dx of [0, 400, 2_000]) {
        scene.pan(dx);
        const fresh = freshPane(scene, new FakeHost({ grid: scene.grid, settings: scene.settings }), pane);
        expect(diffPixels(fresh, beforePane(scene, pane), { left: 4, right: 4 }), `${flavour} pan ${dx}`).toEqual({ count: 0, first: null });
      }
    }
  });
});

describe("a fresh paint and the renderer before the raster agree on what is shown", () => {
  it("for every Show filter and with pulled levels hidden", () => {
    for (const flavour of ["index", "crypto"] as const) {
      const scene = buildScene({ seed: 3, flavour });
      const pane = paneOf(scene, 1);
      const painted: number[] = [];
      for (const change of [{ showPulled: false }, { levelFilter: "resting" as const }, { levelFilter: "consumed" as const }]) {
        scene.settings = { ...scene.settings, showPulled: true, levelFilter: "all", ...change };
        const fresh = freshPane(scene, new FakeHost({ grid: scene.grid, settings: scene.settings }), pane);
        painted.push(paintedPixels(fresh));
        expect(diffPixels(fresh, beforePane(scene, pane)), `${flavour} ${JSON.stringify(change)}`).toEqual({ count: 0, first: null });
      }
      expect(new Set(painted).size, flavour).toBe(3);
    }
  });
});

describe("the raster repaints a column whose ceiling alone changed", () => {
  it("as a slow chart's folds hand it new cells with the same sizes and another ceiling, so an index wall never keeps its old shade", () => {
    const scene = buildScene({ seed: 2, flavour: "index" });
    const pane = paneOf(scene, 1);
    const layout = scene.layout();
    const host = new FakeHost({ grid: scene.grid, layout, settings: scene.settings });
    let now = 50_000;
    const renderer = new LiquidityHeatRenderer(host, () => now);
    drawPane(renderer, pane);
    now += SETTLE_MS;
    const settled = drawPane(renderer, pane);
    const raised = { ...layout, tiers: layout.tiers.map((tier) => ({ ...tier, columns: tier.columns.map((column) => ({ ...column, ceiling: 40 * (column.reference ?? layout.reference) })) })) };
    host.layout = raised;
    now += SETTLE_MS;
    const after = drawPane(renderer, pane);
    const fresh = drawPane(new LiquidityHeatRenderer(new FakeHost({ grid: scene.grid, layout: raised, settings: scene.settings }), () => now), pane);
    expect(diffPixels(settled, fresh).count).toBeGreaterThan(0);
    expect(diffPixels(after, fresh)).toEqual({ count: 0, first: null });
  });
});
