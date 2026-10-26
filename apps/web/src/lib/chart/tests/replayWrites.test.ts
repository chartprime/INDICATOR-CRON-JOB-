import { afterEach, describe, expect, it } from "vitest";
import { createIndicatorRuntime } from "../indicatorRuntime";
import { draw } from "../draw";
import type { BoxHandle } from "../draw/box";
import { resetDrawOwnerScopeForTests } from "../draw/creationScope";
import { create, handlesForOwners, resetDrawRegistryForTests, setRequestUpdate, tablesForOwners, withNotificationsDeferred } from "../draw/registry";
import { createBox } from "../draw/box";
import { createTable, flushTableCells } from "../draw/table";
import type { RuntimeIndicatorDef } from "../indicatorTypes";
import type { BarFrame } from "../../../types/frames";

// Report 57 W4, GE-19: activating an order-block indicator froze the chart for
// 2.3-2.8 s. Every replayed bar rewrote every slot (200 boxes and 200 lines
// for Classic Order Blocks), each write copied the object and asked the chart
// to repaint, and every bar walked every handle looking for tables: 14.5 M
// writes for one activation over 10,080 bars. A write that changes nothing is
// now free, a replay asks for one repaint, and only tables are flushed as
// tables; an indicator's snapshot replays it once.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

function bar(index: number): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: 60_000,
    ts_open: index * 60_000, open: 1, high: 2, low: 1, close: 1.5, volume: 1, trade_count: 1, closed: true,
  } as BarFrame;
}

function counter(ownerId: string): { count: () => number } {
  let calls = 0;
  setRequestUpdate(ownerId, () => {
    calls += 1;
  });
  return { count: () => calls };
}

describe("draw writes during replay (report 57 W4, GE-19)", () => {
  it("does not repaint or copy for a write that changes nothing, and does for one that does", () => {
    const box = createBox("owner", { time1: 1, price1: 2, time2: 3, price2: 4 });
    const repaints = counter("owner");
    const before = handlesForOwners(["owner"])[0].data;
    box.setLeftTop(1, 2);
    box.setBorderColor("#787b86");
    expect(repaints.count()).toBe(0);
    expect(handlesForOwners(["owner"])[0].data).toBe(before);
    box.setLeftTop(1, 5);
    expect(repaints.count()).toBe(1);
    expect(handlesForOwners(["owner"])[0].data).toMatchObject({ time1: 1, price1: 5, time2: 3, price2: 4 });
  });

  it("collapses the repaint requests of a deferred block into one per owner, after the outermost block", () => {
    const repaints = counter("owner");
    const other = counter("other");
    withNotificationsDeferred(() => {
      const box = createBox("owner", { time1: 0, price1: 0, time2: 0, price2: 0 });
      withNotificationsDeferred(() => {
        for (let price = 1; price <= 50; price += 1) box.setLeftTop(0, price);
      });
      createBox("other", { time1: 0, price1: 0, time2: 0, price2: 0 });
      expect(repaints.count()).toBe(0);
    });
    expect([repaints.count(), other.count()]).toEqual([1, 1]);
  });

  it("flushes an owner's tables without visiting its other handles", () => {
    for (let index = 0; index < 5; index += 1) create("owner", "box", { index });
    const table = createTable("owner");
    table.cell(0, 0, { text: "x" });
    expect(tablesForOwners(["owner"]).map((record) => record.kind)).toEqual(["table"]);
    flushTableCells("owner");
    expect((tablesForOwners(["owner"])[0].data as { committedGrid: Record<string, { text: string }> }).committedGrid["0,0"].text).toBe("x");
  });

  it("asks the chart to repaint once for a whole replay, not once per bar", () => {
    const def: RuntimeIndicatorDef<{ box: BoxHandle }, Record<string, never>> = {
      kind: "runtime", id: "writer", label: "Writer", category: "technical", defaultSettings: {}, lines: [],
      placement: { kind: "overlay" }, readOutput: () => ({}),
      createState: () => ({ box: draw.box({ time1: 0, price1: 0, time2: 0, price2: 0 }) }),
      onBar: (ctx) => ctx.state.box.setRightBottom(ctx.bar.ts_open, ctx.bar.close),
    };
    const runtime = createIndicatorRuntime([def as RuntimeIndicatorDef<unknown, unknown>]);
    runtime.setActive(new Set(["writer"]), {}, []);
    const repaints = counter(runtime.getDrawOwnerId("writer")!);
    runtime.onSnapshot(Array.from({ length: 500 }, (_, index) => bar(index)));
    expect(repaints.count()).toBe(1);
  });

  it("replays each indicator exactly once for a snapshot that also activates it", () => {
    let replayed = 0;
    const def: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
      kind: "runtime", id: "counted", label: "Counted", category: "technical", defaultSettings: {}, lines: [],
      placement: { kind: "overlay" }, readOutput: () => ({}), createState: () => ({}),
      onBar: (ctx) => {
        if (ctx.replaying) replayed += 1;
      },
    };
    const runtime = createIndicatorRuntime([def as RuntimeIndicatorDef<unknown, unknown>]);
    runtime.setActiveAndReplay(new Set(["counted"]), {}, Array.from({ length: 40 }, (_, index) => bar(index)));
    expect(replayed).toBe(40);
  });

  it("hands the chart no fill for an indicator that never fills, and every point for one that does", () => {
    const plain: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
      kind: "runtime", id: "plain", label: "Plain", category: "technical", defaultSettings: {}, lines: [],
      placement: { kind: "overlay" }, readOutput: () => ({}), createState: () => ({}), onBar: () => {},
    };
    const band: RuntimeIndicatorDef<Record<string, never>, Record<string, never>> = {
      ...plain, id: "band", onBar: (ctx) => ctx.draw.fill(ctx.bar.high, ctx.bar.low),
    };
    const runtime = createIndicatorRuntime([plain, band] as RuntimeIndicatorDef<unknown, unknown>[]);
    runtime.setActiveAndReplay(new Set(["plain", "band"]), {}, Array.from({ length: 30 }, (_, index) => bar(index)));
    expect(runtime.getFillPoints("plain")).toBeNull();
    expect(runtime.getFillPoints("band")?.points).toHaveLength(30);
  });
});
