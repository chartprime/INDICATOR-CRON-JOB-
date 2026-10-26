const { parseServerArgs, dxfeedBooksSummary, startInstrumentTablePoll, pruneExpiredLiquidityStores } = require("../../../scripts/serve/run-ws-server");

describe("pruneExpiredLiquidityStores (report 57 O-22)", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  test("keeps the governed catalog's futures, removes a contract that has rolled off it, and logs what it removed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-server-prune-"));
    try {
      for (const name of ["FUTURE_ESU26_XCME.json", "FUTURE_ESZ26_XCME.json", "FUTURE_NQZ26_XCME.json", "EQUITY_AAPL.json"]) {
        fs.writeFileSync(path.join(dir, name), "{}");
      }
      const logger = { info: jest.fn() };
      const removed = pruneExpiredLiquidityStores({ L2_HEATMAP_STORE_DIR: dir }, logger);
      expect(removed).toEqual(["FUTURE_ESU26_XCME.json"]);
      expect(fs.readdirSync(dir).sort()).toEqual(["EQUITY_AAPL.json", "FUTURE_ESZ26_XCME.json", "FUTURE_NQZ26_XCME.json"]);
      expect(logger.info).toHaveBeenCalledWith("removed heatmap stores of expired futures contracts", { files: "FUTURE_ESU26_XCME.json" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
const { DEFAULT_PORT, DEFAULT_SYMBOL, DEFAULT_ALLOWED_ORIGINS } = require("../../../src/server/app");

// A2.19 / L1L2-V2-093. run-ws-server.js is the entry point behind `npm run dev`
// and `npm run dev:dxfeed:live`, and every one of its argument branches was
// untested: the whole file executed at require time, so nothing could load it
// without starting a real server on a real port. Argument parsing is now a
// pure function and the startup lives behind require.main, which is what makes
// these assertions possible at all.

describe("parseServerArgs", () => {
  test("book readiness summary excludes stale depth", () => {
    expect(dxfeedBooksSummary([{ l2: { status: "READY", stale: true } }, { l2: { status: "READY" } }])).toBe("1/2 READY");
  });
  test("returns the documented defaults for no arguments", () => {
    expect(parseServerArgs([], {})).toEqual({
      port: DEFAULT_PORT,
      symbol: DEFAULT_SYMBOL,
      dxfeedEager: false,
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    });
  });

  test("accepts an explicit port and allowed symbol", () => {
    expect(parseServerArgs(["9100", "ETHUSDT"], {})).toMatchObject({ port: 9100, symbol: "ETHUSDT" });
  });

  test("accepts a hyphenated wire symbol and converts it to the internal form", () => {
    expect(parseServerArgs(["8001", "BTC-USDT"], {})).toMatchObject({ symbol: "BTCUSDT" });
    expect(parseServerArgs(["8001", "ETH-USDT"], {})).toMatchObject({ symbol: "ETHUSDT" });
  });

  test.each(["0", "-1", "65536", "99999", "abc", "8001.5"])(
    "rejects the invalid port %p rather than binding something unintended",
    (bad) => {
      expect(() => parseServerArgs([bad], {})).toThrow(`invalid port "${bad}"`);
    },
  );

  // A hyphenated symbol that fromWireSymbol cannot parse and a plain symbol
  // that is simply not allow-listed produce different messages, and an
  // operator reading the log needs to be able to tell them apart.
  test("distinguishes an unparseable wire symbol from an unproven one", () => {
    expect(() => parseServerArgs(["8001", "BTCUSDT-SPOT"], {})).toThrow('invalid symbol "BTCUSDT-SPOT"');
    expect(() => parseServerArgs(["8001", "DOGEUSDT"], {})).toThrow('unproven symbol "DOGEUSDT"');
    expect(() => parseServerArgs(["8001", "DOGE-USDT"], {})).toThrow('invalid symbol "DOGE-USDT"');
  });

  // Order matters: the symbol is parsed before the port is validated, so an
  // invocation wrong in both ways reports the symbol first. Pinned because the
  // extraction could silently reorder it.
  test("reports an unparseable symbol ahead of an invalid port when both are wrong", () => {
    expect(() => parseServerArgs(["0", "BTCUSDT-SPOT"], {})).toThrow(/invalid symbol/);
  });

  test("recognises --dxfeed-eager once the positional arguments are present", () => {
    expect(parseServerArgs([], {}).dxfeedEager).toBe(false);
    expect(parseServerArgs(["8001", "BTCUSDT", "--dxfeed-eager"], {}).dxfeedEager).toBe(true);
  });

  // The flag is positional-after, not free-floating: the first argument is
  // always read as the port. `dev:dxfeed:live` passes `8001 BTCUSDT
  // --dxfeed-eager` for exactly this reason, and a shorter invocation fails
  // loudly rather than starting a non-eager server the operator did not want.
  test("rejects --dxfeed-eager given in place of the port instead of silently ignoring it", () => {
    expect(() => parseServerArgs(["--dxfeed-eager"], {})).toThrow('invalid port "--dxfeed-eager"');
  });

  // The ngrok workflow depends on this: EXTRA_ALLOWED_ORIGIN is read once at
  // process start, and dropping the defaults would lock out local development.
  test("appends EXTRA_ALLOWED_ORIGIN to the defaults rather than replacing them", () => {
    const { allowedOrigins } = parseServerArgs([], { EXTRA_ALLOWED_ORIGIN: "https://demo.ngrok.app" });

    expect(allowedOrigins).toEqual([...DEFAULT_ALLOWED_ORIGINS, "https://demo.ngrok.app"]);
  });

  test("leaves the defaults untouched when EXTRA_ALLOWED_ORIGIN is absent or empty", () => {
    expect(parseServerArgs([], {}).allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseServerArgs([], { EXTRA_ALLOWED_ORIGIN: "" }).allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  test("does not mutate DEFAULT_ALLOWED_ORIGINS when it appends", () => {
    const before = [...DEFAULT_ALLOWED_ORIGINS];
    parseServerArgs([], { EXTRA_ALLOWED_ORIGIN: "https://demo.ngrok.app" });

    expect(DEFAULT_ALLOWED_ORIGINS).toEqual(before);
  });
});

describe("dxfeedBooksSummary", () => {
  test("reports n/a with no instruments configured or selected", () => {
    expect(dxfeedBooksSummary([])).toBe("n/a");
  });

  test("counts only READY books against the total instrument count", () => {
    expect(dxfeedBooksSummary([
      { l2: { status: "READY" } },
      { l2: { status: "READY" } },
      { l2: { status: "UNAVAILABLE", reason: "CORRELATION_FAILED" } },
      { l2: { status: "BUFFERING" } },
    ])).toBe("2/4 READY");
  });

  test("names the books that are stale only because their market is closed (Block 8 #10)", () => {
    const thursdayNightEt = Date.parse("2026-09-25T01:11:00Z");
    expect(dxfeedBooksSummary([
      { symbol: "/ESZ26:XCME", assetClass: "FUTURE", l2: { status: "READY" } },
      { symbol: "/NQZ26:XCME", assetClass: "FUTURE", l2: { status: "READY" } },
      { symbol: "AAPL", assetClass: "EQUITY", l2: { status: "READY", stale: true } },
      { symbol: "TSLA", assetClass: "EQUITY", l2: { status: "READY", stale: true } },
    ], thursdayNightEt)).toBe("2/4 READY, 2 closed");
  });
});

describe("startInstrumentTablePoll", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function fakeLogger() {
    return { instrumentTable: jest.fn() };
  }

  test("does not print while there are no instruments to show", () => {
    const app = { dxfeedMarketDataServer: { instrumentSnapshot: () => [] } };
    const logger = fakeLogger();
    startInstrumentTablePoll(app, logger);

    jest.advanceTimersByTime(5_000);

    expect(logger.instrumentTable).not.toHaveBeenCalled();
  });

  test("prints once when instruments appear, and again only once their state actually changes", () => {
    let rows = [{ symbol: "AAPL", assetClass: "EQUITY", l1: { recoveryState: "RECOVERING", quiet: false }, l2: { status: "BUFFERING", reason: null } }];
    const app = { dxfeedMarketDataServer: { instrumentSnapshot: () => rows } };
    const logger = fakeLogger();
    startInstrumentTablePoll(app, logger);

    jest.advanceTimersByTime(1_000);
    expect(logger.instrumentTable).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(3_000);
    expect(logger.instrumentTable).toHaveBeenCalledTimes(1);

    rows = [{ symbol: "AAPL", assetClass: "EQUITY", l1: { recoveryState: "READY", quiet: false }, l2: { status: "READY", reason: null } }];
    jest.advanceTimersByTime(1_000);
    expect(logger.instrumentTable).toHaveBeenCalledTimes(2);
    expect(logger.instrumentTable).toHaveBeenLastCalledWith(rows);
  });

  test("does not redraw for high-frequency diagnostics that are not visible in the table", () => {
    let rejected = 1;
    const app = { dxfeedMarketDataServer: { instrumentSnapshot: () => [{
      symbol: "AAPL", assetClass: "EQUITY", l1: { recoveryState: "READY", quiet: false },
      l2: { status: "READY", reason: null }, dataQuality: { rejected: { INVALID_TICK: rejected++ } },
    }] } };
    const logger = fakeLogger();
    startInstrumentTablePoll(app, logger);
    jest.advanceTimersByTime(5_000);
    expect(logger.instrumentTable).toHaveBeenCalledTimes(1);
  });

  test("does not redraw for quiet or stale flags while their current state hides those details", () => {
    let tick = 0;
    const app = { dxfeedMarketDataServer: { instrumentSnapshot: () => [{
      symbol: "AAPL", assetClass: "EQUITY",
      l1: { recoveryState: "RECOVERING", quiet: tick++ % 2 === 0 },
      l2: { status: "READY", reason: null, stale: tick % 2 === 0 },
    }] } };
    const logger = fakeLogger();
    startInstrumentTablePoll(app, logger);
    jest.advanceTimersByTime(5_000);
    expect(logger.instrumentTable).toHaveBeenCalledTimes(1);
  });

  test("the returned stop function halts further polling, even once the underlying state keeps changing", () => {
    let rows = [{ symbol: "AAPL", assetClass: "EQUITY", l1: { recoveryState: "READY", quiet: false }, l2: { status: "READY", reason: null } }];
    const app = { dxfeedMarketDataServer: { instrumentSnapshot: () => rows } };
    const logger = fakeLogger();
    const stop = startInstrumentTablePoll(app, logger);

    jest.advanceTimersByTime(1_000);
    expect(logger.instrumentTable).toHaveBeenCalledTimes(1);

    stop();
    rows = [{ symbol: "AAPL", assetClass: "EQUITY", l1: { recoveryState: "RECOVERING", quiet: false }, l2: { status: "UNAVAILABLE", reason: "CORRELATION_FAILED" } }];
    jest.advanceTimersByTime(10_000);
    expect(logger.instrumentTable).toHaveBeenCalledTimes(1);
  });

  test("a tick that throws is contained -- it does not crash the process or stop future ticks", () => {
    const app = {
      dxfeedMarketDataServer: {
        instrumentSnapshot: jest.fn(() => {
          throw new Error("storage read failed");
        }),
      },
    };
    const logger = { instrumentTable: jest.fn(), warn: jest.fn() };
    startInstrumentTablePoll(app, logger);

    expect(() => jest.advanceTimersByTime(3_000)).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith("instrument table poll failed", expect.objectContaining({ reason: "storage read failed" }));
    expect(app.dxfeedMarketDataServer.instrumentSnapshot.mock.calls.length).toBeGreaterThan(1);
  });
});
