const { createBinanceRestBarCursor, DEFAULT_MAX_HOLE_RETRIES } = require("../../../src/providers/binance/binance-rest-bar-cursor");
const { parseKlineRows } = require("../../../src/providers/binance/binance-event-normalizer");

const MINUTE = 60_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % MINUTE);

function rawRow(openTime, { open = "64200.00", high = "64300.50", low = "64150.25", close = "64275.99", volume = "12.3", trades = 418, takerBuy = "6.0" } = {}) {
  return [openTime, open, high, low, close, volume, openTime + MINUTE - 1, "792345.11", trades, takerBuy, "385000.0", "0"];
}

function rows(...raws) {
  const parsed = parseKlineRows(raws, MINUTE);
  if (parsed === null) throw new Error("test rows must parse");
  return parsed;
}

describe("binance-rest-bar-cursor", () => {
  test("classifies every row by its own close time against the exchange clock, not by position: the previous bar is final, the current forms", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE, finalizeGraceMs: 1000 });
    const exchangeNow = T0 + 2 * MINUTE + 30_000;
    expect(cursor.nextRequest(exchangeNow)).toEqual({ startTime: T0 + MINUTE, limit: 2, catchUp: false });
    const outcome = cursor.apply({ rows: rows(rawRow(T0 + MINUTE), rawRow(T0 + 2 * MINUTE)), exchangeNowMs: exchangeNow, seq: 1 });
    expect(outcome.stale).toBe(false);
    expect(outcome.emit.map(({ row, closed }) => [row.openTime - T0, closed])).toEqual([[MINUTE, true], [2 * MINUTE, false]]);
    expect(cursor.confirmedOpenTime).toBe(T0 + MINUTE);
  });

  test("a revision replaces the same forming bar only when it changed; finalisation happens once, with the grace after the close", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE, finalizeGraceMs: 1000 });
    cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE)), exchangeNowMs: T0 + MINUTE + 10_000, seq: 1 });
    const unchanged = cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE)), exchangeNowMs: T0 + MINUTE + 11_000, seq: 2 });
    expect(unchanged.emit).toEqual([]);
    const revised = cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE, { close: "64280.00" })), exchangeNowMs: T0 + MINUTE + 12_000, seq: 3 });
    expect(revised.emit.map(({ row, closed }) => [row.openTime - T0, closed, row.close])).toEqual([[MINUTE, false, "64280.00"]]);
    // Exactly at the close the bar is still forming (the grace has not passed); one second later it is final, once.
    const atClose = cursor.apply({ rows: rows(rawRow(T0 + MINUTE, { close: "64281.00" }), rawRow(T0 + 2 * MINUTE)), exchangeNowMs: T0 + 2 * MINUTE + 500, seq: 4 });
    expect(atClose.emit.map(({ row, closed }) => [row.openTime - T0, closed])).toEqual([[MINUTE, false], [2 * MINUTE, false]]);
    const afterGrace = cursor.apply({ rows: rows(rawRow(T0 + MINUTE, { close: "64281.00" }), rawRow(T0 + 2 * MINUTE)), exchangeNowMs: T0 + 2 * MINUTE + 1000, seq: 5 });
    expect(afterGrace.emit.map(({ row, closed }) => [row.openTime - T0, closed])).toEqual([[MINUTE, true]]);
    const again = cursor.apply({ rows: rows(rawRow(T0 + MINUTE, { close: "64281.00" }), rawRow(T0 + 2 * MINUTE)), exchangeNowMs: T0 + 2 * MINUTE + 2000, seq: 6 });
    expect(again.emit).toEqual([]);
    expect(cursor.confirmedOpenTime).toBe(T0 + MINUTE);
  });

  test("the forming-bar change detector compares every downstream field: open, high, low, close, volume, taker-buy volume and trade count", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE });
    const at = T0 + MINUTE + 10_000;
    let seq = 1;
    const emitForming = (overrides) => cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE, overrides)), exchangeNowMs: at, seq: seq++ }).emit
      .filter(({ closed }) => !closed).length;
    expect(emitForming({})).toBe(1);
    expect(emitForming({})).toBe(0);
    for (const change of [
      { open: "64201.00" },
      { high: "64301.00", open: "64201.00" },
      { low: "64100.00", high: "64301.00", open: "64201.00" },
      { close: "64280.00", low: "64100.00", high: "64301.00", open: "64201.00" },
      { volume: "12.4", close: "64280.00", low: "64100.00", high: "64301.00", open: "64201.00" },
      { takerBuy: "6.1", volume: "12.4", close: "64280.00", low: "64100.00", high: "64301.00", open: "64201.00" },
      { trades: 419, takerBuy: "6.1", volume: "12.4", close: "64280.00", low: "64100.00", high: "64301.00", open: "64201.00" },
    ]) {
      expect(emitForming(change)).toBe(1);
      expect(emitForming(change)).toBe(0);
    }
  });

  test("a response from an older poll never overwrites a newer revision", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE });
    cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE, { close: "64280.00" })), exchangeNowMs: T0 + MINUTE + 5000, seq: 2 });
    const late = cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE, { close: "64270.00" })), exchangeNowMs: T0 + MINUTE + 6000, seq: 1 });
    expect(late.stale).toBe(true);
    expect(late.emit).toEqual([]);
    const next = cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE, { close: "64280.00" })), exchangeNowMs: T0 + MINUTE + 7000, seq: 3 });
    expect(next.emit).toEqual([]);
  });

  test("clock skew: a machine clock ahead of the exchange cannot finalise a bar the exchange still has open", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE, finalizeGraceMs: 1000 });
    const machineNow = T0 + 2 * MINUTE + 20_000;
    const exchangeNow = machineNow - 30_000; // the machine runs 30 s ahead
    expect(cursor.nextRequest(exchangeNow)).toEqual({ startTime: T0, limit: 2, catchUp: false });
    const outcome = cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE)), exchangeNowMs: exchangeNow, seq: 1 });
    // By the machine clock the T0+1m bar closed 20 s ago; by the exchange it has 10 s to run.
    expect(outcome.emit.map(({ row, closed }) => [row.openTime - T0, closed])).toEqual([[0, true], [MINUTE, false]]);
  });

  test("after a multi-minute outage it catches up from the last confirmed close in bounded pages before the two-row poll resumes", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE });
    cursor.apply({ rows: rows(rawRow(T0), rawRow(T0 + MINUTE)), exchangeNowMs: T0 + MINUTE + 5000, seq: 1 });
    expect(cursor.confirmedOpenTime).toBe(T0);
    const afterOutage = T0 + 6 * MINUTE + 5000;
    expect(cursor.needsCatchUp(afterOutage)).toBe(true);
    expect(cursor.nextRequest(afterOutage)).toEqual({ startTime: T0 + MINUTE, limit: 1000, catchUp: true });
    const page = cursor.apply({
      rows: rows(rawRow(T0 + MINUTE), rawRow(T0 + 2 * MINUTE), rawRow(T0 + 3 * MINUTE), rawRow(T0 + 4 * MINUTE), rawRow(T0 + 5 * MINUTE), rawRow(T0 + 6 * MINUTE)),
      exchangeNowMs: afterOutage,
      seq: 2,
    });
    expect(page.emit.map(({ row, closed }) => [row.openTime / MINUTE - T0 / MINUTE, closed])).toEqual([[1, true], [2, true], [3, true], [4, true], [5, true], [6, false]]);
    expect(page.hole).toBeNull();
    expect(page.catchingUp).toBe(false);
    expect(cursor.confirmedOpenTime).toBe(T0 + 5 * MINUTE);
    expect(cursor.nextRequest(afterOutage)).toEqual({ startTime: T0 + 5 * MINUTE, limit: 2, catchUp: false });
    // A page that stops short keeps the catch-up going.
    const stillBehind = createBinanceRestBarCursor({ intervalMs: MINUTE });
    stillBehind.apply({ rows: rows(rawRow(T0)), exchangeNowMs: T0 + MINUTE + 5000, seq: 1 });
    const partial = stillBehind.apply({ rows: rows(rawRow(T0 + MINUTE), rawRow(T0 + 2 * MINUTE)), exchangeNowMs: T0 + 10 * MINUTE, seq: 2 });
    expect(partial.catchingUp).toBe(true);
    expect(stillBehind.nextRequest(T0 + 10 * MINUTE)).toEqual({ startTime: T0 + 3 * MINUTE, limit: 1000, catchUp: true });
  });

  test("finality is judged at dispatch: a row asked for before the close stays forming even when received after it, and the later poll's values are the final ones", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE, finalizeGraceMs: 1000 });
    const P = T0 + MINUTE;
    cursor.apply({ rows: rows(rawRow(T0), rawRow(P, { close: "64270.00" })), exchangeNowMs: P + 30_000, seq: 1 });
    // Dispatched half a second before P closes; the exchange built the row then, whatever the receipt time.
    const early = cursor.apply({ rows: rows(rawRow(T0), rawRow(P, { close: "64275.00" })), exchangeNowMs: P + MINUTE - 500, seq: 2 });
    expect(early.emit.map(({ row, closed }) => [row.openTime - T0, closed, row.close])).toEqual([[MINUTE, false, "64275.00"]]);
    expect(cursor.confirmedOpenTime).toBe(T0);
    // The next poll, dispatched after the close plus grace, carries the true final values.
    const late = cursor.apply({ rows: rows(rawRow(P, { close: "64281.00" }), rawRow(P + MINUTE)), exchangeNowMs: P + MINUTE + 1500, seq: 3 });
    expect(late.emit.map(({ row, closed }) => [row.openTime - T0, closed, row.close])).toEqual([[MINUTE, true, "64281.00"], [2 * MINUTE, false, "64275.99"]]);
    expect(cursor.confirmedOpenTime).toBe(P);
  });

  test("an outage before the first confirmed close: the first request anchors the earliest expected minute and catch-up continues from it", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE, finalizeGraceMs: 1000 });
    const P = T0 + MINUTE;
    const C = T0 + 2 * MINUTE;
    // Subscribed half a second into C: P is inside its grace, nothing can be confirmed yet.
    expect(cursor.nextRequest(C + 500)).toEqual({ startTime: P, limit: 2, catchUp: false });
    expect(cursor.anchorOpenTime).toBe(P);
    const first = cursor.apply({ rows: rows(rawRow(P), rawRow(C)), exchangeNowMs: C + 500, seq: 1 });
    expect(first.covered).toBe(true);
    expect(first.emit.map(({ row, closed }) => [(row.openTime - T0) / MINUTE, closed])).toEqual([[1, false], [2, false]]);
    expect(cursor.confirmedOpenTime).toBeNull();
    expect(cursor.continuationOpenTime).toBe(P);
    // Polling pauses for five minutes; the next request must go back to P, not to the current two bars.
    const later = C + 5 * MINUTE + 30_000;
    expect(cursor.needsCatchUp(later)).toBe(true);
    expect(cursor.nextRequest(later)).toEqual({ startTime: P, limit: 1000, catchUp: true });
    const page = cursor.apply({ rows: rows(...Array.from({ length: 7 }, (_, i) => rawRow(P + i * MINUTE))), exchangeNowMs: later, seq: 2 });
    expect(page.emit.map(({ row, closed }) => [(row.openTime - T0) / MINUTE, closed])).toEqual([[1, true], [2, true], [3, true], [4, true], [5, true], [6, true], [7, false]]);
    expect(cursor.confirmedOpenTime).toBe(C + 4 * MINUTE);
    expect(page.catchingUp).toBe(false);
    // A page that starts past the anchor is a hole from the anchor, not a skip.
    const other = createBinanceRestBarCursor({ intervalMs: MINUTE });
    other.nextRequest(C + 500);
    const hole = other.apply({ rows: rows(rawRow(C + 2 * MINUTE)), exchangeNowMs: C + 3 * MINUTE, seq: 1 });
    expect(hole.hole).toEqual({ fromOpenTime: P, toOpenTime: C + MINUTE });
    expect(other.continuationOpenTime).toBe(P);
    // An empty page or one with only confirmed candles is not coverage.
    expect(cursor.apply({ rows: [], exchangeNowMs: later, seq: 3 }).covered).toBe(false);
    expect(cursor.apply({ rows: rows(rawRow(P), rawRow(C)), exchangeNowMs: later, seq: 4 }).covered).toBe(false);
    expect(cursor.confirmedOpenTime).toBe(C + 4 * MINUTE);
    cursor.reset();
    expect(cursor.anchorOpenTime).toBeNull();
  });

  test("a recoverable hole: a page starting past the continuation keeps the cursor on the first missing minute and asks again until the exchange supplies it", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE, maxHoleRetries: 3 });
    cursor.apply({ rows: rows(rawRow(T0)), exchangeNowMs: T0 + 10 * MINUTE, seq: 1 });
    const withHole = () => rows(rawRow(T0 + 3 * MINUTE), rawRow(T0 + 4 * MINUTE));
    const first = cursor.apply({ rows: withHole(), exchangeNowMs: T0 + 10 * MINUTE, seq: 2 });
    expect(first.hole).toEqual({ fromOpenTime: T0 + MINUTE, toOpenTime: T0 + 2 * MINUTE });
    expect(first.emit).toEqual([]);
    expect(first.repairing).toBe(true);
    expect(first.catchingUp).toBe(true);
    expect(cursor.confirmedOpenTime).toBe(T0);
    expect(cursor.nextRequest(T0 + 10 * MINUTE)).toEqual({ startTime: T0 + MINUTE, limit: 1000, catchUp: true });
    const second = cursor.apply({ rows: withHole(), exchangeNowMs: T0 + 10 * MINUTE, seq: 3 });
    expect(second.hole).not.toBeNull();
    expect(second.abandoned).toBeNull();
    expect(cursor.confirmedOpenTime).toBe(T0);
    const supplied = cursor.apply({ rows: rows(rawRow(T0 + MINUTE), rawRow(T0 + 2 * MINUTE), rawRow(T0 + 3 * MINUTE)), exchangeNowMs: T0 + 10 * MINUTE, seq: 4 });
    expect(supplied.hole).toBeNull();
    expect(supplied.repairing).toBe(false);
    expect(supplied.emit.map(({ row }) => (row.openTime - T0) / MINUTE)).toEqual([1, 2, 3]);
    expect(cursor.missing).toEqual([]);
    expect(cursor.missingBars()).toBe(0);
    expect(cursor.stats).toMatchObject({ holes: 1, holeRetries: 0, missingBars: 0 });
  });

  test("an irrecoverable hole: after the bounded retries the interval is recorded as missing, the cursor moves past it and the candles the exchange has are delivered", () => {
    expect(DEFAULT_MAX_HOLE_RETRIES).toBe(3);
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE });
    cursor.apply({ rows: rows(rawRow(T0)), exchangeNowMs: T0 + 10 * MINUTE, seq: 1 });
    const withHole = () => rows(rawRow(T0 + 3 * MINUTE), rawRow(T0 + 4 * MINUTE));
    expect(cursor.apply({ rows: withHole(), exchangeNowMs: T0 + 10 * MINUTE, seq: 2 }).abandoned).toBeNull();
    expect(cursor.apply({ rows: withHole(), exchangeNowMs: T0 + 10 * MINUTE, seq: 3 }).abandoned).toBeNull();
    const third = cursor.apply({ rows: withHole(), exchangeNowMs: T0 + 10 * MINUTE, seq: 4 });
    expect(third.abandoned).toEqual({ fromOpenTime: T0 + MINUTE, toOpenTime: T0 + 2 * MINUTE });
    expect(third.repairing).toBe(false);
    expect(third.emit.map(({ row, closed }) => [(row.openTime - T0) / MINUTE, closed])).toEqual([[3, true], [4, true]]);
    expect(cursor.confirmedOpenTime).toBe(T0 + 4 * MINUTE);
    expect(cursor.missing).toEqual([{ fromOpenTime: T0 + MINUTE, toOpenTime: T0 + 2 * MINUTE }]);
    expect(cursor.missingBars()).toBe(2);
    expect(cursor.stats).toMatchObject({ holes: 1, missingBars: 2 });
    // A different hole later starts its own retry count.
    const other = cursor.apply({ rows: rows(rawRow(T0 + 7 * MINUTE)), exchangeNowMs: T0 + 10 * MINUTE, seq: 5 });
    expect(other.hole).toEqual({ fromOpenTime: T0 + 5 * MINUTE, toOpenTime: T0 + 6 * MINUTE });
    expect(other.abandoned).toBeNull();
    expect(cursor.stats.holes).toBe(2);
    cursor.reset();
    expect(cursor.confirmedOpenTime).toBeNull();
    expect(cursor.repairing).toBeNull();
    expect(() => createBinanceRestBarCursor({ intervalMs: 0 })).toThrow(/intervalMs/);
    expect(() => createBinanceRestBarCursor({ intervalMs: MINUTE, maxHoleRetries: 0 })).toThrow(/maxHoleRetries/);
  });
});
