import type { IcebergOrder } from "../../../types/frames";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../passive-liquidity/liquiditySettings";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export type IcebergHistoryDays = 0 | 1 | 3 | 5;

export type IcebergMarkShape = "dot" | "triangle" | "circle";

export const ICEBERG_MARK_SHAPES: readonly (readonly [IcebergMarkShape, string])[] = Object.freeze([["dot", "Dot"], ["triangle", "Triangle"], ["circle", "Circle"]]);

export type IcebergPlacement = "price" | "candle";

export const ICEBERG_PLACEMENTS: readonly (readonly [IcebergPlacement, string])[] = Object.freeze([["price", "Where it appeared"], ["candle", "Candle high / low"]]);

export const ICEBERG_HISTORY_OPTIONS: readonly (readonly [IcebergHistoryDays, string])[] = Object.freeze([[0, "Off"], [1, "1 day"], [3, "3 days"], [5, "5 days"]]);

export interface IcebergSettings {
  historyDays?: number;
  showPulled?: boolean;
  labels?: boolean;
  bidColor?: string;
  askColor?: string;
  markScale?: number;
  sizeTopPercent?: number;
  markShape?: string;
  placement?: string;
  minTranches?: number;
  revision?: number;
}

export const DEFAULT_ICEBERG_HISTORY_DAYS: IcebergHistoryDays = 0;
export const ICEBERG_SETTINGS_REVISION = 2;

export const DEFAULT_ICEBERG_SETTINGS: IcebergSettings = {
  historyDays: DEFAULT_ICEBERG_HISTORY_DAYS,
  showPulled: true,
  labels: true,
  bidColor: DEFAULT_LIQUIDITY_SETTINGS.bidColor,
  askColor: DEFAULT_LIQUIDITY_SETTINGS.askColor,
  markScale: 1,
  sizeTopPercent: 20,
  markShape: "auto",
  placement: "price",
  minTranches: 2,
  revision: ICEBERG_SETTINGS_REVISION,
};

export const ICEBERG_MIN_TRANCHES = 1;
export const ICEBERG_MAX_TRANCHES = 10;
export const DEFAULT_ICEBERG_MIN_TRANCHES = 2;
export const ICEBERG_CANDLE_PICK_MS = 3_600_000;

export const ICEBERG_SETTINGS_SCHEMA: readonly SettingsFieldSchema<IcebergSettings>[] = [
  { kind: "select", key: "historyDays", label: "History", options: ICEBERG_HISTORY_OPTIONS.map(([value, label]) => ({ value, label })), affects: "recompute" },
  { kind: "slider", key: "sizeTopPercent", label: "Size: biggest share", min: 1, max: 100, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "slider", key: "minTranches", label: "Refills", min: ICEBERG_MIN_TRANCHES, max: ICEBERG_MAX_TRANCHES, step: 1, clampOnRestore: true, affects: "recompute" },
  { kind: "boolean", key: "showPulled", label: "Show pulled icebergs", affects: "cosmetic" },
  { kind: "boolean", key: "labels", label: "Labels", affects: "cosmetic" },
  { kind: "select", key: "placement", label: "Mark placement", options: ICEBERG_PLACEMENTS.map(([value, label]) => ({ value, label })), affects: "cosmetic" },
  { kind: "select", key: "markShape", label: "Mark shape", options: [{ value: "auto", label: "Auto" }, ...ICEBERG_MARK_SHAPES.map(([value, label]) => ({ value, label }))], affects: "cosmetic" },
  { kind: "color", key: "bidColor", label: "Bid icebergs", affects: "cosmetic" },
  { kind: "color", key: "askColor", label: "Ask icebergs", affects: "cosmetic" },
  { kind: "slider", key: "markScale", label: "Mark size", min: 0.5, max: 2.5, step: 0.1, clampOnRestore: true, affects: "cosmetic" },
];

export function icebergMinTranchesOf(settings: Pick<IcebergSettings, "minTranches"> | undefined): number {
  const raw = settings?.minTranches;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_ICEBERG_MIN_TRANCHES;
  return Math.min(ICEBERG_MAX_TRANCHES, Math.max(ICEBERG_MIN_TRANCHES, Math.floor(raw)));
}

export const DAY_MS = 86_400_000;

export function icebergHistoryDaysOf(settings: Pick<IcebergSettings, "historyDays"> | undefined): IcebergHistoryDays {
  const days = settings?.historyDays;
  return ICEBERG_HISTORY_OPTIONS.some(([known]) => known === days) ? (days as IcebergHistoryDays) : DEFAULT_ICEBERG_HISTORY_DAYS;
}

export function icebergColorOf(settings: IcebergSettings | undefined, side: "bid" | "ask"): string {
  const chosen = side === "bid" ? settings?.bidColor : settings?.askColor;
  if (typeof chosen === "string" && chosen.length > 0) return chosen;
  return side === "bid" ? DEFAULT_LIQUIDITY_SETTINGS.bidColor : DEFAULT_LIQUIDITY_SETTINGS.askColor;
}

export function icebergMarkScaleOf(settings: IcebergSettings | undefined): number {
  const scale = settings?.markScale;
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? Math.min(3, scale) : 1;
}

export function icebergShapeOf(settings: Pick<IcebergSettings, "markShape"> | undefined, kind: IcebergOrder["kind"]): IcebergMarkShape {
  const chosen = ICEBERG_MARK_SHAPES.find(([shape]) => shape === settings?.markShape);
  if (chosen !== undefined) return chosen[0];
  return kind === "native" ? "dot" : "circle";
}

export function icebergPlacementOf(settings: Pick<IcebergSettings, "placement"> | undefined): IcebergPlacement {
  return settings?.placement === "candle" ? "candle" : "price";
}

export function icebergSizeTopPercentOf(settings: Pick<IcebergSettings, "sizeTopPercent"> | undefined): number {
  const top = settings?.sizeTopPercent;
  return typeof top === "number" && Number.isFinite(top) ? Math.min(100, Math.max(1, Math.round(top))) : 100;
}

export interface IcebergTotal {
  total: number;
  perOrder: number;
  orders: number;
}

export function icebergTotalOf(iceberg: Pick<IcebergOrder, "kind" | "display" | "tranches" | "executed">): IcebergTotal {
  const perOrder = iceberg.display;
  const counted = iceberg.kind === "native" ? Math.max(1, iceberg.tranches) : 1;
  if (!(perOrder > 0)) return { total: Math.max(0, iceberg.executed), perOrder: 0, orders: counted };
  const orders = Math.max(counted, Math.ceil(iceberg.executed / perOrder - 1e-9));
  return { total: perOrder * orders, perOrder, orders };
}

export function shownIcebergs(list: readonly IcebergOrder[], settings: IcebergSettings | undefined, now: number, liveSince: number | null = null): IcebergOrder[] {
  const days = icebergHistoryDaysOf(settings);
  const from = days === 0 ? null : now - days * DAY_MS;
  const showPulled = settings?.showPulled === true;
  const minTranches = icebergMinTranchesOf(settings);
  const out: IcebergOrder[] = [];
  for (const iceberg of list) {
    if (icebergTotalOf(iceberg).orders < minTranches) continue;
    if (iceberg.status === "pulled" && !showPulled) continue;
    if (iceberg.status === "active") {
      out.push(iceberg);
      continue;
    }
    if (from === null ? !inLiveWindow(iceberg, liveSince) : iceberg.markedAt < from) continue;
    out.push(iceberg);
  }
  const top = icebergSizeTopPercentOf(settings);
  if (top >= 100 || out.length === 0) return out;
  const live = out.filter((iceberg) => inLiveWindow(iceberg, liveSince));
  const older = out.filter((iceberg) => !inLiveWindow(iceberg, liveSince));
  const kept = new Set([...biggestShare(live, top), ...biggestShare(older, top)]);
  return out.filter((iceberg) => kept.has(iceberg));
}

function inLiveWindow(iceberg: IcebergOrder, liveSince: number | null): boolean {
  if (iceberg.status === "active") return true;
  return iceberg.origin === "runtime" && liveSince !== null && iceberg.markedAt >= liveSince;
}

function biggestShare(list: readonly IcebergOrder[], top: number): IcebergOrder[] {
  if (list.length === 0) return [];
  const ranked = list.map((iceberg) => ({ iceberg, total: icebergTotalOf(iceberg).total })).sort((a, b) => b.total - a.total
    || b.iceberg.executed - a.iceberg.executed
    || b.iceberg.markedAt - a.iceberg.markedAt
    || (a.iceberg.id < b.iceberg.id ? -1 : a.iceberg.id > b.iceberg.id ? 1 : 0));
  return ranked.slice(0, Math.max(1, Math.ceil((list.length * top) / 100))).map((entry) => entry.iceberg);
}

export function biggestPerCandle(list: readonly IcebergOrder[], intervalMs: number, candleOpenOf: (ts: number) => number | null): IcebergOrder[] {
  if (!(intervalMs >= ICEBERG_CANDLE_PICK_MS)) return [...list];
  const best = new Map<number, IcebergOrder>();
  const out: IcebergOrder[] = [];
  for (const iceberg of list) {
    const open = candleOpenOf(iceberg.markedAt);
    if (open === null) {
      out.push(iceberg);
      continue;
    }
    const held = best.get(open);
    if (held === undefined || biggerIceberg(iceberg, held)) best.set(open, iceberg);
  }
  const kept = new Set([...out, ...best.values()]);
  return list.filter((iceberg) => kept.has(iceberg));
}

function biggerIceberg(a: IcebergOrder, b: IcebergOrder): boolean {
  const totals = icebergTotalOf(a).total - icebergTotalOf(b).total;
  if (totals !== 0) return totals > 0;
  if (a.executed !== b.executed) return a.executed > b.executed;
  return a.markedAt > b.markedAt;
}

export function icebergHistoryFromText(from: number | null): string {
  if (from === null) return "";
  const at = new Date(from);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
}

export function formatIcebergSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0";
  if (Number.isInteger(size)) return String(size);
  if (size >= 100) return size.toFixed(0);
  return size.toFixed(size >= 10 ? 1 : 3).replace(/\.?0+$/, "");
}

export function compactIcebergSize(size: number): string {
  if (!Number.isFinite(size) || size < 1e-6) return "0";
  if (Number.isInteger(size) || size >= 100) return size.toFixed(0);
  return String(Number(size.toPrecision(3)));
}

export function icebergCardTextOf(iceberg: Pick<IcebergOrder, "kind" | "display" | "tranches" | "executed">): { total: string; breakdown: string } {
  const { total, perOrder, orders } = icebergTotalOf(iceberg);
  const shownPerOrder = compactIcebergSize(perOrder);
  const shownTotal = perOrder > 0 ? compactIcebergSize(Number(shownPerOrder) * orders) : compactIcebergSize(total);
  return { total: shownTotal, breakdown: `(${shownPerOrder} × ${orders})` };
}
