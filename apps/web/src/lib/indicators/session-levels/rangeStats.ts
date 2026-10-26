import { eachColumn, type ColumnFeed } from "../absorption-detector/absorptionColumns";
import { formatLiquiditySize } from "../passive-liquidity/liquiditySettings";

export interface RangeStats {
  biggestBuy: number;
  biggestSell: number;
  bought: number;
  sold: number;
  noPrints?: true;
  missingMs?: number;
}

export function readRangeStats(feed: ColumnFeed, fromMs: number, toMs: number): RangeStats | null {
  const stats: RangeStats = { biggestBuy: 0, biggestSell: 0, bought: 0, sold: 0 };
  const orders = new Map<string, number>();
  let columns = 0;
  let covered = false;
  let coveredThrough = -Infinity;
  let gap = false;
  eachColumn(feed, fromMs, toMs - 1, (column, columnMs) => {
    if (columns === 0) {
      covered = column.ts <= fromMs + columnMs;
      if (!covered) return true;
    }
    if (coveredThrough !== -Infinity && column.ts > coveredThrough) {
      gap = true;
      return true;
    }
    coveredThrough = Math.max(coveredThrough, column.ts + columnMs);
    columns += 1;
    for (const [, volume] of column.buy ?? []) stats.bought += volume;
    for (const [, volume] of column.sell ?? []) stats.sold += volume;
    for (const print of column.prints ?? []) {
      const key = `${print.side}:${print.ts}`;
      orders.set(key, (orders.get(key) ?? 0) + print.size);
    }
  });
  for (const [key, size] of orders) {
    if (key.startsWith("buy:")) stats.biggestBuy = Math.max(stats.biggestBuy, size);
    else stats.biggestSell = Math.max(stats.biggestSell, size);
  }
  return columns > 0 && covered && !gap && coveredThrough >= toMs ? stats : null;
}

function amount(size: number, unit: string): string {
  return `${formatLiquiditySize(size) || "0"} ${unit}`;
}

export function describeRangeStats(stats: RangeStats | null, unit: string): string[] {
  if (stats === null) return ["no book for this range"];
  const cvd = stats.bought - stats.sold;
  const totals = [`Total traded: ${amount(stats.bought + stats.sold, unit)}`, `CVD: ${cvd < 0 ? "-" : "+"}${amount(Math.abs(cvd), unit)}`];
  if (stats.missingMs !== undefined) totals.push(`book missing for ${Math.max(1, Math.round(stats.missingMs / 60_000))} min`);
  if (stats.noPrints) return totals;
  return [`Biggest market buy: ${amount(stats.biggestBuy, unit)}`, `Biggest market sell: ${amount(stats.biggestSell, unit)}`, ...totals];
}
