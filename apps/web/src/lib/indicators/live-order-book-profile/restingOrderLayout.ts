import type { LiquiditySide } from "../passive-liquidity/liquidityGrid";
import { clusterIndex } from "../passive-liquidity/liquiditySettings";
import type { RestingOrder } from "./restingOrders";

export const RESTING_GROW_MS = 300;
export const RESTING_FADE_MS = 2_000;
export const RESTING_MIN_HEIGHT_PX = 8;
export const RESTING_SHOWN_MAX = 6;
export const RESTING_FLASH_MS = 300;
export const RESTING_APPEAR_MS = 1_000;
export const RESTING_FLASH_LIFT = 0.6;

export interface RestingShown {
  order: RestingOrder;
  seenAt: number;
  endedAt: number | null;
  drawn: number;
}

export interface RestingBar {
  key: string;
  side: LiquiditySide;
  size: number;
  share: number;
  flash: number;
  yTop: number;
  yBottom: number;
  alpha: number;
}

type YOf = (price: number) => number | null;
type SizeOf = (side: LiquiditySide, band: number) => number;

export function reconcileResting(shown: Map<string, RestingShown>, resting: readonly RestingOrder[], now: number, fadeMs: number = RESTING_FADE_MS): void {
  const standing = new Set<string>();
  for (const order of resting) {
    standing.add(order.key);
    const entry = shown.get(order.key);
    if (entry === undefined || entry.order.since !== order.since) shown.set(order.key, { order, seenAt: now, endedAt: null, drawn: 0 });
    else entry.order = order;
  }
  for (const [key, entry] of shown) {
    if (standing.has(key)) continue;
    if (entry.endedAt === null) entry.endedAt = now;
    else if (now - entry.endedAt >= fadeMs) shown.delete(key);
  }
}

function grown(entry: RestingShown, at: number): number {
  return Math.min(1, Math.max(0, (at - entry.seenAt) / RESTING_GROW_MS));
}

export function restingAlpha(entry: RestingShown, now: number, fadeMs: number = RESTING_FADE_MS): number {
  if (entry.endedAt === null) return grown(entry, now);
  return grown(entry, entry.endedAt) * Math.max(0, 1 - (now - entry.endedAt) / fadeMs);
}

export function restingFlash(entry: RestingShown, now: number): number {
  if (entry.endedAt === null) return Math.max(0, 1 - (now - entry.seenAt) / RESTING_APPEAR_MS);
  return Math.max(0, 1 - (now - entry.endedAt) / RESTING_FLASH_MS);
}

export function restingFill(color: string, flash: number, alpha: number): string {
  const value = Number.parseInt(color.slice(1), 16);
  const lift = flash * RESTING_FLASH_LIFT;
  const channel = (shift: number) => Math.round(((value >> shift) & 255) * (1 - lift) + 255 * lift);
  return `rgba(${channel(16)}, ${channel(8)}, ${channel(0)}, ${alpha})`;
}

export function restingUntil(shown: ReadonlyMap<string, RestingShown>, fadeMs: number = RESTING_FADE_MS): number {
  let until = 0;
  for (const entry of shown.values()) until = Math.max(until, entry.endedAt === null ? entry.seenAt + RESTING_APPEAR_MS : entry.endedAt + fadeMs);
  return until;
}

interface Band {
  side: LiquiditySide;
  band: number;
  alpha: number;
  flash: number;
  size: number;
  drawn: number;
  live: boolean;
  standing: boolean;
  members: RestingShown[];
}

export function layoutResting(shown: Map<string, RestingShown>, rowWidth: number, clusterRows: number, sizeOf: SizeOf, yOf: YOf, height: number, now: number, maxShown: number = RESTING_SHOWN_MAX, fadeMs: number = RESTING_FADE_MS): RestingBar[] {
  const rows = Math.max(1, Math.floor(clusterRows));
  const bands = new Map<string, Band>();
  for (const entry of shown.values()) {
    const alpha = restingAlpha(entry, now, fadeMs);
    if (alpha <= 0) continue;
    const { order } = entry;
    const flash = restingFlash(entry, now);
    const band = clusterIndex(order.row, rows);
    const key = `${order.side}:${band}`;
    const held = bands.get(key);
    const live = entry.endedAt === null;
    const standing = live && !order.ending;
    const size = live ? order.size : order.peak;
    if (held === undefined) bands.set(key, { side: order.side, band, alpha, flash, size, drawn: entry.drawn, live, standing, members: [entry] });
    else {
      held.alpha = Math.max(held.alpha, alpha);
      held.flash = Math.max(held.flash, flash);
      held.size += size;
      held.drawn = Math.max(held.drawn, entry.drawn);
      held.live ||= live;
      held.standing ||= standing;
      held.members.push(entry);
    }
  }
  const placed: { bar: RestingBar; held: Band }[] = [];
  for (const [key, held] of bands) {
    if (!held.standing && held.drawn <= 0) continue;
    const top = yOf((held.band + 1) * rows * rowWidth);
    const bottom = yOf(held.band * rows * rowWidth);
    if (top === null || bottom === null) continue;
    const grow = Math.max(0, RESTING_MIN_HEIGHT_PX - Math.abs(bottom - top)) / 2;
    const yTop = Math.min(top, bottom) - grow;
    const yBottom = Math.max(top, bottom) + grow;
    if (yBottom < 0 || yTop > height) continue;
    const size = held.standing ? sizeOf(held.side, held.band) || held.size : held.drawn;
    placed.push({ bar: { key, side: held.side, size, share: 0, flash: held.flash, yTop, yBottom, alpha: held.alpha }, held });
  }
  placed.sort((a, b) => b.bar.size - a.bar.size);
  let live = 0;
  const kept = placed.filter(({ held }) => !held.standing || live++ < maxShown);
  const biggest = kept[0]?.bar.size ?? 0;
  for (const { bar, held } of kept) {
    bar.share = biggest > 0 ? bar.size / biggest : 0;
    for (const entry of held.members) entry.drawn = bar.size;
  }
  return kept.map(({ bar }) => bar);
}
