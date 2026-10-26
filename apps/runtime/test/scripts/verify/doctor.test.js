"use strict";

const { runDoctor, formatReport, NOT_CONFIGURED, WORKING, BROKEN } = require("../../../scripts/verify/doctor");

const BEARER = "dev-sam:abcdefghijklmnopqrstuvwxyz0123456789";
const HOST_DATA = Object.freeze({
  TT_ARCHIVE_PROXY_URL: "http://10.88.0.1:8001",
  VITE_ARCHIVE_CLIENT_TOKEN: BEARER,
  TT_LIVE_STORAGE_SERVICE_URL: "http://10.88.0.1:8001/live-storage",
  TT_LIVE_STORAGE_CLIENT_TOKEN: BEARER,
});
const BROKER = "https://tt-dxfeed-token-broker.example.ts.net";

function headers(entries = {}) {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

function reply(status, body, extraHeaders = {}) {
  return { status, headers: headers(extraHeaders), json: async () => body };
}

function fakeGateway(overrides = {}) {
  const calls = [];
  const routes = {
    health: () => reply(200, { ready: true }),
    query: () => reply(200, { rows: [{ open_ns: "1" }] }),
    age: () => reply(200, { available: true, latestTs: 1, ageMs: 4_000 }, { "x-live-storage-contract-version": "live-storage/1" }),
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/health")) return routes.health(init);
    if (url.endsWith("/archive/query")) return routes.query(init);
    if (url.endsWith("/live-storage/recording-age")) return routes.age(init);
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, calls };
}

const reachable = async () => ({ ok: true });

function doctor(env, { fetchImpl = fakeGateway().fetchImpl, connect = reachable, nodeVersion = "24.21.0", resolveNode = () => null, liquidityStoreDir = null } = {}) {
  return runDoctor({ env, fetchImpl, connect, nodeVersion, resolveNode, liquidityStoreDir, required: "24.21.0", now: 1_790_000_000_000, timeoutMs: 50 });
}

describe("doctor: layers are optional", () => {
  test("a repository-only developer passes with both layers not configured", async () => {
    const { fetchImpl, calls } = fakeGateway();
    const report = await doctor({}, { fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.layers.hostData.status).toBe(NOT_CONFIGURED);
    expect(report.layers.dxfeed.status).toBe(NOT_CONFIGURED);
    expect(calls).toHaveLength(0);
  });

  test("dxFeed only passes without touching the network", async () => {
    const { fetchImpl, calls } = fakeGateway();
    const report = await doctor({ TT_DXFEED_TOKEN_BROKER_URL: BROKER }, { fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.layers.dxfeed.status).toBe(WORKING);
    expect(report.layers.hostData.status).toBe(NOT_CONFIGURED);
    expect(calls).toHaveLength(0);
  });

  test("host data only passes and never contacts the broker", async () => {
    const { fetchImpl, calls } = fakeGateway();
    const report = await doctor({ ...HOST_DATA }, { fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.layers.hostData.status).toBe(WORKING);
    expect(report.layers.dxfeed.status).toBe(NOT_CONFIGURED);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/health", "/archive/query", "/live-storage/recording-age"]);
  });

  test("both layers pass together", async () => {
    const report = await doctor({ ...HOST_DATA, TT_DXFEED_TOKEN_BROKER_URL: BROKER });
    expect(report.ok).toBe(true);
    expect(report.layers.hostData.status).toBe(WORKING);
    expect(report.layers.dxfeed.status).toBe(WORKING);
  });
});

describe("doctor: host-data configuration", () => {
  test("an incomplete set names the missing variables", async () => {
    const report = await doctor({ TT_ARCHIVE_PROXY_URL: HOST_DATA.TT_ARCHIVE_PROXY_URL, VITE_ARCHIVE_CLIENT_TOKEN: BEARER });
    expect(report.ok).toBe(false);
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "configuration" });
    expect(report.layers.hostData.detail).toContain("TT_LIVE_STORAGE_SERVICE_URL");
    expect(report.layers.hostData.detail).toContain("TT_LIVE_STORAGE_CLIENT_TOKEN");
  });

  test("the template placeholder is refused", async () => {
    const report = await doctor({ ...HOST_DATA, VITE_ARCHIVE_CLIENT_TOKEN: "<your-bearer>", TT_LIVE_STORAGE_CLIENT_TOKEN: "<your-bearer>" });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "configuration" });
    expect(report.layers.hostData.detail).toContain("placeholder");
  });

  test("two different bearers are refused", async () => {
    const report = await doctor({ ...HOST_DATA, TT_LIVE_STORAGE_CLIENT_TOKEN: `${BEARER}x` });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "configuration" });
  });

  test("a live-storage URL without the relay prefix is refused", async () => {
    const report = await doctor({ ...HOST_DATA, TT_LIVE_STORAGE_SERVICE_URL: "http://10.88.0.1:8001" });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "configuration" });
  });

  test("live ticks pointed at the host are refused even with no other layer", async () => {
    const report = await doctor({ TT_LIVE_PROXY_URL: "http://10.88.0.1:8001" });
    expect(report.ok).toBe(false);
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "configuration" });
  });

  test("live ticks pointed at this laptop are fine", async () => {
    const report = await doctor({ TT_LIVE_PROXY_URL: "http://127.0.0.1:8001" });
    expect(report.ok).toBe(true);
  });
});

describe("doctor: each failure is attributed to its layer", () => {
  test("an unreachable gateway is a WireGuard failure and stops there", async () => {
    const { fetchImpl, calls } = fakeGateway();
    const report = await doctor({ ...HOST_DATA }, { fetchImpl, connect: async () => ({ ok: false, reason: "timed out" }) });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "WireGuard" });
    expect(calls).toHaveLength(0);
  });

  test("an unready gateway is a gateway failure and carries its reasons", async () => {
    const { fetchImpl } = fakeGateway({ health: () => reply(503, { ready: false, reasons: ["ROUTE_DISABLED"] }) });
    const report = await doctor({ ...HOST_DATA }, { fetchImpl });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "gateway" });
    expect(report.layers.hostData.detail).toContain("ROUTE_DISABLED");
  });

  test("a health probe that never answers is a gateway failure", async () => {
    const { fetchImpl } = fakeGateway({ health: (init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }) });
    const report = await doctor({ ...HOST_DATA }, { fetchImpl });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "gateway" });
    expect(report.layers.hostData.detail).toContain("timed out");
  });

  test.each([401, 403])("an archive %i is a bearer failure", async (status) => {
    const { fetchImpl } = fakeGateway({ query: () => reply(status, { error: "UNAUTHORIZED" }) });
    const report = await doctor({ ...HOST_DATA }, { fetchImpl });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "bearer" });
  });

  test("an archive refusal is an archive failure with its code", async () => {
    const { fetchImpl } = fakeGateway({ query: () => reply(503, { error: "READER_UNAVAILABLE" }) });
    const report = await doctor({ ...HOST_DATA }, { fetchImpl });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "archive" });
    expect(report.layers.hostData.detail).toContain("READER_UNAVAILABLE");
  });

  test("an archive with no row for the published probe day is an archive failure", async () => {
    const { fetchImpl } = fakeGateway({ query: () => reply(200, { rows: [] }) });
    const report = await doctor({ ...HOST_DATA }, { fetchImpl });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "archive" });
  });

  test("a live-storage 401 is a bearer failure", async () => {
    const { fetchImpl } = fakeGateway({ age: () => reply(401, { error: "UNAUTHORIZED" }) });
    const report = await doctor({ ...HOST_DATA }, { fetchImpl });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "bearer" });
  });

  test("a live-storage answer without its contract header is a live-storage failure", async () => {
    const { fetchImpl } = fakeGateway({ age: () => reply(200, { available: true, latestTs: 1, ageMs: 1 }) });
    const report = await doctor({ ...HOST_DATA }, { fetchImpl });
    expect(report.layers.hostData).toMatchObject({ status: BROKEN, step: "live-storage" });
  });
});

describe("doctor: requests and output", () => {
  test("both probes present the issued bearer, and live-storage its contract version", async () => {
    const { fetchImpl, calls } = fakeGateway();
    await doctor({ ...HOST_DATA }, { fetchImpl });
    const [health, query, age] = calls;
    expect(health.init.headers?.authorization).toBeUndefined();
    expect(query.init.headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(JSON.parse(query.init.body)).toMatchObject({ contractVersion: "archive-query/1", family: "candle_1d", limit: 1 });
    expect(age.init.headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(age.init.headers["x-live-storage-contract-version"]).toBe("live-storage/1");
  });

  test("the report never prints the bearer", async () => {
    const { fetchImpl } = fakeGateway({ query: () => reply(401, {}) });
    const text = formatReport(await doctor({ ...HOST_DATA }, { fetchImpl }));
    expect(text).not.toContain(BEARER);
    expect(text).toContain("FAIL");
  });

  test("a malformed broker URL is a configuration failure", async () => {
    const report = await doctor({ TT_DXFEED_TOKEN_BROKER_URL: "https://broker.example.com/token" });
    expect(report.ok).toBe(false);
    expect(report.layers.dxfeed).toMatchObject({ status: BROKEN, step: "configuration" });
  });

  test("the wrong Node fails the run even with no layer configured", async () => {
    const report = await doctor({}, { nodeVersion: "25.2.1" });
    expect(report.ok).toBe(false);
    expect(report.node.status).toBe(BROKEN);
    expect(report.node.detail).toContain("TT_NODE_BIN");
  });

  test("a shell on another Node passes when the launcher finds the pinned one, and says which it will run", async () => {
    const report = await doctor({}, {
      nodeVersion: "25.2.1",
      resolveNode: () => ({ executable: "C:\\tmp\\node-v24.21.0-win-x64\\node.exe", source: "TT_NODE_BIN", version: "24.21.0" }),
    });
    expect(report.ok).toBe(true);
    expect(report.node).toMatchObject({ status: WORKING });
    expect(report.node.detail).toContain("this shell runs Node 25.2.1");
    expect(report.node.detail).toContain("from TT_NODE_BIN");
  });
});

describe("doctor: settings and local state (report 57 W5)", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  test("a Terminal C setting that would stop the runtime from starting fails the doctor, named, without its value", async () => {
    const report = await doctor({ L2_HEATMAP_DEEP_S: "eleven-hours" });
    expect(report.ok).toBe(false);
    expect(report.config).toMatchObject({ status: BROKEN, step: "configuration" });
    expect(report.config.detail).toContain("L2_HEATMAP_DEEP_S must be a number, at least 0");
    expect(report.config.detail).not.toContain("eleven-hours");
  });

  test("operator secrets in the shared .env are counted as ignored by Terminal C and D, and typos are flagged", async () => {
    const report = await doctor({ TT_QUERY_S3_SECRET_ACCESS_KEY: "s3", databento_key: "k", L2_HEATMAP_DEEPS: "1" });
    expect(report.config.status).toBe(WORKING);
    expect(report.config.detail).toContain("ignore 2 operator setting(s)");
    expect(report.config.detail).toContain("L2_HEATMAP_DEEPS");
    expect(formatReport(report)).not.toContain("s3");
  });

  test("the heatmap store is reported against its budget and fails only above what the runtime will read", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-store-"));
    try {
      fs.writeFileSync(path.join(dir, "SPOT-BTCUSDT.json"), Buffer.alloc(2 * 1024 * 1024));
      const within = await doctor({}, { liquidityStoreDir: dir });
      expect(within.local.liquidityStore).toMatchObject({ status: WORKING });
      expect(within.local.liquidityStore.detail).toContain("SPOT-BTCUSDT.json 2.0 MiB of the 48.0 MiB budget");
      fs.writeFileSync(path.join(dir, "PERP-ETHUSDT.json"), Buffer.alloc(65 * 1024 * 1024));
      const over = await doctor({}, { liquidityStoreDir: dir });
      expect(over.ok).toBe(false);
      expect(over.local.liquidityStore).toMatchObject({ status: BROKEN, step: "liquidity store" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports whether Terminal C and D are already running without failing either way", async () => {
    const report = await doctor({}, { connect: async (_host, port) => ({ ok: port === 8001 }) });
    expect(report.ok).toBe(true);
    expect(report.local.ports.detail).toBe("Terminal D :8000 not running, Terminal C :8001 running");
  });
});
