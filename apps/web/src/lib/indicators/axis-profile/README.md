# Axis profiles

What the profiles drawn beside the price axis share: the Live Delta Profile and the Live Order Book Profile are both one bar per price row growing leftwards from the axis, and everything about where they sit is the same. This folder holds that; each profile's folder holds what it shows.

## Files

- `axisProfilePrimitive.ts` — `AxisProfilePrimitive`, the lightweight-charts series primitive both profiles extend. It owns the chart hooks, the two pane views (bars under the candles, the rest above), the frame geometry (`right` against the axis or the neighbour, `reach` from the settings' share of the pane but never over the last candle, `rowPx`), the easing of every bar towards its target width (`EASE_SHARE` per animation frame), the animation loop that repaints only when the source's `version` moved, a bar is still sliding or a flash is still fading, the room kept beside the axis through the time scale's right offset (`restoreRoom` puts it back after a refit), claimed through `lib/chart/rightOffsetRoom.ts` like the heatmap ladder's, so the chart takes the widest claim and gets its own offset back once every claim is dropped, the two grey handles (`handleAt` and `reachShareAt` for the edge, `baseHandleAt` and `resizeNeighbour` for the base; drawn always unless the profile's `_handlesAlwaysShown` says no, in which case only the one under the pointer, which ChartPanel reports through `setHandleHover`), the row marker both profiles draw (`drawRowMarker`: arrow beside the last candle, dotted line to the axis, tick at the axis end; `MARKER_GAP_PX`, `MARKER_ARROW_PX`) and the `AxisNeighbour` chain: `setNeighbour` puts the profile left of whatever is drawn against the axis, and `widthPx(paneWidth)` is what the profile takes in turn, so another profile can sit left of it. A subclass brings its source (`version`, `rowWidth`), the merge factor for the timeframe and zoom (`_factor`), its bars with their share of the biggest (`_place`), a bar's target width (`_targetWidth`), the marked row (`_markerIndex`), its reach bounds (`_shareBounds`), and the two draws (`drawBars`, `drawLabels`); optionally the flashes (`_flashes`), room it reserves right of the candles (`_reservePx`), the gap before its bars (`_barEdgeGapPx`), a fallback anchor price, and what to do when the source changes or a frame is built.
- `axisProfileLayout.ts` — the pure handle geometry: whether a point is on the edge line or the base line, the reach share a drag points at, the width a neighbour should take; the label font for a row height (`labelFontPx`, 11 px down to 8); `withAlpha` for a colour at another alpha.

## Tests

```
npx vitest run src/lib/indicators/axis-profile
```
