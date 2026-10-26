import { describe, expect, it } from "vitest";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import { DEFAULT_MAX_ORDER_BLOCKS } from "../../classic-order-blocks/orderBlockRules";
import type { PivotInputs } from "../../classic-order-blocks/orderBlockTracker";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { Thresholds } from "../institutionalRules";
import {
  advanceInstitutional,
  bandWantsOf,
  createInstitutionalTrackerState,
  type BookInput,
  type InstitutionalTrackerState,
} from "../institutionalTracker";
import { bandColumnMsFor, bandKeyOf, type BandHistoryGap, type IndicatorBandHistory } from "../../../chart/bandHistory";
import { describeBlock } from "../institutionalRender";

const T0 = 1_700_000_000_000;
const S = 1_000;
const STEP = 60 * S;
const L = 2;
const NONE: PivotInputs = { primaryHigh: null, primaryLow: null, secondaryHigh: null, secondaryLow: null };
const SIZES: Thresholds = { wall: 4, hit: 2, bandRows: 1 };

interface Step {
  h: number;
  l: number;
  c: number;
  pivots?: Partial<PivotInputs>;
}

// The classic fixture: a swing high of 20 on bar 2 (T0 + 120 s), confirmed on bar 4 whose low of 9 is the base
// (T0 + 240 s), closed above on bar 6 (T0 + 360 s). The block is 9 to 10, one row wide at a row width of 1.
const BULL_BREAK: Step[] = [
  { h: 12, l: 10, c: 11 },
  { h: 13, l: 10, c: 12 },
  { h: 20, l: 12, c: 19 },
  { h: 15, l: 11, c: 13 },
  { h: 14, l: 9, c: 12, pivots: { primaryHigh: 20 } },
  { h: 16, l: 10, c: 15 },
  { h: 22, l: 12, c: 21 },
];
const QUIET: Step = { h: 22, l: 20, c: 21 };
const PIVOT = T0 + 120 * S;
const BASE = T0 + 240 * S;
const BREAK = T0 + 360 * S;
const ATTACK_AT = T0 + 200 * S;

function feedBars(
  state: InstitutionalTrackerState,
  steps: readonly Step[],
  book: BookInput | null,
  startIndex = 0,
  sizes = SIZES,
): void {
  steps.forEach((step, i) => {
    advanceInstitutional(
      state,
      {
        time: T0 + (startIndex + i) * STEP,
        high: step.h,
        low: step.l,
        close: step.c,
        volume: 100,
      },
      { ...NONE, ...step.pivots },
      1,
      L,
      book,
      sizes,
    );
  });
}

interface Shape {
  wallUntil?: number;
  attack?: boolean;
  buying?: boolean;
}

/** The book behind the fixture: a wall of 4 on row 9 until `wallUntil`, one hit of 2 at 200 s, buying from the base on. */
function column(
  ts: number,
  { wallUntil = Infinity, attack = true, buying = true }: Shape,
): LiquidityColumn {
  const bid = new Float64Array(31);
  if (ts < wallUntil) bid[9] = 4;
  const out: LiquidityColumn = {
    ts,
    lo: 0,
    hi: 30,
    bid,
    ask: new Float64Array(31),
    buy: [],
    sell: [],
  };
  if (attack && ts === ATTACK_AT) out.sell = [[9, 2]];
  if (buying && ts >= BASE) out.buy = [[10, 5]];
  return out;
}

function history(
  fromS: number,
  toS: number,
  shape: Shape = {},
): LiquidityColumn[] {
  const out: LiquidityColumn[] = [];
  for (let s = fromS; s <= toS; s += 10) out.push(column(T0 + s * S, shape));
  return out;
}

function bookOf(columns: LiquidityColumn[], rowWidth = 1): {
  book: BookInput;
  feed: ColumnFeed;
} {
  const feed: ColumnFeed = {
    epoch: 1,
    deep: null,
    fine: { columns, columnMs: 10 * S },
  };
  const book: BookInput = {
    reader: {
      get feed() {
        return feed;
      },
      rowWidth,
    },
    flashMs: 180 * S,
    barMs: STEP,
  };
  return { book, feed };
}

function append(feed: ColumnFeed, columns: LiquidityColumn[]): void {
  feed.fine.columns = [...feed.fine.columns, ...columns].sort(
    (a, b) => a.ts - b.ts,
  );
}

describe("advanceInstitutional", () => {
  it("mirrors each classic block and grades it strong when the book backs it and the wall still stands", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(-300, 900));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks).toHaveLength(1);
    const [entry] = state.blocks;
    expect(entry.block).toBe(state.classic.activeBlocks[0]);
    expect(entry.verdict).toBe("strong");
    expect(entry.reason).toBeNull();
    expect(entry.evidence).toEqual({
      held: true,
      standing: true,
      peak: 4,
      current: 4,
      hit: 2,
      delta: 1,
    });
  });

  it("holds a block unverifiable for want of a feed while there is no book, and grades it on the first bar the book is there", () => {
    const state = createInstitutionalTrackerState();
    feedBars(state, BULL_BREAK, null);
    expect(state.blocks[0].verdict).toBe("unverifiable");
    expect(state.blocks[0].reason).toBe("feed");
    expect(state.reads).toBe(0);
    const { book } = bookOf(history(-300, 900));
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.reads).toBe(1);
  });

  it("reads every bar until the formation window is in, then grades", () => {
    const state = createInstitutionalTrackerState();
    const { book, feed } = bookOf(history(-300, 300));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].reason).toBe("after");
    const before = state.reads;
    append(feed, history(310, 900));
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.reads).toBe(before + 1);
  });

  it("starts over on a window before the reach only when older columns arrive, not as new ones do", () => {
    const state = createInstitutionalTrackerState();
    const { book, feed } = bookOf(history(200, 420));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].reason).toBe("before");
    const before = state.reads;
    append(feed, history(430, 440));
    feedBars(state, [QUIET, QUIET], book, BULL_BREAK.length);
    expect(state.reads).toBe(before);
    append(feed, history(-300, 190));
    feedBars(state, [QUIET], book, BULL_BREAK.length + 2);
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.reads).toBe(before + 1);
  });

  it("grades through a hole with the columns it has, asks the recording for the whole window meanwhile, and reads again from the start once columns arrive inside the hole", () => {
    const state = createInstitutionalTrackerState();
    const { book, feed } = bookOf(
      history(-300, 900).filter(
        (c) => c.ts <= T0 + 150 * S || c.ts >= T0 + 230 * S,
      ),
    );
    feedBars(state, BULL_BREAK, book);
    const [entry] = state.blocks;
    expect(entry.reason).toBeNull();
    expect(entry.verdict).not.toBe("unverifiable");
    // The attack at 200 s fell in the hole: nothing traded is seen, the wall still is.
    expect(entry.evidence).toMatchObject({ held: true, standing: true, hit: 0 });
    expect(entry.gap).toEqual({ from: T0 + 150 * S, to: T0 + 230 * S });
    expect(bandWantsOf(state)).toEqual([{ key: bandKeyOf(PIVOT - 180 * S, BREAK + STEP, 9, 10), fromTs: PIVOT - 180 * S, toTs: BREAK + STEP, priceLo: 9, priceHi: 10, columnMs: bandColumnMsFor(1) }]);
    const read = entry.read;
    append(feed, history(910, 1000));
    feedBars(state, [QUIET, QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0].read).toBe(read);
    append(feed, history(160, 220));
    feedBars(state, [QUIET], book, BULL_BREAK.length + 2);
    expect(state.blocks[0].read).not.toBe(read);
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.blocks[0].evidence).toMatchObject({ hit: 2 });
    expect(state.blocks[0].gap).toBeNull();
    expect(bandWantsOf(state)).toEqual([]);
  });

  it("keeps a zone's grade and its read across a rebuild of the columns, carrying on from where it was", () => {
    const state = createInstitutionalTrackerState();
    const { book, feed } = bookOf(history(-300, 900));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].verdict).toBe("strong");
    const read = state.blocks[0].read;
    // The rebuilt columns start after the zone's whole window: nothing of the swing is left to read.
    feed.fine = { columns: history(910, 1200), columnMs: 10 * S };
    feed.epoch = 2;
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0].read).toBe(read);
    expect(state.blocks[0].reason).toBeNull();
    expect(state.blocks[0].verdict).toBe("strong");
  });

  it("starts over when the rows change width, since they no longer mean what they did", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(-300, 900));
    feedBars(state, BULL_BREAK, book);
    const read = state.blocks[0].read;
    (book.reader as { rowWidth: number }).rowWidth = 2;
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0].read).not.toBe(read);
  });

  it("re-reads a graded zone once per closed bar, so its pace is the chart's timeframe", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(-300, 1200));
    feedBars(state, BULL_BREAK, book);
    const graded = state.reads;
    feedBars(state, [QUIET, QUIET, QUIET], book, BULL_BREAK.length);
    expect(state.reads).toBe(graded + 3);
  });

  it("paces itself by the chart's own bar interval, so a slower chart re-reads on its bars and not on the minutes between them", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(-300, 1200));
    const hourly: BookInput = { ...book, barMs: 60 * STEP };
    feedBars(state, BULL_BREAK, book);
    const graded = state.reads;
    const quiet = (bars: number) =>
      advanceInstitutional(
        state,
        { time: T0 + bars * STEP, high: 22, low: 20, close: 21, volume: 100 },
        NONE,
        1,
        L,
        hourly,
        SIZES,
      );
    // A minute past the last read is not an hourly bar's worth of time.
    quiet(BULL_BREAK.length);
    expect(state.reads).toBe(graded);
    quiet(BULL_BREAK.length + 60);
    expect(state.reads).toBe(graded + 1);
  });

  it("turns a strong zone weak once its wall has gone", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(-300, 1200, { wallUntil: T0 + 500 * S }));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].verdict).toBe("strong");
    feedBars(
      state,
      Array.from({ length: 2 }, () => QUIET),
      book,
      BULL_BREAK.length,
    );
    expect(state.blocks[0].verdict).toBe("weak");
    expect(state.blocks[0].evidence).toMatchObject({
      held: true,
      standing: false,
      hit: 2,
    });
  });

  it("rejects a wall that stood, was never hit enough, and left", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(
      history(-300, 1200, { wallUntil: T0 + 500 * S, attack: false }),
    );
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].verdict).toBe("weak");
    feedBars(
      state,
      Array.from({ length: 2 }, () => QUIET),
      book,
      BULL_BREAK.length,
    );
    expect(state.blocks[0].verdict).toBe("rejected");
  });

  it("stops reading a zone once it is mitigated, keeping its last grade", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(-300, 1200, { wallUntil: T0 + 500 * S }));
    feedBars(state, [...BULL_BREAK, { h: 22, l: 8.5, c: 8.8 }], book);
    expect(state.blocks[0].block.mitigatedTime).toBe(BREAK + STEP);
    const graded = state.reads;
    feedBars(
      state,
      Array.from({ length: 3 }, () => QUIET),
      book,
      BULL_BREAK.length + 1,
    );
    expect(state.reads).toBe(graded);
    expect(state.blocks[0].verdict).toBe("strong");
  });

  it("grades strong once enough has traded into the zone after formation: nothing at formation, enough when price came back", () => {
    const state = createInstitutionalTrackerState();
    const retestAt = BREAK + 3 * STEP;
    const columns = history(-300, 1200, { attack: false }).map((c) =>
      c.ts === retestAt ? { ...c, sell: [[9, 2] as [number, number]] } : c,
    );
    const { book } = bookOf(columns);
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].verdict).toBe("weak");
    expect(state.blocks[0].evidence).toMatchObject({ hit: 0 });
    feedBars(
      state,
      Array.from({ length: 3 }, () => QUIET),
      book,
      BULL_BREAK.length,
    );
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.blocks[0].evidence).toMatchObject({ hit: 2 });
  });

  it("starts the delta leg at the base bar, so the selling into the base does not count against the block", () => {
    const state = createInstitutionalTrackerState();
    const columns = history(-300, 900).map((c) =>
      c.ts >= PIVOT && c.ts < BASE
        ? { ...c, sell: [...(c.sell ?? []), [15, 50] as [number, number]] }
        : c,
    );
    const { book } = bookOf(columns);
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.blocks[0].evidence?.delta).toBeCloseTo(1, 6);
  });

  it("shows mitigation through the shared block, on a close through the zone and not on a wick or a close inside it", () => {
    const state = createInstitutionalTrackerState();
    feedBars(
      state,
      [...BULL_BREAK, { h: 22, l: 8.5, c: 21 }, { h: 22, l: 8.5, c: 9.5 }],
      null,
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].block.mitigatedTime).toBeNull();
    feedBars(state, [{ h: 22, l: 8.5, c: 8.8 }], null, BULL_BREAK.length + 2);
    expect(state.blocks[0].block.mitigatedTime).toBe(
      T0 + (BULL_BREAK.length + 2) * STEP,
    );
  });

  it("forgets a block the classic tracker has dropped past its cap", () => {
    const state = createInstitutionalTrackerState();
    // Each cycle is the same shape a whole point higher, so every break reads a base of its own and forms a block.
    for (let cycle = 0; cycle <= DEFAULT_MAX_ORDER_BLOCKS; cycle += 1)
      feedBars(
        state,
        BULL_BREAK.map((step) => ({
          ...step,
          h: step.h + cycle,
          l: step.l + cycle,
          c: step.c + cycle,
        })),
        null,
        cycle * BULL_BREAK.length,
      );
    expect(state.classic.activeBlocks).toHaveLength(DEFAULT_MAX_ORDER_BLOCKS);
    expect(state.blocks).toHaveLength(DEFAULT_MAX_ORDER_BLOCKS);
    expect(state.graded.size).toBe(DEFAULT_MAX_ORDER_BLOCKS);
  });
});

describe("advanceInstitutional -- grading from the host's recording", () => {
  const FROM = PIVOT - 180 * S;
  const TO = BREAK + STEP;
  const KEY = bandKeyOf(FROM, TO, 9, 10);

  function recording(columns: LiquidityColumn[], gaps: BandHistoryGap[] = []): IndicatorBandHistory {
    return {
      version: 1,
      older: () => false,
      feedFor: (key) =>
        key === KEY
          ? { feed: { epoch: 1, deep: null, fine: { columns, columnMs: 10 * S } }, rowWidth: 1, gaps }
          : null,
    };
  }

  it("asks for the block's window when the page's columns do not reach it, and does not ask for one they grade", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].reason).toBe("before");
    expect(bandWantsOf(state)).toEqual([
      { key: KEY, fromTs: FROM, toTs: TO, priceLo: 9, priceHi: 10, columnMs: bandColumnMsFor(1) },
    ]);
    const graded = createInstitutionalTrackerState();
    feedBars(graded, BULL_BREAK, bookOf(history(-300, 900)).book);
    expect(graded.blocks[0].verdict).toBe("strong");
    expect(bandWantsOf(graded)).toEqual([]);
  });

  it("grades the block from the recording once it answers, keeps asking so a replay finds the answer again, then carries on from the page's columns", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    book.bands = recording(history(-60, 410));
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    const [entry] = state.blocks;
    expect(entry.verdict).toBe("strong");
    expect(entry.historical).toBe(true);
    expect(entry.gaps).toEqual([]);
    expect(entry.evidence).toEqual({ held: true, standing: true, peak: 4, current: 4, hit: 2, delta: 1 });
    expect(bandWantsOf(state)).toHaveLength(1);
    const reads = state.reads;
    feedBars(state, [QUIET], book, BULL_BREAK.length + 1);
    expect(state.reads).toBe(reads + 1);
    expect(entry.read.lastTs).toBe(T0 + 530 * S);
    expect(entry.verdict).toBe("strong");
  });

  it("grades through the recording's holes on the columns around them, keeping the gaps", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    const gaps = [{ from: T0 + 250 * S, to: T0 + 280 * S }];
    book.bands = recording(history(-60, 410, { wallUntil: T0 + 250 * S, buying: false }), gaps);
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    const [entry] = state.blocks;
    expect(entry.historical).toBe(true);
    expect(entry.gaps).toBe(gaps);
    expect(entry.evidence).toMatchObject({ held: true, standing: false, hit: 2 });
    expect(entry.verdict).toBe("weak");
  });

  it("grades a block from what the recording has however much of its window is missing, never reading the missing stretch as an empty book", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    // The recording's answer fills its holes with empty columns; a hole from 200 s to the window's end must not read as the wall leaving.
    // The last column recorded, at 200 s, is the one the attack printed in.
    const gaps = [{ from: T0 + 200 * S, to: T0 + 420 * S }];
    book.bands = recording(history(-60, 420, { wallUntil: T0 + 250 * S, buying: false }), gaps);
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    const [entry] = state.blocks;
    expect(entry).toMatchObject({ verdict: "weak", reason: null, historical: true, gaps });
    expect(entry.evidence).toEqual({ held: true, standing: true, peak: 4, current: 4, hit: 2, delta: 0 });
    // The page's own columns carry on from the recording's last column, across the hole, and keep the grade.
    feedBars(state, [QUIET], book, BULL_BREAK.length + 1);
    expect(state.blocks[0]).toMatchObject({ verdict: "weak", reason: null, historical: true, gap: null });
    expect(state.blocks[0].evidence).toMatchObject({ held: true, standing: true, current: 4 });
    expect(state.blocks[0].read.lastTs).toBe(T0 + 530 * S);
  });

  it("keeps a recording-graded block's grade when the page has no columns after the recording's last one", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf([]);
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].reason).toBe("before");
    const gaps = [{ from: T0 + 300 * S, to: T0 + 420 * S }];
    book.bands = recording(history(-60, 420), gaps);
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0]).toMatchObject({ verdict: "strong", reason: null, historical: true });
    feedBars(state, [QUIET], book, BULL_BREAK.length + 1);
    expect(state.blocks[0]).toMatchObject({ verdict: "strong", reason: null, historical: true });
  });

  it("keeps a block unverifiable when the recording has nothing of its window, and does not read it again", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    const gaps = [{ from: T0 + 100 * S, to: T0 + 420 * S }];
    book.bands = recording(history(-60, 420, { wallUntil: T0 + 100 * S, attack: false, buying: false }), gaps);
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    const [entry] = state.blocks;
    expect(entry).toMatchObject({ verdict: "unverifiable", reason: "hole", gap: gaps[0], historical: true, gaps, evidence: null });
    const reads = state.reads;
    feedBars(state, [QUIET], book, BULL_BREAK.length + 1);
    expect(state.reads).toBe(reads);
    expect(state.blocks[0]).toMatchObject({ verdict: "unverifiable", reason: "hole" });
  });

  it("asks nothing for a block taller than one answer can carry, and leaves it as the page found it", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900), 1 / 300);
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].reason).toBe("before");
    expect(bandWantsOf(state)).toEqual([]);
  });

  it("grades a block that was mitigated before the recording answered", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    feedBars(state, [{ h: 22, l: 8.5, c: 8.8 }], book, BULL_BREAK.length);
    expect(state.blocks[0].block.mitigatedTime).not.toBeNull();
    expect(state.blocks[0].reason).toBe("before");
    book.bands = recording(history(-60, 410));
    feedBars(state, [QUIET], book, BULL_BREAK.length + 1);
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.blocks[0].historical).toBe(true);
  });

  it("leaves a recording-graded block as it is when the page's rows are a different width", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    book.bands = recording(history(-60, 410));
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    const [entry] = state.blocks;
    const { read, verdict } = entry;
    const reads = state.reads;
    (book.reader as { rowWidth: number }).rowWidth = 2;
    feedBars(state, [QUIET], book, BULL_BREAK.length + 1);
    expect(state.reads).toBe(reads);
    expect(entry.read).toBe(read);
    expect(entry.verdict).toBe(verdict);
  });

  it("asks nothing for a block the page is still reading, and asks for one the page has a hole in, grading it through the hole meanwhile and from the recording once it answers", () => {
    const reading = createInstitutionalTrackerState();
    feedBars(reading, BULL_BREAK, bookOf(history(-300, 300)).book);
    expect(reading.blocks[0].reason).toBe("after");
    expect(bandWantsOf(reading)).toEqual([]);
    const holed = createInstitutionalTrackerState();
    const { book } = bookOf(history(-300, 900).filter((c) => c.ts <= T0 + 150 * S || c.ts >= T0 + 230 * S));
    feedBars(holed, BULL_BREAK, book);
    expect(holed.blocks[0].reason).toBeNull();
    expect(holed.blocks[0].historical).toBe(false);
    expect(bandWantsOf(holed)).toEqual([{ key: KEY, fromTs: FROM, toTs: TO, priceLo: 9, priceHi: 10, columnMs: bandColumnMsFor(1) }]);
    const gaps = [{ from: T0 + 150 * S, to: T0 + 190 * S }];
    book.bands = recording(history(-60, 410, { wallUntil: T0 + 150 * S, attack: false }).map((c) => (c.ts >= T0 + 230 * S ? { ...c, bid: column(c.ts, {}).bid } : c)), gaps);
    feedBars(holed, [QUIET], book, BULL_BREAK.length);
    expect(holed.blocks[0].historical).toBe(true);
    expect(holed.blocks[0].gaps).toBe(gaps);
    expect(holed.blocks[0].evidence).toMatchObject({ hit: 0 });
    expect(holed.blocks[0].verdict).not.toBe("unverifiable");
  });

  it("lets the page's own columns grade the block when they reach it, dropping the ask, even after an answer the read could not grade", () => {
    const state = createInstitutionalTrackerState();
    const { book, feed } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    expect(bandWantsOf(state)).toHaveLength(1);
    book.bands = recording([]);
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0].reason).toBe("before");
    expect(state.blocks[0].historical).toBe(false);
    append(feed, history(-300, 490));
    feedBars(state, [QUIET], book, BULL_BREAK.length + 1);
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.blocks[0].historical).toBe(false);
    expect(bandWantsOf(state)).toEqual([]);
  });

  it("says a block is older than the recording when the host no longer holds its window, and still reads it once the page's columns reach it", () => {
    const state = createInstitutionalTrackerState();
    const { book, feed } = bookOf(history(200, 420));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0].reason).toBe("before");
    book.bands = { version: 2, feedFor: () => null, older: (key) => key !== KEY };
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0].reason).toBe("before");
    book.bands = { version: 3, feedFor: () => null, older: (key) => key === KEY };
    const reads = state.reads;
    feedBars(state, [QUIET], book, BULL_BREAK.length + 1);
    expect(state.blocks[0]).toMatchObject({ verdict: "unverifiable", reason: "older", historical: false, evidence: null });
    expect(bandWantsOf(state)).toHaveLength(1);
    expect(state.reads).toBe(reads);
    append(feed, history(430, 440));
    feedBars(state, [QUIET], book, BULL_BREAK.length + 2);
    expect(state.blocks[0].reason).toBe("older");
    expect(state.reads).toBe(reads);
    append(feed, history(-300, 190));
    feedBars(state, [QUIET], book, BULL_BREAK.length + 3);
    expect(state.blocks[0].verdict).toBe("strong");
    expect(state.blocks[0].reason).toBeNull();
  });

  it("stays unverified while the recording has not answered, asking no more than once per bar", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    book.bands = recording([]);
    (book.bands as { feedFor: unknown }).feedFor = () => null;
    const reads = state.reads;
    feedBars(state, [QUIET, QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0].reason).toBe("before");
    expect(state.blocks[0].historical).toBe(false);
    expect(state.reads).toBe(reads);
  });
});

// 2026-10-14, owner's call on PR #54: a recording gap can confirm a zone, never reject it. Grading through gaps keeps
// outages from leaving zones ungraded, but a gap counts no wall time and no traded volume, so a Rejected read on a
// window the book did not wholly record cannot be told from a wall that stood through the gap.
describe("advanceInstitutional -- a recording gap confirms, never rejects", () => {
  /** A wall from 30 s on (so its age starts inside the lookback), no attack, buying from the base; minus a hole. */
  function walled(fromS: number, toS: number, hole: [number, number] | null): LiquidityColumn[] {
    return history(fromS, toS, { attack: false })
      .map((c) => (c.ts < T0 + 30 * S ? { ...c, bid: new Float64Array(31) } : c))
      .filter((c) => hole === null || c.ts <= T0 + hole[0] * S || c.ts >= T0 + hole[1] * S);
  }

  it("holds a zone the gap would reject unverified, names the gap, asks the recording, and grades it once the book it did record confirms the wall", () => {
    // The wall stands 120 s before a 130 s hole and 140 s after it to the window's end: neither side reaches the
    // 180 s flash age, so the book read alone says no wall stood here.
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(walled(-300, 900, [150, 280]));
    feedBars(state, BULL_BREAK, book);
    const [entry] = state.blocks;
    expect(entry).toMatchObject({ verdict: "unverifiable", reason: "gap", evidence: null, gap: { from: T0 + 150 * S, to: T0 + 280 * S } });
    expect(describeBlock(entry, "")).toBe("Unverified OB · recording gap 22:15–22:18 UTC");
    expect(bandWantsOf(state)).toHaveLength(1);
    // Read on: 180 s after the hole the wall has stood the flash age on recorded columns alone, and that confirms it.
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    expect(state.blocks[0]).toMatchObject({ verdict: "weak", reason: null });
    expect(state.blocks[0].evidence).toMatchObject({ held: true, standing: true });
  });

  it("rejects as before when the window was recorded whole", () => {
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(walled(-300, 900, null).map((c) => (c.ts >= T0 + 150 * S ? { ...c, bid: new Float64Array(31) } : c)));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0]).toMatchObject({ verdict: "rejected", reason: null, gap: null });
    expect(describeBlock(state.blocks[0], "")).toContain("Rejected OB · no wall stood here");
  });

  it("keeps the grade a gap cannot have caused: a zone the recorded book confirms is graded through the gap", () => {
    // The wall stands from before the window through a hole: held on the columns before it, so the gap only confirms.
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(-300, 900, { attack: false }).filter((c) => c.ts <= T0 + 150 * S || c.ts >= T0 + 280 * S));
    feedBars(state, BULL_BREAK, book);
    expect(state.blocks[0]).toMatchObject({ verdict: "weak", reason: null, gap: { from: T0 + 150 * S, to: T0 + 280 * S } });
  });

  it("holds a recording-graded zone unverified when the recording missed the start of its window and reads no wall", () => {
    const FROM = PIVOT - 180 * S;
    const KEY = bandKeyOf(FROM, BREAK + STEP, 9, 10);
    const state = createInstitutionalTrackerState();
    const { book } = bookOf(history(500, 900));
    feedBars(state, BULL_BREAK, book);
    const gaps = [{ from: T0 - 60 * S, to: T0 + 250 * S }];
    const columns = history(-60, 420, { wallUntil: T0, attack: false });
    book.bands = { version: 1, older: () => false, feedFor: (key) => (key === KEY ? { feed: { epoch: 1, deep: null, fine: { columns, columnMs: 10 * S } }, rowWidth: 1, gaps } : null) };
    feedBars(state, [QUIET], book, BULL_BREAK.length);
    const [entry] = state.blocks;
    expect(entry).toMatchObject({ verdict: "unverifiable", reason: "gap", historical: true, gaps, gap: { from: PIVOT, to: T0 + 260 * S } });
    expect(describeBlock(entry, "")).toBe("Unverified OB · recording gap 22:15–22:17 UTC");
  });
});
