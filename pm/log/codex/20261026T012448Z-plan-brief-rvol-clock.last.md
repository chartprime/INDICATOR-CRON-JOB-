The trading question is clear and useful, and the default view is close to build-ready. The calculation and acceptance contract still need revision.

1. **Specific trading question: yes.** Comparing participation with the same clock slot directly addresses whether normal session seasonality explains a volume spike. Keep the warning that high RVOL does not establish direction or follow-through. Replace “lights up only when the bar is unusual” with a qualified claim pending validation.

2. **Calculation: causal in intent, but not fully implementable as written.**

   - **Short-bar duration is unavailable through `interval_ms`.** [resampleBars.ts](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/apps/web/src/lib/chart/resampleBars.ts:125) emits the nominal target interval even when the equity bucket ends early. A 30-minute final hourly candle therefore still reports 60 minutes. Derive effective scheduled duration using the existing equity calendar and add that dependency to Data, or remove the claimed short-bar adjustment.
   - **Retention is incorrectly defined.** `10_080 * interval_ms` is elapsed time, not retained bar count. For one-minute equities it discards observations after seven calendar days, despite the brief expecting roughly 25 retained sessions. Define an explicit causal lookback horizon, or obtain actual retention information through a supported boundary. Narrow replay equivalence to outputs whose complete dependencies exist in the replay.
   - **Correction behavior needs rollback rules.** Updating a closed volume must also recompute the sustained counter from its state before that bar. Otherwise a qualifying close revised below threshold leaves an inflated run. Specify valid-to-invalid and invalid-to-valid corrections too, including removal or insertion in both baselines.
   - **Fallback commits cannot retroactively confirm drawings.** When the next timestamp commits a pending bar, the current-call marker rule prevents changing the previous bar’s marker. Explicitly define what stays provisional and scope live/replay equality accordingly.
   - Resolve whether the rolling SMA receives **volumes or rates**; both are specified. Rates are consistent with the proposed comparison.

3. **Data availability: mostly appropriate, with one material gap.** OHLCV capability gating, total volume, honest nulls, and ignoring absent bars comply with the [data rules](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/docs/architecture/indicators/data-for-indicator-authors.md). Effective short-bar duration is the missing input identified above. Also define one family-selection rule: the calculation currently mandates weekday/weekend families for crypto, while Controls makes that split optional and off by default.

4. **Default UX: understandable, with small fixes.** One ratio, a 1x reference, hot coloring, and three primary controls are reasonable. Define complete status precedence: unsupported timeframe → invalid current volume → insufficient samples → unusable baseline → forming → ready. Otherwise a forming bar can conceal that it has no usable baseline. Show unavailable table values as `—`, and specify that `n` counts prior observations used in the denominator.

5. **Success criteria: strong structure, but not yet reproducible or fully fair.**

   - Freeze fixture start dates, PRNG draw order, Box–Muller handling, and distinct-anomaly sampling. Seeds alone do not uniquely determine the fixture.
   - Define the extra 1,920 bars used by the 12,000-bar rollover test.
   - Replace the futures autumn repeated-hour fixture with a synthetic clock test: the New York Sunday 01:00 transition occurs while ES/NQ are closed.
   - Add explicit relative acceptance bounds for “lower false-positive rate” and “comparable recall.” Current absolute thresholds can pass even when rolling RVOL performs better.
   - Keep the rolling comparison, but add a **same-slot mean** comparison to separate the benefit of clock normalization from the benefit of using a median.
   - Measure the short-bar fixture through actual repository resampling, not hand-built candles with an assumed duration.

6. **Simplest alternative:** ship the same-slot median ratio, one hot threshold, and a learning count. Defer sustained-run markers, weekend splitting, and the optional rolling plot; retain rolling RVOL in validation. This answers most of the question with substantially fewer lifecycle edge cases.

VERDICT: REVISE