"use strict";

async function remoteErrorDiagnostic(response, correlationId, token) {
  const clean = (value) => typeof value === "string" ? value.split(token).join("[REDACTED]").slice(0, 256) : null;
  let body = null;
  try {
    const reader = response.clone().body.getReader();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 1_000);
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 4_096) { void reader.cancel().catch(() => {}); break; }
        chunks.push(Buffer.from(chunk.value));
      }
      if (!timedOut && length <= 4_096) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  } catch { body = null; }
  return {
    correlationId: clean(correlationId),
    error: clean(body?.error), detail: clean(body?.detail),
  };
}

module.exports = { remoteErrorDiagnostic };
