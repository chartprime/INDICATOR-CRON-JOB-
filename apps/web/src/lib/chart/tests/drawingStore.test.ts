import { describe, expect, it } from "vitest";
import {
  DRAWINGS_STORAGE_KEY,
  MAX_DRAWINGS_PER_INSTRUMENT,
  addDrawing,
  drawingsForInstrument,
  instrumentKey,
  loadDrawings,
  removeDrawing,
  saveDrawings,
  type DrawnObject,
} from "../drawingStore";

function trendline(overrides: Partial<DrawnObject> = {}): DrawnObject {
  return {
    id: "d1",
    type: "trendline",
    points: [
      { time: 1_700_000_000, price: 50_000 },
      { time: 1_700_000_600, price: 51_000 },
    ],
    provider: "BINANCE",
    marketKind: "SPOT",
    symbol: "BTC-USDT",
    ...overrides,
  } as DrawnObject;
}

describe("loadDrawings / saveDrawings", () => {
  it("round-trips a saved drawing through localStorage", () => {
    saveDrawings([trendline()]);
    expect(loadDrawings()).toEqual([trendline()]);
  });

  it("returns an empty array when nothing has been saved yet", () => {
    expect(loadDrawings()).toEqual([]);
  });

  it("falls back to an empty array instead of throwing on corrupted JSON", () => {
    localStorage.setItem(DRAWINGS_STORAGE_KEY, "not valid json{{{");
    expect(() => loadDrawings()).not.toThrow();
    expect(loadDrawings()).toEqual([]);
  });

  it("returns an empty array when the stored value isn't an array", () => {
    localStorage.setItem(DRAWINGS_STORAGE_KEY, JSON.stringify({ id: "d1" }));
    expect(loadDrawings()).toEqual([]);
  });

  it("drops only the malformed entries, keeping the valid ones", () => {
    const good = trendline({ id: "good" });
    const badPoints = { ...trendline({ id: "bad-points" }), points: [{ time: 1, price: -5 }, { time: 2, price: 10 }] };
    const badIdentity = { ...trendline({ id: "bad-identity" }), marketKind: "SPOT", assetClass: "FUTURE" };
    const badType = { ...trendline({ id: "bad-type" }), type: "circle" };
    const missingId = { ...trendline(), id: undefined };
    localStorage.setItem(
      DRAWINGS_STORAGE_KEY,
      JSON.stringify([good, badPoints, badIdentity, badType, missingId]),
    );
    expect(loadDrawings()).toEqual([good]);
  });

  it("truncates an over-cap instrument's entries from tampered storage rather than trusting it", () => {
    const overCap = Array.from({ length: MAX_DRAWINGS_PER_INSTRUMENT + 1 }, (_, i) => trendline({ id: `d${i}` }));
    localStorage.setItem(DRAWINGS_STORAGE_KEY, JSON.stringify(overCap));
    expect(loadDrawings()).toHaveLength(MAX_DRAWINGS_PER_INSTRUMENT);
  });
});

describe("instrumentKey / drawingsForInstrument", () => {
  it("treats the same symbol on different market kinds as different instruments", () => {
    const spot = trendline({ id: "spot", marketKind: "SPOT" });
    const perp = trendline({ id: "perp", marketKind: "PERPETUAL" });
    expect(instrumentKey(spot)).not.toBe(instrumentKey(perp));
    expect(drawingsForInstrument([spot, perp], spot)).toEqual([spot]);
  });

  it("treats the same symbol on different providers as different instruments", () => {
    const binance = trendline({ id: "b" });
    const dxfeed = {
      ...trendline({ id: "d" }),
      provider: "DXFEED",
      marketKind: undefined,
      assetClass: "EQUITY",
      symbol: "AAPL",
    } as DrawnObject;
    expect(drawingsForInstrument([binance, dxfeed], binance)).toEqual([binance]);
    expect(drawingsForInstrument([binance, dxfeed], dxfeed)).toEqual([dxfeed]);
  });
});

describe("addDrawing / removeDrawing", () => {
  it("adds a drawing and reports success", () => {
    const { drawings, added } = addDrawing([], trendline());
    expect(added).toBe(true);
    expect(drawings).toEqual([trendline()]);
  });

  it("refuses to add past the per-instrument cap, leaving the array unchanged", () => {
    const atCap = Array.from({ length: MAX_DRAWINGS_PER_INSTRUMENT }, (_, i) => trendline({ id: `d${i}` }));
    const { drawings, added } = addDrawing(atCap, trendline({ id: "overflow" }));
    expect(added).toBe(false);
    expect(drawings).toHaveLength(MAX_DRAWINGS_PER_INSTRUMENT);
  });

  it("still allows an add for a different instrument once one instrument is at cap", () => {
    const atCap = Array.from({ length: MAX_DRAWINGS_PER_INSTRUMENT }, (_, i) => trendline({ id: `d${i}` }));
    const otherInstrument = trendline({ id: "eth", symbol: "ETH-USDT" });
    const { added } = addDrawing(atCap, otherInstrument);
    expect(added).toBe(true);
  });

  it("removes only the matching id", () => {
    const a = trendline({ id: "a" });
    const b = trendline({ id: "b" });
    expect(removeDrawing([a, b], "a")).toEqual([b]);
  });
});
