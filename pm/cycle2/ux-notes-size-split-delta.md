# UX notes: Size-Split Delta (large vs small), mid-build pass

Reviewed against `ux-standard.md` and the approved brief (amendments 1–10
plus the onset-only divergence amendment of 2026-10-26): `sizeSplitDelta.ts`
and `sizeSplitDeltaMath.ts` at `bfe9d95` on `build/size-split-delta`,
screenshots 01–05 in `pm/cycle2/screenshots/size-split-delta/`. Three-second
verdict on 02/03: the lines and zero line read at once, purple clearly
primary; the table does not read (findings 1–4) and the arrows are lost at
the 02 zoom (finding 7).

## 1. Findings

1. **must · Row (a) is present but invisible.** The table has three rows;
   row (a) prints `—` in `largeLineColor(reading)`, purple at 50 % alpha
   whenever the reading is unconfirmed. In live the current reading is
   always the forming bar (`commitDrawFlush` runs after every forming
   revision, the Compression Breakout lesson), so row (a) is dimmed
   permanently and reads as a smudge in 02–05. Change: `sizeSplitTableRows`
   uses `SIZE_SPLIT_LARGE_COLOR` for row (a), never the provisional colour.

2. **must · "No feed" while the tape is live.** For the first minute after
   connect (and after a reconnect) the forming window is covered by neither
   the pooled history (ends at `ts_open`) nor the live stretch (`liveSince`
   is the wall clock of the first `trade` frame, after `ts_open`), so
   `coverageOf` returns `"none"` and the row says `no feed` while the trade
   tape streams beside it. This needs its own state, not a softer phrase: it
   means "wait one bar", not "fix your transport". Change: in `fill`, when
   `ticks !== undefined`, coverage is `"none"` and `ticks.liveSince !== null
   && ticks.liveSince < record.windowEnd`, status `tapeStarting`, row (c)
   `Tape live · next bar`. `noFeed` stays for `ctx.ticks` undefined or
   `liveSince === null` (REST). Row (a) stays `—` that minute.

3. **must · Row (b) names a condition the trader cannot find.** 02–05 show
   `Conflict 16:09 · −22/+8.66` with no circle on the chart, because
   `showConflict` is off by default; the standard pairs a table row with its
   marker. Change: the engine keeps `lastDivergence` and `lastConflict`
   separately; the def shows the newest condition whose toggle is on
   (divergence wins on the same bar).

4. **must · Merge `main` before the next screenshots.** The branch predates
   `d065f7a`: the table overlaps the price axis (02: `61900.00` shows
   through) and crosshair dots sit on both lines. Both fixes are on main.

5. **should · Provisional alpha outlives the forming bar.** `confirmed` is
   false for a bar committed by supersession, so its line point and marker
   stay at 50 % forever. Add `committed` to `SizeSplitReading` and make
   `provisional()` read it.

6. **should · Row (a) subject.** `confirms` / `lags` have no subject, and
   the overflow fallback prints a lowercase `no extreme` alone. Fallbacks:
   `Large confirms` (14), `Large lags` (10), `No extreme` (10); the full
   form keeps the brief's wording.

7. **should · Arrows invisible at the 02 zoom.** They are the line's colour
   and sit on the line, so at size 1 they look like kinks (02: six arrows,
   none readable; 03: one, clear). Onset-only drops density, not contrast.
   Change: divergence arrow `size: 2`; circle stays 1. `#8672b3` reads on
   `#111316`; if the arrow is still lost on cream, the PM may allow the
   darker house purple `#4d3d78` for it.

8. **should · Row (b) word.** `Div ↓` reads as "dividend" to a retail
   trader; `Divergence ↓ 12:34 · −8.12k` is 27, so the full word fits.

9. **should · Warm-up row form.** `Learning sizes · 120/200` →
   `Learning sizes · 120 of 200` (27), the house form the PM adopted for
   Compression Breakout.

10. **should · Hints.** The schema has no per-control hint; as Compression
    Breakout does, place a `staticHint` after each primary control (same
    `visibleIf` for `tierSize`) and replace the paragraph's engineering
    words (trade frames, complete windows, store):
    - `Large tier`: "Large means the biggest 2 % of recent prints, learned
      from the first 200 prints after connect, or a size you set. Replays
      every bar."
    - `Large from (BTC)`: "Prints at or above this size count as large. Try
      0.5 BTC, 20 contracts or 2,000 shares. Replays every bar."
    - `Anchor`: "Both lines restart from zero each day or week, or run from
      the first bar the tape covers. Replays every bar."
    - Closing paragraph: "Needs the live tape; lines start one bar after
      connect. Arrow: price made a new high or low that the large prints did
      not. Circle: large and small prints pulling opposite ways."

11. **should · Labels.** `Large from (BTC, try 0.5)` puts advice in the unit
    bracket: `settingsFieldsFor` labels become `Large from (BTC)`, `Large
    from (contracts)`, `Large from (shares)`. `Window (bars)` → `Extreme
    window (bars)`; `Minimum tape share` → `Tape share floor (0–1)`.
    Visibility: `Show small tier` → `Show small tier (blue)`, which also
    says which line is which; `Show per-bar contributions` → `Show per-bar
    lines`. Select option `Top 2% of recent sizes` → `Largest 2% of prints`.
    Others pass.

12. **could · Advanced hints.** `Extreme window`: "A new high or low is
    judged against this many prior bars." `Divergence depth`: "How far short
    the large line must fall, in average bar contributions, before an arrow
    prints." `Tape share floor`: "Bars whose prints cover less than this
    share of the candle volume draw nothing."

13. **could · Ready row unit.** House `ct` for contracts: `≥ 20 ct · tape
    100%` (19).

14. **could · All Visibility toggles are `recompute`** (a 10,080-bar replay
    per click). Accepted by the brief; note it on the doc page.

Lines, zero line, pane: purple 2 / blue 1, dotted `0.00` line with axis
label, no fill, own pane at a third of the chart: pass. No fixed
`autoscaleRange` is right for a cumulative; the doc page says the pane
rescales on scroll. The label passes; the ready row carries the unit.

## 2. Final string table (characters)

Row (a): `L +12.4 · S −8.1 · confirms` (27) · `… · lags` (23) ·
`… · no extreme` (29; with `k`/`M` values up to 32, then drop values) ·
fallbacks `Large confirms` (14), `Large lags` (10), `No extreme` (10) ·
`Need 20 valid bars` (18) · `—` (1).

Row (b): `Divergence ↓ 12:34 · −8.12k` (27) · `Conflict 12:34 ·
+4.21k/−3.12k` (30; over 30 → `Conflict 12:34`, 14) · `—`.

Row (c), first match: `Needs live tape · no feed` (25) · `Needs live tape ·
thinned` (25) · `Tape live · next bar` (20) · `Learning sizes · 120 of 200`
(27) · `Tape share unknown` (18) · `Tape 160% · mismatch` (20) · `Tape 38% ·
below 50%` (20) · `Tape gap · 3 bars` (17) · `Forming` (7) · `≥ 0.106 BTC ·
tape 100%` (23; `≥ 20 ct · tape 100%` 19, `≥ 2k shares · tape 100%` 23).

Settings: Inputs `Large tier`, `Large from (BTC)`, `Anchor`; Advanced
`Extreme window (bars)`, `Divergence depth (×)`, `Conflict strength (×)`,
`Tape share floor (0–1)`; Visibility `Show small tier (blue)`, `Show
divergence arrows`, `Show conflict circles`, `Show per-bar lines`.

## 3. Screenshots the package must deliver

Cream chart, defaults, 02 and 03 zooms: (1) first minute after connect,
`Tape live · next bar`, row (a) `—`; (2) `Learning sizes · n of 200`, pane
empty (fixture without the pool); (3) `Need 20 valid bars`; (4) `Tape 38% ·
below 50%` with the gap in both lines; (5) REST, `Needs live tape · no
feed`, pane empty; (6) forming bar, provisional last point, `Forming`; (7)
`Large confirms`; (8) `Large lags`; (9) divergence arrow, row (b)
`Divergence ↓`; (10) conflict circles on, row (b) `Conflict`. Dark chart
(`data-theme="dark"`): states 6, 9 and 10 at both zooms. Dialog: Inputs
with Advanced closed, Advanced open (both with `Fixed size` selected),
Visibility. All after merging main, so the table clears the axis.

## PM rulings

All four must items adopted, including the new `tapeStarting` status
(`Tape live · next bar`) as a distinct state and row (b) showing only
conditions whose Visibility toggle is on. All should items adopted. Both
cycle-2 builders merge `main` (table inset, crosshair markers) before their
final screenshots. The onset-only divergence amendment stands.
