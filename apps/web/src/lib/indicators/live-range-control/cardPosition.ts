export const CARD_POSITION_STORAGE_KEY = "terminal.live-range-control.card-position.v1";
export const CARD_MARGIN_PX = 4;

export interface CardPosition {
  x: number;
  y: number;
}

export interface BoxSize {
  width: number;
  height: number;
}

export function isCardPosition(value: unknown): value is CardPosition {
  if (value === null || typeof value !== "object") return false;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && typeof y === "number" && Number.isFinite(y) && y >= 0;
}

export function clampCardPosition(position: CardPosition, card: BoxSize, pane: BoxSize): CardPosition {
  const maxX = Math.max(0, pane.width - card.width - CARD_MARGIN_PX);
  const maxY = Math.max(0, pane.height - card.height - CARD_MARGIN_PX);
  return {
    x: Math.round(Math.min(maxX, Math.max(Math.min(CARD_MARGIN_PX, maxX), position.x))),
    y: Math.round(Math.min(maxY, Math.max(Math.min(CARD_MARGIN_PX, maxY), position.y))),
  };
}

function storageOf(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadCardPosition(storage?: Storage | null): CardPosition | null {
  const store = storageOf(storage);
  if (store === null) return null;
  try {
    const raw = store.getItem(CARD_POSITION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCardPosition(parsed) ? { x: parsed.x, y: parsed.y } : null;
  } catch {
    return null;
  }
}

export function saveCardPosition(position: CardPosition | null, storage?: Storage | null): void {
  const store = storageOf(storage);
  if (store === null) return;
  try {
    if (position === null) store.removeItem(CARD_POSITION_STORAGE_KEY);
    else store.setItem(CARD_POSITION_STORAGE_KEY, JSON.stringify({ x: position.x, y: position.y }));
  } catch {
    void 0;
  }
}
