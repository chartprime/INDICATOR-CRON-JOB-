import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export const DEFAULT_PIVOT_LENGTH = 5;
export const DEFAULT_MAX_BLOCKS = 5;
export const ZONE_WIDTH_LENGTH = 100;
export const DEFAULT_WIDTH_MULTIPLIER = 1;

export type OrderBlockSide = "bullish" | "bearish";

export interface L1OrderBlock {
  id: string;
  side: OrderBlockSide;
  pivotPrice: number;
  pivotTime: number;
  breakTime: number;
  top: number;
  bottom: number;
  mitigatedTime: number | null;
  buyVolume?: number;
  sellVolume?: number;
  delta?: number | null;
  totalVolume?: number;
  unknownVolume?: number;
}

export interface L1OrderBlockSettings {
  pivotLength: number;
  widthMultiplier: number;
  maxBlocks: number;
  showMitigated: boolean;
  showTradingActivity: boolean;
  showMeanLine: boolean;
  bullishColor: string;
  bearishColor: string;
}

export const DEFAULT_L1_ORDER_BLOCK_SETTINGS: L1OrderBlockSettings = {
  pivotLength: DEFAULT_PIVOT_LENGTH,
  widthMultiplier: DEFAULT_WIDTH_MULTIPLIER,
  maxBlocks: DEFAULT_MAX_BLOCKS,
  showMitigated: false,
  showTradingActivity: true,
  showMeanLine: true,
  bullishColor: "#10b981",
  bearishColor: "#f43f5e",
};

export const L1_ORDER_BLOCK_SETTINGS_SCHEMA: readonly SettingsFieldSchema<L1OrderBlockSettings>[] =
  [
    {
      key: "pivotLength",
      label: "Pivot Length",
      kind: "numeric",
      min: 1,
      max: 50,
      step: 1,
      affects: "recompute",
    },
    {
      key: "widthMultiplier",
      label: "Zone Width Multiplier",
      kind: "numeric",
      min: 0.1,
      max: 3,
      step: 0.1,
      affects: "recompute",
    },
    {
      key: "maxBlocks",
      label: "Max Order Blocks",
      kind: "numeric",
      min: 1,
      max: 100,
      step: 1,
      affects: "recompute",
    },
    {
      key: "showMitigated",
      label: "Show Mitigated Blocks",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "showTradingActivity",
      label: "Show Trading Activity",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "showMeanLine",
      label: "Show Mean Line",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "bullishColor",
      label: "Bullish Box Color",
      kind: "color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      key: "bearishColor",
      label: "Bearish Box Color",
      kind: "color",
      tab: "visibility",
      affects: "recompute",
    },
  ];
