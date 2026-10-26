import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import { withAlpha } from "../classic-order-blocks/orderBlockRender";
import { BOX_FONT_FAMILY, BOX_FONT_SIZE, BOX_TEXT_PADDING } from "../institutional-order-blocks/institutionalOrderBlocks";
import { NO_CARD, ZONE_TEXT, ZONE_TEXT_ON_DARK } from "../institutional-order-blocks/institutionalRender";
import { ageText } from "../liquidity-voids/liquidityVoidsRender";
import type { LevelsBy } from "../liquidity-voids/liquidityVoidsRules";
import type { LiquidityColumn, LiquiditySide } from "../passive-liquidity/liquidityGrid";
import { formatLiquiditySize } from "../passive-liquidity/liquiditySettings";
import type { BandSizes, EmptyBookZone } from "./emptyBookModel";
import type { EmptyOrderbookSettings } from "./emptyOrderbookSettings";

const HIDDEN = "transparent";
export const ZONE_BORDER_ALPHA = 0.85;
export const ZONE_FILL_ALPHA = 0.2;
export const ZONE_BORDER_PX = 1;
export const FLASH_ALPHA = 0.65;
export const FLASH_FLOOR = 0.25;
export const WHOLE_UNITS: readonly string[] = ["contracts", "shares"];
export const SIDE_LABEL: Readonly<Record<LiquiditySide, string>> = Object.freeze({ ask: "Empty Book Ask", bid: "Empty Book Bid" });

export interface ZoneGeometry {
  rowWidth: number;
  clusterRows: number;
}

export function zonePrices(lo: number, hi: number, geometry: ZoneGeometry): { bottom: number; top: number } {
  const height = geometry.rowWidth * geometry.clusterRows;
  return { bottom: Number((lo * height).toPrecision(12)), top: Number(((hi + 1) * height).toPrecision(12)) };
}

export function priceLabel(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function restingIn(column: LiquidityColumn, zone: Pick<EmptyBookZone, "side" | "lo" | "hi">, clusterRows: number, sizes: BandSizes): number {
  let size = 0;
  for (let row = zone.lo; row <= zone.hi; row += 1) size += sizes(column, row, clusterRows)[zone.side];
  return size;
}

export function sizeText(size: number, unit: string): string {
  const amount = WHOLE_UNITS.includes(unit) ? Math.round(size).toLocaleString("en-US") : formatLiquiditySize(size) || "0";
  return unit ? `${amount} ${unit}` : amount;
}

export function describeZone(zone: Pick<EmptyBookZone, "side" | "lo" | "hi" | "since">, nowTs: number, geometry: ZoneGeometry, size: string | null): string[] {
  const { bottom, top } = zonePrices(zone.lo, zone.hi, geometry);
  const label = SIDE_LABEL[zone.side];
  const count = zone.hi - zone.lo + 1;
  const rows = `${count} ${count === 1 ? "row" : "rows"}`;
  const head = size === null ? [label, rows] : [label, rows, size];
  const range = `from ${priceLabel(bottom)} to ${priceLabel(top)}`;
  const forms = [[...head, range, ageText(nowTs - zone.since)], [...head, range], head, head.slice(0, 2), [label]].map((parts) => parts.join(" · "));
  return forms.filter((text, index) => forms.indexOf(text) === index);
}

export function zoneColor(side: LiquiditySide, settings: Pick<EmptyOrderbookSettings, "askColor" | "bidColor">): string {
  return side === "ask" ? settings.askColor : settings.bidColor;
}

export function keptZones<Z extends Pick<EmptyBookZone, "side" | "lo" | "hi" | "since"> & { group?: number }>(zones: readonly Z[], perSide: number, priceBand: number, by: LevelsBy): Z[] {
  const distance = (zone: Z): number => Math.max(zone.lo - priceBand, priceBand - zone.hi, 0);
  const order = by === "furthest" ? (a: Z, b: Z) => distance(b) - distance(a) || a.since - b.since : (a: Z, b: Z) => distance(a) - distance(b) || a.since - b.since;
  const kept: Z[] = [];
  for (const side of ["bid", "ask"] as const) {
    const groups = new Set<unknown>();
    for (const zone of zones.filter((candidate) => candidate.side === side).sort(order)) {
      const group = zone.group ?? zone;
      if (!groups.has(group)) {
        if (groups.size >= Math.max(0, perSide)) continue;
        groups.add(group);
      }
      kept.push(zone);
    }
  }
  return kept;
}

export function createZoneSlots(count: number): BoxHandle[] {
  return Array.from({ length: count }, () =>
    draw.box({
      time1: 0, price1: 0, time2: 0, price2: 0, borderColor: HIDDEN, backgroundColor: HIDDEN, borderWidth: ZONE_BORDER_PX,
      text: "", textColor: HIDDEN, textColorOnDark: ZONE_TEXT_ON_DARK, fontSize: BOX_FONT_SIZE, fontFamily: BOX_FONT_FAMILY, textAlign: "right", textVAlign: "bottom", textPadding: BOX_TEXT_PADDING, textFitsHeight: true, keepTextClear: true,
    }),
  );
}

export function createFlashSlots(count: number): BoxHandle[] {
  return Array.from({ length: count }, () =>
    draw.box({ time1: 0, price1: 0, time2: 0, price2: 0, borderColor: HIDDEN, backgroundColor: HIDDEN, borderWidth: 0, text: "" }),
  );
}

function hide(slot: BoxHandle): void {
  slot.setLeftTop(0, 0);
  slot.setRightBottom(0, 0);
  slot.setBorderColor(HIDDEN);
  slot.setBackgroundColor(HIDDEN);
  slot.setText("");
  slot.setTextFallbacks([]);
  slot.setTextBackground("");
  slot.setTextAccent("");
  slot.setExtendRight(false);
}

export interface DrawnFlash {
  side: LiquiditySide;
  row: number;
  ts: number;
  left: number;
}

export interface ZoneFrame {
  geometry: ZoneGeometry;
  nowTs: number;
  leftOf: (since: number) => number;
  liveOpen: number;
  flashMs: number;
  sizeOf: (zone: EmptyBookZone) => string | null;
}

export function flashAlpha(ageMs: number, flashMs: number): number {
  const left = flashMs > 0 ? 1 - ageMs / flashMs : 0;
  return FLASH_ALPHA * Math.min(1, Math.max(FLASH_FLOOR, left));
}

export function renderZones(slots: readonly BoxHandle[], zones: readonly EmptyBookZone[], settings: Pick<EmptyOrderbookSettings, "askColor" | "bidColor">, frame: ZoneFrame): void {
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const zone = zones[index];
    if (zone === undefined) {
      hide(slot);
      continue;
    }
    const { bottom, top } = zonePrices(zone.lo, zone.hi, frame.geometry);
    const [text, ...fallbacks] = describeZone(zone, frame.nowTs, frame.geometry, frame.sizeOf(zone));
    const color = zoneColor(zone.side, settings);
    slot.setLeftTop(frame.leftOf(zone.since), top);
    slot.setRightBottom(frame.liveOpen, bottom);
    slot.setBorderColor(withAlpha(color, ZONE_BORDER_ALPHA));
    slot.setBorderWidth(ZONE_BORDER_PX);
    slot.setBackgroundColor(withAlpha(color, ZONE_FILL_ALPHA));
    slot.setExtendRight(true);
    slot.setText(text);
    slot.setTextFallbacks(fallbacks);
    slot.setTextColor(ZONE_TEXT);
    slot.setTextBackground(NO_CARD);
    slot.setTextAccent("");
  }
}

export function renderFlashes(slots: readonly BoxHandle[], flashes: readonly DrawnFlash[], settings: Pick<EmptyOrderbookSettings, "askColor" | "bidColor">, frame: ZoneFrame): void {
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const flash = flashes[index];
    if (flash === undefined) {
      hide(slot);
      continue;
    }
    const { bottom, top } = zonePrices(flash.row, flash.row, frame.geometry);
    slot.setLeftTop(flash.left, top);
    slot.setRightBottom(frame.liveOpen, bottom);
    slot.setBorderColor(HIDDEN);
    slot.setBorderWidth(0);
    slot.setBackgroundColor(withAlpha(zoneColor(flash.side, settings), flashAlpha(frame.nowTs - flash.ts, frame.flashMs)));
    slot.setExtendRight(true);
    slot.setText("");
    slot.setTextFallbacks([]);
  }
}
