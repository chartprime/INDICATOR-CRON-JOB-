# UX notes: Relative Volume (Time of Day)

Review of `brief-rvol-clock.md` against `ux-standard.md`. Replacements are exact.

## 1. Violations and strains

| Brief | Rule broken | Replacement |
|---|---|---|
| Hot `#ff9800`, above-1 `#26a69a` | Warn tone is for degraded states; green only for direction | Line `#8672b3`, hot `#2563eb`, below 1 `#787b86` (all read on cream and dark) |
| Grey fill below 1, alpha unspecified | One fill, 0.12–0.25 | `rgba(134,114,179,0.15)` above 1, `transparent` below |
| Widths unspecified; no `autoscaleRange` | Primary 2, secondary 1; fixed pane range | `rvol` 2, `rolling` 1; `autoscaleRange: { min: 0, max: 4 }`, exact value in the table |
| Provisional "lighter styling" | One rule | Same hues at 50 % alpha: `rgba(134,114,179,0.5)`, hot `rgba(37,99,235,0.5)`, marker likewise |
| Marker position unspecified | One shape, placed once | `circle`, `aboveBar`, size 1; size 2 at ≥3 |
| Table row 1 is 32 chars; status rows 36–42 | ≤30 chars, ` · ` separators | §2 |
| Status row blank when ready | Remove the row once live | Two-row table when ready |
| `showRolling` primary; colours under Advanced | Toggles and colours are Visibility | Move both; two primaries remain |
| "Lookback (matching bars)" | Trader words, ≤4 | "Lookback (prior bars)" |

Density (<2 per 100 bars) and the circle comply. Price lines fixed at 1, 2, 3 while `hotThreshold` moves is acceptable if the hint calls them reference marks.

## 2. Approved strings (characters)

Table, top right:
- `RVOL 2.4× · 7 prior` (19), coloured like the line
- `Rolling 1.1× · 20 bars` (22), grey, always shown
- `Learning · 1 of 3 prior` (23)
- `Forming · vs full bar` (21)
- `Needs 1m to 1h` (14)
- `No usable volume` (16)
- `No usable baseline` (18)
- unavailable value `—`

Settings:
- Inputs: `Lookback (prior bars)` (21), hint "Bars at this time of day on earlier sessions. Replays every bar."; `Unusual above (×)` (17), hint "Colours the line and marks the bar. Replays every bar."
- Advanced: `Minimum prior bars` (18); `Clock` (5), options `Automatic`, `New York`, `UTC`.
- Visibility: `Show rolling 20` (15); `Show unusual markers` (20); `Line colour`, `Unusual colour`, `Rolling colour`.
- No other `staticHint` on Inputs; the rest goes in the doc page.

## 3. Screenshots required

1. Ready view, cream chart, two zoom levels, defaults, markers visible, two-row table.
2. Learning: pane empty (no line, fill or marker), table `Learning · 1 of 3 prior`.
3. Forming: table `Forming · vs full bar`, tail bar at 50 % alpha.
4. 4h timeframe: pane empty, table `Needs 1m to 1h`.
5. Dark chart (`data-theme="dark"`), ready view.
6. Dialog: Inputs with Advanced closed, Advanced open, Visibility.
Use `PM/cycle1/screenshots/tools/`; the fixture needs at least four synthetic days so a slot reaches three prior.

## 4. Three-second risks

- "RVOL" is fine: the legend expands it.
- Say "prior" everywhere; never mix "sessions" and "bars" in copy.
- A grey fill below 1 reads as a second signal; removed.
- Blue and purple only, so nothing says buy or sell, which is the point.
- A hot marker that vanishes at the close is acceptable at 50 % alpha; the doc page must say markers confirm at the close.

## Summary

1. Drop orange and green: line `#8672b3`, hot `#2563eb`, below 1 `#787b86`.
2. One fill above 1 at 0.15 alpha, nothing below.
3. Widths 2 and 1; `autoscaleRange` 0–4.
4. Circle above the bar, size 1, size 2 at ≥3; provisional at 50 % alpha.
5. Table strings in §2, all ≤23 chars; status row removed when ready.
6. Two primaries: Lookback (prior bars), Unusual above (×).
7. Advanced: Minimum prior bars, Clock. Visibility: toggles and colours.
8. "Prior" consistently; hints end "Replays every bar."
9. Six screenshot states, including learning and dark.
10. Doc page: markers confirm at the close; lines 1/2/3 are fixed marks.
