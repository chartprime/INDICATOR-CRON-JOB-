import { describe, expect, it } from "vitest";
import type { ExhaustionRaw, ExhaustionSide } from "../../../../types/frames";
import { countText, exhaustionLabels, exhaustionValueTexts, priceText, shareText, signedVolumeText, volumeText } from "../exhaustionWords";

const RAW: ExhaustionRaw = { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 };

describe("exhaustion words", () => {
  it("the book row is the book at the extreme and its amount line names the band that decided the reading, mirrored for each side", () => {
    expect(exhaustionLabels("sellers").book).toBe("Book at the low");
    expect(exhaustionLabels("buyers").book).toBe("Book at the high");
    const book = (side: ExhaustionSide, bookBand: 0 | 1 | 2) => exhaustionValueTexts(side, { ...RAW, bookNow: 4, bookAt: 8, bookBand }, "BTC").book;
    expect(([0, 1, 2] as const).map((band) => book("sellers", band))).toEqual([{ main: "Bids: 4.00", sub: "Low: 8.00" }, { main: "Deeper bids: 4.00", sub: "Low: 8.00" }, { main: "Asks above: 4.00", sub: "Low: 8.00" }]);
    expect(([0, 1, 2] as const).map((band) => book("buyers", band))).toEqual([{ main: "Asks: 4.00", sub: "High: 8.00" }, { main: "Deeper asks: 4.00", sub: "High: 8.00" }, { main: "Bids below: 4.00", sub: "High: 8.00" }]);
    expect(exhaustionValueTexts("sellers", { ...RAW, bookNow: null, bookAt: null, bookBand: null }, "BTC").book).toEqual({ main: "Now: —", sub: "Low: —" });
  });

  it("vs the extreme shows each window's net beside its share of the window's volume, buys minus sells, the share being what the engine compares", () => {
    expect(exhaustionValueTexts("sellers", { ...RAW, own: 3, other: 1, extremeOwn: 1, extremeOther: 0.1 }, "BTC").divergence).toEqual({ main: "Now: −2.00 (−50%)", sub: "Low: −0.90 (−82%)" });
    expect(exhaustionValueTexts("buyers", { ...RAW, own: 0, other: 0, extremeOwn: 2, extremeOther: 2 }, "BTC").divergence).toEqual({ main: "Now: 0", sub: "High: 0 (0%)" });
    expect([shareText(1, 3), shareText(3, 1), shareText(1, 1), shareText(0, 0), shareText(null, 1), shareText(0.004, 0)]).toEqual([" (−50%)", " (+50%)", " (0%)", "", "", " (+100%)"]);
  });

  it("price moves drop their decimals from a hundred up and volumes step to whole thousands from a hundred thousand and to millions from a million, so the longest realistic amounts fit the 19-character column", () => {
    expect([priceText(15.11), priceText(-99.994), priceText(-99.996), priceText(145.75), priceText(-2345.67), priceText(-0.001), priceText(0)]).toEqual(["15.11", "−99.99", "−100", "146", "−2346", "0.00", "0.00"]);
    expect([volumeText(0.004, "BTC"), volumeText(1.27, "BTC"), volumeText(99_949, "BTC"), volumeText(99_950, "BTC"), volumeText(412_345, "BTC"), volumeText(999_499, "BTC"), volumeText(999_500, "BTC"), volumeText(1_250_000, "ETH")]).toEqual(["0.00", "1.27", "99.9k", "100k", "412k", "999k", "1.00M", "1.25M"]);
    expect([volumeText(7, "contracts"), volumeText(12_400, "shares"), volumeText(150_000, "contracts"), volumeText(1_250_000, "shares"), volumeText(0, "contracts")]).toEqual(["7", "12.4k", "150k", "1.3M", "0"]);
    const longest = [
      exhaustionValueTexts("sellers", { ...RAW, own: 412_345, legOwn: 9_999_999, moved: -2345.67, legMoved: 12_345.5 }, "BTC"),
      exhaustionValueTexts("buyers", { ...RAW, own: 150_000, other: 0, legOwn: 1_250_000, moved: -145.75, legMoved: 230.25, extremeOwn: 0, extremeOther: 999_999 }, "contracts"),
      exhaustionValueTexts("sellers", { ...RAW, own: 1_250_000, other: 0, legOwn: 3_000_000, moved: -234.5, legMoved: 1015.5, extremeOwn: 999_999, extremeOther: 0 }, "ETH"),
    ];
    for (const texts of longest) for (const { main } of Object.values(texts)) expect(main.length).toBeLessThanOrEqual(19);
    expect(longest[0].progress).toEqual({ main: "Now: −2346 / 412k", sub: "Leg: 12346 / 10.00M" });
    expect(longest[1].divergence.main).toBe("Now: +150k (+100%)");
    expect(longest[2].divergence.main).toBe("Now: −1.25M (−100%)");
  });

  it("a net that rounds to zero carries no sign; signed amounts keep theirs, k and M included; counts keep one decimal when fractional", () => {
    expect([signedVolumeText(-0.001, "BTC"), signedVolumeText(0.001, "BTC"), signedVolumeText(-2, "BTC"), signedVolumeText(412_345, "BTC"), signedVolumeText(-1_250_000, "ETH"), signedVolumeText(0, "contracts"), signedVolumeText(null, "BTC")]).toEqual(["0.00", "0.00", "−2.00", "+412k", "−1.25M", "0", "—"]);
    expect([countText(3), countText(7.6), countText(0.049), countText(null)]).toEqual(["3", "7.6", "0.0", "—"]);
  });
});
