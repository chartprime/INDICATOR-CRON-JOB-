const { parentPort } = require("node:worker_threads");

parentPort.postMessage({ type: "ready" });
parentPort.on("message", (message) => {
  if (message?.type === "write") {
    parentPort.postMessage({ type: "write_started", id: message.id, itemCount: message.items.length });
  }
});
