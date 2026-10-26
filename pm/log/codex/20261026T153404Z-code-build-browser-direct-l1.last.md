1. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:460–470, 1422–1426`**
   Coverage merges overlapping or adjacent milliseconds without verifying fill-ID continuity. Reproduced: one stream ends at timestamp 1000 with ID 100; the next starts at 1001 with ID 200. Coverage merges into one stretch and `nextSeamGap()` returns `null`, although fills 101–199 may be missing. `aggressive_history` can consequently report incomplete tape as complete.
   
   **Fix:** verify ID continuity or reconcile through REST before merging independently observed spans, including spans sharing a millisecond. Add regression tests for both cases.

2. **WARNING — `apps/web/src/workers/browserBinanceTransport.ts:772–781, 892–895`**
   Cached `done` means the bootstrap finished reading, even if its pages remain staged during the two-second grace period. Switching pairs then discards those pages. Returning restores `started: true`, `done: true`, and no staged pages, permanently skipping that bootstrap. Reproduced this restored state.
   
   **Fix:** persist staged pages and resume their commit, or cache completion only after they are committed so returning restarts the read. Test switching away during grace and returning.

Ran the requested diff and targeted in-memory reproductions against branch source. The full test suite was not run; the read-only workspace remains on `main`.

VERDICT: REVISE