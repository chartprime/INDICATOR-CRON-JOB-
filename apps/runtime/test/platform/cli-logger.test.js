const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCliLogger, classifyTelemetryEvent, flushAndExit } = require("../../src/platform/cli-logger");
const { safeRm } = require("../helpers/temp-files");

function tempLogDir() {
  return path.join(os.tmpdir(), `terminal-l1-l2-cli-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function fakeStream(hasColors) {
  const lines = [];
  return {
    lines,
    hasColors: typeof hasColors === "boolean" ? () => hasColors : undefined,
    write(text) {
      lines.push(text);
    },
  };
}

function readLogFile(logDir, name, date) {
  const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return fs.readFileSync(path.join(logDir, `${name}-${key}.log`), "utf8");
}

describe("createCliLogger", () => {
  let logDir;

  afterEach(() => {
    if (logDir && fs.existsSync(logDir)) {
      safeRm(logDir, { recursive: true, force: true });
    }
  });

  test("rejects a missing name or logDir", () => {
    logDir = tempLogDir();
    expect(() => createCliLogger({ name: "", logDir })).toThrow(/name/);
    expect(() => createCliLogger({ name: "x", logDir: "" })).toThrow(/logDir/);
  });

  test("creates the log directory on construction", () => {
    logDir = tempLogDir();
    expect(fs.existsSync(logDir)).toBe(false);
    createCliLogger({ name: "collector", logDir, stream: fakeStream(false) });
    expect(fs.existsSync(logDir)).toBe(true);
  });

  test("plain text, no escape codes, when the stream reports no color support", () => {
    logDir = tempLogDir();
    const stream = fakeStream(false);
    const logger = createCliLogger({ name: "collector", logDir, stream, now: () => new Date(Date.UTC(2026, 0, 15, 9, 5, 3)) });

    logger.ok("running, capturing all known pairs");

    expect(stream.lines[0]).toBe("09:05:03 OK   running, capturing all known pairs\n");
  });

  test("wraps level tag and message in ANSI codes when the stream supports color", () => {
    logDir = tempLogDir();
    const stream = fakeStream(true);
    const logger = createCliLogger({ name: "collector", logDir, stream, now: () => new Date(Date.UTC(2026, 0, 15, 9, 5, 3)) });

    logger.error("subscribe failed", { pair: "ETHUSDT" });

    expect(stream.lines[0]).toContain("\x1b[31m");
    expect(stream.lines[0]).toContain("subscribe failed");
    expect(stream.lines[0]).toContain("pair ETHUSDT");
  });

  test("each level's persisted file line matches what was printed, minus color", async () => {
    logDir = tempLogDir();
    const date = new Date(Date.UTC(2026, 0, 15, 9, 5, 3));
    const logger = createCliLogger({ name: "collector", logDir, stream: fakeStream(true), now: () => date });

    logger.info("route connected", { marketKind: "SPOT" });
    logger.warn("depth gap detected", { symbol: "BTCUSDT" });
    await logger.flush();

    const persisted = readLogFile(logDir, "collector", date);
    expect(persisted.replace(/ {2}runId [^\n]+/g, "")).toBe(
      "09:05:03 INFO route connected  marketKind SPOT\n" +
        "09:05:03 WARN depth gap detected  symbol BTCUSDT\n",
    );
  });

  test("flushAndExit persists queued evidence before invoking exit", async () => {
    logDir = tempLogDir();
    const date = new Date(Date.UTC(2026, 0, 15, 9, 5, 3));
    const logger = createCliLogger({ name: "proof", logDir, stream: fakeStream(false), now: () => date });
    const exit = jest.fn();
    logger.ok("verification complete");

    const pendingExit = flushAndExit(logger, exit, 0);
    expect(exit).not.toHaveBeenCalled();
    await pendingExit;

    expect(readLogFile(logDir, "proof", date)).toContain("verification complete");
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("flushAndExit fails closed when persistence rejects", async () => {
    const exit = jest.fn();
    await flushAndExit({ flush: () => Promise.reject(new Error("disk full")) }, exit, 0);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("flushAndExit detects a persistence failure from the real logger", async () => {
    logDir = tempLogDir();
    const appendSpy = jest.spyOn(fs.promises, "appendFile").mockRejectedValueOnce(new Error("disk full"));
    const logger = createCliLogger({ name: "proof", logDir, stream: fakeStream(false) });
    const exit = jest.fn();
    logger.error("verification failed");

    await flushAndExit(logger, exit, 0);

    expect(exit).toHaveBeenCalledWith(1);
    appendSpy.mockRestore();
  });

  test("banner prints a boxed block and persists an unstyled equivalent", async () => {
    logDir = tempLogDir();
    const date = new Date(Date.UTC(2026, 0, 15, 9, 0, 0));
    const stream = fakeStream(false);
    const logger = createCliLogger({ name: "collector", logDir, stream, now: () => date });

    logger.banner(["TERMINAL 0 - raw market-data collector", "pairs   BTC-USDT, ETH-USDT"]);
    await logger.flush();

    expect(stream.lines[0]).toMatch(/^\+-+\+\n$/);
    expect(stream.lines.some((line) => line.includes("TERMINAL 0"))).toBe(true);
    expect(stream.lines.at(-1)).toMatch(/^\+-+\+\n$/);

    const persisted = readLogFile(logDir, "collector", date);
    expect(persisted).toContain("TERMINAL 0");
    expect(persisted).toContain("+");
  });

  test("instrumentTable prints a boxed per-instrument board with a title/clock row, and persists an unstyled equivalent", async () => {
    logDir = tempLogDir();
    const date = new Date(Date.UTC(2026, 0, 15, 10, 31, 59));
    const stream = fakeStream(false);
    const logger = createCliLogger({ name: "collector", logDir, stream, now: () => date });

    logger.instrumentTable([
      { symbol: "/NQZ26:XCME", assetClass: "FUTURE", l1: { recoveryState: "READY", quiet: false }, l2: { status: "READY", reason: null } },
      { symbol: "AAPL", assetClass: "EQUITY", l1: { recoveryState: "READY", quiet: false }, l2: { status: "UNAVAILABLE", reason: "CORRELATION_FAILED" } },
      { symbol: "TSLA", assetClass: "EQUITY", l1: { recoveryState: "READY", quiet: true }, l2: { status: "BUFFERING", reason: null } },
    ]);
    await logger.flush();

    expect(stream.lines[0]).toMatch(/^\+-+\+\n$/);
    expect(stream.lines.at(-1)).toMatch(/^\+-+\+\n$/);
    const rendered = stream.lines.join("");
    expect(rendered).toContain("INSTRUMENTS");
    expect(rendered).toContain("10:31:59 UTC");
    expect(rendered).toContain("SYMBOL");
    expect(rendered).toContain("/NQZ26:XCME");
    expect(rendered).toContain("LIVE");
    expect(rendered).toContain("UNAVAILABLE (CORRELATION_FAILED)");
    expect(rendered).toContain("QUIET");
    expect(rendered).toContain("BUFFERING");

    const persisted = readLogFile(logDir, "collector", date);
    expect(persisted).toContain("INSTRUMENTS");
    expect(persisted).toContain("UNAVAILABLE (CORRELATION_FAILED)");
    expect(persisted).not.toContain("\x1b[");
  });

  test("instrumentTable rejects a non-array or non-object row", () => {
    logDir = tempLogDir();
    const logger = createCliLogger({ name: "collector", logDir, stream: fakeStream(false) });
    expect(() => logger.instrumentTable("not an array")).toThrow(/instrumentTable/);
    expect(() => logger.instrumentTable([null])).toThrow(/instrumentTable/);
  });

  test("heartbeat reports nominal with growing counters, formatted with thousands separators", async () => {
    logDir = tempLogDir();
    const logger = createCliLogger({ name: "collector", logDir, stream: fakeStream(false), now: () => new Date(Date.UTC(2026, 0, 15, 9, 0, 0)) });

    logger.heartbeat("3m23s", { trades: 4812, candles: 16 }, true);
    await logger.flush();

    const persisted = readLogFile(logDir, "collector", new Date(Date.UTC(2026, 0, 15)));
    expect(persisted.replace(/ {2}runId [^\n]+/g, "")).toBe("09:00:00 heartbeat  uptime 3m23s  trades 4,812  candles 16  current path nominal\n");
  });

  test("heartbeat reports the no-activity state when told nominal: false", async () => {
    logDir = tempLogDir();
    const logger = createCliLogger({ name: "collector", logDir, stream: fakeStream(false), now: () => new Date(Date.UTC(2026, 0, 15, 9, 1, 0)) });

    logger.heartbeat("1h0m0s", { trades: 4812 }, false);
    await logger.flush();

    const persisted = readLogFile(logDir, "collector", new Date(Date.UTC(2026, 0, 15)));
    expect(persisted).toContain("no new market data since last heartbeat");
  });

  test("heartbeat renders an explicit operational degradation reason", async () => {
    logDir = tempLogDir();
    const date = new Date(Date.UTC(2026, 0, 15, 9, 1, 0));
    const logger = createCliLogger({ name: "collector", logDir, stream: fakeStream(false), now: () => date });

    logger.heartbeat("1h0m0s", { captureQuality: "INVALID" }, false, "capture integrity invalid");
    await logger.flush();

    const persisted = readLogFile(logDir, "collector", date);
    expect(persisted).toContain("capture integrity invalid");
    expect(persisted).not.toContain("no new market data");
  });

  test("heartbeat preserves textual and absent operational gauges instead of rendering them as NaN or zero", async () => {
    logDir = tempLogDir();
    const date = new Date(Date.UTC(2026, 0, 15, 9, 1, 0));
    const logger = createCliLogger({ name: "collector", logDir, stream: fakeStream(false), now: () => date });

    logger.heartbeat("1m0s", { lastBackupAt: "2026-01-15T08:00:00.000Z", lastAuditAt: null }, true);
    await logger.flush();

    const persisted = readLogFile(logDir, "collector", date);
    expect(persisted).toContain("lastBackupAt 2026-01-15T08:00:00.000Z");
    expect(persisted).toContain("lastAuditAt n/a");
    expect(persisted).not.toContain("NaN");
  });

  describe("telemetryLine", () => {
    test.each([
      ["market_data.binance_connection.depth_snapshot_exception", "error"],
      ["market_data.binance_connection.depth_gap_recovery_attempt", "warn"],
      ["market_data.binance_backpressure.event_dropped", "error"],
      ["market_data.binance_backpressure.queue_overflow", "error"],
      ["market_data.binance_connection.route_disconnected", "warn"],
      ["market_data.binance_connection.depth_gap_recovery_succeeded", "ok"],
      ["market_data.binance_connection.route_connected", "ok"],
      ["market_data.binance_connection.depth_snapshot_fetched", "info"],
      ["market_data.dxfeed_order_v2_capture.correlation_failed", "error"],
      ["market_data.dxfeed_order_v2_capture.channel_reopen_exhausted", "error"],
      ["market_data.dxfeed_order_v2_capture.channel_reopen_started", "info"],
      ["market_data.dxfeed_order_v2_capture.channel_reopen_succeeded", "ok"],
      ["market_data.dxfeed_book_assembler.unavailable", "warn"],
      ["market_data.dxfeed_book_assembler.recovery_succeeded", "ok"],
    ])("classifies %s as %s", (event, expectedLevel) => {
      expect(classifyTelemetryEvent(event)).toBe(expectedLevel);
    });

    test("a severity the emitter declares wins over the name rule, and an unknown one falls back to it", () => {
      expect(classifyTelemetryEvent("market_data.dxfeed_candle_input.rejected")).toBe("error");
      expect(classifyTelemetryEvent("market_data.dxfeed_candle_input.rejected", { severity: "info" })).toBe("info");
      expect(classifyTelemetryEvent("market_data.dxfeed_candle_input.rejected", { severity: "warn" })).toBe("warn");
      expect(classifyTelemetryEvent("market_data.dxfeed_candle_input.rejected", { severity: "loud" })).toBe("error");
    });

    test("a declared severity sets the level and is not repeated as meta", async () => {
      logDir = tempLogDir();
      const date = new Date(Date.UTC(2026, 0, 15, 9, 5, 3));
      const logger = createCliLogger({ name: "runtime", logDir, stream: fakeStream(false), now: () => date });

      logger.telemetryLine("[telemetry]", JSON.stringify({
        event: "market_data.dxfeed_candle_input.rejected",
        severity: "info",
        reason: "INVALID_TICK",
        ts: date.toISOString(),
      }));
      await logger.flush();

      const persisted = readLogFile(logDir, "runtime", date);
      expect(persisted.replace(/ {2}runId [^\n]+/g, "")).toBe("09:05:03 INFO dxfeed_candle_input.rejected  reason INVALID_TICK\n");
    });

    test("strips the market_data. prefix and renders remaining fields as meta", async () => {
      logDir = tempLogDir();
      const date = new Date(Date.UTC(2026, 0, 15, 9, 5, 3));
      const logger = createCliLogger({ name: "collector", logDir, stream: fakeStream(false), now: () => date });

      logger.telemetryLine("[telemetry]", JSON.stringify({
        event: "market_data.binance_connection.route_connected",
        marketKind: "SPOT",
        route: "public",
        ts: date.toISOString(),
      }));
      await logger.flush();

      const persisted = readLogFile(logDir, "collector", date);
      expect(persisted.replace(/ {2}runId [^\n]+/g, "")).toBe("09:05:03 OK   binance_connection.route_connected  marketKind SPOT  route public\n");
    });

    test("falls back to a plain info line on malformed JSON, never throws", () => {
      logDir = tempLogDir();
      const logger = createCliLogger({ name: "collector", logDir, stream: fakeStream(false), now: () => new Date(Date.UTC(2026, 0, 15)) });

      expect(() => logger.telemetryLine("[telemetry]", "not json")).not.toThrow();
      expect(() => logger.telemetryLine("[telemetry]", "null")).not.toThrow();
      expect(() => logger.telemetryLine("[telemetry]", "[1,2,3]")).not.toThrow();
    });
  });

  test("contains forged line breaks and exposes durable operator-evidence health", async () => {
    logDir = tempLogDir();
    const date = new Date(Date.UTC(2026, 0, 15, 9, 5, 3));
    const stream = fakeStream(false);
    const logger = createCliLogger({ name: "collector", logDir, stream, now: () => date });

    logger.warn("first\nFORGED", { reason: "bad\rsecond" });
    expect(logger.getStats()).toMatchObject({
      operatorLogPersistenceHealthy: true,
      operatorLogOutputHealthy: true,
      operatorLogPendingWrites: 1,
    });
    await logger.flush({ throwOnError: true });

    expect(readLogFile(logDir, "collector", date).trim().split("\n")).toHaveLength(1);
    expect(stream.lines[0]).toContain("first\\nFORGED");
    expect(logger.getStats()).toMatchObject({
      operatorLogPersistenceHealthy: true,
      operatorLogPendingWrites: 0,
      operatorLogPersistedRecords: 1,
    });
  });

  test("surfaces stream and persistence failures as explicit health signals", async () => {
    logDir = tempLogDir();
    const appendSpy = jest.spyOn(fs.promises, "appendFile").mockRejectedValueOnce(new Error("disk full"));
    const logger = createCliLogger({
      name: "collector",
      logDir,
      stream: { write: () => { throw new Error("pipe closed"); } },
    });
    logger.error("capture failed");
    await logger.flush();

    expect(logger.getStats()).toMatchObject({
      operatorLogPersistenceHealthy: false,
      operatorLogOutputHealthy: false,
      operatorLogStreamWriteFailures: 1,
      operatorLogPersistenceError: "disk full",
    });
    appendSpy.mockRestore();
  });
});
