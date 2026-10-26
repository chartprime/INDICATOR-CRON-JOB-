The trading question is clear and useful, and the default view is appropriately focused. The calculation still has two repository-level mismatches and an incomplete replacement rule that need fixing before build approval.

1. **Specific trading question: passes.** “Is participation unusual for this time of day?” is one concrete question. The direction and follow-through disclaimer is appropriate. Describe the result as unusual *relative to recent comparable bars*; “lights up only when unusual” overstates what a short, noisy baseline can establish.

2. **Calculation: incremental and causal in principle, but not fully specified.**

   - **Short-bar normalization does not match the SDK.** The resampler calculates a shortened equity bucket’s session span, but emits `interval_ms: targetIntervalMs`. A 15:30–16:00 hourly candle therefore still declares 60 minutes. Dividing by `interval_ms` halves its actual volume rate. The early-close acceptance fixture assumes data the indicator will not receive. Derive scheduled duration using the existing market calendar, explicitly include that dependency in the data section, and test actual resampled `BarFrame`s. See [resampleBars.ts](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/apps/web/src/lib/chart/resampleBars.ts:125).
   - **Retention is a bar count, not elapsed time.** `10_080 * interval_ms` is not the chart’s retention window. On one-minute equities, it discards observations after seven calendar days even though 10,080 regular-session bars cover about 25 sessions. Gaps and higher-timeframe resampling create further differences. Use the actual retained-series boundary through a supported runtime path, or explicitly choose a separate time-based horizon and remove the claim that it matches chart retention. See [candleLifecycle.ts](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/apps/web/src/lib/chart/candleLifecycle.ts:3).
   - **Replacement handling must cover all derived state.** Updating the ring is insufficient: specify replacement of the rolling SMA’s last committed input and recomputation of the sustained counter from its value *before this bar*. Test a closed correction crossing `sustainedLevel` in both directions, including marker removal. Also specify valid→invalid and invalid→valid corrections.
   - **Fallback commitment conflicts with confirmation wording.** If an unclosed bar commits when the next bar arrives, its earlier output and marker remain provisional under the stated rendering rule. Define whether that is intentional; the runtime normally replaces only the current timestamp’s output.

   Read-before-write medians and full-bar expectations for forming bars otherwise avoid future data.

3. **Data availability: mostly passes, with the duration exception above.** Total volume requires no sided-volume inference, and `OHLCV_POLICY` is appropriate. Invalid volume and gaps are handled honestly. Resolve the contradiction between calculation step 1’s mandatory crypto weekday/weekend families and the advanced setting’s default `weekendSplit: false`. Write one explicit clock/family resolution rule.

4. **Default usability: passes with small corrections.** One ratio, a 1× reference, orange unusual bars, and three primary controls are understandable quickly. Specify complete status precedence: unsupported timeframe → invalid volume → insufficient samples → unusable baseline → forming → ready. Otherwise a forming, unready bar could misleadingly display only “versus full-bar expectation.” Label the table sample count as prior samples used in the denominator, excluding the current bar.

5. **Validation: testable in outline, but the baseline and replay claims need tightening.**

   - The calculation alternates between rolling **volumes** and rolling **rates**. Choose rates for both methods when durations differ; one-minute fixtures conceal this inconsistency.
   - Replace “REBUILT reproduces live state exactly” with equivalence on bars whose complete dependencies are retained. Earlier retained outputs can legitimately lose their pre-retention warm-up. Sustained markers also depend on run history, so define their comparison eligibility separately or provide a bounded reset rule.
   - The weekday readiness expectation is wrong for arbitrary seven-day start dates: three prior weekdays need not exist by calendar day 4. Freeze the start timestamp and assert readiness from actual prior family observations.
   - Freeze fixture generation order, anomaly sampling/deduplication, and the extra 1,920 rollover bars. A seed alone does not specify these.
   - The same-bar, same-threshold comparison is fair for the stated descriptive experiment. However, the equity fixture deliberately contains clock seasonality and places every anomaly at midday. Add a flat-seasonality control and anomalies at the open/close before making broader claims about superiority.

6. **Simplest alternative:** ship the same-slot median ratio with one line, the readiness table, lookback and threshold controls. Keep rolling RVOL in the validation report; defer sustained markers and optional weekend splitting. That retains most of the trading value while removing substantial state and UX complexity.

VERDICT: REVISE