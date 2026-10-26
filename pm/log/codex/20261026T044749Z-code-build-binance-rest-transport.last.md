1. **CRITICAL — `apps/runtime/src/providers/binance/binance-rest-connection.js:559–566`; `binance-rest-bar-cursor.js:53–61`**  
   A delayed response can permanently finalize an incomplete candle. Classification uses exchange time at **receipt**, although Binance may have generated the row before its close. For example, a snapshot generated at `:59.5` and received at the next minute’s `:01.5` passes the grace check. The cursor emits it closed and rejects the actual final values on subsequent polls. This breaks completed-candle parity with WebSocket and replay data.  
   **Fix:** permit finalization only when the request was dispatched after the candle’s close plus grace, using a conservative exchange-time estimate. Otherwise refetch before confirming it. Add a delayed-response test spanning the minute boundary.

2. **WARNING — `apps/runtime/src/providers/binance/binance-kline-backfill.js:83–86,154–161`**  
   The new grace boundary conflicts with the existing page-range check. During the first 999 ms of a minute, the boundary is the previous minute’s open, while a normal Binance response includes both that candle and the current forming candle. The latter exceeds the boundary, so valid history fails with `PAGE_TIME_RANGE_INVALID`. I reproduced this at 500 ms after rollover.  
   **Fix:** validate the response’s time range separately from finality, then retain rows whose close plus grace passed at dispatch. Allow multiple nonfinal trailing rows. Test backfill during the grace window and across rollover.

3. **WARNING — `apps/runtime/src/providers/binance/binance-rest-bar-cursor.js:53–61`; `binance-rest-connection.js:571–612`**  
   A page starting beyond the expected continuation permanently skips missing minutes. The cursor logs a hole but advances `confirmedOpenTime`; the connection can immediately clear recovery and report READY. I reproduced a missing minute followed by `{ hole: true, catchingUp: false }`, with subsequent requests starting beyond the missing candle. The existing hole test explicitly pins this behavior.  
   **Fix:** keep the continuation cursor at the first missing minute and retain degraded health while repairing it. If the exchange cannot supply that interval, expose persistent incompleteness instead of treating it as caught up. Test both recovery and an irrecoverable gap.

Review used the requested diff and in-memory reproductions of branch code. The full branch test suite was not run; the workspace is read-only and checked out on `main`.

VERDICT: REVISE