import { useState } from "react";
import { HISTORICAL_INSTRUMENTS, type HistoricalInstrument } from "../../lib/archive/historicalCatalog";

const STORAGE_KEY = "terminal.historical-watchlist.v1";
const DEFAULT_IDS = ["btc-perpetual", "eth-perpetual", "es-continuous", "nq-continuous"];

function loadIds(selectedId: string | undefined): string[] {
  const defaults = [...new Set([...(selectedId ? [selectedId] : []), ...DEFAULT_IDS])];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(saved)) return defaults;
    const known = new Set(HISTORICAL_INSTRUMENTS.map((instrument) => instrument.id));
    return [...new Set(saved.filter((id): id is string => typeof id === "string" && known.has(id)))];
  } catch {
    return defaults;
  }
}

export function HistoricalWatchlistPanel({ selected, onSelect }: {
  selected: HistoricalInstrument | null;
  onSelect: (instrument: HistoricalInstrument) => void;
}) {
  const [ids, setIds] = useState(() => loadIds(selected?.id));
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const entries = ids.flatMap((id) => {
    const instrument = HISTORICAL_INSTRUMENTS.find((item) => item.id === id);
    return instrument ? [instrument] : [];
  });
  const available = HISTORICAL_INSTRUMENTS.filter((instrument) =>
    !ids.includes(instrument.id) && `${instrument.label} ${instrument.symbol}`.toLowerCase().includes(query.toLowerCase().trim()));

  function change(next: string[]) {
    setIds(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage may be unavailable */ }
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];
    change(next);
  }

  return <section className="watchlist-panel" aria-label="Historical watchlist">
    <div className="watchlist-heading"><span>Archive watchlist</span><button type="button" aria-label={adding ? "Close archive instruments" : "Add archive instrument"} aria-expanded={adding} onClick={() => setAdding((open) => !open)}>{adding ? "Close" : "+ Add"}</button></div>
    {adding && <div className="watchlist-add">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Find archive instrument" placeholder="Find an archive instrument" />
      <div className="watchlist-add-results">
        {available.map((instrument) => <button key={instrument.id} type="button" onClick={() => { change([...ids, instrument.id]); setAdding(false); setQuery(""); }}><strong>{instrument.label}</strong><span>{instrument.group}</span></button>)}
        {available.length === 0 && <span className="watchlist-empty">No instruments to add.</span>}
      </div>
    </div>}
    <div className="watchlist-columns" aria-hidden="true"><span>Instrument</span><span>Price</span><span>24h</span></div>
    <div className="watchlist-list">
      {entries.map((instrument, index) => <div className={`watchlist-row${selected?.id === instrument.id ? " selected" : ""}`} key={instrument.id}>
        <button type="button" className="watchlist-select" aria-current={selected?.id === instrument.id ? "true" : undefined} aria-label={`Select archive ${instrument.label}`} onClick={() => onSelect(instrument)}>
          <span className="watchlist-symbol"><strong>{instrument.label}</strong><small>{instrument.group} · {instrument.source}</small></span><span className="watchlist-price tabular" title="No archive quote feed">—</span><span className="watchlist-change tabular" title="No 24-hour quote feed">—</span>
        </button>
        <div className="watchlist-row-actions"><button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${instrument.label} up`}>↑</button><button type="button" onClick={() => move(index, 1)} disabled={index === ids.length - 1} aria-label={`Move ${instrument.label} down`}>↓</button><button type="button" onClick={() => change(ids.filter((id) => id !== instrument.id))} aria-label={`Remove ${instrument.label}`}>×</button></div>
      </div>)}
      {entries.length === 0 && <div className="watchlist-empty">Your archive watchlist is empty. Add an instrument to begin.</div>}
    </div>
    <p className="watchlist-note">Selecting an instrument requests its archived chart. This archive has no live quote or 24-hour change feed.</p>
  </section>;
}
