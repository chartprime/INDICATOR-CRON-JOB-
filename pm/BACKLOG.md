# Backlog (PM)

Objective: tools that answer a specific trading question, reveal something
useful, and make sense within seconds of opening the chart.

Repository: `/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk`,
branch `main`, import commit 6ec87d3, 44 indicators registered, baseline web
suite green (351 files, 5170 tests).

## Cycle 1 (complete)

| Step | Owner | State |
|---|---|---|
| Capability sheet | PM | done (`CAPABILITIES.md`) |
| Charter, pipeline, rubric, Codex gates | PM | done (`CHARTER.md`, `codex/`) |
| Ranked concepts | Researcher | done (`cycle1/research.md`, 14 concepts, 7 workflows) |
| 5 concepts each (OHLCV, L1, L2), breakout theme offered | specialists | done (`cycle1/concepts-ohlcv.md`, `concepts-l1.md`, `concepts-l2.md`) |
| UX standard: default view, primary vs advanced controls, colors, copy | UX | done (`cycle1/ux-standard.md`, Advanced group merged to main, 7 screenshots) |
| Validation protocol and fixture harness | Validator | v1 merged (`cycle1/validation-protocol.md`, `apps/web/src/lib/chart/validation/`); Codex fix round in progress |
| Shortlist 3, brief 1, G1 Codex plan review | PM + Codex | done (`cycle1/scoring.md`, `cycle1/brief-rvol-clock.md`; 5 Codex rounds, PM-approved) |
| Build, UX pass, G2, validation, G3, fixes, merge, package | team | DONE: Relative Volume (Time of Day) merged to main; package `cycle1/package-relative-volume.md`; cycle report `log/cycle-1-report.md` |

## Seed concepts the PM already holds (feed into scoring, not pre-approved)

OHLCV: Supertrend, MACD, Relative Volume (time-of-day baseline), TTM Squeeze,
auto-anchored VWAP from latest swing high/low, per-bar delta histogram with
unsided share, compression-then-breakout context.
L1: Tape Speed with burst detection, CVD by trade size (whale versus retail
flow), market sweep detector, price response per unit of aggressive volume.
L2: Order Book Imbalance (bar-averaged), persistent liquidity near price,
pull/stack detector from `l2.events()`, microprice deviation, spread monitor,
replenishment rate after a wall is eaten.

## Rejected

(none yet)

## Cycle 2 (proposed)

- Squeeze Breakout Context (OHLCV, cross-layer anchor) and Size-Split Delta (L1) in parallel; then Break Defense Monitor (L2).
- Deferred from cycle 1: weekend slot family for crypto RVOL; sustained-run marker; `clear` on draw.table; Pine version once the editor source arrives.

## Cycle 2 (in progress)

| Step | Owner | State |
|---|---|---|
| Browser-direct Binance mode (test link) | Platform/Web | DONE: merged to main; link at version 4 (4 Codex rounds, 9 findings fixed) |
| Binance spot URL overrides (stage A) and REST candle transport (stage B) | Platform | DONE: merged to main (4 Codex rounds, 10 findings fixed); stage B2 aggregate trades and stage C depth remain behind capability contracts |
| VPS test host recipe | PM | done (`ops/test-host-recipe.md`) |

## Harness debt

- fakeL2 snapshot-only walls: expire `absorbing` once the snapshot's age exceeds `ABSORB_WINDOW_MS`, or record the last trade timestamp with snapshots (Codex G2 round 3, 2026-10-26). Due before the first L2 indicator validation loop.
