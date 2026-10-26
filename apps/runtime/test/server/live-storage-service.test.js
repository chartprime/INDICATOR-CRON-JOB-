"use strict";

const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  main,
  createService,
  parseServiceArgs,
  configurationProblems,
  DEFAULT_PORT,
  FATAL_EXIT_TIMEOUT_MS,
} = require("../../scripts/serve/run-live-storage-service");
const { LIVE_STORAGE_PATH_PREFIX, SERVICE_SECRET_HEADER, CLIENT_HEADER, CONTRACT_VERSION_HEADER, CONTRACT_VERSION } = require("../../src/server/live-storage-route");

const SERVICE_ENTRY = path.join(__dirname, "../../scripts/serve/run-live-storage-service.js");
const SERVICE_SECRET = "s".repeat(32);

function configuredEnv(overrides = {}) {
  return { TT_LIVE_STORAGE_SERVICE_SECRET: SERVICE_SECRET, ...overrides };
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
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, body: parsed, text };
}

function fakeStorageReader() {
  return {
    dbPath: "/tmp/fake.sqlite",
    readRecordingAge: jest.fn(() => ({ latestTs: 1, ageMs: 1, available: true })),
    close: jest.fn(() => Promise.resolve()),
  };
}

describe("the live-storage service process boundary", () => {
  test("loading it pulls in no exchange connection or dxFeed module", () => {
    const script = `require(${JSON.stringify(SERVICE_ENTRY)});`
      + `console.log(JSON.stringify(Object.keys(require.cache)));`;
    const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const loaded = JSON.parse(output.trim()).map((entry) => entry.replace(/\\/g, "/"));
    const forbidden = loaded.filter((entry) => /binance-connection|dxlink|dxfeed-connection|market-data-server|src\/server\/app\.js/.test(entry));
    expect(forbidden).toEqual([]);
    expect(loaded.some((entry) => /src\/storage\/storage-reader\.js/.test(entry))).toBe(true);
  });
});

describe("parseServiceArgs", () => {
  test("defaults to the loopback service port", () => {
    const parsed = parseServiceArgs([], {});
    expect(parsed.port).toBe(DEFAULT_PORT);
    expect(parsed.host).toBe("127.0.0.1");
  });

  test("argv beats the environment", () => {
    expect(parseServiceArgs(["9300"], { TT_LIVE_STORAGE_PORT: "9400" }).port).toBe(9300);
  });

  test("reads the heatmap pyramid from TT_HEATMAP_DIR, else from the data root (P4c.3)", () => {
    expect(parseServiceArgs([], { TT_HEATMAP_DIR: "/srv/terminal-data/heatmap" }).heatmapDir).toBe("/srv/terminal-data/heatmap");
    expect(parseServiceArgs([], {}).heatmapDir).toMatch(/[\\/]heatmap$/);
  });

  test("reads the iceberg history store from TT_ICEBERG_DIR, else from the data root", () => {
    expect(parseServiceArgs([], { TT_ICEBERG_DIR: "/srv/terminal-data/iceberg-history" }).icebergDir).toBe("/srv/terminal-data/iceberg-history");
    expect(parseServiceArgs([], {}).icebergDir).toMatch(/[\\/]iceberg-history$/);
  });

  test("rejects a non-loopback host", () => {
    expect(() => parseServiceArgs([], { TT_LIVE_STORAGE_HOST: "0.0.0.0" })).toThrow(/loopback/);
  });

  test("rejects an invalid port", () => {
    expect(() => parseServiceArgs(["not-a-port"], {})).toThrow(/invalid port/);
  });
});

describe("configurationProblems", () => {
  test("a configured secret has no problems", () => {
    expect(configurationProblems(configuredEnv())).toEqual([]);
  });

  test("a missing secret is reported", () => {
    expect(configurationProblems({})).toEqual(["SERVICE_SECRET_NOT_CONFIGURED"]);
  });
});

describe("health and routing", () => {
  let service;
  afterEach(async () => {
    if (service) { await service.stop(); service = null; }
  });

  test("a configured service reports ready", async () => {
    service = createService({ env: configuredEnv(), log: () => {}, storageReader: fakeStorageReader() });
    await service.start();
    const { status, body } = await request(service.server.address().port);
    expect(status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.runtime).toMatchObject({
      processRssBytes: expect.any(Number),
      processCpuUserMicros: expect.any(Number),
      eventLoopSamples: expect.any(Number),
    });
    expect(body.storage).toEqual({
      binance: { database: expect.any(Number), wal: expect.any(Number), shm: expect.any(Number) },
      dxfeed: { database: expect.any(Number), wal: expect.any(Number), shm: expect.any(Number) },
    });
  });

  test("an unconfigured service reports not ready with a reason", async () => {
    service = createService({ env: {}, log: () => {}, storageReader: fakeStorageReader() });
    await service.start();
    const { status, body } = await request(service.server.address().port);
    expect(status).toBe(503);
    expect(body.reasons).toContain("SERVICE_SECRET_NOT_CONFIGURED");
  });

  test("a real request under /live-storage/<route> reaches the storage reader", async () => {
    const reader = fakeStorageReader();
    service = createService({ env: configuredEnv(), log: () => {}, storageReader: reader });
    await service.start();
    const { status, body } = await request(service.server.address().port, {
      method: "POST",
      pathname: `${LIVE_STORAGE_PATH_PREFIX}recording-age`,
      headers: { "content-type": "application/json", [SERVICE_SECRET_HEADER]: SERVICE_SECRET, [CLIENT_HEADER]: "laptop-1", [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION },
      body: { symbol: "BTCUSDT", marketKind: "SPOT", options: { nowMs: 1 } },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ latestTs: 1, ageMs: 1, available: true });
    expect(reader.readRecordingAge).toHaveBeenCalledWith("BTCUSDT", "SPOT", { nowMs: 1 });
  });

  test("an unknown path is a 404", async () => {
    service = createService({ env: configuredEnv(), log: () => {}, storageReader: fakeStorageReader() });
    await service.start();
    const { status } = await request(service.server.address().port, { pathname: "/nope" });
    expect(status).toBe(404);
  });

  test("stop closes the storage reader", async () => {
    const reader = fakeStorageReader();
    service = createService({ env: configuredEnv(), log: () => {}, storageReader: reader });
    await service.start();
    await service.stop();
    expect(reader.close).toHaveBeenCalledTimes(1);
    service = null;
  });

  test("stop closes the iceberg history reader", async () => {
    const icebergReader = { readAsync: jest.fn(), stats: jest.fn(() => ({ open: 1 })), close: jest.fn() };
    service = createService({ env: configuredEnv(), log: () => {}, storageReader: fakeStorageReader(), icebergReader });
    await service.start();
    await service.stop();
    expect(icebergReader.close).toHaveBeenCalledTimes(1);
    service = null;
  });

  test("an iceberg history reader that fails to close is logged and the stop still finishes", async () => {
    const icebergReader = { readAsync: jest.fn(), stats: jest.fn(() => ({ open: 1 })), close: jest.fn(() => { throw new Error("database is locked"); }) };
    const log = jest.fn();
    const reader = fakeStorageReader();
    service = createService({ env: configuredEnv(), log, storageReader: reader, icebergReader });
    await service.start();
    await service.stop();
    expect(log).toHaveBeenCalledWith("run-live-storage-service: iceberg history reader close failed", "database is locked");
    expect(reader.close).toHaveBeenCalledTimes(1);
    service = null;
  });
});

describe("main", () => {
  test("starts, serves health, and shuts down cleanly on request", async () => {
    const logger = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {}, banner: () => {}, flush: async () => {}, close: () => {} };
    const processImpl = new (require("node:events").EventEmitter)();
    processImpl.exitCode = 0;
    processImpl.exit = () => {};
    // parseServiceArgs deliberately refuses port 0, so main() cannot take an
    // ephemeral port; borrow a real free one instead.
    const probe = await listen(http.createServer());
    const freePort = probe.address().port;
    await close(probe);
    const { service, shutdown } = await main({
      argv: [String(freePort)],
      env: { ...configuredEnv(), TT_HEATMAP_DIR: "/srv/terminal-data/heatmap", TT_ICEBERG_DIR: "/srv/terminal-data/iceberg-history" },
      processImpl,
      logger,
    });
    try {
      const { status } = await request(service.server.address().port);
      expect(status).toBe(200);
      expect(service.health().heatmap.dir).toBe("/srv/terminal-data/heatmap");
      expect(service.health().icebergHistory.dir).toBe("/srv/terminal-data/iceberg-history");
    } finally {
      await shutdown("test cleanup");
    }
  });

  test("a fatal error exits with 1 even when the shutdown never finishes", async () => {
    const logger = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {}, banner: () => {}, flush: () => new Promise(() => {}), close: () => {} };
    const processImpl = new (require("node:events").EventEmitter)();
    processImpl.exitCode = 0;
    processImpl.exit = jest.fn();
    const probe = await listen(http.createServer());
    const freePort = probe.address().port;
    await close(probe);
    const { service } = await main({ argv: [String(freePort)], env: configuredEnv(), processImpl, logger });
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      processImpl.emit("uncaughtException", new Error("EAGAIN"));
      jest.advanceTimersByTime(FATAL_EXIT_TIMEOUT_MS - 1);
      expect(processImpl.exit).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(processImpl.exit).toHaveBeenCalledWith(1);
      expect(processImpl.exitCode).toBe(1);
    } finally {
      jest.useRealTimers();
      service.server.closeAllConnections?.();
      await new Promise((resolve) => (service.server.listening ? service.server.close(resolve) : resolve()));
    }
  });
});
