import type { LiveRangeRead, PriceImpact, SideImpact } from "./liveRangeReader";
import type { PrintRead } from "./liveRangePrints";
import { VERDICT_Z_FROM, type LiveRangeMode, type RowKey } from "./liveRangeSettings";
import { windowBounds, type LiveRangeWindow, type WindowBounds } from "./liveRangeWindow";

export type Tone = "buyers" | "sellers" | "even";

export interface RangeRow {
  key: RowKey;
  label: string;
  left: string;
  right: string;
  counts?: { left: string; right: string };
  joined?: { text: string; tone: Tone };
}

export type VerdictKey = "buyers" | "sellers" | "balanced" | "few" | "unseen";

export interface Verdict {
  key: VerdictKey;
  text: string;
  z: number | null;
}

export const IMPACT_EVEN_RATIO = 1.25;
export const VERDICT_TEXT: Readonly<Record<VerdictKey, string>> = Object.freeze({ buyers: "Buyers in control", sellers: "Sellers in control", balanced: "Balanced", few: "Too few minutes", unseen: "Not enough data" });
export const VERDICT_MIN_MINUTES = 5;
export const VERDICT_HELD_FROM = 0.5;
export const MISSING_SAID_FROM = 0.1;
export const LEGEND_TEXT = "the candles on screen";
export const HEAD_TEXT: Readonly<Record<LiveRangeMode, string>> = Object.freeze({ visible: "on screen", selected: "selected zone", live: "live zone" });
export const WAITING_TEXT = "waiting for the candles on screen";
export const NO_TRADES_TEXT: Readonly<Record<"screen" | "zone", string>> = Object.freeze({ screen: "no trades on screen yet", zone: "no trades in the zone yet" });

const COUNT_WHOLE_BELOW = 10_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

function placeOf(mode: LiveRangeMode): "screen" | "zone" {
  return mode === "visible" ? "screen" : "zone";
}

function shortText(value: number, unit: string): string {
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${unit}`;
}

export function sizeText(size: number): string {
  if (!(size > 0)) return "0";
  const whole = Math.round(size);
  if (whole === 0) return "<1";
  if (whole < 1_000) return String(whole);
  if (Math.round(size / 1_000) < 1_000) return shortText(size / 1_000, "k");
  return shortText(size / 1_000_000, "M");
}

export function netText(net: number): string {
  const size = sizeText(Math.abs(net));
  if (size === "0") return "0";
  return `${net < 0 ? "−" : "+"}${size}`;
}

export function amountText(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function clock(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function dayClock(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${clock(date)}`;
}

export function spanText(fromTs: number, toTs: number): string {
  const span = toTs - fromTs;
  if (span < MINUTE_MS) return "<1 min";
  if (span < 2 * HOUR_MS) return `${Math.round(span / MINUTE_MS)} min`;
  if (span < 2 * DAY_MS) return `${Math.round(span / (HOUR_MS / 10)) / 10} h`;
  return `${Math.round(span / (DAY_MS / 10)) / 10} d`;
}

export function windowText(fromTs: number, toTs: number | null, nowMs: number): string {
  const from = new Date(fromTs);
  const fromText = sameDay(from, new Date(nowMs)) ? clock(from) : dayClock(from);
  if (toTs === null) return `since ${fromText} UTC`;
  const to = new Date(toTs);
  return `${fromText} → ${sameDay(to, from) ? clock(to) : dayClock(to)} UTC`;
}

export function windowLabel(originMs: number, window: LiveRangeWindow, nowMs: number): string {
  const bounds = windowBounds(originMs, window, nowMs);
  return `${windowText(bounds.fromMs, bounds.toMs, nowMs)} · ${spanText(bounds.fromMs, bounds.toMs ?? nowMs)}`;
}

export function spanLabel(fromTs: number, toTs: number): string {
  const from = new Date(fromTs);
  const to = new Date(toTs);
  const fromText = sameDay(from, to) ? clock(from) : dayClock(from);
  return `${fromText} → ${clock(to)} UTC · ${spanText(fromTs, toTs)}`;
}

export function sinceLabel(fromTs: number, toTs: number): string {
  return `${windowText(fromTs, null, toTs)} · ${spanText(fromTs, toTs)}`;
}

export function headText(mode: LiveRangeMode): string {
  return HEAD_TEXT[mode];
}

export function rangeLine(mode: LiveRangeMode, fromTs: number, toTs: number, live: boolean): string {
  return mode !== "visible" && live ? sinceLabel(fromTs, toTs) : spanLabel(fromTs, toTs);
}

export function legendText(mode: LiveRangeMode, bounds: WindowBounds, nowMs: number): string {
  return mode === "visible" ? LEGEND_TEXT : windowText(bounds.fromMs, bounds.toMs, nowMs);
}

export function minutesText(minutes: number): string {
  return `${minutes} min`;
}

export function pointsText(value: number): string {
  const size = Math.abs(value);
  if (size >= 1_000) return sizeText(size);
  if (size >= 10) return String(Math.round(size));
  return String(Math.round(size * 10) / 10);
}

function signedText(value: number): string {
  const text = pointsText(value);
  return text === "0" ? text : `${value < 0 ? "−" : "+"}${text}`;
}

export function impactText(side: SideImpact, who: "buyers" | "sellers"): string {
  if (!(side.volume > 0)) return "–";
  return signedText(who === "buyers" ? side.moved : -side.moved);
}

export function impactUnderText(side: SideImpact): string {
  if (!(side.volume > 0)) return "";
  const perThousand = (side.moved / side.volume) * 1_000;
  const text = pointsText(perThousand);
  return `(${text === "0" || perThousand > 0 ? text : `−${text}`}/k)`;
}

export interface ImpactTip {
  title: string;
  lines: string[];
  reading: string | null;
}

const SIDE_WORDS = Object.freeze({
  buyers: { name: "Buyers", who: "buyers", did: "bought", toward: "up", away: "down", absorbed: "Buyers were absorbed: their buying did not lift price" },
  sellers: { name: "Sellers", who: "sellers", did: "sold", toward: "down", away: "up", absorbed: "Sellers were absorbed: their selling did not drop price" },
});

function ratioText(ratio: number): string {
  return `${Math.round(ratio * 10) / 10}×`;
}

function impactReading(impact: PriceImpact, side: "buyers" | "sellers"): string {
  const own = impact[side];
  const other = side === "buyers" ? impact.sellers : impact.buyers;
  const words = SIDE_WORDS[side];
  const otherWords = SIDE_WORDS[side === "buyers" ? "sellers" : "buyers"];
  if (pointsText(own.moved) === "0") return `${words.name} did not move price`;
  if (own.moved < 0) return words.absorbed;
  if (other.moved < 0 || pointsText(other.moved) === "0") return `Only ${words.who} moved price their way`;
  const mine = own.moved / own.volume;
  const theirs = other.moved / other.volume;
  if (mine >= theirs * IMPACT_EVEN_RATIO) return `${words.name} moved price ${ratioText(mine / theirs)} more per unit than ${otherWords.who}`;
  if (theirs >= mine * IMPACT_EVEN_RATIO) return `${words.name} needed ${ratioText(theirs / mine)} more size than ${otherWords.who} to move price`;
  return "Buyers and sellers moved price about the same per unit";
}

export function impactTip(impact: PriceImpact, side: "buyers" | "sellers", unit: string): ImpactTip {
  const own = impact[side];
  const words = SIDE_WORDS[side];
  const title = `${words.name} · price impact`;
  if (!(own.volume > 0)) return { title, lines: [`No minute won by ${words.who} to measure yet`], reading: null };
  const units = unit === "" ? "" : ` ${unit}`;
  const moved = pointsText(own.moved);
  const way = own.moved < 0 ? words.away : words.toward;
  const size = `while ${words.who} ${words.did} ${sizeText(own.volume)}${units}`;
  if (moved === "0") return { title, lines: [`Price did not move in the minutes ${words.who} won`, size], reading: impactReading(impact, side) };
  const perThousand = pointsText((own.moved / own.volume) * 1_000);
  return {
    title,
    lines: [`Price went ${way} ${moved} points in the minutes ${words.who} won`, size, `${perThousand} points ${way} for every 1,000${units} ${words.did}`],
    reading: impactReading(impact, side),
  };
}

export function printText(prints: PrintRead | null, side: "buy" | "sell"): string {
  if (prints === null) return "–";
  return sizeText(side === "buy" ? prints.buys : prints.sells);
}

export function printCountText(prints: PrintRead, side: "buy" | "sell"): string {
  const count = side === "buy" ? prints.buyCount : prints.sellCount;
  return `(${count < COUNT_WHOLE_BELOW ? String(count) : sizeText(count)})`;
}

export function zOf(read: Pick<LiveRangeRead, "buys" | "sells" | "noise">): number {
  return read.noise > 0 ? (read.buys - read.sells) / read.noise : 0;
}

export function zText(z: number): string {
  const rounded = Math.round(Math.abs(z) * 10) / 10;
  return `z ${z < 0 && rounded > 0 ? "−" : "+"}${rounded.toFixed(1)}`;
}

export function toneOf(net: number): Tone {
  if (sizeText(Math.abs(net)) === "0") return "even";
  return net > 0 ? "buyers" : "sellers";
}

export function rangeRows(read: LiveRangeRead, prints: PrintRead | null = null): RangeRow[] {
  const net = read.buys - read.sells;
  return [
    { key: "volume", label: "Traded volume", left: sizeText(read.buys), right: sizeText(read.sells) },
    { key: "delta", label: "Delta", left: "", right: "", joined: { text: netText(net), tone: toneOf(net) } },
    {
      key: "prints",
      label: "Big prints",
      left: printText(prints, "buy"),
      right: printText(prints, "sell"),
      counts: prints === null ? undefined : { left: printCountText(prints, "buy"), right: printCountText(prints, "sell") },
    },
    { key: "minutes", label: "Minutes won", left: minutesText(read.minutesWon.buyers), right: minutesText(read.minutesWon.sellers) },
    {
      key: "impact",
      label: "Price impact",
      left: impactText(read.impact.buyers, "buyers"),
      right: impactText(read.impact.sellers, "sellers"),
      counts: { left: impactUnderText(read.impact.buyers), right: impactUnderText(read.impact.sellers) },
    },
  ];
}

export function missingMsOf(read: Pick<LiveRangeRead, "missing">): number {
  let ms = 0;
  for (const [start, end] of read.missing) ms += end - start;
  return ms;
}

export function missingShareOf(read: Pick<LiveRangeRead, "tradedMs" | "missing">): number {
  return read.tradedMs > 0 ? missingMsOf(read) / read.tradedMs : 0;
}

function stretchText(fromTs: number, toTs: number): string {
  const from = new Date(fromTs);
  const to = new Date(toTs);
  return sameDay(from, to) ? `${clock(from)}–${clock(to)} UTC` : `${dayClock(from)}–${dayClock(to)} UTC`;
}

export function missingText(read: Pick<LiveRangeRead, "tradedMs" | "missing">): string | null {
  const share = missingShareOf(read);
  if (!(share >= MISSING_SAID_FROM)) return null;
  const part = `${Math.round(share * 100)} % of the range`;
  if (read.missing.length === 1) return `No data for ${stretchText(read.missing[0][0], read.missing[0][1])} · ${part}`;
  return `No data for ${spanText(0, missingMsOf(read))} in ${read.missing.length} stretches · ${part}`;
}

export function verdictOf(read: LiveRangeRead | null, zFrom: number = VERDICT_Z_FROM.normal): Verdict | null {
  if (read === null) return null;
  if (missingShareOf(read) >= VERDICT_HELD_FROM) return { key: "unseen", text: VERDICT_TEXT.unseen, z: null };
  if (!(read.coveredMs > 0) || !(read.buys + read.sells > 0)) return null;
  if (read.minutesWon.buyers + read.minutesWon.sellers < VERDICT_MIN_MINUTES) return { key: "few", text: VERDICT_TEXT.few, z: null };
  const z = zOf(read);
  const key: VerdictKey = z > 0 && z >= zFrom ? "buyers" : z < 0 && z <= -zFrom ? "sellers" : "balanced";
  return { key, text: VERDICT_TEXT[key], z };
}

export function rangeNote(read: LiveRangeRead | null, mode: LiveRangeMode = "visible", loading = false): string | null {
  if (loading) return null;
  if (read === null) return WAITING_TEXT;
  const missing = missingText(read);
  if (missing !== null) return missing;
  if (!(read.coveredMs > 0)) return NO_TRADES_TEXT[placeOf(mode)];
  return null;
}
