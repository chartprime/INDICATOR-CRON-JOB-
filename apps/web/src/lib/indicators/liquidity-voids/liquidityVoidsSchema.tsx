import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { MaxTradedSlider } from "./MaxTradedSlider";
import { isMaxTradedByInstrument, thresholdKeyFor, thresholdRuleFor, type Identity, type LiquidityVoidsSettings, type ThresholdKey } from "./liquidityVoidsRules";

const THRESHOLD_OPTIONS = [
  { value: "fixed", label: "Fixed", hint: "a set move and a maximum traded per market" },
  { value: "learned", label: "Learned", hint: "the move from the market's own recent trading, for the chart's timeframe" },
] as const;

export function maxTradedField(identity: Identity | null): SettingsFieldSchema<LiquidityVoidsSettings> {
  return {
    kind: "custom",
    key: "maxTradedByInstrument",
    affects: "recompute",
    isValidPersistedValue: isMaxTradedByInstrument,
    byInstrument: true,
    visibleIf: (settings) => identity !== null && thresholdRuleFor(settings, identity) === "learned",
    render: (settings, onChange) => (identity === null ? null : <MaxTradedSlider identity={identity} settings={settings} onChange={onChange} />),
  };
}

function thresholdsField(key: ThresholdKey): SettingsFieldSchema<LiquidityVoidsSettings> {
  return { key, label: "Thresholds", kind: "radioGroup", options: THRESHOLD_OPTIONS, affects: "recompute" };
}

const WINDOW_FIELD: SettingsFieldSchema<LiquidityVoidsSettings> = { key: "windowS", label: "Window (s)", kind: "numeric", min: 5, max: 300, step: 5, affects: "recompute" };

export const LIQUIDITY_VOIDS_SETTINGS_SCHEMA: readonly SettingsFieldSchema<LiquidityVoidsSettings>[] = [
  {
    key: "sensitivity",
    label: "Sensitivity",
    kind: "radioGroup",
    options: [
      { value: "low", label: "Low", hint: "only the biggest pushes" },
      { value: "normal", label: "Normal", hint: "the usual pushes" },
      { value: "high", label: "High", hint: "smaller pushes too" },
    ],
    affects: "recompute",
  },
  thresholdsField("thresholdsIndex"),
  thresholdsField("thresholdsOther"),
  maxTradedField(null),
  WINDOW_FIELD,
  {
    key: "levelsBy",
    label: "Keep the Levels",
    kind: "radioGroup",
    options: [
      { value: "nearest", label: "Nearest to Price", hint: "the levels price is trading into" },
      { value: "furthest", label: "Furthest from Price", hint: "the outer levels, where a higher timeframe is heading" },
    ],
    affects: "recompute",
  },
  { key: "boxesPerSide", label: "Boxes per Side", kind: "numeric", min: 1, max: 8, step: 1, affects: "recompute" },
  { key: "historyHours", label: "History (hours)", kind: "numeric", min: 0, max: 168, step: 1, affects: "recompute" },
  { key: "askColor", label: "Ask-Side Void Color", kind: "color", tab: "visibility", affects: "recompute" },
  { key: "bidColor", label: "Bid-Side Void Color", kind: "color", tab: "visibility", affects: "recompute" },
];

export function marketFieldsFor(identity: Identity): Partial<Record<keyof LiquidityVoidsSettings, SettingsFieldSchema<LiquidityVoidsSettings>>> {
  const hidden: ThresholdKey = thresholdKeyFor(identity) === "thresholdsIndex" ? "thresholdsOther" : "thresholdsIndex";
  return {
    [hidden]: { ...thresholdsField(hidden), visibleIf: () => false },
    maxTradedByInstrument: maxTradedField(identity),
    windowS: { ...WINDOW_FIELD, visibleIf: (settings) => thresholdRuleFor(settings, identity) === "fixed" },
  };
}
