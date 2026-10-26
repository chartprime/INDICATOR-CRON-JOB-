import type { RuntimeIndicatorDef } from "../../chart/indicatorTypes";

/**
 * TA.04 -- registers VPIN Cloud with the new authoring core for lifecycle
 * consistency with the rest of this migration. Deliberately minimal: the
 * ticket's own stated reason for including VPIN Cloud ("proves TA.01's
 * shared liveTick dispatch") does not hold up under direct inspection --
 * no such mechanism exists anywhere in indicatorRuntime.ts/indicatorTypes.ts.
 * The animation is a plain wall-clock `setInterval` in ChartPanel.tsx
 * (`vpinCloudPrimitiveRef.current?.setMotionNow(Date.now())`), entirely
 * outside onBar, and stays exactly as it is. Its settings modal also stays
 * bespoke (`VpinCloudSettingsModal.tsx`, unchanged) rather than migrating
 * onto SettingsFieldSchema: the sensitivity default is derived live, per
 * instrument, from recent VPIN history, and its hint text embeds that
 * live-derived number -- a per-render dynamic value a static schema
 * (defined once, at module load) cannot express, unlike Volume Profile's
 * genuinely static settings. onBar/readOutput are inert for the same
 * reason as every other partial migration in this ticket: nothing here is
 * derived from ctx.bar.
 */
export const vpinCloudIndicator: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
  kind: "runtime",
  id: "vpinCloud",
  label: "VPIN Cloud",
  category: "l1",
  defaultSettings: {},
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
