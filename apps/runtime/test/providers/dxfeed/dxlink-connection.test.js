const { createDxLinkConnection } = require("../../../src/providers/dxfeed/dxlink-connection");
const { REALTIME_ENDPOINT, DELAYED_ENDPOINT } = require("../../../src/providers/dxfeed/dxfeed-connection-config");

function fakeClientImpl(client) {
  // A plain function, not an arrow -- production code calls `new
  // webSocketClientImpl(...)`, and arrow functions can never be used as
  // constructors. Returning an object from a plain function invoked with
  // `new` makes `new` use that returned object instead of `this`.
  return function () {
    return client;
  };
}

function fakeClient() {
  const calls = [];
  let errorListener = null;
  let connectionStateListener = null;
  let authStateListener = null;
  let connectionState = "NOT_CONNECTED";
  let authState = "UNAUTHORIZED";
  return {
    calls,
    setAuthToken(token) {
      calls.push({ name: "setAuthToken", token });
    },
    connect(endpoint) {
      calls.push({ name: "connect", endpoint });
    },
    disconnect() {
      calls.push({ name: "disconnect" });
    },
    getConnectionState() {
      return connectionState;
    },
    getAuthState() {
      return authState;
    },
    addErrorListener(listener) {
      errorListener = listener;
    },
    addConnectionStateChangeListener(listener) {
      connectionStateListener = listener;
    },
    addAuthStateChangeListener(listener) {
      authStateListener = listener;
    },
    emitError(error) {
      errorListener(error);
    },
    setConnectionState(state) {
      const prev = connectionState;
      connectionState = state;
      connectionStateListener(state, prev);
    },
    setAuthState(state) {
      const prev = authState;
      authState = state;
      authStateListener(state, prev);
    },
    openChannel(service, parameters, options) {
      calls.push({ name: "openChannel", service, parameters, options });
      return { id: "fake-channel" };
    },
  };
}

function validConfig(overrides = {}) {
  return { endpoint: REALTIME_ENDPOINT, marketDataMode: "realtime", tempToken: "abc123.def456", ...overrides };
}

describe("createDxLinkConnection", () => {
  test("rejects a config missing endpoint, marketDataMode, or tempToken", () => {
    const client = fakeClient();
    const impl = function () {
      return client;
    };
    expect(() => createDxLinkConnection({}, { webSocketClientImpl: impl })).toThrow(/config must include/);
    expect(() => createDxLinkConnection(validConfig({ endpoint: undefined }), { webSocketClientImpl: impl })).toThrow(
      /config must include/,
    );
  });

  test("attaches the error listener unconditionally at construction, even if the caller never calls connect()", () => {
    const client = fakeClient();
    createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });
    expect(client.calls).toEqual([]);
    expect(() => client.emitError({ type: "X", message: "should not throw" })).not.toThrow();
  });

  test("constructs the underlying client with maxReconnectAttempts: 0, so a dropped connection is never auto-retried against dxFeed's endpoint", () => {
    const client = fakeClient();
    let capturedConfig = null;
    const capturingImpl = function (config) {
      capturedConfig = config;
      return client;
    };
    createDxLinkConnection(validConfig(), { webSocketClientImpl: capturingImpl });
    expect(capturedConfig.maxReconnectAttempts).toBe(0);
  });

  test("uses the default connector factory when createConnector is omitted", () => {
    const client = fakeClient();
    let capturedConfig = null;
    const capturingImpl = function (config) {
      capturedConfig = config;
      return client;
    };
    createDxLinkConnection(validConfig(), { webSocketClientImpl: capturingImpl });
    expect(typeof capturedConfig.connectorFactory).toBe("function");
    // The default factory must actually build a connector object (the real
    // dxlink-ws-connector shape), not throw or return something unusable --
    // confirms omitting createConnector still produces working behavior.
    const connector = capturedConfig.connectorFactory(REALTIME_ENDPOINT);
    expect(typeof connector.start).toBe("function");
    expect(typeof connector.setMessageListener).toBe("function");
  });

  test("uses a supplied createConnector instead of the default, and passes it the connection URL", () => {
    const client = fakeClient();
    let capturedConfig = null;
    const capturingImpl = function (config) {
      capturedConfig = config;
      return client;
    };
    const fakeConnector = { start: jest.fn(), stop: jest.fn() };
    const createConnector = jest.fn(() => fakeConnector);
    createDxLinkConnection(validConfig(), { webSocketClientImpl: capturingImpl, createConnector });
    const connector = capturedConfig.connectorFactory(REALTIME_ENDPOINT);
    expect(createConnector).toHaveBeenCalledWith(REALTIME_ENDPOINT);
    expect(connector).toBe(fakeConnector);
  });

  test("refuses an SDK-requested connector URL outside the pinned approved endpoint", () => {
    const client = fakeClient();
    let capturedConfig = null;
    const capturingImpl = function (config) {
      capturedConfig = config;
      return client;
    };
    const createConnector = jest.fn();
    createDxLinkConnection(validConfig(), { webSocketClientImpl: capturingImpl, createConnector });

    expect(() => capturedConfig.connectorFactory("wss://unapproved.example/dxlink-websocket"))
      .toThrow(/unapproved connector endpoint/);
    expect(createConnector).not.toHaveBeenCalled();
  });

  test("rejects a non-function createConnector before constructing anything", () => {
    const impl = jest.fn();
    expect(() => createDxLinkConnection(validConfig(), { webSocketClientImpl: impl, createConnector: "nope" }))
      .toThrow(/createConnector must be a function/);
    expect(impl).not.toHaveBeenCalled();
  });

  test("connect() sets the auth token before connecting, in that exact order", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });
    connection.connect();
    expect(client.calls).toEqual([
      { name: "setAuthToken", token: "abc123.def456" },
      { name: "connect", endpoint: REALTIME_ENDPOINT },
    ]);
  });

  test("connect() refuses an unapproved endpoint/marketDataMode pair before touching the client at all", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(
      validConfig({ endpoint: DELAYED_ENDPOINT, marketDataMode: "realtime" }),
      { webSocketClientImpl: fakeClientImpl(client) },
    );
    expect(() => connection.connect()).toThrow(/not an approved matching pair/);
    expect(client.calls).toEqual([]);
  });

  test("uses a validated configuration snapshot, so later caller mutation cannot change the endpoint or token boundary", () => {
    const client = fakeClient();
    const config = validConfig();
    const connection = createDxLinkConnection(config, { webSocketClientImpl: fakeClientImpl(client) });

    config.endpoint = "wss://unapproved.example/token-bearing-path";
    config.marketDataMode = "delayed";
    config.tempToken = "mutated-secret.value";
    connection.connect();

    expect(client.calls).toEqual([
      { name: "setAuthToken", token: "abc123.def456" },
      { name: "connect", endpoint: REALTIME_ENDPOINT },
    ]);
  });

  test("rejects a direct, malformed temp token before constructing the SDK client", () => {
    const impl = jest.fn();
    expect(() => createDxLinkConnection(validConfig({ tempToken: "not-a-dxfeed-token" }), { webSocketClientImpl: impl })).toThrow(
      /invalid DXFEED_TEMP_TOKEN shape/,
    );
    expect(impl).not.toHaveBeenCalled();
  });

  test("disconnect() calls through to the client", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });
    connection.disconnect();
    expect(client.calls).toEqual([{ name: "disconnect" }]);
  });

  test("disconnect() redacts an unexpected token-bearing client error", () => {
    const client = fakeClient();
    client.disconnect = () => {
      throw new Error("disconnect failed for abc123.def456");
    };
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });
    expect(() => connection.disconnect()).toThrow(/\[REDACTED\]/);
    expect(() => connection.disconnect()).not.toThrow(/abc123\.def456/);
  });

  test("getStatus() reflects the client's current connection and auth state", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });
    expect(connection.getStatus()).toEqual({ connectionState: "NOT_CONNECTED", authState: "UNAUTHORIZED" });
    client.setConnectionState("CONNECTED");
    client.setAuthState("AUTHORIZED");
    expect(connection.getStatus()).toEqual({ connectionState: "CONNECTED", authState: "AUTHORIZED" });
  });

  test("an error containing the real secret is redacted before reaching any onError listener or console", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig({ tempToken: "abc123.def456" }), {
      webSocketClientImpl: fakeClientImpl(client),
    });
    const received = [];
    connection.onError((error) => received.push(error));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    client.emitError({ type: "AUTH_FAILED", message: "rejected token abc123.def456" });

    expect(received).toEqual([{ type: "AUTH_FAILED", message: "rejected token [REDACTED]" }]);
    expect(errorSpy.mock.calls.some((call) => JSON.stringify(call).includes("abc123.def456"))).toBe(false);
    errorSpy.mockRestore();
  });

  test("onConnectionStateChange and onAuthStateChange fan out state transitions to registered listeners", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });
    const connectionEvents = [];
    const authEvents = [];
    connection.onConnectionStateChange((event) => connectionEvents.push(event));
    connection.onAuthStateChange((event) => authEvents.push(event));

    client.setConnectionState("CONNECTED");
    client.setAuthState("AUTHORIZED");

    expect(connectionEvents).toEqual([{ state: "CONNECTED", prev: "NOT_CONNECTED" }]);
    expect(authEvents).toEqual([{ state: "AUTHORIZED", prev: "UNAUTHORIZED" }]);
  });

  test("listener registration rejects invalid values and returns an unsubscribe function", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });
    expect(() => connection.onError(null)).toThrow(/listener must be a function/);

    const listener = jest.fn();
    const unsubscribe = connection.onError(listener);
    unsubscribe();
    client.emitError({ type: "X", message: "ignored" });

    expect(listener).not.toHaveBeenCalled();
  });

  test("a listener that throws is contained and does not stop other listeners or crash the emitter", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const secondCalls = [];
    connection.onError(() => {
      throw new Error("listener boom");
    });
    connection.onError((error) => secondCalls.push(error));

    expect(() => client.emitError({ type: "X", message: "boom" })).not.toThrow();
    expect(secondCalls).toHaveLength(1);
    errorSpy.mockRestore();
  });

  test("a listener throwing its own error containing the real secret is still redacted, not just the connection's own errors", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig({ tempToken: "abc123.def456" }), {
      webSocketClientImpl: fakeClientImpl(client),
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    connection.onConnectionStateChange(() => {
      throw new Error("listener failed while holding abc123.def456");
    });

    client.setConnectionState("CONNECTED");

    expect(errorSpy.mock.calls.some((call) => JSON.stringify(call).includes("abc123.def456"))).toBe(false);
    expect(errorSpy.mock.calls.some((call) => JSON.stringify(call).includes("[REDACTED]"))).toBe(true);
    errorSpy.mockRestore();
  });

  test("a synchronous throw from the underlying client's connect() itself never leaks the token in the rethrown error", () => {
    const client = fakeClient();
    client.connect = () => {
      throw new Error("upstream rejected token abc123.def456");
    };
    const connection = createDxLinkConnection(validConfig({ tempToken: "abc123.def456" }), {
      webSocketClientImpl: fakeClientImpl(client),
    });

    let thrown = null;
    try {
      connection.connect();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown.message).not.toContain("abc123.def456");
    expect(thrown.message).toContain("[REDACTED]");
  });

  test("openChannel() delegates to the underlying client with the same arguments and returns its result", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });

    const channel = connection.openChannel("FEED", { contract: "AUTO" }, { reconnect: false });

    expect(client.calls).toEqual([
      { name: "openChannel", service: "FEED", parameters: { contract: "AUTO" }, options: { reconnect: false } },
    ]);
    expect(channel).toEqual({ id: "fake-channel" });
  });

  test("openChannel() rejects invalid boundary arguments before touching the client", () => {
    const client = fakeClient();
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });

    expect(() => connection.openChannel("", {})).toThrow(/service must be a non-empty string/);
    expect(() => connection.openChannel("FEED", [])).toThrow(/parameters must be an object/);
    expect(() => connection.openChannel("FEED", {}, [])).toThrow(/options must be an object/);
    expect(client.calls).toEqual([]);
  });

  test("openChannel() redacts token-bearing failures from the underlying client", () => {
    const client = fakeClient();
    client.openChannel = () => {
      throw new Error("channel rejected abc123.def456");
    };
    const connection = createDxLinkConnection(validConfig(), { webSocketClientImpl: fakeClientImpl(client) });

    expect(() => connection.openChannel("FEED", { contract: "AUTO" })).toThrow(/\[REDACTED\]/);
    expect(() => connection.openChannel("FEED", { contract: "AUTO" })).not.toThrow(/abc123\.def456/);
  });
});
