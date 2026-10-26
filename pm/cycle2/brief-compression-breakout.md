# Build brief: Compression Range Breakout (round 3, last plan round, after the PM's pivot)

OHLCV specialist for the PM. Shared rules: `PM/WORKER-BRIEF.md`,
`PM/CAPABILITIES.md`, `PM/cycle1/ux-standard.md` (binding),
`PM/cycle1/validation-protocol.md`; structure as `brief-rvol-clock.md`.
Reviews: `pm/log/codex/20261026T151836Z-...` (round 1), `20261026T153353Z-...`
(round 2). The PM's rulings and the pivot are listed in the change lists.

## The trading question

"Did price leave an established compression range with activity behind the
break bar, and did it come back inside?" Trend is secondary context: it
colours a border and a table row, it never decides.

## Why a fixed range, not a squeeze (the pivot)

The round-3 scratch comparison showed a frozen 20-bar range qualified by
width (k = 2) matching or beating the Bollinger-inside-Keltner squeeze on
every design metric: hits 20/20 versus 18/20, filtered early events 0 versus
10, level validity 20/20 versus 18/18, outcome fixtures 10/10 versus 9/10,
range-control markers 0.4 versus 10.8 per 1,000. The fixtures are monotone
contractions, which favour a fixed-range qualifier, so this is not a claim
that squeezes are worse on real data. The pivot is justified by simplicity
(one ring fewer, no band arithmetic, one sentence: "price has stayed inside a
range narrower than twice its recent bar range") plus equal or better numbers.
The squeeze qualifier stays as a test-only variant, and the live run and the
v2 clause keep the question open.

## Target user and decision

Intraday and swing breakout traders on BTC, ETH, ES, NQ, AAPL, TSLA. Decision:
act on a close outside the compression range, stand aside once it fails, or
treat it as counter-trend context. Descriptive only: "range+vol" means both
activity tests passed on the break bar; "held outside 5 bars" means the
failure window expired, not that a trade worked.

## Identity

- Folder `apps/web/src/lib/indicators/compression-breakout/`; def
  `compressionBreakout.ts`; pure state machine `compressionBreakoutMath.ts`;
  tests in `tests/`, including the test-only baseline and variant defs.
- id `compressionBreakout`, label `"Compression Breakout (20)"`, category
  `"technical"`, placement `{ kind: "overlay" }`, `maxReplayBars` 10,080.
- `OHLCV_POLICY`: reads `bar.open/high/low/close/volume`, `bar.ts_open`,
  `bar.interval_ms`, `bar.closed` only. Every archived instrument; equities
  fine; protocol check 9 N/A, stated in the doc. No `timeframeGate`.

## Data, validity and storage

**Price valid**: open, high, low, close finite, `high ≥ low`, `low ≤ close ≤
high`. **Volume valid**: finite, `≥ 0`. An invalid-price bar contributes
nothing (no ring entry, no range change, no age, no event; status `No usable
price`). Invalid volume keeps the price context; the bar enters no volume
observation and its volume cannot be tested (`vol n/a`). Missing bars
contribute nothing. **Means span valid observations across gaps.** No library
stream drives an event (round 1 evidence); own committed-bar rings, primitives
from `relative-volume/relativeVolumeMath.ts`:

| Ring | Capacity | Serves | Tail |
|---|---|---|---|
| high, low | `rangeLength` (≤ 50) | range width and edges | provisional for the status row; the range opens at commit |
| true range | `2 × rangeLength` (≤ 100) | reference width (the `rangeLength` valid bars preceding the window); range denominator (the preceding 20 valid observations) | excluded from both |
| volume | 20 | volume denominator | excluded |
| close | `trendSlow` (≤ 400) | both MAs | excluded |
| fast-MA history | 6 | slope | excluded |

**True range** uses the previous committed close; on the first bar and on the
first bar after a gap it is `high − low`, so an overnight jump never enters a
reference or a denominator. The slot-median volume baseline is a v2
`volumeRule` option (`createRelativeVolumeEngine`, `reading.rvol`); v1 uses
the rolling denominators so the grade is testable on 400-bar fixtures.

## Calculation

Settings: `rangeLength` 20, `widthMultiple` k 2, `minCompressionBars` 6,
`confirmMultiple` 1.5, `failBars` 5, `holdBars` 40, `trendFast` 50,
`trendSlow` 200. Constant `RANGE_LIFETIME` 500 committed bars.
`committedIndex` counts committed valid-price bars.

1. **Tail and snapshot.** The first dispatch of a new `ts_open` creates the
   tail record and copies the committed state `S`: the five rings,
   `prevClose`, `lastCommittedTsOpen`, `committedIndex`, the active range
   (`hi, lo, openedAt, age, broken, excursion`), the held ranges with
   remaining hold, `lastEvent`. About 600 numbers once per `ts_open`, never
   per revision. **`S` is never modified**; every evaluation, revision and
   correction works on a copy `W`.
2. **Gap (on `W`).** If `ts_open − W.lastCommittedTsOpen > interval_ms`, drop
   the active range from `W` (held ranges stay); status `Gap · range reset`.
   An invalid-price tail cannot reset the committed range.
3. **Provisional values from `W` plus the tail.** `qualified` = width of the
   last `rangeLength` committed highs and lows (`rangeLength − 1` plus the
   tail, status row only) `≤ k ×` mean true range of the `rangeLength` valid
   bars preceding that window; `widthRatio = width / reference` (`null` if the
   reference is 0 or short). Denominators `avgRange20`, `avgVolume20`: mean of
   the preceding 20 valid observations, available only when 20 exist and the
   mean is `> 0`. `gradeBasis` per component = denominator available **and**
   this bar's value valid: 0 none, 1 range, 2 volume, 3 both testable. Trend:
   `fastMA`, `slowMA` over committed closes; slope = `fastMA` now versus five
   committed bars earlier; `up` if `close > slowMA` and slope `> 0`, `down` on
   the mirror, `flat` otherwise; `unknown` until `trendSlow + 5` committed
   closes, or whenever `trendFast ≥ trendSlow`.
4. **Decision, exactly one per bar, read only against `W.active`.**
   - `W.active.broken`: close inside the frozen `[lo, hi]` → `failed`; else
     `committedIndex − brokenIndex === failBars` → `heldOutside`; else
     `pending`. Window = the `failBars` committed bars after the break bar,
     last included.
   - else `W.active` exists and close `> hi` or `< lo`: if `age ≥
     minCompressionBars` → break up / down, tests on testable components only
     (`trueRange ≥ confirmMultiple × avgRange20`, `volume ≥ confirmMultiple ×
     avgVolume20`), `breakGrade` 3 both passed, 1 range only, 2 volume only,
     0 none; if `age < minCompressionBars` → `abandoned` (the range never
     established; silent, not held). Break beats lifetime on the same bar.
   - else `W.active` exists and `committedIndex − openedAt ≥ RANGE_LIFETIME`
     → `expired`.
   - else `none`.
5. **Commit, first dispatch with `closed === true`, in this order.**
   (a) every held range's countdown decrements; one at 0 is removed and its
   handle freed (`holdBars` 0: a retired range disappears at once);
   (b) valid high, low, close and true range enter their rings, valid volume
   its ring, `fastMA` the slope ring;
   (c) the decision is applied: `break` → `broken = {committedIndex, dir,
   grade, basis}`, `excursion` = this bar's high/low; `failed`, `heldOutside`,
   `expired` → the range moves to the held list (`holdBars` remaining;
   `expired` styled like `heldOutside`), `active = null`, `lastEvent`
   updated; `abandoned` → `active = null`, nothing held, no event; `pending`
   → excursion extended, `age += 1`; `none` with an active range → `age += 1`;
   (d) no active range, the window is ready, `qualified` on the committed
   rings, decision `none` → open `{hi, lo}` = the committed window's extremes,
   `openedAt: committedIndex, age: 0`. **Edges never move after opening**; the
   rolling qualification is not re-checked (a frozen range ends only by
   break, abandonment or lifetime);
   (e) `prevClose`, `lastCommittedTsOpen`, `committedIndex` advance; `W`
   becomes the new `S`. `age` counts committed bars inside the frozen edges.
6. **No widening, no re-arm.** A failed break retires its range; a new range
   must requalify and establish again.
7. **Superseded without close**: nothing written; the provisional marker is
   removed on the next dispatch.
8. **Corrections**: a closed re-dispatch of the tail re-runs 2 to 5 from a
   fresh copy of the untouched `S` (cancelled break, removed failure, grade
   change, invalid-to-valid and back). Older corrections arrive as `REBUILT`.
9. **Outputs** (`readOutput`). Persistent: `rangeHigh`, `rangeLow` (active
   range only, incl. pending; `null` otherwise), `widthRatio`, `qualified`,
   `trend` −1/0/1 or `null`, `rangeAge`, `pending` 0/1 (1 from the bar after
   the break through the outcome bar). Pulses, non-zero on the event bar
   only: `breakDir`, `breakGrade`, `gradeBasis`, `failed`, `heldOutside`.
   `rangeHigh`/`rangeLow` are the line outputs.
10. **Pinned transitions** (seed-7 breakout, break at 220, `holdBars` 40):
    `breakDir = 1`, `breakGrade = 3`, `gradeBasis = 3` at 220 only; `pending =
    1` at 221..225; `heldOutside = 1` at 225; `rangeHigh/rangeLow` non-null
    through 225, `null` from 226 until a new range; the held range is drawn
    226..265, its handle freed at 266's commit before any range opens at 266;
    `lastEvent` reads `↑ 220 · range+vol` from 220's commit. `holdBars` 0:
    nothing drawn at 226. A range opened at `committedIndex` 100 with no break
    expires at 600's decision. A range left at `age` 3 is abandoned silently.
11. **Readiness per component.** Qualification and range creation from
    zero-based index `2 × rangeLength − 1` (39 at default; `qualified` and
    `widthRatio` `null` before); grading from index 20 with no invalid bars
    before; trend from `trendSlow + 5`. First possible break at index `39 +
    minCompressionBars`.
12. **Table strings, ≤ 30 characters.** Row 1 `Range 61240–61480`
    (instrument precision, no thousands separators; if the row would exceed
    30 characters both edges round to six significant digits), `Warming up ·
    12 of 40 bars`, or `No range`. Row 2 `Trend ↑ · MA 50/200`, `Trend ↓ ·
    MA 50/200`, `Trend flat · MA 50/200`, `Trend · warming 120/205`, `Trend ·
    fast ≥ slow`. Row 3, first match: `No usable price`; `Gap · range reset`;
    `Failed break`; `Held outside · 5 bars`; `Range expired · 500 bars`;
    break strings `Break ↑ · range+vol`, `range only`, `vol only`,
    `unconfirmed` (both testable), `range · vol n/a`, `vol n/a` (volume not
    testable; range passed / failed), `vol · range n/a`, `range n/a`, `no
    baseline`; `Pending · 2 of 5 bars`; `Range · 9 bars · 1.6×`; `Range
    forming · 3 of 6`; `No range`. Row 4 `Last · ↑ 12:34 · range+vol` or `—`.
    Visible from bar 0; provisional styling on the forming tail.
13. **No future data; fail closed.** Values at bar t use bars with `ts_open ≤
    t.ts_open`; any non-finite intermediate yields `null`.

## Default view

Overlay. The active range as a `draw.box`: fill always neutral purple
`#8672b3` at 0.12 alpha; the 1 px border takes the trend colour (bull / bear
pair, purple when flat or unknown), so direction is carried only by the
arrows. A forming range (`age < minCompressionBars`) draws at 0.06 alpha with
no border; an established one at 0.12 with the border. A retired range is held
`holdBars` bars at 0.06 alpha: `heldOutside`/`expired` keep the purple border,
`failed` takes `--warn`. Pool of 8 handles (one active, seven held); a ninth
evicts the oldest held. Drawing skipped when `drawNow === false`.
`rangeHigh`/`rangeLow` lines, width 1, purple. Table as rule 12, top right,
four rows. Nothing drawn before readiness except the table.

## Controls

Primary (three): `rangeLength` "Range length (bars)" 20, 10..50;
`minCompressionBars` "Minimum compression (bars)" 6, 2..30; `confirmMultiple`
"Confirm above (×)" 1.5, 1.0..3.0, step 0.1; all recompute. Advanced:
`widthMultiple` "Width limit (× bar range)" 2, 1..4, step 0.5; `failBars` 5
(1..20); `holdBars` 40 (0..200); `trendFast` 50 (10..199); `trendSlow` 200
(20..400). Visibility: `showMarkers`, `showRanges` (true, recompute). No
colour pickers. One hint per control; a `staticHint` naming the readiness
rules. `releaseBars` is removed (see Round 3 pivot, item 7).

## Alert conditions

Two event types. **Break**: `arrowUp` below or `arrowDown` above the bar in
the bull/bear pair, drawn when `breakGrade ≥ 1` (solid at 3, 50 percent alpha
at 1 or 2); grade 0 is table and range only. **Failed break**: `circle`,
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
  `longCompressionBars` (adversarial replay): `compressionBreakoutBars` with
  `leadBars` 40, `compressionBars` 700, `count` 1,400; the test rebuilds from
  index 300.
- Correction script on seed 7: bar 220 closed as the break, re-dispatched
  closed with `close = compressionHigh − 1` (event gone, range stays active);
  bar 220 with `volume = NaN` then valid (`vol n/a` to `range+vol`); bar 221
  closed inside then outside (failure removed, `pending`). Each must equal a
  clean feed of the corrected series.
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
avgVolume20`). Outcome fixtures score the labelled failure or hold.

## Baselines and variant (test-only defs with their own code)

1. **Squeeze-qualified variant** (`squeezeQualifiedVariant`): the round-2
   machine, qualified by Bollinger (window mean, population standard
   deviation, ×2) inside a Keltner-style channel (same mean, ×1.5 mean true
   range) over own finite-window rings, `minSqueezeBars` 6, `releaseBars` 3;
   otherwise identical grades, outcomes, lifetime and filter.
2. **TTM release** (`ta.ttmSqueeze(20, 2, 20, 1.5)`): `isSqueezed` turns
   false after ≥ 6 true bars; direction = sign of `momentum`.
3. **Bollinger crossing** (`ta.bollinger(20, 2)`): first close outside a band
   after an inside close.

All three run on the design seeds, the evaluation seeds and the live run,
side by side with the product. **v2 clause**: if the live run or the
evaluation seeds show the squeeze variant catching coils the range misses
(hits or level validity), v2 adds `qualifier: range | squeeze` under Advanced;
otherwise it stays out.

## Acceptance

Scratch replication (`sim3lib.mjs`, `sim4.mjs`, `sim5.mjs`, specialist
scratchpad) over 20 seed-directions; **provisional until reproduced through
the runtime**:

| Def | Hits | Wrong dir | Early all (lead) | Early filtered | Level valid | Failure fixture | Hold fixture | Range control marked/1,000 |
|---|---|---|---|---|---|---|---|---|
| Product (range, k 2, min 6) | 20/20 | 0 | 4 (0) | 0 | 20/20 | 10/10 | 10/10 | 0 |
| Squeeze variant | 18/20 | 0 | 60 (42) | 10 | 18/18 | 9/10 | 9/10 | 10.8 |
| TTM release | 18/20 | 0 | 32 (12) | 0 | n/a | none | none | — |
| Bollinger crossing | 20/20 | 0 | 118 (82) | 38 | n/a | none | none | — |

Trend control 0 for all; unmatched: Bollinger 2, others 0; every product hit
is grade 3. Values tried for k: 2, 2.5, 3, 4 (all-events early 8, 8, 28, 66
without the age gate; filtered 0, 0, 0, 24; hits 20/20 at every k); k 2 is
the strictest value that qualifies every design coil. With the age gate the
product's early events fall to 4 and its range-control markers to 0. The
rolling re-check variant (`releaseBars` 3) was tried and rejected: 16/20 hits,
8/10 on both outcome fixtures, seed 7 without any range.

Bounds, set from the frozen-range numbers with margin: hits ≥ 18/20 with level
valid on every hit; failure fixture ≥ 9/10; hold fixture ≥ 9/10; filtered
early ≤ 4; range control ≤ 5 marked per 1,000; trend 0; no wrong-direction
events; `maxPerBar` 1. The doc page states the design-seed numbers for all
four defs, and the evaluation seeds 17..21 in full. Live observation (REST
transport, `data-api.binance.vision`): 10,080-bar BTC-USDT and ETH-USDT
snapshots plus 30 minutes of forming revisions and closes, driven with
`driveLive` and compared with `replayCapture`: equal outputs and confirmed
markers, no fault, ≤ 40 markers per 1,000 on 1m and resampled 5m; the four
event lists quoted side by side in the doc. Density, honesty and replay only.

## Replay policy

(a) **Bounded lifetime.** No range lives past `RANGE_LIFETIME` 500 committed
bars, so every state has a finite horizon: `max(trendSlow + 5, 500 + holdBars
+ failBars)` retained bars (545 at defaults). After the horizon, live and a
replay from the first retained bar must be exactly equal in every output,
event, marker and drawn range; the REBUILT equivalence test asserts a non-zero
compared count after it.
(b) **Pre-horizon difference, documented and tested.** On
`longCompressionBars` with a REBUILT from index 300, the live instance's range
(opened once the window qualifies, expired 500 bars later, a new range after)
and the rebuilt instance's range (opened once its own 40-bar window qualifies)
differ in `openedAt`, `rangeAge`, `rangeHigh`/`rangeLow` and the drawn range
until the horizon; the test pins the expected difference bar by bar and checks
that both see the break at 740 with the same grade. The doc says that after a
reload a range older than the retained history is seen only from the first
retained bar.

## Success criteria

1. Hand-computed values on a 50-bar fixture: reference width, qualification,
   readiness per component, frozen edges, read-before-write test, grade and
   basis with pinned denominators, failure, hold, abandonment, expiry, held
   countdown with `holdBars` 40 and 0, pool eviction, `trendFast ≥ trendSlow`.
2. Protocol checks 1 to 7 and 10 PASS, 9 N/A: truncation invariance on
   breakout and trend fixtures; live-versus-replay equal at zero tolerance;
   duplicate, REBUILT, time gap (`firstBarAfterGapIndex` shows `Gap · range
   reset`, its true range is `high − low`, nothing earlier changes), forming
   tail, the correction script, the invalid-price tail leaving `S` intact.
3. Pooled p99 `onBar + readOutput` under 0.05 ms over bars 1..10,080 with the
   snapshot copy in the timed region; rollover with 10,080 outputs, no markers
   before retention, heap slope within 3× the harness floor, 8 handles.
4. UX: three primary controls; strings as rule 12; screenshots at two zooms:
   forming range, established range, confirmed break, failed break, held
   outside, warm-up, dialog with Advanced closed and open, cream and dark.
5. Doc page and README row; `validate-docs`, web suite, `tsc`, lint green;
   Codex code review APPROVED; validator ACCEPT.

## Limitations to state

Descriptive, not predictive. "Held outside 5 bars" means the failure window
expired, nothing about profit; a return inside is failure of this breakout
rule, not evidence for fading. Readiness: range at `2 × rangeLength` bars,
grading at 20 valid bars, trend at `trendSlow + 5`. The qualifier is a
fixed-length range, not a volatility squeeze; the fixtures favour it and the
live run is where the two are compared. A failed break retires its range; a
second break needs a fresh range. Ranges expire at 500 bars. Equity overnight
gaps reset the range and their first true range is `high − low`. A range older
than the retained history is seen only from the first retained bar after a
reload. Unit-free.

## Deferred

`qualifier: range | squeeze` (v2 clause); re-arm and widening; time-of-day
volume rule; swing pivots; break-bar delta grade; session-open rule.

## Seams for L1 and L2

`rangeHigh`, `rangeLow`, `rangeAge`, `pending`, `breakDir`, `breakGrade`,
`gradeBasis`, `failed`, `heldOutside`: the L1 tape tally grades intensity on
the `breakDir` bar; the L2 Break Defense Monitor watches liquidity at the
edges while `rangeAge ≥ minCompressionBars`. Shared through
`compressionBreakoutMath.ts`.

## Budget

One build run, UX before the end, at most two fix rounds after Codex code
review and validation; a third failure returns the concept to the backlog.

## Ten-line summary

1. A committed 20-bar high/low range qualifies when narrower than twice the mean true range of the 20 bars before it; edges freeze at once.
2. Six committed bars inside make it established; leaving earlier abandons it silently.
3. Break = close outside the frozen edges; break beats lifetime.
4. Grade = true range and volume versus the preceding 20 valid observations; basis says what was testable; `vol n/a` is distinct from a failed test.
5. Failure = back inside within 5 bars; "held outside 5 bars" otherwise; both retire the range.
6. No re-arm; ranges expire at 500 bars; a gap resets the range and its first true range is `high − low`.
7. Neutral purple range; trend colours only the border and row 2; arrows carry direction.
8. Snapshot never modified; corrections re-run from it; pulses on the event bar, `pending` persists.
9. Exact replay equality after a 545-bar horizon; the pre-horizon difference is pinned on `longCompressionBars`.
10. Squeeze variant, TTM release and Bollinger crossing reported beside the product on design seeds, evaluation seeds and the live run; v2 clause for the qualifier.

## Effort estimate

M: five small rings, one state machine, the snapshot copy, three test-only
defs and the adversarial replay test; UX half a day; one validation loop
expected.

## Plan-gate history

Round 1 REVISE: library streams change box creation; freeze tested edges;
transition priority; rollback; denominator validity; table edges and basis;
fair baselines; outcome fixtures; evaluation seeds; `maxReplayBars`. Round 2
REVISE: outcome wording; storage versus `squeezeLength`; trend settings;
implicit transitions; snapshot mutability; readiness; `bar.open`; `vol n/a`;
post-gap true range; colour semantics; unbounded state versus replay; an
independent frozen-range baseline; wrong-direction category.

## Round 2 changes

Own-state finite-window bands; frozen tested edges; no re-arm; whole-state
snapshot with restore-and-reapply; validity rules and `gradeBasis`; table
edges and test-basis strings; all-events and filtered comparison with
direction-correct hits; two frozen generators and a correction script;
`maxReplayBars` 10,080; deferred list.

## Round 3 changes (rulings 1 to 10)

"Held outside 5 bars" wording and its limitation; storage table with tail
inclusion stated; `trendFast`/`trendSlow` as set with readiness and the
`fast ≥ slow` string; pinned transitions, pulses and the `pending` seam;
untouched snapshot with working copy; readiness per component; `bar.open`,
`vol n/a`, `gradeBasis` as testability, post-gap true range; neutral fill,
trend border and row, edge formatting; lifetime 500 and the adversarial
replay fixture; independent frozen-range baseline with k frozen, wrong-
direction category and the PM's decision sentence.

## Round 3 pivot (PM decision on the round-3 finding)

1. Product renamed Compression Range Breakout: folder, id, label and math
   module as ruled; qualifier = committed `rangeLength` high/low range with
   width ≤ k × mean true range of the preceding `rangeLength` valid bars, k 2
   under Advanced; edges frozen at qualification; `minCompressionBars` 6
   counts committed bars inside the frozen edges (ruling 1).
2. Primary controls `rangeLength`, `minCompressionBars`, `confirmMultiple`;
   Advanced `widthMultiple`, `failBars`, `holdBars`, `trendFast`, `trendSlow`;
   `bbMult`/`kcMult` removed (ruling 2).
3. Bollinger-inside-Keltner kept as `squeezeQualifiedVariant`, a test-only def
   reported beside the product everywhere, with the v2 `qualifier` clause
   (ruling 3).
4. Bounds set from the frozen-range numbers with margin; the doc states the
   design-seed numbers for all four defs (ruling 4).
5. Rationale paragraph added (ruling 5). 6. Effort M (ruling 6).
7. **Deviation flagged for the PM**: `releaseBars` is removed rather than
   kept under Advanced. Its squeeze meaning (tolerating a flickering band
   condition) has no counterpart once edges are frozen; the only reading
   available, re-checking the rolling qualification and discarding after
   `releaseBars` misses, was simulated and drops the product to 16/20 hits and
   8/10 on both outcome fixtures (seed 7 never establishes a range), while a
   frozen range that ends only by break, abandonment or lifetime gives the
   numbers in Acceptance. Fixture `longSqueezeBars` renamed
   `longCompressionBars`; the replay horizon is unchanged at 545.

## PM note before Codex round 3

Pivot accepted as rewritten. `releaseBars` removed: a frozen range ends only
by break, abandonment or lifetime, and the simulated alternative meaning was
harmful (16/20 hits). File renamed from `brief-squeeze-breakout.md`; the
plan-gate history above refers to the earlier name. Round 3 is the last plan
round; the PM then approves by authority with remaining objections written in
as amendments.
