1. **WARNING — Marker-budget failures pass the tests.**  
   [sizeSplitDeltaBaseline.test.ts](/home/user/Terminal-L1-L2/worktrees/size-split-delta/apps/web/src/lib/indicators/size-split-delta/tests/sizeSplitDeltaBaseline.test.ts:329), lines 329–339; also 167–178. The busy fixture reports 59 markers per 1,000 against the required ceiling of 40, but asserts that failing count instead of `verdict.ok`. The mechanism fixture checks the ceiling with conflict disabled, then omits it for the combined markers.  
   **Fix:** Assert `judgeBudget(..., 40, 2).ok` for both required configurations. Resolve failures through an approved specification change or implementation correction before acceptance.

2. **WARNING — The scan’s size snapshot exceeds its specified bound.**  
   [sizeSplitDeltaMath.ts](/home/user/Terminal-L1-L2/worktrees/size-split-delta/apps/web/src/lib/indicators/size-split-delta/sizeSplitDeltaMath.ts:187), lines 187–201. `sizes.push()` collects every valid print before `splice()` retains 4,096. A busy window can therefore allocate an array approaching the entire 250,000-print store on every forming revision, exceeding the promised 32 KB snapshot and creating repeated allocation pressure.  
   **Fix:** Collect sizes in a fixed-capacity circular buffer during scanning while continuing to accumulate flow across every print. Test a window containing substantially more than 4,096 prints.

3. **WARNING — Retention shifts the entire record history per commit.**  
   [sizeSplitDeltaMath.ts](/home/user/Terminal-L1-L2/worktrees/size-split-delta/apps/web/src/lib/indicators/size-split-delta/sizeSplitDeltaMath.ts:500), lines 500–501. Once retention fills, removing index zero with `splice()` shifts approximately 10,080 references on every committed bar. This is an array with bounded length, but it violates the specified circular-record storage and prohibition on moving large arrays per bar.  
   **Fix:** Preallocate the record buffer and overwrite entries using a head index. Produce chronological views only when tests or diagnostics request them.

4. **WARNING — Unavailable and learning states always render three rows.**  
   [sizeSplitDelta.ts](/home/user/Terminal-L1-L2/worktrees/size-split-delta/apps/web/src/lib/indicators/size-split-delta/sizeSplitDelta.ts:193), lines 193–203. `sizeSplitTableRows()` unconditionally returns state, condition, and status rows, producing two unavailable placeholders during warm-up and REST operation. The brief explicitly requires one status row for these states.  
   **Fix:** Return only the status row during learning or unavailable operation, clear previously populated cells when transitioning, and pin those transitions in tests.

The PM’s UX rulings authorize onset-only divergence arrows. I found no additional defect in the threshold timing, close/supersession freeze, window cutoff, or coverage/share gates.

Test execution was attempted, but filesystem restrictions blocked Vitest’s temporary-file creation before any tests ran.

VERDICT: REVISE