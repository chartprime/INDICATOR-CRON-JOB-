"use strict";

const http = require("node:http");
const zlib = require("node:zlib");
const { createHeatmapRoute, validateHeatmapRequest, HEATMAP_COLUMNS_PATH, HEATMAP_WALLS_PATH } = require("../../src/server/heatmap-route");

const ORIGIN = "http://127.0.0.1:8000";
const W0 = 1_700_000_100_000 - (1_700_000_100_000 % 300_000);
const PAGE = Object.freeze({ available: true, geometry: { rowWidth: 4 }, levelMs: 30_000, rowFactor: 1, span: { oldest: W0, newest: W0 }, windows: [{ ts: W0, state: "COVERED", columns: [] }], next: null });

function body(extra = {}) {
  return { provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", levelMs: 30_000, fromTs: W0, toTs: W0 + 3_600_000, ...extra };
}

async function serve(routeOptions) {
  const route = createHeatmapRoute({ allowedOrigins: new Set([ORIGIN]), log: () => {}, ...routeOptions });
  const server = http.createServer((request, response) => {
    if (route.handle(request, response)) return;
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { route, server, base: `http://127.0.0.1:${server.address().port}` };
}

function post(base, payload, { origin = ORIGIN, method = "POST", gzip = false, path = HEATMAP_COLUMNS_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(origin === null ? {} : { origin }), ...(gzip ? { "accept-encoding": "gzip" } : {}) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks);
        const text = response.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, body: text === "" ? null : JSON.parse(text) });
      });
    });
    request.on("error", reject);
    if (method === "POST") request.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    else request.end();
  });
}

describe("server/heatmap-route request validation (P4c.4)", () => {
  test("takes the chart's wire identity, stores the Binance symbol without the dash, and refuses anything off the catalog or the pyramid", () => {
    expect(validateHeatmapRequest(body())).toEqual({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTCUSDT", options: { levelMs: 30_000, fromTs: W0, toTs: W0 + 3_600_000 } });
    expect(validateHeatmapRequest(body({ rowFactor: 4 })).options.rowFactor).toBe(4);
    expect(validateHeatmapRequest(body({ provider: "DXFEED", marketKind: "FUTURE", symbol: "/NQZ26:XCME" })).symbol).toBe("/NQZ26:XCME");
    expect(validateHeatmapRequest(body({ extra: 1 })).error).toBe("UNKNOWN_REQUEST_FIELDS:extra");
    expect(validateHeatmapRequest(body({ provider: "TARDIS" })).error).toBe("PROVIDER_NOT_RECOGNIZED");
    expect(validateHeatmapRequest(body({ symbol: "DOGE-USDT" })).error).toBe("INSTRUMENT_NOT_ALLOWED");
    expect(validateHeatmapRequest(body({ provider: "DXFEED", marketKind: "FUTURE", symbol: "/ZZZ:XCME" })).error).toBe("INSTRUMENT_NOT_ALLOWED");
    expect(validateHeatmapRequest(body({ levelMs: 1_000 })).error).toBe("LEVEL_NOT_A_PYRAMID_LEVEL");
    expect(validateHeatmapRequest(body({ rowFactor: 3 })).error).toBe("ROW_FACTOR_OUT_OF_RANGE");
    expect(validateHeatmapRequest(body({ toTs: W0 + 9 * 86_400_000 })).error).toBe("TIME_RANGE_OUT_OF_RANGE:fromTs/toTs");
  });
});

describe("server/heatmap-route over HTTP (P4c.4)", () => {
  let current = null;

  afterEach(async () => {
    if (current) {
      current.route.dispose();
      await new Promise((resolve) => current.server.close(resolve));
      current = null;
    }
  });

  test("serves a page from the reader for an allowed origin, gzipped when asked, and refuses other origins and methods", async () => {
    const page = { ...PAGE, pad: "x".repeat(2_000) };
    const read = jest.fn(async () => page);
    current = await serve({ read });
    const served = await post(current.base, body(), { gzip: true });
    expect(served.status).toBe(200);
    expect(served.headers["content-encoding"]).toBe("gzip");
    expect(served.body).toEqual(page);
    expect(read).toHaveBeenCalledWith("BINANCE", "BTCUSDT", "PERPETUAL", { levelMs: 30_000, fromTs: W0, toTs: W0 + 3_600_000 }, expect.any(AbortSignal));
    expect((await post(current.base, body(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(current.base, body(), { origin: null })).status).toBe(403);
    expect((await post(current.base, null, { method: "GET" })).status).toBe(405);
    const refused = await post(current.base, body({ levelMs: 5 }));
    expect([refused.status, refused.body.detail]).toEqual([400, "LEVEL_NOT_A_PYRAMID_LEVEL"]);
    expect((await post(current.base, "{not json")).body.detail).toBe("BODY_NOT_JSON");
  });

  test("caches real pages for the TTL and bounded in bytes, but never an unavailable answer", async () => {
    let at = 1_000;
    const read = jest.fn(async (provider, symbol, kind, options) => (options.levelMs === 60_000 ? { available: false, reason: "STORAGE_UNAVAILABLE", windows: [], next: null } : { ...PAGE, levelMs: options.levelMs, pad: "x".repeat(400) }));
    const onePage = Buffer.byteLength(JSON.stringify({ ...PAGE, levelMs: 30_000, pad: "x".repeat(400) }));
    current = await serve({ read, now: () => at, cacheTtlMs: 60_000, cacheMaxBytes: onePage * 2 + 10 });
    await post(current.base, body());
    await post(current.base, body());
    expect(read).toHaveBeenCalledTimes(1);
    at += 60_000;
    await post(current.base, body());
    expect(read).toHaveBeenCalledTimes(2);
    await post(current.base, body({ levelMs: 60_000 }));
    await post(current.base, body({ levelMs: 60_000 }));
    expect(read).toHaveBeenCalledTimes(4);
    await post(current.base, body({ levelMs: 10_000 }));
    await post(current.base, body({ levelMs: 300_000 }));
    expect(current.route.stats().cacheEntries).toBe(2);
    expect(current.route.stats().cacheBytes).toBeLessThanOrEqual(onePage * 2 + 10);
    await post(current.base, body());
    expect(read).toHaveBeenCalledTimes(7);
  });

  test("a request without a row factor and one asking for row factor 1 are the same page to the cache, and another row factor is not (PR #40 review)", async () => {
    const read = jest.fn(async () => PAGE);
    current = await serve({ read });
    await post(current.base, body());
    await post(current.base, body({ rowFactor: 1 }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(current.route.stats()).toMatchObject({ cached: 1, cacheEntries: 1 });
    await post(current.base, body({ rowFactor: 4 }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith("BINANCE", "BTCUSDT", "PERPETUAL", expect.objectContaining({ rowFactor: 4 }), expect.any(AbortSignal));
  });

  test("answers busy past the concurrent reads, spends a per-origin budget, and turns a reader failure into 503", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const read = jest.fn(async (provider, symbol, kind, options) => {
      if (options.levelMs === 10_000) throw new Error("disk gone");
      await gate;
      return PAGE;
    });
    current = await serve({ read, maxConcurrent: 1, rateLimit: { max: 3, windowMs: 60_000 } });
    const slow = post(current.base, body());
    await new Promise((resolve) => setTimeout(resolve, 30));
    let busy;
    try {
      busy = await Promise.race([post(current.base, body({ levelMs: 300_000 })), new Promise((resolve) => setTimeout(() => resolve({ status: "no answer", body: {} }), 1_500))]);
    } finally {
      release();
    }
    expect([busy.status, busy.body.error]).toEqual([429, "BUSY"]);
    expect((await slow).status).toBe(200);
    const failed = await post(current.base, body({ levelMs: 10_000 }));
    expect([failed.status, failed.body.error]).toEqual([503, "HEATMAP_UNAVAILABLE"]);
    const budget = await post(current.base, body());
    expect([budget.status, budget.body.error]).toEqual([429, "RATE_BUDGET_EXCEEDED"]);
    expect(budget.body.retryAfterMs).toBeGreaterThan(0);
  });

  // The 2026-09-30 hand test: two viewers opened the default chart together
  // and fetched 97 identical pages within the same second as each other, one
  // host read each, and the second read counted against the concurrency cap.
  test("gives identical requests that arrive while a read runs that one read, without spending the concurrency cap", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const read = jest.fn(async () => {
      await gate;
      return PAGE;
    });
    current = await serve({ read, maxConcurrent: 1 });
    const first = post(current.base, body());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = post(current.base, body());
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const answers = await Promise.all([first, second]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(answers[1].body).toEqual(PAGE);
    expect(read).toHaveBeenCalledTimes(1);
    expect(current.route.stats()).toMatchObject({ shared: 1, busy: 0, served: 2, inFlight: 0 });
  });

  test("keeps a shared read going while any viewer still waits for it, and abandons it once every viewer has gone", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const signals = [];
    const read = jest.fn(async (provider, symbol, kind, options, signal) => {
      signals.push(signal);
      await gate;
      return PAGE;
    });
    current = await serve({ read });
    const abandon = () => {
      const request = http.request(`${current.base}${HEATMAP_COLUMNS_PATH}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN } });
      request.on("error", () => {});
      request.end(JSON.stringify(body()));
      return request;
    };
    const leaver = abandon();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stayer = post(current.base, body());
    await new Promise((resolve) => setTimeout(resolve, 30));
    leaver.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signals[0].aborted).toBe(false);
    release();
    expect((await stayer).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);

    let releaseSecond;
    const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
    read.mockImplementationOnce(async (provider, symbol, kind, options, signal) => {
      signals.push(signal);
      await secondGate;
      return PAGE;
    });
    const lone = http.request(`${current.base}${HEATMAP_COLUMNS_PATH}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN } });
    lone.on("error", () => {});
    lone.end(JSON.stringify(body({ levelMs: 300_000 })));
    await new Promise((resolve) => setTimeout(resolve, 30));
    lone.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signals[1].aborted).toBe(true);
    releaseSecond();
  });

  // Waits on the route's own state, not a fixed delay: on a loaded machine a request can take longer than
  // any fixed pause to reach the route, and one arriving after dispose() is rightly told the server is stopping.
  async function until(condition) {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("condition not reached");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("answers a viewer still waiting when the shared read is abandoned under it, instead of leaving the request hanging", async () => {
    const read = jest.fn(() => new Promise(() => {}));
    current = await serve({ read });
    const waiting = post(current.base, body());
    await until(() => read.mock.calls.length === 1);
    current.route.dispose();
    const answer = await waiting;
    expect([answer.status, answer.body.error]).toEqual([503, "HEATMAP_UNAVAILABLE"]);
  });

  test("tells every viewer of a failed shared read that the history is unavailable, and logs the failure once", async () => {
    let fail;
    const gate = new Promise((resolve, reject) => { fail = reject; });
    const log = jest.fn();
    const read = jest.fn(() => gate);
    current = await serve({ read, log });
    const first = post(current.base, body());
    await until(() => read.mock.calls.length === 1);
    const second = post(current.base, body());
    await until(() => current.route.stats().shared === 1);
    fail(new Error("disk gone"));
    const answers = await Promise.all([first, second]);
    expect(answers.map((answer) => [answer.status, answer.body.error])).toEqual([[503, "HEATMAP_UNAVAILABLE"], [503, "HEATMAP_UNAVAILABLE"]]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(current.route.stats()).toMatchObject({ failed: 2, inFlight: 0 });
  });
});

describe("heatmap-route: the walls path (host wall history read through)", () => {
  const WALLS_PAGE = Object.freeze({ available: true, generation: "g", geometry: { rowWidth: 4 }, span: { oldest: W0, newest: W0 }, walls: [{ id: 7, side: "bid", row: 100, span: 1, startTs: W0, endTs: W0 + 60_000, size: 0, peak: 50, endedBy: "hit", ratio: 2, chain: 0, fill: 0.5, eaten: 0.2, absorbing: false }], next: null });
  const wallsBody = (extra = {}) => ({ provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", fromTs: W0, toTs: W0 + 3_600_000, ...extra });

  test("validates its own fields, hands the storage symbol and the wall options to the reader, caches a page, and ignores the columns path", async () => {
    const reads = [];
    const { route, server, base } = await serve({ path: HEATMAP_WALLS_PATH, routeName: "wall-history", read: async (provider, symbol, kind, options) => { reads.push([provider, symbol, kind, options]); return WALLS_PAGE; } });
    try {
      const served = await post(base, wallsBody({ limit: 5, after: { endTs: W0 + 30_000, id: 3 } }), { path: HEATMAP_WALLS_PATH });
      expect(served.status).toBe(200);
      expect(served.body).toEqual(WALLS_PAGE);
      expect(reads).toEqual([["BINANCE", "BTCUSDT", "PERPETUAL", { fromTs: W0, toTs: W0 + 3_600_000, limit: 5, after: { endTs: W0 + 30_000, id: 3 } }]]);
      const again = await post(base, wallsBody({ limit: 5, after: { endTs: W0 + 30_000, id: 3 } }), { path: HEATMAP_WALLS_PATH });
      expect(again.status).toBe(200);
      expect(reads).toHaveLength(1);
      expect((await post(base, wallsBody({ limit: 5, after: { endTs: W0 + 60_000, id: 9 } }), { path: HEATMAP_WALLS_PATH })).status).toBe(200);
      expect(reads).toHaveLength(2);
      expect(reads[1][3]).toEqual({ fromTs: W0, toTs: W0 + 3_600_000, limit: 5, after: { endTs: W0 + 60_000, id: 9 } });
      expect((await post(base, wallsBody({ levelMs: 30_000 }), { path: HEATMAP_WALLS_PATH })).body).toMatchObject({ error: "MALFORMED_REQUEST", detail: "UNKNOWN_REQUEST_FIELDS:levelMs" });
      expect((await post(base, wallsBody({ limit: 0 }), { path: HEATMAP_WALLS_PATH })).status).toBe(400);
      expect((await post(base, wallsBody({ after: { endTs: W0 } }), { path: HEATMAP_WALLS_PATH })).status).toBe(400);
      expect((await post(base, wallsBody(), { path: HEATMAP_WALLS_PATH, origin: "https://elsewhere.example" })).status).toBe(403);
      expect((await post(base, body(), { path: HEATMAP_COLUMNS_PATH })).status).toBe(404);
      expect(route.stats()).toMatchObject({ served: 2, cached: 1 });
    } finally {
      route.dispose();
      server.close();
    }
  });

  test("hands the size filter to the reader with the outcomes sorted, keys the cache on it, and refuses what the reader could not answer", async () => {
    const reads = [];
    const { route, server, base } = await serve({ path: HEATMAP_WALLS_PATH, routeName: "wall-history", read: async (provider, symbol, kind, options) => { reads.push(options); return WALLS_PAGE; } });
    try {
      const filter = { minUsd: 5_000_000, alwaysOutcomes: ["partial", "filled"] };
      expect((await post(base, wallsBody(filter), { path: HEATMAP_WALLS_PATH })).status).toBe(200);
      expect(reads).toEqual([{ fromTs: W0, toTs: W0 + 3_600_000, minUsd: 5_000_000, alwaysOutcomes: ["filled", "partial"] }]);
      expect((await post(base, wallsBody({ ...filter, alwaysOutcomes: ["filled", "partial"] }), { path: HEATMAP_WALLS_PATH })).status).toBe(200);
      expect(reads).toHaveLength(1);
      expect((await post(base, wallsBody({ ...filter, minUsd: 6_000_000 }), { path: HEATMAP_WALLS_PATH })).status).toBe(200);
      expect((await post(base, wallsBody(), { path: HEATMAP_WALLS_PATH })).status).toBe(200);
      expect((await post(base, wallsBody({ minUsd: 5_000_000 }), { path: HEATMAP_WALLS_PATH })).status).toBe(200);
      expect(reads).toHaveLength(4);
      expect(reads[2]).toEqual({ fromTs: W0, toTs: W0 + 3_600_000 });
      expect(reads[3]).toEqual({ fromTs: W0, toTs: W0 + 3_600_000, minUsd: 5_000_000 });
      const refused = await Promise.all([
        post(base, wallsBody({ minUsd: -1 }), { path: HEATMAP_WALLS_PATH }),
        post(base, wallsBody({ minUsd: "big" }), { path: HEATMAP_WALLS_PATH }),
        post(base, wallsBody({ alwaysOutcomes: ["filled"] }), { path: HEATMAP_WALLS_PATH }),
        post(base, wallsBody({ minUsd: 1, alwaysOutcomes: ["lost"] }), { path: HEATMAP_WALLS_PATH }),
        post(base, wallsBody({ minUsd: 1, alwaysOutcomes: ["hit", "hit"] }), { path: HEATMAP_WALLS_PATH }),
        post(base, wallsBody({ minUsd: 1, alwaysOutcomes: "hit" }), { path: HEATMAP_WALLS_PATH }),
      ]);
      expect(refused.map((answer) => [answer.status, answer.body.detail])).toEqual([
        [400, "MIN_USD_OUT_OF_RANGE"],
        [400, "MIN_USD_OUT_OF_RANGE"],
        [400, "ALWAYS_OUTCOMES_NEEDS_MIN_USD"],
        [400, "ALWAYS_OUTCOMES_INVALID"],
        [400, "ALWAYS_OUTCOMES_INVALID"],
        [400, "ALWAYS_OUTCOMES_INVALID"],
      ]);
      const dxfeed = { provider: "DXFEED", marketKind: "FUTURE", symbol: "/NQZ26:XCME" };
      expect(validateHeatmapRequest({ ...wallsBody({ minUsd: 1 }), ...dxfeed }, "wall-history")).toEqual({ error: "SIZE_FILTER_NEEDS_BINANCE" });
      expect(validateHeatmapRequest({ ...wallsBody(), ...dxfeed }, "wall-history")).toMatchObject({ provider: "DXFEED", options: { fromTs: W0 } });
      expect(reads).toHaveLength(4);
    } finally {
      route.dispose();
      server.close();
    }
  });

  test("the columns route refuses the walls path and the walls fields", async () => {
    const { route, server, base } = await serve({ read: async () => PAGE });
    try {
      expect((await post(base, wallsBody(), { path: HEATMAP_WALLS_PATH })).status).toBe(404);
      expect((await post(base, body({ limit: 5 }))).body).toMatchObject({ error: "MALFORMED_REQUEST", detail: "UNKNOWN_REQUEST_FIELDS:limit" });
      expect(validateHeatmapRequest(wallsBody({ limit: 5 }), "wall-history")).toMatchObject({ provider: "BINANCE", symbol: "BTCUSDT", options: { limit: 5 } });
      expect(validateHeatmapRequest(wallsBody({ toTs: W0 + 9 * 86_400_000 }), "wall-history")).toMatchObject({ error: expect.stringMatching(/TIME_RANGE/) });
    } finally {
      route.dispose();
      server.close();
    }
  });
});
