# TA Math Library (TA.02)

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

A real technical-analysis standard library for indicator authors, so a
new indicator no longer means hand-writing a formula the way RSI/EMA/
Bollinger/SMA had to be as `TA.01`'s own proof. Wraps `trading-signals`
(bennycode, MIT, pinned exact at `8.3.0`), the only file in `apps/web`
that imports it directly is `lib/chart/ta/index.ts`.

## Files

- `apps/web/src/lib/chart/ta/stream.ts` — `Stream<TIn, TOut>` (`push(value,
  replace): TOut | null`) and `wrapTradingSignal`, the one generic adapter
  forwarding to any wrapped indicator's own `update(value, replace)`.
- `apps/web/src/lib/chart/ta/creationGuard.ts` — the persistence-footgun
  guard: a nest-safe creation-window depth, checked by every factory. A
  mistaken factory call warns once per factory rather than flooding the
  browser console while historical bars replay.
- `apps/web/src/lib/chart/ta/stdev.ts` — the one real gap in the library
  (no dedicated streaming standard deviation class): a fixed-window
  population-stdev stream with a bounded ring buffer and stable running
  moments.
- `apps/web/src/lib/chart/ta/helpers.ts` — `highest`, `lowest`, `prev`,
  `crossover`, `crossunder`, each a small stateful tracker taking one
  value per bar. `highest`/`lowest` use monotonic queues, and `prev` a
  bounded ring buffer, so no helper re-derives from a full history array.
- `apps/web/src/lib/chart/ta/index.ts` — the `ta` object: one factory per
  wrapped indicator (`sma`, `ema`, `wma`, `rma`, `vwma`, `alma`, `rsi`,
  `macd`, `stoch`, `cci`, `roc`, `mom`, `atr`, `bollinger`, `keltner`,
  `adx`, `psar`, `vwap`, `obv`, `mfi`), plus the 5 helpers.
- `apps/web/src/lib/chart/indicatorRuntime.ts`,
  `apps/web/src/lib/chart/replayBars.ts`,
  `apps/web/src/components/chart/ChartPanel.tsx` — the three files that
  call `createState()`. Each wraps that call in
  `withStreamCreationWindow(...)` so the guard can tell a legitimate
  creation from a misuse. All three go through the one shared wrapper
  rather than toggling the flag by hand, so a fourth call site cannot
  half-implement it: an unwrapped one makes the guard fire on correct
  code, which is what the `replayBars` regression test pins.

## Usage

`ta.*` factories are plain top-level imports, called once inside an
indicator's own `createState()` and stored on its own state object — not
namespaced under `ctx`, since `createState(settings): S` (`TA.01`'s own,
unmodified contract) takes no `ctx` argument to hang a factory off. This
matches how RSI/EMA/Bollinger/SMA already build their own internal state
today; `ta.*` just replaces hand-written math with a wrapped library call
where an author wants it, e.g. `createState: () => ({ rsi: ta.rsi(14) })`,
then `onBar: (ctx) => { state.value = state.rsi.push(ctx.bar.close,
ctx.replace); }`.

A stream created inside `onBar` instead — a fresh instance every bar,
never warming up — triggers a `console.error` naming the factory, and
still returns a working (if permanently cold) stream rather than
crashing, so the mistake produces obviously-wrong output instead of a
plausible-looking one.

## Adapter shape

One generic wrapper covers every indicator regardless of its own input
or result shape, since `trading-signals`' base `Indicator<Result, Input>`
contract is already generic over both and already exposes
`update(input, replace): Result | null` directly — the exact `push(value,
ctx.replace)` shape needed, confirmed against the installed package's own
shipped declarations rather than assumed. A plain-number input (`sma`),
an OHLC-object input (`atr`, `adx`, `cci`, `mfi`, `keltner`, `stoch`), a
high/low-only input (`psar`), and an OHLCV input (`vwap`, `obv`, `vwma`)
are all wrapped through the same `wrapTradingSignal`, with the specific
shape enforced by each factory's own TypeScript signature rather than by
the adapter. `macd` constructs its own internal `EMA` legs (the
library's own constructor takes pre-built moving-average instances, not
plain period numbers).

## Standard deviation

The library has no dedicated streaming stdev class (`MAD`, `IQR`, and
`RogersSatchellVolatility` exist in its volatility category; none is a
plain population stdev). `ta.stdev(length)` is the one hand-rolled
exception. Its committed/tentative split means a `replace:true` push is
recomputed against the same committed baseline without mutating it.
Stable running moments make each normal update constant-time without
subtracting large price-scale squares; retained memory remains bounded by
`length`.

## TA.02b — coverage extension (~35 more, curated)

`trading-signals` ships roughly 130 indicator classes total, verified by
listing every `export declare class` across its own shipped `.d.ts`
files, not its README. `TA.02` wrapped the 20 indicators explicitly
requested; this extension adds 36 more genuinely standard, recognizable
ones — not a count-inflating sweep of everything available. Roughly 75
further classes are deliberately left unwrapped: niche/academic tools
easy to misconfigure into a misleading plot, and the library's own
internal structural helpers that overlap `TA.02`'s own `highest`/
`lowest`/`prev`. Adding any excluded one later is one line plus a test,
not a technical limit.

Added, by category, each verified against the installed package's own
shipped declaration before wrapping (two composite constructors —
`SuperTrend`, `IchimokuCloud` — take a single destructured config object
rather than positional args, matching `keltner`/`stoch`'s own existing
precedent):

- **Trend**: `hma`, `tema`, `dema`, `superTrend`, `ichimoku`, `aroon`,
  `zigzag`, `kama`, `vortex`, `linreg`.
- **Momentum**: `williamsR`, `ao`, `ultimateOscillator`, `trix`, `cmo`,
  `fisherTransform`, `stochasticRsi`, `elderRay`, `dpo`, `kst`, `ppo`.
- **Volatility**: `donchian`, `cvi`, `ulcerIndex`, `ttmSqueeze`, `natr`, `tr`.
- **Volume**: `cmf`, `ad`, `kvo`, `nvi`, `pvi`, `emv`, `forceIndex`, `pvo`, `adosc`.

No changes to `stream.ts`, `creationGuard.ts`, `stdev.ts`, `helpers.ts`,
or `indicatorRuntime.ts` — purely additive registration against the
already-generic adapter, exactly as scoped. `trading-signals` still
imported from exactly one file.

Three indicators with a real, historically variable convention were
spot-checked directly against a live run rather than assumed correct by
name: `williamsR` returns the textbook `-100..0` range (not inverted),
`ppo` returns a percentage (`5.35`, not `0.0535`) unlike `roc`'s own
decimal-ratio convention, and `cmo` returns the textbook `-100..100`
range. All three matched textbook form — no new deviation to record
alongside the two already documented above.

`linreg` intentionally exposes the library's structured
`{ prediction, slope, intercept }` result, rather than disguising it as a
single number. `emv(length, scale?)` also exposes its documented scale:
the library default is 100,000,000, so authors working with crypto or
smaller-volume instruments can choose a sensible unit. `kst(config?)`
accepts the library's full ROC/SMA-period configuration instead of being
restricted to its defaults.

No indicator in this batch is migrated onto or exposed through a
registered chart indicator (`indicatorRegistry.ts` is untouched) — this
extension is the `ta.<name>(...)` math layer only, callable by any
future indicator author, the same way the original 20 already were.
Building an actual chart-registered indicator on top of any of these
(colors, settings schema, line placement, and for `ichimoku` specifically
a forward-displaced plot the current `ctx` has no primitive for) is
deliberately out of scope here.

## Verification

Every wrapped indicator has a test proving the adapter's own wiring —
exact hand-computed values for the plain single-value indicators (`sma`,
`ema`, `rsi`, `mom`, `roc`), input-shape and stability sanity for the
composite/OHLC ones (`atr`, `bollinger`, `macd`, `stoch`, `keltner`,
`adx`, `psar`, `vwap`, `obv`, `mfi`, `vwma`, `wma`, `rma`, `alma`, `cci`,
and the 36 added in the coverage extension above) — not a re-proof of
the upstream library's own, separately-tested math. Two library-specific
conventions were verified directly rather than assumed and differ from
`TA.01`'s own hand-written EMA/ROC: this library's `EMA` seeds from the
first value directly (not an SMA seed), and `roc` returns a decimal
ratio (`0.1`), not a percentage (`10`).

The 5 helpers each have exact-value and live-replace-semantics tests, plus
degenerate-argument tests: a zero, negative or fractional length fails
closed to `null` rather than leaking `NaN`, `±Infinity` or `undefined`
into a chart series.

The persistence-footgun guard is pinned from three directions, because
guarding only the obvious path is what makes this class of guard
useless. A fake indicator that (wrongly) creates a stream fresh inside
`onBar` logs the loud warning and produces an always-null output (never
warms up), paired with the same indicator built correctly producing real
output and no warning. Separately, every key exported on `ta` — all 62
now, up from the original 26, enumerated against `Object.keys(ta)` so a
newly added factory cannot skip the check — is asserted to warn, naming
itself, when called outside a
creation window, and to stay silent inside one. Finally, `replayBars`
(the harness every migrated indicator's own suite runs through) is
asserted not to trigger the guard for a correctly authored indicator.

`apps/web`: 73 test files, 1,163 tests. `apps/runtime`: 99 suites, 2,688
tests (unaffected, run as part of the full repo check). Production
TypeScript build green. Lint clean, one pre-existing warning unrelated to
this work. `trading-signals` confirmed imported from exactly one file.

## Not yet built, by design

No existing indicator (RSI/EMA/Bollinger/SMA) is migrated onto this
library — they stay exactly as `TA.01` left them; this ticket is the
library itself, not a migration. `ctx.draw`/`ctx.markers` remain `TA.03`'s
job. The library's own `getRequiredInputs()`/`getResultOrThrow()` are not
exposed through the adapter — every factory here only needs `push`/
`getResult`'s null-safe contract.
