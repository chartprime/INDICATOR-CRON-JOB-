# Setting presets

[Handbook](../../README.md) · [Indicator index](README.md) ·
[Data for indicator authors](data-for-indicator-authors.md) ·
[Indicator SDK](../indicator-sdk/TA.01-indicator-authoring-core-evidence.md)

A preset is a named copy of one indicator's settings, such as "Scalp mode" or
"Swing mode". Every settings dialog has them, in Live and in Historical Mode.
The code named here is the authority; when this page and the code disagree,
the code wins and this page is the defect.

## What the user sees

The dialog footer has a **Defaults ▾** button, beside "Reset to default" in
the dialogs that have one. L2 Support & Resistance, the L2 Liquidity Book Map
and the Whale Limit Order Heatmap keep their "Reset" button in the dialog body,
and ICT Killzones has no reset button of its own. The button opens a small
popup:

- **Reset settings** runs the dialog's own reset. On ICT Killzones, the only
  reset there is, it ticks the default sessions and shows the indicator again.
- **Save as preset…** shows a name field: Enter or Save saves, Escape cancels,
  an empty name is refused with a red border. Saving under a name that already
  exists, in any letter case, replaces that preset in place.
- **Presets** lists the saved ones in creation order (hidden while there are
  none). A click applies one and closes the popup; ✕ deletes it.

When the current settings equal a saved preset, the button shows that preset's
name (in full as its tooltip) instead of "Defaults". Applying a preset is an
ordinary settings edit: the dialogs apply edits live, so there is nothing to
confirm. Escape closes the popup and leaves the dialog open. A preset holds the
indicator's inputs only, never its "Show on chart" state.
A field declared with `tab: "advanced"` is an ordinary input shown under a
collapsed Advanced group at the end of the Inputs tab; presets save and apply
it like any other input.

Presets belong to one indicator, and they follow the way its settings are kept:

- Aggressive Orders, Prime Absorption, the Iceberg Detector, Exhaustion,
  Initiative Continuation, Live Range Control, Live Delta Profile and Live Order
  Book Profile keep their presets per instrument,
  the Passive Liquidity Heatmap per market style (per instrument in Historical
  Mode), and the Large Trade Detector per size unit (dollars or contracts).
- Institutional Order Blocks v2 and Flowprint Blocks keep a minimum size and a
  maximum traded per instrument inside one settings object. Their presets are
  kept per instrument, and a preset saves and applies that value for the
  instrument on screen only; every other instrument keeps its own.
- The live heatmap preset also holds Price zoom.
- Historical Mode keeps its own presets, as it keeps its own settings: a preset
  saved there never shows in Live Mode, and the other way round.

## Where presets are kept

In the browser, under the one localStorage key `terminal.indicator-presets.v1`,
holding every indicator's presets: a map from the indicator's preset key to its
presets, at most 32 per key, names up to 64 characters. The key is the
indicator id, or `<indicatorId>@<scope>` where presets are scoped: an instrument
key (`DXFEED:FUTURE:/NQZ26:XCME`), a heatmap market style (`crypto`), a size
unit (`USD`, `CONTRACTS`), `historical`, `historical:<instrument>` for the
Historical per-instrument dialogs (the heatmap included), or
`historical:<unit>` for the Historical Large Trade Detector.

The store (`indicatorPresets` in `apps/web/src/lib/chart/indicatorPresets.ts`)
loads them once and keeps them in memory, so the popup opens at once. A save or
a delete first reads what is stored, so a change made in another tab is never
overwritten, then updates memory and writes. A change another tab makes shows
up in an open popup through the browser's `storage` event. A write that fails
shows "Could not save the preset" (or "Could not delete the preset") in the
popup; the change stays on screen until the next save, delete or reload.

## Wiring account storage

The terminal has no sign-in yet, so the browser is the only store in use. The
store is ready to move to an account once there is one; nothing in the dialogs
changes. Implement `PresetAccountStorage` against a table with one row per user
and preset key:

```ts
interface PresetAccountStorage {
  load(): Promise<unknown>;                                                // the user's rows as { [presetKey]: presets }
  write(indicatorKey: string, presets: readonly Preset[]): Promise<void>; // upsert that row; an empty list deletes it
}
```

and call the store where the app learns the session state:

```ts
const { merged, failed, left } = await indicatorPresets.signIn(accountStorage); // after sign-in
indicatorPresets.signOut();                                                     // on sign-out
```

`signIn` loads the account's presets, then merges the browser's into them, the
account's version winning on a shared name. A preset saved while the account
loads is included. It writes the indicators that changed, then rewrites the
browser copy so it holds only what did not reach the account, which is empty
when every write succeeded and nothing was past the cap, so a preset deleted
later is not copied back at the next sign-in. Each write sends the indicator's
presets as they are at that moment, so a save made while the writes run is
kept. `merged` names the indicators that needed a write, `failed` the ones
whose write failed, and `left` the ones still held in the browser: those whose
write failed, those with more presets than fit under the cap, or all of them if
the browser copy could not be rewritten. If the account cannot be read, `signIn`
rejects and the store stays on the browser; a sign-out while `signIn` runs
stops it before the browser copy is touched. While signed in, a save or delete
writes only that indicator's row.

## How a preset is read

A preset is never applied raw. Each dialog declares its inputs as a
`SettingsFieldSchema` list: a runtime indicator's `settingsSchema` (or its
`persistenceSchema`), and for the hand-built dialogs the schema in their
settings module or `*Presets.ts` file. Saving keeps only those inputs (a
checkbox list in its own option order). Applying reads the preset through
`restoreFields` in `apps/web/src/lib/chart/historicalIndicatorPreferences.ts`,
the same routine that reads saved settings back after a reload, and changes
only those inputs; a setting outside them keeps its current value.

| The preset holds | Applied as |
|---|---|
| A value inside the input's range and on its step | That value |
| A value outside the range | The nearest end if the field sets `clampOnRestore`, otherwise the default |
| A value of another type, or a choice the list no longer offers | The default |
| A custom value its `isValidPersistedValue` refuses | The default |
| Nothing for an input added since it was saved | The default |
| A key the indicator no longer has | Ignored |

When saved values and presets are read back, a numeric field with `step: 0`
takes any value inside its range; the hand-built dialogs' preset schemas use it
for their free number boxes. The generic dialog refuses every value of a
`step: 0` field it renders, so a runtime `settingsSchema` keeps `step > 0`. A
custom field whose value is a map keyed by instrument sets `byInstrument: true`;
the generic dialog then saves and applies only the instrument on screen, and
leaves the field out where it has no instrument (Historical Mode). The button's
preset name is found through the same rules, so a saved preset still matches
after a harmless change to the indicator.

## Changing an indicator's settings

- A setting that changes meaning gets a new key. The same number under a new
  meaning is the one change no check can see; under a new key, old presets give
  that input its default. A settings revision, like the Iceberg Detector's, does
  not replace a new key: it drops saved settings at reload, but it is not a
  preset input, so presets keep their values.
- An input replaced by others follows the same rules. Prime Absorption's floor
  per timeframe and Strong walls only became three sliders (absorbed share,
  strong share, minimum absorbed) and Show broken: a preset holding the old two
  keys applies its other inputs, ignores those two, and gives the new ones their
  defaults.
- Every setting a dialog keeps is one of its preset inputs, or is named in
  `NOT_IN_PRESETS` (hand-built dialogs) or `NOT_IN_SDK_PRESETS` (runtime
  indicators) in `apps/web/src/components/tests/indicatorPresetInputs.test.ts`,
  for the few no dialog edits, such as the Iceberg Detector's settings revision,
  which applying a preset leaves as it is. That test fails otherwise, because a
  preset would not hold that setting.
- The same test pins every dialog's preset inputs (key, kind, range, step,
  choices) in `apps/web/src/components/tests/fixtures/indicatorPresetInputs.json`.
  A change there fails it on purpose: rename the key, accept that old presets
  clamp, then rewrite the fixture by running that test file with
  `UPDATE_PRESET_INPUTS=1` set.

## Adding a dialog

A runtime indicator with a `settingsSchema` gets presets from
`GenericIndicatorSettingsModal` when it is given `defaultSettings` and a
`presetKey` (and `instrumentKey` in Live Mode). A hand-built dialog passes
`presets` to `IndicatorSettingsModal`: the preset key
(`presetKeyFor(id, scope)`), its current settings, its schema, its defaults,
an apply callback and its reset. A dialog shown in Historical Mode takes a
`presetScope`, which the Historical panels set to `historical` (or
`historical:<instrument>` for the per-instrument ones); a per-instrument dialog
in Live Mode takes the instrument key as its `presetScope`.

Every indicator in the registry needs presets. `indicatorPresetInputs.test.ts`
fails, naming the indicator, unless it has an SDK `settingsSchema`, its
hand-built dialog's schema is listed in `BESPOKE`, or it is named in
`NO_SETTINGS_DIALOG` with the reason (RSI, EMA, Bollinger Bands and the L2
Feed Status have no settings button). A hand-built dialog that keeps one
settings object also lists it in `SETTINGS_OF`, which is what the
every-setting check above reads.

## Files

| Concern | File |
|---|---|
| Store, browser storage, account seam | `apps/web/src/lib/chart/indicatorPresets.ts` |
| Saving and applying through a schema, per-instrument entries, the preset in use | `apps/web/src/lib/chart/presetFields.ts` |
| The popup | `apps/web/src/components/IndicatorPresetsMenu.tsx` |
| The footer that hosts it | `apps/web/src/components/IndicatorSettingsModal.tsx` |
| Tests | `indicatorPresets.test.ts`, `presetFields.test.ts` beside the code; `IndicatorPresetsMenu.test.tsx`, `indicatorPresetsWiring.test.tsx`, `indicatorPresetInputs.test.ts` in `apps/web/src/components/tests/`; the Historical keys in `HistoricalModePanel.test.tsx`; the live per-instrument keys in `MainPanel.test.tsx` |
| Mutation spec | `benchmarks/mutations/indicator-presets.json` |
