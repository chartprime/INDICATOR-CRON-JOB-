"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  createArchiveAuth,
  MIN_TOKEN_LENGTH,
} = require("../../src/server/archive-auth");
const {
  createArchiveStudyRoute,
  createArchiveStudyRouteOrRefuse,
  ARCHIVE_STUDY_PATH,
  CONTRACT_VERSION,
  validateRequest,
} = require("../../src/server/archive-study-route");
const { FIRST_MONDAY_MS, WEEK_MS } = require("../../src/server/archive-study");

// Report 54 phase 3. The study route runs on the host gateway, beside the data:
// it pages the archive service over loopback, runs the live engines, and sends
// back only the result. The archive service here is a real socket, because the
// headers, the paging and the failure mapping are what is under test.
const SECRET_A = "a".repeat(MIN_TOKEN_LENGTH);
const SECRET_B = "b".repeat(MIN_TOKEN_LENGTH);
const SERVICE_SECRET = "service-secret-under-test";
const GOLDEN = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../../benchmarks/fixtures/golden/trade-families.json",
    ),
    "utf8",
  ),
);
const MS_NS = 1_000_000n;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const decimal = (value) => Number(value).toFixed(12);
const nsOf = (ms) => String(BigInt(GOLDEN.baseMs + ms) * MS_NS);
const LEVEL_ROWS = GOLDEN.cases.futures.expected.trade_level.map((row) => ({
  event_ns: nsOf(row.minuteMs),
  open_ns: nsOf(row.minuteMs),
  close_ns: nsOf(row.minuteMs + MINUTE_MS),
  tick_size: decimal(GOLDEN.cases.futures.tickSize),
  price_bucket: String(row.priceBucket),
  volume: decimal(row.volume),
  buy_volume: decimal(row.buyVolume),
  sell_volume: decimal(row.sellVolume),
  trade_count: String(row.tradeCount),
  method: "trade_level/1",
}));

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(
  condition,
  { timeoutMs = 5_000, label = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor: ${label} did not happen within ${timeoutMs}ms`);
}

function servePage(record, levelRows = LEVEL_ROWS, pointerToken = "tok") {
  const query = JSON.parse(record.body);
  const from = BigInt(query.from);
  const to = BigInt(query.to);
  const rows =
    query.family === "trade_level_1m"
      ? levelRows.filter(
          (row) => BigInt(row.event_ns) >= from && BigInt(row.event_ns) < to,
        )
      : [];
  const body = JSON.stringify({
    contractVersion: "archive-query/1",
    family: query.family,
    rows,
    nextCursor: null,
    pointerToken,
    coverage: {
      requested: { from: query.from, to: query.to },
      served: rows.length === 0 ? null : { from: query.from, to: query.to },
      partitions: rows.length === 0 ? 0 : 1,
      states: rows.length === 0 ? { QUIET: 1 } : { PUBLISHED: 1 },
      gaps: [],
      corrupt: [],
    },
  });
  record.response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  record.response.end(body);
}

async function fakeArchiveService(handler = servePage) {
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
  return {
    seen,
    server,
    url: `http://127.0.0.1:${server.address().port}/query`,
  };
}

async function gateway(options = {}) {
  const route = createArchiveStudyRoute({
    auth: createArchiveAuth({
      clientTokens: `viewer-1:${SECRET_A},viewer-2:${SECRET_B}`,
    }),
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

async function post(base, body, { token = SECRET_A } = {}) {
  const response = await fetch(base + ARCHIVE_STUDY_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : JSON.parse(text),
  };
}

function profileRequest(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: 7,
    study: "volume_profile",
    symbol: "ES",
    assetClass: "FUTURE",
    tickSize: 0.25,
    segments: [
      {
        instrumentId: '["XCME","FUTURE","ESU6","USD","CONTRACT"]',
        fromTs: GOLDEN.baseMs,
        toTs: GOLDEN.baseMs + 30 * DAY_MS,
      },
    ],
    ranges: [{ fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 30 * DAY_MS }],
    options: { mode: "fixed_range", binSizeMultiplier: 1 },
    ...overrides,
  };
}

describe("archive study route", () => {
  test("study pointer tokens use the archive query contract", () => {
    expect(validateRequest(profileRequest({ pointerToken: "snapshot_1" }))).toBeNull();
    for (const pointerToken of ["", "bad/token", "a".repeat(513), 42]) {
      expect(validateRequest(profileRequest({ pointerToken }))).toMatchObject({
        reason: "POINTER_TOKEN_NOT_A_STRING",
      });
    }
  });
  test("crypto study requests bind market, instrument and conversion tick geometry", () => {
    const request = profileRequest({
      symbol: "BTCUSDT", assetClass: "PERPETUAL", tickSize: 0.1,
      segments: [{ instrumentId: '["BINANCE","PERPETUAL","BTCUSDT","USDT","COIN"]',
        fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 30 * DAY_MS }],
    });
    expect(validateRequest(request)).toBeNull();
    expect(validateRequest({ ...request, tickSize: 0.01 })).toMatchObject({ reason: "CRYPTO_GEOMETRY_MISMATCH" });
    expect(validateRequest({ ...request, segments: [{ ...request.segments[0], instrumentId: '["BINANCE","SPOT","BTCUSDT","USDT","COIN"]' }] }))
      .toMatchObject({ reason: "CRYPTO_IDENTITY_MISMATCH" });
    expect(validateRequest({ ...request, symbol: "SOLUSDT" })).toMatchObject({ reason: "CRYPTO_GEOMETRY_MISMATCH" });
  });
  let service;
  let gw;

  afterEach(async () => {
    if (gw) {
      gw.route.dispose();
      await close(gw.server);
      gw = null;
    }
    if (service) {
      await close(service.server);
      service = null;
    }
  });

  test("a study runs beside the data and returns only its result, paging the archive in accepted windows", async () => {
    service = await fakeArchiveService();
    gw = await gateway({ serviceUrl: service.url });

    const { status, body } = await post(gw.base, profileRequest());

    expect(body).toMatchObject({ complete: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      contractVersion: CONTRACT_VERSION,
      study: "volume_profile",
      requestId: 7,
      complete: true,
    });
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].delivery_scope).toBe("HISTORICAL");
    expect(
      body.profiles[0].buckets.reduce((sum, bucket) => sum + bucket.volume, 0),
    ).toBe(32);
    const queries = service.seen.map((record) => JSON.parse(record.body));
    expect(
      service.seen.every(
        (record) =>
          record.headers["x-archive-service-secret"] === SERVICE_SECRET,
      ),
    ).toBe(true);
    expect(
      service.seen.every(
        (record) => record.headers["x-archive-client"] === "viewer-1.study",
      ),
    ).toBe(true);
    expect(
      queries.every(
        (query) =>
          query.contractVersion === "archive-query/1" &&
          query.family === "trade_level_1m",
      ),
    ).toBe(true);
    expect(
      Math.max(
        ...queries.map((query) =>
          Number((BigInt(query.to) - BigInt(query.from)) / MS_NS),
        ),
      ),
    ).toBeLessThanOrEqual(7 * DAY_MS);
    expect(queries.length).toBe(Math.ceil(30 / 7));
    expect(queries[0].pointerToken).toBeUndefined();
    expect(queries.slice(1).every((query) => query.pointerToken === "tok")).toBe(true);
  });

  test("a study pins every archive chunk to the chart snapshot", async () => {
    service = await fakeArchiveService();
    gw = await gateway({ serviceUrl: service.url });
    const result = await post(gw.base, profileRequest({ pointerToken: "tok" }));
    expect(result.status).toBe(200);
    expect(service.seen.length).toBeGreaterThan(1);
    expect(service.seen.every((record) => JSON.parse(record.body).pointerToken === "tok")).toBe(true);
    // Pinned or not, a study spends the study budget, never the chart's.
    expect(service.seen.every((record) => record.headers["x-archive-client"] === "viewer-1.study")).toBe(true);
  });

  const clientMismatch = (record) => {
    record.response.writeHead(409, { "content-type": "application/json" });
    record.response.end(JSON.stringify({
      contractVersion: "archive-query/1", error: "POINTER_TOKEN_INVALID",
      detail: JSON.stringify({ reason: "CLIENT_MISMATCH" }),
    }));
  };

  test("a chart-issued pin is read under the study budget by an archive that reads `.study` as a budget class", async () => {
    service = await fakeArchiveService((record) => {
      if (record.headers["x-archive-client"].replace(/\.study$/, "") !== "viewer-1") return clientMismatch(record);
      servePage(record);
    });
    gw = await gateway({ serviceUrl: service.url });

    const result = await post(gw.base, profileRequest({ pointerToken: "tok" }));

    expect(result.status).toBe(200);
    expect(result.body.complete).toBe(true);
    expect(service.seen.every((record) => record.headers["x-archive-client"] === "viewer-1.study")).toBe(true);
    expect(gw.route.stats().viewerFallbacks).toBe(0);
  });

  test("an archive that still ties a pin to the exact client is read under the viewer once, then for the rest of the study", async () => {
    service = await fakeArchiveService((record) => {
      if (record.headers["x-archive-client"] !== "viewer-1") return clientMismatch(record);
      servePage(record);
    });
    gw = await gateway({ serviceUrl: service.url });

    const result = await post(gw.base, profileRequest({ pointerToken: "tok" }));

    expect(result.status).toBe(200);
    expect(result.body.complete).toBe(true);
    const clients = service.seen.map((record) => record.headers["x-archive-client"]);
    expect(clients[0]).toBe("viewer-1.study");
    expect(clients.slice(1).length).toBeGreaterThan(1);
    expect(clients.slice(1).every((client) => client === "viewer-1")).toBe(true);
    expect(gw.route.stats().viewerFallbacks).toBe(1);
  });

  test("any other pointer refusal is not retried under the viewer", async () => {
    service = await fakeArchiveService((record) => {
      record.response.writeHead(409, { "content-type": "application/json" });
      record.response.end(JSON.stringify({
        contractVersion: "archive-query/1", error: "POINTER_TOKEN_INVALID",
        detail: JSON.stringify({ reason: "EXPIRED" }),
      }));
    });
    gw = await gateway({ serviceUrl: service.url });

    const result = await post(gw.base, profileRequest({ pointerToken: "tok" }));

    expect(result.status).not.toBe(200);
    expect(service.seen.map((record) => record.headers["x-archive-client"])).toEqual(["viewer-1.study"]);
    expect(gw.route.stats().viewerFallbacks).toBe(0);
  });

  test("a changed archive snapshot refuses the study rather than mixing chunks", async () => {
    service = await fakeArchiveService((record) => servePage(record, LEVEL_ROWS, "new_snapshot"));
    gw = await gateway({ serviceUrl: service.url });
    const result = await post(gw.base, profileRequest({ pointerToken: "tok" }));
    expect(result).toMatchObject({ status: 502, body: {
      error: "UPSTREAM_REFUSED", reason: "POINTER_TOKEN_MISMATCH",
    } });
    expect(service.seen).toHaveLength(1);
  });

  test("an older browser can request automatic or exact tick-width profile rows", async () => {
    service = await fakeArchiveService();
    gw = await gateway({ serviceUrl: service.url });
    const automatic = await post(gw.base, profileRequest({ options: { mode: "fixed_range", ticksPerRow: null } }));
    expect(automatic.status).toBe(200);
    expect(automatic.body.complete).toBe(true);
    const exact = await post(gw.base, profileRequest({ options: { mode: "fixed_range", ticksPerRow: 4 } }));
    expect(exact.status).toBe(200);
    expect(exact.body.complete).toBe(true);
    expect(exact.body.profiles[0].row_width).toBe(1);
    const ambiguous = await post(gw.base, profileRequest({ options: { mode: "fixed_range", ticksPerRow: 4, binSizeMultiplier: 1 } }));
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.reason).toBe("AMBIGUOUS_PROFILE_BIN_SIZE");
  });

  test("legacy requests stay under the older browser's 300-bucket wire limit", async () => {
    const rows = Array.from({ length: 400 }, (_, bucket) => ({
      event_ns: nsOf(0),
      open_ns: nsOf(0),
      close_ns: nsOf(MINUTE_MS),
      tick_size: decimal(0.25),
      price_bucket: String(bucket + 1_000),
      volume: decimal(1),
      buy_volume: decimal(1),
      sell_volume: decimal(0),
      trade_count: "1",
      method: "trade_level/1",
    }));
    service = await fakeArchiveService((record) => servePage(record, rows));
    gw = await gateway({ serviceUrl: service.url });
    const legacy = await post(gw.base, profileRequest({ options: { mode: "fixed_range", ticksPerRow: 1 } }));
    expect(legacy.status).toBe(200);
    expect(legacy.body.profiles[0].buckets.length).toBeLessThanOrEqual(300);
    const current = await post(gw.base, profileRequest({ options: { mode: "fixed_range", binSizeMultiplier: 0.1 } }));
    expect(current.status).toBe(200);
    expect(current.body.profiles[0].buckets.length).toBeGreaterThan(300);
  });

  test("an unauthenticated caller is refused before anything is read", async () => {
    service = await fakeArchiveService();
    gw = await gateway({ serviceUrl: service.url });

    const { status, body } = await post(gw.base, profileRequest(), {
      token: null,
    });

    expect(status).toBe(401);
    expect(body.error).toBe("UNAUTHORIZED");
    expect(service.seen).toEqual([]);
  });

  test.each([
    [
      "an unknown field",
      { rogue: 1 },
      400,
      "MALFORMED_REQUEST",
      "UNKNOWN_REQUEST_FIELDS:rogue",
    ],
    [
      "contract stretches with a gap between them",
      {
        segments: [
          {
            instrumentId: "A",
            fromTs: GOLDEN.baseMs,
            toTs: GOLDEN.baseMs + DAY_MS,
          },
          {
            instrumentId: "B",
            fromTs: GOLDEN.baseMs + 2 * DAY_MS,
            toTs: GOLDEN.baseMs + 3 * DAY_MS,
          },
        ],
      },
      400,
      "INVALID_STUDY",
      "SEGMENTS_NOT_CONTIGUOUS",
    ],
    [
      "a range the contracts do not cover",
      {
        ranges: [{ fromTs: GOLDEN.baseMs, toTs: GOLDEN.baseMs + 40 * DAY_MS }],
      },
      400,
      "INVALID_STUDY",
      "RANGE_OUTSIDE_SEGMENTS",
    ],
    [
      "VPIN over a range that is not whole weeks",
      {
        study: "vpin",
        segments: [
          {
            instrumentId: "A",
            fromTs: FIRST_MONDAY_MS + 2_900 * WEEK_MS,
            toTs: FIRST_MONDAY_MS + 2_902 * WEEK_MS,
          },
        ],
        ranges: [
          {
            fromTs: FIRST_MONDAY_MS + 2_900 * WEEK_MS + DAY_MS,
            toTs: FIRST_MONDAY_MS + 2_901 * WEEK_MS,
          },
        ],
        options: {},
      },
      400,
      "INVALID_STUDY",
      "VPIN_RANGE_NOT_WHOLE_WEEKS",
    ],
  ])(
    "%s is refused by name",
    async (_label, overrides, status, error, reason) => {
      service = await fakeArchiveService();
      gw = await gateway({ serviceUrl: service.url });

      const answer = await post(gw.base, profileRequest(overrides));

      expect(answer.status).toBe(status);
      expect(answer.body).toMatchObject({
        contractVersion: CONTRACT_VERSION,
        error,
        reason,
      });
      expect(service.seen).toEqual([]);
    },
  );

  test("a refusal from the archive service is reported with its own code, not as an empty study", async () => {
    service = await fakeArchiveService((record) => {
      const body = JSON.stringify({
        contractVersion: "archive-query/1",
        error: "UNSUPPORTED_FAMILY",
      });
      record.response.writeHead(400, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      record.response.end(body);
    });
    gw = await gateway({ serviceUrl: service.url });

    const { status, body } = await post(gw.base, profileRequest());

    expect(status).toBe(502);
    expect(body).toMatchObject({
      error: "UPSTREAM_REFUSED",
      reason: "UNSUPPORTED_FAMILY",
    });
  });

  test("a partial archive success is missing, never cached as an empty market period", async () => {
    service = await fakeArchiveService((record) => {
      const query = JSON.parse(record.body);
      const body = JSON.stringify({
        contractVersion: "archive-query/1",
        family: query.family,
        rows: [],
        nextCursor: null,
        pointerToken: "tok",
        coverage: {
          requested: { from: query.from, to: query.to },
          served: null,
          partitions: 0,
          states: { CORRUPT: 1 },
          gaps: [{ date: "2026-08-03", state: "CORRUPT" }],
          corrupt: [{ date: "2026-08-03", reason: "PART_HASH_MISMATCH" }],
        },
      });
      record.response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      record.response.end(body);
    });
    gw = await gateway({ serviceUrl: service.url });

    const { status, body } = await post(gw.base, profileRequest());

    expect(status).toBe(200);
    expect(body).toMatchObject({
      complete: false,
      profiles: [],
      empty: [],
      missing: profileRequest().ranges,
    });
  });

  test("time no partition covers is time nothing traded, so a range spanning a weekend still completes", async () => {
    // The host reports a weekday window as {PUBLISHED: 1}, a Saturday as
    // {UNKNOWN: 1}, and three weeks as {PUBLISHED: 18, UNKNOWN: 3}: the query
    // engine will not guess whether uncovered time is a closed market or an
    // unconverted day. The study can, because the pointer publication proves
    // the derived families exist on exactly the trade family's days. Treating
    // UNKNOWN as a gap made every multi-day study on the real host return
    // nothing.
    service = await fakeArchiveService((record) => {
      const query = JSON.parse(record.body);
      const rows = query.family === "trade_level_1m" ? LEVEL_ROWS : [];
      const body = JSON.stringify({
        contractVersion: "archive-query/1",
        family: query.family,
        rows,
        nextCursor: null,
        pointerToken: "tok",
        coverage: {
          requested: { from: query.from, to: query.to },
          served: rows.length === 0 ? null : { from: query.from, to: query.to },
          partitions: 18,
          states: { PUBLISHED: 18, UNKNOWN: 3 },
          gaps: [],
          corrupt: [],
        },
      });
      record.response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      record.response.end(body);
    });
    gw = await gateway({ serviceUrl: service.url });

    const { status, body } = await post(gw.base, profileRequest());

    expect(status).toBe(200);
    expect(body).toMatchObject({ complete: true, missing: [] });
    expect(body.profiles).toHaveLength(1);
  });

  test("an archive service that is down makes the study unavailable, not empty", async () => {
    service = await fakeArchiveService();
    const url = service.url;
    await close(service.server);
    service = null;
    gw = await gateway({ serviceUrl: url });

    const { status, body } = await post(gw.base, profileRequest());

    expect(status).toBe(503);
    expect(body).toMatchObject({
      error: "READER_UNAVAILABLE",
      reason: "UPSTREAM_UNREACHABLE",
    });
  });

  test("one client runs one study at a time; another client is not held behind it", async () => {
    const held = [];
    service = await fakeArchiveService((record) => held.push(record));
    gw = await gateway({ serviceUrl: service.url });

    const first = post(gw.base, profileRequest());
    await waitFor(() => held.length === 1, {
      label: "first study reached the archive",
    });
    const second = await post(gw.base, profileRequest());
    const other = post(gw.base, profileRequest(), { token: SECRET_B });
    await waitFor(() => held.length === 2, {
      label: "the other client's study reached the archive",
    });

    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({
      error: "OVERLOADED",
      reason: "ONE_STUDY_PER_CLIENT",
    });
    for (const record of held) servePage(record);
    await waitFor(() => held.length >= 2, { label: "held pages served" });
    const release = setInterval(() => {
      while (held.length > 2) servePage(held.splice(2, 1)[0]);
    }, 5);
    try {
      expect((await first).status).toBe(200);
      expect((await other).status).toBe(200);
    } finally {
      clearInterval(release);
    }
  });

  test("an archive that asks the study to slow down is waited for, not failed", async () => {
    let refusals = 0;
    service = await fakeArchiveService((record) => {
      if (refusals < 2) {
        refusals += 1;
        const body = JSON.stringify({
          contractVersion: "archive-query/1",
          error: "OVERLOADED",
          detail: '{"reason":"RATE_BUDGET"}',
          retryAfterMs: 20,
        });
        record.response.writeHead(429, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        });
        record.response.end(body);
        return;
      }
      servePage(record);
    });
    gw = await gateway({ serviceUrl: service.url });

    const { status, body } = await post(gw.base, profileRequest());

    expect(status).toBe(200);
    expect(body).toMatchObject({ complete: true });
    expect(
      body.profiles[0].buckets.reduce((sum, bucket) => sum + bucket.volume, 0),
    ).toBe(32);
    expect(service.seen[1].body).toBe(service.seen[0].body);
    expect(service.seen[2].body).toBe(service.seen[0].body);
    expect(gw.route.stats()).toMatchObject({
      pacedWaits: 2,
      completed: 1,
      failed: 0,
    });
  });

  test("a pace the deadline cannot absorb ends the study as timed out, before waiting it out", async () => {
    service = await fakeArchiveService((record) => {
      const body = JSON.stringify({
        contractVersion: "archive-query/1",
        error: "OVERLOADED",
        retryAfterMs: 60_000,
      });
      record.response.writeHead(429, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      record.response.end(body);
    });
    gw = await gateway({ serviceUrl: service.url, studyDeadlineMs: 5_000 });

    const started = Date.now();
    const { status, body } = await post(gw.base, profileRequest());

    expect(status).toBe(504);
    expect(body).toMatchObject({
      error: "STUDY_TIMEOUT",
      reason: "ARCHIVE_PACE_EXCEEDS_DEADLINE",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(gw.route.stats()).toMatchObject({ timedOut: 1, pacedWaits: 0 });
  });

  test("any other archive refusal is not retried", async () => {
    service = await fakeArchiveService((record) => {
      const body = JSON.stringify({
        contractVersion: "archive-query/1",
        error: "RANGE_TOO_LARGE",
        retryAfterMs: 20,
      });
      record.response.writeHead(400, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      record.response.end(body);
    });
    gw = await gateway({ serviceUrl: service.url });

    const { status, body } = await post(gw.base, profileRequest());

    expect(status).toBe(502);
    expect(body).toMatchObject({
      error: "UPSTREAM_REFUSED",
      reason: "RANGE_TOO_LARGE",
    });
    expect(service.seen).toHaveLength(1);
  });

  test("a long client name keeps its study budget inside the archive's client-name limit", async () => {
    const longName = `v${"x".repeat(127)}`;
    service = await fakeArchiveService();
    gw = await gateway({
      serviceUrl: service.url,
      auth: createArchiveAuth({ clientTokens: `${longName}:${SECRET_A}` }),
    });

    const { status } = await post(gw.base, profileRequest());

    expect(status).toBe(200);
    const presented = service.seen[0].headers["x-archive-client"];
    expect(presented).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    expect(presented.endsWith(".study")).toBe(true);
  });

  test("a client name too long to keep whole with the suffix reads a pin under its own name", async () => {
    const longName = `v${"x".repeat(127)}`;
    service = await fakeArchiveService();
    gw = await gateway({
      serviceUrl: service.url,
      auth: createArchiveAuth({ clientTokens: `${longName}:${SECRET_A}` }),
    });

    const { status } = await post(gw.base, profileRequest({ pointerToken: "tok" }));

    expect(status).toBe(200);
    expect(service.seen.every((record) => record.headers["x-archive-client"] === longName)).toBe(true);
  });

  test("a study that outlives its deadline is ended and says so", async () => {
    service = await fakeArchiveService(() => {});
    gw = await gateway({ serviceUrl: service.url, studyDeadlineMs: 200 });

    const { status, body } = await post(gw.base, profileRequest());

    expect(status).toBe(504);
    expect(body).toMatchObject({
      error: "STUDY_TIMEOUT",
      reason: "DEADLINE_EXCEEDED",
    });
  });

  test("without the service secret every study is refused as not configured", async () => {
    const route = createArchiveStudyRouteOrRefuse({
      auth: createArchiveAuth({ clientTokens: `viewer-1:${SECRET_A}` }),
      serviceUrl: "http://127.0.0.1:9/query",
      serviceSecret: "",
      log: () => {},
    });
    const server = http.createServer((request, response) => {
      if (route.handle(request, response)) return;
      response.writeHead(404);
      response.end();
    });
    await listen(server);
    try {
      const { status, body } = await post(
        `http://127.0.0.1:${server.address().port}`,
        profileRequest(),
      );
      expect(status).toBe(503);
      expect(body).toMatchObject({
        error: "READER_UNAVAILABLE",
        reason: "SERVICE_NOT_CONFIGURED",
      });
    } finally {
      route.dispose();
      await close(server);
    }
  });
});
