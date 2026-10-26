1. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:1693–1705`**  
   A closed stream span contained within one millisecond has `from === to`. The first-boundary branch handles it first and drops every aggregate with `f >= firstId`, including aggregates wholly **after** `lastId`. Those missing trades are never seeded or marked unverified, yet the seam can become complete.  
   **Fix:** Reconcile against both ID boundaries when timestamps coincide. Add a test with a one-trade span and aggregates before, inside, after, and straddling it.

2. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:1653–1661`**  
   Bootstrap coverage includes the oldest row’s entire millisecond. A walk stopped at the page budget can start midway through that millisecond; earlier aggregates sharing its timestamp were never fetched. ID continuity within the fetched pages does not establish complete timestamp coverage at that edge.  
   **Fix:** Exclude the oldest millisecond unless its beginning is verified, or fetch the preceding boundary rows. Test a page-budget cutoff splitting several aggregates with the same timestamp.

3. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:1516–1519`**  
   History completeness uses the live interval’s infinite endpoint. Requests up to 60 seconds into the future pass validation and can receive `complete: true` with empty trades. This records unobserved time as complete history.  
   **Fix:** Bound history completeness by a finite observation cutoff; return unavailable for windows extending beyond it. Add a future-window regression test.

Executed targeted probes against the branch’s transpiled code: finding 1 dropped the after-span aggregate without marking uncertainty; finding 3 returned complete empty future history. The full test suite was not run; the read-only checkout is on `main`.

VERDICT: REVISE