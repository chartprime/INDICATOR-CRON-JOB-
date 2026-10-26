import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame, TradeFrame } from "../../../types/frames";
import { AggressiveTape } from "../../indicators/aggressive-orders/aggressiveTape";
import { resetDrawOwnerScopeForTests } from "../draw/creationScope";
import { resetDrawRegistryForTests } from "../draw/registry";
import { createIndicatorRuntime } from "../indicatorRuntime";
import {
  firstPrintAtOrAfter,
  indicatorTicksOf,
  sumPrintsIn,
  type IndicatorTicks,
} from "../indicatorTicks";
import type { RuntimeIndicatorDef } from "../indicatorTypes";

// ctx.ticks: the terminal's own L1 print store, offered to the indicators that
// price volume by print. Unlike ctx.liquidity and ctx.l2 there is no version to
// watch -- the store is read through live -- so the only event the runtime has
// to react to is the store being handed over, which is what backfills the bars
// drawn before it existed.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function bar(ts_open: number): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: MINUTE,
    ts_open,
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    volume: 1,
    trade_count: 1,
    closed: true,
  } as BarFrame;
}

function trade(price: number, size: number, ts_exchange: number): TradeFrame {
  return {
    type: "trade",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_exchange,
    price,
    size,
    side: "buy",
    trade_id: `${ts_exchange}@${price}@${size}`,
  };
}

function tapeOf(trades: readonly TradeFrame[]): AggressiveTape {
  const tape = new AggressiveTape(() => 0);
  tape.reset();
  for (const item of trades) tape.add(item);
  return tape;
}

function viewOf(tape: AggressiveTape): IndicatorTicks {
  const ticks = indicatorTicksOf(tape);
  if (ticks === null) throw new Error("a tape always yields a view");
  return ticks;
}

describe("reading the print store", () => {
  it("is null for no tape, so an indicator sees one absence rather than two", () => {
    expect(indicatorTicksOf(null)).toBeNull();
  });

  it("reads through to the tape, so a print landing later needs no new view", () => {
    const tape = tapeOf([trade(100, 1, 0)]);
    const ticks = viewOf(tape);
    expect(ticks.prints).toHaveLength(1);
    expect(ticks.liveSince).toBe(0);
    tape.add(trade(200, 2, 1_000));
    expect(ticks.prints).toHaveLength(2);
  });
});

describe("how the store covers a window", () => {
  it("calls the live stretch complete, including its still-forming end", () => {
    const ticks = viewOf(tapeOf([trade(100, 1, MINUTE)]));
    expect(ticks.coverageOf(0, MINUTE)).toBe("all");
    expect(ticks.coverageOf(MINUTE, MINUTE + 1)).toBe("all");
  });

  it("calls history served above no size floor complete", () => {
    const tape = tapeOf([]);
    tape.coverHistory(0, HOUR, 0);
    expect(viewOf(tape).coverageOf(0, MINUTE)).toBe("all");
  });

  it("calls floor-filtered history thin, and says which half of the window it covers", () => {
    const tape = tapeOf([]);
    tape.coverHistory(0, MINUTE, 5);
    const ticks = viewOf(tape);
    expect(ticks.coverageOf(0, MINUTE)).toBe("thin");
    // A window that runs past the covered stretch is not covered by it.
    expect(ticks.coverageOf(0, HOUR)).toBe("none");
    expect(ticks.coverageOf(MINUTE, 2 * MINUTE)).toBe("none");
  });

  it("calls a window nothing covers none rather than guessing", () => {
    expect(viewOf(tapeOf([trade(100, 1, 0)])).coverageOf(-HOUR, 0)).toBe("none");
  });

  it("prefers the complete reading when both kinds of history cover the window", () => {
    const tape = tapeOf([]);
    tape.coverHistory(0, HOUR, 50);
    tape.coverHistory(0, HOUR, 0);
    expect(viewOf(tape).coverageOf(0, MINUTE)).toBe("all");
  });
});

describe("summing the prints of a window", () => {
  it("takes the half-open window it was given, and finds its start without a scan", () => {
    const prints = tapeOf([
      trade(10, 1, 0),
      trade(100, 2, MINUTE),
      trade(200, 3, 2 * MINUTE),
    ]).prints;
    expect(firstPrintAtOrAfter(prints, -1)).toBe(0);
    expect(firstPrintAtOrAfter(prints, 0)).toBe(0);
    expect(firstPrintAtOrAfter(prints, MINUTE)).toBe(1);
    expect(firstPrintAtOrAfter(prints, 2 * MINUTE)).toBe(2);
    expect(firstPrintAtOrAfter(prints, 3 * MINUTE)).toBe(3);
  });

  it("weights each print by its own size and squares its own price", () => {
    const prints = tapeOf([trade(100, 1, 0), trade(200, 3, 0)]).prints;
    expect(sumPrintsIn(prints, 0, MINUTE)).toEqual({
      volume: 4,
      priceVolume: 700,
      priceSquaredVolume: 130_000,
    });
    expect(sumPrintsIn(prints, 0, MINUTE - 1).volume).toBe(4);
    expect(sumPrintsIn(prints, MINUTE, 2 * MINUTE).volume).toBe(0);
  });

  it("ignores a print that is not a positive finite price and size", () => {
    const prints = tapeOf([
      trade(100, 1, 0),
      trade(Number.NaN, 5, 1),
      trade(0, 5, 2),
      trade(100, 0, 3),
    ]).prints;
    expect(sumPrintsIn(prints, 0, MINUTE)).toEqual({
      volume: 1,
      priceVolume: 100,
      priceSquaredVolume: 10_000,
    });
  });
});

/** A def that counts its own replays, and optionally reads `ctx.ticks`. */
function stubDef(
  id: string,
  wanted: boolean,
  replays: { count: number },
): RuntimeIndicatorDef<null, Record<string, never>> {
  return {
    kind: "runtime",
    id,
    label: id,
    category: "l1",
    ticksWanted: wanted,
    defaultSettings: {},
    settingsSchema: [],
    lines: [{ key: "prints" }],
    placement: { kind: "overlay" },
    createState: () => null,
    onBar: (ctx) => {
      if (ctx.replaying) replays.count += 1;
    },
    readOutput: () => ({ prints: null }),
  };
}

describe("handing the store over", () => {
  it("replays only the indicators that declared they read it", () => {
    const asked = { count: 0 };
    const silent = { count: 0 };
    const runtime = createIndicatorRuntime([
      stubDef("asked", true, asked),
      stubDef("silent", false, silent),
    ] as never);
    const bars = [bar(0), bar(MINUTE)];
    runtime.setActiveAndReplay(
      new Set(["asked", "silent"]),
      { asked: {}, silent: {} },
      bars,
    );
    expect(asked.count).toBe(2);
    expect(silent.count).toBe(2);

    runtime.setTicks(viewOf(tapeOf([trade(100, 1, 0)])), bars);
    expect(asked.count).toBe(4);
    expect(silent.count).toBe(2);
  });

  it("does nothing at all for the same store twice, which is every tape-identity refresh", () => {
    const asked = { count: 0 };
    const runtime = createIndicatorRuntime([stubDef("asked", true, asked)] as never);
    const bars = [bar(0)];
    runtime.setActiveAndReplay(new Set(["asked"]), { asked: {} }, bars);
    const ticks = viewOf(tapeOf([trade(100, 1, 0)]));
    runtime.setTicks(ticks, bars);
    expect(asked.count).toBe(2);
    runtime.setTicks(ticks, bars);
    runtime.setTicks(ticks, []);
    expect(asked.count).toBe(2);
  });

  it("hands the store to a newly activated indicator without replaying it twice", () => {
    const asked = { count: 0 };
    const runtime = createIndicatorRuntime([stubDef("asked", true, asked)] as never);
    const bars = [bar(0)];
    runtime.setTicks(viewOf(tapeOf([trade(100, 1, 0)])), bars);
    runtime.setActiveAndReplay(new Set(["asked"]), { asked: {} }, bars);
    expect(asked.count).toBe(1);
  });
});

describe("where the live recording is complete (PR #29 review)", () => {
  it("calls a window the size cap took live prints from thin, and the windows after the newest one it took complete", () => {
    const tape = new AggressiveTape(() => 0);
    tape.reset();
    for (let i = 0; i < 50_000; i += 1) tape.add(trade(100, 1, Math.floor((i * MINUTE) / 50_000)));
    for (let i = 0; i < 230_000; i += 1) tape.add(trade(200, 2, MINUTE + Math.floor((i * 59 * MINUTE) / 230_000)));
    const ticks = viewOf(tape);
    expect(tape.liveDroppedThrough).toBeGreaterThanOrEqual(0);
    expect(tape.liveDroppedThrough).toBeLessThan(MINUTE);
    expect(ticks.prints.filter((print) => print.ts < MINUTE).length).toBeLessThan(50_000);
    expect(ticks.coverageOf(0, MINUTE)).toBe("thin");
    expect(ticks.coverageOf(MINUTE, 2 * MINUTE)).toBe("all");
  });

  it("keeps the stretch before a reconnect complete up to its last live print, and the gap after it uncovered", () => {
    let now = 0;
    const tape = new AggressiveTape(() => now);
    tape.reset();
    tape.absorb([]);
    tape.add(trade(100, 1, 10 * MINUTE));
    now = 20 * MINUTE;
    tape.absorb([]);
    const ticks = viewOf(tape);
    expect(tape.liveSpans).toEqual([{ from: 0, to: 10 * MINUTE }]);
    expect(ticks.coverageOf(5 * MINUTE, 6 * MINUTE)).toBe("all");
    expect(ticks.coverageOf(10 * MINUTE, 11 * MINUTE)).toBe("none");
    expect(ticks.coverageOf(20 * MINUTE, 21 * MINUTE)).toBe("all");
    tape.reset();
    expect(tape.liveSpans).toEqual([]);
    expect(tape.liveDroppedThrough).toBe(-Infinity);
  });

  it("moves the history version for history prints and coverage, never for a live print, and replays only the indicators that read the store", () => {
    const tape = new AggressiveTape(() => 0);
    tape.reset();
    const start = tape.historyVersion;
    tape.add(trade(100, 1, 0));
    expect(tape.historyVersion).toBe(start);
    tape.addHistory([trade(100, 1, -MINUTE)]);
    expect(tape.historyVersion).toBe(start + 1);
    tape.coverHistory(-HOUR, 0, 0);
    expect(tape.historyVersion).toBe(start + 2);
    const asked = { count: 0 };
    const silent = { count: 0 };
    const runtime = createIndicatorRuntime([stubDef("asked", true, asked), stubDef("silent", false, silent)] as never);
    const bars = [bar(0), bar(MINUTE)];
    runtime.setActiveAndReplay(new Set(["asked", "silent"]), { asked: {}, silent: {} }, bars);
    runtime.refreshTicks(bars);
    expect([asked.count, silent.count]).toEqual([4, 2]);
    runtime.refreshTicks([]);
    expect(asked.count).toBe(4);
  });
});

