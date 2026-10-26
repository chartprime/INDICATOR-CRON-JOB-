import { describe, expect, it } from "vitest";
import type { LiquidityPrint } from "../../../../types/frames";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { PrintLedger, noPrints, readPrints, type PrintRead } from "../liveRangePrints";
import type { HostColumn, RangeGrid } from "../liveRangeReader";

const T = Date.UTC(2026, 9, 16, 2, 0);
const S = 10_000;

function print(ts: number, price: number, size: number, side: "buy" | "sell", id: string | null = `${ts}:${price}:${size}:${side}`): LiquidityPrint {
  return { ts, price, size, side, id };
}

function fine(ts: number, prints: LiquidityPrint[], printsFloor?: number): LiquidityColumn {
  return { ts, lo: 99, hi: 101, bid: new Float64Array(3), ask: new Float64Array(3), prints, ...(printsFloor === undefined ? {} : { printsFloor }) };
}

function host(ts: number, prints: LiquidityPrint[], printsFloor: number | null = null): HostColumn {
  return { ts, rowWidth: 1, buy: [], sell: [], prints, printsFloor };
}

function grid(columns: LiquidityColumn[], deepColumns: LiquidityColumn[] = []): RangeGrid {
  return { columns, columnMs: 1_000, deepColumns, deepColumnMs: deepColumns.length > 0 ? S : 0, rowWidth: 1 };
}

describe("readPrints", () => {
  it("starts from nothing: no prints, no floor, the threshold and the unit it was asked with", () => {
    expect(noPrints(5, "BTC")).toEqual({ buys: 0, sells: 0, buyCount: 0, sellCount: 0, threshold: 5, floor: null, unit: "BTC" });
  });

  it("adds up the prints at or above the threshold by side, with how many there were", () => {
    const columns = [
      fine(T + 1_000, [print(T + 200, 100, 5, "buy"), print(T + 300, 100, 4, "buy"), print(T + 400, 100, 7, "sell")]),
      fine(T + 2_000, [print(T + 1_500, 100, 12, "buy"), print(T + 1_600, 100, 5, "sell")]),
    ];
    expect(readPrints(grid(columns), [], T, T + 2_000, 5, "BTC")).toEqual({ buys: 17, sells: 12, buyCount: 2, sellCount: 2, threshold: 5, floor: null, unit: "BTC" });
    expect(readPrints(grid(columns), [], T, T + 2_000, 7, "BTC")).toEqual({ buys: 12, sells: 7, buyCount: 1, sellCount: 1, threshold: 7, floor: null, unit: "BTC" });
    expect(readPrints(grid(columns), [], T, T + 2_000, 0, "")).toMatchObject({ buys: 21, buyCount: 3, sells: 12, sellCount: 2 });
  });

  it("reads the prints of the window, its first moment in and its end out", () => {
    const columns = [fine(T + 1_000, [print(T, 100, 5, "buy"), print(T + 999, 100, 6, "buy"), print(T + 1_000, 100, 7, "buy")]), fine(T + 2_000, [print(T + 1_500, 100, 8, "buy")])];
    expect(readPrints(grid(columns), [], T, T + 1_000, 1, "").buys).toBe(11);
    expect(readPrints(grid(columns), [], T + 1, T + 2_000, 1, "").buys).toBe(6 + 7 + 8);
  });

  it("counts a print once when two columns carry it, and never folds together two prints without an id", () => {
    const shared = print(T + 900, 100, 5, "buy", "a1");
    const columns = [fine(T + 1_000, [shared, print(T + 950, 100, 5, "sell", null)]), fine(T + 2_000, [shared, print(T + 950, 100, 5, "sell", null)])];
    expect(readPrints(grid(columns), [], T, T + 2_000, 1, "")).toMatchObject({ buys: 5, buyCount: 1, sells: 10, sellCount: 2 });
  });
});

describe("readPrints across the tiers", () => {
  it("reads the host columns before the oldest ten-second column of the runtime, the ten-second columns up to the seam and the one-second columns from it, so no print is read twice", () => {
    const hosted = [host(T - S, [print(T - 9_000, 100, 5, "buy", "h1")]), host(T, [print(T + 1_000, 100, 50, "buy", "h2")])];
    const deep = [
      fine(T, [print(T + 2_000, 100, 6, "buy", "d1"), print(T + 6_000, 100, 4, "buy", "d4")]),
      fine(T + S, [print(T + 12_000, 100, 7, "sell", "d2")]),
      fine(T + 2 * S, [print(T + 25_000, 100, 8, "sell", "d3")]),
      fine(T + 3 * S, [print(T + 31_000, 100, 9, "buy", null)]),
    ];
    const ones = [
      fine(T + 21_000, []),
      fine(T + 26_000, [print(T + 25_000, 100, 8, "sell", null)]),
      fine(T + 31_000, [print(T + 30_500, 100, 9, "buy", null)]),
      fine(T + 40_000, []),
    ];
    expect(readPrints(grid(ones, deep), hosted, T - S, T + 40_000, 1, "")).toMatchObject({ buys: 24, buyCount: 4, sells: 15, sellCount: 2 });
    expect(readPrints(grid(ones, deep), hosted, T + 5_000, T + 40_000, 1, "")).toMatchObject({ buys: 13, buyCount: 2, sells: 15, sellCount: 2 });
  });

  it("fills a stretch the runtime holds no column for from the host columns that lie whole inside it, before the runtime's newest column only, in the ledger as in readPrints", () => {
    const deep = [fine(T, [print(T + 2_000, 100, 6, "buy", "d1")]), fine(T + 12 * S, [print(T + 121_000, 100, 4, "sell", "d2")])];
    const ones = [fine(T + 130_000, [print(T + 129_500, 100, 3, "buy", "o1")]), fine(T + 131_000, []), fine(T + 200_000, [])];
    const hosted = [
      host(T, [print(T + 2_000, 100, 6, "buy", "d1"), print(T + 3_000, 100, 999, "buy", "x1")]),
      host(T + S, [print(T + 12_000, 100, 7, "sell", "h1")]),
      host(T + 2 * S, [print(T + 25_000, 100, 8, "buy", "h2")]),
      host(T + 3 * S, [print(T + 31_000, 100, 9, "buy", "h3")]),
      host(T + 12 * S, [print(T + 122_000, 100, 999, "sell", "x2")]),
      host(T + 15 * S, [print(T + 150_000, 100, 11, "buy", "h4")]),
      host(T + 21 * S, [print(T + 211_000, 100, 999, "sell", "x3")]),
    ];
    const g = grid(ones, deep);
    expect(readPrints(g, hosted, T - S, T + 220_000, 1, "")).toMatchObject({ buys: 37, buyCount: 5, sells: 11, sellCount: 2 });
    expect(readPrints(g, hosted, T + 20_000, T + 220_000, 1, "")).toMatchObject({ buys: 31, buyCount: 4, sells: 4, sellCount: 1 });
    const ledger = new PrintLedger();
    expect(ledger.update(g, hosted, 1)).toBe(9);
    expect(ledger.read(T - S, T + 220_000, "")).toEqual(readPrints(g, hosted, T - S, T + 220_000, 1, ""));
    expect(ledger.read(T + 20_000, T + 220_000, "")).toEqual(readPrints(g, hosted, T + 20_000, T + 220_000, 1, ""));
    const edge = new PrintLedger();
    edge.update(null, [host(T, [print(T + 1_000, 100, 5, "buy", "e1"), print(T + 3_000, 100, 7, "buy", "e2")])], 1);
    expect(edge.read(T, T + 3_000, "")).toMatchObject({ buys: 5, buyCount: 1 });
    expect(edge.read(T, T + 3_001, "")).toMatchObject({ buys: 12, buyCount: 2 });
    const narrow = grid(ones, [fine(T, [print(T + 2_000, 100, 6, "buy", "d1")]), fine(T + 6 * S, [print(T + 61_000, 100, 4, "sell", "d2")])]);
    expect(readPrints(narrow, hosted, T - S, T + 220_000, 1, "")).toMatchObject({ buys: 20, buyCount: 3, sells: 1_003, sellCount: 2 });
  });

  it("reads only the host columns while the grid replays a coarser tier, and the host columns up to the end of the window without a grid", () => {
    const hosted = [host(T - S, [print(T - 9_000, 100, 5, "buy")]), host(T, [print(T + 1_000, 100, 6, "sell")])];
    const replaying: RangeGrid = { columns: [fine(T + S, [print(T + 9_500, 100, 50, "buy")])], columnMs: S, deepColumns: [], deepColumnMs: 0, rowWidth: 1 };
    expect(readPrints(replaying, hosted, T - S, T + 2 * S, 1, "")).toMatchObject({ buys: 5, sells: 6 });
    expect(readPrints(null, hosted, T - S, T + 2 * S, 1, "")).toMatchObject({ buys: 5, sells: 6 });
    expect(readPrints(null, hosted, T - S, T, 1, "")).toMatchObject({ buys: 5, sells: 0 });
  });

  it("names the highest floor of the columns it read, the size from which each of them kept every print, and none when no column says", () => {
    const columns = [fine(T + 1_000, [], 0.4), fine(T + 2_000, [], 0.9), fine(T + 3_000, [], 0.2)];
    expect(readPrints(grid(columns), [], T, T + 3_000, 5, "").floor).toBe(0.9);
    expect(readPrints(grid(columns), [], T + 2_000, T + 3_000, 5, "").floor).toBe(0.2);
    expect(readPrints(grid([fine(T + 1_000, [])]), [], T, T + 1_000, 5, "").floor).toBeNull();
    expect(readPrints(grid([fine(T + 1_000, [], Number.NaN), fine(T + 2_000, [], -1), fine(T + 3_000, [], 0)]), [], T, T + 3_000, 5, "").floor).toBeNull();
    expect(readPrints(null, [host(T - S, [], 480)], T - S, T, 5, "").floor).toBe(480);
  });

  it("reads nothing for an empty window", () => {
    const columns = [fine(T + 1_000, [print(T + 500, 100, 5, "buy")], 0.5)];
    expect(readPrints(grid(columns), [], T + 1_000, T + 1_000, 1, "BTC")).toEqual(noPrints(1, "BTC"));
    expect(readPrints(grid(columns), [], T + 1_000, T, 1, "BTC")).toEqual(noPrints(1, "BTC"));
  });
});

describe("PrintLedger", () => {
  const rounded = (read: PrintRead) => ({ ...read, buys: Math.round(read.buys * 1e9) / 1e9, sells: Math.round(read.sells * 1e9) / 1e9 });
  function walk(count: number, seed: number): { hosted: HostColumn[]; deep: LiquidityColumn[]; ones: LiquidityColumn[] } {
    let state = seed;
    const rand = () => {
      state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const printsAt = (ts: number, span: number, previous: LiquidityPrint[]): LiquidityPrint[] => {
      const out: LiquidityPrint[] = [];
      if (previous.length > 0 && rand() < 0.3) out.push(previous[0]);
      const n = Math.floor(rand() * 4);
      for (let k = 0; k < n; k += 1) {
        const at = ts - 1_000 + Math.floor(rand() * span);
        out.push(print(at, 100 + Math.floor(rand() * 5), Math.round(rand() * 100) / 10, rand() < 0.5 ? "buy" : "sell", rand() < 0.15 ? null : `p${at}:${k}`));
      }
      return out;
    };
    const hosted: HostColumn[] = [];
    let previous: LiquidityPrint[] = [];
    for (let i = 0; i < count; i += 1) {
      previous = printsAt(T + i * S, S, previous);
      hosted.push(host(T + i * S, previous, rand() < 0.5 ? Math.round(rand() * 10) / 10 : null));
    }
    const edge = T + count * S;
    hosted.push(host(edge, [print(edge + 500, 100, 9, "buy", "past-the-seam")]));
    const deep: LiquidityColumn[] = [];
    for (let i = 0; i < 6; i += 1) {
      previous = printsAt(edge + i * S, S, previous);
      deep.push(fine(edge + i * S, previous, rand() < 0.5 ? Math.round(rand() * 10) / 10 : undefined));
    }
    const ones: LiquidityColumn[] = [];
    for (let ts = edge + 3 * S + 5_000; ts < edge + 7 * S; ts += 1_000) {
      previous = printsAt(ts, 1_000, previous);
      ones.push(fine(ts, previous));
    }
    return { hosted, deep, ones };
  }

  it("reads what readPrints reads: over the tiers, prints two columns carry, prints without an id, the window's edges, the threshold and the floor", () => {
    for (const seed of [3, 11, 29]) {
      const { hosted, deep, ones } = walk(300, seed);
      const g = grid(ones, deep);
      const end = T + 307 * S;
      for (const threshold of [0, 2.5, 7]) {
        const ledger = new PrintLedger();
        expect(ledger.update(g, hosted, threshold)).toBe(300 + 4 + ones.filter((c) => c.ts >= T + 304 * S).length);
        for (const [from, to] of [[T, end], [T + 37 * S + 4_000, T + 250 * S + 6_000], [T + 299 * S, end - 11_000], [T + 304 * S + 500, end], [T + 100 * S, T + 100 * S + 5_000]]) {
          expect(rounded(ledger.read(from, to, "BTC")), `seed ${seed} threshold ${threshold} from ${from - T} to ${to - T}`).toEqual(rounded(readPrints(g, hosted, from, to, threshold, "BTC")));
        }
        expect(ledger.read(T + S, T + S, "BTC")).toEqual(noPrints(threshold, "BTC"));
        expect(ledger.read(end, T, "BTC")).toEqual(noPrints(threshold, "BTC"));
      }
      const replaying: RangeGrid = { columns: deep, columnMs: S, deepColumns: [], deepColumnMs: 0, rowWidth: 1 };
      const ledger = new PrintLedger();
      ledger.update(replaying, hosted, 1);
      expect(rounded(ledger.read(T, end, ""))).toEqual(rounded(readPrints(replaying, hosted, T, end, 1, "")));
      ledger.update(null, hosted, 1);
      expect(rounded(ledger.read(T, end, ""))).toEqual(rounded(readPrints(null, hosted, T, end, 1, "")));
    }
    expect(new PrintLedger().read(T, T + S, "BTC")).toEqual(noPrints(0, "BTC"));
  });

  it("takes new columns at the end and a changed last column without starting over, and reads with a new threshold by redoing every tally, not the line-up", () => {
    const { hosted, deep, ones } = walk(120, 5);
    const ledger = new PrintLedger();
    const fineIn = (columns: LiquidityColumn[]) => columns.filter((c) => c.ts >= T + 124 * S).length;
    expect(ledger.update(grid(ones, deep), hosted, 1)).toBe(120 + 4 + fineIn(ones));
    expect(ledger.update(grid(ones, deep), hosted, 1)).toBe(0);
    const more = [...ones, fine(ones[ones.length - 1].ts + 1_000, [print(ones[ones.length - 1].ts + 500, 100, 9, "buy", "new")])];
    expect(ledger.update(grid(more, deep), hosted, 1)).toBe(1);
    const changed = [...more.slice(0, -1), fine(more[more.length - 1].ts, [print(more[more.length - 1].ts + 500, 100, 9, "buy", "new"), print(more[more.length - 1].ts + 600, 100, 4, "sell", "late")])];
    expect(ledger.update(grid(changed, deep), hosted, 1)).toBe(1);
    const end = changed[changed.length - 1].ts + 1_000;
    expect(rounded(ledger.read(T, end, ""))).toEqual(rounded(readPrints(grid(changed, deep), hosted, T, end, 1, "")));
    expect(ledger.update(grid(changed, deep), hosted, 6)).toBe(120 + 4 + fineIn(changed));
    expect(rounded(ledger.read(T, end, ""))).toEqual(rounded(readPrints(grid(changed, deep), hosted, T, end, 6, "")));
    expect(ledger.update(grid(changed, deep), hosted, 6)).toBe(0);
  });

  it("replays from a column changed in the middle and lets go of the prints it owned, so a print it no longer carries counts in the next column that does, and starts over when the first column is another", () => {
    const shared = print(T + 9_500, 100, 5, "buy", "twice");
    const first = [host(T, [shared]), host(T + S, [shared, print(T + 15_000, 100, 7, "sell", "s1")]), host(T + 2 * S, [print(T + 25_000, 100, 8, "buy", "b2")])];
    const ledger = new PrintLedger();
    expect(ledger.update(null, first, 1)).toBe(3);
    expect(ledger.read(T, T + 3 * S, "")).toMatchObject({ buys: 13, buyCount: 2, sells: 7, sellCount: 1 });
    expect(ledger.read(T + S, T + 3 * S, "")).toMatchObject({ buys: 8, buyCount: 1 });
    expect(ledger.read(T + 9_200, T + 3 * S, "")).toMatchObject({ buys: 13, buyCount: 2 });
    const second = [host(T, [print(T + 500, 100, 2, "sell", "s0")]), first[1], first[2]];
    expect(ledger.update(null, second, 1)).toBe(3);
    expect(rounded(ledger.read(T, T + 3 * S, ""))).toEqual(rounded(readPrints(null, second, T, T + 3 * S, 1, "")));
    expect(ledger.read(T + 9_200, T + 3 * S, "")).toMatchObject({ buys: 13, buyCount: 2 });
    const third = [first[0], first[1], host(T + 2 * S, [print(T + 25_000, 100, 8, "buy", "b2"), shared])];
    expect(ledger.update(null, third, 1)).toBe(3);
    expect(ledger.read(T + 2 * S, T + 3 * S, "")).toMatchObject({ buys: 8, buyCount: 1 });
    const thrice = print(T + 25_000, 100, 3, "sell", "thrice");
    const chain = [host(T, [thrice]), host(T + S, [thrice]), host(T + 2 * S, [thrice])];
    expect(ledger.update(null, chain, 1)).toBe(3);
    expect(ledger.read(T + 9_000, T + 3 * S, "")).toEqual(readPrints(null, chain, T + 9_000, T + 3 * S, 1, ""));
    expect(ledger.read(T + 9_000, T + 3 * S, "")).toMatchObject({ sells: 3, sellCount: 1 });
    expect(ledger.update(null, third, 1)).toBe(3);
    expect(ledger.update(null, [first[0], first[1]], 1)).toBe(0);
    expect(ledger.read(T, T + 3 * S, "")).toMatchObject({ buys: 5, buyCount: 1, sells: 7 });
    expect(ledger.update(null, [host(T - S, []), ...first], 1)).toBe(4);
    expect(ledger.update(null, [], 1)).toBe(0);
    expect(ledger.read(T, T + 3 * S, "")).toEqual(noPrints(1, ""));
  });
});
