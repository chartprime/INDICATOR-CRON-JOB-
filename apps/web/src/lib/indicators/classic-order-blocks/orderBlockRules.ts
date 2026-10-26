import type { SettingsFieldSchema } from "../../chart/indicatorTypes";

export const DEFAULT_PIVOT_LENGTH = 7;
export const SECONDARY_LEFT_BARS = 1;
export const ZONE_WIDTH_LENGTH = 100;
export const DEFAULT_WIDTH_MULTIPLIER = 1;
export const DEFAULT_MAX_ORDER_BLOCKS = 10;
export const MAX_PIVOT_AGE_BARS = 500;
export const MAX_STORED_PIVOTS = 32;

export type OrderBlockSide = "bullish" | "bearish";
export type OrderBlockTier = "primary" | "secondary";

export interface OrderBlockSettings {
  pivotLength: number;
  widthMultiplier: number;
  maxBlocks: number;
  stackPivots: boolean;
  showSecondary: boolean;
  showMitigated: boolean;
  bullishColor: string;
  bearishColor: string;
}

export const DEFAULT_ORDER_BLOCK_SETTINGS: OrderBlockSettings = {
  pivotLength: DEFAULT_PIVOT_LENGTH,
  widthMultiplier: DEFAULT_WIDTH_MULTIPLIER,
  maxBlocks: DEFAULT_MAX_ORDER_BLOCKS,
  stackPivots: true,
  showSecondary: false,
  showMitigated: false,
  bullishColor: "#3b82f6",
  bearishColor: "#ef4444",
};

export const ORDER_BLOCK_SETTINGS_SCHEMA: readonly SettingsFieldSchema<OrderBlockSettings>[] =
  [
    {
      key: "pivotLength",
      label: "Structure Pivot Length",
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
      label: "Maximum Order Blocks",
      kind: "numeric",
      min: 1,
      max: 200,
      step: 1,
      affects: "recompute",
    },
    {
      key: "stackPivots",
      label: "Break Older Structure",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "showSecondary",
      label: "Show Secondary Blocks",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "showMitigated",
      label: "Show Mitigated Blocks",
      kind: "boolean",
      affects: "recompute",
    },
    {
      key: "bullishColor",
      label: "Bullish Block Color",
      kind: "color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      key: "bearishColor",
      label: "Bearish Block Color",
      kind: "color",
      tab: "visibility",
      affects: "recompute",
    },
    {
      kind: "staticHint",
      text: "A bullish block forms when a candle closes above a confirmed swing high: the zone sits on the lowest low between that swing and the breakout, one average candle range tall. Bearish blocks mirror it off a swing low. A block is mitigated when a later candle closes through it, beyond its far edge; a close inside it or a wick through is not enough. Break Older Structure keeps every unbroken swing instead of only the newest, so a rally can still take out a high set some time ago; turn it off for the reference's behaviour.",
    },
  ];

export interface OrderBlock {
  side: OrderBlockSide;
  tier: OrderBlockTier;
  pivotTime: number;
  baseTime: number;
  breakTime: number;
  top: number;
  bottom: number;
  mitigatedTime: number | null;
  volume: number;
}

export function zoneFor(
  side: OrderBlockSide,
  base: number,
  width: number,
): { top: number; bottom: number } {
  return side === "bullish"
    ? { top: base + width, bottom: base }
    : { top: base, bottom: base - width };
}

export function baseOf(block: OrderBlock): number {
  return block.side === "bullish" ? block.bottom : block.top;
}

export function mitigates(block: OrderBlock, bar: { close: number }): boolean {
  return block.side === "bullish"
    ? bar.close < block.bottom
    : bar.close > block.top;
}

export function breaks(
  side: OrderBlockSide,
  pivotPrice: number,
  close: number,
): boolean {
  return side === "bullish" ? close > pivotPrice : close < pivotPrice;
}
