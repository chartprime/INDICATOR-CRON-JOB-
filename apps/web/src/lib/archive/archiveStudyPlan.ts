import marketInstrumentCatalog from "../../../../../config/market-instruments.json";
import cryptoTicks from "../../../../../config/archive-crypto-ticks.json";
import { alignedPeriodBoundaries } from "../indicators/volume-profile/volumeProfileZones";
import type { HistoricalInstrument } from "./historicalCatalog";
import { dateMs } from "./continuousArchive";
import type { ArchiveBarFlow, ArchiveStudyRange, ArchiveStudySegment } from "./archiveStudyClient";
import { historicalBucketOpenMs } from "./historicalResampleBars";
import { HISTORICAL_TIMEFRAMES, type HistoricalTimeframe } from "./historicalTimeframes";

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const WEEK_MS = 7 * DAY_MS;
export const FIRST_MONDAY_MS = 4 * DAY_MS;
export const PRINT_CHUNK_BARS = 500;
export const MAX_PRINT_CHUNK_MS = WEEK_MS;
export const MAX_VPIN_WEEKS_PER_REQUEST = 2;
export const MAX_PROFILE_BLOCKS_PER_REQUEST = 16;
export const MAX_PROFILE_SPAN_PER_REQUEST_MS = 16 * DAY_MS;
export const FLOW_CHUNK_BARS = 500;
export const MAX_FLOW_CHUNK_MS = 31 * DAY_MS;
export const VPIN_CALIBRATION_WINDOW_MS = 21 * DAY_MS;

export type StudyCoverage = Readonly<{ fromTs: number; toTs: number }>;

export function studySegmentsFor(instrument: HistoricalInstrument): readonly ArchiveStudySegment[] {
  if (instrument.kind === "single") {
    const fromTs = dateMs(instrument.availableFrom, "availableFrom");
    const toTs = dateMs(instrument.availableToExclusive, "availableToExclusive");
    const studyFrom = instrument.source === "binance"
      ? Math.max(fromTs, dateMs(cryptoTicks.tradeWindow.from, "tradeWindow.from")) : fromTs;
    const studyTo = instrument.source === "binance"
      ? Math.min(toTs, dateMs(cryptoTicks.tradeWindow.toExclusive, "tradeWindow.toExclusive")) : toTs;
    if (studyTo <= studyFrom) return [];
    return [{
      instrumentId: instrument.archiveInstrumentId,
      fromTs: studyFrom,
      toTs: studyTo,
    }];
  }
  return instrument.rolls
    .map((roll) => ({
      instrumentId: roll.archiveInstrumentId,
      fromTs: dateMs(roll.from, "roll.from"),
      toTs: dateMs(roll.to, "roll.to"),
    }))
    .sort((left, right) => left.fromTs - right.fromTs);
}

export function studyCoverage(segments: readonly ArchiveStudySegment[]): StudyCoverage | null {
  if (segments.length === 0) return null;
  return { fromTs: segments[0].fromTs, toTs: segments[segments.length - 1].toTs };
}

export function studyTickSize(instrument: HistoricalInstrument): number | null {
  if (instrument.source === "binance") {
    const market = instrument.chartIdentity.marketKind;
    const entry = cryptoTicks.instruments.find((row) => row.marketKind === market && row.symbol === instrument.symbol);
    const tick = entry === undefined ? Number.NaN : Number(entry.tickSize);
    return Number.isFinite(tick) && tick > 0 ? tick : null;
  }
  const entry = marketInstrumentCatalog.dxfeed.find((candidate) => candidate.label === instrument.symbol);
  return entry === undefined || !Number.isFinite(entry.tickSize) || entry.tickSize <= 0 ? null : entry.tickSize;
}

export function studyAssetClass(instrument: HistoricalInstrument): "FUTURE" | "EQUITY" | "SPOT" | "PERPETUAL" | null {
  const identity = instrument.chartIdentity;
  if (identity.provider === "BINANCE") return identity.marketKind;
  if (identity.provider !== "DATABENTO") return null;
  return identity.assetClass === "FUTURE" || identity.assetClass === "EQUITY" ? identity.assetClass : null;
}

export function archiveStudiesSupported(instrument: HistoricalInstrument): boolean {
  return studyTickSize(instrument) !== null && studyAssetClass(instrument) !== null;
}

export function profileBlocks(
  visibleFromMs: number,
  visibleToMs: number,
  periodMs: number,
  coverage: StudyCoverage,
): readonly ArchiveStudyRange[] {
  return alignedPeriodBoundaries(visibleFromMs, visibleToMs, periodMs, coverage.toTs)
    .filter((block) => block.rangeEndTs - block.rangeStartTs === periodMs)
    .filter((block) => block.rangeStartTs >= coverage.fromTs && block.rangeEndTs <= coverage.toTs)
    .filter((block) => block.rangeStartTs % MINUTE_MS === 0 && block.rangeEndTs % MINUTE_MS === 0)
    .map((block) => ({ fromTs: block.rangeStartTs, toTs: block.rangeEndTs }));
}

export function profileBlocksPerRequest(periodMs: number): number {
  return Math.max(1, Math.min(MAX_PROFILE_BLOCKS_PER_REQUEST, Math.floor(MAX_PROFILE_SPAN_PER_REQUEST_MS / periodMs)));
}

export function weekStartOf(ts: number): number {
  return Math.floor((ts - FIRST_MONDAY_MS) / WEEK_MS) * WEEK_MS + FIRST_MONDAY_MS;
}

export function vpinWeeks(visibleFromMs: number, visibleToMs: number, coverage: StudyCoverage): readonly number[] {
  if (!(visibleToMs > visibleFromMs)) return [];
  const weeks: number[] = [];
  for (let week = weekStartOf(visibleFromMs); week < visibleToMs; week += WEEK_MS) {
    if (week - VPIN_CALIBRATION_WINDOW_MS >= coverage.fromTs && week + WEEK_MS <= coverage.toTs) weeks.push(week);
  }
  return weeks;
}

export function printBucketMs(intervalMs: number): number {
  if (intervalMs <= DAY_MS && DAY_MS % intervalMs === 0 && intervalMs % MINUTE_MS === 0) return intervalMs;
  return DAY_MS;
}

export function printChunks(
  visibleFromMs: number,
  visibleToMs: number,
  bucketMs: number,
  coverage: StudyCoverage,
): readonly ArchiveStudyRange[] {
  if (!(visibleToMs > visibleFromMs)) return [];
  const chunkMs = Math.min(bucketMs * PRINT_CHUNK_BARS, MAX_PRINT_CHUNK_MS);
  const chunks: ArchiveStudyRange[] = [];
  for (let start = Math.floor(visibleFromMs / chunkMs) * chunkMs; start < visibleToMs; start += chunkMs) {
    const fromTs = Math.max(start, Math.ceil(coverage.fromTs / bucketMs) * bucketMs);
    const toTs = Math.min(start + chunkMs, Math.floor(coverage.toTs / bucketMs) * bucketMs);
    if (toTs > fromTs) chunks.push({ fromTs, toTs });
  }
  return chunks;
}

// The archive buckets flow from the epoch, which matches the chart's candles up
// to 1D but not its weeks (Monday opens) or months (the 1st). Above 1D the flow
// is asked for by day and added up into the chart's own candles here.
export function flowBucketMs(intervalMs: number): number | null {
  if (!(intervalMs > 0) || intervalMs % MINUTE_MS !== 0) return null;
  return intervalMs > DAY_MS ? DAY_MS : intervalMs;
}

function calendarTimeframeOf(intervalMs: number): HistoricalTimeframe | null {
  return HISTORICAL_TIMEFRAMES.find((timeframe) => timeframe.intervalMs === intervalMs && timeframe.bucket !== "fixed") ?? null;
}

function calendarBucketCloseMs(openMs: number, timeframe: HistoricalTimeframe): number {
  if (timeframe.bucket !== "month") return openMs + timeframe.intervalMs;
  const date = new Date(openMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** The span to ask flow for: the visible one, widened to whole weeks or months. */
export function flowSpan(visibleFromMs: number, visibleToMs: number, intervalMs: number): StudyCoverage {
  const timeframe = calendarTimeframeOf(intervalMs);
  if (timeframe === null || !(visibleToMs > visibleFromMs)) return { fromTs: visibleFromMs, toTs: visibleToMs };
  return {
    fromTs: historicalBucketOpenMs(visibleFromMs, timeframe),
    toTs: calendarBucketCloseMs(historicalBucketOpenMs(visibleToMs - 1, timeframe), timeframe),
  };
}

function covered(ranges: readonly ArchiveStudyRange[], fromTs: number, toTs: number): boolean {
  let reached = fromTs;
  for (const range of [...ranges].sort((left, right) => left.fromTs - right.fromTs)) {
    if (range.fromTs > reached) break;
    reached = Math.max(reached, range.toTs);
    if (reached >= toTs) return true;
  }
  return reached >= toTs;
}

/**
 * The flow for the chart's candles. Up to 1D the archive's buckets are the
 * candles. On 1W and 1M the days are added up into each week or month, and a
 * week or month is given only once every day of it the archive holds has
 * loaded, so a candle never shows part of its flow.
 */
export function chartFlowBars(
  loaded: readonly Readonly<{ range: ArchiveStudyRange; bars: readonly ArchiveBarFlow[] }>[],
  intervalMs: number,
  coverage: StudyCoverage,
): ArchiveBarFlow[] {
  const days = loaded.flatMap((chunk) => chunk.bars);
  const timeframe = calendarTimeframeOf(intervalMs);
  if (timeframe === null) return [...days].sort((left, right) => left.ts_open - right.ts_open);
  const ranges = loaded.map((chunk) => chunk.range);
  const candles = new Map<number, { ts_open: number; volume: number; buy_volume: number; sell_volume: number; unknown_volume: number; trade_count: number }>();
  for (const day of days) {
    const open = historicalBucketOpenMs(day.ts_open, timeframe);
    const candle = candles.get(open) ?? { ts_open: open, volume: 0, buy_volume: 0, sell_volume: 0, unknown_volume: 0, trade_count: 0 };
    candle.volume += day.volume;
    candle.buy_volume += day.buy_volume;
    candle.sell_volume += day.sell_volume;
    candle.unknown_volume += day.unknown_volume;
    candle.trade_count += day.trade_count;
    candles.set(open, candle);
  }
  return [...candles.values()]
    .filter((candle) => {
      const fromTs = Math.max(candle.ts_open, Math.ceil(coverage.fromTs / DAY_MS) * DAY_MS);
      const toTs = Math.min(calendarBucketCloseMs(candle.ts_open, timeframe), Math.floor(coverage.toTs / DAY_MS) * DAY_MS);
      return covered(ranges, fromTs, toTs);
    })
    .sort((left, right) => left.ts_open - right.ts_open);
}

export function flowChunks(
  visibleFromMs: number,
  visibleToMs: number,
  bucketMs: number,
  coverage: StudyCoverage,
): readonly ArchiveStudyRange[] {
  if (!(visibleToMs > visibleFromMs)) return [];
  const chunkMs = Math.max(bucketMs, Math.floor(Math.min(bucketMs * FLOW_CHUNK_BARS, MAX_FLOW_CHUNK_MS) / bucketMs) * bucketMs);
  const chunks: ArchiveStudyRange[] = [];
  for (let start = Math.floor(visibleFromMs / chunkMs) * chunkMs; start < visibleToMs; start += chunkMs) {
    const fromTs = Math.max(start, Math.ceil(coverage.fromTs / bucketMs) * bucketMs);
    const toTs = Math.min(start + chunkMs, Math.floor(coverage.toTs / bucketMs) * bucketMs);
    if (toTs > fromTs) chunks.push({ fromTs, toTs });
  }
  return chunks;
}

export function contiguousRuns<T extends number>(starts: readonly T[], stepMs: number, maxPerRun: number): readonly ArchiveStudyRange[] {
  const sorted = [...starts].sort((left, right) => left - right);
  const runs: ArchiveStudyRange[] = [];
  let runStart: number | null = null;
  let runEnd = 0;
  let length = 0;
  for (const start of sorted) {
    if (runStart !== null && start === runEnd && length < maxPerRun) {
      runEnd += stepMs;
      length += 1;
      continue;
    }
    if (runStart !== null) runs.push({ fromTs: runStart, toTs: runEnd });
    runStart = start;
    runEnd = start + stepMs;
    length = 1;
  }
  if (runStart !== null) runs.push({ fromTs: runStart, toTs: runEnd });
  return runs;
}
