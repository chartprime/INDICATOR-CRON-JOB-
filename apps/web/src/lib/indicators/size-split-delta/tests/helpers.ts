import type { BarFrame, TradeFrame } from "../../../../types/frames";
import type { MarkerCall } from "../../../chart/draw/markers";
import type { IndicatorTicks } from "../../../chart/indicatorTicks";
import type { RuntimeIndicatorDef } from "../../../chart/indicatorTypes";
import { FIXTURE_T0, tapeOf, ticksOf, type SizeSplitFixture } from "../../../chart/validation";
import { barDelta } from "../../barSides";
import { evaluateMarkers, type MarkerRingEntry } from "../sizeSplitDeltaMath";

/** The store a fixture's prints make, complete from the first bar (`liveSince = FIXTURE_T0`). */
export function fixtureTicks(fixture: SizeSplitFixture, liveSince = FIXTURE_T0): IndicatorTicks {
  return ticksOf(tapeOf(fixture.prints, liveSince));
}

/**
 * Synthetic bars whose volume equals their prints' total, so the tape share
 * reads 1 and the share gate passes: the protocol's `busyTapeFor` draws
 * prints independently of the bar volume it was given.
 */
export function withTapeVolume(bars: readonly BarFrame[], printsByBar: ReadonlyMap<number, readonly TradeFrame[]>): BarFrame[] {
  return bars.map((bar) => {
    const prints = printsByBar.get(bar.ts_open) ?? [];
    let volume = 0;
    let buy = 0;
    for (const print of prints) {
      volume += print.size;
      if (print.side === "buy") buy += print.size;
    }
    return { ...bar, volume, buy_volume: buy, sell_volume: volume - buy, trade_count: prints.length } as BarFrame;
  });
}

/** Bar indices of the markers of one shape, in time order. */
export function markerIndices(markers: readonly MarkerCall[], bars: readonly BarFrame[], shape: MarkerCall["shape"]): number[] {
  return markers
    .filter((call) => call.shape === shape)
    .map((call) => bars.findIndex((bar) => bar.ts_open === call.time))
    .sort((a, b) => a - b);
}

export interface CvdBaselineSettings {
  K: number;
  m: number;
}

interface CvdBaselineState {
  ring: MarkerRingEntry[];
  base: number;
  tail: { tsOpen: number; committed: boolean; delta: number | null; close: number } | null;
  value: number | null;
  divergence: "bearish" | "bullish" | null;
  /** The divergence condition at the last committed bar, for the onset rule. */
  previousDivergence: "bearish" | "bullish" | null;
  heldNow: "bearish" | "bullish" | null;
}

function commitCvdTail(state: CvdBaselineState, K: number): void {
  const tail = state.tail;
  if (tail === null || tail.committed) return;
  tail.committed = true;
  if (tail.delta === null) {
    state.ring.length = 0;
    state.previousDivergence = null;
    return;
  }
  state.previousDivergence = state.heldNow;
  state.base += tail.delta;
  state.ring.push({ close: tail.close, largeBar: tail.delta, smallBar: 0, large: state.base });
  if (state.ring.length > K) state.ring.splice(0, state.ring.length - K);
}

/**
 * The "what candles alone show" baseline: the `orderFlow` cumulative delta from
 * `barSides`, with the indicator's divergence rule applied to it (the whole
 * candle delta plays the large tier, the small tier is zero). Tail-only
 * commits at the close or on supersession, like the indicator. Test-only.
 */
export const cvdDivergenceBaseline: RuntimeIndicatorDef<CvdBaselineState, CvdBaselineSettings> = {
  kind: "runtime",
  id: "cvdDivergenceBaselineTest",
  label: "CVD divergence baseline (test)",
  category: "l1",
  defaultSettings: { K: 20, m: 2 },
  lines: [{ key: "cvd" }],
  placement: { kind: "ownPane" },
  createState: () => ({ ring: [], base: 0, tail: null, value: null, divergence: null, previousDivergence: null, heldNow: null }),
  onBar: (ctx) => {
    const { bar, state, settings } = ctx;
    if (state.tail !== null && bar.ts_open < state.tail.tsOpen) return;
    if (state.tail !== null && bar.ts_open > state.tail.tsOpen) {
      commitCvdTail(state, settings.K);
      state.tail = null;
    }
    if (state.tail === null) state.tail = { tsOpen: bar.ts_open, committed: false, delta: null, close: bar.close };
    if (!state.tail.committed) {
      state.tail.delta = barDelta(bar);
      state.tail.close = bar.close;
    }
    const delta = state.tail.delta;
    if (delta === null) {
      state.value = null;
      state.divergence = null;
      state.heldNow = null;
    } else {
      const large = state.base + delta;
      const evaluation = evaluateMarkers(state.ring, { close: bar.close, largeBar: delta, smallBar: 0, large }, { conflict: false, divergence: state.previousDivergence }, { K: settings.K, m: settings.m, q: 2 });
      state.value = large;
      state.divergence = evaluation.divergence;
      state.heldNow = evaluation.divergenceHeld;
      if (evaluation.divergence !== null) {
        ctx.markers.plotshape({
          shape: evaluation.divergence === "bearish" ? "arrowDown" : "arrowUp",
          position: evaluation.divergence === "bearish" ? "aboveBar" : "belowBar",
          color: "#787b86",
          size: 1,
        });
      }
    }
    if (bar.closed && !state.tail.committed) commitCvdTail(state, settings.K);
  },
  readOutput: (state) => ({ cvd: state.value }),
};
