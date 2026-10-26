// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DomPanel } from "../DomPanel";
import type { BookFrame } from "../../../types/frames";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function readyBook(overrides: Partial<BookFrame> = {}): BookFrame {
  return {
    type: "book",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    status: "READY",
    bids: [
      { price: 100, size: 1 },
      { price: 99, size: 2 },
    ],
    asks: [
      { price: 101, size: 0.5 },
      { price: 102, size: 3 },
    ],
    lastUpdateId: 1,
    stale: false,
    ...overrides,
  } as BookFrame;
}

async function render(
  book: BookFrame | null,
  {
    lastPrice,
    lastTickDirection = null,
    futuresMode = false,
  }: {
    lastPrice?: number;
    lastTickDirection?: "up" | "down" | null;
    futuresMode?: boolean;
  } = {},
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DomPanel
        book={book}
        lastPrice={lastPrice}
        lastTickDirection={lastTickDirection}
        futuresMode={futuresMode}
      />,
    );
  });
  return { container, root };
}

describe("DomPanel", () => {
  it("computes imbalance only from displayed levels and keeps best prices next to the spread", async () => {
    const bids = Array.from({ length: 6 }, (_, index) => ({ price: 100 - index, size: index === 5 ? 100 : 2 }));
    const asks = Array.from({ length: 6 }, (_, index) => ({ price: 101 + index, size: 1 }));
    const { container } = await render(readyBook({ bids, asks }));
    await act(async () => container.querySelector<HTMLButtonElement>('.dom-level-controls button:first-child')!.click());
    expect(container.querySelectorAll(".dom-bids .dom-row")).toHaveLength(5);
    expect(container.querySelectorAll(".dom-asks .dom-row")).toHaveLength(5);
    expect(container.querySelector(".dom-imbalance")?.getAttribute("aria-label")).toBe("Shown depth: 67% bids, 33% asks");
    expect(container.querySelector(".dom-asks .dom-row:last-child .p")?.textContent).toBe("101.00");
    expect(container.querySelector(".dom-bids .dom-row:first-child .p")?.textContent).toBe("100.00");
  });
  it("renders nothing yet when book is null -- honestly unknown before the first frame arrives", async () => {
    const { container } = await render(null);
    expect(container.querySelector(".dom-empty")?.textContent).toContain("Book initializing");
    expect(container.querySelector(".dom-list")).toBeNull();
    expect(container.querySelector(".dom-empty")?.getAttribute("role")).toBe("status");
  });

  it("discloses that the ladder is the top 20 price levels on each side", async () => {
    const { container } = await render(null);
    expect(container.querySelector(".dom-depth-scope")?.textContent).toBe("source pending · 10 of top 20 / side");
  });

  it("renders bids and asks in the right order for a READY book", async () => {
    const { container } = await render(readyBook());

    const askPrices = Array.from(container.querySelectorAll(".dom-asks .p")).map((el) => el.textContent);
    const bidPrices = Array.from(container.querySelectorAll(".dom-bids .p")).map((el) => el.textContent);

    // Best (lowest) ask closest to the spread -- last in the asks column,
    // reading down toward the bids -- matching a real DOM ladder.
    expect(askPrices).toEqual(["102.00", "101.00"]);
    // Bids already come back best-first (highest first) from the backend.
    expect(bidPrices).toEqual(["100.00", "99.00"]);
    expect(container.querySelector(".dom-depth-scope")?.textContent).toContain("Binance");
    expect(container.querySelector(".dom-spread")?.textContent).toContain("Spread 1.00 · Mid 100.50");
  });

  it.each([
    "CONNECTION_DOWN",
    "RECOVERY_IN_PROGRESS",
    "BUFFERING",
    "SNAPSHOT_MALFORMED",
    "SNAPSHOT_TOO_OLD",
    "SEQUENCE_GAP",
    "UPSTREAM_EVENT_UNAVAILABLE",
    "BUFFER_OVERFLOW_BEFORE_SNAPSHOT",
  ])("represents an UNAVAILABLE book with reason %s honestly, no rows rendered", async (reason) => {
    const { container } = await render({ type: "book", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", status: "UNAVAILABLE", reason });
    expect(container.querySelector(".dom-empty")?.textContent).toContain(`Book unavailable (${reason})`);
    expect(container.querySelector(".dom-list")).toBeNull();
  });

  it("an empty READY book (no levels yet) renders no rows without throwing", async () => {
    await expect(render(readyBook({ bids: [], asks: [] }))).resolves.not.toThrow();
  });

  it("READY but stale keeps the last ladder visible and announces the stall -- never a frozen book with no indication", async () => {
    const { container } = await render(readyBook({ stale: true }));
    expect(container.querySelector(".dom-list")).not.toBeNull();
    expect(container.querySelector(".dom-overlay")?.textContent).toContain("Book stale");
    expect(container.querySelector(".dom-overlay")?.getAttribute("role")).toBe("status");
    expect(container.querySelector(".dom-asks .p")).not.toBeNull();
  });

  it("shows the USD notional (price * size) alongside the native size for every level of a non-futures book, never filtered", async () => {
    const { container } = await render(
      readyBook({ bids: [{ price: 100, size: 1.5 }], asks: [{ price: 101, size: 0.5 }] }),
    );
    const bidRow = container.querySelector(".dom-bids .dom-row")!;
    expect(bidRow.querySelector(".native")?.textContent).toBe("1.5000");
    expect(bidRow.querySelector(".usd")?.textContent).toBe("$150");
    const askRow = container.querySelector(".dom-asks .dom-row")!;
    expect(askRow.querySelector(".usd")?.textContent).toBe("$51");
  });

  describe("futures mode (DX3.07 Phase D)", () => {
    it("shows whole-contract counts instead of a fabricated USD notional -- dxFeed futures price is an index point, not a real dollar unit price", async () => {
      const { container } = await render(
        readyBook({ bids: [{ price: 29139.75, size: 7 }], asks: [{ price: 29140, size: 3 }] }),
        { futuresMode: true },
      );
      const bidRow = container.querySelector(".dom-bids .dom-row")!;
      expect(bidRow.querySelector(".native")?.textContent).toBe("7 ct");
      expect(bidRow.querySelector(".usd")).toBeNull();
      const askRow = container.querySelector(".dom-asks .dom-row")!;
      expect(askRow.querySelector(".native")?.textContent).toBe("3 ct");
      expect(askRow.querySelector(".usd")).toBeNull();
    });

    it("labels the size column Contracts instead of Size / USD", async () => {
      const { container } = await render(readyBook(), { futuresMode: true });
      const header = Array.from(container.querySelectorAll(".dom-cols span")).map((el) => el.textContent);
      expect(header).toEqual(["Price", "Contracts"]);
    });

    it("defaults to non-futures (USD) display when futuresMode is omitted -- existing Binance behavior stays exactly as it was", async () => {
      const { container } = await render(readyBook());
      const header = Array.from(container.querySelectorAll(".dom-cols span")).map((el) => el.textContent);
      expect(header).toEqual(["Price", "Size / USD"]);
      expect(container.querySelector(".dom-bids .dom-row .usd")).not.toBeNull();
    });
  });

  describe("last-price separator", () => {
    it("sits between the asks and bids ladders, not inside either", async () => {
      const { container } = await render(readyBook(), { lastPrice: 100.5 });
      const list = container.querySelector(".dom-list")!;
      const children = Array.from(list.children).map((el) => el.className);
      const asksIndex = children.findIndex((c) => c.includes("dom-asks"));
      const sepIndex = children.findIndex((c) => c.includes("dom-last-price"));
      const bidsIndex = children.findIndex((c) => c.includes("dom-bids"));
      expect(asksIndex).toBeLessThan(sepIndex);
      expect(sepIndex).toBeLessThan(bidsIndex);
    });

    it("does not render at all when there is no price yet -- never a fabricated 0.00", async () => {
      const { container } = await render(readyBook(), { lastPrice: undefined });
      expect(container.querySelector(".dom-last-price")).toBeNull();
    });

    it("colors up green with an up arrow, down red with a down arrow", async () => {
      const { container: upContainer } = await render(readyBook(), { lastPrice: 100, lastTickDirection: "up" });
      const upEl = upContainer.querySelector(".dom-last-price")!;
      expect(upEl.classList.contains("up")).toBe(true);
      expect(upEl.querySelector(".arrow")?.textContent).toBe("↑");

      const { container: downContainer } = await render(readyBook(), { lastPrice: 100, lastTickDirection: "down" });
      const downEl = downContainer.querySelector(".dom-last-price")!;
      expect(downEl.classList.contains("down")).toBe(true);
      expect(downEl.querySelector(".arrow")?.textContent).toBe("↓");
    });

    it("shows the price with no direction color or arrow before the first tick is known", async () => {
      const { container } = await render(readyBook(), { lastPrice: 100, lastTickDirection: null });
      const el = container.querySelector(".dom-last-price")!;
      expect(el.classList.contains("up")).toBe(false);
      expect(el.classList.contains("down")).toBe(false);
      expect(el.querySelector(".arrow")).toBeNull();
    });

    it("formats the price the same way every other price in the panel is formatted", async () => {
      const { container } = await render(readyBook(), { lastPrice: 69335.1 });
      expect(container.querySelector(".dom-last-price")?.textContent).toContain("69335.10");
    });
  });
});
