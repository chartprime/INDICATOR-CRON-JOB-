1. **WARNING — `apps/web/src/lib/chart/validation/fakeL2.ts:127–134`**  
   When neither a snapshot nor a birth event is available, `wallAt` uses the final `wall.size` as its historical size and peak. A wall that later shrank from 500 to 20 therefore appears as size 20 before that shrink. This leaks future state and invents historical certainty. The new test at `fakeL2.test.ts:121–123` explicitly pins this incorrect behavior.  
   **Fix:** Require an eligible snapshot or birth record to reconstruct historical state; otherwise omit the wall. Test that changing a future final record cannot change an earlier cut.

2. **WARNING — `apps/web/src/lib/chart/validation/fakeL2.ts:124–134`**  
   Event reconstruction always returns `absorbing: false`, including after an absorbed `wall_trade`. The same lifecycle returns `absorbing: true` through its snapshots or uncut final record. Consequently, replay and live inputs disagree depending on whether snapshots were supplied, potentially hiding absorption signals in validation.  
   **Fix:** Reconstruct absorption state using the event’s mode and production semantics, or require snapshots when the events cannot determine it. Add a comparison of snapshot-backed and event-backed views after an absorbed trade.

3. **WARNING — `apps/web/src/lib/chart/validation/perfProbe.ts:361–363`**  
   The pooled probe passes `extras.liquidity` directly into every historical bar. The real runtime calls `liquidity.atTime(barClose)` first. A supplied historical liquidity provider can therefore expose future columns during this probe and exercise different computation paths from a real replay.  
   **Fix:** Apply the same liquidity cutoff as `indicatorRuntime.makeCtx`, preserving a `null` cutoff result as unavailable. Add a provider that records cutoff requests and contains a future-only column.

The fixture math matches the adjacent PM brief. Tests were attempted, but Vitest failed creating its temporary SSR directory before test collection; no tests executed.

VERDICT: REVISE