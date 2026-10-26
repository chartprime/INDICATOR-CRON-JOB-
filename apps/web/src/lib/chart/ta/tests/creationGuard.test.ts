import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertInsideCreationWindow,
  beginStreamCreationWindow,
  endStreamCreationWindow,
  isInsideStreamCreationWindow,
  resetStreamCreationGuardForTests,
  withStreamCreationWindow,
} from "../creationGuard";
import { ta } from "../index";
import { replayBars } from "../../replayBars";
import type { BarFrame } from "../../../../types/frames";
import type { RuntimeIndicatorDef } from "../../indicatorTypes";

afterEach(() => {
  resetStreamCreationGuardForTests();
  vi.restoreAllMocks();
});

describe("creationGuard", () => {
  it("reports not inside a window by default", () => {
    expect(isInsideStreamCreationWindow()).toBe(false);
  });

  it("reports inside a window between begin and end, and not inside again after end", () => {
    beginStreamCreationWindow();
    expect(isInsideStreamCreationWindow()).toBe(true);
    endStreamCreationWindow();
    expect(isInsideStreamCreationWindow()).toBe(false);
  });

  it("keeps an outer creation window valid until the matching outer end, even when creation scopes nest", () => {
    beginStreamCreationWindow();
    beginStreamCreationWindow();
    endStreamCreationWindow();
    expect(isInsideStreamCreationWindow()).toBe(true);
    endStreamCreationWindow();
    expect(isInsideStreamCreationWindow()).toBe(false);
  });

  it("stays silent when a factory is called inside a legitimate creation window", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    beginStreamCreationWindow();
    assertInsideCreationWindow("ta.sma");
    expect(error).not.toHaveBeenCalled();
  });

  it("logs loudly, naming the factory, when called outside a creation window", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    assertInsideCreationWindow("ta.sma");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("ta.sma()");
  });

  it("warns once per factory rather than flooding the console during a historical replay", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    assertInsideCreationWindow("replayedMistake");
    assertInsideCreationWindow("replayedMistake");
    assertInsideCreationWindow("replayedMistake");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("withStreamCreationWindow closes the window even when the wrapped createState throws", () => {
    expect(() =>
      withStreamCreationWindow(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(isInsideStreamCreationWindow()).toBe(false);
  });
});

describe("creationGuard -- every real createState call site opens the window", () => {
  function bar(index: number, close: number): BarFrame {
    return {
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000,
      ts_open: index * 60_000, open: close, high: close, low: close, close, volume: 1, trade_count: 1, closed: true,
    } as BarFrame;
  }

  const correctlyAuthored: RuntimeIndicatorDef<{ sma: ReturnType<typeof ta.sma>; value: number | null }, Record<string, never>> = {
    kind: "runtime",
    id: "guardPath",
    label: "Guard Path",
    category: "technical",
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" },
    createState: () => ({ sma: ta.sma(3), value: null }),
    onBar: (ctx) => {
      ctx.state.value = ctx.state.sma.push(ctx.bar.close, ctx.replace);
    },
    readOutput: (state) => ({ value: state.value }),
  };

  // replayBars is the harness every migrated indicator's own test suite runs
  // through, so an unguarded createState here would make the guard cry wolf at
  // correct code in every one of those suites.
  it("replayBars does not trigger the guard for a correctly authored indicator", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { perBar } = replayBars(correctlyAuthored, [bar(0, 1), bar(1, 2), bar(2, 3)], {});

    expect(error).not.toHaveBeenCalled();
    expect(perBar.value.at(-1)).toBeCloseTo(2, 10); // sma(3) of [1,2,3]
    error.mockRestore();
  });
});
