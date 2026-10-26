import type { RuntimeIndicatorDef } from "../../chart/indicatorTypes";

/**
 * The same intraday-only threshold ChartPanel.tsx already enforced ad hoc
 * before this migration -- preserved exactly, not re-tuned, and now the
 * one source of truth both ChartPanel.tsx's rendering check and this
 * indicator's own timeframeGate read from.
 */
export const KILLZONE_MAX_INTERVAL_MS = 30 * 60_000;

/**
 * TA.04 -- registers Killzones with the new authoring core specifically to
 * prove timeframeGate on real production code (this repo's own first real
 * use of it). Rendering deliberately stays on the existing, unchanged,
 * already-audited KillzonesPrimitive/buildKillzoneOccurrences, still driven
 * directly by ChartPanel.tsx exactly as before -- a full rendering migration
 * needs a custom-primitive escape hatch that does not exist yet (that is
 * Whale Detector's job, TA.04 step 4). This def's onBar/readOutput are
 * intentionally inert: this step moves lifecycle/gating only.
 */
export const killzonesIndicator: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
  kind: "runtime",
  id: "killzones",
  label: "ICT Killzones",
  category: "session",
  defaultSettings: {},
  lines: [],
  placement: { kind: "overlay" },
  timeframeGate: (intervalMs) => intervalMs <= KILLZONE_MAX_INTERVAL_MS,
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
