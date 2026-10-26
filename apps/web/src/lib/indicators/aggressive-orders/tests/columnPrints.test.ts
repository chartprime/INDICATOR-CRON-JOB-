import { describe, expect, it } from "vitest";
import type { LiquidityFrame } from "../../../../types/frames";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { HISTORY_MAX_MS, HISTORY_MIN_MS, HISTORY_REASK_MS, columnCoverage, historyRequestFor, historyWantedFrom, tradesFromColumns } from "../columnPrints";
import { HISTORY_ASK_MAX_MS } from "../aggressiveTape";

const T = 1_700_000_000_000;

function column(ts: number, extra: Partial<LiquidityColumn> = {}): LiquidityColumn {
  return { ts, lo: 10, hi: 12, bid: new Float64Array(3), ask: new Float64Array(3), ...extra };
}

describe("tradesFromColumns", () => {
  it("turns a frame's column prints into trade frames with the frame's identity, synthesising an id where the print has none", () => {
    const frame: LiquidityFrame = {
      type: "liquidity", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL",
      ts: T + 1_000, seq: 2, reset: true, row_width: 4, column_ms: 1_000,
      columns: [
        { ts: T, lo: 10, hi: 12, bid: [], ask: [], prints: [{ ts: T - 300, price: 80_001, size: 3, side: "buy", id: "77" }], prints_floor: 2 },
        { ts: T + 1_000, lo: 10, hi: 12, bid: [], ask: [] },
        { ts: T + 2_000, lo: 10, hi: 12, bid: [], ask: [], prints: [{ ts: T + 1_500, price: 80_000, size: 5, side: "sell", id: null }], prints_floor: 0 },
      ],
    };
    expect(tradesFromColumns(frame)).toEqual([
      { type: "trade", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts_exchange: T - 300, price: 80_001, size: 3, side: "buy", trade_id: "77" },
      { type: "trade", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts_exchange: T + 1_500, price: 80_000, size: 5, side: "sell", trade_id: `column:${T + 1_500}:sell:80000:5` },
    ]);
  });

  it("carries a dxFeed identity", () => {
    const frame: LiquidityFrame = {
      type: "liquidity", symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE",
      ts: T, seq: 1, reset: true, row_width: 0.25, column_ms: 1_000,
      columns: [{ ts: T, lo: 10, hi: 12, bid: [], ask: [], prints: [{ ts: T, price: 20_000, size: 7, side: "buy", id: "nq-1" }], prints_floor: 5 }],
    };
    expect(tradesFromColumns(frame)[0]).toMatchObject({ provider: "DXFEED", assetClass: "FUTURE", symbol: "/NQU26:XCME", trade_id: "nq-1" });
  });
});

describe("columnCoverage", () => {
  it("covers the second ending at each column that kept prints from a floor no higher than the one asked for, merging touching columns", () => {
    const columns = [
      column(T, { prints: [], printsFloor: 0 }),
      column(T + 1_000, { prints: [], printsFloor: 3 }),
      column(T + 2_000, { prints: [], printsFloor: 10 }),
      column(T + 3_000),
      column(T + 5_000, { prints: [], printsFloor: 1 }),
      column(T + 6_000, { prints: [], printsFloor: 4 }),
    ];
    expect(columnCoverage(columns, 1_000, 5)).toEqual([{ from: T - 1_000, to: T + 1_000 }, { from: T + 4_000, to: T + 6_000 }]);
    expect(columnCoverage(columns, 1_000, 0)).toEqual([{ from: T - 1_000, to: T }]);
    expect(columnCoverage(columns, 1_000, 10)).toEqual([{ from: T - 1_000, to: T + 2_000 }, { from: T + 4_000, to: T + 6_000 }]);
  });

  it("uses the tier's own column width for deep columns", () => {
    const columns = [column(T, { prints: [], printsFloor: 0 }), column(T + 10_000, { prints: [], printsFloor: 0 })];
    expect(columnCoverage(columns, 10_000, 0)).toEqual([{ from: T - 10_000, to: T + 10_000 }]);
  });
});

describe("historyRequestFor", () => {
  function grid(fine: LiquidityColumn[], deep: LiquidityColumn[] = []) {
    return { columns: fine, columnMs: 1_000, deepColumns: deep, deepColumnMs: 10_000 };
  }
  const NOW = T + 100_000;
  const WINDOW = 60_000;

  it("asks for the whole window when nothing covers it", async () => {
    const { AggressiveTape } = await import("../aggressiveTape");
    expect(historyRequestFor(new AggressiveTape(() => NOW), null, 5, NOW - WINDOW, NOW)).toEqual({ from: NOW - WINDOW, to: NOW });
  });

  it("once the tape is full, the history it shed is not asked for again: the wanted edge stays at what the tape can hold", async () => {
    const { AggressiveTape, MAX_TAPE_PRINTS, TRIM_SLACK_PRINTS } = await import("../aggressiveTape");
    const tape = new AggressiveTape(() => NOW);
    const print = (i: number, ts: number) => ({ type: "trade", symbol: "/ESU26:XCME", provider: "DXFEED", assetClass: "FUTURE", ts_exchange: ts, price: 7600, size: 1, side: "buy", trade_id: `p${i}` }) as const;
    tape.add(print(-1, NOW));
    tape.coverHistory(NOW - 7_200_000, NOW, 1);
    const count = MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS;
    tape.addHistory(Array.from({ length: count }, (_unused, i) => print(i, NOW - 7_200_000 + Math.floor((i * 7_000_000) / count))));
    expect(tape.prints.length).toBeLessThanOrEqual(MAX_TAPE_PRINTS);
    const heldFrom = tape.prints[0].ts;
    expect(heldFrom).toBeGreaterThan(NOW - 7_200_000);
    expect(historyRequestFor(tape, null, 1, NOW - 7_200_000, NOW)).toBeNull();
    expect(tape.historyWantedFrom).toBe(heldFrom);
  });

  it("asks only for what the columns leave uncovered, oldest hole first, then the stretch up to now", async () => {
    const { AggressiveTape } = await import("../aggressiveTape");
    const tape = new AggressiveTape(() => NOW);
    const deep = [column(NOW - 50_000, { prints: [], printsFloor: 2 }), column(NOW - 40_000, { prints: [], printsFloor: 2 })];
    const fine = Array.from({ length: 20 }, (_unused, i) => column(NOW - 20_000 + i * 1_000, { prints: [], printsFloor: 3 }));
    expect(historyRequestFor(tape, grid(fine, deep), 5, NOW - WINDOW, NOW)).toEqual({ from: NOW - 40_000, to: NOW - 21_000 });
    tape.coverHistory(NOW - 40_000, NOW - 21_000, 5);
    expect(historyRequestFor(tape, grid(fine, deep), 5, NOW - WINDOW, NOW)).toEqual({ from: NOW - 1_000, to: NOW });
    tape.coverHistory(NOW - 1_000, NOW, 5);
    expect(historyRequestFor(tape, grid(fine, deep), 5, NOW - WINDOW, NOW)).toBeNull();
  });

  it("never asks for the stretch the live feed covers, and does not repeat an ask while its reply is due", async () => {
    const { AggressiveTape } = await import("../aggressiveTape");
    const LONG = 600_000;
    const clock = { now: NOW - 30_000 };
    const tape = new AggressiveTape(() => clock.now);
    tape.absorb([]); // the snapshot: live from thirty seconds before now
    clock.now = NOW;
    // The window up to where the live feed took over, and no further.
    expect(historyRequestFor(tape, null, 5, NOW - LONG, NOW)).toEqual({ from: NOW - LONG, to: NOW - 30_000 });
    // The same stretch a second later, its reply still due: not asked again ...
    expect(historyRequestFor(tape, null, 5, NOW + 1_000 - LONG, NOW + 1_000)).toBeNull();
    // ... at another floor it is another ask ...
    expect(historyRequestFor(tape, null, 3, NOW + 2_000 - LONG, NOW + 2_000)).toEqual({ from: NOW + 2_000 - LONG, to: NOW - 30_000 });
    // ... and once the reply is overdue it may be asked again.
    expect(historyRequestFor(tape, null, 5, NOW + HISTORY_REASK_MS - LONG, NOW + HISTORY_REASK_MS)).toEqual({ from: NOW + HISTORY_REASK_MS - LONG, to: NOW - 30_000 });
    // Coverage that stops short of the live start leaves the stretch between; coverage that reaches it leaves nothing.
    tape.coverHistory(NOW - LONG - 60_000, NOW - 40_000, 5);
    expect(historyRequestFor(tape, null, 5, NOW + 2 * HISTORY_REASK_MS - LONG, NOW + 2 * HISTORY_REASK_MS)).toEqual({ from: NOW - 40_000, to: NOW - 30_000 });
    tape.coverHistory(NOW - 40_000, NOW - 30_000, 5);
    expect(historyRequestFor(tape, null, 5, NOW + 3 * HISTORY_REASK_MS - LONG, NOW + 3 * HISTORY_REASK_MS)).toBeNull();
  });

  // Property: before the live feed has taken over, the ask's end is "now", so
  // it slides with every heatmap frame; that is still the same ask, and the
  // collector is not re-asked every second (the server's 60/min budget
  // refused exactly this during the first live run). Oracle: one ask per
  // HISTORY_REASK_MS as the clock advances frame by frame; another floor is
  // another ask, and the next hole after a reply is asked at once (above).
  it("a not-yet-live tape is asked once per re-ask period as the window slides, not once per frame", async () => {
    const { AggressiveTape } = await import("../aggressiveTape");
    const tape = new AggressiveTape(() => NOW);
    expect(historyRequestFor(tape, null, 5, NOW - WINDOW, NOW)).toEqual({ from: NOW - WINDOW, to: NOW });
    for (let frame = 1; frame < HISTORY_REASK_MS / 1_000; frame += 1) {
      expect(historyRequestFor(tape, null, 5, NOW + frame * 1_000 - WINDOW, NOW + frame * 1_000)).toBeNull();
    }
    expect(historyRequestFor(tape, null, 5, NOW + HISTORY_REASK_MS - WINDOW, NOW + HISTORY_REASK_MS)).toEqual({ from: NOW + HISTORY_REASK_MS - WINDOW, to: NOW + HISTORY_REASK_MS });
    expect(historyRequestFor(tape, null, 5, NOW + HISTORY_REASK_MS + 1_000 - WINDOW, NOW + HISTORY_REASK_MS + 1_000)).toBeNull();
    expect(historyRequestFor(tape, null, 3, NOW + HISTORY_REASK_MS + 2_000 - WINDOW, NOW + HISTORY_REASK_MS + 2_000)).not.toBeNull();
  });

  it("a column that kept prints from a higher floor than asked does not count", async () => {
    const { AggressiveTape } = await import("../aggressiveTape");
    const fine = Array.from({ length: 60 }, (_unused, i) => column(NOW - 59_000 + i * 1_000, { prints: [], printsFloor: 8 }));
    expect(historyRequestFor(new AggressiveTape(() => NOW), grid(fine), 5, NOW - WINDOW, NOW)).toEqual({ from: NOW - WINDOW, to: NOW });
    expect(historyRequestFor(new AggressiveTape(() => NOW), grid(fine), 8, NOW - WINDOW, NOW)).toBeNull();
  });
});

describe("historyRequestFor over days", () => {
  const NOW = T + 100_000;
  const DAY = HISTORY_ASK_MAX_MS;

  it("asks for at most one piece at a time, the newest first, when the wanted stretch is longer", async () => {
    const { AggressiveTape } = await import("../aggressiveTape");
    const tape = new AggressiveTape(() => NOW);
    expect(historyRequestFor(tape, null, 5, NOW - 3 * DAY, NOW)).toEqual({ from: NOW - HISTORY_ASK_MAX_MS, to: NOW });
    tape.coverHistory(NOW - DAY, NOW, 5);
    expect(historyRequestFor(tape, null, 5, NOW - 3 * DAY, NOW + HISTORY_REASK_MS)).toEqual({ from: NOW - 2 * DAY, to: NOW - DAY });
  });

  it("a wanted start that moves further back while a reply is due is not a new ask; once covered, the older day is", async () => {
    const { AggressiveTape } = await import("../aggressiveTape");
    const tape = new AggressiveTape(() => NOW);
    expect(historyRequestFor(tape, null, 5, NOW - DAY, NOW)).toEqual({ from: NOW - DAY, to: NOW });
    expect(historyRequestFor(tape, null, 5, NOW - 3 * DAY, NOW + 1_000)).toBeNull();
    tape.coverHistory(NOW - DAY, NOW, 5);
    expect(historyRequestFor(tape, null, 5, NOW - 3 * DAY, NOW + 2_000)).toEqual({ from: NOW - 2 * DAY, to: NOW - DAY });
  });
});

describe("historyWantedFrom", () => {
  const NOW = T + 100_000;
  const DAY = 24 * 60 * 60 * 1000;

  it("is the last few hours when nothing older is on screen, the screen's start when it is, and never further back than the most kept", () => {
    expect(HISTORY_MIN_MS).toBe(4 * 60 * 60 * 1000);
    expect(HISTORY_MAX_MS).toBe(31 * DAY);
    expect(historyWantedFrom(NOW, null)).toBe(NOW - HISTORY_MIN_MS);
    expect(historyWantedFrom(NOW, NOW - 60_000)).toBe(NOW - HISTORY_MIN_MS);
    expect(historyWantedFrom(NOW, NOW - 5 * DAY)).toBe(NOW - 5 * DAY);
    expect(historyWantedFrom(NOW, NOW - 400 * DAY)).toBe(NOW - HISTORY_MAX_MS);
  });
});

describe("historyRequestFor and a stretch given up on", () => {
  const NOW = T + 100_000;
  const DAY = HISTORY_ASK_MAX_MS;

  it("does not ask again for a piece the collector could not serve, and asks for the piece below it instead", async () => {
    const { AggressiveTape, HISTORY_GIVE_UP_MS } = await import("../aggressiveTape");
    const tape = new AggressiveTape(() => NOW);
    tape.giveUpHistory(NOW - DAY, NOW, NOW + HISTORY_GIVE_UP_MS);
    expect(historyRequestFor(tape, null, 5, NOW - 3 * DAY, NOW)).toEqual({ from: NOW - 2 * DAY, to: NOW - DAY });
    tape.coverHistory(NOW - 2 * DAY, NOW - DAY, 5);
    expect(historyRequestFor(tape, null, 5, NOW - 3 * DAY, NOW + HISTORY_REASK_MS)).toEqual({ from: NOW - 3 * DAY, to: NOW - 2 * DAY });
  });
});

describe("historyRequestFor at the floor in force", () => {
  const NOW = T + 100_000;
  const DAY = HISTORY_ASK_MAX_MS;

  it("counts coverage at the ask's floor or finer only: a day covered at a coarser floor is asked again at a finer one, and not at the same or a coarser one", async () => {
    const { AggressiveTape } = await import("../aggressiveTape");
    const tape = new AggressiveTape(() => NOW);
    tape.coverHistory(NOW - 12 * 3_600_000, NOW, 0.16);
    tape.coverHistory(NOW - 12 * 3_600_000 - DAY, NOW - 12 * 3_600_000, 5);
    expect(historyRequestFor(tape, null, 5, NOW - 6 * DAY, NOW)).toEqual({ from: NOW - 12 * 3_600_000 - 2 * DAY, to: NOW - 12 * 3_600_000 - DAY });
    expect(historyRequestFor(tape, null, 10, NOW - 6 * DAY, NOW + 1_000)).toEqual({ from: NOW - 12 * 3_600_000 - 2 * DAY, to: NOW - 12 * 3_600_000 - DAY });
    expect(historyRequestFor(tape, null, 3, NOW - 6 * DAY, NOW + 2_000)).toEqual({ from: NOW - 12 * 3_600_000 - DAY, to: NOW - 12 * 3_600_000 });
  });
});
