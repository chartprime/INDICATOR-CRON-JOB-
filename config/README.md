# Governed market-instrument catalog

`market-instruments.json` is the deployment source of truth for every
instrument exposed by the browser and captured or accepted by the Binance and
dxFeed runtime paths. Do not duplicate its membership or instrument count in
code or documentation. Consumers may describe the supported asset classes, but
must resolve the current exact symbols from this file.

The catalog governs:

- provider and market membership;
- display group and label;
- the exact provider symbol;
- dxFeed asset class and order source; and
- tick size used by provider-aware consumers.

Runtime loaders validate the file at process startup. A malformed or
unsupported entry must fail closed rather than silently removing a symbol or
using a guessed market property.

Futures rollover is intentionally explicit. Choosing the active contract is a market-liquidity decision, so application code must not silently guess it from the calendar.

## Futures rollover

Futures rollover is a controlled production change, not a text substitution.
For a roll:

1. Stop the dxFeed collector and market-data relay cleanly.
2. Update the exact resolved futures symbols and proven order sources in `market-instruments.json`.
3. Run the catalog, provider-router, lazy-server, eager-server, collector, and
   storage-routing tests that cover the changed symbol.
4. Build the frontend and verify the symbol menu contains the new contracts.
5. Start the collector first, verify durable capture and book readiness, then start the relay and browser.

6. Verify the hosted live-storage reader accepts the new exact symbol and the
   retired contract remains queryable as historical data where applicable.
7. Update final-state documentation only if the supported asset class or
   operating procedure changed. Do not edit prose merely to replace one dated
   contract with another.

Commit the catalog change with the rollover evidence. Do not edit a frontend
or server-local instrument list; those lists are derived from this catalog.

## Related configuration

Instrument membership belongs here. Secrets and machine-specific service
settings belong outside Git under `/etc/terminal-l1-l2`. Local developer
settings belong in the ignored repository-root `.env`, using `.env.example` as
the developer reference and `.env.operator.example` for operator tasks. Host
templates live under `ops/linux-host/config`.

## Market calendar

`market-calendar.json` is the source of truth for US equity sessions: the
regular session (09:30-16:00 ET, 13:00 on early closes), the extended-hours
labels, exchange holidays and early closes, each list with the official page
it was copied from and the date it was fetched. For US equities the chart is
regular session only: live and historical candles, bar studies, large-trade
bubbles and markers, heatmap columns and the server-side volume profile and
VPIN inputs. Raw capture and the trade tape keep every print.

The runtime (`apps/runtime/src/providers/shared/market-calendar.js`) and the
browser (`apps/web/src/lib/chart/marketCalendar.ts`) each evaluate this file;
a property test checks that they agree minute by minute. The runtime loader
fails closed on a malformed entry. Coverage is explicit: renew the next year's
dates from the exchange pages before the calendar test's 60-day runway check
fails. Futures sessions are not governed here.
