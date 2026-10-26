import { barIndexAt, type ChartTimeGeometry } from "../l2-book-map/l2BookMapPrimitive";

export function timeToX(timeMs: number, geometry: ChartTimeGeometry): number {
  const { opens, count } = slotsOf(geometry);
  const scale = geometry.barSpacing / geometry.intervalMs;
  const slotLeft = (index: number) => geometry.originX + (index - (count - 1)) * geometry.barSpacing;
  const index = barIndexAt(timeMs, opens);
  if (index < 0) return slotLeft(0) + (timeMs - opens[0]) * scale;
  const open = opens[index];
  if (index === count - 1) return slotLeft(index) + (timeMs - open) * scale;
  return slotLeft(index) + Math.min(timeMs - open, geometry.intervalMs) * scale;
}

export function xToTime(x: number, geometry: ChartTimeGeometry): number {
  const { opens, count } = slotsOf(geometry);
  const slot = (x - geometry.originX) / geometry.barSpacing;
  const offset = Math.floor(slot);
  const index = count - 1 + offset;
  if (offset >= 0) return opens[count - 1] + slot * geometry.intervalMs;
  if (index >= 0) return opens[index] + (slot - offset) * geometry.intervalMs;
  return opens[0] + (slot + (count - 1)) * geometry.intervalMs;
}

function slotsOf(geometry: ChartTimeGeometry): { opens: readonly number[]; count: number } {
  return { opens: geometry.barOpensMs, count: geometry.barOpensMs.length };
}

export function bandThickness(heat: number, spanPx: number, thinnest: number, thickest: number): number {
  return Math.max(thinnest + (thickest - thinnest) * heat, spanPx);
}

export function bandColor(side: 0 | 1, alpha: number): string {
  const clamped = Math.min(0.98, Math.max(0, alpha));
  return side === 0 ? `rgba(38,195,110,${clamped.toFixed(3)})` : `rgba(220,65,65,${clamped.toFixed(3)})`;
}

export const OUTCOME_ALPHA: readonly number[] = Object.freeze([1, 0.88, 0.5, 0.34, 0.24]);

export function bandAlpha(heat: number, outcome: number): number {
  return (0.2 + 0.7 * Math.pow(heat, 0.75)) * (OUTCOME_ALPHA[outcome] ?? 0.24);
}

export function pickLabelRows(centres: readonly number[], minGap: number, top: number, bottom: number): readonly number[] {
  const used: number[] = [];
  const picked: number[] = [];
  for (let index = 0; index < centres.length; index += 1) {
    const y = centres[index];
    if (!(y >= top && y <= bottom)) continue;
    if (used.some((other) => Math.abs(other - y) < minGap)) continue;
    used.push(y);
    picked.push(index);
  }
  return picked;
}

export function nearestWalls(standing: readonly { readonly side: 0 | 1; readonly lo: number; readonly hi: number; readonly usd: number }[], price: number): { ask: { usd: number; pct: number } | null; bid: { usd: number; pct: number } | null } {
  let ask: { mid: number; usd: number } | null = null;
  let bid: { mid: number; usd: number } | null = null;
  for (const wall of standing) {
    const mid = (wall.lo + wall.hi) / 2;
    if (wall.side === 1 && mid > price && (ask === null || mid < ask.mid)) ask = { mid, usd: wall.usd };
    if (wall.side === 0 && mid < price && (bid === null || mid > bid.mid)) bid = { mid, usd: wall.usd };
  }
  return {
    ask: ask === null ? null : { usd: ask.usd, pct: (100 * (ask.mid - price)) / price },
    bid: bid === null ? null : { usd: bid.usd, pct: (100 * (price - bid.mid)) / price },
  };
}
