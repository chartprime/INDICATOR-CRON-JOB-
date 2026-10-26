const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCliLogger } = require("../../src/platform/cli-logger");
const { start } = require("../../scripts/serve/run-ws-server");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
function fixture(startImpl = async () => {}) {
  const processImpl = new EventEmitter();
  processImpl.exit = jest.fn();
  const logger = Object.fromEntries(["info", "ok", "warn", "error", "banner", "instrumentTable", "heartbeat", "telemetryLine", "flush", "close"].map((key) => [key, jest.fn()]));
  const app = {
    start: startImpl, stop: jest.fn(async () => {}),
    router: { connectedClientCount: () => 0, getActiveProvider: () => "BINANCE" },
    marketDataServer: { currentAnalyticsStatus: () => ({}) },
    dxfeedMarketDataServer: { currentSymbolInfo: () => null, isActive: () => false, currentRecoveryState: () => "IDLE", instrumentSnapshot: () => [] },
  };
  const service = start({ argv: ["8001"], env: {}, processImpl, logger, createAppImpl: () => app });
  return { service, app, processImpl, logger };
}

test("shutdown during startup never installs late heartbeat/poll timers", async () => {
  const startup = deferred();
  const { service, app, processImpl, logger } = fixture(() => startup.promise);
  await tick();
  const stop = service.shutdown("test");
  expect(service.shutdown("repeat")).toBe(stop);
  await stop;
  startup.resolve();
  await service.ready;
  expect(app.stop).toHaveBeenCalledTimes(1);
  expect(logger.banner).not.toHaveBeenCalled();
  expect(logger.flush).toHaveBeenCalledTimes(1);
  expect(processImpl.eventNames()).toEqual([]);
});

test.each(["SIGINT", "SIGTERM", "beforeExit"])("%s releases all CLI listeners and timers before log close", async (signal) => {
  const { service, app, processImpl, logger } = fixture();
  await service.ready;
  processImpl.emit(signal);
  await service.shutdown("repeat");
  expect(app.stop).toHaveBeenCalledTimes(1);
  expect(processImpl.eventNames()).toEqual([]);
  expect(logger.close).toHaveBeenCalledTimes(1);
  expect(logger.ok).toHaveBeenCalledWith("lifecycle.stopped", expect.any(Object));
});

test("startup rejection still closes the app and logger and removes handlers", async () => {
  const { service, app, processImpl, logger } = fixture(async () => { throw new Error("fixture startup failed"); });
  await expect(service.ready).rejects.toThrow("fixture startup failed");
  await service.shutdown("repeat");
  expect(app.stop).toHaveBeenCalledTimes(1);
  expect(processImpl.exitCode).toBe(1);
  expect(logger.close).toHaveBeenCalledTimes(1);
  expect(processImpl.eventNames()).toEqual([]);
});

test("a cancelled startup rejection after deliberate shutdown does not turn clean shutdown into failure", async () => {
  let rejectStart;
  const pending = new Promise((_, reject) => { rejectStart = reject; });
  const { service, processImpl } = fixture(() => pending);
  await tick();
  await service.shutdown("SIGTERM");
  rejectStart(new Error("startup cancelled"));
  await expect(service.ready).rejects.toThrow("startup cancelled");
  expect(processImpl.exitCode).toBeUndefined();
});

test("stopped telemetry cannot recreate timers from late callbacks", () => {
  jest.useFakeTimers();
  try {
    const { createThrottledConsoleSink } = require("../../src/platform/telemetry-console-sink");
    const sink = createThrottledConsoleSink({ log: jest.fn() });
    sink({ event: "fixture" });
    expect(jest.getTimerCount()).toBe(1);
    sink.stop();
    sink({ event: "late" });
    expect(jest.getTimerCount()).toBe(0);
    expect(sink.getStats().telemetryThrottleOpenWindows).toBe(0);
  } finally { jest.useRealTimers(); }
});

test("stalled disk/output have bounded queues, explicit loss and one drain listener", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w5-log-bound-"));
  const write = deferred();
  const output = new EventEmitter();
  output.write = jest.fn(() => false);
  const appendFile = jest.fn(() => write.promise);
  const logger = createCliLogger({ name: "fixture", logDir: dir, stream: output, appendFile, maxPendingWrites: 4, maxPendingBytes: 2048 });
  try {
    for (let i = 0; i < 10_000; i++) logger.info("record", { i });
    expect(logger.getStats()).toMatchObject({ operatorLogPendingWrites: 4, operatorLogDroppedRecords: 9996, operatorLogPersistenceHealthy: false });
    expect(logger.getStats().operatorLogPendingBytes).toBeLessThanOrEqual(2048);
    expect(output.write).toHaveBeenCalledTimes(1);
    expect(output.listenerCount("drain")).toBe(1);
    write.resolve();
    await expect(logger.flush({ throwOnError: true })).rejects.toThrow("persistence failed");
    expect(appendFile).toHaveBeenCalledTimes(4);
    expect(logger.getStats().operatorLogPendingBytes).toBe(0);
    expect(appendFile.mock.calls[0][1]).toContain(`runId ${logger.identity.runId}`);
    expect(appendFile.mock.calls[0][1]).toContain(`pid ${process.pid}`);
  } finally {
    write.resolve();
    logger.close();
    expect(output.listenerCount("drain")).toBe(0);
    fs.rmdirSync(dir);
  }
});

test("a stalled log flush rejects at its deadline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w5-log-deadline-"));
  const write = deferred();
  const logger = createCliLogger({ name: "fixture", logDir: dir, stream: { write() {} }, appendFile: () => write.promise, flushTimeoutMs: 10 });
  try {
    logger.info("record");
    await expect(logger.flush()).rejects.toThrow("deadline exceeded");
  } finally {
    write.resolve();
    await logger.flush();
    logger.close();
    fs.rmdirSync(dir);
  }
});
