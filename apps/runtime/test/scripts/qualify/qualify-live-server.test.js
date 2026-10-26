const { resolveEndpoints, DEFAULT_WS_URL } = require("../../../scripts/qualify/qualify-live-server");

// A2.19 / L1L2-V2-094. This harness drives a running server across BOTH
// providers, dxFeed included, and it called main() unconditionally at require
// time -- so merely loading the file attempted live WebSocket connections, and
// against a running server that meant opening a dxFeed session nobody asked
// for. That sits badly against the standing CME constraint that live connects
// are deliberate and minimal. The run is now behind require.main, which is
// what lets this file exist; the live orchestration itself still needs a real
// server and is deliberately not simulated here.

describe("resolveEndpoints", () => {
  test("defaults to the local dev server both scripts and docs assume", () => {
    expect(resolveEndpoints(undefined)).toEqual({
      wsUrl: DEFAULT_WS_URL,
      httpUrl: "http://127.0.0.1:8001/health",
    });
  });

  test("derives the health endpoint from an explicit ws url, preserving host and port", () => {
    expect(resolveEndpoints("ws://127.0.0.1:9100/ws").httpUrl).toBe("http://127.0.0.1:9100/health");
    expect(resolveEndpoints("ws://localhost:8001/ws").httpUrl).toBe("http://localhost:8001/health");
  });

  // wss must map to https, not http: downgrading would send the health probe
  // in the clear and, behind a tunnel, simply fail to connect.
  test("maps a secure ws url to https rather than downgrading it", () => {
    expect(resolveEndpoints("wss://demo.ngrok.app/ws").httpUrl).toBe("https://demo.ngrok.app/health");
  });

  test("replaces the path with /health rather than appending to it", () => {
    expect(resolveEndpoints("ws://127.0.0.1:8001/some/deep/path").httpUrl).toBe("http://127.0.0.1:8001/health");
  });

  test("keeps the ws url it was given for the socket connection", () => {
    expect(resolveEndpoints("ws://127.0.0.1:9100/ws").wsUrl).toBe("ws://127.0.0.1:9100/ws");
  });

  // An http:// argument would previously become "httpp://..." through the
  // ^ws replacement and fail somewhere further along; rejecting it names the
  // mistake at the point the operator made it.
  test.each(["http://127.0.0.1:8001/ws", "127.0.0.1:8001", "", "ftp://host/ws"])(
    "rejects %p rather than deriving a nonsense health url",
    (bad) => {
      expect(() => resolveEndpoints(bad)).toThrow(/must start with ws:\/\/ or wss:\/\//);
    },
  );

  test("rejects a non-string argument", () => {
    expect(() => resolveEndpoints(8001)).toThrow(/must start with ws:\/\/ or wss:\/\//);
  });
});
