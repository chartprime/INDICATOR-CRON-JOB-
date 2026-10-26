import { describe, expect, it } from "vitest";
import { bandMaxSizes, bandSizes, type LiquidityColumn, type LiquiditySide } from "../../passive-liquidity/liquidityGrid";
import { DEFAULT_EMPTY_BOOK_RULES, createEmptyBookState, emptiestWindow, emptyBookFlashes, emptyBookZones, stepEmptyBook, zoneRows, type EmptyBookRules, type EmptyBookState } from "../emptyBookModel";

const T = 1_700_000_000_000;
const S = 1_000;
const BID = 10_000;
const RULES: EmptyBookRules = { ...DEFAULT_EMPTY_BOOK_RULES, clusterRows: 1, minRows: 3, bandSizes, averageMs: 10 * S, rejoinMs: 3 * S, showMs: 5 * S, flashMs: 2 * S, gapMs: 5 * S, reachBp: 100 };
const JOINED = T + 9 * S;

type Edit = readonly [side: LiquiditySide, lo: number, hi: number, size: number];

/** A book with `size` on every row of its side, `reach` rows each way from the touch, then the edits on top. */
function book(ts: number, bidRow: number, edits: readonly Edit[] = [], reach = 120, size = 10): LiquidityColumn {
  const lo = bidRow - reach;
  const hi = bidRow + 1 + reach;
  const bid = new Float64Array(hi - lo + 1);
  const ask = new Float64Array(hi - lo + 1);
  for (let row = lo; row <= bidRow; row += 1) bid[row - lo] = size;
  for (let row = bidRow + 1; row <= hi; row += 1) ask[row - lo] = size;
  const column = { ts, lo, hi, bid, ask };
  for (const [side, from, to, value] of edits) {
    for (let row = Math.max(lo, from); row <= Math.min(hi, to); row += 1) column[side][row - lo] = value;
  }
  return column;
}

interface Run {
  state: EmptyBookState;
  last: number;
  hold(seconds: number, edits?: readonly Edit[], bidRow?: number, reach?: number, size?: number): void;
}

/** Steps one column a second from T. */
function start(rules: EmptyBookRules = RULES): Run {
  const run: Run = {
    state: createEmptyBookState(rules.clusterRows),
    last: T - S,
    hold(seconds, edits = [], bidRow = BID, reach = 120, size = 10) {
      for (let i = 0; i < seconds; i += 1) {
        run.last += S;
        stepEmptyBook(run.state, book(run.last, bidRow, edits, reach, size), rules, S);
      }
    },
  };
  return run;
}

function thin(side: LiquiditySide, lo: number, hi: number, size = 2): Edit {
  return [side, lo, hi, size];
}

function spans(state: EmptyBookState, side: LiquiditySide): [number, number][] {
  return state.zones[side].map((zone) => [zone.lo, zone.hi]);
}

describe("empty book model", () => {
  it("marks a run of thin rows at least the minimum height tall, once it has lasted the show time", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_013)];
    run.hold(10, edits);
    expect(run.state.zones.ask).toEqual([{ id: 1, group: 1, side: "ask", lo: 10_010, hi: 10_013, since: JOINED, shown: false }]);
    expect(emptyBookZones(run.state)).toEqual([]);
    run.hold(4, edits);
    expect(emptyBookZones(run.state)).toEqual([]);
    run.hold(1, edits);
    expect(emptyBookZones(run.state)).toEqual([{ id: 1, group: 1, side: "ask", lo: 10_010, hi: 10_013, since: JOINED, shown: true }]);
  });

  it("judges nothing until the average has its full window of columns", () => {
    const run = start();
    run.hold(9, [thin("ask", 10_010, 10_013)]);
    expect(run.state.zones.ask).toEqual([]);
    run.hold(1, [thin("ask", 10_010, 10_013)]);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_013]]);
  });

  it("ignores a run of thin rows under the minimum height", () => {
    const short = start();
    short.hold(20, [thin("ask", 10_010, 10_011)]);
    expect(short.state.zones.ask).toEqual([]);
    const enough = start();
    enough.hold(20, [thin("ask", 10_010, 10_012)]);
    expect(spans(enough.state, "ask")).toEqual([[10_010, 10_012]]);
  });

  it("counts a row thin only under 75 % of the typical row", () => {
    const fuller = start();
    fuller.hold(20, [thin("ask", 10_010, 10_013, 8)]);
    expect(fuller.state.zones.ask).toEqual([]);
    const thinner = start();
    thinner.hold(20, [thin("ask", 10_010, 10_013, 7)]);
    expect(spans(thinner.state, "ask")).toEqual([[10_010, 10_013]]);
  });

  it("needs the average of the window under the thin line, not only the size right now", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_013)];
    run.hold(20);
    run.hold(3, edits);
    expect(run.state.zones.ask).toEqual([]);
    run.hold(1, edits);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_013]]);
  });

  it("needs the size right now under the thin line too, not only the average", () => {
    const run = start();
    run.hold(20);
    run.hold(2, [thin("ask", 10_010, 10_013, 0)]);
    run.hold(3, [thin("ask", 10_010, 10_013, 8)]);
    expect(run.state.zones.ask).toEqual([]);
    run.hold(1, [thin("ask", 10_010, 10_013, 7)]);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_013]]);
  });

  it("takes the typical row from the rows near price, whatever rests far away", () => {
    const run = start();
    run.hold(20, [["ask", 10_052, 10_121, 1_000], ["bid", 9_880, 9_949, 1_000], thin("ask", 10_010, 10_013, 7)]);
    expect(run.state.typical).toBe(10);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_013]]);
    expect(run.state.zones.bid).toEqual([]);
  });

  it("smooths the typical row, by a tenth of the way each second", () => {
    const run = start();
    run.hold(20);
    expect(run.state.typical).toBe(10);
    run.hold(1, [], BID, 120, 40);
    expect(run.state.typical).toBeCloseTo(13);
    const slow = createEmptyBookState(1);
    const patient = { ...RULES, gapMs: 30 * S };
    stepEmptyBook(slow, book(T, BID), patient, 10 * S);
    stepEmptyBook(slow, book(T + 10 * S, BID, [], 120, 40), patient, 10 * S);
    expect(slow.typical).toBeCloseTo(40 - 30 * 0.9 ** 10);
  });

  it("sizes a row like the profile at the heatmap's row size: summed on crypto, the biggest order on indexes", () => {
    const pairs: Edit[] = [];
    for (let row = 10_020; row <= 10_027; row += 2) pairs.push(["ask", row, row, 5], ["ask", row + 1, row + 1, 0]);
    const summed = start({ ...RULES, clusterRows: 2, bandSizes });
    summed.hold(20, pairs, BID, 120, 4);
    expect(summed.state.typical).toBe(8);
    expect(spans(summed.state, "ask")).toEqual([[5_010, 5_013]]);
    expect(zoneRows(summed.state.zones.ask[0], 2)).toEqual({ rowLo: 10_020, rowHi: 10_027 });
    const biggest = start({ ...RULES, clusterRows: 2, bandSizes: bandMaxSizes });
    biggest.hold(20, pairs, BID, 120, 4);
    expect(biggest.state.typical).toBe(4);
    expect(biggest.state.zones.ask).toEqual([]);
  });

  it("stays clear of price: a row joins from the sixth row out and leaves when price comes within four rows", () => {
    const run = start();
    const edits = [thin("ask", 10_002, 10_013)];
    run.hold(20, edits);
    expect(spans(run.state, "ask")).toEqual([[10_007, 10_013]]);
    run.hold(1, edits, BID + 1);
    expect(spans(run.state, "ask")).toEqual([[10_007, 10_013]]);
    run.hold(1, edits, BID + 2);
    expect(spans(run.state, "ask")).toEqual([[10_008, 10_013]]);
    expect(emptyBookFlashes(run.state)).toEqual([]);
    run.hold(1, edits, BID);
    expect(spans(run.state, "ask")).toEqual([[10_007, 10_013]]);
  });

  it("trims a zone quietly from its near edge as price reaches it, and ends it under the minimum height", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_014)];
    run.hold(20, edits);
    run.hold(1, edits, BID + 4);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_014]]);
    run.hold(1, edits, BID + 6);
    expect(spans(run.state, "ask")).toEqual([[10_012, 10_014]]);
    expect(run.state.zones.ask[0]).toMatchObject({ id: 1, since: JOINED, shown: true });
    run.hold(1, edits, BID + 7);
    expect(run.state.zones.ask).toEqual([]);
    expect(emptyBookFlashes(run.state)).toEqual([]);
  });

  it("flashes a row that comes back to the refill size, a typical row by default, and takes it off the zone's edge", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_014)];
    run.hold(20, edits);
    run.hold(1, [...edits, ["ask", 10_014, 10_014, 9]]);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_014]]);
    expect(emptyBookFlashes(run.state)).toEqual([]);
    run.hold(1, [...edits, ["ask", 10_014, 10_014, 10]]);
    expect(emptyBookFlashes(run.state)).toEqual([{ side: "ask", row: 10_014, ts: run.last, zone: 1, since: JOINED }]);
    expect(emptyBookZones(run.state)).toEqual([{ id: 1, group: 1, side: "ask", lo: 10_010, hi: 10_013, since: JOINED, shown: true }]);
    const raised = start({ ...RULES, refillMultiple: 1.5 });
    raised.hold(20, edits);
    raised.hold(1, [...edits, ["ask", 10_014, 10_014, 14]]);
    expect(emptyBookFlashes(raised.state)).toEqual([]);
    raised.hold(1, [...edits, ["ask", 10_014, 10_014, 15]]);
    expect(emptyBookFlashes(raised.state)).toEqual([{ side: "ask", row: 10_014, ts: raised.last, zone: 1, since: JOINED }]);
  });

  it("splits a zone refilled in its middle: both parts keep the age and the zone's group, the bigger part keeps the id", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_017)];
    run.hold(20, edits);
    run.hold(1, [...edits, ["ask", 10_013, 10_013, 25]]);
    expect(emptyBookFlashes(run.state)).toEqual([{ side: "ask", row: 10_013, ts: run.last, zone: 1, since: JOINED }]);
    expect(emptyBookZones(run.state)).toEqual([
      { id: 2, group: 1, side: "ask", lo: 10_010, hi: 10_012, since: JOINED, shown: true },
      { id: 1, group: 1, side: "ask", lo: 10_014, hi: 10_017, since: JOINED, shown: true },
    ]);
  });

  it("drops the parts of a split that are under the minimum height", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_014)];
    run.hold(20, edits);
    run.hold(1, [...edits, ["ask", 10_012, 10_012, 25]]);
    expect(emptyBookFlashes(run.state)).toEqual([{ side: "ask", row: 10_012, ts: run.last, zone: 1, since: JOINED }]);
    expect(run.state.zones.ask).toEqual([]);
  });

  it("does not flash a refill in a zone that is not shown yet", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_013)];
    run.hold(10, edits);
    run.hold(1, [...edits, ["ask", 10_013, 10_013, 25]]);
    expect(emptyBookFlashes(run.state)).toEqual([]);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_012]]);
  });

  it("keeps a refilled row out until it has stayed thin for the pause, starting the pause over when the row fills again, then lets it join the same zone again", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_014)];
    run.hold(20, edits);
    run.hold(1, [...edits, ["ask", 10_014, 10_014, 25]]);
    run.hold(2, edits);
    run.hold(1, [...edits, ["ask", 10_014, 10_014, 8]]);
    run.hold(2, edits);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_013]]);
    run.hold(1, edits);
    expect(emptyBookZones(run.state)).toEqual([{ id: 1, group: 1, side: "ask", lo: 10_010, hi: 10_014, since: JOINED, shown: true }]);
  });

  it("drops a flash after its time", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_014)];
    run.hold(20, edits);
    run.hold(1, [...edits, ["ask", 10_014, 10_014, 25]]);
    run.hold(1, edits);
    expect(emptyBookFlashes(run.state)).toHaveLength(1);
    run.hold(1, edits);
    expect(emptyBookFlashes(run.state)).toEqual([]);
  });

  it("flashes a row that fills slowly too, once its average is halfway from the thin line to the refill size", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_014)];
    const filling: Edit[] = [...edits, ["ask", 10_014, 10_014, 9]];
    run.hold(20, edits);
    run.hold(9, filling);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_014]]);
    expect(emptyBookFlashes(run.state)).toEqual([]);
    run.hold(1, filling);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_013]]);
    expect(emptyBookFlashes(run.state)).toEqual([{ side: "ask", row: 10_014, ts: run.last, zone: 1, since: JOINED }]);
  });

  it("joins two zones through a row that turns thin, keeping the older zone's id, group and age", () => {
    const run = start();
    const older = thin("ask", 10_010, 10_012);
    const newer = thin("ask", 10_014, 10_016);
    run.hold(20, [older]);
    run.hold(10, [older, newer]);
    expect(run.state.zones.ask).toEqual([
      { id: 1, group: 1, side: "ask", lo: 10_010, hi: 10_012, since: JOINED, shown: true },
      { id: 2, group: 2, side: "ask", lo: 10_014, hi: 10_016, since: T + 23 * S, shown: true },
    ]);
    run.hold(4, [thin("ask", 10_010, 10_016)]);
    expect(run.state.zones.ask).toEqual([{ id: 1, group: 1, side: "ask", lo: 10_010, hi: 10_016, since: JOINED, shown: true }]);
  });

  it("finds the emptiest window of a zone on the 2-minute average, the one nearest price among equals", () => {
    const run = start();
    run.hold(20, [thin("ask", 10_010, 10_015, 3), ["ask", 10_012, 10_012, 1], ["ask", 10_014, 10_014, 0], thin("bid", 9_985, 9_999)]);
    const ask = run.state.zones.ask[0];
    expect(ask).toMatchObject({ lo: 10_010, hi: 10_015 });
    expect(emptiestWindow(run.state, ask, 1)).toBe(10_014);
    expect(emptiestWindow(run.state, ask, 2)).toBe(10_013);
    expect(emptiestWindow(run.state, ask, 3)).toBe(10_012);
    expect(emptiestWindow(run.state, ask, 6)).toBe(10_010);
    expect(emptiestWindow(run.state, ask, 10)).toBe(10_010);
    const bid = run.state.zones.bid[0];
    expect(bid).toMatchObject({ lo: 9_985, hi: 9_994 });
    expect(emptiestWindow(run.state, bid, 2)).toBe(9_993);
    expect(emptiestWindow(run.state, bid, 1)).toBe(9_994);
  });

  it("keeps each side apart, with the bid side mirrored below price", () => {
    const run = start();
    run.hold(20, [thin("bid", 9_985, 9_999)]);
    expect(emptyBookZones(run.state)).toEqual([{ id: 1, group: 1, side: "bid", lo: 9_985, hi: 9_994, since: JOINED, shown: true }]);
    expect(run.state.zones.ask).toEqual([]);
    run.hold(1, [thin("bid", 9_985, 9_999), ["bid", 9_985, 9_985, 25]]);
    expect(emptyBookFlashes(run.state)).toEqual([{ side: "bid", row: 9_985, ts: run.last, zone: 1, since: JOINED }]);
    expect(spans(run.state, "bid")).toEqual([[9_986, 9_994]]);
  });

  it("looks no further than its reach from price, and lets go of rows that fall out of it", () => {
    const far = start();
    far.hold(20, [thin("ask", 10_103, 10_108)]);
    expect(far.state.zones.ask).toEqual([]);
    const near = start();
    near.hold(20, [thin("ask", 10_095, 10_099)]);
    expect(spans(near.state, "ask")).toEqual([[10_095, 10_099]]);
    near.hold(1, [thin("ask", 10_095, 10_099)], BID - 5);
    expect(near.state.zones.ask).toEqual([]);
  });

  it("with no reach set, looks as far as the book goes and stops at its edge", () => {
    const wide = start({ ...RULES, reachBp: Infinity });
    wide.hold(20, [thin("ask", 10_103, 10_108), thin("ask", 10_115, 10_121), thin("bid", 9_880, 9_885)]);
    expect(spans(wide.state, "ask")).toEqual([[10_103, 10_108], [10_115, 10_121]]);
    expect(spans(wide.state, "bid")).toEqual([[9_880, 9_885]]);
  });

  it("takes the typical row from at least ten rows each side of price, however coarse the rows", () => {
    const coarse = start({ ...RULES, typicalBp: 1 });
    coarse.hold(20, [["bid", 9_998, 10_000, 50], ["ask", 10_001, 10_003, 50]]);
    expect(coarse.state.typical).toBe(10);
  });

  it("waits for a full window on rows it starts watching after price moves, before counting them thin", () => {
    const run = start();
    const edits = [thin("ask", 10_103, 10_107)];
    run.hold(20, edits);
    expect(run.state.zones.ask).toEqual([]);
    run.hold(9, edits, BID + 6);
    expect(run.state.zones.ask).toEqual([]);
    run.hold(1, edits, BID + 6);
    expect(spans(run.state, "ask")).toEqual([[10_103, 10_107]]);
  });

  it("ends a zone whose rows the newest column no longer covers, quietly", () => {
    const run = start();
    const edits = [thin("ask", 10_090, 10_094)];
    run.hold(20, edits);
    expect(spans(run.state, "ask")).toEqual([[10_090, 10_094]]);
    run.hold(1, edits, BID, 80);
    expect(run.state.zones.ask).toEqual([]);
    expect(emptyBookFlashes(run.state)).toEqual([]);
  });

  it("leaves everything as it was on a column with one side of the book missing", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_013)];
    run.hold(20, edits);
    const before = structuredClone(run.state.zones);
    const column = book(run.last + S, BID, edits);
    column.bid.fill(0);
    stepEmptyBook(run.state, column, RULES, S);
    expect(run.state.zones).toEqual(before);
  });

  it("rides through a short gap in the columns: the zones stay, with their age", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_013)];
    run.hold(20, edits);
    run.last += 4 * S;
    run.hold(1, edits);
    expect(emptyBookZones(run.state)).toEqual([{ id: 1, group: 1, side: "ask", lo: 10_010, hi: 10_013, since: JOINED, shown: true }]);
  });

  it("starts over after a long gap in the columns", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_013)];
    run.hold(20, edits);
    expect(emptyBookZones(run.state)).toHaveLength(1);
    run.last += 9 * S;
    run.hold(1, edits);
    expect(run.state.zones.ask).toEqual([]);
    run.hold(4, edits);
    expect(run.state.zones.ask).toEqual([]);
    run.hold(5, edits);
    expect(run.state.zones.ask).toEqual([{ id: 2, group: 2, side: "ask", lo: 10_010, hi: 10_013, since: run.last, shown: false }]);
  });

  it("starts over when the row size changes", () => {
    const run = start();
    const edits = [thin("ask", 10_010, 10_013)];
    run.hold(20, edits);
    stepEmptyBook(run.state, book(run.last + S, BID, edits), { ...RULES, clusterRows: 2 }, S);
    expect(run.state.clusterRows).toBe(2);
    expect(run.state.zones.ask).toEqual([]);
    expect(run.state.samples).toHaveLength(1);
  });

  it("ignores a column that is not newer than the last one", () => {
    const run = start();
    run.hold(20, [thin("ask", 10_010, 10_013)]);
    const before = structuredClone(run.state.zones);
    stepEmptyBook(run.state, book(run.last, BID), RULES, S);
    stepEmptyBook(run.state, book(run.last - S, BID), RULES, S);
    expect(run.state.samples).toHaveLength(10);
    expect(run.state.zones).toEqual(before);
  });

  it("keeps every row's 2-minute average on both sides when price moves far enough to move the rows it keeps", () => {
    const run = start({ ...RULES, reachBp: Infinity });
    const stretch = thin("ask", 10_010, 10_014);
    run.hold(20, [stretch], BID, 300);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_014]]);
    const turned: Edit[] = [stretch, thin("ask", 10_016, 10_018), thin("bid", 9_710, 9_712)];
    run.hold(3, turned, BID - 250, 300);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_014]]);
    expect(spans(run.state, "bid")).toEqual([]);
    run.hold(1, turned, BID - 250, 300);
    expect(spans(run.state, "ask")).toEqual([[10_010, 10_014], [10_016, 10_018]]);
    expect(spans(run.state, "bid")).toEqual([[9_710, 9_712]]);
  });

  it("keeps the rows' averages right when price moves away from them and back within the window", () => {
    const run = start({ ...RULES, reachBp: Infinity });
    run.hold(20, [], BID, 300);
    run.hold(2, [], BID - 250, 300);
    run.hold(20, [thin("ask", 10_250, 10_252)], BID, 300);
    expect(spans(run.state, "ask")).toEqual([[10_250, 10_252]]);
  });
});
