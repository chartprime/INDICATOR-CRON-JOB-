// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { TapePanel } from "../TapePanel";
import type { FrameIdentity, TradeFrame } from "../../../types/frames";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// TapePanel's filter input uses a fixed id (#tape-min-size) -- without
// unmounting/removing between tests, stale containers from earlier
// tests pile up with the same id still in document.body, and jsdom's
// ID-selector fast path then resolves against the wrong (or no)
// element instead of scoping to the current container (same failure
// mode caught and fixed in Terminal.test.tsx this session).
let mountedRoots: { root: Root; container: HTMLDivElement }[] = [];

afterEach(async () => {
  for (const { root, container } of mountedRoots) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  mountedRoots = [];
});

function trade(overrides: Partial<TradeFrame> = {}): TradeFrame {
  return {
    type: "trade",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_exchange: 1_700_000_000_000,
    price: 100,
    size: 1,
    side: "buy",
    trade_id: "1",
    ...overrides,
  } as TradeFrame;
}

function futuresTrade(overrides: Partial<TradeFrame> = {}): TradeFrame {
  return {
    type: "trade",
    symbol: "/NQU26:XCME",
    provider: "DXFEED",
    assetClass: "FUTURE",
    ts_exchange: 1_700_000_000_000,
    price: 29219,
    size: 1,
    side: "sell",
    trade_id: "nq-1",
    ...overrides,
  } as TradeFrame;
}

const BINANCE_IDENTITY: FrameIdentity = { provider: "BINANCE", marketKind: "SPOT" };
const FUTURES_IDENTITY: FrameIdentity = { provider: "DXFEED", assetClass: "FUTURE" };

async function render(
  trades: TradeFrame[],
  instrumentIdentity: FrameIdentity = BINANCE_IDENTITY,
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TapePanel trades={trades} instrumentIdentity={instrumentIdentity} />);
  });
  mountedRoots.push({ root, container });
  return { container, root };
}

function minSizeInput(container: HTMLDivElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("#tape-min-size")!;
}

async function setMinSize(container: HTMLDivElement, value: string): Promise<void> {
  const input = minSizeInput(container);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("TapePanel", () => {
  it("summarizes the retained shown prints in the correct native units", async () => {
    const { container } = await render([
      trade({ trade_id: "buy", side: "buy", price: 100, size: 2 }),
      trade({ trade_id: "sell", side: "sell", price: 200, size: 3 }),
    ]);
    expect(container.querySelector(".tape-summary")?.textContent).toContain("Buy · shown prints$200");
    expect(container.querySelector(".tape-summary")?.textContent).toContain("Sell · shown prints$600");
    const { container: futures } = await render([
      futuresTrade({ trade_id: "f-buy", side: "buy", size: 4 }),
      futuresTrade({ trade_id: "f-sell", side: "sell", size: 7 }),
    ], FUTURES_IDENTITY);
    expect(futures.querySelector(".tape-summary")?.textContent).toContain("Buy · shown prints4 ct");
    expect(futures.querySelector(".tape-summary")?.textContent).toContain("Sell · shown prints7 ct");
  });
  it("renders nothing yet when there are no trades", async () => {
    const { container } = await render([]);
    expect(container.querySelector(".tape-empty")?.textContent).toContain("Waiting for trades");
    expect(container.querySelectorAll(".tape-row")).toHaveLength(0);
  });

  it("shows the USD notional (price * size) alongside the native size for every trade", async () => {
    const { container } = await render([trade({ trade_id: "1", price: 100, size: 2.5 })]);
    const row = container.querySelector(".tape-row")!;
    expect(row.querySelector(".native")?.textContent).toBe("2.5000");
    expect(row.querySelector(".usd")?.textContent).toBe("$250");
  });

  it("with the filter untouched (default), every trade renders -- existing behavior is unchanged until someone opts in", async () => {
    const trades = [trade({ trade_id: "1", size: 0.0001 }), trade({ trade_id: "2", size: 50 })];
    const { container } = await render(trades);
    expect(container.querySelectorAll(".tape-row")).toHaveLength(2);
    expect(container.querySelector(".tape-filter .count")).toBeNull();
  });

  it("typing a min size hides trades whose USD notional falls below it", async () => {
    const trades = [
      trade({ trade_id: "small", price: 100, size: 0.01 }), // $1
      trade({ trade_id: "big", price: 100, size: 100 }), // $10,000
    ];
    const { container } = await render(trades);

    await setMinSize(container, "5000");

    const rows = Array.from(container.querySelectorAll(".tape-row"));
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".native")?.textContent).toBe("100.0000");
  });

  it("a trade exactly at the threshold is kept, not excluded -- the filter is >=, not >", async () => {
    const trades = [trade({ trade_id: "exact", price: 100, size: 50 })]; // exactly $5,000
    const { container } = await render(trades);

    await setMinSize(container, "5000");

    expect(container.querySelectorAll(".tape-row")).toHaveLength(1);
  });

  it("shows a distinct empty state when trades exist but all are filtered out, not the generic waiting message", async () => {
    const trades = [trade({ trade_id: "1", price: 100, size: 0.01 })];
    const { container } = await render(trades);

    await setMinSize(container, "5000");

    expect(container.querySelectorAll(".tape-row")).toHaveLength(0);
    expect(container.querySelector(".tape-empty")?.textContent).toContain("No prints ≥ $5.0k");
  });

  it("shows a live shown-count only once a filter is actually active", async () => {
    const trades = [trade({ trade_id: "1", price: 100, size: 0.01 }), trade({ trade_id: "2", price: 100, size: 100 })];
    const { container } = await render(trades);

    expect(container.querySelector(".tape-filter .count")).toBeNull();

    await setMinSize(container, "5000");
    expect(container.querySelector(".tape-filter .count")?.textContent).toBe("1 / 2 shown");
  });

  it("clearing the filter back to empty/0 restores every trade", async () => {
    const trades = [trade({ trade_id: "1", price: 100, size: 0.01 }), trade({ trade_id: "2", price: 100, size: 100 })];
    const { container } = await render(trades);

    await setMinSize(container, "5000");
    expect(container.querySelectorAll(".tape-row")).toHaveLength(1);

    await setMinSize(container, "0");
    expect(container.querySelectorAll(".tape-row")).toHaveLength(2);
  });

  it("rejects a negative min size rather than filtering out every trade with it", async () => {
    const trades = [trade({ trade_id: "1", price: 100, size: 0.01 })];
    const { container } = await render(trades);

    await setMinSize(container, "-500");

    expect(container.querySelectorAll(".tape-row")).toHaveLength(1);
  });

  it("the 'large' highlight ratio is recomputed against the currently VISIBLE trades' sizes, not the full unfiltered set", async () => {
    // USD filtering doesn't correlate monotonically with native size --
    // a trade with a small native size but a high price can carry more
    // USD notional than one with a large native size but a low price.
    // bigNative has the largest native SIZE in the full set (10) but
    // fails the USD filter; smallNativeBigUsd has a tiny native size (1)
    // but clears the filter on USD alone. If "large" were still ratio'd
    // against the full set's own max native size (10), smallNativeBigUsd
    // would read as small (1/10 = 0.1); ratio'd against just what's
    // still visible after filtering (itself), it reads as the whole
    // visible market (1/1 = 1.0) -- which is what should render.
    const trades = [
      trade({ trade_id: "bigNative", price: 50, size: 10 }), // $500 USD, size 10 (full-set native max)
      trade({ trade_id: "smallNativeBigUsd", price: 1000, size: 1 }), // $1,000 USD, size 1
    ];
    const { container } = await render(trades);

    await setMinSize(container, "600"); // bigNative ($500) fails, smallNativeBigUsd ($1,000) passes

    const rows = Array.from(container.querySelectorAll(".tape-row"));
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".native")?.textContent).toBe("1.0000");
    expect(rows[0].classList.contains("large")).toBe(true);
  });

  it("ranks spot/equity tape-bar emphasis by USD notional, not raw token quantity", async () => {
    const trades = [
      trade({ trade_id: "many-low-price", price: 10, size: 100 }), // $1,000
      trade({ trade_id: "few-high-price", price: 1_000, size: 10 }), // $10,000
    ];
    const { container } = await render(trades);
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".tape-row"));

    expect(rows[0].style.getPropertyValue("--size-ratio")).toBe("0.1");
    expect(rows[0].classList.contains("large")).toBe(false);
    expect(rows[1].style.getPropertyValue("--size-ratio")).toBe("1");
    expect(rows[1].classList.contains("large")).toBe(true);
  });

  describe("futures trades (dxFeed /NQ, /ES): contract count, not a fabricated USD figure", () => {
    it("shows contract count instead of a $ notional, since dxFeed price*size isn't real dollars", async () => {
      const { container } = await render([futuresTrade({ trade_id: "1", price: 29219, size: 50 })], FUTURES_IDENTITY);
      const row = container.querySelector(".tape-row")!;
      expect(row.querySelector(".native")?.textContent).toBe("50 ct");
      expect(row.querySelector(".usd")).toBeNull();
    });

    it("labels the size column 'Contracts', not 'Size / USD'", async () => {
      const { container } = await render([futuresTrade()], FUTURES_IDENTITY);
      expect(container.querySelector(".tape-cols")?.textContent).toContain("Contracts");
      expect(container.querySelector(".tape-cols")?.textContent).not.toContain("USD");
    });

    it("the min-size filter has no $ prefix and filters by raw contract count", async () => {
      const trades = [
        futuresTrade({ trade_id: "small", size: 5 }),
        futuresTrade({ trade_id: "big", size: 50 }),
      ];
      const { container } = await render(trades, FUTURES_IDENTITY);
      expect(container.querySelector(".tape-filter .field span")?.textContent).not.toBe("$");

      await setMinSize(container, "10");

      const rows = Array.from(container.querySelectorAll(".tape-row"));
      expect(rows).toHaveLength(1);
      expect(rows[0].querySelector(".native")?.textContent).toBe("50 ct");
    });

    it("the empty-filtered state shows contracts, not a dollar figure", async () => {
      const { container } = await render([futuresTrade({ size: 1 })], FUTURES_IDENTITY);
      await setMinSize(container, "50");
      expect(container.querySelector(".tape-empty")?.textContent).toBe("No prints ≥ 50 ct");
    });

    it("uses contract units before the first futures trade arrives", async () => {
      const { container } = await render([], FUTURES_IDENTITY);
      expect(container.querySelector(".tape-cols")?.textContent).toContain("Contracts");
      expect(container.querySelector(".tape-filter .field")?.textContent).toContain("ct");
    });

    it("does not reuse a USD filter as a contract-count filter across provider switches", async () => {
      const { container, root } = await render([trade({ price: 100, size: 100 })]);
      await setMinSize(container, "5000");

      await act(async () => {
        root.render(<TapePanel trades={[]} instrumentIdentity={FUTURES_IDENTITY} />);
      });
      expect(minSizeInput(container).value).toBe("");

      await setMinSize(container, "25");
      await act(async () => {
        root.render(<TapePanel trades={[]} instrumentIdentity={BINANCE_IDENTITY} />);
      });
      expect(minSizeInput(container).value).toBe("5000");
    });
  });

  it("labels and renders exchange timestamps in UTC, independent of the browser's local timezone", async () => {
    const { container } = await render([trade({ ts_exchange: 1_700_000_000_000 })]);
    expect(container.querySelector(".tape-cols")?.textContent).toContain("Time (UTC)");
    expect(container.querySelector(".tape-row .t")?.textContent).toBe("22:13:20");
  });
});
