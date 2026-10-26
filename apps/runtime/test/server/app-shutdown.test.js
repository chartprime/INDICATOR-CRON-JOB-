const mockBinance = { start: jest.fn(), stop: jest.fn() };
const mockDxfeed = { start: jest.fn(), stop: jest.fn() };
const mockReader = { close: jest.fn() };
const mockDxReader = { close: jest.fn() };
const mockCache = { close: jest.fn() };

jest.mock("../../src/providers/binance/binance-connection", () => ({ createBinanceConnection: () => ({}) }));
jest.mock("../../src/server/market-data-server", () => ({ createMarketDataServer: () => mockBinance }));
jest.mock("../../src/server/dxfeed-market-data-server", () => ({ createDxFeedMarketDataServer: () => mockDxfeed }));
jest.mock("../../src/server/provider-router", () => ({ createProviderRouter: () => ({}) }));
jest.mock("../../src/storage/storage-reader", () => ({ createStorageReader: () => mockReader }));
jest.mock("../../src/storage/dxfeed/dxfeed-storage-reader", () => ({ createDxFeedStorageReader: () => mockDxReader }));
jest.mock("../../src/indicators/volume-profile/volume-profile-cache", () => ({ createVolumeProfileCache: () => mockCache }));

const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../helpers/temp-files");
const { icebergOptionsFromEnv } = require("../../src/indicators/iceberg/iceberg-indicator");
const ICEBERG_STORE_DIR = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "app-shutdown-icebergs-"));
process.env.L2_ICEBERG_STORE_DIR = ICEBERG_STORE_DIR;
afterAll(() => safeRm(ICEBERG_STORE_DIR, { recursive: true, force: true }));
test("the iceberg store env points at this suite temp dir before any server boots", () => {
  expect(icebergOptionsFromEnv().storeDir).toBe(ICEBERG_STORE_DIR);
});

const { createApp } = require("../../src/server/app");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // The baseline discards this promise; keep the red test's rejection controlled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

describe("app shutdown completion contract (loopback transport, fake resource owners)", () => {
  let app;
  beforeEach(async () => {
    jest.resetAllMocks();
    app = createApp({ port: 0, dxfeedBrokerUrl: "" });
    await app.start();
  });
  afterEach(async () => { await app.stop().catch(() => {}); });

  test("waits for asynchronous reader teardown and shares completion across repeated stop", async () => {
    const close = deferred();
    mockDxReader.close.mockReturnValue(close.promise);
    const stop = app.stop();
    let settled = false;
    stop.then(() => { settled = true; });
    try {
      await tick();
      expect(settled).toBe(false);
      expect(app.stop()).toBe(stop);
      expect(mockDxReader.close).toHaveBeenCalledTimes(1);
    } finally {
      close.resolve();
      await stop;
    }
    expect(app.httpServer.listening).toBe(false);
  });

  test("quiesces asynchronous providers before closing the stores they can still use", async () => {
    const provider = deferred();
    mockBinance.stop.mockReturnValue(provider.promise);
    const stop = app.stop();
    try {
      await tick();
      expect(mockReader.close).not.toHaveBeenCalled();
      expect(mockCache.close).not.toHaveBeenCalled();
    } finally {
      provider.resolve();
      await stop;
    }
    expect(mockReader.close).toHaveBeenCalledTimes(1);
    expect(mockCache.close).toHaveBeenCalledTimes(1);
  });

  test("aggregates synchronous and asynchronous failures after all cleanup attempts finish", async () => {
    const failure = new Error("provider cleanup failed");
    const readerFailure = new Error("reader cleanup failed");
    const cache = deferred();
    const reader = deferred();
    mockBinance.stop.mockImplementation(() => { throw failure; });
    mockReader.close.mockReturnValue(reader.promise);
    mockCache.close.mockReturnValue(cache.promise);
    const stop = app.stop();
    const outcome = stop.then(() => null, (error) => error);
    let settled = false;
    outcome.then(() => { settled = true; });
    let earlySettlement;
    try {
      reader.reject(readerFailure);
      await tick();
      earlySettlement = settled;
    } finally {
      cache.resolve();
    }
    const error = await outcome;
    expect(earlySettlement).toBe(false);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual(expect.arrayContaining([failure, readerFailure]));
    expect(mockDxfeed.stop).toHaveBeenCalledTimes(1);
    expect(mockDxReader.close).toHaveBeenCalledTimes(1);
    expect(mockCache.close).toHaveBeenCalledTimes(1);
    expect(app.stop()).toBe(stop);
    expect(app.httpServer.listening).toBe(false);
  });

  test("publishes the shared stop promise before an owner can reenter shutdown", async () => {
    let reentered;
    mockBinance.stop.mockImplementationOnce(() => { reentered = app.stop(); });
    const stop = app.stop();
    await stop;
    expect(reentered).toBe(stop);
    expect(mockBinance.stop).toHaveBeenCalledTimes(1);
    expect(mockReader.close).toHaveBeenCalledTimes(1);
  });

  test("stop during the initial HTTP bind cannot leave a late listening socket", async () => {
    await app.stop();
    app = createApp({ port: 0, dxfeedBrokerUrl: "" });
    const startup = app.start().then(() => null, (error) => error);
    const stop = app.stop();
    try {
      expect(await startup).toBeInstanceOf(Error);
      await stop;
      expect(app.httpServer.listening).toBe(false);
    } finally {
      // Release only this fixture's socket if the baseline resurrects it.
      if (app.httpServer.listening) await new Promise((resolve) => app.httpServer.close(resolve));
    }
  });

  test("a thrown HTTP close still waits for reader cleanup and reports the failure", async () => {
    const reader = deferred();
    const failure = new Error("HTTP close failed");
    mockDxReader.close.mockReturnValue(reader.promise);
    const close = jest.spyOn(app.httpServer, "close").mockImplementation(() => { throw failure; });
    const outcome = app.stop().then(() => null, (error) => error);
    let settled = false;
    outcome.then(() => { settled = true; });
    try {
      await tick();
      expect(settled).toBe(false);
      expect(mockDxReader.close).toHaveBeenCalledTimes(1);
    } finally {
      reader.resolve();
      close.mockRestore();
      if (app.httpServer.listening) await new Promise((resolve) => app.httpServer.close(resolve));
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(failure);
  });
});
