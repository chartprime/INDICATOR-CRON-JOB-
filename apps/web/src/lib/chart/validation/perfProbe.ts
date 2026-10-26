import type { BarFrame, TradeFrame } from "../../../types/frames";
import { MAX_RETAINED_SOURCE_BARS } from "../candleLifecycle";
import { withDrawOwnerScope } from "../draw/creationScope";
import { clearForIndicator } from "../draw/registry";
import type { IndicatorBarCtx, RuntimeIndicatorDef } from "../indicatorTypes";
import { barSides } from "../../indicators/barSides";
import { seeded, tradeFrame, type FixtureIdentity } from "./fixtures";
import { openLiveSession, type LiveExtras } from "./liveDrive";
import { tapeOf, ticksOf } from "./syntheticTape";

/**
 * Protocol check 6, performance. Three probes, each timing the indicator's own
 * `onBar` (the wrapper adds one `performance.now()` pair per call) through the
 * real runtime:
 *
 * - `probeReplay`: activation over a long series (the protocol uses 10,080
 *   bars, the chart's retention cap).
 * - `probeFormingBar`: one bar revised `revisionsPerSecond` times a second for
 *   `seconds`, with `printsPerMinute` prints landing in the tick store and in
 *   `ctx.trades`; the live-update cost.
 * - `probeRollover`: the series at the retention cap, then more bars so the
 *   chart trims the front and `discardLeading` runs; reports what the
 *   indicator retains afterwards.
 *
 * Heap numbers are `process.memoryUsage().heapUsed` after a forced collection
 * when `--expose-gc` is on (`NODE_OPTIONS=--expose-gc npx vitest run ...`);
 * without it they are indicative only and `gcExposed` says so.
 */

export interface Percentiles {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  totalMs: number;
}

export function percentilesOf(samples: readonly number[]): Percentiles {
  if (samples.length === 0) return { count: 0, p50: 0, p90: 0, p99: 0, max: 0, mean: 0, totalMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))];
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted[sorted.length - 1], mean: totalMs / sorted.length, totalMs };
}

export interface HeapReading {
  gcExposed: boolean;
  beforeBytes: number;
  afterBytes: number;
  deltaBytes: number;
}

type GcGlobal = typeof globalThis & { gc?: () => void };

export function heapUsed(): { bytes: number; gcExposed: boolean } {
  const gc = (globalThis as GcGlobal).gc;
  if (typeof gc === "function") gc();
  return { bytes: process.memoryUsage().heapUsed, gcExposed: typeof gc === "function" };
}

function heapReading(before: { bytes: number; gcExposed: boolean }): HeapReading {
  const after = heapUsed();
  return { gcExposed: before.gcExposed && after.gcExposed, beforeBytes: before.bytes, afterBytes: after.bytes, deltaBytes: after.bytes - before.bytes };
}

/** `def` with its `onBar` timed; `samples` fills as the runtime calls it. */
export function timedDef<S, T>(def: RuntimeIndicatorDef<S, T>): { def: RuntimeIndicatorDef<S, T>; samples: number[] } {
  const samples: number[] = [];
  const timed: RuntimeIndicatorDef<S, T> = {
    ...def,
    onBar(ctx) {
      const started = performance.now();
      try {
        def.onBar(ctx);
      } finally {
        samples.push(performance.now() - started);
      }
    },
  };
  return { def: timed, samples };
}

export interface ReplayProbe {
  id: string;
  bars: number;
  onBar: Percentiles;
  /** The whole `onSnapshot`, including the runtime's own bookkeeping. */
  wallMs: number;
  heap: HeapReading;
  faulted: boolean;
}

export function probeReplay<S, T>(def: RuntimeIndicatorDef<S, T>, bars: readonly BarFrame[], settings: T, extras: LiveExtras = {}): ReplayProbe {
  const before = heapUsed();
  const { def: timed, samples } = timedDef(def);
  const session = openLiveSession(timed, settings, extras, []);
  const started = performance.now();
  session.runtime.onSnapshot(bars);
  const wallMs = performance.now() - started;
  const capture = session.capture();
  const heap = heapReading(before);
  session.close();
  return { id: def.id, bars: bars.length, onBar: percentilesOf(samples), wallMs, heap, faulted: capture.faulted };
}

export interface FormingBarOptions {
  seconds?: number;
  revisionsPerSecond?: number;
  printsPerMinute?: number;
  extras?: LiveExtras;
  identity?: FixtureIdentity;
  /** Feed the prints to a real `AggressiveTape` handed over as `ctx.ticks` (default true). */
  tape?: boolean;
  seed?: number;
}

export interface FormingBarProbe {
  id: string;
  revisions: number;
  prints: number;
  onBar: Percentiles;
  wallMs: number;
  heap: HeapReading;
  faulted: boolean;
}

/**
 * The bar after `warmup` forms for `seconds`: `revisionsPerSecond` REPLACED_EDGE
 * dispatches a second, each carrying the prints so far in `ctx.trades`
 * (LIVE_COMPLETE) and in the tick store.
 */
export function probeFormingBar<S, T>(def: RuntimeIndicatorDef<S, T>, warmup: readonly BarFrame[], settings: T, options: FormingBarOptions = {}): FormingBarProbe {
  const seconds = options.seconds ?? 60;
  const revisionsPerSecond = options.revisionsPerSecond ?? 50;
  const printsPerMinute = options.printsPerMinute ?? 1_000;
  const last = warmup[warmup.length - 1];
  if (last === undefined) throw new Error("probeFormingBar: warmup must hold at least one bar");
  const identity = options.identity ?? ({ provider: last.provider, marketKind: last.marketKind, assetClass: last.assetClass, symbol: last.symbol } as FixtureIdentity);
  const ts_open = last.ts_open + last.interval_ms;
  const random = seeded(options.seed ?? 3);
  const totalRevisions = seconds * revisionsPerSecond;
  const totalPrints = Math.round((printsPerMinute * seconds) / 60);
  const prints: TradeFrame[] = [];
  for (let index = 0; index < totalPrints; index += 1) {
    const ts = ts_open + Math.floor((index / totalPrints) * seconds * 1_000);
    const price = Math.round((last.close + (random() - 0.5) * last.close * 0.0005) * 100) / 100;
    prints.push(tradeFrame(ts, price, Math.round((0.01 + random() * 0.5) * 1e6) / 1e6, random() < 0.5 ? "buy" : "sell", identity, `forming-${index}`));
  }
  const tape = options.tape === false ? null : tapeOf([], ts_open);
  const extras: LiveExtras = { ...options.extras };
  if (tape !== null && extras.ticks === undefined) extras.ticks = ticksOf(tape);

  const before = heapUsed();
  const { def: timed, samples } = timedDef(def);
  const session = openLiveSession(timed, settings, extras, warmup);
  const started = performance.now();
  let printIndex = 0;
  let high = last.close;
  let low = last.close;
  let volume = 0;
  let buy = 0;
  let close = last.close;
  for (let revision = 0; revision < totalRevisions; revision += 1) {
    const now = ts_open + Math.floor(((revision + 1) / totalRevisions) * seconds * 1_000);
    while (printIndex < prints.length && prints[printIndex].ts_exchange < now) {
      const print = prints[printIndex];
      tape?.add(print);
      volume += print.size;
      if (print.side === "buy") buy += print.size;
      high = Math.max(high, print.price);
      low = Math.min(low, print.price);
      close = print.price;
      printIndex += 1;
    }
    const closed = revision === totalRevisions - 1;
    const bar = {
      type: "bar",
      ...identity,
      interval_ms: last.interval_ms,
      ts_open,
      open: last.close,
      high,
      low,
      close,
      volume: Math.round(volume * 1e6) / 1e6,
      buy_volume: Math.round(buy * 1e6) / 1e6,
      sell_volume: Math.round((volume - buy) * 1e6) / 1e6,
      trade_count: printIndex,
      closed,
    } as BarFrame;
    session.dispatch({ bar, trades: prints.slice(0, printIndex), tradeAvailability: "LIVE_COMPLETE" });
  }
  const wallMs = performance.now() - started;
  const capture = session.capture();
  const heap = heapReading(before);
  session.close();
  return { id: def.id, revisions: totalRevisions, prints: printIndex, onBar: percentilesOf(samples), wallMs, heap, faulted: capture.faulted };
}

export interface RolloverOptions {
  /** Bars appended past the retention cap (default 1,000). */
  extraBars?: number;
  extras?: LiveExtras;
}

export interface RolloverProbe {
  id: string;
  retainedBars: number;
  discarded: number;
  /** Length of every cached output line after the rollover; each must equal `retainedBars`. */
  outputLengths: Record<string, number>;
  markersRetained: number;
  /** Markers whose time is older than the oldest retained bar: the runtime should have trimmed them. */
  markersBeforeRetention: number;
  onBar: Percentiles;
  heap: HeapReading;
  /** Heap growth per appended bar after the cap, bytes; a positive slope is a leak candidate. */
  bytesPerExtraBar: number;
  faulted: boolean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The bar after `last` for the rollover probe: a small random step in price
 * and volume, with sides read through `barSides` and written coherently. A
 * sided bar gets a fresh buy share and keeps `last`'s unknown share; a bar
 * that carried only `buy_volume` keeps carrying only that; an unsided bar
 * stays unsided. Nothing is inherited by spreading `last`.
 */
export function rolloverBar(last: BarFrame, random: () => number): BarFrame {
  const open = last.close;
  const close = Math.max(1, open + (random() - 0.5) * open * 0.001);
  const volume = round2(50 + random() * 100);
  const { buy_volume: _buy, sell_volume: _sell, ...rest } = last;
  const bar: Record<string, unknown> = {
    ...rest,
    ts_open: last.ts_open + last.interval_ms,
    open,
    high: Math.max(open, close) + random(),
    low: Math.min(open, close) - random(),
    close,
    volume,
    trade_count: last.trade_count === null ? null : Math.max(1, Math.round(volume / 3)),
    closed: true,
  };
  const sides = barSides(last);
  if (sides.known) {
    const unknownShare = last.volume > 0 ? sides.unknown / last.volume : 0;
    const sided = round2(volume * (1 - unknownShare));
    const buy = round2(sided * (0.3 + random() * 0.4));
    bar.buy_volume = buy;
    if (last.sell_volume !== undefined && last.sell_volume !== null) bar.sell_volume = round2(sided - buy);
  }
  return bar as BarFrame;
}

/** `bars` fills the chart to the cap; `extraBars` more then roll the front off, as the live chart does after a week. */
export function probeRollover<S, T>(def: RuntimeIndicatorDef<S, T>, bars: readonly BarFrame[], settings: T, options: RolloverOptions = {}): RolloverProbe {
  const extraBars = options.extraBars ?? 1_000;
  const seed = bars.slice(-MAX_RETAINED_SOURCE_BARS);
  if (seed.length < MAX_RETAINED_SOURCE_BARS) throw new Error(`probeRollover: needs at least ${MAX_RETAINED_SOURCE_BARS} bars`);
  const { def: timed, samples } = timedDef(def);
  const session = openLiveSession(timed, settings, options.extras, seed);
  samples.length = 0;
  const before = heapUsed();
  const random = seeded(13);
  let last = seed[seed.length - 1];
  for (let index = 0; index < extraBars; index += 1) {
    const bar = rolloverBar(last, random);
    session.dispatch({ bar });
    last = bar;
  }
  const heap = heapReading(before);
  const capture = session.capture();
  const oldest = session.bars[0]?.ts_open ?? -Infinity;
  const outputLengths: Record<string, number> = {};
  for (const [key, values] of Object.entries(capture.outputs)) outputLengths[key] = values.length;
  const result: RolloverProbe = {
    id: def.id,
    retainedBars: session.bars.length,
    discarded: session.discarded,
    outputLengths,
    markersRetained: capture.markers.length,
    markersBeforeRetention: capture.markers.filter((call) => call.time < oldest).length,
    onBar: percentilesOf(samples),
    heap,
    bytesPerExtraBar: extraBars === 0 ? 0 : heap.deltaBytes / extraBars,
    faulted: capture.faulted,
  };
  session.close();
  return result;
}

export interface PooledReplayOptions {
  /** Untimed replays before measuring (default 3). */
  warmupRuns?: number;
  /** Timed replays whose per-bar samples are pooled (default 5). */
  timedRuns?: number;
  extras?: LiveExtras;
}

export interface PooledReplayProbe {
  id: string;
  bars: number;
  warmupRuns: number;
  timedRuns: number;
  /** Per-bar `onBar` plus `readOutput` over every timed run, pooled; percentiles by nearest rank. */
  pooled: Percentiles;
  /** Each timed run on its own, for the spread. */
  perRun: Percentiles[];
  /** Wall time of each timed run, ms. */
  runWallMs: number[];
  faulted: boolean;
}

const NOOP_DRAW = Object.freeze({ fill: () => {} });
const NOOP_MARKERS = Object.freeze({ plotshape: () => {}, plotchar: () => {} });
const EMPTY_TA = Object.freeze({});
let nextPooledOwnerId = 1;

/**
 * The frozen measurement of `PM/cycle1/brief-rvol-clock.md` (amendment 9):
 * `warmupRuns` untimed replays, then `timedRuns` timed replays over `bars`,
 * timing `onBar` plus `readOutput` per bar with no-op draw and marker
 * namespaces (drawing excluded), samples pooled across runs, p99 by nearest
 * rank. It bypasses the runtime's own bookkeeping so the number is the
 * indicator's alone; `probeReplay` stays the measurement of a real activation.
 */
export function probeReplayPooled<S, T>(def: RuntimeIndicatorDef<S, T>, bars: readonly BarFrame[], settings: T, options: PooledReplayOptions = {}): PooledReplayProbe {
  const warmupRuns = options.warmupRuns ?? 3;
  const timedRuns = options.timedRuns ?? 5;
  const extras = options.extras ?? {};
  const pooled: number[] = [];
  const perRun: Percentiles[] = [];
  const runWallMs: number[] = [];
  let faulted = false;
  const lastClosed = bars.findLastIndex((bar) => bar.closed);
  const run = (timed: boolean): void => {
    const ownerId = `pooled:${nextPooledOwnerId}:${def.id}`;
    nextPooledOwnerId += 1;
    const samples: number[] = [];
    try {
      const state = withDrawOwnerScope(ownerId, () => def.createState(settings));
      const runStarted = performance.now();
      for (let index = 0; index < bars.length; index += 1) {
        const bar = bars[index];
        const ctx: IndicatorBarCtx<S, T> = {
          bar,
          trades: [],
          tradeAvailability: "HISTORICAL_UNAVAILABLE",
          liquidity: extras.liquidity ?? undefined,
          l2: extras.l2?.atTime?.(bar.ts_open + bar.interval_ms) ?? extras.l2 ?? undefined,
          ticks: extras.ticks ?? undefined,
          state,
          settings,
          replace: false,
          replaying: true,
          drawNow: index >= lastClosed,
          barIndex: index,
          barCount: bars.length,
          ta: EMPTY_TA,
          draw: NOOP_DRAW,
          markers: NOOP_MARKERS,
          pane: { paneIndex: 0 },
        };
        const started = performance.now();
        def.onBar(ctx);
        const output = def.readOutput(state);
        const elapsed = performance.now() - started;
        if (timed) samples.push(elapsed);
        for (const value of Object.values(output)) if (value !== null && !Number.isFinite(value)) faulted = true;
      }
      if (timed) {
        runWallMs.push(performance.now() - runStarted);
        perRun.push(percentilesOf(samples));
        pooled.push(...samples);
      }
    } catch {
      faulted = true;
    } finally {
      clearForIndicator(ownerId);
    }
  };
  for (let index = 0; index < warmupRuns; index += 1) run(false);
  for (let index = 0; index < timedRuns; index += 1) run(true);
  return { id: def.id, bars: bars.length, warmupRuns, timedRuns, pooled: percentilesOf(pooled), perRun, runWallMs, faulted };
}

export function formatPooledReplayProbe(probe: PooledReplayProbe): string {
  return `${probe.id} pooled replay ${probe.bars} bars x ${probe.timedRuns} after ${probe.warmupRuns} warm-ups: onBar+readOutput p50 ${ms(probe.pooled.p50)} p99 ${ms(probe.pooled.p99)} max ${ms(probe.pooled.max)}; run p99s ${probe.perRun.map((run) => run.p99.toFixed(4)).join("/")} ms; run wall ${probe.runWallMs.map((wall) => wall.toFixed(0)).join("/")} ms${probe.faulted ? "; FAULTED" : ""}`;
}

function ms(value: number): string {
  return `${value.toFixed(3)} ms`;
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

export function formatReplayProbe(probe: ReplayProbe): string {
  return `${probe.id} replay ${probe.bars} bars: onBar p50 ${ms(probe.onBar.p50)} p99 ${ms(probe.onBar.p99)} max ${ms(probe.onBar.max)}; wall ${probe.wallMs.toFixed(0)} ms; heap delta ${mb(probe.heap.deltaBytes)}${probe.heap.gcExposed ? "" : " (gc not exposed)"}${probe.faulted ? "; FAULTED" : ""}`;
}

export function formatFormingBarProbe(probe: FormingBarProbe): string {
  return `${probe.id} forming bar ${probe.revisions} revisions, ${probe.prints} prints: onBar p50 ${ms(probe.onBar.p50)} p99 ${ms(probe.onBar.p99)} max ${ms(probe.onBar.max)}; wall ${probe.wallMs.toFixed(0)} ms; heap delta ${mb(probe.heap.deltaBytes)}${probe.heap.gcExposed ? "" : " (gc not exposed)"}${probe.faulted ? "; FAULTED" : ""}`;
}

export function formatRolloverProbe(probe: RolloverProbe): string {
  return `${probe.id} rollover +${probe.discarded} bars: retained ${probe.retainedBars}, outputs ${JSON.stringify(probe.outputLengths)}, markers ${probe.markersRetained} (${probe.markersBeforeRetention} stale); onBar p50 ${ms(probe.onBar.p50)} p99 ${ms(probe.onBar.p99)}; heap delta ${mb(probe.heap.deltaBytes)} = ${probe.bytesPerExtraBar.toFixed(0)} B/bar${probe.heap.gcExposed ? "" : " (gc not exposed)"}${probe.faulted ? "; FAULTED" : ""}`;
}
