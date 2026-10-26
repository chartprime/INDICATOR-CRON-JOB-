# Storage Warm-up Reads and Capacity Planning

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

How the frontend's chart history gets served from the live store
instead of a live REST call, and what disk capacity a deployment
actually needs.

## Files

- `apps/runtime/src/storage/storage-reader.js` — Binance fail-soft read-only candle warm-up
- `apps/runtime/src/storage/dxfeed/dxfeed-storage-reader.js` — dxFeed equivalent
- `apps/runtime/src/server/app.js` — the WS server that calls the readers for warm-up

## Exact warm-up coverage

The WS reader suppresses REST only when storage contains exactly
10,080 distinct, ordered, aligned closed candles spanning the
seven-day UI recovery window and every row carries taker-buy base
volume. This 10,080-bar window is a warm-up payload bound for the
frontend, not a retention limit — the live store itself keeps every
candle ever captured, with no ceiling. A missing, malformed,
duplicate, off-grid, leading, internal, trailing, or legacy null row
makes coverage incomplete, in which case the read falls back to a real
REST kline fetch for whatever the live table doesn't cover. Missing,
locked, unreadable, or corrupt storage fails soft on this read-only
path and falls through to REST the same way.

Both readers query the live table directly — there is no archive tier
to merge results from, and `app.js` does not construct or accept any
archive-related configuration. A read either finds what it needs in
the live table or falls back to REST; there is no third path.

## Capacity planning

Capacity must be sized from measured sustained throughput, not row
counts alone. A four-pair Binance sample occupied approximately 2.28
GB after about 7.8 hours, with raw depth-event rows accounting for
about 1.25 GB before their indexes. That sample is useful for disk
planning as a per-hour rate, but it is not a bounded projection: with
no retention or rotation, the single live database grows for as long
as the deployment runs, without a ceiling. Production deployment needs
capacity for the live database, its WAL, and safety headroom sized
against real observed growth — not against a fixed retention window,
because there isn't one.
