import type { InitiativeHover } from "./initiativeHover";
import { WHALE_CARD_FLIP_BELOW_PX } from "../whale-limit-order-heatmap/whaleCardLayout";

export const COUNTED_COLOR = "#4ade80";
export const UNCOUNTED_COLOR = "#a78bfa";
export const COUNTED_MARK = "✓";
export const UNCOUNTED_MARK = "✗";

const ROW_STYLE = { display: "flex", alignSelf: "stretch", justifyContent: "space-between", gap: 12, alignItems: "baseline" } as const;

export function InitiativeCard({ hover, x, y }: { hover: InitiativeHover; x: number; y: number }) {
  return (
    <div className={`whale-tooltip initiative ${hover.pushers === "buyers" ? "buy" : "sell"}${y < WHALE_CARD_FLIP_BELOW_PX ? " below" : ""}`} style={{ left: x, top: y }}>
      <div className="whale-tooltip-side">{hover.title}</div>
      {hover.lines.map((line) => (
        <div key={line.key} className="whale-tooltip-participation tabular" style={ROW_STYLE}>
          <span>
            <span style={{ color: line.counted ? COUNTED_COLOR : UNCOUNTED_COLOR }}>{line.counted ? COUNTED_MARK : UNCOUNTED_MARK}</span> {line.label}
          </span>
          <span>{line.value}</span>
        </div>
      ))}
    </div>
  );
}
