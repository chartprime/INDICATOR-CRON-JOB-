# Session Killzones

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

An optional price-chart overlay for six New-York-time sessions: Asia,
London, NY AM, NY Lunch, NY PM, and regular trading hours (RTH).

## Files

- `apps/web/src/lib/indicators/killzones/killzones.ts` — `KILLZONE_SESSIONS`, `buildKillzoneOccurrences`, NY-timezone conversion
- `apps/web/src/lib/indicators/killzones/killzonesPrimitive.ts` — the canvas render primitive (boxes + high/low extension lines)
- `apps/web/src/lib/indicators/killzones/KillzonesSettingsModal.tsx` — global visibility + per-session checkboxes
- `apps/web/src/lib/indicators/killzones/killzonesIndicator.ts` — **TA.04**: registers Killzones with the indicator-authoring core (`kind: "runtime"`) specifically so the 30-minute interval gate runs through `RuntimeIndicatorDef.timeframeGate`, the SDK's own general gating mechanism, instead of an ad hoc inline check. `onBar`/`readOutput` are intentionally inert — occurrence computation and rendering are unchanged (see below); this file moves lifecycle/gating only, not rendering.
- `apps/web/src/components/chart/ChartPanel.tsx` — primitive wiring (unchanged), the NY-parts cache lifecycle (unchanged); the 30-minute gate itself now reads `killzonesIndicator`'s registered `timeframeGate` (via `resolveRuntimeIndicatorIds`) rather than its own local constant.

## End-to-end behavior

The browser derives session occurrences from the validated, resampled chart
bars. `Intl.DateTimeFormat` with `America/New_York` supplies the local date and
minute, so daylight-saving transitions follow the platform time-zone database
instead of a fixed UTC offset. Cross-midnight sessions retain the date of
their opening segment.

Each contiguous occurrence records the session high and low. Its box covers
every source bar in that continuous segment, including a one-bar occurrence
and the final bar width. A missing source interval ends the current segment:
the overlay never bridges a data gap or extends a pivot through unobserved
price action. High/low extension lines otherwise stop independently on the
first later bar that strictly breaks the respective level, or when the next
occurrence supersedes them. At most three occurrences per enabled session are
retained.

## Rendering and performance

A chart primitive draws the overlays behind price data. Killzones are shown
only on chart intervals up to 30 minutes; coarser intervals cannot represent
the configured intraday boundaries faithfully. New-York date conversions are
cached by source timestamp across live recomputations, cleared on a new
snapshot, and pruned with removed chart history.

## Configuration and validation

The settings dialog provides an independent global visibility control and a
checkbox for every session. Asia, London, NY AM, and NY PM are enabled by
default; NY Lunch and RTH are available but initially disabled. Session
boundaries, occurrence limits, and strict chronological bar input are
validated before computation. The shared settings dialog traps focus, closes
on Escape or backdrop action, and restores focus to its invoking control.

## Scope

This is a display overlay, not a persisted market-data series. Its output is
deterministic for a given bar history, platform time-zone database, session
configuration, and chart interval.

## TA.04 migration (partial, by design)

Checked directly before migrating: the generic `ctx.draw`/`ctx.markers`
drawing kernel (`TA.03`) cannot yet reproduce this overlay pixel-for-pixel
— its label primitive renders a filled circle with a caption (radius and
font size coupled to one `size` field), not a plain, alpha-blended
background watermark, and it has no fill-opacity control at all. Forcing
the migration through it would have visibly changed how Killzones looks,
which this ticket's own "zero visible change" requirement forbids.
Rendering (`killzonesPrimitive.ts`, unchanged) and occurrence computation
(`buildKillzoneOccurrences`, unchanged) therefore stay exactly as they
were, still driven directly by `ChartPanel.tsx`. Only lifecycle/gating
moved: Killzones is now `kind: "runtime"` and its 30-minute interval gate
runs through the SDK's own `timeframeGate`, the first real production use
of that mechanism. A full rendering migration needs a general
custom-primitive escape hatch that does not exist yet — that is Whale
Detector's job (`TA.04` step 4), not repeated or improvised here.
