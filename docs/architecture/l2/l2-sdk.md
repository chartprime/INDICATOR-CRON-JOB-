# `ctx.l2` — the L2 engine for indicator authors

**Status:** built on `l2-engine` (report 61 P4b). Live only; Historical Mode reports `HISTORICAL_UNAVAILABLE` until J1 adds a historical source behind the same interface.

Book Map reads `l2_view` through `view(laneFor(visibleLow, visibleHigh))`, using the selected lane's row width and fine/deep column duration. If the chosen lane covers only part of the visible price range, the map labels it partial. L2 Support/Resistance reads active `l2_walls` from lane 0, including engine fill and evidence-gap detail. Each primitive clears its rendered facts while its own channel is unsynced or the segment is not LIVE. On an older live server with no L2 store, each can use the lane-0 grid and labels that provenance; Historical Mode uses the unavailable sentinel and never falls back to the last live grid. The resting-order profile remains a separate display detector until recorded-hour comparison proves its policy matches engine walls.
**Code:** `apps/web/src/lib/chart/indicatorL2.ts` (the interface), `apps/web/src/lib/l2/` (the models behind it), `apps/web/src/lib/indicators/l2-feed-status/` (the first consumer) · **Tests:** `src/lib/l2/l2Store.test.ts`, `src/lib/chart/tests/indicatorL2.test.ts`, `src/hooks/useMarketData.l2.test.tsx`, `src/types/l2Frames.test.ts`
**Wire:** the four L2 channels in the [WS frame contract](../../contracts/ws-frame-contract/v1/ws-frame-contract-v1.md#l2-channels--the-l2-engine-on-the-wire-2026-09-28-report-61-p4a).

`ctx.liquidity` gives an indicator the heatmap: lane 0, one column a second. `ctx.l2` gives it the rest of what the server's L2 engine knows:
- wider zoom lanes;
- every wall with a stable id and its evidence;
- the events behind the walls;
- the exact book.

## Getting it

Declare the indicator with `category: "l2"`. The runtime then:
- sets `ctx.l2` on every call;
- replays the indicator over the loaded bars when the first L2 frame arrives, and again when the chart switches between live and Historical Mode;
- calls `onBar` again on the tail bar whenever the L2 state changes (a frame applied, a pair switch clearing it, a dropped socket marking it untrusted), with `ctx.replace === true` and `ctx.drawNow === true`.

`ctx.l2` is `undefined` until the first L2 frame of the session arrives.

```ts
onBar(ctx) {
  if (ctx.replaying || ctx.l2 === undefined || !ctx.l2.trusted()) return;
  const bigBids = ctx.l2.walls().filter((wall) => wall.endTs === null && wall.side === "bid" && wall.ratio >= 5);
}
```

## What it reads is now, not as of the bar

Every accessor returns the state the browser holds **at the moment of the call**. During a replay, `ctx.l2` does not rewind to each bar. An indicator that draws per bar has two options:
- draw only on the live tail (`!ctx.replaying`), like the status panel; or
- select by timestamp: walls carry `startTs`/`endTs`, events carry `ts`, and lane columns carry `ts`.

## The interface

| Member | Returns |
|---|---|
| `availability` | `"LIVE"`, or `"HISTORICAL_UNAVAILABLE"` in Historical Mode (every accessor below is then empty) |
| `version` | Increases on every applied frame, `clear` and `markUntrusted`. Use it to skip work when nothing changed. |
| `status(channel)` | `{ synced, seq, lastTs, lastFrameAt }` for `l2_view`, `l2_walls`, `l2_events` or `l2_ladder` |
| `segment()` | `{ id, state }` of the engine's current book segment, or `null`. Ids have the form `<kind>:<symbol>:<start_ts>:<LIVE\|GAP>`. |
| `trusted(ts?)` | `true` when the segment is `LIVE` and walls and events are synced. With `ts`, it also requires `ts` to be at or after the segment's start. |
| `lanes()` | `{ lane, rowWidth, columnMs, deepColumnMs, priceLo, priceHi }` for lane 0 (from `ctx.liquidity`'s grid) and every wider lane received |
| `view(lane)` | An `L2LaneView` for any lane: `fine` (recent) and `deep` columns of bid/ask size per row. The same data `ctx.liquidity` exposes, typed read-only |
| `laneFor(lo, hi)` | The finest lane whose coverage contains the price range, else the widest lane, else 0 |
| `walls()` / `wall(id)` | Every wall the server holds (active: `endTs === null`; recently ended: the verdict is in `endedBy`) |
| `events(sinceSeq?)` | `{ seq, events, missed, complete }`. See below. |
| `ladder()` | `{ ts, depth, bids, asks }`: exact `[price, size]` pairs, bids descending, asks ascending |

All results are frozen, except lane columns. Keep ids and seqs, not object references: a wall's object is replaced whenever the server changes any of its fields.

Lane columns are handed out without copying: they are the chart's own arrays, several megabytes per lane. Copying them on every call would cost more than the indicator that reads them. `L2LaneView` types every column field, cell and list as read-only, so writing to one is a compile error. Don't cast that away: a write would corrupt the heatmap for every indicator reading it.

### Walls

`L2Wall` carries the `liquidity` level fields (`side`, `row`, `span`, `size`, `peak`, `ratio`, `chain`, `fill`, `eaten`, `absorbing`, `startTs`, `endTs`, `endedBy`) and `detail`:

| `detail` field | Meaning |
|---|---|
| `lifeMs` | `null` while active (use `now − startTs`); exact once ended |
| `firstShrinkTs`, `firstShrinkExact`, `reachedAtFirstShrink` | When the wall first shrank, whether the event stream saw it, and whether price was at the wall |
| `traded`, `absorbed`, `swept`, `hidden`, `cleared`, `fillRatio`, `clearedByTrades` | What trading did to it |
| `crossSide`, `crossSideShare` | Opposite-side flow near it. Refreshed at most every 10 s while active. |
| `endDistanceRows`, `endDistancePct` | Distance from the mid when it ended |
| `continuityGapMs`, `repeats`, `repeatsComplete`, `evidenceGap` | Continuity across book gaps and re-placement at the same price |

### Events

`events()` returns the latest events the browser holds (up to 5,000). `events(sinceSeq)` returns only those after `sinceSeq`, and `complete: true` promises that none are missing between `sinceSeq` and `seq`. The usual pattern:

```ts
const slice = ctx.l2.events(ctx.state.seenSeq);
if (!slice.complete) {
  // Treat this interval as partial; reconcile with the authoritative walls.
}
ctx.state.seenSeq = slice.seq;
```

`complete` is `false` when:
- `sinceSeq` is older than what the browser holds;
- `sinceSeq` is from before the last reset;
- the channel is untrusted.
- the server reported dropped events in or after the requested interval. Omitted events have no sequence positions on the wire, so the interval stays incomplete until `sinceSeq` moves past a later retained event or another reset arrives.

`missed` counts events the server's 500-per-frame cap dropped since the last reset. Lifecycle events outrank near-price trades there, so `walls()` stays the authority on a wall's state.

Event kinds (`kind`):
- `wall_born`, `wall_shrink`, `wall_trade`, `wall_hidden`, `wall_end`, all keyed by `wall` id;
- `trade` and `hidden` near the mid;
- `segment`.

Their times come from two clocks, and the host can skew them by up to about 2 s. Do not order a trade against a wall's birth or end by `ts` alone (see the contract).

## Trust

The browser keeps each channel exactly in sequence with the server:
- It drops duplicates.
- On a gap it marks the channel untrusted and asks the server for a fresh snapshot of that channel, at most once every 3 s.
- A dropped socket leaves the held state visible but untrusted until the reconnect's snapshots arrive.
- A pair switch clears everything at once.

An indicator that acts on L2 state should check `trusted()`, or `status(channel).synced` for the channels it reads, and say so visibly when it isn't.

`trusted()` means the current segment is LIVE and the walls/events transport is in sequence. It does not promise that the server's event cap kept every event. An indicator requiring a complete event interval must also require `events(sinceSeq).complete`.

`trusted(ts)` compares `ts` with the segment's start, which is an exchange time. A host-clock time can land on either side of the segment start if it falls within about 2 s of it. Host-clock times include a wall's `startTs`/`endTs` and a lane column's `ts`.

`status("l2_ladder").synced` is `false` from a dropped socket until the next book arrives, even though the last book is still held.

## Cost

Measured on the P0 recordings, one hour each (2026-09-08 14:00–15:00 UTC):

| | Per frame, p99 | Per second, p99 | Lane memory held |
|---|---|---|---|
| BTC perpetual | 0.18 ms | 0.51 ms | 23 MiB |
| ETH spot | 0.16 ms | 0.38 ms | 24 MiB |
| NQ | 0.20 ms | 0.66 ms | 37 MiB |

The lane memory above is after one hour. The browser applies frames on the main thread, then bumps `version` once per animation frame. Lanes keep at most 20 minutes of recent columns and 2 hours of deep columns each. BTC, run for 2.5 hours past both caps, levels off at 30 MiB.

Replaying the same hours showed:
- every 5-minute mid-stream join equal to the live model (33 of 33);
- 0 gaps.

Evidence: `apps/runtime/scripts/bench/l2-client-replay.js`.

## Example: the L2 Feed Status panel

`lib/indicators/l2-feed-status/l2FeedStatus.ts` is a complete `l2` indicator. It is a table that shows, per channel, synced or untrusted, the seq and the time since the last frame; then the segment and trust, the wall and event counts with `missed`, lane coverage, and the book's depth. It redraws every second while visible, so a feed that stops sending shows its lag growing. The Segment row is green only while the segment is LIVE and the store is trusted. It turns neutral while a dropped socket resyncs, and red for GAP or no segment. Use it to confirm a feed before trusting an indicator built on it.
