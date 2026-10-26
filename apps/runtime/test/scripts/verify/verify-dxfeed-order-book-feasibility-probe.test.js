const { DXLinkAuthState, DXLinkConnectionState, DXLinkChannelState } = require("@dxfeed/dxlink-core");
const {
  main,
  decodeEventFlags,
  extractRawIndexStrings,
  isFeedDataFrameText,
  extractOrderIndexStringsFromFrame,
  indexPrecisionLost,
  correlateIndexPrecision,
  createRawFrameCapturingWebSocketImpl,
  orderEntryFor,
  probeSymbol,
  summarizeProbeResult,
} = require("../../../scripts/verify/dxfeed/verify-dxfeed-order-book-feasibility-probe");

function noopLogger() {
  return {
    banner: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ok: jest.fn(),
  };
}

function fakeChannel() {
  const listeners = { message: [], error: [], state: [] };
  const sent = [];
  let state = DXLinkChannelState.REQUESTED;
  return {
    sent,
    send: jest.fn((payload) => sent.push(payload)),
    addMessageListener: jest.fn((listener) => listeners.message.push(listener)),
    removeMessageListener: jest.fn((listener) => {
      listeners.message = listeners.message.filter((entry) => entry !== listener);
    }),
    addErrorListener: jest.fn((listener) => listeners.error.push(listener)),
    removeErrorListener: jest.fn((listener) => {
      listeners.error = listeners.error.filter((entry) => entry !== listener);
    }),
    addStateChangeListener: jest.fn((listener) => listeners.state.push(listener)),
    removeStateChangeListener: jest.fn((listener) => {
      listeners.state = listeners.state.filter((entry) => entry !== listener);
    }),
    close: jest.fn(),
    emitMessage: (message) => [...listeners.message].forEach((listener) => listener(message)),
    emitError: (error) => [...listeners.error].forEach((listener) => listener(error)),
    getState: jest.fn(() => state),
    emitState: (nextState, prev) => {
      state = nextState;
      [...listeners.state].forEach((listener) => listener(nextState, prev));
    },
  };
}

function fakeConnection({ feedChannel = fakeChannel() } = {}) {
  const listeners = { error: [], connection: [], auth: [] };
  let connectionState = DXLinkConnectionState.CONNECTING;
  let authState = DXLinkAuthState.UNAUTHORIZED;
  function subscribable(bucket) {
    return jest.fn((listener) => {
      listeners[bucket].push(listener);
      return () => {
        listeners[bucket] = listeners[bucket].filter((entry) => entry !== listener);
      };
    });
  }
  return {
    channel: feedChannel,
    connect: jest.fn(),
    disconnect: jest.fn(),
    openChannel: jest.fn(() => feedChannel),
    onError: subscribable("error"),
    onConnectionStateChange: subscribable("connection"),
    onAuthStateChange: subscribable("auth"),
    getStatus: jest.fn(() => ({ connectionState, authState })),
    emitError: (error) => [...listeners.error].forEach((listener) => listener(error)),
    emitConnection: (state, prev) => {
      connectionState = state;
      [...listeners.connection].forEach((listener) => listener({ state, prev }));
    },
    emitAuth: (state, prev) => {
      authState = state;
      [...listeners.auth].forEach((listener) => listener({ state, prev }));
    },
  };
}

const config = Object.freeze({
  endpoint: "wss://tools.dxfeed.com/dxlink-chartprime",
  marketDataMode: "realtime",
  tempToken: "temporary-secret.token",
});

function immediateWait() {
  return Promise.resolve();
}

async function driveToChannelOpened(connection) {
  connection.emitAuth(DXLinkAuthState.AUTHORIZED, DXLinkAuthState.UNAUTHORIZED);
  await Promise.resolve();
  await Promise.resolve();
  connection.channel.emitState(DXLinkChannelState.OPENED, DXLinkChannelState.REQUESTED);
  await Promise.resolve();
}

describe("decodeEventFlags", () => {
  test("decodes a single known bit", () => {
    expect(decodeEventFlags(0x04)).toEqual({ raw: 0x04, hex: "0x4", bits: ["SNAPSHOT_BEGIN"], unknownBits: null });
  });

  test("decodes a combination of known bits, in defined order", () => {
    expect(decodeEventFlags(0x0c)).toEqual({
      raw: 0x0c,
      hex: "0xc",
      bits: ["SNAPSHOT_BEGIN", "SNAPSHOT_END"],
      unknownBits: null,
    });
  });

  test("zero flags decodes to no bits, not an error", () => {
    expect(decodeEventFlags(0)).toEqual({ raw: 0, hex: "0x0", bits: [], unknownBits: null });
  });

  test("an unrecognized bit is reported separately, not silently dropped", () => {
    expect(decodeEventFlags(0x84)).toEqual({
      raw: 0x84,
      hex: "0x84",
      bits: ["SNAPSHOT_BEGIN"],
      unknownBits: "0x80",
    });
  });

  test("a non-integer or negative value is reported as unusable, not coerced", () => {
    expect(decodeEventFlags(undefined)).toEqual({ raw: null, hex: null, bits: [], unknownBits: null });
    expect(decodeEventFlags(-1)).toEqual({ raw: -1, hex: null, bits: [], unknownBits: null });
    expect(decodeEventFlags("4")).toEqual({ raw: "4", hex: null, bits: [], unknownBits: null });
  });
});

describe("extractRawIndexStrings", () => {
  test("extracts every index occurrence in order, as strings, preserving full precision", () => {
    const rawText = '{"index":7678176778774447616,"other":1},{"index":42}';
    expect(extractRawIndexStrings(rawText)).toEqual(["7678176778774447616", "42"]);
    // The whole point: this exceeds Number.MAX_SAFE_INTEGER, and the string
    // form survives that -- JSON.parse would have silently rounded it.
    expect(BigInt("7678176778774447616") > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  test("returns an empty array when there is no index field or input isn't a string", () => {
    expect(extractRawIndexStrings('{"eventType":"Quote"}')).toEqual([]);
    expect(extractRawIndexStrings(undefined)).toEqual([]);
    expect(extractRawIndexStrings(null)).toEqual([]);
  });
});

describe("isFeedDataFrameText / extractOrderIndexStringsFromFrame", () => {
  test("only FEED_DATA frames are considered", () => {
    expect(isFeedDataFrameText('{"type":"FEED_DATA","data":[]}')).toBe(true);
    expect(isFeedDataFrameText('{"type":"FEED_CONFIG"}')).toBe(false);
    expect(isFeedDataFrameText(undefined)).toBe(false);
  });

  test("extracts index strings only from FEED_DATA frames, null for anything else", () => {
    expect(extractOrderIndexStringsFromFrame('{"type":"FEED_DATA","data":[{"eventType":"Order","index":123}]}')).toEqual(["123"]);
    expect(extractOrderIndexStringsFromFrame('{"type":"AUTH_STATE","state":"AUTHORIZED"}')).toBeNull();
  });
});

describe("indexPrecisionLost", () => {
  test("detects real precision loss between a raw string and the already-rounded parsed number", () => {
    const rawIndexString = "7678176778774447616";
    const parsedIndexValue = Number(rawIndexString); // what JSON.parse would have produced
    expect(indexPrecisionLost(rawIndexString, parsedIndexValue)).toBe(true);
  });

  test("reports no loss when the value is small enough to round-trip exactly", () => {
    expect(indexPrecisionLost("42", 42)).toBe(false);
  });

  test("returns null (unknown), not false, when either side is missing or unusable", () => {
    expect(indexPrecisionLost(undefined, 42)).toBeNull();
    expect(indexPrecisionLost("42", undefined)).toBeNull();
    expect(indexPrecisionLost("not-a-number", 42)).toBeNull();
  });
});

describe("correlateIndexPrecision", () => {
  test("zips parsed events against raw index strings positionally and flags precision loss per row", () => {
    const parsedEvents = [
      { index: Number("7678176778774447616") },
      { index: 42 },
    ];
    const rawIndexStrings = ["7678176778774447616", "42"];
    const result = correlateIndexPrecision(parsedEvents, rawIndexStrings);
    expect(result.countMismatch).toBe(false);
    expect(result.comparisons[0].precisionLost).toBe(true);
    expect(result.comparisons[1].precisionLost).toBe(false);
  });

  test("flags a count mismatch explicitly rather than silently mis-zipping", () => {
    const result = correlateIndexPrecision([{ index: 1 }, { index: 2 }], ["1"]);
    expect(result.countMismatch).toBe(true);
    expect(result.comparisons).toHaveLength(2);
    expect(result.comparisons[1].rawIndex).toBeNull();
  });
});

describe("summarizeProbeResult", () => {
  function subscriptionWindow({ eventCount = 1, countMismatch = false, precisionLost = false } = {}) {
    return {
      outcome: "DATA_OBSERVED",
      eventCount,
      flagsObserved: [{ bits: ["SNAPSHOT_BEGIN"] }],
      precision: {
        countMismatch,
        comparisons: [{ position: 0, parsedIndex: 1, rawIndex: "1", precisionLost }],
      },
    };
  }

  test("a genuinely aligned, clean correlation reports a real false, not the inconclusive marker", () => {
    const result = {
      label: "AAPL Order (NTV)",
      firstSubscription: subscriptionWindow(),
      resubscription: subscriptionWindow(),
    };
    const summary = summarizeProbeResult(result);
    expect(summary.rawIndexCorrelationCountMismatch).toBe(false);
    expect(summary.rawIndexPrecisionLossObserved).toBe(false);
  });

  test("a count mismatch in either window reports as inconclusive, never a clean false the reader could mistake for a verified-clean result", () => {
    const misaligned = {
      label: "AAPL Order (NTV)",
      firstSubscription: subscriptionWindow({ countMismatch: true, precisionLost: false }),
      resubscription: subscriptionWindow(),
    };
    const summary = summarizeProbeResult(misaligned);
    expect(summary.rawIndexCorrelationCountMismatch).toBe(true);
    expect(summary.rawIndexPrecisionLossObserved).toBe("INCONCLUSIVE_COUNT_MISMATCH");
    expect(summary.rawIndexPrecisionLossObserved).not.toBe(false);
  });

  test("a count mismatch confined to the resubscription window alone is still surfaced, not just the first subscription's", () => {
    const misaligned = {
      label: "AAPL Order (NTV)",
      firstSubscription: subscriptionWindow(),
      resubscription: subscriptionWindow({ countMismatch: true }),
    };
    const summary = summarizeProbeResult(misaligned);
    expect(summary.rawIndexCorrelationCountMismatch).toBe(true);
    expect(summary.rawIndexPrecisionLossObserved).toBe("INCONCLUSIVE_COUNT_MISMATCH");
  });
});

describe("orderEntryFor", () => {
  test("futures use source GLBX and the front-month wire symbol", () => {
    expect(orderEntryFor({ symbol: "/ES", kind: "future", root: "ES" })).toEqual({
      symbol: "/ESZ26:XCME",
      type: "Order",
      source: "GLBX",
    });
  });

  test("equities use source NTV and their own symbol", () => {
    expect(orderEntryFor({ symbol: "AAPL", kind: "equity" })).toEqual({
      symbol: "AAPL",
      type: "Order",
      source: "NTV",
    });
  });
});

describe("createRawFrameCapturingWebSocketImpl", () => {
  class FakeBaseWebSocket {
    constructor() {
      this.listeners = {};
    }
    on(event, listener) {
      this.listeners[event] = listener;
      return this;
    }
    emit(event, ...args) {
      this.listeners[event]?.(...args);
    }
  }

  test("calls onRawFrame with the raw text before the real listener runs, and still invokes the real listener", () => {
    const seen = [];
    const CapturingImpl = createRawFrameCapturingWebSocketImpl(FakeBaseWebSocket, (rawText) => seen.push(rawText));
    const socket = new CapturingImpl();
    const received = [];
    socket.on("message", (data) => received.push(data));
    socket.emit("message", Buffer.from('{"type":"FEED_DATA"}'));
    expect(seen).toEqual(['{"type":"FEED_DATA"}']);
    expect(received).toHaveLength(1);
  });

  test("non-message events pass through untouched", () => {
    const CapturingImpl = createRawFrameCapturingWebSocketImpl(FakeBaseWebSocket, jest.fn());
    const socket = new CapturingImpl();
    const openHandler = jest.fn();
    socket.on("open", openHandler);
    socket.emit("open");
    expect(openHandler).toHaveBeenCalledTimes(1);
  });

  test("a throwing onRawFrame does not prevent the real listener from still receiving the message", () => {
    const CapturingImpl = createRawFrameCapturingWebSocketImpl(FakeBaseWebSocket, () => {
      throw new Error("capture boom");
    });
    const socket = new CapturingImpl();
    const received = [];
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    socket.on("message", (data) => received.push(data));
    expect(() => socket.emit("message", "raw")).not.toThrow();
    expect(received).toEqual(["raw"]);
    errorSpy.mockRestore();
  });
});

describe("probeSymbol", () => {
  test("observes eventFlags and correlates raw-wire index precision across both the initial subscribe and the forced resubscribe", async () => {
    const channel = fakeChannel();
    const symbolEntry = { symbol: "AAPL", kind: "equity" };
    const rawIndexFrames = [];
    const bigIndex = "7678176778774447616";

    const resultPromise = probeSymbol({
      symbolEntry,
      channel,
      wait: immediateWait,
      now: () => 0,
      signal: undefined,
      secrets: [],
      rawIndexFrames,
    });

    // First subscription: simulate the raw frame arriving (as the transport
    // layer would, before parse) followed by the SDK-parsed event.
    await Promise.resolve();
    rawIndexFrames.push([bigIndex]);
    channel.emitMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Order", eventSymbol: "AAPL", source: "NTV", eventFlags: 0x04, index: Number(bigIndex) }],
    });

    await Promise.resolve();
    await Promise.resolve();

    // Resubscription window: a fresh SNAPSHOT_BEGIN, small index this time.
    rawIndexFrames.push(["7"]);
    channel.emitMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Order", eventSymbol: "AAPL", source: "NTV", eventFlags: 0x04, index: 7 }],
    });

    const result = await resultPromise;

    expect(result.firstSubscription.eventCount).toBe(1);
    expect(result.firstSubscription.flagsObserved[0].bits).toEqual(["SNAPSHOT_BEGIN"]);
    expect(result.firstSubscription.precision.comparisons[0].precisionLost).toBe(true);

    expect(result.resubscription.eventCount).toBe(1);
    expect(result.resubscription.flagsObserved[0].bits).toEqual(["SNAPSHOT_BEGIN"]);
    expect(result.resubscription.precision.comparisons[0].precisionLost).toBe(false);
  });
});

describe("main", () => {
  test("connects, authorizes, opens one AUTO-contract FEED channel, and exits 0 after observing every symbol", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const logger = noopLogger();
    const runPromise = main({
      logger,
      loadConfig: () => config,
      createConnection: () => connection,
      wait: immediateWait,
      now: () => 0,
      signalProcess: { on: jest.fn(), off: jest.fn() },
      exit,
    });
    await driveToChannelOpened(connection);

    // Drain every symbol's two observation windows (first + resubscribe),
    // each of which just needs an empty window to elapse with immediateWait.
    for (let tick = 0; tick < 50; tick += 1) {
      await Promise.resolve();
    }
    await runPromise;

    expect(connection.openChannel).toHaveBeenCalledWith("FEED", { contract: "AUTO" });
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("a connection error aborts the probe and exits 1", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      wait: immediateWait,
      now: () => 0,
      signalProcess: { on: jest.fn(), off: jest.fn() },
      exit,
    });
    await driveToChannelOpened(connection);
    connection.emitError({ type: "X", message: "boom" });
    await runPromise;
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("SIGINT aborts cleanly and exits 130", async () => {
    const connection = fakeConnection();
    const exit = jest.fn();
    const signalProcess = { on: jest.fn(), off: jest.fn() };
    const runPromise = main({
      logger: noopLogger(),
      loadConfig: () => config,
      createConnection: () => connection,
      wait: immediateWait,
      now: () => 0,
      signalProcess,
      exit,
    });
    await driveToChannelOpened(connection);
    const sigintHandler = signalProcess.on.mock.calls.find(([signal]) => signal === "SIGINT")[1];
    sigintHandler();
    await runPromise;
    expect(exit).toHaveBeenCalledWith(130);
  });

  test("invalid config logs and exits 1 without connecting", async () => {
    const exit = jest.fn();
    const createConnection = jest.fn();
    await main({
      logger: noopLogger(),
      loadConfig: () => {
        throw new Error("bad config");
      },
      createConnection,
      exit,
    });
    expect(createConnection).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
