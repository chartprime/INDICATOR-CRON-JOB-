"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  runManifest, validateManifest, summarize, classifyResponse, summarizeResponseBody, collectToolProvenance,
} = require("../../../scripts/bench/live-storage-load");

describe("scripts/bench/live-storage-load", () => {
  test("validates bounded deterministic manifests", () => {
    expect(() => validateManifest({ version: 1, users: 33, rounds: 1, requests: [{}] })).toThrow(/users/);
    expect(() => validateManifest({ version: 1, users: 1, rounds: 1, requests: [{ route: "BAD", body: {} }] })).toThrow(/route/);
  });

  test("validates the optional paginate.maxPages field on a request", () => {
    expect(() => validateManifest({
      version: 1, users: 1, rounds: 1,
      requests: [{ route: "replay-page", body: {}, paginate: { maxPages: 0 } }],
    })).toThrow(/paginate\.maxPages/);
    expect(() => validateManifest({
      version: 1, users: 1, rounds: 1,
      requests: [{ route: "replay-page", body: {}, paginate: { maxPages: 3 } }],
    })).not.toThrow();
  });

  test("computes nearest-rank percentiles and status totals", () => {
    const samples = [1, 2, 3, 4].map((durationMs, index) => ({
      durationMs, status: index === 3 ? 503 : 200, responseBytes: 10,
      failureClass: index === 2 ? "DATA_UNAVAILABLE" : index === 3 ? "SERVICE_FAILURE" : "SUCCESS",
    }));
    expect(summarize(samples)).toMatchObject({
      requests: 4, succeeded: 2, failed: 2, responseBytes: 40,
      latencyMs: { min: 1, p50: 2, p95: 4, p99: 4, max: 4 }, statuses: { 200: 3, 503: 1 },
      failureClasses: { DATA_UNAVAILABLE: 1, SERVICE_FAILURE: 1, SUCCESS: 2 },
    });
  });

  test("classifies transport, auth, admission, service, request, and data-availability failures", () => {
    expect(classifyResponse(0, Buffer.from(""))).toBe("TRANSPORT_FAILURE");
    expect(classifyResponse(401, Buffer.from("{}"))).toBe("AUTH_FAILURE");
    expect(classifyResponse(429, Buffer.from("{}"))).toBe("ADMISSION_REJECTED");
    expect(classifyResponse(503, Buffer.from("{}"))).toBe("SERVICE_FAILURE");
    expect(classifyResponse(400, Buffer.from("{}"))).toBe("REQUEST_FAILURE");
    expect(classifyResponse(200, Buffer.from('{"available":false}'))).toBe("DATA_UNAVAILABLE");
    expect(classifyResponse(200, Buffer.from('{"available":true}'))).toBe("SUCCESS");
  });

  test("records only bounded structural response diagnostics", () => {
    expect(summarizeResponseBody(Buffer.from(JSON.stringify({
      rows: [{ secret: "not copied" }], available: false, error: "READER_UNAVAILABLE", detail: "bounded detail",
    })))).toEqual({ rows: 1, available: false, error: "READER_UNAVAILABLE", detail: "bounded detail" });
    expect(summarizeResponseBody(Buffer.from(JSON.stringify({
      frames: [{ payload: "not copied" }], complete: false,
      stats: { snapshotsUsed: 2, eventsRead: 50, timestampGroupsExamined: 9, encodedBytes: 123, secret: 99, bad: "value" }, nextCursor: "not copied",
    })))).toEqual({ frames: 1, complete: false, stats: {
      snapshotsUsed: 2, eventsRead: 50, timestampGroupsExamined: 9, encodedBytes: 123,
    } });
    expect(summarizeResponseBody(Buffer.from("not-json"))).toBeNull();
  });

  test("starts users concurrently, preserves per-user order, and never exposes the token in the report", async () => {
    let clock = 0;
    const calls = [];
    const fetchImpl = jest.fn(async (url, init) => {
      calls.push({ url, correlation: init.headers["x-terminal-correlation-id"] });
      clock += 1;
      return new Response("{}", { status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] } });
    });
    const report = await runManifest({
      manifest: {
        version: 1, name: "two users", users: 2, rounds: 1,
        requests: [{ route: "recording-age", body: { symbol: "BTCUSDT", marketKind: "SPOT", options: { nowMs: 1 } } }],
      },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "top-secret", fetchImpl, now: () => clock,
    });
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.correlation)).size).toBe(2);
    expect(JSON.stringify(report)).not.toContain("top-secret");
    expect(report.summary).toMatchObject({ requests: 2, succeeded: 2, failed: 0 });
    expect(report.samples[0]).toMatchObject({
      correlationId: calls[0].correlation,
      failureClass: "SUCCESS", bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/), responseSummary: {},
    });
  });

  // Property: a sample separates what crossed the wire from what the body
  // inflated to, so a gzip-on vs gzip-off comparison stays honest — the
  // body digest and responseBytes are the semantic identity, wireBytes is
  // the cost. Oracle: a response whose content-length is a tenth of its body.
  test("records the declared wire length and encoding beside the inflated body length", async () => {
    const body = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => [i, "80373.44000000", "0.20770000"]), available: true });
    const fetchImpl = async (_url, init) => new Response(body, {
      status: 200,
      headers: {
        "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"],
        "content-length": String(Math.floor(body.length / 10)),
        "content-encoding": "gzip",
      },
    });
    const report = await runManifest({
      manifest: { version: 1, users: 1, rounds: 1, requests: [{ route: "large-trades", body: {} }] },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret", fetchImpl,
    });
    expect(report.samples[0]).toMatchObject({ responseBytes: body.length, wireBytes: Math.floor(body.length / 10), contentEncoding: "gzip" });
    expect(report.summary).toMatchObject({ responseBytes: body.length, wireBytes: Math.floor(body.length / 10) });

    const identity = await runManifest({
      manifest: { version: 1, users: 1, rounds: 1, requests: [{ route: "recording-age", body: {} }] },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret",
      fetchImpl: async (_url, init) => new Response("{}", { status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] } }),
    });
    expect(identity.samples[0]).toMatchObject({ responseBytes: 2, wireBytes: 2 });
    expect(identity.samples[0]).not.toHaveProperty("contentEncoding");
  });

  test("emits every completed sample for crash-resilient progress capture", async () => {
    const onSample = jest.fn();
    await runManifest({
      manifest: { version: 1, users: 1, rounds: 2, requests: [{ route: "recording-age", body: {} }] },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret", onSample,
      fetchImpl: async (_url, init) => new Response("{}", { status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] } }),
    });
    expect(onSample).toHaveBeenCalledTimes(2);
    expect(onSample.mock.calls[0][0]).toMatchObject({ route: "recording-age", failureClass: "SUCCESS" });
  });

  test("follows nextCursor across pages, threads the cursor into options.cursor per the real replay-page contract, and stops on a null cursor", async () => {
    const cursorsByPage = ["cursor-1", "cursor-2", null];
    const fetchImpl = jest.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      const page = body.options.cursor == null ? 0 : cursorsByPage.indexOf(body.options.cursor) + 1;
      return new Response(JSON.stringify({ available: true, nextCursor: cursorsByPage[page] }), {
        status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] },
      });
    });
    const report = await runManifest({
      manifest: {
        version: 1, users: 1, rounds: 1,
        requests: [{
          route: "replay-page",
          body: { symbol: "BTCUSDT", options: { fromTs: 0, toTs: 1000, tickSize: 1, cursor: null } },
          paginate: { maxPages: 10 },
        }],
      },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret", fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[0].options.cursor).toBeNull();
    expect(bodies[1].options.cursor).toBe("cursor-1");
    expect(bodies[2].options.cursor).toBe("cursor-2");
    expect(bodies[1].symbol).toBe("BTCUSDT");
    expect(bodies[1].options.fromTs).toBe(0);
    expect(report.samples.map((sample) => sample.page)).toEqual([0, 1, 2]);
    expect(new Set(report.samples.map((sample) => sample.correlationId)).size).toBe(3);
    expect(report.byRoutePage["replay-page"]).toMatchObject({ 0: { requests: 1 }, 1: { requests: 1 }, 2: { requests: 1 } });
    expect(report.pagination).toMatchObject({
      workloads: 1, completed: 1, incomplete: 0, reasons: {},
      outcomes: [{ user: 0, round: 0, requestIndex: 0, route: "replay-page", complete: true, reason: null, pages: 3 }],
    });
  });

  test("stops following pagination as soon as a page fails, rather than continuing with a stale cursor", async () => {
    let call = 0;
    const fetchImpl = jest.fn(async (url, init) => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ available: true, nextCursor: "cursor-1" }), {
          status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] },
        });
      }
      return new Response("service unavailable", {
        status: 503, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] },
      });
    });
    const report = await runManifest({
      manifest: {
        version: 1, users: 1, rounds: 1,
        requests: [{ route: "replay-page", body: {}, paginate: { maxPages: 10 } }],
      },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret", fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(report.summary).toMatchObject({ succeeded: 1, failed: 1 });
    expect(report.pagination).toMatchObject({ completed: 0, incomplete: 1, reasons: { SERVICE_FAILURE: 1 } });
  });

  test("caps pagination at maxPages even when the server keeps returning a cursor", async () => {
    const fetchImpl = jest.fn(async (url, init) => new Response(JSON.stringify({ available: true, nextCursor: "always-more" }), {
      status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] },
    }));
    const report = await runManifest({
      manifest: {
        version: 1, users: 1, rounds: 1,
        requests: [{ route: "replay-page", body: {}, paginate: { maxPages: 4 } }],
      },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret", fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(report.pagination).toMatchObject({
      workloads: 1, completed: 0, incomplete: 1, reasons: { MAX_PAGES: 1 },
      outcomes: [{ complete: false, reason: "MAX_PAGES", pages: 4 }],
    });
  });

  test("does not call a terminal response complete when the service explicitly says it is incomplete", async () => {
    const report = await runManifest({
      manifest: {
        version: 1, users: 1, rounds: 1,
        requests: [{ route: "replay-page", body: {}, paginate: { maxPages: 4 } }],
      },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret",
      fetchImpl: async (_url, init) => new Response(JSON.stringify({ complete: false, nextCursor: null }), {
        status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] },
      }),
    });
    expect(report.pagination).toMatchObject({ completed: 0, incomplete: 1, reasons: { RESPONSE_INCOMPLETE: 1 } });
  });

  test("a manifest with no paginated requests carries no byRoutePage breakdown, unchanged from before", async () => {
    const report = await runManifest({
      manifest: {
        version: 1, users: 1, rounds: 1,
        requests: [{ route: "recording-age", body: { symbol: "BTCUSDT", marketKind: "SPOT", options: { nowMs: 1 } } }],
      },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret",
      fetchImpl: async (url, init) => new Response("{}", { status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] } }),
    });
    expect(report.byRoutePage).toBeUndefined();
    expect(report.pagination).toBeUndefined();
  });

  describe("archive-query requests", () => {
    const archiveBody = { instrumentId: '["XCME","FUTURE","NQU5","USD","CONTRACT"]', family: "trade", from: "1", to: "2", limit: 100 };
    const archiveManifest = (request = {}) => ({
      version: 1, users: 1, rounds: 1,
      requests: [{ kind: "archive-query", route: "archive-query", body: archiveBody, ...request }],
    });
    const echoing = (init, body = {}, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] },
    });

    test("validates the archive request kind, route name, and required body fields", () => {
      expect(() => validateManifest(archiveManifest({ kind: "other" }))).toThrow(/kind/);
      expect(() => validateManifest(archiveManifest({ route: "replay-page" }))).toThrow(/route "archive-query"/);
      expect(() => validateManifest(archiveManifest({ body: { ...archiveBody, family: "" } }))).toThrow(/body\.family/);
      expect(() => validateManifest(archiveManifest({ body: { ...archiveBody, from: 1 } }))).toThrow(/body\.from/);
      expect(() => validateManifest(archiveManifest())).not.toThrow();
    });

    test("posts to the gateway origin's fixed archive path with the archive token and contract version, not live-storage headers", async () => {
      const fetchImpl = jest.fn(async (_url, init) => echoing(init, { rows: [], nextCursor: null }));
      await runManifest({
        manifest: archiveManifest(), baseUrl: "http://127.0.0.1:8002/live-storage/", token: "live-token",
        archiveToken: "archive-token", fetchImpl,
      });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("http://127.0.0.1:8002/archive/query");
      expect(init.headers.authorization).toBe("Bearer archive-token");
      expect(init.headers["x-live-storage-contract-version"]).toBeUndefined();
      expect(JSON.parse(init.body)).toEqual({ contractVersion: "archive-query/1", ...archiveBody });
    });

    test("an explicit archive URL overrides the origin derived from the live-storage URL", async () => {
      const fetchImpl = jest.fn(async (_url, init) => echoing(init, { rows: [] }));
      await runManifest({
        manifest: archiveManifest(), baseUrl: "http://127.0.0.1:8002/live-storage", archiveUrl: "http://127.0.0.1:9100/",
        archiveToken: "archive-token", fetchImpl,
      });
      expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:9100/archive/query");
    });

    test("requires the archive token for archive requests but not the live-storage token, and vice versa", async () => {
      const fetchImpl = jest.fn(async (_url, init) => echoing(init, {}));
      await expect(runManifest({ manifest: archiveManifest(), baseUrl: "http://127.0.0.1:8002/live-storage", token: "live", fetchImpl }))
        .rejects.toThrow(/archive token is required/);
      await expect(runManifest({ manifest: archiveManifest(), baseUrl: "http://127.0.0.1:8002/live-storage", archiveToken: "a", fetchImpl }))
        .resolves.toBeDefined();
      await expect(runManifest({
        manifest: { version: 1, users: 1, rounds: 1, requests: [{ route: "recording-age", body: {} }] },
        baseUrl: "http://127.0.0.1:8002/live-storage", archiveToken: "a", fetchImpl,
      })).rejects.toThrow(/token is required/);
    });

    test("pagination puts the cursor and the pinned pointerToken at the top level of the body, and stops on a null cursor", async () => {
      const pages = [
        { rows: [1], nextCursor: "cursor-1", pointerToken: "pointer-1" },
        { rows: [2], nextCursor: "cursor-2", pointerToken: "pointer-1" },
        { rows: [3], nextCursor: null, pointerToken: "pointer-1" },
      ];
      let call = 0;
      const fetchImpl = jest.fn(async (_url, init) => echoing(init, pages[call++]));
      const report = await runManifest({
        manifest: archiveManifest({ paginate: { maxPages: 10 } }), baseUrl: "http://127.0.0.1:8002/live-storage",
        archiveToken: "archive-token", fetchImpl,
      });
      const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body));
      expect(bodies).toHaveLength(3);
      expect(bodies[0].cursor).toBeUndefined();
      expect(bodies[0].pointerToken).toBeUndefined();
      expect(bodies[1]).toMatchObject({ cursor: "cursor-1", pointerToken: "pointer-1", family: "trade" });
      expect(bodies[1].options).toBeUndefined();
      expect(bodies[2]).toMatchObject({ cursor: "cursor-2", pointerToken: "pointer-1" });
      expect(report.samples.map((sample) => sample.page)).toEqual([0, 1, 2]);
      expect(report.byRoutePage["archive-query"]).toMatchObject({ 0: { requests: 1 }, 2: { requests: 1 } });
    });

    test("a mixed manifest sends each request kind to its own endpoint with its own credential", async () => {
      const fetchImpl = jest.fn(async (_url, init) => echoing(init, {}));
      await runManifest({
        manifest: {
          version: 1, users: 1, rounds: 1,
          requests: [{ route: "recording-age", body: {} }, { kind: "archive-query", route: "archive-query", body: archiveBody }],
        },
        baseUrl: "http://127.0.0.1:8002/live-storage", token: "live-token", archiveToken: "archive-token", fetchImpl,
      });
      const byUrl = Object.fromEntries(fetchImpl.mock.calls.map(([url, init]) => [url, init.headers.authorization]));
      expect(byUrl).toEqual({
        "http://127.0.0.1:8002/live-storage/recording-age": "Bearer live-token",
        "http://127.0.0.1:8002/archive/query": "Bearer archive-token",
      });
    });

    test("records only the bounded scan fields of an archive response, so stage names outside the contract never leak into reports", () => {
      const summary = summarizeResponseBody(Buffer.from(JSON.stringify({
        rows: [{}, {}], nextCursor: "not copied",
        scan: {
          partitionsRead: 2, partitionsSelected: 2, partsOpened: 2, exactScanBytes: 1000, bytesRead: 900,
          cacheHits: 1, cacheMisses: 1, fetchMs: 12.5, queryMs: 3.25,
          stageMs: { downloadMs: 9 }, bytesRead2: 5, cacheHitsString: "3", negative: -1,
        },
      })));
      expect(summary).toEqual({
        rows: 2,
        scan: {
          partitionsRead: 2, partitionsSelected: 2, partsOpened: 2, exactScanBytes: 1000, bytesRead: 900,
          cacheHits: 1, cacheMisses: 1, fetchMs: 12.5, queryMs: 3.25,
        },
      });
      expect(summarizeResponseBody(Buffer.from(JSON.stringify({ rows: [], scan: { fetchMs: -1, cacheHits: 1.5, queryMs: "x" } }))))
        .toEqual({ rows: 0 });
    });
  });

  test("treats a missing or changed response correlation ID as a failed request", async () => {
    const report = await runManifest({
      manifest: {
        version: 1, users: 1, rounds: 1,
        requests: [{ route: "recording-age", body: { symbol: "BTCUSDT", marketKind: "SPOT", options: { nowMs: 1 } } }],
      },
      baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    expect(report.summary).toMatchObject({ succeeded: 0, failed: 1, failureClasses: { CORRELATION_MISMATCH: 1 } });
  });

  describe("report source identity", () => {
    const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const manifestBytes = Buffer.from('{"version":1}\n');
    let scriptPath;
    beforeAll(() => {
      scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "provenance-")), "tool.js");
      fs.writeFileSync(scriptPath, "tool bytes");
    });
    afterAll(() => fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true }));
    const gitStub = (answers) => (args) => {
      const key = args.join(" ");
      return Object.hasOwn(answers, key) ? Buffer.from(answers[key]) : null;
    };

    test("pins the exact manifest and tool bytes, the interpreter and a clean commit", () => {
      const provenance = collectToolProvenance({
        manifestBytes, scriptPath, nodeVersion: "v24.0.0",
        runGit: gitStub({ "rev-parse HEAD": `${"a".repeat(40)}\n`, "status --porcelain=v1 --untracked-files=all": "" }),
      });
      expect(provenance).toEqual({
        git: { commit: "a".repeat(40), dirty: false, trackedChanges: 0, untrackedFiles: 0, trackedDiffSha256: null },
        scriptSha256: sha256("tool bytes"), manifestSha256: sha256(manifestBytes), nodeVersion: "v24.0.0",
      });
    });

    test("a dirty tree records how many files differ and a digest of the exact tracked diff", () => {
      const provenance = collectToolProvenance({
        manifestBytes, scriptPath,
        runGit: gitStub({
          "rev-parse HEAD": `${"b".repeat(40)}\n`,
          "status --porcelain=v1 --untracked-files=all": " M apps/a.js\nM  apps/b.js\n?? new.json\n",
          "diff HEAD --binary": "diff bytes",
        }),
      });
      expect(provenance.git).toEqual({
        commit: "b".repeat(40), dirty: true, trackedChanges: 2, untrackedFiles: 1, trackedDiffSha256: sha256("diff bytes"),
      });
    });

    test("untracked files alone mark the tree dirty without inventing a tracked diff", () => {
      const provenance = collectToolProvenance({
        manifestBytes, scriptPath,
        runGit: gitStub({ "rev-parse HEAD": `${"c".repeat(40)}\n`, "status --porcelain=v1 --untracked-files=all": "?? scratch.json\n" }),
      });
      expect(provenance.git).toMatchObject({ dirty: true, trackedChanges: 0, untrackedFiles: 1, trackedDiffSha256: null });
    });

    test("records no git identity when git cannot answer instead of claiming a commit", () => {
      expect(collectToolProvenance({ manifestBytes, scriptPath, runGit: () => null }).git).toBeNull();
    });

    test("the report carries the provenance with contract versions and origins only for the kinds it exercised", async () => {
      const provenance = { git: null, scriptSha256: "s", manifestSha256: "m", nodeVersion: "v24.0.0" };
      const echoing = async (_url, init) => new Response("{}", { status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] } });
      const liveOnly = await runManifest({
        manifest: { version: 1, users: 1, rounds: 1, requests: [{ route: "recording-age", body: {} }] },
        baseUrl: "http://127.0.0.1:8002/live-storage/", token: "live-secret", fetchImpl: echoing, provenance,
      });
      expect(liveOnly.source).toEqual({
        ...provenance,
        contractVersions: { liveStorage: "live-storage/1", archive: null },
        endpoints: { liveStorageOrigin: "http://127.0.0.1:8002", archiveOrigin: null, healthOrigin: null },
      });
      const archiveOnly = await runManifest({
        manifest: {
          version: 1, users: 1, rounds: 1,
          requests: [{ kind: "archive-query", route: "archive-query", body: { instrumentId: "i", family: "trade", from: "1", to: "2" } }],
        },
        baseUrl: "http://127.0.0.1:8002/live-storage/", archiveUrl: "https://archive.example.test:9443/anything", archiveToken: "archive-secret",
        fetchImpl: echoing, provenance,
      });
      expect(archiveOnly.source.contractVersions).toEqual({ liveStorage: null, archive: "archive-query/1" });
      expect(archiveOnly.source.endpoints).toEqual({ liveStorageOrigin: null, archiveOrigin: "https://archive.example.test:9443", healthOrigin: null });
      const serialized = JSON.stringify([liveOnly, archiveOnly]);
      expect(serialized).not.toContain("live-secret");
      expect(serialized).not.toContain("archive-secret");
      expect(serialized).not.toContain("/live-storage");
    });

    test("a report run without provenance has no source block, unchanged from before", async () => {
      const report = await runManifest({
        manifest: { version: 1, users: 1, rounds: 1, requests: [{ route: "recording-age", body: {} }] },
        baseUrl: "http://127.0.0.1:8002/live-storage/", token: "secret",
        fetchImpl: async (_url, init) => new Response("{}", { status: 200, headers: { "x-terminal-correlation-id": init.headers["x-terminal-correlation-id"] } }),
      });
      expect(report.source).toBeUndefined();
    });
  });
});
