import type { OrderBlockSide } from "./l1OrderBlockRules";

export interface BarStats {
  time: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buy_volume: number | null;
  sell_volume: number | null;
}

export interface OrderBlockL1Stats {
  buyVolume: number;
  sellVolume: number;
  delta: number | null;
  totalVolume: number;
  unknownVolume: number;
}

export function computeOrderBlockL1Stats(
  bars: readonly BarStats[],
  _side: OrderBlockSide,
  startTime: number,
  _endTime: number,
): OrderBlockL1Stats {
  let targetBar: BarStats | undefined;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].time === startTime) {
      targetBar = bars[i];
      break;
    }
  }

  if (!targetBar) {
    return { buyVolume: 0, sellVolume: 0, delta: null, totalVolume: 0, unknownVolume: 0 };
  }

  if (targetBar.volume === 0) {
    return { buyVolume: 0, sellVolume: 0, delta: null, totalVolume: 0, unknownVolume: 0 };
  }
  const sidesKnown = targetBar.buy_volume !== null && targetBar.sell_volume !== null;
  const buyVolume = targetBar.buy_volume ?? 0;
  const sellVolume = targetBar.sell_volume ?? 0;
  const totalVolume = targetBar.volume;
  const delta = sidesKnown ? buyVolume - sellVolume : null;

  return {
    buyVolume,
    sellVolume,
    delta,
    totalVolume,
    unknownVolume: Math.max(0, totalVolume - buyVolume - sellVolume),
  };
}
