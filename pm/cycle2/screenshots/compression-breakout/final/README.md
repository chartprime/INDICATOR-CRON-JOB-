# Compression Breakout (20): final screenshot set

Taken on `build/compression-breakout` after merging main d065f7a (table inset
from the price axis, no crosshair dots on SDK lines), on the scratch fixture
runtime that serves a chained compression series (JS port of the harness
generator: an up break that holds, a down break that fails, an up break that
holds), each state cut at the live edge as a closed bar. Cream chart at the
UX standard's two zoom levels; dark chart (`data-theme="dark"`) for states 3,
4 and 6; the dialog on the Inputs tab with Advanced closed and open, and the
Visibility tab.

| State (UX notes §3) | Files | Table rows |
|---|---|---|
| 1 warm-up | 01-warming-up-zoomed-out/in | `Warming up · 26 of 40 bars` (single row), nothing drawn |
| 2 forming range | 02-range-forming-zoomed-out/in | `Range 64877.93–65088.85` · `Trend warming · 142 of 205` · `Range forming · 2 of 6` · `—` |
| 3 established range | 03-range-established-zoomed-out/in, 03-range-established-dark-zoomed-out/in | `Range · 30 bars · width 1.8×`, edge lines, trend border |
| 4 confirmed break | 04-confirmed-break-zoomed-out/in, 04-confirmed-break-dark-zoomed-out/in | `Break ↑ · range+vol`, solid arrow, `Last ↑ 16:49 · range+vol` |
| 5 faded arrow | 05-faded-arrow-zoomed-out/in | `Break ↑ · range only`, faded arrow |
| 6 failed break | 06-failed-break-zoomed-out/in, 06-failed-break-dark-zoomed-out/in | `Failed break` (amber), arrow + circle, amber-bordered box, `Last failed ↓ 16:49` |
| 7 held outside | 07-held-outside-zoomed-out/in | `Held outside · 5 bars`, `Last held ↑ 16:49 · 5 bars` |
| 8 no range, held box drawn | 08-watching-with-held-box-zoomed-out/in | `No range` · `Trend ↑ · MA 50/200` · `Watching · width 14.4×` · `Last held ↑ 16:40 · 5 bars` |
| dialog | 10-dialog-inputs-advanced-closed, 10-dialog-inputs-advanced-open, 10-dialog-visibility | three primary controls, two hints, Advanced group, Visibility toggles |

The timestamps in the rows are the fixture's clock at capture, not market
times. The earlier checkpoint set (01–05 in the parent folder) predates the
UX pass and the main merge.
