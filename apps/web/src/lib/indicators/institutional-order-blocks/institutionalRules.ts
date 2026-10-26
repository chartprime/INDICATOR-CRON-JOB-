import type { FrameIdentity } from "../../../types/frames";
import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { FLASH_WALL_MS } from "../absorption-detector/absorptionSettings";
import { DEFAULT_PIVOT_LENGTH, DEFAULT_WIDTH_MULTIPLIER, DEFAULT_MAX_ORDER_BLOCKS } from "../classic-order-blocks/orderBlockRules";
import { bandRowsFor } from "../institutional-order-blocks-v2/institutionalV2Rules";

export { FLASH_WALL_MS };
export const DELTA_MIN = 0.15;

export interface Thresholds {
  wall: number;
  hit: number;
  bandRows: number;
}

import { futuresRoot, isIndexProvider } from "../../chart/l2Market";

export function thresholdsFor(identity: { symbol: string } & FrameIdentity): Omit<Thresholds, "bandRows"> {
  if (isIndexProvider(identity.provider)) {
    if (identity.assetClass === "EQUITY") return identity.symbol === "TSLA" ? { wall: 1000, hit: 2000 } : { wall: 1000, hit: 3000 };
    const root = futuresRoot(identity.symbol);
    if (root === "/ES" || root === "/MES") return { wall: 30, hit: 20 };
    return { wall: 10, hit: 8 };
  }
  const base = identity.symbol.split("-")[0];
  const perpetual = identity.marketKind === "PERPETUAL";
  if (base === "BTC") return perpetual ? { wall: 50, hit: 40 } : { wall: 10, hit: 5 };
  if (base === "ETH") return perpetual ? { wall: 600, hit: 300 } : { wall: 180, hit: 60 };
  return { wall: 10, hit: 5 };
}

export function thresholdsOf(settings: InstitutionalSettings, identity: { symbol: string } & FrameIdentity): Thresholds {
  const defaults = thresholdsFor(identity);
  return {
    wall: settings.wallSize > 0 ? settings.wallSize : defaults.wall,
    hit: settings.hitSize > 0 ? settings.hitSize : defaults.hit,
    bandRows: settings.bandRows > 0 ? Math.floor(settings.bandRows) : bandRowsFor(identity),
  };
}

export type Verdict = "strong" | "weak" | "rejected" | "unverifiable";

export interface BookEvidence {
  held: boolean;
  standing: boolean;
  peak: number;
  current: number;
  hit: number;
  delta: number;
}

export function verdictOf(evidence: BookEvidence | null, thresholds: Thresholds): Verdict {
  if (evidence === null) return "unverifiable";
  if (!evidence.held) return "rejected";
  const hit = evidence.hit >= thresholds.hit;
  if (hit && evidence.delta >= DELTA_MIN && evidence.standing) return "strong";
  if (!hit && !evidence.standing) return "rejected";
  return "weak";
}

export function zoneRows(top: number, bottom: number, rowWidth: number): { rowLo: number; rowHi: number } | null {
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(rowWidth) || rowWidth <= 0) return null;
  if (top <= bottom) return null;
  const rowLo = Math.floor(bottom / rowWidth);
  const rowHi = Math.ceil(top / rowWidth) - 1;
  return { rowLo, rowHi };
}

export interface InstitutionalSettings {
  pivotLength: number;
  widthMultiplier: number;
  maxBlocks: number;
  stackPivots: boolean;
  showSecondary: boolean;
  wallSize: number;
  hitSize: number;
  bandRows: number;
  showWeak: boolean;
  showRejected: boolean;
  showUnverifiable: boolean;
  showMitigated: boolean;
  bullishColor: string;
  bearishColor: string;
}

export const DEFAULT_INSTITUTIONAL_SETTINGS: InstitutionalSettings = {
  pivotLength: DEFAULT_PIVOT_LENGTH,
  widthMultiplier: DEFAULT_WIDTH_MULTIPLIER,
  maxBlocks: DEFAULT_MAX_ORDER_BLOCKS,
  stackPivots: true,
  showSecondary: false,
  wallSize: 0,
  hitSize: 0,
  bandRows: 0,
  showWeak: false,
  showRejected: false,
  showUnverifiable: false,
  showMitigated: false,
  bullishColor: "#2dd4bf",
  bearishColor: "#fb7185",
};

export const INSTITUTIONAL_SETTINGS_SCHEMA: readonly SettingsFieldSchema<InstitutionalSettings>[] = [
  { key: "bandRows", label: "Wall Width in Rows (0 = instrument default)", kind: "numeric", min: 0, max: 64, step: 1, affects: "recompute" },
  { key: "pivotLength", label: "Structure Pivot Length", kind: "numeric", min: 1, max: 50, step: 1, affects: "recompute" },
  { key: "widthMultiplier", label: "Zone Width Multiplier", kind: "numeric", min: 0.1, max: 3, step: 0.1, affects: "recompute" },
  { key: "maxBlocks", label: "Maximum Order Blocks", kind: "numeric", min: 1, max: 200, step: 1, affects: "recompute" },
  { key: "stackPivots", label: "Break Older Structure", kind: "boolean", affects: "recompute" },
  { key: "showSecondary", label: "Show Secondary Blocks", kind: "boolean", affects: "cosmetic" },
  { key: "showWeak", label: "Show Weak Blocks", kind: "boolean", affects: "cosmetic" },
  { key: "showUnverifiable", label: "Show Unverifiable Blocks", kind: "boolean", affects: "cosmetic" },
  { key: "showRejected", label: "Show Rejected Blocks", kind: "boolean", affects: "cosmetic" },
  { key: "showMitigated", label: "Show Mitigated Blocks", kind: "boolean", affects: "cosmetic" },
  { key: "bullishColor", label: "Bullish Block Color", kind: "color", tab: "visibility", affects: "cosmetic" },
  { key: "bearishColor", label: "Bearish Block Color", kind: "color", tab: "visibility", affects: "cosmetic" },
];

export function isShownVerdict(verdict: Verdict, settings: InstitutionalSettings): boolean {
  if (verdict === "strong") return true;
  if (verdict === "weak") return settings.showWeak;
  if (verdict === "unverifiable") return settings.showUnverifiable;
  return settings.showRejected;
}
