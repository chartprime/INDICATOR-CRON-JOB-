# Relative Volume (Time of Day)

[Handbook](../../README.md) · [Indicator index](README.md) ·
[Data for indicator authors](data-for-indicator-authors.md) ·
[Setting presets](setting-presets.md)

Code: `apps/web/src/lib/indicators/relative-volume/` (`relativeVolume.ts` is
the registry definition, `relativeVolumeMath.ts` the pure machinery, `tests/`
the evidence). Registry id `relativeVolume`, label "Relative Volume (Time of
Day)", category technical, own pane. The code wins over this page.

## The question it answers

"Is this bar's volume unusual compared with the same minute of the day on
recent sessions, or is it just the open, the close or the London/New York
overlap being its normal self?"

A rolling-average relative volume compares a bar with the twenty bars before
it, so the first minute of a cash session always looks loud and the lunch hour
always looks dead. This indicator compares a bar only with bars that started at
the same minute of the day on earlier sessions. High relative volume says
nothing about direction or follow-through; the colours are purple and blue so
nothing on the pane reads as buy or sell. The baseline is short and noisy, so
the claim is "unusual relative to the last N matching bars at this minute", not
"unusual" in any absolute sense. Descriptive only.

## Calculation

One bar at a time, incrementally; `onBar` never rebuilds from an array.

1. **Clock.** The `clock` setting: `auto` is New York for the dxFeed and
   Databento providers and UTC for Binance; `newYork` and `utc` force it. The
   New York minute of day comes from the killzones helper
   (`nyLocalMinuteOfDay`), cached once per UTC hour; there is no new
   time-zone code.
2. **Slot key.** The bar's start minute of day in that clock (0..1439). There
   is no division by bar length: an hourly equity bar starting 09:30 keys 570
   and the 15:30 half-hour bar keys 930, so they never collide. At most 1,440
   keys exist.
3. **Observation.** The bar's `volume`. A volume that is not a finite number
   at or above zero contributes nothing and the bar reads `null`.
4. **Baseline.** Per slot key, a ring of the last `sessions` committed
   observations (default 10, range 2..60) and their median (even count: mean
   of the two middle values). Median, not mean, so one news day does not
   inflate tomorrow's baseline. The ring capacity is the only bound.
5. **Rolling comparison.** A ring of the last 20 committed bars; its mean is
   the plain relative-volume baseline, shown for comparison.
6. **Read before write.** When a bar first arrives, the slot median, the count
   of prior observations and the rolling mean are read and stored on the bar
   record. Every later recomputation of that bar (a forming revision, a
   corrected close) divides by those stored values. A bar never sees its own
   volume in its denominator.
7. **Commit.** One observation per `ts_open`, filed into both rings at the
   first of: the first dispatch with `closed: true`, or the arrival of a bar
   with a greater `ts_open` while the record is still open (a close that never
   arrived; the last known volume is filed). A later closed dispatch of the
   same bar with a different volume updates the observation in place; a
   valid-to-invalid correction removes it and restores whatever its insertion
   evicted; invalid-to-valid re-inserts it. Corrections are tail-only: a
   correction to an older bar reaches the indicator as the runtime's full
   replay, which recreates this state from scratch.
8. **Outputs.** `rvol = volume / slot median`, `null` while the slot has fewer
   than `minSessions` prior observations (default 3, clamped to `sessions`)
   or the median is zero. `rolling = volume / rolling mean`, `null` until 20
   bars are committed. The forming bar is divided by the full-bar
   expectation, so it grows toward its final value during the bar.
9. **Fail closed.** Any non-finite intermediate yields `null`; nothing ever
   emits `NaN`.

Lookback counts **matching bars, not calendar sessions**: a missing slot
stretches the lookback across more sessions, and the autumn New York DST
repeat can supply two observations for one local minute on crypto under the
`newYork` clock. The table therefore says "7 prior" and the control is
"Lookback (prior bars)".

## Data and the clock rule

Reads `bar.ts_open`, `bar.interval_ms`, `bar.volume`, `bar.closed` and
`bar.provider` (the provider only picks the clock). No sided volume, no ticks,
no order book, no wall clock. Missing bars (gaps in `ts_open`) contribute
nothing, never a zero; the rolling comparison carries across a gap because it
counts committed bars, not minutes.

Timeframes longer than one hour cannot be keyed by minute of day: every output
is `null` and the table says `Needs 1m to 1h`. There is no `timeframeGate`, so
the pane and the table stay on the chart to say so.

The resampler reports the nominal `interval_ms` even for a shortened bucket
(the 15:30 equity half hour, an early-close session's last bar), so the
indicator cannot know a bar's real duration and does **no duration
normalisation**. The start-minute key already compares the 15:30 bar only with
other 15:30 bars. The one unhandled case is an early-close session, whose last
bar is shorter than its slot's usual bars; it enters as one observation among
`sessions` and the median limits its influence without removing it (on the
test fixture one 30-minute bar among three full hours moves the median from
60 to 59).

## Default view

Own pane with `autoscaleRange` 0..4 and dotted reference lines at 1, 2 and 3.
Those lines are **fixed reference marks**: they do not move when "Unusual
above" is changed; the exact ratio is in the table.

- One line, `rvol`, width 2: purple `#8672b3` at or above 1, blue `#2563eb`
  when at or above the "unusual" threshold, grey `#787b86` below 1.
- One fill between the line and 1, `rgba(134,114,179,0.15)`, above 1 only.
- A circle above the bar when the bar is unusual (section "Alert conditions").
- The rolling comparison line (width 1, grey) is off by default; its value is
  always in the table.
- While a bar is forming, its line colour, marker and table value use the same
  hues at 50 percent alpha; they settle at the close.
- Table, top right, three rows: `RVOL 2.4× · 7 prior` coloured like the line
  (the count is the prior observations in the denominator, excluding this
  bar), `Rolling 1.1× · 20 bars`, and a status row. Unavailable values show
  `—`. Before warm-up the pane is empty, never zero.

Status row, first match wins: `Needs 1m to 1h`, `No usable volume`,
`Learning · 1 of 3 prior`, `No usable baseline` (median 0), `Forming · vs full
bar`, and blank when the bar is ready and closed. The `draw.table` handle has
no way to drop a row once written, so the blank status row stays as an empty
strip when ready; removing it entirely needs a `TableHandle` change in
`apps/web/src/lib/chart/draw/table.ts`.

## Controls

Inputs tab (two primary controls, each with a one-line hint):

| Key | Label | Default | Range | Effect |
|---|---|---|---|---|
| `sessions` | Lookback (prior bars) | 10 | 2..60, step 1 | Ring capacity per slot. Replays every bar. |
| `hotThreshold` | Unusual above (×) | 2 | 1..10, step 0.5 | Colours the line and marks the bar. Replays every bar. |

Advanced group (collapsed at the end of the Inputs tab):

| Key | Label | Default | Range | Effect |
|---|---|---|---|---|
| `minSessions` | Minimum prior bars | 3 | 1..20, step 1 | Prior observations a slot needs before a ratio shows; clamped to the lookback. Replays. |
| `clock` | Clock | Automatic | Automatic / New York / UTC | Which minute of day a bar is filed under. Replays. |

Visibility tab:

| Key | Label | Default | Effect |
|---|---|---|---|
| `showRolling` | Show rolling 20 | off | Draws the rolling comparison line. Replays. |
| `showMarkers` | Show unusual markers | on | Draws the circles. Replays. |
| `lineColor` | Line colour | `#8672b3` | Line at or above 1 and the fill. |
| `hotColor` | Unusual colour | `#2563eb` | Unusual bars and their markers. |
| `rollingColor` | Rolling colour | `#787b86` | The rolling line. |

`hotThreshold`, `showMarkers` and `showRolling` are `recompute`: a per-bar
colour or marker cannot be reclassified from the old colour alone, and fills
and markers need refreshing, so these replay (well under a second for 10,080
bars). The colour pickers are `cosmetic`; the rolling line recolours in place,
and a change to the line or unusual colour also replays, for the same reason.
Every key is in the schema, so [presets](setting-presets.md) work without any
extra code.

## Alert conditions

There is no notification channel; an alert condition is a marker plus a table
row.

**Unusual volume.** Rule: `rvol >= hotThreshold` (default 2) on the bar of the
current call. It fires on that bar, as a circle above the bar in the unusual
colour, size 1, enlarged to size 2 when `rvol >= 3` (with a threshold above 3
every drawn marker is large). The marker is a pure function of the bar's
current ratio: it appears while the bar forms (at 50 percent alpha), **confirms
at the bar close**, and a correction crossing the threshold in either direction
adds or removes it on the next dispatch; a forming revision redraws rather than
duplicates. A bar whose close never arrived keeps its provisional marker. The
table's first row carries the same ratio in the same colour.

Fixture rate: on the frozen 15-session equity fixture at the default threshold,
13 markers over the 4,680 evaluated bars (sessions 4..15), 0.28 per 100 bars
(2.2 per 1,000), at most one per bar; the twelve labelled anomalies plus one
noise bar. The protocol ceiling is 40 per 1,000 for a signal tool.

## Warm-up

A slot shows a ratio once it holds `minSessions` prior observations (three by
default), so a fresh symbol shows `Learning · n of 3 prior` for three sessions
at every minute. The rolling comparison needs 20 committed bars. On one-minute
bars the chart retains 10,080 bars: about seven UTC days for crypto, about 25
regular sessions for equities, so the default lookback of ten fits; a
60-bar lookback on one-minute crypto never fills. Hourly bars warm up after
three sessions as well, since the key is the start minute, not the bar count.

## Replay and Historical Mode

Candle-only, policy `OHLCV_POLICY`: it works on every archived instrument and
on equities (equity candles are regular session only, so the New York keys run
570..959). A clean replay and a live feed with forming revisions end on the
same committed numbers and the same confirmed markers; the validation tests
pin this on the equity and crypto fixtures (`relativeVolumeValidation.test.ts`).

One documented difference: live state keeps observations from bars the chart
has already discarded past its 10,080-bar retention, while a replay starts
from the retained bars. Live-versus-replay equivalence therefore holds for
every bar whose full lookback lies within the retained series; on the 12,000-bar
crypto fixture at a lookback of 3 that is 5,760 of the 10,080 retained bars,
and the first 1,920 retained bars differ by design. A bar committed because its
close never arrived keeps provisional styling live, which a replay (where every
bar is closed) does not show; its numbers still match.

Truncation invariance (no future data) holds at every cut: a bar's committed
output and confirmed marker never change when later bars are added.

## Baseline comparison

Three methods at the same threshold (2.0) on the same eligible bars, all using
volumes, on the frozen equity fixture from the validation harness
(`relativeVolumeEquityFixture()`: 15 sessions of 390 one-minute bars from
Monday 2026-03-02 09:30 New York across the spring DST change, U-shaped
expected volume, lognormal noise, twelve 2.5× anomalies in sessions 4..15 at
minutes 90..330; predictable slots are minutes 0..9 and 380..389). Eligible
bars are those of sessions 4..15 where all three methods are ready; readiness
is read from actual prior observations per key. A false positive is a
detection on an eligible non-anomaly bar. Reproduced by
`tests/relativeVolumeBaseline.test.ts`, which prints this table.

| Method | Eligible bars | Detections | Anomalies hit | Recall | False positives | FP rate | Predictable-slot bars | Predictable-slot FPs | Predictable-slot FP rate |
|---|---|---|---|---|---|---|---|---|---|
| Time of day (slot median, this indicator) | 4680 | 13 | 12/12 | 100.00% | 1 | 0.02% | 240 | 0 | 0.00% |
| Same-slot mean | 4680 | 12 | 12/12 | 100.00% | 0 | 0.00% | 240 | 0 | 0.00% |
| Rolling 20 mean (plain RVOL) | 4680 | 32 | 12/12 | 100.00% | 20 | 0.43% | 240 | 19 | 7.92% |

What the tool shows that the baseline hides: the rolling baseline fires on 19
of the 240 opening and closing minutes of the evaluated sessions, where volume
is always loud, and the time-of-day baseline fires on none of them, at the same
recall. Acceptance: recall 12/12 (required at least 11/12 and at least rolling
minus one); predictable-slot false-positive rate 0.00 percent (required at
most 10 percent and at most half of rolling's 7.92 percent). The same-slot
mean is as good as the median on this fixture, which has one anomaly per slot
at most; the median's advantage, one news day not inflating tomorrow's
baseline, needs repeated anomalies in one slot and is not measured here.

Control experiment (reported, not a gate): the same fixture with flat
seasonality (`E(m) = V`) and twelve anomalies drawn from every minute. When
the clock explains nothing, the three methods agree on the anomalies and the
rolling baseline no longer misfires; the time-of-day method keeps one noise
false positive.

| Method | Eligible bars | Detections | Anomalies hit | Recall | False positives | FP rate | Predictable-slot bars | Predictable-slot FPs | Predictable-slot FP rate |
|---|---|---|---|---|---|---|---|---|---|
| Time of day (slot median) | 4680 | 13 | 12/12 | 100.00% | 1 | 0.02% | 240 | 0 | 0.00% |
| Same-slot mean | 4680 | 12 | 12/12 | 100.00% | 0 | 0.00% | 240 | 0 | 0.00% |
| Rolling 20 mean | 4680 | 12 | 12/12 | 100.00% | 0 | 0.00% | 240 | 0 | 0.00% |

## Performance and bounded state

Measured on this container (4 cores, Node 24.21.0, vitest) with the
harness's pooled probe (three untimed warm-up replays, five timed replays of
the first 10,080 bars of the frozen crypto fixture, `onBar` plus `readOutput`
per bar with no-op draw and marker namespaces, p99 by nearest rank; drawing is
excluded): p50 0.001 ms, p99 0.004 ms, against the brief's 0.05 ms ceiling.
The real-runtime activation replay of the same bars took 68 ms wall with an
`onBar` p99 of 0.007 ms. After rolling 1,000 bars past the retention cap every
output line holds exactly 10,080 entries and no marker is older than the
oldest retained bar. State is at most 1,440 slot rings of `sessions`
observations, one ring of 20, and one tail record.

## Limitations

- Needs `minSessions` prior observations per slot: one-minute crypto retains
  seven UTC days, one-minute equities about 25 sessions; a fresh symbol shows
  "learning" for three sessions.
- Holidays and early closes are ordinary sessions; an early-close session's
  short last bar is one observation among `sessions` (section "Data").
- No duration normalisation (nominal `interval_ms`).
- Equity candles are regular session only, so no pre-market or after-hours
  slots exist.
- Weekend behaviour on crypto is not separated: a Saturday 14:00 bar is
  compared with weekday 14:00 bars. A weekend slot family is deferred.
- The ratio is unit-free; volume units are the provider's (Binance base
  asset, futures contracts, equity shares).
- Descriptive only: high relative volume says nothing about direction or
  follow-through, and nothing here is a prediction.
- The status row cannot be removed once written (section "Default view").
- No tooltip: an SDK indicator has no hover today, so everything a trader needs
  is in the table and on the reference lines.

## Tests

`apps/web/src/lib/indicators/relative-volume/tests/`:
`relativeVolumeMath.test.ts` (hand-computed three-session fixture, rings,
corrections, eviction rollback, clock, gap, early close, resampler, crypto
retention), `relativeVolume.test.ts` (identity, policy, schema, colours, table
copy, markers, replace semantics), `relativeVolumeValidation.test.ts` (the
protocol checks through the real runtime: truncation invariance, live versus
replay, duplicate, REBUILT, corrections, time gap, warm-up, empty input, no
NaN, the crypto rollover and REBUILT equivalence at lookback 3),
`relativeVolumeBaseline.test.ts` (the comparison table, the control
experiment, the marker budget) and `relativeVolumePerf.test.ts` (the pooled
probe, activation replay, rollover and forming-bar probes; `RVOL_PERF_OUT`
keeps the JSON).
