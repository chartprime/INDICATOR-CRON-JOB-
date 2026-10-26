The trading question is clear and useful, but the brief needs another revision before build approval. The main blockers are replay consistency, short-bar slot assignment, and default crypto readiness.

1. **Specific trading question: yes.** “Is this volume unusual for this time of day?” supports a concrete participation check. Keep the direction/follow-through limitation. Replace “stays flat” with “normalizes recurring intraday volume patterns”; noise, regime changes, and limited samples still move the ratio.

2. **Calculation: causal, but not fully specified or replay-equivalent yet.**

   - **Corrections after commitment break equivalence.** Suppose a bar closes at volume 100, then receives a closed replacement at 150. Live state retains 100 in its ring/SMA, while replay inserts 150. Subsequent denominators differ. Specify correction handling that updates the committed observation or triggers reconstruction, while preserving the corrected bar’s pre-insertion denominator. Test a *changed-volume* closed replacement, not just an identical duplicate.
   - **Retention creates another divergence.** Live rings retain observations after their source bars leave chart retention; `REBUILT` creates fresh state from retained bars. With seven crypto days and a ten-observation lookback, those baselines can differ. Define whether retained history or longer-lived state is authoritative, then require equivalence under that explicit policy.
   - **Short equity bars can enter the wrong slot.** The resampler uses actual shortened `interval_ms`. A 15:30–16:00 hourly candle therefore has a 30-minute interval: the stated formula assigns slot 31, while regular hourly bars use hour slots. This collides with the ordinary 15:00 hourly slot. Use a stable clock-start key and explicitly handle duration differences; do not claim early-close bars necessarily compare like with like.
   - **Sustained markers need transactional state.** Specify committed run state plus a provisional current-bar calculation so repeated forming updates cannot advance the run. Resolve “third consecutive bar” versus configurable `sustainedBars`, define session boundaries, and state how null/invalid bars affect the run.
   - The runtime preserves supplied `closed` flags during replay; it does not make every replay bar closed. Correct that assumption and test replay with a forming tail.

3. **Data availability: mostly sound.** The listed fields exist, total volume needs no sided-volume data, and `OHLCV_POLICY` is appropriate. Missing-volume and missing-bar behavior is honest.

   **Default one-minute crypto weekends remain learning after every fresh seven-day replay:** only two weekend observations per slot are available, below `minSessions = 3`. This is a persistent coverage limitation, not merely a fresh-symbol warm-up. Change the default split/minimum, obtain sufficient supported history, or explicitly accept and prominently describe that behavior.

   Also define invalid-input precedence: an invalid current volume should report unavailable even when the slot is still learning.

4. **Default UX: understandable, with two fixes.** Three primary controls are appropriate, and hiding the rolling line keeps the view focused.

   - Show **“Forming — versus full-bar expectation”** beside the provisional value; lighter styling alone does not explain why an ordinary developing bar starts low.
   - The specified table omits the actual sample count promised elsewhere. Include it.
   - `timeframeGate` excludes the indicator from activation in ChartPanel, so an indicator-owned table cannot display the proposed gated status. Specify a host-level message or revise the gating/display approach.

5. **Validation: substantially testable; benchmark is fair for its stated narrow hypothesis.** Same bars, readiness, and threshold make the rolling comparison reasonable. However:

   - Freeze the PRNG, seed, exact U-curve formula, anomaly placement/uniqueness, and whether anomalies multiply expected volume or noisy volume.
   - Define false positives as detections on **non-anomaly eligible bars**, and report overall false-positive rate alongside predictable-slot results.
   - Fifteen × 390 bars is **5,850**, not the specified 10,080-bar performance replay. Supply a longer deterministic fixture and an explicit rollover/rebuild comparison.
   - Fix the lifecycle contradictions above before requiring unconditional live/replay equivalence. Add expected outcomes to the DST, gap, early-close, and changed-close fixtures.

6. **Simplest alternative:** a one-minute-only version using the median of prior observations at the exact clock minute, one RVOL line, one threshold, and hot markers. Defer weekend splitting, sustained markers, and the rolling display; retain rolling RVOL in validation. This answers most of the question while removing several lifecycle and duration complications.

VERDICT: REVISE