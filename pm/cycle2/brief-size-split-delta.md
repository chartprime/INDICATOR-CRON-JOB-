# Build brief: Size-Split Delta (draft for G1, L1 specialist, 2026-10-26)

Shared rules: `PM/WORKER-BRIEF.md`, `PM/CAPABILITIES.md` (sections 5 and 9),
`PM/cycle1/ux-standard.md` (binding), `PM/cycle1/validation-protocol.md`.
Structure follows `PM/cycle1/brief-rvol-clock.md` after its five rounds.

## The trading question

"Are the large prints and the small prints pushing the same way, and which
one is price following?"

## Target user and decision

Intraday traders on BTC/ETH (Binance) and ES/NQ (dxFeed) who read order
flow. Decision: join a move when the large tier agrees with price; stand
aside or look for the fade when price makes a new extreme the large tier
does not follow while the small tier chases. The tool splits aggressive flow
by **print size as delivered**; it does not identify participants (a sliced
iceberg prints small). Descriptive only; no predictive claim in version 1.

## Identity

- Folder `apps/web/src/lib/indicators/size-split-delta/`; def
  `sizeSplitDelta.ts`; pure math `sizeSplitDeltaMath.ts`; tests in `tests/`.
- id `sizeSplitDelta`, label `"Size-Split Delta (top 2%)"`, category `"l1"`,
  `ticksWanted: true`, `{ kind: "ownPane", priceLines: [0] }`, no
  `autoscaleRange` (a cumulative sum has no fixed range), no `timeframeGate`.
- Historical Mode policy: `unavailableReason: "Needs the live tape: the
  archive keeps only the largest prints of each minute."`

## Data

Flow comes from `ctx.ticks` only: `prints`, `liveSince`, `coverageOf`. From
the bar: `ts_open`, `interval_ms`, `closed`, `volume` (tape share). Never
`barSides` or `buy_volume`; `ctx.trades` is read only to detect
`LIVE_PARTIAL`. Sizes are provider units.

| Path | Tape | Indicator (honest `null` unless coverage is `"all"`) |
|---|---|---|
| Runtime WebSocket, Binance or dxFeed | live prints complete from connect; pre-connect pool and `aggressive_history` floor-filtered (`"thin"`) | lines begin at the first bar whose whole window is `"all"`; earlier bars `null`, row `Needs live tape · history is thinned` |
| Browser-direct | live `trade` stream complete from connect; `aggTrades` bootstrap above a floor (`"thin"`) | as above; the bootstrap never enters a value |
| REST candle transport | no trade frames, `coverageOf` `"none"`, `ctx.ticks` possibly undefined | every output `null`, no markers, row `Needs live tape · polled candles have none` |
| Historical Mode | no store | greyed with the policy sentence |
| Equities (dxFeed) | only sided prints reach the browser | tape share gate (rule 5); sides never inferred |

Store cap: the tape drops live prints past 250,000 (`liveDroppedThrough`), so
on BTC-USDT at about 1,600 trade frames a minute the complete stretch is
roughly 2.6 hours; windows that reached the drop read `"thin"` and are
`null`. The cumulative starts at the later of the anchor and the covered
start; the table says `since 11:42 (tape start)`.

Aggregates: the 10,000-row fixture holds Binance aggregate trades (one taker
order at one price, `m ? "sell" : "buy"`), not prints, so a tier estimated on
it is higher than on prints (p98 = 0.106 BTC, p99 = 0.198, max 2.0; the top
2 percent carry 52.5 percent of volume). The doc says the tier is "per trade
frame as delivered" and fixture numbers do not transfer between transports.

## Calculation (incremental, one bar at a time)

1. **Window.** `[ts_open, ts_open + interval_ms)`; prints located with
   `firstPrintAtOrAfter`, scanned forward, stopping at the window end. A
   print with non-finite or non-positive size or price is skipped.
2. **Tier threshold, read before write.** On the first dispatch of a new
   `ts_open` the record stores `tierAtOpen`: in `auto` mode the nearest-rank
   98th percentile (index `ceil(0.98 n) - 1` of the ascending sort) of the
   **size ring**, `null` while the ring holds fewer than 200 sizes; in
   `fixed` mode the setting `tierSize`. Every revision and the commit of that
   bar use `tierAtOpen`. The threshold may fall as well as rise.
3. **Size ring, exact bound.** A `Float64Array` ring of the last 4,096 sizes
   (32 KB) from **committed** `"all"` windows, both tiers, oldest
   overwritten; sorted into a 32 KB scratch array once per commit that
   changed it (about 0.25 ms), never per revision. 200/4,096 is the
   browser-direct pool's convention. The ring may hold sizes from discarded
   bars (see Retention).
4. **Bar contribution.** For each print in the window: `large = size >=
   tierAtOpen`; `deltaLarge += signed size` or `deltaSmall += signed size`
   (`buy` positive); `tapeVolume += size`; `countLarge`. A window whose
   coverage is not `"all"` yields a `null` contribution.
5. **Tape share gate.** `share = tapeVolume / bar.volume` when `bar.volume`
   is finite and positive, else `null`. A contribution with `share <
   minTapeShare` (default 0.5) is `null` for flow (the tape is not
   representative of the bar), and the row reads `Tape covers 38% · below
   50%`. On Binance and futures the share is about 1.0 and a sudden fall
   flags dropped prints; on equities it is the sided share.
6. **Commit rule, keyed to bar close, tail-only.** Record
   `{ts_open, tierAtOpen, deltaLarge, deltaSmall, tapeVolume, share,
   coverage, committed}`. The tail commits at the first of: (a) the first
   dispatch of its `ts_open` with `bar.closed === true`; (b) the first
   dispatch of a greater `ts_open` while uncommitted. At commit the window
   is **rescanned once from the store** (the store, not the last revision,
   is the source), frozen, and only then its sizes enter the ring and the
   cumulative advances. A later dispatch of the same `ts_open` re-reads only
   `share`; flow never changes after commit. A print landing in a committed
   window later is ignored until a `REBUILT` or `setTicks` replay rebuilds
   everything from the store. A dispatch older than the tail is ignored.
7. **Forming bar.** Every `replace: true` rescans the forming window from
   scratch (measured 0.0105 ms for 1,000 prints in a 250,000-print store)
   and overwrites the tail record: no cursor, no double counting. Forming
   outputs are the frozen cumulative plus the tail, provisional (50 percent
   alpha, row `Forming`).
8. **Anchor and reset.** `anchor`: `day` (default) or `week`, the UTC-aligned
   windows of the shared session kernel (`sessionWindowStartFor`, as VWAP
   Bands), or `tape` (from the first covered bar). Both cumulatives reset to
   0 at the first committed bar whose window differs from the previous
   committed bar's. No bar-count anchor in v1: one placed from `barCount`
   fails truncation invariance by design.
9. **Gaps.** A `null` contribution (thin, none, gate, missing bar) adds
   nothing; both outputs are `null` on that bar; the cumulative resumes
   unchanged at the next covered bar; row `tape gap · 3 bars`. The doc says
   a sum after a gap omits the gap's flow. A `setTicks` reconnect replays
   every bar; windows no longer covered become `null`.
10. **Outputs.** `large` and `small`: cumulative `deltaLarge` and
    `deltaSmall` since the anchor, `null` until `tierAtOpen` exists, the
    window is `"all"` and the share passes. No `NaN` ever; fail closed.
11. **Markers**, a function of committed state (provisional on the tail,
    final at commit; a replace redraws, never duplicates). Over the last `K`
    committed bars with values (default 20): `mabsL` = mean `|deltaLarge|`,
    `mabsS` = mean `|deltaSmall|`.
    - **Large-tier divergence** (`arrowDown` above the bar bearish, `arrowUp`
      below bullish, the large line's colour): with `h` the bar of the
      highest close in `t-K..t-1` (latest if tied), bearish fires when
      `close_t > close_h` and `large_t <= large_h - m · mabsL` (`m` default
      2); bullish mirrors on the lowest close.
    - **Tier conflict** (`circle`, purple): `C_t` is true when `sum_K
      deltaLarge` and `sum_K deltaSmall` have opposite signs and each `|sum|
      >= q · sqrt(K) · mabs` of its tier (`q` default 2); fires on the
      **onset** only, `C_t && !C_{t-1}`.
    At most two markers per bar.
12. **Status precedence, first match wins:** `Needs live tape · polled
    candles have none` (no store or `"none"`); `Needs live tape · history is
    thinned`; `Tape incomplete` (`LIVE_PARTIAL`); `Learning sizes · 120 of
    200`; `Tape covers 38% · below 50%`; `tape gap · N bars`; `Forming`;
    ready: `Large ≥ 0.106 BTC · tape 100% · since 00:00`. Unavailable
    values print `—`.
13. **No future data.** A bar uses prints with `ts < min(now, window end)`
    and a threshold read at its open from committed bars only; truncating
    the series changes no earlier output or committed marker.

## Default view

Own pane: `large` purple `#8672b3` width 2, `small` blue `#2563eb` width 1,
dotted zero line, no fill. Table top right, two rows: `Large +12.4 · Small
−8.1` and the status row. Before warm-up the pane is empty. Same hues on the
dark chart; markers take the large line's colour, never green/red (the arrow
carries direction).

## Controls

Primary (Inputs): `tierMode` select `auto` / `fixed` ("Large tier");
`tierSize` numeric, visible when `fixed`, "Large from (units)", suggested per
instrument through `settingsFieldsFor` (0.5 BTC, 20 contracts, 2,000
shares); `anchor` select `day` / `week` / `tape`. All recompute.

Advanced (`tab: "advanced"`): `K` "Window (bars)" 10..60 step 5; `m`
"Divergence depth (×)" 1..4 step 0.5; `q` "Conflict strength (×)" 1..4 step
0.5; `minTapeShare` "Minimum tape share" 0.2..1 step 0.05; recompute.
Visibility: `showSmall`, `showDivergence`, `showConflict` (recompute, since
`recolor` cannot reclassify history). No colour pickers (RVOL G3 ruling 1).
A `staticHint` names the warm-up (200 sizes, about two minutes on BTC-USDT,
`"all"` coverage) and the tape-start rule.

## Frozen fixture: `sizeSplitFixture()` in `validation/fixtures.ts`

300 one-minute bars from `FIXTURE_T0`, `BINANCE_PERP`, start price 60,000,
`mulberry32(20261102)`; draws per bar in this order: large sides, small
sides, close noise, print price noise.

- Regime `d_i = +1` for bars 0..29, alternating sign every 30 bars.
- Prints per bar: 2 large of exactly 1.0 BTC at 85 and 90 percent of the
  bar, then 98 small of size `0.01 + 0.039 u`, spread evenly. The ring is
  exactly 2 percent large, so the nearest-rank p98 is either the largest
  small (`< 0.05`) or `1.0`; the test asserts `0.049 < tierAtOpen <= 1.0`
  at every bar. Fixed mode uses 0.5.
- Large side `d_i` with probability 0.8 each; small side buy with
  probability `0.5 - 0.15 d_i`.
- Close `open + 25 · netLarge_i + 10 (u - 0.5)` (`netLarge` the signed large
  count); print prices interpolate open to close plus `2 (u - 0.5)`; candle
  from `candleOf(prints)`.
- **Planted divergences** at bars `45 + 30 j`, `j = 0..7`. At `p-2..p` both
  large prints take side `-d`; at `p` the close is forced to
  `max(close_{p-20..p-1}) + 30` (`min - 30` for `d = -1`) and the small
  prints are buys with probability 0.9 (sells for `d = -1`): the crowd
  chases, the whales sell into it. Labels `plantedIndices`, `direction`,
  `eligibleFrom`.
- By construction the `barSides` delta at `p` is about `-2 + 2.35 = +0.35
  d`, so the baseline sees no divergence; a false divergence needs two large
  sells in three bars plus a new high, which the price rule makes rare.

Baseline: the same rule 11 applied to the `orderFlow` CVD from `barSides`
(cumulative total delta, `mabs` of total delta), implemented as a test-only
`RuntimeIndicatorDef` in `tests/`.

Acceptance on the fixture (`anchor: tape`, defaults):

- Divergence recall on the 8 planted bars `>= 7/8`, each hit on bar `p`
  exactly; baseline recall reported beside it (expected 0–1).
- False divergence markers on eligible non-planted bars `<= 2` and `<=` the
  baseline's count.
- Tier-conflict onsets pinned (expected about one per regime); overall
  budget `<= 40` per 1,000 bars, `maxPerBar <= 2`.
- Eligible, detections, hits and false counts tabled and pinned.
  `whaleVersusCrowd()` (whale 50 BTC): whale tape `deltaLarge +50, deltaSmall
  0`, crowd tape `0, +50`, identical candles, baseline `+50` on both.
- 10k aggregate fixture, bars from `candleOf` per minute (five full
  minutes): the auto tier after the first commit equals the hand-computed
  nearest-rank p98, `share = 1.0 ± 1e-9` every bar, tier totals equal the
  fixture's signed sum.

## Further fixtures with expected outcomes

Duplicate close: no change, no second ring insertion. `REBUILT` late bar:
equals a clean replay. Reconnect (`act` resets the tape, `setTicks`):
uncovered windows `null`, nothing stale. Shuffled `tapeOf` equals in-order.
`historyTapeOf(prints, floor)`: `null`. No `extras.ticks` (REST): all
`null`, one status row. Equity: a `DXFEED_EQUITY` tape totalling 0.6 of
`bar.volume` draws, 0.4 is `null` with the share row; `equityUnsidedBars()`
without a tape is `null` throughout and the code never reads `buy_volume`.
`timeGapBars()`: the cumulative carries (documented). Forming tail stays
provisional. Session rollover: both lines equal the first bar's contribution.

## Replay, live and retention

Both read the same store, so `checkLiveReplayEquivalence` with the fixture
tape as `extras.ticks` must return `equal === true` for every covered bar;
the only documented difference is a changed store (reconnect). Records are
trimmed with `discardLeading`; the ring's 4,096 sizes may predate the oldest
retained bar, so a replay from retained bars alone can give the earliest bars
a different `tierAtOpen`. Equivalence is required for bars whose preceding
4,096 committed sizes lie within the retained series, with a non-zero
compared count asserted.

## Performance (frozen method)

`probeReplayPooled` (3 warm-ups, 5 timed runs, `onBar` plus `readOutput`) on
`trendBars({ count: 10080 })` with `busyTapeFor(bars, { printsPerBar: 20 })`
in one `tapeOf` store (201,600 prints, under the cap): p99 `<= 0.5 ms` (the
sort at commit), wall `<= 5 s`. `probeFormingBar` (60 s, 50 revisions a
second, 1,000 prints): p99 `<= 0.1 ms`. `probeRollover`: both lines 10,080
long, `markersBeforeRetention === 0`, `bytesPerExtraBar` within 3× the 370 B
floor. State: 8 numbers per retained bar (under 1 MB), two 32 KB arrays,
K-window rings.

## Success criteria

1. Hand-computed values on a three-bar fixture: tier at each open, both
   contributions, commit order, share, the reset at a session edge.
2. Protocol checks 1 to 7, 9 and 10 in named tests; check 8 N/A.
3. The acceptance numbers above, pinned and quoted in the doc page.
4. UX: three primary controls, Advanced group, two lines, table strings as
   written, screenshots at two zooms on cream and dark plus warm-up and REST
   states; the fixture WebSocket server extended with `trade` frames from
   `sizeSplitFixture()`.
5. Doc `docs/architecture/indicators/size-split-delta.md` plus README row;
   `validate-docs`, full web suite, type check and lint green; Codex G2
   APPROVED; validator PASS; the owner's live observation on the test host
   (threshold, share and marker counts over one BTC-USDT and one NQ session)
   recorded in the package.

## Limitations to state in the package

Print size is not participant size. The tier follows the delivered trade
frame. Lines start at the tape start (about 2.6 hours back on BTC-USDT at
most), never in Historical Mode or on the REST transport. Equities show
sided flow only and are `null` under the share gate on most bars. Markers
are descriptive; no forward claim.

## Summary (ten lines)

1. Two cumulative lines: aggressive delta of prints at or above a size tier, and of the rest.
2. Tier fixed at bar open from a 4,096-size ring of committed `"all"` windows (nearest-rank p98, 200 minimum) or a fixed size.
3. Commit at bar close (or supersession), tail-only, rescanning the window from the store; flow never changes after commit.
4. Honest nulls on `"thin"`, `"none"`, the REST transport, Historical Mode, `LIVE_PARTIAL` and a tape share under 50 percent.
5. Anchor `day`/`week`/`tape`; cumulative starts at the later of anchor and tape start; gaps carry.
6. Two marker types: large-tier divergence (arrows, depth `m · mabs`) and tier-conflict onset (circle); budget `<= 40` per 1,000.
7. Frozen 300-bar fixture, seed 20261102, exact 2 percent large prints of 1.0 BTC, 8 planted divergences the candle delta hides.
8. Acceptance: recall `>= 7/8`, false `<= 2` and `<=` baseline, counts pinned; whale-versus-crowd and the 10k aggregate fixture as exact checks.
9. Performance: pooled p99 `<= 0.5 ms`, forming p99 `<= 0.1 ms`, rollover flat; state under 1 MB plus 64 KB.
10. Three primary controls (tier mode, tier size, anchor); everything else Advanced or Visibility; no colour pickers.

Effort: **M** (one build run, UX joining mid-build, at most two fix rounds);
the only novel mechanism is the size ring with its commit discipline, and
the harness already supplies the tapes, the live driver and the probes.

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
