// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandleMonitorEntry } from "../../../../types/frames";
import { CandleMonitor } from "../CandleMonitor";
import { MONITOR_STALE_MS, candleOverdueAt } from "../candleMonitorText";

const T = Date.UTC(2026, 9, 11, 15, 0);
const ENTRY: CandleMonitorEntry = { candleMs: 60_000, candleTs: T - 60_000, buy: 2.97, sell: 0.56, biggestBuy: { price: 83_180, size: 1.21 }, biggestSell: { price: 83_120, size: 0.4 } };

describe("CandleMonitor", () => {
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

  const show = (entry: CandleMonitorEntry | null, receivedAt: number | null = Date.now(), unit = "BTC", formatPrice = (price: number) => price.toFixed(2), frameTs: number | null = null) => act(() => root.render(<CandleMonitor entry={entry} receivedAt={receivedAt} frameTs={frameTs} unit={unit} formatPrice={formatPrice} />));
  const price = (value: number) => value.toFixed(2);
  const monitor = () => container.querySelector<HTMLElement>(".candle-monitor")!;
  const candle = () => container.querySelector(".candle-monitor-candle")!.textContent;
  const rows = () => [...container.querySelectorAll<HTMLElement>(".candle-monitor-row")].map((row) => [row.dataset.row, row.querySelector(".candle-monitor-label")!.textContent, row.querySelector(".candle-monitor-value")!.textContent]);

  it("names the candle it counts and lists the five rows, label left and value right, the delta in its sign's colour and nothing else coloured", () => {
    show(ENTRY);
    expect(container.querySelector(".candle-monitor-title")!.textContent).toBe("Candle monitor");
    expect(candle()).toBe("1m · 14:59");
    expect(rows()).toEqual([
      ["buy", "Buying volume", "2.97 BTC"],
      ["sell", "Selling volume", "0.56 BTC"],
      ["delta", "Delta", "+2.41 (+68%)"],
      ["biggestBuy", "Biggest buyer", "1.21 BTC @ 83180.00"],
      ["biggestSell", "Biggest seller", "0.40 BTC @ 83120.00"],
    ]);
    const colors = [...container.querySelectorAll<HTMLElement>(".candle-monitor-value")].map((value) => value.style.color);
    expect(colors).toEqual(["", "", "rgb(74, 222, 128)", "", ""]);
    expect(monitor().dataset.stale).toBeUndefined();
    show({ ...ENTRY, buy: 1, sell: 3 }, Date.now(), "contracts");
    expect(rows()[2]).toEqual(["delta", "Delta", "−2 (−50%)"]);
    expect(container.querySelectorAll<HTMLElement>(".candle-monitor-value")[2].style.color).toBe("rgb(248, 113, 113)");
    show({ ...ENTRY, biggestBuy: { price: 230.47, size: 500 } }, Date.now(), "shares", (price) => price.toFixed(4));
    expect(rows()[3]).toEqual(["biggestBuy", "Biggest buyer", "500 shares @ 230.4700"]);
  });

  it("goes stale by itself fifteen seconds after the last frame reached the browser, with nothing re-rendering it; each fresh frame re-arms the fifteen seconds; the rows stay", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T);
      show(ENTRY, T);
      act(() => { vi.advanceTimersByTime(MONITOR_STALE_MS); });
      expect(monitor().dataset.stale).toBeUndefined();
      act(() => { vi.advanceTimersByTime(1); });
      expect(monitor().dataset.stale).toBe("true");
      expect(candle()).toBe("no feed");
      expect(rows()).toHaveLength(5);
      show(ENTRY, T + MONITOR_STALE_MS + 1);
      expect(monitor().dataset.stale).toBeUndefined();
      expect(candle()).toBe("1m · 14:59");
      act(() => { vi.advanceTimersByTime(MONITOR_STALE_MS); });
      expect(monitor().dataset.stale).toBeUndefined();
      act(() => { vi.advanceTimersByTime(1); });
      expect(monitor().dataset.stale).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the fifteen seconds from the arrival, not from the render, and still goes stale when the wall clock jumps back while it waits", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T);
      show(ENTRY, T - 10_000);
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(monitor().dataset.stale).toBeUndefined();
      act(() => { vi.advanceTimersByTime(1); });
      expect(monitor().dataset.stale).toBe("true");
      const fresh = T + 5_001;
      show(ENTRY, fresh);
      expect(monitor().dataset.stale).toBeUndefined();
      vi.setSystemTime(fresh - 5_000);
      act(() => { vi.advanceTimersByTime(MONITOR_STALE_MS + 1); });
      expect(monitor().dataset.stale).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("frames that keep arriving with the same candle turn it stale once the runtime's clock in the frame passes the close of the next candle and its grace, naming the candle; a newer candle clears it; the browser's clock plays no part", () => {
    const deadline = candleOverdueAt(ENTRY);
    const browser = Date.now();
    show(ENTRY, browser, "BTC", price, deadline);
    expect(monitor().dataset.stale).toBeUndefined();
    expect(candle()).toBe("1m · 14:59");
    show(ENTRY, browser, "BTC", price, deadline + 1);
    expect(monitor().dataset.stale).toBe("true");
    expect(candle()).toBe("stale · 1m · 14:59");
    expect(rows()).toHaveLength(5);
    show({ ...ENTRY, candleTs: ENTRY.candleTs + 120_000 }, browser, "BTC", price, deadline + 1);
    expect(monitor().dataset.stale).toBeUndefined();
    expect(candle()).toBe("1m · 15:01");
    show(ENTRY, browser, "BTC", price, null);
    expect(candle()).toBe("1m · 14:59");
  });

  it("a feed that stopped reads no feed, not stale, even when its last candle is also overdue", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T);
      show(ENTRY, T, "BTC", price, candleOverdueAt(ENTRY) + 1);
      expect(candle()).toBe("stale · 1m · 14:59");
      act(() => { vi.advanceTimersByTime(MONITOR_STALE_MS + 1); });
      expect(candle()).toBe("no feed");
      expect(monitor().dataset.stale).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("before the first close of the chart's candle it says so and shows no rows; with no frame at all it says no feed", () => {
    show(null);
    expect(candle()).toBe("waiting for a close");
    expect(rows()).toHaveLength(0);
    expect(monitor().dataset.stale).toBeUndefined();
    show(null, null);
    expect(candle()).toBe("no feed");
    expect(monitor().dataset.stale).toBe("true");
    show(ENTRY, Date.now() - MONITOR_STALE_MS - 5_000);
    expect(candle()).toBe("no feed");
    expect(monitor().dataset.stale).toBe("true");
  });
});
