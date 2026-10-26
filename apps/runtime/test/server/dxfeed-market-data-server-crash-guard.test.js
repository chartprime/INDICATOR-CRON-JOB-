const mockDxfeedSnapshotFrame = jest.fn();
jest.mock("../../src/server/frames", () => ({
  ...jest.requireActual("../../src/server/frames"),
  dxfeedSnapshotFrame: (...args) => mockDxfeedSnapshotFrame(...args),
}));

const { DXLinkAuthState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const { createDxFeedMarketDataServer } = require("../../src/server/dxfeed-market-data-server");
const realFrames = jest.requireActual("../../src/server/frames");

function fakeChannel() {
  const listeners = { message: [], error: [], state: [] };
  let state = DXLinkChannelState.REQUESTED;
  return {
    getState: jest.fn(() => state),
    send: jest.fn(),
    addMessageListener: jest.fn((listener) => listeners.message.push(listener)),
    removeMessageListener: jest.fn(),
    addErrorListener: jest.fn((listener) => listeners.error.push(listener)),
    removeErrorListener: jest.fn(),
    addStateChangeListener: jest.fn((listener) => listeners.state.push(listener)),
    removeStateChangeListener: jest.fn(),
    close: jest.fn(),
    emitMessage: (message) => [...listeners.message].forEach((listener) => listener(message)),
    emitState: (nextState, prev) => {
      state = nextState;
      [...listeners.state].forEach((listener) => listener(nextState, prev));
    },
  };
}

function fakeConnection() {
  const channel = fakeChannel();
  const listeners = { error: [], connection: [], auth: [] };
  let authState = DXLinkAuthState.UNAUTHORIZED;
  function subscribable(bucket) {
    return jest.fn((listener) => {
      listeners[bucket].push(listener);
      return () => {
        listeners[bucket] = listeners[bucket].filter((entry) => entry !== listener);
      };
    });
  }
  return {
    channel,
    getStatus: jest.fn(() => ({ connectionState: "CONNECTED", authState })),
    connect: jest.fn(),
    disconnect: jest.fn(),
    openChannel: jest.fn(() => channel),
    onError: subscribable("error"),
    onConnectionStateChange: subscribable("connection"),
    onAuthStateChange: subscribable("auth"),
    emitAuth: (state, prev) => {
      authState = state;
      [...listeners.auth].forEach((listener) => listener({ state, prev }));
    },
  };
}

function fakeClient() {
  return { readyState: 1, bufferedAmount: 0, sent: [], send: jest.fn(), close: jest.fn() };
}

const NOW_MS = 1_800_000_000_000;
const VALID_EXPIRES_AT = new Date(NOW_MS + 30 * 60_000).toISOString();

function baseOptions(overrides = {}) {
  return {
    brokerUrl: "https://broker.example.ts.net",
    requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT })),
    now: () => NOW_MS,
    sessionRetryBaseMs: 30_000,
    ...overrides,
  };
}

async function driveToChannelOpened(connection) {
  connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
  await Promise.resolve();
  await Promise.resolve();
  connection.channel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
}

function selectMessage(symbol, assetClass) {
  return JSON.stringify({ type: "select", symbol, assetClass });
}

beforeEach(() => {
  mockDxfeedSnapshotFrame.mockImplementation((...args) => realFrames.dxfeedSnapshotFrame(...args));
});

describe("createDxFeedMarketDataServer -- connection-time crash guard (Fix 5)", () => {
  test("REGRESSION: a thrown snapshot build during handleClientConnected drops only the offending client, not the process, and a subsequent client is unaffected", async () => {
    const connection = fakeConnection();
    const server = createDxFeedMarketDataServer(baseOptions({ createConnection: () => connection }));
    server.start();
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), fakeClient());
    await driveToChannelOpened(connection);

    mockDxfeedSnapshotFrame.mockImplementationOnce(() => {
      throw new Error("dxfeedSnapshotFrame: trades must be pair-matched and unique");
    });
    const badClient = fakeClient();
    expect(() => server.handleClientConnected(badClient)).not.toThrow();
    expect(badClient.close).toHaveBeenCalledTimes(1);

    // The mock reverts to the real implementation for this second call --
    // a healthy client connecting afterward must be unaffected.
    const healthyClient = fakeClient();
    expect(() => server.handleClientConnected(healthyClient)).not.toThrow();
    expect(healthyClient.close).not.toHaveBeenCalled();
    expect(healthyClient.send).toHaveBeenCalled();
  });
});
