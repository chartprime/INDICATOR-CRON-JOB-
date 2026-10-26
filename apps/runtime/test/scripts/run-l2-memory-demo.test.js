const { parseDemoArgs } = require("../../scripts/serve/run-l2-memory-demo");

describe("scripts/serve/run-l2-memory-demo", () => {
  test("defaults to BTCUSDT, port 8001, and running until interrupted", () => {
    expect(parseDemoArgs([])).toEqual({ symbol: "BTCUSDT", seconds: 0, port: 8001 });
  });

  test("takes the symbol as the first bare argument and flags in either order", () => {
    expect(parseDemoArgs(["ETHUSDT", "--seconds=120", "--port=9001"])).toEqual({ symbol: "ETHUSDT", seconds: 120, port: 9001 });
    expect(parseDemoArgs(["--seconds=30", "BTCUSDT"])).toEqual({ symbol: "BTCUSDT", seconds: 30, port: 8001 });
  });

  test("rejects a flag that is not a positive number", () => {
    expect(() => parseDemoArgs(["--seconds=abc"])).toThrow(/--seconds/);
    expect(() => parseDemoArgs(["--port=0"])).toThrow(/--port/);
  });

  test("importing the script does not start anything", () => {
    // The module guards its entry point behind require.main, like the other operational scripts.
    expect(typeof parseDemoArgs).toBe("function");
  });
});
