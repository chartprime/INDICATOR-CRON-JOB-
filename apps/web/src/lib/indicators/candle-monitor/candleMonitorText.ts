import type { CandleMonitorEntry, CandleMonitorFrame, CandleMonitorTrade } from "../../../types/frames";
import { NONE, shareText, signedVolumeText, volumeText } from "../exhaustion/exhaustionWords";

export interface CandleMonitorArrival {
  frame: CandleMonitorFrame;
  receivedAt: number;
}

export interface CandleMonitorRow {
  key: "buy" | "sell" | "delta" | "biggestBuy" | "biggestSell";
  label: string;
  value: string;
  color: string | null;
}

export const MONITOR_STALE_MS = 15_000;
export const DELTA_UP_COLOR = "#4ade80";
export const DELTA_DOWN_COLOR = "#f87171";
const DAY_MS = 86_400_000;
const CANDLE_LABELS: Readonly<Record<number, string>> = Object.freeze({ 60_000: "1m", 120_000: "2m", 180_000: "3m", 300_000: "5m", 900_000: "15m", 1_800_000: "30m", 3_600_000: "1h", 14_400_000: "4h", 21_600_000: "6h", 43_200_000: "12h", 86_400_000: "1D" });
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

export function candleLengthLabel(candleMs: number): string {
  return CANDLE_LABELS[candleMs] ?? `${Math.round(candleMs / 60_000)}m`;
}

export function candleTimeText(candleTs: number, candleMs: number): string {
  const date = new Date(candleTs);
  if (candleMs >= DAY_MS) return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function candleHeaderText(entry: Pick<CandleMonitorEntry, "candleMs" | "candleTs">): string {
  return `${candleLengthLabel(entry.candleMs)} · ${candleTimeText(entry.candleTs, entry.candleMs)}`;
}

function amountText(volume: number, unit: string): string {
  const text = volumeText(volume, unit);
  return unit === "" ? text : `${text} ${unit}`;
}

export type PriceFormatter = (price: number) => string;

export function tradeText(trade: CandleMonitorTrade | null, unit: string, formatPrice: PriceFormatter): string {
  if (trade === null) return NONE;
  return `${amountText(trade.size, unit)} @ ${formatPrice(trade.price)}`;
}

export function candleMonitorRows(entry: CandleMonitorEntry, unit: string, formatPrice: PriceFormatter): CandleMonitorRow[] {
  const net = entry.buy - entry.sell;
  return [
    { key: "buy", label: "Buying volume", value: amountText(entry.buy, unit), color: null },
    { key: "sell", label: "Selling volume", value: amountText(entry.sell, unit), color: null },
    { key: "delta", label: "Delta", value: `${signedVolumeText(net, unit)}${shareText(entry.buy, entry.sell)}`, color: net > 0 ? DELTA_UP_COLOR : net < 0 ? DELTA_DOWN_COLOR : null },
    { key: "biggestBuy", label: "Biggest buyer", value: tradeText(entry.biggestBuy, unit, formatPrice), color: null },
    { key: "biggestSell", label: "Biggest seller", value: tradeText(entry.biggestSell, unit, formatPrice), color: null },
  ];
}

export function monitorStale(receivedAt: number | null, nowMs: number): boolean {
  return receivedAt === null || nowMs - receivedAt > MONITOR_STALE_MS;
}

export function candleOverdueAt(entry: Pick<CandleMonitorEntry, "candleMs" | "candleTs">): number {
  return entry.candleTs + 2 * entry.candleMs + MONITOR_STALE_MS;
}

export function candleOverdue(entry: Pick<CandleMonitorEntry, "candleMs" | "candleTs"> | null, nowMs: number): boolean {
  return entry !== null && nowMs > candleOverdueAt(entry);
}
