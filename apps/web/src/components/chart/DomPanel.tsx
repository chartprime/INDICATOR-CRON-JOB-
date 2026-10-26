import { useState, type CSSProperties } from "react";
import type { BookFrame, BookLevel } from "../../types/frames";
import { formatUsd } from "../../lib/chart/formatUsd";

interface DepthRowStyle extends CSSProperties {
  "--size-ratio": number;
}

function maxSize(levels: BookLevel[]): number {
  return levels.reduce((m, l) => Math.max(m, l.size), 0);
}

function DepthRow({
  level,
  side,
  ratio,
  futuresMode,
}: {
  level: BookLevel;
  side: "bid" | "ask";
  ratio: number;
  futuresMode: boolean;
}) {
  return (
    <div className={`dom-row ${side}`} style={{ "--size-ratio": ratio } as DepthRowStyle}>
      <span className="size-bar" aria-hidden="true" />
      <span className="p tabular">{level.price.toFixed(2)}</span>
      <span className="s">
        {futuresMode ? (
          <span className="native tabular">{level.size.toFixed(0)} ct</span>
        ) : (
          <>
            <span className="native tabular">{level.size.toFixed(4)}</span>
            <span className="usd tabular">{formatUsd(level.price * level.size)}</span>
          </>
        )}
      </span>
    </div>
  );
}

interface DomPanelProps {
  book: BookFrame | null;
  lastPrice: number | undefined;
  lastTickDirection: "up" | "down" | null;
  futuresMode?: boolean;
}

export function DomPanel({ book, lastPrice, lastTickDirection, futuresMode = false }: DomPanelProps) {
  const [visibleLevels, setVisibleLevels] = useState<5 | 10 | 20>(10);
  const ready = book?.status === "READY";
  const stale = ready && book.stale === true;
  const bids = ready ? (book.bids ?? []) : [];
  const asks = ready ? (book.asks ?? []) : [];
  const shownBids = bids.slice(0, visibleLevels);
  const shownAsks = asks.slice(0, visibleLevels);
  const combinedMax = Math.max(maxSize(shownBids), maxSize(shownAsks));
  const asksDisplay = [...shownAsks].reverse();
  const bidDepth = shownBids.reduce((sum, level) => sum + level.size, 0);
  const askDepth = shownAsks.reduce((sum, level) => sum + level.size, 0);
  const bidShare = bidDepth + askDepth > 0 ? Math.round(100 * bidDepth / (bidDepth + askDepth)) : null;
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null;
  const midpoint = spread !== null ? (bestAsk! + bestBid!) / 2 : null;
  const source = book?.provider === "DXFEED" ? "dxFeed" : book?.provider === "BINANCE" ? "Binance" : "source pending";

  return (
    <div className="dom-panel">
      <div className="dom-header">
        <h3>Liquidity ladder</h3>
        <span className="dom-depth-scope">{source} · {visibleLevels} of top 20 / side</span>
      </div>
      <div className="dom-level-controls" aria-label="Visible book levels">
        {[5, 10, 20].map((count) => <button type="button" key={count} className={visibleLevels === count ? "active" : ""} aria-pressed={visibleLevels === count} onClick={() => setVisibleLevels(count as 5 | 10 | 20)}>{count}</button>)}
      </div>
      {ready && bidShare !== null && <div className="dom-imbalance" aria-label={`Shown depth: ${bidShare}% bids, ${100 - bidShare}% asks`}>
        <div className="dom-imbalance-bar" style={{ "--bid-share": `${bidShare}%` } as CSSProperties} aria-hidden="true" />
        <div className="dom-imbalance-labels"><span>Bids {bidShare}%</span><span>Shown {visibleLevels} levels / side</span><span>{100 - bidShare}% Asks</span></div>
      </div>}
      <div className="dom-cols">
        <span>Price</span>
        <span>{futuresMode ? "Contracts" : "Size / USD"}</span>
      </div>
      {!book && <div className="dom-empty" role="status" aria-live="polite">Book initializing (no status received)</div>}
      {book && !ready && <div className="dom-empty" role="status" aria-live="polite">Book unavailable{book.reason ? ` (${book.reason})` : " (reason not reported)"}</div>}
      {ready && (
        <>
          {spread !== null && (
            <div className="dom-spread tabular" aria-label="Order book spread and midpoint">
              Spread {spread.toFixed(2)} · Mid {midpoint!.toFixed(2)}
            </div>
          )}
          <div className="dom-list">
          <div className="dom-asks">
            {asksDisplay.map((level, index) => (
              <DepthRow key={`ask-${level.price}-${index}`} level={level} side="ask" ratio={combinedMax > 0 ? level.size / combinedMax : 0} futuresMode={futuresMode} />
            ))}
          </div>
          {lastPrice !== undefined && (
            <div className={`dom-last-price${lastTickDirection ? ` ${lastTickDirection}` : ""}`}>
              <span className="tabular">{lastPrice.toFixed(2)}</span>
              {lastTickDirection && <span className="arrow" aria-hidden="true">{lastTickDirection === "up" ? "↑" : "↓"}</span>}
            </div>
          )}
          <div className="dom-bids">
            {shownBids.map((level, index) => (
              <DepthRow key={`bid-${level.price}-${index}`} level={level} side="bid" ratio={combinedMax > 0 ? level.size / combinedMax : 0} futuresMode={futuresMode} />
            ))}
          </div>
          {stale && (
            <div className="dom-overlay" role="status" aria-live="polite">
              <span className="dot stale" />
              Book stale
            </div>
          )}
          </div>
        </>
      )}
    </div>
  );
}
