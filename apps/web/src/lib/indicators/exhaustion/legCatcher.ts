export interface LegBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type LegSide = "up" | "down";

export interface Leg {
  side: LegSide;
  startIndex: number;
  startTime: number;
  startPrice: number;
  extremeIndex: number;
  extremeTime: number;
  extremePrice: number;
  size: number;
  atr: number;
  sizeAtr: number;
  efficiency: number;
  candles: number;
  open: boolean;
}

export interface LegSettings {
  atrPeriod: number;
  atrMultiple: number;
  reverseAtr: number;
  minEfficiency: number;
}

export const DEFAULT_LEG_SETTINGS: LegSettings = { atrPeriod: 14, atrMultiple: 8, reverseAtr: 3, minEfficiency: 0.5 };
export const SESSION_GAP_INTERVALS = 2;

export function atrSeries(bars: readonly LegBar[], period: number): number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  if (!(period >= 1) || bars.length === 0) return out;
  let sum = 0;
  let atr = Number.NaN;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const previous = i > 0 ? bars[i - 1].close : bar.close;
    const range = Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
    if (i < period) {
      sum += range;
      if (i === period - 1) atr = sum / period;
    } else {
      atr = (atr * (period - 1) + range) / period;
    }
    out[i] = atr;
  }
  return out;
}

export function barIntervalOf(bars: readonly LegBar[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < bars.length && i < 50; i += 1) {
    const step = bars[i].time - bars[i - 1].time;
    if (step > 0 && step < best) best = step;
  }
  return Number.isFinite(best) ? best : 60;
}

function pathOf(bars: readonly LegBar[], from: number, to: number, startPrice: number, extremePrice: number): number {
  let path = 0;
  let last = startPrice;
  for (let j = from + 1; j <= to; j += 1) {
    path += Math.abs(bars[j].close - last);
    last = bars[j].close;
  }
  return path + Math.abs(extremePrice - last);
}

export function catchLegs(bars: readonly LegBar[], settings: LegSettings = DEFAULT_LEG_SETTINGS, interval = barIntervalOf(bars)): Leg[] {
  const atr = atrSeries(bars, settings.atrPeriod);
  const legs: Leg[] = [];
  let dir: 0 | 1 | -1 = 0;
  let pivot = Number.NaN;
  let pivotIndex = -1;
  let extreme = Number.NaN;
  let extremeIndex = -1;
  let atrRef = Number.NaN;
  let lowest = Number.NaN;
  let lowestIndex = -1;
  let highest = Number.NaN;
  let highestIndex = -1;

  const legOf = (side: LegSide, open: boolean): Leg | null => {
    const size = Math.abs(extreme - pivot);
    const base = atrRef;
    if (!(base > 0)) return null;
    const path = pathOf(bars, pivotIndex, extremeIndex, pivot, extreme);
    const efficiency = path > 0 ? Math.min(1, size / path) : 1;
    const leg: Leg = {
      side,
      startIndex: pivotIndex,
      startTime: bars[pivotIndex].time,
      startPrice: pivot,
      extremeIndex,
      extremeTime: bars[extremeIndex].time,
      extremePrice: extreme,
      size,
      atr: base,
      sizeAtr: size / base,
      efficiency,
      candles: extremeIndex - pivotIndex,
      open,
    };
    return leg.sizeAtr >= settings.atrMultiple && leg.efficiency >= settings.minEfficiency ? leg : null;
  };

  const reset = (i: number) => {
    dir = 0;
    lowest = bars[i].low;
    lowestIndex = i;
    highest = bars[i].high;
    highestIndex = i;
    pivot = Number.NaN;
    pivotIndex = -1;
    extreme = Number.NaN;
    extremeIndex = -1;
    atrRef = Number.NaN;
  };

  const settle = () => {
    if (dir === 0) return;
    const leg = legOf(dir === 1 ? "up" : "down", false);
    if (leg !== null) legs.push(leg);
  };

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (i === 0 || bar.time - bars[i - 1].time > SESSION_GAP_INTERVALS * interval) {
      settle();
      reset(i);
      continue;
    }
    if (dir === 0) {
      if (bar.low <= lowest) {
        lowest = bar.low;
        lowestIndex = i;
      }
      if (bar.high >= highest) {
        highest = bar.high;
        highestIndex = i;
      }
      const upFrom = atr[lowestIndex];
      const downFrom = atr[highestIndex];
      if (upFrom > 0 && bar.high - lowest >= settings.reverseAtr * upFrom) {
        dir = 1;
        pivot = lowest;
        pivotIndex = lowestIndex;
        atrRef = upFrom;
        extreme = bar.high;
        extremeIndex = i;
      } else if (downFrom > 0 && highest - bar.low >= settings.reverseAtr * downFrom) {
        dir = -1;
        pivot = highest;
        pivotIndex = highestIndex;
        atrRef = downFrom;
        extreme = bar.low;
        extremeIndex = i;
      }
      continue;
    }
    const reverse = settings.reverseAtr * atrRef;
    if (dir === 1) {
      if (bar.high > extreme) {
        extreme = bar.high;
        extremeIndex = i;
      } else if (extreme - bar.low >= reverse) {
        const leg = legOf("up", false);
        if (leg !== null) legs.push(leg);
        dir = -1;
        pivot = extreme;
        pivotIndex = extremeIndex;
        atrRef = atr[pivotIndex];
        extreme = bar.low;
        extremeIndex = i;
      }
    } else if (bar.low < extreme) {
      extreme = bar.low;
      extremeIndex = i;
    } else if (bar.high - extreme >= reverse) {
      const leg = legOf("down", false);
      if (leg !== null) legs.push(leg);
      dir = 1;
      pivot = extreme;
      pivotIndex = extremeIndex;
      atrRef = atr[pivotIndex];
      extreme = bar.high;
      extremeIndex = i;
    }
  }
  if (dir !== 0) {
    const leg = legOf(dir === 1 ? "up" : "down", true);
    if (leg !== null) legs.push(leg);
  }
  return legs;
}
