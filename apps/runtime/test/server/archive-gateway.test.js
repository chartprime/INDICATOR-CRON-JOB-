"use strict";

const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { MIN_TOKEN_LENGTH } = require("../../src/server/archive-auth");
const {
  CONTRACT_VERSION,
  ARCHIVE_QUERY_PATH,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  REFUSAL_STATUS,
} = require("../../src/server/archive-route");
const {
  main,
  createGateway,
  parseGatewayArgs,
  configurationProblems,
  DEFAULT_PORT,
  REQUEST_TIMEOUT_MS,
} = require("../../scripts/serve/run-archive-gateway");

const CLIENT_SECRET = "c".repeat(MIN_TOKEN_LENGTH);
const GATEWAY_ENTRY = path.join(__dirname, "../../scripts/serve/run-archive-gateway.js");

function configuredEnv(overrides = {}) {
  return {
    TT_ARCHIVE_SERVICE_URL: "http://127.0.0.1:8002/query",
    TT_QUERY_SERVICE_SECRET: "service-secret-under-test",
    TT_ARCHIVE_CLIENT_TOKENS: `terminal-web:${CLIENT_SECRET}`,
    ...overrides,
  };
}

function validPage(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    pointer: {},
    pointerToken: "snapshot-token",
    family: "candle",
    rows: [],
    nextCursor: null,
    queryFingerprint: "f".repeat(64),
    coverage: {
      requested: { from: "1756684800000000000", to: "1756771200000000000" },
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

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function request(port, { method = "GET", pathname = "/health", headers = {}, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, body: parsed, text };
}

describe("parseGatewayArgs", () => {
  test("defaults to the loopback relay port", () => {
    expect(parseGatewayArgs([], {})).toEqual({ port: DEFAULT_PORT, host: "127.0.0.1" });
  });

  test("argv beats the environment", () => {
    expect(parseGatewayArgs(["9100"], { TT_ARCHIVE_GATEWAY_PORT: "9200" }).port).toBe(9100);
  });

  test("the environment is used when argv is absent", () => {
    expect(parseGatewayArgs([], { TT_ARCHIVE_GATEWAY_PORT: "9200" }).port).toBe(9200);
  });

  test("localhost is normalised to an explicit address", () => {
    expect(parseGatewayArgs(["9100", "localhost"], {}).host).toBe("127.0.0.1");
  });

  test("a Tailscale CGNAT address is accepted", () => {
    expect(parseGatewayArgs(["9100", "100.109.200.28"], {}).host).toBe("100.109.200.28");
  });

  test("TT_ARCHIVE_GATEWAY_HOST may supply a Tailscale address when argv has no host", () => {
    expect(parseGatewayArgs(["9100"], { TT_ARCHIVE_GATEWAY_HOST: "100.66.235.12" }).host).toBe("100.66.235.12");
  });

  test("a lab WireGuard address is accepted", () => {
    expect(parseGatewayArgs(["9100", "10.88.0.1"], {}).host).toBe("10.88.0.1");
  });

  test.each([["0.0.0.0"], ["::"], ["82.26.91.250"], ["example.com"], ["10.0.0.1"], ["10.88.0.2"], ["10.88.1.1"], ["100.63.255.255"], ["100.128.0.1"]])(
    "refuses to bind %s", (host) => {
      expect(() => parseGatewayArgs(["9100", host], {})).toThrow(/loopback, a Tailscale address/);
    });

  test("the factory also refuses a host that bypasses argv parsing", () => {
    expect(() => createGateway({ host: "0.0.0.0", env: configuredEnv(), log: () => {} })).toThrow(/loopback, a Tailscale address/);
  });

  test.each([["0"], ["-1"], ["70000"], ["abc"], ["8001.5"]])(
    "refuses port %s", (port) => {
      expect(() => parseGatewayArgs([port], {})).toThrow(/invalid port/);
    });
});

describe("configurationProblems", () => {
  test("a fully configured environment has none", () => {
    expect(configurationProblems(configuredEnv())).toEqual([]);
  });

  test.each([
    ["TT_ARCHIVE_SERVICE_URL", "ARCHIVE_SERVICE_URL_NOT_CONFIGURED"],
    ["TT_QUERY_SERVICE_SECRET", "QUERY_SERVICE_SECRET_NOT_CONFIGURED"],
    ["TT_ARCHIVE_CLIENT_TOKENS", "CLIENT_TOKENS_NOT_CONFIGURED"],
  ])("a missing %s is reported as %s", (name, reason) => {
    expect(configurationProblems(configuredEnv({ [name]: "" }))).toEqual([reason]);
  });

  test("malformed client tokens are distinguished from absent ones", () => {
    expect(configurationProblems(configuredEnv({ TT_ARCHIVE_CLIENT_TOKENS: "no-separator" })))
      .toEqual(["CLIENT_TOKENS_INVALID"]);
  });

  test("a token shorter than the minimum is invalid, not merely accepted", () => {
    expect(configurationProblems(configuredEnv({ TT_ARCHIVE_CLIENT_TOKENS: "web:short" })))
      .toEqual(["CLIENT_TOKENS_INVALID"]);
  });
});

describe("the gateway process boundary", () => {
  test("keeps L2 optional and returns its own refusal contract through the actual gateway entry", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {} });
    await listen(gateway.server);
    try {
      const result = await request(gateway.server.address().port, { method: "POST", pathname: "/archive/l2",
        headers: { authorization: `Bearer ${CLIENT_SECRET}` }, body: { contractVersion: "historical-l2-query/1", operation: "catalog" } });
      expect(result.status).toBe(503);
      expect(result.body.contractVersion).toBe("historical-l2-query/1");
      expect(gateway.health().ready).toBe(true);
      expect(gateway.health().l2.configured).toBe(false);
    } finally { await gateway.stop(); }
  });

  test("authenticates the L2 viewer and relays to the configured isolated upstream", async () => {
    const calls = [];
    const { PROFILES } = require("../../src/server/historical-l2-route");
    const upstream = http.createServer((req, res) => {
      calls.push(req.headers);
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ contractVersion: "historical-l2-query/1", operation: "catalog", releaseId: "a".repeat(64), snapshotToken: "b".repeat(32), depthLimit: 10,
        inference: "top-ten depth inference; not order-level cancellation truth",
        sessions: PROFILES.flatMap((instrument_id) => Array.from({ length: 31 }, (_, i) => ({ instrument_id, date: `2026-08-${String(i + 1).padStart(2, "0")}`, state: "UNAVAILABLE", reason: "NOT_YET_QUALIFIED" }))) }));
    });
    await listen(upstream);
    const gateway = createGateway({ env: configuredEnv({ TT_L2_ARCHIVE_SERVICE_URL: `http://127.0.0.1:${upstream.address().port}/query` }), log: () => {} });
    await listen(gateway.server);
    try {
      const args = { method: "POST", pathname: "/archive/l2", body: { contractVersion: "historical-l2-query/1", operation: "catalog" } };
      expect((await request(gateway.server.address().port, args)).status).toBe(401);
      expect(calls).toHaveLength(0);
      const result = await request(gateway.server.address().port, { ...args, headers: { authorization: `Bearer ${CLIENT_SECRET}` } });
      expect(result.status).toBe(200);
      expect(calls[0]["x-archive-client"]).toBe("terminal-web");
      expect(calls[0]["x-archive-service-secret"]).toBe("service-secret-under-test");
      expect(calls[0].authorization).toBeUndefined();
      expect(gateway.health().l2.disabled).not.toBe(true);
    } finally { await gateway.stop(); await close(upstream); }
  });
  // The entire reason this entry point exists: app.js starts a live Binance
  // WebSocket and the dxFeed server, so serving the archive from it would open a
  // second exchange connection beside the collector. A real child process is used
  // because jest's module registry is not the registry that would matter in
  // production.
  test("loading it pulls in no exchange connection, dxFeed or sqlite", () => {
    const script = `require(${JSON.stringify(GATEWAY_ENTRY)});`
      + `console.log(JSON.stringify(Object.keys(require.cache)));`;
    const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const loaded = JSON.parse(output.trim()).map((entry) => entry.replace(/\\/g, "/"));
    const forbidden = loaded.filter((entry) => /binance-connection|dxfeed|better-sqlite3|(?<!archive-)storage-reader|storage-db|market-data-server|src\/server\/app\.js|frames\.js|vpin-warmup-worker/.test(entry));
    expect(forbidden).toEqual([]);
    expect(loaded.some((entry) => /src\/server\/archive-route\.js/.test(entry))).toBe(true);
    expect(loaded.some((entry) => /src\/server\/archive-study-route\.js/.test(entry))).toBe(true);
    expect(loaded.some((entry) => /src\/storage\/archive-storage-reader\.js/.test(entry))).toBe(true);
  });

  test("its request timeout outlives the upstream deadline", () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_UPSTREAM_TIMEOUT_MS);
  });
});

describe("health", () => {
  test("a configured gateway reports ready with no reasons", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {} });
    await listen(gateway.server);
    try {
      const { status, body } = await request(gateway.server.address().port);
      expect(status).toBe(200);
      expect(body.contractVersion).toBe(CONTRACT_VERSION);
      expect(body.ready).toBe(true);
      expect(body.clients).toBe(1);
      expect(body.runtime).toMatchObject({
        processRssBytes: expect.any(Number),
        processCpuUserMicros: expect.any(Number),
        eventLoopSamples: expect.any(Number),
      });
      expect(body.reasons).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });

  test("an unconfigured gateway listens but names every reason it cannot serve", async () => {
    const gateway = createGateway({ env: {}, log: () => {} });
    await listen(gateway.server);
    try {
      const { body } = await request(gateway.server.address().port);
      expect(body.ready).toBe(false);
      expect(body.reasons).toEqual(expect.arrayContaining([
        "ARCHIVE_SERVICE_URL_NOT_CONFIGURED",
        "QUERY_SERVICE_SECRET_NOT_CONFIGURED",
        "CLIENT_TOKENS_NOT_CONFIGURED",
      ]));
      expect(body.clients).toBe(0);
    } finally {
      await gateway.stop();
    }
  });

  test("a service URL outside loopback disables the route rather than proxying to it", async () => {
    const gateway = createGateway({
      env: configuredEnv({ TT_ARCHIVE_SERVICE_URL: "http://example.com/query" }),
      log: () => {},
    });
    await listen(gateway.server);
    try {
      const { body } = await request(gateway.server.address().port);
      expect(body.ready).toBe(false);
      expect(body.reasons).toContain("ROUTE_DISABLED");
    } finally {
      await gateway.stop();
    }
  });
});

describe("routing", () => {
  test("an unknown path is a 404 with no body", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {} });
    await listen(gateway.server);
    try {
      const { status, text } = await request(gateway.server.address().port, { pathname: "/nope" });
      expect(status).toBe(404);
      expect(text).toBe("");
    } finally {
      await gateway.stop();
    }
  });

  test("an unauthenticated query is refused before anything upstream is contacted", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {} });
    await listen(gateway.server);
    try {
      const { status, body } = await request(gateway.server.address().port, {
        method: "POST",
        pathname: ARCHIVE_QUERY_PATH,
        headers: { "content-type": "application/json" },
        body: { contractVersion: CONTRACT_VERSION },
      });
      expect(status).toBe(401);
      expect(body.error).toBe("UNAUTHORIZED");
    } finally {
      await gateway.stop();
    }
  });

  test("an authenticated query reaches the upstream carrying the service secret and derived client", async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push({
        secret: req.headers["x-archive-service-secret"],
        client: req.headers["x-archive-client"],
        authorization: req.headers.authorization,
      });
      const payload = JSON.stringify(validPage());
      res.writeHead(200, { "content-type": "application/json", "content-length": String(payload.length) });
      res.end(payload);
    });
    await listen(upstream);

    const gateway = createGateway({
      env: configuredEnv({
        TT_ARCHIVE_SERVICE_URL: `http://127.0.0.1:${upstream.address().port}/query`,
      }),
      log: () => {},
    });
    await listen(gateway.server);
    try {
      const { status, body } = await request(gateway.server.address().port, {
        method: "POST",
        pathname: ARCHIVE_QUERY_PATH,
        headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_SECRET}` },
        body: {
          contractVersion: CONTRACT_VERSION,
          instrumentId: '["XCME","FUTURE","ESU5","USD","CONTRACT"]',
          family: "candle",
          from: "1756684800000000000",
          to: "1756771200000000000",
        },
      });
      expect(status).toBe(200);
      expect(body.family).toBe("candle");
      expect(seen).toHaveLength(1);
      expect(seen[0].secret).toBe("service-secret-under-test");
      expect(seen[0].client).toBe("terminal-web");
      // The browser credential must never be forwarded; only the identity it resolved to.
      expect(seen[0].authorization).toBeUndefined();
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });
});

describe("an unexpected throw must not take the process with it", () => {
  // Reproduced before this was written: a route whose stats() threw killed the
  // process with exit 1, the client got no response at all, and the logger never
  // flushed -- losing the diagnostic exactly when it was needed. app.js already
  // guards its own /health branch the same way; this entry point did not.
  function throwingRoute(where) {
    return {
      handle: () => { if (where === "handle") throw new Error("BOOM from handle()"); return false; },
      dispose: () => {},
      stats: () => { if (where === "stats") throw new Error("BOOM from stats()"); return { admitted: 0 }; },
    };
  }

  test("a throwing health probe answers 503 instead of crashing", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, archiveRoute: throwingRoute("stats") });
    await listen(gateway.server);
    try {
      const { status, body } = await request(gateway.server.address().port);
      expect(status).toBe(503);
      expect(body.ready).toBe(false);
      expect(body.reasons).toContain("HEALTH_PROBE_FAILED");
    } finally {
      await gateway.stop();
    }
  });

  test("a throwing route answers inside the contract instead of crashing", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, archiveRoute: throwingRoute("handle") });
    await listen(gateway.server);
    try {
      const { status, body } = await request(gateway.server.address().port, {
        method: "POST",
        pathname: ARCHIVE_QUERY_PATH,
        headers: { "content-type": "application/json" },
        body: { contractVersion: CONTRACT_VERSION },
      });
      expect(status).toBe(REFUSAL_STATUS.READER_UNAVAILABLE);
      expect(body.error).toBe("READER_UNAVAILABLE");
      expect(body.contractVersion).toBe(CONTRACT_VERSION);
    } finally {
      await gateway.stop();
    }
  });

  test("the server keeps answering after a handler throws", async () => {
    let explode = true;
    const route = {
      handle: () => { if (explode) { explode = false; throw new Error("BOOM once"); } return false; },
      dispose: () => {},
      stats: () => ({ admitted: 0 }),
    };
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, archiveRoute: route });
    await listen(gateway.server);
    try {
      const first = await request(gateway.server.address().port, { method: "POST", pathname: ARCHIVE_QUERY_PATH, body: {} });
      expect(first.status).toBe(REFUSAL_STATUS.READER_UNAVAILABLE);
      const second = await request(gateway.server.address().port, { pathname: "/nope" });
      expect(second.status).toBe(404);
    } finally {
      await gateway.stop();
    }
  });

  test("main installs fatal handlers and removes them on shutdown", async () => {
    const listeners = new Map();
    const processImpl = {
      exitCode: 0,
      on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
      off(event, fn) { listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn)); },
      exit() {},
    };
    const logger = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {}, banner: () => {}, flush: async () => {}, close: () => {} };
    // parseGatewayArgs deliberately refuses port 0, so main() cannot take an
    // ephemeral port; borrow a real free one instead.
    const probe = await listen(http.createServer());
    const freePort = probe.address().port;
    await close(probe);
    const { shutdown } = await main({ argv: [String(freePort)], env: configuredEnv(), processImpl, logger });

    expect(listeners.get("uncaughtException")).toHaveLength(1);
    expect(listeners.get("unhandledRejection")).toHaveLength(1);

    await shutdown("test");
    expect(listeners.get("uncaughtException")).toHaveLength(0);
    expect(listeners.get("unhandledRejection")).toHaveLength(0);
  });
});

describe("what health does and does not prove", () => {
  // Both health endpoints decide readiness from the *presence* of a secret, not
  // from the pair actually being accepted. A gateway configured with one secret
  // and a service expecting another reports ready on both sides while refusing
  // every query -- which is precisely the check an operator trusts during a
  // deploy. Recorded as a limitation, not silently fixed: making health prove
  // the pair means probing upstream on every check.
  test("a mismatched service secret still reports ready while every query is refused", async () => {
    const upstream = http.createServer((req, res) => {
      const presented = req.headers["x-archive-service-secret"];
      const payload = JSON.stringify(presented === "what-the-service-expects"
        ? validPage()
        : { contractVersion: CONTRACT_VERSION, error: "UNAUTHORIZED", detail: "SERVICE_SECRET_MISMATCH" });
      res.writeHead(presented === "what-the-service-expects" ? 200 : 401,
        { "content-type": "application/json", "content-length": String(payload.length) });
      res.end(payload);
    });
    await listen(upstream);

    const gateway = createGateway({
      env: configuredEnv({
        TT_ARCHIVE_SERVICE_URL: `http://127.0.0.1:${upstream.address().port}/query`,
        TT_QUERY_SERVICE_SECRET: "what-the-gateway-was-given",
      }),
      log: () => {},
    });
    await listen(gateway.server);
    try {
      const health = await request(gateway.server.address().port);
      expect(health.body.ready).toBe(true);
      expect(health.body.reasons).toBeUndefined();

      const query = await request(gateway.server.address().port, {
        method: "POST",
        pathname: ARCHIVE_QUERY_PATH,
        headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_SECRET}` },
        body: {
          contractVersion: CONTRACT_VERSION,
          instrumentId: '["XCME","FUTURE","ESU5","USD","CONTRACT"]',
          family: "candle", from: "1", to: "2",
        },
      });
      expect(query.status).toBe(401);
      expect(query.body.error).toBe("UNAUTHORIZED");
    } finally {
      await gateway.stop();
      await close(upstream);
    }
  });
});

describe("shutdown", () => {
  test("stop disposes the route and stops answering", async () => {
    const disposals = [];
    const stubRoute = {
      handle: () => false,
      dispose: () => disposals.push("disposed"),
      stats: () => ({ admitted: 0 }),
    };
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, archiveRoute: stubRoute });
    await listen(gateway.server);
    const { port } = gateway.server.address();
    await gateway.stop();
    expect(disposals).toEqual(["disposed"]);
    await expect(request(port)).rejects.toThrow();
  });

  test("health reports the shutdown before the socket closes", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {} });
    await listen(gateway.server);
    const stopping = gateway.stop();
    expect(gateway.health().ready).toBe(false);
    expect(gateway.health().reasons).toContain("SHUTTING_DOWN");
    await stopping;
  });
});

describe("gateway: live-storage relay mounted alongside the archive route", () => {
  test("a request under /live-storage/* reaches the live-storage relay, not the archive route", async () => {
    const liveStorageCalls = [];
    const stubLiveStorage = {
      handle: (request, response) => {
        liveStorageCalls.push(request.url);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return true;
      },
      dispose: () => {},
      stats: () => ({ disabled: false }),
    };
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, liveStorageRelay: stubLiveStorage });
    await listen(gateway.server);
    const { port } = gateway.server.address();
    const response = await fetch(`http://127.0.0.1:${port}/live-storage/recording-age`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(liveStorageCalls).toEqual(["/live-storage/recording-age"]);
    await gateway.stop();
  });

  test("a request under /archive/query never reaches the live-storage relay", async () => {
    const liveStorageCalls = [];
    const stubLiveStorage = {
      handle: (request) => { liveStorageCalls.push(request.url); return false; },
      dispose: () => {},
      stats: () => ({ disabled: false }),
    };
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, liveStorageRelay: stubLiveStorage });
    await listen(gateway.server);
    const { port } = gateway.server.address();
    await fetch(`http://127.0.0.1:${port}${ARCHIVE_QUERY_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_SECRET}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(liveStorageCalls).toEqual([]);
    await gateway.stop();
  });

  test("an unconfigured live-storage relay reports itself disabled in health without affecting archive readiness", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {} });
    const state = gateway.health();
    expect(state.ready).toBe(true);
    expect(state.liveStorage).toEqual(expect.objectContaining({ disabled: true }));
  });

  test("stop disposes the live-storage relay too", async () => {
    const disposals = [];
    const stubLiveStorage = { handle: () => false, dispose: () => disposals.push("live-storage disposed"), stats: () => ({ disabled: false }) };
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, liveStorageRelay: stubLiveStorage });
    await listen(gateway.server);
    await gateway.stop();
    expect(disposals).toEqual(["live-storage disposed"]);
  });
});

describe("gateway: archive study route mounted beside the archive route", () => {
  const STUDY_CONTRACT_VERSION = "archive-study/1";

  test("/archive/study is answered by the study route under the gateway's own client tokens", async () => {
    const gateway = createGateway({ env: configuredEnv(), log: () => {} });
    await listen(gateway.server);
    const { port } = gateway.server.address();
    try {
      const anonymous = await request(port, {
        method: "POST",
        pathname: "/archive/study",
        headers: { "content-type": "application/json" },
        body: { contractVersion: STUDY_CONTRACT_VERSION },
      });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toEqual({ contractVersion: STUDY_CONTRACT_VERSION, error: "UNAUTHORIZED", reason: "CLIENT_NOT_AUTHENTICATED" });

      const authenticated = await request(port, {
        method: "POST",
        pathname: "/archive/study",
        headers: { authorization: `Bearer ${CLIENT_SECRET}`, "content-type": "application/json" },
        body: { contractVersion: STUDY_CONTRACT_VERSION },
      });
      expect(authenticated.status).toBe(400);
      expect(authenticated.body).toMatchObject({ contractVersion: STUDY_CONTRACT_VERSION, error: "MALFORMED_REQUEST" });
      expect(gateway.health().study).toEqual(expect.objectContaining({ unauthorized: 1, refused: 1, inFlight: 0 }));
    } finally {
      await gateway.stop();
    }
  });

  test("a request under /archive/study never reaches the live-storage relay", async () => {
    const liveStorageCalls = [];
    const stubLiveStorage = {
      handle: (request) => { liveStorageCalls.push(request.url); return false; },
      dispose: () => {},
      stats: () => ({ disabled: false }),
    };
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, liveStorageRelay: stubLiveStorage });
    await listen(gateway.server);
    try {
      await request(gateway.server.address().port, {
        method: "POST",
        pathname: "/archive/study",
        headers: { authorization: `Bearer ${CLIENT_SECRET}`, "content-type": "application/json" },
        body: {},
      });
      expect(liveStorageCalls).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });

  test("stop disposes the study route too", async () => {
    const disposals = [];
    const stubStudy = { handle: () => false, dispose: () => disposals.push("study disposed"), stats: () => ({ inFlight: 0 }) };
    const gateway = createGateway({ env: configuredEnv(), log: () => {}, archiveStudyRoute: stubStudy });
    await listen(gateway.server);
    await gateway.stop();
    expect(disposals).toEqual(["study disposed"]);
  });
});
