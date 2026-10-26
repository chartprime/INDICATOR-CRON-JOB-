# Build brief: Relative Volume by Time of Day

PM brief for the cycle-1 build. Shared rules: PM/WORKER-BRIEF.md. Capability
sheet: PM/CAPABILITIES.md. UX standard: PM/cycle1/ux-standard.md (follow it
where it exists; where it is silent, follow the house conventions in the
existing indicators). Validation protocol: PM/cycle1/validation-protocol.md.

## The trading question

"Is this bar's volume unusual for this time of day, or is it just the open,
the close or the London/New York overlap being its normal self?"

## Target user and decision

Intraday traders on ES, NQ, AAPL, TSLA, BTC and ETH who confirm moves with
volume. Decision: treat participation as genuinely unusual for this minute,
or discount it because this minute is always loud. High relative volume on
its own says nothing about direction or follow-through, and the package says
so. Plain rolling
RVOL fires every morning at the open and goes quiet every lunch; this tool
stays flat where the clock explains the volume and lights up only when the bar
is unusual for its slot.

## Identity

- Folder `apps/web/src/lib/indicators/relative-volume/`, def `relativeVolume.ts`,
  computation in `relativeVolumeMath.ts` (pure, testable), tests in `tests/`.
- id `relativeVolume`, label `"Relative Volume (Time of Day)"`, category
  `"technical"`, placement `{ kind: "ownPane", priceLines: [1, 2, 3] }`.
- Historical Mode policy `OHLCV_POLICY`. Works on every archived instrument
  and on equities (unsided volume is irrelevant: only `bar.volume` is read).
- No `timeframeGate` (it would remove the indicator and its table entirely).
  For `interval_ms > 3_600_000` every output is `null` and the status row says
  `Time of day needs an intraday timeframe`.

## Data

`bar.ts_open`, `bar.interval_ms`, `bar.volume`, `bar.closed`, `bar.provider`,
`bar.assetClass`, `bar.marketKind`. Nothing else. No wall clock. Identity
fields choose the clock convention only; availability is governed by the
OHLCV capability policy, never by provider. A bar whose `volume` is not a
finite number >= 0 contributes no sample and yields `null` for that bar.
Missing bars (gaps in `ts_open`) contribute nothing, never a zero sample.

Math library note: the `ta.*` factories are top-level imports
(`import { ta } from "../../chart/ta"`) created once inside `createState`,
exactly as `docs/architecture/indicator-sdk/TA.02-ta-math-library-evidence.md`
describes; `ctx.ta` is an intentionally empty namespace and is not used. The
rolling comparison uses `ta.sma(20)` fed with committed volumes only (see the
commit rule), so its denominator excludes the current bar, mirroring the slot
method; `null` until 20 committed bars.

## Calculation (incremental, one bar at a time)

1. **Clock.** Equities and futures (provider DXFEED or DATABENTO): New York
   local minute of day, computed the way `killzones` does it (reuse
   `apps/web/src/lib/chart/marketCalendar.ts` or the `nyParts` helper; do not
   write a new time-zone routine). Crypto (provider BINANCE): UTC minute of
   day, with two slot families, weekday and weekend, selected by the UTC day of
   week. Advanced setting `clock`: `auto` (default), `newYork`, `utc`.
2. **Slot key.** The bar's start minute of day in the resolved clock
   (0..1439), plus the family. No division by bar length: an hourly equity
   bar starting 09:30 keys 570, the half-hour 15:30 bar keys 930, and neither
   collides with another slot. At most 1,440 keys per family.
3. **Observation = volume rate.** What enters a ring is
   `rate = volume / (interval_ms / 60_000)`, volume per minute, so a short bar
   (an early-close day, the final equity hour bar) is compared with full bars
   fairly. The forming bar's rate uses its declared `interval_ms`.
4. **Baseline.** Per slot key, a ring of the last `sessions` committed
   observations `{ts_open, rate}` (default 10, range 2..60) and their median.
   Median, not mean, so one news day does not inflate tomorrow's baseline. An
   observation is evicted when it is older than the chart's retention window,
   `bar.ts_open - 10_080 * bar.interval_ms`, so state never depends on bars
   the chart no longer holds; a REBUILT replay from retained bars then
   reproduces live state exactly.
5. **Baseline read before write.** For the bar being evaluated, the slot
   median and the rolling SMA are read first (`baselineAtOpen`), stored on the
   bar's own record, and every later recomputation of that bar (a `replace`
   revision, a duplicate closed dispatch) divides by that stored value. A bar
   never sees its own volume in its denominator.
6. **Commit rule (one observation per `ts_open`, correctable).** State keeps
   the current bar record `{ts_open, rate, baselineAtOpen, committed}`. The
   observation is inserted into its slot ring and into the rolling window at
   the first of: (a) the first dispatch of that `ts_open` with
   `bar.closed === true`; (b) the arrival of a bar with a greater `ts_open`
   while the record is uncommitted (a close that never arrived), inserting the
   last known rate. Rings store `{ts_open, rate}`, so a later closed dispatch
   of the same `ts_open` with a different volume UPDATES that observation in
   place (same key, new rate) and recomputes the bar's own ratio from its
   stored `baselineAtOpen`; it never inserts twice. This keeps live state equal
   to a replay that only ever saw the corrected bar. A dispatch older than the
   current record is ignored. The replay tail may be a forming bar (the
   runtime keeps the supplied `closed` flags); it stays pending like any live
   forming bar.
7. **Confirmation.** A bar's outputs and markers are provisional while
   `bar.closed === false` (drawn lighter) and confirmed on the first closed
   dispatch, including the last bar of a replay. No bar ever emits a marker
   for a different bar: a marker is always for the bar of the current call,
   so the runtime's per-timestamp replace cannot leave stale or duplicate
   markers.
8. **Output.** `rvol = rate / slotMedian`, `null` while the slot has fewer
   than `minSessions` (default 3) observations or the median is 0 or not
   finite. Median of an even count is the mean of the two middle values. The
   forming bar is divided by the full-slot expectation, so it grows toward its
   final value during the bar. `rolling = rate / mean of the previous 20
   committed rates`, `null` during its warm-up. `minSessions` is clamped to
   `<= sessions` at read time. Precedence of states: invalid current volume
   gives `No usable volume` even while the slot is still learning.
9. **Markers (alert conditions).** `hot`: `rvol >= hotThreshold` (default 2)
   draws a small circle on that bar; `rvol >= 3` the same circle, larger.
   `sustained` (advanced, off by default): a committed run counter advances
   only when a bar commits with `rvol >= sustainedLevel`; the forming bar is
   evaluated provisionally as `committedRun + (formingQualifies ? 1 : 0)` and
   never advances the committed counter, so repeated forming updates cannot
   inflate the run. The marker is drawn on the bar at which the provisional
   run first reaches `sustainedBars` (default 3), once per run. The run resets
   on a bar below the level, a `null` or invalid bar, a missing bar in the
   sequence (next `ts_open` not equal to previous plus `interval_ms`), or a
   session boundary (a change of calendar day in the resolved clock, or of
   family). Markers are derived from state on every call, so a replace
   redraws rather than duplicates.
10. **Sessions, slots and duration.** A ring holds observations, one per
   committed bar; because a slot occurs once per calendar session, a session
   contributes at most one sample per slot. Exception: the repeated New York
   hour at the autumn DST change can land two futures bars in one slot; both
   are kept as observations, documented, no special case. Bars shorter than
   their nominal length (the 15:30 to 16:00 equity hour bar, an early-close
   day's last bar) are handled by the rate observation and the start-minute
   key: a shortened bar is compared per minute with other bars that started at
   the same clock minute. `sessions` is the ring capacity, not
   a promise of available history: retained history supplies what it has, and
   the table shows the actual sample count.
11. **No future data.** Every value at bar t uses only bars with
    `ts_open <= t.ts_open`. Truncating the series at any index must not change
    earlier outputs or earlier markers (the validator checks both).
12. **Fail closed.** Any non-finite intermediate yields `null`.

## Default view (what a trader sees in three seconds)

Own pane. One line `rvol` with `ctx.draw.fill(rvol, 1, ...)`: green
(`#26a69a`, alpha) above 1, grey below 1. Line color per bar: hot (>= hot
threshold) `#ff9800`, above 1 `#26a69a`, below 1 `#787b86`. Price lines at
1, 2 and 3. Hot markers on. The rolling comparison line is OFF by default
(the orange line already identifies hot bars); its value still shows in the
table so the contrast is one glance away. Table, top right, three rows:
`RVOL 2.4x (time of day, n=7)` colored like the line, where n is the slot's
actual observation count; `1.1x (rolling 20)`; a status row that is exactly
one of `Forming: versus full-bar expectation` (bar not closed),
`Learning this time of day: 1 of 3 sessions`, `No usable volume` (invalid
current volume), `No usable volume baseline` (median 0), `Time of day needs an
intraday timeframe`, or blank when ready and closed. Before warm-up the
pane is empty, never zero.

## Controls

Primary (at most three, in the dialog's main tab): `sessions` ("Lookback
sessions", 10, 2..60, step 1), `hotThreshold` ("Unusual above", 2, 1..10,
step 0.5), `showRolling` ("Show rolling comparison", false).

Advanced (use the mechanism the UX specialist chose; if none landed, use the
`visibility` tab): `minSessions` (3, 1..20, step 1), `clock` select (auto /
newYork / utc), `weekendSplit` (false by default: seven retained days of one-minute crypto
give only two weekend observations per slot, below `minSessions`; the label
says it applies to the UTC clock only and needs longer history, since
`visibleIf` cannot see the instrument),
`showMarkers` (true), `showSustained` (false), `sustainedBars` (3, 2..10),
`sustainedLevel` (1.5, 1..5, step 0.1), colors.

Every key appears in `settingsSchema`; numeric and slider fields have
`step > 0`; `recompute` for anything that changes values, `cosmetic` for
colors. Presets then work.

## Baseline to beat, and the evidence required

Baseline: `volume / SMA(20)` of the previous 20 committed bars (the
comparison line itself). Both methods are evaluated at the same threshold
(2.0), on the same bars (those where both are ready), and both recall and
false-positive rate are reported for both without a predetermined winner.

Deterministic equity fixture (in the validation harness): 15 sessions of
390 one-minute bars, New York 09:30 to 16:00. Expected volume for minute m
(0..389) with midday level V = 1,000: `E(m) = V * (1 + 3 * max(0, 1 - m/60)^2)`
for m < 60, `V` for 60 <= m <= 330, `V * (1 + (m - 330) / 59)` for m > 330
(so 4.0x at the open decaying to 1.0x by minute 60, flat, rising to 2.0x at
the close). Noise: `volume = E(m) * exp(0.15 * z)` with z standard normal from
a Box-Muller transform over mulberry32 seeded 20261026. Anomalies: 12 distinct
(session, minute) pairs drawn with the same generator from sessions 4..15 and
minutes 90..330, each replaced by `2.5 * E(m)` (the expected, not the noisy,
value). Evaluation bars: sessions 4..15 where both methods are ready.
"Predictable slots" are minutes 0..9 and 380..389. A false positive is a
detection on an eligible non-anomaly bar; report the overall rate and the
predictable-slot rate.

Deterministic crypto fixture for performance and retention: 10,080 one-minute
bars (7 UTC days), expected volume `V * (1 + 0.5 * cos(2 * pi * (m - 840) /
1440))` with the same noise model, seed 20261027. Used for the p99 timing,
the rollover (feed 12,000 bars, confirm bounded state), and a REBUILT replay
from the last 10,080 bars that must reproduce the live outputs for every bar
whose full lookback lies within retention.

Acceptance for this indicator (descriptive, not predictive):
- Recall on the 12 anomalies >= 11/12.
- Predictable-slot false-positive rate <= 10 percent of those bars.
- The rolling method's recall, overall and predictable-slot false-positive
  rates on the same bars are reported beside these in the doc page, whatever
  they are. The hypothesis
  under test is that the time-of-day method has a lower false-positive rate
  at the open and close with comparable recall; if the fixture disproves it,
  the brief returns to the PM.

Additional fixtures with expected outcomes:
- Weekend split ON on the 7-day crypto fixture: weekend slots show
  `Learning: 2 of 3 sessions`, weekday slots are ready from day 4 on; no NaN.
- New York DST week for futures (autumn): the repeated 01:00 hour yields two
  observations in those slot keys that day, both kept; the spring week yields
  none for the skipped hour; outputs identical live and in replay.
- Gap: a session missing minutes 120..179 contributes no observations for
  those keys; the bar after the gap has an unchanged baseline and a reset
  sustained run.
- Early close at 13:00: the 12:30 hourly bar (30 minutes) is compared per
  minute with other 12:30 bars; its ratio is near 1 when its rate is normal.
- Changed-volume closed replacement: a bar closes at 100, then closes again at
  150; the ring observation becomes 150, that bar's own ratio uses its stored
  denominator, and every later bar matches a replay that only saw 150.
- Duplicate identical closed dispatch: no change in any output.
- Replay with a forming tail bar: the tail stays pending and provisional.

## Success criteria (all required for acceptance)

1. Hand-computed exact values on a small three-session fixture, including the
   median baseline, warm-up nulls, and the forming-bar growth.
2. Validation harness: truncation invariance; live-versus-replay equivalence
   (committed outputs identical); duplicate closed dispatch and REBUILT
   sequence; empty input; no NaN anywhere.
3. Baseline comparison numbers above, reproduced by a test.
4. Performance, measured with the validator's perf probe on this container
   (4 cores, Node 24.21.0, vitest): p99 `onBar` under 0.05 ms over the
   10,080-bar replay of the fixture above; retained state bounded by
   `2 x 1,440 x sessions` numbers plus one small record per retained bar.
5. Marker budget: on the 15-session fixture above (the "busy fixture"), the
   hot condition at the default threshold emits fewer than 2 markers per 100
   evaluated bars, anomalies included.
6. UX: default view as specified, three primary controls, screenshots at two
   zoom levels from the UX specialist's fixture path, legend copy approved by
   UX.
7. Docs: `docs/architecture/indicators/relative-volume.md` and one row in the
   indicators README map; `node scripts/validate-docs.cjs` passes.
8. Full web suite, type check and lint green; Codex code review APPROVED;
   validator report PASS.

## Limitations to state in the package

Needs `minSessions` prior sessions per slot: one-minute crypto retains seven
UTC days, one-minute equities about 25 sessions; a fresh symbol shows
"learning" for three sessions. Holidays and early closes are ordinary sessions
in this version. Equity candles are regular session only. The ratio is
unit-free; volume units are the provider's.

## Seams for later cycles

`readOutput` exposes `rvol` so Squeeze Breakout Context can adopt the clock
baseline as its volume confirmation. No cross-indicator read exists in the
SDK today, so that adoption is a shared math module import, not a runtime link.

## Note for the Codex plan reviewer

The `PM/` documents referenced above live outside this checkout, at
/home/user/Terminal-L1-L2/PM/. Their requirements relevant here are
summarised in this brief: at most three primary controls, honest nulls,
house colors green `#26a69a` red `#ef5350` neutral `#d1d4dc`, truncation
invariance and live-versus-replay equivalence as validation checks.

## Round 3 changes (after Codex plan review round 2)

Observations are volume rates keyed by start minute of day, so short bars and
early closes compare per minute without slot collisions; rings store
`{ts_open, rate}` and a corrected closed bar updates its observation in place;
observations older than the chart's 10,080-bar retention are evicted so a
REBUILT replay reproduces live state; `timeframeGate` dropped in favour of
null outputs plus a status row; forming label and sample count added to the
table; weekend split off by default with the reason; sustained run has
committed and provisional parts, configurable length and explicit resets;
invalid-volume precedence stated; fixtures frozen (formula, generator, seed,
anomaly rule), a 10,080-bar crypto fixture added for timing and retention,
false positives defined, expected outcomes listed per fixture.

## Round 2 changes (after Codex plan review round 1)

Commit rule now keyed to the first closed dispatch with a fallback on the
next bar; denominator stored before insertion; markers only for the current
bar; even-count median, invalid volume, `minSessions <= sessions`, sustained
re-arm rules, session identity, DST repeat hour and short bars specified;
`ta.sma` clarified as a top-level factory import fed with committed volumes
only; rolling line off by default and `minSessions` moved to advanced;
table rows and status states fixed; benchmark rewritten as a seeded fixture
with both methods measured at the same threshold on the same bars, with
recall and false-positive rate reported for both; hardware named for the
performance target; extra fixtures listed.

## Budget

One build run by the OHLCV specialist, UX joins before the build ends, at most
two fix rounds after Codex code review and validation. A third failure returns
the concept to the backlog with the evidence attached.
