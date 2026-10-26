const {
  createDxFeedOrderV2Capture,
  extractOrderIndexStringsFromDataArray,
  extractChannelNumber,
  isFeedDataFrameText,
  createRawFrameCapturingWebSocketImpl,
} = require("../../../src/providers/dxfeed/dxfeed-order-v2-capture");

// A real-shaped mixed batch: Quote and Trade have no "index" field at
// all (confirmed against QUOTE_ALLOWED_KEYS/TRADE_ALLOWED_KEYS), so only
// the two Order items here should be picked up, in their own relative
// order, skipping the Quote/Trade items entirely.
const FUTURE_INDEX = "5137554220647453001";
const EQUITY_INDEX = "22047776527426937";

function mixedFeedDataFrameText() {
  return JSON.stringify({
    type: "FEED_DATA",
    channel: 3,
    data: [
      { eventType: "Quote", eventSymbol: "/NQZ26:XCME", bidPrice: 29111.5 },
      {
        eventType: "Order", eventSymbol: "/NQZ26:XCME", index: 1, eventFlags: 4, time: 1000,
        action: "NEW", price: 29139.75, side: "SELL", scope: "ORDER", source: "GLBX",
      },
      { eventType: "Trade", eventSymbol: "/NQZ26:XCME", price: 29140 },
      {
        eventType: "Order", eventSymbol: "AAPL", index: 2, eventFlags: 0, time: 1000,
        action: "DELETE", price: 310.48, side: "SELL", scope: "ORDER", source: "NTV",
      },
    ],
  })
    .replace('"index":1,', `"index":${FUTURE_INDEX},`)
    .replace('"index":2,', `"index":${EQUITY_INDEX},`);
}

describe("extractChannelNumber", () => {
  test("extracts the channel number from a real-shaped raw frame", () => {
    expect(extractChannelNumber('{"type":"FEED_DATA","channel":3,"data":[]}')).toBe(3);
  });

  test("returns null when no channel field is present, or the input isn't a string", () => {
    expect(extractChannelNumber('{"type":"FEED_DATA","data":[]}')).toBeNull();
    expect(extractChannelNumber(undefined)).toBeNull();
    expect(extractChannelNumber(42)).toBeNull();
  });
});

describe("isFeedDataFrameText", () => {
  test("only FEED_DATA frames match", () => {
    expect(isFeedDataFrameText('{"type":"FEED_DATA","data":[]}')).toBe(true);
    expect(isFeedDataFrameText('{"type":"FEED_CONFIG"}')).toBe(false);
    expect(isFeedDataFrameText(undefined)).toBe(false);
  });
});

describe("extractOrderIndexStringsFromDataArray", () => {
  test("extracts only the Order items' index strings, in order, skipping Quote/Trade in the same batch", () => {
    expect(extractOrderIndexStringsFromDataArray(mixedFeedDataFrameText())).toEqual([FUTURE_INDEX, EQUITY_INDEX]);
  });

  test("a huge real index string round-trips exactly, proving this is not subject to JSON.parse's own rounding", () => {
    const huge = "18446744073709551615";
    const frame = JSON.stringify({ type: "FEED_DATA", data: [{ eventType: "Order", eventSymbol: "AAPL", index: 999 }] })
      .replace('"index":999', `"index":${huge}`);
    expect(extractOrderIndexStringsFromDataArray(frame)).toEqual([huge]);
    expect(BigInt(extractOrderIndexStringsFromDataArray(frame)[0])).toBe(BigInt(huge));
  });

  test("an Order item missing its index field yields undefined at that position, not a shifted/dropped array", () => {
    const frame = JSON.stringify({
      type: "FEED_DATA",
      data: [
        { eventType: "Order", eventSymbol: "AAPL", action: "DELETE", price: 1 },
        { eventType: "Order", eventSymbol: "AAPL", index: 42, action: "NEW", price: 2 },
      ],
    });
    expect(extractOrderIndexStringsFromDataArray(frame)).toEqual([undefined, "42"]);
  });

  test("returns null for a non-FEED_DATA frame or one with no data array", () => {
    expect(extractOrderIndexStringsFromDataArray('{"type":"AUTH_STATE","state":"AUTHORIZED"}')).toBeNull();
    expect(extractOrderIndexStringsFromDataArray('{"type":"FEED_DATA"}')).toBeNull();
    expect(extractOrderIndexStringsFromDataArray(undefined)).toBeNull();
  });

  test("a batch with no Order items returns an empty array, not null -- it IS a real FEED_DATA frame, just nothing this module cares about", () => {
    const frame = JSON.stringify({ type: "FEED_DATA", data: [{ eventType: "Quote", eventSymbol: "AAPL" }] });
    expect(extractOrderIndexStringsFromDataArray(frame)).toEqual([]);
  });

  test("preserves indexes when whitespace, root-field order, item-field order, and nested JSON-looking strings differ from JSON.stringify output", () => {
    const frame = `{
      "data" : [
        {
          "marketMaker" : "desk { not a JSON object }",
          "index" : 22047776527426937,
          "eventSymbol" : "AAPL",
          "eventType" : "Order"
        }
      ],
      "channel" : 3,
      "type" : "FEED_DATA"
    }`;

    expect(isFeedDataFrameText(frame)).toBe(true);
    expect(extractChannelNumber(frame)).toBe(3);
    expect(extractOrderIndexStringsFromDataArray(frame)).toEqual([EQUITY_INDEX]);
  });

  test("does not mistake an Order-shaped nested object for a direct data item", () => {
    const frame = `{
      "type": "FEED_DATA",
      "data": [{
        "eventType": "Quote",
        "metadata": { "eventType": "Order", "index": 99999999999999999 }
      }]
    }`;

    expect(extractOrderIndexStringsFromDataArray(frame)).toEqual([]);
  });

  test("rejects unsafe or non-integral channel tokens rather than coercing them into a different channel", () => {
    expect(extractChannelNumber('{"type":"FEED_DATA","channel":9007199254740993,"data":[]}')).toBeNull();
    expect(extractChannelNumber('{"type":"FEED_DATA","channel":1.5,"data":[]}')).toBeNull();
    expect(extractChannelNumber('{"type":"FEED_DATA","channel":-1,"data":[]}')).toBeNull();
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

  test("captures the raw text before the real listener runs, and still invokes the real listener", () => {
    const seen = [];
    const CapturingImpl = createRawFrameCapturingWebSocketImpl(FakeBaseWebSocket, (rawText) => seen.push(rawText));
    const socket = new CapturingImpl();
    const received = [];
    socket.on("message", (data) => received.push(data));
    socket.emit("message", Buffer.from('{"type":"FEED_DATA"}'));
    expect(seen).toEqual(['{"type":"FEED_DATA"}']);
    expect(received).toHaveLength(1);
  });

  test("a throwing capture callback does not prevent the real listener from receiving the message", () => {
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

describe("createDxFeedOrderV2Capture", () => {
  function resolveOrderContext(eventSymbol) {
    if (eventSymbol === "/NQZ26:XCME") return { assetClass: "FUTURE", symbol: "/NQZ26:XCME" };
    if (eventSymbol === "AAPL") return { assetClass: "EQUITY", symbol: "AAPL" };
    return null;
  }

  // Mirrors the fake-WebSocket idiom already used by binance-connection.test.js
  // and the probe's own test file: each constructed instance is pushed to a
  // shared array so the test can reach in and drive it, since
  // createWsConnector doesn't expose its internal socket instance.
  function fakeWebSocketImplFactory() {
    const instances = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.listeners = {};
        instances.push(this);
      }
      on(event, listener) {
        this.listeners[event] = listener;
        return this;
      }
      emit(event, ...args) {
        this.listeners[event]?.(...args);
      }
      close() {}
      send() {}
      removeAllListeners() {}
    }
    return { FakeWebSocket, instances };
  }

  function createDrivenCapture(options) {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const capture = createDxFeedOrderV2Capture({ ...options, webSocketImpl: FakeWebSocket });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener((message) => capture.handleChannelMessage(message));
    connector.start();
    return {
      capture,
      emit(message) {
        instances[0].emit("message", JSON.stringify({ channel: 3, ...message }));
      },
    };
  }

  test("rejects a missing resolveOrderContext or onEnvelope", () => {
    expect(() => createDxFeedOrderV2Capture({ onEnvelope: jest.fn() })).toThrow(/resolveOrderContext/);
    expect(() => createDxFeedOrderV2Capture({ resolveOrderContext })).toThrow(/onEnvelope/);
  });

  test("rejects a negative channel id before capture can be armed", () => {
    const capture = createDxFeedOrderV2Capture({ resolveOrderContext, onEnvelope: jest.fn() });
    expect(() => capture.setChannelId(-1)).toThrow(/non-negative safe integer/);
  });

  test("full flow through createConnector: a raw frame intercepted before JSON.parse produces envelopes with the true full-precision index, only for the Order items", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const envelopes = [];
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: (envelope) => envelopes.push(envelope),
      now: () => 1_700_000_000_000,
    });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener((message) => capture.handleChannelMessage(message));
    connector.start();
    const socket = instances[0];
    socket.emit("open");

    socket.emit("message", mixedFeedDataFrameText());

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].assetClass).toBe("FUTURE");
    expect(envelopes[0].providerSymbol).toBe("/NQZ26:XCME");
    expect(envelopes[0].payload.index).toBe(FUTURE_INDEX);
    expect(envelopes[0].payload.action).toBe("NEW");
    expect(envelopes[1].assetClass).toBe("EQUITY");
    expect(envelopes[1].providerSymbol).toBe("AAPL");
    expect(envelopes[1].payload.index).toBe(EQUITY_INDEX);
    expect(envelopes[1].payload.action).toBe("DELETE");
    expect(capture.pendingFrameCount()).toBe(0);
  });

  test("delivers one parsed raw frame as one ordered batch when onEnvelopes is supplied", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const onEnvelopes = jest.fn();
    const capture = createDxFeedOrderV2Capture({ webSocketImpl: FakeWebSocket, resolveOrderContext, onEnvelopes });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener((message) => capture.handleChannelMessage(message));
    connector.start();
    const socket = instances[0];
    socket.emit("open");
    socket.emit("message", JSON.stringify({
      type: "FEED_DATA", channel: 3,
      data: [
        { eventType: "Order", eventSymbol: "AAPL", index: 123, eventFlags: 0, time: 1000, action: "NEW", price: 1, side: "BUY", scope: "ORDER", source: "NTV" },
        { eventType: "Order", eventSymbol: "AAPL", index: 456, eventFlags: 0, time: 1000, action: "NEW", price: 2, side: "SELL", scope: "ORDER", source: "NTV" },
      ],
    }));

    expect(onEnvelopes).toHaveBeenCalledTimes(1);
    expect(onEnvelopes.mock.calls[0][0].map((envelope) => envelope.payload.index)).toEqual(["123", "456"]);
  });

  test("FIFO pairing survives multiple frames in sequence, without drifting", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const envelopes = [];
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: (envelope) => envelopes.push(envelope),
    });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener((message) => capture.handleChannelMessage(message));
    connector.start();
    const socket = instances[0];

    const frameOne = JSON.stringify({
      type: "FEED_DATA",
      channel: 3,
      data: [{
        eventType: "Order", eventSymbol: "AAPL", index: 111, eventFlags: 0, time: 1000,
        action: "NEW", price: 1, side: "BUY", scope: "ORDER", source: "NTV",
      }],
    });
    const frameTwo = JSON.stringify({
      type: "FEED_DATA",
      channel: 3,
      data: [{
        eventType: "Order", eventSymbol: "AAPL", index: 222, eventFlags: 0, time: 1000,
        action: "MODIFY", price: 2, side: "BUY", scope: "ORDER", source: "NTV",
      }],
    });
    socket.emit("message", frameOne);
    socket.emit("message", frameTwo);

    expect(envelopes.map((e) => e.payload.index)).toEqual(["111", "222"]);
    expect(capture.pendingFrameCount()).toBe(0);
  });

  test("raw frames from an unrelated channel sharing the same WebSocket are never queued -- the real bug found while planning Stage 3, where multiple dxLink channels multiplex over one connection", () => {
    // Simulates the real production wiring split: raw-frame capture sees
    // every frame the shared WebSocket receives (all channels), but only
    // frames matching setChannelId's target may ever be queued. The
    // parsed-message side (handleChannelMessage) is exercised separately
    // below, since in production it is only ever invoked by the dxLink
    // client library for messages belonging to the specific channel it was
    // registered against -- unlike this raw layer, which sees everything.
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: jest.fn(),
    });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener(() => {});
    connector.start();
    const socket = instances[0];

    const unrelatedChannelOrderItem = {
      eventType: "Order", eventSymbol: "AAPL", index: 999, eventFlags: 0, time: 1000,
      action: "NEW", price: 1, side: "BUY", scope: "ORDER", source: "NTV",
    };
    socket.emit("message", JSON.stringify({ type: "FEED_DATA", channel: 7, data: [unrelatedChannelOrderItem] }));
    expect(capture.pendingFrameCount()).toBe(0);

    socket.emit("message", JSON.stringify({
      type: "FEED_DATA",
      channel: 3,
      data: [{
        eventType: "Order", eventSymbol: "AAPL", index: 111, eventFlags: 0, time: 1000,
        action: "NEW", price: 1, side: "BUY", scope: "ORDER", source: "NTV",
      }],
    }));
    expect(capture.pendingFrameCount()).toBe(1);
  });

  test("handleChannelMessage's FIFO correlation is correct even when unrelated-channel raw frames interleave with the real channel's frames on the shared WebSocket", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const envelopes = [];
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: (envelope) => envelopes.push(envelope),
    });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener(() => {});
    connector.start();
    const socket = instances[0];

    const unrelatedChannelFrame = JSON.stringify({
      type: "FEED_DATA",
      channel: 7,
      data: [{
        eventType: "Order", eventSymbol: "AAPL", index: 999, eventFlags: 0, time: 1000,
        action: "NEW", price: 1, side: "BUY", scope: "ORDER", source: "NTV",
      }],
    });
    const realChannelFrame = {
      type: "FEED_DATA",
      channel: 3,
      data: [{
        eventType: "Order", eventSymbol: "AAPL", index: 111, eventFlags: 0, time: 1000,
        action: "NEW", price: 1, side: "BUY", scope: "ORDER", source: "NTV",
      }],
    };

    socket.emit("message", unrelatedChannelFrame);
    socket.emit("message", JSON.stringify(realChannelFrame));
    capture.handleChannelMessage(realChannelFrame);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].payload.index).toBe("111");
  });

  test("no frames are captured before setChannelId has ever been called", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: jest.fn(),
    });
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener(() => {});
    connector.start();
    const socket = instances[0];

    socket.emit("message", JSON.stringify({
      type: "FEED_DATA",
      channel: 3,
      data: [{
        eventType: "Order", eventSymbol: "AAPL", index: 111, eventFlags: 0, time: 1000,
        action: "NEW", price: 1, side: "BUY", scope: "ORDER", source: "NTV",
      }],
    }));
    expect(capture.pendingFrameCount()).toBe(0);
  });

  test("bounds the raw-frame correlation queue and reports overflow rather than growing process memory without limit", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const onCaptureError = jest.fn();
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: jest.fn(),
      onCaptureError,
      maxPendingFrames: 2,
    });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener(() => {});
    connector.start();
    const socket = instances[0];
    const frame = JSON.stringify({
      type: "FEED_DATA", channel: 3,
      data: [{ eventType: "Order", eventSymbol: "AAPL", index: 111, eventFlags: 0, time: 1000, action: "NEW", price: 1, side: "BUY", scope: "ORDER", source: "NTV" }],
    });

    socket.emit("message", frame);
    socket.emit("message", frame);
    expect(capture.pendingFrameCount()).toBe(2);
    socket.emit("message", frame);

    expect(capture.pendingFrameCount()).toBe(0);
    expect(onCaptureError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/backlog/) }));
  });

  test("rejects an invalid raw-frame queue capacity at construction", () => {
    expect(() => createDxFeedOrderV2Capture({ resolveOrderContext, onEnvelope: jest.fn(), maxPendingFrames: 0 })).toThrow(/maxPendingFrames/);
  });

  test("bounds queued raw index values as well as frame count", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const onCaptureError = jest.fn();
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: jest.fn(),
      onCaptureError,
      maxPendingFrames: 10,
      maxPendingIndexValues: 2,
    });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener(() => {});
    connector.start();
    const socket = instances[0];

    socket.emit("message", JSON.stringify({
      type: "FEED_DATA",
      channel: 3,
      data: [
        { eventType: "Order", eventSymbol: "AAPL", index: 111 },
        { eventType: "Order", eventSymbol: "AAPL", index: 222 },
        { eventType: "Order", eventSymbol: "AAPL", index: 333 },
      ],
    }));

    expect(capture.pendingFrameCount()).toBe(0);
    expect(onCaptureError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/backlog/) }));
  });

  test("rejects an invalid raw index-value queue capacity at construction", () => {
    expect(() => createDxFeedOrderV2Capture({ resolveOrderContext, onEnvelope: jest.fn(), maxPendingIndexValues: 0 }))
      .toThrow(/maxPendingIndexValues/);
  });

  test("an unresolvable eventSymbol is skipped -- no envelope, no crash, no leaked pending frame", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const envelopes = [];
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: (envelope) => envelopes.push(envelope),
    });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener((message) => capture.handleChannelMessage(message));
    connector.start();
    const socket = instances[0];

    const frame = JSON.stringify({
      type: "FEED_DATA",
      channel: 3,
      data: [{ eventType: "Order", eventSymbol: "TSLA_UNKNOWN", index: 111, action: "NEW", price: 1 }],
    });
    expect(() => socket.emit("message", frame)).not.toThrow();
    expect(envelopes).toHaveLength(0);
    expect(capture.pendingFrameCount()).toBe(0);
  });

  test("a parsed frame without its raw counterpart fails closed and latches correlation unhealthy", () => {
    const envelopes = [];
    const errors = [];
    const capture = createDxFeedOrderV2Capture({
      resolveOrderContext,
      onEnvelope: (envelope) => envelopes.push(envelope),
      onCaptureError: (error) => errors.push(error),
    });

    capture.handleChannelMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Order", eventSymbol: "AAPL", index: 999, action: "NEW", price: 1 }],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "DXFEED_ORDER_V2_CORRELATION_LOST", eventSymbols: ["AAPL"] });
    expect(envelopes).toHaveLength(0);
    expect(capture.getCorrelationStatus()).toEqual({
      healthy: false,
      pendingFrames: 0,
      pendingIndexValues: 0,
      lastFailure: {
        reason: "parsed FEED_DATA arrived without its raw frame",
        eventSymbols: ["AAPL"],
        atMs: expect.any(Number),
      },
    });

    capture.handleChannelMessage({ type: "FEED_DATA", data: [] });
    expect(errors).toHaveLength(1);
    capture.setChannelId(3);
    expect(capture.getCorrelationStatus()).toEqual({
      healthy: true,
      pendingFrames: 0,
      pendingIndexValues: 0,
      lastFailure: {
        reason: "parsed FEED_DATA arrived without its raw frame",
        eventSymbols: ["AAPL"],
        atMs: expect.any(Number),
      },
    });
  });

  test("getCorrelationStatus reports no lastFailure before any correlation loss, and overwrites it on a second one", () => {
    const capture = createDxFeedOrderV2Capture({
      resolveOrderContext,
      onEnvelope: () => {},
      onCaptureError: () => {},
    });

    expect(capture.getCorrelationStatus().lastFailure).toBeNull();

    capture.handleChannelMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Order", eventSymbol: "AAPL", index: 1, action: "NEW", price: 1 }],
    });
    expect(capture.getCorrelationStatus().lastFailure).toMatchObject({ eventSymbols: ["AAPL"] });

    capture.setChannelId(4);
    capture.handleChannelMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Order", eventSymbol: "TSLA", index: 1, action: "NEW", price: 1 }],
    });
    expect(capture.getCorrelationStatus().lastFailure).toMatchObject({ eventSymbols: ["TSLA"] });
  });

  test("a raw/parsed Order count mismatch emits no partial batch and latches correlation unhealthy", () => {
    const { FakeWebSocket, instances } = fakeWebSocketImplFactory();
    const envelopes = [];
    const errors = [];
    const capture = createDxFeedOrderV2Capture({
      webSocketImpl: FakeWebSocket,
      resolveOrderContext,
      onEnvelope: (envelope) => envelopes.push(envelope),
      onCaptureError: (error) => errors.push(error),
    });
    capture.setChannelId(3);
    const connector = capture.createConnector("wss://example.test");
    connector.setMessageListener(() => {});
    connector.start();
    instances[0].emit("message", JSON.stringify({
      type: "FEED_DATA", channel: 3,
      data: [
        { eventType: "Order", eventSymbol: "AAPL", index: 1 },
        { eventType: "Order", eventSymbol: "AAPL", index: 2 },
      ],
    }));

    capture.handleChannelMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Order", eventSymbol: "AAPL", index: 1 }],
    });

    expect(envelopes).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "DXFEED_ORDER_V2_CORRELATION_LOST", eventSymbols: ["AAPL"] });
    expect(capture.getCorrelationStatus().healthy).toBe(false);
  });

  // A single instrument's malformed traffic trips correlation for every other
  // instrument sharing this capture object, since eager mode routes all four
  // through one dxLink channel. The error must name the instrument that
  // actually caused it -- without this, an operator watching /NQ, /ES, AAPL
  // and TSLA all go unavailable together has no way to tell which one broke it.
  test("attributes a correlation failure to the instrument whose traffic caused it", () => {
    const errors = [];
    const capture = createDxFeedOrderV2Capture({
      resolveOrderContext,
      onEnvelope: () => {},
      onCaptureError: (error) => errors.push(error),
    });

    capture.handleChannelMessage({
      type: "FEED_DATA",
      data: [{ eventType: "Order", eventSymbol: "/NQZ26:XCME", index: 1, action: "NEW", price: 1 }],
    });

    expect(errors[0].eventSymbols).toEqual(["/NQZ26:XCME"]);
  });

  test("deduplicates repeated eventSymbol entries when many Order items for one instrument share the failing batch", () => {
    const errors = [];
    const capture = createDxFeedOrderV2Capture({
      resolveOrderContext,
      onEnvelope: () => {},
      onCaptureError: (error) => errors.push(error),
    });

    capture.handleChannelMessage({
      type: "FEED_DATA",
      data: [
        { eventType: "Order", eventSymbol: "/NQZ26:XCME", index: 1, action: "NEW", price: 1 },
        { eventType: "Order", eventSymbol: "/NQZ26:XCME", index: 2, action: "NEW", price: 2 },
        { eventType: "Order", eventSymbol: "/NQZ26:XCME", index: 3, action: "NEW", price: 3 },
      ],
    });

    expect(errors[0].eventSymbols).toEqual(["/NQZ26:XCME"]);
  });

  test("rejects ambiguous callbacks and invalid operational hooks at construction", () => {
    expect(() => createDxFeedOrderV2Capture({
      resolveOrderContext, onEnvelope: jest.fn(), onEnvelopes: jest.fn(),
    })).toThrow(/exactly one/);
    expect(() => createDxFeedOrderV2Capture({
      resolveOrderContext, onEnvelope: jest.fn(), onCaptureError: "nope",
    })).toThrow(/onCaptureError/);
    expect(() => createDxFeedOrderV2Capture({
      resolveOrderContext, onEnvelope: jest.fn(), now: 123,
    })).toThrow(/now/);
  });

  test("a non-FEED_DATA or malformed message is a no-op", () => {
    const envelopes = [];
    const capture = createDxFeedOrderV2Capture({ resolveOrderContext, onEnvelope: (e) => envelopes.push(e) });
    expect(() => capture.handleChannelMessage({ type: "FEED_CONFIG" })).not.toThrow();
    expect(() => capture.handleChannelMessage(null)).not.toThrow();
    expect(() => capture.handleChannelMessage({ type: "FEED_DATA", data: "not-an-array" })).not.toThrow();
    expect(envelopes).toHaveLength(0);
  });

  test("a throwing resolveOrderContext is contained -- routed to onCaptureError, does not crash, does not stop the rest of the batch", () => {
    const envelopes = [];
    const errors = [];
    const { emit } = createDrivenCapture({
      resolveOrderContext: (eventSymbol) => {
        if (eventSymbol === "BOOM") throw new Error("resolver boom");
        return resolveOrderContext(eventSymbol);
      },
      onEnvelope: (envelope) => envelopes.push(envelope),
      onCaptureError: (error) => errors.push(error),
    });

    expect(() => emit({
      type: "FEED_DATA",
      data: [
        { eventType: "Order", eventSymbol: "BOOM", index: 1, action: "NEW", price: 1, time: 1, side: "BUY", scope: "ORDER", source: "GLBX", eventFlags: 0 },
        { eventType: "Order", eventSymbol: "AAPL", index: 2, action: "NEW", price: 1, time: 1, side: "BUY", scope: "ORDER", source: "NTV", eventFlags: 0 },
      ],
    })).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("resolver boom");
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].providerSymbol).toBe("AAPL");
  });

  test("a throwing onEnvelope is contained -- routed to onCaptureError, does not crash, does not stop the rest of the batch", () => {
    const errors = [];
    const seen = [];
    const { emit } = createDrivenCapture({
      resolveOrderContext,
      onEnvelope: (envelope) => {
        if (envelope.providerSymbol === "/NQZ26:XCME") throw new Error("consumer boom");
        seen.push(envelope.providerSymbol);
      },
      onCaptureError: (error) => errors.push(error),
    });

    expect(() => emit({
      type: "FEED_DATA",
      data: [
        { eventType: "Order", eventSymbol: "/NQZ26:XCME", index: 1, action: "NEW", price: 1, time: 1, side: "BUY", scope: "ORDER", source: "GLBX", eventFlags: 0 },
        { eventType: "Order", eventSymbol: "AAPL", index: 2, action: "NEW", price: 1, time: 1, side: "BUY", scope: "ORDER", source: "NTV", eventFlags: 0 },
      ],
    })).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("consumer boom");
    expect(seen).toEqual(["AAPL"]);
  });

  test("a normalizeDxFeedOrderV2Event failure for one item is routed to onCaptureError and does not stop the rest of the batch", () => {
    const envelopes = [];
    const errors = [];
    // A context resolver that returns a malformed identity (unsupported
    // symbol/assetClass pair) for one specific symbol -- forces
    // normalizeDxFeedOrderV2Event's own internal assertion to throw.
    const { emit } = createDrivenCapture({
      resolveOrderContext: (eventSymbol) =>
        eventSymbol === "BROKEN" ? { assetClass: "FUTURE", symbol: "BROKEN" } : resolveOrderContext(eventSymbol),
      onEnvelope: (envelope) => envelopes.push(envelope),
      onCaptureError: (error) => errors.push(error),
    });

    emit({
      type: "FEED_DATA",
      data: [
        { eventType: "Order", eventSymbol: "BROKEN", index: 1, action: "NEW", price: 1, time: 1, side: "BUY", scope: "ORDER", source: "GLBX", eventFlags: 0 },
        { eventType: "Order", eventSymbol: "AAPL", index: 2, action: "NEW", price: 1, time: 1, side: "BUY", scope: "ORDER", source: "NTV", eventFlags: 0 },
      ],
    });

    expect(errors).toHaveLength(1);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].providerSymbol).toBe("AAPL");
  });
});
