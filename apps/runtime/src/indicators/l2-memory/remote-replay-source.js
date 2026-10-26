"use strict";

const crypto = require("node:crypto");
const { rateLimitWaitMs, createPauses } = require("../../storage/rate-limit-pause");
const { hostReadMeter } = require("../../platform/host-read-meter");

const CONTRACT_VERSION_HEADER = "x-live-storage-contract-version";
const CONTRACT_VERSION = "live-storage/1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_750_000;
const MAX_PAGES = 2_048;
const DEFAULT_RATE_LIMIT_BUDGET_MS = 60_000;
const MAX_TRANSIENT_RETRIES = 4;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTuples(value) {
  return Array.isArray(value) && value.every((tuple) => Array.isArray(tuple) && tuple.length === 2 &&
    Number.isFinite(Number(tuple[0])) && Number(tuple[0]) > 0 &&
    Number.isFinite(Number(tuple[1])) && Number(tuple[1]) >= 0);
}

function validPriceOrNull(value) {
  return value === null || (Number.isFinite(Number(value)) && Number(value) > 0);
}

function validBook(book) {
  if (!isRecord(book)) return false;
  if (book.bids === undefined && book.asks === undefined) {
    return validPriceOrNull(book.bestBid) && validPriceOrNull(book.bestAsk);
  }
  return validTuples(book.bids) && validTuples(book.asks);
}

function validFrame(frame) {
  if (!isRecord(frame) || !Number.isSafeInteger(frame.ts) || frame.ts < 0) return false;
  if (frame.kind === "anchor") return Number.isSafeInteger(frame.lastUpdateId) || frame.lastUpdateId === undefined;
  if (frame.kind === "trade") {
    return Number.isFinite(Number(frame.price)) && Number(frame.price) > 0 &&
      Number.isFinite(Number(frame.size)) && Number(frame.size) >= 0 &&
      (frame.side === "buy" || frame.side === "sell" || frame.side === null);
  }
  return frame.kind === "book" && frame.status === "READY" && validBook(frame.book) && isRecord(frame.delta) &&
    validTuples(frame.delta.bids) && validTuples(frame.delta.asks);
}

function unknownBookModeRefusal(body) {
  return isRecord(body) && typeof body.detail === "string" &&
    body.detail.startsWith("UNKNOWN_OPTIONS:") && body.detail.slice("UNKNOWN_OPTIONS:".length).split(",").includes("bookMode");
}

async function readBoundedJson(response, maxBytes) {
  if (!(response?.body instanceof ReadableStream)) throw new Error("REMOTE_RESPONSE_STREAM_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new Error("REMOTE_RESPONSE_CHUNK_INVALID");
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error("REMOTE_RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

function createSource({
  symbol, marketKind, fromTs, toTs, tickSize, clusterTicks, rowClusters, windowRows, remote,
  fetchImpl = (...args) => fetch(...args), meter = hostReadMeter,
} = {}) {
  if (!isRecord(remote) || typeof remote.baseUrl !== "string" || typeof remote.token !== "string" ||
      remote.baseUrl.length === 0 || remote.token.length === 0) {
    throw new Error("remote-replay-source: remote baseUrl and token are required");
  }
  const timeoutMs = remote.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = remote.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const rateLimitBudgetMs = remote.rateLimitBudgetMs ?? DEFAULT_RATE_LIMIT_BUDGET_MS;
  const pauses = createPauses();
  let rateLimitedMs = 0;
  let transientRetryMs = 0;
  const provider = marketKind === "FUTURE" || marketKind === "EQUITY" ? "dxfeed" : "binance";
  const baseUrl = remote.baseUrl.endsWith("/") ? remote.baseUrl.slice(0, -1) : remote.baseUrl;
  const controllers = new Set();
  const stats = { pages: 0, frames: 0, bookMode: "sparse" };
  let closed = false;

  async function request(cursor, transientFailures = 0) {
    if (closed) throw new Error("remote-replay-source: closed");
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const identity = provider === "dxfeed" ? { assetClass: marketKind } : { marketKind };
    try {
      const response = await fetchImpl(`${baseUrl}/replay-page`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${remote.token}`,
          "content-type": "application/json",
          [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
          "x-terminal-correlation-id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          provider, symbol, ...identity,
          options: {
            fromTs, toTs, tickSize, clusterTicks, rowClusters, windowRows, cursor,
            ...(stats.bookMode === "sparse" ? { bookMode: "sparse" } : {}),
          },
        }),
      });
      meter.record("replay-page", response.status);
      if (response.status === 429) {
        const waitMs = await rateLimitWaitMs(response);
        if (closed || rateLimitedMs + transientRetryMs + waitMs > rateLimitBudgetMs) throw new Error("REMOTE_REPLAY_HTTP_429");
        rateLimitedMs += waitMs;
        stats.rateLimitedMs = rateLimitedMs;
        clearTimeout(timer);
        controllers.delete(controller);
        await pauses.pause(waitMs);
        if (closed) throw new Error("remote-replay-source: closed");
        return request(cursor, transientFailures);
      }
      if (response.status === 503) {
        const waitMs = Math.max(await rateLimitWaitMs(response), Math.min(16_000, 1_000 * 2 ** transientFailures));
        if (closed || transientFailures >= MAX_TRANSIENT_RETRIES ||
            rateLimitedMs + transientRetryMs + waitMs > rateLimitBudgetMs) {
          throw new Error("REMOTE_REPLAY_HTTP_503");
        }
        transientRetryMs += waitMs;
        stats.transientRetryMs = transientRetryMs;
        clearTimeout(timer);
        controllers.delete(controller);
        await pauses.pause(waitMs);
        if (closed) throw new Error("remote-replay-source: closed");
        return request(cursor, transientFailures + 1);
      }
      if (response.status === 400 && stats.bookMode === "sparse") {
        const refusal = await readBoundedJson(response, maxResponseBytes).catch(() => null);
        if (unknownBookModeRefusal(refusal)) {
          stats.bookMode = "full";
          return request(cursor);
        }
        throw new Error("REMOTE_REPLAY_HTTP_400");
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`REMOTE_REPLAY_HTTP_${response.status}`);
      if (response.headers.get(CONTRACT_VERSION_HEADER) !== CONTRACT_VERSION) throw new Error("REMOTE_REPLAY_CONTRACT_MISMATCH");
      const page = await readBoundedJson(response, maxResponseBytes);
      if (!isRecord(page) || !Array.isArray(page.frames) || typeof page.complete !== "boolean" ||
          (!page.complete && typeof page.nextCursor !== "string") || !page.frames.every(validFrame)) {
        throw new Error("REMOTE_REPLAY_PAGE_INVALID");
      }
      return page;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function* frames() {
    let cursor = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await request(cursor);
      stats.pages += 1;
      for (const frame of page.frames) {
        stats.frames += 1;
        yield frame;
      }
      if (page.complete) return;
      if (page.nextCursor === cursor) throw new Error("REMOTE_REPLAY_CURSOR_STALLED");
      cursor = page.nextCursor;
    }
    throw new Error("REMOTE_REPLAY_PAGE_LIMIT_EXCEEDED");
  }

  function close() {
    closed = true;
    pauses.releaseAll();
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }

  return Object.freeze({ frames, stats, close });
}

module.exports = { createSource, validFrame, DEFAULT_MAX_RESPONSE_BYTES, MAX_PAGES };
