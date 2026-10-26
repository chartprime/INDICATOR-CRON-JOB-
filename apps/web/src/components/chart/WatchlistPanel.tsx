import { useMemo, useState } from "react";
import { instrumentKey } from "../../lib/chart/drawingStore";
import { INSTRUMENTS, type InstrumentOption } from "../../lib/chart/instruments";
import type { FrameIdentity } from "../../types/frames";

const STORAGE_KEY = "terminal.watchlist.v1";
const DEFAULT_KEYS = INSTRUMENTS.filter(
  (instrument) => instrument.identity.provider === "BINANCE" && instrument.identity.marketKind === "PERPETUAL",
).map((instrument) => instrumentKey({ symbol: instrument.symbol, ...instrument.identity }));

function keyFor(instrument: InstrumentOption): string {
  return instrumentKey({ symbol: instrument.symbol, ...instrument.identity });
}

function loadKeys(selectedKey: string): string[] {
  // Only catalog instruments: a row is drawn per known key, and moving a row swaps keys by the row's own index.
  const valid = new Set(INSTRUMENTS.map(keyFor));
  const defaults = [...new Set([selectedKey, ...DEFAULT_KEYS])].filter((key) => valid.has(key));
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(value)) return defaults;
    return [...new Set(value.filter((key): key is string => typeof key === "string" && valid.has(key)))];
  } catch {
    return defaults;
  }
}

function saveKeys(keys: readonly string[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(keys)); } catch { /* private storage may be unavailable */ }
}

function displaySymbol(instrument: InstrumentOption): string {
  if (instrument.identity.provider === "BINANCE") {
    const base = instrument.symbol.split("-")[0];
    return `${base} ${instrument.identity.marketKind === "PERPETUAL" ? "Perp" : "Spot"}`;
  }
  return instrument.label;
}

export function WatchlistPanel({
  selection,
  lastPrice,
  live,
  onSelect,
}: {
  selection: { symbol: string } & FrameIdentity;
  lastPrice?: number;
  live: boolean;
  onSelect?: (symbol: string, identity: FrameIdentity) => void;
}) {
  const selectedKey = instrumentKey(selection);
  const [keys, setKeys] = useState(() => loadKeys(selectedKey));
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const entries = useMemo(() => keys.flatMap((key) => {
    const instrument = INSTRUMENTS.find((candidate) => keyFor(candidate) === key);
    return instrument ? [instrument] : [];
  }), [keys]);
  const available = INSTRUMENTS.filter((instrument) =>
    !keys.includes(keyFor(instrument)) &&
    `${instrument.label} ${instrument.symbol}`.toLowerCase().includes(query.trim().toLowerCase()));

  function change(next: string[]) {
    setKeys(next);
    saveKeys(next);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= keys.length) return;
    const next = [...keys];
    [next[index], next[target]] = [next[target], next[index]];
    change(next);
  }

  return (
    <section className="watchlist-panel" aria-label="Watchlist">
      <div className="watchlist-heading">
        <span>My watchlist</span>
        <button type="button" onClick={() => setAdding((value) => !value)} aria-expanded={adding} aria-label={adding ? "Close watchlist instruments" : "Add watchlist instrument"}>
          {adding ? "Close" : "+ Add"}
        </button>
      </div>
      {adding && (
        <div className="watchlist-add">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an instrument" aria-label="Find an instrument" />
          <div className="watchlist-add-results">
            {available.map((instrument) => (
              <button type="button" key={keyFor(instrument)} onClick={() => { change([...keys, keyFor(instrument)]); setAdding(false); setQuery(""); }}>
                <strong>{displaySymbol(instrument)}</strong><span>{instrument.group}</span>
              </button>
            ))}
            {available.length === 0 && <span className="watchlist-empty">No instruments to add.</span>}
          </div>
        </div>
      )}
      <div className="watchlist-columns" aria-hidden="true"><span>Symbol</span><span>Price</span><span>24h</span></div>
      <div className="watchlist-list">
        {entries.map((instrument, index) => {
          const key = keyFor(instrument);
          const selected = key === selectedKey;
          const price = selected && live && lastPrice !== undefined && Number.isFinite(lastPrice) ? lastPrice : null;
          return (
            <div className={`watchlist-row${selected ? " selected" : ""}`} key={key}>
              <button type="button" className="watchlist-select" onClick={() => onSelect?.(instrument.symbol, instrument.identity)} disabled={!onSelect} aria-current={selected ? "true" : undefined} aria-label={`Select ${instrument.label}`}>
                <span className="watchlist-symbol"><strong>{displaySymbol(instrument)}</strong><small>{instrument.group}</small></span>
                <span className="watchlist-price tabular" title={price !== null ? "Live price for the selected instrument" : "Select instrument to load its live price"}>
                  {price !== null ? price.toLocaleString("en-US", { minimumFractionDigits: price < 10 ? 4 : 2, maximumFractionDigits: price < 10 ? 4 : 2 }) : "—"}
                </span>
                <span className="watchlist-change tabular" title="24-hour change is not supplied by the current terminal feed">—</span>
              </button>
              <div className="watchlist-row-actions">
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${instrument.label} up`}>↑</button>
                <button type="button" onClick={() => move(index, 1)} disabled={index === keys.length - 1} aria-label={`Move ${instrument.label} down`}>↓</button>
                <button type="button" onClick={() => change(keys.filter((entry) => entry !== key))} aria-label={`Remove ${instrument.label}`}>×</button>
              </div>
            </div>
          );
        })}
        {entries.length === 0 && <div className="watchlist-empty">Your watchlist is empty. Add an instrument to begin.</div>}
      </div>
      <p className="watchlist-note">The current feed supplies live prices for the selected instrument. Other prices and 24-hour changes are shown when a dedicated watchlist feed is available.</p>
    </section>
  );
}
