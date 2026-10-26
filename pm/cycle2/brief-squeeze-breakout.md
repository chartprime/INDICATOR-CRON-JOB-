# Build brief: Squeeze Breakout Context (draft for Codex plan round 1)

Drafted by the OHLCV specialist for the PM. Shared rules: `PM/WORKER-BRIEF.md`,
`PM/CAPABILITIES.md`, `PM/cycle1/ux-standard.md` (binding), 
`PM/cycle1/validation-protocol.md`. Structure and rigour follow
`PM/cycle1/brief-rvol-clock.md` as approved after five plan rounds.

## The trading question

"Is price coiled right now, which way does the surrounding trend lean, and
when the coil breaks, did the break bar carry range and volume, or did price
fall back inside?"

## Target user and decision

Intraday and swing breakout traders on BTC, ETH, ES, NQ, AAPL, TSLA. Decision:
treat a close outside the compression range as a break worth acting on, as a
trap once it fails, or as counter-trend context. Descriptive only: it names the
range, the side the trend favours and what the break bar did; it does not
predict follow-through, and the package says so.

## Identity

- Folder `apps/web/src/lib/indicators/squeeze-breakout/`; def
  `squeezeBreakout.ts`; pure state machine in `squeezeBreakoutMath.ts`;
  tests in `tests/`.
- id `squeezeBreakout`, label `"Squeeze Breakout (20)"`, category
  `"technical"`, placement `{ kind: "overlay" }`, `maxReplayBars` 3,000.
- Historical Mode policy `OHLCV_POLICY`: reads `bar.high/low/close/volume`,
  `bar.ts_open`, `bar.interval_ms`, `bar.closed` only. Works on every archived
  instrument and on equities (volume is unsided-agnostic; no `barSides`).
- No `timeframeGate`; every timeframe is supported.

## Data and library use

`ta.bollinger(len, bbMult)` on close and `ta.keltner(len, len, kcMult)` on
`{high, low, close}` give the squeeze state; `ta.ema(50)` and `ta.ema(200)` on
close give the bias. These four library streams are pushed with `replace`.
Documented limitation: a bar superseded without ever closing stays in them at
its last values (the library cannot retract an input), so the squeeze flag and
bias are "as the chart showed them", while every value that enters an event
(box edges, denominators) is own state and excludes such bars.

The volume and range denominators use the ring primitives exported by
`relative-volume/relativeVolumeMath.ts` (`createRing`, `ringInsert`,
`ringUpdate`, `ringRemove`, `ringSupersede`, `ringMean`), capacity 20, keyed
by `ts_open`, with the same tail-only correction and eviction rollback
semantics that module already proves. **The slot-median (time-of-day) baseline
is not used in this version**: it needs three prior sessions per minute, so the
grade would be `null` for three days on a fresh symbol and on every 400-bar
labelled fixture, untestable on labelled data and different in meaning from bar
to bar. A `volumeRule` (`rolling20` | `timeOfDay`) is a v2 Advanced option once
a multi-session breakout fixture exists (import `createRelativeVolumeEngine`,
read `reading.rvol`).

## Calculation (incremental, one dispatch at a time)

Terms: `len` 20, `bbMult` 2, `kcMult` 1.5, `minSqueezeBars` 6, `releaseBars`
3, `confirmMultiple` 1.5, `failBars` 5, `holdBars` 40.

1. **Tail record, keyed by `ts_open`.** The first dispatch of a new `ts_open`
   creates the record and snapshots, before any write, `boxAtOpen` (the
   committed box: `hi`, `lo`, `age`, `offRun`, `broken`), `avgRange20` (mean of
   the range ring) and `avgVolume20` (mean of the volume ring). Every later
   dispatch of the same `ts_open` (forming revision or closed correction)
   recomputes the tail's decision from these snapshots and the tail's current
   values; the tail never sees itself in a denominator or in the box it is
   tested against.
2. **Time gap.** If `ts_open − previousCommitted.ts_open > interval_ms`, the
   committed box is discarded before the snapshot (the coil's context is
   stale across a hole or an equity overnight) and the status row shows
   `Gap · box reset` on that bar. Streams and rings continue.
3. **Squeeze flag.** Push the bar into bollinger and keltner. `squeezeOn` =
   `bbUpper < kcUpper && bbLower > kcLower`; `depth = (bbUpper − bbLower) /
   (kcUpper − kcLower)`, `null` when either stream is `null` or the KC width is
   0. (The baseline uses `ta.ttmSqueeze` for the same definition, so the two
   are independent implementations.)
4. **Box test (read).** If `boxAtOpen` exists, is not broken and `age ≥
   minSqueezeBars`: `breakDir` = +1 if `close > hi`, −1 if `close < lo`, else
   0. On a break: `expansion = trueRange ≥ confirmMultiple × avgRange20`,
   `volume = bar.volume ≥ confirmMultiple × avgVolume20`; grade `confirmed`
   (both), `partial` (one), `unconfirmed` (none); a `null` denominator makes
   the flag false and the grade carries `denominatorMissing`. True range uses
   the previous committed close.
5. **Failure test (read).** If `boxAtOpen.broken` is set: `close` back inside
   `[lo, hi]` of the frozen box marks `failed`; otherwise, when `index −
   brokenIndex ≥ failBars`, the break is complete and the box is retired.
6. **Commit (write), only on the first dispatch with `closed === true`.**
   In order: (a) range and volume enter their rings (`ringInsert`); (b) if no
   box exists and `squeezeOn`, open one with this bar's `high/low`, `age` 1;
   (c) else if a box exists and is not broken, extend `hi/lo` with this bar,
   then `age += 1, offRun = 0` if `squeezeOn`, else `offRun += 1`, and
   `offRun > releaseBars` discards the box (no event); (d) on a break the box
   freezes (`hi/lo` stop extending) and `broken = {index, dir, grade}`;
   excursion extremes are tracked separately; (e) on a failure the box widens
   to the excursion extremes and re-arms with its age kept; (f) on a completed
   break the box is retired and, if `squeezeOn` still holds, a new box opens
   on the next closed bar with `age` 1 (the coil continues). A squeeze shorter
   than `minSqueezeBars` that releases yields no event and no box is kept.
7. **Superseded without close.** A tail superseded by a newer `ts_open` while
   `closed === false` writes nothing: no ring entry, no box change, no event;
   its provisional marker is removed on the next dispatch. Missing data
   contributes nothing.
8. **Corrections are tail-only.** A closed re-dispatch of the tail with
   different values recomputes the decision from the snapshots, `ringUpdate`s
   both rings, and rebuilds the committed box as `boxAtOpen` plus this bar; a
   valid-to-invalid correction (`volume` not finite or ≥ 0, prices not finite)
   `ringRemove`s and restores `evictedByTail`. An older correction reaches the
   indicator as `REBUILT` and recreates state. `ringSupersede` runs when the
   tail is superseded.
9. **Bias.** `up` if `close > ema200` and `ema50 > ema50 five committed bars
   earlier` (own 6-entry ring of committed ema50 values); `down` on the mirror;
   else `neutral`; `unknown` while either EMA is `null`. Re-evaluated every
   dispatch; it colours the box and the table, and never gates an event.
10. **Outputs** (`readOutput`): `boxHigh`, `boxLow` (`null` with no armed,
    broken or held box), `depth`, `squeezeOn` 0/1, `bias` −1/0/1 (`null`
    unknown), `breakDir` −1/0/1, `breakGrade` 0 none, 1 unconfirmed, 2 partial,
    3 confirmed, `failed` 0/1, `boxAge`. `boxHigh`/`boxLow` are the two line
    outputs; the rest are numeric seams.
11. **Status precedence, first match wins.** `Warming up · n of 21 bars`
    (rings and bands need 20 committed bars plus one); `Gap · box reset`;
    `Failed break · re-armed`; `Break ↑ · confirmed` / `partial` /
    `unconfirmed` (↓ for down) while a break is pending or on its bar;
    `Squeeze · 9 bars · 0.72`; `Squeeze paused · 1 of 3`; `No squeeze`.
    Second row: `Bias up · EMA 50/200`, `Bias down`, `Bias neutral`, `Bias ·
    warming 120 of 200`. Third row: `Last · break ↑ 12:34 · confirmed` or `—`.
    Forming tail: same strings, provisional styling (50 percent alpha).
12. **No future data; fail closed.** Every value at bar t uses bars with
    `ts_open ≤ t.ts_open`; any non-finite intermediate yields `null`.

## Default view

Overlay. One translucent box per coil from its first bar to the current bar
(`draw.box` pool of 8 handles from `createState`, mutated per bar, skipped
when `drawNow === false`): fill 0.12 alpha, border 1 px, colour by bias (house
bull / bear pair; purple `#8672b3` for neutral or unknown). A broken box stops
at the break bar and is held `holdBars` bars at 0.06 alpha; a failed box's
border turns `--warn`. The `boxHigh`/`boxLow` lines (width 1, bias colour)
give the harness its outputs and the trader the exact edges. Table, top right,
three rows as in rule 11. Nothing drawn before warm-up; never a zero.

## Controls

Primary (Inputs tab, three): `squeezeLength` "Squeeze length (bars)" 20,
10..50, step 1, recompute; `minSqueezeBars` "Minimum squeeze (bars)" 6,
2..30, step 1, recompute; `confirmMultiple` "Confirm above (×)" 1.5,
1.0..3.0, step 0.1, recompute (applied to range and volume alike).

Advanced (`tab: "advanced"`, merged on main): `bbMult` 2.0 (1..3, 0.1),
`kcMult` 1.5 (1..3, 0.1), `releaseBars` 3 (1..10), `failBars` 5 (1..20),
`holdBars` 40 (0..200), `trendFast` 50, `trendSlow` 200 (10..400). All
recompute. Visibility: `showMarkers` (true), `showBoxes` (true), both
recompute (markers and fills need a replay, as the RVOL G3 ruling found).
No colour pickers in v1. Every key in the schema; one hint per control at
most; a `staticHint` stating the 21-bar warm-up.

Deferred: time-of-day volume rule (above); swing-pivot lines (a second
structure vocabulary); break-bar delta grade (needs `CANDLE_FLOW_POLICY`);
first-bar-of-session rule (the gap rule covers equities, whose candles skip
the night).

## Alert conditions (markers plus table)

Two event types, the UX maximum: **Break** — `arrowUp` below the bar (up) or
`arrowDown` above it (down), drawn only for `confirmed` (solid) and `partial`
(50 percent alpha) grades, bull/bear colour; unconfirmed breaks are table and
box only. **Failed break** — `circle`, `inBar`, `--warn`, only for a break
that was marked. Markers are a pure function of the bar's current decision:
a forming bar's marker is provisional and revised on each replace; a closed
correction that changes the grade adds or removes it; a duplicate closed
dispatch changes nothing.

## Fixtures (frozen; the harness's own generators)

- **Breakout**: `compressionBreakoutBars({ seed })` for seeds 7..16 (defaults:
  400 bars, `leadBars` 100, `compressionBars` 120, half width 300 → 30, break
  at index 220 closing `compressionHigh + 150` on 3× volume). Labels
  `compressionStart`, `breakoutIndex`, `direction`. Also the same ten seeds
  with `direction: -1`.
- **Trending control**: `trendBars({ seed, count: 1000 })`, seeds 7..11.
- **Ranging control**: `rangeBars({ seed, count: 1000 })`, seeds 7..11.
- Protocol edge cases (gap, duplicate, late, forming tail, correction, empty
  input) on the seed-7 breakout fixture.
- Performance: `relativeVolumeCryptoFixture()` bars 1..10,080,
  `probeReplayPooled`, amendment-9 method.

Scoring: a hit is the first `breakGrade > 0` bar in `[breakoutIndex,
breakoutIndex + 2]`; any break event before `breakoutIndex` is a false
positive, split into lead (`< compressionStart`) and compression; no detection
in the window is a miss. "Marked" means confirmed or partial.

## Baselines

1. **TTM dot flip** (`ta.ttmSqueeze(20, 2, 20, 1.5)`): fires on the first bar
   `isSqueezed` turns false after at least 6 consecutive true bars.
2. **Bollinger break**: fires on any bar closing outside `ta.bollinger(20, 2)`.

Both implemented as `RuntimeIndicatorDef`s in `tests/`, scored by the same
rule. What the tool must show that they hide: the level (the box edges),
the grade of the break bar, and the failure.

## Acceptance (all required)

A scratch replication of the fixtures and rules 3 to 6 (the builder's test
pins the real numbers) gave, over seeds 7..16: tool 10/10 hits at index 220
exactly, all confirmed; 9 compression false positives, 5 marked; TTM dot 9/10
hits, 10 compression false positives; Bollinger 10/10, 24 compression and 63
lead. Range control 6.8 markers per 1,000 bars (34 if unconfirmed breaks were
marked; 0 confirmed breaks); trend control 0. Bounds with margin:

- Hits ≥ 9 of 10 per direction within +2 bars; ≥ 8 of those graded
  `confirmed`; zero late detections beyond +2 (a miss, not a late).
- Marked compression false positives ≤ 8 over the 10 up seeds and strictly
  fewer than the TTM dot's compression false positives; all break events
  (marked or not) reported beside the dot's, whatever they are.
- Ranging control ≤ 20 markers per 1,000 bars (ceiling 40 for a signal tool);
  trending control ≤ 5 per 1,000; `maxPerBar` ≤ 2; counts reported, not only
  rates.
- Live observation on real Binance spot candles through the REST transport
  (`TT_BINANCE_TRANSPORT=rest`, mirror `data-api.binance.vision`): record
  the 10,080-bar BTC-USDT and ETH-USDT snapshots plus 30 minutes of forming
  revisions and closes with the acceptance recorder, drive them through the
  real runtime with `driveLive` and compare with `replayCapture`. Required:
  equal outputs and confirmed markers; no fault; markers ≤ 40 per 1,000 on 1m
  and on the browser-resampled 5m; the event list (time, direction, grade,
  failed) and the box count quoted in the doc page. No label exists, so this
  is a density, honesty and replay check, not accuracy.
- Variants tried, reported not selected: `minSqueezeBars` 8 (4 compression
  false positives, 1 marked, range 5.4 per 1,000; kept as the ES/NQ preset);
  `releaseBars` 2 (no change). The defaults are the concept's, chosen before
  the fixture was run.

## Success criteria

1. Hand-computed values on a 30-bar fixture: box open, extension, read-before-
   write test, grade with pinned denominators, failure and re-arm.
2. Protocol checks 1 to 7, 9 (N/A, stated) and 10 all PASS: truncation
   invariance on breakout and trend fixtures; live-versus-replay equal
   (candle-only, zero tolerance); duplicate, REBUILT, time-gap
   (`firstBarAfterGapIndex` shows `Gap · box reset`, nothing earlier
   changes), forming tail, tail corrections including eviction rollback;
   warm-up `null` through bar 20, first value at 21.
3. Pooled p99 `onBar + readOutput` under 0.05 ms over bars 1..10,080;
   rollover with 10,080 outputs retained, no markers before retention, heap
   slope within 3× the harness floor; the box pool stays at 8 handles.
4. UX: three primary controls, strings exactly as rule 11, screenshots:
   coil forming, confirmed break, failed break, warm-up, dialog Inputs with
   Advanced open and closed, cream and (when layer 1 allows) dark chart.
5. Doc page `docs/architecture/indicators/squeeze-breakout.md` plus README
   row; `validate-docs` passes; web suite, `tsc`, lint green; Codex code review
   APPROVED; validator ACCEPT.

## Limitations to state

Descriptive, not predictive. Warm-up 21 bars; bias needs 200. The squeeze
flag can include a never-closed bar's last values. Continuation squeezes in a
strong trend produce repeated with-bias boxes. A tall first bar makes a tall
box. Equity overnight gaps reset the box, so an opening-drive break is not
graded. Unit-free; no sided volume.

## Seams for L1 and L2 (named, not built)

`readOutput` keys `boxHigh`, `boxLow`, `breakDir`, `breakGrade`, `failed`
and `boxAge` are the contract: an L1 tape tally grades trade intensity on the
`breakDir` bar; the L2 Break Defense Monitor watches displayed liquidity at
`boxHigh`/`boxLow` while `boxAge ≥ minSqueezeBars`. Shared through
`squeezeBreakoutMath.ts` as a module, not a runtime link; any combined score
is its own brief with its own validation.

## Budget

One build run, UX joins before the end, at most two fix rounds after Codex
code review and validation; a third failure returns the concept to the backlog.

## Ten-line summary

1. Overlay box over a Bollinger-inside-Keltner squeeze, from committed bars only.
2. Box coloured by EMA 50/200 bias; bias never gates an event.
3. Break = close outside the box as it stood before the bar (read before write), after 6 squeeze bars.
4. Grade = range and volume versus 20-bar committed means snapshotted at the bar's open.
5. Failed break = close back inside the frozen box within 5 bars; box widens and re-arms.
6. Squeeze may pause 3 bars without losing the box; a gap resets it.
7. Corrections tail-only with ring rollback; older ones arrive as REBUILT.
8. Markers only for confirmed and partial breaks and their failures; two shapes.
9. Volume confirmation is rolling-20 via the RVOL ring primitives; time-of-day deferred to v2.
10. Acceptance: ≥ 9/10 hits at +2 on the harness fixture, fewer marked false positives than the TTM dot, ≤ 20 markers per 1,000 on the range control, plus a BTC/ETH live run.

## Effort estimate

M: state machine and tests about two days of agent work, UX half a day,
validation one loop expected. Risk sits in the correction semantics and the
box-pool drawing, not in the math.

## PM review before Codex round 1

Accepted as drafted, with two rulings recorded so the plan reviewer does not
reopen them without new evidence:

1. **Library streams keep a never-closed bar's last values.** Accepted for v1
   and stated in Limitations. Own-state bands are required only if the
   reviewer shows a fixture where this changes an event (box open, break,
   failure), not the squeeze flag's display. Every event-bearing value is
   already own state.
2. **Warm-up 21 bars for events, 200 for bias.** Accepted. Boxes appear early
   with the purple `unknown` bias; the second table row says why.

Scope check against the charter: one question, descriptive, three primary
controls, Advanced for the rest, fixtures and baselines frozen before the
build, effort M. Proceed to Codex plan round 1.
