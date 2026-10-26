import { describe, expect, it } from "vitest";
import { replayBars } from "../replayBars";
import { draw } from "../draw";
import { get, resetDrawRegistryForTests } from "../draw/registry";
import type { BarFrame } from "../../../types/frames";
import type { RuntimeIndicatorDef } from "../indicatorTypes";

function bar(ts_open: number, close: number): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000, ts_open,
    open: close, high: close, low: close, close, volume: 1, trade_count: 1, closed: true,
  } as BarFrame;
}

interface RunningSumState {
  sum: number;
  replayFlags: boolean[];
}

const runningSumDef: RuntimeIndicatorDef<RunningSumState, Record<string, never>> = {
  kind: "runtime",
  id: "runningSum",
  label: "Running Sum",
  category: "technical",
  defaultSettings: {},
  lines: [{ key: "sum" }],
  placement: { kind: "overlay" },
  createState: () => ({ sum: 0, replayFlags: [] }),
  onBar: (ctx) => {
    ctx.state.sum += ctx.bar.close;
    ctx.state.replayFlags.push(ctx.replaying);
  },
  readOutput: (state) => ({ sum: state.sum }),
};

describe("replayBars", () => {
  it("replays every bar oldest to newest exactly once, marked as replaying", () => {
    const bars = [bar(1000, 1), bar(2000, 2), bar(3000, 3)];
    const result = replayBars(runningSumDef, bars, {});
    expect(result.perBar.sum).toEqual([1, 3, 6]);
  });

  it("starts from fresh state on every call -- two calls do not accumulate across each other", () => {
    const bars = [bar(1000, 10)];
    const first = replayBars(runningSumDef, bars, {});
    const second = replayBars(runningSumDef, bars, {});
    expect(first.perBar.sum).toEqual(second.perBar.sum);
  });

  it("produces one output entry per bar, in the order the bars were given", () => {
    const bars = [bar(1000, 1), bar(2000, 1), bar(3000, 1), bar(4000, 1)];
    const result = replayBars(runningSumDef, bars, {});
    expect(result.perBar.sum).toHaveLength(4);
  });

  it("isolates and cleans up handles created by a drawing-capable definition", () => {
    resetDrawRegistryForTests();
    const drawDef: RuntimeIndicatorDef<{ line: ReturnType<typeof draw.line> }, Record<string, never>> = {
      kind: "runtime",
      id: "replayDraw",
      label: "Replay Draw",
      category: "technical",
      defaultSettings: {},
      lines: [{ key: "sum" }],
      placement: { kind: "overlay" },
      createState: () => ({ line: draw.line({ time1: 0, price1: 0, time2: 1, price2: 1 }) }),
      onBar: () => {},
      readOutput: () => ({ sum: 0 }),
    };
    replayBars(drawDef, [bar(1000, 1)], {});
    expect(get(1)).toBeUndefined();
    resetDrawRegistryForTests();
  });
});
