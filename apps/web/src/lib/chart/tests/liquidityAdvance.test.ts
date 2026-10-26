import { afterEach, describe, expect, it } from "vitest";
import { createIndicatorRuntime } from "../indicatorRuntime";
import { RUNTIME_INDICATOR_DEFS } from "../indicatorRegistry";
import { indicatorLiquidityOf } from "../indicatorLiquidity";
import { resetDrawOwnerScopeForTests } from "../draw/creationScope";
import { resetDrawRegistryForTests } from "../draw/registry";
import { LiquidityGrid } from "../../indicators/passive-liquidity/liquidityGrid";
import type { BarFrame } from "../../../types/frames";
import { bookFrames, drawnBy, walk } from "./fixtures/syntheticMarket";

// Report 57 W4, L-W4-8 (found by the frozen-screenshot oracle): the order-book
// indicators replay once, when the book first reaches the chart. The book then
// keeps filling in place, frame by frame, and nothing asked them to read it
// again until the next candle update -- so a book still arriving at that
// moment left Institutional Order Blocks v2 with no walls, and in a quiet
// market it stayed that way. When the book advances they now read it on the
// forming bar, exactly as the next candle update would have.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

function partialThenFull(id: string, bars: readonly BarFrame[], catchUp: (runtime: ReturnType<typeof createIndicatorRuntime>) => void) {
  const def = RUNTIME_INDICATOR_DEFS.find((candidate) => candidate.id === id)!;
  const settings = { [id]: { ...(def.defaultSettings as Record<string, unknown>), source: "tracker", showWeak: true, showUnverifiable: true, showRejected: true } };
  const frames = bookFrames(bars);
  const grid = new LiquidityGrid();
  grid.apply(frames[0]);
  const runtime = createIndicatorRuntime([def]);
  runtime.setActiveAndReplay(new Set([id]), settings, bars);
  runtime.setLiquidity(indicatorLiquidityOf(grid), bars);
  const early = drawnBy(runtime.getDrawOwnerId(id)!);
  for (const frame of frames.slice(1)) grid.apply(frame);
  catchUp(runtime);
  return { early, late: drawnBy(runtime.getDrawOwnerId(id)!) };
}

describe("order-book indicators follow a book that finishes arriving after their replay", () => {
  it("draws the walls a partial book hid, once the rest of the book has arrived", () => {
    const bars = walk(600);
    const { early, late } = partialThenFull("institutionalOrderBlocksV2", bars, (runtime) => runtime.onLiquidityAdvanced(bars));
    expect(early.boxes).toHaveLength(0);
    expect(late.boxes.length).toBeGreaterThan(0);
  });

  for (const id of ["institutionalOrderBlocksV2", "institutionalOrderBlocks"]) {
    it(`${id} reads the advanced book exactly as the forming bar's next update would`, () => {
      const bars = walk(600);
      const advanced = partialThenFull(id, bars, (runtime) => runtime.onLiquidityAdvanced(bars));
      resetDrawRegistryForTests();
      const updated = partialThenFull(id, bars, (runtime) => runtime.onBar(bars[bars.length - 1], "REPLACED_EDGE", bars));
      expect(advanced.late).toEqual(updated.late);
    });
  }

  it("leaves indicators that do not read the book, and a record not at the forming bar, untouched", () => {
    const def = RUNTIME_INDICATOR_DEFS.find((candidate) => candidate.id === "classicOrderBlocks")!;
    const bars = walk(600);
    const runtime = createIndicatorRuntime([def]);
    runtime.setActiveAndReplay(new Set([def.id]), {}, bars);
    const before = drawnBy(runtime.getDrawOwnerId(def.id)!);
    runtime.onLiquidityAdvanced(bars);
    runtime.onLiquidityAdvanced(bars.slice(0, -1));
    expect(drawnBy(runtime.getDrawOwnerId(def.id)!)).toEqual(before);
  });
});
