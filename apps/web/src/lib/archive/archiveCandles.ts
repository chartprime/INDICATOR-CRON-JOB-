import type { ArchiveRow } from "./archiveClient";

export type HistoricalCandle = Readonly<{
  openMs: number;
  closeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UNSIGNED = /^(?:0|[1-9][0-9]*)$/;

export class ArchiveCandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveCandleError";
  }
}

function text(row: ArchiveRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new ArchiveCandleError(`archive candle ${field} is not a string`);
  return value;
}

function decimal(row: ArchiveRow, field: string): number {
  const value = text(row, field);
  if (!DECIMAL.test(value)) throw new ArchiveCandleError(`archive candle ${field} is not a decimal`);
  const result = Number(value);
  if (!Number.isFinite(result)) throw new ArchiveCandleError(`archive candle ${field} is outside display range`);
  return result;
}

function nsToMs(row: ArchiveRow, field: string): number {
  const value = text(row, field);
  if (!UNSIGNED.test(value)) throw new ArchiveCandleError(`archive candle ${field} is not an unsigned integer`);
  const ms = BigInt(value) / 1_000_000n;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveCandleError(`archive candle ${field} is outside display range`);
  }
  return Number(ms);
}

export function archiveCandle(row: ArchiveRow): HistoricalCandle {
  const candle = {
    openMs: nsToMs(row, "open_ns"),
    closeMs: nsToMs(row, "close_ns"),
    open: decimal(row, "open"),
    high: decimal(row, "high"),
    low: decimal(row, "low"),
    close: decimal(row, "close"),
    volume: decimal(row, "volume"),
  };
  if (candle.openMs >= candle.closeMs
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < Math.max(candle.open, candle.close)
      || candle.volume < 0) {
    throw new ArchiveCandleError("archive candle violates OHLC invariants");
  }
  return Object.freeze(candle);
}

export function archiveCandles(rows: readonly ArchiveRow[]): readonly HistoricalCandle[] {
  const candles = rows.map(archiveCandle);
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index - 1].openMs >= candles[index].openMs) {
      throw new ArchiveCandleError("archive candles are not strictly ordered");
    }
  }
  return Object.freeze(candles);
}
