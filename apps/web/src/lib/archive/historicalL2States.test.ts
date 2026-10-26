import { describe, expect, it } from "vitest";
import { HistoricalL2States, historicalSecondsAt } from "./historicalL2States";
import { HISTORICAL_L2_PROFILES, type HistoricalL2Row } from "./historicalL2Client";

const instrument = HISTORICAL_L2_PROFILES[0], derivation = "a".repeat(64), segment = "b".repeat(64);
function coverage(position = "0", overrides: Record<string, unknown> = {}): HistoricalL2Row {
  return { schema: "historical-l2-second/1", family: "l2_level_state_1s", instrument_id: instrument,
    derivation_id: derivation, append_position: position, known_ns: "2000000000", known_key: ["2000000000", "2", "5", "0"],
    payload: { row_kind: "coverage", open_ns: "1000000000", close_ns: "2000000000", covered_from_ns: "1000000000",
      complete: true, point_prefix: false, trusted: true, segment_id: segment, reason: "OBSERVED_PREFIX",
      tick_size: "0.25", depth_limit: 10, bid_range: [396, 400], ask_range: [404, 408],
      flow: { BUY: 3, SELL: 0, UNKNOWN: 2, count: 2 }, ...overrides } };
}
function level(): HistoricalL2Row {
  const row = coverage("1");
  return { ...row, payload: { ...row.payload, row_kind: "level", price_key: 404,
    bid_size: null, ask_size: 9, buy_volume: 3, sell_volume: 0 } };
}
const model = () => new HistoricalL2States(instrument, derivation, "0.25");

describe("streamed historical book display states", () => {
  it("folds a header and levels split between pages without retaining raw rows", () => {
    const builder = model();
    builder.push([coverage()]);
    builder.push([level()]);
    const seconds = builder.finish();
    expect(seconds).toHaveLength(1);
    const column = seconds[0].column!;
    expect(column.ts).toBe(1000);
    expect(column.bid[0]).toBe(0);
    expect(column.bid[8]).toBeNaN();
    expect(column.ask[0]).toBeNaN();
    expect(column.ask[8]).toBe(9);
    expect(column.buy).toEqual([[404, 3]]);
    expect(seconds[0].flow.UNKNOWN).toBe(2);
    expect(builder.finish()).toEqual(seconds);
    expect(() => builder.push([])).toThrow("sealed");
  });

  it("keeps partial intervals and gaps explicit without inventing full columns", () => {
    const builder = model();
    builder.push([coverage("0", { close_ns: "1500000000", complete: false })]);
    builder.push([{ ...coverage("1", { trusted: false, segment_id: null, reason: "SOURCE_GAP" }), known_key: null }]);
    const seconds = builder.finish();
    expect(seconds.every((second) => second.column === null)).toBe(true);
    expect(seconds.map((second) => second.reason)).toEqual(["OBSERVED_PREFIX", "SOURCE_GAP"]);
  });

  it("applies knowledge time and exact source-prefix cuts independently", () => {
    const builder = model();
    builder.push([{ ...coverage(), known_ns: "2500000000" }]);
    const seconds = builder.finish();
    expect(historicalSecondsAt(seconds, "2000000000")).toHaveLength(0);
    expect(historicalSecondsAt(seconds, "2500000000", ["2000000000", "2", "4", "0"])).toHaveLength(0);
    expect(historicalSecondsAt(seconds, "2500000000", ["2000000000", "2", "5", "0"])).toHaveLength(1);
  });

  it.each([
    { tick_size: "0.5" }, { bid_range: [0, 10000] }, { close_ns: "3000000000" },
    { complete: false }, { segment_id: null }, { flow: { BUY: -1 } },
  ])("refuses invalid geometry, coverage and allocation: %j", (overrides) => {
    const builder = model();
    builder.push([coverage("0", overrides)]);
    expect(() => builder.finish()).toThrow();
  });

  it("refuses orphan, duplicate, reordered and falsely zero-filled levels", () => {
    expect(() => model().push([level()])).toThrow("header");
    const duplicate = model();
    duplicate.push([coverage(), level(), { ...level(), append_position: "2" }]);
    expect(() => duplicate.finish()).toThrow("level");
    const order = model();
    order.push([coverage()]);
    expect(() => order.push([coverage()])).toThrow("order");
    const zero = model();
    zero.push([coverage(), { ...level(), payload: { ...level().payload, bid_size: 0 } }]);
    expect(() => zero.finish()).toThrow("unknown/zero");
  });
});
