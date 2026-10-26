import type { AxisProfileBar } from "../axis-profile/axisProfilePrimitive";
import { MIN_LABEL_FONT_PX } from "../axis-profile/axisProfileLayout";
import { LABEL_CHAR_EM, LABEL_PAD_PX } from "../live-delta-profile/deltaProfileLayout";
import type { BookRow, BookSpread } from "./bookProfileSource";

export interface BookBar extends AxisProfileBar {
  side: "bid" | "ask";
  size: number;
}

type YOf = (price: number) => number | null;

export function layoutBook(bands: readonly BookRow[], yOf: YOf, height: number): BookBar[] {
  const bars: BookBar[] = [];
  let max = 0;
  for (const band of bands) {
    const top = yOf(band.priceTo);
    const bottom = yOf(band.price);
    if (top === null || bottom === null) continue;
    const yTop = Math.min(top, bottom);
    const yBottom = Math.max(top, bottom);
    if (yBottom < 0 || yTop > height) continue;
    const both = band.bid > 0 && band.ask > 0;
    const mid = (yTop + yBottom) / 2;
    if (band.bid > 0) bars.push({ index: band.index * 2, yTop: both ? mid : yTop, yBottom, side: "bid", size: band.bid, share: 0 });
    if (band.ask > 0) bars.push({ index: band.index * 2 + 1, yTop, yBottom: both ? mid : yBottom, side: "ask", size: band.ask, share: 0 });
    max = Math.max(max, band.bid, band.ask);
  }
  if (max > 0) for (const bar of bars) bar.share = bar.size / max;
  return bars;
}

export function bookLabels(bars: readonly BookBar[], fontPx: number): BookBar[] {
  const order = bars.map((bar, at) => ({ bar, at })).sort((a, b) => b.bar.size - a.bar.size || a.bar.index - b.bar.index);
  const taken: [number, number][] = [];
  const kept = new Set<number>();
  for (const { bar, at } of order) {
    const mid = (bar.yTop + bar.yBottom) / 2;
    const top = mid - fontPx / 2;
    const bottom = mid + fontPx / 2;
    if (taken.some(([from, to]) => top < to && from < bottom)) continue;
    taken.push([top, bottom]);
    kept.add(at);
  }
  return bars.filter((_, at) => kept.has(at));
}

export function spreadPrice(spread: BookSpread, rowWidth: number): number | null {
  if (spread.bidRow === null || spread.askRow === null) return null;
  return ((spread.bidRow + 1 + spread.askRow) / 2) * rowWidth;
}

export function bookRowsReadable(rowPx: number): boolean {
  return rowPx >= MIN_LABEL_FONT_PX + 2;
}

export const ZOOMED_OUT_REACH = 1 / 3;

export function bookStubPx(fontPx: number): number {
  return Math.ceil(3 * LABEL_CHAR_EM * fontPx + LABEL_PAD_PX);
}

export function bookColumnPx(share: number, roomPx: number, fontPx: number, rowPx: number): number {
  if (share <= 0) return 0;
  const scale = Math.max(ZOOMED_OUT_REACH, rowPx / (MIN_LABEL_FONT_PX + 2));
  return Math.min(roomPx, Math.max(bookStubPx(fontPx), share * roomPx * scale));
}

export function bookBarPx(share: number, roomPx: number, text: string, fontPx: number): number {
  if (share <= 0) return 0;
  const fitsText = Math.ceil(text.length * LABEL_CHAR_EM * fontPx + LABEL_PAD_PX);
  return Math.min(roomPx, Math.max(share * roomPx, fitsText));
}
