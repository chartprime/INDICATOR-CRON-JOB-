import type { BarFrame } from "../../types/frames";

export type BarSideFlow = Readonly<{ ts_open: number; buy_volume: number; sell_volume: number }>;

export type BarSides = Readonly<{
  known: boolean;
  buy: number;
  sell: number;
  unknown: number;
  delta: number;
  sided: number;
}>;

const UNKNOWN_SIDES: BarSides = Object.freeze({ known: false, buy: 0, sell: 0, unknown: 0, delta: 0, sided: 0 });

export function barSides(bar: BarFrame): BarSides {
  if (bar.buy_volume === undefined || bar.buy_volume === null) return UNKNOWN_SIDES;
  const buy = bar.buy_volume;
  const sell = bar.sell_volume === undefined || bar.sell_volume === null
    ? Math.max(0, bar.volume - buy)
    : bar.sell_volume;
  const sided = buy + sell;
  return Object.freeze({
    known: true,
    buy,
    sell,
    unknown: Math.max(0, bar.volume - sided),
    delta: buy - sell,
    sided,
  });
}

export function barDelta(bar: BarFrame): number | null {
  const sides = barSides(bar);
  return sides.known ? sides.delta : null;
}

export function unsidedShare(bars: readonly BarFrame[]): number | null {
  let volume = 0;
  let unknown = 0;
  for (const bar of bars) {
    const sides = barSides(bar);
    if (!sides.known) continue;
    volume += bar.volume;
    unknown += sides.unknown;
  }
  return volume > 0 ? unknown / volume : null;
}
