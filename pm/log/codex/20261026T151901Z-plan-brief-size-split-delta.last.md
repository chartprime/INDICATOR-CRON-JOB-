The concept is useful, but the brief needs revision before implementation. The main blockers are inconsistent data gating, incomplete marker rules, an insufficient retention-equivalence condition, and a fixture designed to disadvantage the baseline.

1. **Trading question: mostly passes.**

“Are large and small delivered trade frames buying or selling together?” is specific and useful for an order-flow trader. The participant-size disclaimer is appropriate.

“Which one is price following?” is only partly answered: divergence identifies one relationship with price; tier conflict does not establish which tier price follows. Narrow the question to **“Does large-print flow confirm this price extreme?”**, with small-print flow as context. Keep “join” and “fade” as trader decisions rather than validated outcomes.

2. **Calculation: incremental structure is sound, but several rules remain incomplete.**

Freezing the threshold, rescanning the forming bar, and inserting sizes once at commit are good choices. Resolve these details:

- **Commit order:** explicitly commit the previous tail and update its size ring *before* capturing the next bar’s `tierAtOpen` on supersession. Otherwise replay and explicit-close delivery can use different thresholds.
- **Unavailable share:** rule 5 defines `share = null` for missing or non-positive candle volume, but only rejects `share < minTapeShare`. State whether unknown share makes flow unavailable; “fail closed” implies it should. Pin zero-volume and zero-print cases.
- **Post-commit corrections:** rereading share after freezing flow can change eligibility without changing the cumulative contribution. Freeze eligibility too, or require a rebuild when a correction changes it.
- **Marker windows:** “last K committed bars with values” and `t-K..t-1` are different across gaps. Specify whether the current bar enters each mean, require exactly K valid observations, and define whether gaps and anchor resets clear marker state. Comparing cumulative levels across resets can manufacture divergence.
- **Retention:** recovering 4,096 prior sizes recovers the threshold, not the cumulative offset. Replaying only retained bars can still produce different cumulative values when the anchor precedes retention. Preserve an anchor checkpoint, restrict equivalence to fully retained anchors, or explicitly compare contributions separately from cumulative levels.

The no-future-data design is plausible, but `ctx` has no supplied `now`, and ticks are passed through without an SDK knowledge-time cutoff. Define the forming-bar cutoff and test replay with future prints already present in the store.

3. **Data availability: mostly honest, with one important contract mismatch.**

The tick-store boundary, provider units, thinned-history refusal, and Historical Mode policy agree with the repository contracts: [indicatorTypes.ts](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/apps/web/src/lib/chart/indicatorTypes.ts) and [data rules](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/docs/architecture/indicators/data-for-indicator-authors.md).

However, **`LIVE_PARTIAL` is `ctx.tradeAvailability`, not something detectable from `ctx.trades`.** It describes the runtime’s separate per-bar trade buffer. A complete `ctx.ticks` window can coexist with a partial trade buffer. Gating tick-derived values on that flag can therefore break live/replay equivalence.

Choose the authoritative source explicitly: use tick-store coverage for tick-derived calculations, or document and test why another gate is required. Also reconcile the summary’s promise of nulls on `LIVE_PARTIAL` with the calculation, which currently specifies only a status message.

The data list must also include **`bar.close`**, which the marker calculation requires.

4. **Default view: control count passes; immediate interpretation needs work.**

Two lines and at most three primary controls fit the SDK and UX limits. But cumulative signs describe flow since the anchor, not necessarily the current push. A trader can easily mistake positive cumulative large delta for current buying.

Add a short current-state description, such as “Large selling · small buying,” with a precisely defined window. Explain marker meanings visibly. The binding [UX standard](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/pm/cycle1/ux-standard.md) also requires condition name, time, and value in the table; the proposed two rows omit that. Several status strings exceed its 30-character cell limit.

“Top 2%” needs qualification: p98 is estimated from preceding frames, and ties or changing distributions can classify more than 2% of current prints as large.

5. **Validation: testable in outline, but the baseline comparison is not yet fair.**

The fixture explicitly makes price follow large flow and plants events that total delta conceals. That proves the split can expose information total delta loses; it does not establish generally superior divergence detection.

Required changes:

- Keep this fixture as a mechanism test. Add neutral, small-flow-led, and no-relationship regimes, using the protocol’s **at least ten seeds** and identical evaluation eligibility for both tools.
- Fix fixture chronology: prints must be timestamp-sorted before `candleOf`; forcing a close must also produce prints whose resulting candle has that close.
- Exclude warm-up bars from threshold assertions. The first two 100-print bars cannot have an auto threshold.
- Compute percentile expectations from the actual rolling ring. A 4,096-print suffix does not maintain exactly 2% large prints, and `>= p98` also includes tied boundary sizes.
- Replace “expected about one per regime” with exact conflict expectations after resolving marker windows.
- Apply the 40-per-1,000 budget to **both marker types combined**.

6. **Simplest alternative.**

Start with a **fixed size threshold and two per-bar delta histograms**, one large and one small, under the same coverage and share gates. It answers the immediate agreement question without adaptive-threshold warm-up, cumulative-anchor ambiguity, or divergence machinery. Use it as an additional baseline; require the adaptive cumulative version to demonstrate a clear benefit.

VERDICT: REVISE