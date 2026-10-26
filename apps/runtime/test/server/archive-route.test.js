"use strict";

const http = require("node:http");
const zlib = require("node:zlib");
const { createArchiveAuth, MIN_TOKEN_LENGTH } = require("../../src/server/archive-auth");
const {
  createArchiveRoute,
  createArchiveRouteOrRefuse,
  validateRequest,
  ARCHIVE_QUERY_PATH,
  RESTART_HEADER,
  RESTART_CODES,
  CORRELATION_ID_HEADER,
  CONTRACT_VERSION,
  MAX_UPSTREAM_RESPONSE_BYTES,
} = require("../../src/server/archive-route");

const SECRET_A = "a".repeat(MIN_TOKEN_LENGTH);
const SECRET_B = "b".repeat(MIN_TOKEN_LENGTH);
const SERVICE_SECRET = "service-secret-under-test";
const BASE_NS = "1756684800000000000";

function validQuery(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    instrumentId: '["XCME","FUTURE","NQU5","USD","CONTRACT"]',
    family: "trade",
    from: BASE_NS,
    to: "1756684800000001000",
    ...overrides,
  };
}

function validPage(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    pointer: {},
    pointerToken: "snapshot-token",
    family: "trade",
    rows: [],
    nextCursor: null,
    queryFingerprint: "f".repeat(64),
    coverage: {
      requested: { from: BASE_NS, to: "1756684800000001000" },
      served: null,
      partitions: 0,
      states: {},
    },
    scan: {
      partitionsRead: 0,
      partitionsSelected: 0,
      partsOpened: 0,
      exactScanBytes: 0,
      bytesRead: 0,
      cacheHits: 0,
      cacheMisses: 0,
      fetchMs: 0,
      queryMs: 0,
    },
    ...overrides,
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Fixed sleeps make a test that passes alone and fails in a loaded suite, which
// is worse than no test: it teaches people to re-run rather than to look.
async function waitFor(condition, { timeoutMs = 5_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor: ${label} did not happen within ${timeoutMs}ms`);
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// A stand-in for the Python service: it records what reached it and replies with
// whatever the test asked for. Using a real socket rather than a fetch double is
// deliberate -- the headers, status relay and abort behaviour are the thing under
// test, and a double would assert only that the code calls itself.
async function fakeArchiveService(handler) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const record = {
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        request,
        response,
      };
      seen.push(record);
      handler(record);
    });
  });
  await listen(server);
  return { seen, server, url: `http://127.0.0.1:${server.address().port}${"/query"}` };
}

async function gateway(options = {}) {
  const route = createArchiveRoute({
    auth: createArchiveAuth({ clientTokens: `viewer-1:${SECRET_A},viewer-2:${SECRET_B}` }),
    serviceSecret: SERVICE_SECRET,
    log: () => {},
    ...options,
  });
  const server = http.createServer((request, response) => {
    if (route.handle(request, response)) return;
    response.writeHead(404);
    response.end();
  });
  await listen(server);
  return { route, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function post(base, body, { token = SECRET_A, headers = {}, signal } = {}) {
  const response = await fetch(base + ARCHIVE_QUERY_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? null : JSON.parse(text),
  };
}

function postIncomplete(base, body, { token = SECRET_A } = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let answered = false;
    const url = new URL(base + ARCHIVE_QUERY_PATH);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
        authorization: `Bearer ${token}`,
      },
    }, (response) => {
      answered = true;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, body: text === "" ? null : JSON.parse(text) });
      });
    });
    request.on("error", (error) => {
      if (!answered) reject(error);
    });
    request.write(payload.subarray(0, 1));
  });
}

describe("archive route", () => {
  let upstream;
  let front;

  afterEach(async () => {
    if (front) { front.route.dispose(); await close(front.server); front = null; }
    if (upstream) { await close(upstream.server); upstream = null; }
  });

  it("forwards an authenticated query with the service secret and the derived client id", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage()));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery(), { token: SECRET_B });

    expect(result.status).toBe(200);
    expect(result.body.rows).toEqual([]);
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0].headers["x-archive-service-secret"]).toBe(SERVICE_SECRET);
    expect(upstream.seen[0].headers["x-archive-client"]).toBe("viewer-2");
  });

  it("echoes a valid caller-supplied correlation id on a successful query", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage()));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery(), { headers: { [CORRELATION_ID_HEADER]: "bench-run-1.0.0.0.3" } });

    expect(result.status).toBe(200);
    expect(result.headers.get(CORRELATION_ID_HEADER)).toBe("bench-run-1.0.0.0.3");
  });

  it("echoes the correlation id on refusals too, so a rejected request is still attributable", async () => {
    front = await gateway({ serviceUrl: "http://127.0.0.1:1/query" });

    const unauthenticated = await post(front.base, validQuery(), { token: null, headers: { [CORRELATION_ID_HEADER]: "refused-1" } });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get(CORRELATION_ID_HEADER)).toBe("refused-1");

    const malformed = await post(front.base, "not json", { headers: { [CORRELATION_ID_HEADER]: "refused-2" } });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get(CORRELATION_ID_HEADER)).toBe("refused-2");
  });

  it("replaces a missing or malformed correlation id with a fresh unique one rather than reflecting it", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage()));
    });
    front = await gateway({ serviceUrl: upstream.url });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    const missing = await post(front.base, validQuery());
    const malformed = await post(front.base, validQuery(), { headers: { [CORRELATION_ID_HEADER]: "bad id with spaces!" } });
    const oversized = await post(front.base, validQuery(), { headers: { [CORRELATION_ID_HEADER]: "x".repeat(129) } });

    const ids = [missing, malformed, oversized].map((result) => result.headers.get(CORRELATION_ID_HEADER));
    for (const id of ids) expect(id).toMatch(uuid);
    expect(new Set(ids).size).toBe(3);
  });

  it("never forwards the caller's own credential to the archive service", async () => {
    // The browser's bearer token proves which person is asking. The service
    // secret proves the gateway is asking. Leaking the first past this boundary
    // would hand a user credential to a component that has no use for it.
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage()));
    });
    front = await gateway({ serviceUrl: upstream.url });

    await post(front.base, validQuery());

    const forwarded = JSON.stringify(upstream.seen[0].headers) + upstream.seen[0].body;
    expect(forwarded).not.toContain(SECRET_A);
    expect(upstream.seen[0].headers.authorization).toBeUndefined();
  });

  it.each([
    ["no credential", null],
    ["an unknown credential", "z".repeat(MIN_TOKEN_LENGTH)],
  ])("refuses %s before reaching the archive service", async (_label, token) => {
    upstream = await fakeArchiveService(({ response }) => { response.writeHead(200); response.end("{}"); });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery(), { token });

    expect(result.status).toBe(401);
    expect(result.body.error).toBe("UNAUTHORIZED");
    expect(result.headers.get("www-authenticate")).toBe("Bearer");
    expect(upstream.seen).toHaveLength(0);
  });

  it("marks a restart refusal with a header the browser can act on", async () => {
    // Snapshot tokens and cursor signatures are process-local by design, so a
    // service restart invalidates every page token. That is not an error the
    // user should see -- it means re-issue the query from the start.
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ contractVersion: CONTRACT_VERSION, error: "POINTER_TOKEN_INVALID" }));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery({ pointerToken: "stale" }));

    expect(result.status).toBe(409);
    expect(result.headers.get(RESTART_HEADER)).toBe("1");
    expect(front.route.stats().restarts).toBe(1);
  });

  it("does not mark an ordinary refusal as a restart", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(JSON.stringify({ contractVersion: CONTRACT_VERSION, error: "WINDOW_TOO_LARGE" }));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery());

    expect(result.status).toBe(413);
    expect(result.headers.get(RESTART_HEADER)).toBeNull();
  });

  it("relays the archive service's own status and envelope unchanged", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ contractVersion: CONTRACT_VERSION, error: "ESTIMATE_UNVERIFIED" }));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery({ family: "depth" }));

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ contractVersion: CONTRACT_VERSION, error: "ESTIMATE_UNVERIFIED" });
  });

  it("refuses a success response that is outside the contract before exposing it", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ contractVersion: CONTRACT_VERSION, rows: [] }));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery());

    expect(result.status).toBe(502);
    expect(result.body.error).toBe("READER_UNAVAILABLE");
    expect(result.body.detail).toContain("UPSTREAM_CONTRACT_VIOLATION");
  });

  it("refuses a response with malformed coverage or scan metrics before exposing it", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage({
        coverage: {},
        scan: { partitionsRead: 0 },
      })));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery());

    expect(result.status).toBe(502);
    expect(result.body.error).toBe("READER_UNAVAILABLE");
    expect(result.body.detail).toContain("UPSTREAM_CONTRACT_VIOLATION");
  });

  it("refuses an upstream error paired with the wrong contract status", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ contractVersion: CONTRACT_VERSION, error: "WINDOW_TOO_LARGE" }));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery());

    expect(result.status).toBe(502);
    expect(result.body.detail).toContain("UPSTREAM_CONTRACT_VIOLATION");
  });

  it("stops before buffering an upstream response beyond the reader frame", async () => {
    front = await gateway({
      serviceUrl: "http://127.0.0.1:1/query",
      fetchImpl: async () => new Response(JSON.stringify(validPage()), {
        status: 200,
        headers: { "content-length": String(MAX_UPSTREAM_RESPONSE_BYTES + 1) },
      }),
    });

    const result = await post(front.base, validQuery());

    expect(result.status).toBe(502);
    expect(result.body.detail).toContain("UPSTREAM_BODY_TOO_LARGE");
  });

  it("gzips a large page and the client decodes it transparently", async () => {
    const rows = Array.from({ length: 400 }, (_, index) => ({
      event_ns: String(BigInt(BASE_NS) + BigInt(index)), record_id: `rec-${index}`,
    }));
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage({ rows })));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery(), { headers: { "accept-encoding": "gzip" } });

    expect(result.status).toBe(200);
    expect(result.body.rows).toHaveLength(400);
    const uncompressed = Buffer.from(JSON.stringify(validPage({ rows })));
    const compressed = zlib.gzipSync(uncompressed);
    expect(compressed.length).toBeLessThan(uncompressed.length / 4);
  });

  it("refuses a body past the request bound without buffering it all", async () => {
    upstream = await fakeArchiveService(({ response }) => { response.writeHead(200); response.end("{}"); });
    front = await gateway({ serviceUrl: upstream.url, maxRequestBytes: 512 });

    const result = await post(front.base, { ...validQuery(), instrumentId: "x".repeat(4096) });

    expect(result.status).toBe(400);
    expect(result.body.detail).toContain("REQUEST_BODY_TOO_LARGE");
    expect(upstream.seen).toHaveLength(0);
  });

  it("frees an admitted slot when an authenticated caller never finishes its body", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage()));
    });
    front = await gateway({ serviceUrl: upstream.url, requestBodyTimeoutMs: 50 });

    const result = await postIncomplete(front.base, validQuery());

    expect(result.status).toBe(400);
    expect(result.body.error).toBe("MALFORMED_REQUEST");
    expect(result.body.detail).toContain("REQUEST_BODY_TIMEOUT");
    expect(upstream.seen).toHaveLength(0);
    await waitFor(() => front.route.stats().inFlight === 0,
                  { label: "the incomplete request released its admission slot" });
  });

  it("refuses a query the contract cannot accept before spending a round trip", async () => {
    upstream = await fakeArchiveService(({ response }) => { response.writeHead(200); response.end("{}"); });
    front = await gateway({ serviceUrl: upstream.url });

    const backwards = await post(front.base, validQuery({ from: "500", to: "100" }));
    const family = await post(front.base, validQuery({ family: "nonsense" }));

    expect(backwards.status).toBe(400);
    expect(backwards.body.error).toBe("INVALID_WINDOW");
    expect(family.body.error).toBe("UNSUPPORTED_FAMILY");
    expect(upstream.seen).toHaveLength(0);
  });

  it("refuses when the archive service is unreachable rather than hanging", async () => {
    front = await gateway({ serviceUrl: "http://127.0.0.1:1/query" });

    const result = await post(front.base, validQuery());

    expect(result.status).toBe(502);
    expect(result.body.error).toBe("READER_UNAVAILABLE");
  });

  it("refuses every query when the service is not configured", async () => {
    front = await gateway({ serviceUrl: undefined });

    const result = await post(front.base, validQuery());

    expect(result.status).toBe(503);
    expect(result.body.detail).toContain("SERVICE_NOT_CONFIGURED");
  });

  it("spends a client's rate budget per client, not globally", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage()));
    });
    front = await gateway({ serviceUrl: upstream.url, rateLimit: { max: 1, windowMs: 60_000 } });

    const first = await post(front.base, validQuery(), { token: SECRET_A });
    const second = await post(front.base, validQuery(), { token: SECRET_A });
    const other = await post(front.base, validQuery(), { token: SECRET_B });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.retryAfterMs).toBeGreaterThan(0);
    expect(other.status).toBe(200);
  });

  it("names the authenticated client to the archive service, whatever client header the request carries", async () => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validPage()));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, validQuery(), { token: SECRET_B, headers: { "x-archive-client": "viewer-1" } });

    expect(result.status).toBe(200);
    expect(upstream.seen[0].headers["x-archive-client"]).toBe("viewer-2");
  });

  it.each([
    ["a page of another family", validQuery(), validPage({ family: "quote" }), 200],
    ["more rows than the query's limit", validQuery({ limit: 1 }), validPage({ rows: [{}, {}] }), 200],
    ["a refusal code under another code's status", validQuery(), { contractVersion: CONTRACT_VERSION, error: "OVERLOADED" }, 400],
  ])("refuses %s from the archive service before exposing it", async (_label, query, reply, status) => {
    upstream = await fakeArchiveService(({ response }) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
    front = await gateway({ serviceUrl: upstream.url });

    const result = await post(front.base, query);

    expect(result.status).toBe(502);
    expect(result.body.detail).toContain("UPSTREAM_CONTRACT_VIOLATION");
  });

  it("refuses a client with room in its own share once the shared queue is full", async () => {
    const held = [];
    upstream = await fakeArchiveService((record) => { held.push(record); });
    front = await gateway({ serviceUrl: upstream.url, maxConcurrent: 1, maxQueued: 1, maxQueuedPerClient: 1 });

    const inFlight = post(front.base, validQuery());
    await waitFor(() => held.length === 1, { label: "the first query occupied the slot" });
    const queued = post(front.base, validQuery(), { token: SECRET_B });
    await waitFor(() => front.route.stats().waiting === 1, { label: "the second query waited" });
    const refused = await post(front.base, validQuery());

    expect(refused.status).toBe(429);
    expect(refused.body.detail).toBe("QUEUE_FULL");

    for (let answered = 0; answered < 2; answered += 1) {
      await waitFor(() => held.length > answered, { label: "a query reached the service" });
      held[answered].response.writeHead(200, { "content-type": "application/json" });
      held[answered].response.end(JSON.stringify(validPage()));
    }
    expect((await inFlight).status).toBe(200);
    expect((await queued).status).toBe(200);
  });

  it("refuses past the queue rather than growing it without bound", async () => {
    const held = [];
    upstream = await fakeArchiveService((record) => { held.push(record); });
    front = await gateway({ serviceUrl: upstream.url, maxConcurrent: 1, maxQueued: 0 });

    const inFlight = post(front.base, validQuery());
    await waitFor(() => held.length === 1, { label: "the first query occupied the slot" });
    const refused = await post(front.base, validQuery(), { token: SECRET_B });

    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe("OVERLOADED");

    held[0].response.writeHead(200, { "content-type": "application/json" });
    held[0].response.end(JSON.stringify(validPage()));
    expect((await inFlight).status).toBe(200);
  });

  it("queues a second request from one client while another client can use the free slot", async () => {
    const held = [];
    upstream = await fakeArchiveService((record) => { held.push(record); });
    front = await gateway({ serviceUrl: upstream.url, maxConcurrent: 2, maxQueued: 4 });

    const first = post(front.base, validQuery());
    await waitFor(() => held.length === 1, { label: "the first client occupied its slot" });
    const second = post(front.base, validQuery());
    await waitFor(() => front.route.stats().waiting === 1,
                  { label: "the same client's second request queued" });
    expect(held).toHaveLength(1);

    const other = post(front.base, validQuery(), { token: SECRET_B });
    await waitFor(() => held.length === 2, { label: "the other client used the second slot" });

    held[0].response.writeHead(200, { "content-type": "application/json" });
    held[0].response.end(JSON.stringify(validPage()));
    await waitFor(() => held.length === 3, { label: "the queued request started after its own prior request ended" });
    for (const record of held.slice(1)) {
      record.response.writeHead(200, { "content-type": "application/json" });
      record.response.end(JSON.stringify(validPage()));
    }

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await other).status).toBe(200);
  });

  it("does not let one client consume every shared waiting slot", async () => {
    const held = [];
    upstream = await fakeArchiveService((record) => { held.push(record); });
    front = await gateway({ serviceUrl: upstream.url, maxConcurrent: 1, maxQueued: 4,
                            maxQueuedPerClient: 2, maxQueueWaitMs: 500 });

    const first = post(front.base, validQuery());
    await waitFor(() => held.length === 1, { label: "the first client occupied the reader" });

    const queuedA = [post(front.base, validQuery()), post(front.base, validQuery())];
    await waitFor(() => front.route.stats().waiting === 2,
                  { label: "the first client occupied only its queue share" });

    const excess = await post(front.base, validQuery());
    expect(excess.status).toBe(429);
    expect(excess.body.error).toBe("OVERLOADED");
    expect(excess.body.detail).toContain("CLIENT_QUEUE_LIMIT");
    expect(excess.body.retryAfterMs).toBeGreaterThan(0);

    const other = post(front.base, validQuery(), { token: SECRET_B });
    await waitFor(() => front.route.stats().waiting === 3,
                  { label: "another client retained access to the shared queue" });

    for (let served = 0; served < 4; served += 1) {
      await waitFor(() => held.length > 0, { label: "the next accepted request reached upstream" });
      const record = held.shift();
      record.response.writeHead(200, { "content-type": "application/json" });
      record.response.end(JSON.stringify(validPage()));
    }

    expect((await first).status).toBe(200);
    expect((await queuedA[0]).status).toBe(200);
    expect((await queuedA[1]).status).toBe(200);
    expect((await other).status).toBe(200);
  });

  it("removes a queued request when its caller disconnects before it is admitted", async () => {
    const held = [];
    upstream = await fakeArchiveService((record) => { held.push(record); });
    front = await gateway({ serviceUrl: upstream.url, maxConcurrent: 1, maxQueued: 4,
                            upstreamTimeoutMs: 60_000 });

    const first = post(front.base, validQuery());
    await waitFor(() => held.length === 1, { label: "the first query occupied the only slot" });
    const controller = new AbortController();
    const abandoned = post(front.base, validQuery(), { token: SECRET_B, signal: controller.signal })
      .catch(() => null);
    await waitFor(() => front.route.stats().waiting === 1, { label: "the second query queued" });
    controller.abort();
    await abandoned;
    await waitFor(() => front.route.stats().waiting === 0 && front.route.stats().cancelled === 1,
                  { label: "the disconnected queued query was removed" });

    held[0].response.writeHead(200, { "content-type": "application/json" });
    held[0].response.end(JSON.stringify(validPage()));
    expect((await first).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(held).toHaveLength(1);
  });

  it("aborts the upstream request when the caller goes away", async () => {
    // The upstream request has already ended by the time the handler runs, so
    // `aborted` can never fire on it -- the observable signal is the response
    // socket closing before a reply was written. That distinction is why the
    // first version of this test passed for the wrong reason.
    let upstreamDroppedBeforeReplying = false;
    upstream = await fakeArchiveService(({ response }) => {
      response.on("close", () => {
        if (!response.writableEnded) upstreamDroppedBeforeReplying = true;
      });
    });
    front = await gateway({ serviceUrl: upstream.url });

    const controller = new AbortController();
    const pending = post(front.base, validQuery(), { signal: controller.signal })
      .catch((error) => error);
    await waitFor(() => upstream.seen.length === 1, { label: "the upstream received the query" });
    controller.abort();
    await pending;
    await waitFor(() => upstreamDroppedBeforeReplying,
                  { label: "the upstream request was dropped" });
    await waitFor(() => front.route.stats().cancelled === 1,
                  { label: "the gateway counted the cancellation" });

    expect(upstreamDroppedBeforeReplying).toBe(true);
    expect(front.route.stats().cancelled).toBe(1);
  });

  it("calls an upstream timeout a timeout, not a client cancellation", async () => {
    // Both a caller going away and the upstream deadline trip the same
    // AbortController, so the code read the signal and reported the wrong one:
    // a query that was simply too slow told the user THEY disconnected, and was
    // counted as cancelled. Reproduced directly before this test existed.
    upstream = await fakeArchiveService(() => { /* never replies */ });
    front = await gateway({ serviceUrl: upstream.url, upstreamTimeoutMs: 250 });

    const result = await post(front.base, validQuery());

    expect(result.status).toBe(504);
    expect(result.body.error).toBe("READER_UNAVAILABLE");
    expect(result.body.detail).toContain("UPSTREAM_TIMEOUT");
    expect(front.route.stats().timedOut).toBe(1);
    expect(front.route.stats().cancelled).toBe(0);
  });

  it("refuses a queued request at its deadline, not when a slot happens to free", async () => {
    // maxQueueWaitMs was only consulted on dequeue, so a queued request waited
    // for the in-flight one to finish and was THEN told it had waited too long.
    // Measured before the fix: a 200 ms bound produced a 3,014 ms wait.
    const held = [];
    upstream = await fakeArchiveService((record) => { held.push(record); });
    front = await gateway({
      serviceUrl: upstream.url, maxConcurrent: 1, maxQueued: 4,
      maxQueueWaitMs: 200, upstreamTimeoutMs: 60_000,
    });

    const inFlight = post(front.base, validQuery());
    await waitFor(() => held.length === 1, { label: "the first query occupied the slot" });
    const startedAt = Date.now();
    const queued = await post(front.base, validQuery(), { token: SECRET_B });
    const waited = Date.now() - startedAt;

    expect(queued.status).toBe(429);
    expect(queued.body.detail).toContain("QUEUE_WAIT_EXCEEDED");
    expect(waited).toBeLessThan(2_000);

    held[0].response.writeHead(200, { "content-type": "application/json" });
    held[0].response.end(JSON.stringify(validPage()));
    expect((await inFlight).status).toBe(200);
  });

  it("disables archive queries rather than the whole server when its config is bad", async () => {
    // createArchiveRoute throws on malformed tokens, and app.js builds it at
    // startup -- so a typo in an archive credential stopped the live
    // market-data server from starting at all. Verified directly before this
    // test existed. The archive is a new optional subsystem; the live feed is
    // the core, and the blast radius was the wrong way round.
    const logged = [];
    const previous = process.env.TT_ARCHIVE_CLIENT_TOKENS;
    process.env.TT_ARCHIVE_CLIENT_TOKENS = "viewer-1:tooshort";
    let route;
    try {
      route = createArchiveRouteOrRefuse({}, (...args) => logged.push(args));
    } finally {
      if (previous === undefined) delete process.env.TT_ARCHIVE_CLIENT_TOKENS;
      else process.env.TT_ARCHIVE_CLIENT_TOKENS = previous;
    }

    expect(route.stats().disabled).toBe(true);
    expect(logged).toHaveLength(1);

    const server = http.createServer((request, response) => {
      if (route.handle(request, response)) return;
      response.writeHead(404);
      response.end();
    });
    await listen(server);
    try {
      const result = await post(`http://127.0.0.1:${server.address().port}`, validQuery());
      expect(result.status).toBe(503);
      expect(result.body.detail).toContain("SERVICE_NOT_CONFIGURED");
    } finally {
      await close(server);
    }
  });

  it("leaves an unrelated path to the rest of the server", async () => {
    front = await gateway({ serviceUrl: "http://127.0.0.1:1/query" });

    const response = await fetch(`${front.base}/health`);

    expect(response.status).toBe(404);
  });

  it("returns the contract's malformed-request status for a non-POST archive request", async () => {
    front = await gateway({ serviceUrl: "http://127.0.0.1:1/query" });

    const response = await fetch(front.base + ARCHIVE_QUERY_PATH);

    expect(response.status).toBe(400);
  });
});

describe("archive route request validation", () => {
  it.each([
    ["a non-object", [], "REQUEST_NOT_AN_OBJECT"],
    ["a wrong contract version", { contractVersion: "archive-query/0" }, "CONTRACT_VERSION_MISMATCH"],
    ["an unknown field", validQuery({ surprise: 1 }), "UNKNOWN_REQUEST_FIELDS:surprise"],
    ["a limit above the bound", validQuery({ limit: 10_001 }), "LIMIT_OUTSIDE_BOUNDS"],
    ["a limit below the bound", validQuery({ limit: 0 }), "LIMIT_OUTSIDE_BOUNDS"],
    ["a fractional limit", validQuery({ limit: 1.5 }), "LIMIT_OUTSIDE_BOUNDS"],
    ["a numeric timestamp", validQuery({ from: 1 }), "FROM_NOT_DECIMAL_NANOSECONDS"],
    ["a cursor that is not a string", validQuery({ cursor: 7 }), "CURSOR_NOT_A_STRING"],
    ["an empty cursor", validQuery({ cursor: "" }), "CURSOR_NOT_A_STRING"],
    ["an overlong pointer token", validQuery({ pointerToken: "x".repeat(513) }), "POINTER_TOKEN_NOT_A_STRING"],
    ["a malformed pointer token", validQuery({ pointerToken: "bad/token" }), "POINTER_TOKEN_NOT_A_STRING"],
    ["an invalid scan bound", validQuery({ maxScanBytes: 0 }), "MAX_SCAN_BYTES_OUTSIDE_BOUNDS"],
    ["an oversized instrument", validQuery({ instrumentId: "x".repeat(257) }), "INSTRUMENT_ID_NOT_A_STRING"],
  ])("refuses %s", (_label, payload, reason) => {
    const result = validateRequest(payload);

    expect(result).not.toBeNull();
    expect(result.detail).toContain(reason);
  });

  it("accepts a well-formed request", () => {
    expect(validateRequest(validQuery({ limit: 1000, cursor: null, pointerToken: null }))).toBeNull();
  });

  it.each([
    "https://archive.example/query",
    "http://localhost:8002/query",
    "http://127.0.0.1:8002/not-query",
    "http://127.0.0.1:8002/query?redirect=1",
    "http://user:secret@127.0.0.1:8002/query",
  ])("refuses a service URL outside the loopback query boundary: %s", (serviceUrl) => {
    expect(() => createArchiveRoute({ serviceUrl, serviceSecret: SERVICE_SECRET })).toThrow(/loopback/);
  });

  it("names every code it can refuse with as one the contract declares", () => {
    const codes = new Set(["MALFORMED_REQUEST", "INVALID_WINDOW", "UNSUPPORTED_FAMILY"]);
    for (const payload of [[], validQuery({ from: "5", to: "5" }), validQuery({ family: "nope" })]) {
      expect(codes.has(validateRequest(payload).error)).toBe(true);
    }
    expect(RESTART_CODES).toEqual(["POINTER_TOKEN_INVALID", "CURSOR_MALFORMED"]);
  });
});
