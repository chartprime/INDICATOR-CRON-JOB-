import { describe, expect, it } from "vitest";
import type { ProfileBucket } from "../../../../types/frames";
import {
  DEFAULT_DELTA_VALUE_AREA_PCT,
  bucketDelta,
  computeDeltaLevels,
} from "../deltaProfileLevels";

function bucket(
  price: number,
  buy: number,
  sell: number,
  volume = buy + sell,
): ProfileBucket {
  return {
    price,
    volume,
    buy_volume: buy,
    sell_volume: sell,
    single_print: false,
  };
}

describe("bucketDelta", () => {
  it("is buy minus sell, negative when selling dominates", () => {
    expect(bucketDelta(bucket(100, 30, 10))).toBe(20);
    expect(bucketDelta(bucket(100, 10, 30))).toBe(-20);
    expect(bucketDelta(bucket(100, 10, 10))).toBe(0);
  });
});

describe("computeDeltaLevels", () => {
  it("returns empty (NaN) levels and a zero max for an empty bucket list", () => {
    const levels = computeDeltaLevels([]);
    expect(Number.isNaN(levels.pocPrice)).toBe(true);
    expect(Number.isNaN(levels.vahPrice)).toBe(true);
    expect(Number.isNaN(levels.valPrice)).toBe(true);
    expect(levels.maxAbsDelta).toBe(0);
  });

  it("puts the POC on the bucket with the largest |delta|, not the largest volume", () => {
    // Bucket 100 has more total volume (40) but a smaller net delta (4) than
    // bucket 102, whose delta of 30 wins on the delta profile.
    const levels = computeDeltaLevels([
      bucket(100, 22, 18, 40),
      bucket(102, 30, 0, 30),
    ]);
    expect(levels.pocPrice).toBe(102);
    expect(levels.maxAbsDelta).toBe(30);
  });

  it("treats selling as positive weight -- a big net-sell bucket can be the POC", () => {
    const levels = computeDeltaLevels([
      bucket(100, 25, 5), // +20
      bucket(102, 1, 40), // -39
    ]);
    expect(levels.pocPrice).toBe(102);
    expect(levels.maxAbsDelta).toBe(39);
  });

  it("expands the value area over |delta| until it reaches the target share", () => {
    // |delta|: 100 -> 10, 102 -> 40 (POC), 104 -> 10. Total 60; at the default
    // 70% the target is 42, so the POC's 40 pulls in exactly one more bucket.
    const levels = computeDeltaLevels([
      bucket(100, 15, 5), // +10
      bucket(102, 40, 0), // +40 POC
      bucket(104, 0, 10), // -10
    ]);
    expect(levels.pocPrice).toBe(102);
    const inArea = [levels.valPrice, levels.vahPrice];
    expect(inArea).toContain(102);
    // 40 alone is short of 42, so exactly one neighbour joins: 2 buckets total.
    expect(levels.vahPrice - levels.valPrice).toBe(2);
  });

  it("expands outward from the delta POC symmetrically by |delta| weight", () => {
    const buckets = [
      bucket(98, 4, 4), //  0
      bucket(100, 30, 0), //  +30 POC
      bucket(102, 0, 20), //  -20
      bucket(104, 1, 1), //   0
    ];
    // |delta|: 0, 30, 20, 0 -> total 50, 70% target 35. POC 30 pulls in the
    // heavier neighbour (20) -> 50 >= 35, spanning 100..102.
    const levels = computeDeltaLevels(buckets);
    expect(levels.pocPrice).toBe(100);
    expect(levels.valPrice).toBe(100);
    expect(levels.vahPrice).toBe(102);
  });

  it("breaks a POC tie toward the bucket nearest the price mid-range", () => {
    const buckets = [
      bucket(100, 10, 0), // +10
      bucket(110, 0, 10), // -10, equal |delta|
      bucket(120, 10, 0), // +10, equal |delta|
    ];
    // Mid-range of [100, 120] is 110, so the middle bucket wins the tie.
    expect(computeDeltaLevels(buckets).pocPrice).toBe(110);
  });

  it("breaks a remaining tie toward the lower price when the mid-range is equidistant", () => {
    const buckets = [bucket(100, 10, 0), bucket(110, 0, 10)];
    // Both |delta| 10; midpoint 105 is equidistant, so the lower price wins.
    expect(computeDeltaLevels(buckets).pocPrice).toBe(100);
  });

  it("handles an all-zero profile by naming the lowest bucket and reporting zero weight", () => {
    const levels = computeDeltaLevels([bucket(100, 5, 5), bucket(102, 3, 3)]);
    expect(levels.pocPrice).toBe(100);
    expect(levels.maxAbsDelta).toBe(0);
  });

  it("rejects a value-area percentage outside (0, 1]", () => {
    expect(() => computeDeltaLevels([bucket(100, 1, 0)], 0)).toThrow();
    expect(() => computeDeltaLevels([bucket(100, 1, 0)], 1.5)).toThrow();
    expect(() => computeDeltaLevels([bucket(100, 1, 0)], Number.NaN)).toThrow();
  });

  it("exposes the 0.7 default matching the server's volume convention", () => {
    expect(DEFAULT_DELTA_VALUE_AREA_PCT).toBe(0.7);
  });
});
