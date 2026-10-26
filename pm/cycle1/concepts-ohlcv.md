# OHLCV concepts, cycle 1

Author: OHLCV specialist. Candles and volume only. Concepts, no code.

Grounding: `CAPABILITIES.md` (2026-10-26), `indicatorTypes.ts`,
`indicatorRegistry.ts` (44 ids and their policies), `ta/index.ts`,
`barSides.ts`. Feasibility facts used below: `ta.atr`, `ta.keltner`, `ta.adx`,
`ta.ttmSqueeze` take `{high, low, close}`; `ta.donchian` takes `{high, low}`;
`ta.bollinger`, `ta.ema`, `ta.sma`, `ta.stdev`, `ta.highest/lowest`,
`ta.pivotHigh/Low`, `ta.prev` take a number. Every stream has
`push(value, replace)`.

Conventions shared by all five:

- **No future data.** A bar's output uses only that bar and earlier bars.
  Swing pivots are used only once confirmed `rightBars` later and are never
  back-filled as if known earlier. Nothing reads the wall clock, so replay and
  live agree for the same bar.
- **Forming bar.** `replace: true` revises in place: streams receive
  `replace`; the indicator's own buffers hold committed bars only and merge
  the forming bar tentatively (the `rsi.ts` pattern). Forming-bar markers are
  revised (the kernel drops and reinserts a bar's markers on replace) and are
  final only when `bar.closed`.
- **Warm-up** yields `null`, never `NaN` or 0, until every stream a value
  depends on has returned one. Volume math uses `bar.volume` only, so equity
  bars with 35 to 75 percent unsided volume work; any delta reading is
  optional, shown only when `barSides(bar).known`, and labelled with the
  unsided share.
- Own-pane "histograms" are a line plus `ctx.draw.fill(value, 0, ...)`.
  **Alerts** are markers plus a row in the indicator's `draw.table`.

---

## 1. Squeeze Breakout Context (the cross-layer breakout concept)

| | |
|---|---|
| Question | Is price compressed, which way does the surrounding trend lean, and did the break just happen with real range and volume, or did it fail? |
| User, decision | Intraday and swing breakout traders. Enter the break in its direction, fade it as a trap, or ignore it as counter-trend. |
| Inputs | `high/low/close/volume`, `closed`. `ta.ttmSqueeze(20,2,20,1.5)`, `ta.bollinger(20,2)` and `ta.keltner(20,20,1.5)` (depth = BB width / KC width), `ta.atr(20)`, `ta.sma(20)` on volume, `ta.ema(50)`, `ta.ema(200)`, `ta.prev(5)`, `ta.pivotHigh/Low(5,5)` (advanced lines). Optional `barSides` delta of the break bar. |
| Historical | `OHLCV_POLICY`; equities yes. |
| Effort | M |

**Calculation, per bar.**

1. Push `{high, low, close}` into ttmSqueeze, keltner, atr; `close` into
   bollinger, ema50, ema200; `volume` into the SMA, all with `replace`. Any
   `null` makes the bar `null` (warm-up 200 bars for the trend filter).
2. **Compression.** `squeezeOn` = BB inside KC (from ttmSqueeze);
   `depth = bbWidth / kcWidth` (`null` if KC width is 0).
3. **Box.** When `squeezeOn` turns true on a closed bar, open a box at that
   bar's high/low and extend it with each later closed bar while the squeeze
   lasts (committed values); the forming bar's high/low merge tentatively for
   drawing only. A squeeze shorter than `minSqueezeBars` (6) is discarded when
   it ends, so a flicker never makes a box.
4. **Trend bias.** `up` if close > ema200 and ema50 > ema50 five bars ago;
   `down` on the mirror; else `neutral`. The box border takes the bias colour
   and can change while the box develops.
5. **Break.** First closed bar after `minSqueezeBars` with `close > boxHigh`
   (or `< boxLow`) sets `breakDir`. Flags: `expansion = trueRange ≥ 1.5 × atr`,
   `volume = bar.volume ≥ 1.5 × smaVolume`. Grade: confirmed (both), partial
   (one), unconfirmed (none). The forming bar shows a tentative marker, revised
   on each replace, final at close. The box then freezes and is held `holdBars`
   (40) so the retest level stays visible.
6. **Failure.** A closed bar within `failBars` (5) closing back inside the box
   marks the break failed; the box switches to the trap style.
7. `readOutput` exposes `boxHigh`, `boxLow`, `depth`, `squeezeOn`, `bias`,
   `breakDir`, `breakGrade`. These are the seams for L1 (trade intensity and
   price response on the break bar) and L2 (displayed liquidity at the box
   edges as price approaches): a sibling reads the same bar and levels, or a
   merged tool adds its evidence to the grade. Any combined score needs its own
   explained calculation and validation, per the charter.

**Default view.** Overlay: a translucent box over the compression range,
border coloured by bias (green, red, grey). On the break bar an arrow, solid
when confirmed, hollow when partial, grey when against trend. Table:
`Squeeze ON 9 bars · depth 0.72 · bias UP`. Primary controls: squeeze length
(20), minimum squeeze bars (6), confirmation multiplier (1.5, for ATR and
volume). Advanced: BB/KC multipliers, trend EMA lengths, hold and fail bars,
swing pivot lines, break-bar delta, first-bar-of-session suppression, colours.

**Alerts.** Break up/down with trend (arrow), break against trend (grey arrow),
failed break (x via `plotchar`). The box itself announces the squeeze.
`minSqueezeBars` is the rate throttle.

**Baseline to beat.** TTM Squeeze dots and Bollinger Bands. They say
volatility is low; they do not show where the break level is, which side the
trend favours, whether the break bar expanded on volume, or that it failed two
bars later. The box plus grade shows all four.

**Defaults.** Crypto 5m as above. ES/NQ 2m to 5m: min bars 8, ATR mult 1.3.
Equities 5m: first-bar suppression on (a gap over the box is an open, not a
break); 1m: min bars 12.

**Failure modes.** Equity gaps (suppressed). Trending markets produce many
with-trend continuation boxes: correct but busy. A squeeze that starts after a
wide bar makes a tall, weaker box. Timeframe switches replay
(`maxReplayBars` 3,000).

**Overlap.** `bollinger` (bands only); `marketStructure` (BOS/CHoCH of swings
with a delta grade, no compression state, box, trend filter or failure check);
`classicOrderBlocks`/`l1OrderBlocks` (pivot zones); `fvgBoxes` (gaps). PM seeds
"TTM Squeeze" and "compression-then-breakout" are both covered here.

**Pitch.** The box shows where the coil is, the colour shows which way it
leans, the arrow says whether the break was real.

---

## 2. Time-of-Day Relative Volume (RVOL Clock)

| | |
|---|---|
| Question | Is this bar's volume unusual for this time of day, or is it the open, the close or the London overlap behaving normally? |
| User, decision | Any intraday trader confirming moves with volume. Trust the move or discount it as ordinary for the clock. Later, the volume input Concept 1 should use. |
| Inputs | `ts_open`, `interval_ms`, `volume`, `closed`, asset class for the clock. No `ta.*`; own bounded per-slot statistics. `ta.sma(20)` on volume for the comparison line. |
| Historical | `OHLCV_POLICY`; equities yes (390 one-minute regular-session slots). |
| Effort | M |

**Calculation, per bar.**

1. **Slot.** Equities and futures: New York minute-of-day (the `nyParts`
   approach in `killzones.ts`) divided by the bar length. Crypto: UTC
   minute-of-day with separate weekday and weekend families. Above 1h the slot
   is hour-of-day; daily and above are gated off (`timeframeGate`).
2. **Baseline.** Per slot, a ring of the last `K` (10) committed same-slot
   volumes and their median (one news day must not inflate tomorrow). Memory
   is at most 2 × 1,440 × 10 numbers.
3. **Output.** `rvol = volume / slotMedian`, `null` until the slot has
   `minDays` (3) observations and a median > 0. The forming bar is divided by
   the full-slot expectation, so it grows toward its final value with no clock
   reading. An advanced "pace" line divides by the elapsed fraction instead
   (from the 1m source bars), off by default as it is noisy early in the bar.
4. **Commit.** A bar enters its slot ring only when the next bar arrives
   without `replace`; a revision can never double-count.
5. Emit `rvolPlain = volume / sma(volume, 20)` for the comparison.

**Default view.** Own pane: one line filled to 1.0, green above, grey below,
lines at 1, 2, 3. Table: `RVOL 2.4× (time of day) · 1.1× (rolling)`. The pair
is the point. Primary controls: baseline days (10), minimum days (3), rolling
comparison (on). Advanced: weekend split, pace line, colour by delta,
thresholds, clock override.

**Alerts.** `rvol ≥ 2` (circle below bar), `≥ 3` (larger), three consecutive
bars above 1.5 (one marker at the third), and "quiet when it should be loud":
`rvol < 0.4` in the first 30 minutes of the equity session.

**Baseline to beat.** Volume / SMA(20). Rolling RVOL fires at every equity
open and every London/New York overlap because those minutes are always louder
than the hour before; the clock baseline is flat there and fires only when the
bar is unusual for its slot. The reverse matters as much: a lunch bar at 1.3×
rolling can be 2.5× for its slot.

**Defaults.** Equities 1m/5m: 10 days, NY clock. ES/NQ: 10 days, NY clock,
overnight slots kept (the median copes with thin ones). Crypto: 14 days, UTC,
weekend split on.

**Failure modes.** Needs `minDays` per slot: 1m crypto retains seven days
(10,080 bars), 1m equities about 25 sessions; a fresh symbol is honestly
`null` for three days. Holidays and early closes shift equity slot content
(calendar skip, advanced). DST moves the UTC clock against exchange time on
crypto. Rebalance and expiry closes dominate the last slot; the median
absorbs one in ten, not three.

**Overlap.** Nothing registered computes relative volume;
`swingAlphabetProfile` scales bubbles to a leg's own peak. This is the PM seed
"Relative Volume (time-of-day baseline)".

**Pitch.** Volume compared with the same minute on other days, so the open
stops looking like news every morning.

---

## 3. Daily Range Budget (ADR consumption)

| | |
|---|---|
| Question | How much of a normal day's range is already used, and where does today run out of room up and down? |
| User, decision | Intraday traders sizing targets. Chase a late breakout (budget spent) or hold for the remaining room (budget unused). |
| Inputs | `ts_open`, `high/low`, `closed`, session clock by asset class. `ta.sma(N)` fed once per completed day with that day's range. |
| Historical | `OHLCV_POLICY`; equities yes (the regular-session day is the archive's day). |
| Effort | S |

**Calculation, per bar.**

1. **Day key.** Equities: NY date of `ts_open` (bars exist only 09:30 to
   16:00). Crypto and futures: UTC day, the same fixed window Session VWAP
   uses, so the two line up. Advanced: 18:00 ET futures session.
2. **Extremes.** `committedHigh/Low` from closed bars of the day; the forming
   bar merges tentatively each replace. A new day key on a non-replace bar
   closes the previous day: its range enters `ta.sma(N)` (N = 10) and the
   extremes reset.
3. **ADR** = that SMA, `null` until N completed days; the table reads
   `ADR: 6 of 10 days` meanwhile. No partial estimate.
4. **Outputs.** `budgetHigh = dayLow + ADR`, `budgetLow = dayHigh − ADR`,
   `usedPct = (dayHigh − dayLow) / ADR`. When `usedPct > 1` the lines invert
   and draw dashed: the day is already above normal.
5. Advanced: `open ± ADR/2` lines.

**Default view.** Overlay: two thin stepping lines (teal, red) plus a table
`Range used 63% of ADR(10) · room ↑ 1.9 · ↓ 0.4`. Primary controls: ADR length
(10), session clock (auto / UTC / New York), table (on). Advanced: open ± ADR/2,
per-day used-percentage labels, colours.

**Alerts.** `usedPct` crosses 0.75 (square, "late day") and 1.0 (larger
square); first bar of a day after a day under 0.5 ("compressed day behind";
descriptive only, fixtures to be labelled by the validator).

**Baseline to beat.** Daily ATR(14) read off a daily chart. It gives the size
of a normal day; it does not place that size on the intraday chart relative to
today's low and high, does not develop through the day, and gives no used
percentage.

**Defaults.** Equities: N 10, NY. ES/NQ: N 10, UTC (advanced 18:00 ET).
Crypto 1m: N 5 (seven UTC days retained); 5m and above N 10.

**Failure modes.** Overnight equity gaps are not in the budget (correct for
intraday range, but say so). Early closes count as ordinary days. News days
blow through; the inverted dashed lines are the honest reading. A symbol
switch replays; `maxReplayBars` must hold N days.

**Overlap.** `sessionLevels`/`killzones` draw session highs, lows and opening
ranges; neither compares today with typical days or projects room.
`sessionVwap` shares only the day clock.

**Pitch.** Shows how much of a normal day is already spent, right where the
trader is about to chase.

---

## 4. Effort versus Result

| | |
|---|---|
| Question | Is volume producing movement? Which bars had heavy volume and went nowhere (absorption, churn), and which moved far on thin volume (air pocket)? |
| User, decision | Traders reading absorption and exhaustion without a book, equity traders above all (book tools are weak there and volume is largely unsided). Fade an all-effort move, or expect a fast retrace through an air pocket. |
| Inputs | `high/low/close/volume`. `ta.tr()`; `ta.sma(N)` and `ta.stdev(N)` on volume and on true range (N 50); `ta.ema(20)` and `ta.atr(20)` for the advanced extension gate. Optional `barSides` sign to colour churn bars. |
| Historical | `OHLCV_POLICY`; equities yes, the best fit of the five. |
| Effort | S |

**Calculation, per bar.**

1. `trueRange` from `ta.tr` with `replace`.
2. `zVol = (volume − smaVol) / stdevVol`, `zRange = (trueRange − smaTr) /
   stdevTr`, over N committed bars plus the forming bar tentatively; `null`
   until N bars or when a stdev is 0.
3. `effortMinusResult = zVol − zRange`: positive, more volume than movement;
   negative, more movement than volume.
4. Class per bar: `churn` if `zVol ≥ 2` and `zRange ≤ 0`; `air` if
   `zRange ≥ 2` and `zVol ≤ 0`; `climax` if both ≥ 2 (advanced: require close
   more than 2 ATR from ema20, "extended"). Recomputed on each replace; final
   at close.

**Default view.** Own pane: the line filled to zero, orange above, blue below,
lines at ±2. Price-pane markers: square (churn), hollow square (air),
`plotchar` diamond (climax). Table: last class and both z-scores. Primary
controls: lookback (50), threshold z (2), price markers (on). Advanced:
extension gate, colour by delta, separate lookbacks, first-bar suppression.

**Alerts.** Churn, air, climax; two churn bars within five bars on the same
side of a move ("absorption cluster", marker at the second). At z 2 the rate is
about one per sixty bars under normality, two to three per hundred with
fat-tailed volume; the validator measures it on fixtures.

**Baseline to beat.** Volume bars plus ATR. A trader sees "big volume" and
"small bar" separately; the joint anomaly standardised against recent
behaviour is the information, and one line makes it one glance.

**Defaults.** Equities 1m/5m: N 50, z 2. ES/NQ: N 50 (N 100 on 1m; ranges are
tick-quantised). Crypto: N 100 on 1m, 50 above.

**Failure modes.** Equity opens read climax daily (first-bar suppression;
later, Concept 2's clock baseline). Tiny futures bars satisfy `zRange ≤ 0`
easily, so the volume leg carries the test. Thin crypto pairs produce air
constantly, which is the honest reading. A flat tape gives `null`.

**Overlap.** `absorptionDetector`, `exhaustion`, `initiative` need the live
book or live runtime engines and are unavailable in Historical Mode and on
unsided equities; this is the candle-only, observation-based reading of the
same idea that works everywhere.

**Pitch.** One line that says whether the volume is going anywhere.

---

## 5. Trend Quality Gauge (signed efficiency)

| | |
|---|---|
| Question | Is the current trend clean enough to follow, or chop that will stop out trend entries? |
| User, decision | Trend followers and pullback buyers choosing trend tactics or range tactics. |
| Inputs | `close`. Own ring of N committed closes with a running path-length sum; `ta.ema(3)` smoothing; `ta.adx(14)` for the comparison line; `ta.atr(20)` for the advanced gate. |
| Historical | `OHLCV_POLICY`; equities yes. |
| Effort | S |

**Calculation, per bar.**

1. Keep N (20) committed closes and `path = Σ |close_i − close_{i−1}|` over
   the window.
2. Tentatively append the current close: `net = close − close_{t−N}`, `path`
   plus the newest move minus the one leaving the window.
3. `signedER = net / path` in [−1, 1]; `null` until N committed closes or when
   path is 0. Smooth with `ta.ema(3)`.
4. Regime: `≥ 0.3` trend up, `≤ −0.3` trend down, else chop (Kaufman's usual
   floor; the one number to tune).
5. Commit the close on the next non-replace bar; `close_{t−N}` is always a
   committed close older than the current bar.

**Default view.** Own pane −1 to 1: line filled to zero (green up, red down),
dashed ±0.3, faint ADX(14)/100 for comparison. Table: `Trend quality 0.58 UP ·
14 bars in regime`. Primary controls: length (20), threshold (0.3), ADX
comparison (on). Advanced: smoothing, minimum net move gate (0.5 ATR), marker
toggles.

**Alerts.** Enters trend zone (arrow), leaves into chop (circle), up-to-down
flip within five bars (x).

**Baseline to beat.** ADX(14): unsigned and doubly smoothed. Signed efficiency
gives direction and reacts within the window, and shows a trend losing quality
while ADX is still rising, because lengthening pullbacks lengthen the path.

**Defaults.** Equities 5m: N 20. ES/NQ 5m: N 30. Crypto 15m: N 20; 1m N 40.

**Failure modes.** One large bar jumps the ratio (EMA(3) softens). Drift with
tiny bars reads "clean" because net and path are both small (the ATR gate stops
it). Descriptive of the last N bars, not predictive; the package must say so.

**Overlap.** `ema`/`sma` give direction only; `rsi` is momentum. Nothing
registered measures path efficiency. PM seeds "Supertrend" and "MACD" are
direction tools, not quality.

**Pitch.** Tells you whether the trend is worth trading before you learn it the
expensive way.

---

## Summary

| # | Concept | Policy | Equities | Pane | Effort | Primary controls |
|---|---|---|---|---|---|---|
| 1 | Squeeze Breakout Context | OHLCV | yes | overlay + table | M | squeeze length, min squeeze bars, confirmation multiplier |
| 2 | Time-of-Day RVOL | OHLCV | yes | own | M | baseline days, min days, rolling comparison |
| 3 | Daily Range Budget | OHLCV | yes | overlay + table | S | ADR length, session clock, table |
| 4 | Effort versus Result | OHLCV | yes (best fit) | own + markers | S | lookback, threshold z, price markers |
| 5 | Trend Quality Gauge | OHLCV | yes | own | S | length, threshold, ADX comparison |

All five are `OHLCV_POLICY`: every archived instrument, identical values in
replay and live for the same bar, no sided volume required.

## Ranking and recommendation

1. **Squeeze Breakout Context**: highest usefulness, the cross-layer seat, and
   its `boxHigh`/`boxLow`/`breakGrade` outputs are exactly the seams L1 and L2
   need.
2. **Time-of-Day RVOL**: simplest to explain, sharpest baseline contrast, and
   its clock baseline later becomes Concept 1's volume confirmation.
3. **Daily Range Budget**: small, honest, the kind of tool traders leave on.
4. **Effort versus Result**: strongest on equities; needs fixture work on
   marker rates.
5. **Trend Quality Gauge**: solid but closest to commodity.

Recommendation: brief Concept 1 for the cycle-1 build, scoped to the box, the
trend bias, confirmed/partial/failed breaks and the three primary controls,
with the L1 and L2 seams named in the brief but not built. If a second small
build fits the budget, pair it with Concept 2, whose clock baseline stands alone
now and feeds Concept 1's volume confirmation later.
