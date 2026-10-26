# Pine editor snapshot (upstream development, received 2026-10-26)

Location: `/home/user/uploads-pine/extract/Terminal-L1-L2-development` (untrusted
upload, kept outside the fork). Live instance: https://pine.beqa.me/.

## What it is

- `apps/web/src/components/pine/` is the editor panel (code editor, inputs
  toolbox, docs panel, replay bar, sign-in, "Prime AI" chat).
- `apps/web/src/lib/pine/` is an in-browser interpreter (`interpreter.ts`,
  2,055 lines) for a JavaScript-flavoured Pine: `const`, arrow functions,
  `input.float(3.5, { title, min, max, step, tooltip })`, `plot(x, { style,
  color })`, `:=` reassignment, `barstate.*`, `ta.*`, `math.*`, `str.*`,
  `color.*`, arrays/maps/matrices, drawing (`line`, `box`, `label`, `bubble`,
  `bookprofile`, heatmaps, polylines).
- Data namespaces beyond candles (from `lib/pine/docs.ts`):
  - `orderflow.buyVolume()`, `sellVolume()`, `barDelta()`,
    `cumulativeDelta(reset)`, `tradeImbalance()`, `tradeVelocity()`,
    `currentBar()`, `largeTrades(minimumSize)`, `microprice()`.
  - `trades.currentBar` (each trade `.timestamp .price .size .aggressor`),
    `trades.status` (`"full"` or not), `trades.at(offset)`, `trades.forBar`,
    `trades.forBars({from,to})`, `trades.between`, `trades.profile(bins)`.
    Loops cap at 10,000 trades per candle; candles older than a week keep
    only their 10 biggest trades.
  - `book.current()`, `book.columns()`, `book.sizeAt(price)`,
    `book.quality()`, `book.imbalance(reach)`, `book.pressure(reach)`,
    `book.stacking(reach)`, `book.pulling(reach)`, `book.absorption()`,
    `book.sweeps(minimum)`, `book.walls(minimumSize)`,
    `book.icebergs(minimumRefills)`; per-minute book snapshots, replay sees
    only finished minutes.
- Scripts are saved per user under `indicators/pine/<user>/*.pine` (the
  owner's folder is `alex/`; 24 scripts under `ivan-kochergat/`).
- `services/pine-trades/`: a Node service recording every Binance aggTrade
  for BTC, ETH, SOL, BNB spot and BTC, ETH perpetual (raw hours gzip, 7 days;
  per-minute summaries 90 days in SQLite), served at
  `https://pine.beqa.me/trades/*`.

## Divergence from the fork

`apps/web/src` differs in 32 files, including core SDK files
(`indicatorRuntime.ts` 194 changed lines, `ChartPanel.tsx` 141,
`indicatorTypes.ts` 21, `indicatorRegistry.ts` 16, `useMarketData.ts` 19)
plus the new editor, `chartScriptExtension.ts` and `editorMain.tsx`. No git
history in the zip, so the merge is a file-level reconciliation.

## Work this opens

1. Pine ports of the finished indicators (Relative Volume by Time of Day,
   Compression Breakout, Size-Split Delta) as `.pine` scripts in the dialect
   above, validated against the TypeScript engines on recorded candles and
   trades. Size-Split needs `trades.currentBar` with `trades.status ==
   "full"` and sizes in provider units; the p98 tier needs a size ring kept
   in a Pine array.
2. Merge the upstream snapshot into the fork so cycle-1 and cycle-2 work
   runs in the editor build, or rebase our indicators onto it.
