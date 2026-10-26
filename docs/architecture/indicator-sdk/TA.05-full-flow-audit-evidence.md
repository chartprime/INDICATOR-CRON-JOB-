# Full-Flow Institutional-Grade Audit (TA.05)

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

Every ticket from `TA.01` through `TA.04` had its own closure audit,
against its own scope, in isolation. This ticket audits the *assembled*
system instead -- the three trees (`lib/chart/`, `lib/indicators/`,
`components/chart/`) as one thing a user actually opens, hunting for
interactions that only exist now that these tickets share a runtime for
the first time. No new features; findings got fixed as part of this
ticket, not deferred to a report.

## The one real end-to-end scenario traced

`largeTradeBubbles` (`TA.03.5`) is the only indicator in production that
exercises `TA.01` (settings schema) + `TA.03.5` (`ctx.trades`/
`tradeAvailability`) + `TA.03` (`ctx.markers`, the draw kernel's marker
controller) together, on a live, resampled timeframe. Traced directly: a
settings change to its `multiplier` field re-derives the robust
median/MAD threshold on the next live bar without a full replay (`affects:
"liveOnly"`); a bar's `tradeAvailability` gates whether individual prints
are even considered; qualifying prints become `ctx.markers.plotshape`
calls; `MarkerSeriesController` sorts and commits them once per
bar-transition through the real `createSeriesMarkers()` plugin. No
`TA.04`-migrated indicator renders through `TA.03`'s draw kernel or
`TA.02`/`TA.02b`'s `ta.*` math library -- confirmed by direct grep, zero
matches outside test files for both. Neither is a defect: both are real,
tested, wired-up infrastructure that simply has no consumer yet, the same
way a library ships ahead of its first caller. `TA.02`'s own evidence doc
already discloses this for the math library; this ticket confirms it also
holds for the draw kernel.

## Cross-ticket interaction sweep

- **Whale Detector vs. `ctx.trades`/`tradeAvailability`.** Does not
  depend on either -- confirmed directly in `whaleDetectorIndicator.ts`'s
  own docstring and by grep. It kept its pre-existing `markers` prop
  pipeline (`MainPanel.tsx` computing stats, `ChartPanel.applyMarkerSnapshot`)
  because the generic marker system has no hit-test equivalent for hover
  tooltips. `TA.04`'s own migration ticket justified including Whale
  Detector partly on this dependency; that justification does not hold,
  the same way `VPIN Cloud`'s "liveTick" and `Delta Divergence`'s
  "crossAttachments" justifications didn't. A recurring pattern across
  this whole workstream, not three unrelated misses: a ticket's own
  illustrative justification assumed a mechanism the code doesn't
  actually have. Not a defect in the shipped indicator -- its real,
  pre-existing pipeline is untouched and correct.
- **Order Flow / Delta Divergence vs. the generic draw-kernel/marker-
  controller-per-pane model.** Neither renders through it. Order Flow's
  CVD needs a line, a histogram, and a candlestick series simultaneously
  (the generic series-creation path only ever builds `LineSeries`); Delta
  Divergence attaches directly to Order Flow's own hand-built CVD series,
  which was never reachable through the generic model in the first place
  (see the `crossAttachments` finding below). Both stay correctly on
  `ChartPanel.tsx`'s existing bespoke wiring.
- **Registry duplicate-id guard + menu categorization** with real
  production indicators, `TA.02b`'s math-only additions, and the demo all
  coexisting. Pass: `indicatorRegistry.ts`'s 12 entries are unique,
  `assertRuntimeDefinitions` enforces it at construction, and `TA.02b`'s
  ~36 added `ta.*` factories are correctly not separately registered
  (they were never meant to be).

## Two real defects found and fixed

1. **A cosmetic settings change could force an unwanted full replay.**
   `indicatorRuntime.ts`'s `settingsRequireRecompute` treated any
   `custom`-kind schema field marked `affects: "recompute"` as a reason
   to replay on *any* settings change at all, including an unrelated
   `cosmetic` field's -- live today in `sessionProfileIndicator.tsx`
   (a `custom` recompute field for `ticksPerRow` alongside a `cosmetic`
   boolean for `showSinglePrints`). Harmless only because Volume
   Profile's `onBar` is inert; would misbehave the moment any indicator
   combines this field mix with real per-bar work. Fixed by letting a
   `custom` field optionally declare its own `key`, scoping the
   runtime's change-detection to that key instead of the whole settings
   object when present; the old whole-object fallback stays for a
   genuinely multi-key custom field with no `key` declared. Applied to
   Volume Profile's and Delta Divergence's custom fields. Mutation-tested:
   reverting the fix reproduces the false-positive replay exactly.
2. **`crossAttachments`/`getPrimitive` were silently, permanently dead**
   -- declared in `indicatorTypes.ts`, never consumed anywhere in
   `indicatorRuntime.ts` or `ChartPanel.tsx`. The one real case that
   motivated the field (Delta Divergence attaching to Order Flow's CVD
   line) doesn't even fit its own designed shape: `attachToLineKey`
   assumes the target is produced through the generic `lines` output,
   but Order Flow's CVD is hand-built (`lines: []`) for the reason
   above. Building the field "as specified" would not have solved the
   case it exists for; redesigning it now, with only one (non-fitting)
   example to validate against, risks baking in the wrong shape.
   Decided: keep the field (it names a real future need -- self-serve
   attachment onto another indicator's own series -- that a new author
   may legitimately hit), but stop letting it fail silently.
   `createIndicatorRuntime` now throws at registration if any def
   declares a non-empty `crossAttachments`, naming
   `deltaDivergenceIndicator.tsx`'s real `ChartPanel.tsx` hand-wiring as
   the pattern to copy today. Mutation-tested: removing the check
   reproduces the silent-no-op exactly.

## Bundle size and performance: checked, no action taken

Production bundle: `528.89 KB` minified / `162.44 KB` gzip, one chunk,
trips Vite's default 500 KB warning. Checked directly rather than
assumed: the unused `ta.*` math library is already fully tree-shaken out
(grepped the built file for `trading-signals` class names -- zero
matches); the bundle is legitimately `react`/`react-dom`/
`lightweight-charts`/application code. Code-splitting was considered and
declined: this is a single-page terminal where the chart loads
immediately for every session (no deferred-load boundary to exploit),
and it runs as a personal dev tool rather than a public product behind a
CDN (the usual cross-deploy vendor-cache benefit barely applies). No
config change made.

A synthetic frame-rate/object-count benchmark was considered and
declined for the same reason a metric shouldn't be manufactured without
a decision riding on it: every place that actually accumulates unbounded
state under load already has a real, named cap --
`LARGE_TRADE_BUBBLES_MAX_MARKERS_PER_BAR` (50), the marker retention
buffer's per-provider ceilings (60,000 / 5,000) with per-time-bucket
limits, and `useMarketData.ts`'s ten separate bounded trackers for trade
correlation, pending bars, and profile/VPIN accumulation. No performance
complaint exists to investigate, and a CPU-time proxy benchmark with no
browser/GPU harness behind it would produce a number nothing could act
on either way.

## `largeTradeBubbles`' fate: kept

It is the only real, live proof that `ctx.trades`, `tradeAvailability`,
`ctx.markers`, and the draw kernel's marker pipeline work together in
production, not just in unit tests. Removing it now that the real Whale
Detector is migrated (for lifecycle only, not rendering -- see above)
would leave that whole pipeline with zero production consumers. Kept as
the documented example it already is; its `"Large Trade Bubbles (Demo)"`
label and `"community"` category already say so honestly.

## Documentation corrected

- `TA.01-indicator-authoring-core-evidence.md` -- its "Scope" section
  claimed `crossAttachments` was "needed by Delta Divergence's eventual
  migration" and that no existing L1 indicator was migrated yet; both
  superseded by `TA.04`'s actual landing. Corrected.
- `TA.03-plotting-rendering-wrapper-evidence.md` -- predicted `TA.04`'s
  Whale Detector migration would define what `getPrimitive` returns, and
  that `TA.04` would replace 8 hand-built primitives with `draw.*`.
  Neither happened; corrected to state what actually did.
- `TA.03.5-trade-tape-access-evidence.md` -- predicted Whale Detector
  would migrate onto `ctx.trades` "as a later ticket's job." It didn't,
  for a real, checked reason (hit-test). Corrected.
- `P4.03-delta-divergence-evidence.md` -- closed the loop on this
  ticket's `crossAttachments` decision (guard, not build) rather than
  leaving it as open-ended "future work."
- `TA.02-ta-math-library-evidence.md` and the other `P4.xx` docs spot-
  checked (`P4.01`, `P4.09`, `P4.10`, `P4.12`, `session-killzones`):
  already accurate, no changes needed.
- No dedicated `TA.02b`/`TA.04` evidence docs created: `TA.02b`'s work
  already lives inside `TA.02`'s own doc under its own heading, and
  `TA.04`'s per-indicator decisions already live in each indicator's own
  `P4.xx`/`session-killzones` doc -- this repo's established convention.
  A parallel summary doc would duplicate, not clarify.

## Verification

`npm run check`: lint clean both workspaces, `apps/runtime` 99/99 suites
(2,692 tests, unaffected), `apps/web` 92/92 suites (1,362 tests, +7 from
this ticket's two fixes), production build green. Every finding above
was verified real before being fixed, given a named regression test, and
mutation-tested against the exact line it protects.

## Not yet built, by design

The real `crossAttachments` mechanism -- deferred until a second real
cross-pane use case exists to validate a redesigned shape against, not
guessed from the one case that doesn't fit today's. Bundle
code-splitting and a synthetic performance benchmark -- both considered
directly and declined above, not silently skipped.
