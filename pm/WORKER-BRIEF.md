# Worker brief: building an indicator for Terminal-L1-L2

You are one of several worker agents. A project manager (PM) agent assigned you
exactly one indicator, named in your task prompt. Build it completely: code,
settings schema, tests, registry entry, Historical Mode policy, and a short doc
page. Commit on your own branch in your own worktree. Do not push. Do not ask
the PM questions; make a sensible decision, write it down in your report.

## Repository and environment

Repository root (the PM's checkout): `/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk`
You work in a separate git worktree of that repository; your task prompt or your
shell's working directory tells you where. Everything below is relative to your
worktree root.

The project pins Node 24.21.0. Before running anything:

```bash
export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH
node --version   # must print v24.21.0
```

Dependencies are installed only in the PM's checkout. Link them into your
worktree once (they are gitignored, so the links never enter a commit):

```bash
ROOT=/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk
ln -s $ROOT/node_modules ./node_modules
ln -s $ROOT/apps/web/node_modules ./apps/web/node_modules
```

Commands you will use (run from the worktree root unless noted):

| Purpose | Command |
|---|---|
| Your indicator's tests only | `cd apps/web && npx vitest run src/lib/indicators/<folder>` |
| Tests that enumerate the registry | `cd apps/web && npx vitest run src/lib/chart src/components` |
| Whole web suite (do this once before you finish) | `cd apps/web && npx vitest run` |
| Type check | `cd apps/web && npx tsc -b` |
| Web lint | `cd apps/web && npx oxlint` |
| Repo lint | `npx eslint .` |
| Docs check | `node scripts/validate-docs.cjs` |

All of these must pass before you commit. The runtime (jest) suite and the
Python conversion suite are unaffected by indicator work; skip them.

## Read these first, in this order

1. `docs/architecture/indicators/data-for-indicator-authors.md` (the rules every indicator follows)
2. `apps/web/src/lib/chart/indicatorTypes.ts` (the authoring contract: `RuntimeIndicatorDef`, `IndicatorBarCtx`, `SettingsFieldSchema`, `PlacementSpec`)
3. `apps/web/src/lib/chart/indicatorRegistry.ts` (where you register, and `HISTORICAL_INDICATOR_POLICIES`)
4. `docs/architecture/indicator-sdk/TA.01-indicator-authoring-core-evidence.md` (execution model: incremental `onBar`, `replace`, replay, fault latching)
5. `docs/architecture/indicator-sdk/TA.02-ta-math-library-evidence.md` and `apps/web/src/lib/chart/ta/index.ts` (the `ta.*` factories: create them once in `createState`, never in `onBar`)
6. `docs/architecture/indicator-sdk/TA.03-plotting-rendering-wrapper-evidence.md` (`ctx.draw.fill`, `ctx.markers.plotshape/plotchar`, `draw.line/box/label/table` handles)
7. `docs/architecture/indicators/setting-presets.md` (every setting key must be in the schema, `step > 0` for numeric fields)
8. Reference indicators: `apps/web/src/lib/indicators/rsi/rsi.ts` and its tests (simplest SDK indicator); `apps/web/src/lib/indicators/large-trade-bubbles/largeTradeBubbles.ts` (markers plus `tradeAvailability` gating); `apps/web/src/lib/indicators/vwap-bands/vwapBands.ts` and its tests (reading the tick store through `ctx.ticks`, and how tests fake it); `apps/web/src/lib/indicators/l2-feed-status/l2FeedStatus.ts` (reading `ctx.l2`)
9. The test harness `apps/web/src/lib/chart/replayBars.ts`

## What you deliver

1. **One folder** `apps/web/src/lib/indicators/<folder>/` owning the whole
   indicator: pure computation in its own module, the `RuntimeIndicatorDef` in
   `<name>Indicator.ts` (or `<name>.ts` for a simple one), and `tests/`.
2. **Registration**: add the import, append the def to the end of
   `INDICATOR_REGISTRY`, and append an entry to the end of
   `HISTORICAL_INDICATOR_POLICIES`, both in `apps/web/src/lib/chart/indicatorRegistry.ts`.
   Append, never insert in the middle: several workers edit this file and the
   PM merges the branches.
3. **Historical Mode policy** that is honest: `OHLCV_POLICY` for candle-only
   math, `CANDLE_FLOW_POLICY` when you read buy/sell sides, and an
   `unavailableReason` sentence for anything that needs live ticks or the live
   order book. Never fabricate a value a candle archive does not contain.
4. **Settings schema** (`settingsSchema`) covering every key in
   `defaultSettings`, with sensible `min`/`max`/`step`, `affects` set correctly
   (`recompute` for anything that changes the math, `cosmetic` for colors), and a
   `staticHint` explaining the data the indicator needs when it is live-only.
   `apps/web/src/components/tests/indicatorPresetInputs.test.ts` fails if a
   settings key is missing from the schema.
5. **Tests** in `tests/`: exact hand-computed values for the math, `replace:
   true` semantics (a revised forming bar does not corrupt committed state),
   empty input, insufficient warm-up giving `null` (never `NaN`), and the
   data-availability gates (an unavailable source yields `null`, not zero).
   Use `replayBars` for bar sequences and a hand-built ctx for `replace` cases,
   as `rsi/tests/rsi.test.ts` does.
6. **A doc page** `docs/architecture/indicators/<name>.md`: what it computes,
   the data family it reads, units, what happens when the data is missing,
   settings and defaults, and how a retail trader reads it. Add one row to the
   "Documentation map" table in `docs/architecture/indicators/README.md`. Keep
   links relative and valid; `node scripts/validate-docs.cjs` checks them.
7. **One commit** on your branch, message in the imperative, describing what the
   indicator does. Use `git -c user.name="Worker" -c user.email="worker@chartprime.local" commit`.
   No model names anywhere in the commit or code.

## Rules that are not negotiable

- Read buy/sell through `barSides` (`apps/web/src/lib/indicators/barSides.ts`).
  Never compute sell as `volume - buy_volume`. A bar `barSides` reports as not
  `known` draws no delta (`null`), not zero.
- `missing` is not `empty`. Unavailable data yields `null`; a quiet bar with
  complete data yields the real value (which may be 0).
- Tick-based indicators read `ctx.ticks` (declare `ticksWanted: true`) and must
  check `ticks.coverageOf(bar.ts_open, bar.ts_open + bar.interval_ms)`:
  `"all"` is complete, `"thin"` means only large prints are present, `"none"`
  means nothing. Anything that counts or sizes trades is valid only on `"all"`.
  `ctx.trades` with `tradeAvailability === "LIVE_COMPLETE"` is the per-bar
  alternative when you only need the forming bar's prints.
- Order-book indicators read `ctx.l2`. Output `null` unless
  `l2.availability === "LIVE"`, `l2.trusted()` is true and the channel you read
  reports `synced`. Check `apps/web/src/lib/chart/indicatorL2.ts` and
  `apps/web/src/lib/l2/types.ts`.
- Quantities stay in provider units (Binance base asset, futures contracts,
  equity shares). Label them; never convert to a notional the provider did not
  report, except the documented Binance `price * size` USD notional.
- Gate on capabilities and availability, never on `provider === "..."`, except
  to label units (as `largeTradeBubbles.ts` does).
- Incremental only: `onBar` nudges state forward one bar; never rebuild history
  from an array. Respect `replace` (a forming bar revised in place). `ta.*` and
  `draw.*` factories are created once in `createState`.
- Fail closed to `null`. Never emit `NaN` or `Infinity`; the runtime latches
  the indicator as faulted.
- Match the surrounding code style (2-space indentation, double quotes,
  trailing commas, `readonly` where the codebase uses it). Do not reformat lines
  you did not change. No new dependencies.
- Touch only: your folder, `indicatorRegistry.ts` (append only),
  `docs/architecture/indicators/README.md` (one table row), your doc page, and
  `indicatorPresetInputs.test.ts` only if you must list a key in
  `NOT_IN_SDK_PRESETS` (prefer not to).

## Quality bar

The owner's goal is "top grade, very useful and marketable indicators for
retail traders." That means: defaults a trader can use without reading docs,
a label a trader recognizes, colors that read at a glance (bullish green
`#26a69a` / bearish red `#ef5350` are the house pair; neutral `#d1d4dc`),
honest nulls during warm-up, and a settings dialog that exposes what traders
actually tune. Prefer one excellent indicator over two mediocre ones.

## Your report back to the PM

End with a short report containing: branch name, worktree path, files
added/changed, the exact test and lint commands you ran with their pass/fail
counts, every design decision you made that the brief left open, and anything
you could not verify (for example, live rendering, which no worker can see).
