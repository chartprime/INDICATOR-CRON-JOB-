import type { BarFrame, FrameIdentity } from "../../../types/frames";
import { barDelta } from "../barSides";

export const CVD_HISTOGRAM_COMPRESSION_NOTE = "extremes compressed";

export function orderFlowProvenance(identity: FrameIdentity): string {
  const source = identity.provider === "BINANCE"
    ? "Binance exchange taker-buy volume"
    : "dxFeed terminal-classified TimeAndSale";
  return `${source} · ${CVD_HISTOGRAM_COMPRESSION_NOTE}`;
}

export function computeDeltaPerBar(bars: readonly BarFrame[]): (number | null)[] {
  return bars.map((bar) => barDelta(bar));
}

export function computeCVD(deltaPerBar: readonly (number | null)[]): (number | null)[] {
  const result: (number | null)[] = new Array(deltaPerBar.length);
  let running = 0;
  for (let i = 0; i < deltaPerBar.length; i += 1) {
    const delta = deltaPerBar[i];
    if (delta === null) {
      result[i] = null;
      running = 0;
      continue;
    }
    running += delta;
    result[i] = running;
  }
  return result;
}

export function cvdAfter(
  previousBar: Pick<BarFrame, "ts_open" | "interval_ms"> | undefined,
  previousCvd: number | null,
  bar: Pick<BarFrame, "ts_open">,
  delta: number | null,
): number | null {
  if (delta === null) return null;
  const continues = previousBar !== undefined && bar.ts_open === previousBar.ts_open + previousBar.interval_ms;
  return (continues ? previousCvd ?? 0 : 0) + delta;
}

export function computeCVDForBars(
  bars: readonly Pick<BarFrame, "ts_open" | "interval_ms">[],
  deltaPerBar: readonly (number | null)[],
): (number | null)[] {
  if (bars.length !== deltaPerBar.length) {
    throw new Error("computeCVDForBars: bars and deltaPerBar must have identical lengths");
  }
  const result: (number | null)[] = new Array(deltaPerBar.length);
  let running = 0;
  for (let i = 0; i < deltaPerBar.length; i += 1) {
    if (
      i > 0 &&
      bars[i].ts_open !== bars[i - 1].ts_open + bars[i - 1].interval_ms
    ) {
      running = 0;
    }
    const delta = deltaPerBar[i];
    if (delta === null) {
      result[i] = null;
      running = 0;
      continue;
    }
    running += delta;
    result[i] = running;
  }
  return result;
}
