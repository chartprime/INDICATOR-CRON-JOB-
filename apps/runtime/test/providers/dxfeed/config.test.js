const {
  loadDxFeedConfig,
  isApprovedEndpointModePair,
  REALTIME_ENDPOINT,
  DELAYED_ENDPOINT,
} = require("../../../src/providers/dxfeed/dxfeed-connection-config");

const VALID_TOKEN = "header123.payload456";

function baseEnv(overrides = {}) {
  return {
    DXFEED_ENDPOINT: REALTIME_ENDPOINT,
    DXFEED_TEMP_TOKEN: VALID_TOKEN,
    MARKET_DATA_MODE: "realtime",
    ...overrides,
  };
}

describe("loadDxFeedConfig", () => {
  test("rejects each missing or blank required var by name", () => {
    expect(() => loadDxFeedConfig(baseEnv({ DXFEED_ENDPOINT: undefined }))).toThrow(/DXFEED_ENDPOINT/);
    expect(() => loadDxFeedConfig(baseEnv({ DXFEED_TEMP_TOKEN: "   " }))).toThrow(/DXFEED_TEMP_TOKEN/);
    expect(() => loadDxFeedConfig(baseEnv({ MARKET_DATA_MODE: "" }))).toThrow(/MARKET_DATA_MODE/);
  });

  test("accepts the realtime endpoint/mode pair", () => {
    const config = loadDxFeedConfig(baseEnv());
    expect(config).toEqual({ endpoint: REALTIME_ENDPOINT, marketDataMode: "realtime", tempToken: VALID_TOKEN });
  });

  test("accepts the delayed endpoint/mode pair", () => {
    const config = loadDxFeedConfig(
      baseEnv({ DXFEED_ENDPOINT: DELAYED_ENDPOINT, MARKET_DATA_MODE: "delayed" }),
    );
    expect(config).toEqual({ endpoint: DELAYED_ENDPOINT, marketDataMode: "delayed", tempToken: VALID_TOKEN });
  });

  test("rejects a mismatched endpoint/mode pair", () => {
    expect(() => loadDxFeedConfig(baseEnv({ MARKET_DATA_MODE: "delayed" }))).toThrow(/disagree/);
  });

  test("rejects an unapproved host or path without echoing the raw endpoint", () => {
    expect(() => loadDxFeedConfig(baseEnv({ DXFEED_ENDPOINT: "wss://evil.example.com/dxlink-chartprime" })))
      .toThrow(/unapproved DXFEED_ENDPOINT.*host/);
    expect(() => loadDxFeedConfig(baseEnv({ DXFEED_ENDPOINT: "wss://tools.dxfeed.com/not-a-real-path" })))
      .toThrow(/unapproved DXFEED_ENDPOINT.*path/);
  });

  test("rejects embedded credentials, a query string, or a fragment on an otherwise-approved endpoint", () => {
    expect(() =>
      loadDxFeedConfig(baseEnv({ DXFEED_ENDPOINT: "wss://user:pass@tools.dxfeed.com/dxlink-chartprime" })),
    ).toThrow(/embedded credentials/);
    expect(() =>
      loadDxFeedConfig(baseEnv({ DXFEED_ENDPOINT: "wss://tools.dxfeed.com/dxlink-chartprime?x=1" })),
    ).toThrow(/query string/);
    expect(() =>
      loadDxFeedConfig(baseEnv({ DXFEED_ENDPOINT: "wss://tools.dxfeed.com/dxlink-chartprime#frag" })),
    ).toThrow(/fragment/);
  });

  test("a rejected endpoint error never echoes the raw value", () => {
    try {
      loadDxFeedConfig(baseEnv({ DXFEED_ENDPOINT: "wss://user:pass@tools.dxfeed.com/dxlink-chartprime" }));
      throw new Error("expected loadDxFeedConfig to throw");
    } catch (error) {
      expect(error.message).not.toContain("user:pass");
    }
  });

  test("rejects a malformed token shape without echoing it", () => {
    // Blank/missing tokens are covered separately by the required-vars test
    // above; these are all non-blank but shape-invalid. A single segment
    // with no dot (a raw signing secret, not a finished token -- the real
    // shape mistake found live in this project's own .env) and a
    // three-segment token are both invalid: dxFeed's documented format, and
    // the main repo's own production deployment script
    // (update-runtime-dxfeed-token.sh), both require exactly two segments.
    const attempts = [
      "onlysinglesegmentnodothere",
      "three.segments.here",
      "bad char$.segment",
      "trailing.dot.",
      ".leading.dot",
      "a..b",
      "a".repeat(2049),
    ];
    for (const badToken of attempts) {
      let thrown = null;
      try {
        loadDxFeedConfig(baseEnv({ DXFEED_TEMP_TOKEN: badToken }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown.message).not.toContain(badToken);
      expect(thrown.message).toMatch(/DXFEED_TEMP_TOKEN/);
    }
  });

  test("an invalid endpoint URL string is rejected cleanly", () => {
    expect(() => loadDxFeedConfig(baseEnv({ DXFEED_ENDPOINT: "not a url" }))).toThrow(/invalid DXFEED_ENDPOINT/);
  });
});

describe("isApprovedEndpointModePair", () => {
  test("accepts only the two exact approved pairs", () => {
    expect(isApprovedEndpointModePair(REALTIME_ENDPOINT, "realtime")).toBe(true);
    expect(isApprovedEndpointModePair(DELAYED_ENDPOINT, "delayed")).toBe(true);
    expect(isApprovedEndpointModePair(REALTIME_ENDPOINT, "delayed")).toBe(false);
    expect(isApprovedEndpointModePair(DELAYED_ENDPOINT, "realtime")).toBe(false);
    expect(isApprovedEndpointModePair("wss://tools.dxfeed.com/dxlink-chartprime", "realtime")).toBe(true);
  });
});
