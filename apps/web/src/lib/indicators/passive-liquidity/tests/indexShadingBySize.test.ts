import { describe, expect, it } from "vitest";
import { FakeHost, type PaneShot } from "./heatRasterHarness";
import { buildScene, type Scene, type SceneWall } from "./heatRasterScenes";
import { freshPane, paneOf } from "./heatRasterWalk";

interface Painted {
  wall: SceneWall;
  rows: number;
  bandRows: number;
  alpha: number;
}

function paintedBand(scene: Scene, shot: PaneShot, wall: SceneWall, x: number): Painted {
  const layout = scene.layout();
  const band = layout.bands.find((candidate) => candidate.row === Math.floor(wall.core / layout.clusterRows));
  if (band === undefined) throw new Error(`wall ${wall.id} is out of view`);
  const top = Math.max(0, Math.round(band.yTop));
  const bottom = Math.min(shot.height, Math.round(band.yBottom));
  let rows = 0;
  let alpha = 0;
  for (let y = top; y < bottom; y += 1) {
    const a = shot.data[(y * shot.width + x) * 4 + 3];
    if (a > 0) rows += 1;
    if (a > alpha) alpha = a;
  }
  return { wall, rows, bandRows: bottom - top, alpha };
}

function liveWalls(scene: Scene): Painted[] {
  const layout = scene.layout();
  const live = layout.tiers[layout.tiers.length - 1];
  const last = live.columns[live.columns.length - 1];
  const x = Math.round(layout.originX + (last.ts - 500 - layout.originMs) * layout.pxPerMs);
  const shot = freshPane(scene, new FakeHost({ grid: scene.grid, settings: scene.settings }), paneOf(scene, 1));
  return scene.walls()
    .filter((wall) => wall.endTs === null && wall.role !== "range" && wall.bornTs < last.ts - 60_000)
    .map((wall) => paintedBand(scene, shot, wall, x))
    .filter((painted) => painted.rows > 0);
}

describe("an index wall is drawn by its size", () => {
  it("a bigger resting wall is darker and taller than a smaller one, the smaller one well short of its row; the biggest fills it", () => {
    let compared = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const walls = liveWalls(buildScene({ seed, flavour: "index" })).sort((a, b) => a.wall.peak - b.wall.peak);
      if (walls.length < 2) continue;
      const smallest = walls[0];
      const biggest = walls[walls.length - 1];
      if (biggest.wall.peak < 1.5 * smallest.wall.peak) continue;
      compared += 1;
      expect(biggest.alpha, `seed ${seed}`).toBeGreaterThan(smallest.alpha);
      expect(biggest.rows, `seed ${seed}`).toBeGreaterThan(smallest.rows);
      expect(smallest.rows, `seed ${seed}`).toBeLessThan(smallest.bandRows - 1);
      expect(biggest.rows, `seed ${seed}`).toBeGreaterThanOrEqual(biggest.bandRows - 1);
    }
    expect(compared).toBeGreaterThanOrEqual(3);
  });
});
