import { afterEach, describe, expect, it } from "vitest";
import { largeTradeBubblesIndicator } from "../../../indicators/large-trade-bubbles/largeTradeBubbles";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { resetDrawRegistryForTests } from "../../draw/registry";
import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../../indicatorTypes";
import { duplicateClosedArrivals, trendBars } from "../fixtures";
import { captureMarkers, countMarkers, countMarkersOver, judgeBudget, markerBudgetOf, summarizeBudget } from "../markerBudget";
import { busyTapeFor } from "../syntheticTape";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/** Marks every bar, twice: the noisiest tool imaginable. */
const everyBar: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
  kind: "runtime",
  id: "everyBar",
  label: "Every Bar",
  category: "technical",
  defaultSettings: {},
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: (ctx) => {
    ctx.markers.plotshape({ shape: "arrowUp", position: "belowBar", color: "#26a69a" });
    ctx.markers.plotchar({ char: "x", position: "aboveBar" });
  },
  readOutput: () => ({}),
};

describe("marker budget", () => {
  const { bars } = trendBars({ count: 500 });

  it("counts Large Trade Bubbles on a busy live instrument and reports the rate per 1,000 bars", () => {
    const prints = busyTapeFor(bars, { printsPerBar: 60, largeShare: 0.02 });
    const budget = countMarkers(largeTradeBubblesIndicator, bars, { multiplier: 3 }, {
      live: {
        revisionsPerBar: 2,
        tradesFor: (bar, revision, revisions) => {
          const all = prints.get(bar.ts_open)!;
          return { trades: all.slice(0, Math.ceil((all.length * (revision + 1)) / revisions)), tradeAvailability: "LIVE_COMPLETE" };
        },
      },
    });
    expect(budget.bars).toBe(500);
    expect(budget.total).toBeGreaterThan(0);
    expect(budget.per1000Bars).toBeCloseTo((budget.total / 500) * 1000, 6);
    expect(budget.byShape.circle).toBe(budget.total);
    expect(budget.byPosition.atPriceMiddle).toBe(budget.total);
    expect(budget.maxPerBar).toBeLessThanOrEqual(50);
    expect(summarizeBudget("bubbles", budget)).toMatch(/per 1,000 bars/);
    // A replay sees no trades, so the same tool draws nothing there: the budget must be measured live.
    expect(countMarkers(largeTradeBubblesIndicator, bars, { multiplier: 3 }).total).toBe(0);
  });

  it("a tool that marks every bar blows any sane ceiling and the verdict says so", () => {
    const budget = countMarkers(everyBar, bars, {});
    expect(budget.total).toBe(1000);
    expect(budget.per1000Bars).toBe(2000);
    expect(budget.maxPerBar).toBe(2);
    expect(budget.barsWithMarkers).toBe(500);
    expect(budget.byShape).toEqual({ arrowUp: 500, circle: 500 });
    const verdict = judgeBudget(budget, 50, 1);
    expect(verdict.ok).toBe(false);
    expect(summarizeBudget("everyBar", budget, verdict)).toContain("FAIL");
    expect(judgeBudget(markerBudgetOf([], 500), 50).ok).toBe(true);
  });

  it("a faulting indicator is reported as faulted and never passes the budget (Codex finding 6)", () => {
    let calls = 0;
    const thrower: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
      ...everyBar,
      id: "throwsAfterTen",
      onBar: (ctx) => {
        calls += 1;
        if (calls > 10) throw new Error("boom");
        ctx.markers.plotshape({ shape: "circle" });
      },
    };
    const budget = countMarkers(thrower, bars, {});
    expect(budget.faulted).toBe(true);
    expect(budget.total).toBe(0);
    expect(judgeBudget(budget, 1_000_000).ok).toBe(false);
    expect(judgeBudget(budget, 1_000_000).faulted).toBe(true);
    expect(summarizeBudget("thrower", budget, judgeBudget(budget, 50))).toContain("FAULTED");
    calls = 0;
    const over = countMarkersOver(thrower, bars.slice(0, 20).map((bar) => ({ bar })), {});
    expect(over.faulted).toBe(true);
    expect(judgeBudget(over, 1_000_000).ok).toBe(false);
    expect(judgeBudget(markerBudgetOf([], 500, false), 50)).toMatchObject({ ok: true, faulted: false });
  });

  it("a duplicated closed bar does not double the budget", () => {
    const { arrivals } = duplicateClosedArrivals(bars.slice(0, 20), 10);
    const budget = countMarkersOver(everyBar, arrivals, {});
    expect(budget.bars).toBe(20);
    expect(budget.total).toBe(40);
  });

  it("captureMarkers records calls from a hand-built ctx with the bar's time", () => {
    let time = 1_000;
    const capture = captureMarkers(() => time);
    const ctx = { bar: bars[0], state: {}, settings: {}, replace: false, replaying: false, trades: [], ta: {}, draw: { fill: () => {} }, markers: capture.markers, pane: { paneIndex: 0 } } as unknown as IndicatorBarCtx<Record<string, never>, Record<string, never>>;
    everyBar.onBar(ctx);
    time = 2_000;
    everyBar.onBar(ctx);
    expect(capture.calls.map((call) => call.time)).toEqual([1_000, 1_000, 2_000, 2_000]);
    expect(capture.calls[1]).toMatchObject({ shape: "circle", text: "x", position: "aboveBar" });
    capture.reset();
    expect(capture.calls).toEqual([]);
  });
});
