import { describe, expect, it } from "vitest";
import type { MarkerFrame } from "../../../types/frames";
import { createTimeCoveredMarkerRetentionBuffer } from "../markerRetention";
import {
  computeWhaleTradeStats,
  filterWhaleTradesByTopFraction,
  selectWhaleTradesByTopFraction,
} from "../../indicators/whale-detector/whaleTrades";

function seeded(seed: number) {
  let state = seed;
  return () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
}

// Property: at the retention cap, one selection through the view costs a
// small fraction of the array path it replaced (which sorted every marker on
// every update). Oracle: both paths on the same buffer, same answer, timed.
describe("marker selection at the 100,000 cap", () => {
  it("the view path is at least 20x cheaper per update than sorting the whole set, and gives the same answer", () => {
    const random = seeded(42);
    const buffer = createTimeCoveredMarkerRetentionBuffer(100_000);
    const batch: MarkerFrame[] = [];
    for (let index = 0; index < 100_000; index += 1) {
      batch.push({
        type: "marker", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT",
        ts_exchange: 1_700_000_000_000 + index * 15_000 + Math.floor(random() * 1_000),
        price: 60_000 + Math.floor(random() * 5_000), size: Math.round(random() * 400) / 100 + 0.01,
        side: random() < 0.5 ? "buy" : "sell", trade_id: `m-${index}`,
      });
    }
    buffer.insertAll(batch);
    expect(buffer.size()).toBe(100_000);
    const rounds = 20;

    let oldMs = 0;
    for (let round = 0; round < rounds; round += 1) {
      const t0 = performance.now();
      const snapshot = buffer.snapshot();
      const stats = computeWhaleTradeStats(snapshot, Number.MAX_SAFE_INTEGER);
      const result = filterWhaleTradesByTopFraction(stats, 30_000, 0.0005);
      oldMs += performance.now() - t0;
      expect(result.stats.length).toBe(15);
      expect(selectWhaleTradesByTopFraction(buffer, 30_000, 0.0005).stats.map((stat) => stat.marker.trade_id))
        .toEqual(result.stats.map((stat) => stat.marker.trade_id));
    }

    let newMs = 0;
    for (let round = 0; round < rounds; round += 1) {
      const t0 = performance.now();
      const result = selectWhaleTradesByTopFraction(buffer, 30_000, 0.0005);
      newMs += performance.now() - t0;
      expect(result.stats.length).toBe(15);
    }

    let insertMs = 0;
    for (let round = 0; round < rounds; round += 1) {
      const live: MarkerFrame = { ...batch[0], ts_exchange: 1_700_000_000_000 + 1_600_000_000 + round * 15_000, trade_id: `live-${round}` };
      const t0 = performance.now();
      buffer.insertAll([live]);
      selectWhaleTradesByTopFraction(buffer, 30_000, 0.0005);
      insertMs += performance.now() - t0;
    }

    const oldPer = oldMs / rounds;
    const newPer = newMs / rounds;
    console.log(`MEASURE per update at 100k markers, top 0.05%: old array path ${oldPer.toFixed(2)} ms | view path ${newPer.toFixed(3)} ms | live insert + select ${(insertMs / rounds).toFixed(3)} ms | speedup ${(oldPer / newPer).toFixed(0)}x`);
    expect(newPer).toBeLessThan(oldPer / 20);
  });
});
