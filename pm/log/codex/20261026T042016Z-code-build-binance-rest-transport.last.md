Reviewed against the final Stage B scope: REST candles only, with tape and book unavailable.

1. **WARNING — `apps/runtime/src/providers/binance/binance-rest-weight-budget.js:68–76` — Reservations can exceed the observed remaining budget.**  
   When `observed > reserved`, successful reservations increment only `reserved`, leaving `used()` unchanged. Reproduction: reserve 20, observe 98 against budget 100, then reserve weight 2 five times—all succeed. Concurrent requests can exceed the intended limit.  
   **Fix:** Advance a conservative accounted total on every reservation, including reservations after header observations. Add a test where a near-limit header permits exactly one further request.

2. **WARNING — `apps/runtime/src/providers/binance/binance-rest-connection.js:121` and `apps/runtime/src/providers/binance/binance-kline-backfill.js:45–57,114–116` — Backfill bypasses exchange-time classification.**  
   Live polling uses the synchronized exchange clock, but backfill uses `Date.now()` to identify closed candles. With the machine ahead, backfill can return an exchange-forming candle as closed; the server then records it as historical data. This breaks live-versus-history consistency.  
   **Fix:** Inject the exchange clock into backfill and filter each row by its close time using the same finalization policy. Test backfill and live polling together with the machine clock ahead.

3. **WARNING — `apps/runtime/src/providers/binance/binance-rest-connection.js:165–181` — Backfill ignores global rate-limit and ban windows.**  
   `meteredFetch` checks only the weight budget. It can dispatch during an existing 429/418 pause, and a 429/418 received by backfill never updates the connection’s shared pause state. Other requests can therefore continue during `Retry-After`.  
   **Fix:** Route backfill through the shared dispatch gate and failure handling. Make queued waits abortable. Test both directions: a polling ban blocks backfill, and a backfill ban blocks polling.

4. **WARNING — `apps/runtime/src/providers/binance/binance-rest-connection.js:307–314` — Clock-refresh rate limits are ignored.**  
   A `/time` response of 429 or 418 only increments `clockRefreshFailures`; it never calls `noteRequestFailure`. Candle polling continues, and a 418 does not disconnect the route or establish the ban window.  
   **Fix:** Apply shared rate-limit/ban handling to failed clock requests while retaining the last valid offset. Add clock-refresh-specific 429 and 418 tests.

5. **WARNING — `apps/runtime/src/server/app.js:143–151` — Tick-size requests bypass the runtime budget.**  
   The tick-size resolver receives raw `fetchImpl`, while reservations exist only inside the REST connection. Its `exchangeInfo` requests consume weight without reservation and bypass the shared ban gate. The documented guarantee covering every runtime request therefore does not hold.  
   **Fix:** Share a weighted dispatch service between the connection and resolver, charging `exchangeInfo` weight 20. Test a tick-size lookup while the budget is exhausted and during an IP ban.

Validation: ran the requested diff and reproduced finding 1 directly from the branch module. The full branch test suite was not run; the workspace is read-only and checked out on `main`.

VERDICT: REVISE