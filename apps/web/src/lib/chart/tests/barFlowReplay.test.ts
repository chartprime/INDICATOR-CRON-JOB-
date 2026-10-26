import { afterEach, describe, expect, it } from "vitest";
import { createIndicatorRuntime } from "../indicatorRuntime";
import { RUNTIME_INDICATOR_DEFS } from "../indicatorRegistry";
import { resetDrawOwnerScopeForTests } from "../draw/creationScope";
import { drawRegistryStats, resetDrawRegistryForTests } from "../draw/registry";
import type { BarFrame } from "../../../types/frames";
import { walk } from "./fixtures/syntheticMarket";

// Report 57 W4, L-W4-2: in Historical Mode the candles arrive first and their
// buy/sell split (the archive's candle flow) arrives later. The chart wrote the
// split into its candles but only redrew; runtime indicators that read the
// split kept what they had computed without it. When the split arrives, they
// are replayed on the updated candles and match a cold build that had it.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const fvgDelta = RUNTIME_INDICATOR_DEFS.find((def) => def.id === "fvgDelta")!;

function withoutSides(bars: readonly BarFrame[]): BarFrame[] {
  return bars.map((bar) => {
    const { buy_volume: _buy, sell_volume: _sell, ...rest } = bar;
    return rest as BarFrame;
  });
}

function hoverAfterCold(bars: readonly BarFrame[]): unknown {
  const runtime = createIndicatorRuntime([fvgDelta]);
  runtime.setActiveAndReplay(new Set([fvgDelta.id]), {}, bars);
  const hover = runtime.getHoverData(fvgDelta.id);
  resetDrawRegistryForTests();
  return hover;
}

describe("a chart that goes away (report 57 W4, L-W4-1)", () => {
  it("frees every draw object its indicators held when it releases them, as the chart now does on unmount", () => {
    const heavy = RUNTIME_INDICATOR_DEFS.filter((def) => ["classicOrderBlocks", "marketStructure", "swingAlphabetProfile"].includes(def.id));
    const runtime = createIndicatorRuntime(heavy);
    runtime.setActiveAndReplay(new Set(heavy.map((def) => def.id)), {}, walk(600));
    expect(drawRegistryStats().objects).toBeGreaterThan(1_000);
    runtime.setActive(new Set(), {}, []);
    expect(drawRegistryStats()).toMatchObject({ objects: 0, owners: 0 });
  });
});

describe("candle flow that arrives after the candles (report 57 W4, L-W4-2)", () => {
  it("changes what FVG Delta reports, so it cannot be left as computed without it", () => {
    const flowed = walk(1_500);
    expect(hoverAfterCold(withoutSides(flowed))).not.toEqual(hoverAfterCold(flowed));
  });

  it("is read once the indicators are replayed on the updated candles", () => {
    const flowed = walk(1_500);
    const expected = hoverAfterCold(flowed);
    const bars = withoutSides(flowed);
    const runtime = createIndicatorRuntime([fvgDelta]);
    runtime.setActiveAndReplay(new Set([fvgDelta.id]), {}, bars);
    for (let index = 0; index < bars.length; index += 1) bars[index] = flowed[index];
    runtime.onSnapshot(bars);
    expect(runtime.getHoverData(fvgDelta.id)).toEqual(expected);
  });
});
