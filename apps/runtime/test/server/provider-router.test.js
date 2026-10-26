const { createProviderRouter } = require("../../src/server/provider-router");

function fakeBackend() {
  return {
    handleClientConnected: jest.fn(),
    handleClientDisconnected: jest.fn(),
    handleClientMessage: jest.fn(),
    deactivate: jest.fn(),
  };
}

function fakeClient() {
  return {};
}

describe("createProviderRouter -- construction", () => {
  test("preserves a validated automatic-restore marker for the dxFeed recovery gate", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY", resume: true }), client);
    expect(dxfeedServer.handleClientMessage).toHaveBeenCalledWith(JSON.stringify({ type: "select", symbol: "AAPL", assetClass: "EQUITY", resume: true }), client);
  });
  test("throws if either backend server is missing", () => {
    expect(() => createProviderRouter({ binanceServer: fakeBackend() })).toThrow(/both required/);
    expect(() => createProviderRouter({ dxfeedServer: fakeBackend() })).toThrow(/both required/);
  });
});

describe("createProviderRouter -- connection lifecycle", () => {
  test("a new connection defaults to the Binance server, matching today's behavior", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    expect(binanceServer.handleClientConnected).toHaveBeenCalledWith(client);
    expect(dxfeedServer.handleClientConnected).not.toHaveBeenCalled();
    expect(router.getActiveProvider()).toBe("BINANCE");
  });

  test("disconnection unregisters the client from both backends unconditionally", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    router.handleDisconnection(client);
    expect(binanceServer.handleClientDisconnected).toHaveBeenCalledWith(client);
    expect(dxfeedServer.handleClientDisconnected).toHaveBeenCalledWith(client);
    expect(router.connectedClientCount()).toBe(0);
  });

  test("a backend registration failure is rolled back and never becomes a connected router client", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    binanceServer.handleClientConnected.mockImplementation(() => { throw new Error("attach failed"); });
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    expect(() => router.handleConnection(client)).toThrow("attach failed");
    expect(binanceServer.handleClientDisconnected).toHaveBeenCalledWith(client);
    expect(router.connectedClientCount()).toBe(0);
  });

  test("disconnection attempts both backends and dxFeed deactivation even when one cleanup step throws", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);
    binanceServer.handleClientDisconnected.mockImplementation(() => { throw new Error("cleanup failed"); });
    expect(() => router.handleDisconnection(client)).toThrow(AggregateError);
    expect(dxfeedServer.handleClientDisconnected).toHaveBeenCalledWith(client);
    expect(dxfeedServer.deactivate).toHaveBeenCalledTimes(1);
    expect(router.connectedClientCount()).toBe(0);
  });
});

describe("createProviderRouter -- backward-compatible legacy messages", () => {
  test("retains marker-history capability across a dxFeed round trip and restores it only on Binance", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    const capability = JSON.stringify({ type: "capabilities", marker_history: true });
    router.handleConnection(client);
    router.handleMessage(capability, client);
    expect(binanceServer.handleClientMessage).toHaveBeenCalledWith(capability, client);

    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);
    expect(dxfeedServer.handleClientMessage).not.toHaveBeenCalledWith(capability, client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" }), client);
    expect(binanceServer.handleClientMessage).toHaveBeenLastCalledWith(capability, client);
  });

  test("a capabilities message sent while dxFeed is active is kept for Binance and never reaches dxFeed (Block 8 #11)", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    const capability = JSON.stringify({ type: "capabilities", marker_history: true });
    router.handleConnection(client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);
    router.handleMessage(capability, client);
    expect(dxfeedServer.handleClientMessage).not.toHaveBeenCalledWith(capability, client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" }), client);
    expect(binanceServer.handleClientMessage).toHaveBeenLastCalledWith(capability, client);
  });

  test("P4a: an L2 capability set follows the client across providers, without marker_history on dxFeed", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    router.handleMessage(JSON.stringify({ type: "capabilities", marker_history: true, l2_walls: true, l2_view: true }), client);
    const full = JSON.stringify({ type: "capabilities", marker_history: true, l2_view: true, l2_walls: true });
    expect(binanceServer.handleClientMessage).toHaveBeenLastCalledWith(full, client);

    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);
    expect(dxfeedServer.handleClientMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: "capabilities", l2_view: true, l2_walls: true }), client);

    router.handleMessage(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" }), client);
    expect(binanceServer.handleClientMessage).toHaveBeenLastCalledWith(full, client);
  });

  test("P4a: a later capabilities message replaces the set, so a client can opt out", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    router.handleMessage(JSON.stringify({ type: "capabilities", l2_ladder: true }), client);
    router.handleMessage(JSON.stringify({ type: "capabilities" }), client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);
    expect(dxfeedServer.handleClientMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: "capabilities" }), client);
  });

  test("P4a: an unknown or non-true capability is not remembered and goes to the active server to be refused", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    for (const raw of [
      JSON.stringify({ type: "capabilities", l2_everything: true }),
      JSON.stringify({ type: "capabilities", l2_walls: false }),
      JSON.stringify({ type: "capabilities", l2_walls: "yes" }),
    ]) {
      router.handleMessage(raw, client);
      expect(binanceServer.handleClientMessage).toHaveBeenLastCalledWith(raw, client);
    }
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);
    expect(dxfeedServer.handleClientMessage.mock.calls.some(([raw]) => JSON.parse(raw).type === "capabilities")).toBe(false);
  });

  test("P4a: capabilities from a client that never connected are not remembered", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    router.handleMessage(JSON.stringify({ type: "capabilities", l2_walls: true }), fakeClient());
    expect(binanceServer.handleClientMessage).not.toHaveBeenCalled();
  });

  test("a legacy 3-key select with no provider field is forwarded to Binance unchanged", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    const raw = JSON.stringify({ type: "select", symbol: "ETH-USDT", marketKind: "PERPETUAL" });
    router.handleMessage(raw, client);
    expect(binanceServer.handleClientMessage).toHaveBeenCalledWith(raw, client);
    expect(dxfeedServer.handleClientMessage).not.toHaveBeenCalled();
  });

  test("an explicit provider: BINANCE select strips the provider key before forwarding", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    router.handleMessage(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "ETH-USDT", marketKind: "PERPETUAL" }), fakeClient());
    expect(JSON.parse(binanceServer.handleClientMessage.mock.calls[0][0])).toEqual({
      type: "select", symbol: "ETH-USDT", marketKind: "PERPETUAL",
    });
  });

  test("malformed (non-JSON) or non-select messages are forwarded as-is to the currently active server, not dropped by the router", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleMessage("not json", client);
    expect(binanceServer.handleClientMessage).toHaveBeenCalledWith("not json", client);
    router.handleMessage(JSON.stringify({ type: "ping" }), client);
    expect(binanceServer.handleClientMessage).toHaveBeenCalledWith(JSON.stringify({ type: "ping" }), client);
  });
});

describe("createProviderRouter -- dxFeed routing and global provider switching", () => {
  test("an explicit provider: DXFEED select switches the active provider and forwards a provider-stripped message", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), fakeClient());
    expect(router.getActiveProvider()).toBe("DXFEED");
    expect(JSON.parse(dxfeedServer.handleClientMessage.mock.calls[0][0])).toEqual({
      type: "select", symbol: "AAPL", assetClass: "EQUITY",
    });
  });

  test("switching providers moves EVERY currently-connected client, not just the requester -- true shared-pair semantics", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const clientA = fakeClient();
    const clientB = fakeClient();
    router.handleConnection(clientA);
    router.handleConnection(clientB);
    binanceServer.handleClientConnected.mockClear();

    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), clientA);

    expect(binanceServer.handleClientDisconnected).toHaveBeenCalledWith(clientA);
    expect(binanceServer.handleClientDisconnected).toHaveBeenCalledWith(clientB);
    expect(dxfeedServer.handleClientConnected).toHaveBeenCalledWith(clientA);
    expect(dxfeedServer.handleClientConnected).toHaveBeenCalledWith(clientB);
  });

  test("installs the destination selection before attaching clients, preventing a retained old view from leaking during a provider switch", () => {
    const callOrder = [];
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    binanceServer.handleClientDisconnected.mockImplementation(() => callOrder.push("detach-binance"));
    dxfeedServer.handleClientMessage.mockImplementation(() => callOrder.push("select-dxfeed"));
    dxfeedServer.handleClientConnected.mockImplementation(() => callOrder.push("attach-dxfeed"));
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);

    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);

    expect(callOrder).toEqual(["detach-binance", "select-dxfeed", "attach-dxfeed"]);
  });

  test("rolls clients back to the current provider if destination selection setup throws", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    dxfeedServer.handleClientMessage.mockImplementation(() => {
      throw new Error("destination failed");
    });
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    binanceServer.handleClientConnected.mockClear();

    expect(() => router.handleMessage(
      JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }),
      client,
    )).not.toThrow();

    expect(router.getActiveProvider()).toBe("BINANCE");
    expect(binanceServer.handleClientDisconnected).toHaveBeenCalledWith(client);
    expect(binanceServer.handleClientConnected).toHaveBeenCalledWith(client);
    expect(dxfeedServer.handleClientDisconnected).toHaveBeenCalledWith(client);
    expect(dxfeedServer.handleClientConnected).not.toHaveBeenCalled();
    expect(dxfeedServer.deactivate).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "provider-router: destination selection failed; restored the previous provider",
      "destination failed",
    );
    consoleError.mockRestore();
  });

  test("a source-detachment failure keeps the provider unchanged and drops every uncertain client", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const clientA = { close: jest.fn() };
    const clientB = { close: jest.fn() };
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    router.handleConnection(clientA);
    router.handleConnection(clientB);
    binanceServer.handleClientDisconnected.mockImplementationOnce(() => { throw new Error("detach failed"); });

    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), clientA);

    expect(router.getActiveProvider()).toBe("BINANCE");
    expect(router.connectedClientCount()).toBe(0);
    expect(dxfeedServer.handleClientMessage).not.toHaveBeenCalled();
    expect(clientA.close).toHaveBeenCalledWith(1011, "Unable to switch market data provider");
    expect(clientB.close).toHaveBeenCalledWith(1011, "Unable to switch market data provider");
    consoleError.mockRestore();
  });

  test("a destination attachment failure drops only that client while healthy clients complete the shared switch", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const clientA = { close: jest.fn() };
    const clientB = { close: jest.fn() };
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    router.handleConnection(clientA);
    router.handleConnection(clientB);
    dxfeedServer.handleClientConnected.mockImplementation((client) => {
      if (client === clientA) throw new Error("client attach failed");
    });

    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), clientB);

    expect(router.getActiveProvider()).toBe("DXFEED");
    expect(router.connectedClientCount()).toBe(1);
    expect(clientA.close).toHaveBeenCalledWith(1011, "Unable to attach market data provider");
    expect(clientB.close).not.toHaveBeenCalled();
    expect(dxfeedServer.handleClientDisconnected).toHaveBeenCalledWith(clientA);
    consoleError.mockRestore();
  });

  test("switching back to Binance after being on dxFeed moves clients back and stops dxFeed forwarding", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);

    router.handleMessage(JSON.stringify({ type: "select", symbol: "ETH-USDT", marketKind: "PERPETUAL" }), client);

    expect(router.getActiveProvider()).toBe("BINANCE");
    expect(dxfeedServer.handleClientDisconnected).toHaveBeenCalledWith(client);
    expect(binanceServer.handleClientConnected).toHaveBeenCalledWith(client);
    expect(dxfeedServer.deactivate).toHaveBeenCalledTimes(1);
  });

  test("the final socket disconnect releases an active dxFeed session", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);

    router.handleDisconnection(client);

    expect(dxfeedServer.deactivate).toHaveBeenCalledTimes(1);
    expect(router.connectedClientCount()).toBe(0);
  });

  test("no provider switch (and no client movement) happens when re-selecting within the already-active provider", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    binanceServer.handleClientConnected.mockClear();

    router.handleMessage(JSON.stringify({ type: "select", symbol: "BTC-USDT", marketKind: "SPOT" }), client);

    expect(binanceServer.handleClientDisconnected).not.toHaveBeenCalled();
    expect(binanceServer.handleClientConnected).not.toHaveBeenCalled();
    expect(binanceServer.handleClientMessage).toHaveBeenCalledTimes(1);
  });

  test("a client cannot bypass the global selection rate limit by alternating providers", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = { close: jest.fn() };
    router.handleConnection(client);

    router.handleMessage(JSON.stringify({ type: "select", symbol: "ETH-USDT", marketKind: "SPOT" }), client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT" }), client);

    expect(router.getActiveProvider()).toBe("DXFEED");
    expect(binanceServer.handleClientMessage).toHaveBeenCalledTimes(1);
    expect(dxfeedServer.handleClientMessage).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "provider-router: closed client that exceeded the global selection rate limit",
    );
    expect(client.close).toHaveBeenCalledWith(1008, "Too many selection requests");
    consoleError.mockRestore();
  });

  test("an unrecognized provider value is dropped entirely -- not forwarded to either backend, no switch", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    router.handleMessage(JSON.stringify({ type: "select", provider: "CRYPTO", symbol: "BTC-USDT" }), fakeClient());
    expect(binanceServer.handleClientMessage).not.toHaveBeenCalled();
    expect(dxfeedServer.handleClientMessage).not.toHaveBeenCalled();
    expect(router.getActiveProvider()).toBe("BINANCE");
  });

  test("a provider-switching select for dxFeed with a missing assetClass never switches or moves clients (closure-audit finding)", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    binanceServer.handleClientDisconnected.mockClear();

    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL" }), client);

    expect(router.getActiveProvider()).toBe("BINANCE");
    expect(binanceServer.handleClientDisconnected).not.toHaveBeenCalled();
    expect(dxfeedServer.handleClientConnected).not.toHaveBeenCalled();
    expect(dxfeedServer.handleClientMessage).not.toHaveBeenCalled();
  });

  test("a provider-switching select for dxFeed with an unproven symbol never switches or moves clients", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);

    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "MSFT", assetClass: "EQUITY" }), client);

    expect(router.getActiveProvider()).toBe("BINANCE");
    expect(dxfeedServer.handleClientConnected).not.toHaveBeenCalled();
    expect(dxfeedServer.handleClientMessage).not.toHaveBeenCalled();
  });

  test("a provider-switching select back to Binance with a missing marketKind never switches or moves clients", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    router.handleMessage(JSON.stringify({ type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" }), client);
    dxfeedServer.handleClientDisconnected.mockClear();
    binanceServer.handleClientConnected.mockClear();

    router.handleMessage(JSON.stringify({ type: "select", symbol: "BTC-USDT" }), client);

    expect(router.getActiveProvider()).toBe("DXFEED");
    expect(dxfeedServer.handleClientDisconnected).not.toHaveBeenCalled();
    expect(binanceServer.handleClientConnected).not.toHaveBeenCalled();
  });

  test("an otherwise-valid provider switch with an extra field is rejected before moving any client", () => {
    const binanceServer = fakeBackend();
    const dxfeedServer = fakeBackend();
    const router = createProviderRouter({ binanceServer, dxfeedServer });
    const client = fakeClient();
    router.handleConnection(client);
    binanceServer.handleClientDisconnected.mockClear();

    router.handleMessage(JSON.stringify({
      type: "select", provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY", marketKind: "SPOT",
    }), client);

    expect(router.getActiveProvider()).toBe("BINANCE");
    expect(binanceServer.handleClientDisconnected).not.toHaveBeenCalled();
    expect(dxfeedServer.handleClientConnected).not.toHaveBeenCalled();
    expect(dxfeedServer.handleClientMessage).not.toHaveBeenCalled();
  });
});
