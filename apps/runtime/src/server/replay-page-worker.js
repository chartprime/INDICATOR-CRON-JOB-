"use strict";

const { parentPort } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");
const { createReplaySource } = require("../indicators/l2-memory/replay-source");
const { createDxFeedReplaySource } = require("../indicators/l2-memory/dxfeed-replay-source");
const { createReplayTruncator } = require("../indicators/l2-memory/replay-truncate");
const { fingerprint } = require("./replay-storage-fingerprint");
const { runBandHistory } = require("./band-history");

// Persistent, message-driven worker: it lives in a pool and serves many
// pages across many requests, reusing one open SQLite connection per
// dbPath instead of paying the open cost on every single page. A cached
// connection is only ever reused when the file it points at is still the
// exact file it was opened against (dev/ino/birthtime unchanged) -- a
// deploy, migration, or collector restart that replaces the database file
// on disk invalidates the cache and forces a fresh open, the same
// correctness guarantee the coordinator already gives page-to-page cursors.
const connections = new Map();

function connectionFor(dbPath) {
  const currentFingerprint = fingerprint(dbPath);
  const cached = connections.get(dbPath);
  if (cached && cached.fingerprint === currentFingerprint) return cached.db;
  if (cached) {
    try { cached.db.close(); } catch { /* already gone */ }
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  connections.set(dbPath, { db, fingerprint: currentFingerprint });
  return db;
}

function sourceFor(request, { includeBuffering = false } = {}) {
  const db = connectionFor(request.dbPath);
  const shared = { db, symbol: request.symbol, fromTs: request.pageFromTs ?? request.fromTs, toTs: request.toTs };
  return request.provider === "dxfeed"
    ? createDxFeedReplaySource({ ...shared, assetClass: request.marketKind })
    : createReplaySource({
      ...shared,
      marketKind: request.marketKind,
      bookMode: request.kind === "band-history" ? "sparse" : request.geometry?.bookMode ?? "full",
      replayGeometry: request.geometry ?? null,
      includeBuffering,
    });
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function runOne(request) {
  const workerStartedAt = performance.now();
  const source = sourceFor(request);
  const openedAt = performance.now();
  const truncator = createReplayTruncator(request.geometry);
  const frames = [];
  let bytes = 2;
  let complete = true;
  let nextFromTs = null;
  let group = [];
  let groupTs = null;
  let timestampGroupsExamined = 0;

  function acceptGroup() {
    if (group.length === 0) return true;
    timestampGroupsExamined += 1;
    const groupBytes = group.reduce((total, frame) => total + encodedBytes(frame) + 1, 0);
    if (group.length > request.maxFrames || groupBytes > request.maxBytes) {
      throw new Error("REPLAY_TIMESTAMP_GROUP_TOO_LARGE");
    }
    if (frames.length + group.length > request.maxFrames || bytes + groupBytes > request.maxBytes) {
      complete = false;
      nextFromTs = groupTs;
      return false;
    }
    frames.push(...group);
    bytes += groupBytes;
    group = [];
    return true;
  }

  try {
    for (const raw of source.frames()) {
      if (raw.kind === "trade" && raw.ts < request.pageFromTs) continue;
      const frame = truncator.truncate(raw);
      if (groupTs !== null && frame.ts !== groupTs && !acceptGroup()) break;
      if (group.length === 0) groupTs = frame.ts;
      group.push(frame);
    }
    if (complete) acceptGroup();
    const completedAt = performance.now();
    return {
      frames, complete, nextFromTs,
      stats: { ...source.stats, timestampGroupsExamined, encodedBytes: bytes },
      telemetry: { readerSetupMs: openedAt - workerStartedAt, queryMs: completedAt - openedAt },
    };
  } finally {
    // The source never owns the pooled connection (db was passed in), so
    // this never closes it -- only per-request prepared-statement state.
    source.close();
  }
}

async function runBand(request) {
  const workerStartedAt = performance.now();
  const source = sourceFor({ ...request, kind: "band-history" }, { includeBuffering: true });
  const openedAt = performance.now();
  const dxfeed = request.provider === "dxfeed";
  const result = await runBandHistory({
    source, fullDepth: dxfeed,
    tickSize: request.tickSize, clusterTicks: request.clusterTicks, rowClusters: request.rowClusters,
    fromTs: request.fromTs, toTs: request.toTs, columnMs: request.columnMs, priceLo: request.priceLo, priceHi: request.priceHi,
  });
  const completedAt = performance.now();
  return { result, telemetry: { readerSetupMs: openedAt - workerStartedAt, queryMs: completedAt - openedAt } };
}

// parentPort is only set when this file is actually loaded as a worker
// thread (`new Worker(WORKER_PATH)`); guarded so the connection cache below
// can also be unit-tested by requiring this module directly. The reader
// tears a worker down with terminate(), not a message, so open connections
// are released by the thread exiting, not by a graceful shutdown path here.
if (parentPort) {
  parentPort.on("message", (message) => {
    const post = (result) => parentPort.postMessage({ requestId: message.requestId, ...result });
    const fail = (error) => parentPort.postMessage({ requestId: message.requestId, error: error?.message ?? String(error) });
    if (message.kind === "band-history") {
      runBand(message).then(post, fail);
      return;
    }
    try {
      post(runOne(message));
    } catch (error) {
      fail(error);
    }
  });
}

module.exports = { connectionFor, runOne, runBand };
