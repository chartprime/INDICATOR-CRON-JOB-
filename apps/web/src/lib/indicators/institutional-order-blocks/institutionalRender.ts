import type { BoxHandle } from "../../chart/draw/box";
import { CARD_FILL, CARD_TEXT, MITIGATED_FILL_ALPHA, withAlpha } from "../classic-order-blocks/orderBlockRender";
import { formatLiquiditySize } from "../passive-liquidity/liquiditySettings";
import type { UnverifiableReason } from "./bookEvidence";
import { isShownVerdict, type InstitutionalSettings, type Verdict } from "./institutionalRules";
import type { InstitutionalBlock } from "./institutionalTracker";

export const STRONG_FILL_ALPHA = 0.55;
export const WEAK_FILL_ALPHA = 0.32;
export const REJECTED_FILL_ALPHA = 0.14;
export const STRONG_BORDER_ALPHA = 1;
export const WEAK_BORDER_ALPHA = 0.7;
export const REJECTED_BORDER_ALPHA = 0.45;
export const UNVERIFIABLE_BORDER_ALPHA = 0.45;
export { CARD_FILL, CARD_TEXT };
export const MITIGATED_CARD_FILL = "rgba(15, 23, 42, 0.55)";
export const ACCENT_ALPHA: Record<Verdict, number> = { strong: 1, weak: 0.8, rejected: 0.55, unverifiable: 0.55 };
export const MITIGATED_ACCENT_ALPHA = 0.4;
export const NO_CARD = "transparent";
export const ZONE_TEXT = "#1e293b";
export const ZONE_TEXT_ON_DARK = "#f1f5f9";

const GRADE: Record<Verdict, string> = { strong: "Strong", weak: "Weak", rejected: "Rejected", unverifiable: "Unverified" };

const WAITING: Record<UnverifiableReason, string> = {
  feed: "no book",
  before: "book not reached",
  older: "older than the recording",
  after: "book still printing",
  hole: "no book recorded",
  rows: "zone thinner than a row",
  gap: "book missing in its window",
};

export function isShownInstitutional(entry: InstitutionalBlock, settings: InstitutionalSettings): boolean {
  if (entry.block.tier === "secondary" && !settings.showSecondary) return false;
  if (entry.block.mitigatedTime !== null && !settings.showMitigated) return false;
  return isShownVerdict(entry.verdict, settings);
}

function amount(size: number, unit: string): string {
  const text = formatLiquiditySize(size) || "0";
  return unit ? `${text} ${unit}` : text;
}

function signed(ratio: number): string {
  const percent = Math.round(ratio * 100);
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function wording(parts: readonly string[]): string {
  return parts.join(" · ");
}

export function describeBlock(entry: InstitutionalBlock, unit: string): string {
  return wording(facts(entry, unit));
}

export function shortenBlock(entry: InstitutionalBlock, unit: string): string[] {
  const parts = facts(entry, unit);
  const forms: string[] = [];
  for (let keep = parts.length - 1; keep >= 1; keep -= 1) forms.push(wording(parts.slice(0, keep)));
  return forms;
}

function facts(entry: InstitutionalBlock, unit: string): string[] {
  const title = `${GRADE[entry.verdict]} OB`;
  const evidence = entry.evidence;
  if (evidence === null) {
    const why = entry.reason === "gap" && entry.gap !== null ? `recording gap ${clock(entry.gap.from)}–${clock(entry.gap.to)} UTC` : WAITING[entry.reason ?? "feed"];
    return [title, why];
  }
  if (!evidence.held) return [title, "no wall stood here", `${signed(evidence.delta)} Delta`];
  const was = amount(evidence.peak, unit);
  const wall = evidence.standing ? amount(evidence.current, unit) : entry.verdict === "rejected" ? `wall pulled (was ${was})` : `wall gone (was ${was})`;
  return [title, wall, `Traded ${amount(evidence.hit, unit)}`, `${signed(evidence.delta)} Delta`];
}

function styleOf(verdict: Verdict, mitigated: boolean, color: string): { border: string; fill: string } {
  if (mitigated) return { border: "transparent", fill: withAlpha(color, MITIGATED_FILL_ALPHA) };
  switch (verdict) {
    case "strong":
      return { border: withAlpha(color, STRONG_BORDER_ALPHA), fill: withAlpha(color, STRONG_FILL_ALPHA) };
    case "weak":
      return { border: withAlpha(color, WEAK_BORDER_ALPHA), fill: withAlpha(color, WEAK_FILL_ALPHA) };
    case "rejected":
      return { border: withAlpha(color, REJECTED_BORDER_ALPHA), fill: withAlpha(color, REJECTED_FILL_ALPHA) };
    default:
      return { border: withAlpha(color, UNVERIFIABLE_BORDER_ALPHA), fill: "transparent" };
  }
}

function hide(slot: BoxHandle): void {
  slot.setLeftTop(0, 0);
  slot.setRightBottom(0, 0);
  slot.setBorderColor("transparent");
  slot.setBackgroundColor("transparent");
  slot.setText("");
  slot.setTextBackground("");
  slot.setExtendRight(false);
}

const PAINT_RANK: Record<Verdict, number> = { unverifiable: 1, rejected: 2, weak: 3, strong: 4 };

function paintRank(entry: InstitutionalBlock): number {
  return entry.block.mitigatedTime === null ? PAINT_RANK[entry.verdict] : 0;
}

function olderInFront(entry: InstitutionalBlock): boolean {
  return paintRank(entry) === PAINT_RANK.unverifiable;
}

function nested(a: InstitutionalBlock, b: InstitutionalBlock): boolean {
  return (a.block.top >= b.block.top && a.block.bottom <= b.block.bottom) || (b.block.top >= a.block.top && b.block.bottom <= a.block.bottom);
}

function eclipsed(entry: InstitutionalBlock, index: number, shown: readonly InstitutionalBlock[]): boolean {
  return shown.some((other, otherIndex) => {
    if (otherIndex === index || !nested(entry, other)) return false;
    const rank = paintRank(other) - paintRank(entry);
    return rank > 0 || (rank === 0 && (olderInFront(entry) ? otherIndex < index : otherIndex > index));
  });
}

export function renderInstitutionalBlocks(slots: readonly BoxHandle[], entries: readonly InstitutionalBlock[], settings: InstitutionalSettings, currentTime: number, unit: string): void {
  const shown = entries.filter((entry) => isShownInstitutional(entry, settings)).slice(-slots.length);
  const visible = shown
    .filter((entry, index) => !eclipsed(entry, index, shown))
    .sort((a, b) => paintRank(a) - paintRank(b) || (olderInFront(a) ? shown.indexOf(b) - shown.indexOf(a) : 0));
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const entry = visible[index];
    if (entry === undefined) {
      hide(slot);
      continue;
    }
    const { block } = entry;
    const color = block.side === "bullish" ? settings.bullishColor : settings.bearishColor;
    const mitigated = block.mitigatedTime !== null;
    const style = styleOf(entry.verdict, mitigated, color);
    slot.setLeftTop(block.baseTime, block.top);
    slot.setRightBottom(block.mitigatedTime ?? currentTime, block.bottom);
    slot.setBorderColor(style.border);
    slot.setBackgroundColor(style.fill);
    slot.setText(describeBlock(entry, unit));
    slot.setTextFallbacks(shortenBlock(entry, unit));
    slot.setTextColor(ZONE_TEXT);
    slot.setTextBackground(NO_CARD);
    slot.setTextAccent("");
    slot.setTailFade(!mitigated);
    slot.setExtendRight(!mitigated);
  }
}
