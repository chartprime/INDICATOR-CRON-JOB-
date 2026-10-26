"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const { attachReadTelemetry } = require("../storage/read-telemetry");
const { fingerprint } = require("./replay-storage-fingerprint");
const { BOOK_MODES } = require("../indicators/l2-memory/replay-truncate");
const { validateBandOptions } = require("./band-history");

const WORKER_PATH = path.join(__dirname, "replay-page-worker.js");
const MAX_WINDOW_MS = 8 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_FRAMES = 2_000;
const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_PAGES = 2_048;
const DEFAULT_POOL_SIZE = 4;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload, secret) {
  const body = b64url(JSON.stringify(stable(payload)));
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verify(cursor, secret) {
  if (typeof cursor !== "string" || cursor.length > 4_096) throw new Error("replay-page-reader: invalid cursor");
  const parts = cursor.split(".");
  if (parts.length !== 2) throw new Error("replay-page-reader: invalid cursor");
  const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], "base64url"); } catch { throw new Error("replay-page-reader: invalid cursor"); }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("replay-page-reader: invalid cursor");
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { throw new Error("replay-page-reader: invalid cursor"); }
  return payload;
}

function assertPositive(value, field, integer = false) {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`replay-page-reader: ${field} must be a positive ${integer ? "safe integer" : "finite number"}`);
  }
}

function unavailable(message, telemetryReason = "service_unavailable") {
  const error = new Error(message);
  error.code = "SERVICE_UNAVAILABLE";
  error.telemetryReason = telemetryReason;
  return error;
}

function createReplayPageReader({
  dbPath, dxfeedDbPath, cursorSecret, tickSizeResolver, timeoutMs = DEFAULT_TIMEOUT_MS,
  maxFrames = DEFAULT_MAX_FRAMES, maxBytes = DEFAULT_MAX_BYTES, poolSize = DEFAULT_POOL_SIZE,
} = {}) {
  if (typeof cursorSecret !== "string" || cursorSecret.length < 16) throw new Error("replay-page-reader: cursorSecret is required");
  if (!tickSizeResolver || typeof tickSizeResolver.getBinanceTickSize !== "function" ||
      typeof tickSizeResolver.getDxFeedTickSize !== "function") throw new Error("replay-page-reader: tickSizeResolver is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxFrames) || maxFrames <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("replay-page-reader: invalid resource limits");
  if (!Number.isSafeInteger(poolSize) || poolSize <= 0) throw new Error("replay-page-reader: poolSize must be a positive safe integer");
  let closed = false;

  // A small pool of long-lived workers, each keeping its own SQLite
  // connection open across many pages (see replay-page-worker.js), instead
  // of spawning a thread and reopening the database on every single page.
  // A worker that times out or crashes is terminated and replaced, never
  // reused mid-failure, so the timeout/abort/crash guarantees below are
  // identical to the one-worker-per-page design this replaced.
  const allWorkers = new Set();
  const idleWorkers = [];
  const waiters = [];

  function spawnWorker() {
    const worker = new Worker(WORKER_PATH);
    allWorkers.add(worker);
    return worker;
  }

  function releaseWorker(worker) {
    if (closed || !allWorkers.has(worker)) return;
    const waiter = waiters.shift();
    if (waiter) { waiter.resolve(worker); return; }
    idleWorkers.push(worker);
  }

  function retireWorker(worker) {
    allWorkers.delete(worker);
    const idleIndex = idleWorkers.indexOf(worker);
    if (idleIndex >= 0) idleWorkers.splice(idleIndex, 1);
    if (!closed) releaseWorker(spawnWorker());
  }

  function acquireWorker(signal) {
    if (signal?.aborted) return Promise.reject(unavailable("replay-page-reader: aborted", "reader_aborted"));
    const worker = idleWorkers.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(unavailable("replay-page-reader: aborted", "reader_aborted"));
      };
      const waiter = {
        resolve: (availableWorker) => {
          signal?.removeEventListener("abort", abort);
          resolve(availableWorker);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      };
      waiters.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  for (let i = 0; i < poolSize; i += 1) releaseWorker(spawnWorker());

  async function readReplayPage(symbol, marketKind, options, context = {}) {
    if (closed) return Promise.reject(new Error("replay-page-reader: closed"));
    const { provider = "binance" } = context;
    const selectedPath = provider === "dxfeed" ? dxfeedDbPath : dbPath;
    const { fromTs, toTs, tickSize, clusterTicks, rowClusters, windowRows, cursor = null, bookMode = "full" } = options;
    if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs) || fromTs < 0 || toTs < fromTs || toTs - fromTs > MAX_WINDOW_MS) {
      return Promise.reject(new Error("replay-page-reader: invalid time range"));
    }
    if (!BOOK_MODES.includes(bookMode)) {
      return Promise.reject(new Error(`replay-page-reader: bookMode must be one of ${BOOK_MODES.join(", ")}`));
    }
    try {
      assertPositive(tickSize, "tickSize");
      assertPositive(clusterTicks, "clusterTicks", true);
      assertPositive(rowClusters, "rowClusters", true);
      assertPositive(windowRows, "windowRows", true);
    } catch (error) { return Promise.reject(error); }
    if (provider === "dxfeed") {
      const catalogTick = tickSizeResolver.getDxFeedTickSize(marketKind, symbol);
      if (!Number.isFinite(catalogTick) || Math.abs(catalogTick - tickSize) > catalogTick * 1e-9) {
        throw new Error("replay-page-reader: tickSize does not match the instrument catalog");
      }
    }
    const identity = { v: 1, provider, symbol, marketKind, fromTs, toTs, tickSize, clusterTicks, rowClusters, windowRows };
    const storage = fingerprint(selectedPath);
    let pageFromTs = fromTs;
    let page = 0;
    if (cursor !== null) {
      const decoded = verify(cursor, cursorSecret);
      const expected = JSON.stringify(stable(identity));
      if (JSON.stringify(stable(decoded.identity)) !== expected) return Promise.reject(new Error("replay-page-reader: cursor request mismatch"));
      if (decoded.storage !== storage) return Promise.reject(new Error("replay-page-reader: storage identity changed"));
      if (!Number.isSafeInteger(decoded.pageFromTs) || decoded.pageFromTs < fromTs || decoded.pageFromTs > toTs ||
          !Number.isSafeInteger(decoded.page) || decoded.page < 1 || decoded.page >= MAX_PAGES) {
        return Promise.reject(new Error("replay-page-reader: invalid cursor position"));
      }
      pageFromTs = decoded.pageFromTs;
      page = decoded.page;
    }
    const queuedAt = performance.now();
    const worker = await acquireWorker(context.signal);
    const poolQueueMs = performance.now() - queuedAt;
    if (closed) return Promise.reject(new Error("replay-page-reader: closed"));
    if (context.signal?.aborted) {
      releaseWorker(worker);
      return Promise.reject(unavailable("replay-page-reader: aborted", "reader_aborted"));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const requestedAt = performance.now();
      let settled = false;
      const finish = (fn, value, { crashed = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
        if (crashed) {
          worker.terminate().catch(() => {});
          retireWorker(worker);
        } else {
          releaseWorker(worker);
        }
        fn(value);
      };
      const abort = () => finish(reject, unavailable("replay-page-reader: aborted", "reader_aborted"), { crashed: true });
      const timer = setTimeout(() => finish(reject, unavailable("replay-page-reader: timeout", "reader_timeout"), { crashed: true }), timeoutMs);
      context.signal?.addEventListener("abort", abort, { once: true });
      const onError = (error) => finish(reject, unavailable(`replay-page-reader: worker failed: ${error?.message ?? error}`, "worker_failed"), { crashed: true });
      const onExit = (code) => {
        if (!settled) finish(reject, unavailable(`replay-page-reader: worker exited ${code}`, "worker_exited"), { crashed: true });
      };
      const onMessage = (message) => {
        if (message.requestId !== requestId) return;
        if (message.error) return finish(reject, unavailable(`replay-page-reader: ${message.error}`, "worker_query_failed"));
        if (!message.complete && (!Number.isSafeInteger(message.nextFromTs) || message.nextFromTs <= pageFromTs)) {
          return finish(reject, new Error("replay-page-reader: page made no forward progress"));
        }
        const nextCursor = message.complete ? null : sign({
          identity, storage, pageFromTs: message.nextFromTs, page: page + 1,
        }, cursorSecret);
        const workerTotalMs = performance.now() - requestedAt;
        const result = attachReadTelemetry(
          { frames: message.frames, complete: message.complete, nextCursor, stats: message.stats },
          {
            ...message.telemetry,
            poolQueueMs,
            workerTotalMs,
            workerStartupMs: Math.max(0, workerTotalMs - Number(message.telemetry?.readerSetupMs ?? 0) - Number(message.telemetry?.queryMs ?? 0)),
          },
        );
        finish(resolve, result);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      if (context.signal?.aborted) { abort(); return; }
      worker.postMessage({
        requestId, provider, dbPath: selectedPath, symbol, marketKind, pageFromTs, toTs,
        geometry: { tickSize, clusterTicks, rowClusters, windowRows, windowBp: 1, bookMode },
        maxFrames, maxBytes,
      });
    });
  }

  async function readBandHistory(symbol, marketKind, options, context = {}) {
    if (closed) return Promise.reject(new Error("replay-page-reader: closed"));
    const { provider = "binance" } = context;
    const problem = validateBandOptions(options);
    if (problem !== null) return Promise.reject(new Error(`replay-page-reader: ${problem}`));
    if (provider === "dxfeed") {
      const catalogTick = tickSizeResolver.getDxFeedTickSize(marketKind, symbol);
      if (!Number.isFinite(catalogTick) || Math.abs(catalogTick - options.tickSize) > catalogTick * 1e-9) {
        throw new Error("replay-page-reader: tickSize does not match the instrument catalog");
      }
    }
    const queuedAt = performance.now();
    const worker = await acquireWorker(context.signal);
    const poolQueueMs = performance.now() - queuedAt;
    if (closed) return Promise.reject(new Error("replay-page-reader: closed"));
    if (context.signal?.aborted) {
      releaseWorker(worker);
      return Promise.reject(unavailable("replay-page-reader: aborted", "reader_aborted"));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const requestedAt = performance.now();
      let settled = false;
      const finish = (fn, value, { crashed = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
        if (crashed) {
          worker.terminate().catch(() => {});
          retireWorker(worker);
        } else {
          releaseWorker(worker);
        }
        fn(value);
      };
      const abort = () => finish(reject, unavailable("replay-page-reader: aborted", "reader_aborted"), { crashed: true });
      const timer = setTimeout(() => finish(reject, unavailable("replay-page-reader: timeout", "reader_timeout"), { crashed: true }), timeoutMs);
      context.signal?.addEventListener("abort", abort, { once: true });
      const onError = (error) => finish(reject, unavailable(`replay-page-reader: worker failed: ${error?.message ?? error}`, "worker_failed"), { crashed: true });
      const onExit = (code) => {
        if (!settled) finish(reject, unavailable(`replay-page-reader: worker exited ${code}`, "worker_exited"), { crashed: true });
      };
      const onMessage = (message) => {
        if (message.requestId !== requestId) return;
        if (message.error) return finish(reject, unavailable(`replay-page-reader: ${message.error}`, "worker_query_failed"));
        const workerTotalMs = performance.now() - requestedAt;
        finish(resolve, attachReadTelemetry(message.result, {
          ...message.telemetry,
          poolQueueMs,
          workerTotalMs,
          workerStartupMs: Math.max(0, workerTotalMs - Number(message.telemetry?.readerSetupMs ?? 0) - Number(message.telemetry?.queryMs ?? 0)),
        }));
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      if (context.signal?.aborted) { abort(); return; }
      worker.postMessage({
        kind: "band-history", requestId, provider, dbPath: provider === "dxfeed" ? dxfeedDbPath : dbPath, symbol, marketKind,
        fromTs: options.fromTs, toTs: options.toTs, tickSize: options.tickSize, clusterTicks: options.clusterTicks, rowClusters: options.rowClusters,
        priceLo: options.priceLo, priceHi: options.priceHi, columnMs: options.columnMs,
      });
    });
  }

  function readAsync(method, symbol, marketKind, options, context) {
    if (method === "readBandHistory") return readBandHistory(symbol, marketKind, options, context);
    if (method !== "readReplayPage") return Promise.reject(new Error("replay-page-reader: unsupported method"));
    return readReplayPage(symbol, marketKind, options, context);
  }

  function close() {
    closed = true;
    const terminations = [...allWorkers].map((worker) => worker.terminate().catch(() => {}));
    allWorkers.clear();
    idleWorkers.length = 0;
    const pending = waiters.splice(0, waiters.length);
    for (const waiter of pending) waiter.reject(new Error("replay-page-reader: closed"));
    return Promise.all(terminations);
  }

  return Object.freeze({ readAsync, close });
}

module.exports = { createReplayPageReader, sign, verify, MAX_WINDOW_MS, MAX_PAGES };
