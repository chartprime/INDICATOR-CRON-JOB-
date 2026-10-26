import { createElement } from "react";
import type {
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import {
  DEFAULT_SESSION_DELTA_PROFILE_SETTINGS,
  type SessionDeltaProfileSettings,
} from "./sessionDeltaProfileSettings";
import { SessionDeltaPocSettingsField } from "./SessionDeltaPocSettingsField";
import { SessionDeltaValueAreaSettingsField } from "./SessionDeltaValueAreaSettingsField";

const LINE_STYLE_OPTIONS = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
] as const;

export type SessionDeltaProfileIndicatorSettings = SessionDeltaProfileSettings;

export const DEFAULT_SESSION_DELTA_PROFILE_INDICATOR_SETTINGS: SessionDeltaProfileIndicatorSettings =
  DEFAULT_SESSION_DELTA_PROFILE_SETTINGS;

const SESSION_DELTA_PROFILE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<SessionDeltaProfileIndicatorSettings>[] =
  [
    {
      kind: "select",
      key: "sessionPeriodMs",
      label: "Session length",
      tab: "inputs",
      affects: "recompute",
      options: [
        { value: 60 * 60 * 1000, label: "1 Hour" },
        { value: 2 * 60 * 60 * 1000, label: "2 Hours" },
        { value: 3 * 60 * 60 * 1000, label: "3 Hours" },
        { value: 4 * 60 * 60 * 1000, label: "4 Hours" },
        { value: 6 * 60 * 60 * 1000, label: "6 Hours" },
        { value: 12 * 60 * 60 * 1000, label: "12 Hours" },
        { value: 24 * 60 * 60 * 1000, label: "1 Day" },
        { value: 2 * 24 * 60 * 60 * 1000, label: "2 Days" },
        { value: 3 * 24 * 60 * 60 * 1000, label: "3 Days" },
        { value: 7 * 24 * 60 * 60 * 1000, label: "1 Week" },
      ],
    },
    {
      kind: "numeric",
      key: "maxDisplaySessions",
      label: "Max displayed sessions",
      tab: "inputs",
      affects: "recompute",
      min: 1,
      max: 50,
      step: 1,
    },
    {
      kind: "slider",
      key: "maxBarWidthPx",
      label: "Profile row width",
      tab: "inputs",
      affects: "cosmetic",
      min: 40,
      max: 300,
      step: 10,
    },
    {
      kind: "slider",
      key: "rowWidth",
      label: "Bin width",
      tab: "inputs",
      affects: "recompute",
      min: 1,
      max: 10,
      step: 1,
    },
    {
      kind: "slider",
      key: "valueAreaPercent",
      label: "Value area percent",
      tab: "inputs",
      affects: "recompute",
      min: 0.1,
      max: 1,
      step: 0.05,
    },
    {
      kind: "color",
      key: "buyColor",
      label: "Buy color",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "sellColor",
      label: "Sell color",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "custom",
      tab: "visibility",
      affects: "cosmetic",
      render: (settings, onChange) =>
        createElement(SessionDeltaPocSettingsField, { settings, onChange }),
    },
    {
      kind: "custom",
      tab: "visibility",
      affects: "cosmetic",
      render: (settings, onChange) =>
        createElement(SessionDeltaValueAreaSettingsField, {
          settings,
          onChange,
        }),
    },
    ...(["showBuyPoc", "showSellPoc", "showValueAreaLines"] as const).map(
      (key): SettingsFieldSchema<SessionDeltaProfileIndicatorSettings> => ({ kind: "boolean", key, label: "", tab: "visibility", visibleIf: () => false, affects: "cosmetic" }),
    ),
    ...(["buyPocColor", "sellPocColor", "vahValColor"] as const).map(
      (key): SettingsFieldSchema<SessionDeltaProfileIndicatorSettings> => ({ kind: "color", key, label: "", tab: "visibility", visibleIf: () => false, affects: "cosmetic" }),
    ),
    ...(["buyPocStyle", "sellPocStyle"] as const).map(
      (key): SettingsFieldSchema<SessionDeltaProfileIndicatorSettings> => ({ kind: "select", key, label: "", options: LINE_STYLE_OPTIONS, tab: "visibility", visibleIf: () => false, affects: "cosmetic" }),
    ),
    {
      kind: "boolean",
      key: "showSessionHighLow",
      label: "Show session high / low",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "sessionHighLowColor",
      label: "Session high / low color",
      tab: "visibility",
      affects: "cosmetic",
      visibleIf: (settings) => settings.showSessionHighLow,
    },
    {
      kind: "slider",
      key: "smallRowOpacity",
      label: "Small row opacity",
      tab: "inputs",
      affects: "cosmetic",
      min: 0,
      max: 1,
      step: 0.05,
    },
    {
      kind: "slider",
      key: "developingOpacity",
      label: "Developing profile opacity",
      tab: "inputs",
      affects: "cosmetic",
      min: 0,
      max: 1,
      step: 0.05,
    },
  ];

export const sessionDeltaProfileIndicator: RuntimeIndicatorDef<
  Record<string, never>,
  SessionDeltaProfileIndicatorSettings
> = {
  kind: "runtime",
  id: "sessionDeltaProfile",
  label: "Session Delta Profile",
  category: "session",
  defaultSettings: DEFAULT_SESSION_DELTA_PROFILE_INDICATOR_SETTINGS,
  settingsSchema: SESSION_DELTA_PROFILE_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
