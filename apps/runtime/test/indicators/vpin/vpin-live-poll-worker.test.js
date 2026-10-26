jest.mock("../../../src/storage/storage-reader", () => ({ createStorageReader: jest.fn() }));
jest.mock("../../../src/storage/remote-storage-reader", () => ({ createRemoteStorageReader: jest.fn() }));
jest.mock("../../../src/storage/dxfeed/dxfeed-storage-reader", () => ({ createDxFeedStorageReader: jest.fn() }));
jest.mock("../../../src/storage/dxfeed/remote-dxfeed-storage-reader", () => ({ createRemoteDxFeedStorageReader: jest.fn() }));
jest.mock("../../../src/indicators/volume-profile/volume-profile-adapters", () => ({
  createBinanceVolumeProfileAdapter: jest.fn(),
  createDxFeedVolumeProfileAdapter: jest.fn(),
}));
jest.mock("../../../src/indicators/vpin/vpin-session", () => ({
  createVpinSession: jest.fn(),
  pollLive: jest.fn(),
}));

const { createStorageReader } = require("../../../src/storage/storage-reader");
const { createRemoteStorageReader } = require("../../../src/storage/remote-storage-reader");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { createRemoteDxFeedStorageReader } = require("../../../src/storage/dxfeed/remote-dxfeed-storage-reader");
const { createBinanceVolumeProfileAdapter, createDxFeedVolumeProfileAdapter } = require("../../../src/indicators/volume-profile/volume-profile-adapters");
const { createVpinSession, pollLive } = require("../../../src/indicators/vpin/vpin-session");
const { assertWorkerInput, run } = require("../../../src/indicators/vpin/vpin-live-poll-worker");

function binanceInput(overrides = {}) {
  return {
    provider: "binance", dbPath: "/tmp/binance.sqlite", symbol: "BTCUSDT", marketKind: "PERPETUAL",
    vpinState: { sealer: { vBucket: 50_000 } }, pollFromTs: 100, pollCursor: null, nowMs: 200,
    ...overrides,
  };
}

function dxfeedInput(overrides = {}) {
  return {
    provider: "dxfeed", dbPath: "/tmp/dxfeed.sqlite", symbol: "AAPL", assetClass: "EQUITY",
    vpinState: { sealer: { vBucket: 50_000 } }, pollFromTs: 100, pollCursor: null, nowMs: 200,
    ...overrides,
  };
}

function omitDbPath(input) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== "dbPath"));
}

describe("server/vpin-live-poll-worker", () => {
  let reader;

  beforeEach(() => {
    jest.clearAllMocks();
    reader = { close: jest.fn() };
    createStorageReader.mockReturnValue(reader);
    createRemoteStorageReader.mockReturnValue(reader);
    createDxFeedStorageReader.mockReturnValue(reader);
    createRemoteDxFeedStorageReader.mockReturnValue(reader);
    createBinanceVolumeProfileAdapter.mockReturnValue({ kind: "binance" });
    createDxFeedVolumeProfileAdapter.mockReturnValue({ kind: "dxfeed" });
    createVpinSession.mockImplementation(({ adapter, vBucket, nowMs }) => ({
      adapter, vpinState: { sealer: { vBucket } }, pollFromTs: nowMs, pollCursor: null, history: [],
    }));
    pollLive.mockImplementation((session) => {
      session.vpinState.lastSealTs = 150;
      session.pollCursor = { ts: 150, id: 3 };
      return { readings: [{ sealTs: 150 }], tradesApplied: 3, sealedCount: 1, pagesFetched: 1 };
    });
  });

  test("opens the correct provider-local reader and returns the worker-owned state/cursor", async () => {
    const input = binanceInput();
    const result = await run(input);
    expect(createStorageReader).toHaveBeenCalledWith({ dbPath: input.dbPath, timeoutMs: 2_000 });
    expect(createBinanceVolumeProfileAdapter).toHaveBeenCalledWith(reader, input.symbol, input.marketKind);
    expect(createDxFeedStorageReader).not.toHaveBeenCalled();
    expect(createVpinSession).toHaveBeenCalledWith(expect.objectContaining({ vBucket: 50_000, nowMs: 100 }));
    expect(pollLive).toHaveBeenCalledWith(expect.any(Object), 200, {});
    expect(result).toEqual(expect.objectContaining({ pollFromTs: 100, pollCursor: { ts: 150, id: 3 }, readings: [{ sealTs: 150 }] }));
    expect(result.vpinState.lastSealTs).toBe(150);
    expect(reader.close).toHaveBeenCalledTimes(1);
  });

  test("selects the dxFeed reader/asset-class adapter", async () => {
    const input = dxfeedInput();
    await run(input);
    expect(createDxFeedStorageReader).toHaveBeenCalledWith({ dbPath: input.dbPath, timeoutMs: 2_000 });
    expect(createDxFeedVolumeProfileAdapter).toHaveBeenCalledWith(reader, input.symbol, input.assetClass);
    expect(createStorageReader).not.toHaveBeenCalled();
    expect(createRemoteDxFeedStorageReader).not.toHaveBeenCalled();
  });

  test("dxfeed with a remote config opens the remote dxfeed reader instead of the local one", async () => {
    const withoutDbPath = omitDbPath(dxfeedInput());
    const input = { ...withoutDbPath, remote: { baseUrl: "http://10.88.0.1:8003", token: "tok" } };
    expect(() => assertWorkerInput(input)).not.toThrow();
    await run(input);
    expect(createRemoteDxFeedStorageReader).toHaveBeenCalledWith({ baseUrl: "http://10.88.0.1:8003", token: "tok", timeoutMs: undefined });
    expect(createDxFeedStorageReader).not.toHaveBeenCalled();
  });

  test("rejects invalid input before opening a database", async () => {
    expect(() => assertWorkerInput(binanceInput({ nowMs: 99 }))).toThrow(/not be before/);
    expect(() => assertWorkerInput(binanceInput({ pollCursor: { ts: 1 } }))).toThrow(/pollCursor/);
    await expect(run(binanceInput({ vpinState: {} }))).rejects.toThrow(/vpinState/);
    expect(createStorageReader).not.toHaveBeenCalled();
  });

  test("binance with a remote config opens the remote reader instead of the local one", async () => {
    const withoutDbPath = omitDbPath(binanceInput());
    const input = { ...withoutDbPath, remote: { baseUrl: "http://10.88.0.1:8003", token: "tok" } };
    expect(() => assertWorkerInput(input)).not.toThrow();
    await run(input);
    expect(createRemoteStorageReader).toHaveBeenCalledWith({ baseUrl: "http://10.88.0.1:8003", token: "tok", timeoutMs: undefined });
    expect(createStorageReader).not.toHaveBeenCalled();
  });

  test("a binance input with neither dbPath nor remote is rejected", () => {
    const withoutDbPath = omitDbPath(binanceInput());
    expect(() => assertWorkerInput(withoutDbPath)).toThrow(/either dbPath or remote must be provided/);
  });

  test("a dxfeed input with neither dbPath nor remote is rejected", () => {
    const withoutDbPath = omitDbPath(dxfeedInput());
    expect(() => assertWorkerInput(withoutDbPath)).toThrow(/either dbPath or remote must be provided/);
  });
});
