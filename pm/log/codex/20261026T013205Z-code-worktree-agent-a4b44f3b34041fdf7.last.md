1. **WARNING — `fixtures.ts:447–459`: Forming revisions turn unknown volume into selling.**  
   `sell_volume = volume - buy` discards the unsided remainder. A reproduced equity fixture changes delta from **+7.2808** when closed to **−20.6289** while forming.  
   **Fix:** Read sides through `barSides`, scale buy and sell independently, and preserve unknown volume. Add a partially sided revision test.

2. **WARNING — `fakeL2.ts:70–76`: Historical ladder reads can expose future data.**  
   When no historical ladder qualifies, the fallback returns `script.ladder` without checking its timestamp. Reproduced: `atTime(100).ladder()` returns a ladder timestamped `200`.  
   **Fix:** Apply the cutoff to every candidate, including the fallback; return `null` when no eligible ladder exists. Test cutoffs before the first ladder.

3. **WARNING — `fakeL2.ts:57–60`: Wall snapshots retain future-derived fields.**  
   Clearing `endTs` and `endedBy` still exposes final `peak`, `fill`, `eaten`, `absorbing`, and other mutable wall values before those observations occurred. This can let lookahead-dependent indicators pass replay validation.  
   **Fix:** Support timestamped wall snapshots or reconstruct wall state from events through the cutoff. Test a wall whose peak and consumption change after the cutoff.

4. **WARNING — `fakeL2.ts:98–104`: Trust does not match the real L2 contract.**  
   `trusted(ts)` ignores segment start time and channel sync; explicit `segment: null` also becomes a fabricated LIVE segment. Reproduced: a segment starting at `200` is trusted at `100`.  
   **Fix:** Preserve explicit null segments and mirror production trust checks, including segment start and required channel synchronization. Add boundary and unsynced-channel tests.

5. **WARNING — `fakeL2.ts:51–54,115`: Incomplete event streams are reported complete.**  
   Every slice has `complete: true`, including missed events, unsynced channels, and cursors beyond the current sequence. Consequently, tests cannot reliably exercise indicators’ missing-event gates.  
   **Fix:** Model `EventRing.since` completeness and cursor semantics. Pin missed-event, reset, unsynced, and invalid-cursor cases.

6. **WARNING — `markerBudget.ts:65–68,78–79`: Faulting indicators can pass the budget.**  
   Both helpers discard `capture.faulted`. A runtime fault produces an empty marker capture, which becomes a zero-rate budget and passes `judgeBudget`.  
   **Fix:** Propagate faults into the budget result and make judgement fail, or throw on a faulted capture. Add a deliberately throwing indicator test.

7. **WARNING — `perfProbe.ts:229–244`: Rollover bars inherit stale sell volume.**  
   The generated bar spreads `last`, then changes total and buy volume while retaining the previous bar’s `sell_volume`. This creates inconsistent sides and can materially distort performance measurements for side-dependent indicators.  
   **Fix:** Generate coherent independent buy/sell values, preserving unknown volume where applicable. Verify generated rollover bars through `barSides`.

The specified diff was reviewed. Targeted in-memory checks confirmed findings 1, 2, 4, and 5. Vitest could not collect tests because temporary-directory creation failed in the read-only environment.

VERDICT: REVISE