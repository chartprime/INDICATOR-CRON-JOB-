"use strict";

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS = 20_000;
const MAX_REFUSAL_BODY_BYTES = 4_096;

function retryAfterMs(value, nowMs = Date.now()) {
  if (typeof value !== "string" || value.trim().length === 0) return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
  }
  const atMs = Date.parse(value);
  if (!Number.isFinite(atMs)) return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, atMs - nowMs));
}

async function refusalBodyRetryAfterMs(response) {
  let reader;
  try {
    reader = response.body?.getReader?.();
  } catch {
    return null;
  }
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (!chunk || chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) return null;
      total += chunk.value.byteLength;
      if (total > MAX_REFUSAL_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const value = body?.retryAfterMs;
    return Number.isSafeInteger(value) && value > 0 ? Math.min(MAX_RETRY_AFTER_MS, value) : null;
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      void 0;
    }
  }
}

async function rateLimitWaitMs(response, nowMs = Date.now()) {
  const fromBody = await refusalBodyRetryAfterMs(response);
  if (fromBody !== null) return fromBody;
  return retryAfterMs(response.headers?.get?.("retry-after") ?? null, nowMs);
}

function createPauses() {
  const waiting = new Set();
  function pause(ms, signal) {
    return new Promise((resolve) => {
      const entry = { resolve: () => { clearTimeout(entry.timer); waiting.delete(entry); signal?.removeEventListener?.("abort", entry.resolve); resolve(); } };
      entry.timer = setTimeout(entry.resolve, Math.max(0, ms));
      entry.timer.unref?.();
      waiting.add(entry);
      if (signal?.aborted) entry.resolve();
      else signal?.addEventListener?.("abort", entry.resolve, { once: true });
    });
  }
  function releaseAll() {
    for (const entry of [...waiting]) entry.resolve();
  }
  return Object.freeze({ pause, releaseAll });
}

module.exports = {
  retryAfterMs, rateLimitWaitMs, refusalBodyRetryAfterMs, createPauses,
  DEFAULT_RATE_LIMIT_BACKOFF_MS, MAX_RETRY_AFTER_MS, DEFAULT_RATE_LIMIT_RETRY_BUDGET_MS,
};
