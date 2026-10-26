import type { IndicatorCategory } from "./indicatorTypes";

export type IndicatorFamily = "basic" | "orderflow" | "orderbook";

export function indicatorFamily(indicator: { id: string; category: IndicatorCategory }): IndicatorFamily {
  if (indicator.id === "volumeDeltaProfileOhlc") return "basic";
  if (indicator.id === "sessionDeltaProfile" || indicator.id === "largeTradeBubbles") return "orderflow";
  if (indicator.category === "l2") return "orderbook";
  if (indicator.category === "l1") return "orderflow";
  return "basic";
}
