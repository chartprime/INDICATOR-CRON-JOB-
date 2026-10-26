import type { WhaleCard } from "./whaleCard";
import { WHALE_CARD_FLIP_BELOW_PX, WHALE_CARD_WIDTH_PX } from "./whaleCardLayout";

export function WhaleWallCard({ card, x, y, pinned }: { card: WhaleCard; x: number; y: number; pinned: boolean }) {
  return (
    <div className={`whale-wall-card ${card.side === 0 ? "buy" : "sell"}${pinned ? " pinned" : ""}${y < WHALE_CARD_FLIP_BELOW_PX ? " below" : ""}`} style={{ left: x, top: y, width: WHALE_CARD_WIDTH_PX }}>
      <div className="whale-wall-card-head">
        <span className="whale-wall-card-title">{card.title}</span>
        <span className="whale-wall-card-usd tabular">{card.usd}</span>
      </div>
      <div className="whale-wall-card-sentence">{card.sentence}</div>
      {card.meterPct !== null && (
        <div className="whale-wall-card-meter" role="img" aria-label={`${card.meterPct}% traded`}>
          <div className="whale-wall-card-meter-fill" style={{ width: `${card.meterPct}%` }} />
        </div>
      )}
      <div className="whale-wall-card-facts tabular">{card.facts}</div>
      {pinned && card.details.length > 0 && (
        <dl className="whale-wall-card-details">
          {card.details.map(([label, value]) => (
            <div key={label} className="whale-wall-card-row">
              <dt>{label}</dt>
              <dd className="tabular">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {pinned && <div className="whale-wall-card-hint">Esc or click empty chart to close</div>}
    </div>
  );
}
