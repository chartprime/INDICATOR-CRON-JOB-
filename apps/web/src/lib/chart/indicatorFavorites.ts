import { INDICATOR_REGISTRY, type IndicatorId } from "./indicatorRegistry";
import {
  LEGACY_SESSION_PROFILE_IDS,
  SESSION_PROFILE_INDICATOR_ID,
  legacySessionProfileFavorited,
  type LegacySessionProfileId,
} from "../indicators/session-profile/sessionProfileIds";

export const FAVORITES_STORAGE_KEY = "terminal.indicators.favorites";

export function loadIndicatorFavorites(storageKey = FAVORITES_STORAGE_KEY): Set<IndicatorId> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const stored = new Set(
      parsed.filter((id): id is string => typeof id === "string"),
    );
    const valid = parsed.filter(
      (id): id is IndicatorId => typeof id === "string" && INDICATOR_REGISTRY.some((def) => def.id === id),
    );
    const favorites = new Set(valid);
    // Volume Profile, Net Delta Profile and Delta Profile are one indicator
    // now; a workspace that had any of them added keeps it, once.
    if (
      !favorites.has(SESSION_PROFILE_INDICATOR_ID) &&
      legacySessionProfileFavorited(stored)
    ) {
      favorites.add(SESSION_PROFILE_INDICATOR_ID);
    }
    return favorites;
  } catch {
    return new Set();
  }
}

/**
 * Which of the three indicators the session profile replaced are still listed
 * under this favourites key: the migration reads them to open the merged
 * indicator on the view the trader actually had on the chart.
 */
export function storedLegacySessionProfileFavorites(
  storageKey = FAVORITES_STORAGE_KEY,
): LegacySessionProfileId[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return LEGACY_SESSION_PROFILE_IDS.filter((id) => parsed.includes(id));
  } catch {
    return [];
  }
}

export function saveIndicatorFavorites(
  favorites: ReadonlySet<IndicatorId>,
  storageKey = FAVORITES_STORAGE_KEY,
): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...favorites]));
  } catch {
  }
}
