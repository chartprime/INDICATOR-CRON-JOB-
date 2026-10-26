1. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:494–498` and `apps/web/src/workers/tests/browserBinanceTransport.l1.test.ts:962–964`: unresolved seams still claim complete boundary milliseconds.**

   Keeping spans separate prevents a request spanning adjacent milliseconds from succeeding, but each span still claims its entire boundary millisecond. The new fixture contains missing fills 101–150 at `tA`, yet line 964 expects `[tA, tA+1)` to return `complete: true` before REST delivers those fills. When both spans share a millisecond, even the entire seam window incorrectly passes the coverage check. If REST fails, that false completeness persists.

   **Fix:** Exclude unresolved seam boundary milliseconds from coverage until REST reconciliation succeeds. Keep pending exclusions separate from permanently unverified timestamps. Change line 964 to expect `STORAGE_UNAVAILABLE`, and add delayed-response and failed-read tests for coincident spans, asserting completeness only after all required fills arrive.

Ran the requested diff and reproduced the coincident-millisecond coverage error using the branch’s actual interval helpers. Full branch tests were not run in this read-only checkout, which is on `main`.

VERDICT: REVISE