// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InitiativeBand } from "../../../../types/frames";
import { COUNTED_MARK, InitiativeCard, UNCOUNTED_MARK } from "../InitiativeCard";
import { describeInitiative } from "../initiativeHover";
import { WHALE_CARD_FLIP_BELOW_PX } from "../../whale-limit-order-heatmap/whaleCardLayout";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const T = Date.UTC(2026, 9, 14, 13, 40);

const band: InitiativeBand = {
  id: "b", candleMs: 300000, side: "up", dominant: "buyers", dominantShare: 0.71, score: 4,
  facts: { efficiency: { yes: true, value: 0.82 }, closes: { yes: true, value: 3 }, burst: { yes: true, value: 2.6 }, delta: { yes: true, rank: 0.88, share: 0.71 }, prints: { yes: false, rank: 0.65, perCandle: 1.5 } },
  pivotTs: T, pivotPrice: 82482, frozenTs: T + 900_000, frozenPrice: 82600, windowCandles: 4, atr: 32,
  legExtremePrice: 82584.4, legExtremeTs: T + 1_200_000, legEndTs: null, updatedAt: T + 1_200_000, origin: "runtime",
};

describe("the pinned Initiative Continuation card", () => {
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

  it("is the title, then the five facts one per line: a green tick or a purple cross with the fact's name on the left, the plain reason on the right; nothing else", () => {
    act(() => root.render(<InitiativeCard hover={describeInitiative(band)} x={40} y={260} />));
    const card = container.firstElementChild as HTMLDivElement;
    expect(card.className).toBe("whale-tooltip initiative buy");
    expect(card.style.left).toBe("40px");
    expect(card.style.top).toBe("260px");
    const [title, ...rows] = [...card.children] as HTMLDivElement[];
    expect(title.textContent).toBe("▲ BUY START · STRONG (4 of 5)");
    const cells = (row: HTMLDivElement) => [row.children[0].textContent, row.children[1].textContent];
    expect(rows.map(cells)).toEqual([
      ["✓ Clean move", "price went mostly one way"],
      ["✓ Strong candles", "3 of 4 closed near the high"],
      ["✓ Volume burst", "volume 2.6× the quiet before"],
      ["✓ Buyers in charge", "71% of orders were buys, unusually high"],
      ["✗ Big buyers", "large buy trades at a usual pace"],
    ]);
    const marks = rows.map((row) => row.children[0].children[0] as HTMLSpanElement);
    expect(marks.map((mark) => mark.textContent)).toEqual([COUNTED_MARK, COUNTED_MARK, COUNTED_MARK, COUNTED_MARK, UNCOUNTED_MARK]);
    expect(marks.map((mark) => mark.style.color)).toEqual(["rgb(74, 222, 128)", "rgb(74, 222, 128)", "rgb(74, 222, 128)", "rgb(74, 222, 128)", "rgb(167, 139, 250)"]);
    expect(rows.every((row) => row.style.display === "flex" && row.style.justifyContent === "space-between" && row.style.alignSelf === "stretch")).toBe(true);
    expect([COUNTED_MARK, UNCOUNTED_MARK]).toEqual(["✓", "✗"]);
  });

  it("opens below the click when there is no room above it, at the whale card's threshold, and above it otherwise", () => {
    act(() => root.render(<InitiativeCard hover={describeInitiative(band)} x={40} y={WHALE_CARD_FLIP_BELOW_PX - 1} />));
    expect((container.firstElementChild as HTMLDivElement).className).toBe("whale-tooltip initiative buy below");
    act(() => root.render(<InitiativeCard hover={describeInitiative(band)} x={40} y={WHALE_CARD_FLIP_BELOW_PX} />));
    expect((container.firstElementChild as HTMLDivElement).className).toBe("whale-tooltip initiative buy");
  });

  it("a down leg takes the sell colour whatever its flow; an up leg on sellers' flow keeps the buy colour", () => {
    act(() => root.render(<InitiativeCard hover={describeInitiative({ ...band, side: "down", dominant: "buyers", dominantShare: 0.55 })} x={0} y={300} />));
    const card = container.firstElementChild as HTMLDivElement;
    expect(card.className).toBe("whale-tooltip initiative sell");
    expect(card.children[0].textContent).toBe("▼ SELL START · STRONG (4 of 5)");
    act(() => root.render(<InitiativeCard hover={describeInitiative({ ...band, dominant: "sellers", dominantShare: 0.55 })} x={0} y={300} />));
    expect((container.firstElementChild as HTMLDivElement).className).toBe("whale-tooltip initiative buy");
  });
});
