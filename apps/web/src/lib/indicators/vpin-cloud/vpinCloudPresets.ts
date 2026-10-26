import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import { MAX_VPIN_SENSITIVITY, MIN_VPIN_SENSITIVITY } from "./vpinSensitivity";

export const VPIN_CLOUD_PRESET_SCHEMA: readonly SettingsFieldSchema<{ sensitivity: number }>[] = [
  { kind: "numeric", key: "sensitivity", label: "Sensitivity", min: MIN_VPIN_SENSITIVITY, max: MAX_VPIN_SENSITIVITY, step: 0, clampOnRestore: true, affects: "recompute" },
];
