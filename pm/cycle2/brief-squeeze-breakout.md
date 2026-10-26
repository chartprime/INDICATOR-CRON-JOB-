# Build brief: Squeeze Breakout Context (round 2, after Codex plan round 1 REVISE)

OHLCV specialist for the PM. Shared rules: `PM/WORKER-BRIEF.md`,
`PM/CAPABILITIES.md`, `PM/cycle1/ux-standard.md` (binding),
`PM/cycle1/validation-protocol.md`; structure as `brief-rvol-clock.md`. Round
1 review: `pm/log/codex/20261026T151836Z-plan-brief-squeeze-breakout.last.md`;
the PM's ten rulings are applied and listed under "Round 2 changes".

## The trading question

"Did price break an established compression range with range and volume
behind the break bar, and did it come back inside?" Trend bias is secondary
context: it colours, it never decides.

## Target user and decision

Intraday and swing breakout traders on BTC, ETH, ES, NQ, AAPL, TSLA. Decision:
act on a close outside the compression range, fade it once it fails, or treat
it as counter-trend context. Descriptive only: "confirmed" means both activity
tests passed on the break bar, never follow-through.

## Identity

- Folder `apps/web/src/lib/indicators/squeeze-breakout/`; def
  `squeezeBreakout.ts`; pure state machine in `squeezeBreakoutMath.ts`;
  tests in `tests/`.
- id `squeezeBreakout`, label `"Squeeze Breakout (20)"`, category
  `"technical"`, placement `{ kind: "overlay" }`, `maxReplayBars` 10,080
  (equal to retention, so the rollover test and the replay are one series).
- Historical Mode policy `OHLCV_POLICY`: reads `bar.high/low/close/volume`,
  `bar.ts_open`, `bar.interval_ms`, `bar.closed` only. Every archived
  instrument; equities fine (no `barSides`; protocol check 9 is N/A and the
  doc says so). No `timeframeGate`.

## Data and validity

A bar's **price is valid** when open, high, low, close are finite,
`high ≥ low` and `low ≤ close ≤ high`. **Volume is valid** when finite and
`≥ 0`. An invalid-price bar contributes nothing: no ring entry, no box change,
no age, no event; status `No usable price`. Invalid volume keeps the price
context (rings, box, break test) but the bar enters no volume observation and
cannot earn the volume test. Missing bars (gaps in `ts_open`) contribute
nothing; see the gap rule.

**No library streams drive events.** Codex showed that a never-closed bar left
in a `trading-signals` stream flips the squeeze flag on the next committed bar,
so box creation would depend on dispatch history. Every quantity is computed
from own committed-bar rings (a 200-close ring for bands and bias; 20-entry
true-range and volume rings holding only valid observations; primitives
`createRing`/`ringInsert`/`ringMean` from `relative-volume/relativeVolumeMath.ts`),
with the tail evaluated provisionally and never written. Corrections restore
the rule-8 snapshot, so `ringUpdate`/`ringRemove` are not needed.

Bands are finite windows so rollback and replay are exact: Bollinger middle =
mean of the `len` closes (`len − 1` committed plus the tail), `±bbMult`
population standard deviations; the Keltner-style channel takes the same mean
as middle and `±kcMult ×` mean true range over the same window. This departs
from the library's recursive EMA/Wilder Keltner, which has no finite ring form;
`ta.ttmSqueeze` keeps it as the independent baseline. Bias uses MA 50 and
MA 200 from the 200-ring plus a 6-entry ring of committed MA 50 values for the
slope. The slot-median volume baseline is not used in v1 (three prior sessions
per minute would null the grade on every 400-bar fixture); it is the v2
`volumeRule` option (`createRelativeVolumeEngine`, `reading.rvol`).

## Calculation

Settings: `len` 20, `bbMult` 2, `kcMult` 1.5, `minSqueezeBars` 6,
`releaseBars` 3, `confirmMultiple` 1.5, `failBars` 5, `holdBars` 40.
`committedIndex` is an owned counter of committed valid-price bars.

1. **Tail record and snapshot.** The first dispatch of a new `ts_open`
   creates the tail record and copies the whole committed state `S`: the four
   rings, `prevClose`, `lastCommittedTsOpen`, `committedIndex`, the active box
   (`hi, lo, age, offRun, broken, excursion`), the held boxes with remaining
   hold, the last event. Cost: about 250 numbers and a few small objects
   copied once per `ts_open`, never per revision.
2. **Gap.** If `ts_open − S.lastCommittedTsOpen > interval_ms`, the active
   box is dropped from `S` before anything else (held boxes stay); status
   `Gap · box reset` on this bar. Rings continue (the equity night is a gap).
3. **Provisional values from `S` plus the tail.** `trueRange` uses
   `S.prevClose` (first bar: `high − low`). Bands as above; `squeezeOn` =
   `bbUpper < kcUpper && bbLower > kcLower`; `depth = bbWidth / kcWidth`,
   `null` while the window is short or `kcWidth` is 0. Denominators
   `avgRange20`, `avgVolume20`: the mean of a ring only when it holds 20 valid
   observations and the mean is `> 0`; otherwise unavailable. `gradeBasis`:
   0 none, 1 range only, 2 volume only, 3 both available. Bias: `up` if
   `close > MA200` and `MA50 > MA50 five committed bars earlier`; `down` on the
   mirror; `neutral` otherwise; `unknown` until 200 committed closes.
4. **Decision (read only, against `S.active`).** Exactly one per bar:
   - if `S.active.broken`: close inside the frozen `[lo, hi]` → `failed`;
     else if `committedIndex − brokenIndex === failBars` → `completed`; else
     `pending`. The failure window is the `failBars` committed bars after the
     break bar, the last one included.
   - else if `S.active` exists and `age ≥ minSqueezeBars`: `close > hi` →
     break up, `close < lo` → break down. Tests: `trueRange ≥ confirmMultiple
     × avgRange20`, `volume ≥ confirmMultiple × avgVolume20`, each only when
     its denominator is available. `breakGrade`: 3 both passed, 1 range only
     passed, 2 volume only passed, 0 neither. A break has priority over a
     release on the same bar.
   - else `none`.
5. **Commit, only on the first dispatch with `closed === true`, in this
   order.** (a) valid close and true range enter their rings, valid volume
   its ring; (b) apply the decision: `break` → `broken = {committedIndex,
   dir, grade, basis}`, edges frozen at `S.active.hi/lo` (the tested edges;
   the break bar never extends them), `excursion` = this bar's high/low;
   `failed` or `completed` → the active box moves to the held list with that
   styling for `holdBars` committed bars and `active = null`; `pending` →
   excursion extended, `age += 1`; (c) if `none` and an unbroken active box
   exists: extend `hi/lo`, `age += 1`, `offRun = squeezeOn ? 0 : offRun + 1`,
   and `offRun > releaseBars` discards the box silently (not held); (d) if
   no active box remains, `squeezeOn` holds and the decision was `none`, open a
   box `{hi: high, lo: low, age: 1, offRun: 0}`; (e) `prevClose`,
   `lastCommittedTsOpen`, `committedIndex` advance. `age` counts committed
   bars inside the box, squeeze or paused or pending.
6. **No widening, no re-arm.** A failed break retires its box. A new coil
   starts at the next closed squeeze bar with `age` 1 and must reach
   `minSqueezeBars` again before it can break. (Cost: on design seed 10 an
   unconfirmed break inside the compression retires the box 8 bars before
   the labelled break, which is then missed; re-arm is deferred.)
7. **Superseded without close.** A tail replaced by a newer `ts_open` while
   `closed === false` writes nothing; its provisional marker is removed on the
   next dispatch.
8. **Corrections are tail-only, by restore.** A closed re-dispatch of the
   tail restores `S` whole, then re-runs rules 2 to 5 with the corrected bar.
   This covers a cancelled break (close corrected inside: no event, box
   extends), a removed failure (close corrected outside: `pending` again), a
   grade change, invalid-to-valid and valid-to-invalid in either field. An
   older correction arrives as `REBUILT` and recreates state.
9. **Outputs** (`readOutput`): `boxHigh`, `boxLow` (the active box: armed,
   paused or pending; `null` otherwise, held boxes never), `depth`,
   `squeezeOn` 0/1, `bias` −1/0/1 or `null`, `breakDir`, `breakGrade`,
   `gradeBasis`, `failed` 0/1, `boxAge`. `boxHigh`/`boxLow` are the two line
   outputs; the rest are numeric seams for the harness and later layers.
10. **Status precedence (table row 2), first match wins.** `No usable price`;
    `Gap · box reset`; `Failed break`; `Break ↑ · range+vol` / `range only` /
    `vol only` / `unconfirmed` / `no baseline` (basis 0), ↓ for down, while
    pending or on its bar; `Squeeze · 9 bars`; `Paused · 1 of 3`;
    `No squeeze`. Row 1: `Box 61,240–61,480 · up` (active edges in the
    instrument's precision, bias word `up`/`down`/`flat`/`—`), or `Warming up
    · 12 of 20 bars`, or `No box · up`. Row 3: `Last · ↑ 12:34 · range+vol`
    or `—`. Every string is at most 30 characters; the table is visible from
    the first bar. Forming tail: same strings at provisional styling.
11. **No future data; fail closed.** Every value at bar t uses bars with
    `ts_open ≤ t.ts_open`; any non-finite intermediate yields `null`.

## Default view

Overlay. The active box as a translucent `draw.box` from its first bar to the
current bar: fill 0.12 alpha, border 1 px, colour by bias (house bull / bear
pair; purple `#8672b3` for neutral or unknown). A retired box is held
`holdBars` bars at 0.06 alpha: `completed` keeps its bias colour, `failed`
takes a `--warn` border. Pool of 8 handles created in `createState` (one
active, seven held); when a ninth is needed the oldest held box is dropped.
Drawing is skipped when `drawNow === false`. `boxHigh`/`boxLow` lines (width 1,
bias colour) carry the edges for the harness. Table as in rule 10, top right,
three rows. Nothing is drawn before warm-up except the table; never a zero.

## Controls

Primary (three): `squeezeLength` "Squeeze length (bars)" 20, 10..50, step 1
(band window only; denominators stay 20, so warm-up is `max(squeezeLength,
20) + 1` and the hint says so); `minSqueezeBars` "Minimum squeeze (bars)" 6,
2..30; `confirmMultiple` "Confirm above (×)" 1.5, 1.0..3.0, step 0.1. All
recompute. Advanced (`tab: "advanced"`): `bbMult` 2.0, `kcMult` 1.5 (1..3,
0.1), `releaseBars` 3 (1..10), `failBars` 5 (1..20), `holdBars` 40 (0..200),
`trendFast` 50, `trendSlow` 200 (10..200, slow ≥ fast at read). Visibility:
`showMarkers`, `showBoxes` (true, recompute). No colour pickers in v1. Every
key in the schema; one hint per control; a `staticHint` for the warm-up.

## Alert conditions (markers plus table)

Two event types. **Break**: `arrowUp` below or `arrowDown` above the bar,
bull/bear colour, drawn when `breakGrade ≥ 1` (solid at 3, 50 percent alpha
at 1 or 2); grade 0 is table and box only. **Failed break**: `circle`,
`inBar`, `--warn`, only for a marked break. One decision per bar, so at most
one marker per bar; markers are a pure function of the bar's current decision
(provisional on the tail, revised by a correction, unchanged by a duplicate).

## Fixtures

Design seeds 7..16, both directions. **Evaluation seeds 17..21 are untouched:**
no parameter or rule may be chosen on them; their results are reported in a
separate table whatever they are.

- `compressionBreakoutBars({ seed, direction })`, harness defaults (break at
  index 220 closing `compressionHigh + 150` on 3× volume).
- **New, to add to `validation/fixtures.ts` before the build.**
  `compressionFailedBreakBars`: identical to `compressionBreakoutBars` through
  `breakoutIndex` (same generator stream); bar `breakoutIndex + 1`: `open` =
  previous close, `close = startPrice`, `high = max(open, close) + 5`, `low =
  min(open, close) − 5`, `volume = 1.5 × baseVolume`, `buyShare` 0.5; every
  later bar follows the compression generator at progress 1 (half width
  `finalHalfWidth`, draws in the order target, wick, volume, buyShare, with
  `volume = baseVolume × (0.5 + 0.2 × random())`). Labels add `failIndex =
  breakoutIndex + 1`. `compressionContinuationBars`: identical through
  `breakoutIndex`; later bars: `open` = previous close, `raw = open + (random()
  − 0.5) × 16`, `close = direction > 0 ? max(edge + 0.2 × initialHalfWidth, raw)
  : min(edge − 0.2 × initialHalfWidth, raw)` with `edge` the labelled
  compression extreme, wick `random() × 8`, `volume = baseVolume × (1 + 0.6 ×
  random())`, `buyShare = 0.5 + 0.12 × direction + (random() − 0.5) × 0.08`.
  Labels add `completionIndex = breakoutIndex + 5`.
- Correction cancellation (arrival script on seed 7): bar 220 closed as the
  break; the same `ts_open` re-dispatched closed with `close =
  compressionHigh − 1`: the event disappears, the box extends, and every later
  bar equals a clean feed of the corrected series. Also bar 220 with `volume
  = NaN` then corrected (grade from 1 to 3), and bar 221 closed inside then
  corrected outside (failure removed, `pending`).
- Controls: `trendBars({ seed, count: 1000 })`, `rangeBars({ seed, count:
  1000 })`, seeds 7..11. Protocol edge cases on seed 7. Performance:
  `relativeVolumeCryptoFixture()` bars 1..10,080, `probeReplayPooled`.

Scoring, identical for tool and baselines: an event is **matched** when its
index lies in `[breakoutIndex, breakoutIndex + 2]`; a **hit** is a matched
event whose direction equals the label (first matched event counts); **early**
events precede `breakoutIndex` (split lead / compression); **unmatched**
events follow the window. Reported as all events, then with the identical
range-or-volume filter (`trueRange ≥ 1.5 × avgRange20` or `volume ≥ 1.5 ×
avgVolume20`, denominators as rule 3) applied to all three.

## Baselines

**TTM release** (`ta.ttmSqueeze(20, 2, 20, 1.5)`): the bar `isSqueezed` turns
false after at least 6 true bars; direction = sign of `momentum`. **Bollinger
crossing** (`ta.bollinger(20, 2)`): the first close outside a band after an
inside close; direction by the band crossed. Codex's simplest alternative
(frozen-edge range, outside close, return inside) is this v1 minus bias colour
and held boxes, neither of which changes an event, so the tool's own event
stream is that benchmark.

## Acceptance

Scratch replication of the round-2 rules (`sim3.mjs`, specialist scratchpad;
the builder's tests pin the real numbers) on design seeds, per direction:

| Events | Tool hits / early (lead, comp) / unmatched | TTM release | Bollinger crossing |
|---|---|---|---|
| All | 9 of 10 / 30 (21, 9) / 0 | 9 / 16 (6, 10) / 0 | 10 / 59 (41, 18) / 2 |
| Filtered | 9 of 10 / 5 (3, 2) / 0 | 9 / 0 / 0 | 10 / 19 (5, 14) / 2 |

All nine tool hits are grade 3. Range control: 10.8 marked markers per 1,000
bars (48.6 counting unconfirmed); trend control 0. Failed-break fixture: break
at 220 and failure at 221 on 9 of 10 seeds; continuation: break at 220,
completion at 225, no failure, 9 of 10. The miss is seed 10 every time (rule
6). Variant tried, not selected: `minSqueezeBars` 8 (fewer early events, same
hits; the ES/NQ preset).

Read honestly: on timing alone the filtered TTM release equals the tool's hits
with fewer early events. The tool's claim is what the baselines cannot
produce: the level, the failure, the completion, the test basis. Bounds:

- Hits ≥ 8 of 10 per direction on design seeds; evaluation seeds reported.
- On every hit: `boxHigh ≤ compressionHigh`, `boxLow ≥ compressionLow` and
  the break close beyond the tested edge (the level is real); baselines have
  no level by construction.
- Failed-break fixture: break then `failed` at `failIndex` on ≥ 8 of 10;
  continuation: break then `completed` at `completionIndex` with no failure
  on ≥ 8 of 10; both baselines emit no failure or completion event.
- Filtered early events ≤ 8 per direction, reported beside both baselines
  with counts; all-events numbers reported.
- Range control ≤ 20 marked markers per 1,000; trend ≤ 5; `maxPerBar` 1.
- Live observation (REST transport, `data-api.binance.vision`): record the
  10,080-bar BTC-USDT and ETH-USDT snapshots plus 30 minutes of forming
  revisions and closes, drive through the real runtime with `driveLive`,
  compare with `replayCapture`: equal outputs and confirmed markers, no fault,
  ≤ 40 markers per 1,000 on 1m and resampled 5m; event list and box count in
  the doc. A density, honesty and replay check, not accuracy.

If the PM judges that the level and failure evidence does not meet protocol
check 7, the concept returns to the backlog with these tables.

## Replay horizon

Every quantity is a finite window of at most 200 committed bars, so a replay
from the first retained bar reproduces live values exactly once the window
lies in the retained series: bands, denominators and events from retained
index `max(squeezeLength, 20)`, bias from 200 (`unknown` before, where a
long-running live chart may know it; bias never gates an event). An active box
opened before the retained window exists live but not in replay, so the
REBUILT equivalence test compares box and event outputs from the first bar at
or after index 200 with no live active box, asserting a non-zero compared count.

## Success criteria

1. Hand-computed values on a 30-bar fixture: bands, box open and extension,
   read-before-write test, grade and basis with pinned denominators, freeze,
   failure, completion, retirement, pool eviction.
2. Protocol checks 1 to 7 and 10 PASS, 9 N/A: truncation invariance on
   breakout and trend fixtures; live-versus-replay equal at zero tolerance;
   duplicate, REBUILT, time gap (`firstBarAfterGapIndex` shows `Gap · box
   reset`, nothing earlier changes), forming tail, the three correction
   scripts; warm-up `null` through bar 19 with the table visible from bar 0.
3. Pooled p99 `onBar + readOutput` under 0.05 ms over bars 1..10,080 with the
   snapshot inside the timed region; rollover with 10,080 outputs, no markers
   before retention, heap slope within 3× the harness floor, 8 handles.
4. UX: three primary controls; strings as rule 10; screenshots at two zooms:
   coil forming, confirmed break, failed break, warm-up, dialog with Advanced
   closed and open, cream and dark chart.
5. Doc page and README row; `validate-docs`, web suite, `tsc`, lint green;
   Codex code review APPROVED; validator ACCEPT.

## Limitations to state

Descriptive, not predictive. Warm-up `max(squeezeLength, 20) + 1` bars; bias
200. Finite-window bands differ from EMA-based TTM dots. Continuation squeezes
in a trend produce repeated boxes. A tall first bar makes a tall box. A failed
break retires its coil, so a second break needs a fresh six-bar squeeze.
Equity overnight gaps reset the box. Unit-free.

## Deferred

Re-arm and widening after a failed break (v1 simplicity; the seed-10 miss is
its cost); time-of-day volume rule (fixture length); swing pivots; break-bar
delta grade (`CANDLE_FLOW_POLICY`); session-open rule (the gap rule covers
equities).

## Seams for L1 and L2 (named, not built)

`boxHigh`, `boxLow`, `breakDir`, `breakGrade`, `gradeBasis`, `failed`,
`boxAge`: the L1 tape tally grades intensity on the `breakDir` bar; the L2
Break Defense Monitor watches liquidity at the edges while `boxAge ≥
minSqueezeBars`. Shared through `squeezeBreakoutMath.ts`; a combined score is
its own brief.

## Budget

One build run, UX before the end, at most two fix rounds after Codex code
review and validation; a third failure returns the concept to the backlog.

## Ten-line summary

1. Overlay box over a Bollinger-inside-Keltner squeeze from own committed rings; the tail is provisional, never written.
2. Box coloured by MA 50/200 bias; bias never gates an event.
3. Break = close outside the box as of the bar's open, after 6 bars in the box; break beats release.
4. Grade = true range and volume versus 20 valid committed observations with positive means; basis exposed.
5. Edges freeze at the tested values; failure = close back inside within 5 bars; failure or completion retires the box.
6. No re-arm: a new coil must requalify; squeeze may pause 3 bars; a gap resets the box.
7. Corrections restore a per-bar snapshot of all committed state and re-apply; older ones arrive as REBUILT.
8. Markers only for breaks with a passed test and their failures; one per bar.
9. Baselines compared all-events and under the identical filter; the tool's claim is the level, failure and completion they cannot produce.
10. Design seeds 7..16, untouched evaluation seeds 17..21, two new fixtures, a correction script, a BTC/ETH live run.

## Effort estimate

M+: own-state bands and the snapshot restore add about a day to the round-1
estimate; UX half a day; one validation loop expected.

## Plan-gate history

Round 1 REVISE (Codex, 2026-10-26): library streams change box creation;
freeze the tested edges; transition priority; complete rollback; denominator
validity; numeric edges and test basis in the table; fair all-events baseline
comparison; failure, continuation and correction fixtures; untouched
evaluation seeds; `maxReplayBars` versus retention. All ten PM rulings accepted.

## Round 2 changes

1. Own-state finite-window bands and bias from committed rings; `ta.ttmSqueeze`
   baseline only. Flagged deviation: window mean and mean true range stand in
   for EMA/Wilder Keltner, and MA 50/200 for the EMAs, because recursive forms
   have no finite ring and would break exact rollback and replay (ruling 1).
2. Edges frozen at `boxAtOpen`, excursion separate, rule 5 ordered
   read-then-commit, break beats release (ruling 2).
3. No widening or re-arm; failure retires; `age` defined; seed-10 miss
   documented as the cost (ruling 3).
4. Whole-state snapshot per new bar, restore-and-reapply, three correction
   cases, cost stated (ruling 4).
5. Denominators need 20 valid observations and positive means; `gradeBasis`
   seam; validity rules; `no baseline` wording (ruling 5).
6. Table edges, test-basis strings, visible in warm-up, ≤ 30 characters;
   active box owns `boxHigh`/`boxLow`; pool eviction (ruling 6).
7. All events versus all events, identical filter, direction-correct hits,
   Bollinger as a crossing; numbers re-run and stated honestly (ruling 7).
8. Two frozen generators with exact formulas, a correction script, design
   seeds 7..16, evaluation seeds 17..21 untouched (ruling 8).
9. `maxReplayBars` 10,080 and the replay horizon (ruling 9).
10. Deferred list consolidated (ruling 10).

## PM rulings on round 2 (before Codex round 2)

1. **Keltner from window means, not EMA/ATR: accepted.** Exact rollback and
   replay outrank the canonical recursion. The label and doc call the band
   "Keltner-style (window mean, mean true range)" so nobody expects the
   textbook values.
2. **Seed 10 lost to the no-re-arm rule: accepted.** Nine of ten meets the
   bound; re-arm stays deferred with this seed as its motivating case.
3. **Protocol check 7 judgement.** On timing alone the filtered TTM release
   matches the tool. The concept proceeds because the trading question asks
   three things the baselines cannot answer at all: the tested level, the
   failure event and the completion. These three must be demonstrated on the
   new fixtures (9/10 failure and completion as simulated) or the concept
   returns to the backlog at validation. Marketing copy may not claim better
   break timing than a squeeze dot.
