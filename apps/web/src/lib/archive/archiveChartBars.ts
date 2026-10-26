import type { BarFrame } from "../../types/frames";
import { inChartSession, isRegularSessionOnly, regularSessionAt } from "../chart/marketCalendar";
import { ArchiveCandleError, archiveCandles } from "./archiveCandles";
import type { ArchivePage, ArchiveRow } from "./archiveClient";
import {
  familyForResolution,
  type HistoricalInstrument,
  type HistoricalResolution,
} from "./historicalCatalog";
import {
  createHistoricalIndicatorSeries,
  type HistoricalCandleMetrics,
  type HistoricalIndicatorSeries,
} from "./historicalIndicatorSeries";

const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UNSIGNED = /^(?:0|[1-9][0-9]*)$/;

export const HISTORICAL_RESOLUTION_MS: Readonly<Record<HistoricalResolution, number>> = Object.freeze({
  "1m": 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
});

export class ArchiveChartBarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveChartBarError";
  }
}

function archiveError(error: unknown): never {
  if (error instanceof ArchiveCandleError) {
    throw new ArchiveChartBarError(error.message);
  }
  throw error;
}

function optionalDecimal(row: ArchiveRow, field: string): number | undefined {
  const value = row[field];
  if (value === null) return undefined;
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new ArchiveChartBarError(`archive candle ${field} is not a nullable decimal`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new ArchiveChartBarError(`archive candle ${field} is outside display range`);
  }
  return result;
}

function nullableCount(row: ArchiveRow): number | null {
  const value = row.trade_count;
  if (value === null) return null;
  if (typeof value !== "string" || !UNSIGNED.test(value)) {
    throw new ArchiveChartBarError("archive candle trade_count is not a nullable unsigned integer");
  }
  const result = BigInt(value);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveChartBarError("archive candle trade_count is outside display range");
  }
  return Number(result);
}

function alignedToResolution(instrument: HistoricalInstrument, resolution: HistoricalResolution, openMs: number): boolean {
  const intervalMs = HISTORICAL_RESOLUTION_MS[resolution];
  const legacyUtcHour = openMs % intervalMs === 0;
  if (resolution !== "1h" || !isRegularSessionOnly(instrument.chartIdentity)) return legacyUtcHour;
  const session = regularSessionAt(openMs);
  return (session !== null && (openMs - session.openMs) % intervalMs === 0) || legacyUtcHour;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * 64 * Math.max(1, Math.abs(left), Math.abs(right));
}

function metricsForRow(row: ArchiveRow, bar: BarFrame): HistoricalCandleMetrics {
  const quoteVolume = optionalDecimal(row, "quote_volume");
  const takerBuyQuoteVolume = optionalDecimal(row, "taker_buy_quote_volume");
  const suppliedSellBaseVolume = optionalDecimal(row, "taker_sell_base_volume");
  const suppliedSellQuoteVolume = optionalDecimal(row, "taker_sell_quote_volume");
  const buyVolume = bar.buy_volume;
  const derivedSellBaseVolume = buyVolume === undefined ? undefined : bar.volume - buyVolume;
  const takerSellBaseVolume = suppliedSellBaseVolume ?? derivedSellBaseVolume;
  const derivedSellQuoteVolume = quoteVolume === undefined || takerBuyQuoteVolume === undefined
    ? undefined
    : quoteVolume - takerBuyQuoteVolume;
  const takerSellQuoteVolume = suppliedSellQuoteVolume ?? derivedSellQuoteVolume;
  if (suppliedSellBaseVolume !== undefined && derivedSellBaseVolume !== undefined
      && !nearlyEqual(suppliedSellBaseVolume, derivedSellBaseVolume)) {
    throw new ArchiveChartBarError("archive candle taker base volumes do not equal total volume");
  }
  if (suppliedSellQuoteVolume !== undefined && derivedSellQuoteVolume !== undefined
      && !nearlyEqual(suppliedSellQuoteVolume, derivedSellQuoteVolume)) {
    throw new ArchiveChartBarError("archive candle taker quote volumes do not equal quote volume");
  }
  if (quoteVolume !== undefined && takerBuyQuoteVolume !== undefined && takerBuyQuoteVolume > quoteVolume) {
    throw new ArchiveChartBarError("archive candle taker buy quote volume exceeds quote volume");
  }
  return Object.freeze({
    tsOpen: bar.ts_open,
    ...(quoteVolume === undefined ? {} : { quoteVolume }),
    ...(takerBuyQuoteVolume === undefined ? {} : { takerBuyQuoteVolume }),
    ...(takerSellBaseVolume === undefined ? {} : { takerSellBaseVolume }),
    ...(takerSellQuoteVolume === undefined ? {} : { takerSellQuoteVolume }),
  });
}

export function archivePageCandleSeries(
  instrument: HistoricalInstrument,
  resolution: HistoricalResolution,
  page: Pick<ArchivePage, "family" | "rows">,
): HistoricalIndicatorSeries {
  if (page.family !== familyForResolution(resolution)) {
    throw new ArchiveChartBarError("archive page family does not match the selected resolution");
  }
  let candles;
  try {
    candles = archiveCandles(page.rows);
  } catch (error) {
    archiveError(error);
  }
  const intervalMs = HISTORICAL_RESOLUTION_MS[resolution];
  const bars: BarFrame[] = candles.map((candle, index) => {
    const row = page.rows[index];
    if (row.closed !== true) {
      throw new ArchiveChartBarError("historical archive page contains an unclosed candle");
    }
    if (candle.closeMs - candle.openMs !== intervalMs || !alignedToResolution(instrument, resolution, candle.openMs)) {
      throw new ArchiveChartBarError("archive candle is not aligned to the selected resolution");
    }
    const buyVolume = optionalDecimal(row, "buy_volume");
    if (buyVolume !== undefined && buyVolume > candle.volume) {
      throw new ArchiveChartBarError("archive candle buy_volume exceeds volume");
    }
    return {
      ...instrument.chartIdentity,
      type: "bar",
      symbol: instrument.symbol,
      interval_ms: intervalMs,
      ts_open: candle.openMs,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      ...(buyVolume !== undefined ? { buy_volume: buyVolume } : {}),
      trade_count: nullableCount(row),
      closed: true,
    };
  });
  const metrics = bars.map((bar, index) => metricsForRow(page.rows[index], bar));
  if (resolution !== "1m" || !isRegularSessionOnly(instrument.chartIdentity)) return createHistoricalIndicatorSeries(bars, metrics);
  const kept = bars.flatMap((bar, index) => (inChartSession(instrument.chartIdentity, bar.ts_open) ? [index] : []));
  return createHistoricalIndicatorSeries(kept.map((index) => bars[index]), kept.map((index) => metrics[index]));
}

export function archivePageBars(
  instrument: HistoricalInstrument,
  resolution: HistoricalResolution,
  page: Pick<ArchivePage, "family" | "rows">,
): readonly BarFrame[] {
  return archivePageCandleSeries(instrument, resolution, page).bars;
}
