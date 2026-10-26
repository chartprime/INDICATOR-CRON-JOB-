# Validation report: relativeVolume loop 2

Branch: `build/relative-volume` at `e4b9a47` (fix round 1; it merged `validate/relative-volume` `0052eff`, so the validator's loop-1 tests run inside it). `validate/relative-volume` was fast-forwarded to `e4b9a47` in the validator's worktree (`/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/.claude/worktrees/agent-a4b44f3b34041fdf7`); no new validator commits were needed in this loop.
Validator: validation and performance specialist   Date: 2026-10-26
Spec: `PM/cycle1/brief-rvol-clock.md` with the ten amendments and the PM's rulings on Codex G3 round 1.

Commands run (from `apps/web`, Node 24.21.0):

| Command | Result |
|---|---|
| `npx vitest run` on the builder's four non-perf files plus `tests/validation` | 8 files, **96 tests passed, 0 failed** (60 builder tests from loop 1, 4 new builder tests, 32 validator tests; the four loop-1 settling tests now pass) |
| `RVOL_PERF_OUT=… NODE_OPTIONS=--expose-gc npx vitest run …/relativeVolumePerf.test.ts` | 1 passed; JSON at `PM/log/validation/relativeVolume/perf-validator-loop2.json` |
| `npx tsc -b` | exit 0 |
| `npx oxlint` | only the two pre-existing require-yield warnings |
| `node scripts/validate-docs.cjs` (repo root) | passed (97 Markdown files) |
| `npx vitest run` (whole web suite) | 370 files: 368 passed, 2 skipped, **0 failed**; 5,360 tests: 5,353 passed, 7 skipped, 0 failed (114.8 s) |

## Loop-1 required fixes

| Id | Verified | Evidence |
|---|---|---|
| F1 rule 7(b) withdrawn | **Done** | `relativeVolumeMath.ts` `onBar` supersedes an uncommitted tail without `commit`; doc comment and doc page "Commit" paragraph say only a closed bar is filed. Settling tests `rules.test.ts` "rule 7(b) withdrawn…" (engine) and "…through the runtime…" (resampled half-hour bucket, next normal hour learning `null`) pass; the builder flipped `relativeVolumeMath.test.ts` ("a bar superseded without ever closing contributes no observation…") and `relativeVolumeValidation.test.ts` (every closed bar equals a replay in which the never-closed bars do not exist; nothing of them in either ring) |
| F2 `sessions` 3..60 | **Done** | `RVOL_MIN_SESSIONS_SETTING = 3`, new `ringCapacityOf` clamps 3..60 and feeds `requiredPriorOf`; schema `min: 3`; presets fixture `indicatorPresetInputs.json` updated; doc "3..60" with the even-count-median reason. Settling test "sessions has a minimum of 3…" passes |
| F3 cosmetic never changes a number | **Done** | The three colour pickers and their settings keys are gone; colours are constants; both lines carry an identity `recolor`, so a settings update that changes no recompute key takes the RECOLORED path and never replays. Settling test "a cosmetic setting never changes a number…" passes (schema-driven, no cosmetic field remains); the builder's rewrite of my Codex item 1 test and their new "rollover and reconnect (ruling 2)" test both show 2.25× and the marker surviving `updateSettings` |
| F4 doc | **Done** | "Ten fits" removed; "at most six prior observations per minute after a reload until the chart has run for ten days"; both marker budgets quoted (0.28 per 100 on the fixture, 1,000 per 1,000 eligible on a session-wide shift, with the no-cooldown sentence); withdrawn rule 7(b) described; range 3..60; "median limits one day's influence" |
| F5 forming probe | **Done** | `relativeVolumePerf.test.ts` warms every slot on all 10,080 crypto bars, then revises the next bar 500 times alternating 2.5× and 1.5× of its slot median (250 hot), reports p99 beside the replay p99 and writes it to `perf.json`. Rerun by me: forming p99 0.0322 ms beside pooled replay p99 0.0037 ms |
| F6 baseline test | **Done** | Published counts pinned for all three methods on the fixture (13/12/1 with 0 of 240; 12/12/0; 32/12/20 with 19 of 240) and the control (13/12/1, 12/12/0, 12/12/0); `nonAnomalyBars`/`falsePositiveRate` divide by eligible non-anomaly bars (4,668) and `formatComparison` prints that; hand-computed missed-anomaly case (4/97, not 4/98); every budget test asserts non-zero eligible outputs (the unwarmed `trendBars` test replaced by a four-day quiet series with 1,440 eligible bars); ruling-2 rollover/reconnect test added |
| F7 learning screenshot | **Done** | `PM/cycle1/screenshots/relative-volume/03-relative-volume-learning.png`: the pane under the price chart is empty and the table reads `RVOL — · 2 prior`, `Rolling 1.0× · 20 bars`, `Learning · 2 of 3 prior`, the amendment-10 learning state |

Faithfulness of the builder's edits to the validator's tests (`tests/validation/codexChallenges.test.ts`, the only validator file touched): item 1 now asserts that an update carrying a stale colour key leaves the latest ratio at 2.25× with every output and marker unchanged; item 3 now asserts the truncated bucket files nothing (`[60]`), `priorCount 1`, `rvol null`, status `learning`. Both are exactly the amended behaviour the rulings state (ruling 1 and ruling 3) and keep the original scenarios; the describe titles record that the defects were reproduced on `ce8d11c`. No other validator test was changed (diff checked).

## Results

| # | Check | Result | Evidence file (test name) | Measured | Required fix |
|---|---|---|---|---|---|
| 1 | No future data | PASS | `tests/validation/reference.test.ts` ("truncation at every 13th index plus the last 50…"); builder's sampled sweep and full sweeps of the breakout and trend fixtures | 497 cuts over 5,850 bars, 0 output and 0 marker disagreements | |
| 2 | Replay vs live | PASS WITH DOCUMENTED DIFFERENCE | `reference.test.ts` (batch reference equals the engine exactly on 5,850 equity and 12,000 crypto bars); builder's live-with-revisions, never-closed-bar and crypto REBUILT tests (5,760 bars compared) | Live state past the 10,080-bar retention is the one documented difference (2.25× live vs 1.5× after a reload or REBUILT, pinned by the builder's ruling-2 test and my Codex item 2 test); the doc now states it with the six-prior figure | |
| 3 | Gap, duplicate, late | PASS | `rules.test.ts` (older-than-tail ignored, corrections ×2, both amended 7(b) tests); builder's duplicate, REBUILT, older-correction, time-gap, never-closed tests | Duplicate closed = REPLACED_EDGE and idempotent; late bar REBUILT equals clean replay; a superseded unclosed bar files nothing and stays provisional; a gap-truncated resampled bucket no longer enters the baseline | |
| 4 | Warm-up | PASS | builder's warm-up test; `reference.test.ts` ("no NaN anywhere…") | Null until 3 prior per slot; first ratio at 3 prior; no NaN or Infinity in outputs, fill points, marker colours or table text | |
| 5 | Marker budget | PASS (descriptive annotation, ruling 4) | `baselineRecount.test.ts`; `codexChallenges.test.ts` item 4; builder's budget tests now with non-zero eligible outputs | Frozen fixture 13 over 4,680 evaluated = 0.28 per 100 (criterion 5: under 2), 2.2 per 1,000, max 1 per bar; session-wide shift 1,000 per 1,000 eligible; one-hour 3× burst marks exactly 60 bars; both quoted in the doc | |
| 6 | Performance | PASS | builder's `relativeVolumePerf.test.ts` rerun by me (`perf-validator-loop2.json`) | Pooled p50 0.001 / **p99 0.0037 ms** (run p99s 0.0040, 0.0037, 0.0037, 0.0034, 0.0036), ceiling 0.05; activation replay p99 0.005 ms, wall 43 ms, heap 2.6 MB; forming bar with warmed slots and 500 threshold crossings **p99 0.0322 ms**, max 0.176 ms; rollover +1,000: outputs 10,080 each, 0 stale markers, 650 B/bar (floor ≈370, ceiling 1,110) | |
| 7 | Baseline comparison | PASS | `baselineRecount.test.ts` (independent recount pins the table and the control); builder's pinned counts, FP denominator and missed-anomaly case | Time of day 13 detections, 12/12 hits, 1 FP in 4,668 non-anomaly bars (0.02%), 0 of 240 predictable-slot bars; same-slot mean 12/12/0; rolling 32/12/20 (0.43%), 19 of 240 predictable (7.92%). Bounds: recall 12/12 ≥ 11 and ≥ rolling − 1; predictable FP 0% ≤ 10% and ≤ 3.96% | |
| 8 | Predictive claims | N/A | doc "Descriptive only" | No predictive claim | |
| 9 | Equity unsided | PASS | `rules.test.ts` ("reads only volume…") | Identical outputs with sides present, partial or absent; no sided reads in the folder | |
| 10 | Historical policy | PASS | `rules.test.ts` ("OHLCV_POLICY row, appended last…") | `relativeVolume: OHLCV_POLICY` appended last; available with `ohlcv` for BINANCE, DXFEED, DATABENTO; candle-only replay with no extras yields real ratios and the 13 markers | |
| A | Amended spec: `sessions` ≥ 3 | PASS | `rules.test.ts` "sessions has a minimum of 3…" | Schema and clamp at 3 | |
| B | Amended spec: cosmetic never changes a number | PASS | `rules.test.ts` "a cosmetic setting never changes a number…"; builder's ruling-2 test | No cosmetic field; identity `recolor` on both lines; `updateSettings` without a recompute change leaves 2.25× and the marker | |

Verdict: **ACCEPT**.

Check 7 statement: on the frozen 15-session equity fixture at threshold 2.0, the time-of-day median baseline detects all 12 labelled anomalies with 1 false positive among 4,668 non-anomaly bars and none of the 240 opening and closing minutes, while the plain rolling-20 baseline detects the same 12 with 20 false positives, 19 of them in those 240 always-loud minutes (7.92 percent): the tool shows that an unusual bar is unusual for its minute of day, which a rolling baseline cannot tell apart from the open and the close being their normal selves.

## Notes for the package (not blocking)

- Doc wording: the Controls section says "no setting is allowed to trigger [a replay] unless it changes the mathematics", but `hotThreshold`, `showMarkers` and `showRolling` replay without changing the mathematics (amendment 5, by design). Suggested wording: "unless it changes which bars are classified or drawn". Behaviour is as the brief requires; only the sentence overreaches.
- Because those three settings replay over the retained bars, changing the unusual threshold after a long live session on one-minute crypto can move a ratio the same way a reload does (ruling 2's accepted behaviour). The doc's "Replay and Historical Mode" paragraph covers reloads and rebuilds; one clause naming settings changes would complete it.
- Codex G3 round 1 items: 1, 2, 3, 5, 6, 7 are settled by the fixes above and pinned by tests; item 4 is pinned as accepted behaviour with both budgets quoted.

## Not verified

Live rendering beyond the screenshots (pane, fill, markers, table at several zoom levels remain the UX specialist's evidence); browser update latency; real market data (synthetic fixtures only).
