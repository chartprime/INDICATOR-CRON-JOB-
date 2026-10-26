# L2 concepts, cycle 1 (L2 specialist)

Five depth concepts for PM scoring. Concepts only, no code. Grounded in
`CAPABILITIES.md`, `docs/architecture/l2/l2-sdk.md`, `indicatorL2.ts`,
`indicatorLiquidity.ts`, `frames.ts` and the registry as imported 2026-10-26.

## 0. Shared mechanics (every concept, unless it says otherwise)

**Feed requirement.** All five need **aggregated depth** per price (Binance
depth diffs, or the dxFeed Order-v2 book that the runtime's L2 engine folds to
per-price levels before the browser sees it) plus the **tape with aggressor
side**, which reaches the browser as sided flow per row in lane-0 columns.
None needs individual orders, order ids or the dxFeed DOM service, so all run
on BTC/ETH (Binance) and ES/NQ/AAPL/TSLA/NVDA (dxFeed layer 2). On AAPL and
TSLA 35 to 75 percent of volume is unsided and never enters the column flow,
so a "cancel versus fill" split there is **not separable**: the concepts show
net size change only on equities and say so in the legend.

**Inputs.** `ctx.liquidity.feed.fine.columns` (lane 0, 1 s, 20 min): `ts`,
`lo`, `hi`, dense `bid[]`/`ask[]` per row, sparse `buy`/`sell` flow per row,
`reference` (the p95 "typical row" near price when the column printed).
`feed.deep.columns` (10 s, 2 h) hold each row's **maximum** over the 10 s, so
they serve presence only, never size deltas. `ctx.l2.ladder()` (exact top 50
per side), `walls()` (≤400 on lane 0: `size, peak, ratio, fill, eaten,
absorbing, startTs, endTs, endedBy, detail`), `events(sinceSeq)`,
`lanes()/view(k)`. Gates on every read: `ctx.l2 !== undefined`, availability
not `HISTORICAL_UNAVAILABLE`, `trusted()`, `status("l2_view").synced` for
columns, `status("l2_ladder").synced` for the ladder, `events(seenSeq).complete`
wherever an event interval is counted. A failed gate gives `null` outputs and
a one-word status cell (UNTRUSTED, RESYNC, GAP, NO L2), never a zero.

**"Now" and the forming bar.** `onBar` fires with `replace: true` on every
applied L2 frame (about once a second). State keeps `lastColumnTs`; each call
walks `fine.columns` from the end back to it and processes only new columns
(normally one). Per-second measures go into bounded ring buffers; a bar's
output aggregates the seconds inside `[ts_open, ts_open + interval_ms)` and is
sealed on `bar.closed`. Per-bar outputs live in a `Map` capped at 10,080.

**Replayed bars.** State is now-as-of-call, not as-of-bar, so on
`ctx.replaying`: a bar inside the held fine columns (last 20 min) is computed
from those columns by `ts`, exactly as live would have; a bar in the deep tier
(20 min to 2 h) gets only presence-based parts, labelled "10 s", and `null`
for anything needing 1 s deltas or trades; older bars are an honest `null`.
That is the documented replay-versus-live difference.

**Reconnects, gaps, caps.** A dropped socket leaves state held but untrusted:
outputs `null`, status RESYNC, buffers kept. A hole between column `ts` larger
than 2 × `columnMs` + 2 s resets rolling windows and marks the bar "gap" (a
missing interval is never a zero). A `segment` event or `segment().state ===
"GAP"` resets wall bookkeeping. Wall facts come from `walls()` (the authority)
diffed by id against a `Map<id, lastSeen>`; `events(seenSeq)` adds timing only
when `complete`, and `missed > 0` is shown. The 5,000-event ring never holds
state.

**Cost and memory.** One new column a second, K ≤ 64 rows read per side by
index: microseconds. `walls()` allocates ≤400 entries once a second. No
column is copied. Ring buffers ≤ 7,200 s × 8 Float64 ≈ 460 KB worst case plus
the per-bar map; nothing grows with session length.

**Observation versus inference.** Feed numbers are written as facts ("bid 41.2
at 67,200, −18.0 since 14:03:10, 3.1 traded"). Anything about *why* is a
labelled inference with its rule ("likely pulled: 82 % of the shrink had no
trade behind it"). "Spoof", "absorb", "defend", "intent" never appear without
"likely" and the share that earned it. Every legend says "displayed size, not
orders": market-by-price cannot tell one participant from many.

**Units.** Base asset, contracts or shares per provider; every threshold is a
multiple of the column `reference` or of the instrument's own recent flow, so
no cross-provider constant exists.

## 1. Touch Pressure (pull/stack tape near the touch)

| | |
|---|---|
| Question | In the last few seconds, is displayed liquidity within a few rows of the touch being **added or withdrawn**, and is the withdrawal cancels or fills? |
| User, decision | Scalper at a level: lean with the stacked side, fade the pulled side, do not join a move whose own side is cancelling behind it. |
| Inputs | lane-0 fine columns (`bid/ask`, `buy/sell`, `reference`), `ladder()` for the best prices; gates `trusted()`, `status("l2_view").synced`. |
| Feed | aggregated depth + sided tape; equities net change only. |

**Calculation.** Per new column *c* and side: best row *b* from the ladder;
band = the K rows from *b* away from the mid (K = 10). Per row *r*: Δ =
size(c,r) − size(c−1,r), traded = opposing flow at *r* in *c*. Observed:
**added** = Σ max(Δ,0), **shrink** = Σ max(−Δ,0), **filled** = Σ min(shrink_r,
traded_r), **cancelled** = shrink − filled (the ledger's own rule redone on 1 s
columns; a late trade inside the same column is absorbed by the min). Rows
entering or leaving the band because the mid moved are skipped that second.
Values are divided by `reference` ("typical rows"). Per bar: added, filled,
cancelled per side and **net stack** = added − cancelled. A 20 s EMA of net
stack per side is the live line.

**Noise filter.** Row counts only at ≥ 0.1 × reference (the engine's dust
floor mirrored); |Δ| counts only at ≥ 0.05 × reference; a side draws only when
Σ|Δ| ≥ 1 reference in the bar, else a hollow zero ("quiet"). Parameters: K,
dust share, EMA seconds.

**Wording.** Fact: "Asks +3.4 / −1.2 cancelled / −0.8 filled (typical rows,
20 s)". Inference, only when cancelled ≥ 2 × filled and ≥ 2 reference in 20 s:
"likely pulled ahead of price"; added ≥ 2 reference while price approaches:
"stacking into the approach".

**Live/historical.** Live exact; replay exact for 20 min, `null` beyond.
Historical policy `["ohlcv","l2_states","l2_prints"]`; the verified states
carry the top 10 levels at 1 s, so K is clamped to 10 and labelled.

**Default view.** Own pane: bid stack (green) and ask stack (red) lines with
`draw.fill` to zero; a two-cell table in words ("BIDS stacking · ASKS
pulling"). Primary: band rows K, smoothing seconds, show cancel/fill split.
Advanced: dust share, Δ floor, colours.

**Alerts.** `plotshape` arrow when one side stacks ≥ +3 reference while the
other pulls ≤ −2 in the same 20 s; the last three listed in the table.

**Baseline to beat.** Top-of-book imbalance bidSize/(bid+ask). It cannot tell a
bid that traded away from one that was cancelled and flips with every tick of
the best price.

**Failure modes.** Mid moving several rows a second (skipped rows make the
tape quiet, stated); 10–25 % late trades (a fill booked as a cancel for one
column, corrected next); Binance $4 rows hide intra-row requoting.

**Effort** S–M. **Pitch:** the book's hands near the touch, split into added,
cancelled and filled, in units that mean the same on BTC and NQ.

**Overlap.** Live Order Book Profile shows the book now, not its change;
Aggressive Orders shows the trades, not the resting side's response; Empty
Orderbook needs two minutes of thinness. None computes adds or cancels.

## 2. Break Defense Monitor (cross-layer breakout concept)

| | |
|---|---|
| Question | As price approaches and breaks a level, is the displayed liquidity **defending** it eaten, pulled or reinforced; how thin is the book just beyond; does liquidity come back against the move? |
| User, decision | Breakout trader: take a break whose defence was *eaten* into a thin runway with no refill against; skip one whose defence was *pulled* (nobody was beaten) or whose runway is thick. |
| Inputs | a level (default Donchian high/low of N closed bars, the natural partner of an OHLCV compression tool; options: nearest active wall from `walls()`, user price); lane-0 fine columns; `walls()` with `endedBy`, `fill`, `detail.clearedByTrades`; `ladder()`; gates as §0. |
| Feed | aggregated depth + sided tape; equities lose the eaten/pulled split, keep runway and refill. |

**Calculation.** Per column, by the mid's distance to level L in rows:
1. **Approach** (within A = 25 rows): **Defence** D = resting size on L's side
   over rows L … L±W (W = 3, the heatmap cluster); D0 = D at the first approach
   column; added/cancelled/filled on those rows as in Touch Pressure.
   **Runway** R = rows beyond L on the far side until cumulative size reaches
   the instrument's typical one-minute aggressive volume (median of the last
   30 min of column flow), reported as rows and as thin/thick against the
   30 min median runway.
2. **Break** (mid or a trade crosses L for 2 consecutive columns): ≥ 60 % of D0
   left by filling → **eaten**; ≥ 60 % left without trades → **pulled**; D ≥
   70 % of D0 → **held** (a wick). If an engine wall covered L's rows, its
   `endedBy` and `fill` are shown as a second verdict; disagreement is shown.
3. **Follow-through** (60 s): **refill against** = size back on L's rows on
   the broken side as a share of D0; **refill behind** = size arriving within W
   rows on the new near side (the level flipping).

One defence band and one runway scan per column; the level moves only on a
closed bar and is frozen from the first approach column to the end of the
follow-through.

**Noise filter.** Approach opens only at D0 ≥ 1.5 × reference, else "no
visible defence"; splits need ≥ 1 reference of movement; the host-clock wall
`endTs` versus exchange-clock trades (skew up to ~2 s) gets a 3 s tolerance.

**Wording.** Fact: "Defence 67,420: 38 → 9 (24 filled, 5 cancelled) · runway
7 rows (thin, median 15) · refill against 12 % at 60 s". Inference: "likely
genuine break: defence eaten, thin runway, no refill against" or "likely
vacuum: defence pulled (83 % cancelled), nothing was beaten". Three binary
facts (eaten / thin / no refill against) are exposed as outputs for a combined
breakout tool; no score is computed here.

**Live/historical.** Live exact; the Donchian level is replay-safe; replay
verdicts only inside the last 20 min, older breaks show the level and `null`.
Historical policy `["ohlcv","l2_states","l2_walls","l2_prints"]`; a level
deeper than the 10 verified levels is labelled "beyond recorded depth".

**Default view.** Overlay: two level lines; a thin box on the defence rows
coloured by state (grey waiting, amber eaten, blue pulled, green held); a
right-edge label "DEFENCE −76 % · eaten · runway thin". Primary: level source,
approach distance A, follow-through seconds. Advanced: W, thresholds, colours.

**Alerts.** Markers at the break bar: arrow "BREAK · eaten · thin", circle
"BREAK · pulled" (caution), square "REFILL AGAINST ≥ 50 %" inside the window.
Table keeps the last five with the three facts.

**Baseline to beat.** The heatmap ladder's size at the level plus the break
candle. It cannot say whether size left by trading or cancelling, has no
runway, and forgets what stood there before the break.

**Failure modes.** A level between two $4 rows (W absorbs it); engine verdicts
settle 5 s late ("engine verdict pending"); an approach lasting one column
("too fast to judge"); unsided equity volume.

**Effort** M. **Pitch:** tells the breakout trader whether anyone was beaten at
the level, how far the book lets price run, and whether the book refilled
against them, before the retest.

**Overlap.** Flowprint Blocks draws a fast push after the fact with no look at
the level before it; IOB v2 grades walls as zones on 10 s columns with no
approach or runway logic; Absorption draws the opposite outcome. None
distinguishes an eaten defence from a pulled one at a chosen level live.

## 3. Refill Clock (replenishment after a wall is consumed)

| | |
|---|---|
| Question | When a tracked wall is eaten, **how fast and how fully does displayed size return** on its rows? |
| User, decision | Trader holding against a wall: stay while refills are quick and near full; cut when a consumed wall is not replaced within the clock. |
| Inputs | `walls()` diffed by id (`endedBy`, `peak`, `ratio`, `detail.repeats/repeatsComplete`), `events(sinceSeq)` for timing when `complete`, lane-0 fine columns for size on the rows afterwards. |
| Feed | aggregated depth + sided tape (verdicts are the engine's; equities carry the same unsided limit). |

**Calculation.** A wall whose `endTs` turns non-null with `endedBy ∈ {filled,
partial}` opens a **clock**: rows, side, `peak`, `endTs` (host clock, the
columns' clock). Each new column for T = 120 s: refilled share = size on
those rows / peak; record t50, t80 and the share at T. A new wall born on
overlapping rows and side (new id, `repeats`/`chain`) confirms the return. Per
bar: open clocks, latest share, and a rolling 30 min **replenishment ratio**
per side = Σ refilled-at-T / Σ peak over consumed walls.

**Noise filter.** Only walls with `ratio ≥ 2` and `peak ≥ 2 × reference`;
`hit`, `pulled`, `moved` open nothing (nothing was consumed); rows leaving the
column window or a column gap close the clock "unobserved"; a threshold needs
2 consecutive columns.

**Wording.** Fact: "Bid wall 67,200 (peak 52) eaten 14:03:41 · 50 % back in
9 s · 81 % at 120 s". Inference: "likely still defended" (t50 ≤ 30 s and share
at T ≥ 70 %), "likely gone" (share at T < 25 %). No claim about who replaced it.

**Live/historical.** Live exact; replay clocks only for walls ended in the last
20 min; `repeats` shown only when `repeatsComplete`. Historical policy
`["ohlcv","l2_states","l2_walls","l2_prints"]`.

**Default view.** Overlay: a label on the wall's rows at the right edge
"↻ 50 % · 9 s"; ended clocks leave a dot coloured by final share; a two-row
table with the bid/ask replenishment ratio. Primary: clock length T, minimum
wall ratio, show ended clocks. Advanced: t50/t80 thresholds, colours.

**Alerts.** Marker when a clock expires under 25 % ("floor gone") or reaches
80 % within 30 s ("refilled fast").

**Baseline to beat.** The heatmap's run model (a consumed level drawn at its
peak until it ends) and IOB v2's refill counter: neither gives time to refill,
a share at a fixed horizon, or a per-side ratio.

**Failure modes.** Walls that slide a row while worked (clock uses end-time
rows); the 5 s settle delays the start ("from engine verdict"); the 400-wall
wire cap (shown in status); a refill by a different participant is
indistinguishable and the wording never claims otherwise.

**Effort** M. **Pitch:** turns "the wall got eaten" into "and it was 80 %
back nine seconds later", per side.

**Overlap.** Whale Limit Order Heatmap shows large walls' outcomes and
nothing after; IOB v2 counts refills within a life, not the return after
consumption; L2 S/R lists active walls only.

## 4. Sticky Levels (persistence duty cycle and flicker)

| | |
|---|---|
| Question | Which rows near price have **held size continuously**, and which show size that keeps appearing and vanishing without trading? |
| User, decision | Anyone placing stops or targets: lean on sticky rows, discount flickering ones. |
| Inputs | lane-0 fine columns (presence and flow per row), deep columns for presence beyond 20 min (maxima suffice), `walls()` for `repeats`. |
| Feed | aggregated depth; sided tape only for the "without trading" clause (equities: "untraded or unsided"). |

**Calculation.** Rows within ±P = 100 of the mid, counters stored by absolute
row so a moving window costs nothing. Per row, exponentially decayed over H =
30 min: **presence** p = share of seconds the row held ≥ k × reference (k =
1.5); **flicker** f = transitions across k × reference per minute whose shrink
had no trade behind it. **Sticky**: p ≥ 0.8 and f ≤ 0.5/min. **Flicker**: f ≥
3/min and p ≤ 0.5. Per bar: three nearest sticky rows per side, flicker count
per side.

**Noise filter.** k, p, f thresholds; dust rows are never present; a column
gap freezes the counters (no decay through a gap).

**Wording.** Fact: "67,160: present 94 % of 30 min, 2 transitions, 0.6
traded". Inference: "sticky"; "flickering, likely transient". Never "spoof";
the legend says this cannot identify intent or a single participant.

**Live/historical.** Live exact; replay presence from fine and deep columns
("10 s" label), flicker only inside the fine window. Historical: the verified
states hold ten levels; I recommend `unavailableReason` rather than
persistence over ten levels, PM to decide.

**Default view.** Overlay: up to 3 sticky bands per side as thin solid lines
labelled "94 % · 30 m"; flicker rows as dotted ticks. Primary: window H,
persistence share p, show flicker. Advanced: k, P, f thresholds, colours.

**Alerts.** Marker when a sticky row (p ≥ 0.9 for ≥ 20 min) disappears
without trading ("sticky level pulled") or is eaten ("sticky level eaten").

**Baseline to beat.** L2 Support & Resistance (active walls, 10 min lookback):
a wall placed 30 s ago and one that stood all session look alike there.

**Failure modes.** Binance row width changing with price (epoch change resets
counters); thin books where k × reference is tiny; weaker on equities.

**Effort** M. **Pitch:** separates liquidity that stayed from size that only
visits.

**Overlap.** L2 S/R and Whale Heatmap rank by size; Empty Orderbook finds
absence; none measures duty cycle or blinking.

## 5. Impact Runway (depth-to-move band)

| | |
|---|---|
| Question | **How far could a typical burst of aggressive volume move price right now**, up and down, through the displayed book? |
| User, decision | Sizing an entry or stop: thin runway, wider stop or smaller size; asymmetric runway says which way a shock travels. |
| Inputs | `ladder()` (exact top 50 per side), then lane-0 column rows and `view(laneFor(...))` for reach beyond it; column flow for the burst size; gates `status("l2_ladder").synced`, `trusted()`. |
| Feed | aggregated depth; sided tape only to size the burst (understated on equities, stated). |

**Calculation.** Burst B = 90th percentile of per-10-s aggressive volume over
the last 30 min of column flow. On each new ladder, accumulate asks upward
until ≥ B: the price reached is the **up runway**; mirror for bids. If the top
50 hold less than B, continue on column rows and then the wider lane,
labelled "approx." Per bar: min and last of each runway and the up/down ratio.
One walk of ≤ 100 entries per second.

**Noise filter.** B needs ≥ 60 flow samples (10 min); the runway is the median
of the last 5 ladders; dust floor on column rows.

**Wording.** Fact: "A 90th-percentile 10 s burst (2.3 BTC) would reach 67,236
up (+9 rows) / 67,180 down (−5 rows)". Inference: "book thinner above" at
ratio ≥ 1.5. No prediction that the burst comes.

**Live/historical.** Live exact; replay inside the fine window approximated
from banded rows and labelled, else `null`. Historical policy
`["ohlcv","l2_states"]` with "runway beyond 10 levels unknown" when B is not
met.

**Default view.** Overlay: two faint reach lines above and below price moving
with the book, right-edge label with the two row counts. Primary: burst
percentile, burst window seconds, smoothing. Advanced: lookback, colours,
optional ratio pane.

**Alerts.** Marker when one side's runway exceeds 2 × its 30 min median ("air
pocket above/below") or the ratio flips side for ≥ 30 s.

**Baseline to beat.** Cumulative depth within ±0.5 %: a number in coins, not
price distance, blind to the burst the market actually produces and to where
in the band the size sits.

**Failure modes.** Stale (> 5 s) or crossed ladders → `null`; icebergs and
hidden refills make real impact smaller than displayed ("displayed liquidity
only"); on futures 50 levels often exceed B at once, so the band hugs price.

**Effort** S. **Pitch:** the book's thinness translated into price distance,
up and down, for the burst this market actually throws.

**Overlap.** Empty Orderbook boxes thin zones after 2 min; Flowprint Blocks
marks pushes after they happened; Live Order Book Profile shows sizes without
a reach. None converts depth to price distance for a market-sized burst.

## Ranking and recommendation

| Rank | Concept | Why |
|---|---|---|
| 1 | Break Defense Monitor | serves the cross-layer theme, answers a take/skip decision, exposes three plain facts a combined tool can read without a score; M |
| 2 | Touch Pressure | clearest in three seconds; its add/cancel/fill module is the core of #2; S–M |
| 3 | Impact Runway | S effort, portable units, immediately legible; its runway walk is also #2's |
| 4 | Refill Clock | strong question, but tied to engine verdicts and their 5 s settle, and fewer events per hour to show |
| 5 | Sticky Levels | useful, but closest to L2 S/R and the Whale Heatmap, and its flicker rule is the one most likely to be read as spoof detection |

Recommendation: brief the Break Defense Monitor, built on one shared browser
module (per-row add/cancel/fill from 1 s columns plus the ladder runway walk)
from which Touch Pressure and Impact Runway can be released later with little
extra work. Its three outputs (defence eaten, runway thin, no refill against)
are facts, so the OHLCV compression concept can supply the level and the L1
trade-response concept the aggression without any layer needing a combined
score to be useful alone.
