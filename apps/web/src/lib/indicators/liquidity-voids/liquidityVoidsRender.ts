import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import { withAlpha } from "../classic-order-blocks/orderBlockRender";
import { BOX_FONT_FAMILY, BOX_FONT_SIZE, BOX_TEXT_PADDING } from "../institutional-order-blocks/institutionalOrderBlocks";
import { NO_CARD, ZONE_TEXT, ZONE_TEXT_ON_DARK } from "../institutional-order-blocks/institutionalRender";
import type { LevelsBy, LiquidityVoidsSettings } from "./liquidityVoidsRules";
import type { SweepBox, VoidSide } from "./sweepModel";

const HIDDEN = "transparent";
export const VOID_FILL_ALPHA = 0.12;
export const VOID_BORDER_ALPHA = 0.85;
export const VOID_BORDER_PX = 1;
export const SIDE_LABEL: Readonly<Record<VoidSide, string>> = Object.freeze({ ask: "FPB Ask", bid: "FPB Bid" });

export interface VoidBox {
  side: VoidSide;
  rowLo: number;
  rowHi: number;
  startTs: number;
  endTs: number;
  volume: number | null;
}

export interface VoidFormat {
  rowWidth: number;
  tickSize: number | null;
  priceUnit: "$" | "pts";
  sizeUnit: string;
}

export function priceText(value: number): string {
  return String(Number.parseFloat(value.toFixed(2)));
}

export function createVoidSlots(count: number): BoxHandle[] {
  return Array.from({ length: count }, () =>
    draw.box({
      time1: 0, price1: 0, time2: 0, price2: 0, borderColor: HIDDEN, backgroundColor: HIDDEN, borderWidth: VOID_BORDER_PX,
      text: "", textColor: HIDDEN, textColorOnDark: ZONE_TEXT_ON_DARK, fontSize: BOX_FONT_SIZE, fontFamily: BOX_FONT_FAMILY, textAlign: "right", textVAlign: "bottom", textPadding: BOX_TEXT_PADDING, textFitsHeight: true, keepTextClear: true,
    }),
  );
}

export function ageText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

export function describeVoid(box: VoidBox, nowTs: number): string[] {
  const head = SIDE_LABEL[box.side];
  return [`${head} · ${ageText(nowTs - box.endTs)}`, head];
}

export function voidColor(side: VoidSide, settings: Pick<LiquidityVoidsSettings, "askColor" | "bidColor">): string {
  return side === "ask" ? settings.askColor : settings.bidColor;
}

export function keptPerSide<T extends VoidBox>(boxes: readonly T[], perSide: number, priceRow: number, by: LevelsBy): T[] {
  const distance = (box: T): number => Math.max(box.rowLo - priceRow, priceRow - (box.rowHi + 1), 0);
  const order = by === "furthest" ? (a: T, b: T) => distance(b) - distance(a) || b.endTs - a.endTs : (a: T, b: T) => distance(a) - distance(b) || b.endTs - a.endTs;
  const kept: T[] = [];
  for (const side of ["bid", "ask"] as const) {
    kept.push(...boxes.filter((box) => box.side === side).sort(order).slice(0, Math.max(0, perSide)));
  }
  return kept;
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

export function tradedLittle<T extends VoidBox>(boxes: readonly T[], maxTraded: number | null, settledBefore: number): T[] {
  if (maxTraded === null) return [...boxes];
  return boxes.filter((box) => (box.volume === null ? box.startTs < settledBefore : box.volume <= maxTraded));
}

export function smallestInFront<T extends VoidBox>(boxes: readonly T[]): T[] {
  return [...boxes].sort((a, b) => (b.volume ?? Infinity) - (a.volume ?? Infinity));
}

export function renderVoids(slots: readonly BoxHandle[], boxes: readonly SweepBox[], settings: LiquidityVoidsSettings, format: VoidFormat, nowTs: number, snap: (ts: number) => number, liveOpen: number, priceRow: number, maxTraded: number | null, settledBefore: number): VoidBox[] {
  const rowWidth = format.rowWidth;
  const shown = smallestInFront(keptPerSide(tradedLittle(boxes, maxTraded, settledBefore), settings.boxesPerSide, priceRow, settings.levelsBy).slice(0, slots.length));
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const box = shown[index];
    if (box === undefined) {
      hide(slot);
      continue;
    }
    const color = voidColor(box.side, settings);
    const [text, ...fallbacks] = describeVoid(box, nowTs);
    slot.setLeftTop(snap(box.startTs), (box.rowHi + 1) * rowWidth);
    slot.setRightBottom(liveOpen, box.rowLo * rowWidth);
    slot.setBorderColor(withAlpha(color, VOID_BORDER_ALPHA));
    slot.setBorderWidth(VOID_BORDER_PX);
    slot.setBackgroundColor(withAlpha(color, VOID_FILL_ALPHA));
    slot.setExtendRight(true);
    slot.setText(text);
    slot.setTextFallbacks(fallbacks);
    slot.setTextColor(ZONE_TEXT);
    slot.setTextBackground(NO_CARD);
    slot.setTextAccent("");
  }
  return shown;
}
