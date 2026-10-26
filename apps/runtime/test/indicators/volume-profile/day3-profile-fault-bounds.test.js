const { createSession, pollOpenPeriod } = require("../../../src/indicators/volume-profile/volume-profile-engine");

test("a failed later page cannot bypass the live profile memory bound or replay its successful page", async () => {
  const session = createSession({ periodStartTs: 0, originPrice: 0, rowWidth: 1 });
  let page = 0;
  let expectedVolume = 0;
  const adapter = { readTradesSince(_from, _to, cursor) {
    page++;
    if (page % 2 === 0) return { rows: [], nextCursor: null, available: false };
    const fromId = cursor?.id ?? 0;
    const rows = Array.from({ length: 20 }, (_, i) => ({ ts: fromId + i + 1, tradeId: String(fromId + i + 1), price: 100 + (fromId + i) * 1000, size: 1, side: "buy" }));
    expectedVolume += rows.length;
    return { rows, available: true, nextCursor: { ts: fromId + 20, id: fromId + 20 } };
  } };
  for (let attempt = 0; attempt < 10; attempt++) {
    await expect(pollOpenPeriod(session, adapter, 10000, { pageLimit: 20, maxBuckets: 4 })).rejects.toThrow(/source unavailable/);
    expect(session.buckets.size).toBeLessThanOrEqual(4);
    expect([...session.buckets.values()].reduce((sum, bucket) => sum + bucket.volume, 0)).toBe(expectedVolume);
    expect(session.pollCursor.id).toBe(expectedVolume);
  }
});
