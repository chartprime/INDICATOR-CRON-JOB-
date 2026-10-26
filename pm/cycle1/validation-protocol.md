# Validation protocol (cycle 1)

Owner: validation and performance specialist. Applies to every indicator that
reaches step 6 of the pipeline in `PM/CHARTER.md`. The harness that runs these
checks lives on the repository at `apps/web/src/lib/chart/validation/`
(import from `./validation/index.ts`); each utility has its own proving test in
`apps/web/src/lib/chart/validation/tests/`. A check is not passed because the
specialist says so; it is passed because a vitest file in the indicator's
`tests/` folder (or a validation spec next to it) runs the check and the
evidence file named in the report records the result.

Vocabulary: **replay** is the runtime's `onSnapshot`/activation pass over the
retained bars (`replaying: true`, no `trades`, `HISTORICAL_UNAVAILABLE`);
**live** is bars arriving one at a time through `onBar` as `APPENDED`, then
`REPLACED_EDGE` for every forming revision, then `REPLACED_EDGE` once more when
the bar closes. The harness classifies arrivals with the chart's own
`mergeChartBar`, so a duplicated closed bar is a `REPLACED_EDGE` and a late bar
is a `REBUILT`, exactly as `ChartPanel` would dispatch them.

## How to run the harness

```bash
export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH
cd apps/web
npx vitest run src/lib/chart/validation          # the harness proves itself (84 tests)
npx vitest run src/lib/indicators/<folder>       # the indicator's own checks
VALIDATION_BASELINES=1 NODE_OPTIONS=--expose-gc npx vitest run src/lib/chart/validation/tests/baselines.test.ts
```

Heap numbers are meaningful only under `NODE_OPTIONS=--expose-gc` (vitest's
workers inherit it); every probe result carries `heap.gcExposed` so the evidence
says which kind it is.

| Utility | File | Purpose |
|---|---|---|
| `trendBars`, `rangeBars`, `compressionBreakoutBars`, `volumeSpikeBars`, `timeGapBars`, `equityUnsidedBars` | `fixtures.ts` | labelled synthetic regimes, deterministic by seed |
| `relativeVolumeEquityFixture`, `relativeVolumeCryptoFixture`, `mulberry32`, `standardNormals` | `fixtures.ts` | the frozen Relative Volume fixtures of `PM/cycle1/brief-rvol-clock.md` (15-session equity U-curve with 12 labelled anomalies and predictable slots; 12,000-bar crypto cosine day), shared by the builder and the validation loop |
| `formingRevisions`, `liveArrivals`, `duplicateClosedArrivals`, `rebuiltArrivals`, `sampledIndices` | `fixtures.ts` | arrival scripts for the live driver |
| `openLiveSession`, `driveLive`, `replayCapture`, `diffOutputs`, `diffMarkers` | `liveDrive.ts` | the real `indicatorRuntime` driven the way the chart drives it, with the rollover |
| `checkTruncationInvariance` | `truncation.ts` | check 1 |
| `checkLiveReplayEquivalence`, `checkDuplicateClosedIdempotent`, `checkRebuiltEquivalence`, `checkArrivalsAgainstReplay` | `liveEquivalence.ts` | checks 2 and 3 |
| `countMarkers`, `countMarkersOver`, `markerBudgetOf`, `judgeBudget`, `captureMarkers` | `markerBudget.ts` | check 5 |
| `whaleVersusCrowd`, `busyTapeFor`, `tapeOf`, `historyTapeOf`, `ticksOf`, `candleOf` | `syntheticTape.ts` | real `AggressiveTape`s for L1 checks and the whale-versus-crowd baseline |
| `fakeL2`, `fakeL2Unsynced`, `segmentOf`, `ladderOf`, `ladderWithWall`, `wallOf`, `wallLifecycle`, `absorbingAt`, `tradeEvent` | `fakeL2.ts` | a scripted `IndicatorL2` whose trust, segment and event-slice semantics mirror `indicatorL2Of`, `L2Store.trusted` and `EventRing.since`; `atTime` cuts the ladder, walls and events at a bar close. A wall under a cut is served from a timestamped snapshot or rebuilt from its `wall_born`/`wall_trade` events, with `absorbing` by the runtime's rule (traded into within 5 s, holding half its peak); a wall with neither is omitted, never served at its final size |
| `probeReplay`, `probeFormingBar`, `probeRollover`, `probeReplayPooled` | `perfProbe.ts` | check 6; `probeReplayPooled` is the brief's frozen method (warm-ups, pooled timed runs, `onBar` plus `readOutput` only) |

## The checks

Each check states the method, the pass criterion and how the evidence is
recorded. "Evidence file" means a vitest file committed on the indicator's
branch whose test names match the check, plus any JSON or log the test writes
(kept under `PM/log/validation/<indicator>/`).

### 1. No future data

Method. `checkTruncationInvariance(def, bars, settings)` replays the fixture
once in full, then once truncated at every index (`sampledIndices` for series
longer than 1,000 bars: every 25th index plus the last 50), and compares the
committed outputs of every line and every marker at or before the cut. Run it
on at least `compressionBreakoutBars()` and `trendBars()`; tick and book
indicators also run it with the fixture's `extras` (`ticks` from `tapeOf`, `l2`
from `fakeL2` with `atTime` cutting walls and events at the bar close).

Pass. `report.ok === true`: zero output disagreements at tolerance 0 (a
documented floating-point tolerance is acceptable only for a value computed in
a different order live versus replay, never for a different value), zero marker
disagreements, no fault. An indicator that reads `barIndex`/`barCount` to place
anything is suspect by default and must show this check passing.

Evidence. Test named `no future data: truncation invariance` in the
indicator's tests; `summarizeTruncation(report)` written to the log on failure.

### 2. Replay versus live equivalence

Method. `checkLiveReplayEquivalence(def, bars, settings, { revisionsPerBar: 5 })`
feeds every bar as five forming revisions (`closed: false`, path open through
the wicks to the close, volume growing with buy, sell and unknown volume scaled
independently through `barSides`, so an equity bar's unsided share stays
unsided) followed by the closed bar,
through the real runtime, and compares the committed outputs and markers with a
clean replay of the same bars. For a tick or book indicator supply `tradesFor`
and `extras` so the live side sees what the terminal would give it.

Pass. Either `report.equal === true`, or the indicator's doc page states the
exact difference and the test pins it: for a tick-only indicator the expected
and accepted difference is `outputsEqual === true`, replay markers `[]`, live
markers present (`largeTradeBubbles` is the reference: see
`validation/tests/liveEquivalence.test.ts`). Any output difference on a
candle-only indicator fails; it means forming revisions were committed (the
harness catches this with a running sum that ignores `replace`).

Evidence. Test named `replay versus live equivalence`; the documented
difference quoted in the indicator's doc page under "Replay and Historical
Mode".

### 3. Gap, duplicate and late-event behavior

Method, five parts, all through the live driver so the runtime's own
classification is what the indicator sees:

- Duplicate closed dispatch: `checkDuplicateClosedIdempotent(def, bars, settings, index)`.
  The duplicate must be classified `REPLACED_EDGE` and the result must equal a
  feed in which the bar arrived once.
- `REBUILT`: `checkRebuiltEquivalence(def, bars, settings, lateIndex)`. A bar
  arriving two bars late must leave the indicator equal to a clean replay
  (`sawRebuilt === true`). Module-level state (a cache keyed by instrument, a
  slot pool) is where this fails; the runtime replays, the module does not.
- Reconnect that clears the tick store: an arrival script whose `act` hook
  resets the `AggressiveTape` and hands a new `IndicatorTicks` to the session
  (`session.setTicks`). Every bar whose window the store no longer covers must
  read `null`, never a stale value (reference: `tickVolume` in the same test file).
- Out-of-order prints: `tapeOf` with prints in shuffled order must give the
  same per-window sums as in-order arrival (`syntheticTape.test.ts`); an
  indicator that keeps its own print buffer must show the same.
- Time gap: run the indicator on `timeGapBars()`; the output at
  `labels.firstBarAfterGapIndex` must follow the indicator's documented gap rule
  (restart, carry, or null), and nothing before the gap may change.
- Book indicators: run the same checks with `extras.l2` from `fakeL2`. Its
  `trusted(ts)` is false before the segment start, on a GAP or null segment and
  when `l2_walls` or `l2_events` is unsynced; `events(cursor)` is `complete`
  only for an exact cursor on a synced ring past any reported loss, exactly as
  `EventRing.since`; so an indicator's missing-event and untrusted gates can be
  exercised with `patch({ synced: { l2_events: false } })`, `missedEvents`, a
  cursor before `eventResetSeq`, or `segment: segmentOf(start)`.

Pass. All five hold; no fault; no `NaN`.

Evidence. Tests named `duplicate closed bar is idempotent`, `late bar rebuilds
to the replay`, `reconnect clears the store honestly`, `out-of-order prints`,
`time gap`.

### 4. Warm-up

Method. Replay a fixture shorter than the warm-up length and one exactly at
it; read every line of `replayCapture(...).outputs`.

Pass. Every value before the documented warm-up length is `null`; the first
non-null value appears exactly at the documented index; no value anywhere is
`NaN`, `Infinity`, or a fabricated `0` standing in for "not yet" (a genuine
zero from complete data is fine, and the test must say which it is). The
warm-up length (bars, and for tick indicators the coverage condition) is stated
in the doc page and in a `staticHint` of the settings schema.

Evidence. Test named `warm-up is null, never NaN or zero`; the doc sentence.

### 5. Marker and alert budget

Method. `countMarkers(def, bars, settings, { live })` on a busy synthetic
instrument: `trendBars({ count: 1000 })` or the breakout fixture with
`busyTapeFor(bars, { printsPerBar: 60 })` supplying trades live (whales at 0.2
percent of prints, 100 times the small size). In cycle 1 an alert is a marker
(`PM/CHARTER.md`), so this is also the alert budget. Record `per1000Bars`,
`maxPerBar`, `barsWithMarkers` and the breakdown by shape and color.

The budget carries `faulted`; a run in which the runtime latched the indicator
counts nothing and `judgeBudget` fails it whatever the rate.

Pass. Ceilings, unless the build brief sets a different one with a reason:
at most **40 markers per 1,000 bars** for a signal-type tool (a trader can act
on roughly one mark an hour on 1-minute bars), at most **200 per 1,000** for a
descriptive annotation tool (levels, labels), and at most **3 markers on one
bar**. A duplicated closed bar must not add markers (`countMarkersOver` with
`duplicateClosedArrivals`). The judged verdict is `judgeBudget(budget, ceiling,
maxPerBar).ok`.

Evidence. Test named `marker budget`; `summarizeBudget(...)` line in the log.

### 6. Performance

Method. The three probes in `perfProbe.ts`, run with `NODE_OPTIONS=--expose-gc`:

- `probeReplay(def, bars10080, settings)`: activation over 10,080 one-minute
  bars (the chart's retention cap); per-`onBar` p50 and p99, wall time of the
  whole replay, heap delta.
- `probeFormingBar(def, warmup, settings, { seconds: 60, revisionsPerSecond: 50, printsPerMinute: 1000 })`:
  one bar revised 3,000 times with 1,000 prints landing in a real tape
  (`ctx.ticks`) and in `ctx.trades` (`LIVE_COMPLETE`); per-revision p50 and p99.
- `probeRollover(def, bars10080, settings, { extraBars: 1000 })`: the chart at
  the cap, then 1,000 more bars so the front rolls off and `discardLeading`
  runs; retained output lengths, markers older than the oldest retained bar,
  heap growth per extra bar. The appended bars are built by `rolloverBar`,
  which writes sides through `barSides` (sided, buy-only and unsided bars each
  stay what they were).
- `probeReplayPooled(def, bars, settings, { warmupRuns: 3, timedRuns: 5 })`:
  the method frozen in the Relative Volume brief (amendment 9): three untimed
  warm-up replays, five timed replays, per-bar samples pooled, p99 by nearest
  rank, timed region `onBar` plus `readOutput` with no-op draw and marker
  namespaces, no runtime bookkeeping. Its `extras` go through the same
  knowledge-time cutoffs as `indicatorRuntime.makeCtx`: `liquidity.atTime(barClose)`
  with a null answer meaning unavailable, and `l2.atTime(barClose)` with a
  fallback to the uncut view. When a brief states a per-bar p99
  criterion (Relative Volume: under 0.05 ms over the first 10,080 bars of the
  crypto fixture) this is the probe that judges it; `probeReplay` remains the
  measurement of a real activation and keeps the reference rows below.

Pass. Replay p99 ≤ 0.5 ms and total replay wall ≤ 2 s for a candle indicator
(≤ 5 s for a book or tick indicator that reads the store per bar); forming
revision p99 ≤ 1 ms (an indicator revised 50 times a second gets at most 50 ms
of the main thread per second); after the rollover every output line has
exactly 10,080 entries, `markersBeforeRetention === 0`, and heap growth is
flat: `bytesPerExtraBar` within 3× the harness floor measured below (about
370 B per bar, which is the runtime's own output arrays and the bar frames
themselves). A probe that reports `faulted` fails regardless of timing.

Evidence. JSON written by the indicator's baseline test
(`VALIDATION_BASELINES_OUT`), kept under `PM/log/validation/<indicator>/perf.json`,
and the three formatted lines in the report.

Reference points measured on this container (4 cores, Intel Xeon 2.10 GHz,
Node 24.21.0, gc exposed, `trendBars({ count: 10080, driftPerBar: 0.5, noise: 25 })`,
2026-10-26, raw JSON kept at `PM/log/validation/baselines-2026-10-26.json`):

| Indicator | Replay 10,080 bars: onBar p50 / p99 / max (ms), wall (ms), heap Δ | Forming bar, 3,000 revisions, 1,000 prints: p50 / p99 / max (ms), wall (ms) | Rollover +1,000: outputs retained, p50 / p99 (ms), heap B per bar |
|---|---|---|---|
| rsi | 0.0003 / 0.0024 / 0.097, 20, 0.74 MB | 0.0002 / 0.0024 / 0.649, 29 | value 10,080; 0.0005 / 0.0046; 377 |
| bollinger | 0.0008 / 0.0043 / 0.192, 32, 1.55 MB | 0.0006 / 0.0018 / 0.058, 24 | basis, upper, lower 10,080 each; 0.0009 / 0.0050; 385 |
| cvdDivergence (registry def only, see note) | 0.0002 / 0.0004 / 0.051, 14, 0.14 MB | 0.0002 / 0.0003 / 0.028, 18 | no lines; 0.0002 / 0.0005; 361 |
| l2FeedStatus (scripted book: 1,000-level ladder, 20 walls, 2,100 events) | 0.0001 / 0.0004 / 0.146, 35, 0.18 MB | 0.0543 / 0.1702 / 1.911, 229 | no lines; 0.0884 / 0.1910; 370 |

Pooled method on the Relative Volume crypto fixture (bars 1..10,080, three
warm-ups, five timed runs, `onBar` plus `readOutput`), the floor for the
brief's criterion 4: 

| Indicator | Pooled onBar+readOutput p50 / p90 / p99 / max (ms) | Per-run p99 (ms) | Per-run wall (ms) |
|---|---|---|---|
| rsi | 0.0002 / 0.0003 / 0.0009 / 0.264 | 0.0023, 0.0007, 0.0005, 0.0005, 0.0004 | 11, 6, 6, 5, 5 |
| bollinger | 0.0003 / 0.0006 / 0.0009 / 0.271 | 0.0011, 0.0009, 0.0009, 0.0009, 0.0009 | 10, 6, 6, 6, 6 |

Raw JSON: `PM/log/validation/baselines-pooled-2026-10-26.json`. The first timed
run is still warmer-than-cold but slower than the rest (JIT settling), which is
why the brief pools five runs; a single-run p99 would be luck.

Notes on the reference points. The `cvdDivergence` registry def has an empty
`onBar` (its computation is hand-wired in `ChartPanel.tsx` through
`cvdDivergenceRenderer.ts` and `cvdDivergence.ts`), so its row is the harness
floor: what the timing wrapper and the runtime cost with no indicator work at
all. A real measurement of CVD Divergence needs the batch functions
(`rollingDeltaSeries`, `detectCvdDivergences`) timed directly, which the
indicator SDK probe cannot see. `l2FeedStatus` writes about ten table cells per
revision and reads the whole ladder and event list each time, which is why its
forming-bar cost is 200 times the floor while still inside the 1 ms ceiling.
The rollover heap slope of 361 to 385 B per bar is the same for all four, so it
is the runtime and the bar frames, not the indicators; an indicator's own
retained state shows as a slope above that (the harness proves this with a
`hoarder` def in `perfProbe.test.ts`).

### 7. Baseline comparison

For the cycle-1 indicator the brief freezes the fixtures and the acceptance
numbers: `relativeVolumeEquityFixture()` (labels `anomalyIndices`,
`predictableSlotIndices`, `evaluationIndices`, `sessionStarts`) and its
`{ flatSeasonality: true }` control, judged by the recall and false-positive
bounds in `PM/cycle1/brief-rvol-clock.md`; the fixture's own proving test is
`validation/tests/relativeVolumeFixtures.test.ts`. The general rule follows.

Method. The build brief names the simpler baseline (a rolling average, plain
RVOL, a raw imbalance line, a candle-only version of the same idea). The
specialist implements the baseline as a `RuntimeIndicatorDef` in the
indicator's `tests/` (or Codex does, gate G4) and runs both on labelled
fixtures:

- Descriptive tools are judged on **detection accuracy on labelled fixtures**:
  for `compressionBreakoutBars` the detection index versus
  `labels.breakoutIndex` (hit if within the documented tolerance, early if
  before, late if after, plus false positives inside `compressionStart..breakoutIndex`);
  for `volumeSpikeBars` the same against `labels.spikeIndex`; for
  `rangeBars` and `trendBars` the false-positive count. Run each fixture over at
  least 10 seeds and report hits, early, late and false positives for the tool
  and the baseline side by side.
- L1 tools must pass the **whale-versus-crowd** fixture: `whaleVersusCrowd()`
  builds two tapes making the identical candle (print count withheld); the tool
  must respond differently to the two tapes while the candle-only baseline, by
  construction, cannot. `largeTradeBubbles` is the reference (one bubble on the
  whale tape, none on the crowd tape, `syntheticTape.test.ts`).
- L2 tools state what is **observed** (ladder, walls, events as served) versus
  **inferred**, and the baseline comparison is run on the same `fakeL2` script so
  the book is the same for both.

Pass. The report states, in one sentence, what the tool shows that the baseline
hides, and the table shows it: strictly fewer false positives at equal or
better hits, or hits the baseline cannot produce (whale versus crowd). A tool
that only matches the baseline is returned to the backlog.

Evidence. Test named `beats the baseline on labelled fixtures`; the
side-by-side table in the report.

### 8. Predictive claims

Method. Any claim of the form "after X, price tends to Y" is predictive. The
specialist freezes the rule (parameters included) on a development period,
then measures it on an **unseen period** chosen after the rule was frozen:
a different seed range of the synthetic fixtures (declared in the test before
the development runs are made), and, where this container can reach it, a live
Binance stretch recorded after the rule was written. Forward observation only:
the outcome window starts at the signal bar's close and uses no bar before it.

Overfitting rule. Choosing the best of several parameter sets, thresholds or
variants by their result on the development period and reporting that result
is rejected. At most **one** rule is carried to the unseen period; if it fails
there the claim is dropped, not re-tuned. Every variant tried is listed in the
report with its development result so the selection is visible.

Pass. The unseen-period result is reported with its sample size and with the
same statistic on the baseline; a claim with fewer than 30 signals in the
unseen period is reported as "insufficient evidence", not as a pass. Marketing
copy may state only what the unseen period supports.

Evidence. `PM/EXPERIMENTS.md` entry with the frozen rule, the declared unseen
period, every variant, and the two results.

### 9. Equity unsided volume

Method. Run the indicator on `equityUnsidedBars()` (dxFeed equity identity;
every third bar carries no side, the others carry both sides and a 40 percent
unsided remainder) and read every output that depends on sides.

Pass. On `labels.unsidedIndices` every side-dependent output is `null`
(`barSides(bar).known === false` draws nothing, never zero). On
`labels.partiallySidedIndices` the delta equals `buy - sell` from `barSides`
and the unsided remainder is **not** counted as selling; where the tool shows a
delta on equities it shows `unsidedShare` beside it or in the doc. The code
reads sides only through `barSides`: `grep -n "volume - " <folder>` and
`grep -n "buy_volume" <folder>` outside `barSides` calls must be empty. No gate
on `provider === "..."` except to label units.

Evidence. Test named `equity unsided volume is honest`.

### 10. Historical Mode policy honesty

Method. Read the indicator's `HISTORICAL_INDICATOR_POLICIES` entry and the data
it actually reads in `onBar`:

| Reads | Required policy |
|---|---|
| candles only (`bar` OHLCV) | `OHLCV_POLICY` |
| `barSides` / `buy_volume` | `CANDLE_FLOW_POLICY` |
| `ctx.ticks`, `ctx.trades` | `unavailableReason` (or `l2_prints` only if the doc proves the verified hours suffice) |
| `ctx.l2`, `ctx.liquidity`, `bandHistory` | `l2_states` / `l2_walls` capabilities or `unavailableReason` |
| host studies | `TRADE_FAMILY_POLICY` |

Then replay the indicator with `replayCapture` and no extras (what a candle
archive gives): a tick or book indicator must produce `null` outputs and no
markers (`largeTradeBubbles` and the `tickVolume` reference pass this); a
candle-flow indicator on bars without `buy_volume` must produce `null`.

Pass. The policy row matches the table; the replay-without-extras result is
honest nulls; the doc page's "Historical Mode" paragraph says the same thing as
the policy; `historicalIndicatorAvailability(id, capabilities)` for the
instrument's real capability set agrees with the doc's claim of where the tool
works. A policy that promises Historical Mode for data the archive does not
contain fails the indicator outright.

Evidence. Test named `Historical Mode policy is honest` (asserting the policy
entry and the null replay).

## Report template

One report per validation loop, at `PM/log/validation/<indicator>/loop-<n>.md`.
Codex's G3 challenge list is answered item by item in the same file.

```markdown
# Validation report: <indicator id> loop <n>

Branch: <branch>   Commit: <sha>   Validator: <name>   Date: <date>
Commands run: <each command with pass/fail counts>

| # | Check | Result | Evidence file (test name) | Measured | Required fix |
|---|---|---|---|---|---|
| 1 | No future data | PASS / FAIL | <tests/...test.ts> (<test name>) | cuts checked, violations | |
| 2 | Replay vs live | PASS / PASS WITH DOCUMENTED DIFFERENCE / FAIL | | output diffs, marker diffs | |
| 3 | Gap, duplicate, late | PASS / FAIL | | per part | |
| 4 | Warm-up | PASS / FAIL | | warm-up length | |
| 5 | Marker budget | PASS / FAIL | | per 1,000 bars, max per bar, ceiling | |
| 6 | Performance | PASS / FAIL | perf.json | replay p50/p99, forming p50/p99, rollover B/bar | |
| 7 | Baseline comparison | PASS / FAIL | | hits/early/late/false positives, tool vs baseline | |
| 8 | Predictive claims | PASS / INSUFFICIENT EVIDENCE / N/A / FAIL | EXPERIMENTS.md entry | unseen-period statistic, n | |
| 9 | Equity unsided | PASS / FAIL / N/A | | | |
| 10 | Historical policy | PASS / FAIL | | policy row, null replay | |

Codex G3 challenge items: <item> -> <answer with evidence>

Verdict: ACCEPT / FIX AND RERUN (list) / RETURN TO BACKLOG (reason)
Not verified: <anything the container could not reach, e.g. live rendering, real dxFeed data>
```

A check marked FAIL always carries a required fix that names the file and the
behavior, never "investigate". Two loops are the budget; a third failure
returns the concept to the backlog with this report attached.
