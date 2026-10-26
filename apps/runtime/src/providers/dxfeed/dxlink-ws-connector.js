const WebSocket = require("ws");

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

function createWsConnector(url, { webSocketImpl = WebSocket } = {}) {
  let socket;
  let isAvailable = false;
  let openListener;
  let closeListener;
  let messageListener;

  function invokeListener(listener, args, context) {
    if (!listener) return true;
    try {
      listener(...args);
      return true;
    } catch {
      console.error(context);
      return false;
    }
  }

  function setListener(listener, name) {
    if (typeof listener !== "function") {
      throw new Error(`dxlink-ws-connector: ${name} listener must be a function`);
    }
    return listener;
  }

  function handleOpen(activeSocket) {
    if (socket !== activeSocket) return;
    isAvailable = true;
    if (!invokeListener(openListener, [], "dxlink-ws-connector: open listener failed")) {
      handleTerminalClose(activeSocket, "Open processing failed", true);
    }
  }

  function handleMessage(activeSocket, data) {
    if (socket !== activeSocket) return;
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.error("dxlink-ws-connector: message parse error", error?.message ?? error);
      handleTerminalClose(activeSocket, "Malformed message", true);
      return;
    }
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      typeof message.type !== "string" ||
      !Number.isSafeInteger(message.channel) ||
      message.channel < 0
    ) {
      console.error("dxlink-ws-connector: invalid message envelope");
      handleTerminalClose(activeSocket, "Invalid message envelope", true);
      return;
    }
    if (!invokeListener(messageListener, [message], "dxlink-ws-connector: message listener failed")) {
      handleTerminalClose(activeSocket, "Message processing failed", true);
    }
  }

  function handleTerminalClose(activeSocket, reason, isError) {
    if (socket !== activeSocket) return;
    socket = undefined;
    isAvailable = false;
    activeSocket.removeAllListeners();
    if (isError) {
      try {
        activeSocket.close();
      } catch {
        void 0;
      }
    }
    invokeListener(closeListener, [reason, isError], "dxlink-ws-connector: close listener failed");
  }

  return {
    getUrl: () => url,
    setOpenListener: (listener) => {
      openListener = setListener(listener, "open");
    },
    setCloseListener: (listener) => {
      closeListener = setListener(listener, "close");
    },
    setMessageListener: (listener) => {
      messageListener = setListener(listener, "message");
    },
    sendMessage: (message) => {
      if (socket !== undefined && isAvailable) {
        const activeSocket = socket;
        try {
          activeSocket.send(JSON.stringify(message));
        } catch {
          handleTerminalClose(activeSocket, "Unable to send", true);
        }
      }
    },
    start: () => {
      if (socket !== undefined) return;
      const activeSocket = new webSocketImpl(url, { maxPayload: MAX_PAYLOAD_BYTES });
      socket = activeSocket;
      activeSocket.on("open", () => handleOpen(activeSocket));
      activeSocket.on("message", (data) => handleMessage(activeSocket, data));
      activeSocket.on("close", (_code, reason) => handleTerminalClose(activeSocket, reason?.toString() ?? "", false));
      activeSocket.on("error", () => handleTerminalClose(activeSocket, "Unable to connect", true));
    },
    stop: () => {
      if (socket === undefined) return;
      const activeSocket = socket;
      socket = undefined;
      isAvailable = false;
      activeSocket.removeAllListeners();
      activeSocket.close();
    },
  };
}

module.exports = { createWsConnector, MAX_PAYLOAD_BYTES };
