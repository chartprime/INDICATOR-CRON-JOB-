// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WhaleWallCard } from "../WhaleWallCard";
import { WHALE_CARD_FLIP_BELOW_PX, WHALE_CARD_WIDTH_PX, clampCardX } from "../whaleCardLayout";
import type { WhaleCard } from "../whaleCard";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CARD: WhaleCard = {
  side: 0,
  title: "BID · FILLED",
  usd: "$8.0M",
  sentence: "Sellers ate 76% of this $8.0M bid in 4.2 min.",
  meterPct: 76,
  facts: "100 BTC · 4.2 min · 14:03 to 14:07 UTC",
  details: [["First bite", "14:04:13 (seen)"], ["Price", "80000.0"]],
};

let mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
});

async function show(card: WhaleCard, pinned: boolean, x = 120, y = 80) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(<WhaleWallCard card={card} x={x} y={y} pinned={pinned} />));
  return container;
}

describe("whale wall card", () => {
  it("shows the title, size, sentence, traded meter and facts on hover, without the details", async () => {
    const container = await show(CARD, false);
    const root = container.querySelector(".whale-wall-card") as HTMLElement;
    expect(root.classList.contains("buy")).toBe(true);
    expect(root.classList.contains("pinned")).toBe(false);
    expect([root.style.left, root.style.top, root.style.width]).toEqual(["120px", "80px", `${WHALE_CARD_WIDTH_PX}px`]);
    expect(container.querySelector(".whale-wall-card-title")?.textContent).toBe("BID · FILLED");
    expect(container.querySelector(".whale-wall-card-usd")?.textContent).toBe("$8.0M");
    expect(container.querySelector(".whale-wall-card-sentence")?.textContent).toBe(CARD.sentence);
    expect((container.querySelector(".whale-wall-card-meter-fill") as HTMLElement).style.width).toBe("76%");
    expect(container.querySelector(".whale-wall-card-facts")?.textContent).toBe(CARD.facts);
    expect(container.querySelector(".whale-wall-card-details")).toBeNull();
    expect(container.querySelector(".whale-wall-card-hint")).toBeNull();
  });

  it("adds the detail rows and the way to close it once pinned, and is red for an ask", async () => {
    const container = await show({ ...CARD, side: 1 }, true);
    const root = container.querySelector(".whale-wall-card") as HTMLElement;
    expect([root.classList.contains("sell"), root.classList.contains("pinned")]).toEqual([true, true]);
    expect([...container.querySelectorAll(".whale-wall-card-row")].map((row) => row.textContent)).toEqual(["First bite14:04:13 (seen)", "Price80000.0"]);
    expect(container.querySelector(".whale-wall-card-hint")?.textContent).toBe("Esc or click empty chart to close");
  });

  it("opens below the cursor when there is no room above it", async () => {
    const near = await show(CARD, false, 120, WHALE_CARD_FLIP_BELOW_PX - 1);
    expect(near.querySelector(".whale-wall-card")?.classList.contains("below")).toBe(true);
    const far = await show(CARD, false, 120, WHALE_CARD_FLIP_BELOW_PX);
    expect(far.querySelector(".whale-wall-card")?.classList.contains("below")).toBe(false);
  });

  it("leaves out the meter for a standing wall and the details block when there are none", async () => {
    const container = await show({ ...CARD, meterPct: null, details: [] }, true);
    expect(container.querySelector(".whale-wall-card-meter")).toBeNull();
    expect(container.querySelector(".whale-wall-card-details")).toBeNull();
  });

  it("keeps the card inside the chart's width, and leaves a position alone on a chart too narrow to hold it", () => {
    const half = WHALE_CARD_WIDTH_PX / 2 + 6;
    expect(clampCardX(10, 1000)).toBe(half);
    expect(clampCardX(990, 1000)).toBe(1000 - half);
    expect(clampCardX(500, 1000)).toBe(500);
    expect(clampCardX(10, 200)).toBe(10);
  });
});
