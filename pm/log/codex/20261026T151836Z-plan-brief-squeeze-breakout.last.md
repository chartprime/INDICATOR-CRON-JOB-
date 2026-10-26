The brief has a useful trading purpose and available candle inputs, but the state machine and baseline comparison need revision before implementation.

1. **Trading question: mostly passes.** The coherent question is: “Did price break an established compression range with range and volume support, and did it return inside?” Trend bias is reasonable secondary context. Keep that framing; “confirmed” should explicitly mean both activity thresholds passed, without implying follow-through.

2. **Calculation: incremental in structure, but not fully specified or replay-consistent.** Read-before-write snapshots are a good foundation. These issues block approval:

   - **The never-closed-bar limitation changes events.** I checked the installed `trading-signals` implementation with 100 committed bars whose closes alternate between ten bars at 90 and ten at 110, each with high/low ±0.1. On the next committed 90 bar, clean streams report `squeezeOn=false`. Inserting a never-closed bar with high 10,000, low 0, close 100 before it makes `squeezeOn=true`. Under rule 6(b), one path opens a box and the other does not. This meets the PM ruling’s requirement for new evidence: box creation changes, not merely display. Use retractable committed-state calculations for event-driving bands, with forming values evaluated provisionally.
   - **Freeze the actual tested edges.** Rule 6(c) extends the box with the break bar before 6(d) freezes it. For an existing `[90,110]` box and a break bar with high 115 and close 114, freezing the extended box makes the breakout close lie inside its own failure range. Freeze `boxAtOpen` edges; track the break bar’s excursion separately.
   - **Specify transition priority.** Define what happens when a break coincides with `offRun > releaseBars`, whether failure on the fifth subsequent bar counts, and what `offRun` becomes after re-arming. Define whether age counts squeeze bars or all surviving bars.
   - **Complete correction rollback.** Snapshots must cover excursion extremes, held boxes, last-event state, previous close, and the EMA-history ring—not just denominators and the active box. Include invalid-to-valid corrections and removal of a corrected failure.
   - **Define counters and settings precisely.** Use an owned committed-bar counter for expiry. Explain how `squeezeLength` changes warm-up while denominators remain 20 bars. Specify whether the range denominator contains high-minus-low or true range.

   The intended calculations are causal; the problem is inconsistent state across dispatch histories.

3. **Data availability: passes; missing-data behavior needs revision.** OHLCV policy is appropriate across the named archived instruments, and total volume avoids sided-volume availability problems. This agrees with the [data rules](/home/user/Terminal-L1-L2/Terminal-L1-L2-development-indicator-sdk/docs/architecture/indicators/data-for-indicator-authors.md).

   However, `ringMean` accepts partial windows and zero means. Require 20 valid prior observations and positive denominators before grading. Otherwise a zero baseline can satisfy confirmation trivially. Distinguish unavailable volume from observed low volume in the table and numeric outputs; `denominatorMissing` currently has no output seam or specified visible wording. Also specify price validity, including `high ≥ low`, and whether missing volume preserves valid price context.

4. **Default view: promising, but not yet understandable in seconds.** Three primary controls satisfies the contract. Improve the default presentation by:
   
   - Showing the current box’s numeric edges in the table. SDK lines have no current-value axis labels, so lines alone do not provide the promised exact levels.
   - Showing which test passed: range, volume, or both. “Partial” currently leaves the trader guessing.
   - Keeping the warm-up table visible despite “nothing drawn before warm-up.”
   - Defining which box owns `boxHigh`/`boxLow` when held and active boxes coexist, and how the eight-handle pool evicts boxes when full.

   Shorten table strings to the binding UX limit and add two-zoom screenshots to acceptance.

5. **Success criteria: testable in many respects; baseline comparison is not fair yet.** Exact-value tests, protocol checks, performance bounds, and recorded live/replay comparisons are strong.

   The key comparison currently pits **filtered tool markers** against **all TTM release events**. Compare all events with all events, and apply the same range/volume filter to both when comparing marked events. Report direction-correct hits, unique matched events, early events, and unmatched events separately. Bollinger should also have an explicit event rule—every outside close or only the crossing—because those produce very different counts.

   Detection must require the labelled direction; `breakGrade > 0` alone can count a wrong-way break as a hit. Add fixtures for failure, successful continuation, re-arming, and correction cancellation. The current breakout labels do not validate the advertised failure behavior. Treat the scratch results as development evidence and add untouched evaluation seeds.

   Finally, reconcile `maxReplayBars: 3,000` with the stated 10,080-output retention test, and define the compared replay horizon. Recursive EMAs and arbitrarily old active boxes can differ after a bounded replay.

6. **Simplest alternative:** retain the squeeze-qualified range, mark closes outside its frozen edges, and mark returns inside within five bars. Show range and volume multiples as context; defer EMA bias, automatic widening/re-arming, and multiple held boxes. Benchmark that version too—it tests whether the extra machinery adds value.

VERDICT: REVISE