import { identitiesMatch, type BarFrame } from "../../types/frames";
import { isRegularSessionOnly, regularSessionAt } from "./marketCalendar";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const TIMEFRAMES = [
  { label: "1m", intervalMs: 60_000, defaultWindowMs: 2 * HOUR_MS },
  { label: "2m", intervalMs: 2 * 60_000, defaultWindowMs: 3 * HOUR_MS },
  { label: "3m", intervalMs: 3 * 60_000, defaultWindowMs: 4 * HOUR_MS },
  { label: "5m", intervalMs: 5 * 60_000, defaultWindowMs: 6 * HOUR_MS },
  { label: "15m", intervalMs: 15 * 60_000, defaultWindowMs: 12 * HOUR_MS },
  { label: "30m", intervalMs: 30 * 60_000, defaultWindowMs: 1 * DAY_MS },
  { label: "1h", intervalMs: 60 * 60_000, defaultWindowMs: 2 * DAY_MS },
  { label: "4h", intervalMs: 4 * 60 * 60_000, defaultWindowMs: 7 * DAY_MS },
  { label: "6h", intervalMs: 6 * 60 * 60_000, defaultWindowMs: 7 * DAY_MS },
  { label: "12h", intervalMs: 12 * 60 * 60_000, defaultWindowMs: 7 * DAY_MS },
  { label: "1D", intervalMs: 24 * 60 * 60_000, defaultWindowMs: 7 * DAY_MS },
] as const;

export type TimeframeLabel = (typeof TIMEFRAMES)[number]["label"];

const DEFAULT_WINDOW_MS_BY_INTERVAL = new Map<number, number>(
  TIMEFRAMES.map((tf) => [tf.intervalMs, tf.defaultWindowMs]),
);

export function defaultVisibleWindowMs(intervalMs: number): number {
  return DEFAULT_WINDOW_MS_BY_INTERVAL.get(intervalMs) ?? 7 * DAY_MS;
}

function bucketOpenMs(tsClose: number, intervalMs: number): number {
  return Math.floor((tsClose - 1) / intervalMs) * intervalMs;
}

function bucketFor(bar: BarFrame, intervalMs: number, sessionAnchored: boolean): { openMs: number; spanMs: number } {
  const session = sessionAnchored ? regularSessionAt(bar.ts_open) : null;
  if (session === null) return { openMs: bucketOpenMs(bar.ts_open + bar.interval_ms, intervalMs), spanMs: intervalMs };
  const openMs = session.openMs + Math.floor((bar.ts_open - session.openMs) / intervalMs) * intervalMs;
  return { openMs, spanMs: Math.min(intervalMs, session.closeMs - openMs) };
}

function isCompleteBucket(group: readonly BarFrame[], bucketOpen: number, targetIntervalMs: number): boolean {
  let expectedOpen = bucketOpen;
  for (const bar of group) {
    if (bar.ts_open !== expectedOpen || bar.closed !== true) return false;
    expectedOpen += bar.interval_ms;
  }
  return expectedOpen === bucketOpen + targetIntervalMs;
}

function isRepresentableBucket(group: readonly BarFrame[], bucketOpen: number): boolean {
  let expectedOpen = bucketOpen;
  for (let index = 0; index < group.length; index += 1) {
    const bar = group[index];
    if (bar.ts_open !== expectedOpen) return false;
    if (bar.closed !== true && index !== group.length - 1) return false;
    expectedOpen += bar.interval_ms;
  }
  return true;
}

export function resampleBars(bars: readonly BarFrame[], targetIntervalMs: number): BarFrame[] {
  if (bars.length === 0) return [];
  if (!Number.isSafeInteger(targetIntervalMs) || targetIntervalMs <= 0) {
    throw new Error("resampleBars: targetIntervalMs must be a positive safe integer");
  }
  const first = bars[0];
  if (targetIntervalMs < first.interval_ms || targetIntervalMs % first.interval_ms !== 0) {
    throw new Error("resampleBars: targetIntervalMs must be a whole multiple of the source interval");
  }
  for (const bar of bars) {
    if (
      bar.symbol !== first.symbol ||
      !identitiesMatch(bar, first) ||
      bar.interval_ms !== first.interval_ms ||
      bar.ts_open % bar.interval_ms !== 0 ||
      !Number.isSafeInteger(bar.ts_open + bar.interval_ms)
    ) {
      throw new Error("resampleBars: bars must belong to one pair and source interval");
    }
  }
  const barsByOpenTime = new Map<number, BarFrame>();
  for (const bar of bars) barsByOpenTime.set(bar.ts_open, bar);
  const orderedBars = [...barsByOpenTime.values()].sort((a, b) => a.ts_open - b.ts_open);
  if (targetIntervalMs === first.interval_ms) return orderedBars;

  const sessionAnchored = isRegularSessionOnly(first);
  const groups = new Map<number, BarFrame[]>();
  const spans = new Map<number, number>();
  for (const bar of orderedBars) {
    const bucket = bucketFor(bar, targetIntervalMs, sessionAnchored);
    const group = groups.get(bucket.openMs);
    if (group) group.push(bar);
    else groups.set(bucket.openMs, [bar]);
    spans.set(bucket.openMs, bucket.spanMs);
  }

  const bucketOpens = [...groups.keys()].sort((a, b) => a - b);
  const result: BarFrame[] = [];
  for (const bucketOpen of bucketOpens) {
    const group = groups.get(bucketOpen)!;
    if (!isRepresentableBucket(group, bucketOpen)) continue;
    const last = group[group.length - 1];
    const closed = isCompleteBucket(group, bucketOpen, spans.get(bucketOpen)!);
    const volume = group.reduce((sum, b) => sum + b.volume, 0);
    const tradeCount = group.every((bar) => bar.trade_count !== null)
      ? group.reduce((sum, bar) => sum + bar.trade_count!, 0)
      : null;
    const buyVolume = group.every((b) => b.buy_volume !== undefined)
      ? group.reduce((sum, b) => sum + b.buy_volume!, 0)
      : undefined;
    const sellVolume = group.every((b) => b.sell_volume !== undefined)
      ? group.reduce((sum, b) => sum + b.sell_volume!, 0)
      : undefined;
    const reconstructed = group.some((b) => b.reconstructed === true) ? true : undefined;
    if (!Number.isFinite(volume) || (tradeCount !== null && !Number.isSafeInteger(tradeCount)) || (buyVolume !== undefined && !Number.isFinite(buyVolume)) || (sellVolume !== undefined && !Number.isFinite(sellVolume))) {
      throw new Error("resampleBars: aggregate is outside the supported numeric range");
    }
    result.push({
      ...(last.provider === "BINANCE"
        ? { provider: "BINANCE" as const, marketKind: last.marketKind }
        : { provider: last.provider, assetClass: last.assetClass }),
      type: "bar",
      symbol: last.symbol,
      interval_ms: targetIntervalMs,
      ts_open: bucketOpen,
      open: group[0].open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: last.close,
      volume,
      ...(buyVolume !== undefined ? { buy_volume: buyVolume } : {}),
      ...(sellVolume !== undefined ? { sell_volume: sellVolume } : {}),
      trade_count: tradeCount,
      closed,
      ...(reconstructed !== undefined ? { reconstructed } : {}),
    });
  }
  return result;
}
