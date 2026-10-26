import { describe, expect, it } from "vitest";
import {
  ArchiveCandleError,
  archiveCandle,
  archiveCandles,
} from "./archiveCandles";

function row(overrides: Record<string, unknown> = {}) {
  return {
    open_ns: "1756684800000000000",
    close_ns: "1756684860000000000",
    open: "100.25",
    high: "101.5",
    low: "99.75",
    close: "100.75",
    volume: "42.5",
    ...overrides,
  };
}

describe("archiveCandles", () => {
  it("converts exact archive strings without parsing nanoseconds through Number", () => {
    expect(archiveCandle(row())).toEqual({
      openMs: 1_756_684_800_000,
      closeMs: 1_756_684_860_000,
      open: 100.25,
      high: 101.5,
      low: 99.75,
      close: 100.75,
      volume: 42.5,
    });
  });

  it("refuses invalid candle economics rather than silently drawing them", () => {
    expect(() => archiveCandle(row({ low: "101" }))).toThrow(ArchiveCandleError);
  });

  it("refuses a duplicate or reversed archive ordering", () => {
    expect(() => archiveCandles([row(), row()])).toThrow("not strictly ordered");
  });
});
