import { formatLiquiditySize } from "../passive-liquidity/liquiditySettings";
import type { AbsorptionPrint } from "./absorptionEngine";
import type { MergedSphere } from "./absorptionMerge";

export interface AbsorptionHover {
  side: "bid" | "ask";
  title: string;
  headline: string;
  wallLine: string;
  whenLine: string;
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}

function amount(size: number, unit: string): string {
  const text = formatLiquiditySize(size) || "0";
  return unit ? `${text} ${unit}` : text;
}

export function describeAbsorptionSphere(sphere: MergedSphere, rowWidth: number, unit: string): AbsorptionHover {
  if (sphere.count === 1) return describeAbsorptionPrint(sphere.prints[0], rowWidth, unit);
  const attackers = sphere.side === "bid" ? "Sellers" : "Buyers";
  const walls = sphere.side === "bid" ? "bid walls" : "ask walls";
  const bands = new Set(sphere.prints.map((print) => print.band)).size;
  const title = sphere.pending ? `${attackers} hitting · ${bands} ${walls}` : `${attackers} absorbed · ${bands} ${walls}${sphere.broken ? " · broke later" : ""}`;
  const share = Math.round((sphere.absorbed / sphere.resting) * 100);
  const headline = `${amount(sphere.absorbed, unit)} absorbed of ${amount(sphere.resting, unit)} resting (${share}%) over ${sphere.count} spheres${sphere.pending ? " · holding" : ""}`;
  const digits = Math.min(4, (String(rowWidth).split(".")[1] ?? "").length);
  const refills = sphere.prints.reduce((total, print) => total + print.refills, 0);
  const wallLine = `walls ${sphere.lowPrice.toFixed(digits)}–${sphere.highPrice.toFixed(digits)} · ${refills === 0 ? "no refill" : `refilled ${refills}×`}`;
  const first = sphere.prints[0];
  const last = sphere.prints[sphere.prints.length - 1];
  const whenLine = `${clock(first.ts)} to ${clock(last.ts)} UTC · one candle`;
  return { side: sphere.side, title, headline, wallLine, whenLine };
}

export function describeAbsorptionPrint(print: AbsorptionPrint, rowWidth: number, unit: string): AbsorptionHover {
  const attackers = print.side === "bid" ? "Sellers" : "Buyers";
  const wall = print.side === "bid" ? "bid wall" : "ask wall";
  const pending = print.held === null;
  const title = pending ? `${attackers} hitting · ${wall}` : `${attackers} absorbed · ${wall}${print.broken ? " · broke later" : ""}`;
  const share = Math.round((print.absorbed / print.resting) * 100);
  const wallSize = print.shown < print.resting ? `${amount(print.resting, unit)} wall (${amount(print.shown, unit)} shown)` : `${amount(print.resting, unit)} resting`;
  const headline = `${amount(print.absorbed, unit)} absorbed of ${wallSize} (${share}%)${pending ? " · holding" : ""}`;
  const digits = Math.min(4, (String(rowWidth).split(".")[1] ?? "").length);
  const lo = (print.band * print.rows * rowWidth).toFixed(digits);
  const hi = ((print.band * print.rows + print.rows) * rowWidth).toFixed(digits);
  const refills = print.refills === 0 ? "no refill" : `refilled ${print.refills}×`;
  const wallLine = `wall ${lo}–${hi} · holding ${amount(print.current, unit)} at the sphere · ${refills}`;
  const shareWords = print.share === 0.25 ? "a quarter of" : print.share === 0.6 ? "sixty percent of" : print.share === 2 ? "twice" : print.share >= 1 ? `${print.share}×` : `${Math.round(print.share * 100)}% of`;
  const whenLine = `${clock(print.ts)} UTC · ${shareWords} the wall`;
  return { side: print.side, title, headline, wallLine, whenLine };
}
