"use strict";

const http = require("node:http");
const zlib = require("node:zlib");
const { createArchiveAuth, MIN_TOKEN_LENGTH } = require("../../src/server/archive-auth");
const { createLiveStorageRelay, createLiveStorageRelayOrRefuse, MAX_UPSTREAM_RESPONSE_BYTES_BY_ROUTE } = require("../../src/server/live-storage-relay");
const { LIVE_STORAGE_PATH_PREFIX, SERVICE_SECRET_HEADER, CLIENT_HEADER, CONTRACT_VERSION_HEADER, CORRELATION_ID_HEADER, CONTRACT_VERSION } = require("../../src/server/live-storage-route");

const SECRET_A = "a".repeat(MIN_TOKEN_LENGTH);
const SERVICE_SECRET = "internal-service-secret-under-test";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function fakeLiveStorageService(handler) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader(CONTRACT_VERSION_HEADER, CONTRACT_VERSION);
      const record = { url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8"), request, response };
      seen.push(record);
      handler(record);
    });
  });
  await listen(server);
  return { seen, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function gateway(options = {}) {
  const relay = createLiveStorageRelay({
    auth: createArchiveAuth({ clientTokens: `laptop-1:${SECRET_A}` }),
    serviceSecret: SERVICE_SECRET,
    log: () => {},
    ...options,
  });
  const server = http.createServer((request, response) => {
    if (relay.handle(request, response)) return;
    response.writeHead(404);
    response.end();
  });
  await listen(server);
  return { relay, server, base: `http://127.0.0.1:${server.address().port}` };
}

function validBody(overrides = {}) {
  return { symbol: "BTCUSDT", marketKind: "SPOT", options: { nowMs: 1 }, ...overrides };
}

async function post(base, routeName, body, { token = SECRET_A, headers = {} } = {}) {
  const response = await fetch(`${base}${LIVE_STORAGE_PATH_PREFIX}${routeName}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION, ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? null : JSON.parse(text) };
}

describe("server/live-storage-relay", () => {
  test("band-history relay accepts the same bounded response size as both remote readers", () => {
    const { MAX_RESPONSE_BYTES_BY_ROUTE: binance } = require("../../src/storage/remote-storage-reader");
    const { MAX_RESPONSE_BYTES_BY_ROUTE: dxfeed } = require("../../src/storage/dxfeed/remote-dxfeed-storage-reader");
    expect(MAX_UPSTREAM_RESPONSE_BYTES_BY_ROUTE["band-history"]).toBe(binance["band-history"]);
    expect(MAX_UPSTREAM_RESPONSE_BYTES_BY_ROUTE["band-history"]).toBe(dxfeed["band-history"]);
  });
  let upstream;
  let current;
  afterEach(async () => {
    if (current) { await close(current.server); current = null; }
    if (upstream) { await close(upstream.server); upstream = null; }
  });

  test("a valid developer bearer relays with the service secret and resolved client identity, body/status passed through", async () => {
    upstream = await fakeLiveStorageService((record) => {
      record.response.writeHead(200, { "content-type": "application/json" });
      record.response.end(JSON.stringify({ latestTs: 5, ageMs: 1, available: true }));
    });
    current = await gateway({ internalUrl: upstream.url });
    const { status, body } = await post(current.base, "recording-age", validBody());
    expect(status).toBe(200);
    expect(body).toEqual({ latestTs: 5, ageMs: 1, available: true });
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0].url).toBe(`${LIVE_STORAGE_PATH_PREFIX}recording-age`);
    expect(upstream.seen[0].headers[SERVICE_SECRET_HEADER]).toBe(SERVICE_SECRET);
    expect(upstream.seen[0].headers[CLIENT_HEADER]).toBe("laptop-1");
    expect(upstream.seen[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(upstream.seen[0].body)).toEqual(validBody());
  });

  // Measured 2026-09-20: the laptop <-> host path moves ~200 KB/s and a 1 MB
  // sparse replay page gzips 7.6x, while Node's fetch already sends
  // accept-encoding: gzip and inflates transparently. Property: a body the
  // client can inflate is sent gzipped, byte-for-byte equal once inflated,
  // with content-length as the wire length; a client that did not ask, or a
  // tiny body, gets identity. Oracle: raw http, no automatic inflation.
  test("gzips a large body for a client that accepts gzip, and sends identity to one that does not", async () => {
    const big = { rows: Array.from({ length: 4_000 }, (_, i) => [1_700_000_000_000 + i * 60_000, "80373.44000000", "0.20770000"]), available: true };
    upstream = await fakeLiveStorageService((record) => {
      record.response.writeHead(200, { "content-type": "application/json" });
      record.response.end(JSON.stringify(record.url.endsWith("recording-age") ? { latestTs: 5, ageMs: 1, available: true } : big));
    });
    current = await gateway({ internalUrl: upstream.url });
    const raw = (routeName, acceptEncoding) => new Promise((resolve, reject) => {
      const url = new URL(`${current.base}${LIVE_STORAGE_PATH_PREFIX}${routeName}`);
      const request = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
        headers: {
          "content-type": "application/json", [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION, authorization: `Bearer ${SECRET_A}`,
          ...(acceptEncoding === null ? {} : { "accept-encoding": acceptEncoding }),
        },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on("error", reject);
      request.end(JSON.stringify(validBody()));
    });

    const gz = await raw("large-trades", "gzip, deflate, br");
    expect(gz.status).toBe(200);
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.headers.vary).toBe("accept-encoding");
    expect(Number(gz.headers["content-length"])).toBe(gz.body.length);
    expect(gz.body.length).toBeLessThan(JSON.stringify(big).length / 4);
    expect(JSON.parse(zlib.gunzipSync(gz.body).toString("utf8"))).toEqual(big);

    const identity = await raw("large-trades", null);
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(identity.body.toString("utf8"))).toEqual(big);

    const small = await raw("recording-age", "gzip");
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(small.body.toString("utf8"))).toEqual({ latestTs: 5, ageMs: 1, available: true });

    expect((await post(current.base, "large-trades", validBody())).body).toEqual(big);
  });

  test("preserves a valid laptop correlation ID through the relay and records route telemetry", async () => {
    upstream = await fakeLiveStorageService((record) => {
      record.response.writeHead(200, { "content-type": "application/json" });
      record.response.end("{}");
    });
    current = await gateway({ internalUrl: upstream.url });
    const result = await post(current.base, "recording-age", validBody(), {
      headers: { [CORRELATION_ID_HEADER]: "selection-7.request-3" },
    });
    expect(result.headers.get(CORRELATION_ID_HEADER)).toBe("selection-7.request-3");
    expect(upstream.seen[0].headers[CORRELATION_ID_HEADER]).toBe("selection-7.request-3");
    expect(current.relay.stats().telemetry.routes["recording-age"]).toMatchObject({ requests: 1, successes: 1 });
  });

  test("an unrecognized or missing bearer is rejected before the upstream is ever contacted", async () => {
    upstream = await fakeLiveStorageService((record) => { record.response.writeHead(200); record.response.end("{}"); });
    current = await gateway({ internalUrl: upstream.url });
    expect((await post(current.base, "recording-age", validBody(), { token: "wrong-token-wrong-token" })).status).toBe(401);
    expect((await post(current.base, "recording-age", validBody(), { token: null })).status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  test("a malformed request body is rejected before the upstream is contacted", async () => {
    upstream = await fakeLiveStorageService((record) => { record.response.writeHead(200); record.response.end("{}"); });
    current = await gateway({ internalUrl: upstream.url });
    expect((await post(current.base, "recording-age", { symbol: "BTCUSDT" })).status).toBe(400);
    expect((await post(current.base, "recording-age", "not-json")).status).toBe(400);
    expect(upstream.seen).toHaveLength(0);
  });

  test("an unknown route path falls through so the outer server can 404 it", async () => {
    current = await gateway({ internalUrl: "http://127.0.0.1:1" });
    const response = await fetch(`${current.base}/live-storage/not-a-real-route`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET_A}` },
      body: JSON.stringify(validBody()),
    });
    expect(response.status).toBe(404);
  });

  test("an unconfigured upstream refuses with 503 and never attempts a connection", async () => {
    current = await gateway({ internalUrl: null });
    const { status, body } = await post(current.base, "recording-age", validBody());
    expect(status).toBe(503);
    expect(body.error).toBe("READER_UNAVAILABLE");
  });

  test("an unreachable upstream becomes 502", async () => {
    const closedServer = http.createServer();
    await listen(closedServer);
    const url = `http://127.0.0.1:${closedServer.address().port}`;
    await close(closedServer);
    current = await gateway({ internalUrl: url });
    const { status } = await post(current.base, "recording-age", validBody());
    expect(status).toBe(502);
  });

  test("an upstream that never answers within the deadline becomes 504", async () => {
    upstream = await fakeLiveStorageService(() => {});
    current = await gateway({ internalUrl: upstream.url, upstreamTimeoutMs: 50 });
    const { status } = await post(current.base, "recording-age", validBody());
    expect(status).toBe(504);
  });

  test("daily-notional and minute-rollup get their own longer upstream deadline, so a slow calibration read survives a short default elsewhere", async () => {
    upstream = await fakeLiveStorageService((record) => {
      setTimeout(() => {
        record.response.writeHead(200, { "content-type": "application/json" });
        record.response.end(JSON.stringify({ available: true }));
      }, 100);
    });
    current = await gateway({
      internalUrl: upstream.url,
      upstreamTimeoutMs: 50,
      upstreamTimeoutMsByRoute: { "daily-notional": 1_000, "minute-rollup": 1_000 },
    });
    expect((await post(current.base, "daily-notional", validBody({ options: { fromTs: 0, toTs: 3_600_000 } }))).status).toBe(200);
    expect((await post(current.base, "minute-rollup", validBody({ options: { fromTs: 0, toTs: 3_600_000, tickSize: 0.5 } }))).status).toBe(200);
    expect((await post(current.base, "recording-age", validBody())).status).toBe(504);
  });

  test("an upstream body that isn't JSON is reported as READER_UNAVAILABLE, not relayed raw", async () => {
    upstream = await fakeLiveStorageService((record) => { record.response.writeHead(200); record.response.end("not-json"); });
    current = await gateway({ internalUrl: upstream.url });
    const { status, body } = await post(current.base, "recording-age", validBody());
    expect(status).toBe(503);
    expect(body.error).toBe("READER_UNAVAILABLE");
  });

  test("allows the measured seven-day candle payload without widening every route", async () => {
    const largeValue = "x".repeat(2_100_000);
    upstream = await fakeLiveStorageService((record) => {
      record.response.writeHead(200, { "content-type": "application/json" });
      record.response.end(JSON.stringify(record.url.endsWith("recent-candles")
        ? { rows: [largeValue], coversFullWindow: true }
        : { rows: [largeValue], available: true }));
    });
    current = await gateway({ internalUrl: upstream.url });
    expect((await post(current.base, "recent-candles", validBody({ options: { intervalMs: 60_000, windowMs: 604_800_000 } }))).status).toBe(200);
    expect((await post(current.base, "large-trades", validBody())).status).toBe(503);
  });

  test("a rate-limited client is rejected with 429 before the upstream is contacted again", async () => {
    upstream = await fakeLiveStorageService((record) => { record.response.writeHead(200); record.response.end("{}"); });
    current = await gateway({ internalUrl: upstream.url, rateLimit: { max: 1, windowMs: 60_000 } });
    expect((await post(current.base, "recording-age", validBody())).status).toBe(200);
    const second = await post(current.base, "recording-age", validBody());
    expect(second.status).toBe(429);
    expect(upstream.seen).toHaveLength(1);
    expect(Number(second.headers.get("retry-after")) * 1_000).toBeGreaterThanOrEqual(second.body.retryAfterMs);
  });

  test("an upstream 429 reaches the caller with its Retry-After header, so the reader waits the host's time", async () => {
    upstream = await fakeLiveStorageService((record) => {
      const payload = JSON.stringify({ error: "OVERLOADED", detail: "RATE_BUDGET_EXCEEDED", retryAfterMs: 12_400 });
      record.response.writeHead(429, { "content-type": "application/json", [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION });
      record.response.end(payload);
    });
    current = await gateway({ internalUrl: upstream.url });
    const refused = await post(current.base, "recording-age", validBody());
    expect(refused.status).toBe(429);
    expect(refused.body.retryAfterMs).toBe(12_400);
    expect(refused.headers.get("retry-after")).toBe("13");
  });

  test("createLiveStorageRelayOrRefuse degrades to a clean 503 instead of throwing on bad config", () => {
    const messages = [];
    const relay = createLiveStorageRelayOrRefuse({
      auth: createArchiveAuth({ clientTokens: `laptop-1:${SECRET_A}` }),
      internalUrl: "not-a-loopback-url",
    }, (...args) => messages.push(args.join(" ")));
    expect(relay.stats()).toEqual({ disabled: true, disposed: false });
    expect(messages.length).toBeGreaterThan(0);
  });
});
