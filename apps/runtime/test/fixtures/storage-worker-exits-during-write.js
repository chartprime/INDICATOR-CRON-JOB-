const { parentPort } = require("node:worker_threads");

parentPort.on("message", (message) => {
  if (message?.type !== "write") return;
  parentPort.postMessage({ type: "write_started", id: message.id, itemCount: message.items.length });
  setImmediate(() => process.exit(17));
});

parentPort.postMessage({ type: "ready" });
