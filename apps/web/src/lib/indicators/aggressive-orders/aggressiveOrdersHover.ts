import type { FrameIdentity } from "../../../types/frames";
import { formatLiquiditySize, formatWholeSize } from "../passive-liquidity/liquiditySettings";

export interface BubbleHover {
  side: "buy" | "sell";
  volume: number;
  price: number;
  ts: number;
  count: number;
}

export interface BubbleWords {
  side: "buy" | "sell";
  title: string;
  size: string;
  detail: string;
}

export function sizeUnitFor(identity: { symbol: string } & FrameIdentity): string {
  if (identity.provider === "DXFEED") return identity.assetClass === "FUTURE" ? "contracts" : "shares";
  return identity.symbol.split("-")[0];
}

function amount(volume: number, unit: string): string {
  const text = unit === "contracts" || unit === "shares" ? formatWholeSize(volume) : formatLiquiditySize(volume);
  if (text === "") return "";
  return unit ? `${text} ${unit}` : text;
}

export function describeBubble(bubble: BubbleHover, unit: string): BubbleWords {
  const price = bubble.price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return {
    side: bubble.side,
    title: bubble.side === "buy" ? "Buy" : "Sell",
    size: amount(bubble.volume, unit),
    detail: `${bubble.count} print${bubble.count === 1 ? "" : "s"} at ${price}`,
  };
}
