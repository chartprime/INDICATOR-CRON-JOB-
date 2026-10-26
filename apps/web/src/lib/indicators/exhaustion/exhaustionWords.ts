import type { ExhaustionRaw, ExhaustionReadings, ExhaustionSide } from "../../../types/frames";
import { formatLiquiditySize, formatWholeSize } from "../passive-liquidity/liquiditySettings";

export const NONE = "—";
const MINUS = "−";

export interface ExhaustionValueText {
  main: string;
  sub: string;
}

const BOOK_BANDS: Readonly<Record<ExhaustionSide, readonly [string, string, string]>> = Object.freeze({
  buyers: ["Asks", "Deeper asks", "Bids below"],
  sellers: ["Bids", "Deeper bids", "Asks above"],
});

export function exhaustionLabels(side: ExhaustionSide): Record<keyof ExhaustionReadings, string> {
  const extreme = side === "buyers" ? "the high" : "the low";
  return {
    rate: side === "buyers" ? "Buying volume" : "Selling volume",
    progress: "Price moved",
    delta: "Delta",
    divergence: `Vs ${extreme}`,
    prints: side === "buyers" ? "Big buyers" : "Big sellers",
    book: `Book at ${extreme}`,
  };
}

export function volumeText(volume: number | null, unit: string): string {
  if (volume === null) return NONE;
  const whole = unit === "contracts" || unit === "shares";
  if (volume >= 999_500) return `${(volume / 1_000_000).toFixed(whole ? 1 : 2)}M`;
  if (volume >= 99_950) return `${Math.round(volume / 1000)}k`;
  const text = whole ? formatWholeSize(volume) : formatLiquiditySize(volume);
  return text === "" ? "0" : text;
}

export function priceText(move: number | null): string {
  if (move === null) return NONE;
  const abs = Math.abs(move);
  const text = abs.toFixed(Number(abs.toFixed(2)) >= 100 ? 0 : 2);
  return `${move < 0 && Number(text) !== 0 ? MINUS : ""}${text}`;
}

export function signedVolumeText(net: number | null, unit: string): string {
  if (net === null) return NONE;
  const text = volumeText(Math.abs(net), unit);
  if (Number(text) === 0) return text;
  return `${net < 0 ? MINUS : net > 0 ? "+" : ""}${text}`;
}

export function shareText(buys: number | null, sells: number | null): string {
  if (buys === null || sells === null || !(buys + sells > 0)) return "";
  const whole = Math.round(((buys - sells) / (buys + sells)) * 100);
  return ` (${whole > 0 ? "+" : whole < 0 ? MINUS : ""}${Math.abs(whole)}%)`;
}

export function countText(count: number | null): string {
  if (count === null) return NONE;
  return Number.isInteger(count) ? String(count) : count.toFixed(1);
}

export function exhaustionValueTexts(side: ExhaustionSide, raw: ExhaustionRaw, unit: string): Record<keyof ExhaustionReadings, ExhaustionValueText> {
  const extreme = side === "buyers" ? "High" : "Low";
  const buys = side === "buyers" ? raw.own : raw.other;
  const sells = side === "buyers" ? raw.other : raw.own;
  const net = buys === null || sells === null ? null : buys - sells;
  const extremeBuys = side === "buyers" ? raw.extremeOwn : raw.extremeOther;
  const extremeSells = side === "buyers" ? raw.extremeOther : raw.extremeOwn;
  const extremeNet = extremeBuys === null || extremeSells === null ? null : extremeBuys - extremeSells;
  const pushed = volumeText(raw.own, unit);
  const legPushed = volumeText(raw.legOwn, unit);
  const book = raw.bookBand === null ? "Now" : BOOK_BANDS[side][raw.bookBand];
  return {
    rate: { main: raw.own !== null && unit !== "" ? `${pushed} ${unit}` : pushed, sub: `Leg: ${legPushed}` },
    progress: { main: `Now: ${priceText(raw.moved)} / ${pushed}`, sub: `Leg: ${priceText(raw.legMoved)} / ${legPushed}` },
    delta: { main: `Buys: ${volumeText(buys, unit)}`, sub: `Sells: ${volumeText(sells, unit)}` },
    divergence: { main: `Now: ${signedVolumeText(net, unit)}${shareText(buys, sells)}`, sub: `${extreme}: ${signedVolumeText(extremeNet, unit)}${shareText(extremeBuys, extremeSells)}` },
    prints: { main: `Now: ${countText(raw.big)}`, sub: `Leg: ${countText(raw.legBig)}` },
    book: { main: `${book}: ${volumeText(raw.bookNow, unit)}`, sub: `${extreme}: ${volumeText(raw.bookAt, unit)}` },
  };
}
