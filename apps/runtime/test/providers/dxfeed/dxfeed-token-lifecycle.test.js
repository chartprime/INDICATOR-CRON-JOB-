const {
  SHUTDOWN_MARGIN_MS,
  MAX_TOKEN_LIFETIME_MS,
  parseExpiresAtMs,
  computeShutdownDeadlineMs,
  resolveShutdownDeadline,
} = require("../../../src/providers/dxfeed/dxfeed-token-lifecycle");

const NOW_MS = 1_800_000_000_000;

describe("parseExpiresAtMs", () => {
  test("parses a valid, canonical ISO timestamp to epoch ms", () => {
    expect(parseExpiresAtMs("2026-01-01T00:30:00.000Z")).toBe(Date.parse("2026-01-01T00:30:00.000Z"));
  });

  test("returns null for missing, blank, or unparseable values", () => {
    expect(parseExpiresAtMs(undefined)).toBeNull();
    expect(parseExpiresAtMs("")).toBeNull();
    expect(parseExpiresAtMs("   ")).toBeNull();
    expect(parseExpiresAtMs("not-a-date")).toBeNull();
    expect(parseExpiresAtMs(42)).toBeNull();
  });

  test("rejects a non-canonical ISO string even if Date.parse would accept it", () => {
    expect(parseExpiresAtMs("2026-01-01T00:30:00Z")).toBeNull();
  });
});

describe("computeShutdownDeadlineMs", () => {
  test("subtracts the margin from the expiry", () => {
    expect(computeShutdownDeadlineMs(NOW_MS + 30 * 60_000, SHUTDOWN_MARGIN_MS)).toBe(NOW_MS + 25 * 60_000);
  });
});

describe("resolveShutdownDeadline", () => {
  test("resolves a valid, well-bounded expiry to the correct deadline", () => {
    const expiresAt = new Date(NOW_MS + 30 * 60_000).toISOString();
    expect(resolveShutdownDeadline(expiresAt, NOW_MS)).toEqual({ ok: true, shutdownDeadlineMs: NOW_MS + 25 * 60_000 });
  });

  test("fails closed on an invalid clock", () => {
    expect(resolveShutdownDeadline(new Date(NOW_MS + 30 * 60_000).toISOString(), 0)).toEqual({
      ok: false,
      reason: "INVALID_CLOCK",
    });
    expect(resolveShutdownDeadline(new Date(NOW_MS + 30 * 60_000).toISOString(), -1)).toEqual({
      ok: false,
      reason: "INVALID_CLOCK",
    });
  });

  test("fails closed on a missing or invalid expiry", () => {
    expect(resolveShutdownDeadline(undefined, NOW_MS)).toEqual({ ok: false, reason: "MISSING_OR_INVALID_EXPIRY" });
    expect(resolveShutdownDeadline("garbage", NOW_MS)).toEqual({ ok: false, reason: "MISSING_OR_INVALID_EXPIRY" });
  });

  test("fails closed on an expiry beyond the approved token lifetime", () => {
    const tooFar = new Date(NOW_MS + MAX_TOKEN_LIFETIME_MS + 60_000).toISOString();
    expect(resolveShutdownDeadline(tooFar, NOW_MS)).toEqual({ ok: false, reason: "EXPIRY_EXCEEDS_APPROVED_LIFETIME" });
  });

  test("accepts an expiry exactly at the approved lifetime boundary", () => {
    const exact = new Date(NOW_MS + MAX_TOKEN_LIFETIME_MS).toISOString();
    expect(resolveShutdownDeadline(exact, NOW_MS).ok).toBe(true);
  });

  test("fails closed when the token is already past its safe margin", () => {
    const almostExpired = new Date(NOW_MS + 60_000).toISOString();
    expect(resolveShutdownDeadline(almostExpired, NOW_MS)).toEqual({ ok: false, reason: "PAST_SAFE_MARGIN" });
  });

  test("fails closed exactly at the safe-margin boundary, not just past it", () => {
    const exactlyAtMargin = new Date(NOW_MS + SHUTDOWN_MARGIN_MS).toISOString();
    expect(resolveShutdownDeadline(exactlyAtMargin, NOW_MS)).toEqual({ ok: false, reason: "PAST_SAFE_MARGIN" });
  });
});
