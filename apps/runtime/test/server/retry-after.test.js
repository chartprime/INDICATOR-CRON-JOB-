"use strict";

const { retryAfterHeaders } = require("../../src/server/retry-after");
const { rateLimitWaitMs } = require("../../src/storage/rate-limit-pause");

describe("retry-after on refusals", () => {
  test("a 429 carrying retryAfterMs also carries a Retry-After header in whole seconds, rounded up", () => {
    expect(retryAfterHeaders(429, { retryAfterMs: 1 })).toEqual({ "retry-after": "1" });
    expect(retryAfterHeaders(429, { retryAfterMs: 41_200 })).toEqual({ "retry-after": "42" });
  });

  test("anything else carries no header", () => {
    expect(retryAfterHeaders(200, { retryAfterMs: 5_000 })).toEqual({});
    expect(retryAfterHeaders(429, {})).toEqual({});
    expect(retryAfterHeaders(429, { retryAfterMs: 0 })).toEqual({});
    expect(retryAfterHeaders(429, null)).toEqual({});
  });

  test("a reader prefers the body's millisecond hint over the rounded header, and falls back to the header", async () => {
    const withBody = new Response(JSON.stringify({ retryAfterMs: 1_250 }), { status: 429, headers: { "retry-after": "2" } });
    await expect(rateLimitWaitMs(withBody)).resolves.toBe(1_250);
    const headerOnly = new Response("", { status: 429, headers: { "retry-after": "3" } });
    await expect(rateLimitWaitMs(headerOnly)).resolves.toBe(3_000);
  });
});
