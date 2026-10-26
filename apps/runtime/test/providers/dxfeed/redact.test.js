const { REDACTED, redactSecrets, redactError } = require("../../../src/providers/dxfeed/redact");

describe("redactSecrets", () => {
  test("replaces every occurrence of a secret with [REDACTED]", () => {
    expect(redactSecrets("token=abc123 leaked abc123 again", ["abc123"])).toBe(
      "token=[REDACTED] leaked [REDACTED] again",
    );
  });

  test("replaces multiple distinct secrets independently", () => {
    expect(redactSecrets("a=one b=two", ["one", "two"])).toBe("a=[REDACTED] b=[REDACTED]");
  });

  test("ignores falsy secrets in the list rather than throwing", () => {
    expect(redactSecrets("hello world", ["", null, undefined])).toBe("hello world");
  });

  test("passes non-string input through unchanged", () => {
    expect(redactSecrets(undefined, ["secret"])).toBeUndefined();
    expect(redactSecrets(42, ["secret"])).toBe(42);
  });

  test("treats a missing or invalid secrets collection as empty", () => {
    expect(redactSecrets("hello", undefined)).toBe("hello");
    expect(redactSecrets("hello", "not-an-array")).toBe("hello");
  });
});

describe("redactError", () => {
  test("returns type and redacted message", () => {
    const result = redactError({ type: "AUTH_FAILED", message: "bad token abc123" }, ["abc123"]);
    expect(result).toEqual({ type: "AUTH_FAILED", message: "bad token [REDACTED]" });
  });

  test("tolerates a missing message or type", () => {
    expect(redactError({}, ["abc123"])).toEqual({ type: undefined, message: undefined });
  });

  test("normalizes non-string messages without losing redaction", () => {
    expect(redactError({ type: 42, message: 123 }, [])).toEqual({ type: undefined, message: "123" });
  });

  test("the redaction marker is a named constant", () => {
    expect(REDACTED).toBe("[REDACTED]");
  });

  test("does not execute hostile error getters while attempting to log an upstream failure", () => {
    const error = {};
    Object.defineProperty(error, "message", { get: () => { throw new Error("secret-token"); } });
    Object.defineProperty(error, "type", { get: () => { throw new Error("secret-token"); } });
    expect(redactError(error, ["secret-token"])).toEqual({ type: undefined, message: undefined });
  });

  test("fails safely when an adversarial proxy blocks descriptor inspection", () => {
    const error = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("secret-token"); } });
    expect(redactError(error, ["secret-token"])).toEqual({
      type: undefined,
      message: "unreadable upstream error",
    });
  });
});
