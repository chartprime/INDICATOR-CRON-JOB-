import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./heatRasterHarness";
import { buildScene } from "./heatRasterScenes";
import { freshPane, paneOf } from "./heatRasterWalk";

const FROZEN: Record<string, string> = {
  "seed 1": "56dae9b3746953206b5a3a8a7c41ae46863d5d04ed05a7ce90c95f6ad39dfe92",
  "seed 2": "33692f7fbbbe6c894f7a9ab8f905952c1c1f5ee19aff5362e78ecaf9515335d1",
  "seed 3": "643185b16a2ca3ba87f4a761b2dd232069e3802c6f6680403e1f2563cd095e13",
  "seed 4 history": "efde8c3dabfb24d328ee2f5144992694567d3d6a15d275d28859c635e4d32fa1",
};

function digest(seed: number, history: boolean): string {
  const scene = buildScene({ seed, flavour: "crypto", history });
  scene.pan(0.0371);
  const shot = freshPane(scene, new FakeHost({ grid: scene.grid, settings: scene.settings }), paneOf(scene, 1));
  return createHash("sha256").update(shot.data).digest("hex");
}

describe("the crypto drawing is frozen", () => {
  it("paints the crypto scenes pixel for pixel as it did before the index shading change of 2026-10-12", () => {
    const now: Record<string, string> = {
      "seed 1": digest(1, false),
      "seed 2": digest(2, false),
      "seed 3": digest(3, false),
      "seed 4 history": digest(4, true),
    };
    expect(now).toEqual(FROZEN);
  });
});
