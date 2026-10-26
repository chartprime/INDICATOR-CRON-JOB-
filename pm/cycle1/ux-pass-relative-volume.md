# UX pass: Relative Volume (Time of Day), branch `build/relative-volume`

## Screenshots (readable in three seconds?)

| # | Verdict | Why |
|---|---|---|
| 01 zoomed out | Yes | Flat purple line near 1, two blue circles on the spikes, 1/2/3 marks, table `RVOL 1.1× · 4 prior`. |
| 02 zoomed in | Yes | Purple above 1, grey below, faint fill; nothing competes. Headroom to 4 is by design. |
| 03 learning | Yes | Empty pane, `RVOL — · 4 prior`, `Learning · 4 of 10 prior`. But see string note below. |
| 04 forming | Yes | `Forming · vs full bar`; tail segment lighter. |
| 05 4h | Yes | Empty pane, `Needs 1m to 1h`. |
| 06 dark | Partly | Chrome is dark, canvas cream; proves nothing about the dark chart (deviation f). |
| 07 Inputs | Yes | Two controls, two one-line hints, Advanced closed. |
| 08 Advanced open | Yes | `Minimum prior bars`, `Clock`. |
| 09 Visibility | Yes | Two toggles, three colours. |

## Deviations

- (a) Empty status cell when ready: **accept**; screens 01/02 show no visible strip. Smallest SDK change if the PM wants it: in `apps/web/src/lib/chart/draw/table.ts` add `clear(): void` to `TableHandle`, implemented as `update<TableData>(handleId, (data) => ({ ...data, pendingGrid: {} }))` (five lines), plus one case in `draw/tests/` asserting the committed grid empties after `flushTableCells`; the DOM renderer iterates `committedGrid` keys, so it needs nothing. Not needed for acceptance.
- (b) No `recolor` on `rvol`: **accept** if a colour-picker change shows at once; if it does not, **fix** by setting `affects: "recompute"` on `lineColor`, `hotColor`, `rollingColor` (lines 193–195).
- (c) Two hints on Inputs: **accept**. My pre-build notes approved one hint per control; the standard's "one at most" meant one explanatory paragraph, and I will reword it.
- (d) "on earlier sessions": **accept**; it is my approved hint text, and "sessions" here is calendar meaning, not a count.
- (e) 13 hot bars: **accept**; 0.28 per 100 is far under the 2-per-100 budget and the doc states the thirteenth.
- (f) Dark chrome only: **accept**; the canvas palette follows Historical Mode, which needs layer 1. SMA already uses `#8672b3` and `#2563eb` on the dark chart; add the Historical screenshot when layer 1 exists.

## Strings versus the approved list

All table strings, labels, options and hints match the approved list exactly. Screen 03 reads `Learning · 4 of 10 prior`, so it was taken with `minSessions = 10`; the code is right (`requiredPriorOf` returns `min(minSessions, sessions)`). **Fix**: retake it at defaults so it reads `Learning · n of 3 prior`.

## Handover checklist

- [x] Default view at two zoom levels, cream chart
- [ ] Dark chart (deferred to Historical Mode with layer 1)
- [x] Inputs tab ≤3 controls; Advanced holds the rest
- [x] Every settings key in the schema; presets (test-enforced)
- [x] Warm-up row visible on first use; nothing drawn as zero
- [x] Markers under the density cap (0.28 per 100 bars)
- [x] Doc page: question, default view, controls, alert conditions, warm-up, replay caveats, fixed reference marks, markers confirm at close; no tooltip claimed

Verdict: approve for merge once the learning screenshot is retaken at defaults and (b) is confirmed.
