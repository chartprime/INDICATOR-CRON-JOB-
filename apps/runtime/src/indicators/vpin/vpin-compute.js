"use strict";

const {
  deriveDailyVolumesUsd,
  createVpinSession,
  seedSessionFromBackfill,
  calibrateVBucket,
} = require("./vpin-session");

const CALIBRATION_ALIGN_MS = 60 * 60 * 1_000;

async function computeVpin({
  adapter, tickSize, nowMs, calibrationWindowMs, backfillWindowMs, engineOptions = {}, backfill = {},
  calibrationEndTs = nowMs,
}) {
  const calibrationToTs = Math.floor(calibrationEndTs / CALIBRATION_ALIGN_MS) * CALIBRATION_ALIGN_MS;
  const calibrationFromTs = Math.max(0, calibrationToTs - calibrationWindowMs);
  const dailyVolumes = await deriveDailyVolumesUsd({
    adapter,
    tickSize,
    fromTs: calibrationFromTs,
    toTs: calibrationToTs,
  });
  if (dailyVolumes === null) return { available: false, reason: "STORAGE_UNAVAILABLE" };
  const vBucket = calibrateVBucket(dailyVolumes);
  const session = createVpinSession({ adapter, vBucket, nowMs, engineOptions });
  const seeded = await seedSessionFromBackfill(session, Math.max(0, nowMs - backfillWindowMs), nowMs, backfill);
  const slices = seeded.slicesRead === undefined ? {} : { slicesRead: seeded.slicesRead, chunksRead: seeded.chunksRead };
  if (!seeded.complete) {
    return {
      available: false,
      reason: seeded.reason ?? "BACKFILL_INCOMPLETE",
      tradesApplied: seeded.tradesApplied,
      pagesFetched: seeded.pagesFetched,
      ...slices,
    };
  }
  return {
    available: true,
    vBucket,
    vpinState: session.vpinState,
    history: session.history,
    pollFromTs: session.pollFromTs,
    pollCursor: session.pollCursor,
    tradesApplied: seeded.tradesApplied,
    pagesFetched: seeded.pagesFetched,
    ...slices,
  };
}

module.exports = { computeVpin };
