import type { AbsorptionPrint } from "./absorptionEngine";

export const PENDING_ALPHA = 0.4;
export const BASE_ALPHA = 0.55;
export const REFILL_ALPHA_STEP = 0.1;
export const SECOND_SPHERE_ALPHA = 0.15;

export function printAlpha(print: Pick<AbsorptionPrint, "held" | "refills" | "strong">): number {
  if (print.held === null) return PENDING_ALPHA;
  return Math.min(1, BASE_ALPHA + REFILL_ALPHA_STEP * print.refills + (print.strong ? SECOND_SPHERE_ALPHA : 0));
}

export interface MergedSphere {
  key: string;
  side: "bid" | "ask";

  ts: number;
  price: number;
  lowPrice: number;
  highPrice: number;
  absorbed: number;
  resting: number;
  yardstick: number;
  count: number;
  pending: boolean;
  broken: boolean;

  prints: AbsorptionPrint[];
}

export function sphereKey(side: "bid" | "ask", ts: number, held: boolean): string {
  return `${side}:${ts}:${held ? "held" : "pending"}`;
}

export function mergePrints(prints: readonly AbsorptionPrint[], intervalMs: number, bucketOf?: (ts: number) => number | null): MergedSphere[] {
  const byKey = new Map<string, MergedSphere>();
  const sorted = [...prints].sort((a, b) => a.ts - b.ts || a.share - b.share || a.band - b.band);
  for (const print of sorted) {
    const held = print.held === true;
    const ts = bucketOf === undefined ? intervalMs > 0 ? Math.floor(print.ts / intervalMs) * intervalMs : print.ts : bucketOf(print.ts);
    if (ts === null) continue;
    const key = intervalMs > 0 ? sphereKey(print.side, ts, held) : `${print.side}:${print.ts}:${print.band}:${print.rows}:${print.share}:${held ? "held" : "pending"}`;
    let sphere = byKey.get(key);
    if (sphere === undefined) {
      sphere = { key, side: print.side, ts, price: print.price, lowPrice: print.price, highPrice: print.price, absorbed: 0, resting: 0, yardstick: 0, count: 0, pending: !held, broken: true, prints: [] };
      byKey.set(key, sphere);
    }
    sphere.count += 1;
    sphere.lowPrice = Math.min(sphere.lowPrice, print.price);
    sphere.highPrice = Math.max(sphere.highPrice, print.price);
    sphere.broken = sphere.broken && print.broken;
    sphere.prints.push(print);
  }
  const spheres = [...byKey.values()];
  for (const sphere of spheres) {
    const attacks = new Map<string, AbsorptionPrint>();
    for (const print of sphere.prints) {
      const attackKey = `${print.band}:${print.rows}:${print.attackTs}`;
      const furthest = attacks.get(attackKey);
      if (furthest === undefined || print.absorbed > furthest.absorbed) attacks.set(attackKey, print);
    }
    const counted = [...attacks.values()];
    sphere.absorbed = counted.reduce((total, print) => total + print.absorbed, 0);
    sphere.resting = counted.reduce((total, print) => total + print.resting, 0);
    sphere.yardstick = counted.reduce((most, print) => Math.max(most, print.yardstick), 0);
    sphere.price = sphere.absorbed > 0 ? counted.reduce((total, print) => total + print.price * print.absorbed, 0) / sphere.absorbed : sphere.prints[0].price;
  }
  return spheres.sort((a, b) => a.ts - b.ts || (a.side === b.side ? 0 : a.side === "bid" ? -1 : 1) || Number(a.pending) - Number(b.pending));
}

/** The spheres whose wall still stands or ended some other way: the hollow ones, broken later, are left out. */
export function withoutBroken(prints: readonly AbsorptionPrint[]): AbsorptionPrint[] {
  return prints.filter((print) => !print.broken);
}

export function mergedAlpha(sphere: Pick<MergedSphere, "pending" | "prints">): number {
  if (sphere.pending) return PENDING_ALPHA;
  const darkest = sphere.prints.reduce((most, print) => Math.max(most, printAlpha(print)), 0);
  return Math.min(1, darkest + REFILL_ALPHA_STEP * (sphere.prints.length - 1));
}
