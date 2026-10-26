import { useState } from "react";
import type { CSSProperties } from "react";
import type { FrameIdentity, TradeFrame } from "../../types/frames";
import { formatUsd } from "../../lib/chart/formatUsd";

interface TapeRowStyle extends CSSProperties {
  "--size-ratio": number;
}

function formatTime(tsExchangeMs: number): string {
  const d = new Date(tsExchangeMs);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const LARGE_TRADE_RATIO = 0.6;

function tapeMagnitude(trade: TradeFrame, futuresMode: boolean): number {
  return futuresMode ? trade.size : trade.price * trade.size;
}

export function TapePanel({ trades, instrumentIdentity }: { trades: TradeFrame[]; instrumentIdentity: FrameIdentity }) {
  const [minNotionalUsd, setMinNotionalUsd] = useState(0);
  const [minContracts, setMinContracts] = useState(0);
  const futuresMode = instrumentIdentity.provider === "DXFEED" && instrumentIdentity.assetClass === "FUTURE";
  const minSize = futuresMode ? minContracts : minNotionalUsd;
  const visibleTrades =
    minSize > 0 ? trades.filter((trade) => tapeMagnitude(trade, futuresMode) >= minSize) : trades;
  const maxMagnitude = visibleTrades.reduce((maximum, trade) => Math.max(maximum, tapeMagnitude(trade, futuresMode)), 0);
  const buyMagnitude = visibleTrades.reduce((total, trade) => total + (trade.side === "buy" ? tapeMagnitude(trade, futuresMode) : 0), 0);
  const sellMagnitude = visibleTrades.reduce((total, trade) => total + (trade.side === "sell" ? tapeMagnitude(trade, futuresMode) : 0), 0);
  const formatMagnitude = (value: number) => futuresMode ? `${value.toLocaleString("en-US")} ct` : formatUsd(value);

  return (
    <div className="tape-panel">
      <div className="tape-header">
        <h3>Trade Tape</h3>
      </div>
      {trades.length > 0 && <div className="tape-summary" aria-label="Shown trade totals">
        <div><span>Buy · shown prints</span><strong>{formatMagnitude(buyMagnitude)}</strong></div>
        <div><span>Sell · shown prints</span><strong>{formatMagnitude(sellMagnitude)}</strong></div>
      </div>}
      <div className="tape-filter">
        <label htmlFor="tape-min-size">Min size</label>
        <div className="field">
          {!futuresMode && <span aria-hidden="true">$</span>}
          <input
            id="tape-min-size"
            type="number"
            inputMode="numeric"
            min={0}
            step={futuresMode ? 1 : 100}
            placeholder="0"
            value={minSize === 0 ? "" : minSize}
            onChange={(e) => {
              const value = Number(e.target.value);
              const next = Number.isFinite(value) && value > 0 ? value : 0;
              if (futuresMode) setMinContracts(next);
              else setMinNotionalUsd(next);
            }}
          />
          {futuresMode && <span aria-hidden="true">ct</span>}
        </div>
        {minSize > 0 && (
          <span className="count">
            {visibleTrades.length} / {trades.length} shown
          </span>
        )}
      </div>
      <div className="tape-cols">
        <span>Time (UTC)</span>
        <span>Price</span>
        <span>{futuresMode ? "Contracts" : "Size / USD"}</span>
      </div>
      <div className="tape-list">
        {trades.length === 0 && <div className="tape-empty">Waiting for trades…</div>}
        {trades.length > 0 && visibleTrades.length === 0 && (
          <div className="tape-empty">No prints ≥ {futuresMode ? `${minSize} ct` : formatUsd(minSize)}</div>
        )}
        {visibleTrades.map((t) => {
          const ratio = maxMagnitude > 0 ? tapeMagnitude(t, futuresMode) / maxMagnitude : 0;
          const large = ratio >= LARGE_TRADE_RATIO;
          return (
            <div
              key={t.trade_id}
              data-trade-id={t.trade_id}
              data-event-time={t.ts_exchange}
              className={`tape-row ${t.side === "buy" ? "buy" : "sell"}${large ? " large" : ""}`}
              style={{ "--size-ratio": ratio } as TapeRowStyle}
            >
              <span className="size-bar" aria-hidden="true" />
              <span className="t">{formatTime(t.ts_exchange)}</span>
              <span className="p tabular">{t.price.toFixed(2)}</span>
              <span className="s">
                {futuresMode ? (
                  <span className="native tabular">{t.size.toFixed(0)} ct</span>
                ) : (
                  <>
                    <span className="native tabular">{t.size.toFixed(4)}</span>
                    <span className="usd tabular">{formatUsd(t.price * t.size)}</span>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
