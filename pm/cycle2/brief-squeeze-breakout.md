# Build brief: Squeeze Breakout Context (round 3, last plan round)

OHLCV specialist for the PM. Shared rules: `PM/WORKER-BRIEF.md`,
`PM/CAPABILITIES.md`, `PM/cycle1/ux-standard.md` (binding),
`PM/cycle1/validation-protocol.md`; structure as `brief-rvol-clock.md`.
Reviews: `pm/log/codex/20261026T151836Z-...` (round 1) and
`20261026T153353Z-plan-brief-squeeze-breakout.last.md` (round 2). The PM's
rulings are applied and listed under "Round 2 changes" and "Round 3 changes".

## The trading question

"Did price leave an established compression range with activity behind the
break bar, and did it come back inside?" Trend is secondary context: it
colours a border and a table row, it never decides.

## Target user and decision

Intraday and swing breakout traders on BTC, ETH, ES, NQ, AAPL, TSLA. Decision:
act on a close outside the compression range, stand aside once it fails, or
treat it as counter-trend context. Descriptive only: "range+vol" means both
activity tests passed on the break bar; "held outside 5 bars" means the
failure window expired, not that a trade worked.

## Identity

- Folder `apps/web/src/lib/indicators/squeeze-breakout/`; def
  `squeezeBreakout.ts`; pure state machine `squeezeBreakoutMath.ts`; tests in
  `tests/`, including the test-only baseline defs.
- id `squeezeBreakout`, label `"Squeeze Breakout (20)"`, category
  `"technical"`, placement `{ kind: "overlay" }`, `maxReplayBars` 10,080.
- `OHLCV_POLICY`: reads `bar.open/high/low/close/volume`, `bar.ts_open`,
  `bar.interval_ms`, `bar.closed` only. Every archived instrument; equities
  fine; protocol check 9 N/A, stated in the doc. No `timeframeGate`.

## Data, validity and storage

**Price valid**: open, high, low, close finite, `high ≥ low`, `low ≤ close ≤
high`. **Volume valid**: finite, `≥ 0`. An invalid-price bar contributes
nothing (no ring entry, no box change, no age, no event; status `No usable
price`). Invalid volume keeps the price context; the bar enters no volume
observation and its volume cannot be tested (`vol n/a`). Missing bars
contribute nothing. **Means span valid observations across gaps.**

No library stream drives an event (Codex round 1: a never-closed bar left in
a `trading-signals` stream changes box creation). Own committed-bar rings,
primitives from `relative-volume/relativeVolumeMath.ts`:

| Ring | Capacity | Serves | Tail |
|---|---|---|---|
| close | `trendSlow` (≤ 400) | Bollinger window, both MAs | provisional for bands; excluded for MAs |
| true range | `max(squeezeLength, 20)` (≤ 50) | channel width; range denominator | channel window includes the tail provisionally; the denominator is the preceding 20 valid observations, tail excluded |
| volume | 20 | volume denominator | excluded |
| fast-MA history | 6 | slope | excluded |

Bands are finite windows so rollback and replay are exact. Bollinger: mean and
population standard deviation of the last `squeezeLength` closes (`squeezeLength
− 1` committed plus the tail), `±bbMult`. Channel: the same mean as middle,
`±kcMult ×` mean true range over the same window. This departs from the
library's recursive EMA/Wilder Keltner; `ta.ttmSqueeze` keeps it as the
independent baseline. The slot-median volume baseline is a v2 `volumeRule`
option (`createRelativeVolumeEngine`, `reading.rvol`); v1 uses the rolling
denominators so the grade is testable on 400-bar fixtures.

**True range** uses the previous committed close; on the first bar and on the
first bar after a gap it is `high − low`, so an overnight jump never enters a
denominator or the channel.

## Calculation

Settings: `squeezeLength` 20, `bbMult` 2, `kcMult` 1.5, `minSqueezeBars` 6,
`releaseBars` 3, `confirmMultiple` 1.5, `failBars` 5, `holdBars` 40,
`trendFast` 50, `trendSlow` 200. Constant `BOX_LIFETIME` 500 committed bars.
`committedIndex` counts committed valid-price bars.

1. **Tail and snapshot.** The first dispatch of a new `ts_open` creates the
   tail record and copies the committed state `S`: the four rings,
   `prevClose`, `lastCommittedTsOpen`, `committedIndex`, the active box
   (`hi, lo, openedAt, age, offRun, broken, excursion`), the held boxes with
   remaining hold, `lastEvent`. About 500 numbers once per `ts_open`, never per
   revision. **`S` is never modified.** Every evaluation, every revision and
   every correction works on a copy `W` of `S`.
2. **Gap (on `W`).** If `ts_open − W.lastCommittedTsOpen > interval_ms`, drop
   the active box from `W` (held boxes stay); status `Gap · box reset`. An
   invalid-price tail therefore cannot reset the committed box.
3. **Provisional values from `W` plus the tail.** `squeezeOn = bbUpper <
   kcUpper && bbLower > kcLower`; `depth = bbWidth / kcWidth` (`null` if
   `kcWidth` is 0). Denominators `avgRange20`, `avgVolume20`: mean of the
   preceding 20 valid observations, available only when 20 exist and the mean
   is `> 0`. `gradeBasis` per component = denominator available **and** this
   bar's value valid: 0 none, 1 range, 2 volume, 3 both testable. Trend:
   `fastMA`, `slowMA` over committed closes; slope = `fastMA` now versus five
   committed bars earlier; `up` if `close > slowMA` and slope `> 0`, `down` on
   the mirror, `flat` otherwise; `unknown` until `trendSlow + 5` committed
   closes, or whenever `trendFast ≥ trendSlow`.
4. **Decision, exactly one per bar, read only against `W.active`.**
   - `W.active.broken`: close inside the frozen `[lo, hi]` → `failed`; else
     `committedIndex − brokenIndex === failBars` → `heldOutside`; else
     `pending`. Window = the `failBars` committed bars after the break bar,
     last included.
   - else `W.active` exists, `age ≥ minSqueezeBars`, close `> hi` → break up,
     `< lo` → break down. Tests on testable components only: `trueRange ≥
     confirmMultiple × avgRange20`, `volume ≥ confirmMultiple × avgVolume20`.
     `breakGrade`: 3 both passed, 1 range only passed, 2 volume only passed,
     0 none passed. Break beats release and lifetime on the same bar.
   - else `W.active` exists and `committedIndex − openedAt ≥ BOX_LIFETIME` →
     `expired`.
   - else `none`.
5. **Commit, first dispatch with `closed === true`, in this order.**
   (a) every held box's countdown decrements; a box at 0 is removed and its
   handle freed (`holdBars` 0: a retired box disappears at once);
   (b) valid close and true range enter their rings, valid volume its ring,
   `fastMA` enters the slope ring;
   (c) the decision is applied: `break` → `broken = {committedIndex, dir,
   grade, basis}`, edges frozen at `W.active.hi/lo`, `excursion` = this bar's
   high/low; `failed`, `heldOutside`, `expired` → the box moves to the held
   list (`holdBars` remaining; `expired` styled like `heldOutside`), `active =
   null`, `lastEvent` updated; `pending` → excursion extended, `age += 1`;
   (d) `none` with an unbroken active box: extend `hi/lo`, `age += 1`, `offRun
   = squeezeOn ? 0 : offRun + 1`, `offRun > releaseBars` discards it silently;
   (e) no active box, bands ready, `squeezeOn`, decision `none` → open `{hi:
   high, lo: low, openedAt: committedIndex, age: 1, offRun: 0}`;
   (f) `prevClose`, `lastCommittedTsOpen`, `committedIndex` advance; `W`
   becomes the new `S`. `age` counts committed bars inside the box.
6. **No widening, no re-arm.** A failed break retires its box; a new coil
   starts at the next closed squeeze bar with `age` 1 and must requalify.
   Cost: design seed 10 misses the labelled break (an unconfirmed break 8 bars
   earlier retires the box).
7. **Superseded without close**: nothing written; the provisional marker is
   removed on the next dispatch.
8. **Corrections**: a closed re-dispatch of the tail re-runs 2 to 5 from a
   fresh copy of the untouched `S`; covers cancelled break, removed failure,
   grade change, invalid-to-valid and valid-to-invalid. Older corrections
   arrive as `REBUILT`.
9. **Outputs** (`readOutput`). Persistent: `boxHigh`, `boxLow` (active box
   only, incl. pending; `null` otherwise), `depth`, `squeezeOn`, `trend`
   −1/0/1 or `null`, `boxAge`, `pending` 0/1 (1 from the bar after the break
   through the outcome bar). Pulses, non-zero on the event bar only:
   `breakDir`, `breakGrade`, `gradeBasis`, `failed`, `heldOutside`.
   `boxHigh`/`boxLow` are the line outputs.
10. **Pinned transitions** (seed-7 breakout, break at 220, `holdBars` 40):
    `breakDir = 1`, `breakGrade = 3`, `gradeBasis = 3` at 220 only; `pending =
    1` at 221..225; `heldOutside = 1` at 225; `boxHigh/boxLow` non-null through
    225, `null` from 226 until a new box; the held box is drawn 226..265 and
    its handle is freed at 266's commit, before any box opens at 266;
    `lastEvent` reads `↑ 220 · range+vol` from 220's commit. With `holdBars`
    0 nothing is drawn at 226. A box opened at `committedIndex` 100 with no
    break expires at 600's decision.
11. **Readiness per component.** Bands and `squeezeOn` from zero-based index
    `squeezeLength − 1` (19 at default; `null` through 18); box creation from
    the same index; grading from index 20 with no invalid bars before (20
    preceding valid observations); trend from `trendSlow + 5`. Warm-up copy
    reports the bands' readiness.
12. **Table strings, ≤ 30 characters.** Row 1 `Box 61240–61480` (instrument
    precision, no thousands separators; if the row would exceed 30 characters,
    both edges round to six significant digits), `Warming up · 12 of 20
    bars`, or `No box`. Row 2 `Trend ↑ · MA 50/200`, `Trend ↓ · MA 50/200`,
    `Trend flat · MA 50/200`, `Trend · warming 120/205`, `Trend · fast ≥
    slow`. Row 3, first match: `No usable price`; `Gap · box reset`; `Failed
    break`; `Held outside · 5 bars`; `Box expired · 500 bars`; break strings
    `Break ↑ · range+vol`, `range only`, `vol only`, `unconfirmed` (both
    testable), `range · vol n/a`, `vol n/a` (volume not testable; range
    passed / failed), `vol · range n/a`, `range n/a`, `no baseline` (neither
    testable); `Pending · 2 of 5 bars`; `Squeeze · 9 bars`; `Paused · 1 of
    3`; `No squeeze`. Row 4 `Last · ↑ 12:34 · range+vol` or `—`. Visible from
    bar 0; provisional styling on the forming tail.
13. **No future data; fail closed.** Values at bar t use bars with `ts_open ≤
    t.ts_open`; any non-finite intermediate yields `null`.

## Default view

Overlay. The active box as a `draw.box`: fill always neutral purple `#8672b3`
at 0.12 alpha; the 1 px border takes the trend colour (bull / bear pair,
purple when flat or unknown), so direction is carried only by the arrows. A
retired box is held `holdBars` bars at 0.06 alpha: `heldOutside`/`expired`
keep the purple border, `failed` takes `--warn`. Pool of 8 handles (one
active, seven held); a ninth evicts the oldest held. Drawing skipped when
`drawNow === false`. `boxHigh`/`boxLow` lines, width 1, purple. Table as rule
12, top right, four rows. Nothing drawn before readiness except the table.

## Controls

Primary (three): `squeezeLength` "Squeeze length (bars)" 20, 10..50 (band
window only; denominators stay 20); `minSqueezeBars` "Minimum squeeze (bars)"
6, 2..30; `confirmMultiple` "Confirm above (×)" 1.5, 1.0..3.0, step 0.1; all
recompute. Advanced: `bbMult` 2.0, `kcMult` 1.5 (1..3, 0.1), `releaseBars` 3
(1..10), `failBars` 5 (1..20), `holdBars` 40 (0..200), `trendFast` 50
(10..199), `trendSlow` 200 (20..400). Visibility: `showMarkers`, `showBoxes`
(true, recompute). No colour pickers. One hint per control; a `staticHint`
naming the readiness rules.

## Alert conditions

Two event types. **Break**: `arrowUp` below or `arrowDown` above the bar in
the bull/bear pair, drawn when `breakGrade ≥ 1` (solid at 3, 50 percent alpha
at 1 or 2); grade 0 is table and box only. **Failed break**: `circle`,
`inBar`, `--warn`, only for a marked break. One decision per bar, so at most
one marker per bar; markers are a pure function of the bar's decision.

## Fixtures

Design seeds 7..16, both directions. **Evaluation seeds 17..21 untouched**:
nothing is chosen on them; reported in a separate table.

- `compressionBreakoutBars({ seed, direction })`, harness defaults.
- New generators for `validation/fixtures.ts`, specified before the build.
  `compressionFailedBreakBars`: identical to `compressionBreakoutBars` through
  `breakoutIndex` (same generator stream); bar `breakoutIndex + 1`: `open` =
  previous close, `close = startPrice`, `high = max(open, close) + 5`, `low =
  min(open, close) − 5`, `volume = 1.5 × baseVolume`, `buyShare` 0.5; later
  bars follow the compression generator at progress 1 (half width
  `finalHalfWidth`; draws target, wick, volume, buyShare; `volume = baseVolume
  × (0.5 + 0.2 × random())`). Label `failIndex = breakoutIndex + 1`.
  `compressionContinuationBars`: identical through `breakoutIndex`; later
  bars `open` = previous close, `raw = open + (random() − 0.5) × 16`, `close =
  direction > 0 ? max(edge + 0.2 × initialHalfWidth, raw) : min(edge − 0.2 ×
  initialHalfWidth, raw)` (`edge` the labelled extreme), wick `random() × 8`,
  `volume = baseVolume × (1 + 0.6 × random())`, `buyShare = 0.5 + 0.12 ×
  direction + (random() − 0.5) × 0.08`. Label `heldIndex = breakoutIndex + 5`.
  `longSqueezeBars` (adversarial replay): `compressionBreakoutBars` with
  `leadBars` 40, `compressionBars` 700, `count` 1,400, so the coil outlives
  `BOX_LIFETIME`; the test rebuilds from index 300.
- Correction script on seed 7: bar 220 closed as the break, re-dispatched
  closed with `close = compressionHigh − 1` (event gone, box extends); bar 220
  with `volume = NaN` then valid (`vol n/a` to `range+vol`); bar 221 closed
  inside then outside (failure removed, `pending`). Each must equal a clean
  feed of the corrected series.
- Controls `trendBars`, `rangeBars` (1,000 bars, seeds 7..11); protocol edge
  cases on seed 7; `relativeVolumeCryptoFixture()` for `probeReplayPooled`.

Scoring, identical for every def: **matched** = event index in
`[breakoutIndex, breakoutIndex + 2]`; **hit** = first matched event with the
labelled direction; **wrong-direction matched** = first matched event against
it; **early** = before `breakoutIndex` (lead / compression split);
**unmatched** = after the window; **missed** = no matched event; **level
valid** = on a hit, `hi ≤ compressionHigh`, `lo ≥ compressionLow`, close
beyond the tested edge. Reported for all events and under the identical
range-or-volume filter (`trueRange ≥ 1.5 × avgRange20` or `volume ≥ 1.5 ×
avgVolume20`, denominators as rule 3). Outcome fixtures score the labelled
failure or hold.

## Baselines (test-only defs with their own code)

1. **Frozen range**, the simplest alternative: the 20-bar high/low range of
   committed bars qualifies when its width ≤ `k ×` the mean true range of the
   20 bars preceding that window, **k frozen at 2** (the strictest value that
   still qualifies every design coil; the baseline's strongest form, so the
   tool is compared against its best version). Edges freeze at qualification;
   outside close = break; close back inside within 5 bars = failure; 5 bars
   outside = held; `BOX_LIFETIME` 500; identical activity filter and outcome
   window; a new range may qualify after retirement. Values tried: k 2, 2.5,
   3, 4 (all-events early 8, 8, 28, 66 over 20 seed-directions; filtered 0,
   0, 0, 24; hits 20/20 at every k).
2. **TTM release** (`ta.ttmSqueeze(20, 2, 20, 1.5)`): `isSqueezed` turns
   false after ≥ 6 true bars; direction = sign of `momentum`.
3. **Bollinger crossing** (`ta.bollinger(20, 2)`): first close outside a band
   after an inside close.

## Acceptance

Scratch replication (`sim3lib.mjs`, `sim4.mjs`, specialist scratchpad) over
20 seed-directions; **provisional until reproduced through the runtime**:

| Def | Hits | Wrong dir | Early all (lead) | Early filtered (lead) | Level valid | Failure fixture | Hold fixture | Range control marked/1,000 |
|---|---|---|---|---|---|---|---|---|
| Tool | 18/20 | 0 | 60 (42) | 10 (6) | 18/18 | 9/10 | 9/10 | 10.8 |
| Frozen range k=2 | 20/20 | 0 | 8 (0) | 0 | 20/20 | 10/10 | 10/10 | 0.4 |
| TTM release | 18/20 | 0 | 32 (12) | 0 | n/a | none | none | — |
| Bollinger crossing | 20/20 | 0 | 118 (82) | 38 (10) | n/a | none | none | — |

Trend control: 0 for all. Unmatched: Bollinger 2, others 0. Every tool hit is
grade 3. Variant tried, not selected: `minSqueezeBars` 8 (fewer early events,
same hits; the ES/NQ preset).

Read honestly: on the design fixtures the frozen-range baseline matches or
beats the tool on every metric. The fixture is a monotone contraction with a
far-outside break, which a fixed 20-bar range captures as well as a
squeeze; whether that holds on evaluation seeds and on real candles is what
the build must find out. **If the frozen-range baseline matches the tool on
every metric on the design seeds when reproduced through the runtime, the PM
decides at validation whether the squeeze qualification ships or the concept
returns to the backlog.** Bounds:

- Tool hits ≥ 16/20 with level valid on every hit; failure fixture ≥ 8/10;
  hold fixture ≥ 8/10; wrong-direction matched reported; evaluation seeds
  17..21 reported in full for all four defs.
- Filtered early events ≤ 16 over the 20 seed-directions, reported beside all
  baselines; all-events counts reported.
- Range control ≤ 20 marked markers per 1,000; trend ≤ 5; `maxPerBar` 1.
- Live observation (REST transport, `data-api.binance.vision`): 10,080-bar
  BTC-USDT and ETH-USDT snapshots plus 30 minutes of forming revisions and
  closes, driven with `driveLive` and compared with `replayCapture`: equal
  outputs and confirmed markers, no fault, ≤ 40 markers per 1,000 on 1m and
  resampled 5m; the tool's and the frozen-range def's event lists quoted side
  by side in the doc. Density, honesty and replay only; no label.

## Replay policy

(a) **Bounded lifetime.** No box lives past `BOX_LIFETIME` 500 committed bars,
so every state has a finite horizon: `max(trendSlow + 5, 500 + holdBars +
failBars)` retained bars (545 at defaults). After the horizon, live and a
replay from the first retained bar must be exactly equal in every output,
event, marker and drawn box, and the REBUILT equivalence test asserts a
non-zero compared count after it.
(b) **Pre-horizon difference, documented and tested.** On `longSqueezeBars`
with a REBUILT from index 300, the live instance's coil (opened near 59,
expired at 559, a new coil after) and the rebuilt instance's coil (opened near
319) differ in `openedAt`, `boxAge`, `boxHigh`/`boxLow` and the drawn box
until the horizon; the test pins the expected difference bar by bar and
checks that both see the break at 740 with the same grade. The doc states that
after a reload a coil older than the retained history is seen only from the
first retained bar.

## Success criteria

1. Hand-computed values on a 30-bar fixture: bands, readiness per component,
   box open and extension, read-before-write test, grade and basis with
   pinned denominators, freeze, failure, hold, expiry, held countdown with
   `holdBars` 40 and 0, pool eviction, `trendFast ≥ trendSlow`.
2. Protocol checks 1 to 7 and 10 PASS, 9 N/A: truncation invariance on
   breakout and trend fixtures; live-versus-replay equal at zero tolerance;
   duplicate, REBUILT, time gap (`firstBarAfterGapIndex` shows `Gap · box
   reset`, its true range is `high − low`, nothing earlier changes), forming
   tail, the correction script, the invalid-price tail leaving `S` intact.
3. Pooled p99 `onBar + readOutput` under 0.05 ms over bars 1..10,080 with the
   snapshot copy in the timed region; rollover with 10,080 outputs, no markers
   before retention, heap slope within 3× the harness floor, 8 handles.
4. UX: three primary controls; strings as rule 12; screenshots at two zooms:
   coil, confirmed break, failed break, held outside, warm-up, dialog with
   Advanced closed and open, cream and dark chart.
5. Doc page and README row; `validate-docs`, web suite, `tsc`, lint green;
   Codex code review APPROVED; validator ACCEPT.

## Limitations to state

Descriptive, not predictive. "Held outside 5 bars" means the failure window
expired, nothing about profit; a return inside is failure of this breakout
rule, not evidence for fading. Readiness: bands at `squeezeLength`, grading at
20 valid bars, trend at `trendSlow + 5`. Finite-window bands differ from
EMA-based TTM dots. A failed break retires its coil; a second break needs a
fresh squeeze. Boxes expire at 500 bars. Equity overnight gaps reset the box
and their first true range is `high − low`. A coil older than the retained
history is seen only from the first retained bar after a reload. Unit-free.

## Deferred

Re-arm and widening after a failed break; time-of-day volume rule; swing
pivots; break-bar delta grade; session-open rule (the gap rule covers it).

## Seams for L1 and L2

`boxHigh`, `boxLow`, `boxAge`, `pending`, `breakDir`, `breakGrade`,
`gradeBasis`, `failed`, `heldOutside`: the L1 tape tally grades intensity on
the `breakDir` bar; the L2 Break Defense Monitor watches liquidity at the
edges while `boxAge ≥ minSqueezeBars`. Shared through `squeezeBreakoutMath.ts`.

## Budget

One build run, UX before the end, at most two fix rounds after Codex code
review and validation; a third failure returns the concept to the backlog.

## Ten-line summary

1. Overlay box over a Bollinger-inside-Keltner squeeze from own committed rings; tail provisional, never written; snapshot never modified.
2. Neutral purple box; trend colours only the border and row 2; arrows carry direction.
3. Break = close outside the box as of the bar's open after 6 bars in it; break beats release and lifetime.
4. Grade = true range and volume versus the preceding 20 valid observations; basis says what was testable; `vol n/a` is distinct from a failed test.
5. Edges freeze at the tested values; failure = back inside within 5 bars; "held outside 5 bars" otherwise; both retire the box.
6. No re-arm; boxes expire at 500 bars; a gap resets the box and its first true range is `high − low`.
7. Corrections re-run from an untouched per-bar snapshot; older ones arrive as REBUILT.
8. Pulses (`breakDir`, `breakGrade`, `gradeBasis`, `failed`, `heldOutside`) on the event bar; `pending` persists.
9. Exact replay equality after a 545-bar horizon; the pre-horizon difference is pinned on `longSqueezeBars`.
10. Frozen-range baseline (k = 2) built independently; if it matches the tool on every metric, the PM decides at validation.

## Effort estimate

M+: own-state bands, snapshot copies, the frozen-range def and the adversarial
replay test; UX half a day; one validation loop expected, with a real chance
of a backlog return on the baseline comparison.

## Plan-gate history

Round 1 REVISE: library streams change box creation; freeze tested edges;
transition priority; rollback; denominator validity; table edges and basis;
fair baselines; outcome fixtures; evaluation seeds; `maxReplayBars`. Round 2
REVISE: outcome wording; true-range storage versus `squeezeLength`; trend
settings unspecified; implicit transitions; snapshot mutability; readiness;
`bar.open`; `vol n/a`; post-gap true range; box colour semantics; unbounded
state versus replay; an independent frozen-range baseline; wrong-direction
category.

## Round 2 changes

Own-state finite-window bands; frozen tested edges; no re-arm; whole-state
snapshot with restore-and-reapply; validity rules and `gradeBasis`; table
edges and test-basis strings; all-events and filtered comparison with
direction-correct hits; two frozen generators and a correction script;
`maxReplayBars` 10,080; deferred list.

## Round 3 changes

1. "Held outside 5 bars" replaces "completed" everywhere; Limitations say a
   return inside is failure of this rule, not fade evidence (ruling 1).
2. True-range ring `max(squeezeLength, 20)`; the storage table states which
   windows include the tail and which exclude it (ruling 2).
3. Trend uses `trendFast`/`trendSlow` as set, 6-entry slope ring over the fast
   MA, readiness `trendSlow + 5`, ranges 10..199 and 20..400, `fast ≥ slow`
   gives `unknown` and `Trend · fast ≥ slow` (ruling 3).
4. Transitions pinned with expected outputs (rule 10): held countdown first at
   commit, expiry frees the handle, `holdBars` 0, `lastEvent` at commit,
   pulses versus the persistent `pending` seam (ruling 4).
5. `S` untouched; gap reset and every evaluation on a working copy `W`
   (ruling 5).
6. Readiness per component; "null through bar 19" replaced by index-based
   statements (ruling 6).
7. `bar.open` in the read set; `vol n/a` strings; `gradeBasis` redefined as
   testability; post-gap true range `high − low`; means span gaps (ruling 7).
8. Neutral purple fill; trend on border and row 2 only; arrows carry
   direction; edge formatting rule (ruling 8).
9. `BOX_LIFETIME` 500, horizon 545 at defaults, exact equality after it, the
   `longSqueezeBars` adversarial fixture pinning the pre-horizon difference,
   drawn boxes included (ruling 9).
10. Frozen-range baseline as an independent test-only def, k frozen at 2 with
    all values tried reported, wrong-direction category, level validity,
    provisional numbers, and the PM's decision sentence in Acceptance
    (ruling 10).
