import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { minSizeField } from "./minSizeSchema";
import type { InstitutionalV2Settings } from "./institutionalV2Rules";

export const INSTITUTIONAL_V2_SETTINGS_SCHEMA: readonly SettingsFieldSchema<InstitutionalV2Settings>[] = [
  {
    key: "source",
    label: "Walls From",
    kind: "radioGroup",
    options: [
      { value: "engine", label: "L2 Engine", hint: "the server's walls, with what trading did to each" },
      { value: "tracker", label: "Heatmap Tracker", hint: "the bands read from the heatmap columns, as before" },
      { value: "both", label: "Both", hint: "side by side, the engine's marked L2, to compare" },
    ],
    affects: "recompute",
  },
  { key: "showWeak", label: "Show Weak Walls", kind: "boolean", affects: "recompute" },
  { key: "showMitigated", label: "Show Mitigated Walls", kind: "boolean", affects: "recompute" },
  minSizeField(null),
  {
    key: "levelsBy",
    label: "Keep the Levels",
    kind: "radioGroup",
    options: [
      { value: "nearest", label: "Nearest to Price", hint: "the levels price is trading into" },
      { value: "largest", label: "Largest Size", hint: "the biggest walls on the book, wherever they are" },
      { value: "furthest", label: "Furthest from Price", hint: "the outer levels, where a higher timeframe is heading" },
    ],
    affects: "recompute",
  },
  { key: "levelsPerSide", label: "Levels per Side (0 = all)", kind: "numeric", min: 0, max: 64, step: 1, affects: "recompute" },
  { key: "bullishColor", label: "Bid Wall Color", kind: "color", tab: "visibility", affects: "recompute" },
  { key: "bearishColor", label: "Ask Wall Color", kind: "color", tab: "visibility", affects: "recompute" },
  { key: "bandThicknessPx", label: "Band Thickness (px)", kind: "numeric", min: 0, max: 60, step: 2, tab: "visibility", affects: "recompute" },
  { key: "historyHours", label: "History (hours)", kind: "numeric", min: 0, max: 168, step: 1, affects: "recompute" },
];
