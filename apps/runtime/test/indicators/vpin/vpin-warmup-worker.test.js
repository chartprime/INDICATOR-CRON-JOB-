jest.mock("../../../src/storage/storage-reader", () => ({ createStorageReader: jest.fn() }));
jest.mock("../../../src/storage/remote-storage-reader", () => ({ createRemoteStorageReader: jest.fn() }));
jest.mock("../../../src/storage/dxfeed/dxfeed-storage-reader", () => ({ createDxFeedStorageReader: jest.fn() }));
jest.mock("../../../src/storage/dxfeed/remote-dxfeed-storage-reader", () => ({ createRemoteDxFeedStorageReader: jest.fn() }));
jest.mock("../../../src/indicators/volume-profile/volume-profile-adapters", () => ({
  createBinanceVolumeProfileAdapter: jest.fn(),
  createDxFeedVolumeProfileAdapter: jest.fn(),
}));
jest.mock("../../../src/indicators/vpin/vpin-session", () => ({
  VPIN_BACKFILL_MODES: jest.requireActual("../../../src/indicators/vpin/vpin-session").VPIN_BACKFILL_MODES,
  deriveDailyVolumesUsd: jest.fn(),
  createVpinSession: jest.fn(),
  seedSessionFromBackfill: jest.fn(),
  calibrateVBucket: jest.fn(),
}));

const { createStorageReader } = require("../../../src/storage/storage-reader");
const { createRemoteStorageReader } = require("../../../src/storage/remote-storage-reader");
const { createDxFeedStorageReader } = require("../../../src/storage/dxfeed/dxfeed-storage-reader");
const { createRemoteDxFeedStorageReader } = require("../../../src/storage/dxfeed/remote-dxfeed-storage-reader");
const {
  createBinanceVolumeProfileAdapter,
  createDxFeedVolumeProfileAdapter,
} = require("../../../src/indicators/volume-profile/volume-profile-adapters");
const {
  deriveDailyVolumesUsd,
  createVpinSession,
  seedSessionFromBackfill,
  calibrateVBucket,
} = require("../../../src/indicators/vpin/vpin-session");
const { assertWorkerInput, run } = require("../../../src/indicators/vpin/vpin-warmup-worker");

// A2.19 / L1L2-V2-058. This 91-line worker owns provider selection, adapter
// construction, calibration, session creation, backfill seeding and reader
// cleanup, and had no test file -- vpin-warmup.test.js covers the launcher
// only. openAdapter is the single place both providers' readers are built for
// warm-up, so a fault there is provider-wide rather than provider-specific.

function binanceInput(overrides = {}) {
  return {
    provider: "binance",
    dbPath: "/tmp/binance.sqlite",
    symbol: "BTCUSDT",
    marketKind: "SPOT",
    tickSize: 0.1,
    nowMs: 1_700_000_000_000,
    calibrationWindowMs: 86_400_000,
    backfillWindowMs: 3_600_000,
    ...overrides,
  };
}

function dxfeedInput(overrides = {}) {
  return {
    provider: "dxfeed",
    dbPath: "/tmp/dxfeed.sqlite",
    symbol: "/NQ",
    assetClass: "FUTURE",
    tickSize: 0.25,
    nowMs: 1_700_000_000_000,
    calibrationWindowMs: 86_400_000,
    backfillWindowMs: 3_600_000,
    ...overrides,
  };
}

function omitDbPath(input) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== "dbPath"));
}

describe("assertWorkerInput", () => {
  test("accepts a well-formed input for either provider", () => {
    expect(() => assertWorkerInput(binanceInput())).not.toThrow();
    expect(() => assertWorkerInput(dxfeedInput())).not.toThrow();
  });

  test("requires workerData to be an object", () => {
    for (const bad of [null, undefined, "", 0, "binance"]) {
      expect(() => assertWorkerInput(bad)).toThrow(/workerData is required/);
    }
  });

  test("defaults an absent provider to binance rather than rejecting it", () => {
    const { provider, ...withoutProvider } = binanceInput();
    expect(provider).toBe("binance");
    expect(() => assertWorkerInput(withoutProvider)).not.toThrow();
  });

  test("rejects a provider outside the supported pair", () => {
    for (const bad of ["databento", "BINANCE", "dx-feed", ""]) {
      expect(() => assertWorkerInput(binanceInput({ provider: bad }))).toThrow(/provider must be/);
    }
  });

  test("rejects a missing or empty symbol", () => {
    for (const bad of [undefined, null, "", 42]) {
      expect(() => assertWorkerInput(binanceInput({ symbol: bad })))
        .toThrow(/symbol must be a non-empty string/);
    }
  });

  test("a binance input with neither dbPath nor remote is rejected", () => {
    for (const bad of [undefined, null, "", 42]) {
      expect(() => assertWorkerInput(binanceInput({ dbPath: bad })))
        .toThrow(/either dbPath or remote must be provided/);
    }
  });

  test("a binance input accepts remote in place of dbPath", () => {
    const withoutDbPath = omitDbPath(binanceInput());
    expect(() => assertWorkerInput({
      ...withoutDbPath,
      remote: { baseUrl: "http://10.88.0.1:8003", token: "tok" },
    })).not.toThrow();
  });

  test("a remote missing baseUrl or token does not count as configured", () => {
    const withoutDbPath = omitDbPath(binanceInput());
    expect(() => assertWorkerInput({ ...withoutDbPath, remote: { token: "tok" } }))
      .toThrow(/either dbPath or remote must be provided/);
    expect(() => assertWorkerInput({ ...withoutDbPath, remote: { baseUrl: "http://x" } }))
      .toThrow(/either dbPath or remote must be provided/);
  });

  test("a dxfeed input accepts remote in place of dbPath, same as binance", () => {
    const withoutDbPath = omitDbPath(dxfeedInput());
    expect(() => assertWorkerInput({
      ...withoutDbPath,
      remote: { baseUrl: "http://10.88.0.1:8003", token: "tok" },
    })).not.toThrow();
  });

  test("a dxfeed remote missing baseUrl or token does not count as configured", () => {
    const withoutDbPath = omitDbPath(dxfeedInput());
    expect(() => assertWorkerInput({ ...withoutDbPath, remote: { token: "tok" } }))
      .toThrow(/either dbPath or remote must be provided/);
    expect(() => assertWorkerInput({ ...withoutDbPath, remote: { baseUrl: "http://x" } }))
      .toThrow(/either dbPath or remote must be provided/);
  });

  // The identity field differs by provider, so a dxFeed input carrying
  // marketKind instead of assetClass is silently wrong unless this is checked.
  test("requires marketKind for binance and assetClass for dxfeed, not the other way round", () => {
    expect(() => assertWorkerInput(binanceInput({ marketKind: undefined })))
      .toThrow(/marketKind must be a non-empty string/);
    expect(() => assertWorkerInput(dxfeedInput({ assetClass: undefined })))
      .toThrow(/assetClass must be a non-empty string/);

    const { assetClass, ...dxWithoutAssetClass } = dxfeedInput();
    expect(assetClass).toBe("FUTURE");
    expect(() => assertWorkerInput({ ...dxWithoutAssetClass, marketKind: "FUTURE" }))
      .toThrow(/assetClass must be a non-empty string/);
  });

  test.each(["tickSize", "nowMs", "calibrationWindowMs", "backfillWindowMs"])(
    "rejects a non-positive or non-finite %s",
    (field) => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined]) {
        expect(() => assertWorkerInput(binanceInput({ [field]: bad })))
          .toThrow(new RegExp(`${field} must be a positive finite number`));
      }
    },
  );
});

describe("run", () => {
  let reader;

  beforeEach(() => {
    jest.clearAllMocks();
    reader = { close: jest.fn() };
    createStorageReader.mockReturnValue(reader);
    createRemoteStorageReader.mockReturnValue(reader);
    createDxFeedStorageReader.mockReturnValue(reader);
    createRemoteDxFeedStorageReader.mockReturnValue(reader);
    createBinanceVolumeProfileAdapter.mockReturnValue({ kind: "binance-adapter" });
    createDxFeedVolumeProfileAdapter.mockReturnValue({ kind: "dxfeed-adapter" });
    deriveDailyVolumesUsd.mockReturnValue([1_000_000, 2_000_000]);
    calibrateVBucket.mockReturnValue(50_000);
    createVpinSession.mockReturnValue({
      vpinState: { value: 0.4 },
      history: [{ ts: 1, value: 0.4 }],
      pollFromTs: 123,
      pollCursor: 456,
    });
    seedSessionFromBackfill.mockReturnValue({ tradesApplied: 900, pagesFetched: 3, complete: true });
  });

  test("binance opens the binance reader and adapter, never the dxfeed pair", async () => {
    await run(binanceInput());

    expect(createStorageReader).toHaveBeenCalledWith({ dbPath: "/tmp/binance.sqlite", timeoutMs: 2_000 });
    expect(createBinanceVolumeProfileAdapter).toHaveBeenCalledWith(reader, "BTCUSDT", "SPOT");
    expect(createDxFeedStorageReader).not.toHaveBeenCalled();
    expect(createDxFeedVolumeProfileAdapter).not.toHaveBeenCalled();
  });

  test("binance with a remote config opens the remote reader, never the local one", async () => {
    const withoutDbPath = omitDbPath(binanceInput());
    await run({ ...withoutDbPath, remote: { baseUrl: "http://10.88.0.1:8003", token: "tok" } });

    expect(createRemoteStorageReader).toHaveBeenCalledWith({ baseUrl: "http://10.88.0.1:8003", token: "tok", timeoutMs: undefined });
    expect(createBinanceVolumeProfileAdapter).toHaveBeenCalledWith(reader, "BTCUSDT", "SPOT");
    expect(createStorageReader).not.toHaveBeenCalled();
  });

  test("binance prefers an explicit remote config over dbPath when both are present", async () => {
    await run({ ...binanceInput(), remote: { baseUrl: "http://10.88.0.1:8003", token: "tok" } });

    expect(createRemoteStorageReader).toHaveBeenCalledWith({ baseUrl: "http://10.88.0.1:8003", token: "tok", timeoutMs: undefined });
    expect(createStorageReader).not.toHaveBeenCalled();
  });

  test("dxfeed opens the dxfeed reader and adapter, never the binance pair", async () => {
    await run(dxfeedInput());

    expect(createDxFeedStorageReader).toHaveBeenCalledWith({ dbPath: "/tmp/dxfeed.sqlite", timeoutMs: 2_000 });
    expect(createDxFeedVolumeProfileAdapter).toHaveBeenCalledWith(reader, "/NQ", "FUTURE");
    expect(createStorageReader).not.toHaveBeenCalled();
    expect(createBinanceVolumeProfileAdapter).not.toHaveBeenCalled();
    expect(createRemoteDxFeedStorageReader).not.toHaveBeenCalled();
  });

  test("dxfeed with a remote config opens the remote dxfeed reader, never the local one", async () => {
    const withoutDbPath = omitDbPath(dxfeedInput());
    await run({ ...withoutDbPath, remote: { baseUrl: "http://10.88.0.1:8003", token: "tok" } });

    expect(createRemoteDxFeedStorageReader).toHaveBeenCalledWith({ baseUrl: "http://10.88.0.1:8003", token: "tok", timeoutMs: undefined });
    expect(createDxFeedVolumeProfileAdapter).toHaveBeenCalledWith(reader, "/NQ", "FUTURE");
    expect(createDxFeedStorageReader).not.toHaveBeenCalled();
  });

  test("dxfeed prefers an explicit remote config over dbPath when both are present", async () => {
    await run({ ...dxfeedInput(), remote: { baseUrl: "http://10.88.0.1:8003", token: "tok" } });

    expect(createRemoteDxFeedStorageReader).toHaveBeenCalledWith({ baseUrl: "http://10.88.0.1:8003", token: "tok", timeoutMs: undefined });
    expect(createDxFeedStorageReader).not.toHaveBeenCalled();
  });

  test("an absent provider warms up binance, matching assertWorkerInput's default", async () => {
    const { provider, ...withoutProvider } = binanceInput();
    expect(provider).toBe("binance");

    await run(withoutProvider);

    expect(createStorageReader).toHaveBeenCalledTimes(1);
    expect(createDxFeedStorageReader).not.toHaveBeenCalled();
  });

  test("an explicit timeoutMs overrides the default on both providers", async () => {
    await run(binanceInput({ timeoutMs: 9_000 }));
    expect(createStorageReader).toHaveBeenCalledWith({ dbPath: "/tmp/binance.sqlite", timeoutMs: 9_000 });

    await run(dxfeedInput({ timeoutMs: 9_000 }));
    expect(createDxFeedStorageReader).toHaveBeenCalledWith({ dbPath: "/tmp/dxfeed.sqlite", timeoutMs: 9_000 });
  });

  test("validates before opening anything, so a bad input cannot leak a reader", async () => {
    await expect(run(binanceInput({ symbol: "" }))).rejects.toThrow(/symbol must be a non-empty string/);
    expect(createStorageReader).not.toHaveBeenCalled();
    expect(createDxFeedStorageReader).not.toHaveBeenCalled();
  });

  // Property: the calibration window ends on the hour, so repeated warm-ups
  // within an hour ask the host for the identical daily-notional window and
  // share its cached read, without the route rewriting anyone's window.
  // Oracle: the exact window passed to deriveDailyVolumesUsd.
  test("calibrates over an hour-aligned window ending at or before nowMs, floored at zero", async () => {
    const hour = 60 * 60 * 1_000;
    await run(binanceInput({ nowMs: 3 * hour + 299_999, calibrationWindowMs: 9_000 }));
    expect(deriveDailyVolumesUsd).toHaveBeenLastCalledWith({
      adapter: { kind: "binance-adapter" },
      tickSize: 0.1,
      fromTs: 3 * hour - 9_000,
      toTs: 3 * hour,
    });

    await run(binanceInput({ nowMs: 5_000, calibrationWindowMs: 9_000 }));
    expect(deriveDailyVolumesUsd).toHaveBeenLastCalledWith(expect.objectContaining({ fromTs: 0, toTs: 0 }));
  });

  test("seeds the backfill from nowMs minus the backfill window, floored at zero", async () => {
    await run(binanceInput({ nowMs: 1_000, backfillWindowMs: 4_000 }));

    expect(seedSessionFromBackfill).toHaveBeenCalledWith(expect.anything(), 0, 1_000, {});
  });

  // Property: the server's backfill plan reaches the session untouched, so a
  // remote warm-up runs sliced with the geometry it was given and a local one
  // stays exact. Oracle: the options object seedSessionFromBackfill receives.
  test("passes the backfill mode and sliced geometry through to the session, and validates them", async () => {
    await run(binanceInput({ backfillMode: "SLICED_APPROXIMATE", backfillSliceMs: 2_000, backfillChunkMs: 21_600_000 }));
    expect(seedSessionFromBackfill).toHaveBeenLastCalledWith(
      expect.anything(), expect.any(Number), expect.any(Number),
      { backfillMode: "SLICED_APPROXIMATE", sliceMs: 2_000, chunkMs: 21_600_000 },
    );
    await run(binanceInput({ backfillMode: "EXACT" }));
    expect(seedSessionFromBackfill).toHaveBeenLastCalledWith(expect.anything(), expect.any(Number), expect.any(Number), { backfillMode: "EXACT" });
    expect(() => assertWorkerInput(binanceInput({ backfillMode: "GUESS" }))).toThrow(/backfillMode/);
    expect(() => assertWorkerInput(binanceInput({ backfillSliceMs: 0 }))).toThrow(/backfillSliceMs/);
    expect(() => assertWorkerInput(binanceInput({ backfillChunkMs: 1.5 }))).toThrow(/backfillChunkMs/);
  });

  test("reports the session's own reason and slice counts when a sliced backfill cannot complete, and the counts when it can", async () => {
    seedSessionFromBackfill.mockReturnValueOnce({ tradesApplied: 12, pagesFetched: 0, slicesRead: 40, chunksRead: 1, complete: false, reason: "SLICED_UNAVAILABLE" });
    await expect(run(binanceInput())).resolves.toMatchObject({
      available: false, reason: "SLICED_UNAVAILABLE", tradesApplied: 12, slicesRead: 40, chunksRead: 1,
    });
    seedSessionFromBackfill.mockReturnValueOnce({ tradesApplied: 900, pagesFetched: 3, complete: false });
    await expect(run(binanceInput())).resolves.toMatchObject({ available: false, reason: "BACKFILL_INCOMPLETE" });
    seedSessionFromBackfill.mockReturnValueOnce({ tradesApplied: 5_000, pagesFetched: 0, slicesRead: 10_800, chunksRead: 28, complete: true });
    await expect(run(binanceInput())).resolves.toMatchObject({ available: true, slicesRead: 10_800, chunksRead: 28 });
  });

  test("reports the calibrated session, not just that it ran", async () => {
    const result = await run(binanceInput());

    expect(result).toMatchObject({
      available: true,
      vBucket: 50_000,
      vpinState: { value: 0.4 },
      history: [{ ts: 1, value: 0.4 }],
      pollFromTs: 123,
      pollCursor: 456,
      tradesApplied: 900,
      pagesFetched: 3,
    });
    expect(Number.isFinite(result.durationMs)).toBe(true);
  });

  // Reporting unavailable is how the caller knows to fall back to a cold start.
  // Returning available:true with an uncalibrated bucket would warm up VPIN
  // with a meaningless threshold instead.
  test("reports STORAGE_UNAVAILABLE when calibration has no volume to work from", async () => {
    deriveDailyVolumesUsd.mockReturnValue(null);

    const result = await run(binanceInput());

    expect(result).toMatchObject({ available: false, reason: "STORAGE_UNAVAILABLE" });
    expect(calibrateVBucket).not.toHaveBeenCalled();
    expect(createVpinSession).not.toHaveBeenCalled();
  });

  test.each([
    ["a successful warm-up", () => {}],
    ["an unavailable warm-up", () => deriveDailyVolumesUsd.mockReturnValue(null)],
  ])("closes the reader after %s", async (_label, arrange) => {
    arrange();
    await run(binanceInput());
    expect(reader.close).toHaveBeenCalledTimes(1);
  });

  // The worker runs in a thread whose only exit is postMessage; a reader left
  // open on the failure path holds a file handle on a 30+GB database.
  test.each([
    ["calibration", deriveDailyVolumesUsd],
    ["session creation", createVpinSession],
    ["backfill seeding", seedSessionFromBackfill],
  ])("closes the reader when %s throws", async (_label, failing) => {
    failing.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(run(binanceInput())).rejects.toThrow("boom");
    expect(reader.close).toHaveBeenCalledTimes(1);
  });

  test("passes engineOptions through, defaulting to an empty object", async () => {
    await run(binanceInput({ engineOptions: { bucketCount: 50 } }));
    expect(createVpinSession).toHaveBeenCalledWith(expect.objectContaining({ engineOptions: { bucketCount: 50 } }));

    await run(binanceInput());
    expect(createVpinSession).toHaveBeenLastCalledWith(expect.objectContaining({ engineOptions: {} }));
  });
});
