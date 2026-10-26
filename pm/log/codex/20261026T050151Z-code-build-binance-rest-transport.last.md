1. **WARNING — `apps/runtime/src/providers/binance/binance-rest-bar-cursor.js`, lines 40–49:** Catch-up requires an already-confirmed close. If subscription starts inside the finalisation grace and polling then pauses, missed candles are skipped because `confirmedOpenTime` remains null. With the permitted `pollMs=60000`, polling consistently at `:00.500` never finalises any candle; the forming map also grows indefinitely. An executable reproduction produced zero closed candles after ten polls.
   
   **Fix:** Track the earliest unconfirmed minute from the first request and continue from it until finalised or explicitly marked missing. Add tests for an outage before the first confirmed close and minute-long polling inside the grace window.

2. **WARNING — `apps/runtime/src/providers/binance/binance-rest-connection.js`, lines 576–579 and 635–638:** Empty kline responses refresh feed freshness and can end recovery. At startup, `rows: []` produces `catchingUp: false`, so repeated empty responses report READY indefinitely without delivering candles. Responses containing only obsolete rows can similarly hide a stalled candle feed.
   
   **Fix:** Distinguish HTTP success from candle coverage. Keep recovery active when expected minutes are absent, retain the continuation cursor, and base candle freshness on relevant observations. Add tests for empty startup responses, repeated empty polls, and responses containing only old candles.

Reviewed against the final candles-only amendment. Cursor reproductions ran directly against branch source; the full Jest suite was not run because the read-only workspace is checked out on `main`.

VERDICT: REVISE