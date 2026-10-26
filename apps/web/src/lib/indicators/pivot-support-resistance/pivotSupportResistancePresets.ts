import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { pivotSupportResistanceIndicator, type PivotSupportResistanceSettings } from "./pivotSupportResistance";

export const PIVOT_SUPPORT_RESISTANCE_PRESET_SCHEMA: readonly SettingsFieldSchema<PivotSupportResistanceSettings>[] = [
  ...(pivotSupportResistanceIndicator.settingsSchema ?? []),
  { kind: "color", key: "supportColor", label: "Support color", affects: "cosmetic" },
  { kind: "color", key: "resistanceColor", label: "Resistance color", affects: "cosmetic" },
  { kind: "select", key: "lineStyle", label: "Line style", options: [{ value: "solid", label: "Solid" }, { value: "dashed", label: "Dashed" }, { value: "dotted", label: "Dotted" }], affects: "cosmetic" },
];
