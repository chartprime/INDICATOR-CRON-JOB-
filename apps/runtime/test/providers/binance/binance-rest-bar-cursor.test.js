const { createBinanceRestBarCursor } = require("../../../src/providers/binance/binance-rest-bar-cursor");
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
    expect(page.hole).toBe(false);
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

  test("a hole the exchange left is reported, never filled, and the cursor moves past it", () => {
    const cursor = createBinanceRestBarCursor({ intervalMs: MINUTE });
    cursor.apply({ rows: rows(rawRow(T0)), exchangeNowMs: T0 + 10 * MINUTE, seq: 1 });
    const outcome = cursor.apply({ rows: rows(rawRow(T0 + 3 * MINUTE), rawRow(T0 + 4 * MINUTE)), exchangeNowMs: T0 + 10 * MINUTE, seq: 2 });
    expect(outcome.hole).toBe(true);
    expect(outcome.emit).toHaveLength(2);
    expect(cursor.stats).toMatchObject({ confirmedOpenTime: T0 + 4 * MINUTE, holes: 1 });
    cursor.reset();
    expect(cursor.confirmedOpenTime).toBeNull();
    expect(() => createBinanceRestBarCursor({ intervalMs: 0 })).toThrow(/intervalMs/);
  });
});
