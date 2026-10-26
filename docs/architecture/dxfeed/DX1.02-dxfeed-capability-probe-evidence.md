# dxFeed Capability Probe

> **Historical implementation evidence.** This dated page records the result
> of a completed build or audit. It is not a current deployment/health
> statement; use the handbook and final-state overview for supported operation.

What this account actually delivered during the bounded probe, rather than an
entitlement inventory inferred from silence — the connection layer is documented separately in
`DX1.01-dxfeed-integration-evidence.md`. Reachable only via
`npm run verify:dxfeed-capability-probe:live`; not wired into any
production path.

## Findings table

12 of 16 cells are supported by the combined live probe and later physical
storage evidence. The historical probe log contains two consistent runs but
both predate the logger-flush fix and lose their final TSLA Order tail; the
later SQLite capture independently contains 22 `TSLA`/`NTV` Order rows. The
evidence is sufficient for the table below, but it is not described as two
complete durable probe transcripts.

| Symbol | Quote | Trade | Candle (1m) | Order |
|---|---|---|---|---|
| `/NQ` | observed | observed | no data observed | observed (`source: GLBX`) |
| `/ES` | observed | observed | no data observed | observed (`source: GLBX`) |
| `AAPL` | observed | observed | no data observed | observed (`source: NTV`) |
| `TSLA` | observed | observed | no data observed | observed (`source: NTV`) |

## Order source is venue-specific and was not assumed

Futures require `source: "GLBX"` (CME Globex). Equities require
`source: "NTV"` — discovered live, not guessed: omitting `source`
entirely produces total silence (full timeout, zero response), while
`NTV` resolves in ~130ms. `COMPOSITE` was never needed.

## Candle: no data observed in this bounded run

Every symbol returned zero events on the realtime connection in this probe.
That proves only a silent result for the tested AUTO shape. The corrected
extended probe now uses HISTORY, explicit `{=m}`, and a 24-hour `fromTime`;
its next live run is the authoritative follow-up. The product is not a runtime
dependency because bars are aggregated locally.

## Payload shapes, captured directly from this account

Not sourced from any other account's documentation — one representative
sample per working event type, from a live run against this project's own
credentials.

**Quote**:
```json
{"eventType":"Quote","eventSymbol":"/NQU26:XCME","bidTime":1787601544000,"bidExchangeCode":"G","bidPrice":29111.5,"bidSize":2,"askTime":1787601544000,"askExchangeCode":"G","askPrice":29112,"askSize":3}
```

**Trade**:
```json
{"eventType":"Trade","eventSymbol":"TSLA","time":1787601599905,"exchangeCode":"L","price":349.03,"change":-13.83,"size":120,"dayVolume":34651826.7,"tickDirection":"ZERO_UP","extendedTradingHours":true}
```

**Order** (equity, `source: NTV`):
```json
{"eventType":"Order","eventSymbol":"AAPL","eventFlags":4,"index":22047776527426936,"source":"NTV","action":"EXECUTE","price":310.48,"size":"NaN","side":"SELL","scope":"ORDER","marketMaker":"NSDQ"}
```

**Order** (future, `source: GLBX`):
```json
{"eventType":"Order","eventSymbol":"/ESU26:XCME","eventFlags":4,"index":5137554220647461000,"source":"GLBX","action":"EXECUTE","price":7671.75,"size":"NaN","side":"SELL","scope":"ORDER"}
```

Two shape facts to carry into any future consumer: `size`/`executedSize`/
`tradePrice`/`tradeSize` on `Order` events arrive as the literal **string**
`"NaN"` when not applicable, not a JSON number and not `null`. `marketMaker`
is present only on equity Order events (`source: NTV`); futures Order
events (`source: GLBX`) never carry it — an optional, venue-specific
field, not a universal one.

## Front-month futures symbols

`/NQU26:XCME` and `/ESU26:XCME` — reference values carried over from a
different (differently-entitled) dxFeed account's own proven IPF
resolution, not independently resolved via this account's own IPF lookup.
Confirmed still current as of this probe by successfully streaming real
data against both.

## Files

- `apps/runtime/scripts/verify/dxfeed/verify-dxfeed-capability-probe.js` - the probe
  itself: one connect/authorize/open-channel cycle, sequential per-cell
  subscribe/wait/unsubscribe, early-exit on first success
- `apps/runtime/logs/verify-dxfeed-capability-probe-*.log` - the durable,
  per-line evidence record for every run

## Scope

- Disposable and scriptable by design — no normalization, no storage, no
  schema decisions live here; this is what those decisions get informed
  by, not where they're made.
- The equity Order `source` search tries three candidates in a fixed
  order and stops at the first success; a full sweep of every possible
  `source` value was never attempted.
- A connection drop mid-probe aborts the run immediately rather than
  producing a misleadingly complete table — confirmed by mutation test,
  not yet observed live.
- A streaming result requires exact `eventType` plus wire `eventSymbol`
  correlation and, when requested, exact Order `source` correlation. This
  closes a false-positive family where delayed traffic from the preceding
  subscription could have proved the next cell.
- Signal, connection-error, and disconnect paths cancel authorization,
  channel-open, and in-flight attempt waits, then remove the subscription and
  close the channel.
- The historical log ends before its findings table because the old CLI
  exited while async appends were still queued. All DX verification CLIs now
  flush before exit; the old file remains unchanged as historical evidence.
