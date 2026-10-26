export const DEFAULT_CANDLE_MS = 60_000;
export const LINE_HIT_PX = 6;

export type WindowLine = "from" | "to";

export interface TimedRow {
  time: number;
}

export interface LogicalScale {
  logicalToCoordinate(logical: number): number | null;
}

export interface WindowLines {
  left: number;
  right: number;
  from: number | null;
  to: number | null;
}

export function tradedSpans(rows: readonly TimedRow[], candleMs: number, fromTs: number, toTs: number): [number, number][] {
  const spans: [number, number][] = [];
  if (!(toTs > fromTs)) return spans;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].time * 1_000 + candleMs <= fromTs) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < rows.length; i += 1) {
    const start = rows[i].time * 1_000;
    if (start >= toTs) break;
    const from = Math.max(start, fromTs);
    const to = Math.min(start + candleMs, toTs);
    const last = spans[spans.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else spans.push([from, to]);
  }
  return spans;
}

export function candleMsOf(rows: readonly TimedRow[]): number {
  if (rows.length < 2) return DEFAULT_CANDLE_MS;
  const ms = (rows[rows.length - 1].time - rows[rows.length - 2].time) * 1_000;
  return ms > 0 ? ms : DEFAULT_CANDLE_MS;
}

function barAt(rows: readonly TimedRow[], ms: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].time * 1_000 <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function logicalOfTime(rows: readonly TimedRow[], ms: number, candleMs: number): number | null {
  if (rows.length === 0 || !(candleMs > 0) || !Number.isFinite(ms)) return null;
  const i = barAt(rows, ms);
  const share = (ms - rows[i].time * 1_000) / candleMs;
  const inside = i === rows.length - 1 || share < 0 ? share : Math.min(1, share);
  return i - 0.5 + inside;
}

export function timeOfLogical(rows: readonly TimedRow[], logical: number, candleMs: number): number | null {
  if (rows.length === 0 || !(candleMs > 0) || !Number.isFinite(logical)) return null;
  const i = Math.min(rows.length - 1, Math.max(0, Math.floor(logical + 0.5)));
  return rows[i].time * 1_000 + (logical - (i - 0.5)) * candleMs;
}

export function xOfLogical(scale: LogicalScale, logical: number): number | null {
  if (!Number.isFinite(logical)) return null;
  const x0 = scale.logicalToCoordinate(0);
  const x1 = scale.logicalToCoordinate(1);
  return x0 === null || x1 === null ? null : x0 + logical * (x1 - x0);
}

export function logicalOfX(scale: LogicalScale, x: number): number | null {
  const x0 = scale.logicalToCoordinate(0);
  const x1 = scale.logicalToCoordinate(1);
  if (x0 === null || x1 === null || !(x1 - x0 > 0)) return null;
  return (x - x0) / (x1 - x0);
}

export function nearestLine(lines: WindowLines | null, x: number, hitPx: number = LINE_HIT_PX): WindowLine | null {
  if (lines === null) return null;
  const from = lines.from !== null && Math.abs(x - lines.from) <= hitPx ? lines.from : null;
  const to = lines.to !== null && Math.abs(x - lines.to) <= hitPx ? lines.to : null;
  if (from !== null && to !== null) return x >= (from + to) / 2 ? "to" : "from";
  if (from !== null) return "from";
  return to !== null ? "to" : null;
}
