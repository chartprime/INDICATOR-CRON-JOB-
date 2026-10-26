1. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:617–626, 638–640` — Live events can erase the recovery gap.**  
   While REST backfill is pending, a live closed kline advances `session.lastClosedOpen`. The REST loop then skips every missing bar older than that new cursor. For example, with minute A last received, missing B/C, and live D closing before REST returns, B/C are permanently omitted.  
   **Fix:** Preserve the recovery boundary and coordinate backfill with live delivery so closed bars arrive chronologically without gaps. Add a deferred-fetch test where D arrives before the B/C response.

2. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:614–629` — Failed or obsolete recovery reports READY.**  
   A rejected gap-fill request is logged, then followed by `READY`, with no REST retry. Also, if the stream closes during that fetch, the response still passes `isCurrent(session)` because reconnects reuse the session; it can overwrite the newer RECOVERING state with READY while disconnected. This hides missing history and feed failure.  
   **Fix:** Associate recovery with a stream generation, retain degraded health on REST failure, and retry with backoff. Emit READY only after successful recovery for the currently open stream. Test rejection and stream closure during a pending fetch.

3. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:601–609` — Perpetual stream failures violate the specified unavailable behavior.**  
   Perpetual REST failures use `BROWSER_DIRECT_PERPETUAL_UNREACHABLE`, but stream failures follow the spot path: RECOVERING for four failures, then generic STREAM_UNAVAILABLE. The brief requires UNAVAILABLE with the perpetual-specific reason on the first failure.  
   **Fix:** Handle PERPETUAL in `streamLost()` and emit the required state and reason immediately. Test both socket closure and connection timeout after successful perpetual REST bootstrap.

The payload conversions and unavailable-history replies otherwise follow the brief in the inspected paths. No indicator settings or `onBar` factories are introduced.

The requested diff was reviewed. Tests were not run: the working tree is on `main`, and the read-only environment prevents checking out or materializing the target branch.

VERDICT: REVISE