const { createWsConnector, MAX_PAYLOAD_BYTES } = require("../../../src/providers/dxfeed/dxlink-ws-connector");

function fakeWs() {
  const handlers = {};
  const sent = [];
  let closed = false;
  return {
    sent,
    closed: () => closed,
    on(event, handler) {
      handlers[event] = handler;
    },
    send(data) {
      sent.push(data);
    },
    close() {
      closed = true;
    },
    removeAllListeners() {
      for (const key of Object.keys(handlers)) delete handlers[key];
    },
    emitOpen() {
      handlers.open?.();
    },
    emitMessage(data) {
      handlers.message?.(data);
    },
    emitClose(code, reason) {
      handlers.close?.(code, reason);
    },
    emitError(error) {
      handlers.error?.(error);
    },
  };
}

function fakeWsImpl(socket) {
  return function () {
    return socket;
  };
}

describe("createWsConnector", () => {
  test("getUrl() returns the constructed URL unchanged", () => {
    const connector = createWsConnector("wss://example.test/path");
    expect(connector.getUrl()).toBe("wss://example.test/path");
  });

  test("start() creates exactly one socket even if called more than once", () => {
    const socket = fakeWs();
    let constructCount = 0;
    const impl = function () {
      constructCount += 1;
      return socket;
    };
    const connector = createWsConnector("wss://example.test", { webSocketImpl: impl });
    connector.start();
    connector.start();
    expect(constructCount).toBe(1);
  });

  test("start() applies a bounded WebSocket payload ceiling", () => {
    const socket = fakeWs();
    const constructed = [];
    const impl = function (url, options) {
      constructed.push({ url, options });
      return socket;
    };
    const connector = createWsConnector("wss://example.test", { webSocketImpl: impl });
    connector.start();
    expect(constructed).toEqual([
      { url: "wss://example.test", options: { maxPayload: MAX_PAYLOAD_BYTES } },
    ]);
  });

  test("fires the registered open listener when the socket opens", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    const opened = jest.fn();
    connector.setOpenListener(opened);
    connector.start();
    socket.emitOpen();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  test("an open-listener failure terminates the transport instead of leaving a half-open client", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    const closeEvents = [];
    connector.setOpenListener(() => {
      throw new Error("setup failed");
    });
    connector.setCloseListener((reason, isError) => closeEvents.push({ reason, isError }));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    connector.start();
    socket.emitOpen();
    expect(closeEvents).toEqual([{ reason: "Open processing failed", isError: true }]);
    expect(socket.closed()).toBe(true);
    errorSpy.mockRestore();
  });

  test("sendMessage() is a no-op before open, and serializes to JSON once open", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    connector.start();
    connector.sendMessage({ type: "SETUP" });
    expect(socket.sent).toEqual([]);

    socket.emitOpen();
    connector.sendMessage({ type: "SETUP", channel: 0 });
    expect(socket.sent).toEqual([JSON.stringify({ type: "SETUP", channel: 0 })]);
  });

  test("parses an incoming message and delivers the parsed object to the message listener", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    const received = [];
    connector.setMessageListener((message) => received.push(message));
    connector.start();

    socket.emitMessage(Buffer.from(JSON.stringify({ type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" })));

    expect(received).toEqual([{ type: "AUTH_STATE", channel: 0, state: "AUTHORIZED" }]);
  });

  test("a malformed message terminates the transport rather than silently continuing after protocol corruption", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    const received = [];
    const closeEvents = [];
    connector.setMessageListener((message) => received.push(message));
    connector.setCloseListener((reason, isError) => closeEvents.push({ reason, isError }));
    connector.start();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => socket.emitMessage("not json")).not.toThrow();

    expect(received).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    expect(closeEvents).toEqual([{ reason: "Malformed message", isError: true }]);
    expect(socket.closed()).toBe(true);
    errorSpy.mockRestore();
  });

  test.each([null, [], 42, {}, { type: "KEEPALIVE" }, { type: "KEEPALIVE", channel: -1 }])(
    "an invalid parsed message envelope is logged and dropped: %p",
    (payload) => {
      const socket = fakeWs();
      const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
      const received = [];
      const closeEvents = [];
      connector.setMessageListener((message) => received.push(message));
      connector.setCloseListener((reason, isError) => closeEvents.push({ reason, isError }));
      connector.start();
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      socket.emitMessage(JSON.stringify(payload));

      expect(received).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith("dxlink-ws-connector: invalid message envelope");
      expect(closeEvents).toEqual([{ reason: "Invalid message envelope", isError: true }]);
      errorSpy.mockRestore();
    },
  );

  test("listener registration rejects non-functions at the connector boundary", () => {
    const connector = createWsConnector("wss://example.test");
    expect(() => connector.setOpenListener(null)).toThrow(/open listener must be a function/);
    expect(() => connector.setCloseListener({})).toThrow(/close listener must be a function/);
    expect(() => connector.setMessageListener("listener")).toThrow(/message listener must be a function/);
  });

  test("a message listener failure terminates the transport without leaking its error text", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    connector.setMessageListener(() => {
      throw new Error("secret-bearing listener error");
    });
    const closeEvents = [];
    connector.setCloseListener((reason, isError) => closeEvents.push({ reason, isError }));
    connector.start();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => socket.emitMessage(JSON.stringify({ type: "KEEPALIVE", channel: 0 }))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("dxlink-ws-connector: message listener failed");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret-bearing listener error");
    expect(closeEvents).toEqual([{ reason: "Message processing failed", isError: true }]);
    expect(socket.closed()).toBe(true);
    errorSpy.mockRestore();
  });

  test("a socket error reports 'Unable to connect' with isError true to the close listener", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    const closeEvents = [];
    connector.setCloseListener((reason, isError) => closeEvents.push({ reason, isError }));
    connector.start();

    socket.emitError(new Error("ECONNREFUSED"));

    expect(closeEvents).toEqual([{ reason: "Unable to connect", isError: true }]);
    expect(socket.closed()).toBe(true);
  });

  test("a synchronous socket send failure closes the transport and reports one terminal error", () => {
    const socket = fakeWs();
    socket.send = () => {
      throw new Error("write failed");
    };
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    const closeEvents = [];
    connector.setCloseListener((reason, isError) => closeEvents.push({ reason, isError }));
    connector.start();
    socket.emitOpen();

    expect(() => connector.sendMessage({ type: "KEEPALIVE", channel: 0 })).not.toThrow();
    expect(closeEvents).toEqual([{ reason: "Unable to send", isError: true }]);
    expect(socket.closed()).toBe(true);
  });

  test("an error followed by close produces one terminal notification and permits a fresh start", () => {
    const firstSocket = fakeWs();
    const secondSocket = fakeWs();
    const sockets = [firstSocket, secondSocket];
    const connector = createWsConnector("wss://example.test", { webSocketImpl: function () { return sockets.shift(); } });
    const closeEvents = [];
    connector.setCloseListener((reason, isError) => closeEvents.push({ reason, isError }));
    connector.start();

    firstSocket.emitError(new Error("ECONNREFUSED"));
    firstSocket.emitClose(1006, Buffer.from("abnormal closure"));
    connector.start();
    secondSocket.emitOpen();
    connector.sendMessage({ type: "SETUP" });

    expect(closeEvents).toEqual([{ reason: "Unable to connect", isError: true }]);
    expect(secondSocket.sent).toEqual([JSON.stringify({ type: "SETUP" })]);
  });

  test("a normal close reports the close reason with isError false", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    const closeEvents = [];
    connector.setCloseListener((reason, isError) => closeEvents.push({ reason, isError }));
    connector.start();

    socket.emitClose(1000, Buffer.from("normal closure"));

    expect(closeEvents).toEqual([{ reason: "normal closure", isError: false }]);
  });

  test("stop() closes the socket, clears listeners, and allows a fresh start() afterward", () => {
    const socket = fakeWs();
    let constructCount = 0;
    const impl = function () {
      constructCount += 1;
      return socket;
    };
    const connector = createWsConnector("wss://example.test", { webSocketImpl: impl });
    connector.start();
    connector.stop();

    expect(socket.closed()).toBe(true);
    expect(constructCount).toBe(1);

    connector.start();
    expect(constructCount).toBe(2);
  });

  test("stop() before any start() is a safe no-op", () => {
    const connector = createWsConnector("wss://example.test");
    expect(() => connector.stop()).not.toThrow();
  });

  test("sendMessage() after stop() is a safe no-op, not a crash", () => {
    const socket = fakeWs();
    const connector = createWsConnector("wss://example.test", { webSocketImpl: fakeWsImpl(socket) });
    connector.start();
    socket.emitOpen();
    connector.stop();

    expect(() => connector.sendMessage({ type: "KEEPALIVE" })).not.toThrow();
  });
});
