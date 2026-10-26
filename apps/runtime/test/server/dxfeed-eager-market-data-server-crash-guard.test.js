const mockDxfeedSnapshotFrame = jest.fn();
jest.mock("../../src/server/frames", () => ({
  ...jest.requireActual("../../src/server/frames"),
  dxfeedSnapshotFrame: (...args) => mockDxfeedSnapshotFrame(...args),
}));

const { DXLinkAuthState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const { createDxFeedEagerMarketDataServer } = require("../../src/server/dxfeed-eager-market-data-server");
const realFrames = jest.requireActual("../../src/server/frames");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../helpers/temp-files");
const { createIcebergHistory } = require("../../src/indicators/iceberg/iceberg-history");
const { saveIcebergHistory } = require("../../src/indicators/iceberg/iceberg-store");
const { icebergOptionsFromEnv } = require("../../src/indicators/iceberg/iceberg-indicator");
const ICEBERG_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eager-crash-guard-icebergs-"));
process.env.L2_ICEBERG_STORE_DIR = ICEBERG_STORE_DIR;
afterAll(() => safeRm(ICEBERG_STORE_DIR, { recursive: true, force: true }));
test("the iceberg store env points at this suite temp dir before any server boots", () => {
  expect(icebergOptionsFromEnv().storeDir).toBe(ICEBERG_STORE_DIR);
});

const NQ = { assetClass: "FUTURE", symbol: "/NQZ26:XCME", orderSource: "GLBX" };
const AAPL = { assetClass: "EQUITY", symbol: "AAPL", orderSource: "NTV" };
const TEST_INSTRUMENTS = [NQ, AAPL];
const startedServers = [];

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
    emitState: (nextState, prev) => {
      state = nextState;
      [...listeners.state].forEach((listener) => listener(nextState, prev));
    },
  };
}

function fakeConnection() {
  const listeners = { error: [], connection: [], auth: [] };
  let authState = DXLinkAuthState.UNAUTHORIZED;
  const channels = [];
  function subscribable(bucket) {
    return jest.fn((listener) => {
      listeners[bucket].push(listener);
      return () => {
        listeners[bucket] = listeners[bucket].filter((entry) => entry !== listener);
      };
    });
  }
  return {
    channels,
    getStatus: jest.fn(() => ({ connectionState: "CONNECTED", authState })),
    connect: jest.fn(),
    disconnect: jest.fn(),
    openChannel: jest.fn(() => {
      const channel = fakeChannel();
      channels.push(channel);
      return channel;
    }),
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

function fakeStorageReader() {
  return {
    readRecent: jest.fn(() => ({ rows: [], available: true })),
    readRecentCandles: jest.fn(() => ({ rows: [], available: true, startsAtRequestedWindow: true })),
    readLargeTrades: jest.fn(() => ({ rows: [], available: true })),
  };
}

const NOW_MS = 1_800_000_000_000;
const VALID_EXPIRES_AT = new Date(NOW_MS + 30 * 60_000).toISOString();

function baseOptions(overrides = {}) {
  return {
    brokerUrl: "https://broker.example.ts.net",
    requestToken: jest.fn(async () => ({ token: "fresh.token", expiresAt: VALID_EXPIRES_AT })),
    now: () => NOW_MS,
    sessionRetryBaseMs: 30_000,
    storageReader: fakeStorageReader(),
    instruments: TEST_INSTRUMENTS,
    ...overrides,
  };
}

async function waitUntilChannelCount(connection, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (connection.channels.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntilChannelCount: never reached ${count} channels`);
}

async function driveToChannelsOpened(connection) {
  connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
  await waitUntilChannelCount(connection, 1);
  await Promise.resolve();
  await Promise.resolve();
  connection.channels[0].emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
}

function selectMessage(symbol, assetClass) {
  return JSON.stringify({ type: "select", symbol, assetClass });
}

async function bootServer(overrides = {}) {
  const connection = fakeConnection();
  const server = createDxFeedEagerMarketDataServer(baseOptions({ ...overrides, createConnection: () => connection }));
  startedServers.push(server);
  server.start();
  await driveToChannelsOpened(connection);
  await Promise.resolve();
  return { connection, server };
}

beforeEach(() => {
  mockDxfeedSnapshotFrame.mockImplementation((...args) => realFrames.dxfeedSnapshotFrame(...args));
});

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.stop()));
});

describe("createDxFeedEagerMarketDataServer -- crash guards (Fix 5)", () => {
  test("REGRESSION: a thrown snapshot build during handleClientConnected drops only the offending client, not the process, and a subsequent client is unaffected", async () => {
    const { server } = await bootServer();
    server.handleClientMessage(selectMessage("/NQZ26:XCME", "FUTURE"), fakeClient());

    mockDxfeedSnapshotFrame.mockImplementationOnce(() => {
      throw new Error("dxfeedSnapshotFrame: trades must be pair-matched and unique");
    });
    const badClient = fakeClient();
    expect(() => server.handleClientConnected(badClient)).not.toThrow();
    expect(badClient.close).toHaveBeenCalledTimes(1);

    const healthyClient = fakeClient();
    expect(() => server.handleClientConnected(healthyClient)).not.toThrow();
    expect(healthyClient.close).not.toHaveBeenCalled();
    expect(healthyClient.send).toHaveBeenCalled();
  });

  test("REGRESSION: a thrown snapshot build aborts the selection commit, and a later retry succeeds cleanly", async () => {
    const { server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    const sentBeforeSwitch = client.send.mock.calls.length;

    mockDxfeedSnapshotFrame.mockImplementationOnce(() => {
      throw new Error("dxfeedSnapshotFrame: trades must be pair-matched and unique");
    });
    expect(() => server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client)).not.toThrow();
    // The switch failed before its selection was committed, so no client can
    // silently move to an identity whose snapshot was never delivered.
    expect(client.close).not.toHaveBeenCalled();
    expect(server.currentSymbolInfo()).toBeNull();

    // With no proven selection yet, another client honestly receives no
    // view. Retrying the same selection after the transient build failure
    // installs it normally for every connected client.
    const secondClient = fakeClient();
    expect(() => server.handleClientConnected(secondClient)).not.toThrow();
    expect(secondClient.send).not.toHaveBeenCalled();
    expect(() => server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client)).not.toThrow();
    expect(server.currentSymbolInfo()).toEqual({ symbol: "AAPL", assetClass: "EQUITY" });
    expect(secondClient.send).toHaveBeenCalled();
    expect(client.send.mock.calls.length).toBeGreaterThanOrEqual(sentBeforeSwitch);
  });
});
describe("createDxFeedEagerMarketDataServer -- crash guards' iceberg store", () => {
  test("a server this suite builds reads its iceberg store from the suite's temp dir, never from the runtime's data root", async () => {
    const history = createIcebergHistory({ maxAgeMs: 7 * 86_400_000 });
    history.record({
      id: "AAPL|seeded", kind: "native", confidence: "certain", side: "bid", price: 230.5, display: 100, tranches: 3, executed: 250,
      startedAt: NOW_MS - 120_000, markedAt: NOW_MS - 110_000, updatedAt: NOW_MS - 60_000, status: "filled", origin: "runtime",
    });
    expect(saveIcebergHistory({ dir: ICEBERG_STORE_DIR, pairKey: "EQUITY:AAPL", savedAt: NOW_MS - 60_000, history: history.toJSON(), cuts: null, coverage: [] }).ok).toBe(true);
    const { server } = await bootServer();
    const client = fakeClient();
    server.handleClientConnected(client);
    server.handleClientMessage(selectMessage("AAPL", "EQUITY"), client);
    server.handleClientMessage(JSON.stringify({ type: "capabilities", iceberg_orders: true }), client);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frames = client.send.mock.calls.map(([payload]) => JSON.parse(payload)).filter((frame) => frame.type === "iceberg_orders");
    expect(frames).toEqual([
      expect.objectContaining({ reset: true, icebergs: [expect.objectContaining({ id: "AAPL|seeded", status: "filled" })] }),
    ]);
  });
});
