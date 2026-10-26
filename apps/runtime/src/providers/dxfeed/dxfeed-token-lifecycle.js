const SHUTDOWN_MARGIN_MS = 5 * 60_000;
const MAX_TOKEN_LIFETIME_MS = 35 * 60_000;
const PLANNED_ROTATION_EXIT_CODE = 75;
const UNEXPECTED_DISCONNECT_EXIT_CODE = 76;

function parseExpiresAtMs(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function computeShutdownDeadlineMs(expiresAtMs, marginMs) {
  return expiresAtMs - marginMs;
}

function resolveShutdownDeadline(expiresAtRaw, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return { ok: false, reason: "INVALID_CLOCK" };
  }
  const expiresAtMs = parseExpiresAtMs(expiresAtRaw);
  if (expiresAtMs === null) {
    return { ok: false, reason: "MISSING_OR_INVALID_EXPIRY" };
  }
  if (expiresAtMs - nowMs > MAX_TOKEN_LIFETIME_MS) {
    return { ok: false, reason: "EXPIRY_EXCEEDS_APPROVED_LIFETIME" };
  }
  const shutdownDeadlineMs = computeShutdownDeadlineMs(expiresAtMs, SHUTDOWN_MARGIN_MS);
  if (shutdownDeadlineMs <= nowMs) {
    return { ok: false, reason: "PAST_SAFE_MARGIN" };
  }
  return { ok: true, shutdownDeadlineMs };
}

module.exports = {
  SHUTDOWN_MARGIN_MS,
  MAX_TOKEN_LIFETIME_MS,
  PLANNED_ROTATION_EXIT_CODE,
  UNEXPECTED_DISCONNECT_EXIT_CODE,
  parseExpiresAtMs,
  computeShutdownDeadlineMs,
  resolveShutdownDeadline,
};
