const {
  serializeConsoleValue,
  installConsolePersistenceBridge,
} = require("../../src/platform/console-persistence-bridge");

describe("console persistence bridge", () => {
  test("routes warnings and errors through the durable logger and restores console exactly once", () => {
    const originalWarn = jest.fn();
    const originalError = jest.fn();
    const consoleImpl = { warn: originalWarn, error: originalError };
    const logger = { warn: jest.fn(), error: jest.fn() };
    const restore = installConsolePersistenceBridge({ logger, consoleImpl });
    consoleImpl.warn("quiet", { symbol: "AAPL" });
    consoleImpl.error(new Error("failed"));
    expect(logger.warn).toHaveBeenCalledWith("quiet", { details: ['{"symbol":"AAPL"}'] });
    expect(logger.error.mock.calls[0][0]).toContain("failed");
    expect(originalWarn).not.toHaveBeenCalled();
    restore();
    restore();
    expect(consoleImpl.warn).toBe(originalWarn);
    expect(consoleImpl.error).toBe(originalError);
  });

  test("bounds behavior for unserializable values without throwing", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(serializeConsoleValue(cyclic)).toBe("[unserializable]");
  });

  test("validates dependencies", () => {
    expect(() => installConsolePersistenceBridge({ logger: {} })).toThrow(/logger/);
    expect(() => installConsolePersistenceBridge({ logger: { warn() {}, error() {} }, consoleImpl: {} })).toThrow(/console/);
  });
});
