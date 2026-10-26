const { parentPort } = require("node:worker_threads");

parentPort.postMessage({ type: "ready" });
parentPort.on("message", () => {});
