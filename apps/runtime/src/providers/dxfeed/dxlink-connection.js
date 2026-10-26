const { DXLinkWebSocketClient } = require("@dxfeed/dxlink-websocket-client");
const { DXLinkLogLevel } = require("@dxfeed/dxlink-core");
const { redactError, redactSecrets } = require("./redact");
const { assertApprovedToken, isApprovedEndpointModePair } = require("./dxfeed-connection-config");
const { createWsConnector } = require("./dxlink-ws-connector");

function createDxLinkConnection(config, {
  webSocketClientImpl = DXLinkWebSocketClient,
  createConnector = (url) => createWsConnector(url),
} = {}) {
  if (
    !config ||
    typeof config.endpoint !== "string" ||
    typeof config.marketDataMode !== "string" ||
    typeof config.tempToken !== "string"
  ) {
    throw new Error("dxlink-connection: config must include endpoint, marketDataMode, and tempToken");
  }
  if (typeof createConnector !== "function") {
    throw new Error("dxlink-connection: createConnector must be a function");
  }
  const connectionConfig = Object.freeze({
    endpoint: config.endpoint,
    marketDataMode: config.marketDataMode,
    tempToken: assertApprovedToken(config.tempToken),
  });
  const secrets = [connectionConfig.tempToken];
  const client = new webSocketClientImpl({
    logLevel: DXLinkLogLevel.WARN,
    maxReconnectAttempts: 0,
    connectorFactory: (url) => {
      if (url !== connectionConfig.endpoint) {
        throw new Error("dxlink-connection: SDK requested an unapproved connector endpoint");
      }
      return createConnector(url);
    },
  });
  const errorListeners = new Set();
  const connectionStateListeners = new Set();
  const authStateListeners = new Set();

  function safelyInvoke(listener, arg, context) {
    try {
      listener(arg);
    } catch (error) {
      console.error(context, redactSecrets(String(error?.message ?? error), secrets));
    }
  }

  client.addErrorListener((error) => {
    const redacted = redactError(error, secrets);
    console.error("dxlink-connection: connection error", redacted);
    for (const listener of errorListeners) {
      safelyInvoke(listener, redacted, "dxlink-connection: error listener threw");
    }
  });

  client.addConnectionStateChangeListener((state, prev) => {
    for (const listener of connectionStateListeners) {
      safelyInvoke(listener, { state, prev }, "dxlink-connection: connection-state listener threw");
    }
  });

  client.addAuthStateChangeListener((state, prev) => {
    for (const listener of authStateListeners) {
      safelyInvoke(listener, { state, prev }, "dxlink-connection: auth-state listener threw");
    }
  });

  function assertApprovedBeforeConnect() {
    if (!isApprovedEndpointModePair(connectionConfig.endpoint, connectionConfig.marketDataMode)) {
      throw new Error("dxlink-connection: endpoint and marketDataMode are not an approved matching pair, refusing to connect");
    }
  }

  function connect() {
    assertApprovedBeforeConnect();
    try {
      client.setAuthToken(connectionConfig.tempToken);
      client.connect(connectionConfig.endpoint);
    } catch (error) {
      throw new Error(`dxlink-connection: connect failed: ${redactSecrets(String(error?.message ?? error), secrets)}`);
    }
  }

  function disconnect() {
    try {
      client.disconnect();
    } catch (error) {
      throw new Error(`dxlink-connection: disconnect failed: ${redactSecrets(String(error?.message ?? error), secrets)}`);
    }
  }

  function getStatus() {
    return {
      connectionState: client.getConnectionState(),
      authState: client.getAuthState(),
    };
  }

  function addListener(listeners, listener, name) {
    if (typeof listener !== "function") {
      throw new Error(`dxlink-connection: ${name} listener must be a function`);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onError(listener) {
    return addListener(errorListeners, listener, "error");
  }

  function onConnectionStateChange(listener) {
    return addListener(connectionStateListeners, listener, "connection-state");
  }

  function onAuthStateChange(listener) {
    return addListener(authStateListeners, listener, "auth-state");
  }

  function openChannel(service, parameters, options) {
    if (typeof service !== "string" || service.trim() === "") {
      throw new Error("dxlink-connection: channel service must be a non-empty string");
    }
    if (parameters !== undefined && (parameters === null || typeof parameters !== "object" || Array.isArray(parameters))) {
      throw new Error("dxlink-connection: channel parameters must be an object when provided");
    }
    if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
      throw new Error("dxlink-connection: channel options must be an object when provided");
    }
    try {
      return client.openChannel(service, parameters, options);
    } catch (error) {
      throw new Error(`dxlink-connection: openChannel failed: ${redactSecrets(String(error?.message ?? error), secrets)}`);
    }
  }

  return Object.freeze({
    connect,
    disconnect,
    getStatus,
    onError,
    onConnectionStateChange,
    onAuthStateChange,
    openChannel,
  });
}

module.exports = { createDxLinkConnection };
