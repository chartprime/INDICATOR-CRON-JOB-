import type { ExhaustionHover } from "./exhaustionHover";
import { WHALE_CARD_FLIP_BELOW_PX } from "../whale-limit-order-heatmap/whaleCardLayout";

export const COUNTED_COLOR = "#4ade80";
export const UNCOUNTED_COLOR = "#a78bfa";
export const DETAIL_COLOR = "#c0c3c6";

export function ExhaustionCard({ hover, x, y }: { hover: ExhaustionHover; x: number; y: number }) {
  return (
    <div className={`whale-tooltip exhaustion ${hover.side === "buyers" ? "sell" : "buy"}${y < WHALE_CARD_FLIP_BELOW_PX ? " below" : ""}`} style={{ left: x, top: y }}>
      <div className="whale-tooltip-side">{hover.title}</div>
      {hover.lines.map((line) => (
        <div
          key={line.key}
          className="whale-tooltip-participation tabular"
          style={{ display: "flex", alignSelf: "stretch", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}
        >
          <span>{line.label}</span>
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span style={{ color: line.counted ? COUNTED_COLOR : UNCOUNTED_COLOR }}>{line.value}</span>
            <span style={{ fontSize: "0.85em", color: DETAIL_COLOR }}>{line.detail}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
