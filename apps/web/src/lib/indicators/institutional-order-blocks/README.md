# Institutional Order Blocks

A candle order block graded by the book, live. The zone geometry is the
Classic Order Blocks one — same swing, same break, same base, same width — and
the L2 columns say whether a wall stood in it, whether it was hit, and whether
it is still there. Nothing here invents a zone; `classic-order-blocks` remains
the only place a zone is born.

`category: "l2"`. It reads the resting book through `ctx.liquidity`, so it is
inert on an instrument with no L2 feed rather than wrong. The two indicators
never talk: this one runs its own copy of the classic tracker on the same
settings, so the zones are identical by construction.

Built from `Trading indicators/institutional-order-blocks-plan.md`, redrawn on
2026-09-17 to the trader's rule: absolute sizes per instrument, no relative
tests, and a grade that can go down as well as up.

## What a zone says

Each zone is a rounded band in its own colour -- teal for a bullish block,
rose for a bearish one; the words say only the grade and "OB", the colour
says the side -- solid where the book backed it, fainter where it did not, and
hollow where the book could not be read. A live band runs on past the last
candle to the price axis; a spent one stops where it was spent. Where
something is drawn against the axis -- the heatmap's ladder, the Volume
Profile OHLC -- a live band stops where that begins, a small gap short
of it, and never runs under it: the chart's draw kernel keeps that room for
every box that extends right (`setRightInset`, fed by ChartPanel from
`lib/chart/axisInset.ts`), so the words are never written over a profile.
The ladder's room is the width it actually draws, which the heatmap reports
(`ladderWidthPx`: its reach held to the free space right of the last candle,
never under the label strip), not the width its setting asks for.
The words sit inside the band, on one line, right-aligned a padding in from
its right end and centred on it, with no card behind them (`NO_CARD` is a
transparent backing: the kernel insets text by its padding only when it has
one). The ink is dark (`ZONE_TEXT`) on the light Live chart and light
(`ZONE_TEXT_ON_DARK`) on the dark Historical Mode chart: ChartPanel tells the
draw kernel the chart is dark (`setDarkChart`) and the kernel takes the box's
`textColorOnDark` there. Each ink reads at 4.5 : 1 or better on every grade's
fill over its chart. A band thinner than one line of the words carries none:
the kernel drops a form taller than its box when the words sit inside it, so
the words never spill over the candles. There was a dark card with the zone's
colour down its edge until 2026-09-28; the trader had it removed. Where two
zones sit on each other, the one that reads on top -- the strongest -- is
painted last, each still at its own level: words are never moved off their
band to clear others (`keepTextClear` is off; zoomed out it once turned
five near zones into a ladder of labels beside the axis). A line too wide
for its band drops facts from the right until it fits -- the delta first,
then what traded, then the wall, never the grade -- and a zone with no room
even for its grade is a bare band.

```
Strong OB · 52.0 BTC
Traded 41.0 BTC · +18% Delta
```

Each number is stamped with its time by its word:

- **wall** — the biggest band of rows touching the zone on the zone's side,
  the band's rows summed, **as it stands now**, re-read once per closed bar.
  A band is `bandRows` adjacent rows starting at a multiple of that width,
  exactly the cluster the heatmap draws and labels at that width, so the card
  and the ledger read the same number. The width is the second indicator's
  per-instrument default (BTC 4, ETH 8, NQ 12, ES 3, AAPL 8, NVDA 5, TSLA 6)
  or the setting.
- **traded** — everything that has changed hands in the zone's rows from the
  opposing side since the swing, wall or no wall: the formation, the break and
  every retest since. Cumulative for as long as the zone lives; a new block at
  the same prices later starts from zero.
- **delta** — net signed flow over the leg from the base bar to the break, in
  the zone's direction. The impulse; fixed with it.

**A zone drawn over the whole of another is not drawn at all.** Two zones
whose prices nest are one level read twice, so only the better-graded of them
is kept, and the newer when they are graded alike. Zones that merely cross
keep both: they are two levels.

**Where zones overlap, the strongest reads on top.** The draw kernel paints a
slot at a time, so the zones are laid into the slots weakest first: a spent
block furthest back, then unverified, rejected, weak, and strong in front.
Equal grades keep their formation order, which puts the newest of them
forward, except among unverified zones, where the older is in front: a
newer one has read nothing the older has not (the trader's rule, 2026-09-28,
against the ladder of unverified cards a zoomed-out chart made). Without
this the newest zone covered whatever it overlapped, and a strong zone could
sit behind a rejected one drawn a minute later.

**A zone starts at the candle that set its base**, `baseTime` on the classic
block (the lowest low, or highest high, between the swing and the break),
not at the swing itself: drawn from the swing it floated ahead of the candle
it came from, sometimes by many bars. The classic indicator still draws its
own zones from the swing.

A zone whose wall has gone says `Weak OB · wall gone (was 52.0 BTC)` —
the "was" is the largest it stood at; one that stood, had too little traded
into it and left says `Rejected OB · wall pulled (was 52.0 BTC)`; one
with no wall says only `Rejected OB · no wall stood here`. A zone the
book could not be read for is an outline that says why:
`Unverified OB · book not reached`, `book still printing`,
`older than the recording`, `no book recorded`, or
`recording gap 13:37–14:00 UTC` (below).

The first build let traded volume accumulate for the zone's whole life and
printed the wall at its largest beside it. On zones alive seventeen hours that
read `wall 420 · hit 421` when the 421 had traded through a 130 wall four
hours before the 420 stood, and any zone that lived a few hours cleared the
hit size on age alone. Now the two lines cannot be read as one event.

## A zone the page's columns do not reach

The page holds the book for the last hours only. A zone formed before that
is read from the host's stored heatmap columns (`/heatmap/columns`, the same
pyramid the heatmap history paints from) over the zone's own window: three
minutes before the swing to one bar after the break. Until 2026-10-03 it
asked the host to replay its raw recording (`band_history`); those reads took
45 to 70 s each and timed out, so old zones stayed at `book not reached`.

- **Level by window length.** 10 s columns up to two hours, 30 s up to six,
  one minute beyond. One minute is the coarsest the reader takes, since a
  longer step reads as a hole (`HOLE_MS`), and a wall's age starts again
  after a hole. A coarser cell is the largest size
  seen in it, so a wall that flickered inside a minute reads as standing
  through it.
- **Only the zone's rows are kept.** A page is cut to the zone's rows as it
  arrives and dropped, and one page fills every waiting zone it overlaps.
- **Bounded.** Newest zone first, one request in flight, 60 a minute inside
  the 90 a minute it shares with the column streams, 256 zones at most.
- **Older than the recording.** The host keeps a week. A zone whose window
  starts before the host's oldest column, or is longer than a week, says
  `older than the recording` and is not asked again.
- **Not built yet.** The host builds its columns a few minutes behind the
  market. A zone whose window ends past them waits and then asks only the
  windows it lacks.
- **Fallback.** When the host has no stored columns for the pair, a request
  fails three times, or the host stopped building more than 15 minutes ago,
  the zone goes back to the `band_history` replay.
- **Gaps.** A window the host recorded nothing in is a gap, never a zero
  book. The zone is graded on the columns recorded around it, however much
  of its window is missing: the gap counts no traded volume and no wall, and
  a wall's age starts again after it, so a wall seen on both sides of a gap
  is held only if one side alone stood long enough. Only a zone with no
  column recorded in its window stays unverified, as `no book recorded`.
- **A gap confirms, never rejects** (owner's call on PR #54, 2026-10-14).
  Since a gap counts no wall time and no traded volume, a zone the recorded
  columns read as Rejected while part of its window was not recorded cannot
  be told from a wall that stood through the gap. It stays unverified and
  names the first stretch the book missed: a hole between columns, or the
  start or end of the window the recording never reached
  (`Unverified OB · recording gap 13:37–14:00 UTC`). A grade the recorded
  columns confirm (Weak, Strong) stands. A live zone held this way keeps
  asking the host for its window and keeps being read every bar, so the host's
  answer, the page's own columns filling the hole, or a wall that later
  stands long enough on recorded columns grades it.
  Until 2026-10-12 a zone missing more than a tenth of its window stayed
  unverified and named the gap (`recording gap 13:37–14:00 UTC`), so a
  twenty-minute outage after the US open left the zones of that hour
  ungraded. Time outside an equity's regular session is not a gap.

A zone graded this way reads like one graded from the live book: the label
names no source and no gap unless the gap held back a Rejected (until 2026-10-12 it said `from the recording`,
with the missing stretch when the recording had a hole). The code is
`lib/chart/bandHistory.ts`.

## How a zone is graded

Over the zone's life, the columns are read from **three minutes before the
swing** — so a wall already standing there is held at once — through the
break, and on until the zone is mitigated.

1. **A wall** is a band of `bandRows` rows summing to the wall size or more.
   Once open it keeps while the band holds half the size, because walls are eaten and refilled
   constantly and a hard threshold would restart the clock on every fill.
2. **Held** means the wall has stood for three minutes (`FLASH_WALL_MS`, the
   absorption engine's). A flash is not a wall.
3. **Traded** is opposing volume into the zone's rows since the swing, not
   gated by the wall and not stopped at the break. The wall says whether
   someone is defending the level; traded says how much has been thrown at
   it; the verdict needs both.
4. **Standing** is whether a wall is there at the last column read, and
   **wall** is its size then.

| Verdict | Condition | Drawn |
| --- | --- | --- |
| **Strong** | held, traded ≥ hit size, delta ≥ 0.15, still standing | solid |
| **Weak** | held, but one of those is missing — including a wall that has since gone | lighter |
| **Rejected** | no wall ever stood; or one stood, had too little traded into it, and left (a spoof) | faint |
| **Unverifiable** | the columns do not cover the zone | outline |

**The grade is live.** A zone is read every bar until its formation window is
in, and once per closed bar while it is unmitigated, each read continuing from
where the last one stopped. Strong turns weak when the wall leaves. Mitigation
ends the reading and keeps the last grade — and mitigation is a candle
*closing through* the zone, past its far edge, shared with the classic block.
A wick through or a close inside leaves the zone alive: price sitting on the
wall has not broken it, and that is exactly when a retest is being absorbed. A read is kept across a rebuild of the columns: what it read is history, and
it carries on from the newest column it saw, so a zone whose swing the rebuilt
columns no longer reach keeps the grade it earned. It starts over only when
the rows changed width; a window before the reach is re-read once the reach
grows back past it, and a hole once columns arrive inside it.

## What is drawn

Only the zones the book backed: a wall stood in them and it is still
standing. Weak, rejected, unverified and spent zones are switches, off by
default, for when the trader wants to see what was turned down. The Classic
Order Blocks indicator still draws every zone, so nothing is lost by
grading -- the two are meant to be read together.

Changing a size or the zones' geometry costs a replay, since every zone has
to be read again. Changing a switch or a colour does not: the renderer reads
them on every bar, so the chart carries the change on its next tick.

## Sizes

In the instrument's own unit, always. The menu offered `Wall Size` and `Hit
Size` until 2026-09-21, one number for every book, and a size typed on the ETH
perp read every NQ zone as no wall, rejected and hidden; the trader took them
off the menu, a saved size falls back to 0, and 0 takes these.

| Instrument | wall | hit | basis |
| --- | --- | --- | --- |
| BTC perp | 50 BTC | 40 BTC | measured: largest row held 3 min inside zones, 18 zones |
| BTC spot | 10 BTC | 5 BTC | measured, 28 zones |
| ETH perp | 600 ETH | 300 ETH | measured, 13 zones |
| ETH spot | 180 ETH | 60 ETH | measured, 24 zones |
| NQ, MNQ | 10 ct | 8 ct | the trader's, provisional |
| ES, MES | 30 ct | 20 ct | the trader's, provisional |
| AAPL, NVDA | 1,000 sh | 3,000 sh | the trader's, provisional |
| TSLA | 1,000 sh | 2,000 sh | the trader's, provisional |

Provisional means set by hand from too few zones to measure; they wait for a
full US session recorded with the dxFeed recorder up. The crypto sizes were
read off the deep-tier columns of 2026-09-15 to 17 (`thresholds-max.txt` in the
session scratchpad), where about half the zones held a wall at the chosen size
and about half of those were hit at the chosen hit.

## Rows and tiers

A heatmap row counts as inside the zone when any part of its price band
overlaps it; an edge row counts in full, and a row meeting the zone at a single
price does not. Walls are read off the **deep tier** only (ten-second columns
that reach within seconds of the live edge) so a size means the same thing at
every age; the fine tier keeps one-second truth that would read smaller.

## Files

| File | What lives there |
| --- | --- |
| `institutionalRules.ts` | Settings, the per-instrument sizes, the row-overlap rule, the verdict. Pure. |
| `bookEvidence.ts` | One zone's read, continued from where it stopped: wall, held, hit, standing, delta, coverage. Pure. |
| `institutionalTracker.ts` | Owns the classic tracker, keeps a read per block, re-reads on the cadence. |
| `institutionalRender.ts` | Zones and their one line of words onto reused box handles. |
| `institutionalOrderBlocks.ts` | The `RuntimeIndicatorDef`. |

Like Classic Order Blocks, **every setting asks for a replay**: this indicator
has no lines, so the runtime's cosmetic recolor path has nothing to repaint and
a toggle would otherwise sit unapplied until the next bar.

## Limits

- Columns reach `L2_HEATMAP_DEEP_S` (11 h) and carry per-row flow only from
  2026-09-14. Zones older than that are unverifiable by construction.
- An absolute hit size favours long formation windows: a two-hour base collects
  more hits than a ten-minute one. Accepted for now.
- The deep tier keeps each row's ten-second maximum, so a wall reads at its
  best moment in each column. The sizes were measured on the same columns, so
  they are consistent with it.
- A stack restart leaves a gap in the page's columns. A zone forming across
  it is graded on the columns around the gap at once, and asks the host for
  its whole window; the host's answer replaces that grade, and the zone is
  read again from the start if the page's own columns later fill the gap.

## Tests

```
npm test -- src/lib/indicators/institutional-order-blocks
```
