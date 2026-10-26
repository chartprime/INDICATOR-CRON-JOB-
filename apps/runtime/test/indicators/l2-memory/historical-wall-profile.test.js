"use strict";

const { createHash } = require("node:crypto");
const { historicalWallProfile } = require("../../../src/indicators/l2-memory/historical-wall-profile");
const { createHistoricalWallStream } = require("../../../src/indicators/l2-memory/historical-wall-stream");

const geometry = { tickSize: "0.25", rowClusters: 1, windowRows: 128, referenceRows: 128, fold: "max" };
const tracker = { minSize: 40, multiplier: 1.5, gapRows: 2, keepEndedMs: 1200000,
  deepKeepEndedMs: 1200000, maxLevels: 60, settleMs: 5000 };

test("effective settings are canonical, immutable and content-addressed independent of caller key order", () => {
  const first = historicalWallProfile({ ...geometry, trackerOptions: { minSize: 40 } });
  const explicit = historicalWallProfile({ ...geometry, tickSize: "0.2500", trackerOptions: Object.fromEntries(Object.entries(tracker).reverse()) });
  expect(first).toEqual(explicit);
  expect(first.id).toBe(createHash("sha256").update(JSON.stringify(first.profile)).digest("hex"));
  expect(Object.isFrozen(first.profile.tracker)).toBe(true);
  expect(Object.isFrozen(first.profile)).toBe(true);
  expect(first.profile).toMatchObject({ schema: "historical-l2-wall-profile/1", method: "retained-engine-wall-service/1" });
  const caller = { minSize: 40 };
  const frozen = historicalWallProfile({ ...geometry, trackerOptions: caller });
  caller.minSize = 100;
  expect(frozen).toEqual(first);
});

test.each([
  { tickSize: "0.01" }, { sampleMs: 2000 }, { rowClusters: 2 }, { windowRows: 256 }, { referenceRows: 64 }, { fold: "sum" },
  ...Object.entries({ minSize: 80, multiplier: 3, gapRows: 3, keepEndedMs: 600000,
    deepKeepEndedMs: 2400000, maxLevels: 100, settleMs: 2000 }).map(([key, value]) => ({ trackerOptions: { ...tracker, [key]: value } })),
])("each output-affecting setting has a different identity: %j", (change) => {
  expect(historicalWallProfile({ ...geometry, trackerOptions: tracker, ...change }).id)
    .not.toBe(historicalWallProfile({ ...geometry, trackerOptions: tracker }).id);
});

test.each([
  { tickSize: "NaN" }, { sampleMs: 1500 }, { rowClusters: 0 }, { rowClusters: 4097 }, { windowRows: 1025 },
  { referenceRows: 129 }, { fold: "avg" }, { trackerOptions: [] }, { trackerOptions: null },
  ...Object.entries({ minSize: NaN, multiplier: Infinity, gapRows: 4097, keepEndedMs: 86400001,
    deepKeepEndedMs: 1, maxLevels: 257, settleMs: 60001, unknownOption: 1 }).map(([key, value]) => ({ trackerOptions: { ...tracker, [key]: value } })),
])("unsupported or unbounded settings fail before processing data: %j", (change) => {
  expect(() => historicalWallProfile({ ...geometry, trackerOptions: tracker, ...change })).toThrow(/profile/);
  expect(() => createHistoricalWallStream({ ...geometry, trackerOptions: tracker, ...change,
    manifestSha256: "b".repeat(64), expectedRows: 1, fromNs: "0", toNs: "1000000000",
    onSample: () => {}, onSegmentEnd: () => {} })).toThrow(/profile|stream/);
});
