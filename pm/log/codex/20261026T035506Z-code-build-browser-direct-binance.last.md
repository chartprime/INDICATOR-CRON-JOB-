1. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:647–675` — Recovery stops after one REST page.**  
   The fill requests at most 1,000 minutes, then releases buffered bars and reports READY without checking that the gap is complete. After a longer outage, missing minutes become permanent once a newer live close advances `lastClosedOpen`.  
   **Fix:** Paginate through a captured recovery boundary and verify continuity before releasing buffered bars or reporting READY. Add a test covering more than 1,000 missing minutes.

2. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:579–590` — The first stream connection can miss a candle close.**  
   Recovery runs only when `session.degraded` is true. If REST returns a forming candle and the initial WebSocket opens after that minute closes, its final values are never fetched. The next minute can arrive while the previous candle remains incomplete. An isolated execution reproduced this with only one REST call.  
   **Fix:** Reconcile from the last confirmed close on the initial stream open too, buffering incoming klines during reconciliation. Test an initial connection that crosses a minute boundary.

3. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:615–631` — A disconnected book remains marked fresh.**  
   Stream loss emits health degradation but leaves the last book frame at `status: "READY", stale: false`. Book consumers that inspect the book’s own status, including `DomPanel`, can continue displaying disconnected depth as fresh.  
   **Fix:** Emit an unavailable or stale book frame whenever the stream is lost; restore freshness only on a new valid depth message. Test the sequence READY book → disconnect → reconnect without depth.

4. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:690–693` — Recovery buffering has no memory bound.**  
   While the stream stays open and REST recovery repeatedly fails, every closed minute adds another entry to `heldClosedBars`. Retries continue indefinitely, so memory grows with outage duration and eventual recovery copies and sorts the entire buffer.  
   **Fix:** Bound retained closes and recover overflow through paginated REST, keeping health degraded until continuity is restored. Add a prolonged REST-failure test that asserts the bound and subsequent recovery order.

The requested diff was reviewed. Isolated execution confirmed findings 1 and 2; the branch’s Vitest suite was not run because the read-only checkout is on `main`.

VERDICT: REVISE