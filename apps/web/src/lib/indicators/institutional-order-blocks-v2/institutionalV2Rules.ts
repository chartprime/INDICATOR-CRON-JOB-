import type { FrameIdentity } from "../../../types/frames";
import { futuresRoot, isIndexProvider } from "../../chart/l2Market";
import { instrumentKey } from "../../chart/drawingStore";

export const HELD_MS = 180_000;
export const DEATH_SHARE = 0.1;
export const STRONG_EATEN_SHARE = 0.6;
export const STRONG_HOLD_MS = 600_000;
export const STRONG_SIZE_KEEP_SHARE = 0.8;
export const GUARD_EATEN_SHARE = 0.25;
export const HOLE_MS = 600_000;
export const MEMORY_MS = 4 * 3_600_000;
export const RUNTIME_HISTORY_MS = 24 * 3_600_000;
export const DEFAULT_HISTORY_HOURS = 48;
export const MAX_HISTORY_HOURS = 168;

export function historyHoursOf(settings: Pick<InstitutionalV2Settings, "historyHours"> | undefined): number {
  const hours = settings?.historyHours;
  return typeof hours === "number" && Number.isFinite(hours) && hours >= 0 ? Math.min(MAX_HISTORY_HOURS, hours) : DEFAULT_HISTORY_HOURS;
}
export const REFILL_DIP_SHARE = 0.5;
export const REFILL_BACK_SHARE = 0.8;
export const WALL_COLUMN_MS = 10_000;
export const REBUILD_MIN_MS = 5_000;

export type Side = "bid" | "ask";
export type EndReason = "pulled" | "closed" | "window" | "hole" | "invalidated";
export type Grade = "weak" | "strong";
export type Freshness = "fresh" | "tested";

export interface Wall {
  side: Side;
  band: number;
  bandRows: number;
  startTs: number;
  resumedTs: number;
  peak: number;
  current: number;
  low: number;
  eaten: number;
  refills: number;
  refilled: number;
  crossedTs: number | null;
  atStrongSize: boolean;
  reachedStrongSize: boolean;
  guarded: boolean;
  endTs: number | null;
  endReason: EndReason | null;
}

export function gradeOf(wall: Wall, nowTs: number): Grade {
  if (wall.endTs !== null) return "weak";
  return gradeWhileStanding(wall, nowTs);
}

export function gradeWhileStanding(wall: Wall, atTs: number): Grade {
  if (wall.guarded || wall.atStrongSize) return "strong";
  return wall.crossedTs !== null && atTs - wall.crossedTs >= STRONG_HOLD_MS ? "strong" : "weak";
}

export function earnsGuard(wall: Wall): boolean {
  return wall.reachedStrongSize && absorbedShare(wall) >= GUARD_EATEN_SHARE;
}

export function freshnessOf(wall: Wall): Freshness {
  return wall.eaten > 0 ? "tested" : "fresh";
}

export function absorbedShare(wall: Wall): number {
  return wall.peak > 0 ? wall.eaten / wall.peak : 0;
}

export const SCORE_STANDING_MS = 1_800_000;
export const SCORE_MARKS = Object.freeze({ size: 40, defence: 30, refill: 20, standing: 10 });

export function wallScore(wall: Wall, strongSize: number, nowTs: number): number {
  const share = (value: number, cap: number): number => (cap > 0 ? Math.min(1, Math.max(0, value / cap)) : 0);
  return Math.round(
    SCORE_MARKS.size * share(wall.current, strongSize) +
      SCORE_MARKS.defence * share(absorbedShare(wall), GUARD_EATEN_SHARE) +
      SCORE_MARKS.refill * share(wall.refilled, wall.peak) +
      SCORE_MARKS.standing * share(nowTs - wall.startTs, SCORE_STANDING_MS),
  );
}


export function bandRowsFor(identity: { symbol: string } & FrameIdentity): number {
  if (isIndexProvider(identity.provider)) {
    if (identity.assetClass === "EQUITY") return identity.symbol === "AAPL" ? 8 : identity.symbol === "TSLA" ? 6 : 5;
    const root = futuresRoot(identity.symbol);
    if (root === "/NQ" || root === "/MNQ") return 12;
    return 3;
  }
  return identity.symbol.split("-")[0] === "ETH" ? 8 : 4;
}

export function wallSizeFor(identity: { symbol: string } & FrameIdentity): number {
  if (isIndexProvider(identity.provider)) {
    if (identity.assetClass === "EQUITY") return 1000;
    const root = futuresRoot(identity.symbol);
    if (root === "/ES" || root === "/MES") return 90;
    if (root === "/NQ" || root === "/MNQ") return 35;
    return 10;
  }
  const base = identity.symbol.split("-")[0];
  const perpetual = identity.marketKind === "PERPETUAL";
  if (base === "BTC") return perpetual ? 50 : 10;
  if (base === "ETH") return perpetual ? 600 : 180;
  return 10;
}

export function minSizeFor(identity: { symbol: string } & FrameIdentity): number {
  if (isIndexProvider(identity.provider)) {
    if (identity.assetClass === "EQUITY") return 2000;
    const root = futuresRoot(identity.symbol);
    if (root === "/NQ" || root === "/MNQ") return 50;
    if (root === "/ES" || root === "/MES") return 300;
    return wallSizeFor(identity);
  }
  const base = identity.symbol.split("-")[0];
  const perpetual = identity.marketKind === "PERPETUAL";
  if (base === "BTC") return perpetual ? 150 : 20;
  if (base === "ETH") return perpetual ? 2400 : 360;
  return wallSizeFor(identity);
}

export function strongSizeFor(identity: { symbol: string } & FrameIdentity): number {
  if (isIndexProvider(identity.provider)) {
    if (identity.assetClass === "EQUITY") return identity.symbol === "NVDA" ? 100_000 : identity.symbol === "TSLA" ? 23_000 : 10_000;
    const root = futuresRoot(identity.symbol);
    if (root === "/ES" || root === "/MES") return 300;
    if (root === "/NQ" || root === "/MNQ") return 100;
    return Infinity;
  }
  const base = identity.symbol.split("-")[0];
  const perpetual = identity.marketKind === "PERPETUAL";
  if (base === "BTC") return perpetual ? 200 : 80;
  if (base === "ETH") return perpetual ? 5000 : 1200;
  return Infinity;
}

export type LevelsBy = "nearest" | "largest" | "furthest";
export type WallSource = "tracker" | "engine" | "both";

export interface InstitutionalV2Settings {
  source: WallSource;
  showWeak: boolean;
  showMitigated: boolean;
  minSizeByInstrument: Record<string, number>;
  levelsBy: LevelsBy;
  levelsPerSide: number;
  bullishColor: string;
  bearishColor: string;
  bandThicknessPx: number;
  historyHours: number;
}

export const DEFAULT_INSTITUTIONAL_V2_SETTINGS: InstitutionalV2Settings = {
  source: "engine",
  showWeak: false,
  showMitigated: false,
  minSizeByInstrument: {},
  levelsBy: "furthest",
  levelsPerSide: 4,
  bullishColor: "#2dd4bf",
  bearishColor: "#fb7185",
  bandThicknessPx: 24,
  historyHours: DEFAULT_HISTORY_HOURS,
};

export function barTouches(wall: Pick<Wall, "band" | "bandRows">, rowWidth: number, low: number, high: number): boolean {
  const rowLo = wall.band * wall.bandRows;
  return low <= (rowLo + wall.bandRows) * rowWidth && high >= rowLo * rowWidth;
}

export function staysOnChart(wall: Pick<Wall, "current">, minSize: number, touching: boolean, grade: Grade): boolean {
  return touching && grade === "strong" ? wall.current > 0 : wall.current > 0 && wall.current >= minSize;
}

export function minSizeOf(settings: InstitutionalV2Settings, identity: { symbol: string } & FrameIdentity): number {
  return settings.minSizeByInstrument[instrumentKey(identity)] ?? minSizeFor(identity);
}

export function isMinSizeByInstrument(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((size) => typeof size === "number" && Number.isInteger(size) && size > 0);
}

export function sizeUnitFor(identity: { symbol: string } & FrameIdentity): string {
  if (identity.provider === "BINANCE") return identity.symbol.split("-")[0];
  return identity.assetClass === "EQUITY" ? "shares" : "contracts";
}

export function isShownGrade(grade: Grade, settings: InstitutionalV2Settings): boolean {
  return grade === "strong" || settings.showWeak;
}
