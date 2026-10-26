import { describe, expect, it } from "vitest";
import {
  alignedPeriodBoundaries,
  MAX_HISTORICAL_ZONES,
} from "../volumeProfileZones";

const HOUR = 60 * 60 * 1000;

describe("alignedPeriodBoundaries", () => {
  it("produces epoch-aligned blocks covering the visible range, up to the exclusion point", () => {
    // visible: 0.5h .. 3.5h, period = 1h, live period starts at 4h (well
    // clear of the visible range) -- expect boundaries at 0h,1h,2h,3h.
    const blocks = alignedPeriodBoundaries(
      0.5 * HOUR,
      3.5 * HOUR,
      HOUR,
      4 * HOUR,
    );
    expect(blocks).toEqual([
      { rangeStartTs: 0, rangeEndTs: HOUR },
      { rangeStartTs: HOUR, rangeEndTs: 2 * HOUR },
      { rangeStartTs: 2 * HOUR, rangeEndTs: 3 * HOUR },
      { rangeStartTs: 3 * HOUR, rangeEndTs: 4 * HOUR },
    ]);
  });

  it("clips the final block's end to the exclusion boundary when it falls mid-block, never gapping or overlapping the live period", () => {
    // live period starts at 3.25h, mid-way through the 3h..4h aligned block.
    const blocks = alignedPeriodBoundaries(0, 3.5 * HOUR, HOUR, 3.25 * HOUR);
    const last = blocks[blocks.length - 1];
    expect(last).toEqual({ rangeStartTs: 3 * HOUR, rangeEndTs: 3.25 * HOUR });
  });

  it("returns nothing when the live period already covers the start of the visible range", () => {
    expect(alignedPeriodBoundaries(2 * HOUR, 5 * HOUR, HOUR, 2 * HOUR)).toEqual(
      [],
    );
    expect(alignedPeriodBoundaries(2 * HOUR, 5 * HOUR, HOUR, HOUR)).toEqual([]);
  });

  it("returns nothing for a degenerate (inverted) visible range instead of throwing", () => {
    expect(
      alignedPeriodBoundaries(5 * HOUR, 2 * HOUR, HOUR, 10 * HOUR),
    ).toEqual([]);
  });

  it("never emits more than the cap, even for a visible range spanning far more periods than that", () => {
    const blocks = alignedPeriodBoundaries(0, 1000 * HOUR, HOUR, 1000 * HOUR);
    expect(blocks).toHaveLength(MAX_HISTORICAL_ZONES);
  });

  it("honors an explicit maxBlocks override below the default cap", () => {
    const blocks = alignedPeriodBoundaries(
      0,
      1000 * HOUR,
      HOUR,
      1000 * HOUR,
      3,
    );
    expect(blocks).toHaveLength(3);
  });

  // Regression: the cap used to be applied walking FORWARD from the oldest
  // boundary, so the zones it discarded were the newest ones -- the candles
  // nearest the right edge of the chart. Invisible at a 4h period, where 50
  // zones is days, but at 1m (per-candle) 50 zones is under an hour, so a normal
  // 1m view was capped and the most recent candles never loaded at all.
  it("drops the OLDEST zones when capped, never the newest", () => {
    const minute = 60 * 1000;
    const now = 1000 * HOUR;
    // A 4h window of 1m candles is 240 periods -- well past the cap of 50.
    const blocks = alignedPeriodBoundaries(now - 4 * HOUR, now, minute, now);
    expect(blocks).toHaveLength(MAX_HISTORICAL_ZONES);

    const newest = blocks[blocks.length - 1];
    // The newest kept zone must be the one ending at the exclusion point, i.e.
    // the candle immediately before the live one.
    expect(newest.rangeEndTs).toBe(now);
    expect(newest.rangeStartTs).toBe(now - minute);

    // And the whole kept set is contiguous, ascending, and bunched at the right.
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i].rangeStartTs).toBe(blocks[i - 1].rangeEndTs);
    }
    expect(blocks[0].rangeStartTs).toBe(now - MAX_HISTORICAL_ZONES * minute);
  });

  it("aligns to the period grid even when the visible range starts mid-period, not to the visible start itself", () => {
    const blocks = alignedPeriodBoundaries(
      90 * 60 * 1000,
      2.5 * HOUR,
      HOUR,
      10 * HOUR,
    );
    // 90 minutes is mid-way through the 1h..2h block -- must start there, not at 90min.
    expect(blocks[0]).toEqual({ rangeStartTs: HOUR, rangeEndTs: 2 * HOUR });
  });

  it("rejects a non-positive periodMs", () => {
    expect(() => alignedPeriodBoundaries(0, HOUR, 0, HOUR)).toThrow(/periodMs/);
    expect(() => alignedPeriodBoundaries(0, HOUR, -1, HOUR)).toThrow(
      /periodMs/,
    );
  });

  it("rejects a non-positive maxBlocks", () => {
    expect(() => alignedPeriodBoundaries(0, HOUR, HOUR, 10 * HOUR, 0)).toThrow(
      /maxBlocks/,
    );
    expect(() =>
      alignedPeriodBoundaries(0, HOUR, HOUR, 10 * HOUR, 1.5),
    ).toThrow(/maxBlocks/);
  });
});
