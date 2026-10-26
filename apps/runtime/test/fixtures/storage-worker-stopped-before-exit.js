const { parentPort, workerData } = require("node:worker_threads");
parentPort.on("message", (message) => {
  if (message.type === "shutdown") {
    parentPort.postMessage({ type: "stopped" });
    setTimeout(() => {
      if (workerData.dbPath === "fail-after-stopped") process.exitCode = 1;
      parentPort.close();
    }, 200);
  }
});
parentPort.postMessage({ type: "ready" });
