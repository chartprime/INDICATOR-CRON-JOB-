# Cycle 1 scoring and shortlist (PM, 2026-10-26)

Rubric from CHARTER.md: usefulness x2, clarity x2, differentiation, feasibility,
speed, marketability, each 1 to 5. Overlapping proposals were combined first.
Sources: cycle1/research.md (14 concepts), concepts-ohlcv.md, concepts-l1.md,
concepts-l2.md (5 each).

| Concept (combined from) | Use x2 | Clar x2 | Diff | Feas | Speed | Mkt | Total |
|---|---|---|---|---|---|---|---|
| Relative Volume by Time of Day (OHLCV 2, research 1, 9) | 8 | 10 | 3 | 5 | 4 | 4 | 34 |
| Squeeze Breakout Context (OHLCV 1, research 2 OHLCV part, 12, 5) | 10 | 8 | 4 | 4 | 3 | 5 | 34 |
| Size-Split Delta (L1 1, research 10) | 8 | 10 | 4 | 4 | 4 | 4 | 34 |
| Touch Pressure (L2 1, research 3) | 8 | 8 | 5 | 4 | 4 | 4 | 33 |
| Daily Range Budget (OHLCV 3) | 6 | 10 | 3 | 5 | 5 | 3 | 32 |
| Break Defense Monitor (L2 2, research 2 L2 part, 11) | 10 | 6 | 5 | 3 | 2 | 4 | 30 |
| Breakout Tape Confirmation (L1 3, research 2 L1 part) | 8 | 8 | 4 | 3 | 3 | 4 | 30 |
| Effort versus Result (OHLCV 4) | 6 | 8 | 3 | 5 | 5 | 3 | 30 |
| Impact Runway (L2 5) | 6 | 8 | 4 | 4 | 4 | 3 | 29 |
| Wall Reliability Scorecard (research 6) | 6 | 8 | 5 | 3 | 4 | 3 | 29 |
| Breakout Acceptance Meter (research 5) | 6 | 8 | 3 | 5 | 4 | 3 | 29 (folds into Squeeze Breakout failure/acceptance later) |
| Flow Impact / Price Response (L1 2, research 4) | 8 | 6 | 4 | 4 | 3 | 3 | 28 |
| Refill Clock (L2 3, research 11) | 6 | 6 | 4 | 3 | 3 | 3 | 25 |
| Trend Quality Gauge (OHLCV 5) | 6 | 8 | 3 | 5 | 5 | 2 | 29 |
| Intrabar Delta Reversal (L1 4) | 6 | 8 | 3 | 4 | 5 | 2 | 28 |
| Burst Detector (L1 5, research 8) | 6 | 8 | 3 | 4 | 5 | 3 | 29 |
| Sticky Levels (L2 4) | 6 | 6 | 3 | 3 | 3 | 3 | 24 |
| Spread and Top-of-Book Stability (research 7) | 6 | 8 | 3 | 4 | 5 | 2 | 28 |
| Bar-Averaged Book Imbalance (research 13) | 4 | 8 | 1 | 4 | 5 | 2 | 24 (kept only as a baseline) |
| Market Sweep Detector (research 14, PM seed) | 4 | 6 | 2 | 3 | 4 | 2 | 21 (rejected: Flowprint Blocks and Aggressive Orders cover it) |
| Supertrend, MACD (PM seeds) | 4 | 8 | 1 | 5 | 5 | 3 | 26 (rejected for this lineup: direction tools every platform has) |

## Shortlist (three)

1. **Relative Volume by Time of Day** (OHLCV). Works live and in Historical
   Mode on every instrument, clear in one glance, and it is the baseline the
   charter says every volume claim must beat. It later becomes the volume
   confirmation inside the breakout tool.
2. **Squeeze Breakout Context** (OHLCV, cross-layer anchor). Defines the
   compression box, the level and the break event that the L1 tape tally and
   the L2 Break Defense Monitor attach to in later cycles.
3. **Size-Split Delta** (L1). The tape concept with the most reproducible
   candle-beating evidence and no dependency on another layer.

Next in line: Touch Pressure (L2) and Break Defense Monitor (L2 flagship once
the breakout anchor exists).

## Built in cycle 1: Relative Volume by Time of Day

Why this one and not the flashier two: cycle 1 is the benchmark for the whole
process (brief, Codex plan gate, build, UX pass, Codex code review, validation
with the new harness, Codex challenge, package). The indicator chosen should
exercise every step without the math itself being the risk. It runs in both
modes, so replay-versus-live equivalence and screenshots from fixtures are
testable; its baseline comparison is crisp and labelled; both the researcher
(rank 1) and the OHLCV specialist (rank 2) named it; and the two flagship
concepts need it as their volume input.

## Rejected or parked, with reasons

- Market Sweep Detector: covered by Flowprint Blocks and Aggressive Orders.
- Supertrend, MACD: commodity direction tools; no differentiation.
- Bar-Averaged Book Imbalance: kept only as the baseline Touch Pressure must beat.
- Sticky Levels: too close to L2 S/R, and its flicker rule invites a spoofing reading the data cannot support.

## Capability gaps raised by the specialists (PM decisions pending)

- No top of book in `IndicatorBarCtx` (BookFrame exists on the wire). Decision: not needed for cycle 1; revisit with Spread and Top-of-Book Stability.
- dxFeed servers drop unsided equity prints before the browser; a quote-rule side estimate would be a runtime change. Decision: raise to the owner; indicators show "tape covers N percent of volume" meanwhile.
- `L2ColumnView` lacks flow and `reference`; flow math must read lane 0 through `ctx.liquidity.feed`. Recorded in CAPABILITIES.md for cycle 2.
- Historical L2 states hold ten levels at 1 s; depth concepts are capped there in Historical Mode.
