1. **WARNING — `apps/web/src/lib/indicators/relative-volume/tests/relativeVolumeBaseline.test.ts:90–94`**  
   Overall false-positive rate divides by `eligible - anomaliesHit`. Missed anomalies therefore count as negative examples, understating the rate whenever recall falls below 100%.  
   **Fix:** Track eligible non-anomaly bars and divide false positives by that count. Add a hand-computed case containing a missed anomaly.

2. **WARNING — `apps/web/src/lib/indicators/relative-volume/relativeVolume.ts:30–31`**  
   Default colors are purple and blue; the supplied brief requires green `#26a69a` and orange `#ff9800`. The tests and documentation reinforce the changed defaults rather than catching the mismatch.  
   **Fix:** Restore the specified colors and corresponding fill, test expectations, and documentation.

3. **WARNING — `apps/web/src/lib/indicators/relative-volume/relativeVolume.ts:165–191`**  
   `showRolling` is under Visibility, leaving only two primary controls. The brief explicitly requires three primary controls, including the rolling comparison toggle.  
   **Fix:** Move `showRolling` to the main Inputs tab and update the schema test and documentation.

No math, future-data-leakage, or tail-correction defect was identified through static inspection. Trade, tick, L2, and sided-volume gates are inapplicable because this indicator reads OHLCV only.

Validation limitation: the requested diff was reviewed, but test execution did not complete. The read-only checkout is on `main`; an in-memory execution attempt stopped at dependency loading. Available Node is 22.22.0 rather than the specified 24.21.0.

VERDICT: REVISE