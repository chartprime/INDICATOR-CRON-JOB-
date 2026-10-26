// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { AbsorptionPrint } from "../absorptionEngine";
import { mergePrints, mergedAlpha, sphereKey, withoutBroken } from "../absorptionMerge";
import { BASE_ALPHA, PENDING_ALPHA, REFILL_ALPHA_STEP, SECOND_SPHERE_ALPHA } from "../absorptionPrimitive";

const H4 = 4 * 3_600_000;
const T = Math.floor(1_700_000_000_000 / H4) * H4;
const print = (ts: number, over: Partial<AbsorptionPrint> = {}): AbsorptionPrint => {
  const base = { side: "bid" as const, band: 5, rows: 4, ts, attackTs: ts - 10_000, share: 2, strong: false, shown: 2400, resting: 2400, absorbed: 600, yardstick: 10, current: 1800, refills: 0, price: 2600, judgedAt: ts, held: true as boolean | null, broken: false, ...over };
  return { ...base, key: `${base.side}:${base.band}:${base.rows}:${base.attackTs}` };
};

describe("mergePrints", () => {
  // The trader's 4h ETH chart of 2026-09-21: twenty spheres on one candle, none readable. A candle on the chart holds
  // 1,440 columns, and a sphere is a one-column event, so spheres of one side inside the same candle draw as one. The
  // store is untouched: every print stays a fact; this is how the facts are drawn when the chart cannot show them one
  // by one.
  it("draws the held spheres of one side inside one candle as one sphere at the candle, at the absorbed-weighted price, with the sums and the largest typical level", () => {
    const a = print(T + 600_000, { band: 5, price: 2600, absorbed: 600, shown: 2400, resting: 2400, yardstick: 10 });
    const b = print(T + 7_200_000, { band: 6, price: 2610, absorbed: 1800, shown: 3000, resting: 3000, refills: 2, share: 3, strong: true, yardstick: 15 });
    const [sphere] = mergePrints([b, a], H4);
    expect(sphere).toMatchObject({ key: sphereKey("bid", T, true), side: "bid", ts: T, count: 2, absorbed: 2400, resting: 5400, yardstick: 15, pending: false, broken: false });
    expect(sphere.price).toBeCloseTo((2600 * 600 + 2610 * 1800) / 2400);
    expect(sphere.prints.map((p) => p.ts)).toEqual([a.ts, b.ts]);
    expect(sphere.lowPrice).toBe(2600);
    expect(sphere.highPrice).toBe(2610);
  });

  it("counts an attack once, at its print, and reads a merged sphere as broken only when every wall in it broke", () => {
    // Two prints of the same attack (a live one and the history's twin, say) are one attack's flow, not two.
    const twice = mergePrints([print(T + 1000, { absorbed: 600 }), print(T + 1000, { absorbed: 900, refills: 1 })], H4)[0];
    expect([twice.count, twice.absorbed, twice.resting]).toEqual([2, 900, 2400]);
    expect(mergePrints([print(T + 1000, { broken: true }), print(T + 2000, { band: 6 })], H4)[0].broken).toBe(false);
    expect(mergePrints([print(T + 1000, { broken: true }), print(T + 2000, { band: 6, broken: true })], H4)[0].broken).toBe(true);
    expect(mergePrints([print(T + 1000, { broken: true })], 0)[0].broken).toBe(true);
  });

  it("keeps the two sides apart, keeps candles apart, and never merges a sphere still holding with one printed", () => {
    const prints = [
      print(T + 1000),
      print(T + 2000, { side: "ask", band: 9, price: 2700 }),
      print(T + H4 + 1000),
      print(T + 3000, { held: null }),
      print(T + 4000, { held: null, band: 7 }),
    ];
    const spheres = mergePrints(prints, H4);
    expect(spheres.map((s) => [s.side, s.ts - T, s.pending, s.count])).toEqual([
      ["bid", 0, false, 1],
      ["bid", 0, true, 2],
      ["ask", 0, false, 1],
      ["bid", H4, false, 1],
    ]);
  });

  it("merges by the chart's own candle: on the minute two prints a minute apart stay two, two inside one minute are one", () => {
    const M = 60_000;
    expect(mergePrints([print(T + 10_000), print(T + 70_000)], M)).toHaveLength(2);
    expect(mergePrints([print(T + 10_000), print(T + 50_000, { band: 6 })], M)).toHaveLength(1);
  });

  it("draws every print on its own when it is given no candle", () => {
    const prints = [print(T + 1000), print(T + 2000, { band: 6 })];
    const spheres = mergePrints(prints, 0);
    expect(spheres).toHaveLength(2);
    expect(spheres.map((s) => s.ts)).toEqual([T + 1000, T + 2000]);
    expect(spheres[0].price).toBe(2600);
  });

  it("returns the spheres in time order, the sides together, so the paint order is stable", () => {
    const spheres = mergePrints([print(T + H4 + 1), print(T + 1, { side: "ask", band: 9 }), print(T + 2)], H4);
    expect(spheres.map((s) => [s.ts - T, s.side])).toEqual([[0, "bid"], [0, "ask"], [H4, "bid"]]);
  });
});

describe("withoutBroken", () => {
  // The trader's switch of 2026-10-08, in place of "strong only": "Show broken levels" off hides the hollow spheres,
  // the ones whose wall was closed through or pulled within the break window; the walls that held stay, in their order.
  it("drops the broken spheres and keeps the rest in the order given, whatever the band, the side or the ring", () => {
    const first = print(T + 1000);
    const broken = print(T + 5000, { share: 3, strong: true, broken: true });
    const lone = print(T + 9000, { band: 7 });
    const other = print(T + 2000, { side: "ask", band: 9, broken: true });
    expect(withoutBroken([lone, broken, first, other]).map((p) => p.key)).toEqual([lone.key, first.key]);
    expect(withoutBroken([broken, other])).toEqual([]);
    expect(withoutBroken([])).toEqual([]);
  });
});

describe("mergedAlpha", () => {
  it("is the darkest of the merged spheres, a shade darker for every further print, capped; a merged pending stays faint", () => {
    const one = mergePrints([print(T, { refills: 1 })], H4)[0];
    expect(mergedAlpha(one)).toBeCloseTo(BASE_ALPHA + REFILL_ALPHA_STEP);
    const three = mergePrints([print(T + 1, { refills: 1 }), print(T + 2, { band: 6, share: 3, strong: true }), print(T + 3, { band: 7 })], H4)[0];
    expect(mergedAlpha(three)).toBeCloseTo(BASE_ALPHA + SECOND_SPHERE_ALPHA + 2 * REFILL_ALPHA_STEP);
    const many = mergePrints(Array.from({ length: 8 }, (_, i) => print(T + i, { band: i, share: 3, strong: true, refills: 3 })), H4)[0];
    expect(mergedAlpha(many)).toBe(1);
    const pending = mergePrints([print(T + 1, { held: null }), print(T + 2, { held: null, band: 6 })], H4)[0];
    expect(mergedAlpha(pending)).toBe(PENDING_ALPHA);
  });
});
