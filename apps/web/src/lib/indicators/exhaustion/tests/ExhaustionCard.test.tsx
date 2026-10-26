// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExhaustionShade } from "../../../../types/frames";
import { ExhaustionCard } from "../ExhaustionCard";
import { describeExhaustion } from "../exhaustionHover";
import { WHALE_CARD_FLIP_BELOW_PX } from "../../whale-limit-order-heatmap/whaleCardLayout";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const T = Date.UTC(2026, 9, 10, 13, 40);

const shade: ExhaustionShade = {
  id: "s", candleMs: 60000, side: "buyers", status: "pending", intensity: 2, score: 5,
  readings: { rate: false, progress: true, delta: true, divergence: true, prints: true, book: false },
  values: { rate: 0.62, progress: 0.1, delta: -0.4, divergence: -1.4, prints: null, book: 0.95 },
  raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
  startTs: T, endTs: T + 60_000, extremeTs: T - 60_000, extremePrice: 108, legStartTs: T - 600_000, legStartPrice: 100,
  legSize: 8, efficiency: 1, atr: 1, judgedAt: null, updatedAt: T + 60_000, origin: "runtime",
};

describe("the pinned Exhaustion card", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("is the first line and then the six readings as numbers, one per line, label left and value right with its detail under it in grey, the value in the monitor's colour for whether it counted", () => {
    act(() => root.render(<ExhaustionCard hover={describeExhaustion(shade, true, "BTC")} x={40} y={260} />));
    const card = container.firstElementChild as HTMLDivElement;
    expect(card.className).toBe("whale-tooltip exhaustion sell");
    expect(card.style.left).toBe("40px");
    expect(card.style.top).toBe("260px");
    const [title, ...rows] = [...card.children] as HTMLDivElement[];
    expect(title.textContent).toBe("Buyers exhausted · 5/6 · ~60% · waiting for the verdict");
    const cells = (row: HTMLDivElement) => [row.children[0].textContent, row.children[1].children[0].textContent, row.children[1].children[1].textContent];
    expect(rows.map(cells)).toEqual([
      ["Buying volume", "3.00 BTC", "Leg: 14.2"],
      ["Price moved", "Now: 0.00 / 3.00", "Leg: 1.78 / 14.2"],
      ["Delta", "Buys: 3.00", "Sells: 7.00"],
      ["Vs the high", "Now: −4.00 (−40%)", "High: +20.0 (+100%)"],
      ["Big buyers", "Now: 0", "Leg: 0"],
      ["Book at the high", "Asks: 1.00", "High: 2.00"],
    ]);
    const value = rows[0].children[1] as HTMLSpanElement;
    expect([value.style.display, value.style.flexDirection, value.style.alignItems]).toEqual(["flex", "column", "flex-end"]);
    const detail = value.children[1] as HTMLSpanElement;
    expect([detail.style.fontSize, detail.style.color]).toEqual(["0.85em", "rgb(192, 195, 198)"]);
    expect(rows.map((row) => (row.children[1].children[0] as HTMLSpanElement).style.color)).toEqual(["rgb(167, 139, 250)", "rgb(74, 222, 128)", "rgb(74, 222, 128)", "rgb(74, 222, 128)", "rgb(74, 222, 128)", "rgb(167, 139, 250)"]);
    expect(rows.every((row) => row.style.alignItems === "baseline" && row.style.opacity === "")).toBe(true);
    expect(rows.every((row) => row.style.display === "flex" && row.style.justifyContent === "space-between" && row.style.alignSelf === "stretch")).toBe(true);
  });

  it("opens below the click when there is no room above it, at the whale card's threshold, and above it otherwise", () => {
    act(() => root.render(<ExhaustionCard hover={describeExhaustion(shade, true, "BTC")} x={40} y={WHALE_CARD_FLIP_BELOW_PX - 1} />));
    expect((container.firstElementChild as HTMLDivElement).className).toBe("whale-tooltip exhaustion sell below");
    act(() => root.render(<ExhaustionCard hover={describeExhaustion(shade, true, "BTC")} x={40} y={WHALE_CARD_FLIP_BELOW_PX} />));
    expect((container.firstElementChild as HTMLDivElement).className).toBe("whale-tooltip exhaustion sell");
  });

  it("a sellers' card takes the buy colour, names the sellers and the low, and still reads buys before sells", () => {
    act(() => root.render(<ExhaustionCard hover={describeExhaustion({ ...shade, side: "sellers", status: "held", judgedAt: T + 600_000 }, true, "BTC")} x={0} y={300} />));
    const card = container.firstElementChild as HTMLDivElement;
    expect(card.className).toBe("whale-tooltip exhaustion buy");
    expect(card.children[1].textContent).toBe("Selling volume3.00 BTCLeg: 14.2");
    expect(card.children[3].textContent).toBe("DeltaBuys: 7.00Sells: 3.00");
    expect(card.children[4].textContent).toBe("Vs the lowNow: +4.00 (+40%)Low: −20.0 (−100%)");
    expect(card.children[6].textContent).toBe("Book at the lowBids: 1.00Low: 2.00");
  });
});
