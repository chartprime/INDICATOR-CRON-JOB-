jest.mock("../../../scripts/verify/databento/databento-hist-api", () => ({
  ...jest.requireActual("../../../scripts/verify/databento/databento-hist-api"),
  requestJson: jest.fn(),
}));

const { requestJson } = require("../../../scripts/verify/databento/databento-hist-api");
const { main } = require("../../../scripts/verify/databento/verify-databento-entitlement");

function noopLogger() {
  return { banner: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), ok: jest.fn() };
}

const originalKey = process.env.databento_key;

beforeEach(() => {
  process.env.databento_key = "test-key";
  requestJson.mockReset();
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.databento_key;
  else process.env.databento_key = originalKey;
});

describe("verify-databento-entitlement", () => {
  test("a transient metadata.get_cost failure aborts the run instead of being recorded as a confirmed free day", async () => {
    requestJson.mockImplementation((key, method) => {
      if (method === "metadata.get_dataset_range") {
        return Promise.resolve({ status: 200, body: { start: "2020-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z" } });
      }
      // Every metadata.get_cost lookup fails, e.g. a transient rate limit.
      return Promise.resolve({ status: 429, body: null });
    });
    const logger = noopLogger();
    const exit = jest.fn();

    await main({ logger, exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      "boundary search aborted -- a metadata.get_cost call did not return a trustworthy result",
      expect.objectContaining({ dataset: expect.any(String), reason: expect.stringContaining("HTTP 429") }),
    );
    // The failure must stop before ever concluding a schema is confirmed free/paid.
    expect(logger.ok.mock.calls.map(([message]) => message)).not.toContain("entitlement boundary search complete");
  });
});
