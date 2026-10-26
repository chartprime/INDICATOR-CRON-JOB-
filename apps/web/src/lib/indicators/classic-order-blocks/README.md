# Classic Order Blocks

The price-action order block, drawn from the chart's own candles. Named
"classic" to leave the name free for the Institutional Order Blocks indicator
that will read the L2 book instead.

Rectangles on the origin of a move that broke market structure: the last
low before a close above a swing high (a bullish block), or the last high
before a close below a swing low (a bearish block). A `category:
"technical"` indicator on the authoring core (`docs/architecture/indicator-sdk/
TA.01-indicator-authoring-core-evidence.md`), computed from the chart's own
bars, nothing else: no server, no recording, no trades.

The formation rule is ChartPrime's Prime Blocks, read from their
formation-only reference script. That script strips mitigation, overlap and
touch handling on purpose; the choices below are the trader's, made
2026-09-16.

## Formation

1. **A swing.** The primary tier is a `pivotLength`-bar pivot either side
   (`ta.pivotHigh(L, L)`, 7 by default). The secondary tier is a one-bar
   left shoulder and the same `L` bars to the right (`ta.pivotHigh(1, L)`),
   which catches nearly every minor swing; it is tracked always and hidden
   by default (`showSecondary`).
2. **A close through it.** The first closed bar whose close is above the
   swing high (below the swing low) is the break. A wick through is not.
   Because a right-window pivot requires every bar after it to have a lower
   high, the close at confirmation is below the level by construction, and
   the first close above it is necessarily a cross: the "require the close to
   actually cross" decision holds without a separate guard. Breaking structure
   is the one thing that needs a close; mitigation does not.
3. **The origin.** From the swing bar to the break bar inclusive, the
   lowest low (highest high) is the block's base.
4. **The zone.** `widthMultiplier` of the 100-bar simple average candle
   range, up from the base for a bullish block and down from it for a bearish
   one: one full average range by the trader's setting, where the reference
   drew 0.7. Every zone on the chart is the same height at a given moment;
   that is the reference's choice, not the origin candle's own range.
5. **The swing is consumed.** A broken swing never forms a second block. A
   primary break also sets the structure trend, and a secondary block only
   forms in that direction.
6. **The same origin is not drawn twice.** Two breaks in a row with one
   bounce between them read the same extreme as their base, and the second
   zone would sit exactly on the first. While a block of that side and tier
   is still standing on that base, no second one forms there; once it is
   spent, the origin can be a block again. This is not the overlap rule
   below, which is about different zones sharing price.

Nothing forms until the average range has a hundred bars behind it; a break
in that warm-up consumes its swing and draws nothing, as the reference does.

## Break Older Structure

The reference keeps **one** swing per side and per tier: a newer pivot
overwrites the older one, which is then gone for good. In a trend that is
lopsided, and measurably so. A pivot confirms only after `pivotLength` bars
have printed beyond it, so by the time a level can be broken, price has
already travelled a whole pivot window away from it. The trend-following side
breaks its level on the very next leg, while the counter-trend side would have
to retrace that entire window — and the higher levels a real rally would
reclaim have already been discarded. A falling chart therefore fills with
bearish blocks and shows almost no bullish ones. That is the reference
behaving as written, not a fault, and it is why lowering `pivotLength` to 1
makes bullish blocks appear: the stored level is then never more than a bar
old. (At `L = 1` the two tiers also become the same stream, `pivotHigh(1, 1)`,
so every block is drawn twice.)

Every block carries `baseTime`, the candle whose low (or high) set its base;
the Institutional indicator draws the zone from that candle, this one still
from the swing.

`stackPivots` (**Break Older Structure**, on by default) keeps every unbroken
swing instead, up to `MAX_STORED_PIVOTS` (32) per side and tier. A close
consumes every stored swing it has passed and forms **one** block from them,
anchored at the oldest, so a rally that reclaims several descending highs is
a single block whose base spans the whole decline rather than a burst of
nested ones. Levels the close did not reach stay standing and remain
breakable later. Turning it off restores the reference exactly.

## The trader's decisions

- **Mitigation is price closing through the zone.** A block is spent the
  first time a later candle *closes past its far edge*: below a bullish
  block, above a bearish one. A wick through is not enough, and neither is a
  close inside the zone — price sitting on the orders has not broken them, the
  way a wick through a swing is not a break. A close on the far edge itself is
  not through it. The candle that made the block cannot
  spend it: its base is read from that candle's own extreme, so the zone
  contains it by definition, and mitigation is judged from the next bar on. A
  mitigated block stops extending at the bar that spent it and is hidden by
  default (`showMitigated`). Shown, it reads as spent rather than live: a
  fifth of the border and a fraction of the fill an active block gets.
- **Overlapping blocks are both kept.** A primary and a secondary break on
  the same bar are two blocks, at the same base if the swings share one.
  Different zones that share price never merge. (The one exception is
  formation rule 6: the same zone twice, on the same side and tier.)
- **The break requires the close to cross**, which formation step 2 shows is
  a property of the pivot definition itself.

## Bounds

- `MAX_ORDER_BLOCKS` (200, the reference's `max_boxes_count`): the newest
  200 blocks are kept and drawn, on 200 box handles created once in
  `createState` and reused, the way `market-structure` reuses its slots.
- `MAX_STORED_PIVOTS` (32): unbroken swings held per side and tier. The
  oldest is dropped past that.
- `MAX_PIVOT_AGE_BARS` (500): the bars a block's base can be read from. A
  swing older than that at its break forms nothing; the break still counts
  for the trend.
- A closed bar the tracker has already seen is ignored, so a bar delivered
  open and then closed, or replayed, forms one block and not two.

## Files

| File | What lives there |
| --- | --- |
| `orderBlockRules.ts` | The settings, their schema and defaults, the constants, the zone geometry, and the break and mitigation rules. Pure. |
| `orderBlockTracker.ts` | The state machine: the unbroken-swing stacks, trend, formation and mitigation over closed bars, bounded. Pure, takes pivot values as inputs. |
| `orderBlockRender.ts` | Blocks onto box handles: which are shown, where each ends, its colours. |
| `classicOrderBlocks.ts` | The `RuntimeIndicatorDef`: the `ta` streams, the closed-bar gate, the handles. |

**Every setting asks for a replay.** The runtime restyles a cosmetic change
through a line output's `recolor`, and this indicator has no lines, so the
cosmetic path finds nothing to do and returns without repainting: a toggle
would then sit unapplied until the next bar arrived or a timeframe change
forced a replay. Declaring every field `recompute` is what makes a toggle take
effect at once. It is safe because `withDrawOwnerScope` clears the owner before
`createState` runs, so the rebuilt state's 200 boxes replace the previous
generation instead of joining it.

## Tests

```
npm test -- src/lib/indicators/classic-order-blocks
```

The rules and the tracker are tested as pure functions with pivots injected,
including a falling-market fixture that pins what the stack changes and what
the reference does instead, and the double-break shape the trader circled on
BTC 5m; the indicator is tested through `onBar` with real pivot streams, the
draw registry, live-candle replacement and the shared `replayBars` harness.
