/**
 * Identity of the merged indicator, and the names of the three renderings
 * (views) it draws. The view names are the three ids the separate Volume
 * Profile / Net Delta Profile / Delta Profile registrations used, which is what
 * lets a workspace saved before the merge be read straight onto them.
 *
 * Kept free of imports so the preference loaders (favorites, live and
 * historical indicator preferences) can recognise the legacy ids without
 * pulling in a primitive or a React component.
 */

export const SESSION_PROFILE_INDICATOR_ID = "sessionVolumeProfile";

export const SESSION_PROFILE_VIEWS = [
  "volumeProfile",
  "netDeltaProfile",
  "deltaProfile",
] as const;

export type SessionProfileView = (typeof SESSION_PROFILE_VIEWS)[number];

/** The three ids this indicator replaced, which are its view names. */
export type LegacySessionProfileId = SessionProfileView;

export const LEGACY_SESSION_PROFILE_IDS: readonly LegacySessionProfileId[] =
  SESSION_PROFILE_VIEWS;

/** True when a workspace had at least one of the three replaced indicators
 * added to the chart. */
export function legacySessionProfileFavorited(
  favorites: ReadonlySet<string>,
): boolean {
  return LEGACY_SESSION_PROFILE_IDS.some((id) => favorites.has(id));
}
