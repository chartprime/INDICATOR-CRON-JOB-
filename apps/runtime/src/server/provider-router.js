const { isAllowedSymbol, isAllowedMarketKind } = require("../providers/binance/binance-config");
const { isAllowedDxFeedSymbol, isAllowedAssetClass } = require("../providers/dxfeed/dxfeed-instrument-catalog");
const { fromWireSymbol } = require("./frames");
const { parseCapabilities, capabilitiesMessage } = require("./l2-frames");

const BINANCE = "BINANCE";
const DXFEED = "DXFEED";
const SELECTION_RATE_WINDOW_MS = 1_000;
const MAX_SELECTIONS_PER_WINDOW = 2;

function hasExactKeys(record, expected) {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isValidSelectPayload(provider, parsed) {
  if (provider === DXFEED) {
    return (
      (parsed.resume === true
        ? hasExactKeys(parsed, ["assetClass", "provider", "resume", "symbol", "type"])
        : hasExactKeys(parsed, ["assetClass", "provider", "symbol", "type"])) &&
      isAllowedAssetClass(parsed.assetClass) &&
      isAllowedDxFeedSymbol(parsed.symbol, parsed.assetClass)
    );
  }
  const expectedKeys = parsed.provider === undefined
    ? ["marketKind", "symbol", "type"]
    : ["marketKind", "provider", "symbol", "type"];
  if (!hasExactKeys(parsed, expectedKeys)) return false;
  let providerSymbol;
  try {
    providerSymbol = fromWireSymbol(parsed.symbol);
  } catch {
    return false;
  }
  return isAllowedSymbol(providerSymbol) && isAllowedMarketKind(parsed.marketKind);
}

function capabilitiesFor(provider, flags) {
  if (provider === BINANCE) return JSON.stringify(capabilitiesMessage(flags));
  return JSON.stringify(capabilitiesMessage(new Set([...flags].filter((flag) => flag !== "marker_history"))));
}

function createProviderRouter({ binanceServer, dxfeedServer }) {
  const requiredMethods = ["handleClientConnected", "handleClientDisconnected", "handleClientMessage"];
  if (
    !binanceServer ||
    !dxfeedServer ||
    requiredMethods.some((method) => typeof binanceServer[method] !== "function" || typeof dxfeedServer[method] !== "function") ||
    typeof dxfeedServer.deactivate !== "function"
  ) {
    throw new Error("provider-router: binanceServer and dxfeedServer are both required");
  }
  const connectedClients = new Set();
  const selectionWindowsByClient = new Map();
  const capabilitiesByClient = new Map();
  let activeProvider = BINANCE;

  function restoreCapabilities(server, provider, client) {
    const flags = capabilitiesByClient.get(client);
    if (flags !== undefined) server.handleClientMessage(capabilitiesFor(provider, flags), client);
  }

  function activeServer() {
    return activeProvider === DXFEED ? dxfeedServer : binanceServer;
  }

  function handleConnection(client) {
    if (connectedClients.has(client)) return;
    const server = activeServer();
    try {
      server.handleClientConnected(client);
      connectedClients.add(client);
    } catch (error) {
      try {
        server.handleClientDisconnected(client);
      } catch {
        void 0;
      }
      throw error;
    }
  }

  function handleDisconnection(client) {
    connectedClients.delete(client);
    selectionWindowsByClient.delete(client);
    capabilitiesByClient.delete(client);
    const errors = [];
    for (const server of [binanceServer, dxfeedServer]) {
      try {
        server.handleClientDisconnected(client);
      } catch (error) {
        errors.push(error);
      }
    }
    if (connectedClients.size === 0 && activeProvider === DXFEED) {
      try {
        dxfeedServer.deactivate();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "provider-router: one or more client cleanup steps failed");
    }
  }

  function parseSelectEnvelope(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || parsed.type !== "select") {
      return undefined;
    }
    return parsed;
  }

  function allowSelectionRequest(client, nowMs = Date.now()) {
    let window = selectionWindowsByClient.get(client);
    if (!window || nowMs < window.startedAtMs || nowMs - window.startedAtMs >= SELECTION_RATE_WINDOW_MS) {
      window = { startedAtMs: nowMs, selections: 0 };
      selectionWindowsByClient.set(client, window);
    }
    window.selections += 1;
    return window.selections <= MAX_SELECTIONS_PER_WINDOW;
  }

  function handleMessage(raw, client) {
    let control;
    try {
      control = JSON.parse(raw);
    } catch {
      control = null;
    }
    if (control && typeof control === "object" && control.type === "capabilities") {
      const flags = parseCapabilities(control);
      if (flags === null) {
        activeServer().handleClientMessage(raw, client);
        return;
      }
      if (!connectedClients.has(client)) return;
      capabilitiesByClient.set(client, flags);
      restoreCapabilities(activeServer(), activeProvider, client);
      return;
    }
    const parsed = parseSelectEnvelope(raw);
    if (parsed === undefined) {
      activeServer().handleClientMessage(raw, client);
      return;
    }
    if (parsed.provider !== undefined && parsed.provider !== BINANCE && parsed.provider !== DXFEED) {
      console.warn("provider-router: dropped select request with an unrecognized provider", parsed.provider);
      return;
    }
    const requestedProvider = parsed.provider === DXFEED ? DXFEED : BINANCE;
    if (!isValidSelectPayload(requestedProvider, parsed)) {
      console.warn("provider-router: dropped a select with an invalid payload", requestedProvider);
      return;
    }
    if (!allowSelectionRequest(client)) {
      console.error("provider-router: closed client that exceeded the global selection rate limit");
      try {
        client?.close?.(1008, "Too many selection requests");
      } catch {
        void 0;
      }
      return;
    }
    const { provider, ...forwarded } = parsed;
    void provider;
    if (requestedProvider !== activeProvider) {
      const previousServer = activeServer();
      const nextServer = requestedProvider === DXFEED ? dxfeedServer : binanceServer;
      const clientsAtSwitch = [...connectedClients];
      const detachErrors = [];
      for (const connectedClient of connectedClients) {
        try {
          previousServer.handleClientDisconnected(connectedClient);
        } catch (error) {
          detachErrors.push(error);
        }
      }
      if (detachErrors.length > 0) {
        for (const connectedClient of clientsAtSwitch) {
          connectedClients.delete(connectedClient);
          selectionWindowsByClient.delete(connectedClient);
          try {
            previousServer.handleClientDisconnected(connectedClient);
          } catch {
            void 0;
          }
          try {
            nextServer.handleClientDisconnected(connectedClient);
          } catch {
            void 0;
          }
          try {
            connectedClient?.close?.(1011, "Unable to switch market data provider");
          } catch {
            void 0;
          }
        }
        if (activeProvider === DXFEED) {
          try {
            dxfeedServer.deactivate();
          } catch (cleanupError) {
            console.error("provider-router: dxFeed session deactivation failed during switch recovery", cleanupError?.message ?? cleanupError);
          }
        }
        console.error("provider-router: source detachment failed; retained the current provider and dropped affected clients", detachErrors[0]?.message ?? detachErrors[0]);
        return;
      }
      try {
        nextServer.handleClientMessage(JSON.stringify(forwarded), client);
      } catch (error) {
        for (const connectedClient of clientsAtSwitch) {
          try {
            nextServer.handleClientDisconnected(connectedClient);
          } catch {
            void 0;
          }
          try {
            previousServer.handleClientConnected(connectedClient);
            restoreCapabilities(previousServer, activeProvider, connectedClient);
          } catch (restoreError) {
            connectedClients.delete(connectedClient);
            selectionWindowsByClient.delete(connectedClient);
            try {
              connectedClient?.close?.(1011, "Unable to restore market data provider");
            } catch {
              void 0;
            }
            console.error("provider-router: dropped a client that could not be restored after switch failure", restoreError?.message ?? restoreError);
          }
        }
        if (connectedClients.size === 0 && activeProvider === DXFEED) {
          try {
            dxfeedServer.deactivate();
          } catch (cleanupError) {
            console.error("provider-router: dxFeed session deactivation failed during switch recovery", cleanupError?.message ?? cleanupError);
          }
        }
        if (requestedProvider === DXFEED) {
          try {
            dxfeedServer.deactivate();
          } catch (cleanupError) {
            console.error("provider-router: destination dxFeed cleanup failed", cleanupError?.message ?? cleanupError);
          }
        }
        console.error("provider-router: destination selection failed; restored the previous provider", error?.message ?? error);
        return;
      }
      if (activeProvider === DXFEED) {
        try {
          dxfeedServer.deactivate();
        } catch (error) {
          console.error("provider-router: dxFeed session deactivation failed", error?.message ?? error);
        }
      }
      activeProvider = requestedProvider;
      for (const connectedClient of clientsAtSwitch) {
        try {
          nextServer.handleClientConnected(connectedClient);
          restoreCapabilities(nextServer, requestedProvider, connectedClient);
        } catch (error) {
          connectedClients.delete(connectedClient);
          selectionWindowsByClient.delete(connectedClient);
          try {
            nextServer.handleClientDisconnected(connectedClient);
          } catch {
            void 0;
          }
          try {
            previousServer.handleClientDisconnected(connectedClient);
          } catch {
            void 0;
          }
          try {
            connectedClient?.close?.(1011, "Unable to attach market data provider");
          } catch {
            void 0;
          }
          console.error("provider-router: dropped a client that could not attach to the selected provider", error?.message ?? error);
        }
      }
      if (connectedClients.size === 0 && activeProvider === DXFEED) {
        try {
          dxfeedServer.deactivate();
        } catch (error) {
          console.error("provider-router: empty dxFeed session deactivation failed", error?.message ?? error);
        }
      }
      return;
    }
    activeServer().handleClientMessage(JSON.stringify(forwarded), client);
  }

  return Object.freeze({
    handleConnection,
    handleDisconnection,
    handleMessage,
    getActiveProvider: () => activeProvider,
    connectedClientCount: () => connectedClients.size,
  });
}

module.exports = { createProviderRouter, BINANCE, DXFEED };
