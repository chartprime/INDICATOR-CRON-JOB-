import { describe, expect, it } from "vitest";
import type { AbsorptionPrint } from "../absorptionEngine";
import { describeAbsorptionPrint, describeAbsorptionSphere } from "../absorptionHover";
import { mergePrints } from "../absorptionMerge";

const T = Date.UTC(2026, 8, 20, 17, 51, 0);
const print = (over: Partial<AbsorptionPrint> = {}): AbsorptionPrint => ({
  key: "bid:5075:4:0", side: "bid", band: 5075, rows: 4, ts: T, attackTs: T - 10_000, share: 0.25, strong: false, shown: 981, resting: 981, absorbed: 260, yardstick: 10, current: 690, refills: 3, price: 81208, judgedAt: T, held: true, broken: false, ...over,
});

describe("describeAbsorptionSphere", () => {
  it("reads as the one print when nothing was merged, and as the whole of a candle's spheres when they were", () => {
    const one = mergePrints([print()], 4 * 3_600_000)[0];
    expect(describeAbsorptionSphere(one, 4, "BTC")).toEqual(describeAbsorptionPrint(print(), 4, "BTC"));
    const H4 = 4 * 3_600_000;
    const T0 = Math.floor(T / H4) * H4;
    const three = mergePrints([print({ ts: T0 + 60_000 }), print({ ts: T0 + 3_600_000, band: 5076, price: 81224, absorbed: 400, shown: 1000, resting: 1000, refills: 1, share: 0.6, strong: true }), print({ ts: T0 + 7_200_000, band: 5070, price: 81128, absorbed: 300, shown: 900, resting: 900, refills: 0 })], H4)[0];
    const words = describeAbsorptionSphere(three, 4, "BTC");
    expect(words.title).toBe("Sellers absorbed · 3 bid walls");
    expect(words.headline).toBe("960 BTC absorbed of 2.9k BTC resting (33%) over 3 spheres");
    expect(words.wallLine).toBe("walls 81128–81224 · refilled 4×");
    expect(words.whenLine).toMatch(/^\d\d:\d\d:\d\d to \d\d:\d\d:\d\d UTC · one candle$/);
    // The same attack twice inside the candle (a live print and the history's twin): its absorbed is cumulative and its
    // resting is the same wall, so each attack counts once, at its fullest print.
    const sameAttack = mergePrints([
      print({ ts: T0 + 60_000, share: 0.25, absorbed: 250, shown: 1000, resting: 1000 }),
      print({ ts: T0 + 60_000, share: 0.6, strong: true, absorbed: 600, shown: 1000, resting: 1000 }),
    ], H4)[0];
    expect(describeAbsorptionSphere(sameAttack, 4, "BTC").headline).toBe("600 BTC absorbed of 1.0k BTC resting (60%) over 2 spheres");
    const pending = mergePrints([print({ ts: T0 + 1, held: null }), print({ ts: T0 + 2, held: null, band: 5076 })], H4)[0];
    expect(describeAbsorptionSphere(pending, 4, "BTC").title).toBe("Sellers hitting · 2 bid walls");
    expect(describeAbsorptionSphere(pending, 4, "BTC").headline).toMatch(/· holding$/);
    // Every wall in the candle broken later: the title says so.
    const broke = mergePrints([print({ ts: T0 + 1, broken: true }), print({ ts: T0 + 2, band: 5076, broken: true })], H4)[0];
    expect(describeAbsorptionSphere(broke, 4, "BTC").title).toBe("Sellers absorbed · 2 bid walls · broke later");
  });
});

describe("describeAbsorptionPrint", () => {
  it("says who was absorbed, by what wall, how much of what it held, what it held at the sphere, its refills, and when", () => {
    const words = describeAbsorptionPrint(print(), 4, "BTC");
    expect(words.side).toBe("bid");
    expect(words.title).toBe("Sellers absorbed · bid wall");
    expect(words.headline).toBe("260 BTC absorbed of 981 BTC resting (27%)");
    expect(words.wallLine).toBe("wall 81200–81216 · holding 690 BTC at the sphere · refilled 3×");
    // In UTC, labelled, like the tape and the chart's own axis: a laptop's local zone must not shift it.
    expect(words.whenLine).toBe("17:51:00 UTC · a quarter of the wall");
  });

  it("says the wall broke later when it did: a bar closed through it or it was pulled, after the sphere printed", () => {
    const words = describeAbsorptionPrint(print({ broken: true }), 4, "BTC");
    expect(words.title).toBe("Sellers absorbed · bid wall · broke later");
    expect(words.headline).toBe("260 BTC absorbed of 981 BTC resting (27%)");
    expect(describeAbsorptionPrint(print({ side: "ask", broken: true }), 4, "BTC").title).toBe("Buyers absorbed · ask wall · broke later");
  });

  it("reads as a hit still holding while pending, names buyers on an ask wall, and prints the band to the row's digits", () => {
    const pending = describeAbsorptionPrint(print({ side: "ask", held: null, refills: 0, share: 0.6, absorbed: 600, shown: 1000, resting: 1000 }), 0.14, "ETH");
    expect(pending.title).toBe("Buyers hitting · ask wall");
    expect(pending.headline).toBe("600 ETH absorbed of 1.0k ETH resting (60%) · holding");
    expect(pending.wallLine).toBe("wall 2842.00–2842.56 · holding 690 ETH at the sphere · no refill");
    expect(pending.whenLine).toMatch(/· sixty percent of the wall$/);
    expect(describeAbsorptionPrint(print({ share: 0.4 }), 4, "").whenLine).toMatch(/· 40% of the wall$/);
    expect(describeAbsorptionPrint(print({ share: 2, absorbed: 450, shown: 200, resting: 200 }), 4, "contracts").whenLine).toMatch(/· twice the wall$/);
    expect(describeAbsorptionPrint(print({ share: 2, absorbed: 450, shown: 200, resting: 200 }), 4, "contracts").headline).toBe("450 contracts absorbed of 200 contracts resting (225%)");
    // A thin book's wall is read as the heatmap's wall size when it showed less: the hover says both.
    expect(describeAbsorptionPrint(print({ share: 1, absorbed: 600, shown: 200, resting: 500 }), 4, "contracts").headline).toBe("600 contracts absorbed of 500 contracts wall (200 contracts shown) (120%)");
    expect(describeAbsorptionPrint(print({ share: 3 }), 4, "").whenLine).toMatch(/· 3× the wall$/);
    expect(describeAbsorptionPrint(print(), 4, "").headline).toBe("260 absorbed of 981 resting (27%)");
  });
});
