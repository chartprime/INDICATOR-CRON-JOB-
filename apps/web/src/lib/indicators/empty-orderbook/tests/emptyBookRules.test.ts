import { describe, expect, it } from "vitest";
import type { Identity } from "../../liquidity-voids/liquidityVoidsRules";
import { bandSizes } from "../../passive-liquidity/liquidityGrid";
import { DEFAULT_EMPTY_BOOK_RULES } from "../emptyBookModel";
import { MIN_ZONE_ROWS, emptyBookRulesFor, minRowsOf } from "../emptyBookRules";

const NQ: Identity = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };
const ES: Identity = { provider: "DXFEED", symbol: "/ESZ26:XCME", assetClass: "FUTURE" };
const BTC: Identity = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" };
const ETH: Identity = { provider: "BINANCE", symbol: "ETH-USDT", marketKind: "SPOT" };
const M1 = 60_000;

describe("empty book rules", () => {
  it("turns the sensitivity into a minimum height in heatmap rows: BTC 70 / 50 / 30 USD over 8 USD rows", () => {
    expect(minRowsOf({ sensitivity: "low" }, BTC, 110_000, M1, 4, 2)).toBe(9);
    expect(minRowsOf({ sensitivity: "normal" }, BTC, 110_000, M1, 4, 2)).toBe(6);
    expect(minRowsOf({ sensitivity: "high" }, BTC, 110_000, M1, 4, 2)).toBe(4);
  });

  it("counts futures in ticks: NQ Normal is 37 ticks, three rows of 2.75 points; ES Normal is 10 ticks, three rows of a point", () => {
    expect(minRowsOf({ sensitivity: "normal" }, NQ, 31_000, M1, 0.25, 11)).toBe(3);
    expect(minRowsOf({ sensitivity: "normal" }, ES, 6_900, M1, 0.25, 4)).toBe(3);
  });

  it("scales the minimum height with the timeframe like Order Flow Gaps, over that timeframe's rows", () => {
    expect(minRowsOf({ sensitivity: "normal" }, BTC, 110_000, 15 * M1, 4, 6)).toBe(5);
    expect(minRowsOf({ sensitivity: "normal" }, BTC, 110_000, 15 * M1, 4, 2)).toBe(14);
  });

  it("never asks for fewer than two rows, whatever the row size", () => {
    expect(MIN_ZONE_ROWS).toBe(2);
    expect(minRowsOf({ sensitivity: "normal" }, ETH, 2_700, M1, 0.14, 8)).toBe(2);
    expect(minRowsOf({ sensitivity: "normal" }, BTC, 110_000, M1, 0, 2)).toBe(2);
  });

  it("builds the model's rules from the heatmap's row size and the minimum height, on the fixed numbers", () => {
    expect(emptyBookRulesFor(2.9, 6.9, bandSizes)).toEqual({ ...DEFAULT_EMPTY_BOOK_RULES, clusterRows: 2, minRows: 6, bandSizes });
    expect(emptyBookRulesFor(0, 0, bandSizes)).toMatchObject({ clusterRows: 1, minRows: 1 });
    expect(emptyBookRulesFor(2, 1, bandSizes).minRows).toBe(1);
    expect(emptyBookRulesFor(2, 6, bandSizes, 1.9).clearRows).toBe(1);
    expect(emptyBookRulesFor(2, 6, bandSizes, 0).clearRows).toBe(0);
    expect(emptyBookRulesFor(2, 6, bandSizes, -3).clearRows).toBe(0);
    expect(emptyBookRulesFor(2, 6, bandSizes, Number.NaN).clearRows).toBe(4);
    expect(emptyBookRulesFor(2, 6, bandSizes, 4, 0.5).thinShare).toBe(0.5);
    expect(emptyBookRulesFor(2, 6, bandSizes, 4).thinShare).toBe(0.75);
    expect(emptyBookRulesFor(2, 6, bandSizes, 4, 0).thinShare).toBe(0.75);
    expect(emptyBookRulesFor(2, 6, bandSizes, 4, Number.NaN).thinShare).toBe(0.75);
    expect(emptyBookRulesFor(2, 6, bandSizes, 4, 0.5, 1.5).refillMultiple).toBe(1.5);
    expect(emptyBookRulesFor(2, 6, bandSizes, 4, 0.5).refillMultiple).toBe(1);
    expect(emptyBookRulesFor(2, 6, bandSizes, 4, 0.75, 0.5).refillMultiple).toBe(0.75);
    expect(emptyBookRulesFor(2, 6, bandSizes, 4, 0.5, Number.NaN).refillMultiple).toBe(1);
    expect(DEFAULT_EMPTY_BOOK_RULES).toEqual({ thinShare: 0.75, refillMultiple: 1, averageMs: 120_000, rejoinMs: 15_000, showMs: 30_000, flashMs: 3_000, gapMs: 30_000, typicalBp: 50, reachBp: Infinity, clearRows: 4 });
  });
});
