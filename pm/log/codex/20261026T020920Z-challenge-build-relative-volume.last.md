Inspected the requested diff and tests, and ran read-only reproductions using the branch’s TypeScript and repository runtime. The full Vitest suite was unavailable because project dependencies are absent. I found no direct future-data lookup or dependency on sided volume; a 100,000-bar engine run remained bounded.

1. **CONFIRMED — A cosmetic colour change can remove a confirmed signal.**  
   **Claim attacked:** The rolling line recolours in place.  
   **Input:** Default settings; eleven days of one-minute crypto bars. Volume is 100 for five days, then 300, with the final bar at 450. Change only `rollingColor`.  
   **Wrong behavior:** Reproduced through the runtime: latest RVOL changes from **2.25× to 1.5×**, and its confirmed marker disappears. `recolorAll()` requests replay because the `rvol` line lacks `recolor`; replay loses discarded baseline history.  
   **Settling test:** Add this runtime regression and require identical numeric outputs and marker membership after changing `rollingColor`.

2. **CONFIRMED — Default crypto lookback does not fit retention; reconnects can change current signals.**  
   **Claim attacked:** “The default lookback of ten fits,” and practical replay/live consistency.  
   **Input:** The eleven-day sequence above, followed by replay of the retained 10,080 bars. Alternatively, dispatch an identical closed duplicate of an older retained bar: `mergeChartBar()` classifies it as `REBUILT`.  
   **Wrong behavior:** Live has ten prior observations per slot; retained replay has only six at the latest bar. Ratios and confirmed markers can change without any volume correction. The documented retention caveat permits this mathematically, but the claim that ten fits is false for one-minute crypto.  
   **Settling test:** Test default `sessions: 10` after rollover, including reconnect and an unchanged older duplicate. Compare the latest outputs and markers, not only bars whose complete lookback survives retention.

3. **CONFIRMED — Gaps can introduce partial-hour baseline observations.**  
   **Claim attacked:** Missing bars contribute nothing; early closes are the identified shortened-duration problem.  
   **Input:** Resample hourly buckets containing thirty contiguous closed minutes followed by a missing second half, then receive a later bucket.  
   **Wrong behavior:** Reproduced: `resampleBars()` emits an hourly bar with volume 30 and `closed: false`; arrival of the next bucket commits that partial volume into the baseline. Ordinary outage truncation therefore joins the early-close limitation. With lookback two and observations `[60, 30]`, the next normal volume-60 hour reads **1.33×**.  
   **Settling test:** Drive source-minute gaps through resampling and the runtime, then assert baseline membership and the next session’s ratio.

4. **CONFIRMED — One marker per bar does not enforce the marker-rate ceiling.**  
   **Claim attacked:** Acceptable marker counts on busy instruments.  
   **Input:** Three complete crypto days at volume 100 per minute, followed by a day at 250 per minute, using defaults.  
   **Wrong behavior:** Reproduced **1,440 hot bars out of 1,440 eligible bars: 1,000 markers per 1,000 bars**. There is no cooldown or rate limiter. The frozen fixture’s low rate does not generalize to a session-wide volume shift.  
   **Settling test:** Run the marker-budget check on sustained regime shifts, clustered bursts, and low-baseline instruments. Distinguish a fixture-specific budget from an enforced ceiling.

5. **CONFIRMED — The 50-updates-per-second test misses warmed-up signals and browser rendering.**  
   **Claim attacked:** Evidence for inexpensive operation on a busy pair.  
   **Input:** The existing forming probe uses `timing.slice(-300)` as warm-up. That covers only five hours of distinct minute slots.  
   **Wrong behavior:** Every measured forming revision has `rvol: null`; the probe never exercises an active unusual marker. Its assertion allows an `onBar` p99 of **1 ms**, while the advertised **0.05 ms** gate belongs to a separate replay probe. Browser marker sorting, plugin updates, and fill rendering are excluded. This confirms a coverage gap, not a measured performance failure.  
   **Settling measurement:** Warm all relevant slots, retain a dense marker history, force threshold crossings at 50 Hz, and measure complete browser update latency and dropped frames.

6. **CONFIRMED — A single news day can inflate the median at supported settings.**  
   **Claim attacked:** Median prevents one news day from inflating tomorrow’s baseline.  
   **Input:** `sessions: 2`, `minSessions: 2`; same-slot volumes 100, 1,000, then 250.  
   **Wrong behavior:** The stored median is **550**, because the even-count median averages both observations. Tomorrow reads **0.455×**, rather than the 2.5× comparison against ordinary volume. At lookback two, median provides no advantage over mean.  
   **Settling test:** Add repeated-slot news shocks across supported lookbacks and warm-up counts; qualify the robustness claim accordingly.

7. **CONFIRMED — Several published results are printed but not pinned.**  
   **Claim attacked:** Tests establish the exact comparison tables and control-experiment agreement.  
   **Input:** A regression preserving eligibility while changing flat-control detections, recall, or false positives.  
   **Wrong behavior:** The control test still passes: its detection assertion is `anomaliesHit >= 0`. Main-fixture gates also permit eleven anomaly hits and do not pin the published thirteen detections or one false positive. The short `trendBars({ count: 1_000 })` marker-budget test never warms a default same-minute baseline.  
   **Settling test:** Assert the published counts explicitly, check control-method agreement, and require nonzero eligible RVOL outputs in every budget test.

VERDICT: FAIL