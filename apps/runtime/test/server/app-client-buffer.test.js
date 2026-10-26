"use strict";

const mockMarketDataOptions = [];
const mockDxfeedOptions = [];
const mockDxfeedEagerOptions = [];
const mockStub = () => ({ isActive: () => false });

jest.mock("../../src/providers/binance/binance-connection", () => ({ createBinanceConnection: () => ({}) }));
jest.mock("../../src/server/market-data-server", () => ({
  createMarketDataServer: (options) => { mockMarketDataOptions.push(options); return mockStub(); },
}));
jest.mock("../../src/server/dxfeed-market-data-server", () => ({
  createDxFeedMarketDataServer: (options) => { mockDxfeedOptions.push(options); return mockStub(); },
}));
jest.mock("../../src/server/dxfeed-eager-market-data-server", () => ({
  createDxFeedEagerMarketDataServer: (options) => { mockDxfeedEagerOptions.push(options); return mockStub(); },
}));
jest.mock("../../src/server/provider-router", () => ({ createProviderRouter: () => ({}) }));
jest.mock("../../src/storage/storage-reader", () => ({ createStorageReader: () => ({}) }));
jest.mock("../../src/storage/dxfeed/dxfeed-storage-reader", () => ({ createDxFeedStorageReader: () => ({}) }));
jest.mock("../../src/indicators/volume-profile/volume-profile-cache", () => ({ createVolumeProfileCache: () => ({}) }));

const os = require("node:os");
const path = require("node:path");
const { safeRm } = require("../helpers/temp-files");
const { icebergOptionsFromEnv } = require("../../src/indicators/iceberg/iceberg-indicator");
const ICEBERG_STORE_DIR = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "app-client-buffer-icebergs-"));
process.env.L2_ICEBERG_STORE_DIR = ICEBERG_STORE_DIR;
afterAll(() => safeRm(ICEBERG_STORE_DIR, { recursive: true, force: true }));
test("the iceberg store env points at this suite temp dir before any server boots", () => {
  expect(icebergOptionsFromEnv().storeDir).toBe(ICEBERG_STORE_DIR);
});

const { createApp } = require("../../src/server/app");

const BUFFER_KEYS = ["clientBufferSoftBytes", "clientBufferHardBytes", "clientBufferGraceMs"];

describe("createApp client buffer thresholds", () => {
  beforeEach(() => {
    mockMarketDataOptions.length = 0;
    mockDxfeedOptions.length = 0;
    mockDxfeedEagerOptions.length = 0;
  });

  const build = (extra = {}) => createApp({ port: 0, archiveRoute: null, ...extra });

  test("forwards the three thresholds to the Binance and dxFeed servers", () => {
    build({ clientBufferSoftBytes: 1_000, clientBufferHardBytes: 4_000, clientBufferGraceMs: 250 });
    const expected = { clientBufferSoftBytes: 1_000, clientBufferHardBytes: 4_000, clientBufferGraceMs: 250 };
    expect(mockMarketDataOptions[0]).toMatchObject(expected);
    expect(mockDxfeedOptions[0]).toMatchObject(expected);
  });

  test("forwards them to the eager dxFeed server when that variant is selected", () => {
    build({ dxfeedEager: true, clientBufferSoftBytes: 1_000, clientBufferHardBytes: 4_000, clientBufferGraceMs: 250 });
    expect(mockDxfeedEagerOptions[0]).toMatchObject({ clientBufferSoftBytes: 1_000, clientBufferHardBytes: 4_000, clientBufferGraceMs: 250 });
    expect(mockDxfeedOptions).toHaveLength(0);
  });

  test("passes nothing when they are not set, so every server keeps its own defaults", () => {
    build();
    for (const options of [mockMarketDataOptions[0], mockDxfeedOptions[0]]) {
      for (const key of BUFFER_KEYS) expect(Object.hasOwn(options, key)).toBe(false);
    }
  });

  test("passes only the thresholds that were set", () => {
    build({ clientBufferGraceMs: 0 });
    expect(mockMarketDataOptions[0].clientBufferGraceMs).toBe(0);
    expect(Object.hasOwn(mockMarketDataOptions[0], "clientBufferSoftBytes")).toBe(false);
    expect(Object.hasOwn(mockMarketDataOptions[0], "clientBufferHardBytes")).toBe(false);
  });
});
