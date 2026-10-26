import type { LineOutputSpec, RuntimeIndicatorDef } from "../../../chart/indicatorTypes";
import { compressionBreakoutIndicator, type CompressionBreakoutSettings, type CompressionBreakoutState } from "../compressionBreakout";

/**
 * The runtime records a per-bar value only for the keys a def declares as
 * `lines`, so the harness's truncation and equivalence checks would otherwise
 * compare the two edge lines alone. This test-only def is the product with
 * every `readOutput` key declared as a line (nothing renders in a test), so a
 * check sees the seams too: the raw range snapshot, the pulses, `pending`,
 * `heldCount`, the trend and the width ratio.
 */
export const SEAM_KEYS = [
  "rangeHigh",
  "rangeLow",
  "activeHigh",
  "activeLow",
  "heldCount",
  "widthRatio",
  "qualified",
  "trend",
  "rangeAge",
  "pending",
  "breakDir",
  "breakGrade",
  "gradeBasis",
  "failed",
  "heldOutside",
  "expired",
] as const;

const SEAM_LINES: readonly LineOutputSpec<CompressionBreakoutState>[] = SEAM_KEYS.map((key) => ({ key }));

export const compressionBreakoutSeamDef: RuntimeIndicatorDef<CompressionBreakoutState, CompressionBreakoutSettings> = {
  ...compressionBreakoutIndicator,
  id: "compressionBreakoutSeams",
  lines: SEAM_LINES,
};
