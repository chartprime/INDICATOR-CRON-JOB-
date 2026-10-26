"use strict";

function retryAfterHeaders(status, body) {
  if (status !== 429) return {};
  const retryAfterMs = body?.retryAfterMs;
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0) return {};
  return { "retry-after": String(Math.ceil(retryAfterMs / 1_000)) };
}

module.exports = { retryAfterHeaders };
