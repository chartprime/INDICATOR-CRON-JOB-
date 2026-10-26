import type { LineOutputSpec, RuntimeIndicatorDef } from "../../../chart/indicatorTypes";
import { ta } from "../../../chart/ta";
import type { Stream } from "../../../chart/ta/stream";
import { CB_BEAR_COLOR, CB_BULL_COLOR, CB_WARN_COLOR, withAlpha, type CompressionBreakoutSettings } from "../compressionBreakout";
import { createCompressionBreakoutEngine, type CompressionBreakoutEngine, type Qualifier, type Reading } from "../compressionBreakoutMath";

/**
 * The test-only comparator defs of the brief, each with the same output seams
 * the scoring reads (`breakDir`, `breakGrade`, `failed`, `heldOutside`,
 * `activeHigh`, `activeLow`) declared as lines so the harness records them.
 *
 * - `plainFrozenRangeBaseline`: the product's establishment, grading and
 *   outcome rules with no width qualifier at all (every ready window opens a
 *   range), amendment 8's "does compression selection discriminate" baseline.
 * - `squeezeQualifiedVariant`: the same machine qualified by Bollinger inside
 *   a Keltner-style channel over the committed window (the v2 clause's
 *   qualifier), so the comparison isolates the qualifier.
 * - `ttmReleaseComparator`: the library's TTM Squeeze releasing after at least
 *   six squeezed bars; direction from the momentum sign. Timing and density
 *   only: it has no level and no outcome.
 * - `bollingerCrossingComparator`: the first close outside a Bollinger band
 *   after an inside close. Timing and density only.
 */

const SEAMS = ["breakDir", "breakGrade", "gradeBasis", "failed", "heldOutside", "activeHigh", "activeLow"] as const;

interface EngineState {
  engine: CompressionBreakoutEngine;
  reading: Reading | null;
}

function engineDef(id: string, qualifier: Qualifier): RuntimeIndicatorDef<EngineState, CompressionBreakoutSettings> {
  return {
    kind: "runtime",
    id,
    label: id,
    category: "technical",
    defaultSettings: {
      rangeLength: 20,
      minCompressionBars: 6,
      confirmMultiple: 1.5,
      widthMultiple: 2,
      failBars: 5,
      holdBars: 40,
      trendFast: 50,
      trendSlow: 200,
      showMarkers: true,
      showRanges: true,
    },
    lines: SEAMS.map((key) => ({ key })) as readonly LineOutputSpec<EngineState>[],
    placement: { kind: "overlay" },
    createState: (settings) => ({ engine: createCompressionBreakoutEngine({ ...settings, qualifier }), reading: null }),
    onBar: (ctx) => {
      const reading = ctx.state.engine.onBar(ctx.bar);
      ctx.state.reading = reading;
      const d = reading.decision;
      if (d.kind === "break" && d.grade >= 1) {
        const base = d.dir > 0 ? CB_BULL_COLOR : CB_BEAR_COLOR;
        ctx.markers.plotshape({ shape: d.dir > 0 ? "arrowUp" : "arrowDown", position: d.dir > 0 ? "belowBar" : "aboveBar", color: d.grade === 3 ? base : withAlpha(base, 0.5), size: 1 });
      } else if (d.kind === "failed" && d.grade >= 1) {
        ctx.markers.plotshape({ shape: "circle", position: "inBar", color: CB_WARN_COLOR, size: 1 });
      }
    },
    readOutput: (state) => {
      const r = state.reading;
      if (r === null) return { breakDir: 0, breakGrade: 0, gradeBasis: 0, failed: 0, heldOutside: 0, activeHigh: null, activeLow: null };
      const isBreak = r.decision.kind === "break";
      return {
        breakDir: isBreak ? r.decision.dir : 0,
        breakGrade: isBreak ? r.decision.grade : 0,
        gradeBasis: isBreak ? r.decision.basis : 0,
        failed: r.decision.kind === "failed" ? 1 : 0,
        heldOutside: r.decision.kind === "heldOutside" ? 1 : 0,
        activeHigh: r.rangeHigh,
        activeLow: r.rangeLow,
      };
    },
  };
}

export const plainFrozenRangeBaseline = engineDef("plainFrozenRangeBaseline", "always");
export const squeezeQualifiedVariant = engineDef("squeezeQualifiedVariant", "squeeze");

interface TtmState {
  stream: Stream<{ high: number; low: number; close: number }, { isSqueezed: boolean; momentum: number }>;
  committedRun: number;
  pendingSqueezed: boolean | null;
  breakDir: number;
}

/** TTM Squeeze release: the first bar `isSqueezed` is false after at least `minSqueezedBars` consecutive true bars. */
export const ttmReleaseComparator: RuntimeIndicatorDef<TtmState, { minSqueezedBars: number }> = {
  kind: "runtime",
  id: "ttmReleaseComparator",
  label: "ttmReleaseComparator",
  category: "technical",
  defaultSettings: { minSqueezedBars: 6 },
  lines: [{ key: "breakDir" }],
  placement: { kind: "overlay" },
  createState: () => ({ stream: ta.ttmSqueeze(20, 2, 20, 1.5), committedRun: 0, pendingSqueezed: null, breakDir: 0 }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;
    if (!replace && state.pendingSqueezed !== null) state.committedRun = state.pendingSqueezed ? state.committedRun + 1 : 0;
    const result = state.stream.push({ high: bar.high, low: bar.low, close: bar.close }, replace);
    state.pendingSqueezed = result === null ? null : result.isSqueezed;
    state.breakDir = 0;
    if (result !== null && !result.isSqueezed && state.committedRun >= settings.minSqueezedBars) {
      state.breakDir = Math.sign(result.momentum);
      if (state.breakDir !== 0) ctx.markers.plotshape({ shape: state.breakDir > 0 ? "arrowUp" : "arrowDown", position: state.breakDir > 0 ? "belowBar" : "aboveBar", color: state.breakDir > 0 ? CB_BULL_COLOR : CB_BEAR_COLOR, size: 1 });
    }
  },
  readOutput: (state) => ({ breakDir: state.breakDir }),
};

interface BollingerState {
  stream: Stream<number, { lower: number; middle: number; upper: number }>;
  committedInside: boolean;
  pendingInside: boolean | null;
  breakDir: number;
}

/** Bollinger crossing: a close outside a band when the previous committed close was inside. */
export const bollingerCrossingComparator: RuntimeIndicatorDef<BollingerState, Record<string, never>> = {
  kind: "runtime",
  id: "bollingerCrossingComparator",
  label: "bollingerCrossingComparator",
  category: "technical",
  defaultSettings: {},
  lines: [{ key: "breakDir" }],
  placement: { kind: "overlay" },
  createState: () => ({ stream: ta.bollinger(20, 2), committedInside: true, pendingInside: null, breakDir: 0 }),
  onBar: (ctx) => {
    const { bar, state, replace } = ctx;
    if (!replace && state.pendingInside !== null) state.committedInside = state.pendingInside;
    const bands = state.stream.push(bar.close, replace);
    state.breakDir = 0;
    if (bands === null) {
      state.pendingInside = null;
      return;
    }
    const outsideUp = bar.close > bands.upper;
    const outsideDown = bar.close < bands.lower;
    state.pendingInside = !outsideUp && !outsideDown;
    if ((outsideUp || outsideDown) && state.committedInside) {
      state.breakDir = outsideUp ? 1 : -1;
      ctx.markers.plotshape({ shape: outsideUp ? "arrowUp" : "arrowDown", position: outsideUp ? "belowBar" : "aboveBar", color: outsideUp ? CB_BULL_COLOR : CB_BEAR_COLOR, size: 1 });
    }
  },
  readOutput: (state) => ({ breakDir: state.breakDir }),
};
