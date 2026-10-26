import type { BarFrame } from "../../../types/frames";
import { barDelta } from "../barSides";

export type OrderFlowDisplayMode = "line" | "candles";

export interface CvdCandle {
  ts_open: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function deltaOf(bar: BarFrame): number | null {
  return barDelta(bar);
}

export function computeCvdCandles(
  displayBars: readonly BarFrame[],
  sourceBars: readonly BarFrame[],
  intervalMs: number,
): (CvdCandle | null)[] {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("computeCvdCandles: intervalMs must be a positive safe integer");
  }
  const byBucket = new Map<number, BarFrame[]>();
  for (const bar of sourceBars) {
    const bucket = Math.floor(bar.ts_open / intervalMs) * intervalMs;
    const group = byBucket.get(bucket);
    if (group) group.push(bar);
    else byBucket.set(bucket, [bar]);
  }
  for (const group of byBucket.values()) group.sort((a, b) => a.ts_open - b.ts_open);

  const candles: (CvdCandle | null)[] = [];
  let running = 0;
  for (let displayIndex = 0; displayIndex < displayBars.length; displayIndex += 1) {
    const displayBar = displayBars[displayIndex];
    if (
      displayIndex > 0 &&
      displayBar.ts_open !== displayBars[displayIndex - 1].ts_open + intervalMs
    ) {
      running = 0;
    }
    const constituents = byBucket.get(displayBar.ts_open);
    if (constituents === undefined || constituents.length === 0) {
      candles.push(null);
      running = 0;
      continue;
    }
    const deltas: number[] = [];
    let complete = true;
    for (const constituent of constituents) {
      const delta = deltaOf(constituent);
      if (delta === null) {
        complete = false;
        break;
      }
      deltas.push(delta);
    }
    if (!complete) {
      candles.push(null);
      running = 0;
      continue;
    }
    const open = running;
    let high = open;
    let low = open;
    for (const delta of deltas) {
      running += delta;
      if (running > high) high = running;
      if (running < low) low = running;
    }
    candles.push({ ts_open: displayBar.ts_open, open, high, low, close: running });
  }
  return candles;
}
