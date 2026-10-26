import type { SettingsFieldSchema } from "../../chart/indicatorTypes";
import type { WhaleClusterMode } from "./whaleMarkerClusters";
import {
  MAX_TOP_FRACTION,
  MAX_WHALE_THRESHOLD_CONTRACTS,
  MAX_WHALE_THRESHOLD_USD,
  MIN_TOP_FRACTION,
  MIN_WHALE_THRESHOLD_CONTRACTS,
  MIN_WHALE_THRESHOLD_USD,
  type WhaleDetectionMode,
} from "./whaleTrades";

export type WhaleDetectorPresetParams = {
  mode: WhaleDetectionMode;
  topFraction: number;
  threshold: number;
  clusterMode: WhaleClusterMode;
  minDeltaPercent: number;
};

export function whaleDetectorPresetSchema(unit: "USD" | "CONTRACTS", sizeOnly = false): readonly SettingsFieldSchema<WhaleDetectorPresetParams>[] {
  const contracts = unit === "CONTRACTS";
  const fields: SettingsFieldSchema<WhaleDetectorPresetParams>[] = [
    { kind: "radioGroup", key: "mode", label: "Detection method", options: [{ value: "topPercent", label: "Top %" }, { value: "size", label: "Size" }], affects: "recompute" },
    { kind: "numeric", key: "topFraction", label: "Show top", min: MIN_TOP_FRACTION, max: MAX_TOP_FRACTION, step: 0, clampOnRestore: true, affects: "recompute" },
    {
      kind: "numeric",
      key: "threshold",
      label: contracts ? "Minimum size (contracts)" : "Minimum size ($)",
      min: contracts ? MIN_WHALE_THRESHOLD_CONTRACTS : MIN_WHALE_THRESHOLD_USD,
      max: contracts ? MAX_WHALE_THRESHOLD_CONTRACTS : MAX_WHALE_THRESHOLD_USD,
      step: contracts ? 1 : 0,
      clampOnRestore: true,
      affects: "recompute",
    },
    { kind: "radioGroup", key: "clusterMode", label: "Bubble mode", options: [{ value: "delta", label: "Delta" }, { value: "buySell", label: "Buy / Sell" }], affects: "recompute" },
    { kind: "numeric", key: "minDeltaPercent", label: "Min delta (%)", min: 0, max: 100, step: 0, clampOnRestore: true, affects: "recompute" },
  ];
  return sizeOnly ? fields.filter((field) => field.kind === "staticHint" || (field.key !== "mode" && field.key !== "topFraction")) : fields;
}

