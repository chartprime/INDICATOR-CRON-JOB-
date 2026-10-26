# Expressing "Advanced" settings in the SDK

UX seat, cycle 1. Decision requested from the PM. A prototype of option A is
committed on branch `worktree-agent-aa4a6294e0f5e7448` (commit `3f09b78`),
81 lines across four files, component tests green.

## The need

The owner wants each indicator to open with a few primary controls and the
rest under an Advanced group. Today `SettingsFieldSchema.tab` is
`"inputs" | "visibility"`, the generic dialog renders two tabs when any field
declares one, and there is no grouping inside a tab. The only hiding
mechanism is `visibleIf(settings)`, which sees settings and nothing else.

## Options

### A. `tab: "advanced"`, rendered as a collapsed group on the Inputs tab (prototyped)

- Schema: one more value in the union. No new keys in the settings object.
- Dialog: fields with `tab: "advanced"` stay on the Inputs tab but render
  after the primary fields inside `<details class="indicator-settings-advanced">`
  with a `<summary>Advanced</summary>`, closed by default. A schema with only
  `inputs` + `advanced` fields shows no tab strip at all, just the group.
- Presets, reset, persistence, the preset-inputs fixture: untouched. `tab`
  is read nowhere but the generic dialog (verified by grep), so every
  advanced field is an ordinary input to `persistableFields`, `restoreFields`
  and `indicatorPresetInputs.test.ts`.
- Cost: 19 lines in `GenericIndicatorSettingsBody.tsx`, 9 in
  `indicatorTypes.ts` (doc comment included), 19 of CSS, 38 of tests.
- Limits: the group's open state is not remembered between openings (native
  `<details>`); hand-built dialogs (Aggressive Orders, the heatmap, the
  Historical panels' bespoke modals) do not pick it up, they would add the
  same markup by hand; `visibleIf` still applies inside the group.

### B. A third tab, "Advanced"

Same schema change, rendered as a tab beside Inputs and Visibility. Rejected:
a third tab hides the advanced controls as completely as the Visibility tab
hides colours, so a trader looking for "the other threshold" has to guess
between two tabs; and schemas with no Visibility fields would gain a tab
strip for one group. A collapsed group keeps "what the calculation does" in
one place and shows that more exists.

### C. `visibleIf` plus a "Show advanced" boolean field

No type change. Rejected: the boolean becomes a settings key, so it must be
in the schema (test enforces), gets saved in presets and restored on reload
(the dialog would reopen expanded for whoever once ticked it), needs an
entry in `NOT_IN_SDK_PRESETS` to avoid that, and pollutes every settings
type with UI state. It also does not express grouping: the fields appear
inline, interleaved with primary ones unless the author orders them by hand.

### D. A separate `advancedSchema` on `RuntimeIndicatorDef`

Two field lists. Rejected: every consumer that walks `settingsSchema`
(presets, persistence, `settingsSchemaFor`, the preset-inputs test, the
every-key-in-schema test) would need to concatenate both, which is more
surface than one union member, and `settingsFieldsFor` overrides would need
to say which list they target.

## Recommendation

Adopt A. It is the smallest change, it is purely presentational, nothing
downstream can tell the difference, and it matches the owner's wording
("under an Advanced group"). Follow-ups if adopted:

1. Merge the prototype (`apps/web/src/lib/chart/indicatorTypes.ts`,
   `apps/web/src/components/GenericIndicatorSettingsBody.tsx`,
   `apps/web/src/App.css`, `apps/web/src/components/tests/GenericIndicatorSettingsBody.test.tsx`).
2. One sentence in `docs/architecture/indicators/setting-presets.md`
   ("How a preset is read") and in `data-for-indicator-authors.md`: an
   `advanced` field is an input; it changes nothing for presets.
3. `CAPABILITIES.md` section 5: `tab: "inputs" | "visibility" | "advanced"`.
4. Optional later: remember the group's open state per indicator in
   localStorage, and port the markup into the two hand-built dialogs when
   they are next touched.

## What the prototype shows

`PM/cycle1/screenshots/06-advanced-group-collapsed.png` and
`07-advanced-group-open.png` were taken with Session VWAP's two band sliders
temporarily marked `advanced` (change reverted, not committed). Note the
long `staticHint` sits between the primary fields and the group because it is
last in the schema; the standard caps hints on the Inputs tab at two
sentences for this reason.
