const { buildAlignedProfileSession, createProfilePollPolicy } = require("../../../src/indicators/volume-profile/volume-profile-session");
const { createSession, pollOpenPeriod } = require("../../../src/indicators/volume-profile/volume-profile-engine");

const NOW = Date.parse("2026-09-25T20:30:00Z");
const options = (adapter) => ({ adapter, tickSize: 0.25, periodMs: 3_600_000, binSizeMultiplier: 1, nowMs: NOW, referenceLookbackMs: 900_000 });

test("an available empty reference is not a storage failure, and a failed seed is never published", async () => {
  const adapter = { readPriceRange: jest.fn(async () => ({ available: true, tradeCount: 0, minPrice: null, maxPrice: null })), readVolumeProfile: jest.fn(async () => ({ available: false })) };
  expect(await buildAlignedProfileSession(options(adapter))).toBeNull();
  expect(adapter.readVolumeProfile).not.toHaveBeenCalled();
  adapter.readPriceRange.mockResolvedValue({ available: false });
  await expect(buildAlignedProfileSession(options(adapter))).rejects.toThrow("PROFILE_REFERENCE_UNAVAILABLE");
  adapter.readPriceRange.mockResolvedValue({ available: true, tradeCount: 2, minPrice: 100, maxPrice: 101 });
  await expect(buildAlignedProfileSession(options(adapter))).rejects.toThrow("PROFILE_SEED_UNAVAILABLE");
});

test("closed markets suspend reads; empty and failed queries retry with bounded backoff and reopen immediately", () => {
  let nowMs = NOW;
  const policy = createProfilePollPolicy({ now: () => nowMs });
  expect(policy.allow(false)).toBe(false);
  expect(policy.status).toBe("CLOSED");
  expect(policy.allow(true)).toBe(true);
  policy.settle("EMPTY");
  expect(policy.allow(true)).toBe(false);
  nowMs += 15_000;
  expect(policy.allow(true)).toBe(true);
  expect(policy.fail(new Error("unavailable"))).toBe(true);
  expect(policy.status).toBe("UNAVAILABLE");
  nowMs += 14_999;
  expect(policy.allow(true)).toBe(false);
  nowMs += 1;
  expect(policy.allow(true)).toBe(true);
  expect(policy.fail(new Error("unavailable"))).toBe(false);
  nowMs += 29_999;
  expect(policy.allow(true)).toBe(false);
  nowMs += 1;
  expect(policy.allow(true)).toBe(true);
  policy.fail(new Error("different"));
  nowMs += 60_000;
  expect(policy.allow(true)).toBe(true);
  policy.fail(new Error("different"));
  expect(policy.allow(false)).toBe(false);
  expect(policy.allow(true)).toBe(true);
  policy.settle("READY");
  expect(policy.status).toBe("READY");
});

test("hitting the per-tick page cap reports incomplete catch-up and resumes without losing or duplicating trades", async () => {
  const session = createSession({ periodStartTs: NOW, originPrice: 100, rowWidth: 0.25 });
  const adapter = { readTradesSince: jest.fn(async (from, to, cursor) => cursor === null ? { available: true, rows: [{ ts: NOW, tradeId: 1, price: 100, size: 2, side: "buy" }], nextCursor: { ts: NOW, tradeId: 1 } } : { available: true, rows: [], nextCursor: null }) };
  expect(await pollOpenPeriod(session, adapter, NOW + 1, { pageLimit: 1, maxPagesPerTick: 1 })).toMatchObject({ rowsApplied: 1, complete: false });
  expect(await pollOpenPeriod(session, adapter, NOW + 1, { pageLimit: 1, maxPagesPerTick: 1 })).toMatchObject({ rowsApplied: 0, complete: true });
  expect(session.buckets.get(0)).toMatchObject({ volume: 2, buyVolume: 2, sellVolume: 0 });
});
