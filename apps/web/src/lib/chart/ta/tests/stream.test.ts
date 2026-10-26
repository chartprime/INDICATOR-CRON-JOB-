import { describe, expect, it, vi } from "vitest";
import { wrapTradingSignal } from "../stream";

describe("wrapTradingSignal", () => {
  it("forwards push(value, replace) straight to the wrapped indicator's own update(value, replace)", () => {
    const update = vi.fn<(value: number, replace: boolean) => number | null>(() => 42);
    const stream = wrapTradingSignal({ update });

    const result = stream.push(10, false);

    expect(update).toHaveBeenCalledWith(10, false);
    expect(result).toBe(42);
  });

  it("forwards the replace flag through unchanged, both true and false", () => {
    const update = vi.fn<(value: number, replace: boolean) => number | null>(() => null);
    const stream = wrapTradingSignal({ update });

    stream.push(1, false);
    stream.push(2, true);

    expect(update).toHaveBeenNthCalledWith(1, 1, false);
    expect(update).toHaveBeenNthCalledWith(2, 2, true);
  });

  it("passes through a null result (the library's own 'not enough data yet' signal) unchanged", () => {
    const stream = wrapTradingSignal({ update: () => null });
    expect(stream.push(1, false)).toBeNull();
  });

  it("works with a non-number input/output shape, matching an OHLC-input or composite-result indicator", () => {
    interface Ohlc {
      high: number;
      low: number;
      close: number;
    }
    interface MacdLikeResult {
      macd: number;
      signal: number;
    }
    const update = vi.fn<(value: Ohlc, replace: boolean) => MacdLikeResult | null>(() => ({ macd: 1, signal: 2 }));
    const stream = wrapTradingSignal({ update });

    const result = stream.push({ high: 10, low: 5, close: 8 }, false);

    expect(update).toHaveBeenCalledWith({ high: 10, low: 5, close: 8 }, false);
    expect(result).toEqual({ macd: 1, signal: 2 });
  });
});
