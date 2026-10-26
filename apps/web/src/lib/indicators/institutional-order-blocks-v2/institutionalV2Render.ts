import type { BoxHandle } from "../../chart/draw/box";
import { MITIGATED_FILL_ALPHA, withAlpha } from "../classic-order-blocks/orderBlockRender";
import { ACCENT_ALPHA, CARD_FILL, CARD_TEXT, MITIGATED_ACCENT_ALPHA, MITIGATED_CARD_FILL, STRONG_FILL_ALPHA } from "../institutional-order-blocks/institutionalRender";
import { formatLiquiditySize } from "../passive-liquidity/liquiditySettings";
import { barTouches, freshnessOf, gradeOf, gradeWhileStanding, isShownGrade, staysOnChart, wallScore, type Freshness, type Grade, type InstitutionalV2Settings, type LevelsBy, type Wall } from "./institutionalV2Rules";

export const STRONG_BORDER_ALPHA = 1;
export const WEAK_BORDER_ALPHA = 0.5;
export const MITIGATED_BORDER_ALPHA = 0.35;
export const WALL_TEXT_PADDING = 4;
export const WEAK_FILL_ALPHA = 0.1;
export const WEAK_ACCENT_ALPHA = 0.5;
export const WEAK_CARD_FILL = MITIGATED_CARD_FILL;

const GRADE: Record<Grade, string> = { strong: "Strong", weak: "Weak" };
const FRESHNESS: Record<Freshness, string> = { fresh: "Fresh", tested: "Tested" };

export function wallPrices(wall: Wall, rowWidth: number): { top: number; bottom: number } {
  const rowLo = wall.band * wall.bandRows;
  return { bottom: rowLo * rowWidth, top: (rowLo + wall.bandRows) * rowWidth };
}

function amount(size: number, unit: string): string {
  const text = formatLiquiditySize(size) || "0";
  return unit ? `${text} ${unit}` : text;
}

function facts(wall: Wall, grade: Grade, nowTs: number, unit: string, strongSize: number): string[] {
  return [`${GRADE[grade]} OB`, amount(wall.current, unit), FRESHNESS[freshnessOf(wall)], `${wallScore(wall, strongSize, nowTs)}/100`];
}

export function describeWall(wall: Wall, grade: Grade, nowTs: number, unit: string, strongSize: number): string {
  return facts(wall, grade, nowTs, unit, strongSize).join(" · ");
}

export function shortenWall(wall: Wall, grade: Grade, nowTs: number, unit: string, strongSize: number): string[] {
  const parts = facts(wall, grade, nowTs, unit, strongSize);
  const forms: string[] = [];
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) forms.push(parts.slice(0, keep).join(" · "));
  return forms;
}

function distanceToPrice(wall: Wall, rowWidth: number, price: number): number {
  const { top, bottom } = wallPrices(wall, rowWidth);
  return Math.max(bottom - price, price - top, 0);
}

function topPerSide<T extends { wall: Wall }>(entries: readonly T[], count: number, rowWidth: number, price: number, by: LevelsBy): T[] {
  if (!(count > 0)) return [...entries];
  const nearer = (a: T, b: T): number => distanceToPrice(a.wall, rowWidth, price) - distanceToPrice(b.wall, rowWidth, price);
  const bigger = (a: T, b: T): number => b.wall.current - a.wall.current;
  const order =
    by === "largest"
      ? (a: T, b: T) => bigger(a, b) || nearer(a, b)
      : by === "furthest"
        ? (a: T, b: T) => nearer(b, a) || bigger(a, b)
        : (a: T, b: T) => nearer(a, b) || bigger(a, b);
  const kept: T[] = [];
  for (const side of ["bid", "ask"] as const) {
    kept.push(...entries.filter((entry) => entry.wall.side === side).sort(order).slice(0, count));
  }
  return kept;
}

function hide(slot: BoxHandle): void {
  slot.setLeftTop(0, 0);
  slot.setRightBottom(0, 0);
  slot.setBorderColor("transparent");
  slot.setBackgroundColor("transparent");
  slot.setText("");
  slot.setTextBackground("");
  slot.setMinHeightPx(0);
  slot.setExtendRight(false);
}

export const ENGINE_TAG = "L2";
export const ENGINE_BORDER_PX = 2;

export interface WallMark {
  tag: string;
  borderPx: number;
}

export const PLAIN_MARK: WallMark = { tag: "", borderPx: 1 };
export const ENGINE_MARK: WallMark = { tag: ENGINE_TAG, borderPx: ENGINE_BORDER_PX };

function tagged(text: string, mark: WallMark): string {
  return mark.tag ? `${mark.tag} · ${text}` : text;
}

export function renderWalls(slots: readonly BoxHandle[], walls: readonly Wall[], mitigated: readonly Wall[], settings: InstitutionalV2Settings, nowTs: number, barTs: number, snapToBar: (ts: number) => number, rowWidth: number, unit: string, minSize: number, priceNow: number, strongSize: number, bars: readonly (readonly [number, number])[] = [[priceNow, priceNow]], mark: WallMark = PLAIN_MARK): void {
  const RANK = { mitigated: 0, weak: 1, strong: 2 } as const;
  type Entry = { wall: Wall; grade: Grade; kind: keyof typeof RANK; endTs: number };
  const spent: Entry[] = settings.showMitigated
    ? mitigated.filter((wall) => wall.endTs !== null).map((wall) => ({ wall, grade: gradeWhileStanding(wall, wall.endTs as number), kind: "mitigated", endTs: wall.endTs as number }))
    : [];
  const live: Entry[] = topPerSide(
    walls
      .map((wall) => ({ wall, grade: gradeOf(wall, nowTs) }))
      .filter(({ wall, grade }) => isShownGrade(grade, settings) && staysOnChart(wall, minSize, bars.some(([low, high]) => barTouches(wall, rowWidth, low, high)), grade))
      .map(({ wall, grade }) => ({ wall, grade, kind: grade, endTs: barTs })),
    settings.levelsPerSide,
    rowWidth,
    priceNow,
    settings.levelsBy,
  ).sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.wall.current - b.wall.current || distanceToPrice(b.wall, rowWidth, priceNow) - distanceToPrice(a.wall, rowWidth, priceNow));
  const visible = [...spent, ...live].slice(-slots.length);
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const entry = visible[index];
    if (entry === undefined) {
      hide(slot);
      continue;
    }
    const { wall, grade, kind, endTs } = entry;
    const strong = kind === "strong";
    const color = wall.side === "bid" ? settings.bullishColor : settings.bearishColor;
    const { top, bottom } = wallPrices(wall, rowWidth);
    const at = kind === "mitigated" ? endTs : nowTs;
    slot.setLeftTop(snapToBar(wall.startTs), top);
    slot.setRightBottom(snapToBar(endTs), bottom);
    slot.setBorderColor(withAlpha(color, kind === "mitigated" ? MITIGATED_BORDER_ALPHA : strong ? STRONG_BORDER_ALPHA : WEAK_BORDER_ALPHA));
    slot.setBorderWidth(mark.borderPx);
    slot.setMinHeightPx(settings.bandThicknessPx);
    slot.setExtendRight(kind !== "mitigated");
    slot.setBackgroundColor(withAlpha(color, kind === "mitigated" ? MITIGATED_FILL_ALPHA : strong ? STRONG_FILL_ALPHA : WEAK_FILL_ALPHA));
    slot.setText(tagged(describeWall(wall, grade, at, unit, strongSize), mark));
    slot.setTextFallbacks(shortenWall(wall, grade, at, unit, strongSize).map((text) => tagged(text, mark)));
    slot.setTextColor(CARD_TEXT);
    slot.setTextBackground(strong ? CARD_FILL : kind === "mitigated" ? MITIGATED_CARD_FILL : WEAK_CARD_FILL);
    slot.setTextAccent(withAlpha(color, kind === "mitigated" ? MITIGATED_ACCENT_ALPHA : strong ? ACCENT_ALPHA.strong : WEAK_ACCENT_ALPHA));
    slot.setTailFade(kind !== "mitigated");
  }
}
