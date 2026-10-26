import type {
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import type { LineStyleKind } from "../../chart/draw/line";
import { ProfileVahValStyleField } from "../volume-profile/ProfileVahValStyleField";
import {
  MAX_BIN_SIZE_MULTIPLIER,
  MIN_BIN_SIZE_MULTIPLIER,
  PROFILE_PERIOD_PRESETS,
} from "../volume-profile/profileSessionConfig";
import {
  MAX_VALUE_AREA_PCT,
  MIN_VALUE_AREA_PCT,
} from "../volume-profile/deltaProfileLevels";
import { SESSION_PROFILE_INDICATOR_ID } from "./sessionProfileIds";
import {
  DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
  SESSION_PROFILE_VIEW_OPTIONS,
  type SessionProfileIndicatorSettings,
} from "./sessionProfileSettings";

const VAH_VAL_STYLES: ReadonlySet<unknown> = new Set<LineStyleKind>([
  "solid",
  "dashed",
  "dotted",
]);

const SESSION_PROFILE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<SessionProfileIndicatorSettings>[] =
  [
    {
      kind: "select",
      key: "view",
      label: "View",
      tab: "inputs",
      affects: "cosmetic",
      options: SESSION_PROFILE_VIEW_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    },
    {
      kind: "radioGroup",
      key: "mode",
      label: "Mode",
      tab: "inputs",
      affects: "recompute",
      options: [
        {
          value: "continuous",
          label: "Continuous",
          hint: "A rolling session profile that resets on a fixed schedule, independent of the chart's timeframe.",
        },
        {
          value: "per_candle",
          label: "Per-Candle",
          hint: "Resets every time the chart's timeframe changes, one profile per candle interval.",
        },
      ],
    },
    {
      kind: "select",
      key: "periodMs",
      label: "Session length",
      tab: "inputs",
      affects: "recompute",
      visibleIf: (settings) => settings.mode === "continuous",
      options: PROFILE_PERIOD_PRESETS.map((preset) => ({
        value: preset.ms,
        label: preset.label,
      })),
    },
    {
      kind: "slider",
      key: "binSizeMultiplier",
      label: "Bin size",
      tab: "inputs",
      affects: "recompute",
      min: MIN_BIN_SIZE_MULTIPLIER,
      max: MAX_BIN_SIZE_MULTIPLIER,
      step: 0.01,
    },
    {
      kind: "staticHint",
      tab: "inputs",
      text: "Scales the automatic bin size, which is derived from the instrument's own volatility (ATR). 2 is the default: higher is coarser bins and fewer rows, lower is finer bins and more rows.",
    },
    {
      kind: "slider",
      key: "valueAreaPercent",
      label: "Value area percent",
      tab: "inputs",
      affects: "cosmetic",
      min: MIN_VALUE_AREA_PCT,
      max: MAX_VALUE_AREA_PCT,
      step: 0.05,
      // The volume view's value area is the frame's own volume-based levels,
      // so this only has anything to move in the two delta views.
      visibleIf: (settings) => settings.view !== "volumeProfile",
    },
    {
      kind: "staticHint",
      tab: "inputs",
      text: "Mode, session length and bin size recompute the profile on the host; colours and lines redraw at once.",
    },
    {
      kind: "staticHint",
      tab: "visibility",
      text: "One palette for all three views: Buy is the delta views' net-buying bar and the volume view's traded-volume bar; Sell is the net-selling bar, or the volume bar's sell-side share.",
    },
    {
      kind: "color",
      key: "buyColor",
      label: "Buy color (outside value area)",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "buyValueAreaColor",
      label: "Buy color in value area",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "sellColor",
      label: "Sell color (outside value area)",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "sellValueAreaColor",
      label: "Sell color in value area",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "pocColor",
      label: "POC line",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "vahValColor",
      label: "Value area lines",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "boolean",
      key: "showPocLine",
      label: "Show POC line",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "boolean",
      key: "showValueAreaLines",
      label: "Show value area lines",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "custom",
      key: "vahValStyle",
      tab: "visibility",
      affects: "cosmetic",
      isValidPersistedValue: (value) => VAH_VAL_STYLES.has(value),
      render: (settings, onChange) => (
        <ProfileVahValStyleField
          style={settings.vahValStyle}
          onStyleChange={(vahValStyle) =>
            onChange({ ...settings, vahValStyle })
          }
        />
      ),
    },
  ];

/**
 * The three volume-profile renderings as one indicator: one server
 * `ProfileFrame`, three ways to draw it, chosen by the `view` setting.
 * Volume Profile, Net Delta Profile and Delta Profile used to be registered
 * separately; they shared this same frame and this same session config already
 * (see profileSessionConfig.ts), and their saved preferences are migrated onto
 * this id by sessionProfileSettings.ts.
 *
 * Profile data arrives from the server as a `ProfileFrame`, never from
 * `ctx.bar`, so `onBar`/`readOutput` are intentionally inert and the rendering
 * stays on the three primitives, driven by ChartPanel.tsx/MainPanel.tsx.
 */
export const sessionProfileIndicator: RuntimeIndicatorDef<
  Record<string, never>,
  SessionProfileIndicatorSettings
> = {
  kind: "runtime",
  id: SESSION_PROFILE_INDICATOR_ID,
  label: "Session Volume Profile (Volume / Net Delta / Delta)",
  category: "l1",
  defaultSettings: DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
  settingsSchema: SESSION_PROFILE_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
