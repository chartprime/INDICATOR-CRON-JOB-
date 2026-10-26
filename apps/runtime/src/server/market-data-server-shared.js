const { frameKindOf, FRAME_KIND_CONTROL, FRAME_KIND_LATEST_STATE, FRAME_KIND_INCREMENTAL } = require("./frames");
const {
  MAX_HISTORY_RANGES,
  VPIN_REMOTE_BACKFILL_SLICE_MS,
  VPIN_REMOTE_BACKFILL_CHUNK_MS,
  VPIN_CALIBRATION_WINDOW_MS,
  DXFEED_CANDLE_WARMUP_WINDOW_MS,
  VPIN_N_BASELINE,
} = require("./history-parameters");

const RANGE_KEYS = ["range_end_ts", "range_start_ts"];
const SELECTION_RATE_WINDOW_MS = 1_000;
const MAX_SELECTIONS_PER_WINDOW = 2;

function parseHistoryRanges(rawRanges, periodMs) {
  if (!Array.isArray(rawRanges) || rawRanges.length === 0 || rawRanges.length > MAX_HISTORY_RANGES) return null;
  const ranges = [];
  const seen = new Set();
  for (const entry of rawRanges) {
    if (typeof entry !== "object" || entry === null) return null;
    const keys = Object.keys(entry).sort();
    if (keys.length !== RANGE_KEYS.length || !keys.every((key, index) => key === RANGE_KEYS[index])) return null;
    const { range_start_ts: startTs, range_end_ts: endTs } = entry;
    if (!Number.isSafeInteger(startTs) || startTs < 0) return null;
    if (!Number.isSafeInteger(endTs) || endTs <= startTs) return null;
    if (endTs - startTs !== periodMs) return null;
    if (startTs % periodMs !== 0) return null;
    if (seen.has(startTs)) return null;
    seen.add(startTs);
    ranges.push({ rangeStartTs: startTs, rangeEndTs: endTs });
  }
  return ranges;
}

function createSelectionRateLimiter({
  now = () => Date.now(),
  windowMs = SELECTION_RATE_WINDOW_MS,
  maxPerWindow = MAX_SELECTIONS_PER_WINDOW,
} = {}) {
  if (typeof now !== "function") throw new Error("market-data-server-shared: now must be a function");
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("market-data-server-shared: windowMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPerWindow) || maxPerWindow <= 0) {
    throw new Error("market-data-server-shared: maxPerWindow must be a positive safe integer");
  }
  const windowsByClient = new Map();
  return {
    allowSelectionRequest(client) {
      if (!client) return true;
      const nowMs = now();
      let window = windowsByClient.get(client);
      if (!window || nowMs < window.startedAtMs || nowMs - window.startedAtMs >= windowMs) {
        window = { startedAtMs: nowMs, selections: 0 };
        windowsByClient.set(client, window);
      }
      window.selections += 1;
      return window.selections <= maxPerWindow;
    },
    forget(client) {
      windowsByClient.delete(client);
    },
    clear() {
      windowsByClient.clear();
    },
    get size() {
      return windowsByClient.size;
    },
  };
}

function createFrameDispatch({ logPrefix, clients, wsOpen, safelySendSerialized, log = console }) {
  if (typeof logPrefix !== "string" || logPrefix.length === 0) {
    throw new Error("market-data-server-shared: logPrefix must be a non-empty string");
  }
  if (typeof safelySendSerialized !== "function") {
    throw new Error("market-data-server-shared: safelySendSerialized must be a function");
  }
  function safelySend(client, frame) {
    try {
      return safelySendSerialized(client, JSON.stringify(frame), frameKindOf(frame));
    } catch (error) {
      log.error(`${logPrefix}: frame serialization failed`, error?.message ?? error);
      return false;
    }
  }
  function broadcast(frame) {
    let serializedFrame;
    try {
      serializedFrame = JSON.stringify(frame);
    } catch (error) {
      log.error(`${logPrefix}: broadcast frame serialization failed`, error?.message ?? error);
      return;
    }
    const kind = frameKindOf(frame);
    for (const client of clients) {
      if (client.readyState === wsOpen) safelySendSerialized(client, serializedFrame, kind);
    }
  }
  return { safelySend, broadcast };
}

const LIQUIDITY_REPLAY_BATCH = 4;
const LIQUIDITY_REPLAY_POLL_MS = 20;
const LIQUIDITY_REPLAY_MAX_MS = 60_000;
const LIQUIDITY_REPLAY_QUEUE_CAP = 300;
const LIQUIDITY_RESYNC_MIN_INTERVAL_MS = 2_000;

function createLiquidityReplayer({
  logPrefix,
  clients,
  wsOpen,
  safelySend,
  safelySendSerialized,
  snapshotFrames,
  softBytes,
  now = () => Date.now(),
  log = console,
  batch = LIQUIDITY_REPLAY_BATCH,
  pollMs = LIQUIDITY_REPLAY_POLL_MS,
  maxMs = LIQUIDITY_REPLAY_MAX_MS,
  queueCap = LIQUIDITY_REPLAY_QUEUE_CAP,
  resyncMinIntervalMs = LIQUIDITY_RESYNC_MIN_INTERVAL_MS,
}) {
  if (typeof logPrefix !== "string" || logPrefix.length === 0) throw new Error("market-data-server-shared: logPrefix must be a non-empty string");
  if (!(clients instanceof Set)) throw new Error("market-data-server-shared: clients must be a Set");
  for (const [name, value] of [["safelySend", safelySend], ["safelySendSerialized", safelySendSerialized], ["snapshotFrames", snapshotFrames]]) {
    if (typeof value !== "function") throw new Error(`market-data-server-shared: ${name} must be a function`);
  }
  if (!Number.isFinite(softBytes) || softBytes <= 0) throw new Error("market-data-server-shared: softBytes must be a positive number");
  const replays = new Map();
  const resyncNotBefore = new Map();

  function start(client, frames) {
    stop(client);
    if (!Array.isArray(frames) || frames.length === 0) return;
    const replay = { queue: [], timer: null, index: 0, startedAt: now(), overflowed: false, frames };
    replays.set(client, replay);
    step(client);
  }

  function step(client) {
    const replay = replays.get(client);
    if (!replay) return;
    replay.timer = null;
    if (!clients.has(client) || client.readyState !== wsOpen) {
      replays.delete(client);
      return;
    }
    if (now() - replay.startedAt > maxMs) {
      replays.delete(client);
      clients.delete(client);
      console.warn(`${logPrefix}: closing a client whose snapshot replay could not keep up (1013)`, {
        sentFrames: replay.index,
        totalFrames: replay.frames.length,
        bufferedAmount: client.bufferedAmount ?? null,
      });
      if (client.closeCause === undefined) {
        client.closeCause = "snapshot-replay-timeout";
        client.closeBufferedAmount = client.bufferedAmount;
      }
      try { client.close?.(1013, "Snapshot replay could not keep up"); } catch { void 0; }
      return;
    }
    const buffered = client.bufferedAmount;
    if (Number.isFinite(buffered) && buffered > softBytes / 4) {
      replay.timer = setTimeout(() => step(client), pollMs);
      replay.timer.unref?.();
      return;
    }
    const end = Math.min(replay.frames.length, replay.index + batch);
    while (replay.index < end) {
      if (!safelySend(client, replay.frames[replay.index])) {
        replays.delete(client);
        return;
      }
      replay.index += 1;
    }
    if (replay.index >= replay.frames.length) {
      finish(client);
      return;
    }
    replay.timer = setTimeout(() => step(client), 0);
    replay.timer.unref?.();
  }

  function finish(client) {
    const replay = replays.get(client);
    replays.delete(client);
    if (!replay) return;
    if (replay.overflowed) {
      start(client, snapshotFrames());
      return;
    }
    for (const frame of replay.queue) {
      if (!clients.has(client)) break;
      if (!safelySend(client, frame)) break;
    }
  }

  function stop(client) {
    const replay = replays.get(client);
    if (!replay) return;
    if (replay.timer) clearTimeout(replay.timer);
    replays.delete(client);
  }

  function forget(client) {
    stop(client);
    resyncNotBefore.delete(client);
  }

  function stopAll() {
    for (const replay of replays.values()) if (replay.timer) clearTimeout(replay.timer);
    replays.clear();
    resyncNotBefore.clear();
  }

  function broadcast(frame) {
    let serialized;
    try {
      serialized = JSON.stringify(frame);
    } catch (error) {
      log.error(`${logPrefix}: liquidity frame serialization failed`, error?.message ?? error);
      return;
    }
    const kind = frameKindOf(frame);
    for (const client of clients) {
      if (client.readyState !== wsOpen) continue;
      const replay = replays.get(client);
      if (replay) {
        if (replay.queue.length < queueCap) replay.queue.push(frame);
        else replay.overflowed = true;
      } else {
        safelySendSerialized(client, serialized, kind);
      }
    }
  }

  function announce(frames) {
    if (!Array.isArray(frames) || frames.length === 0) return;
    for (const client of clients) {
      if (client.readyState !== wsOpen) continue;
      const replay = replays.get(client);
      if (replay) replay.overflowed = true;
      else start(client, frames);
    }
  }

  function resync(client) {
    const notBefore = resyncNotBefore.get(client) ?? 0;
    if (now() < notBefore) return false;
    resyncNotBefore.set(client, now() + resyncMinIntervalMs);
    start(client, snapshotFrames());
    return true;
  }

  return Object.freeze({
    start,
    stop,
    forget,
    stopAll,
    broadcast,
    announce,
    resync,
    get size() {
      return replays.size;
    },
  });
}

const VPIN_WARMUP_RETRY_STEPS_MS = Object.freeze([15_000, 60_000, 10 * 60 * 1_000]);

function vpinBackfillPlan(storageReader) {
  if (storageReader?.remote) {
    return {
      backfillMode: "SLICED_APPROXIMATE",
      backfillSliceMs: VPIN_REMOTE_BACKFILL_SLICE_MS,
      backfillChunkMs: VPIN_REMOTE_BACKFILL_CHUNK_MS,
    };
  }
  return { backfillMode: "EXACT" };
}

function createVpinWarmupRetryPolicy({ log, label }) {
  if (typeof log !== "function") throw new Error("market-data-server-shared: log must be a function");
  if (typeof label !== "string" || label.length === 0) throw new Error("market-data-server-shared: label must be a non-empty string");
  const failuresByKey = new Map();
  const loggedReasonByKey = new Map();
  return Object.freeze({
    failed(key, reason, details) {
      const failures = (failuresByKey.get(key) ?? 0) + 1;
      failuresByKey.set(key, failures);
      if (loggedReasonByKey.get(key) !== reason) {
        loggedReasonByKey.set(key, reason);
        log(`${label}: vpin warm-up for ${key} is unavailable (${reason}); retrying with backoff`, details);
      }
      return VPIN_WARMUP_RETRY_STEPS_MS[Math.min(failures, VPIN_WARMUP_RETRY_STEPS_MS.length) - 1];
    },
    succeeded(key) {
      failuresByKey.delete(key);
      loggedReasonByKey.delete(key);
    },
    forget(key) {
      failuresByKey.delete(key);
      loggedReasonByKey.delete(key);
    },
    clear() {
      failuresByKey.clear();
      loggedReasonByKey.clear();
    },
  });
}

/**
 * A market data server's outbound send, with the slow-client policy all three
 * servers share. Under `softBytes` buffered, a frame is sent. Over it, the
 * client has `graceMs` from the first frame that found it over: control,
 * latest-state and incremental frames still go (the client stays exact), bulk
 * history is skipped (it can ask again), and once the grace runs out, or the
 * buffer passes `hardBytes`, the client is closed with 1013 and released. A
 * send that throws closes it with 1011. Dropping back under `softBytes` resets
 * the grace.
 */
function createClientSender({ logPrefix, softBytes, hardBytes, graceMs, now, clientCount, releaseClient, closeClient }) {
  if (typeof logPrefix !== "string" || logPrefix.length === 0) throw new Error("market-data-server-shared: logPrefix must be a non-empty string");
  for (const [name, value] of [["now", now], ["clientCount", clientCount], ["releaseClient", releaseClient], ["closeClient", closeClient]]) {
    if (typeof value !== "function") throw new Error(`market-data-server-shared: ${name} must be a function`);
  }
  const overSince = new Map();

  function send(client, serializedFrame, kind = null) {
    function attemptSend() {
      try {
        client.send(serializedFrame);
        return true;
      } catch (error) {
        console.error(`${logPrefix}: client send failed`, error?.message ?? error);
        releaseClient(client);
        closeClient(client, 1011, "Unable to deliver market data");
        return false;
      }
    }
    const buffered = client.bufferedAmount;
    if (Number.isFinite(buffered) && buffered > softBytes) {
      const atMs = now();
      const since = overSince.get(client) ?? atMs;
      overSince.set(client, since);
      const runaway = buffered > hardBytes;
      const withinGrace = !runaway && atMs - since < graceMs;
      if (withinGrace && (kind === FRAME_KIND_CONTROL || kind === FRAME_KIND_LATEST_STATE || kind === FRAME_KIND_INCREMENTAL)) {
        return attemptSend();
      }
      if (withinGrace) {
        return false;
      }
      console.warn(`${logPrefix}: evicting a slow client (1013)`, {
        bufferedBytes: buffered,
        overForMs: atMs - since,
        reason: runaway ? "HARD_CEILING" : "GRACE_EXPIRED",
        remainingClients: Math.max(0, clientCount() - 1),
      });
      closeClient(client, 1013, "Client is too slow to receive market data");
      releaseClient(client);
      return false;
    }
    overSince.delete(client);
    return attemptSend();
  }

  return Object.freeze({
    send,
    forget: (client) => overSince.delete(client),
    clear: () => overSince.clear(),
  });
}

module.exports = {
  createClientSender,
  parseHistoryRanges,
  createSelectionRateLimiter,
  createFrameDispatch,
  createLiquidityReplayer,
  vpinBackfillPlan,
  createVpinWarmupRetryPolicy,
  VPIN_REMOTE_BACKFILL_SLICE_MS,
  VPIN_REMOTE_BACKFILL_CHUNK_MS,
  VPIN_CALIBRATION_WINDOW_MS,
  VPIN_N_BASELINE,
  DXFEED_CANDLE_WARMUP_WINDOW_MS,
  VPIN_WARMUP_RETRY_STEPS_MS,
  LIQUIDITY_REPLAY_BATCH,
  LIQUIDITY_REPLAY_POLL_MS,
  LIQUIDITY_REPLAY_MAX_MS,
  LIQUIDITY_REPLAY_QUEUE_CAP,
  LIQUIDITY_RESYNC_MIN_INTERVAL_MS,
  MAX_HISTORY_RANGES,
  SELECTION_RATE_WINDOW_MS,
  MAX_SELECTIONS_PER_WINDOW,
};
