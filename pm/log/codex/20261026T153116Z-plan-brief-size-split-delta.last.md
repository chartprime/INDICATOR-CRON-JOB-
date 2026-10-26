The question is focused and useful, but the brief is not build-ready. The main blockers are an impossible fixture assertion, a commit path the SDK cannot publish correctly, and an unfair baseline comparison.

1. **Trading question: passes.** “Does large-print flow confirm this price extreme?” describes one concrete observation. Calling these delivered trade frames rather than participants is honest. Keep that distinction in fixture commentary too: replace “whales sell into it” with “large prints oppose the move.”

2. **Calculation: mostly specified, with two important gaps.**

   - **Supersession cannot finalize the previous plotted bar through this contract.** Rule 6(b) rescans and potentially changes the previous tail while processing the next bar. The [runtime](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/apps/web/src/lib/chart/indicatorRuntime.ts:657) then appends only the current output; it does not rewrite the previous output or its provisional colour. Internal cumulatives can therefore disagree with the displayed history and replay. Require a final dispatch for the previous bar before appending, or explicitly scope a runtime change. Test a print arriving after the tail’s last revision but before supersession.
   - **Anchor reset must apply to forming output too.** Rule 8 resets on commitment, while rule 7 uses the frozen cumulative plus the forming contribution. As written, the first forming bar of a new day can display yesterday’s cumulative and compare against yesterday’s marker ring. Specify an effective zero base and empty comparison ring immediately on entering a new anchor window.

   The committed-bar timestamp cutoff and read-before-write threshold otherwise avoid future data. Add forming-prefix checks, rather than relying solely on closed-bar equivalence.

3. **Data availability: substantially passes.** The declared tick fields exist in [IndicatorTicks](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/apps/web/src/lib/chart/indicatorTicks.ts:23), and coverage gating, REST nulls, Historical Mode refusal, provider units, and the equity share limitation are appropriate.

   Correct the retention promise: `discardLeading` trims runtime outputs and markers; it does **not** notify indicator state. Specify how your retained records are bounded, or remove them if running totals and the two rings suffice. Replay equivalence also needs an exact eligibility rule: retaining the cumulative anchor does not necessarily retain the preceding 4,096-size threshold history.

4. **Default view: close, but needs clearer priority.** Three primary controls and two lines meet the limits. However, the current three-bar buying/selling row answers a different observation from confirmation of a price extreme. Make divergence/confirmation the primary state, and default conflict circles off as secondary context.

   Specify how the three-bar summary resets across gaps and anchors, how stale conditions are cleared or dated, and which condition wins when both fire. Preserve the one-row warm-up view. Include compact current values, as the binding UX standard requires; SDK lines have no current-value axis labels.

5. **Validation: testable in structure, currently contradictory and biased.**

   - **The p98 assertion cannot pass.** After two fixture bars, the ring contains 196 small prints and four 1.0 prints. Nearest-rank p98 is rank `ceil(0.98 × 200) = 196`: the largest **small** print. With `size >= threshold`, at least that small print classifies large. Keep the specified percentile and remove the perfect-separation assertion, or change the fixture’s proportions.
   - **The simpler baseline receives a different detector.** The proposed tool compares cumulative delta against the prior price-extreme bar; baseline (b) tests a three-bar sum. This confounds adaptive sizing, accumulation, and detection logic. Compare fixed versus adaptive thresholds using the same detector first; assess the per-bar alternative separately.
   - **The labels favour baseline (b)’s formula.** They define truth using a three-bar opposing sum, while the tool measures cumulative divergence. Define truth independently and specify strict versus tied extremes, event matching, and treatment of the `"small"` regime.
   - **Fallback is underspecified.** “Ship (b)” changes the promised calculation, controls, markers, view, and documentation. Give the fallback its own frozen acceptance contract before building.
   - Pin the whale-versus-crowd test to fixed mode or a shared warmed threshold; default auto mode cannot classify an isolated whale tape before 200 sizes.

6. **Simplest alternative:** a fixed size threshold with large-print per-bar delta and one divergence marker; small-print delta optional. It answers most of the question while removing adaptive warm-up, percentile state, cumulative anchors, and much of the retention complexity. Require demonstrated benefit before adding those mechanisms.

VERDICT: REVISE