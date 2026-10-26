const { DXLinkAuthState, DXLinkConnectionState } = require("@dxfeed/dxlink-core");
const { main } = require("../../../scripts/verify/dxfeed/verify-dxfeed-auth");

function noopLogger() {
  return {
    banner: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ok: jest.fn(),
  };
}

function fakeConnection({ connectError = null, disconnectError = null } = {}) {
  const listeners = { error: [], connection: [], auth: [] };
  return {
    connect: jest.fn(() => {
      if (connectError) throw connectError;
    }),
    disconnect: jest.fn(() => {
      if (disconnectError) throw disconnectError;
      for (const listener of listeners.connection) {
        listener({ state: DXLinkConnectionState.NOT_CONNECTED, prev: DXLinkConnectionState.CONNECTED });
      }
    }),
    onError: jest.fn((listener) => listeners.error.push(listener)),
    onConnectionStateChange: jest.fn((listener) => listeners.connection.push(listener)),
    onAuthStateChange: jest.fn((listener) => listeners.auth.push(listener)),
    emitError: (error) => listeners.error.forEach((listener) => listener(error)),
    emitConnection: (state, prev) => listeners.connection.forEach((listener) => listener({ state, prev })),
    emitAuth: (state, prev) => listeners.auth.forEach((listener) => listener({ state, prev })),
  };
}

const config = Object.freeze({
  endpoint: "wss://tools.dxfeed.com/dxlink-chartprime",
  marketDataMode: "realtime",
  tempToken: "temporary-secret.token",
});

let sigintCountBefore;
let sigtermCountBefore;

beforeEach(() => {
  sigintCountBefore = process.listenerCount("SIGINT");
  sigtermCountBefore = process.listenerCount("SIGTERM");
});

afterEach(() => {
  expect(process.listenerCount("SIGINT")).toBe(sigintCountBefore);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermCountBefore);
});

describe("verify-dxfeed-auth", () => {
  test("fails immediately on an error and never reports a later authorization as zero-error success", async () => {
    const connection = fakeConnection();
    const logger = noopLogger();
    const exit = jest.fn();
    await main({ logger, loadConfig: () => config, createConnection: () => connection, exit });

    connection.emitError({ type: "AUTH", message: `denied ${config.tempToken}` });
    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.ok).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("connection error", expect.objectContaining({
      message: expect.not.stringContaining(config.tempToken),
    }));
  });

  test("a deliberate success disconnect does not self-report as an unexpected connection drop", async () => {
    const connection = fakeConnection();
    const logger = noopLogger();
    const exit = jest.fn();
    await main({ logger, loadConfig: () => config, createConnection: () => connection, exit });

    connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);

    expect(exit).toHaveBeenCalledWith(0);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls.map(([message]) => message)).not.toContain(
      "connection dropped before reaching AUTHORIZED, this attempt failed",
    );
  });

  test("SIGTERM disconnects and returns the conventional interrupted exit status", async () => {
    const connection = fakeConnection();
    const logger = noopLogger();
    const exit = jest.fn();
    await main({ logger, loadConfig: () => config, createConnection: () => connection, exit });

    process.emit("SIGTERM");

    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
    expect(logger.warn).toHaveBeenCalledWith("received SIGTERM, disconnecting");
  });

  test("a synchronous connect exception is redacted and finalized as a failed verification", async () => {
    const connection = fakeConnection({ connectError: new Error(`connect failed ${config.tempToken}`) });
    const logger = noopLogger();
    const exit = jest.fn();
    await main({ logger, loadConfig: () => config, createConnection: () => connection, exit });

    expect(exit).toHaveBeenCalledWith(1);
    const serializedLogs = JSON.stringify(logger.error.mock.calls);
    expect(serializedLogs).not.toContain(config.tempToken);
  });

  test("a listener-registration exception is redacted, disconnected, and finalized as a failed verification", async () => {
    const connection = fakeConnection();
    connection.onAuthStateChange = () => {
      throw new Error(`listener setup failed ${config.tempToken}`);
    };
    const logger = noopLogger();
    const exit = jest.fn();

    await main({ logger, loadConfig: () => config, createConnection: () => connection, exit });

    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(connection.connect).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(config.tempToken);
  });
});
