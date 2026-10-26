"use strict";

// Worker side of the liquidity backfill: replays the collector's recording
// on its own thread and posts finished columns back in batches, so the
// server's event loop never sees the synchronous SQLite work.
//

const { parentPort, workerData } = require("worker_threads");
const { runBackfillInProcess } = require("./liquidity-backfill");

async function main() {
  const batchColumns = workerData.batchColumns;
  let batch = [];
  let laneBatch = [];
  const flush = () => {
    if (batch.length > 0) {
      parentPort.postMessage({ type: "columns", batch });
      batch = [];
    }
    if (laneBatch.length > 0) {
      parentPort.postMessage({ type: "laneColumns", batch: laneBatch });
      laneBatch = [];
    }
  };
  const { sourceModule, ...options } = workerData;
  const createSource = sourceModule === undefined ? undefined : require(sourceModule).createSource;
  if (sourceModule !== undefined && typeof createSource !== "function") throw new Error(`liquidity-backfill-worker: ${sourceModule} does not export createSource`);
  const result = await runBackfillInProcess({
    ...options,
    createSource,
    onColumn: (column) => {
      batch.push(column);
      if (batch.length >= batchColumns) flush();
    },
    onLaneColumn: (lane, column) => {
      laneBatch.push({ lane, column });
      if (laneBatch.length >= batchColumns) flush();
    },
  });
  flush();
  parentPort.postMessage({ type: "done", result });
}

main().catch((error) => {
  parentPort.postMessage({ type: "error", message: error?.message ?? String(error) });
});
