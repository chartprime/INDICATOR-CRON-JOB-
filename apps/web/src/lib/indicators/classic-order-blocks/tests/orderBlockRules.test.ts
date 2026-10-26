import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORDER_BLOCK_SETTINGS,
  DEFAULT_PIVOT_LENGTH,
  DEFAULT_WIDTH_MULTIPLIER,
  DEFAULT_MAX_ORDER_BLOCKS,
  MAX_STORED_PIVOTS,
  ORDER_BLOCK_SETTINGS_SCHEMA,
  SECONDARY_LEFT_BARS,
  ZONE_WIDTH_LENGTH,
  baseOf,
  breaks,
  mitigates,
  zoneFor,
  type OrderBlock,
} from "../orderBlockRules";

/** A whole candle, so a case can show the wick it ignores as well as the close it reads. */
const candle = (high: number, low: number, close: number) => ({
  high,
  low,
  close,
});

const block = (
  side: OrderBlock["side"],
  top: number,
  bottom: number,
): OrderBlock => ({
  side,
  tier: "primary",
  pivotTime: 1,
  baseTime: 1,
  breakTime: 2,
  top,
  bottom,
  mitigatedTime: null,
  volume: 100,
});

describe("the numbers", () => {
  it("keeps Prime Blocks' formation inputs, a 7-bar structure pivot and a 1-bar left shoulder on the secondary tier over a 100-bar average range, and the trader's zone height of one full range", () => {
    expect(DEFAULT_PIVOT_LENGTH).toBe(7);
    expect(SECONDARY_LEFT_BARS).toBe(1);
    expect(ZONE_WIDTH_LENGTH).toBe(100);
    // The reference draws 0.7 of the average range; the trader set 1 on 2026-09-16 after the first live look.
    expect(DEFAULT_WIDTH_MULTIPLIER).toBe(1);
    expect(DEFAULT_MAX_ORDER_BLOCKS).toBe(10);
    expect(MAX_STORED_PIVOTS).toBe(32);
  });

  it("starts every chart on the trader's settings of 2026-09-16: older structure breakable, secondary and mitigated blocks hidden", () => {
    expect(DEFAULT_ORDER_BLOCK_SETTINGS).toEqual({
      pivotLength: 7,
      widthMultiplier: 1,
      maxBlocks: 10,
      stackPivots: true,
      showSecondary: false,
      showMitigated: false,
      bullishColor: "#3b82f6",
      bearishColor: "#ef4444",
    });
  });

  it("replays history for every input, because a box is not a line and the cosmetic path cannot repaint one", () => {
    // The runtime restyles a cosmetic change through LineOutputSpec.recolor. This indicator has no lines, so
    // recolorAll finds nothing to do and returns without a replay: the boxes then keep whatever the last onBar
    // drew until another bar arrives. Every field here has to ask for a replay or the toggle does nothing.
    const affects = Object.fromEntries(
      ORDER_BLOCK_SETTINGS_SCHEMA.flatMap((field) =>
        "key" in field ? [[field.key, field.affects]] : [],
      ),
    );
    expect(affects).toEqual({
      pivotLength: "recompute",
      widthMultiplier: "recompute",
      maxBlocks: "recompute",
      stackPivots: "recompute",
      showSecondary: "recompute",
      showMitigated: "recompute",
      bullishColor: "recompute",
      bearishColor: "recompute",
    });
    const hint = ORDER_BLOCK_SETTINGS_SCHEMA.find(
      (field) => field.kind === "staticHint",
    );
    expect(hint && "text" in hint ? hint.text : "").toContain(
      "closes through it, beyond its far edge",
    );
  });
});

describe("zoneFor and baseOf", () => {
  it("builds a bullish zone up from its base and a bearish one down from it, and reads the base back", () => {
    expect(zoneFor("bullish", 100, 3)).toEqual({ top: 103, bottom: 100 });
    expect(zoneFor("bearish", 100, 3)).toEqual({ top: 100, bottom: 97 });
    expect(baseOf(block("bullish", 103, 100))).toBe(100);
    expect(baseOf(block("bearish", 100, 97))).toBe(100);
  });
});

describe("breaks", () => {
  it("is a close beyond the swing, never a touch of it", () => {
    expect(breaks("bullish", 20, 20.01)).toBe(true);
    expect(breaks("bullish", 20, 20)).toBe(false);
    expect(breaks("bearish", 20, 19.99)).toBe(true);
    expect(breaks("bearish", 20, 20)).toBe(false);
  });
});

describe("mitigates", () => {
  it("is a candle closing through the zone, beyond its far edge: not a wick through it, not a close inside it, not a close on the edge", () => {
    // The trader's meaning of 2026-09-17: a wall is spent when it broke, and it broke when price closed past it.
    const bull = block("bullish", 103, 100);
    expect(mitigates(bull, candle(105, 98, 99.99))).toBe(true);
    expect(mitigates(bull, candle(105, 98, 100))).toBe(false);
    expect(mitigates(bull, candle(105, 98, 101))).toBe(false);
    expect(mitigates(bull, candle(105, 98, 104))).toBe(false);
    const bear = block("bearish", 100, 97);
    expect(mitigates(bear, candle(102, 95, 100.01))).toBe(true);
    expect(mitigates(bear, candle(102, 95, 100))).toBe(false);
    expect(mitigates(bear, candle(102, 95, 99))).toBe(false);
    expect(mitigates(bear, candle(102, 95, 96))).toBe(false);
  });
});
