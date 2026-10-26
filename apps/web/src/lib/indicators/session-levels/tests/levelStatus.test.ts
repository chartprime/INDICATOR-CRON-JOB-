import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import type { LevelRules } from "../levelReader";
import { advanceLevel, applyRecording, createLevelStatus, needsRecording, type LevelStatus } from "../levelStatus";
import type { WindowReading } from "../levelWindow";
import type { Level } from "../sessionLevelsRules";
import type { OpeningRange } from "../sessionRanges";

const T0 = 1_700_000_000_000;
const S = 1_000;
const MINUTE = 60 * S;
const RULES: LevelRules = { bandRows: 4, floor: 75, share: 2 };
// An opening range that closed at T0 - 1 min with its high at 100: the level under test, band rows 100..103, far edge 104.
const range: OpeningRange = { kind: "orb", sessionId: "nyam", windowMin: 5, startMs: T0 - 5 * MINUTE, endMs: T0 - MINUTE, high: 100, low: 90, highTouchMs: null, lowTouchMs: null };
const HIGH: Level = { range, side: "high", price: 100, touchMs: null };

interface Spec {
  ask?: Record<number, number>;
  buy?: [number, number][];
  mid?: number;
}

/** Ten-second columns over rows 80..130 from `from`, `count` of them; `at(i)` gives column i its asks, buys and mid (default 97, under the level). */
function feedOf(from: number, count: number, at: (index: number) => Spec): ColumnFeed {
  const columns: LiquidityColumn[] = [];
  for (let i = 0; i < count; i += 1) {
    const spec = at(i);
    const ask = new Float64Array(51);
    const bid = new Float64Array(51);
    const mid = spec.mid ?? 97;
    bid[mid - 80] = 5;
    ask[mid + 1 - 80] = 5;
    for (const [row, size] of Object.entries(spec.ask ?? {})) if (Number(row) > mid) ask[Number(row) - 80] = size;
    const ts = from + i * 10 * S;
    columns.push({ ts, lo: 80, hi: 130, ask, bid, prints: [], buy: spec.buy ?? [], sell: [] });
  }
  return { epoch: 1, deep: null, fine: { columns, columnMs: 10 * S } };
}

function bar(ts_open: number, high: number, low: number): BarFrame {
  return {
    type: "bar", symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", interval_ms: MINUTE, ts_open,
    open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 0, trade_count: 1, closed: true,
  } as BarFrame;
}

/** Bars from T0, one a minute, `count` of them, all under the level (99..96), but for the minutes in `touching`, which reach it (100..96). */
function bars(count: number, touching: number[] = []): BarFrame[] {
  return Array.from({ length: count }, (_, i) => bar(T0 + i * MINUTE, touching.includes(i) ? 100 : 99, 96));
}

function run(feed: ColumnFeed, all: BarFrame[], status = createLevelStatus()): LevelStatus {
  for (const b of all) advanceLevel(status, HIGH, b, feed, 1, RULES, all);
  return status;
}

describe("advanceLevel", () => {
  it("reads the resting size and its peak from the bar's last column while the level is untested", () => {
    const feed = feedOf(T0, 30, (i) => ({ ask: { 101: i < 10 ? 300 : 120 } }));
    const status = run(feed, bars(3));
    expect(status).toMatchObject({ resting: 120, peak: 300, window: null });
  });

  it("opens a window on the touch, at the column the mid reached the band, reads Testing while the columns have not reached its end, and judges it once they have", () => {
    const feed = feedOf(T0, 12, (i) => ({ ask: { 101: 200 }, mid: i >= 8 ? 99 : 97 }));
    const status = run(feed, bars(2, [1]));
    expect(status.window).toMatchObject({ open: true, verdict: null, from: T0 + MINUTE + 20 * S });
    const later = feedOf(T0, 60, (i) => ({ ask: { 101: 200 }, mid: i >= 8 ? 99 : 97 }));
    advanceLevel(status, HIGH, bar(T0 + 2 * MINUTE, 99, 96), later, 1, RULES, bars(3, [1]));
    expect(status.window).toMatchObject({ open: false, verdict: "held" });
  });

  it("judges the first touch alone, the trader's rule: a held level is done, a later touch opens nothing", () => {
    const feed = feedOf(T0, 120, () => ({ ask: { 101: 200 } }));
    const status = run(feed, bars(9, [1, 7]));
    expect(status.window).toMatchObject({ verdict: "held", from: T0 + MINUTE });
  });

  it("does not open another window on a touching bar inside the window already judged", () => {
    const feed = feedOf(T0, 120, () => ({ ask: { 101: 200 } }));
    const status = run(feed, bars(6, [1, 2, 3]));
    expect(status.window).toMatchObject({ from: T0 + MINUTE });
  });

  it("ends the level on a sweep and reads nothing after", () => {
    const feed = feedOf(T0, 120, () => ({ ask: { 101: 200 } }));
    const all = [bar(T0, 99, 96), bar(T0 + MINUTE, 105, 96), bar(T0 + 2 * MINUTE, 99, 96), bar(T0 + 8 * MINUTE, 100, 96)];
    const status = run(feed, all);
    expect(status.window).toMatchObject({ verdict: "swept", from: T0 + MINUTE });
  });

  it("reads absorbed on the first touch and is done there too", () => {
    const feed = feedOf(T0, 120, (i) => ({ ask: { 101: 40 }, buy: i === 8 ? [[101, 100]] : [] }));
    const status = run(feed, bars(9, [1, 7]));
    expect(status.window).toMatchObject({ verdict: "absorbed", from: T0 + MINUTE, facts: { into: 100, before: 40 } });
  });

  it("leaves a level alone before its range has closed, and one with no columns at all", () => {
    const feed = feedOf(T0, 120, () => ({ ask: { 101: 200 } }));
    const status = createLevelStatus();
    advanceLevel(status, HIGH, bar(T0 - MINUTE, 100, 96), feed, 1, RULES, []);
    expect(status).toMatchObject({ window: null, resting: 0 });
    const empty: ColumnFeed = { epoch: 1, deep: null, fine: { columns: [], columnMs: 10 * S } };
    advanceLevel(status, HIGH, bar(T0, 99, 96), empty, 1, RULES, []);
    expect(status).toMatchObject({ window: null, resting: 0 });
  });

  it("reads a no-book window again on every bar, the same first touch, until the book reaches it: a snapshot arrives in chunks, oldest first", () => {
    // A snapshot lands in chunks, oldest first, and only the first chunk bumps the epoch.
    const all = feedOf(T0, 60, () => ({ ask: { 101: 200 } })).fine.columns;
    const feed: ColumnFeed = { epoch: 1, deep: { columns: all.slice(0, 3), columnMs: 10 * S }, fine: { columns: all.slice(54), columnMs: 10 * S } };
    const status = run(feed, bars(9, [1]));
    expect(status.window).toMatchObject({ verdict: null, noBook: true, open: false, from: T0 + MINUTE });
    feed.deep = { columns: all.slice(0, 54), columnMs: 10 * S };
    advanceLevel(status, HIGH, bar(T0 + 9 * MINUTE, 99, 96), feed, 1, RULES, bars(10, [1]));
    expect(status.window).toMatchObject({ verdict: "held", noBook: false, from: T0 + MINUTE });
  });

  it("reads a partial-data window again on every bar too, until the book holds enough of what the candles say traded", () => {
    // 90 in the book against 300 by the candles: 30% caught.
    const all = feedOf(T0, 60, () => ({ ask: { 101: 200 } })).fine.columns.map((column) => ({ ...column, sell: [[90, 10]] as const }));
    const feed: ColumnFeed = { epoch: 1, deep: { columns: all.slice(0, 15), columnMs: 10 * S }, fine: { columns: all.slice(54), columnMs: 10 * S } };
    const traded = (count: number) => bars(count, [1]).map((b) => ({ ...b, volume: 60 }));
    const status = run(feed, traded(9));
    expect(status.window).toMatchObject({ verdict: null, partial: true, facts: { captured: 90, expected: 300 } });
    feed.deep = { columns: all.slice(0, 54), columnMs: 10 * S };
    advanceLevel(status, HIGH, bar(T0 + 9 * MINUTE, 99, 96), feed, 1, RULES, traded(10));
    expect(status.window).toMatchObject({ verdict: "held", partial: false, facts: { captured: 300, expected: 300 } });
  });

  it("keeps a decided verdict: a later bar reads nothing again, whatever the book does", () => {
    const feed = feedOf(T0, 60, () => ({ ask: { 101: 200 } }));
    const status = run(feed, bars(9, [1]));
    expect(status.window).toMatchObject({ verdict: "held" });
    const swept = feedOf(T0, 60, () => ({ ask: { 101: 200 }, mid: 106 }));
    advanceLevel(status, HIGH, bar(T0 + 9 * MINUTE, 99, 96), swept, 1, RULES, bars(10, [1]));
    expect(status.window).toMatchObject({ verdict: "held" });
  });

  it("closes a window over columns that never came as no book, and a later touch does not replace the first", () => {
    const late = feedOf(T0 + 10 * MINUTE, 60, () => ({ ask: { 101: 200 } }));
    const status = run(late, bars(12, [1, 11]));
    expect(status.window).toMatchObject({ verdict: null, noBook: true, open: false, from: T0 + MINUTE });
  });

  it("reads the same open bar again without opening a second window", () => {
    const feed = feedOf(T0, 12, () => ({ ask: { 101: 200 } }));
    const status = createLevelStatus();
    const touch = bar(T0 + MINUTE, 100, 96);
    advanceLevel(status, HIGH, touch, feed, 1, RULES, [touch]);
    advanceLevel(status, HIGH, touch, feed, 1, RULES, [touch]);
    expect(status.window).toMatchObject({ open: true, from: T0 + MINUTE });
  });
});

describe("a level's window read again from the host's recording", () => {
  const FACTS = { before: 0, now: 0, into: 0, through: 0, against: 0, delta: 0, wentPast: false, outAtEnd: false, columns: 0, captured: 0, expected: 0 };
  const reading = (over: Partial<WindowReading> = {}): WindowReading => ({ from: T0, to: T0 + 5 * MINUTE, open: false, noBook: false, partial: false, verdict: null, facts: FACTS, ...over });
  const withWindow = (window: WindowReading | null, recorded: WindowReading | null): LevelStatus => ({ ...createLevelStatus(), window, recorded });

  it("starts with nothing asked and nothing recorded, and wants the recording only for a closed window without a verdict", () => {
    expect(createLevelStatus()).toEqual({ resting: 0, peak: 0, window: null, want: null, recorded: null, recordedFrom: null });
    expect(needsRecording(createLevelStatus())).toBe(false);
    expect(needsRecording(withWindow(reading({ noBook: true }), null))).toBe(true);
    expect(needsRecording(withWindow(reading({ partial: true }), null))).toBe(true);
    expect(needsRecording(withWindow(reading({ open: true }), null))).toBe(false);
    expect(needsRecording(withWindow(reading({ verdict: "held" }), null))).toBe(false);
  });

  it("takes the recording's verdict where the page had none, and leaves a live verdict or an open window alone", () => {
    const absorbed = reading({ verdict: "absorbed" });
    const fromNoBook = withWindow(reading({ noBook: true }), absorbed);
    applyRecording(fromNoBook);
    expect(fromNoBook.window).toBe(absorbed);
    const fromPartial = withWindow(reading({ partial: true }), absorbed);
    applyRecording(fromPartial);
    expect(fromPartial.window).toBe(absorbed);
    const live = reading({ verdict: "swept" });
    const decided = withWindow(live, absorbed);
    applyRecording(decided);
    expect(decided.window).toBe(live);
    const open = reading({ open: true });
    const running = withWindow(open, absorbed);
    applyRecording(running);
    expect(running.window).toBe(open);
    const none = withWindow(reading({ noBook: true }), null);
    applyRecording(none);
    expect(none.window).toMatchObject({ noBook: true });
    const untouched = withWindow(null, absorbed);
    applyRecording(untouched);
    expect(untouched.window).toBeNull();
  });

  it("without a verdict, shows the recording when it has a book the page lacks or caught more of the trading", () => {
    const gap = reading({ partial: true, bookGap: true });
    const noBook = withWindow(reading({ noBook: true }), gap);
    applyRecording(noBook);
    expect(noBook.window).toBe(gap);
    const bothNoBook = reading({ noBook: true });
    const still = withWindow(bothNoBook, reading({ noBook: true }));
    applyRecording(still);
    expect(still.window).toBe(bothNoBook);
    const more = reading({ partial: true, facts: { ...FACTS, captured: 70, expected: 100 } });
    const less = reading({ partial: true, facts: { ...FACTS, captured: 43, expected: 100 } });
    const better = withWindow(less, more);
    applyRecording(better);
    expect(better.window).toBe(more);
    const worse = withWindow(more, less);
    applyRecording(worse);
    expect(worse.window).toBe(more);
    const equal = withWindow(less, reading({ partial: true, facts: { ...FACTS, captured: 43, expected: 100 } }));
    applyRecording(equal);
    expect(equal.window).toBe(less);
  });
});
