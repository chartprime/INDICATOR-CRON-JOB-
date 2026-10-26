1. **WARNING** — `apps/web/src/workers/browserBinanceTransport.ts`, lines **1158–1162, 1233–1235**: Coverage is inferred solely from its start and size floor. It ignores the acknowledged REST-to-stream seam and subsequent disconnects; kline recovery does not recover missing trades. I reproduced `complete: true, trades: []` for both unobserved intervals. Snapshot coverage likewise extends across these holes, allowing consumers to treat missing prints as valid data.

   **Fix:** Track observed tape intervals and require the entire requested window to be covered. Backfill gaps or return `STORAGE_UNAVAILABLE`; publish snapshot coverage only for a continuous interval. Add tests for a delayed stream connection, disconnect, and reconnect without tape backfill.

2. **WARNING** — `apps/web/src/workers/browserBinanceTransport.ts`, lines **1265–1271, 1315–1318**: Invalid aggregate-trade rows are silently discarded. The remaining rows then establish continuous coverage, and the reduced row count can prematurely terminate pagination. For example, one malformed row in a full page leaves 999 rows, stops the walk, and permits a “complete” history response despite a missing trade.

   **Fix:** Treat malformed pages as failed reads, preserving previously validated coverage and using the existing retry/degraded behavior. Base pagination on validated page integrity. Add a test with one malformed row inside a full page that asserts no completeness claim spans the missing data.

The requested diff was reviewed. Full Vitest execution was unavailable because dependencies are absent and the workspace is read-only; the coverage reproductions loaded branch code in memory.

VERDICT: REVISE