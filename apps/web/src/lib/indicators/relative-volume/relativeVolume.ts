import { draw } from "../../chart/draw";
import type { FillOptions } from "../../chart/draw/fill";
import type { TableHandle } from "../../chart/draw/table";
import type { LineOutputSpec, PlacementSpec, RuntimeIndicatorDef, SettingsFieldSchema } from "../../chart/indicatorTypes";
import {
  RVOL_DEFAULT_MIN_SESSIONS,
  RVOL_DEFAULT_SESSIONS,
  RVOL_MAX_SESSIONS_SETTING,
  RVOL_MIN_SESSIONS_SETTING,
  RVOL_ROLLING_LENGTH,
  createRelativeVolumeEngine,
  type RelativeVolumeEngine,
  type RvolClock,
  type RvolReading,
} from "./relativeVolumeMath";

/**
 * Relative Volume (Time of Day): this bar's volume against the median volume
 * of the same start minute on the last `sessions` matching bars, so the open,
 * the close and the London/New York overlap are compared with themselves
 * rather than with the quiet lunch hour. Own pane, one line, one fill above 1,
 * a circle on bars at or above the "unusual" threshold, and a three-row table.
 * Candle-only: reads `bar.volume`, `bar.ts_open`, `bar.interval_ms`,
 * `bar.closed` and `bar.provider` (the provider only picks the clock).
 */

export const RVOL_DEFAULT_HOT_THRESHOLD = 2;
/** A drawn marker is enlarged from this ratio up (brief amendment 6). */
export const RVOL_LARGE_MARKER_FROM = 3;
/** Fixed for this version: a colour picker would force a replay over the retained bars, which can change a number. */
export const RVOL_LINE_COLOR = "#8672b3";
export const RVOL_HOT_COLOR = "#2563eb";
export const RVOL_BELOW_ONE_COLOR = "#787b86";
export const RVOL_ROLLING_COLOR = "#787b86";
export const RVOL_FILL_COLOR_ABOVE = "rgba(134,114,179,0.15)";
export const RVOL_TABLE_TEXT_COLOR = "#d1d4dc";
export const RVOL_PROVISIONAL_ALPHA = 0.5;
export const RVOL_UNAVAILABLE = "—";

export interface RelativeVolumeSettings {
  sessions: number;
  hotThreshold: number;
  minSessions: number;
  clock: RvolClock;
  showRolling: boolean;
  showMarkers: boolean;
}

export interface RelativeVolumeState {
  engine: RelativeVolumeEngine;
  table: TableHandle;
  reading: RvolReading | null;
  /** The rolling line's value for this bar, null when the line is switched off. */
  rollingLine: number | null;
}

export const RELATIVE_VOLUME_DEFAULT_SETTINGS: RelativeVolumeSettings = Object.freeze({
  sessions: RVOL_DEFAULT_SESSIONS,
  hotThreshold: RVOL_DEFAULT_HOT_THRESHOLD,
  minSessions: RVOL_DEFAULT_MIN_SESSIONS,
  clock: "auto",
  showRolling: false,
  showMarkers: true,
});

const RVOL_FILL_OPTIONS: FillOptions = Object.freeze({ colorAbove: RVOL_FILL_COLOR_ABOVE, colorBelow: "transparent" });
const RVOL_LINE_PROVISIONAL = withAlpha(RVOL_LINE_COLOR, RVOL_PROVISIONAL_ALPHA);
const RVOL_HOT_PROVISIONAL = withAlpha(RVOL_HOT_COLOR, RVOL_PROVISIONAL_ALPHA);
const RVOL_BELOW_ONE_PROVISIONAL = withAlpha(RVOL_BELOW_ONE_COLOR, RVOL_PROVISIONAL_ALPHA);
const RVOL_ROLLING_PROVISIONAL = withAlpha(RVOL_ROLLING_COLOR, RVOL_PROVISIONAL_ALPHA);

/** `#rgb` or `#rrggbb` with an alpha; any other colour string is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex === null) return color;
  let digits = hex[1];
  if (digits.length === 3) digits = digits.split("").map((d) => d + d).join("");
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function isHot(reading: RvolReading | null, hotThreshold: number): boolean {
  return reading !== null && reading.rvol !== null && Number.isFinite(hotThreshold) && reading.rvol >= hotThreshold;
}

/** The rvol line's colour for the bar: unusual, at or above 1, below 1; provisional while the bar forms. */
export function rvolLineColor(reading: RvolReading | null, settings: RelativeVolumeSettings): string {
  const provisional = reading !== null && !reading.confirmed;
  if (reading !== null && reading.rvol !== null) {
    if (isHot(reading, settings.hotThreshold)) return provisional ? RVOL_HOT_PROVISIONAL : RVOL_HOT_COLOR;
    if (reading.rvol < 1) return provisional ? RVOL_BELOW_ONE_PROVISIONAL : RVOL_BELOW_ONE_COLOR;
  }
  return provisional ? RVOL_LINE_PROVISIONAL : RVOL_LINE_COLOR;
}

function rollingLineColor(reading: RvolReading | null): string {
  return reading !== null && !reading.confirmed ? RVOL_ROLLING_PROVISIONAL : RVOL_ROLLING_COLOR;
}

function formatRatio(value: number | null): string {
  return value === null ? RVOL_UNAVAILABLE : `${value.toFixed(1)}×`;
}

/** Rule 11, first match wins; the empty string means the row is blank because the bar is ready and closed. */
export function statusText(reading: RvolReading | null): string {
  if (reading === null) return "";
  switch (reading.status) {
    case "unsupported":
      return "Needs 1m to 1h";
    case "noVolume":
      return "No usable volume";
    case "learning":
      return `Learning · ${reading.priorCount} of ${reading.requiredPrior} prior`;
    case "noBaseline":
      return "No usable baseline";
    case "forming":
      return "Forming · vs full bar";
    default:
      return "";
  }
}

export interface RvolTableRow {
  text: string;
  color: string;
}

/** The three rows of the top-right table: value, rolling comparison, status. */
export function relativeVolumeTableRows(reading: RvolReading | null, settings: RelativeVolumeSettings): readonly RvolTableRow[] {
  const rvol = reading?.rvol ?? null;
  const rolling = reading?.rolling ?? null;
  return [
    { text: `RVOL ${formatRatio(rvol)} · ${reading?.priorCount ?? 0} prior`, color: rvolLineColor(reading, settings) },
    { text: `Rolling ${formatRatio(rolling)} · ${RVOL_ROLLING_LENGTH} bars`, color: RVOL_TABLE_TEXT_COLOR },
    { text: statusText(reading), color: RVOL_TABLE_TEXT_COLOR },
  ];
}

const RELATIVE_VOLUME_LINES: readonly LineOutputSpec<RelativeVolumeState, RelativeVolumeSettings>[] = [
  // The colours are constants, so `recolor` keeps every bar's colour as it is:
  // a settings update that changes no recompute key never replays (a replay
  // over the retained bars can change a number, which a cosmetic change must not).
  { key: "rvol", lineWidth: 2, color: (state, settings) => rvolLineColor(state.reading, settings), recolor: (current) => current ?? RVOL_LINE_COLOR },
  { key: "rolling", lineWidth: 1, color: (state) => rollingLineColor(state.reading), recolor: (current) => current ?? RVOL_ROLLING_COLOR },
];

const RELATIVE_VOLUME_PLACEMENT: PlacementSpec = {
  kind: "ownPane",
  priceLines: [1, 2, 3],
  autoscaleRange: { min: 0, max: 4 },
};

export const RELATIVE_VOLUME_SETTINGS_SCHEMA: readonly SettingsFieldSchema<RelativeVolumeSettings>[] = [
  {
    kind: "numeric",
    key: "sessions",
    label: "Lookback (prior bars)",
    min: RVOL_MIN_SESSIONS_SETTING,
    max: RVOL_MAX_SESSIONS_SETTING,
    step: 1,
    affects: "recompute",
  },
  { kind: "staticHint", text: "Bars at this time of day on earlier sessions. Replays every bar." },
  { kind: "numeric", key: "hotThreshold", label: "Unusual above (×)", min: 1, max: 10, step: 0.5, affects: "recompute" },
  { kind: "staticHint", text: "Colours the line and marks the bar. Replays every bar." },
  { kind: "numeric", key: "minSessions", label: "Minimum prior bars", min: 1, max: 20, step: 1, affects: "recompute", tab: "advanced" },
  {
    kind: "select",
    key: "clock",
    label: "Clock",
    options: [
      { value: "auto", label: "Automatic" },
      { value: "newYork", label: "New York" },
      { value: "utc", label: "UTC" },
    ],
    affects: "recompute",
    tab: "advanced",
  },
  { kind: "boolean", key: "showRolling", label: "Show rolling 20", affects: "recompute", tab: "visibility" },
  { kind: "boolean", key: "showMarkers", label: "Show unusual markers", affects: "recompute", tab: "visibility" },
];

export const relativeVolumeIndicator: RuntimeIndicatorDef<RelativeVolumeState, RelativeVolumeSettings> = {
  kind: "runtime",
  id: "relativeVolume",
  label: "Relative Volume (Time of Day)",
  category: "technical",
  defaultSettings: RELATIVE_VOLUME_DEFAULT_SETTINGS,
  settingsSchema: RELATIVE_VOLUME_SETTINGS_SCHEMA,
  lines: RELATIVE_VOLUME_LINES,
  placement: RELATIVE_VOLUME_PLACEMENT,
  createState: (settings) => ({
    engine: createRelativeVolumeEngine({ sessions: settings.sessions, minSessions: settings.minSessions, clock: settings.clock }),
    table: draw.table(),
    reading: null,
    rollingLine: null,
  }),
  onBar: (ctx) => {
    const { bar, state, settings } = ctx;
    const reading = state.engine.onBar(bar);
    state.reading = reading;
    state.rollingLine = settings.showRolling ? reading.rolling : null;

    ctx.draw.fill(reading.rvol, 1, RVOL_FILL_OPTIONS);

    if (settings.showMarkers && isHot(reading, settings.hotThreshold)) {
      ctx.markers.plotshape({
        shape: "circle",
        position: "aboveBar",
        color: reading.confirmed ? RVOL_HOT_COLOR : RVOL_HOT_PROVISIONAL,
        size: reading.rvol !== null && reading.rvol >= RVOL_LARGE_MARKER_FROM ? 2 : 1,
      });
    }

    if (ctx.drawNow !== false) {
      const rows = relativeVolumeTableRows(reading, settings);
      for (let row = 0; row < rows.length; row += 1) {
        state.table.cell(row, 0, { text: rows[row].text, textColor: rows[row].color });
      }
    }
  },
  readOutput: (state) => ({
    rvol: state.reading?.rvol ?? null,
    rolling: state.rollingLine,
  }),
};
