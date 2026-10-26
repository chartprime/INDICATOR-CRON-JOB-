# Build brief: Relative Volume by Time of Day (final, after four Codex plan rounds)

PM brief for the cycle-1 build. Shared rules: PM/WORKER-BRIEF.md. Capability
sheet: PM/CAPABILITIES.md. UX standard: PM/cycle1/ux-standard.md. Validation
protocol: PM/cycle1/validation-protocol.md. Those live outside the repository
checkout at /home/user/Terminal-L1-L2/PM/; their requirements that matter here
are restated in this brief.

## The trading question

"Is this bar's volume unusual compared with the same minute of the day on
recent sessions, or is it just the open, the close or the London/New York
overlap being its normal self?"

## Target user and decision

Intraday traders on ES, NQ, AAPL, TSLA, BTC and ETH who confirm moves with
volume. Decision: treat participation as unusual relative to recent comparable
bars, or discount it because this minute is always loud. A rolling-average
RVOL cannot tell those apart; this tool normalises recurring intraday volume
patterns before comparing. High relative volume says nothing about direction
or follow-through, and the package says so. The baseline is short and noisy,
so the claim is "unusual relative to the last N sessions at this minute", not
"unusual" in any absolute sense.

## Identity

- Folder `apps/web/src/lib/indicators/relative-volume/`; def
  `relativeVolume.ts`; pure computation in `relativeVolumeMath.ts`; tests in
  `tests/`.
- id `relativeVolume`, label `"Relative Volume (Time of Day)"`, category
  `"technical"`, placement `{ kind: "ownPane", priceLines: [1, 2, 3] }`.
- Historical Mode policy `OHLCV_POLICY`. Works on every archived instrument
  and on equities (only `bar.volume` is read; sided volume is irrelevant).
- No `timeframeGate` (it would remove the indicator and its table). For
  `interval_ms > 3_600_000` every output is `null` and the status row says
  `Time of day needs an intraday timeframe`.

## Data

`bar.ts_open`, `bar.interval_ms`, `bar.volume`, `bar.closed`, `bar.provider`
(and `assetClass`/`marketKind` only to resolve the clock). Nothing else. No
wall clock. Identity fields choose the clock convention only; availability is
governed by the OHLCV capability policy, never by provider. A bar whose
`volume` is not a finite number >= 0 contributes no observation and yields
`null`. Missing bars (gaps in `ts_open`) contribute nothing, never a zero.

Known limitation accepted by the PM: the resampler reports the nominal
`interval_ms` even for a shortened bucket (`resampleBars.ts`), so the
indicator cannot know a bar's real duration. It therefore does no duration
normalisation. The start-minute key already compares the 15:30 equity
half-hour bar only with other 15:30 bars. The one unhandled case is an
early-close session, whose last bar is shorter than its slot's usual bars; it
enters as one observation among `sessions` and the median absorbs it. State
this in the doc page.

The `ta.*` factories are top-level imports created in `createState`
(`ctx.ta` is intentionally empty); this indicator does not use them, because
its rolling window must replace an arbitrary earlier input on a correction,
which a library stream cannot do.

## Calculation (incremental, one bar at a time)

1. **Clock, one rule.** Setting `clock`: `auto` resolves to `newYork` for
   provider DXFEED or DATABENTO and to `utc` for BINANCE; `newYork` and `utc`
   force it. New York minute of day is computed the way `killzones` does it
   (reuse its `nyParts` helper or `apps/web/src/lib/chart/marketCalendar.ts`;
   no new time-zone code). There is exactly one slot family in this version.
2. **Slot key.** The bar's start minute of day in the resolved clock
   (0..1439). No division by bar length: an hourly equity bar starting 09:30
   keys 570 and the 15:30 half-hour bar keys 930; neither collides. At most
   1,440 keys.
3. **Observation.** The bar's `volume`.
4. **Baseline.** Per slot key, a ring of the last `sessions` committed
   observations `{ts_open, volume}` (default 10, range 2..60) and their
   median (even count: mean of the two middle values). Median, not mean, so one
   news day does not inflate tomorrow's baseline. The ring capacity is the only
   bound. Live state may therefore hold observations from bars the chart has
   already discarded; that is accepted and documented, and live-versus-replay
   equivalence is required only for bars whose full `sessions` lookback lies
   within the retained series.
5. **Rolling comparison.** An own ring of the last 20 committed
   `{ts_open, volume}`; `rollingMean` is their mean. Both baselines exclude the
   current bar.
6. **Read before write.** For the bar being evaluated, `slotMedian`,
   `priorCount` and `rollingMean` are read first and stored on the bar record
   as `baselineAtOpen`. Every later recomputation of that bar (replace, closed
   correction) divides by those stored values. A bar never sees its own volume
   in its denominator.
7. **Commit rule (one observation per `ts_open`, correctable).** The bar
   record is `{ts_open, volume, baselineAtOpen, committed}`. The observation is
   inserted into the slot ring and the rolling ring at the first of: (a) the
   first dispatch of that `ts_open` with `bar.closed === true`; (b) the
   arrival of a bar with a greater `ts_open` while the record is uncommitted (a
   close that never arrived), inserting the last known volume. All derived
   state is keyed by `ts_open`, so a later closed dispatch of the same
   `ts_open` with a different volume UPDATES the observation in both rings in
   place and recomputes that bar's own ratio from `baselineAtOpen`; it never
   inserts twice. A valid-to-invalid correction REMOVES the observation from
   both rings and yields `null`; invalid-to-valid inserts it. A dispatch older
   than the current record is ignored. The replay tail may be a forming bar
   (the runtime keeps supplied `closed` flags); it stays pending.
8. **Confirmation.** Outputs and the marker are provisional while
   `bar.closed === false` (lighter styling, status row `Forming`) and
   confirmed on the first closed dispatch. The marker is always for the bar of
   the current call. A bar committed by rule (b) never received a close, so its
   drawing stays provisional; that is intentional and documented, and such
   bars are excluded from the live-versus-replay marker comparison (their
   numeric outputs are still compared).
9. **Output.** `rvol = volume / slotMedian`, `null` while `priorCount <
   minSessions` (default 3) or the median is 0 or not finite. `rolling =
   volume / rollingMean`, `null` until 20 committed bars. `minSessions` is
   clamped to `<= sessions` at read time. The forming bar is divided by the
   full-bar expectation, so it grows toward its final value during the bar.
10. **Marker (the one alert condition).** `hot`: `rvol >= hotThreshold`
    (default 2) draws a small circle on the bar; `rvol >= 3` the same circle,
    larger. The marker is a pure function of the bar's current `rvol`, so a
    correction crossing the threshold in either direction adds or removes it
    on the next dispatch, and a replace redraws rather than duplicates.
11. **Status precedence, first match wins.** Unsupported timeframe; invalid
    current volume (`No usable volume`); insufficient prior samples
    (`Learning this time of day: 1 of 3 sessions`); unusable baseline
    (`No usable volume baseline`, median 0); forming (`Forming: versus
    full-bar expectation`); ready (blank).
12. **No future data.** Every value at bar t uses only bars with
    `ts_open <= t.ts_open`. Truncating the series at any index must not
    change earlier numeric outputs or earlier confirmed markers.
13. **Fail closed.** Any non-finite intermediate yields `null`.

## Default view (what a trader sees in three seconds)

Own pane. One line `rvol` with `ctx.draw.fill(rvol, 1, ...)`: green
(`#26a69a`, alpha) above 1, grey below 1. Line color per bar: hot (>=
`hotThreshold`) `#ff9800`, above 1 `#26a69a`, below 1 `#787b86`. Price lines
at 1, 2 and 3. Hot markers on. The rolling comparison line is OFF by default;
its value still shows in the table. Table, top right, three rows:
`RVOL 2.4x (time of day, 7 prior)` colored like the line, the count being the
prior observations in the denominator excluding this bar; `1.1x (rolling 20)`;
the status row from rule 11. Any unavailable value shows `—`. Before warm-up
the pane is empty, never zero.

## Controls

Primary (three, main tab): `sessions` ("Lookback sessions", 10, 2..60,
step 1, recompute), `hotThreshold` ("Unusual above", 2, 1..10, step 0.5,
cosmetic: it changes colors and markers only, computed from the stored
`rvol`), `showRolling` ("Show rolling comparison", false, cosmetic).

Advanced (the UX specialist's mechanism; if none landed, the `visibility`
tab): `minSessions` (3, 1..20, step 1, recompute), `clock` select (auto /
newYork / utc, recompute), `showMarkers` (true, cosmetic), colors (cosmetic).

Every key appears in `settingsSchema`; numeric and slider fields have
`step > 0`. Presets then work automatically.

Deferred to the backlog with reasons: weekend slot family for crypto (seven
retained days of one-minute history give two weekend observations per slot);
a "sustained" run marker (needs run state that survives corrections).

## Baseline comparison: what must be shown

Two comparison methods, both at the same threshold (2.0), on the same
eligible bars (both ready), both using volumes:
- Rolling: `volume / mean of previous 20 committed volumes`.
- Same-slot mean: `volume / mean of the slot ring` (same observations as the
  median), to separate the benefit of clock normalisation from the benefit of
  the median.

Equity fixture (deterministic, in the validation harness): 15 sessions of
390 one-minute bars starting Monday 2026-03-02 09:30 New York (this week
contains the US spring DST change on Sunday 2026-03-08, so sessions 1..5 and
6..15 have different UTC offsets while their New York start-minute keys are
identical; that is the clock test). Expected volume for minute m (0..389)
with V = 1,000: `E(m) = V * (1 + 3 * max(0, 1 - m/60)^2)` for m < 60, `V`
for 60 <= m <= 330, `V * (1 + (m - 330) / 59)` for m > 330. Noise:
`volume = round(E(m) * exp(0.15 * z))`, z standard normal from Box-Muller
(two uniforms per pair, both outputs used in order) over mulberry32 seeded
20261026. Generation order: for each session in order, for each minute in
order, one z. Then anomalies: draw (session in 4..15, minute in 90..330) pairs
one at a time with the same generator, rejecting duplicates, until 12 are
held; each replaces its bar with `round(2.5 * E(m))`. Evaluation bars:
sessions 4..15 where all methods are ready. Predictable slots: minutes 0..9
and 380..389. A false positive is a detection on an eligible non-anomaly bar.

Acceptance (descriptive, not predictive):
- Time-of-day recall on the 12 anomalies >= 11/12, and >= rolling recall
  minus one anomaly.
- Time-of-day predictable-slot false-positive rate <= 10 percent of those
  bars, and <= half of rolling's predictable-slot rate.
- Overall false-positive rates and the same-slot-mean method's numbers are
  reported beside these in the doc page, whatever they are. If the fixture
  disproves the hypothesis, the brief returns to the PM.

Control experiment (reported, not a gate): the same fixture with flat
seasonality (`E(m) = V`) and 12 anomalies drawn from all minutes, so the doc
page states how the methods compare when the clock explains nothing.

Crypto fixture (performance, retention): 12,000 one-minute bars starting
2026-03-02 00:00 UTC, expected volume `V * (1 + 0.5 * cos(2 * pi * (m -
840) / 1440))`, same noise model and generation order, seed 20261027. Timing
over bars 1..10,080; rollover over all 12,000 (the per-bar record count stays
at or under 10,080 and every ring at or under capacity); a REBUILT replay from
bars 1,921..12,000 must reproduce live outputs for every bar whose full
`sessions` lookback lies within those bars. Readiness is asserted from actual
prior observations per key, not from a calendar day number.

Further fixtures with expected outcomes:
- Gap: a session missing minutes 120..179 contributes no observations for
  those keys; the bar after the gap has an unchanged baseline.
- Early close at 13:00: the session's last bar enters its key as one
  observation; the next session's bar at that key still divides by the median
  of `sessions` observations, which one short bar does not move.
- Short-bar key check through the real resampler: feed one session of 1m
  fixture bars through `resampleBars` to the hourly timeframe and confirm the
  final bar keys 930 (15:30) and that the indicator treats it as its own slot.
- Changed-volume closed replacement: close at 100, then close again at 150;
  both ring observations become 150, that bar's ratio uses its stored
  denominator, its hot marker appears or disappears accordingly, and every
  later bar matches a replay that only saw 150. Also valid to invalid
  (observation removed, output null) and invalid to valid (inserted).
- Duplicate identical closed dispatch: no change in any output.
- Replay with a forming tail bar: the tail stays pending and provisional.

## Success criteria (all required for acceptance)

1. Hand-computed exact values on a small three-session fixture: median
   baseline, warm-up nulls, the forming-bar growth, the stored denominator.
2. Validation harness: truncation invariance (numbers and confirmed markers);
   live-versus-replay equivalence as scoped above; the correction, duplicate,
   gap, early-close, resampler and forming-tail fixtures; empty input; no NaN.
3. The baseline comparison numbers above, reproduced by a test and quoted in
   the doc page.
4. Performance, measured with the validator's perf probe on this container
   (4 cores, Node 24.21.0, vitest): p99 `onBar` under 0.05 ms over the first
   10,080 bars of the crypto fixture; bounded state as above.
5. Marker budget: on the equity fixture, the hot condition at the default
   threshold emits fewer than 2 markers per 100 evaluated bars, anomalies
   included.
6. UX: default view as specified, three primary controls, screenshots at two
   zoom levels from the UX specialist's fixture path, table copy approved by
   UX.
7. Docs: `docs/architecture/indicators/relative-volume.md` and one row in the
   indicators README map; `node scripts/validate-docs.cjs` passes.
8. Full web suite, type check and lint green; Codex code review APPROVED;
   validator report PASS.

## Limitations to state in the package

Needs `minSessions` prior sessions per slot: one-minute crypto retains seven
UTC days, one-minute equities about 25 sessions; a fresh symbol shows
"learning" for three sessions. Holidays and early closes are ordinary
sessions. No duration normalisation (see Data). Equity candles are regular
session only. Weekend behaviour on crypto is not separated. The ratio is
unit-free; volume units are the provider's. Descriptive only.

## Seams for later cycles

`relativeVolumeMath.ts` exports the slot-median machinery so Squeeze Breakout
Context can import it as its volume confirmation. There is no cross-indicator
read in the SDK, so this is a shared module, not a runtime link.

## Budget

One build run by the OHLCV specialist, UX joins before the build ends, at most
two fix rounds after Codex code review and validation. A third failure returns
the concept to the backlog with the evidence attached.

## Plan-gate history

Round 1 REVISE: commit timing, stored denominator, marker ownership, edge
cases, busier default, benchmark math. Round 2 REVISE: corrections after
commit, retention, short-bar slot collision, sustained state, replay tail,
weekend readiness, status precedence, gate hides table. Round 3 REVISE: rate
normalisation impossible with nominal `interval_ms`, retention claim wrong,
corrections in all derived state, fallback commit styling, clock rule, fixture
freezing, control experiment. Round 4 reviewed an unchanged brief by PM error
and repeated round 3 plus: synthetic clock test, relative acceptance bounds,
same-slot-mean comparison, `—` for unavailable values. All accepted here; the
PM rejected only round 1's claim that `ta.sma` is unavailable (it is, but is
no longer used).

## Amendments from plan round 5 (accepted by the PM; the brief is APPROVED by PM authority after five rounds)

1. **Corrections are tail-only.** In-place update, removal or insertion of an
   observation applies only to the current tail record. A correction to any
   older bar reaches the indicator as a `REBUILT` replay (the runtime's own
   behaviour), which recreates state from scratch. Test: correct a bar after
   several successors by replaying, and compare every successor against a fresh
   replay.
2. **Eviction rollback.** When the tail's observation is inserted into a full
   ring, the evicted observation is kept as `evictedByTail` on that ring until
   the tail is superseded by a newer bar. A valid-to-invalid correction of the
   tail removes its observation and restores `evictedByTail`; invalid-to-valid
   re-inserts and re-evicts. Test valid, invalid, valid with both rings full
   and compare with a replay that saw only the final state.
3. **Lookback counts matching bars, not sessions.** A missing slot stretches
   the lookback across more calendar sessions, and the autumn New York DST
   repeat can supply two observations for one local minute on crypto under the
   `newYork` clock. Accept "last N matching bars" and label accordingly:
   control label "Lookback (matching bars)", table "7 prior"; the settings key
   stays `sessions` for brevity but the doc page explains it.
4. **Median wording.** The median limits a single short or odd bar's influence;
   it does not make it zero. Test the exact median on a fixture containing one
   shortened bar instead of asserting no change.
5. **Settings that change colours or markers replay.** `recolor` receives only
   the old colour and settings, so it cannot reclassify history under a new
   threshold, and markers and fills need refreshing too. Therefore
   `hotThreshold`, `showMarkers` and `showRolling` are `affects: "recompute"`
   (a replay at this indicator's cost is well under a second for 10,080 bars);
   only the colour pickers are `cosmetic` with `recolor`.
6. **Marker size rule.** Draw a marker only when hot; enlarge a drawn marker
   when `rvol >= 3`. With `hotThreshold > 3` every drawn marker is large.
7. **Crypto equivalence test at a feasible lookback.** Twelve thousand minutes
   hold about eight days, so no slot has ten prior observations in a seven-day
   replay. Run the REBUILT equivalence check with `sessions = 3`, assert a
   non-zero count of compared bars, and exercise full rings at the default
   capacity on the 15-session equity fixture (14 prior per slot).
8. **Report counts, not only rates**, for every comparison: eligible bars,
   detections, anomalies hit.
9. **Performance measurement, frozen.** Three untimed warm-up replays, then
   five timed replays of the first 10,080 bars; per-bar timings pooled; p99 by
   nearest rank; the timed region is `onBar` plus `readOutput` with no-op draw
   and marker namespaces (drawing is excluded and said to be).
10. **Warm-up screenshot.** The UX package includes a screenshot of the
    learning state (table row visible, pane empty) beside the ready view.

## Amendments from the UX pre-build review (adopted 2026-10-26, supersede Default view and Controls above)

Colours follow the house colour semantics: the rvol line is purple `#8672b3`,
hot bars `#2563eb`, below-1 grey `#787b86`; one fill above 1 at
`rgba(134,114,179,0.15)`, nothing below 1; widths 2 and 1; `autoscaleRange
{ min: 0, max: 4 }` with `priceLines [1, 2, 3]`; provisional styling is the
same hues at 50 percent alpha. Marker: circle, aboveBar, size 1 when hot,
size 2 at rvol >= 3, colour `#2563eb`. Controls: two primaries on the Inputs
tab, `sessions` "Lookback (prior bars)" and `hotThreshold` "Unusual above
(×)"; Advanced: `minSessions` "Minimum prior bars", `clock` "Clock"
(Automatic / New York / UTC); Visibility: `showRolling` "Show rolling 20",
`showMarkers` "Show unusual markers". Table strings exactly: `RVOL 2.4× · 7
prior`, `Rolling 1.1× · 20 bars`, status one of `Learning · 1 of 3 prior`,
`Forming · vs full bar`, `Needs 1m to 1h`, `No usable volume`, `No usable
baseline`; `—` for unavailable; "prior" everywhere in trader-facing copy.
Eight screenshots: ready at two zooms, learning, forming, 4h unsupported, dark
chart, dialog Inputs, Advanced open, Visibility.

## Rulings on the Codex challenge gate (G3 round 1, 2026-10-26)

1. Colour pickers for the rvol line forced a replay that can change values
   (live state holds observations beyond chart retention). Ruling: remove the
   three colour pickers for this version; colours are fixed. `rollingColor`
   may stay only if it recolours in place without replay. A cosmetic setting
   must never change a number.
2. Default lookback 10 on one-minute crypto exceeds the seven retained days,
   so a reconnect or rebuild can change the latest ratio. Ruling: accepted
   behaviour, documented plainly ("after a reload, one-minute crypto has at
   most six prior observations per minute until the chart has run for ten
   days"); the doc must not claim ten fits; add the rollover/reconnect test
   Codex describes, comparing the latest outputs and markers.
3. A resampled bucket truncated by a source gap (`closed: false`, then
   superseded) committed its partial volume. Ruling: rule 7(b) is withdrawn.
   A bar that is superseded without ever closing contributes NO observation
   to either ring; its own ratio stays provisional. Missing data contributes
   nothing.
4. A session-wide volume shift marks every bar hot. Ruling: correct
   behaviour for a descriptive tool (every bar IS unusual relative to prior
   sessions); no cooldown, which would hide information. The doc page states
   it and the marker budget is reported on the frozen fixture and on a
   regime-shift fixture, both numbers quoted. Classified as a descriptive
   annotation tool under the protocol's 200 per 1,000 ceiling on typical data.
5. The forming-bar probe never reached a warmed slot, so it timed nulls.
   Ruling: fix the probe to warm every slot with the frozen fixture first and
   to force threshold crossings; report that p99 beside the replay p99.
6. With `sessions = 2` the even-count median is a mean. Ruling: `sessions`
   range becomes 3..60; the doc says the median "limits" one day's influence.
7. Published counts were printed, not pinned. Ruling: pin the published
   detections, hits and false positives for all three methods and the
   control; require non-zero eligible outputs in every budget test.

Code gate round 1 also required: the overall false-positive rate divides by
eligible non-anomaly bars, not by eligible minus hits; add a hand-computed
case with a missed anomaly.
