# Indicator Authoring Core (TA.01)

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

An incremental, declarative system for authoring chart indicators: one
file per indicator describing its state, its per-bar update, its
rendered lines, and its settings, registered with one array entry that
the chart and the indicators menu both pick up automatically. Built so
outside TypeScript developers can write a working indicator without
touching `ChartPanel.tsx`'s own internals. RSI, EMA, Bollinger Bands and
SMA are built on it — see `docs/architecture/indicators/
technical-indicators-evidence.md` for their math.

## Execution model

An indicator keeps a small `state` object nudged forward one bar at a
time (`onBar`), never recomputing its history to answer for one new bar.
`ChartPanel.tsx`'s bars array is mutated in exactly two places, and the
runtime (`indicatorRuntime.ts`) hooks both: `applySnapshot` triggers a
full replay of every active indicator (covers initial connect, symbol/
provider switch, timeframe switch, and reconnect/gap-repair with one
mechanism), and `applyBar` dispatches one `APPENDED` / `REPLACED_EDGE` /
`REBUILT` / `REJECTED_REOPEN` call per bar, matching the classification
`mergeChartBar` already produces. Each active record tracks its own tail
bar by `ts_open`, not an array index, since `ChartPanel` splices old bars
off the front of the retained array once it exceeds the 10,080-bar cap;
`discardLeading(count)` trims the same number of entries off the front of
every cached output and color array on that same rollover, keeping them
aligned to the trimmed bars array.

A normal, contiguous live-bar update draws with lightweight-charts' own
incremental `series.update()`; a gap, a correction, a settings change, a
fault, or a rollover instead redraw that indicator's lines in full.

## Rendering

`ctx.draw`/`ta`/`markers` are stub namespaces until `TA.02`/`TA.03` land,
so a `RuntimeIndicatorDef` carries its own `readOutput(state)` and
`lines: LineOutputSpec[]` in the meantime; `ChartPanel`'s series manager
turns these into dynamically-keyed `LineSeries` objects, the generic form
of what used to be a hand-built series per indicator. A line's
`color(state, settings)` is recomputed per bar (EMA's short/long lines
share one, colored by which leg is currently above the other).

Settings are split `affects: "recompute"` (invalidates state, triggers a
full replay) vs. `"cosmetic"` (re-styles existing output only). A
cosmetic change tries a color-bearing line's own `recolor(currentColor,
settings)` first, touching only the color arrays; a line without one
falls back to a full replay instead of repainting all of history from
today's state alone, which would be wrong for a color that varies by
historical bar (EMA's trend coloring) rather than by settings alone
(SMA's user-picked color, which supplies `recolor` and keeps the cheap
path).

`PlacementSpec`'s `sharedPane` and a definition's `timeframeGate` are
resolved together through a fixed-point loop over the active id set: an
indicator drops out if its timeframe gate fails or its declared
shared-pane parent isn't itself resolved, including chained dependencies,
before any series are created.

## Fault handling

Every author-supplied call (`createState`, `onBar`, `readOutput`,
`color`, `recolor`) is wrapped. A throw, a non-object `readOutput`
result, a non-finite numeric value, or a non-string color all latch that
one indicator's record `faulted` — skipped on every later call, and
reported as no output at all (`getOutput`/`getLineColors` return `null`)
rather than a stale or invalid array. A faulted indicator gets a fresh
chance only by being fully removed and re-added; nothing else in the app
is affected by one indicator's fault.

## Settings and registration

A numeric field's committed value is validated against `min`, `max`, and
`step` together, so a value inside range but off-step (`2.5` for an
integer length) is rejected rather than silently rounded. When saved
settings and presets are read back, a field with `step: 0` takes any value
inside the range; the hand-built dialogs' preset schemas use it for free number
boxes, and the generic dialog refuses every value of a `step: 0` field it
renders, so a runtime `settingsSchema` keeps `step > 0`. A custom field whose
value is a map keyed by instrument sets `byInstrument: true`. Every settings
dialog has [setting presets](../indicators/setting-presets.md), read through the
same field rules. A registered
indicator's id and each of its own line keys must be unique across the
whole registry; a duplicate throws at construction rather than one
silently overwriting another author's runtime state. Un-favoriting and
re-favoriting a runtime indicator within a session restores its last
customized settings rather than reverting to defaults.

## Files

- `apps/web/src/lib/chart/indicatorTypes.ts` - the authoring contract (`ctx` shape, `LineOutputSpec`, `PlacementSpec`, `SettingsFieldSchema`, `RuntimeIndicatorDef`/`LegacyIndicatorDef`)
- `apps/web/src/lib/chart/indicatorRegistry.ts` - the single array the chart and the indicators menu both read; derives `IndicatorId`
- `apps/web/src/lib/chart/indicatorRuntime.ts` - the engine: per-indicator state/output/color tracking, fault latching, replay/incremental/recolor dispatch
- `apps/web/src/lib/chart/replayBars.ts` - shared test harness every indicator's own suite replays bars through
- `apps/web/src/components/GenericIndicatorSettingsBody.tsx` / `GenericIndicatorSettingsModal.tsx` - renders any indicator's settings schema into the existing shared modal shell
- `apps/web/src/components/chart/ChartPanel.tsx` - the runtime's two integration points into the chart's bar lifecycle, and the per-bar series update/redraw dispatch
- `apps/web/src/components/chart/MainPanel.tsx` - generic settings-modal rendering for any runtime indicator with a schema
- `apps/web/src/lib/chart/indicatorPresets.ts` / `presetFields.ts` and `apps/web/src/components/IndicatorPresetsMenu.tsx` - setting presets: the store, saving and applying through a schema, the Defaults menu in the shared modal footer
- `apps/web/src/components/chrome/IndicatorsMenu.tsx` - one menu section per non-empty `IndicatorCategory` (four today: `technical`/`session`/`l1`/`community`, the last shown as "ChartPrime Library")

## Scope

- `ctx.ta` is a typed but permanently empty namespace by design -- `ta.*`
  factories (`TA.02`) are top-level, called once in `createState()`, not
  per-bar. `ctx.draw`/`ctx.markers` gained real per-bar methods in `TA.03`.
  `crossAttachments` is typed but unimplemented; `createIndicatorRuntime`
  throws if a def declares one (`TA.05`) rather than silently ignoring
  it -- Delta Divergence's real migration hand-wires its cross-pane
  attachment directly in `ChartPanel.tsx` instead, never needing this
  field.
- All 7 of the terminal's pre-existing L1/order-flow indicators
  (Killzones, Order Flow, Large Trade Detector, Delta Divergence, Volume
  Profile, Delta Profile, VPIN Cloud) are now migrated onto this
  authoring core (`TA.04`), each keeping its own rendering primitive
  where the generic draw/series-creation surface doesn't yet cover its
  needs -- see each indicator's own evidence doc.
- RSI/EMA/Bollinger's values are checked directly against the batch
  implementation they replaced (`lib/chart/indicators.ts`, kept only as
  that reference, no longer called in production).
- Customized settings on a runtime indicator do not persist across a page
  reload, matching every other indicator's own settings in this app.
