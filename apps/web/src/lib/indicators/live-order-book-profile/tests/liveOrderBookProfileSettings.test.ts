// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_LIQUIDITY_SETTINGS, clusterRowsFor } from "../../passive-liquidity/liquiditySettings";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, MAX_RESTING_SHARE, MAX_RESTING_STAND_S, MIN_RESTING_SHARE, MIN_RESTING_STAND_S, ROW_FACTOR_CHOICES, clusterRowsOf, restingSizeRange } from "../liveOrderBookProfileSettings";
import { RESTING_MULTIPLE, RESTING_STAND_MS } from "../restingOrders";
import { RESTING_REACH_MS } from "../liveOrderBookProfilePrimitive";

const HOUR = 3_600_000;

describe("Live Order Book Profile settings", () => {
  it("starts on the heatmap's bands and its colours", () => {
    expect(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS.rowFactor).toBe(0);
    expect(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS.bidColor).toBe(DEFAULT_LIQUIDITY_SETTINGS.bidColor);
    expect(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS.askColor).toBe(DEFAULT_LIQUIDITY_SETTINGS.askColor);
    expect(ROW_FACTOR_CHOICES[0]).toBe(0);
  });

  it("shows big resting orders by default at three times the book's typical row, the biggest bar a fifth of the chart long", () => {
    expect(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS.showResting).toBe(true);
    expect(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS.restingMinSize).toBe(0);
    expect(RESTING_MULTIPLE).toBe(3);
    expect(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS.restingShare).toBe(0.2);
    expect(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS.restingStandS).toBe(30);
    expect(RESTING_STAND_MS).toBe(30_000);
    expect([MIN_RESTING_STAND_S, MAX_RESTING_STAND_S]).toEqual([3, 120]);
    expect(restingSizeRange(0)).toEqual({ max: 100, step: 1 });
    expect(restingSizeRange(9)).toEqual({ max: 200, step: 1 });
    expect(restingSizeRange(30)).toEqual({ max: 500, step: 1 });
    expect(restingSizeRange(85)).toEqual({ max: 2_000, step: 10 });
    expect(restingSizeRange(500)).toEqual({ max: 10_000, step: 10 });
    expect(restingSizeRange(0.4)).toEqual({ max: 10, step: 1 });
    expect([MIN_RESTING_SHARE, MAX_RESTING_SHARE]).toEqual([0.01, 0.5]);
    expect(RESTING_REACH_MS).toBe(15 * 60_000);
  });

  it("reads the heatmap's cluster for the timeframe on Auto, and the trader's own rows otherwise", () => {
    const heatmap = { clusterRows: 3 };
    expect(clusterRowsOf({ rowFactor: 0 }, heatmap, 60_000)).toBe(3);
    expect(clusterRowsOf({ rowFactor: 0 }, heatmap, HOUR)).toBe(clusterRowsFor(heatmap, HOUR));
    expect(clusterRowsOf({ rowFactor: 0 }, heatmap, HOUR)).toBe(24);
    expect(clusterRowsOf({ rowFactor: 4 }, heatmap, HOUR)).toBe(4);
    expect(clusterRowsOf({ rowFactor: 4.9 }, heatmap, 60_000)).toBe(4);
  });
});
