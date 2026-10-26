"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { createStorageReader } = require("../../storage/storage-reader");
const { createRemoteStorageReader } = require("../../storage/remote-storage-reader");
const { createDxFeedStorageReader } = require("../../storage/dxfeed/dxfeed-storage-reader");
const { createRemoteDxFeedStorageReader } = require("../../storage/dxfeed/remote-dxfeed-storage-reader");
const { createBinanceVolumeProfileAdapter, createDxFeedVolumeProfileAdapter } = require("../volume-profile/volume-profile-adapters");
const { VPIN_BACKFILL_MODES } = require("./vpin-session");
const { computeVpin } = require("./vpin-compute");

const PROVIDERS = new Set(["binance", "dxfeed"]);

function hasRemoteConfig(input) {
  return input.remote != null && typeof input.remote.baseUrl === "string" && input.remote.baseUrl.length > 0 &&
    typeof input.remote.token === "string" && input.remote.token.length > 0;
}

function assertWorkerInput(input) {
  if (!input || typeof input !== "object") throw new Error("vpin-warmup-worker: workerData is required");
  const provider = input.provider ?? "binance";
  if (!PROVIDERS.has(provider)) throw new Error("vpin-warmup-worker: provider must be \"binance\" or \"dxfeed\"");
  if (typeof input.symbol !== "string" || input.symbol.length === 0) {
    throw new Error("vpin-warmup-worker: symbol must be a non-empty string");
  }
  const hasDbPath = typeof input.dbPath === "string" && input.dbPath.length > 0;
  if (!hasDbPath && !hasRemoteConfig(input)) {
    throw new Error("vpin-warmup-worker: either dbPath or remote must be provided");
  }
  const identityField = provider === "binance" ? "marketKind" : "assetClass";
  if (typeof input[identityField] !== "string" || input[identityField].length === 0) {
    throw new Error(`vpin-warmup-worker: ${identityField} must be a non-empty string`);
  }
  for (const field of ["tickSize", "nowMs", "calibrationWindowMs", "backfillWindowMs"]) {
    if (!Number.isFinite(input[field]) || input[field] <= 0) {
      throw new Error(`vpin-warmup-worker: ${field} must be a positive finite number`);
    }
  }
  if (input.backfillMode !== undefined && !VPIN_BACKFILL_MODES.has(input.backfillMode)) {
    throw new Error("vpin-warmup-worker: backfillMode must be EXACT or SLICED_APPROXIMATE");
  }
  for (const field of ["backfillSliceMs", "backfillChunkMs"]) {
    if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || input[field] <= 0)) {
      throw new Error(`vpin-warmup-worker: ${field} must be a positive safe integer`);
    }
  }
}

function backfillOptions(input) {
  return {
    ...(input.backfillMode === undefined ? {} : { backfillMode: input.backfillMode }),
    ...(input.backfillSliceMs === undefined ? {} : { sliceMs: input.backfillSliceMs }),
    ...(input.backfillChunkMs === undefined ? {} : { chunkMs: input.backfillChunkMs }),
  };
}

function openAdapter(input) {
  if (input.provider === "dxfeed") {
    const reader = hasRemoteConfig(input)
      ? createRemoteDxFeedStorageReader({ baseUrl: input.remote.baseUrl, token: input.remote.token, timeoutMs: input.remote.timeoutMs ?? input.timeoutMs })
      : createDxFeedStorageReader({ dbPath: input.dbPath, timeoutMs: input.timeoutMs ?? 2_000 });
    return { reader, adapter: createDxFeedVolumeProfileAdapter(reader, input.symbol, input.assetClass) };
  }
  const reader = hasRemoteConfig(input)
    ? createRemoteStorageReader({ baseUrl: input.remote.baseUrl, token: input.remote.token, timeoutMs: input.remote.timeoutMs ?? input.timeoutMs })
    : createStorageReader({ dbPath: input.dbPath, timeoutMs: input.timeoutMs ?? 2_000 });
  return { reader, adapter: createBinanceVolumeProfileAdapter(reader, input.symbol, input.marketKind) };
}

async function run(rawInput) {
  const startedAt = Date.now();
  const input = { provider: "binance", ...rawInput };
  assertWorkerInput(input);
  const { reader, adapter } = openAdapter(input);
  try {
    const result = await computeVpin({
      adapter,
      tickSize: input.tickSize,
      nowMs: input.nowMs,
      calibrationWindowMs: input.calibrationWindowMs,
      backfillWindowMs: input.backfillWindowMs,
      engineOptions: input.engineOptions ?? {},
      backfill: backfillOptions(input),
    });
    return { ...result, durationMs: Date.now() - startedAt };
  } finally {
    reader.close();
  }
}

if (parentPort) {
  run(workerData).then(
    (result) => parentPort.postMessage({ ok: true, result }),
    (error) => parentPort.postMessage({
      ok: false,
      error: error?.message ?? String(error),
    }),
  );
}

module.exports = { assertWorkerInput, computeVpin, run };
