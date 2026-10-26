# Plotting & Rendering Wrapper (TA.03)

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

A Pine-like drawing vocabulary -- mutable `line`/`box`/`label`/`polyline`
objects, `plotshape`/`plotchar` markers, a band/ribbon `fill()`, and a
`table` -- so an indicator author can make computed values look like a
real Pine indicator instead of a flat line, without hand-writing a raw
canvas primitive the way every existing complex indicator does today.

The ticket text scoped this as "new files under `apps/web/src/lib/chart/
draw/` only." Building it end to end required more than that: `ctx.draw`/
`ctx.markers` were frozen empty stubs with no path from an indicator's
`onBar` to any real chart primitive, and `getPrimitive(id)` was an
unimplemented stub. Both are addressed below, the same way TA.02 resolved
its own `ctx.ta` ambiguity -- by deciding a concrete architecture and
documenting the resolution.

## Files

- `apps/web/src/lib/chart/draw/registry.ts` -- the shared, owner-tagged
  store for created-once handles (line/box/label/polyline/table
  identity). `create`/`update`/`remove`/`clearForIndicator`/
  `handlesForOwners`, plus `setRequestUpdate`/`notifyOwner` so a direct
  handle mutation notifies whichever kernel instance is currently
  responsible for that owner.
- `apps/web/src/lib/chart/draw/creationScope.ts` -- `withDrawOwnerScope
  (ownerId, fn)`: clears the owner's previous registry entries, opens
  the *same* stream-creation window `ta.*` already checks (a legitimate
  `createState()` call can freely mix `ta.*` and `draw.*` factories), and
  tracks the current owner id via `currentDrawOwnerId()`.
- `apps/web/src/lib/chart/draw/line.ts`, `box.ts`, `label.ts`,
  `polyline.ts` -- one file per mutable-object kind. Each stores domain
  values (time/price) only, never pixels; coordinate mapping happens
  lazily inside the kernel's render path.
- `apps/web/src/lib/chart/draw/table.ts` -- the hybrid handle: `.cell()`
  buffers into a pending grid; `flushTableCells(ownerId)` (called once
  per bar-transition, never per `.cell()` call) flips it to the
  committed grid actually read for rendering.
- `apps/web/src/lib/chart/draw/fill.ts` -- `computeFillPolygon`, pure
  geometry that splits into disjoint segments at every null gap and
  every sign flip of `(valueA - valueB)`, plus the `pushFillPoint`/
  `overwriteLastFillPoint`/`resetFillPoints` trio shaped like
  `pushOutput`/`overwriteLastOutput`/`emptyOutputs`.
- `apps/web/src/lib/chart/draw/markers.ts` -- `buildSeriesMarker` (Pine
  shape/char to the library's real `SeriesMarker` fields; `plotchar`'s
  character has no native glyph shape, so it's carried in `text`
  against a neutral marker) and `MarkerSeriesController`, the only
  thing that ever calls the real `createSeriesMarkers()` plugin's
  `setMarkers()` -- once per bar-transition, sorted into ascending time
  order (the library's own real constraint, the same one `series.
  setData()` has).
- `apps/web/src/lib/chart/draw/kernelPrimitive.ts` -- `DrawKernelPrimitive`,
  the shared canvas `ISeriesPrimitive`, following the same Renderer/
  PaneView/Primitive 3-tier shape every existing hand-built primitive in
  this codebase already uses. **One instance per pane, not a global
  singleton** -- an own-pane indicator (RSI already ships this way) must
  never have its objects rendered on the main series. Hosts the shared
  `L1L2-V2-087` canvas-restore regression test.
- `apps/web/src/lib/chart/draw/index.ts` -- the public `draw` module
  (`draw.line`/`.box`/`.label`/`.polyline`/`.table`), mirroring `ta/
  index.ts`'s guarded-factory shape. A misused factory (called outside
  `createState()`) warns once and returns a harmless no-op handle,
  never throws -- the same fail-safe philosophy `ta.*` already uses.

Touch points outside `draw/`: `indicatorTypes.ts` (`DrawNamespace`/
`MarkersNamespace` given real shapes), `indicatorRuntime.ts` (below),
`replayBars.ts` (its `createState()` call now uses `withDrawOwnerScope`
so a test exercising `draw.*` through this harness works correctly),
`ChartPanel.tsx` (below), and `ta/creationGuard.ts` (its warning message
hardcoded a `ta.` prefix; generalized to accept a fully-qualified name so
`draw.*` can reuse the same guard honestly -- all 26 `ta.*` call sites
updated to pass `"ta.sma"` etc. instead of relying on the prefix).

## Two lifecycles, three rendering backends

Pine's own real semantics split cleanly, and conflating them would be
wrong:

| Object | Backend | Lifecycle |
|---|---|---|
| line, box, label, polyline | shared canvas kernel (hosts the L1L2-087 test) | created-once handle, top-level factory (`import { draw } from ".../draw"`), same pattern as `ta.*` |
| fill | same shared canvas kernel | per-bar declarative, real `ctx.draw.fill(...)` field |
| plotshape, plotchar | `createSeriesMarkers()` wrapper | per-bar declarative, real `ctx.markers.plotshape/plotchar(...)` fields |
| table | DOM overlay | hybrid: created-once handle + per-bar batched flush |

**Created-once objects** (`line`/`box`/`label`/`polyline`) are plain
top-level factory imports, called once inside `createState()`, guarded
by the same creation-window mechanism as `ta.*`, returning a handle
stored on the indicator's own state and mutated via that handle inside
`onBar`. `ctx.draw`'s namespace stays empty for this half -- not a new
departure, the same one TA.02 already made for `ctx.ta`.

**Per-bar declarative calls** (`plotshape`/`plotchar`, `fill`) are real,
populated `ctx.draw`/`ctx.markers` fields, architecturally identical to
the existing `state` + `readOutput` + `outputs[key][]` mechanism, not
the `ta.*` pattern: `indicatorRuntime.ts` accumulates one value (or
null) per bar into a new per-`ActivationRecord` buffer, committed once
per bar-transition.

## `indicatorRuntime.ts` wiring

- `ActivationRecord` gained `fillPoints`, `fillOptions`, `markerCalls`,
  plus `pendingFillPoint`/`pendingMarkerCalls` (this bar's not-yet-
  committed calls, reset at the top of `makeCtx`).
- `makeCtx` builds real `draw.fill`/`markers.plotshape`/`markers.plotchar`
  closures instead of the frozen empty stub.
- `commitDrawFlush(record, bar, replace)` -- one new step next to the
  existing `pushOutput`/`overwriteLastOutput`, called after every
  successful `onBar` in `fullReplay` and both `onBar` mutation branches:
  push-or-overwrite the bar's fill point, drop-then-reinsert this bar's
  markers on a `replace`, and flush any table's pending cells.
- `fullReplay`'s `createState()` call now uses `withDrawOwnerScope
  (record.drawOwnerId, ...)` instead of the narrower
  `withStreamCreationWindow`. `drawOwnerId` is unique to one runtime/chart
  instance, so two charts using the same logical indicator id cannot clear,
  repaint or render one another's handles.
- `setActive`'s deactivation branch calls `clearForIndicator(record.drawOwnerId)`
  alongside `records.delete(id)`, so a deactivated indicator's drawn
  objects don't outlive it.
- `discardLeading` trims `fillPoints` in lockstep with `outputs`/
  `colors` (index-aligned, one entry per bar). Sparse `markerCalls` are
  trimmed by the first retained timestamp rather than positional index, so a
  long-running chart cannot retain and re-sort an unbounded history of old
  markers.
- New `getFillPoints(id)`/`getMarkers(id)` pulls, mirroring `getOutput`/
  `getLineColors`'s null-when-faulted convention.
- `getPrimitive(id)` is left exactly as it was (an unimplemented stub) --
  see "Not yet built" below.

## `ChartPanel.tsx` wiring

- One `DrawKernelPrimitive` and one `MarkerSeriesController` per pane,
  created lazily in `syncDrawKernelsToPanes()` (called from the existing
  `syncRuntimeIndicatorSeries`, which already resolves each indicator's
  real pane index) and reused across indicators sharing a pane, matching
  the existing `DeltaDivergencePrimitive("price")`/`("cvd")`
  dual-instance precedent.
- The per-pane kernel/controller now tracks its concrete host series. If an
  indicator whose series hosts the primitive is removed while another owner
  remains in that pane, both are detached before series removal and attached
  to the surviving host. A drawing backend therefore cannot stay attached to
  a deleted series.
- `flushDrawState()` -- content, not topology: filters each pane's
  activated owners down to the currently *shown* ones (an
  activated-but-hidden indicator's drawn objects disappear the same way
  its line series' data already does), pulls `getFillPoints`/
  `getMarkers` per shown owner, and forwards a table's committed grid
  into a new `tableOverlays` React state rendered as a DOM overlay
  (`.draw-table-overlay-stack`, top-right corner). Called once per
  bar-transition (`recomputeRuntimeIndicatorSeries`/
  `updateRuntimeIndicatorSeriesForBar`) and once per topology change.
- The pre-existing throwaway `createState()` call inside
  `syncRuntimeIndicatorSeries` (used only to derive a line's initial
  color before any real bar has run) stays on the narrower
  `withStreamCreationWindow` -- **not** `withDrawOwnerScope` -- because
  its result is discarded immediately and never receives an `onBar`
  call. Wrapping it in `withDrawOwnerScope` was tried and found to
  silently corrupt the real, already-populated state from the same
  activation's genuine `fullReplay` call (see Verification).
- Full unmount cleanup detaches every `MarkerSeriesController` before
  `chart.remove()`, matching the order every other primitive in this
  file already detaches in.

## Verification

The focused TA.03/lifecycle regression set and the full web suite pass
(`84` files, `1,280` tests); production build is green. Lint has one
pre-existing unrelated `Terminal.tsx` React-hook dependency warning.

The shared `L1L2-V2-087` regression test (canvas `fillStyle`/
`strokeStyle`/`lineWidth`/save-stack unchanged after a draw call) lives
once on `DrawKernelPrimitive`, mutation-tested by removing its
`finally { context.restore() }` and confirming the test fails.

Five real defects were found and fixed during a fresh, adversarial
self-audit after the initial build+test pass, not just re-affirmed:

1. **Double-`createState()` corruption (severe).** The throwaway
   initial-color-derivation call in `ChartPanel.tsx` was originally
   wrapped in `withDrawOwnerScope`. Its clear-on-entry behavior silently
   wiped every indicator's already-populated line/box/label/table
   objects the instant it activated, since that throwaway state never
   runs `onBar` to repopulate them -- the objects a real indicator
   creates would have rendered as permanently empty. Caught by a new
   integration test asserting real DOM output (`ChartPanel.lifecycle.
   test.tsx`'s `draw.table()` test), not by any of the pure-unit tests
   in `draw/`. Fixed by reverting that one call site to
   `withStreamCreationWindow`; confirmed by grep that exactly 3 real
   `createState()` call sites exist in the whole codebase and only that
   one was wrong.
2. **Cleanup ordering.** `MarkerSeriesController.detach()` was called
   after `chart.remove()` instead of before, breaking the order every
   other primitive in this file already detaches in. Reordered.
3. **React key collision.** The table overlay keyed on `ownerId` alone;
   two tables registered by the same indicator would collide. Keyed on
   `${ownerId}:${handleId}` instead.
4. **Missing marker sort.** `createSeriesMarkers()` requires ascending
   time order (the same real constraint `series.setData()` has).
   Concatenating multiple indicators' per-owner marker arrays on a
   shared pane does not stay sorted. Fixed with an explicit sort inside
   `MarkerSeriesController.setMarkers()`; mutation-tested.
5. **Dead notification code, real fragility underneath.**
   `registry.ts`'s `setRequestUpdate`/`notifyOwner` mechanism was built
   and tested in isolation but never called by any production code --
   a direct handle mutation between bar-transitions (e.g. `line.
   setColor(...)` called mid-session) only repainted by accident, via
   an unrelated unconditional `setOwnerIds()` call inside
   `flushDrawState()`. A future change to skip that call when the owner
   list is unchanged would have silently broken live redraws. Wired
   `DrawKernelPrimitive.setOwnerIds` to register/unregister itself
   against the registry per owner, making repaint-on-mutation a
   deliberate guarantee; mutation-tested (3 cases: mutation while owned,
   mutation after reassignment away, mutation after `detached()`).
6. **Cross-chart owner collision (severe).** The registry originally used
   only `indicator.id` as its owner key. Two live ChartPanel instances using
   (say) an RSI-derived custom drawing would clear and overwrite each other's
   objects; the latest kernel could also steal the other's repaint callback.
   The runtime now assigns a unique draw-owner id per chart instance and the
   panel passes that identity consistently to its kernel, fills and tables.
   A regression test activates the same drawing definition in two runtimes
   and proves deactivating one leaves the other's handle intact.
7. **Unbounded marker retention (performance).** When source bars rolled
   past the retained-history limit, fills and numeric outputs were trimmed
   but sparse marker calls were left forever. The marker plugin consequently
   sorted and resent an ever-growing array. Markers are now pruned by the
   first retained candle timestamp, with a regression test.
8. **Incorrect cloud crossing geometry (accuracy).** A fill changed colour
   at the next candle after a band crossing, drawing a triangular patch using
   the wrong colour. Geometry now inserts the interpolated intersection and
   shares it between the two colour segments.
9. **Stale fill options (accuracy).** Calling `ctx.draw.fill(a, b)` after a
   previous call with custom colours retained the old colours instead of
   returning to defaults. The primitive now removes stored options when none
   are supplied, with a regression test.
10. **Pane-host lifetime (lifecycle).** The per-pane primitive/controller
    could remain attached to a series that had just been removed if it was
    the first active indicator in that pane. Host tracking now explicitly
    detaches before removal and reattaches to the remaining series.

Also verified directly rather than assumed: pane indices are
append-only for the life of a chart instance (`chart.removePane()` is
never called anywhere in `ChartPanel.tsx`), ruling out a scenario where
a freed pane index gets reused by a different indicator within one sync
pass and silently inherits a stale kernel still attached to the removed
series.

## Not yet built, by design

`getPrimitive(id)` stays the pre-existing, unimplemented stub. TA.04's
Whale Detector migration -- the one that actually needed hit-test
geometry -- confirmed this prediction wrong rather than fulfilling it:
it kept its own `WhaleMarkersPrimitive`/`hitTestWhaleMarkers` entirely
outside the runtime, precisely because `getPrimitive` still returns
nothing. `TA.05`'s audit went further and made the gap load-bearing:
`createIndicatorRuntime` now throws if any def declares a
`crossAttachments` (the only real caller `getPrimitive` would ever have
had), so the stub can no longer be silently relied on by a future author.

The 4 "beyond Pine" extras (a higher drawn-object ceiling, live
animation, hover interactivity via the library's real `hitTest()`, a
provable performance guarantee) stay in `02b-Ticket-TA.03b.md`, not
started, per the explicit decision to ship and prove this ticket first.

`TA.04` migrated all 7 of the terminal's pre-existing complex indicators
onto the authoring core, but not onto `draw.*`/`ctx.markers` -- each
found and documented its own specific rendering gap (no histogram/
candlestick series, no hit-test, no per-label opacity control) and kept
its own hand-built primitive. `draw.*`/`ctx.markers`' only real
production consumer remains the `TA.03.5` demo indicator
(`largeTradeBubbles`); RSI/EMA/Bollinger/SMA still use the plain
`lines`/`readOutput` channel from `TA.01`, not this ticket's drawing
vocabulary at all.
