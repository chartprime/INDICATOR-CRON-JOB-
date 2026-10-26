import { describe, expect, it, vi } from "vitest";
import type { TradeFrame } from "../../../../types/frames";
import { AUTO_FLOOR_MIN_PRINTS, AUTO_FLOOR_REFRESH_MS, AggressiveTape, HISTORY_ASK_MAX_MS, HISTORY_GIVE_UP_MS, HISTORY_THIN_PER_MINUTE_SIDE, MAX_COVERAGE_ENTRIES, MAX_TAPE_PRINTS, TRIM_SLACK_PRINTS, foldPrint, type ClusterRules, type OrderCluster, HISTORY_SETTLE_MS } from "../aggressiveTape";

const T = 1_700_000_100_000;
let nextId = 1;
const trade = (over: Partial<TradeFrame> = {}): TradeFrame => ({
  type: "trade",
  symbol: "/ESU26:XCME",
  provider: "DXFEED",
  assetClass: "FUTURE",
  ts_exchange: T,
  price: 7600,
  size: 1,
  side: "buy",
  trade_id: String(nextId++),
  ...over,
}) as TradeFrame;
// ES-like rules: two ticks wide, three seconds of quiet, ten seconds of life, every print counts.
const RULES: ClusterRules = { minVolume: 0, width: 0.5, gapMs: 3_000, maxMs: 10_000, bucketMs: 0 };
const NO_RUNS: ClusterRules = { ...RULES, width: 0 };
const summary = (clusters: readonly OrderCluster[]) => clusters.map((c) => `${c.side} ${c.price}@${c.ts - T} vol=${c.volume} n=${c.count}`);

describe("aggressiveTape", () => {
  it("keeps every print with its own moment, price, size and side", () => {
    const tape = new AggressiveTape();
    tape.add(trade({ ts_exchange: T + 1_000, size: 3, price: 7600 }));
    tape.add(trade({ ts_exchange: T + 2_000, size: 2, side: "sell", price: 7599.75 }));
    expect(tape.prints).toEqual([
      { id: "1", history: false, ts: T + 1_000, price: 7600, size: 3, side: "buy", seq: 0 },
      { id: "2", history: false, ts: T + 2_000, price: 7599.75, size: 2, side: "sell", seq: 1 },
    ]);
    expect(tape.liveCount).toBe(2);
    expect(tape.lastTs).toBe(T + 2_000);
  });

  it("merges a sweep (same side, same timestamp, several levels) into one bubble even with runs off", () => {
    const tape = new AggressiveTape(() => T);
    tape.add(trade({ ts_exchange: T + 1_000, price: 7600, size: 5 }));
    tape.add(trade({ ts_exchange: T + 1_000, price: 7600.25, size: 3 }));
    tape.add(trade({ ts_exchange: T + 1_000, price: 7602, size: 2 })); // far, same order
    tape.add(trade({ ts_exchange: T + 1_000, price: 7600, size: 4, side: "sell" })); // other side: its own bubble
    expect(summary(tape.clusters(NO_RUNS, T))).toEqual(["buy 7600@1000 vol=10 n=3", "sell 7600@1000 vol=4 n=1"]);
    expect(tape.clusters(NO_RUNS, T)[0].vwap).toBeCloseTo((7600 * 5 + 7600.25 * 3 + 7602 * 2) / 10);
  });

  it("folds a run into one bubble anchored where it began: within the width of the LAST print, within the gap of it, and remembers the prices it walked", () => {
    const tape = new AggressiveTape(() => T);
    tape.add(trade({ ts_exchange: T + 1_000, price: 7600, size: 2 }));
    tape.add(trade({ ts_exchange: T + 2_500, price: 7600.25, size: 3 })); // joins: 1.5 s later, one tick up
    tape.add(trade({ ts_exchange: T + 4_000, price: 7600.5, size: 1 })); // joins: two ticks from the anchor, one from the last
    tape.add(trade({ ts_exchange: T + 5_000, price: 7600.75, size: 1 })); // joins: three ticks from the anchor but one from the last print (a sweep walking up)
    tape.add(trade({ ts_exchange: T + 5_200, price: 7601.5, size: 1 })); // three ticks from the last print: a new bubble
    tape.add(trade({ ts_exchange: T + 5_500, price: 7600, size: 9, side: "sell" })); // other side never joins
    expect(summary(tape.clusters(RULES, T))).toEqual(["buy 7600@1000 vol=7 n=4", "buy 7601.5@5200 vol=1 n=1", "sell 7600@5500 vol=9 n=1"]);
    expect(tape.clusters(RULES, T)[0]).toMatchObject({ price: 7600, lastPrice: 7600.75, minPrice: 7600, maxPrice: 7600.75 });
  });

  it("keeps a candle's bubbles inside that candle when the rules bind them to one", () => {
    // A 15-minute candle: the candle is the gap and the life, and no print from the next candle joins.
    const candle = 15 * 60000;
    const open = Math.floor((T + candle) / candle) * candle; // a real candle boundary
    const linked: ClusterRules = { minVolume: 0, width: 0.5, gapMs: candle, maxMs: candle, bucketMs: candle };
    const tape = new AggressiveTape(() => T);
    tape.add(trade({ trade_id: "a", ts_exchange: open + 1_000, price: 7600, size: 2 }));
    tape.add(trade({ trade_id: "b", ts_exchange: open + 600_000, price: 7600.25, size: 3 })); // ten minutes later: still this candle, one bubble
    tape.add(trade({ trade_id: "c", ts_exchange: open + candle + 1_000, price: 7600.25, size: 4 })); // next candle, same price a second later: its own bubble
    const clusters = tape.clusters(linked, T);
    expect(clusters.map((c) => [c.ts - open, c.volume, c.count])).toEqual([[1_000, 5, 2], [candle + 1_000, 4, 1]]);
    // Unbound, the same prints would have made three bubbles (ten minutes is far past the 3 s gap).
    expect(tape.clusters(RULES, T)).toHaveLength(3);
  });

  it("closes a run after the gap and at the end of its life", () => {
    const tape = new AggressiveTape(() => T);
    tape.add(trade({ ts_exchange: T + 1_000, price: 7600, size: 1 }));
    tape.add(trade({ ts_exchange: T + 4_001, price: 7600, size: 1 })); // 3.001 s of quiet: a new bubble
    for (let i = 1; i <= 5; i += 1) tape.add(trade({ ts_exchange: T + 4_001 + i * 2_000, price: 7600, size: 1 })); // every 2 s: joins until the 10 s life is up
    expect(summary(tape.clusters(RULES, T))).toEqual(["buy 7600@1000 vol=1 n=1", "buy 7600@4001 vol=6 n=6"]);
    tape.add(trade({ ts_exchange: T + 4_001 + 10_001, price: 7600, size: 1 }));
    expect(summary(tape.clusters(RULES, T)).at(-1)).toBe("buy 7600@14002 vol=1 n=1");
  });

  it("filters prints before clustering: a bubble is never a sum of small orders", () => {
    const tape = new AggressiveTape(() => T);
    for (let i = 0; i < 20; i += 1) tape.add(trade({ ts_exchange: T + i * 100, price: 7600, size: 2 })); // 40 contracts of two-lots in a run
    tape.add(trade({ ts_exchange: T + 500, price: 7600, size: 10, side: "sell" }));
    expect(summary(tape.clusters(RULES, T))).toEqual(["buy 7600@0 vol=40 n=20", "sell 7600@500 vol=10 n=1"]);
    expect(summary(tape.clusters({ ...RULES, minVolume: 10 }, T))).toEqual(["sell 7600@500 vol=10 n=1"]);
  });

  it("rebuilds under new rules and folds later prints into the current tally as they land", () => {
    const tape = new AggressiveTape(() => T);
    tape.add(trade({ ts_exchange: T + 1_000, price: 7600, size: 1 }));
    tape.add(trade({ ts_exchange: T + 2_000, price: 7600.25, size: 1 }));
    expect(tape.clusters(RULES, T)).toHaveLength(1);
    expect(tape.clusters(NO_RUNS, T)).toHaveLength(2);
    tape.add(trade({ ts_exchange: T + 2_500, price: 7600.25, size: 1 }));
    expect(tape.clusters(NO_RUNS, T)).toHaveLength(3);
    expect(tape.clusters(RULES, T)).toHaveLength(1);
    expect(tape.clusters(RULES, T)[0].count).toBe(3);
  });

  it("stamps the wall clock of a live join for the pulse, and no pulse on a rebuild", () => {
    let wall = 5_000;
    const tape = new AggressiveTape(() => wall);
    tape.clusters(RULES, T); // arm the tally
    tape.add(trade({ ts_exchange: T + 1_000, size: 1 }));
    expect(tape.clusters(RULES, T)[0].fedAt).toBe(5_000);
    wall = 6_000;
    tape.add(trade({ ts_exchange: T + 1_500, size: 1 }));
    expect(tape.clusters(RULES, T)[0].fedAt).toBe(6_000);
    expect(tape.clusters(NO_RUNS, T)[0].fedAt).toBe(-Infinity);
  });

  it("returns the bubbles whose first print falls in a window, oldest first", () => {
    const tape = new AggressiveTape(() => T);
    tape.add(trade({ ts_exchange: T + 1_000, size: 1 }));
    tape.add(trade({ ts_exchange: T + 60_000, size: 1 }));
    tape.add(trade({ ts_exchange: T + 120_000, size: 1 }));
    expect(tape.bubbles(RULES, T, T + 30_000, T + 90_000).map((c) => c.ts - T)).toEqual([60_000]);
    expect(tape.bubbles(RULES, T, T, T + 200_000).map((c) => c.ts - T)).toEqual([1_000, 60_000, 120_000]);
  });

  it("sets its own floor at the biggest two percent of prints, only once the tape is deep enough, re-measured at most once a second", () => {
    const tape = new AggressiveTape();
    for (let i = 1; i < AUTO_FLOOR_MIN_PRINTS; i += 1) tape.add(trade({ ts_exchange: T + i, size: i }));
    expect(tape.autoFloor(T)).toBe(0);
    tape.add(trade({ ts_exchange: T + 100, size: 100 }));
    expect(tape.autoFloor(T)).toBe(49);
    expect(tape.floor(0, T)).toBe(49);
    expect(tape.floor(7, T)).toBe(7);
    for (let i = 0; i < 100; i += 1) tape.add(trade({ ts_exchange: T + 200 + i, size: 1000 }));
    expect(tape.autoFloor(T + 10)).toBe(49);
    expect(tape.autoFloor(T + AUTO_FLOOR_REFRESH_MS)).toBe(1000);
  });

  it("measures the automatic floor on live prints only: history, already filtered at a floor, must not drag it up", () => {
    const tape = new AggressiveTape(() => T);
    for (let i = 0; i < 100; i += 1) tape.add(trade({ trade_id: `live-${i}`, ts_exchange: T + 200_000 + i, size: i < 98 ? 1 : 5 })); // live: one-lots, two five-lots
    expect(tape.autoFloor(T)).toBe(1);
    tape.addHistory(Array.from({ length: 700 }, (_, i) => trade({ trade_id: `hist-${i}`, ts_exchange: T + i, size: 10 + (i % 5) })));
    expect(tape.liveCount).toBe(100);
    expect(tape.prints.filter((print) => print.history)).toHaveLength(700);
    expect(tape.autoFloor(T + AUTO_FLOOR_REFRESH_MS)).toBe(1); // still the live prints' own floor
    // With no live prints at all the floor is unknown (0) and everything shows, history included.
    const fresh = new AggressiveTape(() => T);
    fresh.addHistory(Array.from({ length: 700 }, (_, i) => trade({ trade_id: `h-${i}`, ts_exchange: T + i, size: 12 })));
    expect(fresh.liveCount).toBe(0);
    expect(fresh.autoFloor(T)).toBe(0);
    const shown = fresh.bubbles({ ...RULES, minVolume: 0 }, T, T, T + 1_000);
    expect(shown).toHaveLength(1); // one run of 700 twelve-lots a millisecond apart on one price
    expect(shown[0].count).toBe(700);
  });

  it("takes from a snapshot only the prints it does not hold yet, by trade id, and starts over on reset", () => {
    const tape = new AggressiveTape();
    tape.absorb([trade({ trade_id: "a", ts_exchange: T + 1_000 }), trade({ trade_id: "b", ts_exchange: T + 2_000 })]);
    tape.add(trade({ trade_id: "c", ts_exchange: T + 3_000 }));
    tape.add(trade({ trade_id: "c", ts_exchange: T + 3_000 })); // the same print twice: once
    tape.absorb([trade({ trade_id: "b", ts_exchange: T + 2_000, size: 9 }), trade({ trade_id: "c", ts_exchange: T + 3_000, size: 9 }), trade({ trade_id: "d", ts_exchange: T + 4_000 })]);
    expect(tape.prints.map((print) => print.id)).toEqual(["a", "b", "c", "d"]);
    expect(tape.prints.map((print) => print.size)).toEqual([1, 1, 1, 1]);
    tape.reset([trade({ trade_id: "z", ts_exchange: T + 50_000, size: 7 })]);
    expect(tape.prints).toHaveLength(1);
    expect(tape.prints[0]).toMatchObject({ id: "z", history: false, ts: T + 50_000, price: 7600, size: 7, side: "buy" });
  });

  it("lays history from the collector under what it holds: new ids only, back in time order, bubbles rebuilt, listeners told", () => {
    const tape = new AggressiveTape(() => T);
    const listener = vi.fn();
    tape.subscribe(listener);
    tape.add(trade({ trade_id: "live-1", ts_exchange: T + 100_000, size: 6 }));
    tape.add(trade({ trade_id: "live-2", ts_exchange: T + 100_500, size: 6 }));
    expect(summary(tape.clusters(RULES, T))).toEqual(["buy 7600@100000 vol=12 n=2"]);
    listener.mockClear();
    const taken = tape.addHistory([
      trade({ trade_id: "h-1", ts_exchange: T + 1_000, size: 7, side: "sell" }),
      trade({ trade_id: "h-2", ts_exchange: T + 2_000, size: 7, side: "sell" }),
      trade({ trade_id: "live-1", ts_exchange: T + 100_000, size: 6 }), // already held: skipped
    ]);
    expect(taken).toBe(2);
    expect(tape.prints.map((print) => print.id)).toEqual(["h-1", "h-2", "live-1", "live-2"]);
    // The walk-back lands in many replies: the bubbles are served as they were until it settles, then rebuilt once.
    expect(tape.settling(T)).toBe(true);
    expect(summary(tape.clusters(RULES, T))).toEqual(["buy 7600@100000 vol=12 n=2"]);
    expect(tape.settling(T + HISTORY_SETTLE_MS)).toBe(false);
    expect(summary(tape.clusters(RULES, T + HISTORY_SETTLE_MS))).toEqual(["sell 7600@1000 vol=14 n=2", "buy 7600@100000 vol=12 n=2"]);
    expect(tape.generation).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(tape.addHistory([trade({ trade_id: "h-1", ts_exchange: T + 1_000 })])).toBe(0); // nothing new: no rebuild, no call
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tells its subscribers on every print, the moment it lands, until they stop listening", () => {
    const tape = new AggressiveTape();
    const listener = vi.fn();
    const stop = tape.subscribe(listener);
    tape.add(trade({ trade_id: "same" }));
    expect(listener).toHaveBeenCalledTimes(1);
    tape.absorb([trade({ trade_id: "same", ts_exchange: T - 1 })]); // already held: no call
    expect(listener).toHaveBeenCalledTimes(1);
    tape.absorb([trade({ trade_id: "new", ts_exchange: T + 1 })]);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    tape.add(trade());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("over the cap it sheds the small prints first and keeps the big ones history was promised for, however old", () => {
    const tape = new AggressiveTape(() => T);
    tape.coverHistory(T - 1, T + MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS, 10);
    tape.addHistory([trade({ trade_id: "big-old", ts_exchange: T, size: 50 })]);
    for (let i = 1; i < MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS; i += 1) tape.add(trade({ trade_id: `p${i}`, ts_exchange: T + i, size: 1 }));
    expect(tape.prints).toHaveLength(MAX_TAPE_PRINTS);
    expect(tape.prints[0].id).toBe("big-old");
    expect(tape.prints[1].id).toBe(`p${TRIM_SLACK_PRINTS + 1}`);
  });

  it("knows since when the live feed covers it: from the snapshot or the first live print, never from history, forgotten on reset", () => {
    const clock = { now: T + 5_000 };
    const tape = new AggressiveTape(() => clock.now);
    expect(tape.liveSince).toBeNull();
    tape.addHistory([trade({ trade_id: "h" })]);
    expect(tape.liveSince).toBeNull();
    tape.add(trade({ trade_id: "a" }));
    expect(tape.liveSince).toBe(T + 5_000);
    clock.now = T + 9_000;
    tape.add(trade({ trade_id: "b", ts_exchange: T + 9_000 }));
    expect(tape.liveSince).toBe(T + 5_000);
    tape.reset();
    expect(tape.liveSince).toBeNull();
    // An empty snapshot still says the live feed covers from here.
    tape.absorb([]);
    expect(tape.liveSince).toBe(T + 9_000);
  });

  it("remembers the last ask it made per floor, so the same stretch is not asked again while its reply is due", () => {
    const tape = new AggressiveTape(() => T);
    expect(tape.lastHistoryAsk(5)).toBeNull();
    tape.noteHistoryAsk({ from: T - 60_000, to: T - 30_000 }, 5, T);
    expect(tape.lastHistoryAsk(5)).toEqual({ ask: { from: T - 60_000, to: T - 30_000 }, at: T });
    expect(tape.lastHistoryAsk(3)).toBeNull();
    tape.noteHistoryAsk({ from: T - 60_000, to: T - 20_000 }, 3, T + 1_000);
    expect(tape.lastHistoryAsk(3)?.at).toBe(T + 1_000);
    expect(tape.lastHistoryAsk(5)).toBeNull();
    tape.reset();
    expect(tape.lastHistoryAsk(3)).toBeNull();
  });

  it("keeps a bounded tape: once TRIM_SLACK_PRINTS over the cap the oldest go in one cut, and their ids with them", () => {
    const tape = new AggressiveTape();
    for (let i = 0; i < MAX_TAPE_PRINTS + 10; i += 1) tape.add(trade({ trade_id: `p${i}`, ts_exchange: T + i }));
    expect(tape.prints).toHaveLength(MAX_TAPE_PRINTS + 10); // a little over the cap costs nothing yet
    expect(tape.full).toBe(true);
    for (let i = MAX_TAPE_PRINTS + 10; i < MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS; i += 1) tape.add(trade({ trade_id: `p${i}`, ts_exchange: T + i }));
    expect(tape.prints).toHaveLength(MAX_TAPE_PRINTS);
    expect(tape.prints[0].ts).toBe(T + TRIM_SLACK_PRINTS);
    tape.add(trade({ trade_id: "p0", ts_exchange: T + MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS })); // a dropped id may come back
    expect(tape.prints.at(-1)?.id).toBe("p0");
  });

  it("remembers what history covered per floor: a reply counts for asks at its floor or above, never below, and nothing starts over", () => {
    const tape = new AggressiveTape();
    expect(tape.historyCoveredTo(0)).toBeNull();
    tape.coverHistory(T, T + 10_000, 5);
    expect(tape.historyCoveredTo(5)).toBe(T + 10_000);
    expect(tape.historyCoveredTo(10)).toBe(T + 10_000); // a coarser need is covered by a finer answer
    expect(tape.historyCoveredTo(0)).toBeNull(); // a finer need is not covered by a coarser answer
    tape.coverHistory(T + 10_000, T + 20_000, 5);
    expect(tape.historyCoveredTo(5)).toBe(T + 20_000);
    tape.coverHistory(T + 20_000, T + 30_000, 10); // a coarser answer counts at its own floor and above, not at the finer one
    expect(tape.historyCoveredTo(5)).toBe(T + 20_000);
    expect(tape.historyCoveredTo(10)).toBe(T + 30_000);
    expect(tape.historyIntervalsAt(5)).toEqual([{ from: T, to: T + 20_000 }]);
    tape.coverHistory(T + 15_000, T + 25_000, 0); // a finer answer counts everywhere, beside what was there
    expect(tape.historyCoveredTo(0)).toBe(T + 25_000);
    expect(tape.historyIntervalsAt(5)).toEqual([{ from: T, to: T + 25_000 }]);
    expect(tape.historyFrom).toBe(T);
    tape.wantHistoryFrom(T - 3_600_000);
    expect(tape.historyWantedFrom).toBe(T - 3_600_000);
    tape.reset();
    expect(tape.historyCoveredTo(0)).toBeNull();
    expect(tape.historyWantedFrom).toBeNull();
  });

  it("keeps coverage as intervals: a hole between two replies stays a hole, and is the next thing to ask for", () => {
    const tape = new AggressiveTape();
    tape.wantHistoryFrom(T);
    tape.coverHistory(T + 60_000, T + 90_000, 0);
    expect(tape.historyCoveredTo(0)).toBe(T + 90_000);
    expect(tape.historyFrom).toBe(T + 60_000);
    expect(tape.nextHistoryGap()).toEqual({ from: T, to: T + 60_000 });
    tape.coverHistory(T, T + 30_000, 0); // an older reply that never met the newer one: two intervals, not one
    expect(tape.historyIntervals).toEqual([{ from: T, to: T + 30_000 }, { from: T + 60_000, to: T + 90_000 }]);
    expect(tape.historyCoveredTo(0)).toBe(T + 90_000);
    expect(tape.historyFrom).toBe(T + 60_000);
    expect(tape.nextHistoryGap()).toEqual({ from: T + 30_000, to: T + 60_000 });
    tape.coverHistory(T + 30_000, T + 60_000, 0); // touching both: one interval
    expect(tape.historyIntervals).toEqual([{ from: T, to: T + 90_000 }]);
    expect(tape.nextHistoryGap()).toBeNull();
    tape.coverHistory(T + 20_000, T + 40_000, 0); // nested: nothing changes
    expect(tape.historyIntervals).toEqual([{ from: T, to: T + 90_000 }]);
    tape.coverHistory(T + 85_000, T + 120_000, 0); // overlapping: the edge moves
    expect(tape.historyIntervals).toEqual([{ from: T, to: T + 120_000 }]);
    expect(tape.historyCoveredTo(0)).toBe(T + 120_000);
    tape.coverHistory(T + 200_000, T + 210_000, 0); // a reconnect's window for the newest minutes
    expect(tape.historyCoveredTo(0)).toBe(T + 210_000);
    expect(tape.nextHistoryGap()).toEqual({ from: T + 120_000, to: T + 200_000 });
    tape.coverHistory(T + 130_000, T + 200_000, 5); // a coarser reply counts for asks at its floor, not at the finer one in force
    expect(tape.nextHistoryGap(0)).toEqual({ from: T + 120_000, to: T + 200_000 });
    expect(tape.nextHistoryGap(5)).toEqual({ from: T + 120_000, to: T + 130_000 });
    tape.wantHistoryFrom(T + 199_500); // a hole shorter than the minimum is not chased
    expect(tape.nextHistoryGap(0)).toBeNull();
    tape.coverHistory(T + 150_000, T + 205_000, 0); // the same floor merges into the newest run; the coarser stretch stays its own
    expect(tape.historyIntervalsAt(0)).toEqual([{ from: T, to: T + 120_000 }, { from: T + 150_000, to: T + 210_000 }]);
    expect(tape.historyIntervalsAt(5)).toEqual([{ from: T, to: T + 120_000 }, { from: T + 130_000, to: T + 210_000 }]);
  });

  it("places a late live print chronologically and invalidates incremental calculations", () => {
    const tape = new AggressiveTape();
    tape.add(trade({ trade_id: "newer", ts_exchange: T + 2_000 }));
    const generationBeforeLatePrint = tape.generation;
    tape.add(trade({ trade_id: "late", ts_exchange: T + 1_000 }));

    expect(tape.prints.map((print) => print.id)).toEqual(["late", "newer"]);
    expect(tape.generation).toBe(generationBeforeLatePrint + 1);
  });

  it("foldPrint: a print far in price from every live run opens its own bubble", () => {
    const clusters: OrderCluster[] = [];
    foldPrint(clusters, { id: "x", history: false, ts: T, price: 100, size: 1, side: "buy", seq: 0 }, RULES, 1);
    const opened = foldPrint(clusters, { id: "y", history: false, ts: T + 100, price: 200, size: 2, side: "buy", seq: 1 }, RULES, 2);
    expect(clusters).toHaveLength(2);
    expect(opened).toMatchObject({ price: 200, lastPrice: 200, minPrice: 200, maxPrice: 200, volume: 2, fedAt: 2 });
  });
});

describe("aggressiveTape history over days", () => {
  const DAY = HISTORY_ASK_MAX_MS;

  it("asks for a long hole one piece at a time, the newest first, so no ask is longer than the host answers", () => {
    const tape = new AggressiveTape();
    tape.wantHistoryFrom(T - 3 * DAY);
    tape.coverHistory(T - 3_600_000, T, 0);
    expect(HISTORY_ASK_MAX_MS).toBe(6 * 60 * 60 * 1000);
    expect(tape.nextHistoryGap()).toEqual({ from: T - 3_600_000 - DAY, to: T - 3_600_000 });
    tape.coverHistory(T - 3_600_000 - DAY, T - 3_600_000, 0);
    expect(tape.nextHistoryGap()).toEqual({ from: T - 3_600_000 - 2 * DAY, to: T - 3_600_000 - DAY });
    tape.coverHistory(T - 3_600_000 - 2 * DAY, T - 3_600_000 - DAY, 0);
    expect(tape.nextHistoryGap()).toEqual({ from: T - 3 * DAY, to: T - 3_600_000 - 2 * DAY });
    tape.coverHistory(T - 3 * DAY, T - 3_600_000 - 2 * DAY, 0);
    expect(tape.nextHistoryGap()).toBeNull();
  });

  it("a hole between two replies is asked from its newest end when it is longer than one piece", () => {
    const tape = new AggressiveTape();
    tape.wantHistoryFrom(T - 5 * DAY);
    tape.coverHistory(T - 5 * DAY, T - 4 * DAY, 0);
    tape.coverHistory(T - DAY, T, 0);
    expect(tape.nextHistoryGap()).toEqual({ from: T - 2 * DAY, to: T - DAY });
  });

  it("thins history older than the raw stretch to the biggest prints of each minute and side, and leaves the rest whole", () => {
    const tape = new AggressiveTape(() => T);
    const minute = T - 2 * 3_600_000;
    const old = Array.from({ length: 6 }, (_unused, i) => trade({ trade_id: `old-${i}`, ts_exchange: minute + i * 1_000, size: i + 1 }));
    const oldSells = Array.from({ length: 6 }, (_unused, i) => trade({ trade_id: `old-sell-${i}`, ts_exchange: minute + i * 1_000, size: 10 + i, side: "sell" }));
    const recent = Array.from({ length: 6 }, (_unused, i) => trade({ trade_id: `new-${i}`, ts_exchange: T - 1_000 + i, size: i + 1 }));
    tape.addHistory([...old, ...oldSells, ...recent], T - 3_600_000);
    const kept = tape.prints.map((print) => print.id);
    expect(kept.filter((id) => id.startsWith("old-sell"))).toEqual(["old-sell-2", "old-sell-3", "old-sell-4", "old-sell-5"]);
    expect(kept.filter((id) => /^old-\d/.test(id))).toEqual(["old-2", "old-3", "old-4", "old-5"]);
    expect(kept.filter((id) => id.startsWith("new-"))).toHaveLength(6);
    expect(HISTORY_THIN_PER_MINUTE_SIDE).toBe(4);
  });

  it("a later reply into an already thinned minute is thinned against what is there, so the minute never grows past its cap", () => {
    const tape = new AggressiveTape(() => T);
    const minute = T - 2 * 3_600_000;
    tape.addHistory(Array.from({ length: 4 }, (_unused, i) => trade({ trade_id: `a-${i}`, ts_exchange: minute + i, size: 5 })), T - 3_600_000);
    tape.addHistory([trade({ trade_id: "bigger", ts_exchange: minute + 10, size: 9 }), trade({ trade_id: "smaller", ts_exchange: minute + 11, size: 1 })], T - 3_600_000);
    const ids = tape.prints.map((print) => print.id);
    expect(ids).toHaveLength(4);
    expect(ids).toContain("bigger");
    expect(ids).not.toContain("smaller");
  });

  it("when the cap forces the oldest prints out it gives up their coverage and stops wanting them, so they are not asked for again", () => {
    const tape = new AggressiveTape(() => T);
    tape.wantHistoryFrom(T - DAY);
    tape.coverHistory(T - DAY, T + MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS, 1);
    tape.addHistory(Array.from({ length: MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS }, (_unused, i) => trade({ trade_id: `h${i}`, ts_exchange: T + i, size: 1 })));
    expect(tape.prints).toHaveLength(MAX_TAPE_PRINTS);
    const oldestKept = tape.prints[0].ts;
    expect(oldestKept).toBe(T + TRIM_SLACK_PRINTS);
    expect(tape.historyIntervals).toEqual([{ from: oldestKept, to: T + MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS }]);
    expect(tape.historyWantedFrom).toBe(oldestKept);
    expect(tape.nextHistoryGap()).toBeNull();
  });

  it("coverage that ends exactly at the oldest kept print is given up whole, not kept as an empty stretch", () => {
    const tape = new AggressiveTape(() => T);
    tape.wantHistoryFrom(T - DAY);
    tape.coverHistory(T - DAY, T + TRIM_SLACK_PRINTS, 1);
    tape.coverHistory(T + TRIM_SLACK_PRINTS + 1, T + MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS, 1);
    tape.addHistory(Array.from({ length: MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS }, (_unused, i) => trade({ trade_id: `h${i}`, ts_exchange: T + i, size: 1 })));
    expect(tape.prints[0].ts).toBe(T + TRIM_SLACK_PRINTS);
    expect(tape.historyIntervals).toEqual([{ from: T + TRIM_SLACK_PRINTS + 1, to: T + MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS }]);
  });
});

describe("aggressiveTape history given up on", () => {
  const DAY = HISTORY_ASK_MAX_MS;

  it("skips a stretch given up on and asks for the piece below it, until the cooldown passes", () => {
    const clock = { now: T };
    const tape = new AggressiveTape(() => clock.now);
    tape.wantHistoryFrom(T - 4 * DAY);
    tape.coverHistory(T - DAY, T, 0);
    tape.giveUpHistory(T - 2 * DAY, T - DAY, T + HISTORY_GIVE_UP_MS);
    expect(tape.nextHistoryGap()).toEqual({ from: T - 3 * DAY, to: T - 2 * DAY });
    expect(tape.askable({ from: T - 2 * DAY, to: T - DAY }, T)).toBeNull();
    expect(tape.askable({ from: T - 2 * DAY - 500, to: T - DAY }, T)).toBeNull();
    clock.now = T + HISTORY_GIVE_UP_MS;
    expect(tape.nextHistoryGap()).toEqual({ from: T - 2 * DAY, to: T - DAY });
    expect(HISTORY_GIVE_UP_MS).toBe(10 * 60 * 1000);
  });

  it("forgets what it gave up on when it is reset", () => {
    const tape = new AggressiveTape(() => T);
    tape.giveUpHistory(T - DAY, T, T + HISTORY_GIVE_UP_MS);
    expect(tape.askable({ from: T - DAY, to: T }, T)).toBeNull();
    tape.reset();
    expect(tape.askable({ from: T - DAY, to: T }, T)).toEqual({ from: T - DAY, to: T });
  });
});

describe("aggressiveTape coverage at the trader's floor over the pool's", () => {
  it("a reply at a coarser floor than the snapshot pool's is coverage at that floor, so the next day is asked and never the same one again", () => {
    const tape = new AggressiveTape(() => T);
    const DAY = HISTORY_ASK_MAX_MS;
    tape.wantHistoryFrom(T - 6 * DAY);
    tape.coverHistory(T - 12 * 3_600_000, T, 0.16);
    const first = tape.nextHistoryGap(3);
    expect(first).toEqual({ from: T - 12 * 3_600_000 - DAY, to: T - 12 * 3_600_000 });
    tape.coverHistory(first!.from, first!.to, 3);
    expect(tape.nextHistoryGap(3)).toEqual({ from: first!.from - DAY, to: first!.from });
    expect(tape.nextHistoryGap(0.16)).toEqual(first);
  });

  it("keeps a bounded number of coverage entries, shedding the oldest", () => {
    const tape = new AggressiveTape(() => T);
    for (let i = 0; i < MAX_COVERAGE_ENTRIES + 20; i += 1) tape.coverHistory(T + i * 10_000, T + i * 10_000 + 5_000, i % 7);
    expect(tape.historyIntervalsAt(Infinity)).toHaveLength(MAX_COVERAGE_ENTRIES);
    expect(tape.historyIntervalsAt(Infinity)[0].from).toBe(T + 20 * 10_000);
  });
});
