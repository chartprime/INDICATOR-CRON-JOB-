import type { BarFrame } from "../../types/frames";

export const MAX_RETAINED_SOURCE_BARS = 10_080;

export type SourceBarRejection = "FINALIZED_BAR_CANNOT_REOPEN" | "STALE_DEVELOPING_BAR";

export interface SourceBarAdmission {
  accepted: boolean;
  developingBar: BarFrame | null;
  rejection?: SourceBarRejection;
}

function lowerBoundByOpenTime(bars: readonly BarFrame[], tsOpen: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (bars[middle].ts_open < tsOpen) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function replaceClosedBars(bars: readonly BarFrame[]): BarFrame[] {
  const byOpenTime = new Map<number, BarFrame>();
  for (const bar of bars) {
    if (bar.closed) byOpenTime.set(bar.ts_open, bar);
  }
  return [...byOpenTime.values()]
    .sort((a, b) => a.ts_open - b.ts_open)
    .slice(-MAX_RETAINED_SOURCE_BARS);
}

export function upsertClosedBar(bars: BarFrame[], bar: BarFrame): void {
  if (!bar.closed) throw new Error("upsertClosedBar: bar must be finalized");
  const last = bars[bars.length - 1];
  if (last === undefined || last.ts_open < bar.ts_open) bars.push(bar);
  else {
    const index = lowerBoundByOpenTime(bars, bar.ts_open);
    if (bars[index]?.ts_open === bar.ts_open) bars[index] = bar;
    else bars.splice(index, 0, bar);
  }
  if (bars.length > MAX_RETAINED_SOURCE_BARS) {
    bars.splice(0, bars.length - MAX_RETAINED_SOURCE_BARS);
  }
}

export function admitSourceBar(
  closedBars: BarFrame[],
  developingBar: BarFrame | null,
  bar: BarFrame,
): SourceBarAdmission {
  if (bar.closed) {
    upsertClosedBar(closedBars, bar);
    return {
      accepted: true,
      developingBar: developingBar !== null && developingBar.ts_open > bar.ts_open
        ? developingBar
        : null,
    };
  }

  const newestClosed = closedBars[closedBars.length - 1];
  if (newestClosed !== undefined && bar.ts_open <= newestClosed.ts_open) {
    return { accepted: false, developingBar, rejection: "FINALIZED_BAR_CANNOT_REOPEN" };
  }
  if (developingBar !== null && bar.ts_open < developingBar.ts_open) {
    return { accepted: false, developingBar, rejection: "STALE_DEVELOPING_BAR" };
  }
  return { accepted: true, developingBar: bar };
}

export function fullBarBuffer(closedBars: readonly BarFrame[], developingBar: BarFrame | null): BarFrame[] {
  if (developingBar === null) return [...closedBars];
  const retainedClosed = closedBars.length >= MAX_RETAINED_SOURCE_BARS
    ? closedBars.slice(closedBars.length - (MAX_RETAINED_SOURCE_BARS - 1))
    : closedBars;
  return [...retainedClosed, developingBar];
}

export function latestSourceBar(closedBars: readonly BarFrame[], developingBar: BarFrame | null): BarFrame | null {
  const newestClosed = closedBars[closedBars.length - 1] ?? null;
  return developingBar !== null && (newestClosed === null || developingBar.ts_open > newestClosed.ts_open)
    ? developingBar
    : newestClosed;
}

export function sourceBarsForBucket(
  closedBars: readonly BarFrame[],
  developingBar: BarFrame | null,
  bucketOpen: number,
  bucketIntervalMs: number,
): BarFrame[] {
  if (!Number.isSafeInteger(bucketOpen) || !Number.isSafeInteger(bucketIntervalMs) || bucketIntervalMs <= 0) {
    throw new Error("sourceBarsForBucket: invalid bucket boundary");
  }
  const bucketEnd = bucketOpen + bucketIntervalMs;
  if (!Number.isSafeInteger(bucketEnd)) throw new Error("sourceBarsForBucket: bucket boundary overflow");
  const start = lowerBoundByOpenTime(closedBars, bucketOpen);
  const end = lowerBoundByOpenTime(closedBars, bucketEnd);
  const selected = closedBars.slice(start, end);
  if (developingBar !== null && developingBar.ts_open >= bucketOpen && developingBar.ts_open < bucketEnd) {
    selected.push(developingBar);
  }
  return selected;
}
