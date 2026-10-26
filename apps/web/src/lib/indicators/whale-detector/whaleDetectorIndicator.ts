import type { RuntimeIndicatorDef } from "../../chart/indicatorTypes";

/**
 * TA.04 -- registers the real Whale Detector (id kept as the existing
 * `largeTradeDetector`, distinct from TA.03.5's own `largeTradeBubbles`
 * proof-of-concept) with the new authoring core for lifecycle consistency.
 * Deliberately minimal, for two independent, directly-checked reasons:
 *
 * 1. Rendering (variable-radius bubbles, local-median-bucket baseline,
 *    buy/sell/delta clustering) needs the same custom-primitive escape
 *    hatch Killzones' migration already found missing -- `getPrimitive(id)`
 *    on IndicatorRuntime is still an unimplemented stub. Hover tooltips
 *    specifically need real hit-test geometry (`whaleMarkerGeometry.ts`'s
 *    `hitTestWhaleMarkers`), which the generic ctx.markers system has no
 *    equivalent for at all -- losing hover would be a real, user-visible
 *    regression, not an acceptable trade for "migrated."
 * 2. Its settings modal doesn't fit SettingsFieldSchema the way Volume
 *    Profile's did: two logarithmic range sliders (no "slider"/log-range
 *    field kind exists), and hint text that embeds live, externally-
 *    computed values (`resolvedThreshold`, `truncated`) the static schema
 *    model has no way to receive -- the same closure-scope limit VPIN
 *    Cloud's dynamic sensitivity default already hit, here on more
 *    fields at once. Building either a log-slider field kind or a way to
 *    pass extra per-render context into a custom field would be new SDK
 *    mechanism this ticket does not need to invent.
 *
 * Data flow (MainPanel.tsx computing marker stats from live `markers`,
 * ChartPanel.tsx's `applyMarkerSnapshot`) and the settings modal both stay
 * exactly as they are. onBar/readOutput are inert: nothing here is
 * derived from ctx.bar either.
 */
export const whaleDetectorIndicator: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
  kind: "runtime",
  id: "largeTradeDetector",
  label: "Large Trade Detector",
  category: "l1",
  defaultSettings: {},
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
