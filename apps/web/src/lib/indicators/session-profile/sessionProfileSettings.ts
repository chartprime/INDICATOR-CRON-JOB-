import type { LineStyleKind } from "../../chart/draw/line";
import {
  DEFAULT_VOLUME_PROFILE_SETTINGS,
  type VolumeProfileSettings,
} from "../volume-profile/volumeProfilePrimitive";
import {
  DEFAULT_NET_DELTA_PROFILE_SETTINGS,
  type NetDeltaProfileSettings,
} from "../net-delta-profile/netDeltaProfilePrimitive";
import {
  DEFAULT_DELTA_PROFILE_SETTINGS,
  type DeltaProfileSettings,
} from "../delta-profile/deltaProfilePrimitive";
import {
  DEFAULT_DELTA_VALUE_AREA_PCT,
  MAX_VALUE_AREA_PCT,
  MIN_VALUE_AREA_PCT,
} from "../volume-profile/deltaProfileLevels";
import {
  DEFAULT_BIN_SIZE_MULTIPLIER,
  DEFAULT_PROFILE_SESSION_MODE,
  DEFAULT_VOLUME_PROFILE_PERIOD_MS,
  PROFILE_PERIOD_PRESETS,
  isBinSizeMultiplier,
  type ProfileSessionMode,
} from "../volume-profile/profileSessionConfig";
import {
  LEGACY_SESSION_PROFILE_IDS,
  type LegacySessionProfileId,
  type SessionProfileView,
} from "./sessionProfileIds";

export type { SessionProfileView };

export const SESSION_PROFILE_VIEW_OPTIONS: readonly {
  value: SessionProfileView;
  label: string;
}[] = [
  { value: "volumeProfile", label: "Volume Profile" },
  { value: "netDeltaProfile", label: "Net Delta Profile" },
  { value: "deltaProfile", label: "Delta Profile" },
];

export function sessionProfileViewLabel(view: SessionProfileView): string {
  return (
    SESSION_PROFILE_VIEW_OPTIONS.find((option) => option.value === view)
      ?.label ?? view
  );
}

/**
 * One settings object for all three views: the session/binning config the
 * server needs, plus a single palette. Two of the palette's fields are named
 * after what they mean in the delta views -- `buy`/`sell` -- and mean the
 * traded-volume bar and its sell-side share in the volume view; the volume
 * view's value area comes from the frame itself, so `valueAreaPercent` only
 * moves the levels the two delta views derive client-side.
 */
export interface SessionProfileIndicatorSettings {
  view: SessionProfileView;
  mode: ProfileSessionMode;
  periodMs: number;
  binSizeMultiplier: number;
  valueAreaPercent: number;
  vahValStyle: LineStyleKind;
  showPocLine: boolean;
  showValueAreaLines: boolean;
  buyColor: string;
  buyValueAreaColor: string;
  sellColor: string;
  sellValueAreaColor: string;
  pocColor: string;
  vahValColor: string;
}

/** Defaults are the Volume Profile palette, so the base view keeps the look it
 * shipped with; the two delta views start from that same palette. */
export const DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS: SessionProfileIndicatorSettings =
  {
    view: "volumeProfile",
    mode: DEFAULT_PROFILE_SESSION_MODE,
    periodMs: DEFAULT_VOLUME_PROFILE_PERIOD_MS,
    binSizeMultiplier: DEFAULT_BIN_SIZE_MULTIPLIER,
    valueAreaPercent: DEFAULT_DELTA_VALUE_AREA_PCT,
    vahValStyle: DEFAULT_VOLUME_PROFILE_SETTINGS.vahValStyle,
    showPocLine: DEFAULT_VOLUME_PROFILE_SETTINGS.showPocLine,
    showValueAreaLines: DEFAULT_VOLUME_PROFILE_SETTINGS.showValueAreaLines,
    buyColor: DEFAULT_VOLUME_PROFILE_SETTINGS.outsideValueAreaColor,
    buyValueAreaColor: DEFAULT_VOLUME_PROFILE_SETTINGS.valueAreaColor,
    sellColor: DEFAULT_VOLUME_PROFILE_SETTINGS.sellColor,
    sellValueAreaColor: DEFAULT_VOLUME_PROFILE_SETTINGS.sellValueAreaColor,
    pocColor: DEFAULT_VOLUME_PROFILE_SETTINGS.pocColor,
    vahValColor: DEFAULT_VOLUME_PROFILE_SETTINGS.vahValColor,
  };

export function sessionProfileVolumeSettings(
  settings: SessionProfileIndicatorSettings,
): VolumeProfileSettings {
  return {
    ...DEFAULT_VOLUME_PROFILE_SETTINGS,
    valueAreaColor: settings.buyValueAreaColor,
    outsideValueAreaColor: settings.buyColor,
    sellColor: settings.sellColor,
    sellValueAreaColor: settings.sellValueAreaColor,
    pocColor: settings.pocColor,
    vahValColor: settings.vahValColor,
    vahValStyle: settings.vahValStyle,
    showPocLine: settings.showPocLine,
    showValueAreaLines: settings.showValueAreaLines,
  };
}

export function sessionProfileNetDeltaSettings(
  settings: SessionProfileIndicatorSettings,
): NetDeltaProfileSettings {
  return {
    ...DEFAULT_NET_DELTA_PROFILE_SETTINGS,
    buyColor: settings.buyColor,
    buyValueAreaColor: settings.buyValueAreaColor,
    sellColor: settings.sellColor,
    sellValueAreaColor: settings.sellValueAreaColor,
    pocColor: settings.pocColor,
    vahValColor: settings.vahValColor,
    valueAreaPercent: settings.valueAreaPercent,
    vahValStyle: settings.vahValStyle,
    showPocLine: settings.showPocLine,
    showValueAreaLines: settings.showValueAreaLines,
  };
}

export function sessionProfileDeltaSettings(
  settings: SessionProfileIndicatorSettings,
): DeltaProfileSettings {
  return {
    ...DEFAULT_DELTA_PROFILE_SETTINGS,
    buyColor: settings.buyColor,
    buyValueAreaColor: settings.buyValueAreaColor,
    sellColor: settings.sellColor,
    sellValueAreaColor: settings.sellValueAreaColor,
    pocColor: settings.pocColor,
    vahValColor: settings.vahValColor,
    valueAreaPercent: settings.valueAreaPercent,
    vahValStyle: settings.vahValStyle,
    showPocLine: settings.showPocLine,
    showValueAreaLines: settings.showValueAreaLines,
  };
}

/**
 * Migration off the three indicators this one replaced. Rules, in full:
 *
 * - The view is the legacy indicator the trader had on the chart: favourited
 *   and not hidden, else favourited, else (no favourites to go by) one whose
 *   own settings were saved. Saved settings break a tie, then a delta view
 *   wins over Volume Profile: a trader who stacked two of them was working in
 *   the delta one, Volume Profile being the base every chart had.
 * - mode/periodMs/binSizeMultiplier come from the legacy Volume Profile entry
 *   that owned them, falling back to the legacy Net Delta Profile entry, which
 *   stored the same fields against its own copy of the schema.
 * - A delta view keeps the palette the trader saw: its own saved palette, or
 *   that view's shipped defaults when it was never customized, so the
 *   migration never recolours a profile. A trader who customized both delta
 *   views keeps the chosen one's; one palette cannot honour both.
 */
const LEGACY_VIEW_PRIORITY: readonly LegacySessionProfileId[] = [
  "deltaProfile",
  "netDeltaProfile",
  "volumeProfile",
];

/** What the trader had of the legacy indicators: favourited ids and their visibility. */
export interface LegacySessionProfileUse {
  favorited: readonly LegacySessionProfileId[];
  visibility: Partial<Record<LegacySessionProfileId, boolean>>;
}

const NO_LEGACY_USE: LegacySessionProfileUse = { favorited: [], visibility: {} };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function color(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    ? value
    : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function mode(value: unknown): ProfileSessionMode | null {
  return value === "continuous" || value === "per_candle" ? value : null;
}

function periodMs(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= PROFILE_PERIOD_PRESETS[0].ms
    ? value
    : null;
}

function valueAreaPercent(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_VALUE_AREA_PCT &&
    value <= MAX_VALUE_AREA_PCT
    ? value
    : null;
}

function vahValStyle(value: unknown): LineStyleKind | null {
  return value === "solid" || value === "dashed" || value === "dotted"
    ? value
    : null;
}

function legacyEntry(
  legacy: Partial<Record<LegacySessionProfileId, unknown>>,
  id: LegacySessionProfileId,
): Record<string, unknown> | null {
  const entry = legacy[id];
  return record(entry) ? entry : null;
}

export function legacySessionProfileView(
  legacy: Partial<Record<LegacySessionProfileId, unknown>>,
  use: LegacySessionProfileUse = NO_LEGACY_USE,
): SessionProfileView {
  const shown = use.favorited.filter((id) => use.visibility[id] !== false);
  const saved = LEGACY_VIEW_PRIORITY.filter(
    (id) => legacyEntry(legacy, id) !== null,
  );
  const pool =
    shown.length > 0 ? shown : use.favorited.length > 0 ? use.favorited : saved;
  return (
    LEGACY_VIEW_PRIORITY.find(
      (id) => pool.includes(id) && legacyEntry(legacy, id) !== null,
    ) ??
    LEGACY_VIEW_PRIORITY.find((id) => pool.includes(id)) ??
    "volumeProfile"
  );
}

export type SessionProfilePalette = Pick<
  SessionProfileIndicatorSettings,
  | "buyColor"
  | "buyValueAreaColor"
  | "sellColor"
  | "sellValueAreaColor"
  | "pocColor"
  | "vahValColor"
  | "valueAreaPercent"
  | "vahValStyle"
  | "showPocLine"
  | "showValueAreaLines"
>;

/**
 * The palette a view shipped with as its own indicator, before the merge.
 * Volume Profile's is the merged default; the two delta views had their own.
 */
export function shippedSessionProfilePalette(
  view: SessionProfileView,
): SessionProfilePalette {
  const shipped =
    view === "netDeltaProfile"
      ? DEFAULT_NET_DELTA_PROFILE_SETTINGS
      : view === "deltaProfile"
        ? DEFAULT_DELTA_PROFILE_SETTINGS
        : DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS;
  return {
    buyColor: shipped.buyColor,
    buyValueAreaColor: shipped.buyValueAreaColor,
    sellColor: shipped.sellColor,
    sellValueAreaColor: shipped.sellValueAreaColor,
    pocColor: shipped.pocColor,
    vahValColor: shipped.vahValColor,
    valueAreaPercent: shipped.valueAreaPercent,
    vahValStyle: shipped.vahValStyle,
    showPocLine: shipped.showPocLine,
    showValueAreaLines: shipped.showValueAreaLines,
  };
}

export function migrateLegacySessionProfileSettings(
  legacy: Partial<Record<LegacySessionProfileId, unknown>>,
  use: LegacySessionProfileUse = NO_LEGACY_USE,
): SessionProfileIndicatorSettings {
  const view = legacySessionProfileView(legacy, use);
  const settings: SessionProfileIndicatorSettings = {
    ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
    view,
  };
  for (const owner of ["volumeProfile", "netDeltaProfile"] as const) {
    const entry = legacyEntry(legacy, owner);
    if (entry === null) continue;
    settings.mode = mode(entry.mode) ?? settings.mode;
    settings.periodMs = periodMs(entry.periodMs) ?? settings.periodMs;
    settings.binSizeMultiplier =
      isBinSizeMultiplier(entry.binSizeMultiplier)
        ? entry.binSizeMultiplier
        : settings.binSizeMultiplier;
    break;
  }
  if (view === "volumeProfile") return settings;
  // The view's own shipped palette first, then whatever of it was saved.
  Object.assign(settings, shippedSessionProfilePalette(view));
  const palette = legacyEntry(legacy, view);
  if (palette !== null) {
    settings.buyColor = color(palette.buyColor) ?? settings.buyColor;
    settings.buyValueAreaColor =
      color(palette.buyValueAreaColor) ?? settings.buyValueAreaColor;
    settings.sellColor = color(palette.sellColor) ?? settings.sellColor;
    settings.sellValueAreaColor =
      color(palette.sellValueAreaColor) ?? settings.sellValueAreaColor;
    settings.pocColor = color(palette.pocColor) ?? settings.pocColor;
    settings.vahValColor = color(palette.vahValColor) ?? settings.vahValColor;
    settings.valueAreaPercent =
      valueAreaPercent(palette.valueAreaPercent) ?? settings.valueAreaPercent;
    settings.vahValStyle = vahValStyle(palette.vahValStyle) ?? settings.vahValStyle;
    settings.showPocLine = boolean(palette.showPocLine) ?? settings.showPocLine;
    settings.showValueAreaLines =
      boolean(palette.showValueAreaLines) ?? settings.showValueAreaLines;
  }
  return settings;
}

/** The merged indicator is hidden only if every legacy entry that recorded a
 * visibility was hidden. */
export function inheritedSessionProfileVisibility(
  legacy: Partial<Record<LegacySessionProfileId, boolean>>,
): boolean | undefined {
  const recorded = LEGACY_SESSION_PROFILE_IDS.map((id) => legacy[id]).filter(
    (value): value is boolean => typeof value === "boolean",
  );
  if (recorded.length === 0) return undefined;
  return recorded.some((value) => value);
}
