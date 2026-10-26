import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LIVE_TIMEFRAME_MENU_OPTIONS, type TimeframeMenuOption } from "../../lib/chart/timeframeMenuOptions";

const FAVORITES_STORAGE_KEY = "terminal.timeframe.favorites";
const DEFAULT_FAVORITE_LABELS = ["1m", "5m", "15m", "1h", "4h", "1D"];

function fallbackFavorites(
  options: readonly TimeframeMenuOption[],
  defaultFavoriteIds: readonly string[],
): Set<string> {
  const validIds = new Set(options.map((option) => option.id));
  const favorites = defaultFavoriteIds.filter((id) => validIds.has(id));
  return new Set(favorites.length > 0 ? favorites : [options[0].id]);
}

function loadFavorites(
  storageKey: string,
  options: readonly TimeframeMenuOption[],
  defaultFavoriteIds: readonly string[],
): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallbackFavorites(options, defaultFavoriteIds);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallbackFavorites(options, defaultFavoriteIds);
    const valid = parsed.filter(
      (id): id is string => typeof id === "string" && options.some((option) => option.id === id),
    );
    return valid.length > 0 ? new Set(valid) : fallbackFavorites(options, defaultFavoriteIds);
  } catch {
    return fallbackFavorites(options, defaultFavoriteIds);
  }
}

interface TimeframeMenuProps {
  selectedId: string;
  onTimeframeSelect: (id: string) => void;
  options?: readonly TimeframeMenuOption[];
  favoriteStorageKey?: string;
  defaultFavoriteIds?: readonly string[];
}

export function TimeframeMenu({
  selectedId,
  onTimeframeSelect,
  options = LIVE_TIMEFRAME_MENU_OPTIONS,
  favoriteStorageKey = FAVORITES_STORAGE_KEY,
  defaultFavoriteIds = DEFAULT_FAVORITE_LABELS,
}: TimeframeMenuProps) {
  if (options.length === 0 || new Set(options.map((option) => option.id)).size !== options.length) {
    throw new RangeError("TimeframeMenu requires uniquely identified timeframe options");
  }
  const [favorites, setFavorites] = useState<Set<string>>(() =>
    loadFavorites(favoriteStorageKey, options, defaultFavoriteIds));
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const rowSelectRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const closeMenu = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    try {
      localStorage.setItem(favoriteStorageKey, JSON.stringify([...favorites]));
    } catch {
    }
  }, [favoriteStorageKey, favorites]);

  useEffect(() => {
    if (!isOpen) return;
    popoverRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  function moveRowFocus(fromIndex: number, delta: number): void {
    const count = options.length;
    rowSelectRefs.current[(fromIndex + delta + count) % count]?.focus();
  }

  function onRowSelectKeyDown(index: number) {
    return (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        moveRowFocus(index, 1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        moveRowFocus(index, -1);
      } else if (event.key === "Home") {
        event.preventDefault();
        rowSelectRefs.current[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        rowSelectRefs.current[options.length - 1]?.focus();
      }
    };
  }

  function toggleFavorite(label: string) {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        if (next.size <= 1) return next;
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  const quickAccess = options.filter((option) => favorites.has(option.id) || option.id === selectedId);

  return (
    <div className="tf-menu">
      {quickAccess.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`tf-pill${option.id === selectedId ? " active" : ""}`}
          onClick={() => onTimeframeSelect(option.id)}
        >
          {option.label}
        </button>
      ))}
      <button
        ref={triggerRef}
        type="button"
        className={`tf-menu-trigger${isOpen ? " active" : ""}`}
        onClick={() => setIsOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label="More timeframes"
        title="More timeframes"
      >
        ▾
      </button>
      {isOpen && (
        <>
          <div className="menu-backdrop" onClick={closeMenu} aria-hidden="true" />
          <div ref={popoverRef} className="tf-menu-popover" role="dialog" aria-label="Timeframes">
            <div className="menu-popover-title">Timeframes</div>
            {options.map((option, index) => {
              const favorited = favorites.has(option.id);
              return (
                <div key={option.id} className="tf-menu-row">
                  <button
                    ref={(node) => {
                      rowSelectRefs.current[index] = node;
                    }}
                    type="button"
                    className={`tf-menu-row-select${option.id === selectedId ? " active" : ""}`}
                    onClick={() => {
                      onTimeframeSelect(option.id);
                      closeMenu();
                    }}
                    onKeyDown={onRowSelectKeyDown(index)}
                  >
                    {option.label}
                  </button>
                  <button
                    type="button"
                    className={`tf-menu-star${favorited ? " favorited" : ""}`}
                    onClick={() => toggleFavorite(option.id)}
                    aria-pressed={favorited}
                    aria-label={favorited ? `Remove ${option.label} from favorites` : `Add ${option.label} to favorites`}
                    title={favorited ? "Remove from favorites" : "Add to favorites"}
                  >
                    {favorited ? "★" : "☆"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
