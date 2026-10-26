const {
  requestDevelopmentToken,
  parseDevelopmentTokenResponse,
  TOKEN_PATH,
  MAX_TOKEN_TTL_MS,
  TOKEN_REQUEST_HEADERS,
  isRetryableTokenBrokerError,
} = require("../../../src/providers/dxfeed/token-broker-client");

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status });
}

const BROKER_URL = "https://tt-dxfeed-token-broker.tail1234.ts.net";

describe("requestDevelopmentToken", () => {
  test.each([false, true])("owner cancellation aborts transport and removes the deadline; already aborted=%s", async (alreadyAborted) => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = jest.fn(() => new Promise(() => {}));
    if (alreadyAborted) controller.abort();
    const request = requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl, signal: controller.signal });
    controller.abort();
    try {
      await expect(request).rejects.toMatchObject({ code: "DXFEED_TOKEN_BROKER_CANCELLED", retryable: false });
      if (alreadyAborted) expect(fetchImpl).not.toHaveBeenCalled();
      else expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
  test("resolves { token, expiresAt } on a well-formed 200 JSON response", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ token: "abc.def", expiresAt: "2026-01-01T00:30:00.000Z" }),
    );
    const result = await requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl, now: () => 1_767_225_600_000 });
    expect(result).toEqual({ token: "abc.def", expiresAt: "2026-01-01T00:30:00.000Z" });
  });

  test("posts to the documented token path with no query/fragment", async () => {
    const nowMs = Date.now();
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def", expiresAt: new Date(nowMs + 30 * 60_000).toISOString() }));
    await requestDevelopmentToken({ brokerUrl: `${BROKER_URL}/`, fetchImpl, now: () => nowMs });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://tt-dxfeed-token-broker.tail1234.ts.net${TOKEN_PATH}`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("sends the complete broker request contract, including real-time entitlement and client version", async () => {
    const nowMs = Date.now();
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def", expiresAt: new Date(nowMs + 30 * 60_000).toISOString() }));
    await requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl, now: () => nowMs });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: TOKEN_REQUEST_HEADERS }),
    );
  });

  test("refuses to follow a redirect, so the token request can never be bounced to another host", async () => {
    const nowMs = Date.now();
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def", expiresAt: new Date(nowMs + 30 * 60_000).toISOString() }));
    await requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl, now: () => nowMs });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "error" }));
  });

  test("a transport abort is reported as a retryable timeout", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const request = requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl });
    await expect(request).rejects.toMatchObject({ code: "DXFEED_TOKEN_BROKER_TIMEOUT", retryable: true });
  });

  test("throws a clearly-prefixed error on a non-2xx status, without echoing response body text", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ error: "forbidden, secret leak here" }, { status: 403 }));
    let thrown = null;
    try {
      await requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).toMatch(/dxfeed-token-broker:.*403/);
    expect(thrown.message).not.toContain("secret leak here");
    expect(thrown.status).toBe(403);
    expect(isRetryableTokenBrokerError(thrown)).toBe(false);
  });

  test("marks transient broker outcomes retryable but never treats ordinary authorization failures as transient", async () => {
    const nowMs = Date.now();
    const retriableStatuses = [408, 425, 429, 500, 503];
    for (const status of retriableStatuses) {
      let thrown = null;
      try {
        await requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl: async () => jsonResponse({}, { status }), now: () => nowMs });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
      expect(isRetryableTokenBrokerError(thrown)).toBe(true);
    }
  });

  test("throws on a malformed (non-JSON) response body", async () => {
    const fetchImpl = jest.fn(async () => new Response("not json", { status: 200 }));
    await expect(requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl })).rejects.toThrow(
      /dxfeed-token-broker/,
    );
  });

  test("throws when JSON is valid but missing the expected token field without echoing untrusted keys", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ "token=secret-value": "ok", ttl: 1800 }));
    let thrown = null;
    try {
      await requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).toMatch(/invalid "token" field/);
    expect(thrown.message).not.toContain("secret-value");
  });

  test("throws when the body parses to a non-object, reporting typeof rather than attempting Object.keys()", async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify("just-a-string"), { status: 200 }));
    let thrown = null;
    try {
      await requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).toContain("string");
  });

  test("rejects a response that omits the authoritative expiry field", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "abc.def" }));
    await expect(requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl })).rejects.toThrow(/invalid "expiresAt"/);
  });

  test("rejects a malformed or already-expired broker expiry instead of launching with unusable credentials", async () => {
    const now = () => 1_700_000_000_000;
    await expect(
      requestDevelopmentToken({
        brokerUrl: BROKER_URL,
        fetchImpl: async () => jsonResponse({ token: "abc.def", expiresAt: "not-a-date" }),
        now,
      }),
    ).rejects.toThrow(/invalid "expiresAt"/);
    await expect(
      requestDevelopmentToken({
        brokerUrl: BROKER_URL,
        fetchImpl: async () => jsonResponse({ token: "abc.def", expiresAt: new Date(now()).toISOString() }),
        now,
      }),
    ).rejects.toThrow(/expired token/);
    await expect(
      requestDevelopmentToken({
        brokerUrl: BROKER_URL,
        fetchImpl: async () => jsonResponse({ token: "abc.def", expiresAt: new Date(now() + MAX_TOKEN_TTL_MS + 1).toISOString() }),
        now,
      }),
    ).rejects.toThrow(/outside the approved temporary-token lifetime/);
  });

  test("rejects an invalid injected clock result", async () => {
    await expect(
      requestDevelopmentToken({
        brokerUrl: BROKER_URL,
        fetchImpl: async () => jsonResponse({ token: "abc.def", expiresAt: "2026-01-01T00:30:00.000Z" }),
        now: () => Number.NaN,
      }),
    ).rejects.toThrow(/clock returned an invalid timestamp/);
  });

  test("times out and throws a clear error when fetchImpl never resolves", async () => {
    const fetchImpl = jest.fn(() => new Promise(() => {}));
    await expect(
      requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/);
  });

  test("rejects a missing or blank brokerUrl before ever invoking fetchImpl", async () => {
    const fetchImpl = jest.fn();
    await expect(requestDevelopmentToken({ brokerUrl: "", fetchImpl })).rejects.toThrow(/dxfeed-token-broker/);
    await expect(requestDevelopmentToken({ brokerUrl: undefined, fetchImpl })).rejects.toThrow(/dxfeed-token-broker/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a non-https brokerUrl before ever invoking fetchImpl", async () => {
    const fetchImpl = jest.fn();
    await expect(
      requestDevelopmentToken({ brokerUrl: "http://tt-dxfeed-token-broker.tail1234.ts.net", fetchImpl }),
    ).rejects.toThrow(/https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a non-Tailscale broker host and URL components outside the broker-origin contract", async () => {
    const fetchImpl = jest.fn();
    await expect(requestDevelopmentToken({ brokerUrl: "https://broker.example.com", fetchImpl })).rejects.toThrow(/Tailscale/);
    await expect(requestDevelopmentToken({ brokerUrl: `${BROKER_URL}/other`, fetchImpl })).rejects.toThrow(/origin/);
    await expect(requestDevelopmentToken({ brokerUrl: `https://user:pass@tt-dxfeed-token-broker.tail1234.ts.net`, fetchImpl })).rejects.toThrow(/origin/);
    await expect(requestDevelopmentToken({ brokerUrl: `${BROKER_URL}?token=secret`, fetchImpl })).rejects.toThrow(/origin/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects malformed broker tokens and invalid request controls before any live-bound side effect", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ token: "not a token" }));
    await expect(requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl })).rejects.toThrow(/invalid "token" field/);
    await expect(requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl: jest.fn(), timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    await expect(requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl: jest.fn(), maxResponseBytes: 0 })).rejects.toThrow(/maxResponseBytes/);
    await expect(requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl: jest.fn(), now: null })).rejects.toThrow(/now/);
  });

  test("rejects a response once its streamed byte total exceeds the ceiling, without buffering it whole", async () => {
    const bigChunk = new Uint8Array(1024).fill(65);
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(bigChunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = jest.fn(async () => new Response(stream, { status: 200 }));
    await expect(
      requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl, maxResponseBytes: 2048 }),
    ).rejects.toThrow(/dxfeed-token-broker/);
    expect(cancelled).toBe(true);
  });

  test("accepts a response body exactly at maxResponseBytes, the boundary-exact case", async () => {
    const nowMs = Date.now();
    const body = JSON.stringify({ token: "abc.def", expiresAt: new Date(nowMs + 30 * 60_000).toISOString() });
    const bodyBytes = new TextEncoder().encode(body);
    const fetchImpl = jest.fn(async () => new Response(bodyBytes, { status: 200 }));
    const result = await requestDevelopmentToken({
      brokerUrl: BROKER_URL,
      fetchImpl,
      maxResponseBytes: bodyBytes.length,
      now: () => nowMs,
    });
    expect(result.token).toBe("abc.def");
  });

  test("rejects a stream chunk that is not a genuine Uint8Array rather than reading through it", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("not-a-uint8array");
        controller.close();
      },
    });
    const fetchImpl = jest.fn(async () => new Response(stream, { status: 200 }));
    await expect(requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl })).rejects.toThrow(
      /dxfeed-token-broker/,
    );
  });

  test("never lets a raw secret surfaced by fetchImpl's own error leak into the thrown message", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("connect failed, cached-token=super-secret-leaked-value");
    });
    let thrown = null;
    try {
      await requestDevelopmentToken({ brokerUrl: BROKER_URL, fetchImpl });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).not.toContain("super-secret-leaked-value");
  });
});

describe("parseDevelopmentTokenResponse", () => {
  test("is exported directly for isolated testing of the authoritative fields", () => {
    const now = () => 0;
    expect(parseDevelopmentTokenResponse({ token: "a.b", expiresAt: new Date(30 * 60_000).toISOString() }, now)).toEqual({
      token: "a.b",
      expiresAt: new Date(30 * 60_000).toISOString(),
    });
  });
});

describe("token request timeout", () => {
  function defaultTimeoutWith(envValue) {
    const previous = process.env.TT_DXFEED_TOKEN_TIMEOUT_MS;
    if (envValue === undefined) delete process.env.TT_DXFEED_TOKEN_TIMEOUT_MS;
    else process.env.TT_DXFEED_TOKEN_TIMEOUT_MS = envValue;
    let loaded;
    try {
      jest.isolateModules(() => {
        loaded = require("../../../src/providers/dxfeed/token-broker-client");
      });
    } finally {
      if (previous === undefined) delete process.env.TT_DXFEED_TOKEN_TIMEOUT_MS;
      else process.env.TT_DXFEED_TOKEN_TIMEOUT_MS = previous;
    }
    return loaded.DEFAULT_TIMEOUT_MS;
  }

  test("waits thirty seconds for the broker by default, or what TT_DXFEED_TOKEN_TIMEOUT_MS says when it is a positive number", () => {
    expect(defaultTimeoutWith(undefined)).toBe(30_000);
    expect(defaultTimeoutWith("45000")).toBe(45_000);
    expect(defaultTimeoutWith("nope")).toBe(30_000);
    expect(defaultTimeoutWith("-5")).toBe(30_000);
    expect(defaultTimeoutWith("")).toBe(30_000);
  });
});
