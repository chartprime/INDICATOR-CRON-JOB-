import { describe, expect, it } from "vitest";
import type { L2Wall, L2WallDetail, L2WallVerdict } from "../../../l2/types";
import { describeStanding, describeWall } from "../whaleCard";
import { fmtDuration, fmtPrice, fmtSize, fmtUsd, fmtUtc, fmtUtcDay } from "../whaleFormat";
import { WhaleWallStore, type WhaleBands } from "../wallStore";

const T = Date.UTC(2026, 9, 5, 14, 3, 12);
const BANDS: WhaleBands = { p50: 8e6, p75: 12e6, p90: 18e6, p95: 24e6, p99: 40e6 };

function detail(over: Partial<L2WallDetail> = {}): L2WallDetail {
  return { lifeMs: null, firstShrinkTs: null, firstShrinkExact: false, reachedAtFirstShrink: null, traded: 0, absorbed: 0, swept: 0, hidden: 0, cleared: 0, fillRatio: 0, crossSide: 0, crossSideShare: 0, endDistanceRows: null, endDistancePct: null, clearedByTrades: false, continuityGapMs: null, repeats: 0, repeatsComplete: false, evidenceGap: false, ...over };
}

function wall(over: Partial<L2Wall> = {}): L2Wall {
  return { id: 1, lane: 0, side: "bid", row: 20_000, span: 1, startTs: T, endTs: T + 4.2 * 60_000, size: 0, peak: 100, endedBy: "filled", ratio: 4.25, chain: 0, fill: 0, eaten: 0, absorbing: false, detail: detail({ traded: 76 }), ...over };
}

function record(over: Partial<L2Wall> = {}) {
  const store = new WhaleWallStore();
  store.addHost([wall(over)], 4);
  return store.select({ cutUsd: 0, fills: true, outcomes: [true, true, true, true, true], side: "both", fromTs: 0, bands: BANDS }).walls[0];
}

describe("whale card text", () => {
  it("says in one sentence what happened to a filled bid or ask, naming the side that traded into it", () => {
    const bid = describeWall(record(), { coin: "BTC", rowWidth: 4 });
    expect(bid).toMatchObject({ side: 0, title: "BID · FILLED", usd: "$8.0M", meterPct: 76, sentence: "Sellers ate 76% of this $8.0M bid in 4.2 min." });
    const ask = describeWall(record({ side: "ask" }), { coin: "BTC", rowWidth: 4 });
    expect(ask).toMatchObject({ side: 1, title: "ASK · FILLED", sentence: "Buyers ate 76% of this $8.0M ask in 4.2 min." });
  });

  it("words each other outcome in its own plain sentence", () => {
    const say = (endedBy: L2WallVerdict, over: Partial<L2Wall> = {}) => describeWall(record({ endedBy, ...over }), { coin: "BTC", rowWidth: 4 }).sentence;
    expect(say("partial", { detail: detail({ traded: 27 }) })).toBe("Sellers took a 27% bite out of this $8.0M bid; it ended after 4.2 min.");
    expect(say("hit", { detail: detail({ traded: 4 }) })).toBe("Price reached this $8.0M bid but only 4% traded; it ended after 4.2 min.");
    expect(say("pulled", { detail: detail({ traded: 0, endDistancePct: 0.84 }) })).toBe("Pulled after 4.2 min, 0.8% away from price; nothing traded.");
    expect(say("pulled", { detail: detail({ traded: 30, endDistancePct: null }) })).toBe("Pulled after 4.2 min; 30% traded.");
    expect(say("pulled", { detail: detail({ traded: 0.4 }) })).toBe("Pulled after 4.2 min; nothing traded.");
    expect(say("pulled", { detail: detail({ traded: 1 }) })).toBe("Pulled after 4.2 min; 1% traded.");
    expect(say("moved")).toBe("Cancelled and re-placed nearby within seconds (it had lived 4.2 min).");
  });

  it("caps the traded share at one hundred percent and reads zero for a wall without detail or size", () => {
    expect(describeWall(record({ detail: detail({ traded: 250 }) }), { coin: "BTC", rowWidth: 4 }).meterPct).toBe(100);
    expect(describeWall(record({ detail: null }), { coin: "BTC", rowWidth: 4 })).toMatchObject({ meterPct: 0, sentence: "Sellers ate 0% of this $8.0M bid in 4.2 min." });
    expect(describeWall(record({ peak: 0, detail: detail({ traded: 5 }) }), { coin: "BTC", rowWidth: 4 }).meterPct).toBe(0);
    const rounded = describeWall(record({ detail: detail({ traded: 76.6 }) }), { coin: "BTC", rowWidth: 4 });
    expect([rounded.meterPct, rounded.sentence]).toEqual([77, "Sellers ate 77% of this $8.0M bid in 4.2 min."]);
  });

  it("puts size, life and the start and end in UTC on one facts line", () => {
    expect(describeWall(record(), { coin: "ETH", rowWidth: 4 }).facts).toBe("100 ETH · 4.2 min · 14:03 to 14:07 UTC");
  });

  it("lists the details a pinned card adds, with n/a where the engine gave none", () => {
    const rich = describeWall(record({ detail: detail({ traded: 76, firstShrinkTs: T + 61_000, firstShrinkExact: true, repeats: 3, crossSideShare: 0.224, endDistancePct: 0.031 }) }), { coin: "BTC", rowWidth: 4 });
    expect(rich.details).toEqual([
      ["First bite", "14:04:13 (seen)"],
      ["Placed at this level", "3x in the last hour"],
      ["Other-side orders nearby", "22%"],
      ["Ended", "0.03% from price"],
      ["Importance", "4.3x usual wall"],
      ["Price", "80000.0"],
    ]);
    const estimated = describeWall(record({ detail: detail({ firstShrinkTs: T + 5_000, firstShrinkExact: false, repeats: 0 }) }), { coin: "BTC", rowWidth: 4 });
    expect(estimated.details[0]).toEqual(["First bite", "14:03:17 (estimated)"]);
    expect(estimated.details[1]).toEqual(["Placed at this level", "1x in the last hour"]);
    const bare = describeWall(record({ detail: null, ratio: 0, span: 3 }), { coin: "BTC", rowWidth: 4 });
    expect(bare.details).toEqual([
      ["First bite", "none seen"],
      ["Placed at this level", "n/a"],
      ["Other-side orders nearby", "n/a"],
      ["Ended", "n/a"],
      ["Importance", "n/a"],
      ["Price", "80000.0 to 80012.0"],
    ]);
  });

  it("describes a standing wall by how long it has rested and how far from price, or without the distance when the price is unknown", () => {
    const store = new WhaleWallStore();
    store.addLive([wall({ endTs: null, endedBy: null, peak: 500, row: 20_100, startTs: T - 7_200_000 })], 4);
    const [standing] = store.select({ cutUsd: 0, fills: true, outcomes: [true, true, true, true, true], side: "both", fromTs: 0, bands: BANDS }).standing;
    const above = describeStanding(standing, { coin: "BTC", rowWidth: 4, now: T, lastClose: 80_000 });
    expect(above).toMatchObject({ side: 0, title: "BID · STANDING NOW", meterPct: null, details: [], sentence: "Resting for 2.0 h, 0.50% above price.", facts: "500 BTC · at 80402.0" });
    expect(describeStanding(standing, { coin: "BTC", rowWidth: 4, now: T, lastClose: 81_000 }).sentence).toBe("Resting for 2.0 h, 0.74% below price.");
    expect(describeStanding(standing, { coin: "BTC", rowWidth: 4, now: T, lastClose: 100_000 }).sentence).toBe("Resting for 2.0 h, 19.60% below price.");
    expect(describeStanding(standing, { coin: "BTC", rowWidth: 4, now: T, lastClose: null }).sentence).toBe("Resting for 2.0 h.");
    expect(describeStanding(standing, { coin: "BTC", rowWidth: 4, now: T, lastClose: 0 }).sentence).toBe("Resting for 2.0 h.");
  });
});

describe("whale card formatting", () => {
  it("writes dollars as thousands, millions or billions", () => {
    expect([fmtUsd(950), fmtUsd(18_800_000), fmtUsd(999_999), fmtUsd(2_340_000_000), fmtUsd(Number.NaN)]).toEqual(["$1k", "$18.8M", "$1000k", "$2.34B", "n/a"]);
    expect([fmtUsd(5e8), fmtUsd(1e6), fmtUsd(1e9)]).toEqual(["$500.0M", "$1.0M", "$1.00B"]);
  });

  it("writes a duration in seconds under a minute and a half, minutes under an hour and a half, then hours", () => {
    expect([fmtDuration(0), fmtDuration(89_400), fmtDuration(90_000), fmtDuration(5_340_000), fmtDuration(5_400_000), fmtDuration(7_200_000)]).toEqual(["0 s", "89 s", "1.5 min", "89.0 min", "1.5 h", "2.0 h"]);
  });

  it("writes UTC clock and day, price digits by row width, and a size with one decimal", () => {
    expect([fmtUtc(T), fmtUtc(T, true), fmtUtcDay(T)]).toEqual(["14:03", "14:03:12", "Oct 5"]);
    expect([fmtPrice(85_243.456, 4), fmtPrice(3_241.456, 0.14)]).toEqual(["85243.5", "3241.46"]);
    expect(fmtPrice(5, 1)).toBe("5.0");
    expect([fmtSize(516.43), fmtSize(1234567.89), fmtSize(0)]).toEqual(["516.4", "1,234,567.9", "0"]);
  });
});
