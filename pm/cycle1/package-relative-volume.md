# Product package: Relative Volume (Time of Day)

Cycle 1, accepted 2026-10-26. Branch `build/relative-volume` merged to `main`
in https://github.com/chartprime/INDICATOR-CRON-JOB- . Registry id
`relativeVolume`, category technical, own pane.

## Name and purpose

**Relative Volume (Time of Day).** Answers one question: is this bar's volume
unusual compared with the same minute of the day on recent sessions, or is it
just the open, the close or the London/New York overlap being its normal self?
A plain rolling average fires every morning at the open and goes quiet at
lunch; this tool compares each minute with its own history, so it stays near
1.0 where the clock explains the volume and lights up only when the bar is
unusual for its minute, relative to the last N sessions.

## What the trader sees

One purple line in its own pane around 1.0, shaded above 1, with fixed
reference marks at 1, 2 and 3. Bars at or above the "Unusual above" threshold
turn blue and get a circle marker (larger at 3×). A small table top right:
`RVOL 2.4× · 7 prior`, `Rolling 1.1× · 20 bars`, and a status row only while
something is not ready (`Learning · 2 of 3 prior`, `Forming · vs full bar`,
`Needs 1m to 1h`, `No usable volume`, `No usable baseline`). Nothing is drawn
until the baseline exists; never a zero.

Screenshots: `pm/cycle1/screenshots/relative-volume/01` to `09` (ready at two
zooms, learning, forming, 4h unsupported, dark chrome, dialog Inputs, Advanced
open, Visibility).

## Controls and presets

Primary: Lookback (prior bars) 10, range 3..60; Unusual above (×) 2.0.
Advanced: Minimum prior bars 3; Clock Automatic / New York / UTC.
Visibility: Show rolling 20 (off), Show unusual markers (on).
Every setting is a preset input, so the Defaults menu saves named presets.

Recommended presets for the trader to save:

| Preset | Lookback | Unusual above | Notes |
|---|---|---|---|
| Equities 1m to 5m | 10 | 2.0 | New York clock automatic; ready after 3 sessions |
| ES / NQ intraday | 10 | 2.0 | New York clock; overnight minutes included |
| Crypto 1m | 6 | 2.0 | seven retained UTC days give at most six prior per minute after a reload |
| Crypto 5m and up | 10 | 2.0 | |
| Scalping sensitivity | 10 | 1.5 | more markers; check the rate before trusting it |

## Alert condition (rendered, no notification channel exists)

**Unusual volume**: `rvol >= Unusual above` on a closed bar. Marker: blue
circle above the bar, larger at `rvol >= 3`. Measured rate: 0.28 markers per
100 evaluated bars on the frozen 15-session fixture at default settings; on a
session-wide volume shift every bar is marked, which is correct for a
descriptive tool and has no cooldown.

## Evidence

- Baseline comparison on the frozen equity fixture (threshold 2.0, 12 planted
  anomalies, 4,668 non-anomaly bars, 240 opening and closing minutes):

| Method | Detections | Anomalies hit | False positives | Predictable-slot false positives |
|---|---|---|---|---|
| Time of day (slot median) | 13 | 12 of 12 | 1 (0.02%) | 0 of 240 |
| Same-slot mean | 12 | 12 of 12 | 0 | 0 of 240 |
| Rolling 20 | 32 | 12 of 12 | 20 (0.43%) | 19 of 240 (7.92%) |

  Flat-seasonality control: all three methods agree (13/12/1, 12/12/0,
  12/12/0) when the clock explains nothing.
- Validation protocol: all ten checks PASS (loop 2), including truncation
  invariance at 497 cuts, replay-versus-live equivalence with an independent
  batch reference equal on 17,850 fixture bars, no NaN anywhere, Historical
  Mode policy honest.
- Performance (this container, 4 cores, Node 24.21.0): replay p99 0.0037 ms
  per bar; forming bar with warmed slots and threshold crossings p99 0.032 ms;
  rollover 650 bytes per bar with 10,080 outputs retained and no stale markers.
- Gates: Codex plan review 5 rounds (PM-approved), Codex code review APPROVED
  on round 2, Codex challenge 7 items all answered with tests, UX pass
  approved, validation ACCEPT on loop 2. Reports under
  `pm/log/validation/relativeVolume/` and `pm/log/codex/`.

## Data requirements

Candles only (`volume`, `ts_open`, `interval_ms`, `closed`); provider identity
only to choose the clock. Works live and in Historical Mode on every archived
instrument, equities included (unsided volume is irrelevant). Intraday
timeframes up to one hour; daily and above show `Needs 1m to 1h`.

## Limitations (say these in marketing)

- Needs three prior sessions per minute before it draws; a fresh symbol shows
  Learning for three sessions.
- One-minute crypto: after a reload at most six prior observations per minute
  until the chart has run ten days; a rebuild, reconnect or a replaying setting
  change can move the latest ratio.
- Holidays and early closes are ordinary sessions; a shortened last bar is one
  observation the median limits but does not ignore.
- No duration normalisation (the resampler reports nominal bar length).
- Weekend behaviour on crypto is not separated in this version.
- Descriptive only: high relative volume says nothing about direction or
  follow-through. No predictive claim is made or supported.
- No hover tooltip; the current value is in the table.

## Safe claims

"Shows volume relative to the same minute of the day over the last N
sessions, live and in replay, with the same numbers in both." "On the
benchmark it flagged every planted anomaly with one false alarm, while a
rolling average produced twenty, nineteen of them at the open and close."
Not allowed: "filters false breakouts", "predicts", any edge claim.

## Short demo

Checkout `main`, run the runtime and the web app (README quick start), select
BTC spot, open Indicators and add Relative Volume (Time of Day). Within a few
seconds the warm-up history fills the baseline; switch to 5m and watch the
open-of-day bars stay near 1.0 while a rolling RVOL (enable Show rolling 20)
spikes there. Open the dialog: two controls, Advanced collapsed.

## Deferred to the backlog

Weekend slot family for crypto; a sustained-run marker; a `clear` method on
`draw.table` so a status row can vanish instead of blanking; a Pine version
for the Indicator editor once its source is available.
