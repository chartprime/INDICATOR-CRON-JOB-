import { identitiesMatch, type BarFrame, type FrameIdentity } from "../../types/frames";
import type { HistoricalTimeframe } from "./historicalTimeframes";

const DAY_MS = 24 * 60 * 60_000;

export class HistoricalResampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalResampleError";
  }
}

function identityOf(bar: BarFrame): FrameIdentity {
  if (bar.provider === "BINANCE") return { provider: "BINANCE", marketKind: bar.marketKind };
  if (bar.provider === "DATABENTO") return { provider: "DATABENTO", assetClass: bar.assetClass };
  return { provider: "DXFEED", assetClass: bar.assetClass };
}

function weekOpenMs(timestampMs: number): number {
  const dayOpenMs = Math.floor(timestampMs / DAY_MS) * DAY_MS;
  const weekday = new Date(dayOpenMs).getUTCDay();
  return dayOpenMs - ((weekday + 6) % 7) * DAY_MS;
}

function monthOpenMs(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function historicalBucketOpenMs(timestampMs: number, timeframe: HistoricalTimeframe): number {
  if (timeframe.bucket === "month") return monthOpenMs(timestampMs);
  if (timeframe.bucket === "week") return weekOpenMs(timestampMs);
  return Math.floor(timestampMs / timeframe.intervalMs) * timeframe.intervalMs;
}

function bucketCloseMs(bucketOpen: number, timeframe: HistoricalTimeframe): number {
  if (timeframe.bucket !== "month") return bucketOpen + timeframe.intervalMs;
  const date = new Date(bucketOpen);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function assertSourceBar(bar: BarFrame, first: BarFrame, timeframe: HistoricalTimeframe): void {
  const sourceIntervalMs = timeframe.sourceResolution === "1m"
    ? 60_000
    : timeframe.sourceResolution === "1h"
      ? 60 * 60_000
      : DAY_MS;
  if (
    bar.type !== "bar" ||
    bar.symbol !== first.symbol ||
    !identitiesMatch(bar, first) ||
    bar.interval_ms !== sourceIntervalMs ||
    bar.calendar_interval !== undefined ||
    !Number.isSafeInteger(bar.ts_open) ||
    bar.ts_open % sourceIntervalMs !== 0 ||
    bar.closed !== true ||
    !Number.isFinite(bar.open) ||
    !Number.isFinite(bar.high) ||
    !Number.isFinite(bar.low) ||
    !Number.isFinite(bar.close) ||
    !Number.isFinite(bar.volume) ||
    bar.volume < 0 ||
    bar.low > Math.min(bar.open, bar.close) ||
    bar.high < Math.max(bar.open, bar.close) ||
    (bar.trade_count !== null && (!Number.isSafeInteger(bar.trade_count) || bar.trade_count < 0)) ||
    (bar.buy_volume !== undefined && (!Number.isFinite(bar.buy_volume) || bar.buy_volume < 0 || bar.buy_volume > bar.volume))
  ) {
    throw new HistoricalResampleError("historical resampling received an invalid source candle");
  }
}

function aggregateBucket(group: readonly BarFrame[], bucketOpen: number, timeframe: HistoricalTimeframe): BarFrame {
  const first = group[0];
  const last = group.at(-1)!;
  const volume = group.reduce((total, bar) => total + bar.volume, 0);
  const tradeCount = group.some((bar) => bar.trade_count === null)
    ? null
    : group.reduce((total, bar) => total + bar.trade_count!, 0);
  const buyVolume = group.some((bar) => bar.buy_volume === undefined)
    ? undefined
    : group.reduce((total, bar) => total + bar.buy_volume!, 0);
  if (
    !Number.isFinite(volume) ||
    (tradeCount !== null && !Number.isSafeInteger(tradeCount)) ||
    (buyVolume !== undefined && (!Number.isFinite(buyVolume) || buyVolume > volume))
  ) {
    throw new HistoricalResampleError("historical candle aggregate is outside the supported display range");
  }
  const identity = identityOf(first);
  return {
    ...identity,
    type: "bar",
    symbol: first.symbol,
    interval_ms: timeframe.intervalMs,
    ...(timeframe.bucket === "month" ? { calendar_interval: "month" as const } : {}),
    ts_open: bucketOpen,
    open: first.open,
    high: Math.max(...group.map((bar) => bar.high)),
    low: Math.min(...group.map((bar) => bar.low)),
    close: last.close,
    volume,
    ...(buyVolume === undefined ? {} : { buy_volume: buyVolume }),
    trade_count: tradeCount,
    closed: true,
    ...(group.some((bar) => bar.reconstructed === true) ? { reconstructed: true } : {}),
  };
}

export function resampleHistoricalBars(
  bars: readonly BarFrame[],
  timeframe: HistoricalTimeframe,
): BarFrame[] {
  if (bars.length === 0) return [];
  const first = bars[0];
  for (const bar of bars) assertSourceBar(bar, first, timeframe);
  const ordered = [...bars].sort((left, right) => left.ts_open - right.ts_open);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].ts_open === ordered[index].ts_open) {
      throw new HistoricalResampleError("historical resampling received duplicate candle timestamps");
    }
  }
  if (timeframe.intervalMs === first.interval_ms && timeframe.bucket === "fixed") return ordered;

  const groups = new Map<number, BarFrame[]>();
  for (const bar of ordered) {
    const bucketOpen = historicalBucketOpenMs(bar.ts_open, timeframe);
    const bucketClose = bucketCloseMs(bucketOpen, timeframe);
    if (bar.ts_open + bar.interval_ms > bucketClose) {
      throw new HistoricalResampleError("historical source candle crosses a display timeframe boundary");
    }
    const group = groups.get(bucketOpen);
    if (group === undefined) groups.set(bucketOpen, [bar]);
    else group.push(bar);
  }
  return [...groups.keys()]
    .sort((left, right) => left - right)
    .map((bucketOpen) => aggregateBucket(groups.get(bucketOpen)!, bucketOpen, timeframe));
}
