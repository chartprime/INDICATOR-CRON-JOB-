import { KILLZONE_SESSIONS, type KillzoneId } from "../indicators/killzones/killzones";
import {
  INDICATOR_REGISTRY,
  RUNTIME_INDICATOR_DEFS,
  type IndicatorId,
} from "./indicatorRegistry";
import type { SettingsFieldSchema } from "./indicatorTypes";
import {
  LEGACY_SESSION_PROFILE_IDS,
  SESSION_PROFILE_INDICATOR_ID,
  type LegacySessionProfileId,
} from "../indicators/session-profile/sessionProfileIds";
import {
  inheritedSessionProfileVisibility,
  migrateLegacySessionProfileSettings,
} from "../indicators/session-profile/sessionProfileSettings";
import { storedLegacySessionProfileFavorites } from "./indicatorFavorites";

export const HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY = "terminal.historical-indicators.preferences.v1";
export const LIVE_INDICATOR_PREFERENCES_STORAGE_KEY = "terminal.live-indicators.preferences.v1";

export type HistoricalIndicatorPreferences = Readonly<{
  visibility: Partial<Record<IndicatorId, boolean>>;
  runtimeSettingsById: Partial<Record<IndicatorId, unknown>>;
  killzoneSessions: ReadonlySet<KillzoneId>;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function indicatorId(value: string): value is IndicatorId {
  return INDICATOR_REGISTRY.some((definition) => definition.id === value);
}

function numericValue(value: unknown, min: number, max: number, step: number): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return false;
  if (step <= 0) return true;
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function restoreField(
  field: SettingsFieldSchema<Record<string, unknown>>,
  candidate: unknown,
  defaultValue: unknown,
): unknown {
  switch (field.kind) {
    case "boolean":
      return typeof candidate === "boolean" ? candidate : defaultValue;
    case "numeric":
    case "slider": {
      if (numericValue(candidate, field.min, field.max, field.step)) return candidate;
      if (field.clampOnRestore !== true || typeof candidate !== "number" || !Number.isFinite(candidate)) return defaultValue;
      const bounded = Math.min(field.max, Math.max(field.min, candidate));
      const clamped = field.step <= 0 ? bounded : field.min + Math.round((bounded - field.min) / field.step) * field.step;
      return numericValue(clamped, field.min, field.max, field.step) ? clamped : defaultValue;
    }
    case "radioGroup":
    case "select":
      return field.options.some((option) => Object.is(option.value, candidate)) ? candidate : defaultValue;
    case "color":
      return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 64
        ? candidate
        : defaultValue;
    case "checkboxList":
      if (!Array.isArray(candidate) || !candidate.every((value) => field.options.some((option) => Object.is(option.value, value)))) {
        return defaultValue;
      }
      return new Set(candidate);
    case "custom":
      return field.isValidPersistedValue?.(candidate) === true ? candidate : defaultValue;
    case "staticHint":
      return defaultValue;
  }
}

export function restoreFields<T>(
  schema: readonly SettingsFieldSchema<T>[],
  candidate: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...defaults };
  for (const field of schema as readonly SettingsFieldSchema<Record<string, unknown>>[]) {
    if (field.kind === "staticHint" || field.key === undefined || !Object.hasOwn(candidate, field.key)) continue;
    settings[field.key as string] = restoreField(field, candidate[field.key as string], settings[field.key as string]);
  }
  return settings;
}

export function persistableFields<T>(
  schema: readonly SettingsFieldSchema<T>[],
  settings: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of schema as readonly SettingsFieldSchema<Record<string, unknown>>[]) {
    if (field.kind === "staticHint" || field.key === undefined || !Object.hasOwn(settings, field.key)) continue;
    const value = settings[field.key as string];
    const restored = restoreField(field, value instanceof Set ? [...value] : value, defaults[field.key as string]);
    values[field.key as string] = restored instanceof Set ? [...restored] : restored;
  }
  return values;
}

function restoreSettings(raw: unknown): Partial<Record<IndicatorId, unknown>> {
  if (!record(raw)) return {};
  const restored: Partial<Record<IndicatorId, unknown>> = {};
  for (const definition of RUNTIME_INDICATOR_DEFS) {
    const schema = definition.persistenceSchema ?? definition.settingsSchema;
    if (!indicatorId(definition.id) || schema === undefined || schema.length === 0) continue;
    const candidate = raw[definition.id];
    if (!record(candidate) || !record(definition.defaultSettings)) continue;
    restored[definition.id] = restoreFields(schema, candidate, definition.defaultSettings);
  }
  return restored;
}

function persistableSettings(settingsById: Partial<Record<IndicatorId, unknown>>): Record<string, unknown> {
  const persisted: Record<string, unknown> = {};
  for (const definition of RUNTIME_INDICATOR_DEFS) {
    const schema = definition.persistenceSchema ?? definition.settingsSchema;
    if (!indicatorId(definition.id) || schema === undefined || schema.length === 0) continue;
    const settings = settingsById[definition.id];
    if (!record(settings) || !record(definition.defaultSettings)) continue;
    persisted[definition.id] = persistableFields(schema, settings, definition.defaultSettings);
  }
  return persisted;
}

function restoreVisibility(raw: unknown): Partial<Record<IndicatorId, boolean>> {
  if (!record(raw)) return {};
  const visibility: Partial<Record<IndicatorId, boolean>> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (indicatorId(id) && typeof value === "boolean") visibility[id] = value;
  }
  return visibility;
}

function legacyEntries<T>(
  raw: Record<string, unknown>,
  ids: readonly LegacySessionProfileId[],
): Partial<Record<LegacySessionProfileId, T>> {
  const entries: Partial<Record<LegacySessionProfileId, T>> = {};
  for (const id of ids) {
    if (Object.hasOwn(raw, id)) entries[id] = raw[id] as T;
  }
  return entries;
}

/**
 * Volume Profile, Net Delta Profile and Delta Profile are one indicator with a
 * view selector now, so a saved workspace written before the merge is read
 * through to it once: the view the trader had on the chart, its palette, the
 * session config and the visibility come across, and the legacy keys
 * disappear on the next save (restoreSettings/persistableSettings only know
 * the ids still in the registry).
 *
 * Any trace of the legacy indicators counts -- saved settings, a recorded
 * visibility, or a listing under the favourites key -- since most workspaces
 * only ever toggled them and never opened their settings.
 */
function migrateSessionProfilePreferences(
  raw: Record<string, unknown>,
  favoritesStorageKey: string | null,
): {
  visibility: Partial<Record<IndicatorId, boolean>>;
  settings: Partial<Record<IndicatorId, unknown>>;
} {
  const restoredVisibility = restoreVisibility(raw.visibility);
  const restoredSettings = restoreSettings(raw.runtimeSettingsById);
  const rawSettings = record(raw.runtimeSettingsById) ? raw.runtimeSettingsById : {};
  if (Object.hasOwn(rawSettings, SESSION_PROFILE_INDICATOR_ID)) {
    return { visibility: restoredVisibility, settings: restoredSettings };
  }
  const legacySettings = legacyEntries<unknown>(rawSettings, LEGACY_SESSION_PROFILE_IDS);
  const legacyVisibility = legacyEntries<unknown>(
    record(raw.visibility) ? raw.visibility : {},
    LEGACY_SESSION_PROFILE_IDS,
  );
  const recordedVisibility: Partial<Record<LegacySessionProfileId, boolean>> = {};
  for (const id of LEGACY_SESSION_PROFILE_IDS) {
    const value = legacyVisibility[id];
    if (typeof value === "boolean") recordedVisibility[id] = value;
  }
  const favorited =
    favoritesStorageKey === null ? [] : storedLegacySessionProfileFavorites(favoritesStorageKey);
  if (
    Object.keys(legacySettings).length === 0 &&
    Object.keys(recordedVisibility).length === 0 &&
    favorited.length === 0
  ) {
    return { visibility: restoredVisibility, settings: restoredSettings };
  }
  const visibility: Partial<Record<IndicatorId, boolean>> = {
    ...restoredVisibility,
  };
  if (!Object.hasOwn(visibility, SESSION_PROFILE_INDICATOR_ID)) {
    // With the favourites known, only the legacy indicators that were on the
    // chart count, and one never toggled was showing; without them, every
    // recorded visibility is all there is to go by.
    const inherited =
      favorited.length > 0
        ? favorited.some((id) => recordedVisibility[id] !== false)
        : inheritedSessionProfileVisibility(recordedVisibility);
    if (inherited !== undefined) visibility[SESSION_PROFILE_INDICATOR_ID] = inherited;
  }
  return {
    visibility,
    settings: {
      ...restoredSettings,
      [SESSION_PROFILE_INDICATOR_ID]: migrateLegacySessionProfileSettings(legacySettings, {
        favorited,
        visibility: recordedVisibility,
      }),
    },
  };
}

function defaultKillzoneSessions(): Set<KillzoneId> {
  return new Set(KILLZONE_SESSIONS.filter((session) => session.defaultShown).map((session) => session.id));
}

function restoreKillzoneSessions(raw: unknown): Set<KillzoneId> {
  if (!Array.isArray(raw)) return defaultKillzoneSessions();
  return new Set(raw.filter((value): value is KillzoneId =>
    typeof value === "string" && KILLZONE_SESSIONS.some((session) => session.id === value)));
}

/**
 * `favoritesStorageKey` is the favourites list that goes with these
 * preferences; the session profile migration reads which legacy profile was on
 * the chart from it. Null leaves it to the preferences alone.
 */
export function loadHistoricalIndicatorPreferences(
  storageKey = HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
  favoritesStorageKey: string | null = null,
): HistoricalIndicatorPreferences {
  try {
    const encoded = localStorage.getItem(storageKey);
    // No preferences saved yet still migrates a legacy profile the favourites list.
    const raw: unknown = encoded === null ? {} : JSON.parse(encoded);
    if (!record(raw)) throw new Error("historical indicator preferences are not an object");
    const migrated = migrateSessionProfilePreferences(raw, favoritesStorageKey);
    return Object.freeze({
      visibility: migrated.visibility,
      runtimeSettingsById: migrated.settings,
      killzoneSessions: restoreKillzoneSessions(raw.killzoneSessions),
    });
  } catch {
    return Object.freeze({ visibility: {}, runtimeSettingsById: {}, killzoneSessions: defaultKillzoneSessions() });
  }
}

export function saveHistoricalIndicatorPreferences(
  preferences: HistoricalIndicatorPreferences,
  storageKey = HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      visibility: restoreVisibility(preferences.visibility),
      runtimeSettingsById: persistableSettings(preferences.runtimeSettingsById),
      killzoneSessions: [...restoreKillzoneSessions([...preferences.killzoneSessions])],
    }));
  } catch {
  }
}
