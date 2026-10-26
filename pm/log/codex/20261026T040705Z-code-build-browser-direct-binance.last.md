1. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:693–719`**  
   Gap recovery does not verify consecutive timestamps. If the last confirmed bar is A and REST returns D plus forming E, B and C are silently skipped: D advances `lastClosedOpen`, E sets `reachedNow`, and recovery succeeds. Invalid rows discarded by `fetchKlines()` can create the same hole. The tests even use this discontinuous response in `browserBinanceTransport.test.ts:313–320`.

   **Fix:** Require each closed row to match the next expected minute before advancing the boundary. Release held closes only while consecutive. Keep `RECOVERING` and retry from the first missing minute. Add tests for missing first/interior rows and malformed rows followed by a forming minute.

2. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:549–561, 693–701`**  
   REST rows are classified as closed using the clock **after** the response arrives. A request served just before a minute closes can contain partial OHLCV, then arrive just after close. That partial row becomes a confirmed closed bar. Subsequent authoritative stream closes for that minute are discarded by the `lastClosedOpen` guard at line 754, leaving permanently incorrect prices, volume, and trade counts.

   **Fix:** Capture a conservative closure cutoff before each REST request and only confirm rows closed before that cutoff. Re-fetch uncertain boundary minutes or accept their authoritative stream close before advancing confirmation. Add a test where the clock crosses a minute boundary during fetch and the final stream bar differs from REST’s partial row.

I ran the requested diff and inspected the branch’s implementation and tests. I could not execute the branch test suite in this read-only checkout on `main`; an attempted in-memory reproduction was blocked by subprocess restrictions.

VERDICT: REVISE