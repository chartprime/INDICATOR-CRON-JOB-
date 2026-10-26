import type { RuntimeIndicatorDef, SettingsFieldSchema } from "../../chart/indicatorTypes";
import {
  DEFAULT_SWING_LENGTH,
  MAX_SWING_LENGTH,
  MIN_SWING_LENGTH,
} from "./deltaDivergence";
import { DeltaDivergenceSwingLengthField } from "./DeltaDivergenceSwingLengthField";

export interface DeltaDivergenceIndicatorSettings {
  swingLength: number;
}

export const DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS: DeltaDivergenceIndicatorSettings = {
  swingLength: DEFAULT_SWING_LENGTH,
};

const DELTA_DIVERGENCE_SETTINGS_SCHEMA: readonly SettingsFieldSchema<DeltaDivergenceIndicatorSettings>[] = [
  {
    kind: "custom",
    key: "swingLength",
    affects: "recompute",
    isValidPersistedValue: (value) => typeof value === "number"
      && Number.isInteger(value)
      && value >= MIN_SWING_LENGTH
      && value <= MAX_SWING_LENGTH,
    render: (settings, onChange) => <DeltaDivergenceSwingLengthField settings={settings} onChange={onChange} />,
  },
  {
    kind: "staticHint",
    text: "Price-pane annotations show when enabled. CVD-pane annotations also need Aggressive Order Flow enabled, because there is no CVD pane to draw on otherwise.",
  },
];

/**
 * TA.04 -- registers Delta Divergence with the new authoring core. Its
 * settings (swingLength + visibility) migrate fully onto SettingsFieldSchema
 * -- swingLength via the schema's existing `custom` escape hatch rather
 * than the plain "numeric" field kind, because that kind has no hint-text
 * slot at all and this field's own hint embeds a value
 * (`cvdAlignmentToleranceBars(swingLength)`) derived live from the setting.
 *
 * Cross-pane rendering deliberately does NOT move here, for a reason
 * checked directly rather than assumed: `RuntimeIndicatorDef.crossAttachments`
 * (`indicatorTypes.ts`) -- the mechanism this migration ticket's own
 * acceptance criteria says Delta Divergence should "prove end-to-end" --
 * is declared but never consumed anywhere in `indicatorRuntime.ts` or
 * `ChartPanel.tsx`. What Delta Divergence actually does today (attaching
 * a `DeltaDivergencePrimitive` to Order Flow's own CVD line series,
 * conditionally, with its own attach/detach lifecycle when either
 * indicator's enabled state changes) is real and correct -- it is simply
 * hand-wired directly in `ChartPanel.tsx`, not routed through this
 * declared-but-unimplemented field. Building that mechanism for real is
 * genuine new infrastructure (lifecycle ordering, what happens when Order
 * Flow is disabled while Delta Divergence stays active) explicitly not
 * attempted here; this ticket's own acceptance criterion referencing it
 * is reported as unmet-as-written in the evidence doc, not silently
 * marked satisfied. TA.05's own audit went further: `createIndicatorRuntime`
 * now throws at registration if any def declares a non-empty
 * `crossAttachments` (`indicatorRuntime.ts`'s `assertRuntimeDefinitions`),
 * so a future author who reaches for this field is pointed here
 * immediately instead of silently getting nothing. `onBar`/`readOutput` are inert: divergences are
 * computed directly from `bars`/`delta`/`cvd` in ChartPanel.tsx's own
 * `recomputeIndicators`, never from `ctx.bar`.
 */
export const deltaDivergenceIndicator: RuntimeIndicatorDef<Record<string, never>, DeltaDivergenceIndicatorSettings> = {
  kind: "runtime",
  id: "deltaDivergence",
  label: "Delta Divergence",
  category: "l1",
  defaultSettings: DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS,
  settingsSchema: DELTA_DIVERGENCE_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  createState: () => ({}),
  onBar: () => {},
  readOutput: () => ({}),
};
