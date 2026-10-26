# UX notes: Compression Breakout (20), mid-build pass

Reviewed against `ux-standard.md` and the approved brief (amendment 7):
`compressionBreakout.ts` and `compressionBreakoutMath.ts` at commit `d0e5090`
on `build/compression-breakout`, screenshots 01–05 in
`pm/cycle2/screenshots/compression-breakout/`. Three-second verdict on 02/03:
box, edge lines and arrow read at once; the table does not (findings 1–4).

## 1. Findings

1. **must · Table is dimmed to 50 % alpha permanently.** `tableRows` applies
   `CB_PROVISIONAL_ALPHA` whenever `reading.confirmed` is false, and
   `commitDrawFlush` runs after every dispatch (`indicatorRuntime.ts` 534,
   695), so the live table always shows the forming bar: every row is grey
   in 02–05. Change: remove `colorOf` from `tableRows`; rows take their full
   colour. Likewise in `drawActive` drop the `reading.confirmed ? 1 : 0.5`
   factor on the fill (the active range would otherwise live at 0.06/0.03).
   Provisional styling stays on markers and on the edge lines' last point only.

2. **must · Warm-up shows four rows, not one.** Rows 1–3 are written as `""`,
   which renders three empty 6 px strips under `Warming up · n of 40 bars`.
   Change: while `reading === null || !reading.rangeReady`, call
   `state.table.cell(0, 0, …)` only; rows 1–3 are first written when ready
   (`tableGridDimensions` sizes the grid from written keys, and a settings
   change recreates the table).

3. **must · Row 4 overflows 30 characters.** `Last · ↑ 12:34 · range · vol n/a`
   is 32, the daily form 33. Change: row 4 drops the dot after `Last` and the
   two "n/a" bases use a comma in both rows (table in §2). Max is 30.

4. **must · "No range" twice (rows 1 and 3).** Keep row 1 `No range` (it is
   the value row) and give row 3 a reason: `Watching · width 2.6×` from the
   provisional `reading.widthRatio` (`Watching` when null). A trader then
   sees how far the rolling window is from the 2× limit instead of a repeat.

5. **must (PM, SDK) · Table overlaps the price-axis labels** (02: `67600.00`
   shows through the table). `draw.table` has only `position`
   (`top-right` | `bottom-right`); `bottom-right` already gets
   `right: bottomTableRightPx` (axis width + 8) and the top-right stack gets
   it only when a card is shown (`ChartPanel.tsx` 3941). Fix is one line
   there: use `{ right: bottomTableRightPx }` for every stack (the state is
   already refreshed at 1898). Builder keeps `top-right`; moving to
   `bottom-right` would collide with the liquidity-voids book table and
   break the house convention.

6. **should · Forming box is invisible.** Purple at 0.06 with no border
   shifts the cream background by about 7 levels and the dark one by 6; a
   forming range cannot be seen on either chart. Change:
   `CB_FILL_FORMING_ALPHA = 0.08` with border `withAlpha(CB_RANGE_COLOR, 0.35)`,
   width 1; `CB_FILL_ESTABLISHED_ALPHA = 0.14` with the solid trend border;
   held ranges 0.06 with border at 0.5 alpha (purple, or `--warn` for
   failed) so they recede behind the active one. Still one fill in 0.12–0.25.

7. **should · Row 1 edge order.** Brief rule 12 reads `Range 61240–61480`
   (low–high); the code prints high–low. Print `lo–hi`.

8. **should · Trader words in rows 2–3.** `Pending · 2 of 5 bars` →
   `Holding · 2 of 5 bars` (pairs with `Held outside · 5 bars`);
   `Range · 9 bars · 1.6×` → `Range · 9 bars · width 1.6×`;
   `Trend · warming 120/205` → `Trend warming · 120 of 205` (the standard's
   warm-up form); `Trend · fast ≥ slow` → `Trend off · fast ≥ slow`.

9. **should · Hints.** `Activity threshold (×)` hint lacks "Replays every
   bar" and opens with jargon; `Minimum compression (bars)` has none.
   Replacements:
   - Range length: keep "The range needs twice this many bars before it can
     qualify. Replays every bar."
   - Minimum bars inside: "Closed bars inside the range before a close outside
     counts as a break. Replays every bar."
   - Activity threshold: "The break bar's range and volume versus the prior
     20 bars: one passing gives a faded arrow, both a solid one. Replays
     every bar."
   One hint per control; nothing else on the Inputs tab.

10. **should · Label.** `Minimum compression (bars)` → `Minimum bars inside`:
    says what is counted. All other labels pass (≤ 4 words, unit in brackets).

11. **could · Markers.** Arrow + amber circle on consecutive bars is readable
    at the 02 zoom; keep both shapes, `size: 1`, circle `inBar`. The faded
    arrow (grade 1–2) at 0.5 alpha of `#26a69a` on cream is untested: deliver
    the faded-arrow screenshot; if it is lost at the 02 zoom, raise the
    marker's faded alpha to 0.65 (markers only, not the table).

12. **could · Edge lines.** No join artefact in 02/03; the transparent last
    point works. The line ends one bar short of the box on the outcome bar,
    which is acceptable. The purple dots on the lines at the crosshair are
    lightweight-charts' default crosshair markers on every SDK line (no
    `crosshairMarkerVisible: false` anywhere); PM may add it beside
    `lastValueVisible: false` in `ChartPanel.tsx`. Not the builder's.

13. **could · Advanced hints.** Width limit: "A range qualifies when narrower
    than this many times the mean bar range before it. Replays every bar."
    Keep retired range: "Bars a failed or held range stays drawn. Replays
    every bar." Others need none.

14. **could · `showMarkers`/`showRanges` are `recompute`** (a 10,080-bar
    replay per toggle). Accepted by the brief; note it in the doc page.

Dark chart: purple `#8672b3`, the bull/bear pair and `#b07a1e` all read on
`#111316`; no colour change needed, but the dark screenshots in §3 are
required before merge.

## 2. Final string table (characters)

Row 1: `Range 66878.17–67237.22` (23, lo–hi, instrument precision; six
significant digits if over 30) · `Warming up · 12 of 40 bars` (26, the only
row during warm-up) · `No range` (8).

Row 2: `Trend ↑ · MA 50/200` (19) · `Trend ↓ · MA 50/200` (19) ·
`Trend flat · MA 50/200` (22) · `Trend warming · 120 of 205` (26) ·
`Trend off · fast ≥ slow` (23).

Row 3, first match: `No usable price` (15) · `Gap · range reset` (17) ·
`Failed break` (12, `--warn`) · `Held outside · 5 bars` (21) ·
`Range expired · 500 bars` (24) · `Break ↑ · range+vol` (19, bull/bear
colour; bases `range only`, `vol only`, `unconfirmed`, `range, vol n/a`,
`vol n/a`, `vol, range n/a`, `range n/a`, `no baseline`; longest 24) ·
`Holding · 2 of 5 bars` (21) · `Range · 9 bars · width 1.6×` (29 at 499
bars) · `Range forming · 3 of 6` (22) · `Watching · width 2.6×` (21) ·
`Watching` (8).

Row 4: `Last ↑ 12:34 · range+vol` (24; same bases, longest
`Last ↑ 26 Oct · range, vol n/a` 30) · `Last failed ↑ 12:34` (19) ·
`Last held ↑ 12:34 · 5 bars` (26) · `Last expired 12:34` (18) · `—`.

Settings: Inputs `Range length (bars)`, `Minimum bars inside`,
`Activity threshold (×)`; Advanced `Width limit (× bar range)`,
`Failure window (bars)`, `Keep retired range (bars)`, `Trend fast MA (bars)`,
`Trend slow MA (bars)`; Visibility `Show break markers`, `Show ranges`.

## 3. Screenshots the package must deliver

Cream chart, defaults, each at the 02 and 03 zoom levels: (1) warm-up, one
table row, nothing drawn; (2) forming range, faint bordered box, row 3
`Range forming`; (3) established range with edge lines, row 1 edges, row 3
`Range · n bars · width`; (4) confirmed break, solid arrow, row 3 `Break ↑ ·
range+vol`; (5) faded arrow (grade 1 or 2); (6) failed break, arrow + circle,
`--warn` held box, row 3 `Failed break`; (7) held outside, row 4 `Last held`;
(8) no range with a held box still drawn, row 3 `Watching`. Dark chart
(`data-theme="dark"`): states 3, 4 and 6 at both zooms. Dialog: Inputs with
Advanced closed, Advanced open, Visibility. Table clear of the axis labels
once finding 5 lands; until then say so in the package.

## PM rulings

All five must items adopted; all should items adopted; could items: the
crosshair-marker one-liner is adopted. Must item 5 (table right inset for
every stack) and the crosshair marker change are SDK-level and go on their own
small branch `ux/table-axis-inset` by the UX specialist, reviewed and merged
before either cycle-2 indicator merges, so both products inherit them. The
builder adopts the rest on `build/compression-breakout` and delivers the
screenshot list above.
