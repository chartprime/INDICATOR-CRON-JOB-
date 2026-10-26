import { describe, expect, it } from "vitest";
import { AT_PRICE_ROWS, CONSUMED_EATEN_SHARE, HOLE_BRIDGE_MS, LEDGER_MATCH_MS, LINK_SHARE, MAX_DIP_MS, atPrice, bandRuns, coversAt, coversSpan, firstAtOrAfter, inQuietZone, settleWithLedger, touchingBars, type FloorsAt, type RunSegment } from "../liquidityRuns";
import type { LiquidityLevel } from "../../../../types/frames";

const T = 1_700_000_000_000;
const M = 60_000;
const bar = (minute: number, low: number, high: number, close: number) => ({ time: T + minute * M, low, high, close });

describe("floors", () => {
  it("links a thinned level down to half its paint floor", () => {
    expect(LINK_SHARE).toBeLessThan(1);
    expect(LINK_SHARE).toBe(0.5);
  });
});

describe("firstAtOrAfter", () => {
  it("is a lower bound", () => {
    expect(firstAtOrAfter([1, 3, 5], 0)).toBe(0);
    expect(firstAtOrAfter([1, 3, 5], 3)).toBe(1);
    expect(firstAtOrAfter([1, 3, 5], 4)).toBe(2);
    expect(firstAtOrAfter([1, 3, 5], 9)).toBe(3);
    expect(firstAtOrAfter([], 1)).toBe(0);
  });
});

describe("bandRuns", () => {
  // One band (row 0, one row per band) at $100..$101; sizes per second.
  const S = 1_000;
  const col = (second: number, size: number) => ({ ts: T + second * S, lo: 0, hi: 0, bid: Float64Array.from([size]), ask: Float64Array.from([0]) });
  const tier = (sizes: number[]) => [{ columns: sizes.map((size, i) => col(i, size)), columnMs: S, scanTo: sizes.length }];
  const NO_BARS: { opens: number[]; ends: number[] } = { opens: [], ends: [] };
  const FLOORS = () => ({ link: 5, paint: 10 });
  const run = (tiers: ReturnType<typeof tier>, touches = NO_BARS) => bandRuns(tiers, 0, 1, "bid", FLOORS, touches);

  it("scans the tiers in time order whatever order they come in: the host's columns filling a hole between the runtime's are judged where they stand", () => {
    const live = [{ columns: [...[0, 1, 2, 3, 4].map((second) => col(second, 12)), ...[40, 41, 42, 43, 44].map((second) => col(second, 12))], columnMs: S, scanTo: 10 }];
    const filler = [{ columns: [col(10, 12), col(20, 12), col(30, 0)], columnMs: 10 * S, scanTo: 3 }];
    const shape = (runs: RunSegment[]) => runs.map((segment) => [(segment.startTs - T) / S, (segment.endTs - T) / S, segment.fate]);
    expect(shape(run([...filler, ...live]))).toEqual([[0, 30, "pulled"], [40, 45, "resting"]]);
    expect(shape(run([...live, ...filler]))).toEqual([[0, 30, "pulled"], [40, 45, "resting"]]);
    // Without the host's columns the hole is bridged and the level reads as one, never having been seen leaving.
    expect(shape(run(live))).toEqual([[0, 45, "resting"]]);
  });

  it("judges dips and holes by the clocks it is given, and drops a closed run shorter than the minimum while a resting one stays", () => {
    // The slow charts' clocks: a dip or a hole is one cell, a run is one bar. Cells of 10 s here, a bar of 40 s.
    const clocks = { dipMs: 0, holeMs: 10 * S, matchMs: 60 * S, minRunMs: 40 * S };
    const cells = (sizes: (number | null)[]) => [{ columns: sizes.flatMap((size, i) => (size === null ? [] : [{ ...col(i * 10, size), ts: T + i * 10 * S }])), columnMs: 10 * S, scanTo: sizes.filter((size) => size !== null).length }];
    // A dip of one cell under the paint floor holds the run; two cells end it.
    expect(bandRuns(cells([12, 6, 12, 12, 12]), 0, 1, "bid", FLOORS, NO_BARS, undefined, clocks)).toHaveLength(1);
    expect(bandRuns(cells([12, 12, 12, 12, 6, 6, 12, 12, 12, 12]), 0, 1, "bid", FLOORS, NO_BARS, undefined, clocks).map((r) => r.fate)).toEqual(["pulled", "resting"]);
    // A hole of one cell is bridged; a longer one is judged when the cells resume.
    expect(bandRuns(cells([12, 12, null, 12, 12, 12]), 0, 1, "bid", FLOORS, NO_BARS, undefined, clocks)).toHaveLength(1);
    expect(bandRuns(cells([12, 12, 12, 12, null, null, 0, 12, 12, 12, 12]), 0, 1, "bid", FLOORS, NO_BARS, undefined, clocks).map((r) => r.fate)).toEqual(["pulled", "resting"]);
    // A band gone after a one-cell hole ended where the cells resumed, not where they stopped: the hole was bridged.
    expect(bandRuns(cells([12, 12, 12, 12, null, 0, 12, 12, 12, 12]), 0, 1, "bid", FLOORS, NO_BARS, undefined, clocks)[0]).toMatchObject({ fate: "pulled", endTs: T + 50 * S });
    expect(bandRuns(cells([12, 12, 12, 12, null, null, 0, 12, 12, 12, 12]), 0, 1, "bid", FLOORS, NO_BARS, undefined, clocks)[0]).toMatchObject({ fate: "pulled", endTs: T + 40 * S });
    // Three cells then gone is under a bar: not a level on this chart. The same three cells at the live edge are.
    expect(bandRuns(cells([12, 12, 12, 0, 0, 0, 0]), 0, 1, "bid", FLOORS, NO_BARS, undefined, clocks)).toEqual([]);
    expect(bandRuns(cells([0, 0, 0, 0, 12, 12, 12]), 0, 1, "bid", FLOORS, NO_BARS, undefined, clocks)).toHaveLength(1);
    // On the default clocks the one-second rules stand: a 45 s dip is the limit, nothing is too short.
    expect(bandRuns(cells([12, 12, 12, 0, 0, 0, 0]), 0, 1, "bid", FLOORS, NO_BARS)).toHaveLength(1);
  });

  it("a band that stands to the end of the data is resting, with its peak", () => {
    const runs = run(tier([12, 20, 15, 12]));
    expect(runs).toEqual([{ startTs: T, endTs: T + 4 * S, fate: "resting", reach: "none", peak: 20, fill: null }]);
  });

  describe("a hole in the columns", () => {
    // The band is row 0 at $100..$101; a candle that printed there is low 100.5.
    const printedInHole = touchingBars([{ time: T + 3 * S, low: 100.5, high: 103, close: 102 }], 4 * S, 100, 101);
    const printedElsewhere = touchingBars([{ time: T + 3 * S, low: 101.5, high: 103, close: 102 }], 4 * S, 100, 101);
    const at = (seconds: number[], sizes: number[]) => {
      const columns = seconds.map((second, i) => col(second, sizes[i]));
      return [{ columns, columnMs: S, scanTo: columns.length }];
    };

    it("of a few seconds is bridged: the run goes on as if the columns were there", () => {
      expect(HOLE_BRIDGE_MS).toBe(5_000);
      // Seconds 3 and 4 missing (the next column is 3 s after the run's end), the band standing throughout: one run, nothing to report.
      expect(run(at([0, 1, 2, 5, 6], [12, 12, 12, 12, 12]))).toEqual([{ startTs: T, endTs: T + 7 * S, fate: "resting", reach: "none", peak: 12, fill: null }]);
      // Gone after a short hole: judged at the column that came back, as an adjacent column would be.
      expect(run(at([0, 1, 2, 5], [12, 12, 12, 0]))).toEqual([{ startTs: T, endTs: T + 5 * S, fate: "pulled", reach: "none", peak: 12, fill: null }]);
      // Exactly the bridge is still bridged; one second more is a hole.
      expect(run(at([0, 1, 7], [12, 12, 12]))).toHaveLength(1);
      expect(run(at([0, 1, 8], [12, 12, 12]))).toEqual([{ startTs: T, endTs: T + 9 * S, fate: "resting", reach: "none", peak: 12, fill: null }]);
    });

    it("longer, with the band still standing after it, keeps the run, its age spanning the hole", () => {
      // 20:14:30 on ETH perp: the publisher stalled 20 s; the wall was there before and after. One level, its age
      // spanning the hole; the dip clock starts over. The hover stops at the age, so the gap is drawn, never listed.
      const runs = run(at([0, 1, 2, 30, 31], [12, 12, 12, 12, 12]));
      expect(runs).toEqual([{ startTs: T, endTs: T + 32 * S, fate: "resting", reach: "none", peak: 12, fill: null }]);
      expect(run(at([0, 1, 2, 30, 60, 61], [12, 12, 12, 12, 12, 12]))).toEqual([{ startTs: T, endTs: T + 62 * S, fate: "resting", reach: "none", peak: 12, fill: null }]);
    });

    it("longer, with the band gone after it, is judged by the candles over the hole: consumed if one printed in the band, else pulled", () => {
      // The 2580-2594 asks on ETH perp at 20:18:40: eaten inside a 30 s hole, the candle shows price went through. Consumed where the columns stopped.
      expect(run(at([0, 1, 2, 30, 31], [12, 12, 12, 0, 0]), printedInHole)).toEqual([{ startTs: T, endTs: T + 3 * S, fate: "consumed", reach: "touch", peak: 12, fill: null }]);
      // No candle reached the band while the columns were missing: it left on its own.
      expect(run(at([0, 1, 2, 30, 31], [12, 12, 12, 0, 0]), printedElsewhere)).toEqual([{ startTs: T, endTs: T + 3 * S, fate: "pulled", reach: "none", peak: 12, fill: null }]);
      expect(run(at([0, 1, 2, 30, 31], [12, 12, 12, 0, 0]))).toEqual([{ startTs: T, endTs: T + 3 * S, fate: "pulled", reach: "none", peak: 12, fill: null }]);
      // What stands when the columns resume is a new run with a new age.
      expect(run(at([0, 1, 2, 30, 31], [12, 12, 12, 0, 12]), printedInHole).map((r) => [r.startTs - T, r.fate])).toEqual([[0, "consumed"], [31 * S, "resting"]]);
      // Never "resting" at a hole any more: only a run open at the live edge rests.
      expect(run(at([0, 1, 2, 30, 31], [12, 12, 12, 0, 0]), printedInHole).some((r) => r.fate === "resting")).toBe(false);
    });
  });

  it("says whether a candle printed in the band anywhere inside a stretch of time", () => {
    const spans = touchingBars([bar(0, 100.5, 101, 100.8), bar(3, 100.2, 101, 100.9)], M, 100, 101);
    expect(coversSpan(spans, T + 30_000, T + 90_000)).toBe(true); // the first bar runs to T+60s
    expect(coversSpan(spans, T + 60_000, T + 180_000)).toBe(false); // between the two
    expect(coversSpan(spans, T + 60_000, T + 180_001)).toBe(true); // reaches the second bar's open
    expect(coversSpan(spans, T - 10_000, T)).toBe(false); // ends at the first bar's open
    expect(coversSpan({ opens: [], ends: [] }, T, T + M)).toBe(false);
  });

  it("a band that empties without price reaching it was pulled", () => {
    const runs = run(tier([12, 12, 0, 0]));
    expect(runs).toEqual([{ startTs: T, endTs: T + 2 * S, fate: "pulled", reach: "none", peak: 12, fill: null }]);
  });

  describe("a band that empties with price at it", () => {
    // Columns carry their window, so the mid is known: the band is row 0, the
    // window is 21 rows around the mid. The bar covering the whole stretch
    // printed in the band (low 100.5).
    const at = (second: number, size: number, midRow: number) => {
      const lo = midRow - 10;
      const bid = new Float64Array(21);
      bid[0 - lo] = size;
      return { ts: T + second * S, lo, hi: midRow + 10, bid, ask: new Float64Array(21) };
    };
    const printed = touchingBars([{ time: T, low: 100.5, high: 110, close: 105 }], M, 100, 101);
    const tiers = (columns: ReturnType<typeof at>[]) => [{ columns, columnMs: S, scanTo: columns.length }];

    it("inside a candle that printed there is consumed where it emptied, not at the candle close", () => {
      const runs = run(tiers([at(0, 12, 4), at(1, 12, 4), at(2, 0, 1), at(3, 0, 1)]), printed);
      expect(runs).toEqual([{ startTs: T, endTs: T + 2 * S, fate: "consumed", reach: "touch", peak: 12, fill: null }]);
      // Gone through in one second: the mid is already below the band. Still eaten.
      const swept = run(tiers([at(0, 12, 4), at(1, 12, 4), at(2, 0, -6)]), printed);
      expect(swept[0]).toMatchObject({ fate: "consumed", reach: "touch", endTs: T + 2 * S });
      // A refill afterwards is a new level, nothing stays dark.
      const again = run(tiers([at(0, 12, 4), at(1, 0, 1), at(2, 12, 1), at(3, 12, 1)]), printed);
      expect(again.map((r) => r.fate)).toEqual(["consumed", "resting"]);
    });

    it("thinning away at the touch counts the same as emptying", () => {
      const dipSeconds = Math.ceil(MAX_DIP_MS / S) + 2;
      const columns = [at(0, 12, 4), ...Array.from({ length: dipSeconds }, (_, i) => at(i + 1, 6, 1))];
      expect(run(tiers(columns), printed)[0]).toMatchObject({ fate: "consumed", reach: "touch" });
    });

    it("is pulled when price was still away, or when no candle printed in the band", () => {
      const away = run(tiers([at(0, 12, 4), at(1, 12, 4), at(2, 0, 4)]), printed);
      expect(away[0]).toMatchObject({ fate: "pulled", reach: "none" });
      const silent = run(tiers([at(0, 12, 4), at(1, 12, 4), at(2, 0, 1)]), NO_BARS);
      expect(silent[0]).toMatchObject({ fate: "pulled", reach: "none" });
    });
  });

  it("the quiet zone raises the floor a level needs to appear, not the one it needs to stay", () => {
    // Appearing: link 20, paint 40. Standing: link 5, paint 10.
    const floors: FloorsAt = (_column, _band, standing) => (standing ? { link: 5, paint: 10 } : { link: 20, paint: 40 });
    const runsOf = (sizes: number[]) => bandRuns(tier(sizes), 0, 1, "bid", floors, NO_BARS);
    // Never big enough to appear.
    expect(runsOf([12, 12, 12, 12])).toEqual([]);
    // Appeared once, then keeps standing at 12 although 12 could not have appeared.
    expect(runsOf([50, 12, 12, 12])).toEqual([{ startTs: T, endTs: T + 4 * S, fate: "resting", reach: "none", peak: 50, fill: null }]);
  });

  it("a level that price wicks into and that holds is one unbroken run, and is consumed only where it empties", () => {
    // Candles print in the band from the first minute on; the band never thins.
    const printed = touchingBars([bar(0, 99, 100.5, 99.5), bar(1, 99, 100.5, 99.5)], M, 100, 101);
    const sizes = Array.from({ length: 70 }, () => 12);
    expect(run(tier(sizes), printed)).toEqual([{ startTs: T, endTs: T + 70 * S, fate: "resting", reach: "none", peak: 12, fill: null }]);
    // It thins to dust at 70 s with price still at it (the mid is row 0): eaten, drawn whole from its start to that second.
    const at = (second: number, size: number) => ({ ts: T + second * S, lo: -10, hi: 10, bid: Float64Array.from({ length: 21 }, (_, i) => (i === 10 ? size : 0)), ask: new Float64Array(21) });
    const eaten = bandRuns([{ columns: [...sizes.map((size, i) => at(i, size)), at(70, 0)], columnMs: S, scanTo: 71 }], 0, 1, "bid", FLOORS, touchingBars([{ time: T, low: 99, high: 100.5, close: 100 }, { time: T + M, low: 99, high: 100.5, close: 100 }], M, 100, 101));
    expect(eaten).toEqual([{ startTs: T, endTs: T + 70 * S, fate: "consumed", reach: "touch", peak: 12, fill: null }]);
  });

  it("reads a band's size through the caller's rule when one is given", () => {
    // Two rows; the first holds 3 and the second 12. Summed, the band is 15 and a level; by its biggest row it is 12, also a level; by its smallest, dust.
    const wide = (second: number) => ({ ts: T + second * S, lo: 0, hi: 1, bid: Float64Array.from([3, 12]), ask: Float64Array.from([0, 0]) });
    const tiers = [{ columns: [wide(0), wide(1)], columnMs: S, scanTo: 2 }];
    expect(bandRuns(tiers, 0, 2, "bid", FLOORS, NO_BARS)).toEqual([{ startTs: T, endTs: T + 2 * S, fate: "resting", reach: "none", peak: 15, fill: null }]);
    expect(bandRuns(tiers, 0, 2, "bid", FLOORS, NO_BARS, (column, band, side) => Math.max(...column[side].slice(band * 2, band * 2 + 2)))).toEqual([{ startTs: T, endTs: T + 2 * S, fate: "resting", reach: "none", peak: 12, fill: null }]);
    expect(bandRuns(tiers, 0, 2, "bid", FLOORS, NO_BARS, (column, band, side) => Math.min(...column[side].slice(band * 2, band * 2 + 2)))).toEqual([]);
  });

  it("dust between the link floor and the paint floor never becomes a run", () => {
    expect(run(tier([6, 7, 8, 6]))).toEqual([]);
  });

  it("a short dip under the paint floor stays in the run; a long one ends it as pulled", () => {
    const short = run(tier([12, 6, 6, 12]));
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({ fate: "resting", peak: 12, endTs: T + 4 * S });
    const dipSeconds = Math.ceil(MAX_DIP_MS / S) + 2;
    const long = run(tier([12, ...Array.from({ length: dipSeconds }, () => 6), 12]));
    expect(long[0]).toMatchObject({ fate: "pulled" });
  });

  it("walks from the deep tier into the fine one as one run", () => {
    const deep = { columns: [col(0, 12), col(10, 14)], columnMs: 10 * S, scanTo: 2 };
    const fine = { columns: [col(20, 13), col(21, 13)], columnMs: S, scanTo: 2 };
    expect(run([deep, fine])).toEqual([{ startTs: T, endTs: T + 22 * S, fate: "resting", reach: "none", peak: 14, fill: null }]);
  });
});

describe("bandRuns with floors that belong to the column", () => {
  it("a column keeps its own yardstick: the same sizes are a level or not by their moment, not by a later one", () => {
    const S = 1_000;
    const col = (second: number, size: number, reference: number) => ({ ts: T + second * S, lo: 0, hi: 0, bid: Float64Array.from([size]), ask: Float64Array.from([0]), reference });
    // 12 BTC printed while the book was thin (reference 10): a level. The same 12 BTC
    // later, while the book was thick (reference 100, link floor 20): not even linked.
    const tiers = [{ columns: [col(0, 12, 10), col(1, 12, 10), col(2, 12, 100), col(3, 12, 100)], columnMs: S, scanTo: 4 }];
    const floors = (c: { reference?: number }) => ({ paint: (c.reference ?? 0) * 0.4, link: (c.reference ?? 0) * 0.2 });
    const runs = bandRuns(tiers, 0, 1, "bid", floors, { opens: [], ends: [] });
    expect(runs).toEqual([{ startTs: T, endTs: T + 2 * S, fate: "pulled", reach: "none", peak: 12, fill: null }]);
  });
});

describe("settleWithLedger", () => {
  const S = 1_000;
  const wall = (over: Partial<LiquidityLevel>): LiquidityLevel => ({
    side: "bid", row: 0, span: 1, start_ts: T, end_ts: T + 55 * S, size: 0, peak: 30, ended_by: "pulled", ratio: 0, chain: 0, fill: 0, eaten: 0, absorbing: false, ...over,
  });
  const run = (over: Partial<RunSegment>): RunSegment => ({ startTs: T, endTs: T + 60 * S, fate: "pulled", reach: "none", peak: 12, fill: null, ...over });

  it("a level that emptied as price arrived is pulled after all when the ledger says the size was cancelled, eaten when it traded", () => {
    // The 81 BTC spot bid of 2026-09-06 22:07: price came to it, 1.2 BTC printed, the rest was withdrawn.
    const touch = run({ fate: "consumed", reach: "touch" });
    expect(settleWithLedger([touch], [wall({ ended_by: "hit", eaten: 0.01 })], 0, 1, "bid")[0]).toMatchObject({ fate: "pulled", fill: 0.01 });
    expect(settleWithLedger([touch], [wall({ ended_by: "moved", eaten: 0.03 })], 0, 1, "bid")[0]).toMatchObject({ fate: "pulled", fill: 0.03 });
    // The 76 BTC perp bid at 79660 three minutes later: three quarters of it traded.
    expect(settleWithLedger([touch], [wall({ ended_by: "filled", eaten: 0.75 })], 0, 1, "bid")[0]).toMatchObject({ fate: "consumed", fill: 0.75 });
    expect(settleWithLedger([touch], [wall({ ended_by: "hit", eaten: 0.2 })], 0, 1, "bid")[0]).toMatchObject({ fate: "consumed", fill: 0.2 });
    // No tracked wall covered it: the chart's own verdict stands.
    expect(settleWithLedger([touch], [wall({ row: 5, eaten: 0 })], 0, 1, "bid")[0]).toMatchObject({ fate: "consumed", fill: null });
  });

  it("a wall that gave a tenth of its peak to trades is consumed even where the candles never reached", () => {
    const [settled] = settleWithLedger([run({})], [wall({ ended_by: "hit", eaten: 0.52 })], 0, 1, "bid");
    expect(settled).toMatchObject({ fate: "consumed", fill: 0.52 });
    expect(CONSUMED_EATEN_SHARE).toBe(0.1);
  });

  it("takes the server at its word when it says filled or partial, and leaves a pulled one pulled", () => {
    expect(settleWithLedger([run({})], [wall({ ended_by: "filled", eaten: 0.05 })], 0, 1, "bid")[0]).toMatchObject({ fate: "consumed" });
    expect(settleWithLedger([run({})], [wall({ ended_by: "partial", eaten: 0.05 })], 0, 1, "bid")[0]).toMatchObject({ fate: "consumed" });
    expect(settleWithLedger([run({})], [wall({ ended_by: "pulled", eaten: 0 })], 0, 1, "bid")[0]).toMatchObject({ fate: "pulled", fill: 0 });
  });

  it("ignores walls of the other side, other rows, still standing, or ended too far from the run", () => {
    const runs = [run({})];
    const untouched = { fate: "pulled", fill: null };
    expect(settleWithLedger(runs, [wall({ side: "ask", eaten: 0.9 })], 0, 1, "bid")[0]).toMatchObject(untouched);
    expect(settleWithLedger(runs, [wall({ row: 3, eaten: 0.9 })], 0, 1, "bid")[0]).toMatchObject(untouched);
    expect(settleWithLedger(runs, [wall({ end_ts: null, eaten: 0.9 })], 0, 1, "bid")[0]).toMatchObject(untouched);
    expect(settleWithLedger(runs, [wall({ end_ts: T + 60 * S + LEDGER_MATCH_MS + 1, eaten: 0.9 })], 0, 1, "bid")[0]).toMatchObject(untouched);
    expect(settleWithLedger(runs, [wall({ start_ts: T + 61 * S, end_ts: T + 70 * S, eaten: 0.9 })], 0, 1, "bid")[0]).toMatchObject(untouched);
    // A wall that ended earlier in the run's life says nothing about the run's end: the eleven-second quote cancelled at 17:37
    // inside a band ETH perp then sold into and emptied at 17:40 (2026-09-11) must not call that band pulled.
    const touch = run({ fate: "consumed", reach: "touch", endTs: T + 240 * S });
    expect(settleWithLedger([touch], [wall({ start_ts: T + 85 * S, end_ts: T + 96 * S, ended_by: "pulled", eaten: 0 })], 0, 1, "bid")[0]).toMatchObject({ fate: "consumed", fill: null });
    expect(settleWithLedger([touch], [wall({ start_ts: T + 85 * S, end_ts: T + 240 * S - LEDGER_MATCH_MS, ended_by: "pulled", eaten: 0 })], 0, 1, "bid")[0]).toMatchObject({ fate: "pulled", fill: 0 });
  });

  it("matches a wall to a run within the window it is given, the minute unless told otherwise", () => {
    const late = wall({ end_ts: T + 60 * S + 90 * S, eaten: 0.9 });
    expect(settleWithLedger([run({})], [late], 0, 1, "bid")[0]).toMatchObject({ fate: "pulled", fill: null });
    expect(settleWithLedger([run({})], [late], 0, 1, "bid", 120 * S)[0]).toMatchObject({ fate: "consumed", fill: 0.9 });
  });

  it("a wall spanning into the band from a lower row still counts, and the largest wall decides", () => {
    const walls = [wall({ row: -1, span: 2, peak: 10, eaten: 0 }), wall({ row: 0, span: 1, peak: 50, eaten: 0.9 })];
    expect(settleWithLedger([run({})], walls, 0, 1, "bid")[0]).toMatchObject({ fate: "consumed", fill: 0.9 });
  });

  it("leaves resting runs alone", () => {
    const [settled] = settleWithLedger([run({ fate: "resting" })], [wall({ eaten: 0.9 })], 0, 1, "bid");
    expect(settled).toMatchObject({ fate: "resting", fill: null });
  });
});

describe("touchingBars and coversAt", () => {
  it("keeps every candle that printed in the band, closed inside or not, and says which covers a moment", () => {
    const bars = [bar(0, 90, 95, 94), bar(1, 96, 101, 98), bar(2, 99, 103, 102), bar(3, 105, 112, 109)];
    const touches = touchingBars(bars, M, 100, 104);
    expect(touches).toEqual({ opens: [T + 1 * M, T + 2 * M], ends: [T + 2 * M, T + 3 * M] });
    expect(coversAt(touches, T + 1 * M)).toBe(true);
    expect(coversAt(touches, T + 2 * M + 30_000)).toBe(true);
    expect(coversAt(touches, T + 3 * M)).toBe(false);
    expect(coversAt(touches, T)).toBe(false);
    expect(coversAt({ opens: [], ends: [] }, T)).toBe(false);
  });
});

describe("atPrice", () => {
  const col = (midRow: number) => ({ ts: T, lo: midRow - 10, hi: midRow + 10, bid: new Float64Array(21), ask: new Float64Array(21) });
  it("a bid band is reached when the mid is at most a row above it, or anywhere below; an ask band the other way round", () => {
    expect(AT_PRICE_ROWS).toBe(1);
    // Band 3 of 2-row bands: rows 6..7.
    expect(atPrice(col(9), 3, 2, "bid")).toBe(false);
    expect(atPrice(col(8), 3, 2, "bid")).toBe(true);
    expect(atPrice(col(7), 3, 2, "bid")).toBe(true);
    expect(atPrice(col(-20), 3, 2, "bid")).toBe(true);
    expect(atPrice(col(4), 3, 2, "ask")).toBe(false);
    expect(atPrice(col(5), 3, 2, "ask")).toBe(true);
    expect(atPrice(col(30), 3, 2, "ask")).toBe(true);
  });
});

describe("inQuietZone", () => {
  // A column whose rows run 100..119: mid row 109.5, so band 27 at one row per band, band 13 at two.
  const column = { ts: T, lo: 100, hi: 119, bid: new Float64Array(20), ask: new Float64Array(20) };

  it("is the bands within the distance of the column's mid, in the column's own band units", () => {
    expect(inQuietZone(column, 109, 1, 3)).toBe(true);
    expect(inQuietZone(column, 112, 1, 3)).toBe(true);
    expect(inQuietZone(column, 113, 1, 3)).toBe(false);
    expect(inQuietZone(column, 106, 1, 3)).toBe(true);
    expect(inQuietZone(column, 105, 1, 3)).toBe(false);
    expect(inQuietZone(column, 54, 2, 1)).toBe(true); // rows 108..109, next to the mid band 54
    expect(inQuietZone(column, 52, 2, 1)).toBe(false);
  });

  it("is off at zero", () => {
    expect(inQuietZone(column, 109, 1, 0)).toBe(false);
  });

  it("raises the floors a run is judged by, band by band", () => {
    const S = 1_000;
    const col = (second: number, size: number) => ({ ts: T + second * S, lo: 0, hi: 9, bid: Float64Array.from({ length: 10 }, (_, i) => (i === 2 ? size : 0)), ask: new Float64Array(10) });
    const tiers = [{ columns: [col(0, 12), col(1, 12)], columnMs: S, scanTo: 2 }];
    // Band 2 sits inside three bands of the mid (4.5): with the quiet zone its floors double and 12 no longer paints.
    const floors = (c: { lo: number; hi: number; ts: number; bid: Float64Array; ask: Float64Array }, band: number) => {
      const k = inQuietZone(c, band, 1, 3) ? 2 : 1;
      return { link: 5 * k, paint: 10 * k };
    };
    expect(bandRuns(tiers, 2, 1, "bid", floors, { opens: [], ends: [] })).toEqual([]);
    expect(bandRuns(tiers, 2, 1, "bid", () => ({ link: 5, paint: 10 }), { opens: [], ends: [] })).toHaveLength(1);
  });
});
