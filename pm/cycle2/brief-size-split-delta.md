# Build brief: Size-Split Delta (G1 round 3, L1 specialist, 2026-10-26)

Shared rules: `PM/WORKER-BRIEF.md`, `PM/CAPABILITIES.md` (sections 5 and 9),
`PM/cycle1/ux-standard.md` (binding), `PM/cycle1/validation-protocol.md`.
Structure follows `PM/cycle1/brief-rvol-clock.md` after its five rounds.

## The trading question

"Does large-print flow confirm this price extreme?" Small-print flow is
context, not a second question.

## Target user and decision

Intraday order-flow traders on BTC/ETH (Binance) and ES/NQ (dxFeed). The
tool shows whether the large tier's cumulative delta made the new extreme
with price or lagged it, and what the small tier did. Joining or fading are
trader decisions, not validated outcomes. Flow is split by **trade frame
size as delivered**, never by participant (a sliced iceberg prints small).
Descriptive only.

## Identity

- Folder `apps/web/src/lib/indicators/size-split-delta/`; def
  `sizeSplitDelta.ts`; pure math `sizeSplitDeltaMath.ts`; tests in `tests/`.
- id `sizeSplitDelta`, label `"Size-Split Delta (large vs small)"`, category
  `"l1"`, `ticksWanted: true`, `maxReplayBars: 10_080`, `{ kind: "ownPane",
  priceLines: [0] }`, no `autoscaleRange`, no `timeframeGate`. The doc
  qualifies "large": a p98 estimated from preceding frames, ties included,
  so more than 2 percent of a bar's prints can classify large.
- Historical Mode policy: `unavailableReason: "Needs the live tape: the
  archive keeps only the largest prints of each minute."`

## Data

Flow comes from `ctx.ticks` only: `prints`, `liveSince`, `coverageOf`. From
the bar: `ts_open`, `interval_ms`, `closed`, `close` (markers), `volume`
(tape share). Never `barSides`, `buy_volume`, `ctx.trades` or
`ctx.tradeAvailability`: tick-store coverage is the only gate for
tick-derived values. Sizes are provider units.

| Path | Tape | Indicator (`null` unless coverage is `"all"`) |
|---|---|---|
| Runtime WebSocket (Binance, dxFeed) | live prints complete from connect; pre-connect pool and `aggressive_history` floor-filtered (`"thin"`) | lines begin at the first `"all"` window; earlier bars `null`, row `Needs live tape · thinned` |
| Browser-direct | live `trade` stream complete from connect; `aggTrades` bootstrap `"thin"` | as above; the bootstrap never enters a value |
| REST candle transport | no trade frames, `"none"`, `ctx.ticks` possibly undefined | all `null`, no markers, row `Needs live tape · no feed` |
| Historical Mode | no store | greyed with the policy sentence |
| Equities (dxFeed) | only sided prints reach the browser | share gate (rule 5); sides never inferred |

Store cap: the tape drops live prints past 250,000 (`liveDroppedThrough`),
about 2.6 hours at BTC-USDT's 1,600 frames a minute; windows that reached
the drop read `"thin"`.

Aggregates: the 10,000-row fixture holds Binance aggregate trades (one taker
order at one price, `m ? "sell" : "buy"`), so its tier is higher than on
prints (p98 0.106 BTC, p99 0.198, max 2.0; the top 2 percent carry 52.5
percent of volume). The tier is "per trade frame as delivered" and does not
transfer between transports.

## Calculation (incremental, one bar at a time)

1. **Window.** `[ts_open, ts_open + interval_ms)`, located with
   `firstPrintAtOrAfter`, scanned to the window end; non-finite or
   non-positive size or price is skipped.
2. **Tier threshold, read before write.** On a new `ts_open`'s first
   dispatch, after rule 6 has committed the previous tail, the record stores
   `tierAtOpen`: `auto` = nearest-rank p98 (index `ceil(0.98 n) - 1` of the
   ascending sort) of the size ring, `null` under 200 sizes; `fixed` =
   `tierSize`. Every revision and the commit use it.
3. **Size ring, exact bound.** A `Float64Array` of the last 4,096 sizes
   (32 KB) from committed `"all"` windows, both tiers, oldest overwritten;
   sorted into a 32 KB scratch once per commit that changed it (about
   0.25 ms), never per revision.
4. **Bar contribution.** Per print: `large = size >= tierAtOpen` (ties
   large); `largeBar` or `smallBar += signed size` (`buy` positive);
   `tapeVolume += size`. Coverage other than `"all"` yields `null`.
5. **Tape share gate, fail closed.** `share = tapeVolume / bar.volume` when
   `bar.volume` is finite and positive, else `null`; `eligible = share !==
   null && share >= minTapeShare` (default 0.5). Ineligible flow is `null`
   (row `Tape 38% · below 50%` or `Tape share unknown`). Pinned: zero or
   missing volume → ineligible even with prints; no prints, positive volume
   → share 0, ineligible; no prints, zero volume → unknown, ineligible;
   never a zero contribution. Binance and futures read about 1.0; equities
   read the sided share.
6. **Commit sequence, keyed to bar close, tail-only.** Record `{ts_open,
   tierAtOpen, largeBar, smallBar, tapeVolume, share, eligible, coverage,
   committed}`. The tail commits at the first of (a) its first dispatch with
   `bar.closed === true`, (b) the first dispatch of a greater `ts_open`
   while uncommitted. On (a), which the runtime publishes: 1 rescan the
   window once from the store; 2 compute `share` and `eligible` from
   `bar.volume`, freeze flow **and** eligibility; 3 if coverage is `"all"`,
   push its sizes into the ring and re-sort; 4 advance the cumulatives if
   eligible, else rule 9. On (b) the runtime appends only the current
   output and cannot republish the previous bar, so steps 2 to 4 use the
   tail's **last revision values, no rescan**: committed history equals the
   display, and a print arriving between the last revision and supersession
   is excluded until a `REBUILT` or `setTicks` replay (doc page). Step 5,
   on the new bar's first dispatch: create its record and read `tierAtOpen`
   (rule 2). After commit nothing changes; a dispatch older than the tail
   is ignored.
7. **Forming bar.** Every `replace: true` rescans the forming window from
   scratch (0.0105 ms measured for 1,000 prints in a 250,000-print store)
   and overwrites the tail: no cursor, no double counting. Forming output =
   frozen cumulative **under the current anchor** plus the forming
   contribution, provisional (50 percent alpha, row `Forming`); the
   forming-prefix test checks this identity at every revision.
8. **Anchor and reset.** `anchor`: `day` (default) or `week`, the shared
   session kernel's UTC-aligned windows (`sessionWindowStartFor`, as VWAP
   Bands), or `tape` (from the first covered bar). On the **first dispatch
   inside a new anchor window**, forming included: zero cumulative base,
   empty marker ring, table rows (a) and (b) cleared; the window's first
   bar shows only its own contribution. No bar-count anchor: one placed
   from `barCount` fails truncation invariance by design.
9. **Gaps.** A `null` or ineligible bar adds nothing and both lines are
   `null` on it; the cumulative resumes unchanged at the next eligible bar
   (row `Tape gap · 3 bars`); the doc says the sum omits the gap's flow. A
   `setTicks` reconnect replays every bar; uncovered windows become `null`.
10. **Outputs** (`readOutput` keys). Lines `large` and `small`: cumulative
    `largeBar` and `smallBar` since the anchor. Seams `largeBar` and
    `smallBar`: the bar's own contributions, no line (or Visibility lines,
    off). All four `null` until
    `tierAtOpen` exists, coverage is `"all"` and the bar is eligible. No
    `NaN`; fail closed.
11. **Markers**, a function of committed state (provisional on the tail,
    final at commit; a replace redraws, never duplicates). The marker ring
    holds exactly `K` (default 20) **consecutive valid committed bars
    immediately preceding `t`** (`close`, `largeBar`, `smallBar`, cumulative
    `large`); a `null` or ineligible bar or an anchor reset empties it, so
    no comparison crosses a reset or gap. `mabsL`, `mabsS` = means of
    `|largeBar|`, `|smallBar|` over the ring, `t` excluded. Nothing fires
    until the ring is full. An **extreme** is strict (`close_t >` ring max
    or `<` min). Divergence wins row (b) when both fire.
    - **Large-tier divergence** (`arrowDown` above bearish, `arrowUp` below
      bullish, the large line's colour): `h` = ring bar with the highest
      close (latest if tied); bearish fires when `close_t > close_h` and
      `large_t <= large_h - m · mabsL` (`m` default 2); bullish mirrors on
      the lowest close.
    - **Tier conflict** (`circle`, purple, off by default): `C_t` when the
      ring-plus-`t` sums of `largeBar` and `smallBar` have opposite signs
      and each `|sum| >= q · sqrt(K + 1) · mabs` of its tier (`q` default
      2); onset only, `C_t && !C_{t-1}`, false after a reset.
    At most two markers per bar; 40 per 1,000 covers both types.
12. **Status precedence, first match wins** (cells at most 30 characters):
    `Needs live tape · no feed` (no store or `"none"`); `Needs live tape ·
    thinned`; `Learning sizes · 120/200`; `Tape share unknown`; `Tape 38% ·
    below 50%`; `Tape gap · 3 bars`; `Forming`; ready: `≥ 0.106 BTC · tape
    100%`. Unavailable values print `—`.
13. **No future data.** The scan takes prints with `ts` in `[ts_open,
    window end)`; the window end is the cutoff, so a committed bar ignores
    prints at or after it even when the store already holds them (test: a
    store loaded with the whole fixture up front equals one fed bar by bar).
    Thresholds come from committed bars only; truncation changes no earlier
    output or committed marker.

## Default view

Own pane: `large` purple `#8672b3` width 2, `small` blue `#2563eb` width 1,
dotted zero line, no fill. Divergence/confirmation is the primary state;
conflict circles are secondary, off by default. Table top right, three rows
of at most 30 characters, values at most 5 characters with sign (`k`
suffix): (a) confirmation state at the current bar: `L +12.4 · S −8.1 ·
confirms` when `close_t` is a strict ring extreme and `large_t` strictly
exceeds the ring's matching `large` extreme; `… · lags` when the close is a
strict extreme but `large_t` is not; `… · no extreme` otherwise; `—` until
the ring is full; reset with the ring on gaps and anchors. (b) Last
condition with time in the instrument's clock and value: `Div ↓ 12:34 ·
−8.1` (depth `large_t - large_h`) or
`Conflict 12:34 · +4.2/−3.1`; cleared on anchor reset. (c) Status. Warm-up
stays one row, pane empty. Same hues on the dark chart; markers take the
large line's colour.

## Controls

Primary (Inputs): `tierMode` select `auto` / `fixed` ("Large tier");
`tierSize` numeric, visible when `fixed`, "Large from (units)", suggested per
instrument through `settingsFieldsFor` (0.5 BTC, 20 contracts, 2,000
shares); `anchor` select `day` / `week` / `tape`. All recompute.

Advanced (`tab: "advanced"`): `K` "Window (bars)" 10..60 step 5; `m`
"Divergence depth (×)" 1..4 step 0.5; `q` "Conflict strength (×)" 1..4 step
0.5; `minTapeShare` "Minimum tape share" 0.2..1 step 0.05. Visibility:
`showSmall` (true), `showDivergence` (true), `showConflict` (**false**).
All recompute; no colour pickers. A `staticHint` names
the warm-up (200 sizes, about two minutes on BTC-USDT, `"all"` coverage),
the tape-start rule and the markers (arrow: a price extreme the large tier
did not make; circle: the tiers pulling apart).

## Frozen fixtures in `validation/fixtures.ts`

**Mechanism fixture `sizeSplitFixture()`**: 300 one-minute bars from
`FIXTURE_T0`, `BINANCE_PERP`, start 60,000, `mulberry32(20261102)`; draws
per bar in order: large sides, small sides, close noise, print price noise.

- Regime `d_i = +1` for bars 0..29, alternating sign every 30 bars.
- Prints per bar: 2 large of exactly 1.0 BTC at 85 and 90 percent of the
  bar, then 98 small of size `0.01 + 0.039 u`, spread evenly; **sorted by
  timestamp** before `candleOf`, so the close is the last print's price.
- Large side `d_i` with probability 0.8 each; small buy probability
  `0.5 - 0.15 d_i`.
- Target close `open + 25 · netLarge_i + 10 (u - 0.5)` (`netLarge` the
  signed large count); print prices interpolate open to target plus
  `2 (u - 0.5)`; the final print trades at the target.
- **Planted divergences** at bars `45 + 30 j`, `j = 0..7`: at `p-2..p` both
  large prints take side `-d`; at `p` the target is `max(close_{p-20..p-1})
  + 30` (`min - 30` for `d = -1`, a strict new extreme) and small prints
  are buys with probability 0.9 (sells for `d = -1`): the large prints
  oppose the move. Labels `plantedIndices`, `direction`, `eligibleFrom`.
  The `barSides` delta at `p` is about `+0.35 d`, invisible to the CVD
  baseline.
- Threshold and contribution assertion, warm-up excluded: from the first bar
  with `tierAtOpen !== null` the test recomputes the nearest-rank p98 from
  the ring actually produced, then derives expected `largeBar`/`smallBar`
  with a reference implementation classifying `size >= threshold`,
  boundary print included. No perfect-separation claim.

**Regime generator `sizeSplitRegimeBars({ seed, priceFollows })`**: 600
bars, same print structure and side model (`d` flipping every 30 bars,
large side `d` at 0.65, small buy at `0.5 - 0.15 d`); target close by
`priceFollows`: `"large"` `open + 25 · netLarge + noise`, `"small"` `open +
60 · netSmall + noise` (net small BTC), `"none"` `open + 30 (u - 0.5)`.
Seeds 1..10 per regime, declared before any run. **Labels come from the
generator's hidden state, independent of any detector**: `"large"` plants
10 events per seed at bars `60 + 55 j`, `j = 0..9`, as the mechanism fixture
does; `"small"` and `"none"` plant nothing, so every marker there is false.
A hit is a marker on the planted bar exactly. Eligibility (full ring,
eligible bar) is identical for every compared configuration.

## Comparisons (test-only `RuntimeIndicatorDef`s in `tests/`)

One controlled comparison: the indicator in `auto` mode versus the same
indicator in `fixed` mode (`tierSize` 0.5 BTC on the fixtures), identical
cumulative detector, identical gates; the only difference is the tier. Plus
the `orderFlow` CVD from `barSides` with rule 11 applied to cumulative total
delta and its own `mabs`, as "what candles alone show".

## Acceptance (`anchor: tape`, defaults, counts pinned in tests)

- Mechanism fixture: divergence recall on the 8 planted bars `>= 7/8`, each
  on bar `p` exactly; false divergences on eligible non-planted bars `<= 2`
  and `<=` the CVD baseline's; conflict onsets pinned to the exact count
  the frozen rule produces; combined budget `<= 40` per 1,000, `maxPerBar
  <= 2`.
- Regime fixtures, per regime over 10 seeds: hits, false markers and
  eligible bars for `auto`, `fixed` and CVD in one table. `auto` must beat
  or match `fixed`: no more false markers on `"none"` and `"small"` at equal
  or better recall on `"large"`, summed over seeds; otherwise the build
  fails acceptance like any other failure and the PM decides. No fallback
  ships from this brief.
- `whaleVersusCrowd()` in **fixed mode, `tierSize` 1.0 BTC** (auto cannot
  classify an isolated tape before 200 sizes): the single-large-print tape
  gives `largeBar +50, smallBar 0`, the hundred-print tape `0, +50`, same
  candle, CVD `+50` on both.
- 10k aggregate fixture, `candleOf` per minute (five full minutes): the auto
  tier after each commit equals the test's nearest-rank p98 of the same
  ring, `share = 1.0 ± 1e-9`, tier totals equal the signed sum.

## Further fixtures with expected outcomes

Duplicate close: no change, no second ring insertion. `REBUILT` late bar
equals a clean replay. Reconnect (`act` resets the tape, `setTicks`):
uncovered windows `null`, nothing stale. Shuffled `tapeOf` equals in-order.
`historyTapeOf`: `null`. No `extras.ticks` (REST): all `null`, one status
row. Equity: a `DXFEED_EQUITY` tape totalling 0.6 of `bar.volume` draws,
0.4 is `null` with the share row; `equityUnsidedBars()` without a tape is
`null` throughout; the code never reads `buy_volume`. `timeGapBars()`: the
cumulative carries. Forming tail stays provisional. Anchor rollover: the
new window's first forming dispatch shows only its own contribution, rows
(a) and (b) cleared, ring empty. Late print before supersession: a print
added after the tail's last revision and before the next bar's first
dispatch leaves committed outputs equal to the displayed history and to a
replay built from the same displayed decisions; a `REBUILT` replay then
includes it.

## Replay, live and retention

`discardLeading` trims runtime outputs and markers only and does not notify
indicator state, so the indicator bounds its own: two running totals, the
4,096-size ring, the `K`-ring and a per-bar record ring of fixed capacity
`maxReplayBars` (10,080); nothing else grows. Both paths read the same
store, so `checkLiveReplayEquivalence` with the fixture tape as
`extras.ticks` must agree on `largeBar`, `smallBar`, `large`, `small` and
markers from the **first retained committed bar whose anchor start and
preceding 4,096 committed sizes both lie inside the retained series**,
non-zero compared count asserted, forming tail excluded. The only
documented difference is a changed store (reconnect). The future-prints
test (rule 13) and the forming-prefix test (rule 7) run here.

## Performance (frozen method)

`probeReplayPooled` (3 warm-ups, 5 timed runs, `onBar` plus `readOutput`) on
`trendBars({ count: 10080 })` with `busyTapeFor(bars, { printsPerBar: 20 })`
in one `tapeOf` store (201,600 prints, under the cap): p99 `<= 0.5 ms`,
wall `<= 5 s`. `probeFormingBar` (60 s, 50 a second, 1,000 prints): p99
`<= 0.1 ms`. `probeRollover`: every output key 10,080 long,
`markersBeforeRetention === 0`, `bytesPerExtraBar` within 3× the 370 B
floor. State as bounded above: under 1 MB plus 64 KB.

## Success criteria

1. Hand-computed values on a three-bar fixture: tier at each open, both
   contributions, both commit paths, share, an anchor reset.
2. Protocol checks 1 to 7, 9 and 10 in named tests; check 8 N/A.
3. The acceptance numbers above, pinned and quoted in the doc page.
4. UX: three primary controls, Advanced group, two lines, table strings as
   written, screenshots at two zooms on cream and dark plus warm-up and REST
   states; the fixture WebSocket server gains `trade` frames.
5. Doc `docs/architecture/indicators/size-split-delta.md` plus README row;
   `validate-docs`, web suite, type check, lint green; Codex G2 APPROVED;
   validator PASS; the owner's live observation (threshold, share, marker
   counts over one BTC-USDT and one NQ session) in the package.

## Limitations to state in the package

Print size is not participant size; the tier follows the delivered trade
frame. Lines start at the tape start (about 2.6 hours back on BTC-USDT at
most), never in Historical Mode or on the REST transport. A bar superseded
without a close keeps its last displayed values until a rebuild. Equities
show sided flow only, `null` under the share gate on most bars.
Cumulative-since-anchor is a presentation choice (per-bar histogram mode in
v2). Descriptive; no forward claim.

## Summary (ten lines)

1. Does large-print flow confirm this price extreme; two cumulative lines plus per-bar seams.
2. Tier at bar open from a 4,096-size ring of committed `"all"` windows (nearest-rank p98, ties large, 200 minimum) or fixed.
3. Commit at close (rescan) or supersession (last revision); freeze flow and eligibility, ring, cumulative, next tier.
4. Honest nulls on `"thin"`, `"none"`, REST, Historical Mode, unknown or low share; coverage is the only tick gate.
5. Anchor `day`/`week`/`tape`; reset on the first dispatch in a new window; gaps carry.
6. Divergence arrows (primary) and conflict onset circles (off) on exactly `K` prior valid bars; 40 per 1,000 combined.
7. Mechanism fixture (300 bars, 8 planted) plus regime generator (large plants 10 per seed; 10 seeds each).
8. Auto versus fixed tier with the identical detector, plus the CVD candles-alone baseline; no fallback ships.
9. Pooled p99 `<= 0.5 ms`, forming p99 `<= 0.1 ms`, rollover flat; bounded state under 1 MB plus 64 KB.
10. Three primary controls; three-row table within 30 characters; no colour pickers.

Effort: **M** (one build run, UX mid-build, at most two fix rounds); the only
novel mechanism is the size ring with its commit discipline.

## PM review before Codex round 1

Accepted as drafted. Rulings on the three open points:

1. **Fixture WebSocket server gains `trade` frames** built from
   `sizeSplitFixture()` so the UX pass can screenshot this tool. In scope
   for the build (already in success criterion 4); the server stays a
   `pm/cycle1/screenshots/tools` asset, not a product file.
2. **Live observation** runs wherever the tape is complete from connect: the
   owner's test host (runtime WebSocket) or the browser-direct deployment.
   The REST transport is not a live-observation venue for this tool, and the
   package says so.
3. **Browser-direct bootstrap is `"thin"` and never enters a value.**
   Accepted; it matches the runtime's pre-connect pool behaviour, so the two
   paths show the same honest start.

Scope check against the charter: one question, descriptive, three primary
controls, no `barSides`, frozen fixture and baseline before the build,
effort M. Proceed to Codex plan round 1.

## Round 2 changes (after Codex plan round 1, PM rulings 1 to 10)

1. Question narrowed to large-print confirmation of the extreme; small flow
   is context; join/fade are trader decisions; label `(large vs small)`;
   "top 2%" qualified as a p98 estimate, ties included.
2. Commit as a numbered sequence: previous tail commits and the ring updates
   before the new `tierAtOpen` is read.
3. Share fails closed; eligibility frozen with flow; zero-volume and
   zero-print cases pinned.
4. `ctx.trades`/`ctx.tradeAvailability` dropped with the `LIVE_PARTIAL` row;
   `bar.close` added.
5. Marker ring of exactly `K` valid prior bars, means exclude `t`, cleared
   by any null or reset; conflict count pinned; budget combined.
6. `largeBar`/`smallBar` seams; equivalence on contributions for every
   covered committed bar, on cumulatives only with the anchor retained; tail
   excluded; future-prints test with the window-end cutoff.
7. Three-row table within 30 characters; marker meaning in the `staticHint`.
8. Fixture chronology fixed; warm-up excluded from threshold assertions;
   expectations from the actual ring; `sizeSplitRegimeBars`, 10 seeds each.
9. Second baseline (fixed tier, per-bar); ship its rule set if the adaptive
   cumulative shows no benefit.
10. Kept: 4,096 ring, p98, 200 minimum, anchors, no `barSides`, three
    primary controls, honest nulls.

## Round 3 changes (after Codex plan round 2, PM rulings 1 to 10)

1. "Large prints oppose the move" replaces "whales" throughout.
2. Supersession commits the tail's last revision values without a rescan
   (the runtime cannot republish the previous bar); only an explicit close
   rescans; a print between the last revision and supersession is excluded
   until `REBUILT`/`setTicks`, documented and tested.
3. Anchor reset on the first dispatch inside a new window: zero base for
   the forming output, empty ring, rows (a) and (b) cleared; forming-prefix
   checks at every revision.
4. Own bounded state named (totals, size ring, `K`-ring, 10,080-record
   ring, `maxReplayBars: 10_080`); exact equivalence eligibility: anchor
   start and preceding 4,096 sizes both retained, non-zero count.
5. Divergence/confirmation is the primary state; `showConflict` false; row
   (a) `L +12.4 · S −8.1 · confirms | lags | no extreme` with strict
   extremes; row (b) cleared on reset, divergence wins; warm-up one row.
6. Perfect-separation claim removed; expected contributions from a
   reference implementation with `size >= threshold`, boundary included.
7. One controlled comparison, `auto` versus `fixed` with the identical
   cumulative detector; CVD stays as the candles-alone baseline; the
   per-bar detector and the "ship (b)" fallback are gone; failure is an
   acceptance failure for the PM.
8. Labels from the generator's hidden state: `"large"` plants 10 per seed
   at `60 + 55 j`; `"small"` and `"none"` plant none; strict extremes,
   exact-bar hits.
9. `whaleVersusCrowd` runs in fixed mode, `tierSize` 1.0 BTC.
10. Per-bar histogram display deferred to v2; cumulative-since-anchor stated
    as a presentation choice with no claimed benefit.
