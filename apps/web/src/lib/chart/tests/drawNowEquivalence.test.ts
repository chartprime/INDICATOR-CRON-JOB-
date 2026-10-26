import { afterEach, describe, expect, it } from "vitest";
import { createIndicatorRuntime } from "../indicatorRuntime";
import { RUNTIME_INDICATOR_DEFS } from "../indicatorRegistry";
import { indicatorLiquidityOf } from "../indicatorLiquidity";
import { resetDrawOwnerScopeForTests } from "../draw/creationScope";
import { resetDrawRegistryForTests } from "../draw/registry";
import type { RuntimeIndicatorDef } from "../indicatorTypes";
import type { LiquidityGrid } from "../../indicators/passive-liquidity/liquidityGrid";
import type { BarFrame } from "../../../types/frames";
import { book, drawnBy, walk } from "./fixtures/syntheticMarket";

// Report 57 W4, GE-19: an indicator that only needs its final picture may skip
// drawing while it replays history (ctx.drawNow is false before the last
// closed replayed bar). What the chart shows afterwards must be exactly what
// drawing on every bar produced -- including a replay that ends on a candle
// still forming, and an indicator that reads the order book.

const ADOPTERS = ["classicOrderBlocks", "institutionalOrderBlocks", "institutionalOrderBlocksV2", "marketStructure", "l1OrderBlocks"];

const SHOW_EVERY_VERDICT: Readonly<Record<string, Record<string, unknown>>> = {
  institutionalOrderBlocks: { showWeak: true, showUnverifiable: true, showRejected: true, showMitigated: true },
};

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

function drawnAfterReplay(def: RuntimeIndicatorDef<unknown, unknown>, bars: readonly BarFrame[], grid: LiquidityGrid | null) {
  const runtime = createIndicatorRuntime([def]);
  runtime.setLiquidity(indicatorLiquidityOf(grid));
  const settings = { ...(def.defaultSettings as Record<string, unknown>), ...(SHOW_EVERY_VERDICT[def.id] ?? {}) };
  runtime.setActiveAndReplay(new Set([def.id]), { [def.id]: settings }, bars);
  const result = { drawn: drawnBy(runtime.getDrawOwnerId(def.id)!), output: runtime.getOutput(def.id), markers: runtime.getMarkers(def.id) };
  resetDrawRegistryForTests();
  return result;
}

function alwaysDrawing(def: RuntimeIndicatorDef<unknown, unknown>): RuntimeIndicatorDef<unknown, unknown> {
  return { ...def, onBar: (ctx) => def.onBar({ ...ctx, drawNow: true }) };
}

describe("drawing only once a replay reaches its last closed bar (report 57 W4, GE-19)", () => {
  for (const id of ADOPTERS) {
    const def = RUNTIME_INDICATOR_DEFS.find((candidate) => candidate.id === id)!;
    for (const lastOpen of [false, true]) {
      it(`${id} draws exactly what drawing every bar drew${lastOpen ? " when the last candle is still forming" : ""}`, () => {
        const bars = walk(3_000, lastOpen);
        const grid = id.startsWith("institutional") ? book(bars) : null;
        const expected = drawnAfterReplay(alwaysDrawing(def), bars, grid);
        const actual = drawnAfterReplay(def, bars, grid);
        expect(expected.drawn.boxes.length + expected.drawn.lines.length + expected.drawn.labels.length).toBeGreaterThan(0);
        expect(actual).toEqual(expected);
      });
    }
  }
});
