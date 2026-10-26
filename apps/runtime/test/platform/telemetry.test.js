const { emitTelemetry } = require("../../src/platform/telemetry");

describe("emitTelemetry", () => {
  test("calls a function sink with the event name, payload, and an ISO timestamp", () => {
    const sink = jest.fn();
    emitTelemetry(sink, "market_data.connected", { symbol: "BTCUSDT" });

    expect(sink).toHaveBeenCalledTimes(1);
    const entry = sink.mock.calls[0][0];
    expect(entry.event).toBe("market_data.connected");
    expect(entry.symbol).toBe("BTCUSDT");
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("defaults payload to {} when omitted", () => {
    const sink = jest.fn();
    emitTelemetry(sink, "market_data.tick");
    expect(sink.mock.calls[0][0]).toEqual({ event: "market_data.tick", ts: expect.any(String) });
  });

  test("call-site event identity and generated timestamp cannot be shadowed by payload", () => {
    const sink = jest.fn();
    emitTelemetry(sink, "real-event", { event: "spoofed-event", ts: "not-a-real-timestamp" });
    const entry = sink.mock.calls[0][0];
    expect(entry.event).toBe("real-event");
    expect(entry.ts).not.toBe("not-a-real-timestamp");
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test("falls back to console.log when no function sink is provided -- the production default path", () => {
    const consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      emitTelemetry(undefined, "market_data.connected", { symbol: "ETHUSDT" });
      expect(consoleLog).toHaveBeenCalledTimes(1);
      const [prefix, json] = consoleLog.mock.calls[0];
      expect(prefix).toBe("[telemetry]");
      const parsed = JSON.parse(json);
      expect(parsed.event).toBe("market_data.connected");
      expect(parsed.symbol).toBe("ETHUSDT");
    } finally {
      consoleLog.mockRestore();
    }
  });

  test("a non-function sink (e.g. null, an object) also falls back to console.log rather than throwing", () => {
    const consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      emitTelemetry(null, "market_data.tick");
      emitTelemetry({}, "market_data.tick");
      expect(consoleLog).toHaveBeenCalledTimes(2);
    } finally {
      consoleLog.mockRestore();
    }
  });

  test("a throwing sink is caught and reported via console.error, never escapes emitTelemetry", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sink = jest.fn(() => {
        throw new Error("sink exploded");
      });
      expect(() => emitTelemetry(sink, "market_data.connected")).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith("telemetry sink error", "sink exploded");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("a throwing sink that throws a non-Error value is still caught and reported", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sink = jest.fn(() => {
        throw "not an Error instance";
      });
      expect(() => emitTelemetry(sink, "market_data.connected")).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith("telemetry sink error", "not an Error instance");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("contains malformed identity, payload, and throwing payload accessors", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const sink = jest.fn();
    const payload = {};
    Object.defineProperty(payload, "broken", { enumerable: true, get: () => { throw new Error("getter failed"); } });
    try {
      expect(emitTelemetry(sink, "", {})).toBeNull();
      expect(emitTelemetry(sink, "event", null)).toBeNull();
      expect(emitTelemetry(sink, "event", payload)).toBeNull();
      expect(sink).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledTimes(3);
    } finally {
      consoleError.mockRestore();
    }
  });
});
