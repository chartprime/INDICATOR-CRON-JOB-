import { useEffect, useMemo, useRef, useState } from "react";
import { INDICATOR_REGISTRY, type IndicatorId } from "../../lib/chart/indicatorRegistry";
import { indicatorFamily, type IndicatorFamily } from "../../lib/chart/indicatorFamily";

type View = IndicatorFamily | "all" | "favorites" | "on-chart";
const STORAGE_KEY = "terminal.indicators.starred.v1";
const KNOWN_IDS = new Set<IndicatorId>(INDICATOR_REGISTRY.map((def) => def.id));

function loadStarred(): Set<IndicatorId> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return new Set(Array.isArray(saved) ? saved.filter((id): id is IndicatorId => KNOWN_IDS.has(id as IndicatorId)) : []);
  } catch {
    return new Set();
  }
}

const VIEWS: { id: View; label: string; section: string }[] = [
  { id: "favorites", label: "Favorites", section: "PERSONAL" },
  { id: "on-chart", label: "On chart", section: "PERSONAL" },
  { id: "basic", label: "Basic · OHLCV", section: "BUILT INS" },
  { id: "orderflow", label: "Orderflow · L1", section: "BUILT INS" },
  { id: "orderbook", label: "Orderbook · L2", section: "BUILT INS" },
  { id: "all", label: "All indicators", section: "LIBRARY" },
];

interface IndicatorsMenuProps {
  /** The indicators on the chart. Starring one (Favorites) is separate and kept by the menu itself. */
  active: ReadonlySet<IndicatorId>;
  onToggleActive: (id: IndicatorId) => void;
}

export function IndicatorsMenu({ active, onToggleActive }: IndicatorsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>("basic");
  const [query, setQuery] = useState("");
  const [starred, setStarred] = useState(loadStarred);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // A search looks through every indicator, whichever group is selected: the group an indicator sits in is not
  // something a user should have to know before finding it.
  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;
  const results = useMemo(() => INDICATOR_REGISTRY.filter((def) => {
    if (searching) return `${def.label} ${indicatorFamily(def)}`.toLowerCase().includes(needle);
    return view === "all" ||
      (view === "favorites" && starred.has(def.id)) ||
      (view === "on-chart" && active.has(def.id)) ||
      indicatorFamily(def) === view;
  }), [view, needle, searching, starred, active]);

  function closeMenu() {
    setIsOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }

  function toggleStar(id: IndicatorId) {
    const next = new Set(starred);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setStarred(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* storage may be unavailable */ }
  }

  useEffect(() => {
    if (!isOpen) return;
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  return (
    <div className="indicators-menu">
      <button ref={triggerRef} type="button" className={`indicators-trigger${isOpen ? " active" : ""}`}
        onClick={() => setIsOpen((open) => !open)} aria-haspopup="dialog" aria-expanded={isOpen}>
        ◇ Indicators
      </button>
      {isOpen && <>
        <div className="menu-backdrop" onClick={closeMenu} aria-hidden="true" />
        <div ref={dialogRef} className="indicators-popover" role="dialog" aria-modal="true" aria-label="Indicators">
          <div className="indicators-dialog-header"><strong>Indicators</strong><button type="button" onClick={closeMenu} aria-label="Close indicators">×</button></div>
          <div className="indicators-dialog-search"><input ref={searchRef} type="search" placeholder="Search indicators" aria-label="Search indicators" value={query} onChange={(event) => setQuery(event.target.value)} /><span aria-hidden="true">⌕</span></div>
          <div className="indicators-dialog-body">
            <nav className="indicators-dialog-nav" aria-label="Indicator categories">
              {VIEWS.map((item, index) => <div key={item.id}>
                {(index === 0 || VIEWS[index - 1].section !== item.section) && <div className="indicators-nav-section">{item.section}</div>}
                <button type="button" className={view === item.id && !searching ? "active" : ""} aria-current={view === item.id && !searching ? "page" : undefined} onClick={() => { setView(item.id); setQuery(""); }}>{item.label}</button>
              </div>)}
            </nav>
            <div className="indicators-results">
              <div className="indicators-results-heading"><span>{searching ? "Search · all indicators" : VIEWS.find((item) => item.id === view)?.label}</span><span>{results.length} indicators</span></div>
              {results.length === 0 && <div className="indicators-empty">No indicators found.</div>}
              {results.map((def) => <div key={def.id} className="indicators-result">
                <button type="button" className="indicators-star" aria-label={`${starred.has(def.id) ? "Remove" : "Add"} ${def.label} ${starred.has(def.id) ? "from" : "to"} favorites`} aria-pressed={starred.has(def.id)} onClick={() => toggleStar(def.id)}>{starred.has(def.id) ? "★" : "☆"}</button>
                <button type="button" className="indicators-row" aria-pressed={active.has(def.id)} onClick={() => onToggleActive(def.id)}><span className="indicators-row-label">{def.label}</span><span className="indicators-row-action">{active.has(def.id) ? "On chart ✓" : "Add to chart"}</span></button>
              </div>)}
            </div>
          </div>
        </div>
      </>}
    </div>
  );
}
