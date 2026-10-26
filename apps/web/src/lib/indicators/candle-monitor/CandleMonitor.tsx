import { useEffect, useState } from "react";
import type { CandleMonitorEntry } from "../../../types/frames";
import { MONITOR_STALE_MS, candleHeaderText, candleMonitorRows, candleOverdue, monitorStale, type PriceFormatter } from "./candleMonitorText";

export function CandleMonitor({ entry, receivedAt, frameTs = null, unit, formatPrice }: { entry: CandleMonitorEntry | null; receivedAt: number | null; frameTs?: number | null; unit: string; formatPrice: PriceFormatter }) {
  const [expiredFor, setExpiredFor] = useState<number | null>(null);
  useEffect(() => {
    if (receivedAt === null) return undefined;
    const timer = setTimeout(() => setExpiredFor(receivedAt), Math.max(0, receivedAt + MONITOR_STALE_MS + 1 - Date.now()));
    return () => clearTimeout(timer);
  }, [receivedAt]);
  const stale = (receivedAt !== null && expiredFor === receivedAt) || monitorStale(receivedAt, Date.now());
  const overdue = !stale && frameTs !== null && candleOverdue(entry, frameTs);
  const rows = entry === null ? [] : candleMonitorRows(entry, unit, formatPrice);
  return (
    <div className="candle-monitor" data-testid="candle-monitor" data-stale={stale || overdue ? "true" : undefined}>
      <div className="candle-monitor-head">
        <span className="candle-monitor-title">Candle monitor</span>
        <span className="candle-monitor-candle">{stale ? "no feed" : entry === null ? "waiting for a close" : overdue ? `stale · ${candleHeaderText(entry)}` : candleHeaderText(entry)}</span>
      </div>
      {rows.map((row) => (
        <div key={row.key} className="candle-monitor-row" data-row={row.key}>
          <span className="candle-monitor-label">{row.label}</span>
          <span className="candle-monitor-value tabular" style={row.color === null ? undefined : { color: row.color }}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}
