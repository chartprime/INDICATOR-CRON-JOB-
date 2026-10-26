# DX3.03-DX3.04 Provider Routing Evidence

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

## Files

- `apps/runtime/src/server/provider-router.js` — active-provider switching, atomic rollback, selection validation/rate limiting
- `apps/runtime/src/server/app.js` — router wiring, `/health` reporting (client count, dxFeed recovery state)
- `apps/runtime/src/providers/dxfeed/dxfeed-trade-adapter.js` — `tickDirection`/`aggressorSide` semantics, see "Proven boundaries" below
- `apps/web/src/components/chart/Terminal.tsx` — requested-vs-confirmed identity tracking, 15-second compensating-select timeout (`SELECTION_CONFIRM_TIMEOUT_MS`)
- `apps/web/src/hooks/useMarketData.ts` — frame-vs-pending-selection matching
- `apps/web/src/components/chrome/SymbolMenu.tsx` — grouped-listbox instrument selector

## Delivered flow

The shared WebSocket service starts on Binance and owns one process-wide
selection. A valid client `select` is checked against an exact provider-specific
shape before any state changes. Cross-provider switches detach all clients,
install the destination selection, then attach every client to the destination,
so a retained old provider view cannot leak during the transition. If the
destination server rejects the switch synchronously, every already-detached
client is reconnected back to the previous provider rather than left
stranded — the switch is atomic, not partially applied.

For dxFeed, selection confirmation and an empty or storage-warmed snapshot are
published before token acquisition. The view therefore has a deterministic
identity even when broker, expiry, handshake, channel, or subscription setup
fails. Failures retain that view with `UNAVAILABLE`; a same-symbol retry starts a
fresh bounded session. Overlapping token requests are generation-guarded, and
stop/switch abort pending handshakes and clean every acquired resource.

The browser tracks requested and server-confirmed identities across provider,
symbol, and provider-specific market dimension. Frames must match both while a
selection is pending. A 15-second unconfirmed switch sends a compensating select
for the last confirmed pair instead of merely repainting the dropdown. An
unavailable dxFeed selection can be explicitly retried without choosing another
instrument first.

## Proven boundaries

The current dxFeed browser producer subscribes only to `Trade` under the `AUTO`
contract. Under dxFeed's event model, `Trade` is a ticker/latest-state event;
`TimeAndSale` is the stream event intended for individual executions. It is not
a lossless time-and-sales path, and `tickDirection` is not the separate
aggressor-side field. See the official
[event publishing model](https://kb.dxfeed.com/en/data-model/market-events/model-of-event-publishing.html)
and [market-event model](https://kb.dxfeed.com/en/data-model/market-events/qd-model-of-market-events.html).
dxFeed bars, large-trade markers, and assembled L2 remain outside
DX3.03-DX3.04.

`dxfeed-trade-adapter.js` maps all four `tickDirection` values
(`UP`/`ZERO_UP` → buy, `DOWN`/`ZERO_DOWN` → sell) and rejects anything
else outright rather than guessing a side. A live trade's ID is
synthesized from `symbol`/`time`/`timeNanoPart`/`sequence`; any one of
those being absent or invalid fails the adapter closed instead of
falling back to a partial key that could collide with an unrelated
trade.

The authenticated external run is deliberately still pending. Local evidence
covers exact contracts, real loopback HTTP/WebSocket composition, race paths,
shutdown, frontend contamination resistance, lint, typecheck, and production
build; it does not claim that an unaudited external entitlement/session succeeded.
