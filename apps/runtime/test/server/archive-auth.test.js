"use strict";

const {
  createArchiveAuth,
  parseClientTokens,
  bearerToken,
  MIN_TOKEN_LENGTH,
  MAX_AUTHORIZATION_LENGTH,
} = require("../../src/server/archive-auth");

const SECRET_A = "a".repeat(MIN_TOKEN_LENGTH);
const SECRET_B = "b".repeat(MIN_TOKEN_LENGTH);
const TOKENS = `viewer-1:${SECRET_A},viewer-2:${SECRET_B}`;

describe("archive auth", () => {
  it("refuses an Authorization header longer than the cap, even one carrying a configured token", () => {
    const long = "c".repeat(MAX_AUTHORIZATION_LENGTH);
    const auth = createArchiveAuth({ clientTokens: `viewer-long:${long}` });

    expect(auth.identify(`Bearer ${long}`)).toBeNull();
    const fits = createArchiveAuth({ clientTokens: `viewer-fits:${long.slice(0, MAX_AUTHORIZATION_LENGTH - "Bearer ".length)}` });
    expect(fits.identify(`Bearer ${long.slice(0, MAX_AUTHORIZATION_LENGTH - "Bearer ".length)}`)).toBe("viewer-fits");
  });

  it("resolves a bearer token to the stable client id it was issued for", () => {
    const auth = createArchiveAuth({ clientTokens: TOKENS });

    expect(auth.identify(`Bearer ${SECRET_A}`)).toBe("viewer-1");
    expect(auth.identify(`Bearer ${SECRET_B}`)).toBe("viewer-2");
    expect(auth.clientCount).toBe(2);
  });

  it.each([
    ["an unknown token", `Bearer ${"z".repeat(MIN_TOKEN_LENGTH)}`],
    ["a truncated token", `Bearer ${SECRET_A.slice(0, -1)}`],
    ["a token with trailing data", `Bearer ${SECRET_A}x`],
    ["no scheme", SECRET_A],
    ["the wrong scheme", `Basic ${SECRET_A}`],
    ["an empty header", ""],
    ["a missing header", undefined],
    ["a lowercase scheme", `bearer ${SECRET_A}`],
  ])("refuses %s", (_label, authorization) => {
    const auth = createArchiveAuth({ clientTokens: TOKENS });

    expect(auth.identify(authorization)).toBeNull();
  });

  it("identifies nobody when no tokens are configured", () => {
    // An unconfigured deployment must reject every caller rather than admit
    // them all, which is what returning a default identity would do.
    const auth = createArchiveAuth({ clientTokens: "" });

    expect(auth.identify(`Bearer ${SECRET_A}`)).toBeNull();
    expect(auth.clientCount).toBe(0);
  });

  it("refuses an oversized authorization header without hashing it", () => {
    const auth = createArchiveAuth({ clientTokens: TOKENS });

    expect(auth.identify(`Bearer ${"a".repeat(1_000_000)}`)).toBeNull();
  });

  it.each([
    ["a token with no client id", `:${SECRET_A}`],
    ["a token with no separator", "viewer-1"],
    ["a token shorter than the floor", `viewer-1:${"a".repeat(MIN_TOKEN_LENGTH - 1)}`],
    ["a duplicate client id", `viewer-1:${SECRET_A},viewer-1:${SECRET_B}`],
    ["a client id with a space", `view er:${SECRET_A}`],
    ["a secret a bearer header cannot carry", `viewer-1:${"c".repeat(MIN_TOKEN_LENGTH)}:tail`],
  ])("rejects %s at construction rather than at request time", (_label, raw) => {
    expect(() => parseClientTokens(raw)).toThrow(/archive-auth/);
  });

  it("refuses a secret that would parse but could never be presented", () => {
    // The parser splits on the first colon, so a secret containing one is
    // readable here -- but a colon is outside RFC 6750's token68, so that
    // credential could never arrive in an Authorization header. A token that is
    // accepted at startup and silently never works is worse than a refusal.
    expect(() => parseClientTokens(`viewer-3:${"c".repeat(MIN_TOKEN_LENGTH)}:tail`))
      .toThrow(/bearer credential cannot carry/);
  });

  it("extracts exactly one space-delimited bearer value", () => {
    expect(bearerToken(`Bearer ${SECRET_A}`)).toBe(SECRET_A);
    expect(bearerToken(`Bearer  ${SECRET_A}`)).toBeNull();
    expect(bearerToken(`Bearer ${SECRET_A} extra`)).toBeNull();
  });

  it("uses the configured token grammar when parsing a bearer header", () => {
    expect(bearerToken(`Bearer ${SECRET_A.slice(0, 12)}=${SECRET_A.slice(12)}`)).toBeNull();
    expect(bearerToken(`Bearer ${SECRET_A}==`)).toBe(`${SECRET_A}==`);
  });
});
