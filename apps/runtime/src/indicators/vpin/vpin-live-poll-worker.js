"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { createStorageReader } = require("../../storage/storage-reader");
const { createRemoteStorageReader } = require("../../storage/remote-storage-reader");
const { createDxFeedStorageReader } = require("../../storage/dxfeed/dxfeed-storage-reader");
const { createRemoteDxFeedStorageReader } = require("../../storage/dxfeed/remote-dxfeed-storage-reader");
const { createBinanceVolumeProfileAdapter, createDxFeedVolumeProfileAdapter } = require("../volume-profile/volume-profile-adapters");
const { createVpinSession, pollLive } = require("./vpin-session");

const PROVIDERS = new Set(["binance", "dxfeed"]);

function hasRemoteConfig(input) {
  return input.remote != null && typeof input.remote.baseUrl === "string" && input.remote.baseUrl.length > 0 &&
    typeof input.remote.token === "string" && input.remote.token.length > 0;
}

function assertWorkerInput(input) {
  if (!input || typeof input !== "object") throw new Error("vpin-live-poll-worker: workerData is required");
  if (!PROVIDERS.has(input.provider)) throw new Error("vpin-live-poll-worker: provider must be binance or dxfeed");
  if (typeof input.symbol !== "string" || input.symbol.length === 0) {
    throw new Error("vpin-live-poll-worker: symbol must be a non-empty string");
  }
  const hasDbPath = typeof input.dbPath === "string" && input.dbPath.length > 0;
  if (!hasDbPath && !hasRemoteConfig(input)) {
    throw new Error("vpin-live-poll-worker: either dbPath or remote must be provided");
  }
  const identityField = input.provider === "binance" ? "marketKind" : "assetClass";
  if (typeof input[identityField] !== "string" || input[identityField].length === 0) {
    throw new Error(`vpin-live-poll-worker: ${identityField} must be a non-empty string`);
  }
  for (const field of ["nowMs", "pollFromTs"]) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 0) {
      throw new Error(`vpin-live-poll-worker: ${field} must be a non-negative safe integer`);
    }
  }
  if (input.nowMs < input.pollFromTs) {
    throw new Error("vpin-live-poll-worker: nowMs must not be before pollFromTs");
  }
  if (
    input.pollCursor !== null &&
    (!input.pollCursor || typeof input.pollCursor !== "object" ||
      !Number.isSafeInteger(input.pollCursor.ts) || input.pollCursor.ts < 0 ||
      !Number.isSafeInteger(input.pollCursor.id) || input.pollCursor.id < 0)
  ) {
    throw new Error("vpin-live-poll-worker: pollCursor must be null or a timestamp/id cursor");
  }
  if (!input.vpinState || typeof input.vpinState !== "object" || !input.vpinState.sealer) {
    throw new Error("vpin-live-poll-worker: vpinState is required");
  }
  if (!Number.isFinite(input.vpinState.sealer.vBucket) || input.vpinState.sealer.vBucket <= 0) {
    throw new Error("vpin-live-poll-worker: vpinState must carry a positive vBucket");
  }
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

async function run(input) {
  assertWorkerInput(input);
  const { reader, adapter } = openAdapter(input);
  try {
    const session = createVpinSession({
      adapter,
      vBucket: input.vpinState.sealer.vBucket,
      nowMs: input.pollFromTs,
    });
    session.vpinState = input.vpinState;
    session.pollFromTs = input.pollFromTs;
    session.pollCursor = input.pollCursor ?? null;
    const result = await pollLive(session, input.nowMs, input.pollOptions ?? {});
    return {
      ...result,
      vpinState: session.vpinState,
      pollFromTs: session.pollFromTs,
      pollCursor: session.pollCursor,
    };
  } finally {
    reader.close();
  }
}

if (parentPort) {
  run(workerData).then(
    (result) => parentPort.postMessage({ ok: true, result }),
    (error) => parentPort.postMessage({ ok: false, error: error?.message ?? String(error) }),
  );
}

module.exports = { assertWorkerInput, openAdapter, run };
