import type { BarFrame } from "../../../types/frames";

/**
 * Compression Range Breakout: the pure, incremental state machine.
 *
 * A committed `rangeLength`-bar high/low range qualifies when its width is at
 * most `widthMultiple` times the mean true range of the `rangeLength` valid
 * bars preceding that window. Its edges freeze the moment it opens. After
 * `minCompressionBars` committed bars whose close stayed inside, a close
 * outside is a break, graded by the break bar's true range and volume against
 * the preceding 20 valid observations. A close back inside (or beyond the
 * opposite edge) within `failBars` bars is a failure; otherwise the break is
 * "held outside". Failure, hold and a 500-bar lifetime retire the range; a
 * new one must qualify and establish again. No widening, no re-arm.
 *
 * Three named states (brief amendment 4): `P`, the committed state before the
 * tail bar, kept untouched for corrections of that tail; `W`, the working view
 * every evaluation reads (`P` plus the gap rule, never written); `C`, the
 * committed state after the tail's first closed dispatch, which seeds the next
 * `ts_open`. A forming revision evaluates against `P` only. A closed
 * re-dispatch of the tail recomputes `C` from `P`, so a cancelled break, a
 * removed failure, a changed grade and a validity flip in either field are all
 * one rule.
 *
 * Lifetime, the failure window and the hold countdown count committed
 * dispatched bars, invalid-price bars included (they skip every other commit
 * step); denominators count valid observations and carry no bar bound.
 *
 * No library stream drives an event: a never-closed bar left in a
 * `trading-signals` stream would change range creation. Every window here is a
 * finite ring of committed valid bars, so corrections and replays are exact.
 */

export const DAY_MS = 86_400_000;
export const RANGE_LIFETIME = 500;
export const DENOMINATOR_LENGTH = 20;
/** The fast-MA history holds this many committed values: the slope compares the newest with the one five bars earlier. */
export const SLOPE_HISTORY = 6;
/** One active handle and seven held ones in the pool of eight; the oldest held range gives way to a new one. */
export const MAX_HELD_RANGES = 7;

export type Qualifier = "width" | "always" | "squeeze";

export interface CompressionBreakoutMathSettings {
  rangeLength: number;
  widthMultiple: number;
  minCompressionBars: number;
  confirmMultiple: number;
  failBars: number;
  holdBars: number;
  trendFast: number;
  trendSlow: number;
  /** How a range qualifies; the product uses `width`. `always` and `squeeze` exist for the test-only comparator defs. */
  qualifier?: Qualifier;
}

export type BreakGrade = 0 | 1 | 2 | 3;
export type GradeBasis = 0 | 1 | 2 | 3;
export type Direction = 1 | -1;

export interface BreakRecord {
  /** `committedIndex` of the break bar. */
  index: number;
  tsOpen: number;
  dir: Direction;
  grade: BreakGrade;
  basis: GradeBasis;
}

export interface ActiveRange {
  hi: number;
  lo: number;
  /** `committedIndex` of the bar whose commit opened the range. */
  openedAt: number;
  openedTs: number;
  /** Committed bars since opening whose close stayed inside (or pending bars after a break). */
  age: number;
  /** Width over reference at qualification; null for the `always` qualifier. */
  widthRatio: number | null;
  broken: BreakRecord | null;
  excursionHi: number;
  excursionLo: number;
}

export type Outcome = "failed" | "heldOutside" | "expired";

export interface HeldRange {
  hi: number;
  lo: number;
  openedTs: number;
  /** `ts_open` of the bar whose commit retired the range. */
  closedTs: number;
  outcome: Outcome;
  /** Committed bars the range is still drawn for; removed at the commit after it reaches 0. */
  remaining: number;
}

export type EventKind = "break" | "failed" | "heldOutside" | "expired";

export interface LastEvent {
  kind: EventKind;
  index: number;
  tsOpen: number;
  dir: Direction;
  grade: BreakGrade;
  basis: GradeBasis;
}

export interface CommittedState {
  /** Valid committed highs and lows, capacity `rangeLength`. */
  highs: number[];
  lows: number[];
  /** Valid committed true ranges, capacity `2 × rangeLength` (at least 20). */
  trs: number[];
  /** Valid committed volumes (price valid too), capacity 20. */
  volumes: number[];
  /** Valid committed closes, capacity `trendSlow` (at least 20). */
  closes: number[];
  /** Committed fast-MA values, capacity 6. */
  fastHistory: number[];
  prevClose: number | null;
  lastCommittedTsOpen: number | null;
  /** Committed dispatched bars so far; the next bar's index. */
  committedIndex: number;
  /** Committed valid-price bars so far: readiness counts these, the rings being capped. */
  validCount: number;
  active: ActiveRange | null;
  held: HeldRange[];
  lastEvent: LastEvent | null;
}

export type DecisionKind = "none" | "invalidPrice" | "break" | "abandoned" | "expired" | "failed" | "heldOutside" | "pending";

export interface Decision {
  kind: DecisionKind;
  dir: Direction | 0;
  grade: BreakGrade;
  basis: GradeBasis;
  rangePassed: boolean;
  volumePassed: boolean;
}

export type TrendStatus = "ready" | "warming" | "fastGeSlow";

/** Everything one dispatch of a bar yields, read against `W`; the output snapshot is taken here, before any retirement. */
export interface Reading {
  tsOpen: number;
  intervalMs: number;
  confirmed: boolean;
  priceValid: boolean;
  volumeValid: boolean;
  gap: boolean;
  trueRange: number | null;
  /** Valid committed bars before this one, capped at the range-creation readiness count. */
  warmupCount: number;
  warmupNeeded: number;
  rangeReady: boolean;
  /** The active range as tested (armed, forming or pending); null otherwise. */
  active: ActiveRange | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  rangeAge: number | null;
  pending: 0 | 1;
  /** Committed bars since the break, this bar included, while pending; 0 otherwise. */
  pendingBars: number;
  /** Provisional qualification of the window ending at this bar (status row only). */
  qualified: boolean | null;
  widthRatio: number | null;
  trend: -1 | 0 | 1 | null;
  trendStatus: TrendStatus;
  closesCount: number;
  avgRange: number | null;
  avgVolume: number | null;
  gradeBasis: GradeBasis;
  decision: Decision;
  /** The held ranges to draw for this bar: `C.held` once closed, `P.held` while forming. */
  held: readonly HeldRange[];
  lastEvent: LastEvent | null;
}

export interface CompressionBreakoutEngine {
  readonly settings: CompressionBreakoutMathSettings;
  onBar(bar: BarFrame): Reading;
  readonly current: Reading | null;
  /** `P`: the committed state before the current tail. */
  readonly pre: CommittedState;
  /** `C`: the committed state after the tail's close (equals `P` while the tail is forming). */
  readonly committed: CommittedState;
}

export function normalizedSettings(settings: CompressionBreakoutMathSettings): Required<CompressionBreakoutMathSettings> {
  const int = (value: number, fallback: number, min: number, max: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
  const num = (value: number, fallback: number, min: number, max: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    rangeLength: int(settings.rangeLength, 20, 10, 50),
    widthMultiple: num(settings.widthMultiple, 2, 1, 4),
    minCompressionBars: int(settings.minCompressionBars, 6, 2, 30),
    confirmMultiple: num(settings.confirmMultiple, 1.5, 1, 3),
    failBars: int(settings.failBars, 5, 1, 20),
    holdBars: int(settings.holdBars, 40, 0, 200),
    trendFast: int(settings.trendFast, 50, 10, 199),
    trendSlow: int(settings.trendSlow, 200, 20, 400),
    qualifier: settings.qualifier ?? "width",
  };
}

export function createCommittedState(): CommittedState {
  return {
    highs: [],
    lows: [],
    trs: [],
    volumes: [],
    closes: [],
    fastHistory: [],
    prevClose: null,
    lastCommittedTsOpen: null,
    committedIndex: 0,
    validCount: 0,
    active: null,
    held: [],
    lastEvent: null,
  };
}

function cloneState(state: CommittedState): CommittedState {
  return {
    highs: state.highs.slice(),
    lows: state.lows.slice(),
    trs: state.trs.slice(),
    volumes: state.volumes.slice(),
    closes: state.closes.slice(),
    fastHistory: state.fastHistory.slice(),
    prevClose: state.prevClose,
    lastCommittedTsOpen: state.lastCommittedTsOpen,
    committedIndex: state.committedIndex,
    validCount: state.validCount,
    active: state.active === null ? null : { ...state.active, broken: state.active.broken === null ? null : { ...state.active.broken } },
    held: state.held.map((range) => ({ ...range })),
    lastEvent: state.lastEvent === null ? null : { ...state.lastEvent },
  };
}

export function isPriceValid(bar: BarFrame): boolean {
  const { open, high, low, close } = bar;
  return (
    Number.isFinite(open) &&
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    Number.isFinite(close) &&
    high >= low &&
    low <= close &&
    close <= high &&
    low <= open &&
    open <= high
  );
}

export function isVolumeValid(volume: unknown): volume is number {
  return typeof volume === "number" && Number.isFinite(volume) && volume >= 0;
}

/** Mean of the last `count` entries; null when fewer exist. */
export function tailMean(values: readonly number[], count: number): number | null {
  if (count <= 0 || values.length < count) return null;
  let sum = 0;
  for (let index = values.length - count; index < values.length; index += 1) sum += values[index];
  return sum / count;
}

/** Mean of `values[from, to)`; null when the slice is not fully present. */
function sliceMean(values: readonly number[], from: number, to: number): number | null {
  if (from < 0 || to > values.length || to <= from) return null;
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += values[index];
  return sum / (to - from);
}

function pushCapped(values: number[], value: number, capacity: number): void {
  values.push(value);
  if (values.length > capacity) values.splice(0, values.length - capacity);
}

/** True range against the previous committed close; `high − low` on the first bar and on the first bar after a gap. */
export function trueRangeOf(bar: BarFrame, prevClose: number | null, gap: boolean): number {
  const span = bar.high - bar.low;
  if (prevClose === null || gap) return span;
  return Math.max(span, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** A positive denominator from the last `DENOMINATOR_LENGTH` valid observations; null otherwise. */
export function denominatorOf(values: readonly number[]): number | null {
  const mean = tailMean(values, DENOMINATOR_LENGTH);
  return mean !== null && mean > 0 ? mean : null;
}

/** Population standard deviation of the last `count` values; null when fewer exist. */
function tailStdev(values: readonly number[], count: number, mean: number): number | null {
  if (values.length < count) return null;
  let sum = 0;
  for (let index = values.length - count; index < values.length; index += 1) sum += (values[index] - mean) ** 2;
  return Math.sqrt(sum / count);
}

export interface Qualification {
  ready: boolean;
  qualified: boolean;
  widthRatio: number | null;
  hi: number;
  lo: number;
}

/**
 * The qualification of the window formed by the last `rangeLength` entries of
 * the given rings. On the committed rings this decides whether a range opens;
 * with the tail appended provisionally it feeds the status row only.
 */
export function qualificationOf(
  highs: readonly number[],
  lows: readonly number[],
  trs: readonly number[],
  closes: readonly number[],
  settings: Required<CompressionBreakoutMathSettings>,
): Qualification {
  const length = settings.rangeLength;
  const none: Qualification = { ready: false, qualified: false, widthRatio: null, hi: Number.NaN, lo: Number.NaN };
  if (highs.length < length || lows.length < length || trs.length < 2 * length) return none;
  let hi = -Infinity;
  let lo = Infinity;
  for (let index = highs.length - length; index < highs.length; index += 1) hi = Math.max(hi, highs[index]);
  for (let index = lows.length - length; index < lows.length; index += 1) lo = Math.min(lo, lows[index]);
  const reference = sliceMean(trs, trs.length - 2 * length, trs.length - length);
  const widthRatio = reference !== null && reference > 0 ? (hi - lo) / reference : null;
  if (settings.qualifier === "always") return { ready: true, qualified: true, widthRatio, hi, lo };
  if (settings.qualifier === "squeeze") {
    if (closes.length < length) return none;
    const mean = tailMean(closes, length)!;
    const stdev = tailStdev(closes, length, mean)!;
    const atr = tailMean(trs, length)!;
    const squeezed = mean + 2 * stdev < mean + 1.5 * atr && mean - 2 * stdev > mean - 1.5 * atr;
    return { ready: true, qualified: squeezed, widthRatio, hi, lo };
  }
  return { ready: true, qualified: widthRatio !== null && widthRatio <= settings.widthMultiple, widthRatio, hi, lo };
}

export function createCompressionBreakoutEngine(input: CompressionBreakoutMathSettings): CompressionBreakoutEngine {
  const settings = normalizedSettings(input);
  const trCapacity = Math.max(2 * settings.rangeLength, DENOMINATOR_LENGTH);
  const closeCapacity = Math.max(settings.trendSlow, DENOMINATOR_LENGTH);
  const readinessCount = 2 * settings.rangeLength;
  let pre: CommittedState = createCommittedState();
  let committed: CommittedState = pre;
  let tailTsOpen: number | null = null;
  let current: Reading | null = null;

  function evaluate(P: CommittedState, bar: BarFrame): Reading {
    const priceValid = isPriceValid(bar);
    const volumeValid = isVolumeValid(bar.volume);
    const gap =
      P.lastCommittedTsOpen !== null &&
      Number.isFinite(bar.interval_ms) &&
      bar.interval_ms > 0 &&
      bar.interval_ms < DAY_MS &&
      bar.ts_open - P.lastCommittedTsOpen > bar.interval_ms;
    // W: P with the gap rule applied, never written.
    const active = gap ? null : P.active;
    const trueRange = priceValid ? trueRangeOf(bar, P.prevClose, gap) : null;
    const avgRange = denominatorOf(P.trs);
    const avgVolume = denominatorOf(P.volumes);
    const rangeTestable = avgRange !== null && trueRange !== null;
    const volumeTestable = avgVolume !== null && volumeValid;
    const gradeBasis = ((rangeTestable ? 1 : 0) + (volumeTestable ? 2 : 0)) as GradeBasis;

    // Provisional qualification: the window of rangeLength − 1 committed bars plus the tail.
    let qualified: boolean | null = null;
    let widthRatio: number | null = null;
    if (priceValid && P.highs.length >= settings.rangeLength - 1 && P.trs.length >= 2 * settings.rangeLength - 1) {
      const provisional = qualificationOf(
        [...P.highs, bar.high],
        [...P.lows, bar.low],
        [...P.trs, trueRange as number],
        [...P.closes, bar.close],
        settings,
      );
      if (provisional.ready) {
        qualified = provisional.qualified;
        widthRatio = provisional.widthRatio;
      }
    }

    // Trend, from committed closes only; the tail's close is compared with them.
    let trendStatus: TrendStatus = "warming";
    let trend: -1 | 0 | 1 | null = null;
    if (settings.trendFast >= settings.trendSlow) {
      trendStatus = "fastGeSlow";
    } else if (P.validCount >= settings.trendSlow + 5 && P.closes.length >= settings.trendSlow && P.fastHistory.length >= SLOPE_HISTORY) {
      trendStatus = "ready";
      if (priceValid) {
        const slowMa = tailMean(P.closes, settings.trendSlow) as number;
        const slope = P.fastHistory[P.fastHistory.length - 1] - P.fastHistory[0];
        trend = bar.close > slowMa && slope > 0 ? 1 : bar.close < slowMa && slope < 0 ? -1 : 0;
      }
    }

    // Decision, exactly one per bar, read against W.
    const index = P.committedIndex;
    let decision: Decision = { kind: "none", dir: 0, grade: 0, basis: gradeBasis, rangePassed: false, volumePassed: false };
    if (!priceValid) {
      decision = { ...decision, kind: "invalidPrice" };
    } else if (active !== null && active.broken !== null) {
      const inside = bar.close <= active.hi && bar.close >= active.lo;
      const opposite = active.broken.dir > 0 ? bar.close < active.lo : bar.close > active.hi;
      if (inside || opposite) decision = { ...decision, kind: "failed", dir: active.broken.dir, grade: active.broken.grade, basis: active.broken.basis };
      else if (index - active.broken.index >= settings.failBars)
        decision = { ...decision, kind: "heldOutside", dir: active.broken.dir, grade: active.broken.grade, basis: active.broken.basis };
      else decision = { ...decision, kind: "pending", dir: active.broken.dir, grade: active.broken.grade, basis: active.broken.basis };
    } else if (active !== null) {
      const dir: Direction | 0 = bar.close > active.hi ? 1 : bar.close < active.lo ? -1 : 0;
      if (dir !== 0) {
        if (active.age >= settings.minCompressionBars) {
          const rangePassed = rangeTestable && (trueRange as number) >= settings.confirmMultiple * (avgRange as number);
          const volumePassed = volumeTestable && bar.volume >= settings.confirmMultiple * (avgVolume as number);
          const grade: BreakGrade = rangePassed && volumePassed ? 3 : rangePassed ? 1 : volumePassed ? 2 : 0;
          decision = { kind: "break", dir, grade, basis: gradeBasis, rangePassed, volumePassed };
        } else {
          decision = { ...decision, kind: "abandoned", dir };
        }
      } else if (index - active.openedAt >= RANGE_LIFETIME) {
        decision = { ...decision, kind: "expired" };
      }
    }

    // Readiness counts committed valid-price bars plus this bar when its price is valid; the rings themselves are capped.
    const validThroughThisBar = P.validCount + (priceValid ? 1 : 0);
    return {
      tsOpen: bar.ts_open,
      intervalMs: bar.interval_ms,
      confirmed: bar.closed === true,
      priceValid,
      volumeValid,
      gap,
      trueRange,
      warmupCount: Math.min(validThroughThisBar, readinessCount),
      warmupNeeded: readinessCount,
      rangeReady: validThroughThisBar >= readinessCount,
      active,
      rangeHigh: active?.hi ?? null,
      rangeLow: active?.lo ?? null,
      rangeAge: active?.age ?? null,
      pending: active !== null && active.broken !== null ? 1 : 0,
      pendingBars: active !== null && active.broken !== null ? index - active.broken.index : 0,
      qualified,
      widthRatio,
      trend,
      trendStatus,
      closesCount: Math.min(P.validCount, settings.trendSlow + 5),
      avgRange,
      avgVolume,
      gradeBasis,
      decision,
      held: P.held,
      lastEvent: P.lastEvent,
    };
  }

  /** The commit of the tail's first closed dispatch: `C` from `P`, in the brief's order. */
  function commit(P: CommittedState, bar: BarFrame, reading: Reading): CommittedState {
    const C = cloneState(P);
    const index = P.committedIndex;
    // (a) held countdown: free the ones that reached zero at the previous commit, then count the rest down.
    C.held = C.held.filter((range) => range.remaining > 0).map((range) => ({ ...range, remaining: range.remaining - 1 }));
    if (reading.gap) C.active = null;
    if (reading.priceValid) {
      // (b) rings
      pushCapped(C.highs, bar.high, settings.rangeLength);
      pushCapped(C.lows, bar.low, settings.rangeLength);
      pushCapped(C.closes, bar.close, closeCapacity);
      pushCapped(C.trs, reading.trueRange as number, trCapacity);
      if (reading.volumeValid) pushCapped(C.volumes, bar.volume, DENOMINATOR_LENGTH);
      const fastMa = tailMean(C.closes, settings.trendFast);
      if (fastMa !== null) pushCapped(C.fastHistory, fastMa, SLOPE_HISTORY);
      // (c) the decision
      const decision = reading.decision;
      const active = C.active;
      if (active !== null) {
        switch (decision.kind) {
          case "break":
            active.broken = { index, tsOpen: bar.ts_open, dir: decision.dir as Direction, grade: decision.grade, basis: decision.basis };
            active.excursionHi = bar.high;
            active.excursionLo = bar.low;
            C.lastEvent = { kind: "break", index, tsOpen: bar.ts_open, dir: decision.dir as Direction, grade: decision.grade, basis: decision.basis };
            break;
          case "failed":
          case "heldOutside":
          case "expired": {
            const dir = (active.broken?.dir ?? (bar.close >= active.hi ? 1 : -1)) as Direction;
            C.lastEvent = { kind: decision.kind, index, tsOpen: bar.ts_open, dir, grade: active.broken?.grade ?? 0, basis: active.broken?.basis ?? 0 };
            retire(C, active, decision.kind, bar.ts_open);
            C.active = null;
            break;
          }
          case "abandoned":
            C.active = null;
            break;
          case "pending":
            active.excursionHi = Math.max(active.excursionHi, bar.high);
            active.excursionLo = Math.min(active.excursionLo, bar.low);
            active.age += 1;
            break;
          case "none":
            active.age += 1;
            break;
          default:
            break;
        }
      }
      // (d) a new range opens only on a bar with no event, from the committed rings.
      if (C.active === null && decision.kind === "none") {
        const qualification = qualificationOf(C.highs, C.lows, C.trs, C.closes, settings);
        if (qualification.ready && qualification.qualified) {
          C.active = {
            hi: qualification.hi,
            lo: qualification.lo,
            openedAt: index,
            openedTs: bar.ts_open,
            age: 0,
            widthRatio: qualification.widthRatio,
            broken: null,
            excursionHi: qualification.hi,
            excursionLo: qualification.lo,
          };
        }
      }
      C.prevClose = bar.close;
      C.validCount += 1;
    }
    // (e) every committed dispatched bar advances the clock, valid or not.
    C.lastCommittedTsOpen = bar.ts_open;
    C.committedIndex = index + 1;
    return C;
  }

  function retire(C: CommittedState, range: ActiveRange, outcome: Outcome, closedTs: number): void {
    const held: HeldRange = { hi: range.hi, lo: range.lo, openedTs: range.openedTs, closedTs, outcome, remaining: settings.holdBars };
    C.held.push(held);
    // One active handle and seven held ones: the oldest held range gives way to a new one.
    if (C.held.length > MAX_HELD_RANGES) C.held.splice(0, C.held.length - MAX_HELD_RANGES);
  }

  function onBar(bar: BarFrame): Reading {
    if (tailTsOpen !== null && bar.ts_open < tailTsOpen) {
      // Older than the tail: the runtime replays those as a REBUILT; here it is ignored.
      return current ?? evaluate(pre, bar);
    }
    if (tailTsOpen === null || bar.ts_open > tailTsOpen) {
      // A new ts_open: C seeds P; a tail superseded without closing wrote nothing.
      pre = committed;
      tailTsOpen = bar.ts_open;
    }
    const reading = evaluate(pre, bar);
    if (bar.closed === true) {
      committed = commit(pre, bar, reading);
      reading.held = committed.held;
      reading.lastEvent = committed.lastEvent;
    } else {
      committed = pre;
    }
    current = reading;
    return reading;
  }

  return {
    settings,
    onBar,
    get current() {
      return current;
    },
    get pre() {
      return pre;
    },
    get committed() {
      return committed;
    },
  };
}

