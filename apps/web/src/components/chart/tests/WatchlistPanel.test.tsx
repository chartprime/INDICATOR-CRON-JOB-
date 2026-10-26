// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchlistPanel } from "../WatchlistPanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];
afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  localStorage.clear();
});

async function render(live = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  await act(async () => root.render(<WatchlistPanel selection={{ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" }} lastPrice={86421.5} live={live} onSelect={onSelect} />));
  mounted.push({ root, container });
  return { container, onSelect };
}

describe("WatchlistPanel", () => {
  it("starts with the current instrument even when it is outside the default perpetuals", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<WatchlistPanel selection={{ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" }} live lastPrice={100} />));
    mounted.push({ root, container });
    expect(container.querySelector(".watchlist-row.selected .watchlist-symbol")?.textContent).toContain("BTC Spot");
    expect(container.querySelectorAll(".watchlist-row")).toHaveLength(3);
  });
  it("shows a real price only for the selected live instrument", async () => {
    const { container } = await render();
    const rows = [...container.querySelectorAll(".watchlist-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".watchlist-price")?.textContent).toBe("86,421.50");
    expect(rows[1].querySelector(".watchlist-price")?.textContent).toBe("—");
    expect(rows.every((row) => row.querySelector(".watchlist-change")?.textContent === "—")).toBe(true);
  });

  it("hides even the selected price when the feed is unavailable", async () => {
    const { container } = await render(false);
    expect(container.querySelector(".watchlist-price")?.textContent).toBe("—");
  });

  it("routes selection through the terminal callback and persists added instruments", async () => {
    const { container, onSelect } = await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select ETH Perp"]')!.click());
    expect(onSelect).toHaveBeenCalledWith("ETH-USDT", { provider: "BINANCE", marketKind: "PERPETUAL" });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add watchlist instrument"]')!.click());
    const addSpot = [...container.querySelectorAll<HTMLButtonElement>(".watchlist-add-results button")].find((button) => button.textContent?.includes("BTC Spot"))!;
    await act(async () => addSpot.click());
    expect(container.querySelectorAll(".watchlist-row")).toHaveLength(3);
    expect(localStorage.getItem("terminal.watchlist.v1")).toContain("SPOT");
  });
});
