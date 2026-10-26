import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../types/frames";
import {
  MAX_RETAINED_SOURCE_BARS,
  admitSourceBar,
  fullBarBuffer,
  latestSourceBar,
  replaceClosedBars,
  sourceBarsForBucket,
} from "../candleLifecycle";
import { resampleBars } from "../resampleBars";

function bar(tsOpen: number, closed: boolean, close = 100): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
    interval_ms: 60_000, ts_open: tsOpen, open: 100, high: Math.max(100, close),
    low: Math.min(100, close), close, volume: 1, trade_count: 1, closed,
  };
}

describe("candleLifecycle", () => {
  it("deduplicates, orders, closes-only and bounds an authoritative snapshot", () => {
    const input = Array.from({ length: MAX_RETAINED_SOURCE_BARS + 2 }, (_, index) => bar(index * 60_000, true));
    input.push(bar(120_000, true, 999), bar((MAX_RETAINED_SOURCE_BARS + 3) * 60_000, false));
    const result = replaceClosedBars(input);
    expect(result).toHaveLength(MAX_RETAINED_SOURCE_BARS);
    expect(result[0].ts_open).toBe(2 * 60_000);
    expect(result.find((candidate) => candidate.ts_open === 120_000)?.close).toBe(999);
    expect(result.every((candidate) => candidate.closed)).toBe(true);
  });

  it("reserves one retained slot for the developing edge at maximum history", () => {
    const closed = Array.from({ length: MAX_RETAINED_SOURCE_BARS }, (_, index) => bar(index * 60_000, true));
    const developing = bar(MAX_RETAINED_SOURCE_BARS * 60_000, false);
    const buffer = fullBarBuffer(closed, developing);
    expect(buffer).toHaveLength(MAX_RETAINED_SOURCE_BARS);
    expect(buffer[0].ts_open).toBe(60_000);
    expect(buffer.at(-1)).toBe(developing);
  });

  it("selects only the affected source bucket with binary boundaries, including its developing edge", () => {
    const closed = Array.from({ length: 20 }, (_, index) => bar(index * 60_000, true));
    const developing = bar(20 * 60_000, false);
    expect(sourceBarsForBucket(closed, developing, 15 * 60_000, 5 * 60_000).map((candidate) => candidate.ts_open))
      .toEqual([15, 16, 17, 18, 19].map((minute) => minute * 60_000));
    expect(sourceBarsForBucket(closed, developing, 20 * 60_000, 5 * 60_000).map((candidate) => candidate.ts_open))
      .toEqual([20 * 60_000]);
  });

  it("keeps the newer developing candle when a delayed prior close arrives", () => {
    const closed = [bar(0, true)];
    const developing = bar(120_000, false, 103);
    const result = admitSourceBar(closed, developing, bar(60_000, true, 102));
    expect(result).toEqual({ accepted: true, developingBar: developing });
    expect(latestSourceBar(closed, result.developingBar)).toBe(developing);
    expect(fullBarBuffer(closed, result.developingBar).map((candidate) => candidate.ts_open)).toEqual([0, 60_000, 120_000]);
  });

  it("never reopens an already finalized candle", () => {
    const closed = [bar(0, true), bar(60_000, true)];
    const delayedOpen = bar(60_000, false, 999);
    expect(admitSourceBar(closed, null, delayedOpen)).toEqual({
      accepted: false,
      developingBar: null,
      rejection: "FINALIZED_BAR_CANNOT_REOPEN",
    });
    expect(closed[1].close).not.toBe(999);
  });

  it("rejects an older developing update without moving the live edge backwards", () => {
    const current = bar(120_000, false, 103);
    expect(admitSourceBar([bar(0, true)], current, bar(60_000, false, 102))).toEqual({
      accepted: false,
      developingBar: current,
      rejection: "STALE_DEVELOPING_BAR",
    });
  });

  it("finalizes the matching developing candle and accepts later closed corrections", () => {
    const closed = [bar(0, true)];
    const finalized = admitSourceBar(closed, bar(60_000, false), bar(60_000, true, 105));
    expect(finalized.developingBar).toBeNull();
    const corrected = admitSourceBar(closed, null, bar(0, true, 97));
    expect(corrected.accepted).toBe(true);
    expect(closed.map((candidate) => candidate.close)).toEqual([97, 105]);
  });

  it("converges to the same higher-timeframe candle from snapshot history or open/close live updates", () => {
    const finalBars = Array.from({ length: 10 }, (_, index) => bar(index * 60_000, true, 100 + index));
    const streamedClosed: BarFrame[] = [];
    let developing: BarFrame | null = null;
    for (const finalBar of finalBars) {
      const openUpdate = { ...finalBar, close: finalBar.open, closed: false };
      developing = admitSourceBar(streamedClosed, developing, openUpdate).developingBar;
      developing = admitSourceBar(streamedClosed, developing, finalBar).developingBar;
    }
    expect(developing).toBeNull();
    expect(resampleBars(fullBarBuffer(streamedClosed, developing), 300_000)).toEqual(resampleBars(finalBars, 300_000));

    admitSourceBar(streamedClosed, null, bar(120_000, true, 150));
    const correctedHistory = finalBars.map((candidate) => candidate.ts_open === 120_000 ? bar(120_000, true, 150) : candidate);
    expect(resampleBars(streamedClosed, 300_000)).toEqual(resampleBars(correctedHistory, 300_000));
  });
});
