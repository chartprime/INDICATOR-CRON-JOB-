# Compression Breakout (20)

[Handbook](../../README.md) · [Indicator index](README.md) ·
[Data for indicator authors](data-for-indicator-authors.md) ·
[Setting presets](setting-presets.md)

Code: `apps/web/src/lib/indicators/compression-breakout/`
(`compressionBreakout.ts` is the registry definition, `compressionBreakoutMath.ts`
the pure state machine, `tests/` the evidence, including the test-only
comparator defs). Registry id `compressionBreakout`, label "Compression
Breakout (20)", category technical, overlay. The code wins over this page.

## The question it answers

"Did price leave an established compression range with activity behind the
break bar, and did it come back inside?"

A compression range is a committed 20-bar high/low range narrower than twice
the mean true range of the 20 bars before it: price has stayed inside a band
narrower than two of its recent bars. Its edges freeze the moment it opens.
Once six later closed bars stayed inside, a close outside is a break, graded by
what the break bar did (its true range and its volume against the preceding 20
bars). A close back inside within five bars is a failed break; otherwise the
break is "held outside 5 bars". Trend (MA 50 against MA 200) colours a border
and one table row and never decides anything. Descriptive only: "range+vol"
says both activity tests passed on the break bar, "held outside" says the
failure window expired. Neither says anything about profit, and a return
inside is a failure of this breakout rule, not evidence for fading it.

## Calculation

One bar at a time; `onBar` never rebuilds from an array. Three named states:
`P`, the committed state before the current bar, kept untouched while that bar
is the tail; `W`, the working view every evaluation reads (`P` plus the gap
rule, never written); `C`, the committed state after the bar's first closed
dispatch, which seeds the next `ts_open`.

1. **Validity.** A bar's price is valid when open, high, low and close are
   finite with `low ≤ open, close ≤ high`; its volume when finite and at least
   zero. An invalid-price bar contributes nothing except one tick of the clock
   (lifetime, failure window, hold countdown): no ring entry, no range change,
   no age, no event, status `No usable price`. An invalid volume keeps the
   price context; the bar enters no volume observation and its volume cannot
   be tested (`vol n/a`). Missing bars contribute nothing. Means span valid
   observations across gaps.
2. **Rings of committed valid bars.** Highs and lows (20), true ranges (40),
   volumes (20), closes (`trendSlow`), the fast MA's last six values. No
   library stream drives an event: a never-closed bar left in one would change
   range creation. True range uses the previous committed close; on the first
   bar and on the first bar after a gap it is `high − low`, so an overnight
   jump never enters a reference or a denominator.
3. **Gap.** Below one-day bars, a `ts_open` more than one interval after the
   last committed bar drops the active range on `W` (status `Gap · range
   reset`); held ranges stay. Daily and weekly bars never reset on calendar
   gaps. An invalid-price bar skips the reset with every other commit step.
4. **Qualification.** The window of the last 20 committed highs and lows
   qualifies when `width ≤ widthMultiple × mean true range of the 20 valid bars
   before the window`. Readiness is 40 valid committed bars (zero-based index
   39 at the earliest); `qualified` and the width ratio are `null` before.
5. **Opening and establishment.** A range opens at the commit of a qualifying
   bar with no active range and no event, with `age` 0 and its edges frozen
   at the window's extremes. Each later committed bar whose close stays inside
   adds one to `age`. A close outside before `age ≥ minCompressionBars` abandons
   the range silently (nothing held, no event). The earliest eligible break at
   defaults is index 46.
6. **Break and grade.** Eligible and `close > hi` (or `< lo`): a break. The
   denominators are the means of the preceding 20 valid true ranges and
   volumes, available only when 20 exist and the mean is positive.
   `gradeBasis` says which components could be tested on this bar
   (denominator available and the bar's value valid): 0 none, 1 range, 2
   volume, 3 both. `breakGrade`: 3 both passed (`range+vol`), 1 range only,
   2 volume only, 0 none. The threshold is `confirmMultiple` (1.5) on both.
7. **Outcome.** From the bar after the break: a close back inside the frozen
   edges, or beyond the opposite edge, is a failure; otherwise, `failBars`
   committed bars after the break (the last included, invalid bars counted)
   the break is held outside. Either retires the range into the held list for
   `holdBars` committed bars (`holdBars` 0 keeps nothing). No widening, no
   re-arm: a new range must qualify and establish again. A range that never
   breaks expires 500 committed bars after it opened and is held like a
   held-outside one.
8. **Order of a commit.** Held countdown first (a range at zero is freed, the
   rest count down); then the rings; then the decision (break, failure, hold,
   expiry, abandonment, pending or inside); then a new range may open; then
   the clock advances.
9. **Snapshot and corrections.** `readOutput` reads a snapshot taken after the
   decision and before any retirement, so the edges are still reported on the
   outcome bar and `pending` is 1 from the bar after the break through the
   outcome bar. A forming revision evaluates against `P` only. A closed
   re-dispatch of the tail recomputes `C` from `P`: a cancelled break, a
   removed failure, a changed grade and a validity flip in either field are one
   rule. A correction to an older bar reaches the indicator as a full replay.
   A tail superseded without closing writes nothing; the hole it leaves is a
   gap.
10. **Trend.** `up` if the close is above the slow MA and the fast MA rose over
    the last five committed bars; `down` on the mirror; `flat` otherwise;
    unknown until `trendSlow + 5` valid closes, and off when `trendFast ≥
    trendSlow`.

### Outputs

Line outputs `rangeHigh` and `rangeLow`: the snapshot edges whenever a range
exists, forming included; a range's last point (its outcome or abandonment
bar) is painted transparent so the line never joins one range to the next
with a slope that never existed. Numeric seams for the harness and for later
layers: `activeHigh`, `activeLow` (the same snapshot under the names the
harness tests use), `heldCount`, `widthRatio`, `qualified`, `trend`, `rangeAge`, `pending`, and
the event pulses `breakDir`, `breakGrade`, `gradeBasis`, `failed`,
`heldOutside`, `expired`, non-zero on the event bar only. The L1 tape tally
grades intensity on the `breakDir` bar; the L2 Break Defense Monitor watches
displayed liquidity at the edges while the range is established.

## What the trader sees

A neutral purple box over the compression range: faint with a faded border
while forming, fuller with a 1 px border in the trend colour once established
(bull/bear pair, purple when flat or unknown); direction is carried only by
the arrows. A retired range stays drawn for `holdBars` bars with a fainter
fill, purple border when held outside or expired, amber when failed. The two
edge lines while a range exists. Markers: `arrowUp` below the break bar or
`arrowDown` above it, solid when both activity tests passed, faded when one
did, none when neither; an amber circle in the bar on a marked break's
failure. One decision per bar, so at most one marker per bar. A four-row table
top right: `Range 66878.17–67237.22` (low–high at the instrument's precision,
six significant digits if the row would exceed 30 characters) or `No range`;
`Trend ↑ · MA 50/200` / `Trend ↓` / `Trend flat` / `Trend warming · 120 of
205` / `Trend off · fast ≥ slow`; the state (`No usable price`, `Gap · range
reset`, `Failed break`, `Held outside · 5 bars`, `Range expired · 500 bars`,
`Break ↑ · range+vol` with the bases `range only`, `vol only`, `unconfirmed`,
`range, vol n/a`, `vol n/a`, `vol, range n/a`, `range n/a`, `no baseline`,
`Holding · 2 of 5 bars`, `Range · 9 bars · width 1.6×`, `Range forming · 3
of 6`, `Watching · width 2.6×`); and the last event (`Last ↑ 12:34 ·
range+vol`, `Last failed ↑ 12:34`, `Last held ↑ 12:34 · 5 bars`, `Last expired
12:34`, `—`). During warm-up the table shows the single row `Warming up · 12
of 40 bars` and nothing is drawn. Every string is at most 30 characters.

The table sits inside the price axis and SDK lines show no crosshair dots
once the UX branch `ux/table-axis-inset` (main d065f7a) is in the build.

## Controls

Inputs: `Range length (bars)` 20 (10..50; the range needs twice this many bars
before it can qualify), `Minimum bars inside` 6 (2..30), `Activity threshold
(×)` 1.5 (1..3, step 0.1: one test passing gives a faded arrow, both a solid
one). Advanced: `Width limit (× bar range)` 2 (1..4, step 0.5), `Failure window
(bars)` 5, `Keep retired range (bars)` 40 (0..200), `Trend fast MA (bars)` 50
(10..199), `Trend slow MA (bars)` 200 (20..400). Visibility: `Show break
markers`, `Show ranges`. Every setting replays the retained bars when changed,
the two visibility toggles included (markers and boxes need a replay to be
rebuilt). No colour pickers in this version. Every key is in the schema, so
presets work.

## Alert conditions (rendered; no notification channel exists)

**Break**: a close outside an established range with at least one activity
test passed (`breakGrade ≥ 1`); arrow on the break bar. **Failed break**: a
marked break whose price closed back inside within five bars; circle on that
bar. Unconfirmed breaks (`breakGrade` 0) are table and box only. Measured on
the controls at defaults: 0 markers per 1,000 bars on the ranging and the
trending fixtures (see Evidence).

## Historical Mode, replay and the retained history

Policy `OHLCV_POLICY`: candles only, every archived instrument, equities
included (no side is ever read; protocol check 9 is not applicable). Live and
replay agree exactly for the same bars.

What a reload can change (brief amendment 1): the chart keeps 10,080 one-minute
bars, so a replay starts from the first retained bar. Every window is finite,
but a range opened before the retained history exists live and not in the
replay, and a continuously qualifying market reopens ranges at different
phases. Outputs, events, markers and drawn ranges are therefore required equal
from the first retained bar at which the live instance holds no active and no
held range, once the 20 denominators and `trendSlow + 5` closes lie inside
retention; before that bar the difference is the range phase, pinned in
`tests/compressionBreakoutValidation.test.ts` on a 3,000-bar constant-width
fixture rebuilt at offsets 0, 137 and 500 (the edges are identical on both
sides, only age and expiry differ) and on a 1,400-bar coil rebuilt from index
300 (both instances break at 740 with the same grade; their edges may differ
before). After a reload a range older than the retained history is seen only
from the first retained bar.

## Limitations

Descriptive, not predictive. Readiness: the range at 40 valid bars, grading
at 20 valid bars, the trend at `trendSlow + 5`. The qualifier is a
fixed-length range, not a volatility squeeze; the synthetic fixtures are
monotone contractions that favour it, and the live run is where the two were
compared (the squeeze qualifier stays a test-only variant; see the v2 clause
in the brief). A failed break retires its range; a second break needs a fresh
range. Ranges expire at 500 bars. Intraday equity ranges reset at the
overnight gap (the session-open rule is deferred). Unit-free; no sided volume.

## Evidence

Design seeds 7..16 (both directions, 20 seed-directions; outcome fixtures 20
each; controls 5 × 1,000 bars), reproduced through the runtime in
`tests/compressionBreakoutBaseline.test.ts` and pinned there:

| Def | Hits | Wrong dir | Early all (lead) | Early filtered | Level valid | Failure fixture | Hold fixture | Range control markers/1,000 | Trend control markers/1,000 |
|---|---|---|---|---|---|---|---|---|---|
| Product (width ≤ 2×, min 6) | 20/20 | 0 | 4 (0) | 0 | 20/20 | 20/20 | 20/20 | 0.0 | 0.0 |
| Plain frozen range (no width qualifier) | 20/20 | 0 | 42 (24) | 16 | 8/20 | 20/20 | 20/20 | 4.6 | 0.0 |
| Squeeze-qualified variant (the squeeze qualifier on this machine, not the round-2 state machine with pause and release) | 20/20 | 0 | 28 (20) | 6 | 14/20 | 20/20 | 20/20 | 5.0 | 0.0 |
| TTM release (timing and density only) | 18/20 | 0 | 32 (12) | 0 | n/a | none | none | 12.6 | 0.0 |
| Bollinger crossing (timing and density only) | 20/20 | 0 | 118 (82) | 38 | n/a | none | none | 47.6 | 0.0 |

Scoring: matched = a break event within two bars after the labelled break;
hit = the first matched event has the labelled direction; wrong direction = a
break event opposing the label inside that window; early = before the labelled
break (lead-phase count in brackets); filtered = events whose bar passes the
identical activity test (true range or volume at least 1.5× the preceding
20-bar mean); level valid = the frozen edges lie inside the labelled compression
range and the close is beyond the tested edge. The plain frozen-range baseline
shares every rule but the width qualifier: its early events and its level
validity are what the qualifier buys.

Evaluation seeds 17..21 (frozen criteria, run once; `tests/compressionBreakoutEvaluation.test.ts`):

| Def | Hits | Wrong dir | Early all (lead) | Early filtered | Level valid | Missed | Unmatched | Failure fixture | Hold fixture | Range control markers/1,000 | Trend control markers/1,000 | Max per bar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Product (width ≤ 2×, min 6) | 10/10 | 0 | 0 (0) | 0 | 10/10 | 0 | 0 | 10/10 | 10/10 | 0.0 | 0.0 | 0 |
| Plain frozen range (no width qualifier) | 10/10 | 0 | 22 (12) | 4 | 6/10 | 0 | 0 | 10/10 | 10/10 | 4.6 | 0.0 | 1 |
| Squeeze-qualified variant | 10/10 | 0 | 16 (12) | 2 | 10/10 | 0 | 0 | 10/10 | 10/10 | 5.0 | 0.0 | 1 |
| TTM release (timing and density only) | 10/10 | 0 | 10 (10) | 0 | n/a | 0 | 0 | none | none | 12.6 | 0.0 | 1 |
| Bollinger crossing (timing and density only) | 10/10 | 0 | 56 (38) | 14 | n/a | 0 | 0 | none | none | 47.6 | 0.0 | 1 |

The product meets the frozen criteria (hits ≥ 9 of 10 with level valid on every hit, filtered early ≤ 2, no wrong-direction event, failure and hold fixtures ≥ 4 of 5 per direction) with 10/10, 0, 0, 10/10 and 10/10.

Performance (this container, Node 24, `tests/compressionBreakoutPerf.test.ts`):

- Pooled replay of 10,080 one-minute bars, five timed runs after three warm-ups, `onBar` plus `readOutput` with the per-bar snapshot copy inside the timed region: p50 0.0042 ms, p99 0.0240 ms, max 9.761 ms (ceiling 0.05 ms at p99).
- Real activation replay: p99 0.0205 ms, wall 80 ms (ceilings 0.5 ms and 2 s).
- Forming bar with a range warmed on 10,080 bars, 500 revisions alternating a breaking and an inside close (250 marked): p99 0.0904 ms (ceiling 1 ms).
- Rollover of 1,000 bars past retention: 10080 bars retained, outputs {"rangeHigh": 10080, "rangeLow": 10080}, 0 stale markers, 462 B per extra bar (within 3× the harness floor of about 370 B).

Live observation on real Binance spot candles through the REST transport
(`data-api.binance.vision`), density and replay only, no label; every def
replayed over the same recordings (`pm/log/validation/compressionBreakout/live-run.md`
holds the full event lists):

**BTC-USDT.** Recorded 2026-10-26 17:17 to 17:47 UTC: snapshot 10,080 bars,
1,819 bar frames (30 closes, 31 open times; 1,772 REPLACED_EDGE, 31 APPENDED,
16 REBUILT late closes; 22 snapshot re-sends, each replayed as the chart
does). Live versus the replay of the 10,080 retained bars: first quiet bar at
retained index 228, 9,852 bars compared after it with 0 seam disagreements
and 0 confirmed-marker differences, 3 cold-start cells before it, no fault.
Ranges opened over the seven days: 20.

**ETH-USDT.** Recorded over the same half hour: 1,242 bar frames (30 closes,
1 REBUILT, 7 snapshot re-sends). First quiet bar at index 205, 9,875 bars
compared with 0 disagreements, 54 cold-start cells before it, no fault.
Ranges opened: 26.

Density of every def on the same retained bars (confirmed markers; the two
timing comparators mark every event):

| Def | BTC events on 1m | BTC markers on 1m (per 1,000) | BTC markers on 5m (per 1,000) | ETH events on 1m | ETH markers on 1m (per 1,000) | ETH markers on 5m (per 1,000) |
|---|---|---|---|---|---|---|
| Product (width ≤ 2×, min 6) | 20 | 7 (0.7) | 4 (2.0) | 20 | 7 (0.7) | 3 (1.5) |
| Plain frozen range (no width qualifier) | 438 | 234 (23.2) | 55 (27.3) | 454 | 249 (24.7) | 50 (24.8) |
| Squeeze-qualified variant (the squeeze qualifier on this machine) | 82 | 43 (4.3) | 22 (10.9) | 134 | 71 (7.0) | 31 (15.4) |
| TTM release (timing and density only) | 16 | 16 (1.6) | 11 (5.5) | 29 | 29 (2.9) | 19 (9.4) |
| Bollinger crossing (timing and density only) | 573 | 573 (56.8) | 119 (59.0) | 589 | 589 (58.4) | 125 (62.0) |

Over the seven retained days the product recorded 10 breaks (6 marked), 5
failures and 5 held outside on BTC, and 10 breaks (8 marked), 5
failures and 5 held outside on ETH. The
squeeze qualifier on this machine fires six to seven times as often as the
width qualifier on these bars; whether it catches coils the range misses is a
question of level validity on labelled data, where the evaluation seeds showed
none (see the v2 clause in the brief). The REBUILT mutations are closes that
arrived after a newer forming bar on the polled transport; each one replays the
retained bars, as in the chart.

## Deviations from the brief

- The comparator defs share the product's engine through a `qualifier` option
  (`width`, `always`, `squeeze`), by design (code review ruling 4): the plain
  baseline isolates the width qualifier under identical machinery, and the
  independent validator's batch reference covers shared-defect risk. The
  squeeze-qualified variant is the squeeze qualifier on this machine, not the
  round-2 state machine with pause and release; nothing here validates that
  round-2 machine.
- The engine's rings are plain numeric rings rather than the keyed
  `ObservationRing` of Relative Volume: corrections are by snapshot restore,
  so no keyed update or eviction rollback is needed.
- The UX pass (`pm/cycle2/ux-notes-compression-breakout.md`) is adopted in
  full: full-colour table, single warm-up row, `Watching · width` row, row-4
  formats, lo–hi edges, box alphas and borders, labels and hints.
