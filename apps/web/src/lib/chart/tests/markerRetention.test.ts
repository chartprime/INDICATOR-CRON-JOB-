import { describe, expect, it } from "vitest";
import type { MarkerFrame } from "../../../types/frames";
import {
  createTimeCoveredMarkerRetentionBuffer,
  retainTimeCoveredMarkers,
} from "../markerRetention";

function marker(tradeId: string, magnitude: number, tsExchange: number): MarkerFrame {
  return { type: "marker", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", ts_exchange: tsExchange, price: 1, size: magnitude, side: "buy", trade_id: tradeId };
}

describe("retainTimeCoveredMarkers", () => {
  it("keeps temporal coverage while selecting the strongest marker within each minute and side", () => {
    const items = [
      marker("old-weak", 10, 1_000),
      marker("old-strong", 100, 2_000),
      { ...marker("old-sell", 50, 3_000), side: "sell" as const },
      marker("next-minute", 5, 61_000),
    ];
    expect(retainTimeCoveredMarkers(items, 10, 60_000, 1).map((item) => item.trade_id)).toEqual([
      "old-strong", "old-sell", "next-minute",
    ]);
  });

  it("keeps the stronger cold-start print even when the weaker print is newer in the same bucket", () => {
    const retained = retainTimeCoveredMarkers([
      marker("older-strong", 100, 1_000),
      marker("newer-weak", 10, 2_000),
    ], 10, 60_000, 1);
    expect(retained.map((item) => item.trade_id)).toEqual(["older-strong"]);
  });

  it("evicts oldest covered time first at the global cap, not a newer lower-notional marker", () => {
    const retained = retainTimeCoveredMarkers([
      marker("old-huge", 1_000_000, 1_000),
      marker("middle", 10, 61_000),
      marker("new", 1, 121_000),
    ], 2);
    expect(retained.map((item) => item.trade_id)).toEqual(["middle", "new"]);
  });
});

describe("createTimeCoveredMarkerRetentionBuffer", () => {
  it("feeding markers one flush-batch at a time matches feeding them all at once", () => {
    const markers = [
      marker("old-weak", 10, 1_000),
      marker("old-strong", 100, 2_000),
      { ...marker("old-sell", 50, 3_000), side: "sell" as const },
      marker("next-minute", 5, 61_000),
    ];
    const oneShot = createTimeCoveredMarkerRetentionBuffer(10, 60_000, 1);
    oneShot.insertAll(markers);

    const incremental = createTimeCoveredMarkerRetentionBuffer(10, 60_000, 1);
    for (const item of markers) incremental.insertAll([item]);

    expect(incremental.snapshot()).toEqual(oneShot.snapshot());
  });

  it("a bucket-side eviction followed by a global-cap eviction still finds the true oldest survivor", () => {
    const buffer = createTimeCoveredMarkerRetentionBuffer(2, 60_000, 1);
    buffer.insertAll([marker("minute-0-weak", 10, 1_000)]);
    buffer.insertAll([marker("minute-0-strong", 100, 2_000)]);
    buffer.insertAll([marker("minute-1", 5, 61_000)]);

    expect(buffer.snapshot().map((item) => item.trade_id)).toEqual(["minute-0-strong", "minute-1"]);
  });

  it("stays correct across enough churn to force the time-heap's own compaction", () => {
    const buffer = createTimeCoveredMarkerRetentionBuffer(50, 60_000, 1);
    for (let minute = 0; minute < 1_000; minute += 1) {
      buffer.insertAll([marker(`weak-${minute}`, 1, minute * 60_000)]);
      buffer.insertAll([marker(`strong-${minute}`, 1_000, minute * 60_000 + 1)]);
    }
    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(50);
    expect(snapshot.every((item) => item.trade_id.startsWith("strong-"))).toBe(true);
  });

  it("stays fast at scale -- an O(n) scan per insert would not clear this bar", () => {
    const buffer = createTimeCoveredMarkerRetentionBuffer(45_000, 60_000, 2);
    const startedAt = Date.now();
    for (let i = 0; i < 200_000; i += 1) {
      buffer.insertAll([marker(`m-${i}`, 1 + (i % 7), i * 61_000)]);
    }
    // 10s leaves ample room for full-suite parallel-worker contention; the
    // O(n)-scan regression this guards against takes ~40s at this scale.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(buffer.snapshot()).toHaveLength(45_000);
  });
});
