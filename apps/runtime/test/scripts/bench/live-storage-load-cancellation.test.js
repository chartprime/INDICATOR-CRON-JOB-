"use strict";

const http = require("node:http");

const { runManifest, validateManifest } = require("../../../scripts/bench/live-storage-load");

const BASE = "http://127.0.0.1:8002/live-storage/";
const HEALTH = "http://127.0.0.1:8002/health";

const manifestOf = (request = {}, extra = {}) => ({
  version: 1, users: 1, rounds: 1,
  requests: [{ route: "minute-rollup", body: { symbol: "BTCUSDT" }, ...request }],
  ...extra,
});
const okResponse = (init) => new Response("{}", { status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] } });
const slowThenOk = (delayMs, { honourAbort = true } = {}) => (_url, init) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(okResponse(init)), delayMs);
  if (honourAbort) {
    init.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(init.signal.reason);
    }, { once: true });
  }
});
const run = (manifest, overrides = {}) => runManifest({ manifest, baseUrl: BASE, token: "secret", ...overrides });

describe("scripts/bench/live-storage-load cancellation contract", () => {
  describe("manifest validation", () => {
    test("accepts a bounded abort and rejects anything else", () => {
      expect(() => validateManifest(manifestOf({ abort: { afterMs: 500 } }))).not.toThrow();
      for (const abort of [{}, { afterMs: 0 }, { afterMs: 1.5 }, { afterMs: 600_001 }, { afterMs: 5, extra: 1 }, [], "500", null]) {
        expect(() => validateManifest(manifestOf({ abort }))).toThrow(/abort/);
      }
    });

    test("serverDelta is opt-in, must be true, and needs a live-storage request to read", () => {
      expect(() => validateManifest(manifestOf({}, { serverDelta: true }))).not.toThrow();
      expect(() => validateManifest(manifestOf({}, { serverDelta: false }))).toThrow(/serverDelta/);
      expect(() => validateManifest(manifestOf({
        kind: "archive-query", route: "archive-query",
        body: { instrumentId: "i", family: "trade", from: "1", to: "2" },
      }, { serverDelta: true }))).toThrow(/live-storage request/);
    });
  });

  describe("abort classification", () => {
    test("the benchmark's own abort timer firing first is CLIENT_ABORTED and records that it fired", async () => {
      const report = await run(manifestOf({ abort: { afterMs: 5 } }), { fetchImpl: slowThenOk(500) });
      expect(report.samples[0]).toMatchObject({
        failureClass: "CLIENT_ABORTED", status: 0, responseBytes: 0, bodySha256: null, abort: { afterMs: 5, fired: true },
      });
      expect(report.samples[0].abortRaced).toBeUndefined();
      expect(report.samples[0].error).toContain("BENCHMARK_ABORT");
    });

    test("the runner's own timeout is CLIENT_TIMEOUT, distinct from a transport failure and from a deliberate abort", async () => {
      const report = await run(manifestOf(), { fetchImpl: slowThenOk(500), timeoutMs: 5 });
      expect(report.samples[0]).toMatchObject({ failureClass: "CLIENT_TIMEOUT", status: 0 });
      expect(report.samples[0].abort).toBeUndefined();
    });

    test("a timeout that fires before the abort timer wins, and the abort is recorded as not fired", async () => {
      const report = await run(manifestOf({ abort: { afterMs: 400 } }), { fetchImpl: slowThenOk(500), timeoutMs: 5 });
      expect(report.samples[0]).toMatchObject({ failureClass: "CLIENT_TIMEOUT", abort: { afterMs: 400, fired: false } });
    });

    test("a remote socket closure is TRANSPORT_FAILURE even when an abort is scheduled but has not fired", async () => {
      const report = await run(manifestOf({ abort: { afterMs: 10_000 } }), {
        fetchImpl: async () => { throw new TypeError("fetch failed"); },
      });
      expect(report.samples[0]).toMatchObject({ failureClass: "TRANSPORT_FAILURE", abort: { afterMs: 10_000, fired: false }, error: "fetch failed" });
      expect(report.samples[0].abortRaced).toBeUndefined();
    });

    test("a server error status is a service failure, not an abort", async () => {
      const report = await run(manifestOf({ abort: { afterMs: 10_000 } }), {
        fetchImpl: async (_url, init) => new Response("{}", { status: 504, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] } }),
      });
      expect(report.samples[0]).toMatchObject({ failureClass: "SERVICE_FAILURE", status: 504 });
    });

    test("a response that completes although the abort timer fired keeps its real classification and is marked raced", async () => {
      const report = await run(manifestOf({ abort: { afterMs: 5 } }), { fetchImpl: slowThenOk(40, { honourAbort: false }) });
      expect(report.samples[0]).toMatchObject({
        failureClass: "SUCCESS", status: 200, abort: { afterMs: 5, fired: true }, abortRaced: true,
      });
      expect(report.samples[0].bodySha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test("a socket failure that arrives after the abort fired is not credited to the abort", async () => {
      const report = await run(manifestOf({ abort: { afterMs: 5 } }), {
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new TypeError("fetch failed")), { once: true });
        }),
      });
      expect(report.samples[0]).toMatchObject({ failureClass: "TRANSPORT_FAILURE", abort: { afterMs: 5, fired: true }, abortRaced: true });
    });

    test("an abort during the body read still counts as aborted and keeps the status the headers carried", async () => {
      const report = await run(manifestOf({ abort: { afterMs: 5 } }), {
        fetchImpl: (_url, init) => Promise.resolve({
          status: 200,
          headers: { get: () => init.headers["x-terminal-correlation-id"] },
          arrayBuffer: () => new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
        }),
      });
      expect(report.samples[0]).toMatchObject({ failureClass: "CLIENT_ABORTED", status: 200, responseBytes: 0 });
    });

    test("pagination stops at an aborted page instead of following a stale cursor", async () => {
      let calls = 0;
      const report = await run(manifestOf({ abort: { afterMs: 5 }, paginate: { maxPages: 5 } }), {
        fetchImpl: (_url, init) => {
          calls += 1;
          return slowThenOk(500)(_url, init);
        },
      });
      expect(calls).toBe(1);
      expect(report.samples).toHaveLength(1);
    });

    test("against a real socket, an abort surfaces as CLIENT_ABORTED and the server sees the connection close", async () => {
      let observedClose;
      const closed = new Promise((resolve) => { observedClose = resolve; });
      const server = http.createServer((request) => { request.on("close", observedClose); });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address();
        const report = await runManifest({
          manifest: manifestOf({ abort: { afterMs: 50 } }), baseUrl: `http://127.0.0.1:${port}/live-storage`, token: "secret",
        });
        expect(report.samples[0]).toMatchObject({ failureClass: "CLIENT_ABORTED", abort: { afterMs: 50, fired: true } });
        let giveUp;
        const deadline = new Promise((_, reject) => { giveUp = setTimeout(() => reject(new Error("server never saw the close")), 2_000); });
        try {
          await expect(Promise.race([closed, deadline])).resolves.toBeUndefined();
        } finally {
          clearTimeout(giveUp);
        }
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe("process interruption", () => {
    test("in-flight requests end as PROCESS_INTERRUPTED, nothing new starts, and the report says it was interrupted", async () => {
      const interruption = new AbortController();
      let calls = 0;
      const promise = run({ version: 1, users: 2, rounds: 3, requests: [{ route: "minute-rollup", body: {} }] }, {
        signal: interruption.signal,
        fetchImpl: (url, init) => {
          calls += 1;
          return slowThenOk(2_000)(url, init);
        },
      });
      setTimeout(() => interruption.abort(), 20);
      const report = await promise;
      expect(calls).toBe(2);
      expect(report.interrupted).toBe(true);
      expect(report.samples.map((sample) => sample.failureClass)).toEqual(["PROCESS_INTERRUPTED", "PROCESS_INTERRUPTED"]);
    });

    test("a signal that is already aborted starts nothing", async () => {
      const interruption = new AbortController();
      interruption.abort();
      const fetchImpl = jest.fn();
      const report = await run(manifestOf(), { signal: interruption.signal, fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(report).toMatchObject({ interrupted: true, samples: [] });
    });

    test("a run that is never interrupted carries no interrupted flag", async () => {
      const report = await run(manifestOf(), { fetchImpl: async (_url, init) => okResponse(init) });
      expect(report.interrupted).toBeUndefined();
    });
  });

  describe("serverDelta", () => {
    const counters = (overrides = {}) => ({
      requests: 0, successes: 0, clientErrors: 0, serverErrors: 0, cancelled: 0, timedOut: 0, overloaded: 0,
      coalesced: 0, cacheHits: 0, cacheMisses: 0, failureReasons: {}, ...overrides,
    });
    const healthBody = ({ inFlight = 0, route = counters(), runtime = {}, storage = {} } = {}) => JSON.stringify({
      ready: true, route: { inFlight, telemetry: { routes: { "minute-rollup": route } } }, runtime, storage,
    });
    const routed = ({ healthQueue, livestorage = async (_url, init) => okResponse(init), healthRequests = [] }) => async (url, init) => {
      if (String(url) === HEALTH) {
        healthRequests.push(init);
        const next = healthQueue.length > 1 ? healthQueue.shift() : healthQueue[0];
        if (next instanceof Error) throw next;
        return new Response(next, { status: 200 });
      }
      return livestorage(url, init);
    };
    const fakeClock = () => {
      let clock = 0;
      return { now: () => clock, sleep: async (ms) => { clock += ms; } };
    };

    test("requires the health URL up front instead of silently skipping the measurement", async () => {
      const fetchImpl = jest.fn();
      await expect(run(manifestOf({}, { serverDelta: true }), { fetchImpl })).rejects.toThrow(/TT_BENCH_HEALTH_URL/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    test("labels the delta host-wide and quantifies traffic the run cannot account for", async () => {
      const healthQueue = [
        healthBody({ route: counters({ requests: 10, successes: 8, cancelled: 1, failureReasons: { route_timeout: 1 } }) }),
        healthBody({ route: counters({ requests: 14, successes: 9, cancelled: 3, failureReasons: { route_timeout: 2, worker_failed: 1 } }) }),
      ];
      const report = await run(manifestOf({ abort: { afterMs: 5 } }, { serverDelta: true }), {
        healthUrl: HEALTH, ...fakeClock(),
        fetchImpl: routed({ healthQueue, livestorage: slowThenOk(500) }),
      });
      expect(report.serverDelta).toMatchObject({
        attribution: "HOST_WIDE", note: expect.stringMatching(/every request the host served/),
        routes: {
          "minute-rollup": {
            delta: { requests: 4, successes: 1, cancelled: 2 },
            failureReasons: { route_timeout: 1, worker_failed: 1 },
            runRequests: 1, unattributedRequests: 3,
          },
        },
      });
    });

    test("captures bounded process and database/WAL deltas around the governed run", async () => {
      const storage = (database, wal, shm) => ({ binance: { database, wal, shm }, dxfeed: { database: 20, wal: 0, shm: 0 } });
      const report = await run(manifestOf({}, { serverDelta: true }), {
        healthUrl: HEALTH, ...fakeClock(),
        fetchImpl: routed({ healthQueue: [
          healthBody({ runtime: { processCpuUserMicros: 100, processRssBytes: 1_000, secret: 99 }, storage: storage(1_000, 100, 32) }),
          healthBody({ runtime: { processCpuUserMicros: 160, processRssBytes: 1_200, secret: 100 }, storage: storage(1_050, 140, 32) }),
        ] }),
      });
      expect(report.serverDelta.runtime).toEqual({
        before: { processCpuUserMicros: 100, processRssBytes: 1_000 },
        after: { processCpuUserMicros: 160, processRssBytes: 1_200 },
        cumulativeDelta: { processCpuUserMicros: 60 },
      });
      expect(report.serverDelta.storage.byteDelta.binance).toEqual({ database: 50, wal: 40, shm: 0 });
      expect(JSON.stringify(report)).not.toContain("secret");
    });

    test("reports whether the server's in-flight work drained back to its starting level after the run", async () => {
      const drained = await run(manifestOf({ abort: { afterMs: 5 } }, { serverDelta: true }), {
        healthUrl: HEALTH, ...fakeClock(),
        fetchImpl: routed({ healthQueue: [healthBody({ inFlight: 0 }), healthBody({ inFlight: 2 }), healthBody({ inFlight: 0 })], livestorage: slowThenOk(500) }),
        healthSettleMs: 1_000, healthPollMs: 100,
      });
      expect(drained.serverDelta.inFlight).toMatchObject({ before: 0, after: 0, drained: true, settleMs: 1_000 });
      expect(drained.serverDelta.inFlight.drainedAfterMs).toBeGreaterThanOrEqual(100);

      const orphaned = await run(manifestOf({ abort: { afterMs: 5 } }, { serverDelta: true }), {
        healthUrl: HEALTH, ...fakeClock(),
        fetchImpl: routed({ healthQueue: [healthBody({ inFlight: 0 }), healthBody({ inFlight: 3 })], livestorage: slowThenOk(500) }),
        healthSettleMs: 300, healthPollMs: 100,
      });
      expect(orphaned.serverDelta.inFlight).toMatchObject({ before: 0, after: 3, drained: false, drainedAfterMs: null, settleMs: 300 });
    });

    test("does not claim a drain when the server does not report in-flight work", async () => {
      const bare = JSON.stringify({ route: { telemetry: { routes: { "minute-rollup": counters() } } } });
      const report = await run(manifestOf({}, { serverDelta: true }), {
        healthUrl: HEALTH, ...fakeClock(), fetchImpl: routed({ healthQueue: [bare] }),
      });
      expect(report.serverDelta.inFlight).toMatchObject({ before: null, after: null, drained: null, drainedAfterMs: null });
    });

    test("a server restart between the scrapes is reported as a counter reset, not as negative work", async () => {
      const report = await run(manifestOf({}, { serverDelta: true }), {
        healthUrl: HEALTH, ...fakeClock(),
        fetchImpl: routed({ healthQueue: [healthBody({ route: counters({ requests: 100 }) }), healthBody({ route: counters({ requests: 3 }) })] }),
      });
      expect(report.serverDelta).toMatchObject({ attribution: "HOST_WIDE", error: "SERVER_COUNTERS_RESET" });
      expect(report.serverDelta.routes).toBeUndefined();
    });

    test("an unreachable health endpoint is recorded without discarding the run's samples", async () => {
      const afterOnly = await run(manifestOf({}, { serverDelta: true }), {
        healthUrl: HEALTH, ...fakeClock(),
        fetchImpl: routed({ healthQueue: [healthBody(), new Error("connect ECONNREFUSED")] }),
      });
      expect(afterOnly.serverDelta).toMatchObject({ error: "HEALTH_UNAVAILABLE", detail: expect.stringContaining("ECONNREFUSED") });
      expect(afterOnly.samples).toHaveLength(1);
      const beforeToo = await run(manifestOf({}, { serverDelta: true }), {
        healthUrl: HEALTH, ...fakeClock(),
        fetchImpl: routed({ healthQueue: [new Error("connect ECONNREFUSED")] }),
      });
      expect(beforeToo.serverDelta).toMatchObject({ error: "HEALTH_UNAVAILABLE" });
      expect(beforeToo.samples).toHaveLength(1);
    });

    test("keeps only bounded integer counters and known failure reasons, sends no credentials, and records only the health origin", async () => {
      const healthRequests = [];
      const hostile = healthBody({
        route: counters({ requests: 2, failureReasons: { route_timeout: 1, "secret-reason": 9, worker_failed: "many" } }),
      }).replace('"requests":2', '"requests":2,"note":"do-not-copy"');
      const report = await run(manifestOf({}, { serverDelta: true }), {
        healthUrl: `${HEALTH}`, ...fakeClock(), provenance: { git: null, scriptSha256: "s", manifestSha256: "m", nodeVersion: "v24" },
        fetchImpl: routed({ healthQueue: [healthBody(), hostile], healthRequests }),
      });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("do-not-copy");
      expect(serialized).not.toContain("secret-reason");
      expect(report.serverDelta.routes["minute-rollup"].failureReasons).toEqual({ route_timeout: 1 });
      expect(healthRequests.every((init) => init.method === "GET" && init.headers.authorization === undefined)).toBe(true);
      expect(report.source.endpoints.healthOrigin).toBe("http://127.0.0.1:8002");
      expect(serialized).not.toContain("secret\"");
    });

    test("a manifest without serverDelta never touches the health endpoint", async () => {
      const fetchImpl = jest.fn(async (_url, init) => okResponse(init));
      const report = await run(manifestOf(), { fetchImpl, healthUrl: HEALTH });
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(HEALTH);
      expect(report.serverDelta).toBeUndefined();
    });
  });
});
