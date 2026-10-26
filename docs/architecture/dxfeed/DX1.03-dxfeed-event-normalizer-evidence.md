# dxFeed Canonical Event Normalization

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

The normalizer converts approved dxLink Quote, Trade, Order, and TimeAndSale
messages into the exact envelope defined by
`docs/contracts/dxfeed-canonical-event/v1/dxfeed-canonical-event-v1.md`.

## Files

- `apps/runtime/src/providers/dxfeed/dxfeed-event-normalizer.js` — `normalizeDxFeedEvent` (Quote/Trade/generic-Order/TimeAndSale) and `normalizeDxFeedOrderV2Event` (the lossless L2 path)
- `apps/runtime/src/providers/dxfeed/dxfeed-order-v2-capture.js` — the raw-text WebSocket interceptor that extracts each Order-v2 `index` as an exact digit string before `JSON.parse` would round it, then hands that string into `normalizeDxFeedOrderV2Event`

## Boundary behavior

- Caller context must be a plain object with an approved asset class, event
  type, and symbol/asset-class pair. Futures require a venue suffix.
- Raw payloads must be plain data objects with only the allowlisted fields for
  that event type. Proxies, accessors, extra keys, mismatched symbols/types,
  invalid timestamps, and missing required fields produce a complete degraded
  envelope rather than a partial event.
- Quote event time is the usable maximum of bid/ask time. Trade, generic Order,
  and TimeAndSale use their type-specific `time`; the observed top-level
  provider `eventTime=0` is not promoted. The separate lossless Order-v2 path
  uses local `receivedAt` only for a structural `REMOVE_EVENT` that has no
  usable provider time, allowing a valid empty snapshot to clear the book.
- Futures venue is parsed from the dated symbol; equity venue remains null
  because per-event exchange codes do not constitute one fixed venue.
- Native dxFeed numeric prices/sizes remain finite JSON numbers. Unsafe 64-bit
  Order/TimeAndSale identifiers are null rather than collision-prone numbers.
- Order's provider `"NaN"` size maps to null. TimeAndSale preserves
  NEW/CORRECTION/CANCEL, validity, spread-leg, aggressor, nanopart, and sequence
  semantics.

## Order-v2 payload validation

The lossless path validates its own, narrower payload shape rather than
reusing generic Order's. The raw `index` string is accepted only as
1-20 ASCII digits that also parse as a valid `BigInt` — anything else
degrades the event rather than silently truncating precision. Price
must be strictly positive, with one explicit exception: `0` is valid
only for a `TRADE` or `BUST` action, dxFeed's own zero-priced action
types. A structural removal (`eventFlags` has the remove bit set) only
requires `index`/`eventFlags`/`source` — the reduced field set that
lets a legal empty snapshot clear the book without needing a
provider time or price that a pure removal doesn't carry.

A real captured `TRADE`/`BUST` order-v2 event can also carry no usable
provider `time` — confirmed live, not just theorized: dxLink sometimes
sends the literal wire string `"NaN"` for `time` on these actions, the
same transport quirk already known for `size`. `TRADE`/`BUST` events are
therefore also exempt from the `time` requirement; `eventTime` falls back
to local `receivedAt` for them the same way a structural removal already
does. `side`/`scope`/`action`/`source` remain required regardless of
action — only `time` (and, separately, `price`) are ever relaxed. The
identical gap and identical fix applied to the generic Order path
(`dxfeed_orders`) — see `dxfeed-storage-layer-v1.md`'s v14-v16 migration
notes. **That path is retired at schema v20 (`L1L2-V2-039`)**, so the rule no
longer has to be kept in sync by hand across two independent
re-implementations; only the Order-v2 capture path carries it now.

The generic Order path had no removal tier and deliberately never gained
one. `dxfeed_orders` carried no `event_flags` column, so a stored removal
would have been indistinguishable from a resting order at that price and side.
The collector originally filtered structural removals out of the generic
path before normalization and counts them as filtered rather than
degraded; they are retained losslessly, with their flags, in
`dxfeed_order_book_capture`, which is the only reconstruction input.
`verify-dxfeed-storage-capture.js` applies the same filter so its 16-cell
proof reflects the collector's real routing.

## Wiring

The collector normalizes configured Quote/Trade/Order/TimeAndSale cells for
all four instruments. The WS server uses TimeAndSale for tape and bars across
both asset classes; futures require `validTick`, while equities retain real
fractional-share fills even when that flag is false. Storage validates the
canonical contract again before persistence.

Futures downstream behavior uses valid NEW TimeAndSale. Corrections, cancels,
and invalid ticks are stored but excluded from materialized bars. An undefined
aggressor remains valid canonical evidence and contributes to OHLCV without a
fabricated side.

## Evidence boundary

The configured futures symbols are dated contracts and require rollover.
Equity TimeAndSale remains unproven during regular US hours, so equities still
use the disclosed conflated Trade/tick-direction path. Generic Order canonical
events do not preserve the indexed-event contract needed to reconstruct L2;
the dedicated Order-v2 raw interceptor does, retaining the exact decimal index
and event flags before JSON parsing.

Direct tests cover real captured fixtures, malformed object families,
timestamp and identity disagreement, unsafe identifiers, TimeAndSale event
kinds, and storage-level revalidation. The full runtime regression suite is
the release gate.
