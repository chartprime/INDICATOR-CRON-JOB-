import { describe, expect, it } from "vitest";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { bigBandSize, calibrate, typicalBandSize, typicalMove, typicalWallSize } from "../calibration/calibrateWalls";

const T0 = 1_700_000_000_000;
const S = 1_000;
const COLUMN_MS = 10 * S;
const ROW_WIDTH = 1;
const RULES = { bandRows: 1, wallSize: 4 };
const OPTIONS = { horizonMs: 30 * 60 * S, warmUpMs: 0, sampleMs: 60 * S };

interface Spec {
  /** The book's mid: best bid on `mid - 1`, best ask on `mid`. */
  mid: number;
  /** A bid wall of this much on row 9. */
  wall?: number;
  /** A sell of this much into row 9. */
  hit?: number;
}

function column(ts: number, { mid, wall = 0, hit = 0 }: Spec): LiquidityColumn {
  const bid = new Float64Array(41);
  const ask = new Float64Array(41);
  bid[mid - 1] = 1;
  ask[mid] = 1;
  if (wall > 0) bid[9] = wall;
  return { ts, lo: 0, hi: 40, bid, ask, buy: [], sell: hit > 0 ? [[9, hit]] : [] };
}

/** Columns every ten seconds for `minutes`, each from the spec of its minute. */
function series(minutes: number, spec: (minute: number) => Spec): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  for (let ts = T0; ts < T0 + minutes * 60 * S; ts += COLUMN_MS) out.push(column(ts, spec((ts - T0) / (60 * S))));
  return out;
}

/** A wall of 4 on row 9 from the start, hit for 3 in the first minute, so it is strong at minute ten; price at 20 until then. */
const strongAtTen = (after: (minute: number) => number) =>
  series(60, (minute) => ({ mid: minute < 10 ? 20 : after(minute), wall: 4, hit: minute < 1 ? 3 / 6 : 0 }));

describe("typicalBandSize", () => {
  it("is the median non-empty band over both sides of the sampled columns", () => {
    // Each sampled column has bids of 1 and 4 and an ask of 1: sizes 1, 4, 1 -> median 1.
    expect(typicalBandSize(series(3, () => ({ mid: 20, wall: 4 })), 1, 60 * S)).toBe(1);
    // At two rows a band, rows 8..9 sum to 4 and the mid's rows 18..19 and 20..21 to 1 each.
    expect(typicalBandSize(series(3, () => ({ mid: 20, wall: 4 })), 2, 60 * S)).toBe(1);
  });

  it("scales: the big band is the 95th percentile band and the typical wall the median of each side's biggest band", () => {
    // Per sampled column: bid bands 4 (the wall) and 1 (the best bid), ask band 1. Big band: index floor(0.95 * 8) = 7 of nine sorted -> 4.
    const columns = series(3, () => ({ mid: 20, wall: 4 }));
    expect(bigBandSize(columns, 1, 60 * S)).toBe(4);
    // Biggest per side per column: bid 4, ask 1, three columns -> [1, 1, 1, 4, 4, 4] -> lower median 1.
    expect(typicalWallSize(columns, 1, 60 * S)).toBe(1);
    // Without the wall the biggest on each side is the best level, 1.
    expect(typicalWallSize(series(3, () => ({ mid: 20 })), 1, 60 * S)).toBe(1);
  });

  it("sums a band's rows rather than taking their biggest", () => {
    const only = column(T0, { mid: 20, wall: 4 });
    only.ask.fill(0);
    only.bid[19] = 0;
    only.bid[8] = 2;
    expect(typicalBandSize([only], 2, 60 * S)).toBe(6);
  });
});

describe("typicalMove", () => {
  it("is the median absolute move over the horizon from the sampled columns, as a fraction of price", () => {
    // Mid 20 for thirty minutes, then 22: from minutes 0..29 the move is +10%, later samples have no horizon.
    const columns = series(60, (minute) => ({ mid: minute < 30 ? 20 : 22 }));
    expect(typicalMove(columns, ROW_WIDTH, 30 * 60 * S, 60 * S)).toBeCloseTo(0.1, 6);
  });
});

describe("calibrate", () => {
  it("counts a wall that turned strong as reversed when price was the typical move in its favour by the horizon", () => {
    // Strong at minute ten; at minute forty the mid is 24, four rows above the wall's row at 9.5: +153%, well past any yardstick.
    const result = calibrate(strongAtTen((minute) => (minute < 40 ? 20 : 24)), ROW_WIDTH, COLUMN_MS, RULES, OPTIONS);
    expect([result.walls, result.strong, result.reversed, result.broke, result.flat]).toEqual([1, 1, 1, 0, 0]);
  });

  it("counts it as broken when price went through the wall by then", () => {
    // A dip to 4 over minutes forty to forty-five only, so few samples see it and the yardstick stays at nothing.
    const result = calibrate(strongAtTen((minute) => (minute >= 40 && minute < 46 ? 4 : 20)), ROW_WIDTH, COLUMN_MS, RULES, OPTIONS);
    expect([result.strong, result.reversed, result.broke, result.flat]).toEqual([1, 0, 1, 0]);
  });

  it("takes the wall's price at the middle of its band, so a mid a shade under it reads as through the wall", () => {
    // Two rows a band, two a row on rows 8 and 9: the band's middle is 9, its first row 8. Strong at ten. Over minutes forty to
    // forty-five the wall is gone and the mid sits at 8.5 -- best bid row 7, best ask row 9 -- under the middle and above the first row.
    const columns = series(60, (minute) => ({ mid: 20, hit: minute < 1 ? 3 / 6 : 0 }));
    for (const column of columns) {
      const minute = (column.ts - T0) / (60 * S);
      if (minute >= 40 && minute < 46) {
        column.bid.fill(0);
        column.ask.fill(0);
        column.bid[7] = 1;
        column.ask[9] = 1;
      } else {
        column.bid[8] = 2;
        column.bid[9] = 2;
      }
    }
    const result = calibrate(columns, ROW_WIDTH, COLUMN_MS, { bandRows: 2, wallSize: 4 }, OPTIONS);
    expect([result.strong, result.reversed, result.broke]).toEqual([1, 0, 1]);
  });

  it("does not count a wall that turned strong too late for the horizon to be in the recording", () => {
    // Fifteen minutes only: strong at ten, but minute forty never comes.
    const columns = series(15, (minute) => ({ mid: 20, wall: 4, hit: minute < 1 ? 3 / 6 : 0 }));
    const result = calibrate(columns, ROW_WIDTH, COLUMN_MS, RULES, OPTIONS);
    expect([result.walls, result.strong]).toEqual([1, 0]);
  });

  it("grades with the chart's own clock: strong at the hold after the crossing, not before", () => {
    // The same wall, but the recording stops at minute forty-one: crossed in the first minute it is strong before eleven and its
    // horizon is inside the recording; crossed a minute later it turns strong a minute later and the horizon is not.
    const columns = series(41, (minute) => ({ mid: 20, wall: 4, hit: minute < 1 ? 3 / 6 : 0 }));
    expect(calibrate(columns, ROW_WIDTH, COLUMN_MS, RULES, OPTIONS).strong).toBe(1);
    const late = series(41, (minute) => ({ mid: 20, wall: 4, hit: minute >= 1 && minute < 2 ? 3 / 6 : 0 }));
    expect(calibrate(late, ROW_WIDTH, COLUMN_MS, RULES, OPTIONS).strong).toBe(0);
  });

  it("leaves out walls born inside the warm-up, when the store's first columns under-read", () => {
    const columns = strongAtTen(() => 24);
    expect(calibrate(columns, ROW_WIDTH, COLUMN_MS, RULES, { ...OPTIONS, warmUpMs: 60 * S }).walls).toBe(0);
  });

  it("reads a wall a band wide, so the width and size given are the ones judged", () => {
    const columns = strongAtTen(() => 24);
    expect(calibrate(columns, ROW_WIDTH, COLUMN_MS, { bandRows: 1, wallSize: 5 }, OPTIONS).walls).toBe(0);
    expect(calibrate(columns, ROW_WIDTH, COLUMN_MS, { bandRows: 2, wallSize: 4 }, OPTIONS).walls).toBe(1);
  });

  it("puts the baseline at the share of sampled moments, either side, that moved the typical move in that side's favour", () => {
    // Half the samples move up ten percent and half not at all, so the yardstick is the lower median, nothing. Every sample then
    // counts for the bid side, and the still ones for the ask side too: ninety of a hundred and twenty.
    const columns = series(90, (minute) => ({ mid: minute < 30 ? 20 : 22 }));
    const result = calibrate(columns, ROW_WIDTH, COLUMN_MS, RULES, OPTIONS);
    expect(result.typicalMove).toBe(0);
    expect(result.baseline).toBe(0.75);
  });
});

describe("calibrate closes bars", () => {
  it("ends a wall that was traded into when the mid closes through it at a sample, as the chart does, so it is not strong after", () => {
    // Hit in the first minute and crossed; at minute five the mid moves to 4, under the wall on row 9, and stays: the wall is
    // closed through at the next sample and never reaches its hold.
    const columns = series(60, (minute) => ({ mid: minute < 5 ? 20 : 4, wall: 4, hit: minute < 1 ? 3 / 6 : 0 }));
    const result = calibrate(columns, ROW_WIDTH, COLUMN_MS, RULES, OPTIONS);
    expect([result.walls, result.strong]).toEqual([1, 0]);
  });

  it("does not end a wall the mid stays on the right side of", () => {
    const columns = series(60, (minute) => ({ mid: minute < 5 ? 20 : 11, wall: 4, hit: minute < 1 ? 3 / 6 : 0 }));
    expect(calibrate(columns, ROW_WIDTH, COLUMN_MS, RULES, OPTIONS).strong).toBe(1);
  });
});
