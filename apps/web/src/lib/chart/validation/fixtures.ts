import type { BarFrame, FrameIdentity, Side, TradeFrame } from "../../../types/frames";
import { barSides } from "../../indicators/barSides";
import { regularSessionAt } from "../marketCalendar";
import type { IndicatorL2 } from "../indicatorL2";
import type { IndicatorTicks } from "../indicatorTicks";
import type { TradeAvailability } from "../indicatorTypes";

/**
 * Labelled synthetic fixtures for the validation protocol
 * (`PM/cycle1/validation-protocol.md`). Every generator is deterministic for a
 * given seed and returns the bars together with the label a check needs: the
 * index of the breakout bar, the index of the volume spike, where the time gap
 * is. A descriptive indicator is judged against these labels, never against
 * what it happened to draw.
 */

export const MINUTE_MS = 60_000;
export const FIXTURE_T0 = 1_780_000_000_000;

export type FixtureIdentity = FrameIdentity & { symbol: string };

export const BINANCE_PERP: FixtureIdentity = Object.freeze({
  provider: "BINANCE",
  marketKind: "PERPETUAL",
  symbol: "BTC-USDT",
});
export const DXFEED_EQUITY: FixtureIdentity = Object.freeze({
  provider: "DXFEED",
  assetClass: "EQUITY",
  symbol: "AAPL",
});
export const DXFEED_FUTURE: FixtureIdentity = Object.freeze({
  provider: "DXFEED",
  assetClass: "FUTURE",
  symbol: "/NQU26:XCME",
});

/** Linear congruential generator: the same seed gives the same fixture on every machine. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface FixtureOptions {
  seed?: number;
  count?: number;
  startTs?: number;
  intervalMs?: number;
  startPrice?: number;
  identity?: FixtureIdentity;
  /** Base volume per bar; the generators vary around it. */
  baseVolume?: number;
}

export interface LabelledBars<L> {
  bars: BarFrame[];
  labels: L;
}

export interface BarSpec {
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  /** Share of volume that was taker buying; omit for an unsided bar. */
  buyShare?: number;
  tradeCount?: number | null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function barFrame(
  ts_open: number,
  spec: BarSpec,
  identity: FixtureIdentity = BINANCE_PERP,
  intervalMs = MINUTE_MS,
  closed = true,
): BarFrame {
  const volume = round(spec.volume, 4);
  const frame: Record<string, unknown> = {
    type: "bar",
    ...identity,
    interval_ms: intervalMs,
    ts_open,
    open: round(spec.open),
    high: round(Math.max(spec.high, spec.open, spec.close)),
    low: round(Math.min(spec.low, spec.open, spec.close)),
    close: round(spec.close),
    volume,
    trade_count: spec.tradeCount === undefined ? Math.max(1, Math.round(volume / 3)) : spec.tradeCount,
    closed,
  };
  if (spec.buyShare !== undefined) {
    const buy = round(volume * Math.min(1, Math.max(0, spec.buyShare)), 4);
    frame.buy_volume = buy;
    frame.sell_volume = round(volume - buy, 4);
  }
  return frame as BarFrame;
}

function defaults(options: FixtureOptions) {
  return {
    seed: options.seed ?? 7,
    count: options.count ?? 600,
    startTs: options.startTs ?? FIXTURE_T0,
    intervalMs: options.intervalMs ?? MINUTE_MS,
    startPrice: options.startPrice ?? 60_000,
    identity: options.identity ?? BINANCE_PERP,
    baseVolume: options.baseVolume ?? 100,
  };
}

/** A candle from one path step: open at `open`, close at `close`, wicks of `wick` beyond the body. */
function candle(open: number, close: number, wick: number, volume: number, buyShare: number): BarSpec {
  return {
    open,
    close,
    high: Math.max(open, close) + wick,
    low: Math.min(open, close) - wick,
    volume,
    buyShare,
  };
}

export interface TrendLabels {
  regime: "trend";
  direction: 1 | -1;
  startPrice: number;
  endPrice: number;
  driftPerBar: number;
}

/** A persistent drift with noise smaller than the drift, so every 20-bar window moves with the trend. */
export function trendBars(
  options: FixtureOptions & { direction?: 1 | -1; driftPerBar?: number; noise?: number } = {},
): LabelledBars<TrendLabels> {
  const { seed, count, startTs, intervalMs, startPrice, identity, baseVolume } = defaults(options);
  const direction = options.direction ?? 1;
  const drift = (options.driftPerBar ?? 12) * direction;
  const noise = options.noise ?? 8;
  const random = seeded(seed);
  const bars: BarFrame[] = [];
  let price = startPrice;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const close = Math.max(1, open + drift + (random() - 0.5) * 2 * noise);
    const volume = baseVolume * (0.7 + random() * 0.6);
    const buyShare = 0.5 + direction * 0.1 + (random() - 0.5) * 0.1;
    bars.push(barFrame(startTs + index * intervalMs, candle(open, close, random() * noise, volume, buyShare), identity, intervalMs));
    price = bars[bars.length - 1].close;
  }
  return { bars, labels: { regime: "trend", direction, startPrice, endPrice: price, driftPerBar: drift } };
}

export interface RangeLabels {
  regime: "range";
  center: number;
  halfWidth: number;
  low: number;
  high: number;
}

/** Mean-reverting noise inside `[center - halfWidth, center + halfWidth]`; no high or low leaves the band. */
export function rangeBars(
  options: FixtureOptions & { halfWidth?: number } = {},
): LabelledBars<RangeLabels> {
  const { seed, count, startTs, intervalMs, startPrice, identity, baseVolume } = defaults(options);
  const halfWidth = options.halfWidth ?? 150;
  const random = seeded(seed);
  const bars: BarFrame[] = [];
  let price = startPrice;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const pull = (startPrice - open) * 0.2;
    let close = open + pull + (random() - 0.5) * halfWidth * 0.6;
    close = Math.min(startPrice + halfWidth * 0.9, Math.max(startPrice - halfWidth * 0.9, close));
    const room = halfWidth - Math.max(Math.abs(close - startPrice), Math.abs(open - startPrice));
    const wick = Math.max(0, Math.min(random() * halfWidth * 0.1, room));
    const volume = baseVolume * (0.7 + random() * 0.6);
    bars.push(barFrame(startTs + index * intervalMs, candle(open, close, wick, volume, 0.45 + random() * 0.1), identity, intervalMs));
    price = bars[bars.length - 1].close;
  }
  return {
    bars,
    labels: { regime: "range", center: startPrice, halfWidth, low: startPrice - halfWidth, high: startPrice + halfWidth },
  };
}

export interface CompressionBreakoutLabels {
  regime: "compressionBreakout";
  /** First bar of the contracting range. */
  compressionStart: number;
  /** The bar that first closes outside the compression range; also the first bar of the trend that follows. */
  breakoutIndex: number;
  compressionHigh: number;
  compressionLow: number;
  direction: 1 | -1;
}

export interface CompressionSeriesOptions extends FixtureOptions {
  leadBars?: number;
  compressionBars?: number;
  direction?: 1 | -1;
  initialHalfWidth?: number;
  finalHalfWidth?: number;
}

type CompressionAftermath = "trend" | "fail" | "hold";

/**
 * The one generator behind the three compression fixtures: a wide range over
 * `leadBars`, a range contracting bar by bar over `compressionBars`, the bar
 * that closes well outside the compressed range, then the aftermath. The
 * random stream is identical for every aftermath through `breakoutIndex`, so
 * the three fixtures share their lead, their compression and their break bar.
 */
function compressionSeries(options: CompressionSeriesOptions, aftermath: CompressionAftermath): LabelledBars<CompressionBreakoutLabels> {
  const { seed, count, startTs, intervalMs, startPrice, identity, baseVolume } = defaults({ count: 400, ...options });
  const leadBars = options.leadBars ?? 100;
  const compressionBars = options.compressionBars ?? 120;
  const direction = options.direction ?? 1;
  const initialHalfWidth = options.initialHalfWidth ?? 300;
  const finalHalfWidth = options.finalHalfWidth ?? 30;
  const breakoutIndex = leadBars + compressionBars;
  if (breakoutIndex >= count - 1) throw new Error("compressionBreakoutBars: count must leave room for the breakout");
  const random = seeded(seed);
  const bars: BarFrame[] = [];
  let price = startPrice;
  let compressionHigh = -Infinity;
  let compressionLow = Infinity;
  const compressionBar = (progress: number, volumeScale: (random: () => number) => number): BarSpec => {
    const halfWidth = initialHalfWidth + (finalHalfWidth - initialHalfWidth) * progress;
    const open = Math.min(startPrice + halfWidth * 0.8, Math.max(startPrice - halfWidth * 0.8, price));
    const target = startPrice + (random() - 0.5) * 2 * halfWidth * 0.8;
    const close = open + (target - open) * 0.6;
    const room = halfWidth - Math.max(Math.abs(close - startPrice), Math.abs(open - startPrice));
    const wick = Math.max(0, Math.min(random() * halfWidth * 0.2, room));
    return candle(open, close, wick, baseVolume * volumeScale(random), 0.5 + (random() - 0.5) * 0.06);
  };
  for (let index = 0; index < count; index += 1) {
    let spec: BarSpec;
    if (index < leadBars) {
      const open = price;
      const raw = open + (startPrice - open) * 0.15 + (random() - 0.5) * initialHalfWidth * 0.5;
      const close = Math.min(startPrice + initialHalfWidth * 0.8, Math.max(startPrice - initialHalfWidth * 0.8, raw));
      spec = candle(open, close, random() * initialHalfWidth * 0.1, baseVolume * (0.8 + random() * 0.4), 0.5 + (random() - 0.5) * 0.1);
    } else if (index < breakoutIndex) {
      const progress = (index - leadBars) / Math.max(1, compressionBars - 1);
      spec = compressionBar(progress, (r) => 0.9 - progress * 0.4 + r() * 0.2);
      compressionHigh = Math.max(compressionHigh, spec.high);
      compressionLow = Math.min(compressionLow, spec.low);
    } else if (index === breakoutIndex) {
      const open = price;
      const edge = direction > 0 ? compressionHigh : compressionLow;
      const close = edge + direction * initialHalfWidth * 0.5;
      spec = {
        open,
        close,
        high: direction > 0 ? close + 5 : open + 5,
        low: direction > 0 ? open - 5 : close - 5,
        volume: baseVolume * 3,
        buyShare: direction > 0 ? 0.75 : 0.25,
      };
    } else if (aftermath === "fail" && index === breakoutIndex + 1) {
      // Straight back to the middle of the range on ordinary volume: the failure bar.
      const open = price;
      const close = startPrice;
      spec = { open, close, high: Math.max(open, close) + 5, low: Math.min(open, close) - 5, volume: baseVolume * 1.5, buyShare: 0.5 };
    } else if (aftermath === "fail") {
      // The compression generator at progress 1, on reduced volume.
      spec = compressionBar(1, (r) => 0.5 + 0.2 * r());
    } else if (aftermath === "hold") {
      // Drift with no trend, never closer to the range than a fifth of the initial half width beyond its edge.
      const edge = direction > 0 ? compressionHigh : compressionLow;
      const open = price;
      const raw = open + (random() - 0.5) * 16;
      const close = direction > 0 ? Math.max(edge + 0.2 * initialHalfWidth, raw) : Math.min(edge - 0.2 * initialHalfWidth, raw);
      spec = candle(open, close, random() * 8, baseVolume * (1 + random() * 0.6), 0.5 + direction * 0.12 + (random() - 0.5) * 0.08);
    } else {
      const open = price;
      const close = Math.max(1, open + direction * 10 + (random() - 0.5) * 16);
      spec = candle(open, close, random() * 8, baseVolume * (1 + random() * 0.6), 0.5 + direction * 0.12 + (random() - 0.5) * 0.08);
    }
    bars.push(barFrame(startTs + index * intervalMs, spec, identity, intervalMs));
    price = bars[bars.length - 1].close;
  }
  return {
    bars,
    labels: {
      regime: "compressionBreakout",
      compressionStart: leadBars,
      breakoutIndex,
      compressionHigh: round(compressionHigh),
      compressionLow: round(compressionLow),
      direction,
    },
  };
}

/**
 * A wide range that contracts bar by bar over `compressionBars`, then a bar
 * that closes well outside the compressed range and a trend that follows.
 * `breakoutIndex` is the bar to detect; anything earlier is a false positive
 * and anything later is late.
 */
export function compressionBreakoutBars(options: CompressionSeriesOptions = {}): LabelledBars<CompressionBreakoutLabels> {
  return compressionSeries(options, "trend");
}

export interface CompressionFailedBreakLabels extends CompressionBreakoutLabels {
  /** The bar after the break that closes back at the middle of the range. */
  failIndex: number;
}

/**
 * `compressionBreakoutBars` through the break bar (identical random stream), then
 * a bar closing back at `startPrice` on 1.5× base volume, then compression bars
 * at progress 1 on half volume: the labelled failed break.
 */
export function compressionFailedBreakBars(options: CompressionSeriesOptions = {}): LabelledBars<CompressionFailedBreakLabels> {
  const { bars, labels } = compressionSeries(options, "fail");
  return { bars, labels: { ...labels, failIndex: labels.breakoutIndex + 1 } };
}

export interface CompressionContinuationLabels extends CompressionBreakoutLabels {
  /** Five bars after the break, every close still beyond the edge: the labelled "held outside". */
  heldIndex: number;
  heldBars: number;
}

/**
 * `compressionBreakoutBars` through the break bar (identical random stream), then
 * closes held at least a fifth of the initial half width beyond the broken edge
 * with no trend: the labelled continuation.
 */
export function compressionContinuationBars(options: CompressionSeriesOptions & { heldBars?: number } = {}): LabelledBars<CompressionContinuationLabels> {
  const heldBars = options.heldBars ?? 5;
  const { bars, labels } = compressionSeries(options, "hold");
  return { bars, labels: { ...labels, heldIndex: labels.breakoutIndex + heldBars, heldBars } };
}

export interface LongCompressionLabels extends CompressionBreakoutLabels {
  /** Where the adversarial replay test rebuilds from, as if the earlier bars had left retention. */
  rebuildFromIndex: number;
}

/** A coil that outlives a 500-bar range lifetime: 40 lead bars, 700 compression bars, the break at 740, 1,400 bars in all. */
export function longCompressionBars(options: CompressionSeriesOptions & { rebuildFromIndex?: number } = {}): LabelledBars<LongCompressionLabels> {
  const { bars, labels } = compressionSeries({ leadBars: 40, compressionBars: 700, count: 1_400, ...options }, "trend");
  return { bars, labels: { ...labels, rebuildFromIndex: options.rebuildFromIndex ?? 300 } };
}

export interface ConstantWidthLabels {
  regime: "constantWidth";
  /** Every 20-bar window spans exactly this. */
  width: number;
  /** Every bar's true range, so width over the preceding mean true range is `width / trueRange`. */
  trueRange: number;
  /** Rebuild offsets the replay-policy test uses to pin the phase difference. */
  rebuildOffsets: readonly number[];
}

/**
 * The replay-policy fixture of brief amendment 1: a constant-width band with a
 * non-zero true range on every bar and no close ever beyond the band's
 * extremes, so a frozen range qualifies at every window, never breaks and
 * expires at the lifetime; a live instance and one rebuilt from an offset then
 * open their ranges at different phases for as long as the series lasts.
 * Bars alternate between a down bar closing at `center − amplitude` and an up
 * bar closing at `center + amplitude`, wicks of 5 beyond the body.
 */
export function constantWidthBars(
  options: FixtureOptions & { amplitude?: number; rebuildOffsets?: readonly number[] } = {},
): LabelledBars<ConstantWidthLabels> {
  const { count, startTs, intervalMs, startPrice, identity, baseVolume } = defaults({ count: 3_000, ...options });
  const amplitude = options.amplitude ?? 50;
  const wick = 5;
  const bars: BarFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    const up = index % 2 === 1;
    const open = up ? startPrice - amplitude : startPrice + amplitude;
    const close = up ? startPrice + amplitude : startPrice - amplitude;
    bars.push(barFrame(startTs + index * intervalMs, candle(open, close, wick, baseVolume, 0.5), identity, intervalMs));
  }
  return {
    bars,
    labels: {
      regime: "constantWidth",
      width: 2 * amplitude + 2 * wick,
      trueRange: 2 * amplitude + 2 * wick,
      rebuildOffsets: options.rebuildOffsets ?? [0, 137, 500],
    },
  };
}

export interface VolumeSpikeLabels {
  regime: "volumeSpike";
  spikeIndex: number;
  spikeMultiple: number;
  baselineVolume: number;
}

/** Range-like price with ordinary volume, and one bar carrying `spikeMultiple` times the baseline. */
export function volumeSpikeBars(
  options: FixtureOptions & { spikeIndex?: number; spikeMultiple?: number } = {},
): LabelledBars<VolumeSpikeLabels> {
  const { count, baseVolume } = defaults(options);
  const spikeIndex = options.spikeIndex ?? Math.floor(count * 0.7);
  const spikeMultiple = options.spikeMultiple ?? 10;
  if (spikeIndex < 0 || spikeIndex >= count) throw new Error("volumeSpikeBars: spikeIndex is outside the series");
  const { bars } = rangeBars(options);
  const volume = round(baseVolume * spikeMultiple, 4);
  bars[spikeIndex] = {
    ...bars[spikeIndex],
    volume,
    buy_volume: round(volume * 0.5, 4),
    sell_volume: round(volume * 0.5, 4),
    trade_count: Math.round(volume / 3),
  } as BarFrame;
  return { bars, labels: { regime: "volumeSpike", spikeIndex, spikeMultiple, baselineVolume: baseVolume } };
}

export interface TimeGapLabels {
  regime: "timeGap";
  /** The last bar before the hole. */
  gapAfterIndex: number;
  /** The first bar after the hole: next in the array, `missingBars + 1` intervals later in time. */
  firstBarAfterGapIndex: number;
  missingBars: number;
  gapMs: number;
}

/**
 * A contiguous series with `missingBars` minutes removed after `gapAfterIndex`.
 * The array stays strictly chronological, so the runtime accepts it; an
 * indicator that assumes `ts_open` advances by one interval per bar is wrong
 * at `firstBarAfterGapIndex`.
 */
export function timeGapBars(
  options: FixtureOptions & { gapAfterIndex?: number; missingBars?: number } = {},
): LabelledBars<TimeGapLabels> {
  const { count, intervalMs } = defaults(options);
  const gapAfterIndex = options.gapAfterIndex ?? Math.floor(count / 2);
  const missingBars = options.missingBars ?? 15;
  if (gapAfterIndex < 0 || gapAfterIndex >= count - 1) throw new Error("timeGapBars: gapAfterIndex must leave bars on both sides");
  const { bars } = trendBars({ ...options, driftPerBar: 2, noise: 20 });
  const shifted = bars.map((bar, index) =>
    index > gapAfterIndex ? ({ ...bar, ts_open: bar.ts_open + missingBars * intervalMs } as BarFrame) : bar,
  );
  return {
    bars: shifted,
    labels: {
      regime: "timeGap",
      gapAfterIndex,
      firstBarAfterGapIndex: gapAfterIndex + 1,
      missingBars,
      gapMs: (missingBars + 1) * intervalMs,
    },
  };
}

export interface EquityUnsidedLabels {
  regime: "equityUnsided";
  /** Bars that carry no side at all (`barSides(bar).known === false`). */
  unsidedIndices: number[];
  /** Bars that carry both sides and an unknown remainder (`barSides(bar).unknown > 0`). */
  partiallySidedIndices: number[];
  unknownShare: number;
}

/**
 * A dxFeed equity series the way the terminal really sees one: some minutes
 * carry no side at all (a live bar carries sides only when every print had
 * one), and the others carry both sides with an unsided remainder. An
 * indicator that reads sides must draw `null` on the first group and must not
 * count the remainder as selling on the second.
 */
export function equityUnsidedBars(
  options: FixtureOptions & { unsidedEvery?: number; unknownShare?: number } = {},
): LabelledBars<EquityUnsidedLabels> {
  const unsidedEvery = options.unsidedEvery ?? 3;
  const unknownShare = options.unknownShare ?? 0.4;
  const { bars } = trendBars({
    ...options,
    identity: options.identity ?? DXFEED_EQUITY,
    startPrice: options.startPrice ?? 190,
    driftPerBar: 0.02,
    noise: 0.3,
  });
  const unsidedIndices: number[] = [];
  const partiallySidedIndices: number[] = [];
  const out = bars.map((bar, index) => {
    const { buy_volume: _buy, sell_volume: _sell, ...rest } = bar;
    if (index % unsidedEvery === 0) {
      unsidedIndices.push(index);
      return rest as BarFrame;
    }
    partiallySidedIndices.push(index);
    const sided = bar.volume * (1 - unknownShare);
    return { ...rest, buy_volume: round(sided * 0.55, 4), sell_volume: round(sided * 0.45, 4) } as BarFrame;
  });
  return { bars: out, labels: { regime: "equityUnsided", unsidedIndices, partiallySidedIndices, unknownShare } };
}

/** What an `Arrival.act` hook may touch; the live driver supplies the concrete session. */
export interface ArrivalSession {
  bars: readonly BarFrame[];
  setTicks(ticks: IndicatorTicks | null): void;
  setL2(l2: IndicatorL2 | null): void;
  updateSettings(settings: unknown): void;
}

/**
 * One bar's arrival at the chart, in the order the terminal would see it. The
 * live driver classifies it with the chart's own `mergeChartBar`, so a repeated
 * closed bar becomes `REPLACED_EDGE` and a late bar becomes `REBUILT` exactly
 * as they would in `ChartPanel`.
 */
export interface Arrival {
  bar: BarFrame;
  trades?: readonly TradeFrame[];
  tradeAvailability?: TradeAvailability;
  /** Something that happens just before this bar arrives: a reconnect, a tick store reset, a settings change. */
  act?: (session: ArrivalSession) => void;
  label?: string;
}

export interface LabelledArrivals<L> {
  arrivals: Arrival[];
  labels: L;
}

function barPath(bar: BarFrame, points: number): number[] {
  const up = bar.close >= bar.open;
  const anchors = up ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
  const out: number[] = [];
  for (let index = 0; index < points; index += 1) {
    const t = ((index + 1) / (points + 1)) * (anchors.length - 1);
    const segment = Math.min(anchors.length - 2, Math.floor(t));
    const within = t - segment;
    out.push(anchors[segment] + (anchors[segment + 1] - anchors[segment]) * within);
  }
  return out;
}

/**
 * The forming revisions of one closed bar: `revisions` frames that walk the
 * bar's path from its open through its wicks to its close, each `closed:
 * false`, followed by the closed bar itself. The chart appends the first one
 * and replaces the edge with each later one, which is how a live bar really
 * reaches an indicator many times before it is committed.
 */
export function formingRevisions(bar: BarFrame, revisions: number): BarFrame[] {
  if (revisions <= 0) return [bar];
  const path = barPath(bar, revisions);
  const out: BarFrame[] = [];
  let high = bar.open;
  let low = bar.open;
  // Sides are read through barSides and scaled independently, so a revision
  // keeps the bar's buy, sell and unknown shares: unsided equity volume stays
  // unknown instead of being turned into selling by `volume - buy`.
  const sides = barSides(bar);
  for (let index = 0; index < revisions; index += 1) {
    const close = path[index];
    high = Math.max(high, close);
    low = Math.min(low, close);
    const share = (index + 1) / (revisions + 1);
    const volume = round(bar.volume * share, 4);
    const partial: Record<string, unknown> = { ...bar, high: round(high), low: round(low), close: round(close), volume, closed: false };
    if (bar.trade_count !== null) partial.trade_count = Math.max(1, Math.round(bar.trade_count * share));
    if (sides.known) {
      partial.buy_volume = round(sides.buy * share, 4);
      if (bar.sell_volume !== undefined && bar.sell_volume !== null) partial.sell_volume = round(sides.sell * share, 4);
    }
    out.push(partial as BarFrame);
  }
  out.push(bar);
  return out;
}

/** Every bar arriving live: `revisionsPerBar` forming revisions, then the closed bar. */
export function liveArrivals(
  bars: readonly BarFrame[],
  revisionsPerBar: number,
  tradesFor?: (bar: BarFrame, revision: number, revisions: number) => Pick<Arrival, "trades" | "tradeAvailability">,
): Arrival[] {
  const out: Arrival[] = [];
  for (const bar of bars) {
    const frames = formingRevisions(bar, revisionsPerBar);
    frames.forEach((frame, revision) => {
      out.push({ bar: frame, ...(tradesFor ? tradesFor(frame, revision, frames.length) : {}) });
    });
  }
  return out;
}

export interface DuplicateClosedLabels {
  duplicateIndex: number;
}

/** Closed bars arriving in order, with the bar at `duplicateIndex` delivered twice (a repeated closed dispatch). */
export function duplicateClosedArrivals(bars: readonly BarFrame[], duplicateIndex: number): LabelledArrivals<DuplicateClosedLabels> {
  if (duplicateIndex < 0 || duplicateIndex >= bars.length) throw new Error("duplicateClosedArrivals: index outside the series");
  const arrivals: Arrival[] = [];
  bars.forEach((bar, index) => {
    arrivals.push({ bar });
    if (index === duplicateIndex) arrivals.push({ bar, label: "duplicate" });
  });
  return { arrivals, labels: { duplicateIndex } };
}

export interface RebuiltLabels {
  /** The bar that arrives late. */
  lateIndex: number;
  /** It arrives after this bar, so the chart has to rebuild. */
  arrivesAfterIndex: number;
}

/**
 * Closed bars arriving in order except `bars[lateIndex]`, which arrives after
 * `bars[lateIndex + lateBy]`. `mergeChartBar` classifies the late bar as
 * `REBUILT`, which makes the runtime replay the whole series.
 */
export function rebuiltArrivals(bars: readonly BarFrame[], lateIndex: number, lateBy = 2): LabelledArrivals<RebuiltLabels> {
  const arrivesAfterIndex = lateIndex + lateBy;
  if (lateIndex < 0 || lateBy < 1 || arrivesAfterIndex >= bars.length) throw new Error("rebuiltArrivals: the late bar must arrive inside the series");
  const arrivals: Arrival[] = [];
  bars.forEach((bar, index) => {
    if (index === lateIndex) return;
    arrivals.push({ bar });
    if (index === arrivesAfterIndex) arrivals.push({ bar: bars[lateIndex], label: "late" });
  });
  return { arrivals, labels: { lateIndex, arrivesAfterIndex } };
}

/** A trade frame on the fixture's identity. */
export function tradeFrame(
  ts_exchange: number,
  price: number,
  size: number,
  side: Side = "buy",
  identity: FixtureIdentity = BINANCE_PERP,
  trade_id = `${identity.symbol}-${ts_exchange}-${price}-${size}-${side}`,
): TradeFrame {
  return { type: "trade", ...identity, ts_exchange, price, size, side, trade_id } as TradeFrame;
}

/** `[0, step, 2·step, …]` plus the last `tail` indices: a cheaper truncation sweep for long series. */
export function sampledIndices(count: number, step: number, tail = 20): number[] {
  const out = new Set<number>();
  for (let index = 0; index < count; index += Math.max(1, step)) out.add(index);
  for (let index = Math.max(0, count - tail); index < count; index += 1) out.add(index);
  return [...out].sort((a, b) => a - b);
}

/*
 * Frozen fixtures for the cycle-1 Relative Volume (Time of Day) build
 * (`PM/cycle1/brief-rvol-clock.md`, "Baseline comparison" and "Crypto
 * fixture"). The builder and the validation loop import the same functions, so
 * the numbers quoted in the doc page are reproducible from here alone. Every
 * choice the brief leaves open is fixed in the doc comments below.
 */

/** mulberry32, the PRNG the brief names; the same implementation the swing alphabet profile uses. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normals by Box-Muller over `uniform`: two uniforms per pair,
 * `z0 = r·cos(2πu2)` then `z1 = r·sin(2πu2)` with `r = sqrt(-2·ln(1 - u1))`
 * (`1 - u1` keeps the logarithm finite when the generator returns 0). Both
 * outputs are used, in that order, before the next pair is drawn.
 */
export function standardNormals(uniform: () => number): () => number {
  let pending: number | null = null;
  return () => {
    if (pending !== null) {
      const z = pending;
      pending = null;
      return z;
    }
    const u1 = uniform();
    const u2 = uniform();
    const r = Math.sqrt(-2 * Math.log(1 - u1));
    pending = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
}

export const RVOL_EQUITY_SEED = 20261026;
export const RVOL_CRYPTO_SEED = 20261027;
export const RVOL_BASE_VOLUME = 1_000;
export const RVOL_NOISE_SIGMA = 0.15;
export const RVOL_EQUITY_SESSIONS = 15;
export const RVOL_EQUITY_BARS_PER_SESSION = 390;
export const RVOL_EQUITY_ANOMALIES = 12;
export const RVOL_ANOMALY_MULTIPLE = 2.5;
export const RVOL_CRYPTO_BARS = 12_000;
/** The brief's "first 10,080 bars" timing window and the REBUILT replay start (bars 1,921..12,000). */
export const RVOL_CRYPTO_TIMING_BARS = 10_080;
export const RVOL_CRYPTO_REBUILT_FROM_INDEX = 1_920;

/** `E(m)` for the equity U-curve: an opening surge decaying over an hour, flat midday, a linear rise into the close. */
export function relativeVolumeExpectedEquity(minute: number, baseVolume = RVOL_BASE_VOLUME): number {
  if (minute < 60) return baseVolume * (1 + 3 * Math.max(0, 1 - minute / 60) ** 2);
  if (minute <= 330) return baseVolume;
  return baseVolume * (1 + (minute - 330) / 59);
}

/** `E(m)` for crypto: one cosine over the UTC day, peaking at 14:00 UTC (minute 840). */
export function relativeVolumeExpectedCrypto(minuteOfDay: number, baseVolume = RVOL_BASE_VOLUME): number {
  return baseVolume * (1 + 0.5 * Math.cos((2 * Math.PI * (minuteOfDay - 840)) / 1440));
}

function noisyVolume(expected: number, z: number): number {
  return Math.round(expected * Math.exp(RVOL_NOISE_SIGMA * z));
}

/** A deterministic, random-free price path so the volume generator's stream is the only source of randomness. */
function rvolBar(ts_open: number, index: number, volume: number, basePrice: number, amplitude: number, identity: FixtureIdentity, sided: boolean): BarFrame {
  const close = round(basePrice + amplitude * Math.sin(index / 40), 2);
  const open = round(basePrice + amplitude * Math.sin((index - 1) / 40), 2);
  const spec: BarSpec = { open, close, high: Math.max(open, close) + amplitude * 0.02, low: Math.min(open, close) - amplitude * 0.02, volume, tradeCount: Math.max(1, Math.round(volume / 5)) };
  if (sided) spec.buyShare = 0.5;
  return barFrame(ts_open, spec, identity, MINUTE_MS);
}

export interface RelativeVolumeAnomaly {
  /** 1-based session number, as the brief counts them. */
  session: number;
  /** Minute of the session, 0..389. */
  minute: number;
  /** Position in `bars`. */
  index: number;
  expectedVolume: number;
  /** `round(2.5 · E(m))`, the volume written into the bar. */
  volume: number;
}

export interface RelativeVolumeEquityLabels {
  regime: "relativeVolumeEquity" | "relativeVolumeEquityFlat";
  seed: number;
  baseVolume: number;
  sessions: number;
  barsPerSession: number;
  /** `ts_open` of each session's first bar (09:30 New York), in order. */
  sessionStarts: number[];
  /** New York calendar date of each session. */
  sessionDates: string[];
  /** `E(m)` for every minute of a session. */
  expectedVolumes: number[];
  anomalies: RelativeVolumeAnomaly[];
  anomalyIndices: number[];
  /** Bars at minutes 0..9 and 380..389, every session: the slots where volume is always loud and a rolling baseline misfires. */
  predictableSlotIndices: number[];
  /** Every bar of sessions 4..15; a method's own readiness narrows it further. */
  evaluationIndices: number[];
  evaluationSessions: { first: number; last: number };
  /** Sessions 1..5 trade on EST and 6..15 on EDT: same New York start minute, different UTC offset. */
  dstChangeAfterSession: number;
}

export interface RelativeVolumeEquityOptions {
  /** The control experiment: `E(m) = V` and anomalies drawn from every minute. */
  flatSeasonality?: boolean;
  seed?: number;
  baseVolume?: number;
}

function sessionDateKey(openMs: number): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(openMs));
  return date;
}

/**
 * Fifteen regular equity sessions of 390 one-minute bars starting Monday
 * 2026-03-02 09:30 New York (the US spring DST change falls on Sunday
 * 2026-03-08). Volume: `round(E(m) · exp(0.15 z))`, one z per bar in session
 * order then minute order, from `standardNormals(mulberry32(20261026))`. Then
 * twelve anomalies: pairs drawn with the same generator, two uniforms each
 * (`session = 4 + floor(u · 12)`, `minute = 90 + floor(u · 241)`), duplicates
 * rejected, each bar replaced by `round(2.5 · E(m))`. Only `volume` carries
 * information; prices are a smooth deterministic path and the bars carry no
 * sides, as a dxFeed equity minute with any unsided print would not.
 */
export function relativeVolumeEquityFixture(options: RelativeVolumeEquityOptions = {}): LabelledBars<RelativeVolumeEquityLabels> {
  const flat = options.flatSeasonality ?? false;
  const seed = options.seed ?? RVOL_EQUITY_SEED;
  const baseVolume = options.baseVolume ?? RVOL_BASE_VOLUME;
  const expected = (minute: number) => (flat ? baseVolume : relativeVolumeExpectedEquity(minute, baseVolume));
  const expectedVolumes = Array.from({ length: RVOL_EQUITY_BARS_PER_SESSION }, (_, minute) => expected(minute));

  const sessionStarts: number[] = [];
  const sessionDates: string[] = [];
  for (let day = Date.UTC(2026, 2, 2, 17); sessionStarts.length < RVOL_EQUITY_SESSIONS; day += 24 * 60 * MINUTE_MS) {
    const session = regularSessionAt(day);
    if (session === null) continue;
    sessionStarts.push(session.openMs);
    sessionDates.push(sessionDateKey(session.openMs));
  }

  const uniform = mulberry32(seed);
  const normal = standardNormals(uniform);
  const bars: BarFrame[] = [];
  const predictableSlotIndices: number[] = [];
  const evaluationIndices: number[] = [];
  sessionStarts.forEach((start, sessionIndex) => {
    for (let minute = 0; minute < RVOL_EQUITY_BARS_PER_SESSION; minute += 1) {
      const index = bars.length;
      bars.push(rvolBar(start + minute * MINUTE_MS, index, noisyVolume(expectedVolumes[minute], normal()), 190, 2, DXFEED_EQUITY, false));
      if (minute < 10 || minute >= 380) predictableSlotIndices.push(index);
      if (sessionIndex + 1 >= 4) evaluationIndices.push(index);
    }
  });

  const anomalies: RelativeVolumeAnomaly[] = [];
  const taken = new Set<string>();
  while (anomalies.length < RVOL_EQUITY_ANOMALIES) {
    const session = 4 + Math.floor(uniform() * 12);
    const minute = flat ? Math.floor(uniform() * RVOL_EQUITY_BARS_PER_SESSION) : 90 + Math.floor(uniform() * 241);
    const key = `${session}:${minute}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const index = (session - 1) * RVOL_EQUITY_BARS_PER_SESSION + minute;
    const volume = Math.round(RVOL_ANOMALY_MULTIPLE * expectedVolumes[minute]);
    bars[index] = { ...bars[index], volume, trade_count: Math.max(1, Math.round(volume / 5)) } as BarFrame;
    anomalies.push({ session, minute, index, expectedVolume: expectedVolumes[minute], volume });
  }
  anomalies.sort((a, b) => a.index - b.index);

  return {
    bars,
    labels: {
      regime: flat ? "relativeVolumeEquityFlat" : "relativeVolumeEquity",
      seed,
      baseVolume,
      sessions: RVOL_EQUITY_SESSIONS,
      barsPerSession: RVOL_EQUITY_BARS_PER_SESSION,
      sessionStarts,
      sessionDates,
      expectedVolumes,
      anomalies,
      anomalyIndices: anomalies.map((anomaly) => anomaly.index),
      predictableSlotIndices,
      evaluationIndices,
      evaluationSessions: { first: 4, last: RVOL_EQUITY_SESSIONS },
      dstChangeAfterSession: 5,
    },
  };
}

export interface RelativeVolumeCryptoLabels {
  regime: "relativeVolumeCrypto";
  seed: number;
  baseVolume: number;
  count: number;
  startTs: number;
  /** `E(m)` for every minute of the UTC day. */
  expectedVolumes: number[];
  /** Minute of the UTC day of every bar. */
  minuteOfDay: number[];
  /** The brief's timing window, as `[first, last]` indices. */
  timingIndices: { first: number; last: number };
  /** The REBUILT replay runs from this index to the end (bars 1,921..12,000). */
  rebuiltFromIndex: number;
}

/**
 * Twelve thousand one-minute Binance perpetual bars from 2026-03-02 00:00 UTC
 * with `E(m) = V · (1 + 0.5 · cos(2π (m - 840) / 1440))` over the UTC minute
 * of day, the same noise model and generation order as the equity fixture,
 * seed 20261027, no anomalies. Sides are split evenly, since the indicator
 * reads only `volume`.
 */
export function relativeVolumeCryptoFixture(options: { seed?: number; baseVolume?: number; count?: number } = {}): LabelledBars<RelativeVolumeCryptoLabels> {
  const seed = options.seed ?? RVOL_CRYPTO_SEED;
  const baseVolume = options.baseVolume ?? RVOL_BASE_VOLUME;
  const count = options.count ?? RVOL_CRYPTO_BARS;
  const startTs = Date.UTC(2026, 2, 2, 0, 0);
  const expectedVolumes = Array.from({ length: 1440 }, (_, minute) => relativeVolumeExpectedCrypto(minute, baseVolume));
  const normal = standardNormals(mulberry32(seed));
  const bars: BarFrame[] = [];
  const minuteOfDay: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const ts_open = startTs + index * MINUTE_MS;
    const minute = Math.floor((ts_open / MINUTE_MS) % 1440);
    minuteOfDay.push(minute);
    bars.push(rvolBar(ts_open, index, noisyVolume(expectedVolumes[minute], normal()), 60_000, 300, BINANCE_PERP, true));
  }
  return {
    bars,
    labels: {
      regime: "relativeVolumeCrypto",
      seed,
      baseVolume,
      count,
      startTs,
      expectedVolumes,
      minuteOfDay,
      timingIndices: { first: 0, last: Math.min(count, RVOL_CRYPTO_TIMING_BARS) - 1 },
      rebuiltFromIndex: RVOL_CRYPTO_REBUILT_FROM_INDEX,
    },
  };
}
